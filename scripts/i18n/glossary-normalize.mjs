/**
 * OmniRoute — shared glossary terminology normalization.
 *
 * Single implementation of the "canonical term" rules declared in
 * scripts/i18n/glossary/<locale>.json, used by three call sites so they can
 * never disagree about what canonical means:
 *
 *   - scripts/i18n/run-translation.mjs        (active docs pipeline)
 *   - scripts/i18n/generate-multilang.mjs     (deprecated legacy generator)
 *   - scripts/i18n/check-glossary-consistency.mjs (drift gate)
 *   - scripts/i18n/check-translation-ratio.mjs  (real-translation ratchet:
 *     a value that is nothing but protected vocabulary is not untranslated
 *     debt, so the ratchet subtracts it)
 *
 * The vocabulary readers live here for the same reason the replacement rules
 * do: `protected-terms.json` and `glossary/<locale>.json` have exactly one
 * reader each. A second parser is how the glossary gate and the ratio gate
 * start disagreeing about what a protected term is.
 *
 * Why `blockedPrefixes` exists: a synonym is matched as a plain substring, and
 * Chinese compounds have no word separators, so a synonym can appear inside an
 * unrelated term. 型別 ("type") sits across the character boundary of 模型別名
 * ("model alias") and is also the correct rendering of a programming data type
 * in 基本型別. Blocking on the preceding character keeps such a term enforced
 * instead of forcing it to be dropped from the glossary entirely.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GLOSSARY_DIR = path.join(SCRIPT_DIR, "glossary");

const cache = new Map();
const protectedCache = { terms: null, vocabulary: new Map() };

/**
 * @param {string} haystack
 * @param {string} needle
 * @param {string[]} [blockedPrefixes]
 * @returns {boolean} true when at least one occurrence is NOT preceded by a blocked prefix
 */
export function hasUnblockedOccurrence(haystack, needle, blockedPrefixes = []) {
  if (!haystack || !needle) return false;
  const blocked = Array.isArray(blockedPrefixes) ? blockedPrefixes.filter(Boolean) : [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const prev = at === 0 ? "" : haystack.slice(at - 1, at);
    if (!prev || !blocked.includes(prev)) return true;
    from = at + 1;
  }
}

/**
 * Flatten a parsed glossary into applicable replacement rules. Concepts with an
 * empty `synonyms` array are documentation-only and produce no rule.
 *
 * @param {object} glossary - parsed scripts/i18n/glossary/<locale>.json
 * @returns {Array<{synonym: string, canonical: string, blockedPrefixes: string[]}>}
 */
export function buildReplacements(glossary) {
  const terms = glossary && glossary.terms ? glossary.terms : {};
  const replacements = [];
  for (const def of Object.values(terms)) {
    if (!def || !def.canonical) continue;
    const synonyms = Array.isArray(def.synonyms) ? def.synonyms : [];
    const blockedPrefixes = Array.isArray(def.blockedPrefixes) ? def.blockedPrefixes : [];
    for (const synonym of synonyms) {
      if (!synonym) continue;
      replacements.push({ synonym, canonical: def.canonical, blockedPrefixes });
    }
  }
  return replacements;
}

/**
 * Parse scripts/i18n/glossary/<locale>.json. Strict — a locale the glossary
 * gate was asked to check has a glossary, and a missing or corrupt one is a
 * broken gate, not a locale with nothing to enforce. Callers for whom the
 * glossary is optional catch and fall back ({@link loadReplacements},
 * {@link loadProtectedVocabulary}).
 *
 * Shared so the glossary gate and the ratio gate cannot disagree about a
 * locale's canonical terms.
 *
 * @param {string} locale
 * @returns {object}
 */
export function loadGlossary(locale) {
  return JSON.parse(readFileSync(path.join(GLOSSARY_DIR, `${locale}.json`), "utf8"));
}

/**
 * The shared protected-term list (scripts/i18n/glossary/protected-terms.json)
 * — product/provider/protocol/CLI/env identifiers that must appear verbatim
 * in any localized string. Strict for the same reason as loadGlossary: no gate
 * can know what is protected if the file is unreadable, and answering
 * "nothing is protected" would quietly un-exempt whatever the gates exempt.
 *
 * @returns {string[]}
 */
export function loadProtectedTerms() {
  if (!protectedCache.terms) {
    const parsed = JSON.parse(
      readFileSync(path.join(GLOSSARY_DIR, "protected-terms.json"), "utf8")
    );
    protectedCache.terms = Array.isArray(parsed.terms) ? parsed.terms : [];
  }
  return protectedCache.terms;
}


/**
 * The vocabulary a locale's catalog is REQUIRED to keep verbatim: the shared
 * protected terms plus that locale's own canonical renderings from
 * glossary/<locale>.json (ru's 15 Law-6 terms, ko's, zh-CN's, zh-TW's).
 *
 * Returned lowercased so callers compare case-insensitively; deciding what a
 * match means is the caller's job.
 *
 * @param {string} locale
 * @returns {Set<string>}
 */
export function loadProtectedVocabulary(locale) {
  if (protectedCache.vocabulary.has(locale)) return protectedCache.vocabulary.get(locale);
  const vocabulary = new Set();
  for (const term of loadProtectedTerms()) {
    if (typeof term === "string" && term) vocabulary.add(term.toLowerCase());
  }
  // Only ko, ru, zh-CN and zh-TW ship a glossary; every other locale simply
  // has no extra canonical renderings beyond the shared list. A missing
  // glossary is normal here, so it degrades instead of throwing.
  let glossary = {};
  try {
    glossary = loadGlossary(locale);
  } catch {
    // No glossary for this locale — nothing extra is protected.
  }
  for (const def of Object.values(glossary.terms ?? {})) {
    if (def && typeof def.canonical === "string" && def.canonical) {
      vocabulary.add(def.canonical.toLowerCase());
    }
  }
  protectedCache.vocabulary.set(locale, vocabulary);
  return vocabulary;
}

/**
 * @param {string} locale
 * @returns {Array<{synonym: string, canonical: string, blockedPrefixes: string[]}>}
 */
export function loadReplacements(locale) {
  if (cache.has(locale)) return cache.get(locale);
  let replacements = [];
  try {
    replacements = buildReplacements(loadGlossary(locale));
  } catch {
    // No glossary for this locale (or unreadable) — normalization is optional.
    replacements = [];
  }
  cache.set(locale, replacements);
  return replacements;
}

/**
 * Apply one replacement rule, skipping blocked occurrences.
 *
 * @param {string} text
 * @param {{synonym: string, canonical: string, blockedPrefixes: string[]}} rule
 * @returns {string}
 */
export function applyReplacement(text, rule) {
  const { synonym, canonical, blockedPrefixes = [] } = rule;
  if (!synonym || !text.includes(synonym)) return text;
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(synonym, from);
    if (at === -1) return out + text.slice(from);
    const prev = at === 0 ? "" : text.slice(at - 1, at);
    const blocked = Boolean(prev) && blockedPrefixes.includes(prev);
    out += text.slice(from, at) + (blocked ? synonym : canonical);
    from = at + synonym.length;
  }
}

/**
 * Normalize a translated string to the locale's canonical terminology.
 * Returns the input unchanged when the locale has no glossary.
 *
 * @param {string} text
 * @param {string} locale
 * @returns {string}
 */
export function normalizeLocaleText(text, locale) {
  if (typeof text !== "string" || !text || !locale) return text;
  const replacements = loadReplacements(locale);
  if (replacements.length === 0) return text;
  let result = text;
  for (const rule of replacements) {
    result = applyReplacement(result, rule);
  }
  return result;
}
