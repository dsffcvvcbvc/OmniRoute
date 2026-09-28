// Currency formatting for the costs surface. Shared by the tab itself, the
// explorer/breakdown cards under `components/`, and TopListCard — three
// consumers that must agree on the digit rules, so the rules live here rather
// than being restated per component.

export function createCurrencyFormatter(locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Adaptive cost rendering: sub-cent figures keep enough significant digits to
 * stay readable instead of collapsing to `$0.00`, and a zero/non-finite value
 * renders as a plain `$0.00` rather than picking up the adaptive precision.
 */
export function formatCurrencyCost(locale: string, value: number): string {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue === 0) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  }

  const absValue = Math.abs(numericValue);
  const fractionDigits = absValue < 0.01 ? 6 : absValue < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(numericValue);
}
