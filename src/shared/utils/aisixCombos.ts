/**
 * AISIX combo CRUD — the client for `GET|POST /admin/v1/combos` and
 * `GET|PATCH|DELETE /admin/v1/combos/:id`.
 *
 * ## Why this module exists at all
 *
 * The dashboard's Combos screen is a port of the OmniRoute template, which
 * offers 19 routing strategies and a large per-step field set. The Rust gateway
 * implements a SUBSET of that. `aisix-admin::combos_handler` settles the
 * difference by REFUSING: every field outside the combo contract is rejected
 * by name with a 400 rather than accepted and dropped, because a field that
 * validates and then disappears reads on the dashboard as "configured" and does
 * nothing — accepted-but-unread config, which this repo's own rules call a trap.
 *
 * So the form must not offer a control the gateway will refuse. The exact
 * contract this module implements, read off the handler and confirmed against a
 * live gateway:
 *
 *   Document:  `name`, `strategy`, `models`                    (COMBO_FIELDS)
 *   Target:    `model`, `weight`, `priority`, `tags`           (COMBO_MODEL_FIELDS)
 *   Strategy:  round_robin, consistent_hash, failover,
 *              least_cost, least_latency, least_busy            (SUPPORTED_STRATEGIES)
 *
 * `name` is required, a string, and non-empty once trimmed. `strategy` is
 * optional and defaults to `failover` when absent. `models` is required, must be
 * an array, and must hold at least one entry. Each entry names a model by
 * DISPLAY NAME — `model_id` is deliberately absent, because the durable target
 * of this surface is the declarative resources file, which resolves a target by
 * name and rejects the id outright.
 *
 * ## The rules the schema cannot state
 *
 * `validateComboDraft` mirrors these so the form refuses them at the point of
 * entry instead of after a submit:
 *
 *   1. every target must resolve, in the current configuration, to a **direct**
 *      model — `routing.is_none() && ensemble.is_none() && semantic.is_none()`.
 *      A target naming nothing dispatches nowhere; a target naming another
 *      virtual model would nest routing groups with no cycle guard to stop it.
 *   2. a combo lists each target once — the duplicate check is on the TRIMMED
 *      model name, so `"gpt-4o"` and `" gpt-4o "` are the same target.
 *
 * The server stays the authority: this is a pre-flight, not a replacement. A
 * snapshot can change between the form render and the write, so the outcome of
 * every call below reports what the gateway actually did.
 *
 * ## Refusals the UI MUST surface rather than swallow
 *
 * All in the admin `{"error_msg": …}` envelope:
 *   401/403 no admin key                 → nothing is readable or writable
 *   400     field outside the contract    → `"description" is not part of the combo contract…`
 *   400     unknown strategy              → `"priority" is not a routing strategy. Supported
 *                                          strategies: round_robin, …`
 *   400     target is not a direct model  → `… must be an existing direct model`
 *   400     duplicate target              → `… both name "x"; a combo lists each target once`
 *   404     no such combo (PATCH/DELETE)  → `resource not found`
 *   405     wrong verb                    → the route is PATCH; a PUT is not routed at all
 *   409     duplicate combo name          → `a model named "x" already exists`
 *   409     combo still referenced        → `combo "x" is still referenced by 1 (…)`
 *   500     resources file holds other rows → `… which a per-combo write cannot re-emit`
 *
 * `null` data is never a substitute for zero: a failed read yields `data: null`
 * plus the status, so a caller that forgets to check renders an explicit
 * "unknown" state rather than an empty table.
 *
 * ## Authentication
 *
 * The admin plane is key-gated. This client sends `credentials: "include"` on
 * every request so a same-origin cookie session authenticates it unchanged, and
 * attaches `Authorization: Bearer <adminKey>` when the caller supplies one —
 * which is what an ingress in front of `:3001` does, and what the integration
 * suite does to reach a real gateway. With neither, the gateway answers 401 and
 * `fetchCombos` reports that status rather than an empty list, so the page can
 * NAME the missing admin key instead of drawing an empty table.
 *
 * This module never throws.
 */

