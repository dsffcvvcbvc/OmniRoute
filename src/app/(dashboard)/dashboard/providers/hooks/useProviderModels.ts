"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { parseAisixOpenAiModelList } from "@/shared/utils/aisixNativeCatalog";

export interface ProviderModel {
  id: string;
  /** Display-friendly id (unprefixed) */
  displayId?: string;
  object?: string;
  owned_by?: string;
  /** Catalog model type, e.g. "chat", "audio", "image". */
  type?: string;
  /** Audio subtype, e.g. "transcription" or "speech". */
  subtype?: string;
}

interface UseProviderModelsResult {
  models: ProviderModel[];
  loading: boolean;
  error: string | null;
  /** Re-runs the model fetch for the current provider. Useful for a Retry action. */
  retry: () => void;
}

/** The provider-model list URL, on whichever plane this deployment answers it. */
function modelsUrl(providerId: string): string {
  return resolveAisixRequestUrl(`/api/v1/providers/${encodeURIComponent(providerId)}/models`);
}

/**
 * `{ data: [...] }` on a Next deployment; the core's catalog documents on an
 * AISIX one. Both shapes pass through here so the hook has one list contract.
 */
function readModelList(payload: unknown, providerId: string): ProviderModel[] {
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data?: ProviderModel[] }).data;
    return Array.isArray(data) ? data : [];
  }
  return parseAisixOpenAiModelList(payload, providerId).data as ProviderModel[];
}

/**
 * useProviderModels — fetch models for a specific provider via
 * GET /api/v1/providers/{providerId}/models.
 *
 * On the AISIX static export that legacy route does not exist. It is repointed
 * at the core's `GET /admin/v1/models` — the same provider↔model relation — and
 * reshaped into the OpenAI-shaped `{ data: [...] }` this hook's consumer
 * expects, per-provider, by `parseAisixOpenAiModelList`. Previously the
 * OpenAI-shaped path fell through to the `/api/v1/*` → data-plane rule, and
 * `/v1/providers/…` is not part of that plane, so the picker's list was a
 * guaranteed 404 rendered as "this provider offers no models".
 *
 * Falls back to an empty list on error so the playground is still usable.
 * The hook is stable for the lifetime of the component (only re-fetches if
 * `providerId` changes).
 */
export function useProviderModels(providerId: string): UseProviderModelsResult {
  const t = useTranslations("providers");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Cancels any in-flight load (component unmount or a retry superseding the
  // previous request) so a stale response never overwrites a newer one.
  const cleanupRef = useRef<(() => void) | null>(null);

  const load = useCallback(() => {
    cleanupRef.current?.();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(modelsUrl(providerId));
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          const msg = body?.error?.message ?? `${t("providerTestFailed")} (HTTP ${res.status})`;
          if (!cancelled) setError(msg);
          return;
        }
        const list = readModelList(await res.json(), providerId);
        if (cancelled) return;

        // Auto-sync from upstream if local catalog is empty
        if (list.length === 0) {
          setTimeout(async () => {
            try {
              if (cancelled) return;
              const connRes = await fetch("/api/providers");
              if (!connRes.ok || cancelled) return;
              const connData = (await connRes.json()) as {
                connections?: Array<{
                  id: string;
                  provider: string;
                  isActive?: boolean;
                  providerSpecificData?: { autoFetchModels?: boolean };
                }>;
              };
              if (cancelled) return;
              const providerConnections = connData.connections?.filter(
                (c) => (c.provider === providerId || c.id === providerId) && c.isActive !== false
              );
              const providerConn = providerConnections?.[0];

              if (
                providerConn &&
                providerConnections.every(
                  (connection) => connection.providerSpecificData?.autoFetchModels === true
                ) &&
                !cancelled
              ) {
                const syncRes = await fetch(
                  `/api/providers/${encodeURIComponent(providerConn.id)}/sync-models?mode=sync`,
                  { method: "POST" }
                );

                if (syncRes.ok && !cancelled) {
                  const refetchRes = await fetch(modelsUrl(providerId));
                  if (refetchRes.ok && !cancelled) {
                    const refetchList = readModelList(await refetchRes.json(), providerId);
                    if (!cancelled) {
                      setModels(refetchList);
                    }
                  }
                }
              }
            } catch (syncErr) {
              if (!cancelled) {
                console.log("Auto-fetch models failed:", syncErr);
              }
            }
          }, 0);
        }

        if (cancelled) return;
        setModels(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load models");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const cleanup = () => {
      cancelled = true;
    };
    cleanupRef.current = cleanup;
    return cleanup;
  }, [providerId, t]);

  useEffect(() => {
    if (!providerId) return;
    return load();
  }, [providerId, load]);

  // Release the current in-flight cleanup on unmount so no state updates leak.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const retry = useCallback(() => {
    if (!providerId) return;
    load();
  }, [providerId, load]);

  // Without a providerId nothing ever loads, so the exposed loading flag is
  // derived instead of being reset synchronously inside the effect above.
  return { models, loading: providerId ? loading : false, error, retry };
}
