"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolUsageSnapshot } from "@/lib/quota/types";
import { backoffPollDelayMs, isDocumentHidden } from "@/shared/utils/fetchTimeout";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

export interface UsePoolUsageResult {
  usage: PoolUsageSnapshot | null;
  loading: boolean;
  error: string | null;
  /** `true` when the gateway exposes no per-pool usage endpoint. */
  unsupported: boolean;
}

const DEFAULT_POLL_MS = 15_000;

export function usePoolUsage(
  poolId: string,
  pollIntervalMs: number = DEFAULT_POLL_MS
): UsePoolUsageResult {
  const [usage, setUsage] = useState<PoolUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const mountedRef = useRef(true);
  // Consecutive failures feed the exponential backoff: an absent/unreachable
  // endpoint must not be re-requested every 15s forever.
  const failuresRef = useRef(0);
  const quotaRead = resolveAisixSurfaceSupport("quota", "read");

  const fetchUsage = useCallback(async () => {
    if (!poolId) return;
    if (!quotaRead.supported) {
      if (!mountedRef.current) return;
      setUnsupported(true);
      setLoading(false);
      return;
    }
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/quota/pools/${encodeURIComponent(poolId)}/usage`)
    );
    if (!mountedRef.current) return;
    if (!result.ok) {
      if (result.missing) {
        setUnsupported(true);
        setError(null);
      } else {
        setError(result.error || "Failed to load usage");
      }
      setUsage(null);
      failuresRef.current += 1;
      setLoading(false);
      return;
    }
    // The endpoint wraps the snapshot as `{ usage: snapshot }` — unwrap it.
    // Storing the wrapper directly left `usage.dimensions` undefined, which
    // crashed StackedAllocationBar (usage.dimensions[i]) for any pool that has
    // allocations — taking down the whole quota-share page.
    const data = (result.data ?? {}) as { usage?: PoolUsageSnapshot | null };
    setUsage(data?.usage ?? null);
    setError(null);
    failuresRef.current = 0;
    setLoading(false);
  }, [poolId, quotaRead.supported]);

  useEffect(() => {
    mountedRef.current = true;
    failuresRef.current = 0;
    // Async continuation: the compiler only accepts setter-capturing callbacks from an
    // effect when the call sits behind an async boundary (react-hooks/set-state-in-effect).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!mountedRef.current) return;
      if (!isDocumentHidden()) {
        await fetchUsage();
      }
      if (!mountedRef.current) return;
      timer = setTimeout(tick, backoffPollDelayMs(pollIntervalMs, failuresRef.current));
    };
    void tick();

    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [fetchUsage, pollIntervalMs]);

  return { usage, loading, error, unsupported };
}
