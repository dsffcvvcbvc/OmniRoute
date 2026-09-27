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

/**
 * Core liveness — native replacement for `/api/health/ping`.
 *
 * `/api/health/ping` answers "can this Next.js process reach its SQLite file"
 * (`SELECT 1`, see `src/lib/db/core.ts:1436`). On the AISIX gateway the process
 * is the Rust core and there is no SQLite to ping, so the honest equivalent is
 * the core's OWN probe. `livez` is unauthenticated (the admin listener is
 * private in production), which also means the maintenance banner can keep
 * working on a host where the operator has no admin key yet — the case the
 * banner most needs to report.
 */
export function aisixLivezUrl(): string {
  return `${getAisixAdminBase()}/livez`;
}

/** Readiness — the stricter sibling of `livez`, for callers that want dependencies up. */
export function aisixReadyzUrl(): string {
  return `${getAisixAdminBase()}/readyz`;
}

/**
 * Core health snapshot — native replacement for `/api/health/degradation`.
 *
 * Answers `{ status, models: [{ id, name, health }] }` where `status` is the
 * core's own verdict and `health` is a per-model counter. `adaptAisixCoreHealth`
 * in `aisixHealth.ts` turns that into the boolean the degradation badge wants.
 */
export function aisixCoreHealthUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/health`;
}

/**
 * OmniRoute's OWN inbound consumer API keys — native replacement for `/api/keys`.
 *
 * Deliberately NOT `aisixProviderKeysUrl`: `/admin/v1/provider_keys` holds
 * upstream provider credentials (what the core SENDS), while this holds the
 * consumer keys clients PRESENT. The two are different resources and the native
 * core keeps them at different paths for exactly that reason.
 *
 * LIMITATION, and the reason `resolveAisixRequestUrl` does not map `/api/keys`
 * onto it: the native document carries `key_hash`, never the plaintext. A caller
 * that needs a usable key (the playground's credential picker) cannot be served
 * from here, and handing it a hash would be worse than refusing — so `keys`
 * stays in `AisixUnsupportedDomain`. Read-only key INVENTORY callers may use this
 * URL and must render the hash as a hash.
 */
export function aisixApiKeysUrl(query = ""): string {
  return `${getAisixAdminBase()}/admin/v1/api_keys${query}`;
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
  // Liveness BEFORE the health rule below: `/api/health/ping` is a reachability
  // probe whose entire contract is "did the response answer 2xx", and
  // `/admin/v1/health` is a heavy authenticated snapshot — mapping the banner
  // onto it would turn "is the core up" into "is my key valid".
  if (path === "/api/health/ping") {
    return aisixLivezUrl();
  }
  if (path === "/api/health/degradation" || path.startsWith("/api/health/degradation?")) {
    return aisixCoreHealthUrl();
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
  // The native model catalog IS the provider↔model relation the three legacy
  // reads were projections of. The core ignores a `?provider=` filter (it
  // returns the whole catalog), so the query is preserved for a core that later
  // honours it and the per-provider split is done by the adapters in
  // `aisixNativeCatalog.ts` — never by guessing a narrower native path.
  //
  // `/api/v1/providers/{id}/models` is here, NOT below with the other
  // `/api/v1/*` calls: that rule sends the path to the OpenAI-compatible data
  // plane, and `/v1/providers/…` is not part of that surface — it would 404 on
  // every deployment. The catalog is the real source for it.
  if (
    path === "/api/models/catalog" ||
    path === "/api/provider-models" ||
    path === "/api/synced-available-models" ||
    path === "/api/models"
  ) {
    return `${aisixAdminModelsUrl()}${suffix}`;
  }
  if (path === "/api/v1/providers" || /^\/api\/v1\/providers\/[^/]+\/models$/.test(path)) {
    return `${aisixAdminModelsUrl()}${suffix}`;
  }
  // Native combos collection. The legacy `/api/combos*` item/write verbs
  // (`/reorder`, `/test`, `/builder/options`, `/{id}`) stay unmapped — the core
  // exposes `POST /admin/v1/resources` for writes, not per-combo verbs.
  if (path === "/api/combos") {
    return aisixCombosUrl(suffix);
  }
  // Playground proxy shape: `/api` + `/v1/...` → data plane directly.
  if (path.startsWith("/api/v1/")) {
    return `${getAisixDataBase()}${path.slice("/api".length)}${suffix}`;
  }
  if (path === "/v1/models" || path.startsWith("/v1/")) {
    return `${getAisixDataBase()}${path}${suffix}`;
  }
  // No native equivalent (`/api/keys*` — the core holds only the key HASH,
  // `/api/settings*`, `/api/db/health`, `/api/usage/*`, `/api/rate-limits`, …)
  // — pass through.
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
 *   - `keys`   — OmniRoute's own inbound API keys. The core DOES keep this
 *                resource (`GET /admin/v1/api_keys`, see `aisixApiKeysUrl`) but
 *                exposes only `key_hash`, never the plaintext a caller would
 *                have to present, so a read that needs a usable credential has
 *                no honest native source. `provider_keys` is a different
 *                resource entirely (upstream credentials) and must never stand
 *                in for it.
 *   - `settings`     — the app's own SQLite-backed configuration. `POST
 *                      /admin/v1/resources` is the core's only settings verb and
 *                      it is WRITE-only: there is no readable settings
 *                      collection, so `/api/settings` and every
 *                      `/api/settings/*` projection (proxy registry, proxy
 *                      assignments, compression) has nothing to read.
 *   - `storage`      — SQLite file health, size, vacuum. There is no SQLite.
 *   - `session`      — the Next.js CSRF token behind the dashboard's own
 *                      mutation guard. The core's session endpoint is
 *                      `POST /admin/v1/auth/session` and needs no CSRF token;
 *                      in the SPA export the whole Next mutation layer is
 *                      absent, so the interceptor must not be installed at all
 *                      (see `isDashboardCsrfInterceptorNeeded`).
 *   - `sync`         — remote settings sync (the operator's own settings pushed
 *                      to their own remote store). No AISIX counterpart.
 *   - `credentials`  — per-credential health probing and the environment-repair
 *                      wizard. The core reports per-MODEL status
 *                      (`/admin/v1/models/status`) and holds per-provider-key
 *                      documents, but never probes a credential's own health —
 *                      that is a Next.js scheduler (see
 *                      `src/lib/credentialHealth/scheduler.ts`).
 *   - `providerExtras` — the per-provider request-shaping rows: param filters,
 *                      web-search interception rules and the Claude Code
 *                      discovery-alias gate. Three SQLite tables with no
 *                      resource-type equivalent in the core's `resources` model.
 *   - `modelAliases` — the model→alias map. A Next.js join table.
 *   - `deprecated`   — which providers are flagged deprecated. Next.js-only
 *                      metadata with no core counterpart.
 */
