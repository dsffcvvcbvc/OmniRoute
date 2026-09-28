import { LOCALES, LOCALE_COOKIE, LOCALE_ALIASES } from "@/i18n/config";
import type { Locale } from "@/i18n/config";
import { resolveRequestedLocale } from "@/i18n/resolveRequestedLocale";

/**
 * Persist the locale preference in the cookie `src/i18n/request.ts` reads on
 * the server, plus localStorage as a client-side convenience mirror.
 *
 * Shared by every client-side locale writer (manual selection in
 * `LanguageSelector`, first-visit auto-detection in `LocaleAutoDetect`) so
 * there is a single source of truth for the cookie name/format.
 */
export function persistLocale(code: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${code};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
  try {
    localStorage.setItem(LOCALE_COOKIE, code);
  } catch {
    // Ignore (e.g. storage disabled/full)
  }
}

/**
 * The locale `persistLocale` last wrote, or `null` when there is none this build
 * can honour. The read half of the same store, and the counterpart of
 * `src/i18n/request.ts`: a page load has to re-derive the preference from here
 * or the operator is back in the default language on every entry.
 *
 * THE COOKIE WINS, then the localStorage mirror — the same order the server
 * path reads (cookie, then `x-locale`), so a browser with the cookie blocked
 * still gets its choice back and the two never disagree about a value both of
 * them hold.
 *
 * UNTRUSTED INPUT, AND THIS IS THE BOUNDARY. Both stores are writable by any
 * visitor with devtools, and the value read here is what becomes a locale — and
 * therefore a `import(\`./messages/<code>.json\`)` specifier — downstream, so an
 * unknown value must never survive this function. Resolution is therefore
 * delegated to the SAME `resolveRequestedLocale` the server path uses for the
 * same cookie, with an EMPTY fallback: it returns a configured locale or `""`,
 * never the input. That also keeps the two paths in step on a retired locale
 * (`in` → `id`) and on casing (`UK-ua` → `uk-UA`) instead of letting the client
 * answer "English" to a cookie the server would have honoured.
 */
export function readStoredLocale(): Locale | null {
  if (typeof document === "undefined") return null;

  const configured = (raw: string | null | undefined): Locale | null =>
    resolveRequestedLocale(raw ?? "", LOCALES, LOCALE_ALIASES, "") || null;

  return configured(readLocaleCookie()) ?? configured(readStoredMirror());
}

function readLocaleCookie(): string | null {
  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() !== LOCALE_COOKIE) continue;
    return entry.slice(separator + 1).trim();
  }
  return null;
}

function readStoredMirror(): string | null {
  try {
    return localStorage.getItem(LOCALE_COOKIE);
  } catch {
    // Storage disabled or full — the cookie is still there, so this is a
    // narrower miss than an exception would be.
    return null;
  }
}
