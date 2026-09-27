/**
 * AISIX combo contract: the field set, the strategy set, and the two rules the
 * strict schema cannot state.
 *
 * The source of truth is `aisix-admin/src/combos_handler.rs` (read-only) — this
 * suite pins what the client sends and refuses so it can never drift back into
 * sending a field the gateway rejects by name.
 *
 * Rules pinned here (each one CAN fail — see the mutation note on each):
 *   R1  The accepted document field set is exactly `name`, `strategy`, `models`.
 *       Mutate: add a fourth key to the builder → RED.
 *   R2  The accepted target field set is exactly `model`, `weight`, `priority`,
 *       `tags`. Mutate: forward `label` → RED.
 *   R3  Every refused etalon field is DROPPED, never forwarded for the handler
 *       to refuse. Mutate: forward `config` → RED.
 *   R4  The strategy vocabulary is TRANSLATED, not forwarded: the template's
 *       `round-robin` is not a routing strategy. Mutate: pass it through → RED.
 *   R5  A template strategy with no honest mapping is OMITTED, never folded
 *       into a near-equivalent (that would be accepted-but-unread config).
 *       Mutate: substitute `failover` → RED.
 *   R6  `model_id` is refused even though the view never emits it — the whole
 *       point is that the client must not be the thing that adds it back.
 *   R7  `validateComboDraft` mirrors the handler's rules in the handler's order.
 *   R8  The duplicate check is on the TRIMMED name: `"gpt-4o"` and
 *       `" gpt-4o "` are one target, exactly as the handler treats them.
 *   R9  A target must be a DIRECT model, and the direct catalog is read from the
 *       models collection with the same predicate the handler uses.
 *   R10 `null` catalog (not loaded) SKIPS the catalog-dependent check rather
 *       than refusing every draft; the server stays the authority either way.
 *   R11 Every rule code the validator can emit has a message key — a new code
 *       with no sentence would render the bare code to an operator.
 *   R12 A 2xx body we cannot read is a FAILURE, not a success: reporting it as
 *       one is how a write that never landed gets shown as landed.
 *   R13 401/403 is reported as its own status so the page can name the missing
 *       admin key instead of drawing an empty table.
 *   R14 404/405 ambiguity: the admin envelope tells a missing ROW from a
 *       missing ROUTE.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AISIX_COMBO_DEFAULT_STRATEGY,
  AISIX_COMBO_FIELDS,
  AISIX_COMBO_REFUSED_DOCUMENT_FIELDS,
  AISIX_COMBO_REFUSED_TARGET_FIELDS,
  AISIX_COMBO_STRATEGY_VALUES,
  AISIX_COMBO_TARGET_FIELDS,
  AISIX_ETALON_STRATEGY_HONOURS,
  COMBO_DRAFT_ISSUE_MESSAGE_KEYS,
  buildComboDocument,
  buildComboPatch,
  comboDraftIssueValues,
  createCombo,
  deleteCombo,
  fetchCombos,
  fetchDirectModelNames,
  isAisixComboStrategy,
  isAisixHonouredStrategy,
  parseCombos,
  parseDirectModelNames,
  toAisixComboStrategy,
  toEtalonStrategy,
  updateCombo,
  validateComboDraft,
} from "../../src/shared/utils/aisixCombos.ts";

// ── the contract itself ──────────────────────────────────────────────────

test("R1 the accepted document field set is exactly name, strategy, models", () => {
  assert.deepEqual([...AISIX_COMBO_FIELDS], ["name", "strategy", "models"]);

  const document = buildComboDocument({
    name: "  fast-coding  ",
    strategy: "round-robin",
    models: [{ model: "gpt-4o" }],
  });
  // The keys the document carries must be a SUBSET of the accepted set, and
  // `models` is required. Asserting the sorted key list is what makes this fail
  // if a fourth key is ever added.
  assert.deepEqual(Object.keys(document).sort(), ["models", "name", "strategy"]);
  // The name is trimmed — the handler trims before storing.
  assert.equal(document.name, "fast-coding");
});

test("R2 the accepted target field set is exactly model, weight, priority, tags", () => {
  assert.deepEqual([...AISIX_COMBO_TARGET_FIELDS], ["model", "weight", "priority", "tags"]);
});

test("R3 every refused etalon field is dropped, never forwarded", () => {
  // One target carrying the full template step field set, plus a combo-level
  // `config` — the exact shape `ComboFormModal` hands to `handleSave`.
  const document = buildComboDocument({
    name: "k",
    strategy: "failover",
    models: [
      {
        kind: "model",
        provider: "openai",
        providerId: "p1",
        model: "gpt-4o",
        connectionId: "c1",
        allowedConnectionIds: ["c1", "c2"],
        label: "fast",
        prompt: "you are a coder",
        fallbackOnlyOnQuotaExhaustion: true,
        model_id: "9f1c0000-0000-0000-0000-000000000000",
        id: "step-1",
        weight: 3,
        priority: 2,
        tags: ["fast", "  ", "cheap"],
      },
    ],
  } as never);

  const target = (document.models as Record<string, unknown>[])[0];
  assert.deepEqual(
    Object.keys(target).sort(),
    ["model", "priority", "tags", "weight"],
    "only the four contract fields may reach the wire"
  );
  assert.equal(target.model, "gpt-4o");
  assert.equal(target.weight, 3);
  assert.equal(target.priority, 2);
  // A blank tag is dropped rather than sent: the handler validates `tags`.
  assert.deepEqual(target.tags, ["fast", "cheap"]);
  // The refusal lists name every field the form is allowed to draw.
  for (const field of ["label", "connectionId", "model_id", "kind", "prompt"]) {
    assert.ok(
      AISIX_COMBO_REFUSED_TARGET_FIELDS.includes(field as never),
      `${field} must be on the refused-target list`
    );
  }
  for (const field of ["config", "description", "isActive", "isHidden"]) {
    assert.ok(
      AISIX_COMBO_REFUSED_DOCUMENT_FIELDS.includes(field as never),
      `${field} must be on the refused-document list`
    );
  }
});

test("R6 model_id is refused even though a read never emits it", () => {
  // This is the trap the handler calls out by name: a target addressed by id
  // would validate here and leave behind a resources file no reload accepts.
  const document = buildComboDocument({
    name: "k",
    models: [{ model: "gpt-4o", model_id: "9f1c0000-0000-0000-0000-000000000000" }],
  } as never);
  assert.ok(!("model_id" in (document.models as Record<string, unknown>[])[0]));
  assert.ok(AISIX_COMBO_REFUSED_TARGET_FIELDS.includes("model_id" as never));
});

// ── the strategy vocabulary ──────────────────────────────────────────────

test("the implemented strategy set is the handler's six, in its order", () => {
  assert.deepEqual(
    [...AISIX_COMBO_STRATEGY_VALUES],
    ["round_robin", "consistent_hash", "failover", "least_cost", "least_latency", "least_busy"]
  );
  // The handler defaults to `failover` when the field is absent, and the
  // duplicate path falls back to the same value.
  assert.equal(AISIX_COMBO_DEFAULT_STRATEGY, "failover");
  assert.equal(isAisixComboStrategy("failover"), true);
  // A template spelling is NOT a routing strategy even where it looks close.
  assert.equal(isAisixComboStrategy("round-robin"), false);
  assert.equal(isAisixComboStrategy("priority"), false);
});

test("R4 the strategy vocabulary is translated, not forwarded", () => {
  assert.equal(toAisixComboStrategy("round-robin"), "round_robin");
  assert.equal(toAisixComboStrategy("priority"), "failover");
  assert.equal(toAisixComboStrategy("cost-optimized"), "least_cost");
  // A value already in the gateway's vocabulary passes through, so a combo
  // read back from the API can be re-submitted without a double translation.
  assert.equal(toAisixComboStrategy("round_robin"), "round_robin");

  const document = buildComboDocument({
    name: "k",
    strategy: "round-robin",
    models: [{ model: "gpt-4o" }],
  });
  assert.equal(document.strategy, "round_robin");
  // Mutate `buildComboDocument` to pass `input.strategy` straight through and
  // this becomes "round-robin" → RED.
});

test("R5 an unmapped template strategy is omitted, not folded into a near-match", () => {
  // `fusion` and `pipeline` are multi-model shapes a routing model cannot be;
  // `auto` and `lkgp` are scorers with no enum counterpart. Substituting
  // `failover` would be accepted-but-unread config, so nothing is sent.
  for (const unmapped of ["fusion", "pipeline", "auto", "lkgp", "reset-aware", "nonsense"]) {
    assert.equal(toAisixComboStrategy(unmapped), null, `${unmapped} must have no mapping`);
    const document = buildComboDocument({
      name: "k",
      strategy: unmapped,
      models: [{ model: "m" }],
    });
    assert.ok(!("strategy" in document), `${unmapped} must not put a strategy on the wire at all`);
  }
  // The picker predicate agrees with the translator — one vocabulary, one answer.
  assert.equal(isAisixHonouredStrategy("round-robin"), true);
  assert.equal(isAisixHonouredStrategy("fusion"), false);
  for (const [etalon, gateway] of Object.entries(AISIX_ETALON_STRATEGY_HONOURS)) {
    assert.equal(
      toEtalonStrategy(gateway) === etalon ||
        isAisixHonouredStrategy(toEtalonStrategy(gateway) ?? ""),
      true,
      `every honoured strategy must render back into the picker (${etalon} → ${gateway})`
    );
  }
});

test("R7 validateComboDraft mirrors the handler's rules in the handler's order", () => {
  // The handler's order is: name → strategy → models → per-target model →
  // duplicates → direct-only. A draft breaking all of them must report them in
  // that order, because that is the order the server would refuse them in.
  const issues = validateComboDraft({
    name: "   ",
    strategy: "fusion",
    models: [{ model: "a" }, { model: " a " }],
  });
  assert.deepEqual(
    issues.map((i) => i.code),
    ["name_required", "strategy_unsupported", "model_duplicate"],
    "name first, then strategy, then the per-target rules"
  );
});

test("a clean draft produces no issues", () => {
  const issues = validateComboDraft(
    { name: "fast", strategy: "round_robin", models: [{ model: "gpt-4o", weight: 1 }] },
    { directModelNames: ["gpt-4o", "claude"] }
  );
  assert.deepEqual(issues, []);
  // An assertion on an EMPTY array cannot fail on its own, so pin the negative
  // case too: the same draft against a catalog that does not hold gpt-4o.
  const refused = validateComboDraft(
    { name: "fast", strategy: "round_robin", models: [{ model: "gpt-4o" }] },
    { directModelNames: ["claude"] }
  );
  assert.deepEqual(
    refused.map((i) => i.code),
    ["model_not_direct"]
  );
});

test("R8 the duplicate check is on the trimmed name, as the handler reads it", () => {
  // `"gpt-4o"` and `" gpt-4o "` are ONE target to the handler, so the form must
  // not let the operator add what the server will refuse.
  const issues = validateComboDraft({
    name: "k",
    models: [{ model: "gpt-4o" }, { model: "  gpt-4o  " }],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "model_duplicate");
  assert.equal(
    issues[0].field,
    "models[1]",
    "reported on the LATER index, which is the one the handler names"
  );
  assert.equal(
    issues[0].model,
    "gpt-4o",
    "the trimmed name, so the message quotes what the server will"
  );
  // The bare-string shorthand is the same target, not a second one.
  const shorthand = validateComboDraft({ name: "k", models: [{ model: "gpt-4o" }, "gpt-4o"] });
  assert.deepEqual(
    shorthand.map((i) => i.code),
    ["model_duplicate"]
  );
  // Two DIFFERENT models are fine — the check must not fire on every pair.
  const distinct = validateComboDraft({ name: "k", models: [{ model: "a" }, { model: "b" }] });
  assert.deepEqual(distinct, []);
});

test("an empty name, an empty models list and a nameless target are each refused", () => {
  assert.deepEqual(
    validateComboDraft({ name: "", models: [] }).map((i) => i.code),
    ["name_required", "models_required"]
  );
  assert.deepEqual(
    validateComboDraft({ name: "k", models: [{ model: "  " }] }).map((i) => i.code),
    ["model_required"]
  );
  // `models` absent entirely is the same refusal as an empty one.
  assert.deepEqual(
    validateComboDraft({ name: "k" }).map((i) => i.code),
    ["models_required"]
  );
});

// ── the direct-model catalog ─────────────────────────────────────────────

test("R9 the direct catalog uses the handler's own predicate", () => {
  // The handler's `is_direct` is `routing.is_none() && ensemble.is_none() &&
  // semantic.is_none()`. A model carrying ANY of those three is virtual, and a
  // target naming one would nest routing groups with no cycle guard.
  const rows = [
    { id: "1", value: { display_name: "gpt-4o", provider: "openai", model_name: "gpt-4o" } },
    { id: "2", value: { display_name: "combo-a", routing: { strategy: "failover", targets: [] } } },
    { id: "3", value: { display_name: "ens", ensemble: { panel: [] } } },
    { id: "4", value: { display_name: "sem", semantic: { routes: [] } } },
    { id: "5", value: { display_name: "claude" } },
  ];
  assert.deepEqual(parseDirectModelNames(rows), ["gpt-4o", "claude"]);
  // A bare document (no `value` envelope) parses too, so the reader survives an
  // envelope change instead of reporting "no direct models".
  assert.deepEqual(parseDirectModelNames([{ display_name: "solo" }]), ["solo"]);
  // An unreadable payload is `null` — "not loaded", NOT "none exist".
  assert.equal(parseDirectModelNames("nonsense"), null);
  assert.equal(parseDirectModelNames({ nope: 1 }), null);
});

test("R10 a null catalog skips the catalog-dependent check rather than refusing everything", () => {
  const draft = { name: "k", models: [{ model: "gpt-4o" }] };
  assert.deepEqual(validateComboDraft(draft, { directModelNames: null }), []);
  assert.deepEqual(validateComboDraft(draft, { directModelNames: undefined }), []);
  // The name/duplicate rules do not depend on the catalog and still fire.
  assert.deepEqual(
    validateComboDraft(
      { name: "", models: [{ model: "a" }, { model: "a" }] },
      {
        directModelNames: null,
      }
    ).map((i) => i.code),
    ["name_required", "model_duplicate"]
  );
  // An EMPTY catalog is a real answer, and it refuses everything: the opposite
  // of `null`. Deleting the `if (catalog)` guard would collapse the two.
  assert.deepEqual(
    validateComboDraft(draft, { directModelNames: [] }).map((i) => i.code),
    ["model_not_direct"]
  );
});

test("R11 every rule code has a message key and an interpolable value set", () => {
  // The codes the validator can actually emit, spelled out. Adding a code
  // without a key here must fail, or the panel renders the bare code.
  const emitted = [
    "name_required",
    "strategy_unsupported",
    "models_required",
    "model_required",
    "model_not_direct",
    "model_duplicate",
  ] as const;
  for (const code of emitted) {
    assert.equal(
      typeof COMBO_DRAFT_ISSUE_MESSAGE_KEYS[code],
      "string",
      `${code} has no message key`
    );
    assert.ok(COMBO_DRAFT_ISSUE_MESSAGE_KEYS[code].length > 0, `${code} has an empty key`);
  }
  // A code with no entry falls through to the raw code — so the map must be
  // total over the union, not merely a superset.
  assert.deepEqual(Object.keys(COMBO_DRAFT_ISSUE_MESSAGE_KEYS).sort(), [...emitted].sort());
  // Only a target issue interpolates a model name.
  assert.deepEqual(
    comboDraftIssueValues({ code: "model_duplicate", field: "models[1]", model: "a" }),
    {
      model: "a",
    }
  );
  assert.deepEqual(comboDraftIssueValues({ code: "name_required", field: "name" }), {});
});

// ── reading the wire ─────────────────────────────────────────────────────

test("the combo view parses, and an unreadable one is skipped rather than invented", () => {
  const payload = [
    {
      id: "c1",
      name: "fast",
      strategy: "round_robin",
      models: [{ model: "gpt-4o", weight: 3, priority: 2, tags: ["fast"] }],
    },
    // A bare-string target is the shorthand the write path accepts.
    { id: "c2", name: "simple", models: ["claude"] },
    // A stored combo always HAS a routing block, so a view without `strategy`
    // is tolerated rather than dropped.
    { id: "c3", name: "no-strategy", models: [] },
    // No id → not addressable by PATCH/DELETE → skipped, not invented.
    { name: "ghost", models: [] },
    { id: "c4", models: [] },
  ];
  const parsed = parseCombos(payload);
  assert.deepEqual(
    parsed.map((c) => c.id),
    ["c1", "c2", "c3"],
    "entries with no id or no name are skipped"
  );
  assert.equal(parsed[0].strategy, "round_robin");
  assert.deepEqual(parsed[0].models[0], {
    model: "gpt-4o",
    weight: 3,
    priority: 2,
    tags: ["fast"],
  });
  assert.deepEqual(parsed[1].models, [{ model: "claude" }]);
  assert.equal(parsed[2].strategy, undefined);
  // A junk payload is an empty list, never a fabricated row.
  assert.deepEqual(parseCombos("nonsense"), []);
  assert.deepEqual(parseCombos({ combos: payload }).length, 3);
});

// ── transport refusals ───────────────────────────────────────────────────

/** Swap `globalThis.fetch` for a stub answering one canned response. */
async function withFetch(
  response: { status: number; body: unknown; contentType?: string },
  run: () => Promise<void>
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: {
        get: (name: string) =>
          name === "content-type" ? (response.contentType ?? "application/json") : null,
      },
      json: async () => response.body,
    }) as unknown as Response) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("R12 a 2xx body we cannot read is a failure, not a success", async () => {
  // 201 with no `combo` in the envelope: the row is not described, so
  // reporting success is how a write that never landed gets shown as landed.
  await withFetch({ status: 201, body: { id: "c1", revision: 1, version: 1 } }, async () => {
    const outcome = await createCombo({ name: "k", models: [{ model: "m" }] });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "failed");
    assert.equal(outcome.reason, "unreadable_success_body");
  });
  // A success whose embedded view disagrees with the envelope id is also unread.
  await withFetch(
    {
      status: 201,
      body: { id: "c1", revision: 1, version: 1, combo: { id: "OTHER", name: "k", models: [] } },
    },
    async () => {
      const outcome = await createCombo({ name: "k", models: [{ model: "m" }] });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, "unreadable_success_body");
    }
  );
  // And the happy path still parses, so R12 is not a blanket "always fail".
  await withFetch(
    {
      status: 201,
      body: {
        id: "c1",
        revision: 1,
        version: 4,
        combo: { id: "c1", name: "k", strategy: "failover", models: [{ model: "m" }] },
      },
    },
    async () => {
      const outcome = await createCombo({ name: "k", models: [{ model: "m" }] });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.status, 201);
      assert.equal(outcome.result?.version, 4);
      assert.equal(outcome.result?.combo.strategy, "failover");
    }
  );
});

