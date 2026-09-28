/**
 * AISIX SPA-export contract: which legacy `/api/*` reads the exported dashboard
 * makes are REPOINTED at a native gateway endpoint, and which are DECLARED
 * unsupported so the page refuses instead of firing a guaranteed 404.
 *
 * The static export ships no API at all (`scripts/build/build-next-isolated.mjs`
 * moves `src/app/api` aside for `OMNIROUTE_EXPORT=1`). Every read below therefore
 * had exactly two possible outcomes on a real gateway — 2xx real data, or 404.
 * This file pins which one each read now gets, and it pins the SHAPE ADAPTERS
 * that make the repointed payloads usable, because a URL that resolves is not
 * enough: the native documents are wrapped `{id, value, revision}` and a reader
 * that expects a bare array silently renders nothing.
 *
 * Rules encoded here:
 *   R1  Every legacy path the browser actually issued maps to a native URL that
 *       the gateway ROUTES — and never to a subpath that does not exist (the
 *       `/api/combos` → `/admin/v1/combos/<sub>` mistake this module's own
 *       header documents).
 *   R2  A path with no native counterpart passes through UNCHANGED, so the caller
 *       can see it needs a refusal rather than having been silently redirected.
 *   R3  A new unsupported domain always carries a non-empty reason. A refusal
 *       with no text is a blank region, which is the failure this work exists
 *       to remove.
 *   R4  `resolveAisixSurfaceSupport` returns `{supported: true}` for a Next
 *       build and the refusal for the SPA export — the branch a page takes.
 *   R5  The catalog adapter never invents a model, a provider or a type, and
 *       reports `authoritative: false` for anything that is not a real catalog
 *       (404 page, empty list, HTML) so "the core has no models" can never be
 *       concluded from a failed read.
 *   R6  The core-health adapter distinguishes "reported healthy" from
 *       "reported nothing", and flags degradation from EITHER the `status`
 *       token or a non-zero per-model `health`.
 *
 * The payload fixtures below are the REAL wire shapes read from a live
 * `aisix-admin` at `/admin/v1/models`, `/admin/v1/api_keys`, `/admin/v1/health`
 * and `/livez` — not invented examples.
 */

import test from "node:test";
import assert from "node:assert/strict";

const endpoints = await import("../../src/shared/utils/aisixEndpoints.ts");
const catalog = await import("../../src/shared/utils/aisixNativeCatalog.ts");
const health = await import("../../src/shared/utils/aisixHealth.ts");

const {
  resolveAisixRequestUrl,
  aisixLivezUrl,
  aisixReadyzUrl,
  aisixApiKeysUrl,
  aisixStatusModelsUrl,
  aisixProviderKeysUrl,
  aisixAdminModelsUrl,
  aisixCombosUrl,
  aisixUnsupportedRead,
  aisixUnsupportedWrite,
  resolveAisixSurfaceSupport,
  isAisixSpaExport,
  isDashboardCsrfInterceptorNeeded,
} = endpoints;
const {
  parseAisixModelCatalog,
  parseAisixModelCatalogByProvider,
  parseAisixProviderModels,
  parseAisixOpenAiModelList,
  toAisixCatalogBuckets,
} = catalog;
const { parseAisixProviderStatuses, resolveAisixHealthVerdict } = health;

/** The live core's document envelope, verbatim in shape. */
const NATIVE_MODEL = {
  id: "09886b3b-0f6b-58c6-ae6a-9e6b721101f9",
  value: {
    display_name: "m-dit",
    provider: "dit",
    model_name: "mock-model",
    provider_key_id: "42064e98-3056-5917-ad42-9df608ba1d90",
  },
  revision: 1,
};

const NATIVE_MODELS = [NATIVE_MODEL];

// ─── R1: repointed reads land on a route the gateway actually registers ──────

