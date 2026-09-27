/**
 * AISIX native transport bases — AGENT.md v2.0 §3.2.
 *
 * Dashboard data-layer helper: resolves the three native AISIX bases and maps
 * legacy Next.js `/api/*` paths to their native counterparts. Presentation
 * layers are untouched — only fetch URLs change. Transport stays
 * `fetchWithTimeout` (`src/shared/utils/fetchTimeout.ts`); this module builds
 * URL strings and owns the tolerant-read primitive (`fetchAisixJson`) that
 * turns a 404 into a final "this surface does not exist here" answer instead
 * of a silent empty table.
 *
 * THE COMPLETE NATIVE SURFACE (Rust core — nothing else answers):
 *   - ADMIN   `:3001` — `GET /admin/v1/models`, `GET /admin/v1/provider_keys`,
 *                          `POST /admin/v1/resources`, `GET /dashboard`
 *   - METRICS `:9090` — `GET /status/models`, `GET /metrics`
 *   - DATA    `:3000` — `POST /v1/chat/completions` (OpenAI-compatible)
 *
 * Consequences encoded below:
 *   - `POST /admin/v1/resources` is the ONLY resources verb, so there is no
 *     readable resources collection. An earlier revision mapped
 *     `/api/combos|/api/keys|/api/settings` onto
 *     `/admin/v1/resources/<sub>` — those subpaths DO NOT EXIST and were the
 *     single largest source of 404s in the SPA. They are no longer mapped.
 *     Callers of a nonexistent collection must render an explicit empty state
 *     (see `loadProviderPageData` in the providers dashboard).
 *   - Combos, keys, settings, telemetry-summaries, DB health and the
 *     `*_call-logs` surfaces are Next.js-only. Legacy URLs for them fall
 *     through unchanged so the call site keeps an honest "this data does not
 *     exist natively" signal instead of a misleading native URL. For those
 *     families `aisixUnsupportedRead` / `aisixUnsupportedWrite` return the
 *     operator-facing refusal the page must render.
 */

import { fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import {
  aisixAdminFetch,
  classifyAisixAdminStatus,
  isAisixAdminUrl,
  type AisixAdminFailureKind,
  type AisixAdminRequestOptions,
} from "./aisixAdminAuth";
import { getAisixAdminBase, getAisixDataBase, getAisixMetricsBase } from "./aisixTransportBase";

// The three native bases are resolved in `aisixTransportBase` and re-exported
// here, so the URL inventory below stays the single place a caller looks and
// the base resolution stays a leaf both `aisixEndpoints` and `aisixAdminAuth`
// can import without importing each other.
export { getAisixAdminBase, getAisixDataBase, getAisixMetricsBase };

/** `GET` models catalog — native replacement for `/api/provider-nodes`. */
export function aisixAdminModelsUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/models`;
}

/** Provider keys — native replacement for `/api/providers[?provider=]`. */
export function aisixProviderKeysUrl(query = ""): string {
  return `${getAisixAdminBase()}/admin/v1/provider_keys${query}`;
}

/**
 * Single provider-key item (native keys-write target for the API-manager
 * create/patch/delete forms). The collection URL above stays the read path;
 * this item URL is the `PATCH`/`DELETE` target.
 */
export function aisixProviderKeysItemUrl(id: string): string {
  return `${getAisixAdminBase()}/admin/v1/provider_keys/${encodeURIComponent(id)}`;
}

/** Preset-provider catalog — backing store for the providers-page preset grid. */
export function aisixPresetProvidersUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/preset_providers`;
}

/**
 * Native combos collection/item (`POST` create, `PUT`/`PATCH` update,
 * `DELETE` remove). The legacy `/api/combos*` paths intentionally stay
 * unmapped (pass-through): when this native base answers 2xx the combos page
 * uses it, otherwise the page shows an explicit "core without combos-write"
 * banner instead of firing requests into a 404.
 */
export function aisixCombosUrl(suffix = ""): string {
  return `${getAisixAdminBase()}/admin/v1/combos${suffix}`;
}

/**
 * `true` for the "endpoint does not exist on this core build" statuses.
 * Callers map these to an honest empty-state/refusal — never to a retry loop
 * or a silent fallback that would land on the same 404.
 */
