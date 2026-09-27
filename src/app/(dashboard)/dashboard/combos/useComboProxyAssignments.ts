import { useCallback, useEffect, useState } from "react";
import { resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";

// #7149: the Combo "Set Proxy" modal writes through the modern proxy_assignments
// registry (scope="combo"), not the legacy /api/settings/proxy `combos` map — the
// dashboard's "has a proxy" indicator must read from the same registry the modal
// actually writes to, or it stays stale/gray even after a successful save.
export function parseComboProxyAssignmentIds(data: unknown): string[] {
  const items = (data as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (entry): entry is { scopeId: string; proxyId: string } =>
        !!(entry as { scopeId?: unknown })?.scopeId && !!(entry as { proxyId?: unknown })?.proxyId
    )
    .map((entry) => entry.scopeId);
}

export function useComboProxyAssignments() {
  const [comboProxyAssignedIds, setComboProxyAssignedIds] = useState<Set<string>>(new Set());
  // The assignment registry is one of the `/api/settings/*` projections the
  // gateway cannot answer, so the read is skipped rather than 404ing. The
  // returned `assignmentsSupported` lets the page distinguish "no combo has a
  // proxy" (an empty set that was read) from "this host has no assignment
  // registry" — the two render as a grey and an actionable indicator
  // respectively, so conflating them would be a false claim either way.
  const assignmentsSupported = resolveAisixSurfaceSupport("settings", "read").supported;

  const fetchComboProxyAssignments = useCallback(() => {
    // The state is already an empty Set and the flag travels with the return
    // value, so there is nothing to set: the page distinguishes the two cases
    // from `assignmentsSupported`, not from a mutated collection.
    if (!assignmentsSupported) return;
    fetch("/api/settings/proxies/assignments?scope=combo")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setComboProxyAssignedIds(new Set(parseComboProxyAssignmentIds(data))))
      .catch(() => {});
  }, [assignmentsSupported]);

  useEffect(() => {
    fetchComboProxyAssignments();
  }, [fetchComboProxyAssignments]);

  return { comboProxyAssignedIds, fetchComboProxyAssignments, assignmentsSupported };
}
