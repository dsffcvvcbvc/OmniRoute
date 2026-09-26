/**
 * AISIX native transport bases — AGENT.md v2.0 §3.2.
 *
 * Dashboard data-layer helper: resolves the three native AISIX bases from
 * `NEXT_PUBLIC_*` env with loopback fallbacks, and maps legacy Next.js
 * `/api/*` paths to their native counterparts. Presentation layers are
 * untouched — only fetch URLs change. Transport stays `fetchWithTimeout`
 * (`src/shared/utils/fetchTimeout.ts`); this module only builds URL strings.
 *
 * - ADMIN   (`NEXT_PUBLIC_AISIX_ADMIN`, default `http://127.0.0.1:3001`):
 *   models, provider keys, resources.
 * - METRICS (`NEXT_PUBLIC_AISIX_METRICS`, default `http://127.0.0.1:9090`):
 *   status/models, metrics.
 * - DATA    (`NEXT_PUBLIC_AISIX_DATA`, default `http://127.0.0.1:3000`):
 *   OpenAI-compatible data plane (`/v1/*`, incl. chat completions).
 */

const AISIX_ADMIN_FALLBACK = "http://127.0.0.1:3001";
const AISIX_METRICS_FALLBACK = "http://127.0.0.1:9090";
const AISIX_DATA_FALLBACK = "http://127.0.0.1:3000";

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

/** Native admin base (`:3001`): models, provider keys, resources. */
export function getAisixAdminBase(): string {
  return stripTrailingSlash(readPublicEnv("NEXT_PUBLIC_AISIX_ADMIN") ?? AISIX_ADMIN_FALLBACK);
}

/** Native metrics base (`:9090`): status/models, metrics. */
export function getAisixMetricsBase(): string {
  return stripTrailingSlash(readPublicEnv("NEXT_PUBLIC_AISIX_METRICS") ?? AISIX_METRICS_FALLBACK);
}

/** Native data-plane base (`:3000`): OpenAI-compatible `/v1/*`. */
export function getAisixDataBase(): string {
  return stripTrailingSlash(readPublicEnv("NEXT_PUBLIC_AISIX_DATA") ?? AISIX_DATA_FALLBACK);
}

/** `GET` models catalog — native replacement for `/api/provider-nodes`. */
export function aisixAdminModelsUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/models`;
}

/** Provider keys — native replacement for `/api/providers[?provider=]`. */
export function aisixProviderKeysUrl(query = ""): string {
  return `${getAisixAdminBase()}/admin/v1/provider_keys${query}`;
}

/** Resources collection — native replacement for `/api/combos*`, `/api/keys*`, `/api/settings*`. */
export function aisixResourcesUrl(subPath = ""): string {
  return `${getAisixAdminBase()}/admin/v1/resources${subPath}`;
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
 * and absolute URLs pass through unchanged. Method/body semantics are the
 * caller's — only the host/path prefix changes.
 */
export function resolveAisixRequestUrl(legacyUrl: string): string {
  if (/^https?:\/\//i.test(legacyUrl)) return legacyUrl;
  const { path, suffix } = splitQuery(legacyUrl);

  // Metrics first: `/api/combos/metrics` must hit `:9090/metrics`, not resources.
  if (path === "/api/combos/metrics" || path.endsWith("/metrics")) {
    if (path.startsWith("/api/")) return aisixMetricsUrl(suffix);
  }
  if (path === "/api/combos" || path.startsWith("/api/combos/")) {
    return aisixResourcesUrl(`/combos${path.slice("/api/combos".length)}${suffix}`);
  }
  if (path === "/api/keys" || path.startsWith("/api/keys/")) {
    return aisixResourcesUrl(`/keys${path.slice("/api/keys".length)}${suffix}`);
  }
  if (path === "/api/settings" || path.startsWith("/api/settings/")) {
    return aisixResourcesUrl(`/settings${path.slice("/api/settings".length)}${suffix}`);
  }
  if (path === "/api/monitoring/health" || path.startsWith("/api/providers/health")) {
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
  return legacyUrl;
}
