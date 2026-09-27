/**
 * AISIX preset-provider catalog — tolerant client for
 * `GET :3001/admin/v1/preset_providers`.
 *
 * The backend is still in flight, so every shape here degrades honestly:
 * 404/405 (endpoint missing on this core build) → `{ missing: true }` and the
 * providers page renders an explicit "no preset catalog" empty state instead
 * of spinning forever. Any other failure → empty list with `missing: false`
 * so the caller can offer a retry. This module never throws.
 *
 * Pure parsing (`parsePresetProviders`) is separated from I/O
 * (`fetchPresetProviders`) so the envelope tolerance is unit-testable on its
 * own — see `tests/unit/aisix-preset-providers.test.ts`.
 */

import { aisixPresetProvidersUrl, isAisixMissingEndpointStatus } from "./aisixEndpoints";
import { fetchWithTimeout } from "./fetchTimeout";

/** One preset vendor entry, normalized from whatever envelope the core sends. */
export interface AisixPresetProvider {
  /** Stable vendor id (`openai`, `anthropic`, …). Falls back to `name`. */
  id: string;
  /** Display name. */
  name: string;
  /** Upstream base URL, or `null` when the core does not report one. */
  baseUrl: string | null;
  /** Auth shape label (`api_key`, `oauth`, `none`, …) or `null` when unknown. */
  authShape: string | null;
}

/** Result of `fetchPresetProviders` — always resolved, never rejected. */
export interface PresetProvidersResult {
  presets: AisixPresetProvider[];
  /**
   * `true` only when the endpoint itself is absent on this core build
   * (404/405). Distinct from "reachable but empty" (`presets: []`) and from
   * transient failures (`status: null`), so the UI can pick the honest state.
   */
  missing: boolean;
  /** HTTP status of the catalog read, or `null` on network/timeout failure. */
  status: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pickFirst(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = toTrimmedString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

const ID_KEYS = ["id", "provider", "providerId", "provider_id", "slug", "vendor"] as const;
const NAME_KEYS = ["name", "title", "label", "displayName", "display_name"] as const;
const BASE_URL_KEYS = [
  "baseUrl",
  "base_url",
  "baseURL",
  "url",
  "endpoint",
  "apiBase",
  "api_base",
  "apiBaseUrl",
  "api_base_url",
] as const;
const AUTH_SHAPE_KEYS = [
  "authShape",
  "auth_shape",
  "authType",
  "auth_type",
  "auth",
  "authKind",
  "auth_kind",
  "credential",
  "credentialType",
  "credential_type",
] as const;

/** Envelope list fields, in the order the native payload is known to use. */
const PRESET_LIST_FIELDS = ["presets", "providers", "data"] as const;

/** Normalize one raw entry; `null` when it carries no usable identity. */
export function normalizePresetProvider(entry: unknown): AisixPresetProvider | null {
  if (typeof entry === "string") {
    const name = entry.trim();
    if (name.length === 0) return null;
    return { id: name, name, baseUrl: null, authShape: null };
  }
  if (!isRecord(entry)) return null;
  const id = pickFirst(entry, ID_KEYS) ?? pickFirst(entry, NAME_KEYS);
  if (id === null) return null;
  return {
    id,
    name: pickFirst(entry, NAME_KEYS) ?? id,
    baseUrl: pickFirst(entry, BASE_URL_KEYS),
    authShape: pickFirst(entry, AUTH_SHAPE_KEYS),
  };
}

/**
 * Tolerant envelope parsing: a bare array, or an object carrying the list
 * under any of `presets` / `providers` / `data`. Anything else → `[]`.
 */
export function parsePresetProviders(payload: unknown): AisixPresetProvider[] {
  const rawList: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (PRESET_LIST_FIELDS.map((field) => payload[field]).find((candidate) =>
          Array.isArray(candidate)
        ) ?? [])
      : [];
  if (!Array.isArray(rawList)) return [];
  const out: AisixPresetProvider[] = [];
  for (const entry of rawList) {
    const normalized = normalizePresetProvider(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

const PRESET_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read the preset catalog. Never throws and never hangs past the timeout:
 * 404/405 → `{ presets: [], missing: true }` (honest empty-state/refusal),
 * other non-2xx or unreadable body → `{ presets: [], missing: false }`
 * (caller shows empty + retry), network/timeout → `status: null`.
 */
export async function fetchPresetProviders(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch as typeof globalThis.fetch,
  timeoutMs: number = PRESET_FETCH_TIMEOUT_MS
): Promise<PresetProvidersResult> {
  try {
    const res = await fetchWithTimeout(aisixPresetProvidersUrl(), {
      timeoutMs,
      fetchFn: fetchImpl,
    });
    if (isAisixMissingEndpointStatus(res.status)) {
      return { presets: [], missing: true, status: res.status };
    }
    if (!res.ok) {
      return { presets: [], missing: false, status: res.status };
    }
    const payload = await res.json().catch(() => null);
    return { presets: parsePresetProviders(payload), missing: false, status: res.status };
  } catch {
    return { presets: [], missing: false, status: null };
  }
}