export function isAisixMissingEndpointStatus(status: number): boolean {
  return status === 404 || status === 405;
}

/** Provider status snapshot — native replacement for `/api/monitoring/health`, `/api/providers/health*`. */
export function aisixStatusModelsUrl(query = ""): string {
  return `${getAisixMetricsBase()}/status/models${query}`;
}

/** Metrics snapshot — native replacement for paths ending with /metrics. */
export function aisixMetricsUrl(query = ""): string {
  return `${getAisixMetricsBase()}/metrics${query}`;
}

/** Absolute chat-completions URL on the data plane (`:3000`). */
export function aisixChatCompletionsUrl(): string {
  return `${getAisixDataBase()}/v1/chat/completions`;
}

/** Absolute data-plane URL for any `/v1/*` path. */
export function aisixDataPlaneUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${getAisixDataBase()}${normalized}`;
}

function splitQuery(url: string): { path: string; suffix: string } {
  const idx = url.indexOf("?");
  if (idx === -1) return { path: url, suffix: "" };
  return { path: url.slice(0, idx), suffix: url.slice(idx) };
}

/**
 * Maps a legacy dashboard `/api/*` (or `/v1/*`) URL to its native AISIX
 * counterpart, preserving trailing segments and query strings. Unknown paths
 * and absolute URLs pass through unchanged — that pass-through IS the signal
 * for "no native equivalent exists", so callers must handle it as an explicit
 * empty state rather than retrying with a guessed path. Method/body semantics
 * are the caller's — only the host/path prefix changes.
 */
