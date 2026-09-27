/**
 * AISIX native transport bases — AGENT.md v2.0 §3.2.
 *
 * Resolution of the three native bases (`:3001` admin, `:9090` metrics, `:3000`
 * data) and nothing else: no endpoint inventory, no fetch, no auth. It is its
 * own module because two modules need it and one of them imports the other —
 * `aisixEndpoints` (which owns the URL inventory) has to reach the admin
 * transport in `aisixAdminAuth`, and `aisixAdminAuth` needs this base to build
 * the session URL. Folding this in would have made those two import each other.
 */

export const AISIX_ADMIN_PORT = 3001;
export const AISIX_METRICS_PORT = 9090;
export const AISIX_DATA_PORT = 3000;

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
 * Scheme the SPA itself was served with, or `null` during SSR/prerender (no
 * `window`). An `https:` page fetching an `http:` core is blocked by the
 * browser as mixed content, so LAN bases inherit the page scheme instead of
 * hardcoding `http:` — the loopback/SSR fallbacks below stay plain HTTP
 * (loopback is trustworthy and never mixed-content-blocked).
 */
function readWindowProtocol(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const protocol = window.location?.protocol;
    return protocol === "https:" || protocol === "http:" ? protocol : null;
  } catch {
    return null;
  }
}

/**
 * Resolution order for a native base:
 *   1. non-loopback `window.location.hostname` → `<page-scheme>://<host>:<port>`.
 *      The SPA was served by AISIX, so its own host is the native host. This
 *      wins over the env vars on purpose: an env var baked at build time cannot
 *      know the deployment hostname of a static bundle. The scheme is inherited
 *      from the page so an `https:` dashboard does not get mixed-content-blocked
 *      against its own core.
 *   2. `NEXT_PUBLIC_AISIX_*` override.
 *   3. `http://127.0.0.1:<port>` (loopback browser, or SSR/prerender).
 *
 * The Rust core serves its three planes as plain HTTP; only the scheme of a
 * same-host base follows the page — explicit env overrides are used verbatim.
 */
function resolveAisixBase(envName: string, port: number, loopbackFallback: string): string {
  const hostname = readWindowHostname();
  if (hostname && !LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) {
    const scheme = readWindowProtocol() ?? "http:";
    return `${scheme}//${hostname}:${port}`;
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
