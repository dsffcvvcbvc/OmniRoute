import ComboControlCenterClient from "../ComboControlCenterClient";

/**
 * A combo id names a row in the operator's own database, so this deep link has
 * no build-time parameter list: `output: "export"` refuses a dynamic route with
 * no `generateStaticParams()` (Next E1452) and, at the export phase, refuses a
 * `force-dynamic` page outright — a placeholder list would emit one shell per
 * placeholder and 404 every real combo.
 *
 * The export build therefore moves this route aside (see
 * `getTransientBuildPaths()` in scripts/build/build-next-isolated.mjs) rather
 * than pretending a static shell exists for it. The `output: "standalone"`
 * build — what actually serves it — is untouched.
 */
export default async function ComboControlCenterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ComboControlCenterClient comboId={id} />;
}
