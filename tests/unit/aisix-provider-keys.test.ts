/**
 * Provider-key CRUD client contract — `src/shared/utils/aisixProviderKeys.ts`.
 *
 * Every expectation here is a shape the Rust handler
 * (`aisix-admin/src/keys_handler.rs`) actually produces, captured against a live
 * gateway rather than read off the OpenAPI prose. The distinctions that matter
 * are all in the refusals, because that is where a dashboard that "handles the
 * error" can still lie:
 *
 *   R1 `GET` is `[{id, revision, value}]`, and an entry without an id or
 *      without `api_key` is not a key and is skipped, not rendered blank.
 *   R2 The create/update body carries ONLY the model's fields. The strict schema
 *      rejects an unknown field with a 400, and `enabled` is the one an operator
 *      reaches for and the model has no place for.
 *   R3 A PATCH is a merge, so it sends only what changed and omits an empty
 *      optional rather than sending `""`.
 *   R4 201/200 → `ok` WITH the server's own document, so the list can replace
 *      the row instead of guessing what the server stored.
 *   R5 409 is two different facts — a taken name and a still-referenced key —
 *      and the gateway's own `error_msg` (which NAMES the dependents) reaches
 *      the caller intact.
 *   R6 500 from the store is classified as `not_persisted`, not `failed`: the
 *      handler mutates the snapshot and then discovers the resources file cannot
 *      re-emit it, so a success here would be a lie.
 *   R7 404/405 → `unsupported` (this build has no such surface), while 404 on a
 *      PATCH/DELETE of a real id → `not_found` (the key is gone).
 *   R8 2xx with a body that cannot be read is NOT a success.
 */

import test from "node:test";
import assert from "node:assert/strict";

const keys = await import("../../src/shared/utils/aisixProviderKeys.ts");
const {
  parseProviderKeyEntries,
  normalizeProviderKeyEntry,
  buildProviderKeyDocument,
  buildProviderKeyPatch,
} = keys;

/** The one live row, with the secret redacted. */
const LIVE_ENTRY = {
  id: "0bd7102a-e2ac-5d3a-b3d8-3168d4512c03",
  revision: 1,
  value: {
    display_name: "local-openai",
    api_key: "sk-redacted",
    api_base: "https://api.openai.com/v1",
    provider: "openai",
    telemetry_tags: { featured: false },
    strip_headers: ["authorization", "cookie", "set-cookie", "x-api-key"],
  },
};

/** A JSON `Response`-alike good enough for the client's read/write helpers. */
function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response;
}

function withFetch(response: Response | (() => never)) {
  const impl = async () => {
    if (typeof response === "function") response();
    return response;
  };
  return impl as unknown as typeof globalThis.fetch;
}

test("R1: the list shape is [{id, revision, value}] and every field survives", () => {
  const parsed = parseProviderKeyEntries([LIVE_ENTRY]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, LIVE_ENTRY.id);
  assert.equal(parsed[0].revision, 1);
  assert.equal(parsed[0].value.display_name, "local-openai");
  assert.equal(parsed[0].value.api_base, "https://api.openai.com/v1");
  assert.equal(parsed[0].value.provider, "openai");
  // The rest of the document is passed through untouched: a PATCH merges onto
  // the STORED document server-side, so dropping fields here would lose them.
  assert.deepEqual(parsed[0].value.strip_headers, [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
  ]);
  assert.deepEqual(parsed[0].value.telemetry_tags, { featured: false });
});

test("R1: an entry with no id, or no api_key, is not a key", () => {
  assert.equal(
    normalizeProviderKeyEntry({ revision: 1, value: { display_name: "x", api_key: "k" } }),
    null
  );
  // `api_key` is REQUIRED by the schema, so an entry without it is malformed.
  assert.equal(
    normalizeProviderKeyEntry({ id: "a", revision: 1, value: { display_name: "x" } }),
    null
  );
  assert.equal(normalizeProviderKeyEntry({ id: "a", revision: 1, value: "not-an-object" }), null);
  // `.length` rather than deepEqual([]): a cross-realm array compares structurally
  // but not by reference, and the thing being asserted is "nothing was invented".
  assert.equal(parseProviderKeyEntries([{ foo: 1 }, null, 7, []]).length, 0);
});

test("R1: tolerant envelopes parse; an unknown shape yields an empty list", () => {
  const expected = parseProviderKeyEntries([LIVE_ENTRY]);
  assert.deepEqual(parseProviderKeyEntries({ provider_keys: [LIVE_ENTRY] }), expected);
  assert.deepEqual(parseProviderKeyEntries({ keys: [LIVE_ENTRY] }), expected);
  assert.deepEqual(parseProviderKeyEntries({ data: [LIVE_ENTRY] }), expected);
  assert.deepEqual(parseProviderKeyEntries({}), []);
  assert.deepEqual(parseProviderKeyEntries(null), []);
  assert.deepEqual(parseProviderKeyEntries("nope"), []);
});

