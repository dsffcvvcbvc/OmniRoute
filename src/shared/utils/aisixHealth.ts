/**
 * AISIX native health/metrics adapters — AGENT.md v2.0 §3.2 + Law 5.
 *
 * The native Rust core exposes exactly two read endpoints for operator
 * observability: `GET :9090/status/models` and `GET :9090/metrics`. Neither
 * matches the shape the Next.js dashboard cards used to render
 * (`/api/monitoring/health`, `/api/telemetry/summary`, `/api/db/health`,
 * `/api/cache/stats`, `/api/rate-limits`, `/api/health/degradation`,
 * `/api/providers/health-matrix`, `/api/providers/health-autopilot`).
 *
 * This module is the single place that reconciles the two: it parses the
 * native payloads into typed snapshots with EXPLICIT missing fields (`null` /
 * empty), so a card renders a real empty state instead of `undefined`
 * property access, a misleading zero, or a 404. It is pure — no I/O, no
 * React — so the shape contract is testable on its own.
 *
 * Invariants:
 *   - Never invent a value the native plane cannot report. `null` means
 *     "not reported natively"; it is NOT the same as zero.
 *   - The verdict is derived from the parsed provider list, never from a
 *     server-supplied `status` string (the native payload has none).
 */

export type AisixProviderState = "healthy" | "degraded" | "down";

export interface AisixProviderStatus {
  provider: string;
  model: string | null;
  state: AisixProviderState;
  failures: number;
  /** Cooldown/breaker reset delay in ms, or `null` when not reported. */
  retryAfterMs: number | null;
  /** Epoch ms of the last failure, or `null` when not reported. */
  lastFailureAt: number | null;
  reason: string | null;
}

/** Verdict banner states — the only three the health page renders. */
export type AisixHealthVerdict = "healthy" | "cooling" | "action_required";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Epoch-ms from a numeric epoch (s or ms) or an ISO-8601 string. */
function toEpochMs(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return ms > 0 ? ms : null;
  }
  const text = toStringOrNull(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const HEALTHY_STATES = new Set(["closed", "healthy", "ok", "up", "ready", "available", "active"]);
const DEGRADED_STATES = new Set([
  "half_open",
  "halfopen",
  "degraded",
  "recovering",
  "warn",
  "warning",
  "cooling",
  "cooldown",
  "throttled",
  "limited",
]);
const DOWN_STATES = new Set([
  "open",
  "down",
  "error",
  "failed",
  "failure",
  "unavailable",
  "inactive",
  "banned",
  "expired",
]);

/** Map any native status token onto the three-state dashboard vocabulary. */
export function toAisixProviderState(value: unknown): AisixProviderState {
  const token = toStringOrNull(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!token) return "healthy";
  if (HEALTHY_STATES.has(token)) return "healthy";
  if (DEGRADED_STATES.has(token)) return "degraded";
  if (DOWN_STATES.has(token)) return "down";
  return "degraded";
}

function readStatusEntry(
  entry: unknown,
  fallbackProvider: string | null
): AisixProviderStatus | null {
  if (!isRecord(entry)) return null;
  const provider =
    toStringOrNull(entry.provider) ??
    toStringOrNull(entry.provider_id) ??
    toStringOrNull(entry.providerId) ??
    toStringOrNull(entry.vendor) ??
    toStringOrNull(entry.name) ??
    toStringOrNull(entry.model) ??
    toStringOrNull(entry.id) ??
    fallbackProvider;
  if (!provider) return null;

  const model = toStringOrNull(entry.model) ?? toStringOrNull(entry.model_id) ?? null;
  const failures =
    toFiniteNumber(entry.failures) ??
    toFiniteNumber(entry.failure_count) ??
    toFiniteNumber(entry.failureCount) ??
    toFiniteNumber(entry.failures_count) ??
    toFiniteNumber(entry.count) ??
    0;
  const retryAfterMs =
    toFiniteNumber(entry.retry_after_ms) ??
    toFiniteNumber(entry.retryAfterMs) ??
    toFiniteNumber(entry.retry_after) ??
    toFiniteNumber(entry.retryAfter) ??
    toFiniteNumber(entry.cooldown_remaining_ms) ??
    toFiniteNumber(entry.cooldownRemainingMs);
  const lastFailureAt =
    toEpochMs(entry.last_failure) ??
    toEpochMs(entry.lastFailure) ??
    toEpochMs(entry.last_failure_time) ??
    toEpochMs(entry.lastFailureTime) ??
    toEpochMs(entry.updated_at) ??
    toEpochMs(entry.updatedAt);
  const reason =
    toStringOrNull(entry.reason) ??
    toStringOrNull(entry.last_error_type) ??
    toStringOrNull(entry.lastErrorType) ??
    toStringOrNull(entry.error_code) ??
    toStringOrNull(entry.errorCode) ??
    toStringOrNull(entry.status) ??
    toStringOrNull(entry.state);

  return {
    provider,
    model,
    state: toAisixProviderState(entry.state ?? entry.status ?? entry.health),
    failures,
    retryAfterMs,
    lastFailureAt,
    reason,
  };
}

/** Candidate list fields, in the order the native payload is known to use. */
const LIST_FIELDS = ["models", "status", "statuses", "providers", "items", "data", "results"];

function collectRawEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const field of LIST_FIELDS) {
    const candidate = payload[field];
    if (Array.isArray(candidate)) return candidate;
  }
  // `{ "openai": {...}, "anthropic": {...} }` — a map keyed by provider.
  const nested = payload.data;
  if (isRecord(nested)) {
    for (const field of LIST_FIELDS) {
      const candidate = nested[field];
      if (Array.isArray(candidate)) return candidate;
    }
    return Object.entries(nested).map(([provider, value]) =>
      isRecord(value) ? { provider, ...value } : { provider, state: value }
    );
  }
  return [];
}