export function resolveAisixRequestUrl(legacyUrl: string): string {
  if (/^https?:\/\//i.test(legacyUrl)) return legacyUrl;
  const { path, suffix } = splitQuery(legacyUrl);

  // Metrics first: `/api/combos/metrics` must hit `:9090/metrics`.
  if (path.endsWith("/metrics")) {
    if (path.startsWith("/api/")) return aisixMetricsUrl(suffix);
  }
  if (path === "/api/monitoring/health" || path.startsWith("/api/providers/health")) {
    return aisixStatusModelsUrl(suffix);
  }
  // Telemetry summary IS the metrics plane's JSON snapshot — same source the
  // health page parses for its verdict.
  if (path === "/api/telemetry/summary") {
    return aisixStatusModelsUrl(suffix);
  }
  if (path === "/api/providers" || path === "/api/providers/client") {
    return aisixProviderKeysUrl(suffix);
  }
  if (path === "/api/provider-nodes" || path === "/api/models") {
    return `${aisixAdminModelsUrl()}${suffix}`;
  }
  if (path === "/api/providers/expiration") {
    return aisixStatusModelsUrl(suffix);
  }
  if (path === "/api/providers/openrouter-stats") {
    return aisixMetricsUrl(suffix);
  }
  // Playground proxy shape: `/api` + `/v1/...` → data plane directly.
  if (path.startsWith("/api/v1/")) {
    return `${getAisixDataBase()}${path.slice("/api".length)}${suffix}`;
  }
  if (path === "/v1/models" || path.startsWith("/v1/")) {
    return `${getAisixDataBase()}${path}${suffix}`;
  }
  // No native equivalent (`/api/combos*`, `/api/keys*`, `/api/settings*`,
  // `/api/db/health`, `/api/usage/*`, `/api/rate-limits`, …) — pass through.
  return legacyUrl;
}

// ─── Honest refusal for surfaces the Rust core does not expose ───────────────

/**
 * Legacy `/api/*` families that have NO counterpart in the Rust core at all.
 * `resolveAisixRequestUrl` deliberately leaves them unmapped; these keys name
 * them so a page can refuse instead of firing requests into a 404.
 *
 *   - `radar`  — the free-model catalog overlay (SQLite feed cache + opt-in
 *                supporter keys). No AISIX feed, no AISIX settings.
 *   - `quota`  — quota pools / groups / plans / per-key model previews.
 *   - `usage`  — cost & usage analytics (per-provider/model/account/key
 *                breakdowns). `:9090` reports request/latency counters only,
 *                which is NOT the same data — see `adaptAisixTelemetry`.
 *   - `logs`   — call-log rows, log export, request-history purge.
 *   - `relay`  — relay proxy tokens.
 *   - `keys`   — OmniRoute's own inbound API keys. NOT the same thing as
 *                `:3001/admin/v1/provider_keys` (upstream provider
 *                credentials), so it must never be mapped onto them.
 *   - `providerRules` — the per-provider tuning rows on the provider detail
 *                page: param filters, web-search/fetch interception rules and
 *                the Claude Code discovery-alias gate. Each is a SQLite row
 *                behind a Next-only route, and the export ships no
 *                `src/app/api/**` at all (`getTransientBuildPaths`), so on a
 *                static host all three GETs are a guaranteed 404. They are
 *                permanent by architecture, not transient: a page that retries
 *                one is spinning on a certainty.
 */
export type AisixUnsupportedDomain =
  "radar" | "quota" | "usage" | "logs" | "relay" | "keys" | "providerRules";

/**
 * Result of asking "can this surface be reached through the AISIX gateway?".
 * `supported: false` carries the operator-facing `reason`; it is never a retry
 * hint — a retry would land on the same 404.
 */
export type AisixSurfaceSupport =
  { supported: true; reason?: undefined } | { supported: false; reason: string };

const AISIX_UNSUPPORTED_REASON: Record<AisixUnsupportedDomain, string> = {
  radar:
    "Radar (каталог бесплатных моделей, лента intel/offers, opt-in supporter-ключи) не входит в AISIX-шлюз: у него нет ни фида, ни настроек.",
  quota:
    "Quota-share (пулы, группы, планы, квоты по ключам) не входит в AISIX-шлюз: у Rust-ядра нет этой подсистемы.",
  usage:
    "Аналитика расходов и использования не входит в AISIX-шлюз: ядро отдаёт только счётчики запросов/латентности, без разбивки по провайдерам, моделям и ключам.",
  logs: "Журналы запросов и их экспорт/очистка не входят в AISIX-шлюз: у Rust-ядра нет call-log хранилища.",
  relay:
    "Relay-прокси (токены ретрансляции) не входит в AISIX-шлюз: у Rust-ядра нет этой подсистемы.",
  keys: "Ключи API OmniRoute (входящие) не входят в AISIX-шлюз: /admin/v1/provider_keys — это ключи вышестоящих провайдеров, а не потребительские ключи.",
  providerRules:
    "Правила провайдера (фильтры параметров, перехват web_search/web_fetch, алиасы Claude Code) хранятся в SQLite за Next.js-маршрутами, которых нет в статической сборке AISIX — читать и менять их здесь нельзя.",
};

/**
 * A read on `domain` has no native AISIX counterpart. Callers render an
 * explicit "unavailable in the AISIX gateway" empty state from `reason`
 * instead of an endless spinner or a silently empty table.
 */
export function aisixUnsupportedRead(domain: AisixUnsupportedDomain): AisixSurfaceSupport {
  return { supported: false, reason: AISIX_UNSUPPORTED_REASON[domain] };
}

/** A write on `domain` has no native AISIX counterpart — refuse it loudly. */
export function aisixUnsupportedWrite(domain: AisixUnsupportedDomain): AisixSurfaceSupport {
  return { supported: false, reason: AISIX_UNSUPPORTED_REASON[domain] };
}

/**
 * `true` when this bundle IS the AISIX static SPA (`OMNIROUTE_EXPORT=1` →
 * `next.config.mjs` inlines `NEXT_PUBLIC_AISIX_SPA_EXPORT=1`).
 *
 * The decisive signal for a Next-only surface: in that build the whole
 * Next.js API layer is absent, so probing it is pointless — every request is a
 * guaranteed 404 and every 404-driven state machine is a spinner. In a normal
 * Next build the same helper returns `false` and the legacy routes answer.
 */
export function isAisixSpaExport(): boolean {
  return process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT === "1";
}

/**
 * Build-aware answer for one dashboard surface, which is what a page should
 * actually branch on:
 *   - SPA export build → the refusal from `aisixUnsupportedRead`/
 *     `aisixUnsupportedWrite` (banner + disabled buttons, no request fired);
 *   - Next build        → `{ supported: true }` and the legacy route is used.
 */
export function resolveAisixSurfaceSupport(
  domain: AisixUnsupportedDomain,
  mode: "read" | "write"
): AisixSurfaceSupport {
  if (!isAisixSpaExport()) return { supported: true };
  return mode === "read" ? aisixUnsupportedRead(domain) : aisixUnsupportedWrite(domain);
}

/**
 * Tolerant JSON read against the native (or pass-through) URL.
 *
 * Every one of these dashboard reads used to be a bare `fetch()` whose
 * `!res.ok` was either ignored or funneled into a `.catch(() => {})`. In the
 * static SPA that produced silent 404s: empty tables, stuck spinners, no
 * signal at all. This helper is the opposite contract:
 *
 *   - `ok: true`  → 2xx with a JSON body.
 *   - `missing`   → 404/405: the endpoint does not exist on this core. Callers
 *                   MUST treat this as a final answer (render an empty state),
 *                   never as something to retry.
 *   - everything else (non-2xx, non-JSON body, network error, timeout) is
 *                   reported through `status`/`error` and yields `data: null`,
 *                   so a caller that forgets to check still renders an empty
 *                   state rather than a fabricated value.
 *
 * `null` data is never a substitute for zero: it means "not reported".
 */
export interface AisixJsonResult {
  data: unknown;
  ok: boolean;
  /** 404/405 — the endpoint is absent from this core build. */
  missing: boolean;
  /** HTTP status, or `0` when the request never produced a response. */
  status: number;
  error: string | null;
  /**
   * How a non-2xx answer is classified, or `null` for 2xx and for statuses that
   * are not a credential problem (5xx, network failure). The four kinds are
   * different operator situations — see `classifyAisixAdminStatus`. Present so
   * a caller can name the cause without re-deriving it from the status; the
   * status is still the authoritative field for the existing
   * `status === 401 || status === 403` checks.
   */
  failure: AisixAdminFailureKind | null;
  /**
   * The gateway's `{"error_msg": "…"}` envelope on a refusal, or `null`. Read
   * tolerantly: it is an extra detail beside the classification, never the
   * classification itself.
   */
  errorMsg: string | null;
}

const AISIX_JSON_READ_TIMEOUT_MS = 15_000;

/** The `{"error_msg": "…"}` envelope, or `null`. Never throws on an unreadable body. */
async function readAisixErrorMsg(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = (payload as Record<string, unknown>).error_msg;
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    // A refusal with no readable envelope is still a refusal.
  }
  return null;
}

