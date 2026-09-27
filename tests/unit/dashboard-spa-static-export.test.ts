import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTransientBuildPaths } from "../../scripts/build/build-next-isolated.mjs";

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
    const hasGet = /\bexport\s+(?:async\s+)?function\s+GET\b/.test(src);
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
 * The export blockers that are NOT fixed, asserted as an exact set.
 *
 * Next documents "Dynamic Routes without `generateStaticParams()`" as
 * unsupported under `output: "export"`. Every route below is a client-only
 * deep-link view whose parameter is genuinely unknown at build time, so there is
 * no honest `generateStaticParams()` to write: returning a placeholder list
 * would emit an HTML page per placeholder and 404 every real id in the static
 * host. Fixing them means restructuring each route to a static shell + a
 * client-side resolver (the same shape `StaticRedirect` gives the alias pages),
 * which is a routing change well beyond removing the build blockers — and six of
 * the eight live in the provider / embedded-service / combo trees that
 * AGENT.md keeps off the SPA surface (MITM, SQLite, child processes).
 *
 * This is an inventory, not an endorsement. It is asserted so that ADDING a
 * tenth dynamic route to the export build fails here instead of surfacing as a
 * 2.8-minute CI build, and so removing one forces the list to be updated.
 */
const KNOWN_UNRESOLVED_DYNAMIC_ROUTES = [
  "src/app/(dashboard)/dashboard/cli-agents/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/cli-code/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/combos/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.tsx",
  "src/app/(dashboard)/dashboard/media-providers/[kind]/page.tsx",
  "src/app/(dashboard)/dashboard/plugins/[name]/config/page.tsx",
  "src/app/(dashboard)/dashboard/providers/[id]/page.tsx",
  "src/app/connect/codex/[token]/page.tsx",
  "src/app/docs/[...slug]/page.tsx",
];

test("the inventory of unresolved dynamic-segment export blockers is still accurate", () => {
  const actual = [];

  for (const file of walk(APP_DIR)) {
    if (!path.basename(file).startsWith("page.")) continue;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const p = path.resolve(file);
    if (isExcludedFromExport(p)) continue;
    if (ANY_DYNAMIC_SEGMENT.test(path.relative(APP_DIR, p).split(path.sep).join("/"))) {
      actual.push(rel(file));
    }
  }

  assert.deepEqual(
    actual.sort(),
    [...KNOWN_UNRESOLVED_DYNAMIC_ROUTES].sort(),
    "The set of dynamic-segment pages in the export build changed. A new one is a\n" +
      'fresh output:"export" blocker — fix it or add it here with a reason.\n' +
      "A REMOVED one means someone gave it a generateStaticParams(); drop it from\n" +
      "this list and from the comment above."
  );
});
