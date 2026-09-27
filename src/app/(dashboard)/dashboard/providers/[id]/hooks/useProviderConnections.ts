"use client";

/**
 * useProviderConnections — Phase 1f extraction for Issue #3501.
 *
 * Owns ALL connection-management state and handlers that were previously
 * inline in ProviderDetailPageClient:
 *  - connections / providerNode / loading state
 *  - fetchConnections (with compatible-node retry logic)
 *  - batch activate / deactivate / retest / delete (with MAX_BULK_IDS chunking)
 *  - single-connection handlers: delete, update status, proxy toggles,
 *    rate-limit, claude extra-usage, codex limit, cpa mode,
 *    retest, clear-cooldown, token refresh, swap priority
 *  - selection state: selectedIds, handleToggleSelectOne/All, batchDeleteConfirmOpen
 *  - batch-test runner (runBatchTest / handleBatchTestAll / handleBatchRetest)
 *  - health/pagination filters (healthFilter, page)
 *  - proxy/distribution helpers (loadConnProxies, handleDistributeProxies,
 *    toggleProxyEnabled, togglePerKeyProxyEnabled)
 *
 * The hook is cycle-safe: it imports only from leaf modules (@/store, @/shared,
 * providers constants) — never from ProviderDetailPageClient.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import { isClaudeCodeCompatibleProvider } from "@/shared/constants/providers";
import type { ConnectionRowConnection } from "../components/ConnectionRow";
import {
  connectionBelongsToProviderPage,
  getProviderConnectionsRequestUrl,
} from "../../providerPageUtils";
import {
  aisixAdminModelsUrl,
  getAisixAdminBase,
  resolveAisixRequestUrl,
} from "@/shared/utils/aisixEndpoints";
import { aisixAdminFetch } from "@/shared/utils/aisixAdminAuth";
import { normalizeCodexLimitPolicy, providerText } from "../providerPageHelpers";
import { useProviderQuotaVisibility } from "./useProviderQuotaVisibility";
import { useReorderByAvailability } from "./useReorderByAvailability";
import {
  useConnectionDeleteConfirm,
  type ConnectionDeleteConfirmState,
} from "./useConnectionDeleteConfirm";

// Max connection ids accepted per bulk request — mirrors API-side cap.
const MAX_BULK_IDS = 100;
const PAGE_SIZE = 50;

// ──── module-level fetch helpers ────────────────────────────────────────────
// The network/parse/retry concerns live outside the hook so the callbacks
// below only set state after the await — the mount effect can then call them
// without a synchronous setState (errors come back as values, not as state
// writes inside catch/finally blocks).

interface ProviderConnectionsFetchResult {
  connections: ConnectionRowConnection[] | null;
  node: any;
  nodeResolved: boolean;
}

/**
 * The native admin plane has shipped more than one envelope for these two
 * collections (`{connections:[…]}`, `{data:[…]}`, `{keys:[…]}` /
 * `{nodes:[…]}`, `{models:[…]}`). Reading only one key is how a reachable
 * admin plane ends up rendering as "0 connections" — mirror the tolerant
 * shape resolution in `loadProviderPageData` so both dashboards agree.
 */
function readNativeList(payload: unknown, fields: readonly string[]): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

async function loadProviderConnectionsData(
  providerId: string,
  isCompatible: boolean
): Promise<ProviderConnectionsFetchResult | null> {
  try {
    const connectionsUrl = getProviderConnectionsRequestUrl(providerId);
    const [connectionsRes, nodesRes] = await Promise.all([
      fetch(connectionsUrl, { cache: "no-store" }),
      fetch(aisixAdminModelsUrl(), { cache: "no-store" }),
    ]);
    const connectionsData = await connectionsRes.json();
    const nodesData = await nodesRes.json();
    const connections = connectionsRes.ok
      ? readNativeList(connectionsData, ["connections", "data", "keys"]).filter((c: any) =>
          connectionBelongsToProviderPage(c.provider, providerId)
        )
      : null;
    let node = null;
    let nodeResolved = false;
    if (nodesRes.ok) {
      nodeResolved = true;
      const readNode = (payload: unknown) =>
        readNativeList(payload, ["nodes", "data", "models"]).find(
          (entry: any) => entry.id === providerId
        ) || null;
      node = readNode(nodesData);

      // Newly created compatible nodes can be briefly unavailable on one worker.
      if (!node && isCompatible) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const retryRes = await aisixAdminFetch(aisixAdminModelsUrl(), { cache: "no-store" });
          if (!retryRes.ok) continue;
          const retryData = await retryRes.json();
          node = readNode(retryData);
          if (node) break;
        }
      }
    }
    return { connections, node, nodeResolved };
  } catch (error) {
    console.error("Error fetching connections:", error);
    return null;
  }
}

