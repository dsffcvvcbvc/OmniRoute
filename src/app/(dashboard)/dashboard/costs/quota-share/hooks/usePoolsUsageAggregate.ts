"use client";

import { useEffect, useRef, useState } from "react";
import type { QuotaPool } from "@/lib/quota/dimensions";
import type { PoolUsageSnapshot } from "@/lib/quota/types";
import { backoffPollDelayMs, isDocumentHidden } from "@/shared/utils/fetchTimeout";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

export interface PoolsUsageAggregate {
  avgUtilizationPercent: number; // 0-100
  borrowingKeyCount: number;
  loading: boolean;
  error: string | null;
  /**
   * `true` when the gateway exposes no per-pool usage endpoint. The KPI cards
   * must then show "—" instead of `0%` / `0`: the honest answer there is "not
   * reported", not "no pool is borrowing anything".
   */
  unsupported: boolean;
}

const POLL_MS = 15_000;

const IDLE_STATE: PoolsUsageAggregate = {
  avgUtilizationPercent: 0,
  borrowingKeyCount: 0,
  loading: true,
  error: null,
  unsupported: false,
};

const EMPTY_FETCH: PoolsUsageAggregate = {
  avgUtilizationPercent: 0,
  borrowingKeyCount: 0,
  loading: false,
  error: null,
  unsupported: false,
};

export function usePoolsUsageAggregate(pools: QuotaPool[]): PoolsUsageAggregate {
  // `loading` and the no-surface case are derived below, so only the measured
  // values live in state.
  const [fetched, setFetched] = useState<PoolsUsageAggregate | null>(null);
  const failuresRef = useRef(0);
  const quotaRead = resolveAisixSurfaceSupport("quota", "read");
  const poolIds = pools.map((p) => p.id).join(",");
  // Derived, not stored: with no pool to aggregate — or no quota-usage surface
  // at all — there is nothing to fetch, and the KPI cards must show "—"/idle
  // immediately rather than through a setState round-trip from an effect.
  const hasPools = poolIds.length > 0;
  const canRead = hasPools && quotaRead.supported;

  useEffect(() => {
    if (!canRead) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = poolIds.split(",");

    const fetchAll = async () => {
      const snapshots = await Promise.all(
        ids.map((id) =>
          fetchAisixJson(resolveAisixRequestUrl(`/api/quota/pools/${encodeURIComponent(id)}/usage`))
        )
      );
      if (!mounted) return;
      // A 404 on every pool means the whole quota-usage surface is absent: that
      // is a final answer, so stop counting it as a transient failure (which
      // would otherwise back the poller off to 5 minutes for nothing).
      const allMissing = snapshots.every((snapshot) => snapshot.missing);
      const anyFailed = snapshots.some((snapshot) => !snapshot.ok);
      if (allMissing) {
        // Every pool 404s: the whole quota-usage surface is absent, which is a
        // final answer — not a transient failure to keep backing off for.
        setFetched({ ...EMPTY_FETCH, unsupported: true });
        return;
      }
      const valid = snapshots
        .filter((s) => s.ok && s.data && typeof s.data === "object")
        .map((s) => s.data as { usage?: PoolUsageSnapshot | null })
        .filter((payload) => payload && payload.usage);
      let totalUtil = 0;
      let utilCount = 0;
      let borrowing = 0;
      for (const { usage } of valid) {
        for (const dim of usage!.dimensions ?? []) {
          if (dim.limit > 0) {
            totalUtil += (dim.consumedTotal / dim.limit) * 100;
            utilCount += 1;
          }
          for (const key of dim.perKey ?? []) {
            if (key.borrowing) borrowing += 1;
          }
        }
      }
      if (anyFailed) failuresRef.current += 1;
      else failuresRef.current = 0;
      setFetched({
        ...EMPTY_FETCH,
        avgUtilizationPercent: utilCount > 0 ? totalUtil / utilCount : 0,
        borrowingKeyCount: borrowing,
        error: anyFailed ? "quota_usage_partial" : null,
      });
    };

    const tick = async () => {
      if (!mounted) return;
      if (!isDocumentHidden()) {
        await fetchAll();
      }
      if (!mounted) return;
      timer = setTimeout(tick, backoffPollDelayMs(POLL_MS, failuresRef.current));
    };
    void tick();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [poolIds, canRead]);

  if (!canRead) {
    return { ...IDLE_STATE, loading: false, unsupported: !hasPools ? false : true };
  }
  if (!fetched) return IDLE_STATE;
  return fetched;
}
