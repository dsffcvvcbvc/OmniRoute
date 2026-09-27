"use client";

import { useTranslations } from "next-intl";

/**
 * Core-state badge for `/home` (AGENT.md §3.3).
 *
 * `loadHomeSettings()` reports `"unknown"` when the native admin plane is
 * unreachable — deliberately distinct from `true` ("setup is complete").
 * Rendering nothing for `unknown` made it visually identical to a completed
 * setup, so the badge says so explicitly: amber, `role="status"`, impossible
 * to confuse with the blue first-run card or with setup-complete silence.
 */
export default function CoreStateBadge() {
  const t = useTranslations("home");

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4"
    >
      <span className="material-symbols-outlined mt-0.5 shrink-0 text-[20px] text-amber-500">
        cloud_off
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
          {t("coreUnreachableBadge")}
        </p>
        <p className="mt-0.5 text-sm text-amber-700/80 dark:text-amber-200/80">
          {t("coreUnreachableHint")}
        </p>
      </div>
    </div>
  );
}
