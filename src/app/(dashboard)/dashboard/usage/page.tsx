import { getTranslations } from "next-intl/server";

import { StaticRedirect } from "@/shared/components";

/**
 * `/dashboard/usage` is a legacy alias for `/dashboard/logs`.
 *
 * AGENT.md §3.3: `StaticRedirect` replaces `redirect("/dashboard/logs")` — a
 * Server Component `redirect()` cannot be prerendered for `output: "export"`.
 */
export default async function UsageRedirectPage() {
  const t = await getTranslations("sidebar");
  return <StaticRedirect to="/dashboard/logs" label={t("logs")} />;
}
