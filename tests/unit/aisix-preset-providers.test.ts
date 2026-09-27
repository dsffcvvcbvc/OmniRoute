/**
 * AISIX SPA-export contract: preset catalog tolerant parsing + refusal paths.
 *
 * Covers `src/shared/utils/aisixPresets.ts` (every envelope form the core is
 * known to ship, plus the 404/405/network refusal paths) and the new URL
 * builders in `src/shared/utils/aisixEndpoints.ts`.
 *
 * Rules:
 *   R1 A bare array parses directly.
 *   R2 `{presets|providers|data}` envelopes parse; other shapes yield `[]`.
 *   R3 snake_case variants (`base_url`, `auth_type`, `provider_id`, …) normalize.
 *   R4 Entries without any usable identity are skipped, never invented.
 *   R5 404/405 → `{ presets: [], missing: true }` (honest refusal, no retry loop).
 *   R6 Other non-2xx → `{ presets: [], missing: false }` (empty + retry).
 *   R7 Network/timeout throw → `{ presets: [], missing: false, status: null }`.
 *   R8 The REAL wire shape: `auth` is an OBJECT `{"type": …, "header": …}` —
 *      that is what `GET :3001/admin/v1/preset_providers` actually sends, so a
 *      parser that only accepts a string reports "unknown" for every vendor.
 *   R9 401 keeps its status, so the UI can name the missing admin key instead of
 *      drawing an empty catalog.
 */

import test from "node:test";
import assert from "node:assert/strict";

const presets = await import("../../src/shared/utils/aisixPresets.ts");
const endpoints = await import("../../src/shared/utils/aisixEndpoints.ts");

const { parsePresetProviders, normalizePresetProvider, fetchPresetProviders } = presets;
const {
  aisixPresetProvidersUrl,
  aisixProviderKeysUrl,
  aisixProviderKeysItemUrl,
  aisixCombosUrl,
  isAisixMissingEndpointStatus,
} = endpoints;

function stubFetch(status: number, payload: unknown, ok?: boolean) {
  return async () => ({
    status,
    ok: ok ?? (status >= 200 && status < 300),
    headers: { get: () => "application/json" },
    json: async () => payload,
  });
}

test("R1: bare array parses directly", () => {
  assert.deepEqual(
    parsePresetProviders([
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", authShape: "api_key" },
    ]),
    [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        authShape: "api_key",
        authHeader: null,
        headers: [],
      },
    ]
  );
});

test("R2: presets/providers/data envelopes all parse; unknown shapes yield []", () => {
  const entry = { id: "anthropic", name: "Anthropic" };
  const expected = [
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: null,
      authShape: null,
      authHeader: null,
      headers: [],
    },
  ];
  assert.deepEqual(parsePresetProviders({ presets: [entry] }), expected);
  assert.deepEqual(parsePresetProviders({ providers: [entry] }), expected);
  assert.deepEqual(parsePresetProviders({ data: [entry] }), expected);
  assert.deepEqual(parsePresetProviders({}), []);
  assert.deepEqual(parsePresetProviders(null), []);
  assert.deepEqual(parsePresetProviders({ presets: "nope" }), []);
  assert.deepEqual(parsePresetProviders("nope"), []);
});

test("R3: snake_case and alias keys normalize", () => {
  assert.deepEqual(
    parsePresetProviders([
      {
        provider_id: "xai",
        title: "xAI",
        base_url: "https://api.x.ai/v1",
        auth_type: "api_key",
      },
    ]),
    [
      {
        id: "xai",
        name: "xAI",
        baseUrl: "https://api.x.ai/v1",
        authShape: "api_key",
        authHeader: null,
        headers: [],
      },
    ]
  );
});

test("R4: entries without identity are skipped; strings and name-only entries survive", () => {
  assert.deepEqual(parsePresetProviders([{ foo: 1 }, null, 42, {}, []]), []);
  assert.deepEqual(parsePresetProviders(["openai", "  "]), [
    { id: "openai", name: "openai", baseUrl: null, authShape: null, authHeader: null, headers: [] },
  ]);
  assert.deepEqual(parsePresetProviders([{ name: "Nameless" }]), [
    {
      id: "Nameless",
      name: "Nameless",
      baseUrl: null,
      authShape: null,
      authHeader: null,
      headers: [],
    },
  ]);
  assert.equal(normalizePresetProvider({}), null);
});

test("R5: 404/405 refuse honestly with missing=true", async () => {
  for (const status of [404, 405]) {
    const result = await fetchPresetProviders(stubFetch(status, {}) as never);
    assert.deepEqual(result, { presets: [], missing: true, status });
  }
});

test("fetch 200 parses every envelope form", async () => {
  const entry = { id: "openai", name: "OpenAI" };
  const expected = [
    { id: "openai", name: "OpenAI", baseUrl: null, authShape: null, authHeader: null, headers: [] },
  ];
  for (const payload of [
    [entry],
    { presets: [entry] },
    { providers: [entry] },
    { data: [entry] },
  ]) {
    const result = await fetchPresetProviders(stubFetch(200, payload) as never);
    assert.deepEqual(result, { presets: expected, missing: false, status: 200 });
  }
});

test("R6/R7: 500 and network failure stay retryable (missing=false)", async () => {
  assert.deepEqual(await fetchPresetProviders(stubFetch(500, {}) as never), {
    presets: [],
    missing: false,
    status: 500,
  });
  assert.deepEqual(
    await fetchPresetProviders((async () => {
      throw new Error("down");
    }) as never),
    { presets: [], missing: false, status: null }
  );
});

