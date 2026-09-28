/**
 * Native model-catalog adapter — AGENT.md v2.0 §3.2, the payload half of
 * `aisixEndpoints.ts`.
 *
 * `GET /admin/v1/models` IS the provider↔model relation on the Rust core: a
 * list of `{ id, value: { display_name, provider, model_name, provider_key_id } }`
 * documents. Three legacy dashboard reads were projections of that one
 * relation, and all three 404 on a static host because the export ships no
 * Next.js API:
 *
 *   - `GET /api/synced-available-models`       → `{ [provider]: [{id, name?}] }`
 *   - `GET /api/provider-models?provider=<p>`   → one provider's model rows
 *   - `GET /api/v1/providers/<p>/models`        → the same rows, OpenAI-shaped
 *
 * The core IGNORES a `?provider=` filter — it returns the whole catalog either
 * way — so the per-provider split happens HERE rather than in a guessed native
 * path. That is the whole point of this module: the native answer is real data
 * and the split is arithmetic over it, not a second round trip that 404s.
 *
 * Invariants, same as `aisixHealth.ts`:
 *   - Never invent a model the core did not report. A provider with no
 *     documents is ABSENT from the result, which is not the same as "this
 *     provider has no models" — callers keep their static registry for those.
 *   - `display_name` is BOTH the operator's label and the id a request must
 *     carry — the core routes on the name shard, so they are the same string,
 *     not two swappable ones. `model_name` is the UPSTREAM vendor identifier
 *     the core substitutes when it dispatches; it is never routable and is
 *     never what this adapter puts in `id`.
 *   - `isAuthoritative: true` is returned only when the core actually answered
 *     with at least one document. A 404, an HTML error page or an empty list
 *     must not be reported as "the core says this provider has no models".
 *
 * Pure — no I/O, no React — so the shape contract is testable on its own.
 */

/** One catalog row as the dashboard's model pickers consume it. */
export interface AisixCatalogModelRow {
  /**
   * The id a request must carry — `value.display_name`.
   *
   * NOT `model_name`. `display_name` is what the core routes on: it is what
   * `Resource::name()` returns, what `filesource` registers the `models`
   * collection's `IdentityField` on, what surfaces on `/v1/models` and in
   * `req.model`, and what `model_resolve::resolve_model` looks up
   * (`snapshot.models.get_by_name(requested)`). `model_name` is the UPSTREAM
   * vendor identifier the core itself substitutes when it dispatches — it is
   * never something a client may send. On a Next build the two usually
   * coincide, so the inversion is invisible until an operator gives a model a
   * label of its own, at which point every id the playground picker offers is
   * unroutable and `get_by_name` returns `None`.
   */
  id: string;
  /** The operator-facing label, when the core carries one. */
  name?: string;
  /** Owning provider id (`value.provider`). */
  provider: string;
  /** Native document id, kept so a row can be traced back to the core. */
  documentId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The native `value` document, or `null`.
 *
 * The core wraps every resource in `{ id, value: {...}, revision }`, so the
 * interesting fields are one level down. A bare `{...}` (no `value` wrapper) is
 * also accepted so the adapter keeps working if a future core flattens the
 * envelope — the row contract is what matters, not the nesting depth.
 */
function readValueDocument(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  const wrapped = entry.value;
  return isRecord(wrapped) ? wrapped : entry;
}

/**
 * Every catalog row the core reported, in the order it reported it.
 * Entries that carry no usable provider or no usable model id are dropped —
 * a row with neither cannot answer "which models does this provider have".
 */
export function parseAisixModelCatalog(payload: unknown): AisixCatalogModelRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: AisixCatalogModelRow[] = [];
  for (const entry of payload) {
    if (!isRecord(entry)) continue;
    const document = readValueDocument(entry);
    if (!document) continue;
    const provider = readString(document.provider);
    // `display_name` is the routable name. A ROUTING/ensemble model (a combo)
    // leaves `model_name` UNSET — it has no upstream to dispatch to — so
    // reading `model_name` first gave every combo a row whose id was its own
    // resource UUID, or none at all. `model_name` is the fallback for a
    // document that somehow lacks a label, never the primary.
    // `document.id`, not `entry.id`: in the native `{id, value}` envelope the
    // resource id is a UUID no request can name, so a WRAPPED document with
    // neither `display_name` nor `model_name` must be dropped, not given a
    // bogus id. For a BARE (unwrapped) document `document === entry`, and its
    // `id` IS its name — which is exactly the case that fallback exists for.
    const id =
      readString(document.display_name) ??
      readString(document.model_name) ??
      readString(document.id);
    if (!provider || !id) continue;
    const row: AisixCatalogModelRow = {
      id,
      provider,
      documentId: readString(entry.id) ?? id,
    };
    const name = readString(document.display_name);
    if (name) row.name = name;
    rows.push(row);
  }
  return rows;
}

