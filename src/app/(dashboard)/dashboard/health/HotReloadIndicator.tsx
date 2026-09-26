"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Card } from "@/shared/components";
import { aisixAdminModelsUrl } from "@/shared/utils/aisixEndpoints";
import {
  backoffPollDelayMs,
  fetchWithTimeout,
  isDocumentHidden,
} from "@/shared/utils/fetchTimeout";

type ResourcesStatus = {
  version: string | null;
  appliedAt: string | null;
  reachable: boolean;
};

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;

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
  // StrictMode mounts effects twice; without this guard the first (immediately
  // superseded) interval keeps polling and can setState after unmount.
  const cancelledRef = useRef(false);
  // Consecutive failures — unreachable core backs off exponentially (LOW 14).
  // `reachable: false` is the card's honest empty state, not an error.
  const failuresRef = useRef(0);

  const loadStatus = useCallback(async () => {
    // READ ONLY. The native admin plane exposes `POST /admin/v1/resources` as its
    // sole resources verb, so an earlier revision retried a failed GET with
    // `POST {}` — a periodic UNSOLICITED WRITE from a passive status card. The
    // probe now reads the real catalog endpoint and degrades to
    // `reachable: false` on any failure.
    try {
      const response = await fetchWithTimeout(aisixAdminModelsUrl(), {
        cache: "no-store",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const parsed = parseStatus(payload);
      if (cancelledRef.current) return;
      setStatus({ ...parsed, reachable: true });
      failuresRef.current = 0;
    } catch {
      if (cancelledRef.current) return;
      failuresRef.current += 1;
      setStatus((prev) => ({ ...prev, reachable: false }));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    failuresRef.current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelledRef.current) return;
      if (!isDocumentHidden()) {
        await loadStatus();
      }
      if (cancelledRef.current) return;
      timer = setTimeout(tick, backoffPollDelayMs(REFRESH_MS, failuresRef.current));
    };
    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
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
