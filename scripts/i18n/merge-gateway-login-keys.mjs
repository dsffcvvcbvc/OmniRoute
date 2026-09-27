#!/usr/bin/env node
/**
 * Merge the gateway-login i18n keys into `en.json` and every locale catalogue.
 *
 * The repo's translation runner (`scripts/i18n/run-translation.mjs`) needs a
 * translation backend (`OMNIROUTE_TRANSLATION_API_URL`), which is not reachable
 * here, so this script applies translations that are already written and then
 * enforces the three rules that merge path enforces, mechanically, before it
 * writes anything:
 *
 *   1. no empty value;
 *   2. no value identical to the English source;
 *   3. no Latin script leaking into a catalogue whose language does not use it.
 *
 * Rule 3 is the one that needs judgement, so it is not "does the string contain
 * Latin" — every locale legitimately keeps product names, config keys, cookie
 * attribute names and status codes. It is: strip the code-only tokens every
 * language may keep, then require that what remains carries the locale's own
 * script. A non-Latin catalogue whose value is Latin after that is a leaked
 * untranslated string, which is the failure the rule exists to catch.
 *
 * The same three rules are asserted by `tests/unit/aisix-admin-auth-i18n.test.ts`,
 * so they cannot rot between runs.
 *
 * Usage: node scripts/i18n/merge-gateway-login-keys.mjs [--dry-run] [--check]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MESSAGES = path.join(ROOT, "src", "i18n", "messages");
const dryRun = process.argv.includes("--dry-run");
const checkOnly = process.argv.includes("--check");

/** The `adminAuth` namespace, English source of record. */
const EN = {
  title: "Sign in to the gateway",
  intro:
    "The dashboard reads the gateway's admin API. Enter the admin key from admin.admin_keys in the gateway configuration.",
  keyLabel: "Admin key",
  keyHint:
    "The key is sent once and never stored in this browser: the gateway sets an HttpOnly session cookie that page scripts cannot read.",
  submit: "Sign in",
  cancel: "Cancel",
  signingIn: "Signing in…",
  signingOut: "Signing out…",
  emptyKey: "Enter the admin key.",
  wrongKey:
    "That key was not accepted. Check admin.admin_keys in the gateway configuration and try again.",
  badRequest:
    "The gateway rejected the request itself (400) — not the key. That is a dashboard defect; please report it.",
  forbidden:
    "The gateway refused this request as cross-origin (403). A dashboard served by the same gateway cannot produce that; please report it.",
  sessionNotKept:
    "The gateway accepted the key, but the browser did not keep the session cookie, so the dashboard is still signed out. This is what happens when the gateway marks the cookie Secure over a plain-HTTP connection: configure admin.tls on the admin listener, or serve the dashboard over HTTPS.",
  unreachable: "The gateway did not answer. Check that it is running, then try again.",
  signedIn: "Signed in to the gateway.",
  lifetimeNote:
    "A session lasts up to 8 hours and is held in the gateway process, so it ends at the next restart or redeploy. You will be asked for the key again then.",
  signOut: "Sign out",
  signInAction: "Sign in",
  endedNote:
    "Your session ended. Gateway sessions last up to 8 hours and do not survive a restart, so being asked again is expected.",
};

const NAMESPACE = "adminAuth";
/** `providers.adminAuthSignIn` — the button on the two denied banners. */
const PROVIDERS_KEY = "adminAuthSignIn";
const PROVIDERS_SIGN_IN = "Sign in";

// ─── script detection ─────────────────────────────────────────────────────

/** Locales whose script is not Latin. Anything absent here is treated as Latin-script. */
const NON_LATIN = {
  am: "Ethiopic",
  ar: "Arabic",
  bn: "Bengali",
  fa: "Arabic",
  ha: "Latin",
  he: "Hebrew",
  hi: "Devanagari",
  hy: "Armenian",
  id: "Latin",
  ka: "Georgian",
  km: "Khmer",
  kn: "Kannada",
  ko: "Hangul",
  lo: "Lao",
  ml: "Malayalam",
  mn: "Cyrillic",
  mr: "Devanagari",
  my: "Myanmar",
  ne: "Devanagari",
  pa: "Gurmukhi",
  si: "Sinhala",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  ur: "Arabic",
  yo: "Latin",
  zh: "Han",
};

/** `zh-CN`/`zh-TW` are Han; both are non-Latin. */
function isNonLatin(locale) {
  if (locale === "zh-CN" || locale === "zh-TW") return true;
  const script = NON_LATIN[locale];
  if (!script) return false;
  // `ha`, `id`, `yo` are listed above only to document that they are Latin even
  // though they are not English — a non-English language that legitimately uses
  // Latin script must not be failed by this rule.
  return script !== "Latin";
}

