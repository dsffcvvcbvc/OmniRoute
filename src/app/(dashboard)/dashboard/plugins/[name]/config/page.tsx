import PluginConfigPageClient from "./PluginConfigPageClient";

/**
 * /dashboard/plugins/[name]/config
 *
 * AGENT.md §3.3: `output: "export"` refuses a dynamic segment with no
 * `generateStaticParams()` (Next E1452). The installed-plugin set lives in the
 * operator's own database and is unknowable at build time, so there is no
 * honest parameter list — a placeholder list would emit one shell per
 * placeholder and 404 every real plugin. Declaring the route dynamic states
 * that this deep link has no static representation; the `output: "standalone"`
 * build, which actually serves it, is unaffected.
 *
 * The config lives here rather than in the client component because route
 * segment config is only readable from a Server Component module.
 */
export const dynamic = "force-dynamic";

export default function PluginConfigPage({ params }: { params: Promise<{ name: string }> }) {
  return <PluginConfigPageClient params={params} />;
}
