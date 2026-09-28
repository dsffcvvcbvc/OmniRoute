"use client";

/**
 * CloudSyncStatus — Compact sync status indicator for the sidebar
 *
 * Shows cloud sync connection state with a small icon + label.
 * Fetches status from /api/sync/cloud periodically.
 * Listens for 'cloud-status-changed' events to re-poll immediately.
 *
 * @module shared/components/CloudSyncStatus
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";

// #6147 — user-facing labels renamed from "Cloud …" to "Remote Settings Sync"
// wording (this feature syncs the operator's own settings to their own remote
// store — it is not a cloud/telemetry service). Internal state keys, the
// `cloud_*` material icons and the cloudSync.* wiring are intentionally kept.
const STATUS_CONFIG = {
  connected: { icon: "cloud_done", color: "text-green-500", labelKey: "synced" },
  syncing: { icon: "cloud_sync", color: "text-blue-400 animate-pulse", labelKey: "syncing" },
  disconnected: { icon: "cloud_off", color: "text-amber-500", labelKey: "off" },
  error: { icon: "cloud_off", color: "text-red-400", labelKey: "error" },
  disabled: { icon: "cloud_off", color: "text-text-muted/50", labelKey: "disabled" },
};

export default function CloudSyncStatus({ collapsed = false }) {
  const t = useTranslations("cloudSyncStatus");
  const [status, setStatus] = useState("disabled");
  const [lastSync, setLastSync] = useState(null);
  const mountedRef = useRef(true);
  const router = useRouter();
  // Remote settings sync is a Next.js subsystem with no counterpart in the
  // gateway. The read is skipped rather than fired into a 404 — and note what
  // the 404 used to do: `!res.ok` set the state to "disconnected", which tells
  // the operator their sync is BROKEN. It is not broken; it is not part of this
  // gateway. The `disabled` state below is the honest one, and the reason
  // travels in the title so the control is not a mute mystery.
  const syncSupport = resolveAisixSurfaceSupport("sync", "read");

  const poll = useCallback(async () => {
    if (!syncSupport.supported) {
      if (mountedRef.current) setStatus("disabled");
      return;
    }
    try {
      const res = await fetch("/api/sync/cloud");
      if (!mountedRef.current) return;
      if (!res.ok) {
        setStatus("disconnected");
        return;
      }
      const data = await res.json();
      if (!mountedRef.current) return;

      if (!data.enabled) setStatus("disabled");
      else if (data.syncing) setStatus("syncing");
      else if (data.connected) {
        setStatus("connected");
        if (data.lastSync) setLastSync(new Date(data.lastSync));
      } else setStatus("disconnected");
    } catch {
      if (mountedRef.current) setStatus("disconnected");
    }
  }, [syncSupport.supported]);

  useEffect(() => {
    mountedRef.current = true;

    // Schedule initial poll outside of effect body to avoid setState-in-effect lint
    queueMicrotask(poll);
    const interval = setInterval(poll, 30000);

    // Listen for immediate re-poll events from EndpointPageClient
    const handleCloudChange = () => {
      setTimeout(poll, 500); // Small delay to let backend settle
    };
    globalThis.addEventListener("cloud-status-changed", handleCloudChange);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      globalThis.removeEventListener("cloud-status-changed", handleCloudChange);
    };
  }, [poll]);

  const config = STATUS_CONFIG[status];
  const label = t(config.labelKey);
  // The gateway has no sync subsystem, so the row is rendered as "disabled"
  // with the reason attached — NOT hidden. Rendering nothing was the previous
  // answer for the disabled state, and on a gateway where the feature does not
  // exist at all that reads as a control that silently vanished.
  const unsupportedReason = syncSupport.supported ? null : syncSupport.reason;
  const onClick = syncSupport.supported ? () => router.push("/dashboard/endpoint") : undefined;
  const controlClass = syncSupport.supported
    ? "flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg hover:bg-white/5 transition-colors cursor-pointer w-full"
    : "flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg w-full";

  return (
    <button
      onClick={onClick}
      disabled={!syncSupport.supported}
      className={controlClass}
      data-testid="cloud-sync-status"
      data-unsupported={syncSupport.supported ? undefined : "sync"}
      title={
        unsupportedReason ??
        (lastSync
          ? t("lastSync", {
              status: status === "connected" ? t("connected") : t("disconnected"),
              time: lastSync.toLocaleTimeString(),
            })
          : label)
      }
      aria-label={unsupportedReason ?? t("statusLabel", { status: label })}
    >
      <span className={`material-symbols-outlined text-[16px] ${config.color}`} aria-hidden="true">
        {config.icon}
      </span>
      {!collapsed && (
        <span
          className={`truncate ${status === "connected" ? "text-green-500" : "text-text-muted"}`}
        >
          {label}
        </span>
      )}
    </button>
  );
}
