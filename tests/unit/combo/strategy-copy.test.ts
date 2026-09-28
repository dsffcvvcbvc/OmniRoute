/**
 * The two modules extracted out of `combos/page.tsx` to bring the frozen file
 * back under its 5091-line budget.
 *
 * The extraction was a MOVE, so the thing worth pinning is that the data
 * catalogues are still complete and still agree with the shared contract they
 * are derived from. A silent drop during an extraction is invisible in review
 * and shows up later as a strategy or a template that quietly disappeared from
 * a picker.
 *
 * These import the modules directly — no React, no translator, no network —
 * so the shape of a catalogue entry is checkable without mounting the page.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AISIX_COMBO_TEXT,
  AISIX_COMBO_DRAFT_ISSUE_FALLBACKS,
  ADVANCED_FIELD_HELP_FALLBACK,
  STRATEGY_GUIDANCE_FALLBACK,
  STRATEGY_OPTIONS,
  STRATEGY_RECOMMENDATIONS_FALLBACK,
  describeComboDraftIssue,
  getI18nOrFallback,
  getStrategyBadgeClass,
  getStrategyDescription,
  getStrategyGuideText,
  getStrategyLabel,
  getStrategyRecommendationText,
} from "../../../src/app/(dashboard)/dashboard/combos/comboStrategyCopy.ts";

import {
  COMBO_FORM_STAGE_META,
  COMBO_TEMPLATE_FALLBACK,
  COMBO_TEMPLATES,
  COMBO_WIZARD_STEPS,
} from "../../../src/app/(dashboard)/dashboard/combos/comboTemplates.ts";

import {
  AISIX_COMBO_STRATEGY_VALUES,
  COMBO_DRAFT_ISSUE_MESSAGE_KEYS,
  toAisixComboStrategy,
} from "../../../src/shared/utils/aisixCombos.ts";
import { ROUTING_STRATEGIES } from "../../../src/shared/constants/routingStrategies.ts";

/** A translator that resolves nothing, so every lookup takes the literal path. */
const missing = () => ((key: string) => key) as unknown as (key: string) => string;
const noKeys = { has: () => false, [Symbol.toStringTag]: "t" } as never;

// ── the strategy option list ───────────────────────────────────────────────

test("the strategy picker offers every routing strategy, with both of its keys", () => {
  // STRATEGY_OPTIONS is what the pickers render. A strategy dropped here is a
  // strategy the operator can no longer choose, so the count is the assertion.
  assert.equal(STRATEGY_OPTIONS.length, ROUTING_STRATEGIES.length);
  assert.deepEqual(
    STRATEGY_OPTIONS.map((s) => s.value).sort(),
    ROUTING_STRATEGIES.map((s) => s.value).sort()
  );
  for (const option of STRATEGY_OPTIONS) {
    assert.ok(option.labelKey, `${option.value} must carry a label key`);
    assert.ok(option.descKey, `${option.value} must carry a description key`);
  }
});

test("a strategy the gateway does not honour still resolves to a readable label", () => {
  // The fallbacks exist for a locale that has not caught up. `context-relay`
  // and `reset-aware` are the two with hand-written labels; every other
  // strategy falls back to its own value, which must never be blank.
  assert.equal(getStrategyLabel(missing(), "context-relay"), "Context Relay");
  assert.equal(getStrategyLabel(missing(), "reset-aware"), "Reset-Aware RR");
  assert.equal(getStrategyLabel(missing(), "priority"), "priority");
  // An unknown strategy must not render as an empty string.
  assert.equal(getStrategyLabel(missing(), "not-a-strategy"), "not-a-strategy");
  assert.ok(getStrategyDescription(missing(), "priority").length > 0);
});

// ── the AISIX contract copy ────────────────────────────────────────────────

test("every AISIX contract string is a finished sentence, never a key name", () => {
  // These literals are the ONLY thing an operator sees when a locale catalogue
  // is missing the key, so a bare key name here is a visible regression. The
  // mutator: set one value to its own key.
  for (const [key, value] of Object.entries(AISIX_COMBO_TEXT)) {
    assert.equal(typeof value, "string", `${key} must be a string`);
    assert.ok(value.trim().length > 0, `${key} must not be empty`);
    assert.notEqual(value, key, `${key} must read as a sentence, not as its own key`);
  }
});