import {
  aisixAdminModelsUrl,
  aisixCombosUrl,
  fetchAisixJson,
  isAisixMissingEndpointStatus,
  type AisixJsonResult,
} from "./aisixEndpoints";
import { fetchWithTimeout } from "./fetchTimeout";

// ─── the accepted contract ───────────────────────────────────────────────

/**
 * The strategies this gateway build implements, in the handler's own order.
 *
 * The handler parses a request through the `RoutingStrategy` enum rather than
 * against a hand-kept list, so this array is the ENUM's surface transcribed:
 * a new strategy cannot be accepted while this list still claims six. Every
 * one of the template's 19 is spelled differently from all six — the template
 * says `round-robin` where the enum says `round_robin` — so there is no
 * partial spelling that would "just work".
 */
export const AISIX_COMBO_STRATEGY_VALUES = [
  "round_robin",
  "consistent_hash",
  "failover",
  "least_cost",
  "least_latency",
  "least_busy",
] as const;

export type AisixComboStrategy = (typeof AISIX_COMBO_STRATEGY_VALUES)[number];

/** The strategy the routing model uses when the field is absent. */
export const AISIX_COMBO_DEFAULT_STRATEGY: AisixComboStrategy = "failover";

/** The three top-level fields a combo document may carry (`COMBO_FIELDS`). */
export const AISIX_COMBO_FIELDS = ["name", "strategy", "models"] as const;

/** The four fields one `models` entry may carry (`COMBO_MODEL_FIELDS`). */
export const AISIX_COMBO_TARGET_FIELDS = ["model", "weight", "priority", "tags"] as const;

/**
 * Every etalon document field with no home in the routing model, named as the
 * handler names it. Present so the UI can say which control it removed and why,
 * and so a test can prove the list matches what the gateway actually refuses.
 *
 * `model_id` is in the TARGET list, not this one: it is the control plane's
 * reference style, and accepting it here would validate and then leave behind a
 * resources file no reload accepts.
 */
export const AISIX_COMBO_REFUSED_DOCUMENT_FIELDS = [
  "description",
  "displayName",
  "config",
  "allowedProviders",
  "allowedModelFamilies",
  "system_message",
  "tool_filter_regex",
  "context_cache_protection",
  "context_length",
  "dimensions",
  "isActive",
  "isHidden",
] as const;

export const AISIX_COMBO_REFUSED_TARGET_FIELDS = [
  "kind",
  "provider",
  "providerId",
  "connectionId",
  "allowedConnectionIds",
  "label",
  "prompt",
  "fallbackOnlyOnQuotaExhaustion",
  "model_id",
] as const;

