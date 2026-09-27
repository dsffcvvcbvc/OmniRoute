/**
 * Pure message-catalogue transforms — no `next-intl/server`, no `next/headers`.
 *
 * Why this module exists (AGENT.md §3.3 — AISIX SPA static export):
 *
 * `src/i18n/request.ts` is the next-intl request config. It mixes two concerns:
 * the *pure* transform of a raw `<locale>.json` into the tree next-intl expects
 * (dotted `compliance.eventTypes` keys nested, EN fallback for missing keys and
 * missing namespaces) and the *loading* of that JSON (`import()` of the locale
 * file, plus the `cookies()`/`headers()` negotiation).
 *
 * The transform used to be reachable only through `request.ts`, so the only way
 * to obtain a catalogue outside the request config was to import a module that
 * also pulls in `next/headers` — which a Client Component may not do. The SPA
 * export needs exactly that: it renders the client-side `NextIntlClientProvider`
 * from a bundled catalogue (see `SpaIntlProvider.tsx`) and must apply the SAME
 * transform, or a locale that is missing keys or namespaces renders differently
 * in the browser than the server produced it. Extracting the transform lets both
 * sides share one implementation instead of two that can drift.
 *
 * Nothing here touches the environment, the filesystem or the request scope, so
 * it is importable from Server Components, Client Components and unit tests.
 */

import { DEFAULT_LOCALE } from "./config";

/**
 * Sentinel prefix written by `scripts/i18n/sync-ui-keys.mjs` when backfilling a
 * locale file with an untranslated key: `__MISSING__:<english value>`. Kept in
 * sync manually with the scripts (plain .mjs, no shared TS module) — see
 * `scripts/i18n/sync-ui-keys.mjs` and `scripts/i18n/check-ui-keys-coverage.mjs`.
 */
export const PLACEHOLDER_PREFIX = "__MISSING__:";

/**
 * Locale whose catalogue fills gaps in every other locale. Conceptually the
 * "gap filler", distinct from `DEFAULT_LOCALE` below (the locale the app falls
 * back to wholesale and the one the static export prerenders). They coincide
 * today; they are kept apart because they answer different questions and a
 * future change to either must not silently change the other.
 */
export const FALLBACK_LOCALE = "en";

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
 * Turn a raw `<locale>.json` into the tree next-intl resolves keys against.
 *
 * Three steps, in order (extracted verbatim from `resolveLocaleMessages` so the
 * request-config path and the SPA client path cannot diverge):
 *   1. nest the dotted `compliance.eventTypes` keys;
 *   2. for a non-EN locale, deep-merge EN underneath so an absent leaf or a
 *      `__MISSING__:` sentinel resolves to the real English string;
 *   3. for a non-default locale, add whole EN namespaces the locale has not
 *      shipped yet.
 *
 * `loadFallback` is a thunk, not a value: the server request config only
 * imports `en.json` when the active locale is not EN (step 2 and 3 are both
 * no-ops then), which keeps the request path's import graph unchanged. A caller
 * that already holds the EN catalogue in memory — the SPA client provider —
 * passes a thunk that resolves it immediately.
 */
export async function buildLocaleMessages(
  locale: string,
  rawLocaleMessages: Record<string, unknown>,
  loadFallback: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const localeMessages = normalizeComplianceEventTypes(rawLocaleMessages);

  // G1: fall back to EN for any missing key. EN is loaded only once per request
  // and only when the active locale is not EN itself (no-op).
  let messages = localeMessages as Record<string, unknown>;
  if (locale !== FALLBACK_LOCALE) {
    const fallbackMessages = normalizeComplianceEventTypes(await loadFallback());
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
    const enMessages = normalizeComplianceEventTypes(await loadFallback());
    mergedMessages = { ...enMessages, ...mergedMessages };
  }

  return mergedMessages;
}
