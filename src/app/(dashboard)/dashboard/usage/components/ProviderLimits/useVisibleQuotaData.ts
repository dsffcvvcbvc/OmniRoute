import { useEffect, useMemo, useState } from "react";

import { collectHiddenQuotaModelIds, filterHiddenModelQuotas } from "./utils";
import { resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";

function getProviderKey(connections: any[]): string {
  const providers = new Set<string>();
  for (const conn of connections) {
    if (typeof conn?.provider === "string" && conn.provider) providers.add(conn.provider);
  }
  return Array.from(providers).sort().join("|");
}

export function useVisibleQuotaData(
  connections: any[],
  quotaData: Record<string, any>
): Record<string, any> {
  const [hiddenModelsByProvider, setHiddenModelsByProvider] = useState<Record<string, string[]>>(
    {}
  );
  const providerKey = useMemo(() => getProviderKey(connections), [connections]);

  useEffect(() => {
    if (!providerKey) return;

    let alive = true;
    const providers = providerKey.split("|").filter(Boolean);

    Promise.all(
      providers.map(async (provider) => {
        try {
          // Repointed at the core's `GET /admin/v1/models` on the AISIX export.
          // `collectHiddenQuotaModelIds` looks for `isHidden`, which the core's
          // catalog documents do not carry — so the answer here is "the core
          // reports no hidden models", and the operator's quota view is not
          // filtered. That is the honest reading: visibility flags are an
          // operator-authored Next.js setting with no core counterpart, and a
          // gateway that cannot know must not pretend to.
          const response = await fetch(
            resolveAisixRequestUrl(`/api/provider-models?provider=${encodeURIComponent(provider)}`)
          );
          if (!response.ok) return [provider, []] as const;
          const data = await response.json();
          return [provider, collectHiddenQuotaModelIds(provider, data)] as const;
        } catch {
          return [provider, []] as const;
        }
      })
    ).then((entries) => {
      if (alive) setHiddenModelsByProvider(Object.fromEntries(entries));
    });

    return () => {
      alive = false;
    };
  }, [providerKey]);

  return useMemo(() => {
    const next: Record<string, any> = {};
    for (const conn of connections) {
      const data = quotaData[conn.id];
      if (!data) continue;
      next[conn.id] = {
        ...data,
        quotas: filterHiddenModelQuotas(
          conn.provider,
          data.quotas,
          hiddenModelsByProvider[conn.provider]
        ),
      };
    }
    return next;
  }, [connections, hiddenModelsByProvider, quotaData]);
}