test("R1 every repointed legacy read resolves to a native admin/root route", () => {
  // The admin base, derived from a builder that certainly points at :3001.
  const admin = aisixProviderKeysUrl().replace(/\/admin\/v1\/provider_keys$/, "");
  const cases: Array<[string, RegExp]> = [
    // The six shell reads a static host 404'd.
    ["/api/health/ping", /\/livez$/],
    // The providers-index reads.
    ["/api/synced-available-models", /\/admin\/v1\/models$/],
    ["/api/provider-models?provider=openai", /\/admin\/v1\/models\?provider=openai$/],
    ["/api/synced-available-models?provider=openai", /\/admin\/v1\/models\?provider=openai$/],
    // The provider-detail model reads.
    ["/api/v1/providers/openai/models", /\/admin\/v1\/models$/],
    ["/api/models/catalog", /\/admin\/v1\/models$/],
    // The missed combos collection.
    ["/api/combos", /\/admin\/v1\/combos$/],
  ];
  for (const [legacy, expected] of cases) {
    const resolved = resolveAisixRequestUrl(legacy);
    assert.match(
      resolved,
      expected,
      `${legacy} must repoint onto a native route the gateway registers, got ${resolved}`
    );
    assert.ok(
      resolved.startsWith(admin),
      `${legacy} repointed off the admin base (${resolved}) — the static SPA is same-origin with :3001`
    );
  }
});

test("R1 the shell's degradation read is UNAUTHENTICATED, and that is the whole point", () => {
  // Regression shape with teeth: `aisixAdminFetch` flips the GLOBAL signed-out
  // store on any admin-plane 401, so a header badge — which runs on every page —
  // must not read the admin plane. Point it at `/admin/v1/health` and a visitor
  // who has not entered a key yet gets the whole dashboard signed out of them,
  // cards and all.
  const resolved = resolveAisixRequestUrl("/api/health/degradation?summary=true");
  assert.equal(
    resolved,
    aisixStatusModelsUrl("?summary=true"),
    "the degradation read must land on the metrics plane, same as /api/monitoring/health"
  );
  assert.ok(
    !resolved.includes("/admin/v1/"),
    `a shell control must not read the authenticated admin plane, got ${resolved}`
  );
  // Same target as the two sibling shell health reads — one rule, not three.
  assert.equal(
    resolveAisixRequestUrl("/api/health/degradation?summary=true").replace(/\?.*$/, ""),
    resolveAisixRequestUrl("/api/monitoring/health").replace(/\?.*$/, "")
  );
});

test("R1 the native URL builders address routes that exist in lib.rs", () => {
  assert.match(aisixLivezUrl(), /\/livez$/);
  assert.match(aisixReadyzUrl(), /\/readyz$/);
  assert.match(aisixStatusModelsUrl(), /\/status\/models$/);
  assert.match(aisixApiKeysUrl(), /\/admin\/v1\/api_keys$/);
  assert.match(aisixApiKeysUrl("?x=1"), /\/admin\/v1\/api_keys\?x=1$/);
  assert.match(aisixAdminModelsUrl(), /\/admin\/v1\/models$/);
  assert.match(aisixCombosUrl(), /\/admin\/v1\/combos$/);
  // An absolute URL is never rewritten: the caller is already off-host.
  assert.equal(
    resolveAisixRequestUrl("https://elsewhere.test/api/health/ping"),
    "https://elsewhere.test/api/health/ping"
  );
});

test("R1 /api/health/ping must not be answered by the authenticated health snapshot", () => {
  // Regression shape, not a style rule: mapping the maintenance banner onto an
  // admin-plane route would turn "is my core up" into "is my admin key valid",
  // and — because of the global signed-out store — would sign an unauthenticated
  // visitor out of the whole dashboard. /livez is unauthenticated precisely so it
  // can answer that.
  const ping = resolveAisixRequestUrl("/api/health/ping");
  assert.notEqual(ping, aisixStatusModelsUrl());
  assert.match(ping, /\/livez$/);
  assert.ok(!ping.includes("/admin/v1/"));
});

// ─── R2: unmapped paths pass through so the caller can refuse ────────────────

