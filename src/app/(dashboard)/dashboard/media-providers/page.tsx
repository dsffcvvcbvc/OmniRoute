import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/media-providers` is a hub with no page of its own; it forwards to
 * the canonical kind list.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces the Server Component
 * `redirect("/dashboard/media-providers/embedding")`, which cannot be
 * prerendered for `output: "export"`.
 */
export default async function MediaProvidersPage() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/media-providers/embedding" label={t("media")} />;
}