test("every draft-issue code has an English fallback, in step with the message key", () => {
  // A code with no sentence renders the bare code to an operator, which is the
  // failure this pairing exists to prevent. The mutator: delete one entry.
  assert.deepEqual(
    Object.keys(AISIX_COMBO_DRAFT_ISSUE_FALLBACKS).sort(),
    Object.keys(COMBO_DRAFT_ISSUE_MESSAGE_KEYS).sort()
  );
  for (const [code, sentence] of Object.entries(AISIX_COMBO_DRAFT_ISSUE_FALLBACKS)) {
    assert.ok(sentence.trim().length > 0, `${code} must have a sentence`);
  }
});

test("an unmapped draft-issue code shows the code rather than nothing", () => {
  // Deliberate: an unmapped code is a bug in the page, and showing the code is
  // louder than silently showing nothing.
  const t = missing() as never;
  const described = describeComboDraftIssue(t, { code: "not_a_real_code" } as never);
  assert.equal(described, "not_a_real_code");
});

test("a resolved draft issue uses the translator and interpolates its values", () => {
  // The interpolating path: `model_not_direct` names the offending model, and
  // the values must reach the translator. `getI18nOrFallback` only calls the
  // translator when `t.has(key)` is true, so this mock has to report the key
  // as present — otherwise every lookup silently takes the literal path and
  // this test would pass without the translator ever being consulted.
  // The mutator: drop the `values` argument.
  const seen: Array<[string, unknown]> = [];
  const t = Object.assign(
    (key: string, values?: unknown) => {
      seen.push([key, values]);
      return "resolved";
    },
    { has: () => true }
  ) as never;
  const described = describeComboDraftIssue(t, {
    code: "model_not_direct",
    field: "models[0]",
    model: "gpt-4o",
  } as never);
  assert.equal(described, "resolved");
  assert.deepEqual(seen, [[COMBO_DRAFT_ISSUE_MESSAGE_KEYS.model_not_direct, { model: "gpt-4o" }]]);
});

test("a draft issue with no values does not pass an empty object to the translator", () => {
  // `name_required` interpolates nothing. Passing `{}` instead of `undefined`
  // is the kind of difference that renders `{model}` literally in some
  // next-intl configurations. The mutator: always pass `values`.
  const seen: Array<[string, unknown]> = [];
  const t = Object.assign(
    (key: string, values?: unknown) => {
      seen.push([key, values]);
      return "resolved";
    },
    { has: () => true }
  ) as never;
  describeComboDraftIssue(t, { code: "name_required", field: "name" } as never);
  assert.deepEqual(seen, [[COMBO_DRAFT_ISSUE_MESSAGE_KEYS.name_required, undefined]]);
});

// ── the advanced-field help ───────────────────────────────────────────────

test("every advanced-field help entry explains the field, not its name", () => {
  for (const [field, help] of Object.entries(ADVANCED_FIELD_HELP_FALLBACK)) {
    assert.ok(help.trim().length > 20, `${field} help must be a real explanation`);
    assert.notEqual(help, field, `${field} help must not be the field name`);
  }
});

// ── guidance and recommendations ──────────────────────────────────────────

test("guidance and recommendations answer for every strategy in the picker", () => {
  for (const { value } of STRATEGY_OPTIONS) {
    for (const field of ["when", "avoid", "example"]) {
      assert.ok(
        getStrategyGuideText(missing(), value, field).length > 0,
        `${value}.${field} must resolve to guidance`
      );
    }
    assert.ok(
      getStrategyRecommendationText(missing(), value, "title").length > 0,
      `${value} must resolve to a recommendation title`
    );
    const tips = getStrategyRecommendationText(missing(), value, "tips");
    assert.ok(Array.isArray(tips), `${value} tips must be a list`);
    assert.ok(tips.length > 0, `${value} must offer at least one tip`);
  }
});

// The resolvers fall back to `priority` for any strategy with no entry of its
// own, so a DELETED entry is indistinguishable from one that was never there:
// the operator gets a plausible sentence about the wrong strategy. That is
// why this test exists, and why the first mutant below has to go red on it.
//
// It does NOT assert full coverage, because full coverage is not true today
// and fixing it is not this suite's to do. Five strategies the picker offers
// have no copy and have had none since before the extraction; the locale
// catalogues are short the same five, and adding en-only keys is forbidden by
// the glossary/completeness gate, so closing this is a translation task across
// 66 locales, not a line of code. Pinning the exact set records the defect in
// a place a reader will meet, and turns a sixth gap into a red test.
const STRATEGIES_WITH_NO_COPY = new Set([
  "reset-window",
  "headroom",
  "cache-optimized",
  "fusion",
  "pipeline",
]);