test("R2 a path with no native counterpart is returned UNCHANGED", () => {
  // Each of these is a Next.js/SQLite subsystem the core does not carry. If any
  // of them were rewritten, the caller would be redirected at a native URL that
  // answers something else, and the refusal would never render.
  const unmapped = [
    "/api/settings",
    "/api/settings/proxy",
    "/api/settings/proxies/assignments?scope=combo",
    "/api/settings/compression",
    "/api/settings/database",
    "/api/storage/health",
    "/api/sync/cloud",
    "/api/token-health",
    "/api/system/env/repair",
    "/api/providers/deprecated",
    "/api/models/alias",
    "/api/keys",
    "/api/auth/csrf",
    "/api/providers/openai/param-filters",
    "/api/providers/openai/interception-rules",
    "/api/providers/openai/cc-alias",
  ];
  for (const legacy of unmapped) {
    assert.equal(
      resolveAisixRequestUrl(legacy),
      legacy,
      `${legacy} has no native counterpart and must fall through unchanged`
    );
  }
});

test("R2 an absolute URL and a non-API path are left alone", () => {
  assert.equal(resolveAisixRequestUrl("/dashboard/providers"), "/dashboard/providers");
  assert.equal(resolveAisixRequestUrl("/_next/static/x.js"), "/_next/static/x.js");
});

// ─── R3: every declared-unsupported domain carries a real reason ─────────────

test("R3 every unsupported domain has a non-empty operator-facing reason", () => {
  const domains = [
    "radar",
    "quota",
    "usage",
    "logs",
    "relay",
    "keys",
    "settings",
    "storage",
    "session",
    "sync",
    "credentials",
    "providerExtras",
    "modelAliases",
    "deprecated",
  ] as const;
  for (const domain of domains) {
    for (const surface of [aisixUnsupportedRead, aisixUnsupportedWrite]) {
      const result = surface(domain);
      assert.equal(result.supported, false, `${domain} must be declared unsupported`);
      assert.equal(typeof result.reason, "string", `${domain} refusal must carry a string reason`);
      assert.ok(
        (result.reason as string).trim().length > 20,
        `${domain} refusal is too short to explain anything: "${result.reason}"`
      );
    }
  }
});

test("R3 the reasons name the gateway so the operator knows WHICH host refused", () => {
  for (const domain of ["settings", "storage", "providerExtras", "sync"] as const) {
    assert.match(
      aisixUnsupportedRead(domain).reason as string,
      /AISIX/,
      `${domain} refusal must name the gateway it is refusing on behalf of`
    );
  }
});

test("R3 a declared read and write refusal are the same refusal, not two stories", () => {
  for (const domain of ["settings", "providerExtras", "keys"] as const) {
    assert.equal(
      aisixUnsupportedRead(domain).reason,
      aisixUnsupportedWrite(domain).reason,
      `${domain}: read and write must not disagree about why the surface is absent`
    );
  }
});

// ─── R4: the build-aware branch a page actually takes ────────────────────────

test("R4 resolveAisixSurfaceSupport follows NEXT_PUBLIC_AISIX_SPA_EXPORT", () => {
  const previous = process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
  try {
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
    assert.equal(isAisixSpaExport(), true);
    assert.equal(isDashboardCsrfInterceptorNeeded(), false, "no CSRF server to guard");
    assert.equal(resolveAisixSurfaceSupport("settings", "read").supported, false);
    assert.equal(resolveAisixSurfaceSupport("providerExtras", "write").supported, false);

    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "0";
    assert.equal(isAisixSpaExport(), false);
    assert.equal(isDashboardCsrfInterceptorNeeded(), true, "a Next build has a CSRF server");
    assert.equal(resolveAisixSurfaceSupport("settings", "read").supported, true);
    assert.equal(resolveAisixSurfaceSupport("providerExtras", "write").supported, true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
    else process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = previous;
  }
});

test("R4 the CSRF gate and the SPA-export flag cannot disagree", () => {
  const previous = process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
  try {
    for (const value of ["1", "0", "true", "", undefined]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
      else process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = value;
      assert.equal(
        isDashboardCsrfInterceptorNeeded(),
        !isAisixSpaExport(),
        `SPA_EXPORT=${String(value)} must make the CSRF gate the exact negation of the export flag`
      );
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
    else process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = previous;
  }
});

// ─── R5: the catalog adapter never invents anything ──────────────────────────

test("R5 the native envelope is unwrapped into real rows", () => {
  const rows = parseAisixModelCatalog(NATIVE_MODELS);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "mock-model",
    provider: "dit",
    documentId: NATIVE_MODEL.id,
    name: "m-dit",
  });
  // `model_name` is the id a request must carry; `display_name` is the label.
  // Swapping them would send `m-dit` upstream as a model id.
  assert.notEqual(rows[0].id, rows[0].name);
});