/** `true` when the gateway's routing model implements this strategy. */
export function isAisixComboStrategy(value: unknown): value is AisixComboStrategy {
  return (
    typeof value === "string" && (AISIX_COMBO_STRATEGY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Which gateway strategy HONOURS each of the template's 19, keyed by the
 * template's own spelling.
 *
 * The two vocabularies do not overlap: the template says `round-robin` where the
 * routing model says `round_robin`, so there is no string that "just works" and
 * a submission must be translated rather than forwarded. These are not
 * synonyms — each entry is a deliberate operator-facing choice:
 *
 *   - `failover` is the routing model's own default, and `priority` is the same
 *     idea expressed as tiers — so `priority` maps onto it and the per-target
 *     `priority` field carries the tiers.
 *   - `round_robin` is `round-robin`; per-target `weight` shares carry the
 *     weighting, so `weighted` lands on it too.
 *   - `consistent_hash` is what pins a request to a target, which is what
 *     `context-relay`, `p2c` and `random` each use `random`/hashing for.
 *   - `least_cost` is `cost-optimized`; `least_busy` is `least-used`,
 *     `headroom` and `strict-random`.
 *   - `least_latency` is the one implemented strategy with no template twin; it
 *     is reachable through `fill-first`/`headroom`'s intent but is presented on
 *     its own in the picker below.
 *
 * The remaining 8 of the 19 (`reset-aware`, `reset-window`, `quota-weighted`,
 * `auto`, `lkgp`, `context-optimized`, `cache-optimized`, `fusion`, `pipeline`
 * — the last three of which are multi-model shapes a routing model cannot be)
 * have no honest mapping and are therefore refused by the form rather than
 * folded into a near-equivalent, which would be accepted-but-unread config.
 */
export const AISIX_ETALON_STRATEGY_HONOURS: Record<string, AisixComboStrategy> = {
  priority: "failover",
  "round-robin": "round_robin",
  weighted: "round_robin",
  "context-relay": "consistent_hash",
  p2c: "consistent_hash",
  random: "consistent_hash",
  "cost-optimized": "least_cost",
  "least-used": "least_busy",
  headroom: "least_busy",
  "strict-random": "least_busy",
  "fill-first": "failover",
};

/** The template strategy that best expresses each implemented strategy. */
const AISIX_STRATEGY_ETALON_SPELLING: Record<AisixComboStrategy, string> = {
  round_robin: "round-robin",
  consistent_hash: "context-relay",
  failover: "priority",
  least_cost: "cost-optimized",
  least_latency: "headroom",
  least_busy: "least-used",
};

/** `true` when a submitted strategy is one the gateway routes with. */
export function isAisixHonouredStrategy(etalon: string): boolean {
  return Object.prototype.hasOwnProperty.call(AISIX_ETALON_STRATEGY_HONOURS, etalon);
}

/**
 * Resolve a strategy name from EITHER vocabulary to the gateway's spelling.
 *
 * A value already in the gateway's vocabulary passes through, so a combo read
 * back from the API can be re-submitted without a double translation. Anything
 * else resolves through the honour map; an unmapped value yields `null`, which
 * the caller must refuse rather than substitute a near-equivalent.
 */
export function toAisixComboStrategy(value: unknown): AisixComboStrategy | null {
  if (isAisixComboStrategy(value)) return value;
  if (typeof value !== "string") return null;
  return AISIX_ETALON_STRATEGY_HONOURS[value] ?? null;
}

/** The template spelling of a gateway strategy, for rendering a stored combo. */
export function toEtalonStrategy(value: unknown): string | null {
  if (isAisixComboStrategy(value)) return AISIX_STRATEGY_ETALON_SPELLING[value];
  if (typeof value !== "string") return null;
  return Object.prototype.hasOwnProperty.call(AISIX_ETALON_STRATEGY_HONOURS, value) ? value : null;
}

// ─── wire shapes ─────────────────────────────────────────────────────────

/** One routing target, as the write path accepts and the read path emits. */
export interface AisixComboTarget {
  /** The model's DISPLAY NAME. Never an id — see the module doc. */
  model: string;
  /** A relative share, NOT a percentage. */
  weight?: number;
  /** A tier; a higher value is preferred. */
  priority?: number;
  /** Gates the target on the request's routing tags. */
  tags?: string[];
}

/**
 * The combo view `GET` returns — and, because the handler emits `models`
 * entries in the same shape the write path accepts, a `GET` response can be
 * `PATCH`ed back unchanged.
 */
export interface AisixCombo {
  id: string;
  name: string;
  strategy?: AisixComboStrategy;
  models: AisixComboTarget[];
}

/** `{id, revision, version, combo}` — what a create/update answers. */
export interface AisixComboWriteResult {
  id: string;
  revision: number;
  version: number;
  combo: AisixCombo;
}

/** What a draft looks like coming out of the template form. */
export interface ComboDraftInput {
  name?: string;
  strategy?: string;
  models?: unknown;
}

export interface AisixComboRequestOptions {
  /**
   * Admin key to authenticate with. Omitted in the dashboard (the page renders
   * the 401 refusal instead of guessing a credential) and supplied by an ingress
   * or by the integration suite.
   */
  adminKey?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ─── parsing ─────────────────────────────────────────────────────────────

function normalizeTarget(entry: unknown): AisixComboTarget | null {
  // A bare string is the shorthand for an unannotated entry.
  if (typeof entry === "string") {
    const model = entry.trim();
    return model ? { model } : null;
  }
  if (!isRecord(entry)) return null;
  const model = toTrimmedString(entry.model);
  // `model` is REQUIRED; an entry without one is not a target.
  if (!model) return null;
  const target: AisixComboTarget = { model };
  if (typeof entry.weight === "number" && Number.isFinite(entry.weight))
    target.weight = entry.weight;
  if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) {
    target.priority = entry.priority;
  }
  if (Array.isArray(entry.tags)) {
    const tags = entry.tags.filter(
      (tag): tag is string => typeof tag === "string" && tag.trim() !== ""
    );
    // The view omits an empty tag list rather than emitting `"tags": []`.
    if (tags.length > 0) target.tags = tags;
  }
  return target;
}

/** Coerce one wire combo; `null` when it carries no id, which the list then skips. */
export function normalizeCombo(entry: unknown): AisixCombo | null {
  if (!isRecord(entry)) return null;
  const id = toTrimmedString(entry.id);
  const name = toTrimmedString(entry.name);
  if (!id || !name) return null;
  const models = Array.isArray(entry.models)
    ? entry.models
        .map(normalizeTarget)
        .filter((target): target is AisixComboTarget => target !== null)
    : [];
  const combo: AisixCombo = { id, name, models };
  if (isAisixComboStrategy(entry.strategy)) combo.strategy = entry.strategy;
  return combo;
}

// ─── the direct-model catalog ────────────────────────────────────────────

/**
 * The display names a combo target is allowed to carry, read off
 * `GET /admin/v1/models`.
 *
 * This is the same predicate the handler applies (`routing.is_none() &&
 * ensemble.is_none() && semantic.is_none()`): a model that SELECTS among other
 * models is virtual, and a target naming one would nest routing groups with no
 * cycle guard to stop it. Computing it from the models collection rather than
 * hardcoding a list is what keeps the form and the handler agreeing as the
 * configuration changes.
 *
 * `null` for "the catalog has not loaded" — deliberately NOT an empty list, since
 * "no direct model exists" and "we have not asked yet" are opposite facts and
 * only the second one should let a draft through unchecked.
 */
export function parseDirectModelNames(payload: unknown): string[] | null {
  const rows: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (["models", "data", "items"] as const)
          .map((field) => payload[field])
          .find((candidate) => Array.isArray(candidate))
      : null;
  if (!Array.isArray(rows)) return null;
  const names: string[] = [];
  for (const row of rows) {
    // The admin envelope nests the document under `value`; a bare document is
    // accepted too so the parser survives an envelope change.
    const value = isRecord(row) && isRecord(row.value) ? row.value : row;
    if (!isRecord(value)) continue;
    if (
      value.routing !== undefined ||
      value.ensemble !== undefined ||
      value.semantic !== undefined
    ) {
      continue;
    }
    const name = toTrimmedString(value.display_name);
    if (name) names.push(name);
  }
  return names;
}

/** The direct-model catalog from the native models collection, or `null`. */
export async function fetchDirectModelNames(
  options: AisixComboRequestOptions = {}
): Promise<string[] | null> {
  const result: AisixJsonResult = await fetchAisixJson(aisixAdminModelsUrl(), {
    credentials: "include",
    ...authHeader(options),
  });
  // A failed read is `null`, never `[]`: the form must fall back to the server
  // rather than refuse every draft against a catalog it never received.
  if (!result.ok) return null;
  return parseDirectModelNames(result.data);
}

export function parseCombos(payload: unknown): AisixCombo[] {
  const raw: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (["combos", "data", "items"] as const)
          .map((field) => payload[field])
          .find((candidate) => Array.isArray(candidate))
      : [];
  if (!Array.isArray(raw)) return [];
  const out: AisixCombo[] = [];
  for (const entry of raw) {
    const normalized = normalizeCombo(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

// ─── read ────────────────────────────────────────────────────────────────

export interface CombosReadResult {
  combos: AisixCombo[];
  /** True only for the "endpoint is not on this build" answer. */
  missing: boolean;
  /** 401/403 means the core HAS the surface and wants an admin key. */
  status: number;
  /** HTTP status, or `0` when the request never produced a response. */
  error: string | null;
}

export async function fetchCombos(
  options: AisixComboRequestOptions = {}
): Promise<CombosReadResult> {
  const result: AisixJsonResult = await fetchAisixJson(aisixCombosUrl(), {
    credentials: "include",
    ...authHeader(options),
  });
  if (!result.ok) {
    return { combos: [], missing: result.missing, status: result.status, error: result.error };
  }
  return { combos: parseCombos(result.data), missing: false, status: 200, error: null };
}

// ─── client-side validation (mirrors the server, never replaces it) ──────

/** The rules `validateComboDraft` can report, in the handler's own order. */
export type ComboDraftIssueCode =
  | "name_required"
  | "strategy_unsupported"
  | "models_required"
  | "model_required"
  | "model_not_direct"
  | "model_duplicate";

export interface ComboDraftIssue {
  code: ComboDraftIssueCode;
  /** `models[i]` for a target issue; the top-level field otherwise. */
  field: string;
  /** The offending model name, for a target issue. */
  model?: string;
  /** For `model_not_direct`, the existing names the operator may pick instead. */
  directModelNames?: string[];
}

/**
 * The i18n key each rule reports under, so the mapping from "which rule broke"
 * to "which sentence" is DATA a test can pin rather than a `switch` buried in
 * a 5000-line page component. Exhaustive over `ComboDraftIssueCode` by type, and
 * the unit suite asserts it stays that way at runtime — a new code with no
 * sentence would otherwise render the bare code to an operator.
 */
export const COMBO_DRAFT_ISSUE_MESSAGE_KEYS: Record<ComboDraftIssueCode, string> = {
  name_required: "draftIssueNameRequired",
  strategy_unsupported: "draftIssueStrategyUnsupported",
  models_required: "draftIssueModelsRequired",
  model_required: "draftIssueModelRequired",
  model_not_direct: "draftIssueModelNotDirect",
  model_duplicate: "draftIssueModelDuplicate",
};

/** `{model}` — the only value a target issue interpolates. */
export function comboDraftIssueValues(issue: ComboDraftIssue): Record<string, string> {
  return issue.model ? { model: issue.model } : {};
}

export interface ValidateComboDraftOptions {
  /**
   * Display names of every model in the current configuration that is DIRECT —
   * the only names a target may carry. Omit when the catalog has not loaded; the
   * two catalog-dependent checks are then skipped and the server stays the
   * authority, rather than the form refusing on a catalog it never received.
   */
  directModelNames?: Iterable<string> | null;
}

function readTargetModel(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (isRecord(entry)) return toTrimmedString(entry.model);
  return null;
}

/**
 * Pre-flight a draft against the gateway's rules, in the order the handler
 * applies them. Returns `[]` when the draft is one the gateway would accept.
 *
 * An empty result is a claim about the RULES, never about the current snapshot:
 * a target can stop being direct between this call and the write, so the server
 * stays the authority and its refusal is what the page reports.
 */
export function validateComboDraft(
  draft: ComboDraftInput,
  options: ValidateComboDraftOptions = {}
): ComboDraftIssue[] {
  const issues: ComboDraftIssue[] = [];

  // 1. `name` — required, a string, non-empty once trimmed.
  if (!toTrimmedString(draft.name)) {
    issues.push({ code: "name_required", field: "name" });
  }

  // 2. `strategy` — optional; absent means the model's own default. Either
  //    vocabulary is accepted here and TRANSLATED on the way out; a template
  //    strategy with no honest mapping is refused, because substituting a
  //    near-equivalent would be accepted-but-unread config.
  if (draft.strategy !== undefined && toAisixComboStrategy(draft.strategy) === null) {
    issues.push({ code: "strategy_unsupported", field: "strategy" });
  }

  // 3. `models` — required, an array, at least one entry.
  const entries = Array.isArray(draft.models) ? draft.models : null;
  if (!entries || entries.length === 0) {
    issues.push({ code: "models_required", field: "models" });
    return issues;
  }

  // 4. per entry: `model` required, non-empty once trimmed.
  const identities: string[] = [];
  entries.forEach((entry, index) => {
    const model = readTargetModel(entry);
    if (!model) {
      issues.push({ code: "model_required", field: `models[${index}]` });
      identities.push("");
      return;
    }
    identities.push(model);
  });

  // 5. a combo lists each target once — on the TRIMMED name, so `"gpt-4o"` and
  //    `" gpt-4o "` are one target. Reported on the LATER index, which is the
  //    one the handler names.
  const firstSeen = new Map<string, number>();
  identities.forEach((model, index) => {
    if (!model) return;
    const previous = firstSeen.get(model);
    if (previous === undefined) {
      firstSeen.set(model, index);
      return;
    }
    issues.push({ code: "model_duplicate", field: `models[${index}]`, model });
  });

  // 6. every target must resolve to an existing DIRECT model.
  const catalog = options.directModelNames ? new Set(options.directModelNames) : null;
  if (catalog) {
    identities.forEach((model, index) => {
      if (model && !catalog.has(model)) {
        issues.push({
          code: "model_not_direct",
          field: `models[${index}]`,
          model,
          directModelNames: Array.from(catalog),
        });
      }
    });
  }

  return issues;
}

// ─── writes ──────────────────────────────────────────────────────────────

/**
 * Why a write failed, in the terms the UI has to render.
 *
 * `unsupported` is the one case that must never be retried or optimistically
 * papered over: the resources file already holds rows this per-combo endpoint
 * cannot re-emit, so the gateway applies the change in memory and then REFUSES
 * to persist it. Reporting that as success would leave the operator believing a
 * combo is stored when a reload will drop it.
 */
export type ComboWriteFailureKind =
  | "unauthorized"
  | "invalid"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "not_persisted"
  | "unsupported"
  | "failed";

export interface ComboWriteOutcome {
  ok: boolean;
  status: number;
  /** Present only on success — the caller renders the SERVER's combo, not a guess. */
  result: AisixComboWriteResult | null;
  failure: ComboWriteFailureKind | null;
  /** The gateway's own `error_msg`, verbatim and untranslated — it names the exact refusal. */
  reason: string | null;
}

const WRITE_TIMEOUT_MS = 15_000;

function classify(status: number): ComboWriteFailureKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400) return "invalid";
  if (status === 404) return "not_found";
  // The route is `PATCH /:id`. A `PUT` is not routed at all, so a 405 here means
  // "wrong verb", not "missing row" — a distinction worth keeping, because
  // reading it as a missing surface would disable a surface that is right there.
  if (status === 405) return "method_not_allowed";
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

function parseWriteResult(body: unknown): AisixComboWriteResult | null {
  if (!isRecord(body)) return null;
  const id = toTrimmedString(body.id);
  const combo = normalizeCombo(body.combo);
  // The envelope and the embedded view must agree on the id — a mismatch means
  // the response is not what this contract describes.
  if (!id || !combo || combo.id !== id) return null;
  return { id, revision: toCount(body.revision), version: toCount(body.version), combo };
}

/**
 * The DELETE envelope is NOT the write envelope: the handler answers
 * `{id, status: "deleted", version}` and carries no combo, because there is no
 * row left to describe. Parsing it with `parseWriteResult` would report a
 * successful delete as an unreadable success body.
 */
function parseDeleteResult(body: unknown): { id: string; version: number } | null {
  if (!isRecord(body)) return null;
  const id = toTrimmedString(body.id);
  if (!id || toTrimmedString(body.status) !== "deleted") return null;
  return { id, version: toCount(body.version) };
}

/**
 * `Authorization` when the caller supplied a key, nothing otherwise — so a
 * same-origin cookie session authenticates the request unchanged.
 */
function authHeader(options: AisixComboRequestOptions): Record<string, string> {
  const key = options.adminKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function sendWrite(
  url: string,
  method: string,
  body: unknown,
  options: AisixComboRequestOptions,
  parse: (payload: unknown) => AisixComboWriteResult | null = parseWriteResult
): Promise<ComboWriteOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method,
      headers: { "Content-Type": "application/json", ...authHeader(options) },
      body: JSON.stringify(body),
      // Cookie-ready: a same-origin admin session authenticates this unchanged.
      credentials: "include",
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
    // 2xx with a body we cannot read is NOT a success: reporting it as one is
    // how a write that never landed gets shown as landed.
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
    // route this build does not serve has no such envelope at all.
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
 * Exported and separately tested because the field set IS the contract: a field
 * the routing model has no home for is rejected by name with a 400, and an
 * empty string for an optional field is not the same as omitting it. `strategy`
 * is omitted when the caller has none, because the handler defaults it — sending
 * `""` would be a 400, not a default.
 */
export function buildComboDocument(input: ComboDraftInput): Record<string, unknown> {
  const document: Record<string, unknown> = { name: (input.name ?? "").trim() };
  // Translated, never forwarded: the template's `round-robin` is not a routing
  // strategy and the handler would refuse it by name.
  const strategy = toAisixComboStrategy(input.strategy);
  if (strategy) document.strategy = strategy;
  document.models = buildTargets(input.models);
  return document;
}

/** A PATCH body. Only the fields the operator actually changed. */
export function buildComboPatch(input: ComboDraftInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const name = toTrimmedString(input.name);
  if (name) patch.name = name;
  const strategy = toAisixComboStrategy(input.strategy);
  if (strategy) patch.strategy = strategy;
  if (Array.isArray(input.models) && input.models.length > 0)
    patch.models = buildTargets(input.models);
  return patch;
}

/**
 * Translate template steps into the only target shape the gateway accepts.
 *
 * Every field a step carries that the routing model has no home for —
 * `kind`, `provider`, `connectionId`, `label`, `prompt`, and the rest — is
 * DROPPED here rather than forwarded for the handler to refuse. That is the
 * whole point: the transport carries the contract, so the form can keep the
 * template's richer model and the wire still holds only what the gateway models.
 */
function buildTargets(models: unknown): AisixComboTarget[] {
  if (!Array.isArray(models)) return [];
  const targets: AisixComboTarget[] = [];
  for (const entry of models) {
    const model = readTargetModel(entry);
    if (!model) continue;
    const target: AisixComboTarget = { model };
    if (isRecord(entry)) {
      if (typeof entry.weight === "number" && Number.isFinite(entry.weight))
        target.weight = entry.weight;
      if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) {
        target.priority = entry.priority;
      }
      if (Array.isArray(entry.tags)) {
        const tags = entry.tags
          .filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
          .map((tag) => tag.trim());
        if (tags.length > 0) target.tags = tags;
      }
    }
    targets.push(target);
  }
  return targets;
}

/** `POST /admin/v1/combos` — 201 with the server's own combo. */
export function createCombo(
  input: ComboDraftInput,
  options: AisixComboRequestOptions = {}
): Promise<ComboWriteOutcome> {
  return sendWrite(aisixCombosUrl(), "POST", buildComboDocument(input), options);
}

/**
 * `PATCH /admin/v1/combos/:id` — the only update verb the route serves.
 *
 * A PATCH is a MERGE onto the stored model document, so it needs no full
 * document and every field the patch does not name survives it untouched.
 */
export function updateCombo(
  id: string,
  input: ComboDraftInput,
  options: AisixComboRequestOptions = {}
): Promise<ComboWriteOutcome> {
  return sendWrite(
    aisixCombosUrl(`/${encodeURIComponent(id)}`),
    "PATCH",
    buildComboPatch(input),
    options
  );
}

/**
 * `DELETE /admin/v1/combos/:id`.
 *
 * 409 is the interesting case and it is a FEATURE, not an error to hide: the
 * handler refuses while another combo, an ensemble panel or a semantic route
 * still names this one, because the reference would otherwise be left pointing
 * at a model that no longer exists. `reason` carries the dependent names.
 */
export function deleteCombo(
  id: string,
  options: AisixComboRequestOptions = {}
): Promise<ComboWriteOutcome> {
  return sendWrite(
    aisixCombosUrl(`/${encodeURIComponent(id)}`),
    "DELETE",
    {},
    options,
    (payload) => {
      const deleted = parseDeleteResult(payload);
      if (!deleted) return null;
      // There is no combo left to return, so the outcome reports the identity the
      // gateway echoed instead — which is what the caller removes from its list.
      return {
        id: deleted.id,
        revision: 0,
        version: deleted.version,
        combo: { id: deleted.id, name: "", models: [] },
      };
    }
  );
}