test("endpoint builders target the native admin plane", () => {
  assert.ok(aisixPresetProvidersUrl().endsWith("/admin/v1/preset_providers"));
  assert.ok(aisixProviderKeysUrl().endsWith("/admin/v1/provider_keys"));
  assert.ok(aisixCombosUrl().endsWith("/admin/v1/combos"));
  assert.ok(aisixCombosUrl("/abc").endsWith("/admin/v1/combos/abc"));
  assert.ok(aisixProviderKeysItemUrl("a/b").endsWith("/admin/v1/provider_keys/a%2Fb"));
});

test("missing-endpoint status is exactly 404/405", () => {
  assert.equal(isAisixMissingEndpointStatus(404), true);
  assert.equal(isAisixMissingEndpointStatus(405), true);
  assert.equal(isAisixMissingEndpointStatus(200), false);
  assert.equal(isAisixMissingEndpointStatus(500), false);
  assert.equal(isAisixMissingEndpointStatus(0), false);
});

/**
 * R8 — the shape the live core actually sends.
 *
 * Captured from `GET :3001/admin/v1/preset_providers` (190 entries). Every
 * entry carries `auth` as an OBJECT. The pre-fix parser only accepted a string
 * there, so it produced `authShape: null` for all 190 and the UI rendered
 * "auth shape unknown" for every vendor — the exact field an operator needs to
 * know which credential box to paste into.
 */
const LIVE_CATALOG_SAMPLE = [
  {
    id: "agnes",
    display_name: "Agnes",
    base_url: "https://apihub.agnes-ai.com/v1/chat/completions",
    auth: { type: "bearer" },
    headers: [],
  },
  {
    id: "haiper",
    display_name: "Haiper",
    base_url: "https://api.haiper.ai/v1",
    auth: { type: "api_key_header", header: "HAIPER_KEY" },
    headers: [],
  },
  {
    id: "api-airforce",
    display_name: "Airforce",
    base_url: "https://api.airforce/v1/chat/completions",
    auth: { type: "bearer" },
    headers: [
      { name: "HTTP-Referer", value: "https://endpoint-proxy.local" },
      { name: "X-Title", value: "Endpoint Proxy" },
    ],
  },
];

test("R8: the live `auth` OBJECT shape is read, not dropped", () => {
  const parsed = parsePresetProviders(LIVE_CATALOG_SAMPLE);

  assert.equal(parsed.length, 3);

  // A plain bearer entry: the type is read, and no header is invented for it.
  assert.equal(parsed[0].id, "agnes");
  assert.equal(parsed[0].name, "Agnes");
  assert.equal(parsed[0].baseUrl, "https://apihub.agnes-ai.com/v1/chat/completions");
  assert.equal(parsed[0].authShape, "bearer");
  assert.equal(parsed[0].authHeader, null);

  // `api_key_header` must surface the header NAME verbatim — that is the whole
  // point of the field, and it is not derivable from the type alone.
  assert.equal(parsed[1].authShape, "api_key_header");
  assert.equal(parsed[1].authHeader, "HAIPER_KEY");

  // Public headers are carried, not flattened away.
  assert.deepEqual(parsed[2].headers, [
    { name: "HTTP-Referer", value: "https://endpoint-proxy.local" },
    { name: "X-Title", value: "Endpoint Proxy" },
  ]);
});

test("R8: no entry in the live-shaped catalog falls back to an unknown auth shape", () => {
  const parsed = parsePresetProviders(LIVE_CATALOG_SAMPLE);
  // The regression this pins: a string-only `auth` reader returns null here for
  // every single entry, so the assertion below is the thing that goes red.
  assert.deepEqual(
    parsed.filter((entry) => entry.authShape === null).map((entry) => entry.id),
    []
  );
});

test("R8: an `auth` object without a usable type is honestly unknown, never guessed", () => {
  assert.deepEqual(normalizePresetProvider({ id: "x", auth: {} })?.authShape, null);
  assert.deepEqual(
    normalizePresetProvider({ id: "x", auth: { header: "X-Key" } })?.authHeader,
    null
  );
  // A header on a NON-api_key_header shape is not the credential field, so it is
  // not reported as one.
  assert.deepEqual(
    normalizePresetProvider({ id: "x", auth: { type: "bearer", header: "X" } })?.authHeader,
    null
  );
});

test("R8: a string `auth` from a core build that sends the flat form still reads", () => {
  assert.equal(normalizePresetProvider({ id: "x", auth: "oauth" })?.authShape, "oauth");
});

test("R8: malformed header entries are dropped, not rendered half-parsed", () => {
  const parsed = parsePresetProviders([
    { id: "x", headers: [{ name: "A", value: "1" }, { name: "B" }, "nope", { value: "2" }] },
  ]);
  assert.deepEqual(parsed[0].headers, [{ name: "A", value: "1" }]);
  assert.deepEqual(parsePresetProviders([{ id: "x", headers: "nope" }])[0].headers, []);
});

/** R9 — a 401 must be distinguishable from an empty catalog. */
test("R9: 401/403 keep their status so the UI can name the missing admin key", async () => {
  for (const status of [401, 403]) {
    assert.deepEqual(await fetchPresetProviders(stubFetch(status, {}) as never), {
      presets: [],
      missing: false,
      status,
    });
  }
  // And it is NOT the "endpoint absent" answer, which is a different fact.
  const unauthorized = await fetchPresetProviders(stubFetch(401, {}) as never);
  assert.equal(unauthorized.missing, false);
});