test("R2: the create body carries only fields the model has", () => {
  assert.deepEqual(
    buildProviderKeyDocument({
      displayName: "  my-key  ",
      apiKey: " sk-abc ",
      provider: " openai ",
      apiBase: " https://api.openai.com/v1 ",
    }),
    {
      display_name: "my-key",
      api_key: "sk-abc",
      provider: "openai",
      api_base: "https://api.openai.com/v1",
    }
  );
  // `enabled` is the field an operator reaches for; the strict schema rejects it
  // with 400 "Additional properties are not allowed ('enabled' was unexpected)".
  const document = buildProviderKeyDocument({ displayName: "k", apiKey: "s" });
  assert.equal("enabled" in document, false);
  assert.equal(Object.keys(document).sort().join(","), "api_key,display_name");
});

test("R2/R3: blank optionals are omitted, never sent as an empty string", () => {
  const document = buildProviderKeyDocument({
    displayName: "k",
    apiKey: "s",
    provider: "   ",
    apiBase: "",
  });
  // `Option<T>` is modelled by absence; `""` is a value the model would store.
  assert.equal("provider" in document, false);
  assert.equal("api_base" in document, false);
});

test("R3: a PATCH sends only what the operator changed", () => {
  assert.deepEqual(buildProviderKeyPatch({ apiBase: "https://new.test/v1" }), {
    api_base: "https://new.test/v1",
  });
  // An empty patch would still bump the revision server-side for no reason.
  assert.deepEqual(buildProviderKeyPatch({}), {});
  assert.deepEqual(buildProviderKeyPatch({ displayName: "  ", apiKey: "  " }), {});
  assert.deepEqual(buildProviderKeyPatch({ displayName: "renamed", provider: "anthropic" }), {
    display_name: "renamed",
    provider: "anthropic",
  });
});

test("R4/R8: a 2xx with a readable body is ok and carries the server's document", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(
    jsonResponse(201, {
      id: "new-id",
      revision: 1,
      version: 7,
      value: { display_name: "made", api_key: "sk-x", provider: "", strip_headers: [] },
    })
  );
  try {
    const outcome = await keys.createProviderKey({ displayName: "made", apiKey: "sk-x" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 201);
    assert.equal(outcome.failure, null);
    // The UI must render the SERVER's document, not the form's guess — note the
    // empty `provider` the form never sent is preserved rather than dropped.
    assert.equal(outcome.result?.id, "new-id");
    assert.equal(outcome.result?.version, 7);
    assert.equal(outcome.result?.value.display_name, "made");
    assert.equal(outcome.result?.value.provider, "");
  } finally {
    globalThis.fetch = original;
  }
});

test("R4: the DELETE envelope is parsed as a delete, not as a write", async () => {
  // The live handler answers `{id, status, version}` and carries NO document,
  // because there is no row left to describe. Parsing that with the write
  // parser reports a successful delete as an unreadable body — which makes a
  // deleted key look like it is still there. Caught against the real gateway.
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(jsonResponse(200, { id: "gone-id", status: "deleted", version: 9 }));
  try {
    const outcome = await keys.deleteProviderKey("gone-id");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.failure, null);
    // The identity the server echoed is what the caller removes from its list.
    assert.equal(outcome.result?.id, "gone-id");
    assert.equal(outcome.result?.version, 9);
  } finally {
    globalThis.fetch = original;
  }
});

test("R4: a 2xx that is neither a write nor a delete envelope is not a success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(jsonResponse(200, { id: "x", status: "queued" }));
  try {
    // `status` must be exactly "deleted" — anything else is a shape this client
    // does not understand, and guessing "it worked" is how a key survives a
    // delete the gateway did not actually perform.
    assert.equal((await keys.deleteProviderKey("x")).ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("R8: a 2xx whose body cannot be read is NOT reported as a success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(jsonResponse(200, { unexpected: "shape" }));
  try {
    const outcome = await keys.updateProviderKey("some-id", { provider: "x" });
    // Reporting this as ok is how a write that never landed gets shown as landed.
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result, null);
    assert.equal(outcome.failure, "failed");
    assert.equal(outcome.reason, "unreadable_success_body");
  } finally {
    globalThis.fetch = original;
  }
});

test("R5: a duplicate-name 409 surfaces the gateway's own reason", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(
    jsonResponse(409, { error_msg: 'a provider key named "taken" already exists' })
  );
  try {
    const outcome = await keys.createProviderKey({ displayName: "taken", apiKey: "s" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "conflict");
    // The message is what names the conflict; it is passed through untranslated.
    assert.equal(outcome.reason, 'a provider key named "taken" already exists');
  } finally {
    globalThis.fetch = original;
  }
});

test("R5: a still-referenced delete 409 keeps the dependent names", async () => {
  const original = globalThis.fetch;
  const reason =
    'provider key abc-123 is still referenced by 1 (model "e2e-model"); remove the references first';
  globalThis.fetch = withFetch(jsonResponse(409, { error_msg: reason }));
  try {
    const outcome = await keys.deleteProviderKey("abc-123");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "conflict");
    // This is the whole point of the 409: the model name is the actionable part.
    assert.equal(outcome.reason, reason);
    assert.ok(outcome.reason?.includes('model "e2e-model"'));
  } finally {
    globalThis.fetch = original;
  }
});

