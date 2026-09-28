"use client";

/**
 * useConnectionProxies — extracted from useProviderConnections so that file can
 * sit under the 1200-line file-size cap.
 *
 * Owns every PROXY concern of the connections surface, and nothing else:
 *  - `proxyConfig` (provider-level) and `connProxyMap` (per-connection badges),
 *    both derived from ONE `GET /api/settings/proxy` read
 *  - the mount-time read of that one collection, plus `fetchProxyConfig` /
 *    `refreshProxyState`
 *  - the `proxyEnabled` / `perKeyProxyEnabled` per-connection PUTs
 *  - `handleDistributeProxies` (the "distribute saved proxies" toolbar action)
 *
 * What stays in useProviderConnections is deliberately NOT here: the UPSTREAM
 * routing mode (native / CLIProxyAPI / Dario / fallback) is a provider-level
 * routing decision read from `/api/upstream-proxy/[providerId]`, not a
 * per-connection proxy assignment, and it has its own card.
 *
 * Cycle-safe: imports only from leaf modules. No import from
 * ProviderDetailPageClient or useProviderConnections.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAisixRequestUrl, resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";
import { readNativeList } from "../../providerPageUtils";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";
import type { ConnectionRowConnection } from "../components/ConnectionRow";

/** Minimal surface of the notification store this hook needs. */
interface ProxyNotifier {
  error: (message: string) => void;
  warning: (message: string) => void;
  success: (message: string) => void;
}

export type ConnectionProxyAssignment = { proxy: any; level: string } | null;

export interface UseConnectionProxiesParams {
  /** Re-reads the provider-level config when the page switches provider. */
  providerId: string;
  connections: ConnectionRowConnection[];
  setConnections: (
    updater:
      ConnectionRowConnection[] | ((prev: ConnectionRowConnection[]) => ConnectionRowConnection[])
  ) => void;
  loading: boolean;
  fetchConnections: () => Promise<void>;
  notify: ProxyNotifier;
  t: ProviderMessageTranslator;
}

export interface UseConnectionProxiesReturn {
  proxyConfig: any;
  connProxyMap: Record<string, ConnectionProxyAssignment>;
  distributingProxies: boolean;
  fetchProxyConfig: () => Promise<void>;
  refreshProxyState: () => Promise<void>;
  handleToggleProxyEnabled: (connectionId: string, proxyEnabled: boolean) => Promise<void>;
  handleTogglePerKeyProxyEnabled: (
    connectionId: string,
    perKeyProxyEnabled: boolean
  ) => Promise<void>;
  handleDistributeProxies: (tagFilter?: string) => Promise<void>;
}

async function loadProxyConfigData(): Promise<{ config: any } | null> {
  try {
    // Declared unsupported: the proxy registry is part of the app's SQLite
    // settings, which the gateway cannot read. The read is skipped rather than
    // 404ing; the proxy fields then stay at their documented defaults, which is
    // the same state a failed read produced and is not a claim that a proxy is
    // configured.
    if (!resolveAisixSurfaceSupport("settings", "read").supported) {
      return;
    }
    const res = await fetch(resolveAisixRequestUrl("/api/settings/proxy"), { cache: "no-store" });
    if (res.ok) return { config: await res.json() };
    return { config: null };
  } catch {
    // Proxy indicators are best-effort — keep whatever is currently shown.
    return null;
  }
}

/**
 * Build the per-connection proxy badge map from ONE `/api/settings/proxy`
 * read.
 *
 * Why: the old implementation issued one `?resolve=<connectionId>` request per
 * connection. On the native transport that path resolves to a resources
 * sub-path that does not exist (and on the Next build it is an N+1 request
 * storm), so every badge silently fell back to "no proxy" through a swallowed
 * `.catch`. The collection response already carries the assignments; resolve
 * them client-side.
 */
