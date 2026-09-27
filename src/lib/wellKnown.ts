import type { NextRequest } from "next/server";

/**
 * Derive the base URL for A2A agent card endpoints.
 * Prefers OMNIROUTE_BASE_URL env var for admin override; falls back to the
 * request's dynamic origin so the gateway works behind any hostname without
 * hardcoded localhost:20128 (S2 security fix).
 *
 * AGENT.md §3.3 — static SPA export (`output: "export"`, OMNIROUTE_EXPORT=1).
 * Next pins a route handler's dynamic mode to `error` under `output: "export"`
 * and hands the handler a request proxy that THROWS on `nextUrl.origin`
 * (Next E575), so the read below would abort the prerender of
 * `/.well-known/agent.json` and `/.well-known/agent-card.json`.
 *
 * The read is also meaningless there: a static bundle is built once and served
 * from whatever hostname the operator points the AISIX core at, so it has no
 * per-request origin to read. The export build therefore resolves the same
 * build-time base URL the direct-invocation path already used. An operator who
 * wants the card to advertise a real origin sets OMNIROUTE_BASE_URL at build
 * time; the live server keeps deriving it per request, unchanged.
 */
export function getBaseUrl(request?: NextRequest | null): string {
  if (process.env.OMNIROUTE_BASE_URL) return process.env.OMNIROUTE_BASE_URL;
  const defaultPort = process.env.PORT || process.env.DASHBOARD_PORT || 20128;
  if (process.env.OMNIROUTE_EXPORT === "1") return `http://localhost:${defaultPort}`;
  // Direct route-handler invocation (unit tests, programmatic calls) passes no
  // Request — fall back to the default local gateway origin instead of crashing.
  return request?.nextUrl?.origin ?? `http://localhost:${defaultPort}`;
}