test("the set of strategies with no guidance of their own is exactly the known five", () => {
  // The mutator: delete any one entry from either map, and this goes red on
  // the deleted strategy rather than passing via the priority fallback.
  const uncovered = STRATEGY_OPTIONS.filter(
    ({ value }) => !Object.prototype.hasOwnProperty.call(STRATEGY_GUIDANCE_FALLBACK, value)
  ).map(({ value }) => value);
  assert.deepEqual(
    uncovered.sort(),
    [...STRATEGIES_WITH_NO_COPY].sort(),
    "the uncovered set changed: either a strategy gained copy (remove it here) or one lost it (that is a regression)"
  );
});

test("guidance and recommendations are covered by the same strategies, and no stale entries linger", () => {
  // Both maps are read by the same panel, so a strategy present in one and
  // absent from the other renders a guidance card with no recommendation, or
  // the reverse. A stale entry is the same defect pointed the other way: copy
  // that reaches no picker. The mutator: add a key to one map only.
  assert.deepEqual(
    Object.keys(STRATEGY_GUIDANCE_FALLBACK).sort(),
    Object.keys(STRATEGY_RECOMMENDATIONS_FALLBACK).sort(),
    "guidance and recommendations must cover the same strategies"
  );
  for (const value of Object.keys(STRATEGY_GUIDANCE_FALLBACK)) {
    assert.ok(
      STRATEGY_OPTIONS.some((option) => option.value === value),
      `${value} is described in the copy but is not a strategy the picker offers`
    );
  }
});

test("a strategy with no copy of its own falls back to priority rather than to nothing", () => {
  // The documented behaviour, pinned so the fallback stays deliberate: an
  // operator on one of the five still reads a finished sentence, just the
  // wrong strategy's. That is a copy defect, not a blank panel.
  assert.equal(
    getStrategyGuideText(missing(), "reset-window", "when"),
    getStrategyGuideText(missing(), "priority", "when")
  );
});

test("recommendation tips are numbered from one, contiguously", () => {
  // The tip keys are `strategyRecommendations.<strategy>.tip<N>` with N
  // starting at 1 and running to the number of tips the strategy has. Off-by-one
  // here silently renames every tip key, and the locale lookup then misses for
  // all of them at once. `has` must report the keys present, or the translator
  // is never consulted and the keys never appear at all.
  // The mutator: `index` instead of `index + 1`.
  const asked: string[] = [];
  const t = Object.assign(
    (key: string) => {
      asked.push(key);
      return key;
    },
    { has: () => true }
  ) as never;
  const tips = getStrategyRecommendationText(t, "priority", "tips");
  assert.ok(Array.isArray(tips), "tips must resolve to a list");
  assert.equal(asked.length, tips.length, "one key per tip, no more and no fewer");
  assert.deepEqual(
    asked,
    tips.map((_, i) => `strategyRecommendations.priority.tip${i + 1}`),
    "tip keys must run 1..N with no gap and no repeat"
  );
});

test("an unknown strategy falls back to priority guidance rather than rendering nothing", () => {
  assert.equal(getStrategyGuideText(missing(), "not-a-strategy", "when"), getStrategyGuideText(missing(), "priority", "when"));
  assert.equal(
    getStrategyRecommendationText(missing(), "not-a-strategy", "title"),
    getStrategyRecommendationText(missing(), "priority", "title")
  );
});

// ── the badge palette ─────────────────────────────────────────────────────

test("every strategy gets a badge class, and the known ones are distinct", () => {
  for (const { value } of STRATEGY_OPTIONS) {
    const className = getStrategyBadgeClass(value);
    assert.ok(className.length > 0, `${value} must have a badge class`);
  }
  // The whole point of the mapping is that two strategies are told apart.
  assert.notEqual(getStrategyBadgeClass("weighted"), getStrategyBadgeClass("round-robin"));
  assert.notEqual(getStrategyBadgeClass("round-robin"), getStrategyBadgeClass("random"));
  // An unknown strategy must still get a class rather than `undefined` landing
  // in a className attribute.
  assert.ok(getStrategyBadgeClass("not-a-strategy").length > 0);
});

// ── the translator helper itself ──────────────────────────────────────────

