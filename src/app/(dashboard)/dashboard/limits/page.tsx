import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/limits` is a legacy alias for `/dashboard/quota`.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces `redirect("/dashboard/quota")` — a
 * Server Component `redirect()` cannot be prerendered for `output: "export"`.
 */
export default async function LimitsRedirect() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/quota" label={t("limits")} />;
}
