import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/settings/pricing` is a legacy alias for the pricing tab of Costs.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces the Server Component
 * `redirect("/dashboard/costs/pricing")`, which cannot be prerendered for
 * `output: "export"`.
 */
export default async function SettingsPricingPage() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/costs/pricing" label={t("costs")} />;
}
