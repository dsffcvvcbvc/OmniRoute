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
    [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", authShape: "api_key" }]
  );
});

test("R2: presets/providers/data envelopes all parse; unknown shapes yield []", () => {
  const entry = { id: "anthropic", name: "Anthropic" };
  const expected = [{ id: "anthropic", name: "Anthropic", baseUrl: null, authShape: null }];
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
    [{ id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", authShape: "api_key" }]
  );
});

test("R4: entries without identity are skipped; strings and name-only entries survive", () => {
  assert.deepEqual(parsePresetProviders([{ foo: 1 }, null, 42, {}, []]), []);
  assert.deepEqual(parsePresetProviders(["openai", "  "]), [
    { id: "openai", name: "openai", baseUrl: null, authShape: null },
  ]);
  assert.deepEqual(parsePresetProviders([{ name: "Nameless" }]), [
    { id: "Nameless", name: "Nameless", baseUrl: null, authShape: null },
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
  const expected = [{ id: "openai", name: "OpenAI", baseUrl: null, authShape: null }];
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
