"use client";

/**
 * ProviderParamFilterSection — Denylist/allowlist config for provider-level
 * request parameter filtering (#6625).
 *
 * Renders a card on the provider detail page where operators can configure
 * which request params to strip (block) or selectively re-add (allow) before
 * sending to the upstream provider.
 *
 * LOAD PATH: the GET is issued through `useProviderSectionRead`, which refuses
 * before requesting on a deployment that has no such surface and otherwise
 * settles a 404 after ONE attempt. This card used to call
 * `res.json()` without checking `res.ok`, so a 404 body was parsed as "no
 * filters configured" — a silent 404 rendered as an empty success — and its
 * effect re-issued the GET whenever the notification store's identity changed,
 * which its own error toast did on every failure.
 *
 * NOTIFY: this card used to call `notify.notify(message, "error")`. The store
 * has no `notify` method (it exposes `success`/`error`/`warning`/`info` and
 * `addNotification`), so that expression was `undefined` and the load path died
 * on `TypeError: a.notify is not a function` before it could set state —
 * an unhandled rejection plus a card stuck on its skeleton forever. The
 * notifier is now read imperatively and called with the real method names.
 */

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import { fetchAisixJson, resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { useProviderSectionRead, useProviderSectionWrite } from "../hooks/useProviderSectionRead";
import ProviderSectionRefusal from "./ProviderSectionRefusal";

interface ProviderParamFilterSectionProps {
  providerId: string;
}

interface ParamFilterConfig {
  block: string[];
  allow: string[];
  models?: Record<string, { block?: string[]; allow?: string[] }>;
  autoLearn: boolean;
}

type Translate = (key: string, values?: Record<string, string>) => string;

const EMPTY_CONFIG: ParamFilterConfig = { block: [], allow: [], autoLearn: false };

/** The unsupported family this card's rule row belongs to. */
const PARAM_FILTER_DOMAIN = "providerRules" as const;

// Literal for the load-failure message, used when the catalogue has no such key
// (`providerText` semantics). The localized catalogue copy wins when it does —
// this guarantees the operator never sees a bare message key.
const LOAD_ERROR_FALLBACK = "Failed to load param filter config: {error}";

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatCommaList(arr: string[]): string {
  return arr.join(", ");
}

// ---------------------------------------------------------------------------
// Fetch helpers — isolate the HTTP + response-shape concerns so the
// component's handlers stay focused on state transitions + user feedback.
// ---------------------------------------------------------------------------

/** Module-level: the load effect depends on it, so it must not be a closure. */
async function fetchParamFilterConfig(providerId: string) {
  return fetchAisixJson(
    resolveAisixRequestUrl(`/api/providers/${encodeURIComponent(providerId)}/param-filters`)
  );
}

function parseParamFilterConfig(raw: unknown): ParamFilterConfig {
  const data = (raw ?? {}) as { block?: unknown; allow?: unknown; autoLearn?: unknown };
  return {
    block: Array.isArray(data.block) ? (data.block as string[]) : [],
    allow: Array.isArray(data.allow) ? (data.allow as string[]) : [],
    autoLearn: typeof data.autoLearn === "boolean" ? data.autoLearn : false,
  };
}

async function throwOnErrorResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const errData = await res.json().catch(() => ({}));
  throw new Error(errData.error || `HTTP ${res.status}`);
}

async function putParamFilterConfig(providerId: string, body: ParamFilterConfig): Promise<void> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/param-filters`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwOnErrorResponse(res);
}

async function deleteParamFilterConfig(providerId: string): Promise<void> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/param-filters`, {
    method: "DELETE",
  });
  await throwOnErrorResponse(res);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// State hook — owns config load/save/reset so the component body stays JSX-only.
// ---------------------------------------------------------------------------

// Wraps a raw state setter so updating the draft value also marks the form
// dirty — used for the three form-local draft fields below.
function useDirtySetter<T>(setValue: (value: T) => void, setDirty: (value: boolean) => void) {
  return useCallback(
    (value: T) => {
      setValue(value);
      setDirty(true);
    },
    [setValue, setDirty]
  );
}

