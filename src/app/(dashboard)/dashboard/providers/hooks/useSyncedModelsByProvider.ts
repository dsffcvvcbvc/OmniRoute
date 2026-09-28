"use client";

import { useEffect, useState } from "react";
import type { LiveModelsByProviderId } from "../providerPageUtils";

/**
 * useSyncedModelsByProvider — fetch the live/synced model catalog for every
 * provider connection via GET /api/synced-available-models, so the Providers
 * page model-name filter can match against real upstream models (not just
 * the static curated registry). See #7250: aggregator providers (openrouter,
 * kilocode, ...) declare a single-entry static placeholder, so a
 * search for a real model name never matched and silently hid the provider.
 *
 * NOT REPOINTED, deliberately — the one read in this branch's classification left
 * on its legacy route, and the reason is worth stating because it reads like an
 * oversight.
 *
 * `GET /admin/v1/models` IS the same provider↔model relation, and repointing it
 * here was tried and reverted. The providers index then carries a FOURTH
 * admin-plane 401 (the other three are provider keys, models status and preset
 * providers), and on that page an admin-plane 401 is not a local failure: the
 * shared admin transport flips the dashboard's GLOBAL signed-out store, which
 * opens the "Sign in to the gateway" dialog and unmounts the provider cards
 * themselves. 03-client-navigation's "Providers → OpenAI" leg is the proof — the
 * same three 401s on both builds, but the card is present on 69c9c0c1e4 and gone
 * once the fourth is added.
 *
 * Fails soft — a fetch error leaves the map empty, and callers fall back to
 * the static registry only.
 */
export function useSyncedModelsByProvider(): LiveModelsByProviderId {
  const [models, setModels] = useState<LiveModelsByProviderId>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/synced-available-models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          setModels(data as LiveModelsByProviderId);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}
