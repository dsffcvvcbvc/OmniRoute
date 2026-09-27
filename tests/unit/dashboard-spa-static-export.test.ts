import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTransientBuildPaths } from "../../scripts/build/build-next-isolated.mjs";
import { DEFAULT_LOCALE } from "../../src/i18n/config";

/**
 * AGENT.md §3.3 — `output: "export"` regression guard for the AISIX SPA build.
 *
 * The `Dashboard SPA Export` CI job burned 2.8 min compiling before failing in
 * the export-collection phase on the first unexportable route it hit
 * (`/.well-known/agent.json`, Next E301). This test pins the whole contract
 * statically, so the next person who adds a route under the SPA surface finds
 * out in seconds instead of after a full build.
 *
 * What is asserted, and why each rule:
 *  - E301: a Route Handler exporting `GET` must be static-gen enabled
 *    (`dynamic = "force-static"` or a `revalidate`) — a request handler is the
 *    per-request state, so a GET that is not marked static cannot be exported.
 *  - E278: `dynamic = "force-dynamic"` is rejected outright by `output: "export"`.
 *    The probes that need it are excluded from the export build instead (see
 *    tests/unit/build-next-isolated.test.ts) rather than downgraded — flipping
 *    them would let the standalone build cache a liveness body.
 *  - A Server Component `redirect()` cannot be prerendered, and a page that
 *    awaits `searchParams` opts itself out of static generation.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_DIR = path.join(REPO_ROOT, "src", "app");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const APP_FILES = walk(APP_DIR);
const APP_SOURCE = APP_FILES.filter((f) => /\.(ts|tsx)$/.test(f));
const ROUTE_FILES = APP_FILES.filter((f) => /(^|[\\/])route\.ts$/.test(f));

/** `src/app/api/**` is excluded from the export build, not authored for it. */
const IN_EXPORT_BUILD = (file) => !path.relative(APP_DIR, file).split(path.sep).includes("api");

/**
 * Paths the export build physically moves aside, read from the build script
 * itself so this test can never drift from what `build:export` really skips.
 * A route handler that is neither static-gen enabled nor on this list is one
 * the export build will load — and then throw on.
 */
const EXPORT_EXCLUSIONS = getTransientBuildPaths(REPO_ROOT, { OMNIROUTE_EXPORT: "1" }).map(
  (entry) => path.resolve(entry.sourcePath)
);

function isExcludedFromExport(file) {
  const resolved = path.resolve(file);
  return EXPORT_EXCLUSIONS.some(
    (excluded) => resolved === excluded || resolved.startsWith(excluded + path.sep)
  );
}

/** Drop comments so a doc block that quotes `redirect("…")` is not a match. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const DYNAMIC_CONFIG = /export\s+const\s+dynamic\s*=\s*"([^"]+)"/;
const REVALIDATE_CONFIG = /export\s+const\s+revalidate\s*=/;
const SERVER_REDIRECT = /(^|[^.\w])redirect\(/;
const AWAITS_SEARCH_PARAMS = /await\s+searchParams|searchParams\s*\?\s*await/;
const USES_SEARCH_PARAMS_PROP = /\bsearchParams\b/;
/** Any App-Router dynamic segment: `[id]`, `[[...path]]` and `[...slug]` alike. */
const ANY_DYNAMIC_SEGMENT = /\[[^\]]*\]/;

/**
 * Every shape a Route Handler can use to publish a `GET` under Next 16. The
 * first form is the obvious one; the other three come from library-provided
 * handlers (`fumadocs-core`'s `createFromSource` returns
 * `export const { GET } = …`) and are just as fatal under `output: "export"`.
 * Missing any of them lets a real E301 through to a 2.8-minute CI build.
 */
const EXPORTS_GET = [
  /\bexport\s+(?:async\s+)?function\s+GET\b/,
  /\bexport\s+const\s+GET\b/,
  /\bexport\s+const\s*\{[^}]*\bGET\b[^}]*\}/,
  /\bexport\s*\{[^}]*\bGET\b[^}]*\}/,
];