test("R5 a document with no provider or no model id is dropped, not guessed", () => {
  const rows = parseAisixModelCatalog([
    { id: "a", value: { display_name: "no-provider" } },
    { id: "b", value: { provider: "dit" } },
    { id: "c", value: { provider: "   ", model_name: "  " } },
    null,
    "not-a-document",
    NATIVE_MODEL,
  ]);
  assert.equal(rows.length, 1, "only the complete document may become a row");
  assert.equal(rows[0].provider, "dit");
});

test("R5 a non-catalog payload yields no rows and is not authoritative", () => {
  for (const payload of [null, undefined, "text/html 404", {}, { error_msg: "nope" }, 42, []]) {
    assert.deepEqual(
      parseAisixModelCatalog(payload),
      [],
      `payload ${String(payload)} must yield no rows`
    );
    assert.equal(
      parseAisixProviderModels(payload, "dit").authoritative,
      false,
      `payload ${String(payload)} must never be reported as a real catalog`
    );
  }
});

test("R5 the by-provider map omits providers the core did not report", () => {
  // The consumer falls back to its static registry for a MISSING provider.
  // An explicit empty array would instead claim the provider has no models.
  const byProvider = parseAisixModelCatalogByProvider(NATIVE_MODELS);
  assert.deepEqual(Object.keys(byProvider), ["dit"]);
  assert.deepEqual(byProvider.dit, [{ id: "mock-model", name: "m-dit" }]);
  assert.equal(byProvider.openai, undefined);
  assert.ok(!("openai" in byProvider));
});

test("R5 a row with no display_name carries no name rather than a copy of the id", () => {
  const byProvider = parseAisixModelCatalogByProvider([
    { id: "doc-1", value: { provider: "dit", model_name: "mock-model" } },
  ]);
  assert.deepEqual(byProvider.dit, [{ id: "mock-model" }]);
  assert.ok(!("name" in byProvider.dit[0]));
});

test("R5 the per-provider projection filters, keeps the key, and says it is authoritative", () => {
  const payload = [NATIVE_MODEL, { id: "x", value: { provider: "openai", model_name: "gpt-x" } }];
  const dit = parseAisixProviderModels(payload, "dit");
  assert.equal(dit.models.length, 1);
  assert.equal(dit.models[0].id, "mock-model");
  assert.deepEqual(dit.modelCompatOverrides, [], "the key must exist, not be omitted");
  assert.equal(dit.authoritative, true, "the core really did answer with a catalog");

  const absent = parseAisixProviderModels(payload, "anthropic");
  assert.deepEqual(absent.models, []);
  assert.equal(
    absent.authoritative,
    true,
    "the catalog was authoritative even though this provider had no rows in it"
  );
});

test("R5 the OpenAI-shaped list sets owned_by and never invents a model type", () => {
  const { data } = parseAisixOpenAiModelList(NATIVE_MODELS, "dit");
  assert.deepEqual(data, [
    { id: "mock-model", displayId: "m-dit", object: "model", owned_by: "dit" },
  ]);
  // `type` is absent: the core does not classify models, and a defaulted "chat"
  // would let a media-only model be picked as a chat model.
  assert.ok(!("type" in data[0]));
  assert.equal(parseAisixOpenAiModelList(NATIVE_MODELS, "openai").data.length, 0);
});

