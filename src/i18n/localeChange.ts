/**
 * The single client-side channel a locale change travels through.
 *
 * Before this module there were two unrelated writers of the same preference:
 * `LanguageSelector` (a click) and `LocaleAutoDetect` (a first-visit browser
 * sniff), each calling `persistLocale()` and then `router.refresh()` so the
 * SERVER would re-render in the new locale. That contract is all a
 * `output: "standalone"` server can honour.
 *
 * The AISIX static SPA export cannot: there is no server, and every route's RSC
 * payload is a build-time artifact of `DEFAULT_LOCALE`, so `router.refresh()`
 * re-downloads the very same English payload. Switching language there was
 * therefore a no-op — a real gap, since the export ships all 67 catalogues.
 *
 * `setClientLocale` closes it: it persists the preference (cookie + localStorage,
 * unchanged) and announces the new locale on the window, so a
 * `NextIntlClientProvider` fed from a bundled catalogue
 * (`src/i18n/SpaIntlProvider.tsx`) can swap catalogues client-side. The server
 * path is untouched — callers still call `router.refresh()` there.
 *
 * Deliberately dependency-free (no React, no `next/navigation`) so the writers
 * and the listener can be unit-tested without a renderer.
 */

import { LOCALES, type Locale } from "./config";
import { persistLocale } from "@/shared/lib/persistLocale";

/** `window` CustomEvent name carrying a validated locale code in `detail`. */
export const LOCALE_CHANGE_EVENT = "omniroute:locale-change";

/** True when `code` is a locale this build actually ships a catalogue for. */
export function isSupportedLocale(code: unknown): code is Locale {
  return typeof code === "string" && (LOCALES as readonly string[]).includes(code);
}

/**
 * Persist `code` and announce it to every `SpaIntlProvider` on the page.
 *
 * Returns the locale that was applied, or `null` when `code` is not a
 * configured locale — an unknown code must leave both the cookie and the
 * rendered catalogue untouched rather than write a preference nothing can read.
 */
export function setClientLocale(code: string): Locale | null {
  if (!isSupportedLocale(code)) return null;

  persistLocale(code);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string>(LOCALE_CHANGE_EVENT, { detail: code }));
  }
  return code;
}

/** Subscribe to client-side locale changes. Returns an unsubscribe function. */
export function subscribeLocaleChange(handler: (code: Locale) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isSupportedLocale(detail)) handler(detail);
  };

  window.addEventListener(LOCALE_CHANGE_EVENT, listener);
  return () => window.removeEventListener(LOCALE_CHANGE_EVENT, listener);
}
