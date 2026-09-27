/**
 * AISIX upstream provider-key CRUD — the client for
 * `GET|POST /admin/v1/provider_keys` and
 * `GET|PATCH|DELETE /admin/v1/provider_keys/:id`.
 *
 * SCOPE, and why it is separate from the dashboard's own API keys
 * (`/api/keys`, the `ApiManagerPageClient` surface): a provider key is an
 * UPSTREAM credential — the OpenAI/Anthropic/Gemini key the gateway sends
 * upstream. `aisixEndpoints.ts` documents the same distinction: OmniRoute's
 * inbound consumer keys are a different resource and must never be mapped onto
 * this collection.
 *
 * Every shape here was read off the Rust handler
 * (`aisix-admin/src/keys_handler.rs`) and confirmed against a live gateway, not
 * inferred from the OpenAPI prose. The contract this module implements:
 *
 *   GET    /provider_keys        → 200 `[ { id, revision, value } ]`
 *   GET    /provider_keys/:id    → 200 `{ id, revision, value }` | 404
 *   POST   /provider_keys        → 201 `{ id, revision, value, version }`
 *   PATCH  /provider_keys/:id    → 200 `{ id, revision, value, version }`
 *   DELETE /provider_keys/:id    → 200 `{ id, status: "deleted", version }`
 *
 * Refusals the UI MUST surface rather than swallow — all in the admin
 * `{"error_msg": …}` envelope:
 *   401/403 no admin key                      → nothing is readable or writable
 *   400     strict-schema violation           → `Validation failed at '/': …`
 *   404     no such key (PATCH/DELETE)        → `resource not found`
 *   409     duplicate `display_name`          → `a provider key named "x" already exists`
 *   409     key still referenced              → `… is still referenced by N (…)`
 *   500     resources file holds other rows   → `… which a per-key write cannot
 *            re-emit; use POST /admin/v1/resources` — see the note on
 *            `ProviderKeyWriteOutcome` below.
 *
 * `null` data is never a substitute for zero: a failed read yields
 * `data: null` plus the status, so a caller that forgets to check renders an
 * explicit "unknown" state rather than an empty table.
 *
 * This module never throws.
 */

import {
  aisixProviderKeysItemUrl,
  aisixProviderKeysUrl,
  fetchAisixJson,
  isAisixMissingEndpointStatus,
  type AisixJsonResult,
} from "./aisixEndpoints";
import { fetchWithTimeout } from "./fetchTimeout";

/**
 * The stored document, as `GET` returns it. Only the fields the CRUD UI shows or
 * sends are typed; the gateway stores more (tls, strip_headers, request/
 * response overrides, …) and they are preserved verbatim through a PATCH
 * because the handler merges the patch onto the STORED document rather than
 * replacing it.
 */
