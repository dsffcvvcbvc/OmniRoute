import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flattenLeaves,
  isProtectedOnlyValue,
  measureLocale,
  compareToBaseline,
} from "../../scripts/i18n/check-translation-ratio.mjs";
import {
  loadGlossary,
  loadProtectedTerms,
  loadProtectedVocabulary,
} from "../../scripts/i18n/glossary-normalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const MESSAGES = path.join(ROOT, "src", "i18n", "messages");
const NO_PROTECTION = new Set<string>();

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("measureLocale counts identical, placeholder and missing leaves and skips the allowlist", () => {
  const en = flattenLeaves({ a: { b: "Save", c: "Cancel", d: "OmniRoute", e: "Delete" } });
  const loc = flattenLeaves({ a: { b: "Save", c: "__MISSING__:Cancel", d: "OmniRoute" } });
  assert.deepEqual(measureLocale(en, loc, new Set(["a.d"]), NO_PROTECTION), {
    total: 3,
    identical: 1,
    protectedIdentical: 0,
    placeholder: 1,
    missing: 1,
    untranslated: 3,
    ratio: 100,
  });
});

test("measureLocale reports 0 for a fully translated catalog", () => {
  const en = flattenLeaves({ x: "Save", y: "Cancel" });
  const loc = flattenLeaves({ x: "Salvar", y: "Cancelar" });
  assert.equal(measureLocale(en, loc, NO_PROTECTION, loadProtectedVocabulary("ru")).ratio, 0);
});

test("compareToBaseline flags only locales above baseline + slack", () => {
  const regressions = compareToBaseline(
    { es: 56.4, ar: 3.7, de: 26.0 },
    { es: 55.8, ar: 3.7, de: 26.1 },
    0.5
  );
  assert.deepEqual(regressions, [{ locale: "es", measured: 56.4, baseline: 55.8 }]);
});