function useProviderParamFilterConfig(providerId: string, t: Translate) {
  // `config` is write-only: the card's visible values are the three draft
  // fields below, and a save replaces all three at once.
  const [, setConfig] = useState<ParamFilterConfig>(EMPTY_CONFIG);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [blockText, setBlockTextState] = useState("");
  const [allowText, setAllowTextState] = useState("");
  const [autoLearn, setAutoLearnState] = useState(false);
  const write = useProviderSectionWrite(PARAM_FILTER_DOMAIN);

  const read = useProviderSectionRead<ParamFilterConfig>({
    providerId,
    read: fetchParamFilterConfig,
    parse: parseParamFilterConfig,
    domain: PARAM_FILTER_DOMAIN,
    failureMessageKey: "paramFiltersLoadError",
    failureFallback: LOAD_ERROR_FALLBACK,
    translate: t,
  });

  const setBlockText = useDirtySetter(setBlockTextState, setDirty);
  const setAllowText = useDirtySetter(setAllowTextState, setDirty);
  const setAutoLearn = useDirtySetter(setAutoLearnState, setDirty);

  // Seed the editable draft from the one-shot load. Render-time state adjustment
  // (React's documented "adjusting state when a prop changes") rather than an
  // effect: an effect here would be a second thing that can re-fire.
  if (read.phase === "ready" && seededFor !== providerId) {
    setSeededFor(providerId);
    setConfig(read.data);
    setBlockTextState(formatCommaList(read.data.block));
    setAllowTextState(formatCommaList(read.data.allow));
    setAutoLearnState(read.data.autoLearn);
  }

  const handleSave = useCallback(async () => {
    if (write.refuse(t("paramFiltersSectionTitle"))) return;
    setSaving(true);
    try {
      const body: ParamFilterConfig = {
        block: parseCommaList(blockText),
        allow: parseCommaList(allowText),
        autoLearn,
      };
      await putParamFilterConfig(providerId, body);
      setConfig(body);
      setDirty(false);
      useNotificationStore.getState().success(t("paramFiltersSaveSuccess"));
    } catch (err) {
      useNotificationStore
        .getState()
        .error(t("paramFiltersSaveError", { error: errorMessage(err) }));
    } finally {
      setSaving(false);
    }
  }, [providerId, blockText, allowText, autoLearn, t, write]);

  const handleReset = useCallback(async () => {
    if (write.refuse(t("paramFiltersSectionTitle"))) return;
    setSaving(true);
    try {
      await deleteParamFilterConfig(providerId);
      setConfig(EMPTY_CONFIG);
      setBlockTextState("");
      setAllowTextState("");
      setAutoLearnState(false);
      setDirty(false);
      useNotificationStore.getState().success(t("paramFiltersResetSuccess"));
    } catch (err) {
      useNotificationStore
        .getState()
        .error(t("paramFiltersResetError", { error: errorMessage(err) }));
    } finally {
      setSaving(false);
    }
  }, [providerId, t, write]);

  return {
    read,
    saving,
    dirty,
    write,
    blockText,
    allowText,
    autoLearn,
    setBlockText,
    setAllowText,
    setAutoLearn,
    handleSave,
    handleReset,
  };
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function ParamFilterSectionSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <div className="h-5 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-4 h-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}

function ParamFilterSectionHeader({ t }: { t: (key: string) => string }) {
  return (
    <>
      <h2 className="text-base font-semibold text-text-main mb-1">
        {t("paramFiltersSectionTitle")}
      </h2>
      <p className="text-xs text-text-muted mb-4 leading-relaxed">
        {t.rich("paramFiltersSectionHint", {
          code: (chunks) => (
            <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{chunks}</code>
          ),
        })}
      </p>
    </>
  );
}

interface ParamListFieldProps {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}

function ParamListField({ label, hint, value, placeholder, onChange }: ParamListFieldProps) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-text-muted mb-1.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary dark:bg-zinc-900"
      />
      <p className="text-[11px] text-text-muted mt-1">{hint}</p>
    </div>
  );
}

interface AutoLearnToggleProps {
  t: (key: string) => string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function AutoLearnToggle({ t, checked, onChange }: AutoLearnToggleProps) {
  return (
    <div className="mb-4">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-border text-primary focus:ring-primary"
        />
        <span className="text-xs font-medium text-text-main">
          {t("paramFiltersAutoLearnLabel")}
        </span>
      </label>
      <p className="text-[11px] text-text-muted mt-1 ml-5">{t("paramFiltersAutoLearnHint")}</p>
    </div>
  );
}

interface ParamFilterActionsProps {
  t: (key: string) => string;
  saving: boolean;
  dirty: boolean;
  writeSupported: boolean;
  onSave: () => void;
  onReset: () => void;
}

function ParamFilterActions({
  t,
  saving,
  dirty,
  writeSupported,
  onSave,
  onReset,
}: ParamFilterActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onSave}
        disabled={saving || !dirty || !writeSupported}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {saving ? (
          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
        ) : (
          <span className="material-symbols-outlined text-sm">save</span>
        )}
        {saving ? t("paramFiltersSaving") : t("paramFiltersSaveChanges")}
      </button>
      <button
        type="button"
        onClick={onReset}
        disabled={saving || !writeSupported}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text-main hover:border-primary/40 disabled:opacity-50 transition-colors"
      >
        <span className="material-symbols-outlined text-sm">delete</span>
        {t("paramFiltersResetToDefault")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProviderParamFilterSection({
  providerId,
}: ProviderParamFilterSectionProps) {
  const t = useTranslations("providers");
  const {
    read,
    saving,
    dirty,
    write,
    blockText,
    allowText,
    autoLearn,
    setBlockText,
    setAllowText,
    setAutoLearn,
    handleSave,
    handleReset,
  } = useProviderParamFilterConfig(providerId, t);

  if (read.phase === "loading") {
    return <ParamFilterSectionSkeleton />;
  }

  // An absent surface is a stated fact. Rendering the form with empty fields
  // would tell the operator "this provider has no filters configured" when the
  // truth is "there is no filter store on this deployment".
  if (read.phase === "refused") {
    return (
      <ProviderSectionRefusal
        title={t("paramFiltersSectionTitle")}
        reason={read.reason}
        testId="param-filters-unavailable-banner"
      />
    );
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <ParamFilterSectionHeader t={t} />
      <ParamListField
        label={t("paramFiltersBlockedLabel")}
        hint={t("paramFiltersBlockedHint")}
        value={blockText}
        placeholder={t("paramFiltersBlockedPlaceholder")}
        onChange={setBlockText}
      />
      <ParamListField
        label={t("paramFiltersAllowedLabel")}
        hint={t("paramFiltersAllowedHint")}
        value={allowText}
        placeholder={t("paramFiltersAllowedPlaceholder")}
        onChange={setAllowText}
      />
      <AutoLearnToggle t={t} checked={autoLearn} onChange={setAutoLearn} />
      <ParamFilterActions
        t={t}
        saving={saving}
        dirty={dirty}
        writeSupported={write.supported}
        onSave={handleSave}
        onReset={handleReset}
      />
    </div>
  );
}
