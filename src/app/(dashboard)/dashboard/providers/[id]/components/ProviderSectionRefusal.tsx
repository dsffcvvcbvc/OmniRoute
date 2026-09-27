"use client";

/**
 * ProviderSectionRefusal — the honest state for a provider-detail config card
 * whose backing surface does not exist on this deployment.
 *
 * The alternative the three cards used to have was worse in both directions: a
 * skeleton that never resolves (infinite spinner) or a form pre-filled with
 * defaults, which reads as "your provider has no filters configured" when the
 * truth is "there is nothing here to read". A silent 404 rendered as an empty
 * success is a lie the operator cannot detect.
 *
 * Visual language is the one the logs page already uses for the same situation
 * (`data-testid` + `role="status"` + amber border + `block` glyph), so the
 * gateway-only story looks the same wherever an operator meets it.
 */

export interface ProviderSectionRefusalProps {
  /** Names the card, e.g. "Фильтры параметров" — the operator needs to know WHICH rule is absent. */
  title: string;
  /** The refusal itself: the architectural reason, or the concrete failure. */
  reason: string;
  /** Disambiguates the testids of the three cards on one page. */
  testId: string;
}

export default function ProviderSectionRefusal({
  title,
  reason,
  testId,
}: ProviderSectionRefusalProps) {
  return (
    <div className="rounded-xl border border-border bg-white p-5 dark:bg-zinc-950">
      <h2 className="text-base font-semibold text-text-main mb-1">{title}</h2>
      <div
        role="status"
        data-testid={testId}
        className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200"
      >
        <span className="material-symbols-outlined text-[18px] text-amber-500 shrink-0">block</span>
        <span className="flex-1">{reason}</span>
      </div>
    </div>
  );
}