/**
 * `true` when a request URL resolves to the native read-only
 * `:3001/admin/v1/provider_keys` collection. The native admin plane is
 * read-only there (`POST /admin/v1/resources` is its sole write verb, with a
 * core-side body contract this dashboard must not invent), so DELETE/PATCH
 * against it are never sent — callers refuse loudly instead of 404ing.
 */
function isNativeProviderKeysWrite(url: string): boolean {
  const resolved = /^https?:\/\//i.test(url) ? url : resolveAisixRequestUrl(url);
  return resolved
    .toLowerCase()
    .startsWith(`${getAisixAdminBase().toLowerCase()}/admin/v1/provider_keys`);
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
): Record<string, { proxy: any; level: string } | null> | null {
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
  const map: Record<string, { proxy: any; level: string } | null> = {};
  for (const conn of conns) {
    if (!conn.id) continue;
    map[conn.id] = byScopeId.get(conn.id) ?? null;
  }
  return map;
}

// ──── types ─────────────────────────────────────────────────────────────────

/**
 * Upstream proxy routing mode for Claude-Code-compatible providers. `native`
 * uses OmniRoute's own executor; `cliproxyapi`/`dario` route every request
 * through that backend directly; `fallback` tries native first and retries
 * via `fallbackBackend` on failure. Mirrors the `mode` enum in
 * src/app/api/upstream-proxy/[providerId]/route.ts.
 */
export type UpstreamProxyMode = "native" | "cliproxyapi" | "dario" | "fallback";
export type UpstreamProxyFallbackBackend = "cliproxyapi" | "dario";

export type BatchTestResults = {
  error: string | null;
  results: any[];
  summary: { passed: number; failed: number; total: number } | null;
} | null;

export interface UseProviderConnectionsReturn {
  // State
  connections: ConnectionRowConnection[];
  providerNode: any;
  loading: boolean;
  retestingId: string | null;
  /** Connection id whose cooldown-clear PUT is in flight (drives button spinners). */
  clearingCooldownId: string | null;
  batchTesting: boolean;
  batchTestResults: BatchTestResults;
  selectedIds: Set<string>;
  batchDeleting: boolean;
  batchUpdating: "activate" | "deactivate" | null;
  batchRetesting: boolean;
  batchDeleteConfirmOpen: boolean;
  healthFilter: string;
  page: number;
  accountSearch: string;
  distributingProxies: boolean;
  proxyConfig: any;
  connProxyMap: Record<string, { proxy: any; level: string } | null>;
  cpaProviderEnabled: boolean;
  upstreamProxyMode: UpstreamProxyMode;
  upstreamProxyFallbackBackend: UpstreamProxyFallbackBackend;
  refreshingId: string | null;

  // Setters (minimal surface for UI)
  setPage: (p: number) => void;
  setHealthFilter: (f: string) => void;
  setAccountSearch: (q: string) => void;
  setSelectedIds: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setBatchDeleteConfirmOpen: (open: boolean) => void;
  setBatchTestResults: (r: BatchTestResults) => void;
  setConnections: (
    updater:
      ConnectionRowConnection[] | ((prev: ConnectionRowConnection[]) => ConnectionRowConnection[])
  ) => void;
  setProviderNode: (node: any) => void;

  // Connection fetch
  fetchConnections: () => Promise<void>;
  fetchProxyConfig: () => Promise<void>;
  refreshProxyState: () => Promise<void>;

