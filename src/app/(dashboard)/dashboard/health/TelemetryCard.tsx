"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";
import { aisixStatusModelsUrl } from "@/shared/utils/aisixEndpoints";
import { adaptAisixTelemetry, type AisixTelemetry } from "@/shared/utils/aisixHealth";
import {
  backoffPollDelayMs,
  fetchWithTimeout,
  isDocumentHidden,
} from "@/shared/utils/fetchTimeout";

type TelemetrySample = {
  timestamp: number;
  latencyMs: number;
  throughput: number;
  memoryBytes: number;
};

const REFRESH_MS = 30_000;
const MAX_SAMPLES = 24;
const REQUEST_TIMEOUT_MS = 8000;

function formatDuration(seconds?: number | null) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes?: number | null) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatMs(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}ms`;
}

function formatCount(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

function formatPercent(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

function Sparkline({
  samples,
  field,
}: {
  samples: TelemetrySample[];
  field: keyof TelemetrySample;
}) {
  const values = samples
    .map((sample) => Number(sample[field]))
    .filter((value) => Number.isFinite(value));

  if (values.length < 2) {
    return <div className="h-10 rounded-lg bg-sidebar/50" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 36 - ((value - min) / range) * 32;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 100 40" role="img" aria-hidden="true" className="h-10 w-full">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        points={points}
        className="text-primary"
      />
    </svg>
  );
}

function getIndicatorTone(value: number, warning: number, critical: number, inverse = false) {
  const healthy = inverse ? value >= warning : value <= warning;
  const criticalHit = inverse ? value < critical : value >= critical;
  if (criticalHit) return "bg-red-500/10 text-red-500";
  if (!healthy) return "bg-amber-500/10 text-amber-500";
  return "bg-emerald-500/10 text-emerald-500";
}

export default function TelemetryCard() {
  const t = useTranslations("telemetry");
  const th = useTranslations("health");
  const [telemetry, setTelemetry] = useState<AisixTelemetry | null>(null);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // StrictMode mounts effects twice; without this guard the first (immediately
  // superseded) interval keeps polling and can setState after unmount.
  const cancelledRef = useRef(false);
  // Consecutive failures — unreachable core backs off exponentially (LOW 14).
  const failuresRef = useRef(0);

  const loadTelemetry = useCallback(async () => {
    // ONE native read. `/api/telemetry/summary` and `/api/monitoring/health` were
    // two Next-only endpoints; on the native transport the first 404'd and the
    // second resolves to the same `:9090/status/models` snapshot this card now
    // reads directly. Fields the native plane does not report stay `null` and
    // render as "—" instead of a fabricated 0.
    try {
      const response = await fetchWithTimeout(aisixStatusModelsUrl(), {
        cache: "no-store",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const next = adaptAisixTelemetry(payload);
      if (cancelledRef.current) return;
      setTelemetry(next);
      setError(null);
      setLastUpdated(new Date());
      failuresRef.current = 0;
      // Only accumulate a sample when the native payload actually reported a
      // counter. Pushing fabricated zeros would draw a convincing flat line
      // where the honest answer is "no data".
      if (next.avgLatencyMs !== null || next.totalRequests !== null) {
        setSamples((prev) => [
          ...prev.slice(Math.max(0, prev.length - MAX_SAMPLES + 1)),
          {
            timestamp: Date.now(),
            latencyMs: next.avgLatencyMs ?? 0,
            throughput: next.totalRequests ?? 0,
            memoryBytes: 0,
          },
        ]);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      failuresRef.current += 1;
      setError(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    cancelledRef.current = false;
    failuresRef.current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelledRef.current) return;
      if (!isDocumentHidden()) {
        await loadTelemetry();
      }
      if (cancelledRef.current) return;
      timer = setTimeout(tick, backoffPollDelayMs(REFRESH_MS, failuresRef.current));
    };
    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadTelemetry]);

  const values = useMemo(() => {
    return {
      uptime: telemetry?.uptime ?? null,
      totalRequests: telemetry?.totalRequests ?? null,
      avgLatency: telemetry?.avgLatencyMs ?? null,
      p95Latency: telemetry?.p95LatencyMs ?? null,
      errorRate: telemetry?.errorRate ?? null,
      activeConnections: telemetry?.activeConnections ?? null,
      hasSignal: telemetry?.hasReportedSignal === true,
    };
  }, [telemetry]);

  const metricCards = [
    {
      label: t("uptime"),
      value: formatDuration(values.uptime),
      icon: "timer",
      tone: "bg-blue-500/10 text-blue-500",
    },
    {
      label: t("totalRequests"),
      value: formatCount(values.totalRequests),
      icon: "receipt_long",
      tone: "bg-primary/10 text-primary",
    },
    {
      label: t("avgLatency"),
      value: formatMs(values.avgLatency),
      icon: "speed",
      tone:
        values.p95Latency === null
          ? "bg-text-muted/10 text-text-muted"
          : getIndicatorTone(values.p95Latency, 2_000, 10_000),
    },
    {
      label: t("errorRate"),
      value: formatPercent(values.errorRate),
      icon: "error",
      tone:
        values.errorRate === null
          ? "bg-text-muted/10 text-text-muted"
          : getIndicatorTone(values.errorRate, 1, 5),
    },
    {
      label: t("activeConnections"),
      value: formatCount(values.activeConnections),
      icon: "hub",
      tone: "bg-cyan-500/10 text-cyan-500",
    },
    {
      label: t("memoryUsage"),
      // The native core reports no RSS/heap figure.
      value: formatBytes(null),
      icon: "memory",
      tone: "bg-violet-500/10 text-violet-500",
    },
  ];

  return (
    <Card className="p-5">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">monitoring</span>
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-text-muted">{t("description")}</p>
          {lastUpdated && (
            <p className="mt-2 text-xs text-text-muted">
              {t("updatedAt", { time: lastUpdated.toLocaleTimeString() })}
            </p>
          )}
        </div>
        <button
          onClick={() => void loadTelemetry()}
          disabled={loading}
          title={t("refresh")}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-sidebar disabled:opacity-40"
        >
          <span
            className={`material-symbols-outlined text-[16px] ${loading ? "animate-spin" : ""}`}
          >
            refresh
          </span>
          {t("refresh")}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {t("partialData", { error })}
        </div>
      )}

      {/* Reachable native core that reports no counters: say so once, instead of
          showing a grid of plausible-looking zeros. */}
      {!error && !loading && !values.hasSignal ? (
        <div className="mb-4 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm text-text-muted">
          {th("notAvailable")}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {metricCards.map((metric) => (
          <div key={metric.label} className="rounded-xl border border-border bg-surface/50 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  {metric.label}
                </p>
                <p className="mt-1 text-xl font-semibold text-text-main">{metric.value}</p>
              </div>
              <span
                className={`material-symbols-outlined rounded-lg p-2 text-[20px] ${metric.tone}`}
              >
                {metric.icon}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
            <span>{t("latencyTrend")}</span>
            <span>{formatMs(values.p95Latency)} p95</span>
          </div>
          <Sparkline samples={samples} field="latencyMs" />
        </div>
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
            <span>{t("throughputTrend")}</span>
            <span>{formatCount(values.totalRequests)}</span>
          </div>
          <Sparkline samples={samples} field="throughput" />
        </div>
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
            <span>{t("memoryTrend")}</span>
            <span>{formatBytes(null)}</span>
          </div>
          {/* No process-memory series natively — always the empty placeholder. */}
          <Sparkline samples={[]} field="memoryBytes" />
        </div>
      </div>
    </Card>
  );
}