export interface AisixProviderKeyValue {
  display_name: string;
  api_key: string;
  /** Empty string when the core reports no provider — not absent. */
  provider?: string;
  api_base?: string;
  project?: string;
  strip_headers?: string[];
  telemetry_tags?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** `ResourceEntry<ProviderKey>` — `id` + `revision` are the envelope's, not the document's. */
export interface AisixProviderKeyEntry {
  id: string;
  revision: number;
  value: AisixProviderKeyValue;
}

/** The create/update response, which adds the snapshot `version` the reads do not carry. */
export interface AisixProviderKeyWriteResult {
  id: string;
  revision: number;
  version: number;
  value: AisixProviderKeyValue;
}

/**
 * The document a create may send.
 *
 * The handler validates it against the STRICT write schema, so an unknown field
 * is a 400 rather than a silent drop — `enabled` is the one an operator reaches
 * for and the model has no place for, so it is deliberately absent here. Every
 * optional field is omitted when blank so the payload never carries `""` for
 * something the model models as `Option`.
 */
export interface ProviderKeyCreateInput {
  displayName: string;
  apiKey: string;
  provider?: string;
  apiBase?: string;
}

/** A PATCH body. Same rule: only fields the model actually has. */
export interface ProviderKeyPatchInput {
  displayName?: string;
  apiKey?: string;
  provider?: string;
  apiBase?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function toRevision(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Coerce one wire entry; `null` when it carries no id, which the list then skips. */
export function normalizeProviderKeyEntry(entry: unknown): AisixProviderKeyEntry | null {
  if (!isRecord(entry)) return null;
  const id = toTrimmedString(entry.id);
  if (!id || !isRecord(entry.value)) return null;
  const value = entry.value;
  const displayName = toTrimmedString(value.display_name);
  // `api_key` is REQUIRED by the schema; an entry without it is not a key.
  if (!displayName || typeof value.api_key !== "string") return null;
  return {
    id,
    revision: toRevision(entry.revision),
    value: value as AisixProviderKeyValue,
  };
}

/** Tolerant list parse: a bare array, or `{data|keys|provider_keys}`. */
export function parseProviderKeyEntries(payload: unknown): AisixProviderKeyEntry[] {
  const raw: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (["provider_keys", "keys", "data"] as const)
          .map((field) => payload[field])
          .find((candidate) => Array.isArray(candidate))
      : [];
  if (!Array.isArray(raw)) return [];
  const out: AisixProviderKeyEntry[] = [];
  for (const entry of raw) {
    const normalized = normalizeProviderKeyEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** A read outcome. `missing` is only the "endpoint is not on this build" answer. */
export interface ProviderKeysReadResult {
  entries: AisixProviderKeyEntry[];
  missing: boolean;
  /** 401/403 means the core HAS the surface and wants an admin key. */
  status: number;
  /** HTTP status, or `0` when no response was produced at all. */
  error: string | null;
}

/**
 * List the provider keys. Tolerantly: 404/405 → `missing` (render an explicit
 * empty state), 401/403 → `status` preserved so the page can name the missing
 * admin key instead of drawing an empty table, anything else → `error`.
 */
export async function fetchProviderKeys(): Promise<ProviderKeysReadResult> {
  const result: AisixJsonResult = await fetchAisixJson(aisixProviderKeysUrl());
  if (!result.ok) {
    return {
      entries: [],
      missing: result.missing,
      status: result.status,
      error: result.error,
    };
  }
  return {
    entries: parseProviderKeyEntries(result.data),
    missing: false,
    status: 200,
    error: null,
  };
}

/**
 * Why a write failed, in the terms the UI has to render.
 *
 * `unsupported` is the one case that must never be retried or optimistically
 * papered over: the resources file already holds rows this per-key endpoint
 * cannot re-emit, so the gateway applies the change in memory and then REFUSES
 * to persist it. Reporting that as success would leave the operator believing a
 * credential is stored when a reload will drop it.
 */
export type ProviderKeyWriteFailureKind =
  | "unauthorized"
  | "invalid"
  | "not_found"
  | "conflict"
  | "not_persisted"
  | "unsupported"
  | "failed";

export interface ProviderKeyWriteOutcome {
  ok: boolean;
  status: number;
  /** Present only on success — the caller renders the SERVER's document, not a guess. */
  result: AisixProviderKeyWriteResult | null;
  failure: ProviderKeyWriteFailureKind | null;
  /** The gateway's own `error_msg`, verbatim and untranslated — it names the exact refusal. */
  reason: string | null;
}

const WRITE_TIMEOUT_MS = 15_000;

function classify(status: number): ProviderKeyWriteFailureKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400) return "invalid";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  // The store refused to persist. `AdminError::Store` is a 500, and its message
  // is the only way to tell "the file cannot hold this write" from a real crash.
  if (status >= 500) return "not_persisted";
  return "failed";
}

/** The admin envelope is `{"error_msg": "..."}`; anything else yields `null`. */
function readErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return (
    toTrimmedString(body.error_msg) ?? toTrimmedString(body.error) ?? toTrimmedString(body.message)
  );
}

function parseWriteResult(body: unknown): AisixProviderKeyWriteResult | null {
  if (!isRecord(body)) return null;
  const id = toTrimmedString(body.id);
  const value = body.value;
  if (!id || !isRecord(value) || typeof value.api_key !== "string") return null;
  return {
    id,
    revision: toRevision(body.revision),
    version: toRevision(body.version),
    value: value as AisixProviderKeyValue,
  };
}

/**
 * The DELETE envelope is NOT the write envelope: the handler answers
 * `{id, status: "deleted", version}` and carries no document, because there is
 * no row left to describe. Parsing it with `parseWriteResult` would report a
 * successful delete as an unreadable success body — the key would look like it
 * still exists.
 */
function parseDeleteResult(body: unknown): { id: string; version: number } | null {
  if (!isRecord(body)) return null;
  const id = toTrimmedString(body.id);
  if (!id) return null;
  if (toTrimmedString(body.status) !== "deleted") return null;
  return { id, version: toRevision(body.version) };
}

async function sendWrite(
  url: string,
  method: string,
  body: unknown,
  parse: (payload: unknown) => ProviderKeyWriteResult | null = parseWriteResult
): Promise<ProviderKeyWriteOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: WRITE_TIMEOUT_MS,
      fetchFn: globalThis.fetch as typeof fetch,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      result: null,
      failure: "failed",
      reason: error instanceof Error ? error.message : "request_failed",
    };
  }

  const status = response.status;
  const payload = await response.json().catch(() => null);
  if (response.ok) {
    const result = parse(payload);
    if (result) return { ok: true, status, result, failure: null, reason: null };
    // 2xx with a body we cannot read is NOT a success: reporting it as one is how
    // a write that never landed gets shown as landed.
    return {
      ok: false,
      status,
      result: null,
      failure: "failed",
      reason: "unreadable_success_body",
    };
  }
  if (isAisixMissingEndpointStatus(status)) {
    // 404/405 is ambiguous on its own: a MISSING ROUTE and a MISSING ROW are the
    // same status. The admin envelope tells them apart — the handler answers
    // `{"error_msg": "resource not found"}` for a row it does not have, and a
    // route this build does not serve has no such envelope at all. Getting this
    // backwards tells the operator the whole surface is gone when one key is.
    const message = readErrorMessage(payload);
    if (message === null) {
      return { ok: false, status, result: null, failure: "unsupported", reason: null };
    }
    return { ok: false, status, result: null, failure: "not_found", reason: message };
  }
  return {
    ok: false,
    status,
    result: null,
    failure: classify(status),
    reason: readErrorMessage(payload),
  };
}

