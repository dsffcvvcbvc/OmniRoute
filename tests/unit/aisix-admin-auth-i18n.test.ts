/**
 * The gateway-login i18n keys are real translations in all 66 catalogues.
 *
 * `npm run i18n:check-keys` proves a key is PRESENT everywhere. It cannot prove
 * a key is TRANSLATED: a `__MISSING__:<en>` marker, an empty string, or the
 * English sentence pasted into a Chinese catalogue are all "present", and the
 * 2026-09-16 batch that shipped 61 untranslated keys into 65 locales passed
 * every other gate. These three rules are what the repo's merge path enforces
 * and what this pins:
 *
 *   1. no empty value;
 *   2. no value identical to the English source;
 *   3. no Latin script leaking into a catalogue whose language does not use it.
 *
 * Rule 3 is scoped to the gateway-login namespace on purpose: it is a check on
 * values this change added, and widening it to 13,421 existing keys would be a
 * different (and much larger) audit.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MESSAGES = path.join(ROOT, "src", "i18n", "messages");
const NAMESPACE = "adminAuth";
const PROVIDERS_KEY = "adminAuthSignIn";

const en = JSON.parse(readFileSync(path.join(MESSAGES, "en.json"), "utf8"));
const catalog = en[NAMESPACE];
const EN_PROVIDERS_SIGN_IN = en.providers[PROVIDERS_KEY];

const locales = readdirSync(MESSAGES)
  .filter((f) => f.endsWith(".json") && f !== "en.json")
  .map((f) => f.replace(/\.json$/, ""));

/** Locales whose script is not Latin. `ha`/`id`/`yo` are Latin and must not be listed. */
const NON_LATIN = new Set([
  "am", "ar", "bn", "fa", "he", "hi", "hy", "ka", "km", "kn", "ko", "lo", "ml", "mn", "mr",
  "my", "ne", "pa", "si", "ta", "te", "th", "ur", "zh-CN", "zh-TW",
]);

/** Code every language may keep in Latin: config keys, attributes, status codes. */
const CODE_TOKEN =
  /admin\.admin_keys|admin\.tls|HttpOnly|SameSite|Path|Secure|Strict|HTTPS|HTTP|API|Cookie|URL|aisix_admin_session|400|403|401|204|\b8\b|\b8\s*(hours?|hrs?)\b|\bhttps?:|\/admin\/v1/g;

function proseLetters(value: string): string {
  return value
    .replace(CODE_TOKEN, " ")
    .replace(/[^\p{L}]/gu, "");
}

describe("the gateway-login i18n keys", () => {
  test("the en.json source exists and names every key the UI reads", () => {
    assert.equal(typeof catalog, "object", `${NAMESPACE} is missing from en.json`);
    for (const key of ["title", "keyLabel", "submit", "wrongKey", "badRequest", "sessionNotKept", "signedIn", "signOut", "endedNote", "lifetimeNote"]) {
      assert.equal(typeof catalog[key], "string", `en.${NAMESPACE}.${key}`);
      assert.ok(catalog[key].trim().length > 0);
    }
    assert.equal(typeof EN_PROVIDERS_SIGN_IN, "string", `en.providers.${PROVIDERS_KEY}`);
  });

  test("there are 66 locales and every one carries every key", () => {
    assert.equal(locales.length, 66, `expected 66 locales, found ${locales.length}`);
    const missing: string[] = [];
    for (const locale of locales) {
      const json = JSON.parse(readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));
      for (const key of Object.keys(catalog)) {
        if (typeof json[NAMESPACE]?.[key] !== "string") missing.push(`${locale}.${key}`);
      }
      if (typeof json.providers?.[PROVIDERS_KEY] !== "string") {
        missing.push(`${locale}.providers.${PROVIDERS_KEY}`);
      }
    }
    assert.deepEqual(missing, [], `absent keys:\n${missing.join("\n")}`);
  });

  test("rule 1 — no value is empty", () => {
    const empty: string[] = [];
    for (const locale of locales) {
      const json = JSON.parse(readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));
      for (const key of Object.keys(catalog)) {
        const value = json[NAMESPACE][key];
        if (typeof value !== "string" || value.trim().length === 0) empty.push(`${locale}.${key}`);
      }
      if (json.providers[PROVIDERS_KEY].trim().length === 0) {
        empty.push(`${locale}.providers.${PROVIDERS_KEY}`);
      }
    }
    assert.deepEqual(empty, [], `empty values:\n${empty.join("\n")}`);
  });

  test("rule 2 — no value is identical to the English source", () => {
    const identical: string[] = [];
    for (const locale of locales) {
      const json = JSON.parse(readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));
      for (const key of Object.keys(catalog)) {
        const value = String(json[NAMESPACE][key]).trim();
        if (value === String(catalog[key]).trim()) identical.push(`${locale}.${key}`);
      }
      if (json.providers[PROVIDERS_KEY].trim() === EN_PROVIDERS_SIGN_IN.trim()) {
        identical.push(`${locale}.providers.${PROVIDERS_KEY}`);
      }
    }
    assert.deepEqual(identical, [], `untranslated (identical to English):\n${identical.join("\n")}`);
  });

  test("rule 3 — no Latin script leaked into a non-Latin catalogue", () => {
    const leaked: string[] = [];
    for (const locale of locales) {
      if (!NON_LATIN.has(locale)) continue;
      const json = JSON.parse(readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));
      for (const key of Object.keys(catalog)) {
        const letters = proseLetters(String(json[NAMESPACE][key]));
        // `字` (Japanese) shares a block with `字` used as a name, and Hangul
        // punctuation is not a letter, so only a real Latin WORD counts.
        const latinWords = letters.match(/\p{Script=Latin}{2,}/gu);
        if (latinWords) leaked.push(`${locale}.${key} -> ${latinWords.join(",")}`);
      }
    }
    assert.deepEqual(
      leaked,
      [],
      `Latin script in a non-Latin catalogue:\n${leaked.join("\n")}`
    );
  });

  test("no locale carries a __MISSING__ marker", () => {
    const markers: string[] = [];
    for (const locale of locales) {
      const raw = readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8");
      if (raw.includes("__MISSING__")) markers.push(locale);
    }
    assert.deepEqual(markers, [], `markers present in: ${markers.join(", ")}`);
  });
});
