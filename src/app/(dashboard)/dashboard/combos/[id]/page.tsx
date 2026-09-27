import ComboControlCenterClient from "../ComboControlCenterClient";

/**
 * AGENT.md §3.3: `output: "export"` refuses a dynamic segment with no
 * `generateStaticParams()` (Next E1452). A combo id names a row in the
 * operator's own database, so there is no build-time list to return — a
 * placeholder list would emit one shell per placeholder and 404 every real
 * combo. Declaring the route dynamic says plainly that this deep link has no
 * static representation; the `output: "standalone"` build is unaffected.
 */
export const dynamic = "force-dynamic";

export default async function ComboControlCenterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ComboControlCenterClient comboId={id} />;
}