  // Single-connection handlers
  deleteConfirm: ConnectionDeleteConfirmState;
  handleUpdateConnectionStatus: (id: string, isActive: boolean) => Promise<void>;
  handleToggleRateLimit: (connectionId: string, enabled: boolean) => Promise<void>;
  handleToggleQuotaVisibility: (connectionId: string, visible: boolean) => Promise<void>;
  handleToggleClaudeExtraUsage: (connectionId: string, enabled: boolean) => Promise<void>;
  handleToggleCodexLimit: (connectionId: string, field: string, enabled: boolean) => Promise<void>;
  handleToggleCliproxyapiMode: (connectionId: string, enabled: boolean) => Promise<void>;
  handleSetUpstreamProxyMode: (
    mode: UpstreamProxyMode,
    fallbackBackend?: UpstreamProxyFallbackBackend
  ) => Promise<void>;
  handleToggleProxyEnabled: (connectionId: string, proxyEnabled: boolean) => Promise<void>;
  handleTogglePerKeyProxyEnabled: (
    connectionId: string,
    perKeyProxyEnabled: boolean
  ) => Promise<void>;
  handleRetestConnection: (connectionId: string) => Promise<void>;
  /**
   * Manually lifts a persisted 429 cooldown: PUTs `rateLimitedUntil: null`
   * (plus backoff reset server-side) so the connection rejoins routing
   * immediately. For the "quota already refreshed upstream but OmniRoute
   * still benches the key" case — the cooldown timer is OmniRoute's own
   * lesson, not upstream truth.
   */
  handleClearCooldown: (connectionId: string) => Promise<void>;
  handleRefreshToken: (connectionId: string) => Promise<void>;
  handleSwapPriority: (conn1: any, conn2: any) => Promise<void>;
  handleReorderByAvailability: () => Promise<void>;
  reorderingByAvailability: boolean;

  // Batch handlers
  handleBatchSetActive: (isActive: boolean) => Promise<void>;
  handleBatchDeleteOpenModal: () => void;
  handleBatchDeleteConfirm: (onAfter?: () => Promise<void>) => Promise<void>;
  handleBatchRetest: () => Promise<void>;
  handleBatchTestAll: () => Promise<void>;

  // Selection helpers
  handleToggleSelectOne: (id: string) => void;
  handleToggleSelectAll: () => void;

  // Proxy distribution
  handleDistributeProxies: (tagFilter?: string) => Promise<void>;

  // Helpers for parsing API responses
  parseApiErrorMessage: (res: Response, fallback: string) => Promise<string>;
  getAttachmentFilename: (res: Response, fallback: string) => string;

  // Constants exposed for render
  PAGE_SIZE: number;
}

