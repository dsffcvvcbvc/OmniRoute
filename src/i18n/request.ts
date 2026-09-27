import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_ALIASES } from "./config";
import { resolveRequestedLocale } from "./resolveRequestedLocale";
import { buildLocaleMessages } from "./catalog";

export { PLACEHOLDER_PREFIX, deepMergeFallback, normalizeComplianceEventTypes } from "./catalog";

/**
 * Load the message tree for `locale` and merge the EN fallbacks.
 *
 * Extracted from the request-config callback so the static-export path can
 * resolve a message tree WITHOUT entering the request scope — see the
 * `OMNIROUTE_EXPORT` short-circuit below. The transform itself lives in
 * `catalog.ts` because the AISIX SPA client provider has to apply the exact same
 * one to the catalogue it bundles.
 */
export async function resolveLocaleMessages(locale: string): Promise<Record<string, unknown>> {
  const raw = (await import(`./messages/${locale}.json`)).default as Record<string, unknown>;

  return buildLocaleMessages(locale, raw, async () => {
    return (await import(`./messages/en.json`)).default as Record<string, unknown>;
  });
}

/**
 * AGENT.md §3.3 — static SPA export (`output: "export"`, OMNIROUTE_EXPORT=1).
 *
 * The root layout calls `getLocale()` / `getMessages()` for EVERY route, so
 * this callback runs for every page the export prerenders. At build time there
 * is no request, and touching the request scope is exactly what opts a page out
 * of static generation: under `output: "export"` the renderer is pinned to
 * `dynamic = "error"`, so the `cookies()` / `headers()` reads below abort the
 * render with E611 and the route never reaches `out/`. A single unguarded read
 * here empties the entire export.
 *
 * So the export build resolves DEFAULT_LOCALE straight from disk and never
 * enters the request scope. A static bundle has exactly one prerendered message
 * tree, so per-request locale negotiation is not something a single export can
 * carry; the live `output: "standalone"` server keeps it, unchanged, because
 * this branch is gated on the export build profile alone.
 */
export default getRequestConfig(async () => {
  if (process.env.OMNIROUTE_EXPORT === "1") {
    return {
      locale: DEFAULT_LOCALE,
      messages: await resolveLocaleMessages(DEFAULT_LOCALE),
    };
  }

  const cookieStore = await cookies();
  let locale: string = cookieStore.get(LOCALE_COOKIE)?.value || "";

  if (!locale) {
    const headerStore = await headers();
    locale = headerStore.get("x-locale") || "";
  }

  locale = resolveRequestedLocale(locale, LOCALES, LOCALE_ALIASES, DEFAULT_LOCALE);

  return {
    locale,
    messages: await resolveLocaleMessages(locale),
  };
});
