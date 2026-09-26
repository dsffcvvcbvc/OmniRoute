import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * `/dashboard` is only an alias for `/home`.
 *
 * AGENT.md §3.3: a prerendered link replaces `redirect("/home")`. The static
 * export has to be correct with AND without JavaScript, and the client-side
 * `redirect()` a Server Component emits into `out/dashboard.html` is a
 * meta-refresh fallback — the alias silently becomes a dead page wherever that
 * fallback is not generated. A plain link always works; the existing
 * `/dashboard/skills → /dashboard/omni-skills` style rewrites do not apply to an
 * in-app alias like this one.
 */
export default async function DashboardPage() {
  const t = await getTranslations("sidebar");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Link className="text-primary hover:underline" href="/home">
        {t("home")}
      </Link>
    </main>
  );
}