export function useProviderConnections(
  providerId: string,
  isCompatible: boolean,
  _isSearchProvider: boolean
): UseProviderConnectionsReturn {
  const t = useTranslations("providers");
  const notify = useNotificationStore();

  const isCcCompatible = isClaudeCodeCompatibleProvider(providerId);

  // ── core state ──────────────────────────────────────────────────────────
  const [connections, setConnections] = useState<ConnectionRowConnection[]>([]);
  const handleToggleQuotaVisibility = useProviderQuotaVisibility(setConnections, notify, t);
  const [providerNode, setProviderNode] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // ── test state ──────────────────────────────────────────────────────────
  const [retestingId, setRetestingId] = useState<string | null>(null);
  const [clearingCooldownId, setClearingCooldownId] = useState<string | null>(null);
  const [batchTesting, setBatchTesting] = useState(false);
  const [batchTestResults, setBatchTestResults] = useState<BatchTestResults>(null);

  // ── selection + batch state ─────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchUpdating, setBatchUpdating] = useState<"activate" | "deactivate" | null>(null);
  const [batchRetesting, setBatchRetesting] = useState(false);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);

  // ── filter / pagination state ───────────────────────────────────────────
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  // #7937 — account search across the full in-memory connection list. Resets
  // pagination to page 0 whenever the query text changes (mirrors the
  // existing setPage(0) on health-filter pill click).
  const [accountSearch, setAccountSearchRaw] = useState<string>("");
  const setAccountSearch = useCallback((query: string) => {
    setAccountSearchRaw(query);
    setPage(0);
  }, []);

  // ── proxy state ─────────────────────────────────────────────────────────
  const [distributingProxies, setDistributingProxies] = useState(false);
  const [proxyConfig, setProxyConfig] = useState<any>(null);
  const [connProxyMap, setConnProxyMap] = useState<
    Record<string, { proxy: any; level: string } | null>
  >({});

  // Latest connections, readable from a stable callback without making that
  // callback (and every consumer prop depending on it) change every fetch.
  const connectionsRef = useRef<ConnectionRowConnection[]>(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  // ── Upstream proxy routing state (native / CLIProxyAPI / Dario / fallback) ─
  const [upstreamProxyMode, setUpstreamProxyModeState] = useState<UpstreamProxyMode>("native");
  const [upstreamProxyFallbackBackend, setUpstreamProxyFallbackBackendState] =
    useState<UpstreamProxyFallbackBackend>("cliproxyapi");
  // Legacy derived flag — kept for any consumer still reading a plain
  // enabled/disabled signal instead of the full mode.
  const cpaProviderEnabled =
    upstreamProxyMode === "cliproxyapi" || upstreamProxyMode === "fallback";

  // ── token refresh state ─────────────────────────────────────────────────
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  // ────────────────────────────────────────────────────────────────────────
  // Fetch helpers
  // ────────────────────────────────────────────────────────────────────────

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

  const fetchConnections = useCallback(async () => {
    const result = await loadProviderConnectionsData(providerId, isCompatible);
    if (result) {
      if (result.connections) setConnections(result.connections);
      if (result.nodeResolved) setProviderNode(result.node);
    }
    setLoading(false);
  }, [providerId, isCompatible]);

  // ── effects ──────────────────────────────────────────────────────────────
  // The async work is defined INSIDE each effect (a component-scope loader
  // called synchronously from an effect is rejected by the compiler rules);
  // every setState below runs after an await.

  useEffect(() => {
    const run = async () => {
      const result = await loadProviderConnectionsData(providerId, isCompatible);
      if (result) {
        if (result.connections) setConnections(result.connections);
        if (result.nodeResolved) setProviderNode(result.node);
      }
      setLoading(false);
    };
    void run();
    const runProxyConfig = async () => {
      const result = await loadProxyConfigData();
      if (result) setProxyConfig(result.config);
    };
    void runProxyConfig();
  }, [providerId, isCompatible]);

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

  // Upstream proxy routing config (native / CLIProxyAPI / Dario / fallback)
  useEffect(() => {
    if (!isCcCompatible) return;

    fetch(`/api/upstream-proxy/${providerId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const validModes: UpstreamProxyMode[] = ["cliproxyapi", "dario", "fallback"];
        const mode: UpstreamProxyMode =
          data.enabled && validModes.includes(data.mode) ? data.mode : "native";
        setUpstreamProxyModeState(mode);
        setUpstreamProxyFallbackBackendState(
          data.fallbackBackend === "dario" ? "dario" : "cliproxyapi"
        );
      })
      .catch(() => {});
  }, [isCcCompatible, providerId]);

  // ────────────────────────────────────────────────────────────────────────
  // API error helpers
  // ────────────────────────────────────────────────────────────────────────

  const parseApiErrorMessage = async (res: Response, fallback: string): Promise<string> => {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json().catch(() => ({}));
      if (typeof data?.error === "string" && data.error.trim()) return data.error;
      if (data?.error?.message) return data.error.message;
    }
    const text = await res.text().catch(() => "");
    return text.trim() || fallback;
  };

  const getAttachmentFilename = (res: Response, fallback: string): string => {
    const disposition = res.headers.get("content-disposition") || "";
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
    const plainMatch = disposition.match(/filename="([^"]+)"/i);
    if (plainMatch?.[1]) return plainMatch[1];
    return fallback;
  };

  // ────────────────────────────────────────────────────────────────────────
  // Single-connection handlers
  // ────────────────────────────────────────────────────────────────────────

  const deleteConfirm = useConnectionDeleteConfirm(fetchConnections, notify);

  /**
   * Unified write gate: connection writes have no native verb, so a mutation
   * that would land on the read-only provider_keys collection is refused
   * BEFORE any request is sent, with an explanatory toast. Everything else
   * still attempts the Next-only route and reports `!ok` loudly at the call
   * site — silent write failures are the bug this removes.
   */
  const reportNativeWriteBlocked = (action: string) => {
    notify.error(
      providerText(
        t,
        "nativeConnectionWriteUnsupported",
        "Cannot {action}: the native core exposes provider keys as read-only. Manage keys via POST /admin/v1/resources.",
        { action }
      )
    );
  };

  const handleUpdateConnectionStatus = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setConnections((prev: any[]) => prev.map((c) => (c.id === id ? { ...c, isActive } : c)));
      } else {
        const data = await res.json().catch(() => ({}));
        notify.error(
          (typeof data?.error === "string" && data.error) ||
            data?.error?.message ||
            providerText(t, "failedUpdateConnectionStatus", "Failed to update connection status")
        );
      }
    } catch (error) {
      console.log("Error updating connection status:", error);
      notify.error(
        providerText(t, "failedUpdateConnectionStatus", "Failed to update connection status")
      );
    }
  };

  const handleToggleRateLimit = async (connectionId: string, enabled: boolean) => {
    try {
      const res = await fetch("/api/rate-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, enabled }),
      });
      if (res.ok) {
        setConnections((prev: any[]) =>
          prev.map((c) => (c.id === connectionId ? { ...c, rateLimitProtection: enabled } : c))
        );
      } else {
        const data = await res.json().catch(() => ({}));
        notify.error(
          (typeof data?.error === "string" && data.error) ||
            data?.error?.message ||
            providerText(t, "failedToggleRateLimit", "Failed to toggle rate-limit protection")
        );
      }
    } catch (error) {
      console.error("Error toggling rate limit:", error);
      notify.error(
        providerText(t, "failedToggleRateLimit", "Failed to toggle rate-limit protection")
      );
    }
  };

  const handleToggleClaudeExtraUsage = async (connectionId: string, enabled: boolean) => {
    try {
      const target = (connections as any[]).find((connection) => connection.id === connectionId);
      if (!target) return;

      const providerSpecificData =
        target.providerSpecificData && typeof target.providerSpecificData === "object"
          ? target.providerSpecificData
          : {};

      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: { ...providerSpecificData, blockExtraUsage: enabled },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify.error(
          data.error ||
            providerText(
              t,
              "failedUpdateClaudeExtraUsagePolicy",
              "Failed to update Claude extra-usage policy"
            )
        );
        return;
      }

      setConnections((prev: any[]) =>
        prev.map((connection) =>
          connection.id === connectionId
            ? {
                ...connection,
                providerSpecificData: {
                  ...(connection.providerSpecificData || {}),
                  blockExtraUsage: enabled,
                },
                ...(!enabled && connection.lastErrorSource === "extra_usage"
                  ? {
                      testStatus: "active",
                      lastError: null,
                      lastErrorAt: null,
                      lastErrorType: null,
                      lastErrorSource: null,
                      errorCode: null,
                      rateLimitedUntil: null,
                    }
                  : {}),
              }
            : connection
        )
      );
      notify.success(
        enabled
          ? providerText(
              t,
              "claudeExtraUsageBlockingEnabled",
              "Claude extra-usage blocking enabled (extra usage will be blocked)"
            )
          : providerText(
              t,
              "claudeExtraUsageBlockingDisabled",
              "Claude extra-usage blocking disabled (extra usage is allowed)"
            )
      );
    } catch (error) {
      console.error("Error toggling Claude extra-usage policy:", error);
      notify.error(
        providerText(
          t,
          "failedUpdateClaudeExtraUsagePolicy",
          "Failed to update Claude extra-usage policy"
        )
      );
    }
  };

  const handleToggleCodexLimit = async (connectionId: string, field: string, enabled: boolean) => {
    try {
      const target = (connections as any[]).find((connection) => connection.id === connectionId);
      if (!target) return;

      const providerSpecificData =
        target.providerSpecificData && typeof target.providerSpecificData === "object"
          ? target.providerSpecificData
          : {};
      const existingPolicy =
        providerSpecificData.codexLimitPolicy &&
        typeof providerSpecificData.codexLimitPolicy === "object"
          ? providerSpecificData.codexLimitPolicy
          : {};

      const nextPolicy = {
        ...normalizeCodexLimitPolicy(existingPolicy),
        [field]: enabled,
      };

      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: { ...providerSpecificData, codexLimitPolicy: nextPolicy },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify.error(
          data.error ||
            providerText(t, "failedUpdateCodexLimitPolicy", "Failed to update Codex limit policy")
        );
        return;
      }

      setConnections((prev: any[]) =>
        prev.map((connection) =>
          connection.id === connectionId
            ? {
                ...connection,
                providerSpecificData: {
                  ...(connection.providerSpecificData || {}),
                  codexLimitPolicy: nextPolicy,
                },
              }
            : connection
        )
      );
      notify.success(providerText(t, "codexLimitPolicyUpdated", "Codex limit policy updated"));
    } catch (error) {
      console.error("Error toggling Codex quota policy:", error);
      notify.error(
        providerText(t, "failedUpdateCodexLimitPolicy", "Failed to update Codex limit policy")
      );
    }
  };

  const UPSTREAM_PROXY_MODE_MESSAGES: Record<UpstreamProxyMode, string> = {
    native: "Requests now use native OmniRoute (direct)",
    cliproxyapi: "Requests now route through CLIProxyAPI (deeper emulation)",
    dario: "Requests now route through Dario (Claude subscription proxy)",
    fallback: "Requests try native first, retrying via the configured backend on failure",
  };

  const handleSetUpstreamProxyMode = async (
    mode: UpstreamProxyMode,
    fallbackBackend?: UpstreamProxyFallbackBackend
  ) => {
    try {
      const res = await fetch(`/api/upstream-proxy/${providerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          enabled: mode !== "native",
          ...(mode === "fallback"
            ? { fallbackBackend: fallbackBackend ?? upstreamProxyFallbackBackend }
            : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify.error(
          data.error ||
            providerText(
              t,
              "failedUpdateCliproxyRouting",
              "Failed to update upstream proxy routing"
            )
        );
        return;
      }

      setUpstreamProxyModeState(mode);
      if (mode === "fallback" && fallbackBackend) {
        setUpstreamProxyFallbackBackendState(fallbackBackend);
      }
      notify.success(UPSTREAM_PROXY_MODE_MESSAGES[mode]);
    } catch {
      notify.error(
        providerText(t, "failedUpdateCliproxyRouting", "Failed to update upstream proxy routing")
      );
    }
  };

  // Legacy binary wrapper — kept so existing callers (and the "exposes all
  // expected handler functions" hook test) keep working unchanged.
  const handleToggleCliproxyapiMode = async (_connectionId: string, enabled: boolean) => {
    await handleSetUpstreamProxyMode(enabled ? "cliproxyapi" : "native");
  };

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

  const handleRetestConnection = async (connectionId: string) => {
    if (!connectionId || retestingId) return;
    setRetestingId(connectionId);
    try {
      const res = await fetch(`/api/providers/${connectionId}/test`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify.error(data.error || t("failedRetestConnection"));
        return;
      }
      await fetchConnections();
    } catch (error) {
      console.error("Error retesting connection:", error);
      notify.error(t("failedRetestConnection"));
    } finally {
      setRetestingId(null);
    }
  };

  // Manually lift a persisted 429 cooldown. Complements the automatic paths
  // (Test-button success / Edit-modal key re-validation): those only clear the
  // bench as a side effect of a successful upstream round-trip, so a user whose
  // quota already refreshed upstream still waits out OmniRoute's local timer.
  // PUT /api/providers/[id] applies updateProviderConnectionDefaults, which
  // resets backoffLevel → 0 alongside rateLimitedUntil → null.
  const handleClearCooldown = async (connectionId: string) => {
    if (!connectionId || clearingCooldownId) return;
    setClearingCooldownId(connectionId);
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateLimitedUntil: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify.error(data.error || t("failedClearConnectionCooldown"));
        return;
      }
      // Optimistically drop the cooldown locally so the row leaves the cooling
      // panel immediately; fetchConnections() reconciles with server truth.
      setConnections((prev: any[]) =>
        prev.map((c) =>
          c.id === connectionId ? { ...c, rateLimitedUntil: null, backoffLevel: 0 } : c
        )
      );
      notify.success(t("connectionCooldownCleared"));
      await fetchConnections();
    } catch (error) {
      console.error("Error clearing cooldown:", error);
      notify.error(t("failedClearConnectionCooldown"));
    } finally {
      setClearingCooldownId(null);
    }
  };

  const handleRefreshToken = async (connectionId: string) => {
    if (refreshingId) return;
    setRefreshingId(connectionId);
    try {
      const conn = connections.find((c) => c.id === connectionId);
      const isCursor = conn?.provider === "cursor";
      // Cursor has no refresh_token by design — the generic /refresh route's
      // getAccessToken() call always 502s for it. The dedicated route nudges
      // cursor-agent and re-scrapes IDE/agent credential sources instead.
      const url = isCursor
        ? `/api/providers/${connectionId}/refresh-cursor`
        : `/api/providers/${connectionId}/refresh`;
      const res = await fetch(url, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        if (isCursor && data.unchanged) {
          notify.info(t("cursorSessionUnchanged"));
        } else {
          notify.success(t("tokenRefreshed"));
          await fetchConnections();
        }
      } else {
        notify.error(data.error || t("tokenRefreshFailed"));
      }
    } catch (error) {
      console.error("Error refreshing token:", error);
      notify.error(t("tokenRefreshFailed"));
    } finally {
      setRefreshingId(null);
    }
  };

  const handleSwapPriority = async (conn1: any, conn2: any) => {
    if (!conn1 || !conn2) return;
    try {
      let p1 = conn2.priority;
      let p2 = conn1.priority;

      if (p1 === p2) {
        const isConn1MovingUp =
          (connections as any[]).indexOf(conn1) > (connections as any[]).indexOf(conn2);
        if (isConn1MovingUp) {
          p1 = conn2.priority - 0.5;
        } else {
          p1 = conn2.priority + 0.5;
        }
      }

      await Promise.all([
        fetch(`/api/providers/${conn1.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: p1 }),
        }),
        fetch(`/api/providers/${conn2.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: p2 }),
        }),
      ]).then(async (results) => {
        const failed = results.filter((res) => !res.ok);
        if (failed.length > 0) {
          const data = await failed[0].json().catch(() => ({}));
          notify.error(
            (typeof data?.error === "string" && data.error) ||
              data?.error?.message ||
              providerText(t, "failedSwapPriority", "Failed to swap connection priority")
          );
          return;
        }
      });
      await fetchConnections();
    } catch (error) {
      console.log("Error swapping priority:", error);
      notify.error(providerText(t, "failedSwapPriority", "Failed to swap connection priority"));
    }
  };

  // Reorder-by-availability toolbar action — extracted to its own hook
  // (see useReorderByAvailability.ts) to keep this file under the file-size cap.
  const { reorderingByAvailability, handleReorderByAvailability } = useReorderByAvailability({
    connections,
    setConnections,
    fetchConnections,
    notify,
    t,
  });

  // ────────────────────────────────────────────────────────────────────────
  // Selection handlers
  // ────────────────────────────────────────────────────────────────────────

  const handleToggleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === (connections as any[]).length && (connections as any[]).length > 0) {
        return new Set();
      }
      return new Set((connections as any[]).map((c: { id: string }) => c.id));
    });
  }, [connections]);

  // ────────────────────────────────────────────────────────────────────────
  // Batch handlers
  // ────────────────────────────────────────────────────────────────────────

  const handleBatchDeleteOpenModal = () => {
    if (selectedIds.size === 0) return;
    // The batch endpoint resolves to the read-only native provider_keys
    // collection — never open a confirm modal for a write that cannot run.
    if (isNativeProviderKeysWrite(resolveAisixRequestUrl("/api/providers"))) {
      reportNativeWriteBlocked("delete connections");
      return;
    }
    setBatchDeleteConfirmOpen(true);
  };

  const handleBatchDeleteConfirm = async (onAfter?: () => Promise<void>) => {
    setBatchDeleteConfirmOpen(false);
    const batchUrl = resolveAisixRequestUrl("/api/providers");
    if (isNativeProviderKeysWrite(batchUrl)) {
      reportNativeWriteBlocked("delete connections");
      return;
    }
    setBatchDeleting(true);
    try {
      const res = await fetch(batchUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });

      if (res.ok) {
        const count = selectedIds.size;
        setSelectedIds(new Set());
        await fetchConnections();
        notify.success(t("batchDeleteSuccess", { count }));
        // ConfirmModal's onClick forwards a MouseEvent; only a real callback runs.
        if (typeof onAfter === "function") await onAfter();
      } else {
        const data = await res.json();
        notify.error(data.error || providerText(t, "batchDeleteFailed", "Batch delete failed"));
      }
    } catch {
      notify.error(providerText(t, "batchDeleteNetworkError", "Network error during batch delete"));
    } finally {
      setBatchDeleting(false);
    }
  };

  const handleBatchSetActive = async (isActive: boolean) => {
    if (selectedIds.size === 0 || batchUpdating) return;
    const batchUrl = resolveAisixRequestUrl("/api/providers");
    if (isNativeProviderKeysWrite(batchUrl)) {
      reportNativeWriteBlocked(isActive ? "activate connections" : "deactivate connections");
      return;
    }
    setBatchUpdating(isActive ? "activate" : "deactivate");
    try {
      const ids = Array.from(selectedIds);
      let updated = 0;
      let notFound = 0;
      for (let i = 0; i < ids.length; i += MAX_BULK_IDS) {
        const chunk = ids.slice(i, i + MAX_BULK_IDS);
        const res = await fetch(batchUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk, isActive }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            data.error?.message ||
              data.error ||
              providerText(t, "batchUpdateFailed", "Batch update failed")
          );
        }
        const data = await res.json();
        updated += data.updated ?? 0;
        notFound += Array.isArray(data.notFound) ? data.notFound.length : 0;
      }

      await fetchConnections();

      if (updated === 0) {
        notify.warning(t("batchUpdateNone"));
      } else if (notFound > 0) {
        notify.warning(t("batchUpdatePartial", { count: updated, skipped: notFound }));
      } else {
        notify.success(
          isActive
            ? t("batchActivateSuccess", { count: updated })
            : t("batchDeactivateSuccess", { count: updated })
        );
      }
    } catch (error: any) {
      notify.error(
        error?.message ||
          providerText(t, "batchUpdateNetworkError", "Network error during batch update")
      );
    } finally {
      setBatchUpdating(null);
    }
  };

  // Shared runner for batch connection tests (all-for-provider or selected IDs)
  const runBatchTest = async (payload: Record<string, unknown>) => {
    setBatchTestResults(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2min max
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        data = { error: t("providerTestFailed"), results: [], summary: null };
      }
      setBatchTestResults({
        ...data,
        error: data.error
          ? typeof data.error === "object"
            ? data.error.message || data.error.error || JSON.stringify(data.error)
            : String(data.error)
          : null,
      });
      if (data?.summary) {
        const { passed, failed, total } = data.summary;
        if (total === 0) notify.warning(t("noConnectionsToTest"));
        else if (failed === 0) notify.success(t("allTestsPassed", { total }));
        else notify.warning(t("testSummary", { passed, failed, total }));
      }
      await fetchConnections();
    } catch (error: any) {
      const isAbort = error?.name === "AbortError";
      const msg = isAbort ? t("providerTestTimeout") : t("providerTestFailed");
      setBatchTestResults({ error: msg, results: [], summary: null });
      notify.error(msg);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Batch test all connections for this provider
  const handleBatchTestAll = async () => {
    if (batchTesting || (connections as any[]).length === 0) return;
    setBatchTesting(true);
    try {
      await runBatchTest({ mode: "provider", providerId });
    } finally {
      setBatchTesting(false);
    }
  };

  // Batch retest only the selected connections
  const handleBatchRetest = async () => {
    if (batchRetesting || selectedIds.size === 0) return;
    // Live-testing a huge selection risks the 120s client abort; bound it to
    // the same cap the API enforces and tell the user to narrow the selection.
    if (selectedIds.size > MAX_BULK_IDS) {
      notify.warning(t("batchRetestLimit", { max: MAX_BULK_IDS }));
      return;
    }
    setBatchRetesting(true);
    try {
      await runBatchTest({ mode: "selected", connectionIds: Array.from(selectedIds) });
    } finally {
      setBatchRetesting(false);
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  // Proxy distribution
  // ────────────────────────────────────────────────────────────────────────

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

  // ────────────────────────────────────────────────────────────────────────

  return {
    // State
    connections,
    providerNode,
    loading,
    retestingId,
    batchTesting,
    batchTestResults,
    selectedIds,
    batchDeleting,
    batchUpdating,
    batchRetesting,
    batchDeleteConfirmOpen,
    healthFilter,
    page,
    accountSearch,
    distributingProxies,
    proxyConfig,
    connProxyMap,
    cpaProviderEnabled,
    upstreamProxyMode,
    upstreamProxyFallbackBackend,
    refreshingId,
    reorderingByAvailability,

    // Setters
    setPage,
    setHealthFilter,
    setAccountSearch,
    setSelectedIds,
    setBatchDeleteConfirmOpen,
    setBatchTestResults,
    setConnections,
    setProviderNode,

    // Fetch
    fetchConnections,
    fetchProxyConfig,
    refreshProxyState,

    // Single-connection handlers
    deleteConfirm,
    handleUpdateConnectionStatus,
    handleToggleRateLimit,
    handleToggleQuotaVisibility,
    handleToggleClaudeExtraUsage,
    handleToggleCodexLimit,
    handleToggleCliproxyapiMode,
    handleSetUpstreamProxyMode,
    handleToggleProxyEnabled,
    handleTogglePerKeyProxyEnabled,
    handleRetestConnection,
    handleClearCooldown,
    clearingCooldownId,
    handleRefreshToken,
    handleSwapPriority,
    handleReorderByAvailability,

    // Batch handlers
    handleBatchSetActive,
    handleBatchDeleteOpenModal,
    handleBatchDeleteConfirm,
    handleBatchRetest,
    handleBatchTestAll,

    // Selection
    handleToggleSelectOne,
    handleToggleSelectAll,

    // Proxy distribution
    handleDistributeProxies,

    // Helpers
    parseApiErrorMessage,
    getAttachmentFilename,

    // Constants
    PAGE_SIZE,
  };
}
