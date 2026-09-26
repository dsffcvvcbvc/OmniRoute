/**
 * AISIX native transport bases — AGENT.md v2.0 §3.2.
 *
 * Dashboard data-layer helper: resolves the three native AISIX bases and maps
 * legacy Next.js `/api/*` paths to their native counterparts. Presentation
 * layers are untouched — only fetch URLs change. Transport stays
 * `fetchWithTimeout` (`src/shared/utils/fetchTimeout.ts`); this module only
 * builds URL strings.
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
 *     exist natively" signal instead of a misleading native URL.
 */

/** Native ports, kept in one place so the runtime-host derivation stays honest. */
const AISIX_ADMIN_PORT = 3001;
const AISIX_METRICS_PORT = 9090;
const AISIX_DATA_PORT = 3000;

const AISIX_ADMIN_FALLBACK = `http://127.0.0.1:${AISIX_ADMIN_PORT}`;
const AISIX_METRICS_FALLBACK = `http://127.0.0.1:${AISIX_METRICS_PORT}`;
const AISIX_DATA_FALLBACK = `http://127.0.0.1:${AISIX_DATA_PORT}`;

/**
 * Hosts for which `127.0.0.1` in the browser IS the AISIX host. Only these may
 * use the loopback fallbacks / explicit `NEXT_PUBLIC_AISIX_*` defaults; see
 * `resolveAisixBase`.
 */
const LOOPBACK_HOSTNAMES = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function readPublicEnv(name: string): string | undefined {
  try {
    const value = (process.env as Record<string, string | undefined>)[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(base: string): string {
  return base.length > 1 ? base.replace(/\/+$/, "") : base;
}

/**
 * Hostname the SPA itself was served from, or `null` during SSR/prerender (no
 * `window`). A static export is served BY the AISIX binary, so this is the
 * authoritative answer to "where does AISIX live for THIS browser?" — and on a
 * LAN/tailscale host `127.0.0.1` would point at the operator's own machine.
 */
function readWindowHostname(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const hostname = window.location?.hostname;
    return typeof hostname === "string" && hostname.trim().length > 0 ? hostname.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolution order for a native base:
 *   1. non-loopback `window.location.hostname` → `http://<host>:<port>`.
 *      The SPA was served by AISIX, so its own host is the native host. This
 *      wins over the env vars on purpose: an env var baked at build time cannot
 *      know the deployment hostname of a static bundle.
 *   2. `NEXT_PUBLIC_AISIX_*` override.
 *   3. `http://127.0.0.1:<port>` (loopback browser, or SSR/prerender).
 *
 * Scheme is always `http`: the Rust core serves its three planes as plain HTTP,
 * and the dashboard is served by the same process on the same host.
 */
function resolveAisixBase(envName: string, port: number, loopbackFallback: string): string {
  const hostname = readWindowHostname();
  if (hostname && !LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) {
    return `http://${hostname}:${port}`;
  }
  return stripTrailingSlash(readPublicEnv(envName) ?? loopbackFallback);
}

/** Native admin base (`:3001`): models, provider keys, resources writes. */
export function getAisixAdminBase(): string {
  return resolveAisixBase("NEXT_PUBLIC_AISIX_ADMIN", AISIX_ADMIN_PORT, AISIX_ADMIN_FALLBACK);
}

/** Native metrics base (`:9090`): status/models, metrics. */
export function getAisixMetricsBase(): string {
  return resolveAisixBase("NEXT_PUBLIC_AISIX_METRICS", AISIX_METRICS_PORT, AISIX_METRICS_FALLBACK);
}

/** Native data-plane base (`:3000`): OpenAI-compatible `/v1/*`. */
export function getAisixDataBase(): string {
  return resolveAisixBase("NEXT_PUBLIC_AISIX_DATA", AISIX_DATA_PORT, AISIX_DATA_FALLBACK);
}

/** `GET` models catalog — native replacement for `/api/provider-nodes`. */
export function aisixAdminModelsUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/models`;
}

/** Provider keys — native replacement for `/api/providers[?provider=]`. */
export function aisixProviderKeysUrl(query = ""): string {
  return `${getAisixAdminBase()}/admin/v1/provider_keys${query}`;
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
