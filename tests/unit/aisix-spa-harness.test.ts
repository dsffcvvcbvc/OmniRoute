/**
 * The suite's own instrumentation must not be the thing that lies.
 *
 * Two helpers in `tests/aisix-spa-e2e/harness.ts` decide what the rest of the
 * suite is allowed to conclude, and both are pure functions, so both are
 * asserted here without a browser:
 *
 *   1. `scrub()` — applied to every string the suite persists. It has two
 *      states, and one of them was destroying the evidence: with no admin key
 *      configured (a documented, supported mode — `AISIX_SPA_ADMIN_KEY` is
 *      optional) `"GET /providers/openai.svg".split("")` is one character per
 *      element, so the marker landed between every character of every file. A
 *      25-byte URL came back as 289 bytes of noise, with no error anywhere, in
 *      the run where the operator had least to go on.
 *
 *   2. `summarizeNativeModelStatus()` — the oracle the e2e specs compare the
 *      dashboard's own health reading against. It was a deny-list
 *      (`status !== "healthy" && status !== "ok"` ⇒ degraded), and the core
 *      reports `not_applicable` for a VIRTUAL router — every combo — so it
 *      counted every healthy virtual router as a fault. That is the worst shape
 *      a test can take: the oracle agrees with the bug it exists to catch, so a
 *      regression in either direction is invisible.
 *
 * `scrub` takes the key as a parameter and the classifier is a pure function
 * over a payload precisely so both states, and both directions, are reachable
 * from one process without a gateway.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_STATUS_STATES,
  isOverRequestBudget,
  scrub,
  summarizeNativeModelStatus,
} from "../aisix-spa-e2e/harness";

const KEY = "sk-aisix-admin-0123456789";

describe("scrub — with an admin key configured", () => {
  test("replaces the key wherever it appears, and leaves the rest readable", () => {
    const scrubbed = scrub(`GET /admin/v1/models Authorization: Bearer ${KEY}`, KEY);

    assert.ok(
      !scrubbed.includes(KEY),
      `the key survived scrubbing, which would put a live credential in a file on disk: ${scrubbed}`
    );
    assert.ok(
      scrubbed.startsWith("GET /admin/v1/models"),
      `the surrounding text was mangled; scrubbing must replace the key, not the record: ${scrubbed}`
    );
  });

  test("replaces EVERY occurrence, not just the first", () => {
    const scrubbed = scrub(`${KEY} and again ${KEY}`, KEY);

    assert.ok(!scrubbed.includes(KEY), `a second copy of the key survived: ${scrubbed}`);
    assert.equal(scrubbed, "<admin-key> and again <admin-key>");
  });
});

describe("scrub — with no key configured", () => {
  // The falsifier for the shredding bug: this is red on the old implementation
  // and green only because an empty key is now skipped.
  test("leaves ordinary evidence byte-identical instead of shredding it", () => {
    const evidence =
      "GET /providers/openai.svg → 200 33 times, /api/providers/openai/cc-alias → 404";
    const scrubbed = scrub(evidence, "");

    assert.equal(
      scrubbed,
      evidence,
      "with no admin key configured, scrub() must return the evidence unchanged — an empty key " +
        'split on "" separates every character, so the record comes back as marker noise'
    );
  });

  test("still redacts the credentials that do not need the admin key", () => {
    assert.equal(
      scrub(
        "GET /admin/v1/models Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        ""
      ),
      "GET /admin/v1/models Authorization: Bearer <redacted>"
    );
    assert.equal(scrub("GET /x?api_key=abcd1234&page=2", ""), "GET /x?api_key=<redacted>&page=2");
  });

  test("an empty string is still an empty string", () => {
    assert.equal(scrub("", ""), "");
    assert.equal(scrub("", KEY), "");
  });
});

describe("the request-budget verdict", () => {
  // The function `08-request-budget` asserts with and the C8 negative control
  // injects a storm against. It is a boundary, so both sides are pinned: a
  // verdict that rejected everything would satisfy "nothing is over budget"
  // forever, and one that accepted everything would never fire.
  test("the ceiling is inclusive and the first repeat past it is over", () => {
    assert.equal(isOverRequestBudget({ key: "GET /a", count: 0 }), false);
    assert.equal(
      isOverRequestBudget({ key: "GET /a", count: 5 }),
      false,
      "5 is the ceiling, not past it"
    );
    assert.equal(isOverRequestBudget({ key: "GET /a", count: 6 }), true);
  });

  test("an empty recording is not a storm", () => {
    // The shape `peakRepeats()` returns when it saw nothing. A control that
    // accepted it would be satisfied by a recorder that recorded nothing.
    assert.equal(isOverRequestBudget({ key: "", count: 0 }), false);
  });
});

describe("the native-health oracle", () => {
  // The vocabulary is the core's own `RuntimeStatus` enum
  // (`aisix-proxy/src/health.rs`, snake_case): healthy, unhealthy, cooldown,
  // not_applicable. Both directions are pinned, because an oracle that can only
  // say "faulty" is as broken as one that can only say "fine".
  const row = (status: string) => ({ provider: "openai", model: "gpt-x", status });

  test("a healthy gateway is healthy: no virtual router is counted as a fault", () => {
    const summary = summarizeNativeModelStatus([
      row("healthy"),
      row("not_applicable"),
      row("not_applicable"),
      row("healthy"),
    ]);

    assert.equal(summary.modelCount, 4);
    assert.equal(
      summary.healthyCount,
      4,
      "not_applicable is a virtual router with no upstream of its own — a combo, which is a " +
        "routing model. It is not a fault, and an oracle that says otherwise is a green test " +
        "confirming a bug."
    );
    assert.equal(summary.degradedCount, 0);
    assert.equal(summary.downCount, 0);
    assert.deepEqual(summary.unrecognisedStatusTokens, []);
  });

  test("a genuinely degraded payload reads as degraded, and a dead one as down", () => {
    const cooling = summarizeNativeModelStatus([row("healthy"), row("cooldown")]);
    assert.equal(cooling.degradedCount, 1, "cooldown is out of rotation but lapses on its own");
    assert.equal(cooling.downCount, 0);

    const dead = summarizeNativeModelStatus([row("healthy"), row("unhealthy")]);
    assert.equal(dead.downCount, 1, "the core puts an unhealthy model in DeploymentState::Down");
    assert.equal(dead.degradedCount, 0);
  });

  test("a token the harness does not know is reported, not counted as degradation", () => {
    // The direction a deny-list gets wrong: a token the gateway adds tomorrow
    // would be counted as degraded by default, and that count would be
    // indistinguishable from a real one.
    const summary = summarizeNativeModelStatus([row("healthy"), row("melting_down")]);

    assert.deepEqual(
      summary.unrecognisedStatusTokens,
      ["melting_down"],
      "an unrecognised token must be named, so the spec can fail loudly on a vocabulary gap"
    );
    assert.equal(
      summary.degradedCount,
      0,
      "an unknown token is not evidence of degradation; the honest verdict is 'not known'"
    );
  });

  test("a row with no status token is counted in neither direction", () => {
    const summary = summarizeNativeModelStatus([{ provider: "openai", model: "gpt-x" }]);

    assert.equal(summary.modelCount, 1);
    assert.equal(summary.healthyCount, 0);
    assert.equal(summary.degradedCount, 0);
    assert.equal(summary.downCount, 0);
    assert.deepEqual(summary.statusTokens, { "": 1 });
  });

  test("a payload that is not a list reports nothing rather than throwing", () => {
    const summary = summarizeNativeModelStatus({ error: "not json" });

    assert.equal(summary.modelCount, 0);
    assert.equal(summary.degradedCount, 0);
    assert.deepEqual(summary.unrecognisedStatusTokens, []);
  });
});

describe("the oracle is anchored to the core's own vocabulary", () => {
  // A FOURTH literal is dangerous — but this one is not the oracle's, it is the
  // GATEWAY's, and it is the only list in the file that is not written by the
  // same hand as the table it checks:
  //
  //   `aisix-proxy/src/health.rs` (verified this session),
  //     enum RuntimeStatus { Healthy, Unhealthy, Cooldown, NotApplicable }
  //     #[serde(rename_all = "snake_case")]
  //
  // So the four tokens below are read off the core, and `RUNTIME_STATUS_STATES`
  // is the dashboard-side copy of that same vocabulary. If the core gains a
  // fifth token, the oracle stops classifying it, `unrecognisedStatusTokens`
  // names it, and BOTH of the assertions here fail — which is the drift signal
  // that two independently edited tables otherwise have none of.
  //
  // WHAT IS DELIBERATELY NOT HERE: a parity assertion against
  // `aisixHealth.ts`'s own `HEALTHY_STATES`/`DEGRADED_STATES`/`DOWN_STATES`.
  // Those three sets are module-private (`aisixHealth.ts:80`, `:98`, `:110` in
  // the worktree that carries the fix) — nothing exports them, so the only way
  // a test can read the product's opinion is to call
  // `toAisixProviderState`, i.e. to import the classifier under audit and
  // assert that it agrees with itself. That half needs a one-line export in
  // `aisixHealth.ts`; until then it is absent rather than circular.
  const CORE_RUNTIME_STATUS = ["healthy", "unhealthy", "cooldown", "not_applicable"] as const;

  test("the oracle classifies every token the core can emit", () => {
    const unclassified = CORE_RUNTIME_STATUS.filter(
      (token) => RUNTIME_STATUS_STATES[token] === undefined
    );
    assert.deepEqual(
      unclassified,
      [],
      `the core can emit ${unclassified.join(", ")} and the e2e oracle does not classify ` +
        `${unclassified.join(", ")}. A token it does not know is reported as a vocabulary gap ` +
        "and asserted empty, so every one of these fails the run until the oracle is extended — " +
        "which is the intended alarm, not a defect."
    );
  });

  test("a payload carrying the whole core vocabulary raises no vocabulary gap", () => {
    const summary = summarizeNativeModelStatus(CORE_RUNTIME_STATUS.map((status) => ({ status })));

    assert.equal(summary.modelCount, 4);
    assert.deepEqual(
      summary.unrecognisedStatusTokens,
      [],
      `the core emitted only tokens it is documented to emit, and the oracle called ` +
        `${JSON.stringify(summary.unrecognisedStatusTokens)} unrecognised. The oracle's ` +
        "vocabulary has drifted from the core's."
    );
    // And every one of the four is placed, not merely recognised: a token that
    // reached `unrecognisedStatusTokens` would also be absent from all three
    // counts, so the totals are asserted as a second, independent witness.
    assert.equal(
      summary.healthyCount + summary.degradedCount + summary.downCount,
      4,
      "a core token was recognised but placed in none of the three states"
    );
  });

  test("the four core tokens mean what the core says they mean", () => {
    // The classification itself, which is a claim about meaning and not about
    // coverage: a virtual router is not a fault, a cooling model is out of
    // rotation but lapses, and an unhealthy one is down.
    assert.equal(RUNTIME_STATUS_STATES.not_applicable, "healthy", "a combo is a routing model");
    assert.equal(RUNTIME_STATUS_STATES.healthy, "healthy");
    assert.equal(RUNTIME_STATUS_STATES.cooldown, "degraded");
    assert.equal(RUNTIME_STATUS_STATES.unhealthy, "down");
  });
});
