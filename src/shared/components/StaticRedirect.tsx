"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Static-export-safe forward (AGENT.md §3.3, `output: "export"`).
 *
 * A Server Component `redirect()` cannot be prerendered: during the export build
 * the page has no request, so Next has no origin to resolve the `Location`
 * against and the alias becomes a page whose only behaviour lives in a
 * meta-refresh fallback the export does not always emit. The `dashboard → home`
 * alias already moved to a prerendered link for exactly that reason; this
 * component is the same fix with the redirect UX kept — `useRouter().replace()`
 * runs on the client after hydration, and the rendered `<Link>` is what carries
 * the user when JavaScript never arrives (static host, disabled JS, crawler).
 *
 * Only use it for a Server Component forward whose target is a compile-time
 * constant. A forward that has to read `?tab=`/`?user_id=` cannot use this
 * (the query is only known in the browser) — those pages resolve the target in
 * their own Client Component instead.
 */
export type StaticRedirectProps = {
  /** Absolute in-app path to forward to. */
  to: string;
  /** Label of the no-JS fallback link. */
  label: string;
};

function ReplaceWith({ to }: { to: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return null;
}

export default function StaticRedirect({ to, label }: StaticRedirectProps) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ReplaceWith to={to} />
      <Link className="text-primary hover:underline" href={to}>
        {label}
      </Link>
    </main>
  );
}