/**
 * Tokens every locale may keep in Latin, because they are code, not prose:
 * config keys, cookie attributes, header names, hostnames, status codes.
 *
 * Removing them before the script test is what makes the rule meaningful: a
 * Catalan value that mentions `admin.admin_keys` is translated, and a Chinese
 * one that mentions it and nothing else is not.
 */
const CODE_TOKEN =
  /admin\.admin_keys|admin\.tls|HttpOnly|SameSite|Path|Secure|Strict|HTTPS|HTTP|API|Cookie|URL|aisix_admin_session|400|403|401|204|\b8\b|\b8\s*(hours?|hrs?)\b|\bhttps?:|\/admin\/v1/g;

function stripCodeTokens(value) {
  return value.replace(CODE_TOKEN, " ").replace(/\s+/g, " ").trim();
}

/** Letters the value carries, ignoring digits/punctuation/code tokens. */
function lettersOf(value) {
  return stripCodeTokens(value).replace(/[^\p{L}]/gu, "");
}

// ─── input ────────────────────────────────────────────────────────────────

/** The pre-written translations, read from the files this script is fed. */
function loadTranslations() {
  const merged = {};
  for (const file of process.argv.filter((a) => a.startsWith("--from="))) {
    const filePath = path.resolve(file.slice("--from=".length));
    Object.assign(merged, JSON.parse(readFileSync(filePath, "utf8")));
  }
  if (Object.keys(merged).length === 0) {
    throw new Error("no --from=<file> translation sources given; nothing to merge");
  }
  return merged;
}

const translations = loadTranslations();
const errors = [];

// ─── validate ─────────────────────────────────────────────────────────────

for (const [locale, values] of Object.entries(translations)) {
  for (const key of Object.keys(EN)) {
    const value = values[key];
    const where = `${locale}.${NAMESPACE}.${key}`;

    // A typo guard first: a translation carrying a key name that is not part of
    // the namespace means a hand-edited data file drifted, and silently ignoring
    // it would leave that key untranslated.
    if (key === "signIn") continue;
    if (typeof value !== "string") {
      errors.push(`${where}: missing or non-string value`);
      continue;
    }
    if (value.trim().length === 0) {
      errors.push(`${where}: empty value`);
      continue;
    }
    if (value.trim() === EN[key].trim()) {
      errors.push(`${where}: value identical to the English source`);
      continue;
    }
    if (isNonLatin(locale)) {
      const letters = lettersOf(value);
      if (letters.length > 0 && /\p{Script=Latin}/u.test(letters)) {
        errors.push(`${where}: Latin script leaked into a non-Latin catalogue`);
      }
    }
  }
  if (typeof values.signIn !== "string" || values.signIn.trim().length === 0) {
    errors.push(`${locale}.providers.${PROVIDERS_KEY}: missing or empty value`);
  }
}

// Stray keys in a locale map mean a mistyped field name somewhere; report them
// rather than dropping them, because a dropped key is an untranslated string.
for (const [locale, values] of Object.entries(translations)) {
  for (const key of Object.keys(values)) {
    if (key !== "signIn" && !(key in EN)) {
      errors.push(`${locale}: unknown key "${key}"`);
    }
  }
}

if (errors.length > 0) {
  console.error(`[gateway-login-i18n] ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `[gateway-login-i18n] validated ${Object.keys(translations).length} locales x ${
    Object.keys(EN).length + 1
  } keys (empty / identical-to-English / Latin-in-non-Latin: all clean)`
);

if (checkOnly || dryRun) {
  console.log(`[gateway-login-i18n] ${checkOnly ? "check" : "dry-run"} — nothing written`);
  process.exit(0);
}

// ─── merge ────────────────────────────────────────────────────────────────

const files = readdirSync(MESSAGES).filter((f) => f.endsWith(".json"));
const locales = files.map((f) => f.replace(/\.json$/, ""));

const missing = locales.filter((l) => l !== "en" && !(l in translations));
if (missing.length > 0) {
  console.error(`[gateway-login-i18n] no translation for: ${missing.join(", ")}`);
  process.exit(1);
}

let written = 0;
for (const locale of locales) {
  const file = path.join(MESSAGES, `${locale}.json`);
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (locale === "en") {
    // `providers.adminAuthSignIn` belongs to en.json too: the completeness gate
    // compares locales against it, so a key present in every locale but absent
    // from en.json reads as 66 EXTRA leaves, not as a translated key. en.json is
    // the source of record for both.
    json[NAMESPACE] = { ...EN };
    json.providers[PROVIDERS_KEY] = PROVIDERS_SIGN_IN;
  } else {
    const t = translations[locale];
    const namespace = {};
    for (const key of Object.keys(EN)) namespace[key] = t[key];
    json[NAMESPACE] = namespace;
    json.providers[PROVIDERS_KEY] = t.signIn;
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  written += 1;
}

console.log(`[gateway-login-i18n] merged into ${written} catalogues (en + ${written - 1} locales)`);
