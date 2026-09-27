import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_ALIASES } from "./config";
import { resolveRequestedLocale } from "./resolveRequestedLocale";

const FALLBACK_LOCALE = "en";

/**
 * Sentinel prefix written by `scripts/i18n/sync-ui-keys.mjs` when backfilling a
 * locale file with an untranslated key: `__MISSING__:<english value>`. Kept in
 * sync manually with the scripts (plain .mjs, no shared TS module) — see
 * `scripts/i18n/sync-ui-keys.mjs` and `scripts/i18n/check-ui-keys-coverage.mjs`.
 */
export const PLACEHOLDER_PREFIX = "__MISSING__:";

function isUntranslatedPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Deep merge that mutates `target` with values from `source`.
 * If both have an object at the same key, recurse.
 * Otherwise prefer the existing value in `target` (locale-specific wins) —
 * unless the target value is an untranslated `__MISSING__:` sentinel written
 * by the i18n sync script, in which case it is treated as absent so the
 * clean English fallback value wins instead (#7258).
 */
export function deepMergeFallback(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  for (const [key, sourceValue] of Object.entries(source)) {
    // Guard against prototype pollution from a crafted locale message tree.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      deepMergeFallback(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (targetValue === undefined || isUntranslatedPlaceholder(targetValue)) {
      target[key] = sourceValue;
    }
  }
  return target;
}

function setNestedValue(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split(".");
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      !segment ||
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype"
    ) {
      return;
    }

    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }

    const next = cursor[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
      continue;
    }

    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
}

export function normalizeComplianceEventTypes(
  messages: Record<string, unknown>
): Record<string, unknown> {
  const compliance =
    messages.compliance &&
    typeof messages.compliance === "object" &&
    !Array.isArray(messages.compliance)
      ? (messages.compliance as Record<string, unknown>)
      : null;
  const eventTypes =
    compliance?.eventTypes &&
    typeof compliance.eventTypes === "object" &&
    !Array.isArray(compliance.eventTypes)
      ? (compliance.eventTypes as Record<string, unknown>)
      : null;

  if (!compliance || !eventTypes) return messages;

  const normalizedEventTypes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(eventTypes)) {
    if (key.includes(".")) {
      setNestedValue(normalizedEventTypes, key, value);
    } else {
      normalizedEventTypes[key] = value;
    }
  }

  return {
    ...messages,
    compliance: {
      ...compliance,
      eventTypes: normalizedEventTypes,
    },
  };
}

/**
 * Load the message tree for `locale` and merge the EN fallbacks.
 *
 * Extracted from the request-config callback so the static-export path can
 * resolve a message tree WITHOUT entering the request scope — see the
 * `OMNIROUTE_EXPORT` short-circuit below.
 */
export async function resolveLocaleMessages(locale: string): Promise<Record<string, unknown>> {
  const localeMessages = normalizeComplianceEventTypes(
    (await import(`./messages/${locale}.json`)).default as Record<string, unknown>
  );

  // G1: fall back to EN for any missing key. EN is loaded only once per request
  // and only when the active locale is not EN itself (no-op).
  let messages = localeMessages as Record<string, unknown>;
  if (locale !== FALLBACK_LOCALE) {
    const fallbackMessages = normalizeComplianceEventTypes(
      (await import(`./messages/${FALLBACK_LOCALE}.json`)).default as Record<string, unknown>
    );
    messages = deepMergeFallback({ ...localeMessages }, fallbackMessages);
  }

  // 4. Merge EN as namespace-level fallback for locales that are missing new namespaces.
  //    Only applied when the active locale is not EN (avoids a redundant import).
  //    Merging is shallow at the top-level namespace key — if a namespace is already
  //    present in the locale file it is kept as-is; missing namespaces fall back to EN.
  //    This ensures new namespaces (e.g. cliCode, cliAgents, acpAgents, cliCommon added
  //    in plan 14 F9) are displayed in English for the 39 non-EN/non-pt-BR locales until
  //    translations are shipped.
  let mergedMessages: Record<string, unknown> = messages as Record<string, unknown>;
  if (locale !== DEFAULT_LOCALE) {
    const enMessages = normalizeComplianceEventTypes(
      (await import(`./messages/${DEFAULT_LOCALE}.json`)).default as Record<string, unknown>
    );
    mergedMessages = { ...enMessages, ...mergedMessages };
  }

  return mergedMessages;
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
