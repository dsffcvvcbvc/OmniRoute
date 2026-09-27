"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QuotaPool } from "@/lib/quota/dimensions";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

export interface UsePoolsResult {
  pools: QuotaPool[];
  loading: boolean;
  error: string | null;
  /**
   * `true` when the AISIX gateway has no quota-share store at all. The page
   * must render an explicit "unavailable" state from this: an empty pool list
   * is otherwise indistinguishable from "you have not created a pool yet",
   * which is exactly the silent-404 class this flag exists to kill.
   */
  unsupported: boolean;
  unsupportedReason: string | null;
  mutate: () => Promise<void>;
}

export function usePools(): UsePoolsResult {
  const [pools, setPools] = useState<QuotaPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const mountedRef = useRef(true);
  const poolsRead = resolveAisixSurfaceSupport("quota", "read");

  const fetchPools = useCallback(async () => {
    if (!poolsRead.supported) {
      if (!mountedRef.current) return;
      setUnsupported(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await fetchAisixJson(resolveAisixRequestUrl("/api/quota/pools"));
    if (!mountedRef.current) return;
    if (!result.ok) {
      setUnsupported(result.missing);
      setError(result.missing ? null : result.error || "Failed to load pools");
      setLoading(false);
      return;
    }
    const data: unknown = result.data;
    const list = Array.isArray(data)
      ? (data as QuotaPool[])
      : Array.isArray((data as { pools?: QuotaPool[] }).pools)
        ? (data as { pools: QuotaPool[] }).pools
        : [];
    setPools(list);
    setLoading(false);
  }, [poolsRead.supported]);

  useEffect(() => {
    mountedRef.current = true;
    // Async continuation — see usePoolUsage (react-hooks/set-state-in-effect).
    void (async () => {
      await fetchPools();
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchPools]);

  const mutate = useCallback(async () => {
    await fetchPools();
  }, [fetchPools]);

  return {
    pools,
    loading,
    error,
    unsupported,
    unsupportedReason: unsupported ? poolsRead.reason : null,
    mutate,
  };
}
