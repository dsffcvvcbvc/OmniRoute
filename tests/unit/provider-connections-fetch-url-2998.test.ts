import assert from "node:assert/strict";
import test from "node:test";

import { getProviderConnectionsRequestUrl } from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";

test("provider detail requests only the exact provider when no aliases are configured", () => {
  assert.equal(
    getProviderConnectionsRequestUrl("openai"),
    "http://127.0.0.1:3001/admin/v1/provider_keys?provider=openai"
  );
});

test("provider detail keeps alias-backed pages on the unfiltered request", () => {
  assert.equal(
    getProviderConnectionsRequestUrl("alibaba"),
    "http://127.0.0.1:3001/admin/v1/provider_keys"
  );
  assert.equal(
    getProviderConnectionsRequestUrl("kimi-coding"),
    "http://127.0.0.1:3001/admin/v1/provider_keys"
  );
});

test("unified xAI detail fetches all auth variants through the unfiltered request", () => {
  assert.equal(
    getProviderConnectionsRequestUrl("xai"),
    "http://127.0.0.1:3001/admin/v1/provider_keys"
  );
});
