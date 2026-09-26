"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Card } from "@/shared/components";
import { aisixResourcesUrl } from "@/shared/utils/aisixEndpoints";
import { fetchWithTimeout } from "@/shared/utils/fetchTimeout";

type ResourcesStatus = {
  version: string | null;
  appliedAt: string | null;
  reachable: boolean;
};

const REFRESH_MS = 30_000;

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parseStatus(payload: unknown): Omit<ResourcesStatus, "reachable"> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { version: null, appliedAt: null };
  }
  const record = payload as Record<string, unknown>;
  const nested =
    record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const version =
    toStringOrNull(record.version) ??
    toStringOrNull(record.resourcesVersion) ??
    (nested ? (toStringOrNull(nested.version) ?? toStringOrNull(nested.resourcesVersion)) : null);
  const appliedAt =
    toStringOrNull(record.applied_at) ??
    toStringOrNull(record.appliedAt) ??
    toStringOrNull(record.updated_at) ??
    toStringOrNull(record.updatedAt) ??
    (nested
      ? (toStringOrNull(nested.applied_at) ??
        toStringOrNull(nested.appliedAt) ??
        toStringOrNull(nested.updated_at))
      : null);
  return { version, appliedAt };
}

function formatAppliedAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toLocaleString();
  return value;
}

export default function HotReloadIndicator() {
  const t = useTranslations("health");
  const [status, setStatus] = useState<ResourcesStatus>({
    version: null,
    appliedAt: null,
    reachable: false,
  });
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const url = aisixResourcesUrl();
      let response = await fetchWithTimeout(url, { cache: "no-store", timeoutMs: 8000 });
      if (!response.ok) {
        response = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
          timeoutMs: 8000,
        });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const parsed = parseStatus(payload);
      setStatus({ ...parsed, reachable: true });
    } catch {
      setStatus((prev) => ({ ...prev, reachable: false }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadStatus();
    })();
    const id = setInterval(() => void loadStatus(), REFRESH_MS);
    return () => clearInterval(id);
  }, [loadStatus]);

  const appliedLabel = formatAppliedAt(status.appliedAt);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">autorenew</span>
            {t("hotReloadTitle")}
          </h2>
          <p className="mt-1 text-sm text-text-muted">{t("hotReloadDescription")}</p>
        </div>
        {status.reachable ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/10 px-2.5 py-1 text-xs font-semibold text-green-400">
            <span className="size-2 rounded-full bg-green-500" />
            {t("hotReloadOk")}
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/50 px-2.5 py-1 text-xs font-semibold text-text-muted">
            <span className="size-2 rounded-full bg-text-muted" />
            {t("hotReloadUnavailable")}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface/50 p-3">
          <p className="text-xs uppercase tracking-wide text-text-muted">{t("version")}</p>
          <p className="mt-1 truncate font-mono text-sm font-semibold text-text-main">
            {status.version ?? t("notAvailable")}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-3">
          <p className="text-xs uppercase tracking-wide text-text-muted">
            {t("hotReloadAppliedAt")}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-text-main">
            {appliedLabel ?? t("notAvailable")}
          </p>
        </div>
      </div>

      {!loading && !status.reachable ? (
        <p className="mt-3 text-sm text-text-muted">{t("hotReloadError")}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void loadStatus()}
        disabled={loading}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-sidebar disabled:opacity-40"
      >
        <span className={`material-symbols-outlined text-[16px] ${loading ? "animate-spin" : ""}`}>
          refresh
        </span>
        {t("refresh")}
      </button>
    </Card>
  );
}
