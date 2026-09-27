"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { resolveAisixRequestUrl } from "@/shared/utils/aisixEndpoints";
import { adaptAisixCoreHealth } from "@/shared/utils/aisixHealth";

export default function DegradationBadge() {
  const [isDegraded, setDegraded] = useState(false);
  const t = useTranslations("common"); // Or a specific namespace if needed

  useEffect(() => {
    const checkDegradation = async () => {
      try {
        // Repointed at `GET /admin/v1/health` in the static SPA export. The
        // legacy `/api/health/degradation` route is a Next.js-only read of the
        // SQLite degradation table, so on a static host it 404'd — and because
        // the badge only ever acted on `res.ok`, a 404 read as "not degraded".
        // The core DOES report degradation, so the answer was available and the
        // badge was discarding it.
        const res = await fetch(resolveAisixRequestUrl("/api/health/degradation?summary=true"));
        if (res.ok) {
          const data = await res.json();
          setDegraded(adaptAisixCoreHealth(data).isDegraded);
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
