"use client";

import { useEffect, useState } from "react";
import { resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { parseAisixModelCatalogByProvider } from "@/shared/utils/aisixNativeCatalog";
import type { LiveModelsByProviderId } from "../providerPageUtils";

/**
 * useSyncedModelsByProvider — fetch the live/synced model catalog for every
 * provider connection via GET /api/synced-available-models, so the Providers
 * page model-name filter can match against real upstream models (not just
 * the static curated registry). See #7250: aggregator providers (openrouter,
 * kilocode, ...) declare a single-entry static placeholder, so a
 * search for a real model name never matched and silently hid the provider.
 *
 * On the AISIX static export the legacy route does not exist, so the read is
 * repointed at the core's own `GET /admin/v1/models` — which IS the same
 * provider↔model relation — and reshaped by `parseAisixModelCatalogByProvider`.
 * That turns a guaranteed 404 into real catalog data for the filter to match
 * against, which is what this hook is for.
 *
 * Fails soft — an unreadable core leaves the map empty, and callers fall back to
 * the static registry only. Empty is the honest reading there: no catalog, no
 * extra matches, and the curated registry still matches.
 */
export function useSyncedModelsByProvider(): LiveModelsByProviderId {
  const [models, setModels] = useState<LiveModelsByProviderId>({});

  useEffect(() => {
    let cancelled = false;
    fetch(resolveAisixRequestUrl("/api/synced-available-models"))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data !== "object") return;
        setModels(parseAisixModelCatalogByProvider(data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}