function resolveConnectionProxies(
  conns: { id?: string }[],
  config: unknown
): Record<string, ConnectionProxyAssignment> | null {
  const assignments = readNativeList(config, ["assignments", "proxies", "items", "data"]);
  const byScopeId = new Map<string, { proxy: any; level: string }>();
  for (const assignment of assignments) {
    const scopeId = typeof assignment?.scopeId === "string" ? assignment.scopeId : null;
    if (!scopeId || !assignment?.proxy) continue;
    byScopeId.set(scopeId, {
      proxy: assignment.proxy,
      level: typeof assignment.level === "string" ? assignment.level : "account",
    });
  }
  const map: Record<string, ConnectionProxyAssignment> = {};
  for (const conn of conns) {
    if (!conn.id) continue;
    map[conn.id] = byScopeId.get(conn.id) ?? null;
  }
  return map;
}

export function useConnectionProxies({
  providerId,
  connections,
  setConnections,
  loading,
  fetchConnections,
  notify,
  t,
}: UseConnectionProxiesParams): UseConnectionProxiesReturn {
  // ── proxy state ─────────────────────────────────────────────────────────
  const [distributingProxies, setDistributingProxies] = useState(false);
  const [proxyConfig, setProxyConfig] = useState<any>(null);
  const [connProxyMap, setConnProxyMap] = useState<Record<string, ConnectionProxyAssignment>>({});

  // Latest connections, readable from a stable callback without making that
  // callback (and every consumer prop depending on it) change every fetch.
  const connectionsRef = useRef<ConnectionRowConnection[]>(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  const fetchProxyConfig = useCallback(async () => {
    const result = await loadProxyConfigData();
    if (result) setProxyConfig(result.config);
  }, []);

  /**
   * Refresh every proxy view the page renders after a proxy assignment is
   * written elsewhere (ProxyConfigModal saves/clears through
   * `/api/settings/proxies/assignments`).
   *
   * Two independent sources back those views and BOTH must be re-read:
   *  - `proxyConfig`   ← GET /api/settings/proxy  (provider-level chip AND the
   *    per-connection badge assignments, resolved client-side from that single
   *    response)
   *  - `connProxyMap`  ← derived from the same payload
   *
   * The `connProxyMap` effect below is keyed on [loading, connections], and a
   * proxy save changes neither, so without this callback the account-row
   * badges keep showing pre-save state until a manual reload.
   */
  const refreshProxyState = useCallback(async () => {
    const [configResult] = await Promise.all([loadProxyConfigData()]);
    if (!configResult) return;
    setProxyConfig(configResult.config);
    const map = resolveConnectionProxies(connectionsRef.current, configResult.config);
    if (map) setConnProxyMap(map);
  }, []);
  // The provider-level chip, read once per provider. This used to ride along in
  // useProviderConnections' mount effect; it is keyed on `providerId` alone
  // because that is the only one of that effect's inputs that can change
  // without the provider changing (`isCompatible` is derived from it).
  //
  // The read is written out inside the effect, not delegated to
  // `fetchProxyConfig()`, for the same reason the sibling effect below is:
  // a callback that synchronously sets state trips `react-hooks/set-state-in-effect`,
  // because from the compiler's point of view the effect body calls a function
  // that sets state before its first await.
  useEffect(() => {
    const run = async () => {
      const result = await loadProxyConfigData();
      if (result) setProxyConfig(result.config);
    };
    void run();
  }, [providerId]);

  // Per-connection proxy badges, derived from the same /api/settings/proxy read.
  useEffect(() => {
    if (loading || connections.length === 0) return;
    const run = async () => {
      const result = await loadProxyConfigData();
      if (!result) return;
      const map = resolveConnectionProxies(connections, result.config);
      if (map) setConnProxyMap(map);
    };
    void run();
  }, [loading, connections]);

  const handleToggleProxyEnabled = async (connectionId: string, proxyEnabled: boolean) => {
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyEnabled }),
      });
      if (res.ok) {
        setConnections((prev: any[]) =>
          prev.map((c) => (c.id === connectionId ? { ...c, proxyEnabled } : c))
        );
      } else {
        const data = await res.json().catch(() => ({}));
        notify.error(
          (typeof data?.error === "string" && data.error) ||
            data?.error?.message ||
            providerText(t, "failedToggleProxy", "Failed to toggle proxy for this connection")
        );
      }
    } catch (error) {
      console.error("Error toggling proxy enabled:", error);
      notify.error(
        providerText(t, "failedToggleProxy", "Failed to toggle proxy for this connection")
      );
    }
  };

  const handleTogglePerKeyProxyEnabled = async (
    connectionId: string,
    perKeyProxyEnabled: boolean
  ) => {
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ perKeyProxyEnabled }),
      });
      if (res.ok) {
        setConnections((prev: any[]) =>
          prev.map((c) => (c.id === connectionId ? { ...c, perKeyProxyEnabled } : c))
        );
      } else {
        const data = await res.json().catch(() => ({}));
        notify.error(
          (typeof data?.error === "string" && data.error) ||
            data?.error?.message ||
            providerText(t, "failedToggleProxy", "Failed to toggle proxy for this connection")
        );
      }
    } catch (error) {
      console.error("Error toggling per-key proxy enabled:", error);
      notify.error(
        providerText(t, "failedToggleProxy", "Failed to toggle proxy for this connection")
      );
    }
  };

  const handleDistributeProxies = async (tagFilter?: string) => {
    const targetConnections = tagFilter
      ? (connections as any[]).filter(
          (c: any) => (c.providerSpecificData?.tag as string | undefined)?.trim() === tagFilter
        )
      : connections;
    if ((targetConnections as any[]).length === 0) return;
    setDistributingProxies(true);
    try {
      const proxiesRes = await fetch(resolveAisixRequestUrl("/api/settings/proxies"));
      if (!proxiesRes.ok) throw new Error("Failed to fetch proxies");
      const proxiesData = await proxiesRes.json();
      const savedProxies = (proxiesData?.items || []).filter((p: any) => p.status === "active");
      if (savedProxies.length === 0) {
        notify.error(
          providerText(
            t,
            "noSavedProxies",
            "No saved proxies found. Add proxies in Settings → Proxy first."
          )
        );
        return;
      }

      let assigned = 0;
      let failed = 0;
      const sorted = [...(targetConnections as any[])].sort(
        (a: any, b: any) => (a.priority || 0) - (b.priority || 0)
      );

      for (let i = 0; i < sorted.length; i++) {
        const conn = sorted[i] as any;
        const proxy = savedProxies[i % savedProxies.length];

        try {
          await fetch(resolveAisixRequestUrl("/api/settings/proxies/assignments"), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope: "account", scopeId: conn.id, proxyId: null }),
          });
        } catch {
          /* clear old assignment */
        }

        const patchRes = await fetch(`/api/providers/${conn.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxyEnabled: true, perKeyProxyEnabled: true }),
        });

        if (!patchRes.ok) {
          console.error(`Failed to update connection ${conn.id}`);
          failed++;
          continue;
        }

        const assignRes = await fetch(resolveAisixRequestUrl("/api/settings/proxies/assignments"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "account", scopeId: conn.id, proxyId: proxy.id }),
        });

        if (!assignRes.ok) {
          console.error(`Failed to assign proxy to ${conn.id}`);
          failed++;
          continue;
        }

        assigned++;
      }

      await fetchConnections();
      if (failed > 0 && assigned === 0) {
        notify.error(providerText(t, "failedDistributeProxies", "Failed to distribute proxies."));
        return;
      }
      const tagLabel = tagFilter ? `"${tagFilter}" ` : "";
      notify.success(
        providerText(
          t,
          "proxiesDistributed",
          "Distributed {assigned} proxy assignment(s) across {tagLabel}{total} connection(s).",
          { assigned, tagLabel, total: sorted.length }
        )
      );
      if (failed > 0) {
        notify.warning(
          providerText(
            t,
            "proxiesDistributedPartial",
            "{failed} connection(s) could not be updated.",
            { failed }
          )
        );
      }
    } catch (err) {
      console.error("Error distributing proxies:", err);
      notify.error(providerText(t, "failedDistributeProxies", "Failed to distribute proxies."));
    } finally {
      setDistributingProxies(false);
    }
  };

  return {
    proxyConfig,
    connProxyMap,
    distributingProxies,
    fetchProxyConfig,
    refreshProxyState,
    handleToggleProxyEnabled,
    handleTogglePerKeyProxyEnabled,
    handleDistributeProxies,
  };
}