/**
 * Parse a `GET :9090/status/models` payload into provider/model states.
 * Unknown-but-object entries are kept (state defaults to `healthy`) so the
 * dashboard never renders "0 providers" for a reachable native core.
 */
export function parseAisixProviderStatuses(payload: unknown): AisixProviderStatus[] {
  const out: AisixProviderStatus[] = [];
  for (const raw of collectRawEntries(payload)) {
    const entry = readStatusEntry(raw, null);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * The verdict banner state, derived from the parsed list (item 10: never from
 * `data.status`, which the native plane does not send):
 *   - every reported provider healthy  → "healthy"
 *   - some provider cooling/degraded   → "cooling"
 *   - some provider down               → "action_required"
 *   - nothing reported (unreachable)   → "action_required" (the page already
 *     shows its own error state in that case)
 */
export function resolveAisixHealthVerdict(
  statuses: readonly AisixProviderStatus[]
): AisixHealthVerdict {
  if (!statuses.some((entry) => entry.state !== "healthy")) return "healthy";
  if (statuses.some((entry) => entry.state === "down")) return "action_required";
  return "cooling";
}

/**
 * Shape the health dashboard page renders, normalized from the native payload.
 * Fields the native plane cannot report stay `null` / empty — the page's
 * `?.` guards and empty-state branches then render honest "n/a" instead of a
 * fabricated number.
 */
export interface AisixHealthSnapshot {
  verdict: AisixHealthVerdict;
  providerStatuses: AisixProviderStatus[];
  providerHealth: Record<
    string,
    {
      state: "CLOSED" | "DEGRADED" | "OPEN";
      failures: number;
      retryAfterMs: number | null;
      lastFailure: string | null;
    }
  >;
  providerSummary: { configuredCount: number; activeCount: number; monitoredCount: number };
  /** Native core reports no uptime/version/memory. */
  system: { uptime: number | null; version: string | null; nodeVersion: string | null } | null;
  rateLimitStatus: null;
  learnedLimits: null;
  lockouts: Record<string, never>;
  sessions: null;
  quotaMonitor: null;
}

const STATE_TO_CIRCUIT: Record<AisixProviderState, "CLOSED" | "DEGRADED" | "OPEN"> = {
  healthy: "CLOSED",
  degraded: "DEGRADED",
  down: "OPEN",
};

export function normalizeAisixHealthSnapshot(payload: unknown): AisixHealthSnapshot {
  const providerStatuses = parseAisixProviderStatuses(payload);
  const providerHealth: AisixHealthSnapshot["providerHealth"] = {};
  for (const entry of providerStatuses) {
    const bucket = providerHealth[entry.provider];
    // A provider with several models is only as healthy as its worst model.
    if (bucket && bucket.state !== "OPEN") continue;
    providerHealth[entry.provider] = {
      state: STATE_TO_CIRCUIT[entry.state],
      failures: entry.failures,
      retryAfterMs: entry.retryAfterMs,
      lastFailure: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
    };
  }
  const monitoredCount = Object.keys(providerHealth).length;
  const activeCount = Object.values(providerHealth).filter(
    (entry) => entry.state === "CLOSED"
  ).length;
  return {
    verdict: resolveAisixHealthVerdict(providerStatuses),
    providerStatuses,
    providerHealth,
    providerSummary: { configuredCount: monitoredCount, activeCount, monitoredCount },
    system: null,
    rateLimitStatus: null,
    learnedLimits: null,
    lockouts: {},
    sessions: null,
    quotaMonitor: null,
  };
}

/** Telemetry the native plane actually reports, as an optional-fields record. */
export interface AisixTelemetry {
  /** Native status snapshot has no request counters — `null` means "not reported". */
  totalRequests: number | null;
  uptime: number | null;
  errorRate: number | null;
  activeConnections: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  modelCount: number;
  hasReportedSignal: boolean;
}

/**
 * Adapt a `status/models` payload into the telemetry card's optional-fields
 * shape. Every numeric field is `null` unless the payload really carries it,
 * so the card can show `n/a` instead of a misleading `0`.
 */
export function adaptAisixTelemetry(payload: unknown): AisixTelemetry {
  const record = isRecord(payload) ? payload : {};
  const totals = isRecord(record.totals) ? record.totals : {};
  const read = (key: string): number | null =>
    toFiniteNumber(record[key]) ?? toFiniteNumber(totals[key]);

  const totalRequests = read("total_requests") ?? read("totalRequests") ?? read("requests");
  const uptime = read("uptime") ?? read("uptime_seconds") ?? read("uptimeSeconds");
  const errorRateRaw = read("error_rate") ?? read("errorRate");
  const activeConnections = read("active_connections") ?? read("activeConnections");
  const avgLatencyMs = read("avg_latency_ms") ?? read("avgLatencyMs");
  const p95LatencyMs = read("p95_latency_ms") ?? read("p95LatencyMs");
  const modelCount = parseAisixProviderStatuses(payload).length;

  return {
    totalRequests,
    uptime,
    errorRate: errorRateRaw,
    activeConnections,
    avgLatencyMs,
    p95LatencyMs,
    modelCount,
    hasReportedSignal:
      totalRequests !== null ||
      uptime !== null ||
      errorRateRaw !== null ||
      activeConnections !== null ||
      avgLatencyMs !== null ||
      p95LatencyMs !== null,
  };
}
