"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const LEGACY_TAB_ROUTES: Record<string, string> = {
  advanced: "/dashboard/settings/advanced",
  ai: "/dashboard/settings/ai",
  appearance: "/dashboard/settings/appearance",
  featureFlags: "/dashboard/settings/feature-flags",
  "feature-flags": "/dashboard/settings/feature-flags",
  cache: "/dashboard/settings/cache",
  general: "/dashboard/settings/general",
  modalityBridge: "/dashboard/settings/modality-bridge",
  "modality-bridge": "/dashboard/settings/modality-bridge",
  resilience: "/dashboard/settings/resilience",
  routing: "/dashboard/settings/routing",
  security: "/dashboard/settings/security",
  sidebar: "/dashboard/settings/sidebar",
};

const DEFAULT_SETTINGS_ROUTE = "/dashboard/settings/general";

export function resolveSettingsRoute(value: string | undefined): string {
  return value ? LEGACY_TAB_ROUTES[value] || DEFAULT_SETTINGS_ROUTE : DEFAULT_SETTINGS_ROUTE;
}

// AGENT.md §3.3: `/dashboard/settings` forwards on the client — see the note on
// the sibling `../context/page.tsx`. Awaiting `searchParams` in a Server
// Component would make this page unprerenderable and hard-fail
// `output: "export"`.
function SettingsRedirector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const target = resolveSettingsRoute(searchParams.get("tab") ?? undefined);

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return null;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsRedirector />
    </Suspense>
  );
}
