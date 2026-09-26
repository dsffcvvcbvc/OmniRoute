import RuntimePageClient from "./RuntimePageClient";

// AGENT.md §3.3: SPA static export — no force-dynamic.
export default function RuntimePage() {
  return <RuntimePageClient />;
}
