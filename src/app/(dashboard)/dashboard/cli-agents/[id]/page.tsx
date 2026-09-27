import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { notFound } from "next/navigation";
import ToolDetailClient from "../../cli-code/components/ToolDetailClient";

/**
 * AGENT.md §3.3: `output: "export"` refuses a dynamic segment that has no
 * `generateStaticParams()` (Next E1452).
 *
 * The honest parameter list exists here: `CLI_TOOLS` is a build-time literal
 * registry, so the agent tool ids are known exactly at build time. Returning
 * precisely the tools whose category is "agent" emits one page per tool that
 * really exists — no placeholder ids, and no real id 404s against the
 * prerendered set. The `notFound()` guard below stays as the live-server
 * contract for a hand-typed unknown id.
 */
export function generateStaticParams() {
  return Object.entries(CLI_TOOLS)
    .filter(([, tool]) => tool.category === "agent")
    .map(([id]) => ({ id }));
}

export default async function CliAgentsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tool = CLI_TOOLS[id];
  if (!tool || tool.category !== "agent") notFound();
  return <ToolDetailClient toolId={id} category="agent" />;
}
