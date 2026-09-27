"use client";

import { useEffect } from "react";
import type { QuotaPool, PoolAllocation, Policy } from "@/lib/quota/dimensions";
import { useNotificationStore } from "@/store/notificationStore";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

const LS_KEY = "omniroute:quota-share:pools";

// Shape of a legacy localStorage pool (QuotaSharePageClient.tsx old format)
interface LsPool {
  id?: string;
  connectionId?: string;
  provider?: string;
  accountLabel?: string;
  window?: string;
  policy?: string;
  allocations?: Array<{
    apiKeyId?: string;
    percent?: number;
  }>;
}

interface PoolCreate {
  connectionId: string;
  name: string;
  allocations: Array<{
    apiKeyId: string;
    weight: number;
    capValue?: number;
    capUnit?: string;
    policy: Policy;
  }>;
}

export function adaptLsPoolToApiSchema(lsPool: LsPool): PoolCreate {
  const connectionId = lsPool.connectionId || "";
  const name =
    lsPool.accountLabel || lsPool.provider || lsPool.connectionId?.slice(0, 12) || "Migrated pool";
  const policy: Policy =
    lsPool.policy === "soft" || lsPool.policy === "burst" ? (lsPool.policy as Policy) : "hard";

  const allocations: PoolAllocation[] = (lsPool.allocations || [])
    .filter((a) => a.apiKeyId)
    .map((a) => ({
      apiKeyId: a.apiKeyId as string,
      weight: typeof a.percent === "number" ? Math.max(0, Math.min(100, a.percent)) : 0,
      policy,
    }));

  return { connectionId, name, allocations };
}

export interface UseLocalStoragePoolMigrationInput {
  pools: QuotaPool[];
  mutate: () => Promise<unknown>;
}

export function useLocalStoragePoolMigration({
  pools,
  mutate,
}: UseLocalStoragePoolMigrationInput): void {
  const notify = useNotificationStore();
  const quotaWrite = resolveAisixSurfaceSupport("quota", "write");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return;

    // Idempotency: if DB already has pools, do not migrate
    if (pools.length > 0) {
      // Leave localStorage key intact (safety — let user verify before cleanup)
      return;
    }

    // The migration POSTs into the quota-pools collection, which the AISIX
    // gateway does not have. Sending it anyway meant one guaranteed 404 per
    // pool, silently swallowed by a `.catch(() => {})` that then also left the
    // data in localStorage forever with no explanation. Refuse loudly instead
    // and keep the payload for a build that can store it.
    if (!quotaWrite.supported) {
      notify.error(
        `AISIX-шлюз: миграция пулов недоступна. ${quotaWrite.reason} Данные сохранены локально.`
      );
      return;
    }

    let lsPools: unknown[] = [];
    try {
      lsPools = JSON.parse(raw) as unknown[];
    } catch {
      window.localStorage.removeItem(LS_KEY);
      return;
    }

    if (!Array.isArray(lsPools) || lsPools.length === 0) {
      window.localStorage.removeItem(LS_KEY);
      return;
    }

    // POST batch — migrate all pools
    Promise.all(
      lsPools.map((p) =>
        fetchAisixJson(resolveAisixRequestUrl("/api/quota/pools"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(adaptLsPoolToApiSchema(p as LsPool)),
        })
      )
    ).then((results) => {
      // Only drop the localStorage copy once EVERY pool was stored; a partial
      // batch would silently lose the pools that failed.
      if (results.every((result) => result.ok)) {
        window.localStorage.removeItem(LS_KEY);
        void mutate();
        return;
      }
      notify.error("Миграция пулов: часть записей не сохранена — локальная копия сохранена.");
    });
  }, [pools.length, mutate, notify, quotaWrite.supported, quotaWrite.reason]);
}
