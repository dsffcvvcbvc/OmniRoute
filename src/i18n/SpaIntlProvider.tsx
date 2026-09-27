"use client";

import { useEffect, useState } from "react";
import { NextIntlClientProvider } from "next-intl";
import { DEFAULT_LOCALE, RTL_LOCALES, type Locale } from "@/i18n/config";
import { buildLocaleMessages, normalizeComplianceEventTypes } from "@/i18n/catalog";
import { subscribeLocaleChange, isSupportedLocale } from "@/i18n/localeChange";
import enCatalog from "@/i18n/messages/en.json";

/**
 * AGENT.md §3.3 — the client half of the message-catalogue hoist.
 *
 * THE BUG THIS FIXES. `<NextIntlClientProvider messages={…}>` in a Server
 * Component is a prop crossing the RSC boundary, so the ENTIRE catalogue is
 * serialized into the flight payload of every route. Measured on artifact
 * `10928452044`: a single 690,493-byte flight row holding the English
 * `next-intl` tree was byte-identical in 359 of 360 inspected `<route>.txt`
 * files, plus 515.6 MiB of the same catalogue inside `<route>.html`'s
 * `self.__next_f` script bodies — ~1.9 GiB of a 2.03 GiB export, re-fetched and
 * re-downloaded per route.
 *
 * WHY A BUNDLED CATALOGUE. The catalogue cannot simply be dropped: a Client
 * Component's `useTranslations()` runs during SSR too, so the server render
 * needs a real message tree, and whatever object the provider renders with
 * must exist on the client at hydration or React cannot hydrate the tree. Two
 * ways to give the client one:
 *
 *  - a `<script src>`/static-JSON fetch. It is off the flight payload, but the
 *    server still needs the tree synchronously during SSR and the client only
 *    has it asynchronously, so the provider must suspend and the first paint
 *    needs either a flash of untranslated keys or a global side channel for
 *    the server render (a `globalThis` the server sets per render — wrong the
 *    moment two requests interleave on a real server).
 *  - a static `import` of the catalogue into a Client Component. Both the SSR
 *    pass and the browser resolve the SAME module through their own module
 *    graphs, so the value is there synchronously in both, and — the decisive
 *    part — it is an import of a client component's own dependency, NOT a prop
 *    from a Server Component, so it never enters the flight payload. The
 *    browser downloads one immutable, content-hashed chunk once and reuses it
 *    for every subsequent route.
 *
 * This is the same shape the app already ships for its error boundary:
 * `src/app/global-error.tsx` statically imports `en.json` and dynamically
 * imports the other locales. It reuses those chunks rather than adding a second
 * copy of 67 catalogues.
 *
 * ONLY THE DEFAULT LOCALE IS EAGER. It is the one a static export can ever
 * prerender (`src/i18n/request.ts` pins `DEFAULT_LOCALE` under
 * `OMNIROUTE_EXPORT=1`), so it is the only one on the critical path. The other
 * 66 arrive as lazy chunks on first use, which is what makes the language
 * switcher work client-side in the export instead of silently doing nothing.
 */

type Messages = Record<string, unknown>;

const RAW_EN = enCatalog as Messages;

/**
 * The EN catalogue in next-intl's shape, built ONCE at module scope. A fresh
 * object per render would give `NextIntlClientProvider` a new `messages`
 * identity on every render and re-render the whole app each time.
 *
 * `buildLocaleMessages(DEFAULT_LOCALE, …)` returns exactly this, but it is
 * `async` (the server path awaits a lazy `import()`), and this module must be
 * able to hand the tree to the provider SYNCHRONOUSLY on the server render pass
 * and at hydration. Both of `buildLocaleMessages`' fallbacks are gated on
 * `locale !== FALLBACK_LOCALE` / `locale !== DEFAULT_LOCALE`, so for the
 * default locale the whole function is just step 1. `tests/unit/ui/
 * spa-intl-provider-catalogue-parity.test.ts` asserts that equality, so the two
 * cannot drift apart silently.
 */
