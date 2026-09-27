"use client";

/**
 * Health Dashboard — Phase 8.3
 *
 * System health overview with cards for:
 * - System status (uptime, version, memory)
 * - Provider health (circuit breaker states)
 * - Rate limit status
 * - Active lockouts
 * - Signature cache stats
 * - Latency telemetry & prompt cache
 */

import { useState, useEffect, useCallback, useRef } from "react";

import { Card } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderDisplayName } from "@/lib/display/names";
import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import { aisixStatusModelsUrl } from "@/shared/utils/aisixEndpoints";
import { normalizeAisixHealthSnapshot } from "@/shared/utils/aisixHealth";
import {
  backoffPollDelayMs,
  fetchWithTimeout,
  isDocumentHidden,
} from "@/shared/utils/fetchTimeout";
import { compareTr } from "@/shared/utils/turkishText";
import { useLocale, useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import TelemetryCard from "./TelemetryCard";
import ProviderHealthAutopilotCard from "./ProviderHealthAutopilotCard";
import ProviderHealthMatrixCard from "./ProviderHealthMatrixCard";
import CooldownStatusCard from "./CooldownStatusCard";
import HotReloadIndicator from "./HotReloadIndicator";

const REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8000;

function formatUptime(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const total = Number(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRelativeTime(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "<1m";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

const CB_STYLES = {
  CLOSED: { bg: "bg-green-500/10", text: "text-green-500", labelKey: "healthy" },
  OPEN: { bg: "bg-red-500/10", text: "text-red-500", labelKey: "down" },
  HALF_OPEN: { bg: "bg-amber-500/10", text: "text-amber-500", labelKey: "recovering" },
};

export default function HealthPage() {
  const locale = useLocale();
  const t = useTranslations("health");
  const tc = useTranslations("common");
  const tp = useTranslations("providers");
  const notify = useNotificationStore();
  const nodeMap = useProviderNodeMap();
  // Native snapshot (see normalizeAisixHealthSnapshot): every field the Rust core
  // cannot report stays null, so the page renders explicit "n/a" / empty states
  // instead of undefined-property crashes or invented zeros.
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [unblocking, setUnblocking] = useState(false);
  const [unblockingKey, setUnblockingKey] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // StrictMode mounts effects twice; without this guard the first (immediately
  // superseded) interval keeps polling and can setState after unmount.
  const cancelledRef = useRef(false);
  // Consecutive failed polls — drives the exponential backoff below so an
  // unreachable core is re-probed on a slowing schedule, not every 15s forever.
  const failuresRef = useRef(0);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(aisixStatusModelsUrl(), {
        cache: "no-store",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (cancelledRef.current) return;
      setData(normalizeAisixHealthSnapshot(json));
      setError(null);
      setLastRefresh(new Date());
      failuresRef.current = 0;
    } catch (err) {
      if (cancelledRef.current) return;
      failuresRef.current += 1;
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    failuresRef.current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelledRef.current) return;
      // Backgrounded tab: skip the probe (the refresh happens on return).
      if (!isDocumentHidden()) {
        await fetchHealth();
      }
      if (cancelledRef.current) return;
      timer = setTimeout(tick, backoffPollDelayMs(REFRESH_MS, failuresRef.current));
    };
    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchHealth]);

  // Circuit-breaker reset is a WRITE. The native admin plane only accepts
  // `POST /admin/v1/resources`, so there is no native reset verb and the old
  // `DELETE /api/monitoring/health` would 404. The reset action is therefore
  // gone; the individual per-model unblock below is equally native-less and
  // kept only for the rows the snapshot reports.
  // Both unblock actions target the Next-only `/api/resilience/model-cooldowns`
  // route: without a snapshot (core unreachable) there is nothing to unblock,
  // so the buttons render disabled, and every failure surfaces as a toast —
  // never a silent console.error. Messages are literals on purpose: the health
  // catalog has no keys for them and the completeness gate forbids adding
  // en-only keys.
  const handleUnblockAll = async () => {
    if (!data) {
      notify.error("Core unreachable — nothing to unblock.");
      return;
    }
    setUnblocking(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        notify.error(
          detail
            ? `Failed to unblock models: ${detail.slice(0, 200)}`
            : `Failed to unblock models (HTTP ${res.status}).`
        );
        return;
      }
      await fetchHealth();
    } catch (err) {
      console.error("Failed to unblock all models:", err);
      notify.error("Failed to unblock models.");
    } finally {
      setUnblocking(false);
    }
  };

  const handleUnblockOne = async (provider: string, model: string) => {
    if (!data) {
      notify.error("Core unreachable — nothing to unblock.");
      return;
    }
    const key = `${provider}::${model}`;
    setUnblockingKey(key);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        notify.error(
          detail
            ? `Failed to unblock ${provider}/${model}: ${detail.slice(0, 200)}`
            : `Failed to unblock ${provider}/${model} (HTTP ${res.status}).`
        );
        return;
      }
      await fetchHealth();
    } catch (err) {
      console.error(`Failed to unblock ${provider}/${model}:`, err);
      notify.error(`Failed to unblock ${provider}/${model}.`);
    } finally {
      setUnblockingKey(null);
    }
  };

  const fmtMs = (ms) =>
    ms != null ? t("millisecondsShort", { value: Math.round(ms) }) : t("notAvailable");

  const notAvailable = t("notAvailable");

  if (!data && !error) {
    return (
      <div className="flex items-center justify-center min-h-100">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <p className="text-text-muted mt-4">{t("loadingHealth")}</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center">
          <span className="material-symbols-outlined text-red-500 text-[32px] mb-2">error</span>
          <p className="text-red-400">{t("failedToLoad", { error })}</p>
          <button
            onClick={fetchHealth}
            className="mt-4 px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm hover:bg-primary/20 transition-colors"
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  const {
    system,
    providerHealth,
    providerSummary,
    rateLimitStatus,
    learnedLimits,
    lockouts,
    sessions,
    quotaMonitor,
  } = data;
  // The verdict comes from the parsed status/models list, never from a
  // server-supplied `data.status` — the native payload has no such field, so
  // reading it always fell through to "action required".
  const verdict = data.verdict;
  const verdictHealthy = verdict === "healthy";
  const cbEntries = Object.entries(providerHealth || {});
  const lockoutEntries = Object.entries(lockouts || {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-3">
        {lastRefresh && (
          <span className="text-xs text-text-muted">
            {t("updatedAt", { time: lastRefresh.toLocaleTimeString(locale) })}
          </span>
        )}
        <button
          onClick={() => {
            fetchHealth();
          }}
          className="p-2 rounded-lg bg-surface hover:bg-surface/80 text-text-muted hover:text-text-main transition-colors"
          title={tc("refresh")}
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
        </button>
      </div>

      {/* Verdict Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">
          {verdict === "healthy"
            ? t("healthVerdictReady")
            : verdict === "cooling"
              ? t("healthVerdictCoolingDown")
              : t("healthVerdictActionRequired")}
        </h1>
        <p className="text-text-muted text-lg">{t("healthSubtitle")}</p>
      </div>

      {/* Status Details */}
      <div
        role="status"
        aria-live="polite"
        className={`rounded-xl p-4 flex items-center gap-3 ${
          verdictHealthy
            ? "bg-green-500/10 border border-green-500/20"
            : "bg-red-500/10 border border-red-500/20"
        }`}
      >
        <span
          className={`material-symbols-outlined text-[24px] ${
            verdictHealthy ? "text-green-500" : "text-red-500"
          }`}
        >
          {verdictHealthy ? "check_circle" : "error"}
        </span>
        <span className={verdictHealthy ? "text-green-400" : "text-red-400"}>
          {verdictHealthy ? t("allOperational") : t("issuesDetected")}
        </span>
      </div>

      {/* Advanced Diagnostics Section */}
      <div className="mt-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">{t("advancedDiagnosticsTitle")}</h2>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-primary hover:underline"
          >
            {showAdvanced ? t("hide") : t("show")}
          </button>
        </div>
        <div className={showAdvanced ? "block" : "hidden"}>
          <TelemetryCard />
          <ProviderHealthAutopilotCard />
          <ProviderHealthMatrixCard />
          <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
            <CooldownStatusCard />
            <HotReloadIndicator />
          </div>
        </div>
      </div>

      {/* Database diagnostics. The Rust core has no SQLite, so there is no
          /api/db/health to read and no auto-repair to POST — the card renders an
          explicit "not available" state instead of a permanent amber warning. */}
      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center justify-center size-9 rounded-lg bg-surface text-text-muted">
                <span className="material-symbols-outlined text-[18px]">database</span>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-main">{t("databaseHealth")}</h2>
                <p className="text-sm text-text-muted">{t("databaseHealthDescription")}</p>
              </div>
            </div>
            <p className="mt-4 rounded-xl border border-border bg-surface/50 px-3 py-2 text-sm text-text-muted">
              {notAvailable}
            </p>
          </div>
        </div>
      </Card>

      {/* System Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex items-center justify-center size-8 rounded-lg bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[18px]">timer</span>
            </div>
            <span className="text-sm text-text-muted">{t("uptime")}</span>
          </div>
          <p className="text-xl font-semibold text-text-main">
            {system ? (formatUptime(system.uptime) ?? notAvailable) : notAvailable}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex items-center justify-center size-8 rounded-lg bg-blue-500/10 text-blue-500">
              <span className="material-symbols-outlined text-[18px]">info</span>
            </div>
            <span className="text-sm text-text-muted">{t("version")}</span>
          </div>
          <p className="text-xl font-semibold text-text-main">
            {system?.version ? `v${system.version}` : notAvailable}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {system?.nodeVersion ? t("nodeVersion", { version: system.nodeVersion }) : notAvailable}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex items-center justify-center size-8 rounded-lg bg-purple-500/10 text-purple-500">
              <span className="material-symbols-outlined text-[18px]">memory</span>
            </div>
            <span className="text-sm text-text-muted">{t("memoryRss")}</span>
          </div>
          {/* The Rust core exposes no process RSS/heap reading. */}
          <p className="text-xl font-semibold text-text-main">{notAvailable}</p>
          <p className="text-xs text-text-muted mt-1">
            {t("heap")}: {notAvailable}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex items-center justify-center size-8 rounded-lg bg-amber-500/10 text-amber-500">
              <span className="material-symbols-outlined text-[18px]">dns</span>
            </div>
            <span className="text-sm text-text-muted">{t("providers")}</span>
          </div>
          <p className="text-xl font-semibold text-text-main">
            {providerSummary?.configuredCount ?? cbEntries.length}
          </p>
          <p
            className="text-[11px] text-text-muted mt-1 inline-flex items-center gap-1"
            title={t("configuredProvidersHint")}
          >
            {t("configuredProvidersLabel")}
            <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
              help
            </span>
          </p>
          <p
            className="text-xs text-text-muted inline-flex items-center gap-1"
            title={t("activeProvidersHint")}
          >
            {t("activeProviders", { count: providerSummary?.activeCount ?? 0 })}
            <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
              info
            </span>
          </p>
          <p
            className="text-xs text-text-muted inline-flex items-center gap-1"
            title={t("monitoredProvidersHint")}
          >
            {t("monitoredProviders", {
              count: providerSummary?.monitoredCount ?? cbEntries.length,
            })}
            <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
              info
            </span>
          </p>
        </Card>
      </div>

      {/* Session & Quota Observability */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary">groups</span>
              {t("sessionActivity")}
            </h2>
            <span className="text-xs text-text-muted">
              {/* The native core reports no session counters (`sessions` stays
                  null) — render "—", never a fabricated 0. */}
              {t("activeCount", { count: sessions?.activeCount ?? notAvailable })}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("stickyBoundSessions")}</div>
              <div className="text-2xl font-semibold text-text-main mt-1">
                {sessions?.stickyBoundCount ?? notAvailable}
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("sessionsByApiKey")}</div>
              <div className="text-2xl font-semibold text-text-main mt-1">
                {sessions?.byApiKey ? Object.keys(sessions.byApiKey).length : notAvailable}
              </div>
            </div>
          </div>
          {sessions?.top?.length > 0 ? (
            <div className="space-y-2">
              {sessions.top.slice(0, 5).map((session: any) => (
                <div
                  key={session.sessionId}
                  className="rounded-lg border border-border/30 bg-surface/20 p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-text-main truncate">
                      {session.sessionId}
                    </div>
                    <div className="text-xs text-text-muted mt-1">
                      {t("requestCount", { count: session.requestCount })}
                      {session.connectionId ? ` • ${session.connectionId.slice(0, 8)}…` : ""}
                    </div>
                  </div>
                  <div className="text-right text-xs text-text-muted shrink-0">
                    <div>
                      {t("idleSeconds", { count: Math.round((session.idleMs || 0) / 1000) })}
                    </div>
                    <div>{t("ageSeconds", { count: Math.round((session.ageMs || 0) / 1000) })}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("noActiveSessionsTracked")}</p>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary">radar</span>
              {t("quotaMonitors")}
            </h2>
            <span className="text-xs text-text-muted">
              {/* Same as sessions above: the native core reports no quota
                  counters (`quotaMonitor` stays null) — "—", not 0. */}
              {t("activeCount", { count: quotaMonitor?.active ?? notAvailable })}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("alerting")}</div>
              <div className="text-2xl font-semibold text-amber-400 mt-1">
                {quotaMonitor?.alerting ?? notAvailable}
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("limitExhausted")}</div>
              <div className="text-2xl font-semibold text-red-400 mt-1">
                {quotaMonitor?.exhausted ?? notAvailable}
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("errors")}</div>
              <div className="text-2xl font-semibold text-orange-400 mt-1">
                {quotaMonitor?.errors ?? notAvailable}
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-surface/30 p-3">
              <div className="text-xs text-text-muted">{t("providers")}</div>
              <div className="text-2xl font-semibold text-text-main mt-1">
                {quotaMonitor?.byProvider
                  ? Object.keys(quotaMonitor.byProvider).length
                  : notAvailable}
              </div>
            </div>
          </div>
          {quotaMonitor?.monitors?.length > 0 ? (
            <div className="space-y-2">
              {quotaMonitor.monitors.slice(0, 5).map((monitor: any) => (
                <div
                  key={`${monitor.sessionId}:${monitor.accountId}`}
                  className="rounded-lg border border-border/30 bg-surface/20 p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-main truncate">
                      {monitor.provider} • {monitor.accountId.slice(0, 8)}…
                    </div>
                    <div className="text-xs text-text-muted mt-1 truncate">
                      {monitor.sessionId} • {monitor.status}
                    </div>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    <div
                      className={
                        monitor.status === "exhausted"
                          ? "text-red-400"
                          : monitor.status === "warning"
                            ? "text-amber-400"
                            : monitor.status === "error"
                              ? "text-orange-400"
                              : "text-text-main"
                      }
                    >
                      {typeof monitor.lastQuotaPercent === "number"
                        ? `${Math.round(monitor.lastQuotaPercent * 100)}%`
                        : "—"}
                    </div>
                    <div className="text-text-muted">
                      {monitor.nextPollDelayMs
                        ? `${Math.round(monitor.nextPollDelayMs / 1000)}s`
                        : "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("noSessionQuotaMonitorsActive")}</p>
          )}
        </Card>
      </div>

      {/* Prompt + signature cache stats. Both are Next/SQLite surfaces with no
          native read path, so they render an explicit empty state rather than
          404-ing on /api/cache/stats and /api/rate-limits every 15s. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-text-muted mb-3 flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">cached</span>
            {t("promptCache")}
          </h3>
          <p className="text-sm text-text-muted">{notAvailable}</p>
        </Card>

        <Card className="p-4">
          <h3 className="text-sm font-semibold text-text-muted mb-3 flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">database</span>
            {t("signatureCache")}
          </h3>
          <p className="text-sm text-text-muted">{notAvailable}</p>
        </Card>
      </div>

      {/* Provider Health */}
      <Card className="p-5" role="region" aria-label={t("providerHealthStatusAria")}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-primary">
              health_and_safety
            </span>
            {t("providerHealth")}
          </h2>
          <div className="flex items-center gap-3">
            {cbEntries.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-green-500" /> {t("healthy")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-amber-500" /> {t("recovering")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-red-500" /> {t("down")}
                </span>
              </div>
            )}
          </div>
        </div>
        {cbEntries.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-4">{t("noCBData")}</p>
        ) : (
          (() => {
            const unhealthy = cbEntries.filter(([, cb]: [string, any]) => cb.state !== "CLOSED");
            const healthy = cbEntries.filter(([, cb]: [string, any]) => cb.state === "CLOSED");
            return (
              <div className="space-y-4">
                {/* Unhealthy providers first */}
                {unhealthy.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-red-400 uppercase tracking-wide">
                      {t("issuesLabel")}
                    </p>
                    {unhealthy.map(([provider, cb]: [string, any]) => {
                      const style = CB_STYLES[cb.state] || CB_STYLES.OPEN;
                      const providerInfo = AI_PROVIDERS[provider];
                      const displayName = getProviderDisplayName(
                        provider,
                        nodeMap.get(provider) ?? providerInfo
                      );
                      return (
                        <div
                          key={provider}
                          className={`rounded-lg p-3 ${style.bg} border border-white/5 flex items-center gap-3`}
                        >
                          <div
                            className="size-8 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold"
                            style={{
                              backgroundColor: `${providerInfo?.color || "#888"}15`,
                              color: providerInfo?.color || "#888",
                            }}
                          >
                            {providerInfo?.textIcon || provider.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text-main truncate">
                                {displayName}
                              </span>
                              <span
                                className={`text-xs font-semibold px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}
                              >
                                {t(style.labelKey)}
                              </span>
                            </div>
                            <div className="text-xs text-text-muted mt-0.5">
                              {cb.failures === 1
                                ? t("failures", { count: cb.failures })
                                : t("failuresPlural", { count: cb.failures })}
                              {Number(cb.retryAfterMs) > 0 && (
                                <span className="ml-2">
                                  · {t("retryIn", { duration: fmtMs(cb.retryAfterMs) })}
                                </span>
                              )}
                              {cb.lastFailure && (
                                <span className="ml-2">
                                  · {t("lastFailure")}:{" "}
                                  {new Date(cb.lastFailure).toLocaleTimeString(locale)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Healthy providers in compact grid */}
                {healthy.length > 0 && (
                  <div>
                    {unhealthy.length > 0 && (
                      <p className="text-xs font-medium text-green-400 uppercase tracking-wide mb-2">
                        {t("operational")}
                      </p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                      {healthy.map(([provider]) => {
                        const providerInfo = AI_PROVIDERS[provider];
                        const displayName = getProviderDisplayName(
                          provider,
                          nodeMap.get(provider) ?? providerInfo
                        );
                        return (
                          <div
                            key={provider}
                            className="rounded-lg p-2.5 bg-green-500/5 border border-white/5 flex items-center gap-2"
                          >
                            <span className="size-2 rounded-full bg-green-500 shrink-0" />
                            <span
                              className="text-xs font-medium text-text-main truncate"
                              title={displayName}
                            >
                              {displayName}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()
        )}
      </Card>

      {/* Rate Limit Status */}
      {rateLimitStatus &&
        Object.keys(rateLimitStatus).length > 0 &&
        (() => {
          // Parse rate limit keys ("provider:connectionId" or "provider:connectionId:model")
          const parseKey = (key) => {
            const parts = key.split(":");
            const providerId = parts[0];
            const connectionId = parts[1] || "";
            const model = parts.slice(2).join(":") || null;

            // Resolve friendly name — prefer user-given name from provider node map
            let providerInfo = AI_PROVIDERS[providerId];
            const displayName = resolveProviderName(providerId, nodeMap);

            return { providerId, displayName, providerInfo, connectionId, model };
          };

          // Group entries by provider for a cleaner display
          const entries = Object.entries(rateLimitStatus).map(([key, status]: [string, any]) => ({
            key,
            ...parseKey(key),
            status,
          }));

          // Sort: active (queued/running > 0) first, then alphabetically
          entries.sort((a, b) => {
            const aActive = (a.status.queued || 0) + (a.status.running || 0);
            const bActive = (b.status.queued || 0) + (b.status.running || 0);
            if (aActive !== bActive) return bActive - aActive;
            return compareTr(a.displayName, b.displayName);
          });

          return (
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px] text-amber-500">
                    speed
                  </span>
                  {t("rateLimitStatus")}
                </h2>
                <span className="text-xs text-text-muted">
                  {entries.length === 1
                    ? t("activeLimiters", { count: entries.length })
                    : t("activeLimitersPlural", { count: entries.length })}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {entries.map(
                  ({ key, displayName, providerInfo, connectionId, model, status }: any) => {
                    const learned = learnedLimits?.[key] || null;
                    const isActive = (status.queued || 0) + (status.running || 0) > 0;
                    const isQueued = (status.queued || 0) > 0;
                    const learnedLimit =
                      typeof learned?.limit === "number" && learned.limit > 0
                        ? learned.limit
                        : null;
                    const learnedRemaining =
                      typeof learned?.remaining === "number" ? learned.remaining : null;
                    const learnedMinTime =
                      typeof learned?.minTime === "number" && learned.minTime > 0
                        ? learned.minTime
                        : null;
                    const learnedLastUpdated =
                      typeof learned?.lastUpdated === "number" ? learned.lastUpdated : null;
                    const lowRemaining =
                      learnedLimit != null &&
                      learnedRemaining != null &&
                      learnedRemaining / learnedLimit <= 0.1;
                    const exhausted = learnedRemaining != null && learnedRemaining <= 0;
                    const quotaProgress =
                      learnedLimit != null && learnedRemaining != null
                        ? Math.max(0, Math.min(100, (learnedRemaining / learnedLimit) * 100))
                        : null;
                    return (
                      <div
                        key={key}
                        className={`rounded-lg p-3 border transition-colors ${
                          exhausted
                            ? "bg-red-500/5 border-red-500/20"
                            : isQueued || lowRemaining
                              ? "bg-amber-500/5 border-amber-500/20"
                              : isActive
                                ? "bg-blue-500/5 border-blue-500/15"
                                : "bg-surface/30 border-white/5"
                        }`}
                        title={key}
                      >
                        <div className="flex items-center gap-2.5 mb-2">
                          <div
                            className="size-7 rounded-md flex items-center justify-center shrink-0 text-[10px] font-bold"
                            style={{
                              backgroundColor: `${providerInfo?.color || "#888"}15`,
                              color: providerInfo?.color || "#888",
                            }}
                          >
                            {providerInfo?.textIcon || displayName.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-main truncate">
                              {displayName}
                            </p>
                            {connectionId && (
                              <p className="text-[10px] text-text-muted font-mono truncate">
                                {connectionId.length > 12
                                  ? connectionId.slice(0, 8) + "…"
                                  : connectionId}
                                {model && (
                                  <span className="ml-1 text-text-muted/60">· {model}</span>
                                )}
                              </p>
                            )}
                          </div>
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              exhausted
                                ? "bg-red-500/15 text-red-400"
                                : isQueued || lowRemaining
                                  ? "bg-amber-500/15 text-amber-400"
                                  : isActive
                                    ? "bg-blue-500/15 text-blue-400"
                                    : "bg-green-500/10 text-green-400"
                            }`}
                          >
                            {exhausted
                              ? t("limitExhausted")
                              : isQueued || lowRemaining
                                ? t("queued")
                                : isActive
                                  ? tc("active")
                                  : t("ok")}
                          </span>
                        </div>
                        {quotaProgress != null && (
                          <div className="mb-3">
                            <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                              <span>{t("learnedFromHeaders")}</span>
                              <span>
                                {t("remainingOfLimit", {
                                  remaining: learnedRemaining,
                                  limit: learnedLimit,
                                })}
                              </span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-surface/70">
                              <div
                                className={`h-full rounded-full ${
                                  exhausted
                                    ? "bg-red-500"
                                    : lowRemaining
                                      ? "bg-amber-500"
                                      : "bg-emerald-500"
                                }`}
                                style={{ width: `${quotaProgress}%` }}
                              />
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-3 text-[11px] text-text-muted">
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-[12px]">schedule</span>
                            {t("queuedCount", { count: status.queued || 0 })}
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-[12px]">
                              play_arrow
                            </span>
                            {t("runningCount", { count: status.running || 0 })}
                          </span>
                        </div>
                        {(learnedMinTime != null || learnedLastUpdated != null) && (
                          <div className="mt-3 space-y-1 text-[11px] text-text-muted">
                            {learnedMinTime != null && (
                              <p>{t("throttleStatus", { value: `${learnedMinTime}ms/req` })}</p>
                            )}
                            {learnedLastUpdated != null && (
                              <p>
                                {t("lastHeaderUpdate", {
                                  age: formatRelativeTime(learnedLastUpdated) || t("notAvailable"),
                                })}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }
                )}
              </div>
            </Card>
          );
        })()}

      {/* Active Lockouts */}
      {lockoutEntries.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-red-500">lock</span>
              {t("activeLockouts")}
            </h2>
            <button
              onClick={handleUnblockAll}
              disabled={unblocking || !data}
              title={!data ? "Core unreachable — nothing to unblock." : undefined}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                bg-amber-500/10 border border-amber-500/30 text-amber-600
                hover:bg-amber-500/15 hover:border-amber-500/50
                dark:text-amber-400 transition-all duration-200
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[16px]">lock_open</span>
              {unblocking ? "Unblocking..." : "Unblock all"}
            </button>
          </div>
          <div className="space-y-2">
            {lockoutEntries.map(([key, lockout]: [string, any]) => {
              const lockProvider = lockout.provider as string;
              const lockModel = lockout.model as string;
              const lockKey = `${lockProvider}::${lockModel}`;
              return (
                <div
                  key={key}
                  className="rounded-lg p-3 bg-red-500/5 border border-red-500/10 flex items-center justify-between"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-text-main">
                      {lockProvider}/{lockModel}
                    </span>
                    {lockout.reason && (
                      <span className="text-xs text-text-muted ml-2">({lockout.reason})</span>
                    )}
                    {lockout.until && (
                      <span className="text-xs text-red-400 ml-2">
                        until {new Date(lockout.until).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleUnblockOne(lockProvider, lockModel)}
                    disabled={unblockingKey === lockKey || !data}
                    title={!data ? "Core unreachable — nothing to unblock." : undefined}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg
                      bg-amber-500/10 border border-amber-500/20 text-amber-600
                      hover:bg-amber-500/15 hover:border-amber-500/40
                      dark:text-amber-400 transition-all duration-200
                      disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    <span className="material-symbols-outlined text-[14px]">lock_open</span>
                    {unblockingKey === lockKey ? "..." : "Unblock"}
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
