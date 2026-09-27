"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";
import type {
  ApiKeyUsageLimitPayload,
  ApiKeyUsageLimitSavePayload,
} from "./components/ApiKeyUsageLimitCard";

export function useApiKeyUsageLimits(selectedApiKeyId: string | null) {
  const [payload, setPayload] = useState<ApiKeyUsageLimitPayload | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-key spend limits are stored with OmniRoute's own API keys, which the
  // AISIX gateway does not expose (they are NOT `:3001/admin/v1/provider_keys`,
  // which hold upstream provider credentials). So both the read and the PATCH
  // are unavailable: the read degrades to `null` and the write refuses loudly
  // instead of firing a guaranteed 404 at the save button.
  const limitsRead = resolveAisixSurfaceSupport("keys", "read");
  const limitsWrite = resolveAisixSurfaceSupport("keys", "write");

  const load = useCallback(async () => {
    if (!selectedApiKeyId || !limitsRead.supported) {
      setPayload(null);
      return;
    }
    setLoading(true);
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/keys/${encodeURIComponent(selectedApiKeyId)}/usage-limits`)
    );
    setPayload(result.ok ? ((result.data ?? null) as ApiKeyUsageLimitPayload) : null);
    setLoading(false);
  }, [selectedApiKeyId, limitsRead.supported]);

  const save = useCallback(
    async (_next: ApiKeyUsageLimitSavePayload) => {
      if (!selectedApiKeyId) return;
      if (!limitsWrite.supported) {
        throw new Error(limitsWrite.reason);
      }
      const result = await fetchAisixJson(
        resolveAisixRequestUrl(`/api/keys/${encodeURIComponent(selectedApiKeyId)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(_next),
        }
      );
      if (!result.ok) {
        throw new Error(result.missing ? limitsWrite.reason : `HTTP ${result.status || 0}`.trim());
      }
      await load();
    },
    [load, selectedApiKeyId, limitsWrite.supported, limitsWrite.reason]
  );

  useEffect(() => {
    // Async continuation — the compiler rejects a sync call to a setter-capturing
    // callback from the effect body (react-hooks/set-state-in-effect).
    void (async () => {
      await load();
    })();
  }, [load]);

  return {
    payload,
    loading,
    save,
    unsupported: !limitsRead.supported,
    unsupportedReason: limitsRead.supported ? null : limitsRead.reason,
  };
}