const EAGER_MESSAGES: Messages = normalizeComplianceEventTypes(RAW_EN);

interface SpaIntlProviderProps {
  /** The locale the server prerendered this route with (`getLocale()`). */
  locale: string;
  children: React.ReactNode;
}

/**
 * How many non-default catalogues to keep once loaded. A user flipping between a
 * few languages should not re-pay the swap each time, but a long-lived dashboard
 * tab must not grow an unbounded per-locale cache either (67 catalogues is ~70 MiB
 * of messages). Beyond the cap the oldest entries are dropped and re-imported on
 * demand — cheap, because the bundler has already cached the chunk.
 */
const MAX_CACHED_LOCALES = 4;

export function SpaIntlProvider({ locale: initialLocale, children }: SpaIntlProviderProps) {
  const [activeLocale, setActiveLocale] = useState(initialLocale);
  // Loaded catalogues keyed by locale. The default one is in the bundle, so it is
  // seeded here and the common path (every route of the export) never loads
  // anything. `messages` is DERIVED from this rather than stored separately, so
  // falling back to the default needs no state write at all.
  const [catalogues, setCatalogues] = useState<Record<string, Messages>>({
    [DEFAULT_LOCALE]: EAGER_MESSAGES,
  });
  const messages = catalogues[activeLocale] ?? EAGER_MESSAGES;

  // Manual selection (LanguageSelector) and first-visit auto-detection
  // (LocaleAutoDetect) both announce the new locale through this channel.
  useEffect(() => subscribeLocaleChange((code) => setActiveLocale(code)), []);

  // Load the catalogue for the active locale. The default one is already in
  // memory, so this is a no-op for every route in the export; a non-default
  // locale resolves from its own lazy chunk.
  useEffect(() => {
    // `activeLocale` reaches this component from three places — the server's
    // `getLocale()` (already narrowed by resolveRequestedLocale), the locale
    // cookie and `navigator.languages` — so re-check against the configured
    // list here rather than trusting the call chain. The bundler resolves the
    // specifier to a fixed map of chunks, so this is not a filesystem read, but
    // the invariant belongs next to the only place a locale becomes a module
    // path.
    if (!isSupportedLocale(activeLocale) || catalogues[activeLocale]) return;

    let cancelled = false;
    void (async () => {
      try {
        const raw = (await import(`./messages/${activeLocale}.json`)).default as Messages;
        const merged = await buildLocaleMessages(activeLocale, raw, async () => RAW_EN);
        if (cancelled) return;
        setCatalogues((previous) => {
          if (previous[activeLocale]) return previous;
          const next = { ...previous, [activeLocale]: merged };
          const stale = Object.keys(next).filter(
            (code) => code !== DEFAULT_LOCALE && code !== activeLocale
          );
          for (const code of stale.slice(0, Math.max(0, stale.length - MAX_CACHED_LOCALES))) {
            delete next[code];
          }
          return next;
        });
      } catch {
        // A catalogue that will not load must not blank the UI. `messages` is
        // derived as `catalogues[activeLocale] ?? EAGER_MESSAGES`, so the
        // bundled default stays rendered and the page keeps working — in the
        // target locale's own `dir`/`lang`, with English copy, which is a far
        // better failure than an empty shell.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeLocale, catalogues]);

  // `<html lang>` / `dir` are rendered by the Server Component layout and are
  // therefore baked to the prerendered locale. Keep them honest once the client
  // catalogue moves (this is what makes an RTL locale reachable in the export,
  // where no server render follows the switch).
  useEffect(() => {
    const root = document.documentElement;
    if (root.lang !== activeLocale) root.lang = activeLocale;
    const dir = (RTL_LOCALES as readonly string[]).includes(activeLocale) ? "rtl" : "ltr";
    if (root.dir !== dir) root.dir = dir;
  }, [activeLocale]);

  return (
    <NextIntlClientProvider locale={activeLocale as Locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