export type AisixUnsupportedDomain =
  | "radar"
  | "quota"
  | "usage"
  | "logs"
  | "relay"
  | "keys"
  | "settings"
  | "storage"
  | "session"
  | "sync"
  | "credentials"
  | "providerExtras"
  | "modelAliases"
  | "deprecated";

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
  settings:
    "Настройки приложения не входят в AISIX-шлюз: у ядра есть только запись POST /admin/v1/resources, а читаемой коллекции настроек нет.",
  storage:
    "Состояние и обслуживание локальной базы данных (размер, vacuum) не входят в AISIX-шлюз: у Rust-ядра нет SQLite.",
  session:
    "CSRF-токен и сессионный слой Next.js не входят в AISIX-шлюз: ядро использует собственную сессию POST /admin/v1/auth/session и CSRF-токена не требует.",
  sync: "Синхронизация настроек с удалённым хранилищем не входит в AISIX-шлюз: у него нет этой подсистемы.",
  credentials:
    "Проверка здоровья учётных данных и мастер восстановления окружения не входят в AISIX-шлюз: ядро отдаёт статус моделей, но не проверяет каждый ключ.",
  providerExtras:
    "Фильтры параметров, правила перехвата веб-поиска и алиас Claude Code не входят в AISIX-шлюз: это отдельные подсистемы Next.js поверх его SQLite.",
  modelAliases: "Карта алиасов моделей не входит в AISIX-шлюз: у ядра нет этой таблицы.",
  deprecated:
    "Список устаревших провайдеров не входит в AISIX-шлюз: это метаданные Next.js без соответствия в ядре.",
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
 * `false` in the SPA export, `true` in a normal Next build.
 *
 * The dashboard CSRF interceptor monkey-patches `globalThis.fetch` to attach
 * `DASHBOARD_CSRF_HEADER` to every same-origin `/api/*` mutation, and it first
 * reads a token from `GET /api/auth/csrf`. In the export there is no Next.js
 * server behind that path, so:
 *
 *   - the token read is a guaranteed 404 on every load — the shell's `/dashboard`
 *     read count carries it today;
 *   - there is no Next.js dashboard left for the header to protect: the only
 *     same-origin mutations the SPA can make are the core's `/admin/v1/*`
 *     verbs, which authenticate by admin key / session cookie and carry no
 *     CSRF token of their own.
 *
 * So the interceptor is not "failing to find a token" in the export — it is
 * guarding a server that is not there. Not installing it removes the read, the
 * global fetch patch, and the `server/authz/csrf.ts` verify path it feeds, and
 * changes no behaviour a real Next deployment depends on.
 */
export function isDashboardCsrfInterceptorNeeded(): boolean {
  return !isAisixSpaExport();
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