/** Metadata file conventions Next compiles into Route Handlers (`app/manifest.ts` → `/manifest.webmanifest`). */
const METADATA_ROUTE_FILES = /^(manifest|robots|sitemap)\.(t|j)sx?$/;

function rel(file) {
  return path.relative(REPO_ROOT, file);
}

test("the export build actually excludes the paths this test assumes", () => {
  // If the build script ever stops moving these, the checks below silently stop
  // covering them — so assert the assumption rather than trusting it.
  for (const endpoint of ["api", "healthz", "livez", "readyz", "authorize"]) {
    assert.ok(
      isExcludedFromExport(path.join(APP_DIR, endpoint, "route.ts")),
      `src/app/${endpoint} must be in getTransientBuildPaths() for OMNIROUTE_EXPORT=1`
    );
  }
  assert.ok(
    !isExcludedFromExport(path.join(APP_DIR, ".well-known", "agent.json", "route.ts")),
    "src/app/.well-known/agent.json must stay in the export build — it prerenders to out/"
  );
});

test("every Route Handler the export build loads is static-gen enabled (Next E301)", () => {
  const offenders = [];

  for (const file of ROUTE_FILES.filter(IN_EXPORT_BUILD)) {
    if (isExcludedFromExport(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const dynamic = DYNAMIC_CONFIG.exec(src)?.[1];
    const hasGet = EXPORTS_GET.some((re) => re.test(src));
    const staticGen = dynamic === "force-static" || REVALIDATE_CONFIG.test(src);

    if (hasGet && !staticGen) {
      offenders.push(`${rel(file)} — exports GET without dynamic="force-static"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'output:"export" throws E301 on these routes. Mark a genuinely static one\n' +
      '`export const dynamic = "force-static"`, or add it to getTransientBuildPaths()\n' +
      "in scripts/build/build-next-isolated.mjs when it can never be static."
  );
});

test("no Route Handler the export build loads is force-dynamic (Next E278)", () => {
  const offenders = ROUTE_FILES.filter(IN_EXPORT_BUILD)
    .filter((file) => !isExcludedFromExport(file))
    .filter((file) => DYNAMIC_CONFIG.exec(fs.readFileSync(file, "utf8"))?.[1] === "force-dynamic")
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    'output:"export" rejects `dynamic = "force-dynamic"` outright. Do NOT "fix" a\n' +
      "lifecycle probe by downgrading it to force-static — that would let the\n" +
      "standalone build cache the probe body. Exclude it from the export build."
  );
});

test("no Route Handler that exports no GET is left for the export to prerender (Next E582)", () => {
  // A handler that publishes only POST/PUT/DELETE/PATCH/OPTIONS passes the E301
  // gate (it is skipped there), which means `next build` schedules it for
  // prerendering — and the render then aborts with "Route is configured with
  // methods that cannot be statically generated". Declaring `dynamic` (which
  // Next normalises to `revalidate: 0` for the export) keeps it out of the
  // schedule. `/a2a` is the live example: a POST-only JSON-RPC endpoint.
  const offenders = ROUTE_FILES.filter(IN_EXPORT_BUILD)
    .filter((file) => !isExcludedFromExport(file))
    .filter((file) => {
      const src = fs.readFileSync(file, "utf8");
      if (EXPORTS_GET.some((re) => re.test(src))) return false;
      return !DYNAMIC_CONFIG.test(src) && !REVALIDATE_CONFIG.test(src);
    })
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    "This handler exports no GET, so the E301 gate lets it through and the export\n" +
      "build schedules a prerender it cannot perform (Next E582). Add\n" +
      '`export const dynamic = "force-dynamic"` — honest for a per-request\n' +
      "endpoint — or move the tree into getTransientBuildPaths()."
  );
});

test("every metadata file convention in the export build is static-gen enabled (Next E301)", () => {
  // `app/manifest.ts` is compiled by next-metadata-route-loader into the
  // Route Handler `GET /manifest.webmanifest`. That loader re-exports every
  // named export of the source file except `default`, so `export const dynamic`
  // placed in the convention file does reach the route module. Run #5 of the
  // `Dashboard SPA Export` workflow died on exactly this: the convention file
  // shipped without the config, so the loader produced a bare GET.
  const offenders = APP_SOURCE.filter((file) => METADATA_ROUTE_FILES.test(path.basename(file)))
    .filter((file) => !isExcludedFromExport(file))
    .filter((file) => {
      const src = fs.readFileSync(file, "utf8");
      const dynamic = DYNAMIC_CONFIG.exec(src)?.[1];
      return dynamic !== "force-static" && !REVALIDATE_CONFIG.test(src);
    })
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    "A metadata convention file with no static-gen config becomes an unexportable\n" +
      'Route Handler under output:"export". Add `export const dynamic =\n' +
      '"force-static"` — these documents are compile-time constants by nature.'
  );
});

test("no page the export build loads is declared force-dynamic", () => {
  // The mirror of the E278 rule for Route Handlers, and the one that cost run
  // #7: Next's export phase hard-aborts on it —
  //   'Page with `dynamic = "force-dynamic"` couldn\'t be exported.
  //   `output: "export"` requires all pages be renderable statically because
  //   there is no runtime server to dynamically render routes…'
  // Every page in the export build must therefore be prerenderable: a dynamic
  // segment needs a real `generateStaticParams()`, and a route that genuinely
  // cannot be prerendered belongs in getTransientBuildPaths() instead.
  const offenders = APP_SOURCE.filter((file) => path.basename(file).startsWith("page."))
    .filter((file) => !isExcludedFromExport(file))
    .filter((file) => DYNAMIC_CONFIG.exec(fs.readFileSync(file, "utf8"))?.[1] === "force-dynamic")
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    "A force-dynamic page cannot be exported (Next aborts the export phase).\n" +
      "Either return the REAL parameter set from generateStaticParams(), or move the\n" +
      "route into getTransientBuildPaths() in scripts/build/build-next-isolated.mjs."
  );
});

test("every dynamic-segment page the export build loads has a real parameter list (Next E1452)", () => {
  // `output: "export"` refuses a dynamic segment that has no
  // `generateStaticParams()` — and there is no "just mark it dynamic" escape:
  // `dynamic = "force-dynamic"` trips the export-phase abort instead. So a
  // dynamic route is either in this build with an honest list, or out of it.
  const offenders = [];
  for (const file of APP_SOURCE) {
    if (!path.basename(file).startsWith("page.")) continue;
    const p = path.resolve(file);
    if (isExcludedFromExport(p)) continue;
    if (!ANY_DYNAMIC_SEGMENT.test(path.relative(APP_DIR, p).split(path.sep).join("/"))) continue;

    const src = fs.readFileSync(file, "utf8");
    if (!/export\s+(?:async\s+)?function\s+generateStaticParams\b/.test(src)) {
      offenders.push(rel(file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'output:"export" hard-fails on a dynamic segment with no generateStaticParams()\n' +
      "(Next E1452). Return the REAL parameter set — a build-time constant list, as\n" +
      "the CLI-tool, media-provider and provider pages do — or, when the id is a\n" +
      "runtime value, move the route into getTransientBuildPaths()."
  );
});

test("the two agent-card documents are the static surface of /.well-known", () => {
  // The two public discovery documents are the only route handlers that DO belong
  // in out/ — CI and the AISIX native core both read them as files.
  for (const name of ["agent.json", "agent-card.json"]) {
    const file = path.join(APP_DIR, ".well-known", name, "route.ts");
    assert.ok(fs.existsSync(file), `${rel(file)} must exist`);
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /export const dynamic = "force-static"/,
      `${rel(file)} must prerender to out/.well-known/${name}`
    );
    // A dynamic-API read would opt the handler back out of static generation
    // even with force-static set.
    for (const api of ["cookies", "headers", "connection", "draftMode"]) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${api}\\s*\\(\\s*\\)`),
        `${rel(file)} must not read ${api}() — it has no request at build time`
      );
    }
  }
});

test("no page in the SPA surface awaits searchParams (unprerenderable)", () => {
  const offenders = [];

  for (const file of APP_SOURCE.filter(IN_EXPORT_BUILD)) {
    if (!path.basename(file).startsWith("page.")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (AWAITS_SEARCH_PARAMS.test(src) && USES_SEARCH_PARAMS_PROP.test(src)) {
      offenders.push(rel(file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Awaiting `searchParams` opts a page out of static generation and hard-fails\n" +
      'output:"export". Read the query in a Client Component behind <Suspense> instead\n' +
      "(see src/app/page.tsx)."
  );
});

test("no Server Component in the SPA surface calls redirect()", () => {
  const offenders = [];

  for (const file of APP_SOURCE.filter(IN_EXPORT_BUILD)) {
    if (!path.basename(file).startsWith("page.")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/^\s*["']use client["']/m.test(src)) continue;
    if (SERVER_REDIRECT.test(stripComments(src))) offenders.push(rel(file));
  }

  assert.deepEqual(
    offenders,
    [],
    'A Server Component redirect() cannot be prerendered for output:"export".\n' +
      "Use <StaticRedirect to=... /> (constant target) or a Client Component\n" +
      "redirector behind <Suspense> (target derived from the query string)."
  );
});

test("the dashboard root and home entrypoints stay statically renderable", () => {
  for (const relPath of [
    "src/app/(dashboard)/dashboard/page.tsx",
    "src/app/(dashboard)/home/page.tsx",
  ]) {
    const file = path.join(REPO_ROOT, relPath);
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /export const dynamic\s*=\s*"force-dynamic"/,
      `${relPath} regressed to force-dynamic — it must stay prerenderable`
    );
    for (const api of ["cookies", "headers", "connection"]) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${api}\\s*\\(\\s*\\)`),
        `${relPath} must not read ${api}()`
      );
    }
  }
});

test("every client component reading useSearchParams sits behind a Suspense boundary", () => {
  const DASHBOARD_DIR = path.join(APP_DIR, "(dashboard)");
  const dashboardFiles = walk(DASHBOARD_DIR).filter((f) => /\.(ts|tsx)$/.test(f));
  const offenders = [];

  for (const file of dashboardFiles) {
    if (!path.basename(file).startsWith("page.")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (!/useSearchParams|useParams/.test(src)) continue;

    // The page is responsible for the boundary: either it is itself a client
    // component that opens one, or it wraps the client child in one.
    const opensBoundary = /<Suspense[\s>]/.test(src);
    if (!opensBoundary) offenders.push(rel(file));
  }

  assert.deepEqual(
    offenders,
    [],
    "useSearchParams()/useParams() need a <Suspense> boundary above them or\n" +
      'output:"export" refuses to prerender the page.'
  );
});

/**
 * Every dynamic-segment route, split by how the static export resolves it.
 *
 * Next documents "Dynamic Routes without `generateStaticParams()`" as
 * unsupported under `output: "export"`, and there is no third option: a page
 * declared `force-dynamic` is rejected just as hard, at the export phase
 * ("Page with `dynamic = "force-dynamic"` couldn't be exported"), because the
 * output format has no runtime server. So each route below is in one group or
 * the other.
 *
 * PRERENDERED — the parameter set is a build-time CONSTANT, so the page returns
 * the real list and every emitted page corresponds to a target that genuinely
 * exists. No placeholder ids, and no real id missing from `out/`.
 *
 * EXCLUDED — the parameter is a runtime value (a database row, an
 * operator-installed plugin, a single-use share token) or the page is
 * request-scoped by design, so there is no honest list to return. Those trees
 * move aside for the export build; see `getTransientBuildPaths()` in
 * scripts/build/build-next-isolated.mjs. The routes are a real, reported gap in
 * the static bundle — not a silent stub — and the `output: "standalone"` build,
 * which is what actually serves them, is untouched.
 *
 * This is an inventory, not an endorsement. It is asserted so that ADDING a
 * tenth dynamic route fails here — pinned to one group or the other — instead
 * of surfacing as a 2.8-minute CI build (Next E1452), and so that moving a
 * route between the groups forces this comment to be updated.
 */
const PRERENDERED_DYNAMIC_ROUTES = [
  // 10 agent tools, from the `CLI_TOOLS` literal registry.
  "src/app/(dashboard)/dashboard/cli-agents/[id]/page.tsx",
  // 26 code tools, from the same registry.
  "src/app/(dashboard)/dashboard/cli-code/[id]/page.tsx",
  // 163 (kind, provider) pairs, from `MEDIA_KINDS` x `AI_PROVIDERS`.
  "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.tsx",
  // 10 media kinds, from the `MediaKind` literal union.
  "src/app/(dashboard)/dashboard/media-providers/[kind]/page.tsx",
  // 358 providers, from the `AI_PROVIDERS` catalog.
  "src/app/(dashboard)/dashboard/providers/[id]/page.tsx",
];

const EXCLUDED_DYNAMIC_ROUTES = [
  // A row in the operator's own database.
  "src/app/(dashboard)/dashboard/combos/[id]/page.tsx",
  // An operator-installed plugin, from the runtime plugin registry.
  "src/app/(dashboard)/dashboard/plugins/[name]/config/page.tsx",
  // A single-use share token.
  "src/app/connect/codex/[token]/page.tsx",
  // The docs site is force-dynamic by design and reads the locale cookie.
  "src/app/docs/[...slug]/page.tsx",
];

test("the export build never hands the message catalogue to a Client Component", () => {
  // AGENT.md §3.3 — the ~1.9 GiB payload bug.
  //
  // `<NextIntlClientProvider messages={…}>` rendered by a SERVER component is a
  // prop crossing the RSC boundary, so the whole next-intl tree is re-serialized
  // into the flight payload of every prerendered route. Measured on artifact
  // `10928452044`: a single 690,493-byte English catalogue row was byte-identical
  // across 359 of 360 inspected `<route>.txt` files, plus 515.6 MiB of the same
  // bytes inside the `<route>.html` `self.__next_f` script bodies.
  //
  // The fix is structural — the catalogue reaches the provider as an IMPORT inside
  // a Client Component, because an import between two Client Components is never
  // serialized while a Server-Component prop always is. Re-adding a `messages`
  // prop is a one-line change that costs 1.9 GiB in CI minutes, so it has to fail
  // HERE, statically, instead. Each assertion below names the exact edit it
  // catches and fails on its own.
  const layout = fs.readFileSync(path.join(APP_DIR, "layout.tsx"), "utf8");
  const providerSource = fs.readFileSync(
    path.join(REPO_ROOT, "src", "i18n", "SpaIntlProvider.tsx"),
    "utf8"
  );

  assert.match(
    layout,
    /isAisixSpaExport\(\)/,
    'src/app/layout.tsx must branch on the SPA export marker — the `output:"standalone"`\n' +
      "build keeps server-negotiated messages per request, the static export cannot."
  );
  assert.match(
    layout,
    /isSpaExport\s*\?[\s\S]{0,200}?<SpaIntlProvider\s+locale=\{locale\}>/,
    "the export branch must render <SpaIntlProvider locale={locale}>, the component that\n" +
      "owns the catalogue itself"
  );
  assert.doesNotMatch(
    layout,
    /<SpaIntlProvider[^>]*\smessages=/,
    "<SpaIntlProvider> must not receive a `messages` prop — that is precisely the\n" +
      "RSC-boundary serialization this provider exists to avoid."
  );
  assert.match(
    providerSource,
    /^"use client";/m,
    "src/i18n/SpaIntlProvider.tsx must be a Client Component: that is what keeps the\n" +
      "catalogue out of the flight payload."
  );
  assert.match(
    providerSource,
    /import enCatalog from "@\/i18n\/messages\/en\.json"/,
    "the provider must import the catalogue as a module, so the server render pass and\n" +
      "hydration both resolve it synchronously (no Suspense, no untranslated flash)."
  );
  assert.doesNotMatch(
    providerSource,
    /next-intl\/server|next\/headers|@\/i18n\/request/,
    "the provider must not reach the request config: it pulls `next/headers` into the\n" +
      "CLIENT graph, which cannot be resolved and would fail the export build."
  );
});

test("both locale writers drive the client channel and skip the server-only refresh in the export", () => {
  // `persistLocale()` + `router.refresh()` is the ONLY contract a
  // `output: \"standalone\"` server can honour: there is a server to re-render. A
  // static export has none, so `router.refresh()` re-downloads the very same
  // English payload and the selection silently does nothing. Both writers must
  // therefore announce the locale on the client and skip the refresh when the
  // bundle is the SPA.
  for (const relPath of [
    "src/shared/components/LanguageSelector.tsx",
    "src/shared/components/LocaleAutoDetect.tsx",
  ]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");

    assert.match(
      src,
      /setClientLocale\(/,
      `${relPath} must write the locale through setClientLocale() (cookie + localStorage\n` +
        "plus the client catalogue swap), not through persistLocale() alone."
    );
    assert.doesNotMatch(
      src,
      /import\s*\{[^}]*persistLocale[^}]*\}\s*from/,
      `${relPath} must go through setClientLocale(); a bare persistLocale() leaves the\n` +
        "rendered catalogue on the old locale."
    );
    assert.match(
      src,
      /isAisixSpaExport\(\)/,
      `${relPath} must consult isAisixSpaExport() to decide whether router.refresh() is\n` +
        "meaningful — in the export it re-fetches an identical payload."
    );
  }
});

test("the i18n request config resolves a locale without entering the request scope when exporting", () => {
  // `src/i18n/request.ts` backs `getLocale()` / `getMessages()` /`getTranslations()`,
  // and the ROOT layout calls all three — so this module runs for every page the
  // export prerenders. Its live path reads `cookies()` then `headers()`. Under
  // `output: "export"` the renderer is pinned to `dynamic = "error"`, so
  // touching the request scope aborts the render (Next E611) and the route never
  // reaches `out/`. One unguarded read here would empty the whole export, so the
  // export build must short-circuit BEFORE the first request read.
  const source = fs.readFileSync(path.join(REPO_ROOT, "src", "i18n", "request.ts"), "utf8");
  const shortCircuit = source.indexOf('process.env.OMNIROUTE_EXPORT === "1"');
  assert.notStrictEqual(
    shortCircuit,
    -1,
    "src/i18n/request.ts must short-circuit on OMNIROUTE_EXPORT=1 — a static export\n" +
      "has no request to read, and the root layout resolves this config for every route."
  );

  const firstRequestRead = Math.min(
    ...["cookies()", "headers()"]
      .map((call) => source.indexOf(`await ${call}`))
      .filter((index) => index !== -1)
  );
  assert.ok(
    firstRequestRead !== Infinity && shortCircuit < firstRequestRead,
    "The OMNIROUTE_EXPORT short-circuit must come before the cookies()/headers() reads.\n" +
      `Found the short-circuit at offset ${shortCircuit} and the first request read at\n` +
      `offset ${firstRequestRead}. The live path after it keeps per-request locale\n` +
      "negotiation untouched."
  );
});

test("the export locale resolver loads the default-locale message tree with no request", async () => {
  const { resolveLocaleMessages } = await import("../../src/i18n/request.ts");
  const messages = await resolveLocaleMessages(DEFAULT_LOCALE);

  assert.equal(typeof messages, "object");
  assert.notStrictEqual(messages, null);
  // The export build calls this with no request at all, so it must resolve a
  // complete tree on its own. An empty/partial object would render an untranslated
  // shell into every page of `out/`.
  assert.ok(
    Object.keys(messages).length > 50,
    `expected a populated message tree, got ${Object.keys(messages).length} namespaces`
  );
});

test("the agent-card base URL never reads the request origin when exporting (Next E575)", async () => {
  // Under `output: "export"` Next pins a Route Handler's dynamic mode to
  // `error` and passes a request proxy that THROWS on `nextUrl.origin`. Both
  // agent-card routes are `force-static` and DO prerender, so an unguarded read
  // here aborts the very first page of the export (run #6 died on
  // `/.well-known/agent-card.json` with exactly that error).
  const source = fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "wellKnown.ts"), "utf8");
  const guard = source.indexOf('process.env.OMNIROUTE_EXPORT === "1"');
  const read = source.indexOf("request?.nextUrl?.origin");

  assert.notStrictEqual(guard, -1, "src/lib/wellKnown.ts must guard on OMNIROUTE_EXPORT=1");
  assert.ok(
    guard < read,
    "The OMNIROUTE_EXPORT guard must come before the `request.nextUrl.origin` read.\n" +
      `Found the guard at offset ${guard} and the read at offset ${read}.`
  );

  // Behavioural half: with the export profile set and a request whose origin
  // read would throw, the resolver must return the build-time base URL.
  const previous = { export: process.env.OMNIROUTE_EXPORT, base: process.env.OMNIROUTE_BASE_URL };
  process.env.OMNIROUTE_EXPORT = "1";
  delete process.env.OMNIROUTE_BASE_URL;
  try {
    const { getBaseUrl } = await import("../../src/lib/wellKnown.ts");
    const hostileRequest = {
      get nextUrl(): never {
        throw new Error("nextUrl.origin is not readable under output: export (E575)");
      },
    };
    assert.strictEqual(getBaseUrl(hostileRequest as never), "http://localhost:20128");

    // An explicit build-time override still wins.
    process.env.OMNIROUTE_BASE_URL = "https://gateway.example.com";
    assert.strictEqual(getBaseUrl(hostileRequest as never), "https://gateway.example.com");
  } finally {
    if (previous.export === undefined) delete process.env.OMNIROUTE_EXPORT;
    else process.env.OMNIROUTE_EXPORT = previous.export;
    if (previous.base === undefined) delete process.env.OMNIROUTE_BASE_URL;
    else process.env.OMNIROUTE_BASE_URL = previous.base;
  }
});

