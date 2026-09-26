"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Card } from "@/shared/components";
import { aisixStatusModelsUrl } from "@/shared/utils/aisixEndpoints";
import { fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import { matchesSearch } from "@/shared/utils/turkishText";

type CooldownRaw = {
  key?: unknown;
  model?: unknown;
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  vendor?: unknown;
  until?: unknown;
  cooldownUntil?: unknown;
  rateLimitedUntil?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
  reason?: unknown;
  lastErrorType?: unknown;
  errorCode?: unknown;
  status?: unknown;
};

type CooldownEntry = {
  key: string;
  provider: string;
  untilMs: number | null;
  untilLabel: string;
  reason: string;
};

const REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8000;

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toUntilMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return ms > 0 ? ms : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && trimmed !== "" && /^\d+(\.\d+)?$/.test(trimmed)) {
      return toUntilMs(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatUntil(untilMs: number | null): string {
  if (untilMs === null) return "—";
  const remaining = untilMs - Date.now();
  if (remaining <= 0) return new Date(untilMs).toLocaleTimeString();
  return `${new Date(untilMs).toLocaleTimeString()} (${Math.ceil(remaining / 1000)}s)`;
}

function extractEntries(payload: unknown): CooldownRaw[] {
  if (Array.isArray(payload)) return payload as CooldownRaw[];
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const field of ["cooldowns", "models", "keys", "data", "items"]) {
      const candidate = record[field];
      if (Array.isArray(candidate)) return candidate as CooldownRaw[];
    }
    if (record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)) {
      const nested = record.data as Record<string, unknown>;
      for (const field of ["cooldowns", "models", "keys", "items"]) {
        const candidate = nested[field];
        if (Array.isArray(candidate)) return candidate as CooldownRaw[];
      }
    }
  }
  return [];
}

function normalizeEntry(raw: CooldownRaw): CooldownEntry {
  const key =
    toStringOrNull(raw.key) ??
    toStringOrNull(raw.model) ??
    toStringOrNull(raw.id) ??
    toStringOrNull(raw.name) ??
    "—";
  const provider = toStringOrNull(raw.provider) ?? toStringOrNull(raw.vendor) ?? "—";
  const untilMs =
    toUntilMs(raw.until) ??
    toUntilMs(raw.cooldownUntil) ??
    toUntilMs(raw.rateLimitedUntil) ??
    toUntilMs(raw.expiresAt) ??
    toUntilMs(raw.expires_at);
  const reason =
    toStringOrNull(raw.reason) ??
    toStringOrNull(raw.lastErrorType) ??
    toStringOrNull(raw.errorCode) ??
    toStringOrNull(raw.status) ??
    "—";
  return { key, provider, untilMs, untilLabel: formatUntil(untilMs), reason };
}

export default function CooldownStatusCard() {
  const t = useTranslations("health");
  const [entries, setEntries] = useState<CooldownEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // StrictMode mounts effects twice; without this guard the first (immediately
  // superseded) interval keeps polling and can setState after unmount.
  const cancelledRef = useRef(false);

  const loadCooldowns = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(aisixStatusModelsUrl(), {
        cache: "no-store",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const now = Date.now();
      // No upper time window: connection cooldowns are exponential
      // (`baseCooldownMs * 2 ** failureIndex`) and reach 5/10 minutes by
      // profile, so a fixed 60s cutoff silently dropped the long ones the card
      // exists to show. Everything with a future timestamp is still cooling.
      const normalized = extractEntries(payload)
        .map(normalizeEntry)
        .filter((entry) => {
          if (entry.untilMs !== null) return entry.untilMs > now;
          return entry.reason.includes("429") || matchesSearch(entry.reason, "cooldown");
        })
        // Soonest expiry first; entries with no deadline last, not first — `?? 0`
        // used to sort a null deadline ahead of every real cooldown.
        .sort((a, b) => (a.untilMs ?? Infinity) - (b.untilMs ?? Infinity));
      if (cancelledRef.current) return;
      setEntries(normalized);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      await loadCooldowns();
    })();
    const id = setInterval(() => void loadCooldowns(), REFRESH_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [loadCooldowns]);

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-amber-500">schedule</span>
            {t("cooldownStatusTitle")}
          </h2>
          <p className="mt-1 text-sm text-text-muted">{t("cooldownStatusDescription")}</p>
          {lastUpdated && (
            <p className="mt-2 text-xs text-text-muted">
              {t("updatedAt", { time: lastUpdated.toLocaleTimeString() })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void loadCooldowns()}
          disabled={loading}
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

      {error ? (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {t("cooldownLoadFailed", { error })}
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="rounded-xl border border-border bg-bg-subtle p-6 text-center text-sm text-text-muted">
          {t("loadingHealth")}
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-border bg-bg-subtle p-6 text-center text-sm text-text-muted">
          {t("cooldownEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface/50 text-left">
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  {t("cooldownColKey")}
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  {t("cooldownColProvider")}
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  {t("cooldownColUntil")}
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  {t("cooldownColReason")}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={`${entry.provider}::${entry.key}::${entry.untilMs ?? entry.reason}`}
                  className="border-t border-border/40"
                >
                  <td className="max-w-45 truncate px-3 py-2 font-mono text-xs text-text-main">
                    {entry.key}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-main">{entry.provider}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-amber-400">
                    {entry.untilLabel}
                  </td>
                  <td className="max-w-60 truncate px-3 py-2 text-xs text-text-muted">
                    {entry.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