test("a 400 is `invalid` and carries the gateway's own message verbatim", async () => {
  const reason = 'bad request: "config" is not part of the combo contract.';
  await withFetch({ status: 400, body: { error_msg: reason } }, async () => {
    const outcome = await createCombo({ name: "k", models: [{ model: "m" }] });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "invalid");
    assert.equal(
      outcome.reason,
      reason,
      "the handler names the field; the UI must not paraphrase it away"
    );
  });
});

test("R13 401/403 keeps its status so the page can name the missing admin key", async () => {
  await withFetch({ status: 401, body: null, contentType: "text/plain" }, async () => {
    const read = await fetchCombos();
    assert.equal(read.status, 401);
    assert.equal(read.missing, false, "a gated surface is NOT an absent one");
    assert.deepEqual(read.combos, []);
    // And the write path reports `unauthorized`, not a generic failure.
    const outcome = await updateCombo("c1", { name: "k2" });
    assert.equal(outcome.failure, "unauthorized");
  });
});

test("R14 404/405: the admin envelope tells a missing ROW from a missing ROUTE", async () => {
  // 404 WITH the envelope is a row the gateway does not have.
  await withFetch({ status: 404, body: { error_msg: "resource not found" } }, async () => {
    const outcome = await deleteCombo("00000000-0000-0000-0000-000000000000");
    assert.equal(outcome.failure, "not_found");
    assert.equal(outcome.reason, "resource not found");
  });
  // 404 WITHOUT one is a route this build does not serve — a different answer,
  // and getting it backwards tells the operator the whole surface is gone.
  await withFetch({ status: 404, body: null, contentType: "text/plain" }, async () => {
    const outcome = await deleteCombo("c1");
    assert.equal(outcome.failure, "unsupported");
    assert.equal(outcome.reason, null);
  });
  // A 409 names the dependents, which is the actionable half of the message.
  await withFetch(
    { status: 409, body: { error_msg: 'combo "x" is still referenced by 1 (combo "y")' } },
    async () => {
      const outcome = await deleteCombo("c1");
      assert.equal(outcome.failure, "conflict");
      assert.match(String(outcome.reason), /still referenced by 1/);
      assert.match(String(outcome.reason), /combo "y"/);
    }
  );
  // A 500 from the store is "applied in memory, refused on disk" — reporting it
  // as success would leave the operator believing a combo is stored.
  await withFetch(
    {
      status: 500,
      body: { error_msg: "refusing to persist a resources file the file source would reject" },
    },
    async () => {
      const outcome = await createCombo({ name: "k", models: [{ model: "m" }] });
      assert.equal(outcome.failure, "not_persisted");
    }
  );
});

