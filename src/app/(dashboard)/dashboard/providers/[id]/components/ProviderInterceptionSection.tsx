"use client";

/**
 * ProviderInterceptionSection — provider-level toggles for OmniRoute web
 * search/fetch tool interception (#3384 Phases 1-2 shipped the DB schema +
 * resolvers only; #7339 wires interceptFetch into the chat pipeline and adds
 * this dashboard toggle, covering both interceptSearch and interceptFetch
 * since they share one interception-rules row per provider).
 *
 * Renders a card on the provider detail page where operators opt a provider
 * into routing its provider-native web_search / web_fetch tool calls through
 * OmniRoute's own /v1/search and /v1/web/fetch endpoints instead of letting
 * the upstream provider run them natively. Off (undefined) preserves today's
 * native-bypass behavior exactly — this is purely additive opt-in.
 *
 * LOAD PATH: the GET is issued through `useProviderSectionRead`, which refuses
 * before requesting on a deployment that has no such surface, settles a 404
 * after ONE attempt, and bounds any transient retry. This card used to own a
 * private effect that re-issued its GET whenever the notification store's
 * identity changed — and that effect itself pushed a toast, so a 404 re-armed
 * the read which produced it. See the hook for the measured consequence.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import Toggle from "@/shared/components/Toggle";
import { fetchAisixJson, resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { useProviderSectionRead, useProviderSectionWrite } from "../hooks/useProviderSectionRead";
import ProviderSectionRefusal from "./ProviderSectionRefusal";

interface ProviderInterceptionSectionProps {
  providerId: string;
}

interface InterceptionToggles {
  interceptSearch: boolean;
  interceptFetch: boolean;
}

type Translate = (key: string, values?: Record<string, string>) => string;

const DEFAULT_TOGGLES: InterceptionToggles = { interceptSearch: false, interceptFetch: false };

/** The unsupported family this card's rule row belongs to. */
const INTERCEPTION_DOMAIN = "providerRules" as const;

// Literal for the load-failure message, used when the catalogue has no such key
// (`providerText` semantics). The localized catalogue copy wins when it does —
// this guarantees the operator never sees a bare message key.
const LOAD_ERROR_FALLBACK = "Failed to load interception settings: {error}";

async function throwOnErrorResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const errData = await res.json().catch(() => ({}));
  throw new Error(errData.error || `HTTP ${res.status}`);
}

/** Module-level: the load effect depends on it, so it must not be a closure. */
async function fetchInterceptionToggles(providerId: string) {
  return fetchAisixJson(
    resolveAisixRequestUrl(`/api/providers/${encodeURIComponent(providerId)}/interception-rules`)
  );
}

function parseInterceptionToggles(raw: unknown): InterceptionToggles {
  const data = (raw ?? {}) as { interceptSearch?: unknown; interceptFetch?: unknown };
  return {
    interceptSearch: data.interceptSearch === true,
    interceptFetch: data.interceptFetch === true,
  };
}

async function putInterceptionToggles(
  providerId: string,
  toggles: InterceptionToggles
): Promise<void> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/interception-rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toggles),
  });
  await throwOnErrorResponse(res);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useProviderInterceptionToggles(providerId: string, t: Translate) {
  const [toggles, setToggles] = useState<InterceptionToggles>(DEFAULT_TOGGLES);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<keyof InterceptionToggles | null>(null);
  const write = useProviderSectionWrite(INTERCEPTION_DOMAIN);

  const read = useProviderSectionRead<InterceptionToggles>({
    providerId,
    read: fetchInterceptionToggles,
    parse: parseInterceptionToggles,
    domain: INTERCEPTION_DOMAIN,
    failureMessageKey: "interceptionLoadError",
    failureFallback: LOAD_ERROR_FALLBACK,
    translate: t,
  });

  // Seed the editable copy from the one-shot load. Render-time state adjustment
  // (React's documented "adjusting state when a prop changes") rather than an
  // effect: an effect here would be a second thing that can re-fire.
  if (read.phase === "ready" && seededFor !== providerId) {
    setSeededFor(providerId);
    setToggles(read.data);
  }

  const handleToggle = useCallback(
    async (key: keyof InterceptionToggles, value: boolean) => {
      if (write.refuse(t("interceptionSectionTitle"))) return;
      const next = { ...toggles, [key]: value };
      setSavingKey(key);
      try {
        await putInterceptionToggles(providerId, next);
        setToggles(next);
      } catch (err) {
        useNotificationStore
          .getState()
          .error(t("interceptionSaveError", { error: errorMessage(err) }));
      } finally {
        setSavingKey(null);
      }
    },
    [providerId, toggles, t, write]
  );

  return { toggles, read, savingKey, handleToggle, write };
}

function InterceptionSectionSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <div className="h-5 w-56 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-4 h-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}

export default function ProviderInterceptionSection({
  providerId,
}: ProviderInterceptionSectionProps) {
  const t = useTranslations("providers");
  const { toggles, read, savingKey, handleToggle, write } = useProviderInterceptionToggles(
    providerId,
    t
  );

  if (read.phase === "loading") {
    return <InterceptionSectionSkeleton />;
  }

  // An absent surface is a stated fact, not an empty card: the operator has to be
  // able to tell "this provider intercepts nothing" from "there is nothing here
  // to intercept with".
  if (read.phase === "refused") {
    return (
      <ProviderSectionRefusal
        title={t("interceptionSectionTitle")}
        reason={read.reason}
        testId="interception-rules-unavailable-banner"
      />
    );
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <h2 className="text-base font-semibold text-text-main mb-1">
        {t("interceptionSectionTitle")}
      </h2>
      <p className="text-xs text-text-muted mb-4 leading-relaxed">{t("interceptionSectionHint")}</p>
      <div className="flex flex-col gap-4">
        <Toggle
          size="sm"
          checked={toggles.interceptSearch}
          disabled={savingKey === "interceptSearch" || !write.supported}
          onChange={(value) => handleToggle("interceptSearch", value)}
          label={t("interceptSearchLabel")}
          description={t("interceptSearchHint")}
        />
        <Toggle
          size="sm"
          checked={toggles.interceptFetch}
          disabled={savingKey === "interceptFetch" || !write.supported}
          onChange={(value) => handleToggle("interceptFetch", value)}
          label={t("interceptFetchLabel")}
          description={t("interceptFetchHint")}
        />
      </div>
    </div>
  );
}