test("getI18nOrFallback prefers a real key and never throws on a broken translator", () => {
  const present = ((key: string) => `T:${key}`) as never;
  present.has = ((key: string) => key === "known") as never;
  assert.equal(getI18nOrFallback(present, "known", "fallback"), "T:known");
  assert.equal(getI18nOrFallback(present, "unknown", "fallback"), "fallback");

  // A translator whose `has` throws must not take the page down with it — the
  // whole point of the helper is that a missing key degrades to a literal.
  const hostile = {
    has: () => {
      throw new Error("translator exploded");
    },
  } as never;
  assert.equal(getI18nOrFallback(hostile, "anything", "fallback"), "fallback");
});

// ── the template and wizard catalogues ────────────────────────────────────

test("every quick-start template is applicable: its strategy TRANSLATES to one the gateway honours", () => {
  // A template carries the TEMPLATE spelling (`round-robin`), which is not a
  // routing strategy — the enum spells it `round_robin`. So the question is
  // not "is this string in the enum" but "does the page's own translation turn
  // it into one", and a template whose strategy does not translate would be
  // applied and then refused on save: the accepted-but-ignored shape the
  // contract work exists to prevent.
  // The mutator: point a template at a strategy with no mapping, e.g. `reroll`.
  for (const template of COMBO_TEMPLATES) {
    const translated = toAisixComboStrategy(template.strategy);
    assert.ok(
      translated,
      `template ${template.id} names strategy ${template.strategy}, which the gateway refuses`
    );
    assert.ok(
      (AISIX_COMBO_STRATEGY_VALUES as readonly string[]).includes(translated),
      `template ${template.id} translated to ${translated}, which is not a gateway strategy`
    );
    assert.ok(template.suggestedName.length > 0, `${template.id} must suggest a name`);
    assert.ok(template.config.maxRetries >= 0, `${template.id} must carry a sane retry count`);
  }
});

test("every template carries a translation key AND an English fallback for both strings", () => {
  // Both halves matter: the key for locales that have the string, the literal
  // for locales that do not. Dropping either leaves one class of operator with
  // a blank tile.
  for (const template of COMBO_TEMPLATES) {
    assert.ok(template.titleKey, `${template.id} must carry a title key`);
    assert.ok(template.descKey, `${template.id} must carry a description key`);
    assert.ok(template.fallbackTitle.trim().length > 0, `${template.id} needs a fallback title`);
    assert.ok(template.fallbackDesc.trim().length > 0, `${template.id} needs a fallback description`);
  }
});

test("template ids are unique — a duplicate id collides in the React key and the testid", () => {
  const ids = COMBO_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate template id in ${ids.join(", ")}`);
});

test("the template fallback block covers every title and description the templates use", () => {
  // The templates read their literals out of COMBO_TEMPLATE_FALLBACK by
  // property. A renamed key would be `undefined` at runtime and render as an
  // empty tile, so the literals must be present.
  for (const field of ["title", "description", "apply"]) {
    assert.ok(COMBO_TEMPLATE_FALLBACK[field].trim().length > 0, `${field} must have a literal`);
  }
  for (const [key, value] of Object.entries(COMBO_TEMPLATE_FALLBACK)) {
    assert.ok(value.trim().length > 0, `${key} must not be empty`);
  }
});

test("the builder stage list is ordered and every stage is labelled", () => {
  assert.ok(COMBO_FORM_STAGE_META.length > 0, "there must be at least one stage");
  for (const stage of COMBO_FORM_STAGE_META) {
    assert.ok(stage.id, "each stage needs an id");
    assert.ok(stage.fallbackLabel.trim().length > 0, `${stage.id} needs a label`);
    assert.ok(stage.fallbackDescription.trim().length > 0, `${stage.id} needs a description`);
  }
  const ids = COMBO_FORM_STAGE_META.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate stage id in ${ids.join(", ")}`);
});

test("the wizard step list starts at one and is contiguous", () => {
  // The numbers are rendered into the DOM as the step index. A gap or a
  // zero-based list is a visible off-by-one in the progress indicator. The
  // mutator: start at 0.
  const steps = COMBO_WIZARD_STEPS.map((s) => s.step);
  assert.deepEqual(
    steps,
    steps.map((_, i) => i + 1),
    `wizard steps must run 1..N with no gaps, got ${steps.join(", ")}`
  );
  for (const step of COMBO_WIZARD_STEPS) {
    assert.ok(step.titleKey, `step ${step.step} needs a title key`);
    assert.ok(step.descKey, `step ${step.step} needs a description key`);
  }
});