test("a PATCH sends only the fields the operator changed", async () => {
  // A patch is a MERGE onto the stored document, so a full document would
  // rewrite fields the operator never touched.
  assert.deepEqual(buildComboPatch({ name: "  renamed  " }), { name: "renamed" });
  assert.deepEqual(buildComboPatch({ strategy: "least_cost" }), { strategy: "least_cost" });
  assert.deepEqual(buildComboPatch({}), {}, "an empty patch changes nothing");
  // An empty `models` is omitted rather than sent as `[]`, which the handler
  // refuses ("a combo requires at least one entry in `models`").
  assert.deepEqual(buildComboPatch({ models: [] }), {});
  assert.deepEqual(buildComboPatch({ models: [{ model: "m" }] }), { models: [{ model: "m" }] });
});

test("the update verb is PATCH, and the delete envelope is not the write envelope", async () => {
  let seenMethod = "";
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenMethod = String(init?.method);
    return {
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ id: "c1", status: "deleted", version: 9 }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    const deleted = await deleteCombo("c1");
    assert.equal(seenMethod, "DELETE");
    // No `combo` in the body: there is no row left to describe. Parsing this
    // with the write parser would report a successful delete as unreadable.
    assert.equal(deleted.ok, true);
    assert.equal(deleted.result?.id, "c1");
    assert.equal(deleted.result?.version, 9);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seenMethod, "DELETE");
  // The handler routes `PATCH /:id` and no `PUT`; a PUT is 405 on every save.
  // Pin the verb the client uses so a regression to PUT is RED.
  const real2 = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenMethod = String(init?.method);
    return {
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        id: "c1",
        revision: 2,
        version: 2,
        combo: { id: "c1", name: "k", models: [{ model: "m" }] },
      }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    const updated = await updateCombo("c1", { name: "k2" });
    assert.equal(seenMethod, "PATCH");
    assert.equal(updated.ok, true);
  } finally {
    globalThis.fetch = real2;
  }
});

test("the direct-model read degrades to null when the catalog is unreadable", async () => {
  // `null` means "not loaded" and lets the form fall back to checking on save.
  // Returning `[]` instead would refuse every draft against a catalog it never
  // received — and the failure would look like "this gateway has no models".
  await withFetch({ status: 404, body: null, contentType: "text/plain" }, async () => {
    assert.equal(await fetchDirectModelNames(), null);
  });
  await withFetch({ status: 500, body: { error_msg: "boom" } }, async () => {
    assert.equal(await fetchDirectModelNames(), null);
  });
  await withFetch(
    {
      status: 200,
      body: [
        { id: "1", value: { display_name: "gpt-4o" } },
        { id: "2", value: { display_name: "c", routing: {} } },
      ],
    },
    async () => {
      assert.deepEqual(await fetchDirectModelNames(), ["gpt-4o"]);
    }
  );
});
