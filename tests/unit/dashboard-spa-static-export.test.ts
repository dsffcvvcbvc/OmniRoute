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

test("every dynamic-segment page in the export build declares how it is resolved (Next E1452)", () => {
  // `output: "export"` refuses a dynamic segment that is neither given a
  // `generateStaticParams()` nor declared uncacheable. `force-dynamic` is the
  // declaration that matters: Next normalises it to `revalidate: 0` for the
  // export, which removes the page from the prerender schedule instead of
  // aborting the whole build. This is also how the pre-existing
  // `docs/[...slug]` and `connect/codex/[token]` pages stay in the export build.
  const offenders = [];
  for (const file of APP_SOURCE) {
    if (!path.basename(file).startsWith("page.")) continue;
    const p = path.resolve(file);
    if (isExcludedFromExport(p)) continue;
    if (!ANY_DYNAMIC_SEGMENT.test(path.relative(APP_DIR, p).split(path.sep).join("/"))) continue;

    const src = fs.readFileSync(file, "utf8");
    const dynamic = DYNAMIC_CONFIG.exec(src)?.[1];
    const resolved = /export\s+(?:async\s+)?function\s+generateStaticParams\b/.test(src);
    if (!resolved && dynamic !== "force-dynamic" && !REVALIDATE_CONFIG.test(src)) {
      offenders.push(rel(file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'output:"export" hard-fails on a dynamic segment with no generateStaticParams()\n' +
      "(Next E1452). Either return the REAL parameter set (a build-time constant\n" +
      "list, as the CLI-tool and media-kind pages do) or declare the route\n" +
      '`dynamic = "force-dynamic"` when the parameter is a runtime id.'
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
 * Every dynamic-segment page in the export build, and HOW it is resolved.
 *
 * Next documents "Dynamic Routes without `generateStaticParams()`" as
 * unsupported under `output: "export"`. There are exactly two honest ways out,
 * and every route below takes one of them.
 *
 * PRERENDERED — the parameter is a small build-time CONSTANT, so the page
 * returns the real list. `CLI_TOOLS` and `MEDIA_KINDS` are literal registries,
 * so each emitted page corresponds to a target that really exists: no
 * placeholder ids, and no real id 404s against the prerendered set.
 *
 * DYNAMIC — the parameter is a runtime identifier (a database row, an
 * operator-installed plugin, a one-time share token) or a cross product far too
 * large to be worth emitting. There is no honest list to return, so the page
 * declares `dynamic = "force-dynamic"`, which Next normalises to
 * `revalidate: 0` for the export and keeps it off the prerender schedule. The
 * route is then simply absent from `out/` — a real, reported limitation of the
 * static bundle, not a build failure. Giving these a `generateStaticParams()`
 * would be worse than leaving them out: a placeholder list emits an HTML page
 * per placeholder and 404s every real id in the static host.
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
  // 10 media kinds, from the `MediaKind` literal union.
  "src/app/(dashboard)/dashboard/media-providers/[kind]/page.tsx",
];

const DYNAMIC_DECLARED_ROUTES = [
  "src/app/(dashboard)/dashboard/combos/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/plugins/[name]/config/page.tsx",
  "src/app/(dashboard)/dashboard/providers/[id]/page.tsx",
  "src/app/connect/codex/[token]/page.tsx",
  "src/app/docs/[...slug]/page.tsx",
];

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

test("the inventory of dynamic-segment pages in the export build is still accurate", () => {
  const prerendered = [];
  const declared = [];

  for (const file of walk(APP_DIR)) {
    if (!path.basename(file).startsWith("page.")) continue;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const p = path.resolve(file);
    if (isExcludedFromExport(p)) continue;
    if (!ANY_DYNAMIC_SEGMENT.test(path.relative(APP_DIR, p).split(path.sep).join("/"))) continue;

    const src = fs.readFileSync(file, "utf8");
    if (/export\s+(?:async\s+)?function\s+generateStaticParams\b/.test(src))
      prerendered.push(rel(file));
    else declared.push(rel(file));
  }

  assert.deepEqual(
    prerendered.sort(),
    [...PRERENDERED_DYNAMIC_ROUTES].sort(),
    "The set of PRERENDERED dynamic-segment pages changed. A new one is a fresh\n" +
      'output:"export" obligation — give it a real generateStaticParams() and list\n' +
      "it here, or move it to DYNAMIC_DECLARED_ROUTES with a reason.\n" +
      "A REMOVED one means it is no longer in the export build (moved into\n" +
      "getTransientBuildPaths(), or its segment became static) — drop it here."
  );

  assert.deepEqual(
    declared.sort(),
    [...DYNAMIC_DECLARED_ROUTES].sort(),
    "The set of dynamic-segment pages DECLARED dynamic changed. A new one is a\n" +
      'fresh output:"export" blocker (Next E1452) — it needs a real\n' +
      'generateStaticParams() or an explicit `dynamic = "force-dynamic"`.\n' +
      "A REMOVED one means someone gave it a generateStaticParams(); move it to\n" +
      "PRERENDERED_DYNAMIC_ROUTES and update the comment above."
  );
});
