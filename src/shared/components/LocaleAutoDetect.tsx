"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LOCALES, LOCALE_ALIASES, LOCALE_COOKIE } from "@/i18n/config";
import type { Locale } from "@/i18n/config";
import { detectBrowserLocale } from "@/i18n/detectBrowserLocale";
import { setClientLocale } from "@/i18n/localeChange";
import { isAisixSpaExport } from "@/shared/utils/aisixEndpoints";

function hasLocaleCookie(): boolean {
  return document.cookie.split(";").some((entry) => entry.trim().startsWith(`${LOCALE_COOKIE}=`));
}

/**
 * Auto-detects the browser language on first visit (no locale cookie set
 * yet) and persists it via the same writer `LanguageSelector` uses for a
 * manual selection, then refreshes the router so the server re-renders with
 * the detected locale. Mounted once in the root layout; renders nothing.
 *
 * In the AISIX static SPA export there is no server render to refresh — the
 * detected locale is applied client-side by `setClientLocale`, which swaps the
 * bundled catalogue instead. See `src/i18n/SpaIntlProvider.tsx`.
 */
export function LocaleAutoDetect() {
  const router = useRouter();

  useEffect(() => {
    if (typeof navigator === "undefined" || hasLocaleCookie()) return;

    const detected = detectBrowserLocale(
      navigator.languages ?? [navigator.language],
      LOCALES,
      LOCALE_ALIASES
    );
    if (!detected) return;

    setClientLocale(detected as Locale);
    // Only refresh when the detected locale DIFFERS from the one the server
    // just rendered (<html lang>): refreshing on every first visit re-navigated
    // the page mid-interaction (flaky e2e "execution context destroyed" + a
    // visible flash for every new visitor whose browser already matches).
    const renderedLocale = document.documentElement.lang || null;
    if (renderedLocale === detected) return;
    if (isAisixSpaExport()) return;
    router.refresh();
    // Run once on mount only — this is a first-visit detection, not a
    // reactive effect that should re-run on router identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