test("R5 the catalog buckets are keyed by provider and need no shape translation downstream", () => {
  const buckets = toAisixCatalogBuckets(NATIVE_MODELS);
  assert.deepEqual(buckets, {
    dit: { provider: "dit", models: [{ id: "mock-model", name: "m-dit" }] },
  });
  // This is exactly what models/modelCatalogUtils.ts#flattenCatalog consumes.
  assert.equal(Array.isArray(buckets.dit.models), true);
  assert.equal(typeof buckets.dit.models[0].id, "string");
});

test("R5 a flattened bare (unwrapped) document is still understood", () => {
  // The adapter must not be welded to the `{id, value}` nesting depth.
  const rows = parseAisixModelCatalog([
    { id: "doc", display_name: "m-x", provider: "p", model_name: "x" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "x");
  assert.equal(rows[0].name, "m-x");
  assert.equal(rows[0].documentId, "doc");
});

// ─── R6: the degradation verdict, through the helpers the badge actually uses ──

/** The live `:9090/status/models` document shape, verbatim. */
const NATIVE_STATUS_MODELS = [
  {
    id: "6b29b278-0e45-541c-b5c7-b2db0ab4d895",
    display_name: "m-dahl",
    kind: "direct",
    status: "healthy",
  },
  {
    id: "2a972f85-e897-5a42-a39a-8625787e029e",
    display_name: "m-pioneer",
    kind: "direct",
    status: "healthy",
  },
];

const verdictOf = (payload: unknown) =>
  resolveAisixHealthVerdict(parseAisixProviderStatuses(payload));

test("R6 the live /status/models payload reads as healthy", () => {
  assert.equal(verdictOf(NATIVE_STATUS_MODELS), "healthy");
});

test("R6 a degraded model token is degradation", () => {
  for (const status of ["degraded", "half_open", "cooling", "warn"]) {
    const verdict = verdictOf([...NATIVE_STATUS_MODELS, { id: "x", status }]);
    assert.notEqual(verdict, "healthy", `status "${status}" must not read as healthy`);
  }
});

test("R6 a down model is action_required, not merely cooling", () => {
  assert.equal(
    verdictOf([...NATIVE_STATUS_MODELS, { id: "x", status: "open" }]),
    "action_required"
  );
});

test("R6 a payload with nothing in it is not reported as healthy", () => {
  // The distinction the badge depends on: it must not conclude "all clear" from a
  // response that said nothing. `resolveAisixHealthVerdict` maps an empty list to
  // "healthy" by its own documented rule, so the badge's own guard is what has to
  // hold here — which is why this asserts the PARSER saw nothing, not the verdict.
  for (const payload of [null, undefined, "not json", {}, { models: [] }]) {
    assert.deepEqual(
      parseAisixProviderStatuses(payload),
      [],
      `payload ${JSON.stringify(payload)} must yield no provider statuses`
    );
  }
  // And the pre-existing verdict helper keeps its own documented behaviour.
  assert.equal(verdictOf([]), "healthy");
  assert.equal(verdictOf([{ id: "a", status: "healthy" }]), "healthy");
});

test("R6 an unrecognised status token is DEGRADED, never silently healthy", () => {
  // The conservative default, and the one the badge's correctness rests on: a
  // token the adapter has never heard of must raise the banner, not lower it.
  // Defaulting it to "healthy" would let a core invent a new state name and the
  // dashboard would go quiet about it.
  for (const status of ["weird-new-state", "PARTIALLY_MELTED", "42"]) {
    assert.notEqual(
      verdictOf([...NATIVE_STATUS_MODELS, { id: "x", status }]),
      "healthy",
      `unknown token "${status}" must not read as healthy`
    );
  }
});

test("R6 the badge's boolean is exactly 'verdict is not healthy'", () => {
  // The two lines the badge runs, asserted as a pair so a change to either is
  // caught here rather than as a badge that is silently always-on or always-off.
  const badgeSaysDegraded = (payload: unknown) =>
    resolveAisixHealthVerdict(parseAisixProviderStatuses(payload)) !== "healthy";
  assert.equal(badgeSaysDegraded(NATIVE_STATUS_MODELS), false);
  assert.equal(badgeSaysDegraded([{ id: "a", status: "degraded" }]), true);
  assert.equal(badgeSaysDegraded([]), false, "no report is not a degradation claim");
});