/**
 * The exact document a create may send.
 *
 * Exported and separately tested because the field set IS the contract: a key
 * the model has no field for is rejected by the strict schema with a 400, and
 * an empty string for an `Option` field is not the same as omitting it.
 */
export function buildProviderKeyDocument(input: ProviderKeyCreateInput): Record<string, string> {
  const document: Record<string, string> = {
    display_name: input.displayName.trim(),
    api_key: input.apiKey.trim(),
  };
  const provider = input.provider?.trim();
  const apiBase = input.apiBase?.trim();
  if (provider) document.provider = provider;
  if (apiBase) document.api_base = apiBase;
  return document;
}

/** The exact document a PATCH may send: only the fields the operator changed. */
export function buildProviderKeyPatch(input: ProviderKeyPatchInput): Record<string, string> {
  const patch: Record<string, string> = {};
  const displayName = input.displayName?.trim();
  const apiKey = input.apiKey?.trim();
  const provider = input.provider?.trim();
  const apiBase = input.apiBase?.trim();
  if (displayName) patch.display_name = displayName;
  if (apiKey) patch.api_key = apiKey;
  if (provider) patch.provider = provider;
  if (apiBase) patch.api_base = apiBase;
  return patch;
}

/** `POST /admin/v1/provider_keys` — 201 with the server's own document. */
export function createProviderKey(input: ProviderKeyCreateInput): Promise<ProviderKeyWriteOutcome> {
  return sendWrite(aisixProviderKeysUrl(), "POST", buildProviderKeyDocument(input));
}

/**
 * `PATCH /admin/v1/provider_keys/:id`.
 *
 * A PATCH is a MERGE onto the stored document, so it needs no full document —
 * and sending an empty patch would be a no-op write that still bumps the
 * revision, so the caller is told when nothing would change.
 */
export function updateProviderKey(
  id: string,
  input: ProviderKeyPatchInput
): Promise<ProviderKeyWriteOutcome> {
  return sendWrite(aisixProviderKeysItemUrl(id), "PATCH", buildProviderKeyPatch(input));
}

/**
 * `DELETE /admin/v1/provider_keys/:id`.
 *
 * 409 is the interesting case and it is a FEATURE, not an error to hide: the
 * handler refuses while a model or passthrough route still names the key,
 * because `provider_key_id` is a reference and orphaning it would leave a live
 * model dispatching with no credential. `reason` carries the dependent names.
 */
export function deleteProviderKey(id: string): Promise<ProviderKeyWriteOutcome> {
  return sendWrite(aisixProviderKeysItemUrl(id), "DELETE", {}, (payload) => {
    const deleted = parseDeleteResult(payload);
    if (!deleted) return null;
    // There is no document left to return, so the outcome reports the identity
    // the gateway echoed instead — which is what the caller removes from its list.
    return {
      id: deleted.id,
      revision: 0,
      version: deleted.version,
      value: { display_name: "", api_key: "" },
    };
  });
}
