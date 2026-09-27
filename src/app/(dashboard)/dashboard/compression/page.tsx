import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/compression` forwards to the Caveman context page, which is where
 * compression tuning lives.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces the Server Component
 * `redirect("/dashboard/context/caveman")`, which cannot be prerendered for
 * `output: "export"`. The metadata block is kept — it is build-time data and
 * prerenders fine.
 */
export async function generateMetadata() {
  const t = await getTranslations("metadata");
  return {
    title: t("compressionTitle"),
    description: t("compressionDescription"),
  };
}

export default async function CompressionPage() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/context/caveman" label={t("contextCaveman")} />;
}
