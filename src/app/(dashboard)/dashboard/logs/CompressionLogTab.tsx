"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  savingsPercent: number;
  techniquesUsed: string[];
  mode: string;
  timestamp: number;
  rulesApplied?: string[];
  durationMs?: number;
}

interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  compressionStats?: CompressionStats | null;
}

export default function CompressionLogTab() {
  const t = useTranslations("logs");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  // Compression stats are attached to Next.js-only call-log rows, so the AISIX
  // gateway has nothing to read here. Previously the 404 landed in a
  // `.catch(() => {})` and the tab rendered "no compression events", which
  // reads as a healthy empty state rather than a missing subsystem.
  const logsRead = resolveAisixSurfaceSupport("logs", "read");
  const logsSupported = logsRead.supported;

  useEffect(() => {
    if (!logsSupported) return;
    let alive = true;
    void (async () => {
      const result = await fetchAisixJson(
        resolveAisixRequestUrl("/api/logs?filter=compressed&limit=50")
      );
      if (!alive) return;
      if (!result.ok) {
        setReadError(`${t("compressionLogEmpty")} (${result.error})`);
        setLogs([]);
      } else {
        const data = result.data;
        setLogs(Array.isArray(data) ? (data as LogEntry[]) : []);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [logsSupported, t]);

  // Derived from the build-time support flag: a gateway with no call-log store
  // has nothing to load, so the tab must not sit in its loading state.
  const unavailableReason = !logsSupported ? logsRead.reason : readError;
  const isLoading = logsSupported && loading;

  if (isLoading) {
    return (
      <Card className="p-6">
        <p className="text-sm text-text-muted">{t("loading")}</p>
      </Card>
    );
  }

  if (unavailableReason) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="material-symbols-outlined text-blue-500 text-[20px]">compress</span>
          <h3 className="text-lg font-semibold">{t("compressionLogTitle")}</h3>
        </div>
        <div
          role="status"
          data-testid="compression-log-unavailable"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200"
        >
          {unavailableReason}
        </div>
      </Card>
    );
  }

  if (logs.length === 0) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="material-symbols-outlined text-blue-500 text-[20px]">compress</span>
          <h3 className="text-lg font-semibold">{t("compressionLogTitle")}</h3>
        </div>
        <p className="text-sm text-text-muted">{t("compressionLogEmpty")}</p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <span className="material-symbols-outlined text-blue-500 text-[20px]">compress</span>
        <h3 className="text-lg font-semibold">{t("compressionLogTitle")}</h3>
      </div>

      <div className="space-y-3">
        {logs.map((entry) => {
          const stats = entry.compressionStats;
          if (!stats) return null;

          return (
            <div
              key={entry.id}
              className="p-3 rounded-lg border border-border/50 bg-surface/30 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-text-main">
                    {entry.provider}/{entry.model}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    {stats.mode}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span>
                    {stats.originalTokens} → {stats.compressedTokens} {t("tokens")}
                  </span>
                  <span
                    className={`font-medium ${
                      stats.savingsPercent >= 25
                        ? "text-emerald-400"
                        : stats.savingsPercent >= 10
                          ? "text-yellow-400"
                          : "text-text-muted"
                    }`}
                  >
                    -{stats.savingsPercent.toFixed(1)}%
                  </span>
                  {stats.durationMs !== undefined && <span>{stats.durationMs}ms</span>}
                </div>
              </div>

              {stats.techniquesUsed.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {stats.techniquesUsed.map((technique) => (
                    <span
                      key={technique}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-surface text-text-muted border border-border/30"
                    >
                      {technique}
                    </span>
                  ))}
                </div>
              )}

              {stats.rulesApplied && stats.rulesApplied.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {stats.rulesApplied.map((rule) => (
                    <span
                      key={rule}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20"
                    >
                      {rule.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
