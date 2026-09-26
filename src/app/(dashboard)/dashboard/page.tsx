import { redirect } from "next/navigation";

// AGENT.md §3.3: SPA static export — redirect rendered statically via meta fallback in out/.
export default function DashboardPage() {
  redirect("/home");
}
