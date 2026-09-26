"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";
import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import { aisixStatusModelsUrl } from "@/shared/utils/aisixEndpoints";
import { normalizeAisixHealthSnapshot } from "@/shared/utils/aisixHealth";
import {
  backoffPollDelayMs,
  fetchWithTimeout,
  isDocumentHidden,
} from "@/shared/utils/fetchTimeout";

type AutopilotAction = {
  type: string;
  label: string;
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  target: {
    provider: string;
    connectionId?: string;
    model?: string;
  };
  preconditionsHash: string;
};

type AutopilotIssue = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  recommendation: string;
  target: AutopilotAction["target"];
  evidence?: Record<string, unknown>;
  actions: AutopilotAction[];
};

type AutopilotProvider = {
  provider: string;
  state: "healthy" | "degraded" | "down";
  score: number;
  signals: {
    connections: {
      total: number;
      active: number;
      cooldown: number;
      terminal: number;
      staleErrors: number;
    };
    modelLockouts: number;
  };
  issues: AutopilotIssue[];
};

type AutopilotReport = {
  status: "healthy" | "warning" | "critical";
  checkedAt: string;
  summary: {
    providerCount: number;
    connectionCount: number;
    issueCount: number;
    actionableCount: number;
  };
  providers: AutopilotProvider[];
};

const STATUS_STYLES: Record<AutopilotReport["status"], string> = {
  healthy: "bg-green-500/10 text-green-400 border-green-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
};

const REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Build the autopilot report the card renders from the ONE native read it has.
 *
 * The card used to `GET /api/providers/health-autopilot`, which on the native
 * transport resolves to `:9090/status/models` — a provider/model state list, not
 * an issue report. Blindly casting it produced a report with `undefined`
 * `providers`/`summary` and silently-zeroed counters. Now the native list is
 * normalized and every field the core cannot report (per-issue diagnosis,
 * connection counts, actions) stays an explicit 0/empty.
 *
 * Issue synthesis itself is a Next/SQLite feature (it reads the connection and
 * lockout tables), so `issues` is always empty and the card renders its
 * "no issues" state instead of a fabricated one.
 */
function buildReportFromNative(snapshot: ReturnType<typeof normalizeAisixHealthSnapshot>) {
  const providers: AutopilotProvider[] = snapshot.providerStatuses.map((status) => ({
    provider: status.provider,
    state: status.state,
    // No native per-connection counters.
    score: status.state === "healthy" ? 100 : status.state === "degraded" ? 50 : 0,
    signals: {
      connections: { total: 0, active: 0, cooldown: 0, terminal: 0, staleErrors: 0 },
      modelLockouts: 0,
    },
    issues: [],
  }));
  const unhealthy = providers.filter((entry) => entry.state !== "healthy").length;
  return {
    status: (unhealthy > 0 ? "warning" : "healthy") as AutopilotReport["status"],
    checkedAt: new Date().toISOString(),
    summary: {
      providerCount: providers.length,
      connectionCount: 0,
      issueCount: 0,
      actionableCount: 0,
    },
    providers,
  } satisfies AutopilotReport;
}

export default function ProviderHealthAutopilotCard() {
  const t = useTranslations("providerHealthAutopilot");
  const nodeMap = useProviderNodeMap();
  const [report, setReport] = useState<AutopilotReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // StrictMode mounts effects twice; without this guard the first (immediately
  // superseded) interval keeps polling and can setState after unmount.
  const cancelledRef = useRef(false);
  // Consecutive failures — unreachable core backs off exponentially (LOW 14).
  const failuresRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(aisixStatusModelsUrl(), {
        cache: "no-store",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (cancelledRef.current) return;
      setReport(buildReportFromNative(normalizeAisixHealthSnapshot(json)));
      setError(null);
      failuresRef.current = 0;
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
        await load();
      }
      if (cancelledRef.current) return;
      timer = setTimeout(tick, backoffPollDelayMs(REFRESH_MS, failuresRef.current));
    };
    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const topProviders = useMemo(
    () =>
      [...(report?.providers ?? [])].sort((left, right) => left.score - right.score).slice(0, 6),
    [report]
  );

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[18px]">health_and_safety</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-main">{t("title")}</h2>
              <p className="text-sm text-text-muted">{t("description")}</p>
            </div>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface/80 disabled:opacity-50"
        >
          {t("refresh")}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <div
          className={`rounded-xl border px-3 py-2 ${STATUS_STYLES[report?.status || "healthy"]}`}
        >
          <p className="text-xs uppercase tracking-wide opacity-80">{t("status")}</p>
          <p className="text-lg font-semibold capitalize">
            {t(`state.${report?.status || "loading"}`)}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-bg-subtle px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-text-muted">{t("issues")}</p>
          <p className="text-lg font-semibold text-text-main">{report?.summary.issueCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-bg-subtle px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-text-muted">{t("actions")}</p>
          <p className="text-lg font-semibold text-text-main">
            {report?.summary.actionableCount ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-bg-subtle px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-text-muted">{t("connections")}</p>
          <p className="text-lg font-semibold text-text-main">
            {report?.summary.connectionCount ?? 0}
          </p>
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : loading && !report ? (
        <p className="mt-4 text-sm text-text-muted">{t("loadingRecommendations")}</p>
      ) : topProviders.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">{t("noRecommendations")}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {topProviders.map((provider) => (
            <div
              key={provider.provider}
              className="rounded-xl border border-border bg-bg-subtle p-4"
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="font-semibold text-text-main">
                    {resolveProviderName(provider.provider, nodeMap)}
                  </h3>
                  <p className="text-xs text-text-muted">
                    {t("providerMetrics", {
                      score: (provider.score * 100).toFixed(0),
                      active: provider.signals.connections.active,
                      total: provider.signals.connections.total,
                      cooldown: provider.signals.connections.cooldown,
                      lockouts: provider.signals.modelLockouts,
                    })}
                  </p>
                </div>
                <span
                  className={`w-fit rounded-full border px-2 py-1 text-xs font-medium ${
                    provider.state === "down"
                      ? "border-red-500/20 bg-red-500/10 text-red-300"
                      : provider.state === "degraded"
                        ? "border-amber-500/20 bg-amber-500/10 text-amber-300"
                        : "border-green-500/20 bg-green-500/10 text-green-300"
                  }`}
                >
                  {t(`providerState.${provider.state}`)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
