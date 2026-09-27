import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/auto-combo` is a legacy alias for the intelligent-filter view of
 * the Combos page.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces the Server Component
 * `redirect("/dashboard/combos?filter=intelligent")`, which cannot be
 * prerendered for `output: "export"`.
 */
export default async function AutoComboRedirectPage() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/combos?filter=intelligent" label={t("combos")} />;
}
