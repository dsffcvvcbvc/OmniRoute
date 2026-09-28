"use client";

import { useTranslations } from "next-intl";
import { Button, Input, Modal } from "@/shared/components";
import { MAX_KEY_NAME_LENGTH } from "../apiManagerPageUtils";

/**
 * The "create API key" form. It owns no state: the page holds the draft so the
 * name field can be scrolled into view and focused when validation fails, and so
 * the same values survive the modal's open/close cycle. `onCancel` and the
 * modal's close button both reset the draft through the page's `onClose`.
 */
export function AddApiKeyModal({
  isOpen,
  isSubmitting,
  name,
  nameError,
  createError,
  manageEnabled,
  selfUsageEnabled,
  accountQuotaEnabled,
  usageCommandEnabled,
  nameInputId,
  formRef,
  nameFieldRef,
  onClose,
  onNameChange,
  onManageToggle,
  onSelfUsageToggle,
  onAccountQuotaToggle,
  onUsageCommandToggle,
  onSubmit,
}: {
  isOpen: boolean;
  isSubmitting: boolean;
  name: string;
  nameError: string | null;
  createError: string | null;
  manageEnabled: boolean;
  selfUsageEnabled: boolean;
  accountQuotaEnabled: boolean;
  usageCommandEnabled: boolean;
  nameInputId: string;
  formRef: React.RefObject<HTMLDivElement | null>;
  nameFieldRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onNameChange: (name: string) => void;
  onManageToggle: () => void;
  onSelfUsageToggle: () => void;
  onAccountQuotaToggle: () => void;
  onUsageCommandToggle: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("apiManager");
  const tc = useTranslations("common");

  return (
    <Modal
      isOpen={isOpen}
      title={t("createKey")}
      bodyClassName="p-6 max-h-[calc(100vh-150px)] overflow-y-auto"
      onClose={onClose}
    >
      <div ref={formRef} className="flex flex-col gap-4">
        <div ref={nameFieldRef}>
          <label className="text-sm font-medium text-text-main mb-1.5 block">{t("keyName")}</label>
          <Input
            id={nameInputId}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t("keyNamePlaceholder")}
            maxLength={MAX_KEY_NAME_LENGTH}
            error={nameError}
            autoFocus
          />
          <p className="text-xs text-text-muted mt-1.5">{t("keyNameDesc")}</p>
        </div>
        <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text-main">{t("managementAccess")}</p>
            <p className="text-xs text-text-muted">{t("managementAccessDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={manageEnabled}
            onClick={onManageToggle}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors shrink-0 ${
              manageEnabled
                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30"
                : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">admin_panel_settings</span>
            {manageEnabled ? tc("enabled") : tc("disabled")}
          </button>
        </div>
        <div className="flex flex-col gap-3 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text-main">{t("selfServiceVisibility")}</p>
            <p className="text-xs text-text-muted">{t("selfServiceVisibilityDesc")}</p>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-text-main">{t("ownUsageVisibility")}</p>
              <p className="text-xs text-text-muted">{t("ownUsageVisibilityDesc")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={selfUsageEnabled}
              onClick={onSelfUsageToggle}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors shrink-0 ${
                selfUsageEnabled
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                  : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">query_stats</span>
              {selfUsageEnabled ? tc("enabled") : tc("disabled")}
            </button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-text-main">{t("sharedAccountQuotaVisibility")}</p>
              <p className="text-xs text-text-muted">{t("sharedAccountQuotaVisibilityDesc")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={accountQuotaEnabled}
              disabled={!selfUsageEnabled}
              onClick={onAccountQuotaToggle}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors shrink-0 ${
                accountQuotaEnabled
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                  : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
              } ${!selfUsageEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className="material-symbols-outlined text-[14px]">account_balance</span>
              {accountQuotaEnabled ? tc("enabled") : tc("disabled")}
            </button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-text-main">{t("localUsageCommand")}</p>
              <p className="text-xs text-text-muted">{t("localUsageCommandDesc")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={usageCommandEnabled}
              onClick={onUsageCommandToggle}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors shrink-0 ${
                usageCommandEnabled
                  ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30"
                  : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">terminal</span>
              {usageCommandEnabled ? tc("enabled") : tc("disabled")}
            </button>
          </div>
        </div>
        {createError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <span className="material-symbols-outlined text-red-500 text-sm">error</span>
            <p className="text-sm text-red-700 dark:text-red-300 flex-1">{createError}</p>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={onClose} variant="ghost" fullWidth>
            {tc("cancel")}
          </Button>
          <Button onClick={onSubmit} fullWidth disabled={!name.trim()} loading={isSubmitting}>
            {t("createKey")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