export async function fetchAisixJson(
  url: string,
  init: AisixAdminRequestOptions = {},
  timeoutMs: number = AISIX_JSON_READ_TIMEOUT_MS
): Promise<AisixJsonResult> {
  try {
    // Through the shared admin transport when the URL is on the admin base, so
    // the cookie, the header policy and the 401 → signed-out signal are decided
    // in ONE place and every caller inherits all three. The `:9090`/`:3000`/Next
    // `/api/*` URLs keep the plain path: they are unauthenticated surfaces, and
    // their 401s have nothing to do with a gateway session.
    const onAdminPlane = isAisixAdminUrl(url);
    const response = onAdminPlane
      ? await aisixAdminFetch(url, { ...init, timeoutMs })
      : await fetchWithTimeout(url, {
          ...init,
          timeoutMs,
          fetchFn: globalThis.fetch as typeof fetch,
        });
    const status = response.status;
    if (isAisixMissingEndpointStatus(status)) {
      return {
        data: null,
        ok: false,
        missing: true,
        status,
        error: null,
        failure: classifyAisixAdminStatus(status),
        errorMsg: await readAisixErrorMsg(response),
      };
    }
    if (!response.ok) {
      return {
        data: null,
        ok: false,
        missing: false,
        status,
        error: `HTTP ${status}`,
        failure: classifyAisixAdminStatus(status),
        errorMsg: await readAisixErrorMsg(response),
      };
    }
    // `:9090/metrics` answers Prometheus text; a blind `.json()` on it rejects.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      return {
        data: null,
        ok: false,
        missing: false,
        status,
        error: "non_json_body",
        failure: null,
        errorMsg: null,
      };
    }
    const data = await response.json();
    return { data, ok: true, missing: false, status, error: null, failure: null, errorMsg: null };
  } catch (error) {
    return {
      data: null,
      ok: false,
      missing: false,
      status: 0,
      error: error instanceof Error ? error.message : "request_failed",
      failure: null,
      errorMsg: null,
    };
  }
}
