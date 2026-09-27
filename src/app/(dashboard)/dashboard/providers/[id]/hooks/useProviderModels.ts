"use client";

/**
 * useProviderModels — Phase 1f extraction for Issue #3501.
 *
 * Owns model-metadata state and handlers that were previously inline in
 * ProviderDetailPageClient:
 *  - modelMeta (customModels + modelCompatOverrides)
 *  - syncedAvailableModels
 *  - modelAliases
 *  - fetchProviderModelMeta, fetchAliases, handleSetAlias, handleDeleteAlias
 *
 * Cycle-safe: imports only from leaf modules.
 */

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import { resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";
import { parseAisixProviderModels } from "@/shared/utils/aisixNativeCatalog";
import { providerText, type CompatModelRow } from "../providerPageHelpers";

// ──── types ─────────────────────────────────────────────────────────────────

export interface ModelMeta {
  customModels: CompatModelRow[];
  modelCompatOverrides: Array<CompatModelRow & { id: string }>;
}

export interface UseProviderModelsReturn {
  modelMeta: ModelMeta;
  syncedAvailableModels: any[];
  syncedCatalogAuthoritative: boolean;
  modelAliases: Record<string, string>;
  /** `false` when the gateway has no model-alias surface at all. */
  modelAliasesSupported: boolean;
  /** Operator-facing refusal, or `null` while the surface is supported. */
  modelAliasesUnsupportedReason: string | null;
  fetchProviderModelMeta: () => Promise<void>;
  fetchAliases: () => Promise<void>;
  handleSetAlias: (modelId: string, alias: string, providerAlias?: string) => Promise<void>;
  handleDeleteAlias: (alias: string) => Promise<void>;
}

export function useProviderModels(
  providerId: string,
  isSearchProvider: boolean
): UseProviderModelsReturn {
  const t = useTranslations("providers");
  const notify = useNotificationStore();
  const modelAliasesSupport = resolveAisixSurfaceSupport("modelAliases", "read");

  const [modelMeta, setModelMeta] = useState<ModelMeta>({
    customModels: [],
    modelCompatOverrides: [],
  });
  const [syncedCatalog, setSyncedCatalog] = useState({
    providerId: "",
    models: [] as any[],
    authoritative: false,
  });
  const syncedAvailableModels = syncedCatalog.providerId === providerId ? syncedCatalog.models : [];
  const syncedCatalogAuthoritative =
    syncedCatalog.providerId === providerId && syncedCatalog.authoritative;
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});

  const fetchAliases = useCallback(async () => {
    // The model→alias map is a Next.js join table with no core counterpart
    // (see `AisixUnsupportedDomain` → `modelAliases`). On the AISIX export the
    // read is skipped outright instead of being fired into a guaranteed 404, and
    // `modelAliasesUnsupportedReason` lets the page SAY so — an alias list that
    // is empty because nothing was read and one that is empty because there are
    // no aliases are different claims, and the form must not conflate them.
    if (!modelAliasesSupport.supported) return;
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) {
        setModelAliases(data.aliases || {});
      }
    } catch (error) {
      console.log("Error fetching aliases:", error);
    }
  }, [modelAliasesSupport.supported]);

  // Every alias write refuses through the same declaration, before any request.
  const refuseAliasWrite = useCallback((): boolean => {
    if (modelAliasesSupport.supported) return false;
    notify.error(`AISIX-шлюз: ${modelAliasesSupport.reason}`);
    return true;
  }, [modelAliasesSupport, notify]);

  const handleSetAlias = useCallback(
    async (modelId: string, alias: string, providerAlias?: string) => {
      if (refuseAliasWrite()) return;
      const qualifiedModel = providerAlias
        ? modelId.includes("/")
          ? `${providerAlias}/${modelId.split("/").slice(1).join("/")}`
          : `${providerAlias}/${modelId}`
        : modelId;
      try {
        const res = await fetch("/api/models/alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: qualifiedModel, alias }),
        });
        if (res.ok) {
          await fetchAliases();
          notify.success(t("setAliasSuccess", { alias }));
        } else {
          const data = await res.json().catch(() => ({}));
          notify.error(
            data?.error?.message || providerText(t, "failedSetAlias", "Failed to set alias")
          );
        }
      } catch (error) {
        console.log("Error setting alias:", error);
        notify.error(providerText(t, "networkErrorSettingAlias", "Network error setting alias"));
      }
    },
    [fetchAliases, t, notify, refuseAliasWrite]
  );

  const handleDeleteAlias = useCallback(
    async (alias: string) => {
      if (refuseAliasWrite()) return;
      try {
        const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, {
          method: "DELETE",
        });
        if (res.ok) {
          await fetchAliases();
          notify.success(t("deleteAliasSuccess", { alias }));
        } else {
          const data = await res.json().catch(() => ({}));
          notify.error(
            data?.error?.message || providerText(t, "failedDeleteAlias", "Failed to delete alias")
          );
        }
      } catch (error) {
        console.log("Error deleting alias:", error);
        notify.error(providerText(t, "networkErrorDeletingAlias", "Network error deleting alias"));
      }
    },
    [fetchAliases, t, notify, refuseAliasWrite]
  );

  const fetchProviderModelMeta = useCallback(async () => {
    if (isSearchProvider) return;
    // Both reads are the SAME relation on the AISIX core, and both legacy
    // routes are absent from a static export. Repointed at
    // `GET /admin/v1/models` and split per-provider by
    // `parseAisixProviderModels` — the core ignores `?provider=`, so the split
    // is arithmetic over the one document rather than a second 404.
    const catalogUrl = resolveAisixRequestUrl(
      `/api/provider-models?provider=${encodeURIComponent(providerId)}`
    );
    try {
      const res = await fetch(catalogUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const projected = parseAisixProviderModels(data, providerId);
      setModelMeta({
        customModels: projected.models,
        modelCompatOverrides: projected.modelCompatOverrides,
      });
      if (projected.authoritative) {
        setSyncedCatalog({
          providerId,
          models: projected.models,
          authoritative: true,
        });
      }
    } catch (e) {
      console.error("fetchProviderModelMeta", e);
    }
  }, [providerId, isSearchProvider]);

  return {
    modelMeta,
    syncedAvailableModels,
    syncedCatalogAuthoritative,
    modelAliases,
    /** `false` on the AISIX export — the page renders `reason` instead of an empty alias list. */
    modelAliasesSupported: modelAliasesSupport.supported,
    modelAliasesUnsupportedReason: modelAliasesSupport.supported
      ? null
      : modelAliasesSupport.reason,
    fetchProviderModelMeta,
    fetchAliases,
    handleSetAlias,
    handleDeleteAlias,
  };
}
