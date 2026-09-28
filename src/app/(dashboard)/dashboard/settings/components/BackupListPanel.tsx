"use client";

import { useTranslations } from "next-intl";
import { Badge, Button } from "@/shared/components";
import { formatBytes } from "./systemStorageFormat";

interface BackupEntry {
  id: string;
  createdAt: string;
  size: number;
  connectionCount: number;
  reason: string;
}

/**
 * The expandable list of database backups. Restoring is a two-step
 * confirmation, so the tab owns which backup is armed (`confirmRestoreId`) and
 * performs the restore; this panel only reports the intent.
 */
export function BackupListPanel({
  backups,
  loading,
  locale,
  restoringId,
  confirmRestoreId,
  onRefresh,
  onRequestRestore,
  onCancelRestore,
  onRestore,
}: {
  backups: BackupEntry[];
  loading: boolean;
  locale: string;
  restoringId: string | null;
  confirmRestoreId: string | null;
  onRefresh: () => void;
  onRequestRestore: (backupId: string) => void;
  onCancelRestore: () => void;
  onRestore: (backupId: string) => void;
}) {
  const t = useTranslations("settings");

  const formatBackupReason = (reason: string) => {
    if (reason === "manual") return t("backupReasonManual");
    if (reason === "pre-restore") return t("backupReasonPreRestore");
    return reason;
  };

  return (
    <div className="flex flex-col gap-2 mt-3">
      {loading ? (
        <div className="flex items-center justify-center py-6 text-text-muted">
          <span
            className="material-symbols-outlined animate-spin text-[20px] mr-2"
            aria-hidden="true"
          >
            progress_activity
          </span>
          {t("loadingBackups")}
        </div>
      ) : backups.length === 0 ? (
        <div className="text-center py-6 text-text-muted text-sm">
          <span
            className="material-symbols-outlined text-[32px] mb-2 block opacity-40"
            aria-hidden="true"
          >
            folder_off
          </span>
          {t("noBackupsYet")}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-muted">
              {t("backupsAvailable", { count: backups.length })}
            </span>
            <button
              onClick={onRefresh}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                refresh
              </span>
              {t("refresh")}
            </button>
          </div>
          {backups.map((backup) => (
            <div
              key={backup.id}
              className="flex items-center justify-between p-3 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] border border-border/50 hover:border-border transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="material-symbols-outlined text-[16px] text-amber-500"
                    aria-hidden="true"
                  >
                    description
                  </span>
                  <span className="text-sm font-medium truncate">
                    {new Date(backup.createdAt).toLocaleString(locale)}
                  </span>
                  <Badge
                    variant={
                      backup.reason === "pre-restore"
                        ? "warning"
                        : backup.reason === "manual"
                          ? "success"
                          : "default"
                    }
                    size="sm"
                  >
                    {formatBackupReason(backup.reason)}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted ml-6">
                  <span>{t("connectionsCount", { count: backup.connectionCount })}</span>
                  <span>•</span>
                  <span>{formatBytes(backup.size)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3">
                {confirmRestoreId === backup.id ? (
                  <>
                    <span className="text-xs text-amber-500 font-medium">{t("confirm")}</span>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => onRestore(backup.id)}
                      loading={restoringId === backup.id}
                      className="!bg-amber-500 hover:!bg-amber-600"
                    >
                      {t("yes")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={onCancelRestore}>
                      {t("no")}
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => onRequestRestore(backup.id)}>
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      restore
                    </span>
                    {t("restore")}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
