"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { parseAisixProviderStatuses, resolveAisixHealthVerdict } from "@/shared/utils/aisixHealth";

export default function DegradationBadge() {
  const [isDegraded, setDegraded] = useState(false);
  const t = useTranslations("common"); // Or a specific namespace if needed

  useEffect(() => {
    const checkDegradation = async () => {
      try {
        // Repointed at the core's UNAUTHENTICATED `:9090/status/models` in the
        // static SPA export — the same native target the two sibling shell health
        // reads use, and the same payload the health page already parses. The
        // legacy `/api/health/degradation` route is a Next.js-only read of the
        // SQLite degradation table, so on a static host it 404'd, and because the
        // badge acted only on `res.ok` a 404 read as "not degraded" for a core
        // that had plenty to report.
        //
        // Deliberately NOT `/admin/v1/health`: that plane is authenticated, and a
        // 401 from any admin-plane read signs the whole dashboard out. A badge
        // that runs on every page cannot be allowed to do that to a visitor who
        // has not entered a key yet.
        const res = await fetch(resolveAisixRequestUrl("/api/health/degradation?summary=true"));
        if (res.ok) {
          const data = await res.json();
          setDegraded(resolveAisixHealthVerdict(parseAisixProviderStatuses(data)) !== "healthy");
        }
      } catch (err) {
        // Ignore error
      }
    };

    checkDegradation();
    const interval = setInterval(checkDegradation, 60000);
    return () => clearInterval(interval);
  }, []);

  if (!isDegraded) return null;

  return (
    <Link
      href="/dashboard/health"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors border border-amber-500/20"
      title={t("warning")} // Using common warning text, or we could just use English / fixed string if i18n is not strict
    >
      <span className="material-symbols-outlined text-[16px]">healing</span>
      <span className="text-xs font-semibold whitespace-nowrap">{t("degraded")}</span>
    </Link>
  );
}