/** `true` only when the payload really is a catalog the core answered. */
function isAisixCatalogPayload(payload: unknown): boolean {
  return Array.isArray(payload) && payload.length > 0 && parseAisixModelCatalog(payload).length > 0;
}

/**
 * The `/api/synced-available-models` contract: `{ [provider]: [{ id, name? }] }`.
 *
 * Providers the core did not report are absent from the result. The consumer
 * (`useSyncedModelsByProvider`) treats a missing provider as "fall back to the
 * static registry", which is the honest reading; an explicit empty array would
 * instead claim the provider has no models at all.
 */
export function parseAisixModelCatalogByProvider(
  payload: unknown
): Record<string, Array<{ id: string; name?: string }>> {
  const byProvider: Record<string, Array<{ id: string; name?: string }>> = {};
  for (const row of parseAisixModelCatalog(payload)) {
    const bucket = byProvider[row.provider] ?? (byProvider[row.provider] = []);
    const entry: { id: string; name?: string } = { id: row.id };
    if (row.name) entry.name = row.name;
    bucket.push(entry);
  }
  return byProvider;
}

/**
 * The `/api/provider-models?provider=<p>` contract: `{ models, modelCompatOverrides }`.
 *
 * `modelCompatOverrides` is `[]` and NOT omitted. The legacy route could report
 * operator-authored compat overrides; the core holds no such resource, so the
 * field is present and empty — a consumer that branches on its presence keeps
 * working, and one that reads it as "no overrides exist" is correct rather than
 * crashing on `undefined`.
 */
export function parseAisixProviderModels(
  payload: unknown,
  provider: string
): { models: AisixCatalogModelRow[]; modelCompatOverrides: never[]; authoritative: boolean } {
  const rows = parseAisixModelCatalog(payload).filter((row) => row.provider === provider);
  return {
    models: rows,
    modelCompatOverrides: [],
    authoritative: isAisixCatalogPayload(payload),
  };
}

/**
 * The `/api/v1/providers/{p}/models` contract: `{ data: ProviderModel[] }`, the
 * OpenAI-shaped list the playground's model picker consumes.
 *
 * The core's catalog row carries the two things that list needs and nothing it
 * does not: `id` is the model id a request must carry, and `owned_by` is the
 * provider that owns it. `object` and `displayId` are added because the
 * consumer's type declares them and the OpenAI convention is `"model"` for the
 * discriminator; `type`/`subtype` are deliberately left ABSENT rather than
 * defaulted, because the core does not classify models and a guessed `"chat"`
 * would be a fabricated value that a media provider's entry could act on.
 */
export function parseAisixOpenAiModelList(
  payload: unknown,
  provider: string
): { data: Array<{ id: string; displayId: string; object: "model"; owned_by: string }> } {
  return {
    data: parseAisixModelCatalog(payload)
      .filter((row) => row.provider === provider)
      .map((row) => ({
        id: row.id,
        displayId: row.name ?? row.id,
        object: "model" as const,
        owned_by: row.provider,
      })),
  };
}

/**
 * The `/api/models/catalog` contract the model-catalog table reads:
 * `{ [providerId]: { provider, models: [{ id, name }] } }`.
 *
 * A nested bucket map rather than a flat list, because that is what
 * `flattenCatalog` (`models/modelCatalogUtils.ts`) consumes — grouping here
 * keeps the models page unchanged instead of teaching it a second shape.
 *
 * The core does not classify a model, so no `type` is written: the flattener
 * renders a missing type as `"unknown"`, which is the honest reading, whereas a
 * defaulted `"chat"` would let a media-only model be selected as a chat model.
 */
export function toAisixCatalogBuckets(
  payload: unknown
): Record<string, { provider: string; models: Array<{ id: string; name: string }> }> {
  const byProvider = parseAisixModelCatalogByProvider(payload);
  const buckets: Record<string, { provider: string; models: Array<{ id: string; name: string }> }> =
    {};
  for (const [provider, entries] of Object.entries(byProvider)) {
    buckets[provider] = {
      provider,
      models: entries.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })),
    };
  }
  return buckets;
}