test("R6: a store 500 is `not_persisted`, never a plain failure", async () => {
  const original = globalThis.fetch;
  const reason =
    "store error: the configured resources file holds 1 resource(s) outside `provider_keys`, " +
    "which a per-key write cannot re-emit; use `POST /admin/v1/resources` to write the whole file";
  globalThis.fetch = withFetch(jsonResponse(500, { error_msg: reason }));
  try {
    const outcome = await keys.createProviderKey({ displayName: "x", apiKey: "s" });
    assert.equal(outcome.ok, false);
    // Distinguishing this from a generic failure is the whole classification: the
    // handler applied the change in memory and then refused to persist it.
    assert.equal(outcome.failure, "not_persisted");
    assert.equal(outcome.reason, reason);
  } finally {
    globalThis.fetch = original;
  }
});

test("R6: a strict-schema 400 keeps the schema's own field path", async () => {
  const original = globalThis.fetch;
  const reason =
    "bad request: Validation failed at `/`: schema validation failed at ``: " +
    "Additional properties are not allowed ('enabled' was unexpected)";
  globalThis.fetch = withFetch(jsonResponse(400, { error_msg: reason }));
  try {
    const outcome = await keys.createProviderKey({ displayName: "x", apiKey: "s" });
    assert.equal(outcome.failure, "invalid");
    assert.equal(outcome.reason, reason);
  } finally {
    globalThis.fetch = original;
  }
});

test("R6: 401/403 is `unauthorized` — the surface exists and wants an admin key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(
    jsonResponse(401, { error_msg: "missing or malformed admin authorization" })
  );
  try {
    const outcome = await keys.deleteProviderKey("any");
    assert.equal(outcome.failure, "unauthorized");
  } finally {
    globalThis.fetch = original;
  }
});

test("R7: a 404 in the admin envelope is a missing ROW, not a missing surface", async () => {
  const original = globalThis.fetch;
  try {
    // The live handler answers exactly this for a key it does not hold.
    globalThis.fetch = withFetch(jsonResponse(404, { error_msg: "resource not found" }));
    const gone = await keys.deleteProviderKey("gone");
    // Getting this backwards tells the operator the whole provider-key surface
    // does not exist when in fact one row does.
    assert.equal(gone.failure, "not_found");
    assert.equal(gone.reason, "resource not found");
  } finally {
    globalThis.fetch = original;
  }
});

test("R7: a 404/405 with no admin envelope is a missing surface", async () => {
  const original = globalThis.fetch;
  try {
    // A route this build does not serve answers outside the admin envelope.
    globalThis.fetch = withFetch(jsonResponse(404, {}));
    assert.equal((await keys.deleteProviderKey("any")).failure, "unsupported");

    globalThis.fetch = withFetch(jsonResponse(405, {}));
    assert.equal(
      (await keys.createProviderKey({ displayName: "x", apiKey: "s" })).failure,
      "unsupported"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a network failure is reported, not thrown", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch((): never => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const outcome = (await keys.fetchProviderKeys)
      ? await keys.createProviderKey({ displayName: "x", apiKey: "s" })
      : null;
    assert.equal(outcome?.ok, false);
    assert.equal(outcome?.status, 0);
    assert.equal(outcome?.reason, "ECONNREFUSED");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchProviderKeys: 401 keeps its status so the UI can name the missing admin key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(
    jsonResponse(401, { error_msg: "missing or malformed admin authorization" })
  );
  try {
    const result = await keys.fetchProviderKeys();
    assert.deepEqual(result.entries, []);
    // `missing` is ONLY the "endpoint absent on this build" answer.
    assert.equal(result.missing, false);
    assert.equal(result.status, 401);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchProviderKeys: 404 is the honest 'no surface on this build' answer", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = withFetch(jsonResponse(404, {}));
  try {
    const result = await keys.fetchProviderKeys();
    assert.equal(result.missing, true);
    assert.equal(result.status, 404);
  } finally {
    globalThis.fetch = original;
  }
});
