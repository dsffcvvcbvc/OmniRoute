"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// `/dashboard/context` is a hub with only sub-routes (settings, combos, ultra,
// …) and no page of its own, so Next.js RSC prefetches of the bare parent
// route 404'd (#5298). Redirect the parent to its canonical sub-route, honoring
// a legacy `?tab=` query for deep links.
//
// AGENT.md §3.3: this page is a Client Component that forwards on the client.
// A Server Component here could only honour `?tab=` by awaiting `searchParams`,
// which opts the page out of static generation and hard-fails
// `output: "export"`. Reading the query in the browser is the same resolution
// with a prerenderable page. The resolver stays a pure exported function
// (regression-guarded by tests/unit/dashboard/context-parent-redirect-5298.test.ts).
const CONTEXT_TAB_ROUTES: Record<string, string> = {
  settings: "/dashboard/context/settings",
  combos: "/dashboard/context/combos",
  caveman: "/dashboard/context/caveman",
  rtk: "/dashboard/context/rtk",
  headroom: "/dashboard/context/headroom",
  "session-dedup": "/dashboard/context/session-dedup",
  sessionDedup: "/dashboard/context/session-dedup",
  ccr: "/dashboard/context/ccr",
  llmlingua: "/dashboard/context/llmlingua",
  lite: "/dashboard/context/lite",
  aggressive: "/dashboard/context/aggressive",
  ultra: "/dashboard/context/ultra",
};

const DEFAULT_CONTEXT_ROUTE = "/dashboard/context/settings";

export function resolveContextRoute(value: string | undefined): string {
  return value ? CONTEXT_TAB_ROUTES[value] || DEFAULT_CONTEXT_ROUTE : DEFAULT_CONTEXT_ROUTE;
}

function ContextRedirector() {
  const router = useRouter();
  // `useSearchParams` must sit behind a Suspense boundary or the static export
  // refuses to prerender the page.
  const searchParams = useSearchParams();
  const target = resolveContextRoute(searchParams.get("tab") ?? undefined);

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return null;
}

export default function ContextPage() {
  return (
    <Suspense fallback={null}>
      <ContextRedirector />
    </Suspense>
  );
}