test("compareToBaseline treats a locale absent from the baseline as a regression against 0", () => {
  assert.deepEqual(compareToBaseline({ el: 12 }, {}, 0.5), [
    { locale: "el", measured: 12, baseline: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// Protected vocabulary is not untranslated debt
//
// scripts/i18n/glossary/protected-terms.json and glossary/<locale>.json
// REQUIRE these values to read in English in every locale, and
// check-glossary-consistency.mjs fails a locale that transliterates them (the
// ko glossary lists the transliterated "Anthropic" as a defect, not a
// translation). The ratchet used to charge ru for obeying: 282 identical
// values, 169 of them protected-only, and no translation could lower it.
// ---------------------------------------------------------------------------

const RU = loadProtectedVocabulary("ru");

test("a value that is nothing but protected vocabulary is exempt", () => {
  for (const value of [
    "Provider",
    "Model",
    "API Key",
    "Request ID",
    "Token",
    "OmniRoute",
    // two protected terms with punctuation between them
    "API Endpoint",
    "CLI: MCP",
    "Claude (OAuth)",
    "Latency · Failover",
    // the glossary lists "Round-Robin"; matching is case-insensitive
    "Round-robin",
  ]) {
    assert.equal(isProtectedOnlyValue(value, RU), true, `expected "${value}" to be exempt`);
  }
});

test("symbol-only values carry no English prose and are exempt", () => {
  for (const value of ["%", "*", "-", "???", "·", "—", "✓", "✗"]) {
    assert.equal(isProtectedOnlyValue(value, RU), true, `expected "${value}" to be exempt`);
  }
});

test("a protected term inside an English sentence is still debt", () => {
  for (const value of [
    "Provider settings",
    "Choose a Provider",
    "Delete all Providers",
    "Configure the Provider endpoint",
    "Model context length",
  ]) {
    assert.equal(
      isProtectedOnlyValue(value, RU),
      false,
      `expected "${value}" to be scored as untranslated debt`
    );
  }
});

test("the match is whole-word: a plural or inflected form is still debt", () => {
  // The glossary protects "Model" and "API Key". It does not protect "Models"
  // or "API Keys", and the ratchet has no business extending it there — a
  // locale that ships "Models" in English is shipping English to the user.
  for (const value of ["Models", "API Keys", "Providers", "Endpoints", "Tokens"]) {
    assert.equal(
      isProtectedOnlyValue(value, RU),
      false,
      `expected "${value}" to be scored as untranslated debt`
    );
  }
});

test("a protected term glued to an identifier is still debt", () => {
  // Whole-word means whole-word: "Model" must not match inside "ModelAdmin".
  for (const value of ["ModelAdmin", "APIKeyRotator", "cf_clearance_token"]) {
    assert.equal(
      isProtectedOnlyValue(value, RU),
      false,
      `expected "${value}" to be scored as untranslated debt`
    );
  }
});

test("an empty vocabulary exempts nothing", () => {
  // Guards the load-failure direction: a gate that cannot read the glossary
  // must score everything as debt, never silently stop exempting.
  assert.equal(isProtectedOnlyValue("Provider", NO_PROTECTION), false);
  assert.equal(isProtectedOnlyValue("Provider", new Set<string>()), false);
});

// ---------------------------------------------------------------------------
// The gate still bites
// ---------------------------------------------------------------------------

test("protected vocabulary is exempt while genuine English is debt", () => {
  // The three shapes the ratchet exists to catch: a pricing string, an error
  // message, a button label. None is a protected term, a brand or a symbol.
  const catalog = {
    labels: { a: "Provider", b: "API Key" },
    pricing: { c: "$0.02 per 1M tokens" },
    errors: { d: "Failed to connect to the gateway" },
    actions: { e: "Save changes" },
  };
  const en = flattenLeaves(catalog);
  const ru = flattenLeaves({ ...catalog });
  const m = measureLocale(en, ru, NO_PROTECTION, RU);
  assert.equal(m.total, 5);
  assert.equal(m.protectedIdentical, 2, "Provider and API Key are protected-only");
  assert.equal(m.identical, 3, "pricing, error and button label are real debt");
  assert.equal(m.untranslated, 3);
  assert.equal(m.ratio, 60);
});

const BASELINE = readJson(path.join(ROOT, "config", "quality", "i18n-translation-baseline.json"));
const ALLOW = new Set<string>(
  readJson(path.join(ROOT, "scripts/i18n/untranslatable-keys.json")).keys ?? []
);
const EN = flattenLeaves(readJson(path.join(MESSAGES, "en.json")));

const measureReal = (locale: string) => {
  const flat = flattenLeaves(readJson(path.join(MESSAGES, `${locale}.json`)));
  return { flat, m: measureLocale(EN, flat, ALLOW, loadProtectedVocabulary(locale)) };
};

const withinRatchet = (locale: string, ratio: number) =>
  compareToBaseline({ [locale]: ratio }, BASELINE.locales, Number(BASELINE.slack ?? 0.5)).length === 0;

for (const locale of ["ru", "ko", "zh-CN", "zh-TW"]) {
  test(`the real ${locale} catalog is inside its ratchet`, () => {
    const { m } = measureReal(locale);
    assert.ok(m.protectedIdentical > 0, `${locale} should have exempt values to subtract`);
    assert.ok(
      withinRatchet(locale, m.ratio),
      `${locale} measured ${m.ratio}% > baseline ${BASELINE.locales[locale]}% (+${BASELINE.slack})`
    );
  });
}

test("a batch of untranslated English strings turns the real ru ratchet red", () => {
  // The other half of the contract. The exemption exists so the gate measures
  // the right thing; this is the proof it did not stop measuring anything.
  // 120 leaves out of ~13,300 is 0.9%, which takes ru past both its measured
  // 0.9% and its 1.1% baseline + 0.5 slack, so the gate has to turn red.
  const synthetic: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) synthetic[`pricing.${i}`] = `$${i}.99 per 1M tokens`;
  for (let i = 0; i < 40; i += 1)
    synthetic[`errors.${i}`] = `Failed to connect to the gateway (attempt ${i})`;
  for (let i = 0; i < 40; i += 1) synthetic[`actions.${i}`] = `Save changes (step ${i})`;

  const debt = flattenLeaves({ syntheticRatioProbe: synthetic });
  for (const [, value] of debt) {
    assert.equal(
      isProtectedOnlyValue(value, RU),
      false,
      `synthetic debt "${value}" must not be exempt or this test proves nothing`
    );
  }

  const { m: before, flat: ruBefore } = measureReal("ru");
  assert.ok(withinRatchet("ru", before.ratio), "ru is green before the debt is injected");

  const after = measureLocale(
    new Map([...EN, ...debt]),
    new Map([...ruBefore, ...debt]),
    ALLOW,
    RU
  );
  assert.equal(after.identical - before.identical, debt.size, "every injected string is debt");
  assert.equal(
    after.protectedIdentical,
    before.protectedIdentical,
    "and none of it lands in the protected exemption"
  );
  assert.ok(
    !withinRatchet("ru", after.ratio),
    `ru should be over its baseline after ${debt.size} untranslated strings, got ${after.ratio}%`
  );
});

test("the exemption does not grow when the glossary does", () => {
  // ru's own glossary contributes no canonical beyond the shared list, so ru's
  // exempt values must all be reachable from protected-terms.json alone. If a
  // future glossary edit adds a term this stops being true, and the exemption's
  // size is no longer explainable by the shared vocabulary alone.
  const shared = new Set(loadProtectedTerms().map((t) => t.toLowerCase()));
  const ruExtras = Object.values(loadGlossary("ru").terms ?? {})
    .map((def) => (def as { canonical?: string }).canonical?.toLowerCase())
    .filter((c): c is string => Boolean(c));
  assert.deepEqual(ruExtras.filter((c) => !shared.has(c)), []);
});

// ---------------------------------------------------------------------------
// One loader for one glossary
// ---------------------------------------------------------------------------

test("a locale without a glossary still gets the shared protected terms", () => {
  // es ships no glossary file. The vocabulary still comes from the shared list:
  // the loader degrades to the shared terms, it never answers "nothing is
  // protected".
  const shared = loadProtectedTerms().map((t) => t.toLowerCase()).sort();
  assert.deepEqual([...loadProtectedVocabulary("es")].sort(), shared);
});

test("a locale with a glossary also protects its own canonical renderings", () => {
  const shared = loadProtectedTerms().map((t) => t.toLowerCase());
  for (const locale of ["ru", "ko", "zh-CN", "zh-TW"]) {
    const vocabulary = loadProtectedVocabulary(locale);
    for (const term of shared) {
      assert.ok(vocabulary.has(term), `${locale} dropped shared protected term "${term}"`);
    }
    for (const def of Object.values(loadGlossary(locale).terms ?? {})) {
      const canonical = (def as { canonical?: string }).canonical;
      if (!canonical) continue;
      assert.ok(
        vocabulary.has(canonical.toLowerCase()),
        `${locale} dropped its own canonical "${canonical}"`
      );
    }
  }
});

test("ko and zh-CN protect vocabulary the shared list does not carry", () => {
  const shared = new Set(loadProtectedTerms().map((t) => t.toLowerCase()));
  for (const locale of ["ko", "zh-CN"]) {
    const extras = [...loadProtectedVocabulary(locale)].filter((t) => !shared.has(t));
    assert.ok(extras.length > 0, `${locale} is expected to add canonical renderings`);
  }
});
