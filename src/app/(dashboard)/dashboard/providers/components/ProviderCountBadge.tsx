"use client";

import { useTranslations } from "next-intl";

interface ProviderCountBadgeProps {
  /**
   * Connections configured in this section, or `null` when the admin plane
   * refused the read and the number is therefore UNKNOWN.
   *
   * `null` is not decoration. `0` would tell the operator they have configured
   * nothing in this section — a claim about their gateway that a 401 cannot
   * support, and one the same page is contradicting a few pixels away.
   */
  configured: number | null;
  total: number;
}

export default function ProviderCountBadge({ configured, total }: ProviderCountBadgeProps) {
  const t = useTranslations("providers");

  if (total === 0) return null;

  // Unknown reads as a dash, never as a zero. Muted rather than coloured: the
  // three existing colours all mean "this is a count", and none of them is true
  // here. The existing `configuredCount` key is the honest explanation of the
  // whole badge in the withheld case — it is already translated in every locale,
  // and it is the sentence the page is already saying in the banner above.
  if (configured === null) {
    return (
      <span
        className="text-xs font-medium text-text-muted"
        title={t("aisixAdminKeyRequired")}
        data-testid="provider-count-unknown"
      >
        —/{total}
      </span>
    );
  }

  const colorClass =
    configured === 0
      ? "text-text-muted"
      : configured === total
        ? "text-green-500"
        : "text-amber-500";

  return (
    <span
      className={`text-xs font-medium ${colorClass}`}
      title={t("configuredCount", { configured, total })}
    >
      {configured}/{total}
    </span>
  );
}
