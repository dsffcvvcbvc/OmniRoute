"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Root entry. Zed's native-app sign-in always redirects the browser to the
 * loopback ROOT (`http://127.0.0.1:<dashboard-port>/?user_id=...&access_token=...`),
 * ignoring any path — when the dashboard port is reused as native_app_port
 * (see zed-hosted.ts), that redirect lands HERE. Forward the payload to the
 * /callback relay (which postMessages it to the waiting OAuth modal) instead of
 * the plain /dashboard redirect below, which would drop the query string.
 *
 * AGENT.md §3.3: the forward runs on the client. A Server Component can only
 * read `?user_id=`/`?access_token=` by awaiting `searchParams`, which opts this
 * page out of static generation and hard-fails `output: "export"` — and CI
 * asserts `out/index.html` exists. Resolving the query in the browser is the
 * same decision with a prerenderable root.
 */
const DEFAULT_ENTRY_ROUTE = "/dashboard";

export function resolveEntryRoute(params: URLSearchParams): string {
  if (params.get("user_id") && params.get("access_token")) {
    return `/callback?${params.toString()}`;
  }
  return DEFAULT_ENTRY_ROUTE;
}

function EntryRedirector() {
  const router = useRouter();
  // `useSearchParams` must sit behind a Suspense boundary or the static export
  // refuses to prerender the page.
  const searchParams = useSearchParams();
  const target = resolveEntryRoute(new URLSearchParams(searchParams));

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return null;
}

export default function InitPage() {
  return (
    <Suspense fallback={null}>
      <EntryRedirector />
    </Suspense>
  );
}
