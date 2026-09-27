"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";
import type { ConsumptionEvent } from "@/lib/db/quotaConsumption";

export interface UsageLogCardProps {
  poolId: string;
  /** Optional map from apiKeyId to display label */
  keyLabels?: Record<string, string>;
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(epochMs);
  }
}

/**
 * UsageLogCard — collapsible footer card that shows the N most-recent
 * quota_consumption events for a pool, sourced from
 * GET /api/quota/pools/[id]/log.
 *
 * Fail-soft: on error / loading / no data → renders an empty-state message.
 * Never throws; never crashes the parent PoolCard. On a gateway with no quota
 * store it states that explicitly instead of showing "no events" (the previous
 * behaviour, where a 404 was swallowed into an empty list).
 *
 * Collapsed by default so pool cards stay compact.
 */
export default function UsageLogCard({ poolId, keyLabels }: UsageLogCardProps) {
  const t = useTranslations("quotaShare");
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ConsumptionEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const quotaLogRead = resolveAisixSurfaceSupport("quota", "read");

  useEffect(() => {
    if (!open) return;
    if (!quotaLogRead.supported) return;
    let alive = true;
    void (async () => {
      const result = await fetchAisixJson(
        resolveAisixRequestUrl(`/api/quota/pools/${encodeURIComponent(poolId)}/log`)
      );
      if (!alive) return;
      if (!result.ok) {
        // A gateway 404 and a transport failure share one copy here; the
        // "absent surface" wording is supplied by `unavailableReason` below.
        setReadError(t("logEmpty"));
        setEvents([]);
        setLoaded(true);
        return;
      }
      const raw: unknown = (result.data ?? {}) as { events?: unknown } | null;
      setEvents(Array.isArray(raw) ? (raw as ConsumptionEvent[]) : []);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [open, poolId, t, quotaLogRead.supported]);

  // Derived from the build-time support flag, so a gateway without the log
  // surface never needs a state write to stop showing "loading".
  const unavailableReason = !quotaLogRead.supported ? quotaLogRead.reason : readError;
  const isLoaded = quotaLogRead.supported ? loaded : true;

  const keyLabel = (apiKeyId: string): string =>
    keyLabels?.[apiKeyId] ?? apiKeyId.slice(0, 10) + "…";

  return (
    <div className="mt-2 pt-2 border-t border-border/30">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-text-muted hover:text-text-main w-full text-left cursor-pointer"
      >
        <span
          className={`material-symbols-outlined text-[13px] transition-transform ${open ? "rotate-90" : ""}`}
        >
          chevron_right
        </span>
        {t("logTitle")}
      </button>

      {open && (
        <div className="mt-1.5">
          {!isLoaded ? (
            <div className="text-[11px] text-text-muted italic">{t("loading")}</div>
          ) : unavailableReason ? (
            <div
              role="status"
              data-testid="quota-usage-log-unavailable"
              className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200"
            >
              {unavailableReason}
            </div>
          ) : events.length === 0 ? (
            <div className="text-[11px] text-text-muted italic">{t("logEmpty")}</div>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-1">
              {events.map((ev, i) => (
                <div
                  key={`${ev.apiKeyId}-${ev.dimensionKey}-${ev.bucketIndex}-${i}`}
                  className="flex items-center gap-1.5 text-[11px] text-text-muted"
                >
                  <span className="tabular-nums text-text-muted/60 shrink-0 w-[52px]">
                    {formatTime(ev.updatedAt)}
                  </span>
                  <span className="truncate max-w-[80px]" title={ev.apiKeyId}>
                    {keyLabel(ev.apiKeyId)}
                  </span>
                  <span className="text-text-muted/50">·</span>
                  <span className="truncate max-w-[80px]">{ev.unit}</span>
                  <span className="text-text-muted/50">·</span>
                  <span className="tabular-nums text-text-main/80">
                    {ev.consumed.toFixed(0)} {ev.window}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