test("the inventory of dynamic-segment routes is still accurate", () => {
  const prerendered = [];
  const notPrerendered = [];

  for (const file of walk(APP_DIR)) {
    if (!path.basename(file).startsWith("page.")) continue;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const relative = path.relative(APP_DIR, path.resolve(file)).split(path.sep).join("/");
    if (!ANY_DYNAMIC_SEGMENT.test(relative)) continue;

    const p = path.resolve(file);
    if (isExcludedFromExport(p)) {
      notPrerendered.push(rel(file));
    } else if (
      /export\s+(?:async\s+)?function\s+generateStaticParams\b/.test(fs.readFileSync(file, "utf8"))
    ) {
      prerendered.push(rel(file));
    }
  }

  assert.deepEqual(
    prerendered.sort(),
    [...PRERENDERED_DYNAMIC_ROUTES].sort(),
    "The set of PRERENDERED dynamic-segment routes changed. A new one is a fresh\n" +
      'output:"export" obligation — give it a real generateStaticParams() and list it\n' +
      "here, or move it to EXCLUDED_DYNAMIC_ROUTES with a reason.\n" +
      "A REMOVED one means it is now excluded from the export build (or its segment\n" +
      "became static) — move it to the other list and update the comment above."
  );

  assert.deepEqual(
    notPrerendered.sort(),
    [...EXCLUDED_DYNAMIC_ROUTES].sort(),
    "The set of dynamic-segment routes EXCLUDED from the export build changed.\n" +
      'A route that is neither prerendered nor excluded is a fresh output:"export"\n' +
      "blocker (Next E1452) — it needs a real generateStaticParams(), or its tree\n" +
      "needs to be in getTransientBuildPaths().\n" +
      "A REMOVED one means someone gave it a generateStaticParams(); move it to\n" +
      "PRERENDERED_DYNAMIC_ROUTES."
  );
});
