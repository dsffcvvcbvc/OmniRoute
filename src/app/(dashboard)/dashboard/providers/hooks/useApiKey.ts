"use client";

import { useState, useEffect } from "react";
import { resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  isActive?: boolean;
  createdAt?: string;
}

interface UseApiKeyOptions {
  preferredId?: string;
}

interface UseApiKeyResult {
  apiKey: string;
  setApiKey: (key: string) => void;
  keys: ApiKey[];
  loading: boolean;
  /**
   * `false` when the gateway cannot report a USABLE consumer key. It keeps the
   * resource at `GET /admin/v1/api_keys`, but that document carries `key_hash`
   * and never the plaintext — so this is not a repoint, it is a refusal, and the
   * caller renders `keysUnsupportedReason` instead of an empty picker.
   */
  keysSupported: boolean;
  keysUnsupportedReason: string | null;
}

/**
 * useApiKey — fetch OmniRoute API keys from /api/keys and expose the first
 * active key (or the one matching `preferredId`) as `apiKey`.
 *
 * The hook only fetches once on mount.  Use the returned `setApiKey` to let
 * the user pick a different key from a <select> control.
 */
export function useApiKey(opts?: UseApiKeyOptions): UseApiKeyResult {
  const [apiKey, setApiKey] = useState<string>("");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const keysSupport = resolveAisixSurfaceSupport("keys", "read");
  // Derived from the support flag at INITIALISATION, not cleared by an effect:
  // the core holds the resource but only its hash, so there is nothing to hand
  // the playground. Skipping the read keeps the picker from presenting a hash as
  // if it were a credential, and the caller says why via `keysUnsupportedReason`.
  // Setting it here rather than inside the effect also keeps
  // `react-hooks/set-state-in-effect` satisfied — there is no work to do, so
  // there is no loading state to finish.
  const [loading, setLoading] = useState<boolean>(keysSupport.supported);
  const preferredId = opts?.preferredId;

  useEffect(() => {
    if (!keysSupport.supported) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/keys");
        if (!res.ok) return;
        const data = (await res.json()) as { keys?: ApiKey[] };
        const list: ApiKey[] = data.keys ?? [];
        if (cancelled) return;
        setKeys(list);
        const active = preferredId
          ? list.find((k) => k.id === preferredId)
          : list.find((k) => k.isActive !== false);
        setApiKey(active?.key ?? "");
      } catch {
        // silently ignore — the playground is non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [preferredId, keysSupport.supported]);

  return {
    apiKey,
    setApiKey,
    keys,
    loading,
    keysSupported: keysSupport.supported,
    keysUnsupportedReason: keysSupport.supported ? null : keysSupport.reason,
  };
}
