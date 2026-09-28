"use client";

/**
 * ProviderCcAliasSection — operator control for the Claude Code discovery-alias
 * gate (`claude/&lt;provider&gt;/&lt;model&gt;` mirror ids on /v1/models — see
 * src/lib/db/ccDiscoveryAliases.ts for the gate itself).
 *
 * Renders a card on the provider detail page with:
 *   - a 3-state provider-level control (inherit / on / off)
 *   - a compact list of per-model overrides, each also inherit/on/off
 *
 * "Inherit" clears the DB override (`value: null`) and falls back to the next
 * level down (model → provider → the global EXPOSE_CC_DISCOVERY_ALIASES flag).
 * Off by default at every level — this card is purely opt-in.
 *
 * LOAD PATH: the GET is issued through `useProviderSectionRead`, which refuses
 * before requesting on a deployment that has no such surface and otherwise
 * settles a 404 after ONE attempt. This card used to own a private effect that
 * re-issued its GET whenever the notification store's identity changed — and
 * that effect itself pushed a toast, so a 404 re-armed the read which produced
 * it. See the hook for the measured consequence.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import { fetchAisixJson, resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";
import { useProviderSectionRead, useProviderSectionWrite } from "../hooks/useProviderSectionRead";
import ProviderSectionRefusal from "./ProviderSectionRefusal";

export type CcAliasSettingValue = "on" | "off" | null;

interface ProviderCcAliasSectionProps {
  providerId: string;
}

interface CcAliasState {
  provider: CcAliasSettingValue;
  models: Record<string, "on" | "off">;
}

const DEFAULT_STATE: CcAliasState = { provider: null, models: {} };

/** The unsupported family this card's rule rows belong to. */
const CC_ALIAS_DOMAIN = "providerRules" as const;

const LOAD_ERROR_FALLBACK = "Failed to load discovery-alias settings: {error}";
const SAVE_ERROR_FALLBACK = "Failed to save discovery-alias setting: {error}";

/** Module-level: the load effect depends on it, so it must not be a closure. */
async function fetchCcAliasState(providerId: string) {
  return fetchAisixJson(
    resolveAisixRequestUrl(`/api/providers/${encodeURIComponent(providerId)}/cc-alias`)
  );
}

function parseCcAliasState(raw: unknown): CcAliasState {
  const data = (raw ?? {}) as { provider?: unknown; models?: unknown };
  return {
    provider: data?.provider === "on" || data?.provider === "off" ? data.provider : null,
    models:
      data?.models && typeof data.models === "object"
        ? (data.models as CcAliasState["models"])
        : {},
  };
}

async function throwOnErrorResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const errData = await res.json().catch(() => ({}));
  const message =
    typeof errData?.error === "string"
      ? errData.error
      : errData?.error?.message || `HTTP ${res.status}`;
  throw new Error(message);
}

async function putProviderSetting(providerId: string, value: CcAliasSettingValue): Promise<void> {
  const res = await fetch(`/api/providers/${providerId}/cc-alias`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "provider", value }),
  });
  await throwOnErrorResponse(res);
}

async function putModelSetting(
  providerId: string,
  modelId: string,
  value: CcAliasSettingValue
): Promise<void> {
  const res = await fetch(`/api/providers/${providerId}/cc-alias`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "model", modelId, value }),
  });
  await throwOnErrorResponse(res);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Loads the provider's alias settings once, under a ceiling, and refuses honestly. */
function useCcAliasData(providerId: string, t: ProviderMessageTranslator) {
  const [state, setState] = useState<CcAliasState>(DEFAULT_STATE);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const write = useProviderSectionWrite(CC_ALIAS_DOMAIN);

  const read = useProviderSectionRead<CcAliasState>({
    providerId,
    read: fetchCcAliasState,
    parse: parseCcAliasState,
    domain: CC_ALIAS_DOMAIN,
    failureMessageKey: "ccAliasLoadError",
    failureFallback: LOAD_ERROR_FALLBACK,
    translate: t,
  });

  // Seed the editable copy from the one-shot load. Render-time state adjustment
  // (React's documented "adjusting state when a prop changes") rather than an
  // effect: an effect here would be a second thing that can re-fire.
  if (read.phase === "ready" && seededFor !== providerId) {
    setSeededFor(providerId);
    setState(read.data);
  }

  return { state, setState, read, write };
}

function useProviderCcAliasState(providerId: string, t: ProviderMessageTranslator) {
  const { state, setState, read, write } = useCcAliasData(providerId, t);
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");

  const reportSaveError = useCallback(
    (err: unknown) => {
      useNotificationStore
        .getState()
        .error(
          providerText(t, "ccAliasSaveError", SAVE_ERROR_FALLBACK, { error: errorMessage(err) })
        );
    },
    [t]
  );

  const handleProviderChange = useCallback(
    async (value: CcAliasSettingValue) => {
      if (
        write.refuse(providerText(t, "ccAliasSectionTitle", "Expose in Claude Code (claude/…)"))
      ) {
        return;
      }
      setSavingProvider(true);
      try {
        await putProviderSetting(providerId, value);
        setState((prev) => ({ ...prev, provider: value }));
      } catch (err) {
        reportSaveError(err);
      } finally {
        setSavingProvider(false);
      }
    },
    [providerId, t, write, reportSaveError, setState]
  );

  const handleModelChange = useCallback(
    async (modelId: string, value: CcAliasSettingValue) => {
      if (
        write.refuse(providerText(t, "ccAliasSectionTitle", "Expose in Claude Code (claude/…)"))
      ) {
        return;
      }
      setSavingModelId(modelId);
      try {
        await putModelSetting(providerId, modelId, value);
        setState((prev) => {
          const models = { ...prev.models };
          if (value === null) delete models[modelId];
          else models[modelId] = value;
          return { ...prev, models };
        });
      } catch (err) {
        reportSaveError(err);
      } finally {
        setSavingModelId(null);
      }
    },
    [providerId, t, write, reportSaveError, setState]
  );

  const handleAddModelOverride = useCallback(async () => {
    const modelId = newModelId.trim();
    if (!modelId) return;
    await handleModelChange(modelId, "on");
    setNewModelId("");
  }, [newModelId, handleModelChange]);

  return {
    state,
    read,
    write,
    savingProvider,
    savingModelId,
    newModelId,
    setNewModelId,
    handleProviderChange,
    handleModelChange,
    handleAddModelOverride,
  };
}

function CcAliasSectionSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <div className="h-5 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-4 h-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}

type TriState = "inherit" | "on" | "off";

function toTriState(value: CcAliasSettingValue): TriState {
  if (value === "on") return "on";
  if (value === "off") return "off";
  return "inherit";
}

function fromTriState(value: TriState): CcAliasSettingValue {
  if (value === "inherit") return null;
  return value;
}

interface TriStateSelectProps {
  t: ProviderMessageTranslator;
  value: CcAliasSettingValue;
  disabled?: boolean;
  onChange: (value: CcAliasSettingValue) => void;
  ariaLabel: string;
}

function TriStateSelect({ t, value, disabled, onChange, ariaLabel }: TriStateSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={toTriState(value)}
      onChange={(e) => onChange(fromTriState(e.target.value as TriState))}
      className="rounded-md border border-border bg-sidebar/50 px-2 py-1 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="inherit">{providerText(t, "ccAliasStateInherit", "Inherit")}</option>
      <option value="on">{providerText(t, "ccAliasStateOn", "On")}</option>
      <option value="off">{providerText(t, "ccAliasStateOff", "Off")}</option>
    </select>
  );
}

export default function ProviderCcAliasSection({ providerId }: ProviderCcAliasSectionProps) {
  const t = useTranslations("providers");
  const {
    state,
    read,
    write,
    savingProvider,
    savingModelId,
    newModelId,
    setNewModelId,
    handleProviderChange,
    handleModelChange,
    handleAddModelOverride,
  } = useProviderCcAliasState(providerId, t);

  if (read.phase === "loading") {
    return <CcAliasSectionSkeleton />;
  }

  // An absent surface is a stated fact, not "every model is Inherit" — which is
  // what this card used to show whenever its read failed.
  if (read.phase === "refused") {
    return (
      <ProviderSectionRefusal
        title={providerText(t, "ccAliasSectionTitle", "Expose in Claude Code (claude/…)")}
        reason={read.reason}
        testId="cc-alias-unavailable-banner"
      />
    );
  }

  const modelEntries = Object.entries(state.models);

  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <h2 className="text-base font-semibold text-text-main mb-1">
        {providerText(t, "ccAliasSectionTitle", "Expose in Claude Code (claude/…)")}
      </h2>
      <p className="text-xs text-text-muted mb-4 leading-relaxed">
        {providerText(
          t,
          "ccAliasSectionHint",
          "Advertise this provider's models under claude/&lt;provider&gt;/&lt;model&gt; mirror ids so Claude Code's gateway model discovery can list them. Off by default — enabling this doubles catalog entries for all clients."
        )}
      </p>

      <div className="flex items-center justify-between gap-3 mb-4">
        <span className="text-sm font-medium text-text-main">
          {providerText(t, "ccAliasProviderLevelLabel", "Provider default")}
        </span>
        <TriStateSelect
          t={t}
          value={state.provider}
          disabled={savingProvider || !write.supported}
          onChange={handleProviderChange}
          ariaLabel={providerText(t, "ccAliasProviderLevelLabel", "Provider default")}
        />
      </div>

      <ModelOverrideList
        t={t}
        entries={modelEntries}
        savingModelId={savingModelId}
        writeSupported={write.supported}
        onChange={handleModelChange}
      />

      <AddOverrideRow
        t={t}
        value={newModelId}
        onValueChange={setNewModelId}
        onSubmit={handleAddModelOverride}
        disabled={savingModelId !== null || !write.supported}
      />
    </div>
  );
}

function ModelOverrideList({
  t,
  entries,
  savingModelId,
  writeSupported,
  onChange,
}: {
  t: ProviderMessageTranslator;
  entries: Array<[string, CcAliasSettingValue]>;
  savingModelId: string | null;
  writeSupported: boolean;
  onChange: (modelId: string, value: CcAliasSettingValue) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      <span className="text-xs font-medium text-text-muted">
        {providerText(t, "ccAliasModelOverridesLabel", "Per-model overrides")}
      </span>
      {entries.map(([modelId, value]) => (
        <div key={modelId} className="flex items-center justify-between gap-3">
          <code className="rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted truncate">
            {modelId}
          </code>
          <TriStateSelect
            t={t}
            value={value}
            disabled={savingModelId === modelId || !writeSupported}
            onChange={(v) => onChange(modelId, v)}
            ariaLabel={providerText(t, "ccAliasModelOverrideAriaLabel", "Override for {modelId}", {
              modelId,
            })}
          />
        </div>
      ))}
    </div>
  );
}

function AddOverrideRow({
  t,
  value,
  onValueChange,
  onSubmit,
  disabled,
}: {
  t: ProviderMessageTranslator;
  value: string;
  onValueChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onSubmit();
        }}
        placeholder={providerText(t, "ccAliasAddModelPlaceholder", "Model id (e.g. gpt-4o)")}
        className="flex-1 rounded-lg border border-border bg-sidebar/50 px-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-main hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {providerText(t, "ccAliasAddModelButton", "Add override")}
      </button>
    </div>
  );
}
