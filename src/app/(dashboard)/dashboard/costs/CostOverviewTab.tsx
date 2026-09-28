"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import { Card, EmptyState, SegmentedControl, CardSkeleton } from "@/shared/components";
import {
  getServiceTierDisplayLabel,
  type TranslationFn as CostTranslationFn,
} from "@/shared/utils/serviceTierLabels";
import dynamic from "next/dynamic";

const CostTrendCard = dynamic(
  () => import("./components/CostCharts").then((m) => ({ default: m.CostTrendCard })),
  { ssr: false }
);
const ProviderSpendCard = dynamic(
  () => import("./components/CostCharts").then((m) => ({ default: m.ProviderSpendCard })),
  { ssr: false }
);
const WeeklyPatternCard = dynamic(
  () => import("./components/CostCharts").then((m) => ({ default: m.WeeklyPatternCard })),
  { ssr: false }
);

import {
  buildCostExplorerRows,
  type CostExplorerGroupBy,
  type CostExplorerSortDirection,
  type CostExplorerSortKey,
} from "./costExplorerUtils";

import {
  parseApiKeyIds,
  parseCostRange,
  parseExplorerGroupBy,
  type CostRange,
} from "./costExplorerParams";
import { ApiKeyUsageLimitCard } from "./components/ApiKeyUsageLimitCard";
import { MetricCard } from "./components/MetricCard";
import { TopListCard } from "./components/TopListCard";
import { CostExplorerCard } from "./components/CostExplorerCard";
import { ActivityHeatmap } from "./components/ActivityHeatmap";
import { CostBreakdownTable } from "./components/CostBreakdownTable";
import { createCurrencyFormatter, formatCurrencyCost } from "./costCurrency";
import { useApiKeyUsageLimits } from "./useApiKeyUsageLimits";
import {
  aisixStatusModelsUrl,
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";
import { adaptAisixTelemetry, type AisixTelemetry } from "@/shared/utils/aisixHealth";

interface UsageAnalyticsSummary {
  totalCost: number;
  totalRequests: number;
  uniqueModels: number;
  uniqueAccounts: number;
  uniqueApiKeys: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  fallbackCount: number;
  fallbackRatePct: number;
  requestedModelCoveragePct: number;
  streak: number;
  flexRequests?: number;
  flexCost?: number;
  flexSavings?: number;
  flexUsageSavingsTokens?: number;
}

interface UsageAnalyticsProviderRow {
  provider: string;
  requests: number;
  totalTokens: number;
  cost: number;
}

interface UsageAnalyticsModelRow {
  model: string;
  requests: number;
  totalTokens: number;
  cost: number;
}

interface UsageAnalyticsTrendRow {
  date: string;
  cost: number;
}

interface UsageAnalyticsApiKeyRow {
  apiKey: string;
  apiKeyId: string | null;
  apiKeyName: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

interface UsageAnalyticsAccountRow {
  account: string;
  totalTokens: number;
  requests: number;
  cost: number;
}

interface UsageAnalyticsServiceTierRow {
  serviceTier: "standard" | "priority" | "flex";
  label: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  savings?: number;
  usageSavingsTokens?: number;
}

interface UsageAnalyticsPayload {
  summary: UsageAnalyticsSummary;
  byProvider: UsageAnalyticsProviderRow[];
  byModel: UsageAnalyticsModelRow[];
  byApiKey: UsageAnalyticsApiKeyRow[];
  byAccount: UsageAnalyticsAccountRow[];
  byServiceTier?: UsageAnalyticsServiceTierRow[];
  dailyTrend: UsageAnalyticsTrendRow[];
  weeklyPattern: Array<{ day: string; avgTokens: number; totalTokens: number }>;
  activityMap: Record<string, number>;
  presetSummaries?: Record<string, { totalCost: number }>;
  // The API reports whether the returned cost figures include token-price
  // equivalents for flat-rate subscriptions (route.ts). Billed-cost mode omits
  // it, so treat anything but an explicit `true` as billed money.
  includesFlatRateEstimates?: boolean;
}

const RANGE_OPTIONS: Array<{ value: CostRange; labelKey: string }> = [
  { value: "7d", labelKey: "range7d" },
  { value: "30d", labelKey: "range30d" },
  { value: "90d", labelKey: "range90d" },
  { value: "180d", labelKey: "range180d" },
  { value: "365d", labelKey: "range365d" },
  { value: "all", labelKey: "rangeAll" },
];

const EXPLORER_GROUP_OPTIONS: Array<{
  value: CostExplorerGroupBy;
  labelKey: string;
}> = [
  { value: "provider", labelKey: "groupProvider" },
  { value: "model", labelKey: "groupModel" },
  { value: "apiKey", labelKey: "groupApiKey" },
  { value: "account", labelKey: "groupAccount" },
  { value: "serviceTier", labelKey: "groupServiceTier" },
];

const CHART_COLORS = [
  "#10b981",
  "#06b6d4",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#6366f1",
  "#ec4899",
];

const SHORT_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function formatWeekdayLabel(day: string, locale: string): string {
  const index = SHORT_WEEKDAY_INDEX[day.slice(0, 3)];
  if (index === undefined) return day;
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
    new Date(Date.UTC(2024, 0, 7 + index))
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The exports are consumed outside the app, where no i18n runtime is available
// and the header/summary keys are already English literals, so the estimate
// disclosure ships as an English marker alongside them.
const FLAT_RATE_ESTIMATE_CSV_NOTE =
  "Includes token-price estimates for flat-rate subscriptions; not billed cost.";

function generateCSV(analytics: UsageAnalyticsPayload, locale: string): string {
  const currencyFormatter = createCurrencyFormatter(locale);
  const lines: string[] = [];
  // Only an explicit `true` means estimate mode; omitted/false/malformed stays
  // billed-cost, which is what the API itself does with the query parameter.
  const includesEstimates = analytics.includesFlatRateEstimates === true;

  lines.push("# OmniRoute Cost Report");
  lines.push(`# Generated: ${new Date().toISOString()}`);
  if (includesEstimates) {
    lines.push(`# ${FLAT_RATE_ESTIMATE_CSV_NOTE}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("Metric,Value");
  lines.push(
    `${csvCell(includesEstimates ? "Total Cost (includes flat-rate estimates)" : "Total Cost")},${csvCell(currencyFormatter.format(analytics.summary.totalCost))}`
  );
  lines.push(`Total Requests,${analytics.summary.totalRequests}`);
  lines.push(`Unique Models,${analytics.summary.uniqueModels}`);
  lines.push(`Unique Accounts,${analytics.summary.uniqueAccounts}`);
  lines.push(`Total Tokens,${analytics.summary.totalTokens}`);
  lines.push("");

  lines.push("## Daily Cost Trend");
  lines.push("Date,Cost (USD)");
  for (const row of analytics.dailyTrend) {
    lines.push(`${csvCell(row.date)},${row.cost.toFixed(6)}`);
  }
  lines.push("");

  lines.push("## Cost by Provider");
  lines.push("Provider,Requests,Total Tokens,Cost (USD)");
  for (const row of analytics.byProvider) {
    lines.push(
      [row.provider, row.requests, row.totalTokens, row.cost.toFixed(6)].map(csvCell).join(",")
    );
  }
  lines.push("");

  lines.push("## Cost by Model");
  lines.push("Model,Requests,Total Tokens,Cost (USD)");
  for (const row of analytics.byModel) {
    lines.push(
      [row.model, row.requests, row.totalTokens, row.cost.toFixed(6)].map(csvCell).join(",")
    );
  }
  lines.push("");

  lines.push("## Cost by API Key");
  lines.push("API Key,Requests,Total Tokens,Cost (USD)");
  for (const row of analytics.byApiKey || []) {
    lines.push(
      [row.apiKeyName || row.apiKey, row.requests, row.totalTokens, row.cost.toFixed(6)]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push("");

  lines.push("## Cost by Account");
  lines.push("Account,Requests,Total Tokens,Cost (USD)");
  for (const row of analytics.byAccount || []) {
    lines.push(
      [row.account, row.requests, row.totalTokens, row.cost.toFixed(6)].map(csvCell).join(",")
    );
  }

  return lines.join("\n");
}

function generateJSON(analytics: UsageAnalyticsPayload): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      includesFlatRateEstimates: analytics.includesFlatRateEstimates === true,
      summary: analytics.summary,
      dailyTrend: analytics.dailyTrend,
      weeklyPattern: analytics.weeklyPattern,
      activityMap: analytics.activityMap,
      byProvider: analytics.byProvider,
      byModel: analytics.byModel,
      byApiKey: analytics.byApiKey || [],
      byAccount: analytics.byAccount || [],
    },
    null,
    2
  );
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function CostOverviewTab() {
  const t = useTranslations("costs");
  const locale = useLocale();
  const nodeMap = useProviderNodeMap();
  const searchParams = useSearchParams();
  const apiKeyIdsParam = searchParams.get("apiKeyIds");
  const selectedApiKeyIds = useMemo(() => parseApiKeyIds(apiKeyIdsParam), [apiKeyIdsParam]);
  const selectedApiKeyId = selectedApiKeyIds.length === 1 ? selectedApiKeyIds[0] : null;
  const apiKeyFilter = useMemo(() => selectedApiKeyIds.join(","), [selectedApiKeyIds]);
  const currencyFormatter = useMemo(() => createCurrencyFormatter(locale), [locale]);
  const [range, setRange] = useState<CostRange>(() => parseCostRange(searchParams.get("range")));
  const [analytics, setAnalytics] = useState<UsageAnalyticsPayload | null>(null);
  const [presetCosts, setPresetCosts] = useState<Record<"1d" | "7d" | "30d", number>>({
    "1d": 0,
    "7d": 0,
    "30d": 0,
  });
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [explorerGroupBy, setExplorerGroupBy] = useState<CostExplorerGroupBy>(() =>
    parseExplorerGroupBy(searchParams.get("groupBy"))
  );
  const [explorerSearch, setExplorerSearch] = useState("");
  const [explorerSortKey, setExplorerSortKey] = useState<CostExplorerSortKey>("cost");
  const [explorerSortDirection, setExplorerSortDirection] =
    useState<CostExplorerSortDirection>("desc");
  const {
    payload: apiKeyUsageLimits,
    loading: apiKeyUsageLimitsLoading,
    save: saveApiKeyUsageLimits,
    unsupported: apiKeyLimitsUnsupported,
    unsupportedReason: apiKeyLimitsUnsupportedReason,
  } = useApiKeyUsageLimits(selectedApiKeyId);
  // `/api/usage/analytics` is a Next/SQLite report (cost + token breakdowns per
  // provider/model/account/key). The AISIX gateway has no equivalent: `:9090`
  // reports request/latency COUNTERS, which is a different dataset — mapping
  // one onto the other would render invented dollar figures. So the page either
  // reports "no native equivalent" or shows the counters the core DOES report.
  const usageRead = resolveAisixSurfaceSupport("usage", "read");
  const usageSupported = usageRead.supported;
  const [nativeSignal, setNativeSignal] = useState<AisixTelemetry | null>(null);

  // The one usage summary the core genuinely exposes, read through the same
  // adapter the health page uses. Parsed tolerantly: a field the snapshot does
  // not carry stays `null` and renders "—", never 0.
  useEffect(() => {
    if (usageSupported) return;
    let cancelled = false;
    void (async () => {
      const result = await fetchAisixJson(aisixStatusModelsUrl(), { cache: "no-store" });
      if (cancelled) return;
      setNativeSignal(result.ok ? adaptAisixTelemetry(result.data) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [usageSupported]);

  useEffect(() => {
    let active = true;

    async function loadRange() {
      if (!usageSupported) {
        setLoading(false);
        setSummaryLoading(false);
        return;
      }
      setLoading(true);
      setSummaryLoading(true);
      const params = new URLSearchParams({
        range,
        presets: "1d,7d,30d",
        includeFlatRateEstimates: "true",
      });
      if (apiKeyFilter) params.set("apiKeyIds", apiKeyFilter);
      const result = await fetchAisixJson(
        resolveAisixRequestUrl(`/api/usage/analytics?${params.toString()}`)
      );
      if (!active) return;
      if (!result.ok) {
        setError(result.missing ? usageRead.reason : (result.error ?? t("overviewLoadFailed")));
        setLoading(false);
        setSummaryLoading(false);
        return;
      }
      const payload = (result.data ?? null) as UsageAnalyticsPayload | null;
      setAnalytics(payload);
      if (payload?.presetSummaries) {
        setPresetCosts({
          "1d": payload.presetSummaries["1d"]?.totalCost || 0,
          "7d": payload.presetSummaries["7d"]?.totalCost || 0,
          "30d": payload.presetSummaries["30d"]?.totalCost || 0,
        });
      }
      setError(null);
      setLoading(false);
      setSummaryLoading(false);
    }

    void loadRange();

    return () => {
      active = false;
    };
  }, [apiKeyFilter, range, t, usageSupported, usageRead.reason]);

  const selectedRangeLabel = t(
    RANGE_OPTIONS.find((option) => option.value === range)?.labelKey || "range30d"
  );
  const summary = analytics?.summary || {
    totalCost: 0,
    totalRequests: 0,
    uniqueModels: 0,
    uniqueAccounts: 0,
    uniqueApiKeys: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    fallbackCount: 0,
    fallbackRatePct: 0,
    requestedModelCoveragePct: 0,
    streak: 0,
  };
  const hasCostData = summary.totalCost > 0;
  // The API opts this page into token-price equivalents for flat-rate
  // subscriptions (includeFlatRateEstimates=true above) and reports back whether
  // the figures actually carry them. Only an explicit `true` switches the page
  // to estimate wording — omitted, false, malformed or unknown values keep the
  // billed-cost presentation, matching the API's own default.
  const includesFlatRateEstimates = analytics?.includesFlatRateEstimates === true;

  const providersByCost = [...(analytics?.byProvider || [])]
    .filter((provider) => (hasCostData ? provider.cost > 0 : provider.requests > 0))
    .sort((left, right) => (hasCostData ? right.cost - left.cost : right.requests - left.requests))
    .map((row) => ({ ...row, provider: resolveProviderName(row.provider, nodeMap) }));
  const modelsByCost = [...(analytics?.byModel || [])]
    .filter((model) => (hasCostData ? model.cost > 0 : model.requests > 0))
    .sort((left, right) => (hasCostData ? right.cost - left.cost : right.requests - left.requests));
  const apiKeysByCost = [...(analytics?.byApiKey || [])]
    .filter((apiKey) => (hasCostData ? apiKey.cost > 0 : apiKey.requests > 0))
    .sort((left, right) => (hasCostData ? right.cost - left.cost : right.requests - left.requests));
  const accountsByCost = [...(analytics?.byAccount || [])]
    .filter((account) => (hasCostData ? account.cost > 0 : account.requests > 0))
    .sort((left, right) => (hasCostData ? right.cost - left.cost : right.requests - left.requests));
  const localizedAnalytics = useMemo<UsageAnalyticsPayload | null>(() => {
    if (!analytics?.byServiceTier) return analytics;
    return {
      ...analytics,
      byServiceTier: analytics.byServiceTier.map((row) => ({
        ...row,
        label: getServiceTierDisplayLabel(t as CostTranslationFn, row.serviceTier, row.label),
      })),
    };
  }, [analytics, t]);
  const avgCostPerRequest =
    summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0;
  const dailyTrend = analytics?.dailyTrend || [];
  const recentDays = dailyTrend.slice(-7);
  const avgDailyCost =
    recentDays.length > 0
      ? recentDays.reduce((sum, day) => sum + (day.cost || 0), 0) / recentDays.length
      : 0;
  const today = new Date();
  const daysRemainingInMonth =
    new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
  const projectedMonthEnd =
    (presetCosts["30d"] || summary.totalCost) + avgDailyCost * daysRemainingInMonth;
  const trendLength = dailyTrend.length;
  const halfLength = Math.floor(trendLength / 2);
  const firstHalf = dailyTrend.slice(0, halfLength);
  const secondHalf = dailyTrend.slice(halfLength);
  const firstHalfCost = firstHalf.reduce((sum, day) => sum + (day.cost || 0), 0);
  const secondHalfCost = secondHalf.reduce((sum, day) => sum + (day.cost || 0), 0);
  const costChangePct =
    firstHalfCost > 0
      ? ((secondHalfCost - firstHalfCost) / firstHalfCost) * 100
      : secondHalfCost > 0
        ? 100
        : 0;
  const explorerRows = useMemo(
    () =>
      buildCostExplorerRows({
        analytics: localizedAnalytics,
        groupBy: explorerGroupBy,
        searchQuery: explorerSearch,
        sortKey: explorerSortKey,
        sortDirection: explorerSortDirection,
      }),
    [localizedAnalytics, explorerGroupBy, explorerSearch, explorerSortDirection, explorerSortKey]
  );
  const explorerVisibleRows = explorerRows.slice(0, 50);

  function handleExplorerSort(sortKey: CostExplorerSortKey) {
    if (explorerSortKey === sortKey) {
      setExplorerSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }

    setExplorerSortKey(sortKey);
    setExplorerSortDirection(sortKey === "name" ? "asc" : "desc");
  }

  if (loading && !analytics) {
    return <CardSkeleton />;
  }

  // No native cost/usage analytics: say so once, show the counters the core does
  // report, and do NOT render the cost tables — their `0` defaults would read as
  // "you spent nothing", which is a fabricated answer rather than a missing one.
  if (!usageSupported) {
    return (
      <div className="flex flex-col gap-6">
        <Card className="p-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-text-main">{t("overviewTitle")}</h2>
            <p className="text-sm text-text-muted">{t("overviewDescription")}</p>
          </div>
        </Card>

        <div
          role="status"
          data-testid="cost-usage-unavailable-banner"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200"
        >
          <span className="material-symbols-outlined text-[18px] text-amber-500 shrink-0">
            block
          </span>
          <span className="flex-1">{usageRead.reason}</span>
        </div>

        {/* The native signal the core DOES report (request/latency counters). */}
        {nativeSignal?.hasReportedSignal ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard
              label={t("requestsInWindow")}
              value={
                nativeSignal.totalRequests === null
                  ? "—"
                  : new Intl.NumberFormat(locale).format(nativeSignal.totalRequests)
              }
            />
            <MetricCard label={t("activeModels")} value={String(nativeSignal.modelCount)} />
            <MetricCard
              label={t("avgCostPerRequest")}
              // The core reports no price per request: a dollar figure here
              // would be invented, so the honest value is "—".
              value="—"
            />
          </div>
        ) : (
          <EmptyState icon="payments" title={t("overviewTitle")} description={usageRead.reason} />
        )}

        {apiKeyLimitsUnsupported && apiKeyLimitsUnsupportedReason && (
          <div className="rounded-lg border border-border bg-surface/40 px-4 py-3 text-xs text-text-muted">
            {apiKeyLimitsUnsupportedReason}
          </div>
        )}
      </div>
    );
  }

  if (error && !analytics) {
    return (
      <Card className="p-6">
        <EmptyState icon="payments" title={t("overviewTitle")} description={error} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-bold text-text-main">{t("overviewTitle")}</h2>
            <p className="text-sm text-text-muted mt-1">{t("overviewDescription")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {summary.streak > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                <span className="material-symbols-outlined text-amber-400 text-sm">
                  local_fire_department
                </span>
                <span className="text-sm font-semibold text-amber-400">{summary.streak}</span>
                <span className="text-xs text-amber-400/70">{t("dayStreak")}</span>
              </div>
            )}
            {analytics && summary.totalCost > 0 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    const csv = generateCSV(analytics, locale);
                    const dateStr = new Date().toISOString().slice(0, 10);
                    downloadFile(csv, `omniroute-costs-${range}-${dateStr}.csv`, "text/csv");
                  }}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-text-muted hover:text-text-main hover:bg-surface/50 rounded-lg border border-border/30 transition-colors"
                  title={t("exportCSV")}
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  CSV
                </button>
                <button
                  onClick={() => {
                    const json = generateJSON(analytics);
                    const dateStr = new Date().toISOString().slice(0, 10);
                    downloadFile(
                      json,
                      `omniroute-costs-${range}-${dateStr}.json`,
                      "application/json"
                    );
                  }}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-text-muted hover:text-text-main hover:bg-surface/50 rounded-lg border border-border/30 transition-colors"
                  title={t("exportJSON")}
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  JSON
                </button>
              </div>
            )}
            <SegmentedControl
              options={RANGE_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              value={range}
              onChange={(value) => setRange(value as CostRange)}
            />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label={t("spendToday")}
          value={formatCurrencyCost(locale, presetCosts["1d"] || 0)}
          loading={summaryLoading}
          color="text-emerald-400"
        />
        <MetricCard
          label={t("spend7d")}
          value={formatCurrencyCost(locale, presetCosts["7d"] || 0)}
          loading={summaryLoading}
          color="text-sky-400"
        />
        <MetricCard
          label={t("spend30d")}
          value={formatCurrencyCost(locale, presetCosts["30d"] || 0)}
          loading={summaryLoading}
          color="text-violet-400"
        />
        <MetricCard
          label={t("selectedWindow")}
          value={formatCurrencyCost(locale, summary.totalCost || 0)}
          subValue={selectedRangeLabel}
          color="text-amber-400"
        />
      </div>

      {includesFlatRateEstimates && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <span className="material-symbols-outlined text-amber-400 text-base leading-5">info</span>
          <p className="text-xs text-amber-300/90">{t("flatRateEstimateNotice")}</p>
        </div>
      )}

      {selectedApiKeyId && (
        <ApiKeyUsageLimitCard
          payload={apiKeyUsageLimits}
          loading={apiKeyUsageLimitsLoading}
          locale={locale}
          onSave={saveApiKeyUsageLimits}
        />
      )}

      <Card className="p-5">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <CompactMetric
            label={t("requestsInWindow")}
            value={new Intl.NumberFormat(locale).format(summary.totalRequests || 0)}
          />
          <CompactMetric
            label={t("activeProviders")}
            value={new Intl.NumberFormat(locale).format(providersByCost.length)}
          />
          <CompactMetric
            label={t("activeModels")}
            value={new Intl.NumberFormat(locale).format(summary.uniqueModels || 0)}
          />
          <CompactMetric
            label={t("avgCostPerRequest")}
            value={formatCurrencyCost(locale, avgCostPerRequest)}
          />
        </div>
      </Card>

      <CostExplorerCard
        rows={explorerVisibleRows}
        totalRows={explorerRows.length}
        groupBy={explorerGroupBy}
        groupOptions={EXPLORER_GROUP_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        searchQuery={explorerSearch}
        sortKey={explorerSortKey}
        sortDirection={explorerSortDirection}
        locale={locale}
        hasCostData={hasCostData}
        onGroupByChange={setExplorerGroupBy}
        onSearchChange={setExplorerSearch}
        onSort={handleExplorerSort}
      />

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
          {t("tokenUsage")}
        </h3>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <CompactMetric
            label={t("totalTokens")}
            value={new Intl.NumberFormat(locale, { notation: "compact" }).format(
              summary.totalTokens || 0
            )}
          />
          <CompactMetric
            label={t("inputTokens")}
            value={new Intl.NumberFormat(locale, { notation: "compact" }).format(
              summary.promptTokens || 0
            )}
          />
          <CompactMetric
            label={t("outputTokens")}
            value={new Intl.NumberFormat(locale, { notation: "compact" }).format(
              summary.completionTokens || 0
            )}
          />
          <CompactMetric
            label={t("inputOutputRatio")}
            value={
              summary.completionTokens > 0
                ? `${(summary.promptTokens / summary.completionTokens).toFixed(1)}:1`
                : "-"
            }
          />
        </div>
      </Card>

      {summary.totalRequests > 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
            {t("routingEfficiency")}
          </h3>
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border/20 bg-surface/20 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-text-muted font-semibold">
                {t("fallbackCount")}
              </p>
              <p className="text-lg font-semibold text-text-main mt-1">
                {new Intl.NumberFormat(locale).format(summary.fallbackCount || 0)}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {t("outOfRequests", {
                  total: new Intl.NumberFormat(locale).format(summary.totalRequests),
                })}
              </p>
            </div>
            <div className="rounded-lg border border-border/20 bg-surface/20 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-text-muted font-semibold">
                {t("fallbackRate")}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <p
                  className={`text-lg font-semibold ${
                    (summary.fallbackRatePct || 0) > 10
                      ? "text-red-400"
                      : (summary.fallbackRatePct || 0) > 5
                        ? "text-amber-400"
                        : "text-emerald-400"
                  }`}
                >
                  {(summary.fallbackRatePct || 0).toFixed(1)}%
                </p>
                <span
                  className="material-symbols-outlined text-sm"
                  style={{
                    color:
                      (summary.fallbackRatePct || 0) > 10
                        ? "#f87171"
                        : (summary.fallbackRatePct || 0) > 5
                          ? "#fbbf24"
                          : "#34d399",
                  }}
                >
                  {(summary.fallbackRatePct || 0) > 5 ? "warning" : "check_circle"}
                </span>
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-surface/20 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-text-muted font-semibold">
                {t("modelCoverage")}
              </p>
              <p className="text-lg font-semibold text-text-main mt-1">
                {(summary.requestedModelCoveragePct || 0).toFixed(1)}%
              </p>
              <p className="text-xs text-text-muted mt-1">{t("modelCoverageDesc")}</p>
            </div>
          </div>
        </Card>
      )}

      {summary.totalCost > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-sky-400 text-lg">trending_up</span>
              <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">
                {t("monthlyForecast")}
              </h3>
            </div>
            <div className="flex items-end gap-3">
              <p className="text-3xl font-bold text-sky-400">
                {currencyFormatter.format(projectedMonthEnd)}
              </p>
              <p className="text-xs text-text-muted pb-1">
                {t("forecastBasis", { days: recentDays.length })}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span>{t("avgDailyCost")}:</span>
              <span className="font-mono">{currencyFormatter.format(avgDailyCost)}</span>
              <span>/</span>
              <span>{t("daysRemaining", { days: daysRemainingInMonth })}</span>
            </div>
            {includesFlatRateEstimates && (
              <p className="mt-2 text-xs text-amber-300/90">{t("flatRateEstimateForecast")}</p>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-violet-400 text-lg">
                compare_arrows
              </span>
              <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">
                {t("periodComparison")}
              </h3>
            </div>
            <div className="flex items-end gap-3">
              <p
                className={`text-3xl font-bold ${
                  costChangePct > 0
                    ? "text-red-400"
                    : costChangePct < 0
                      ? "text-emerald-400"
                      : "text-text-main"
                }`}
              >
                {costChangePct > 0 ? "+" : ""}
                {costChangePct.toFixed(1)}%
              </p>
              <span
                className={`material-symbols-outlined text-lg pb-1 ${
                  costChangePct > 0
                    ? "text-red-400"
                    : costChangePct < 0
                      ? "text-emerald-400"
                      : "text-text-muted"
                }`}
              >
                {costChangePct > 0
                  ? "arrow_upward"
                  : costChangePct < 0
                    ? "arrow_downward"
                    : "remove"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div className="text-text-muted">
                <p>{t("previousPeriod")}</p>
                <p className="font-mono text-text-main">
                  {currencyFormatter.format(firstHalfCost)}
                </p>
              </div>
              <div className="text-text-muted">
                <p>{t("currentPeriod")}</p>
                <p className="font-mono text-text-main">
                  {currencyFormatter.format(secondHalfCost)}
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {summary.totalCost <= 0 && summary.totalRequests <= 0 ? (
        <Card className="p-6">
          <EmptyState
            icon="payments"
            title={t("noCostDataTitle")}
            description={t("noCostDataDescription")}
          />
        </Card>
      ) : (
        <>
          {hasCostData && (
            <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-4">
              <CostTrendCard
                title={t("costTrend")}
                rows={analytics?.dailyTrend || []}
                locale={locale}
              />
              <ProviderSpendCard
                title={t("providerShare")}
                rows={providersByCost}
                locale={locale}
              />
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <TopListCard
              title={t("topProviders")}
              nameKey="provider"
              valueKey="cost"
              secondaryKey="totalTokens"
              secondaryLabel={t("tokens")}
              rows={providersByCost}
              locale={locale}
              hasCostData={hasCostData}
              legacyFreeLabel={t("legacyFreeLabel")}
            />
            <TopListCard
              title={t("topModels")}
              nameKey="model"
              valueKey="cost"
              secondaryKey="totalTokens"
              secondaryLabel={t("tokens")}
              rows={modelsByCost}
              locale={locale}
              hasCostData={hasCostData}
              legacyFreeLabel={t("legacyFreeLabel")}
            />
          </div>

          {(apiKeysByCost.length > 0 || accountsByCost.length > 0) && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {apiKeysByCost.length > 0 && (
                <CostBreakdownTable
                  title={t("costByApiKey")}
                  rows={apiKeysByCost.slice(0, 8)}
                  columns={[
                    { key: "apiKeyName", label: t("apiKeyName"), align: "left" },
                    { key: "requests", label: t("requests"), align: "right", format: "number" },
                    {
                      key: "totalTokens",
                      label: t("tokens"),
                      align: "right",
                      format: "compact",
                    },
                    { key: "cost", label: t("cost"), align: "right", format: "currency" },
                  ]}
                  locale={locale}
                  legacyFreeLabel={t("legacyFreeLabel")}
                />
              )}
              {accountsByCost.length > 0 && (
                <CostBreakdownTable
                  title={t("costByAccount")}
                  rows={accountsByCost.slice(0, 8)}
                  columns={[
                    { key: "account", label: t("account"), align: "left" },
                    { key: "requests", label: t("requests"), align: "right", format: "number" },
                    {
                      key: "totalTokens",
                      label: t("tokens"),
                      align: "right",
                      format: "compact",
                    },
                    { key: "cost", label: t("cost"), align: "right", format: "currency" },
                  ]}
                  locale={locale}
                  legacyFreeLabel={t("legacyFreeLabel")}
                />
              )}
            </div>
          )}

          {summary.totalRequests > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.5fr] gap-4">
              <WeeklyPatternCard
                title={t("weeklyUsagePattern")}
                rows={(analytics?.weeklyPattern || []).map((row) => ({
                  ...row,
                  day: formatWeekdayLabel(row.day, locale),
                }))}
                locale={locale}
                tokensLabel={t("tokens")}
              />
              <ActivityHeatmap
                title={t("activityHeatmap")}
                activityMap={analytics?.activityMap || {}}
                lessLabel={t("less")}
                moreLabel={t("more")}
                tokensLabel={t("tokens")}
                locale={locale}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/20 bg-surface/20 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-text-muted font-semibold">{label}</p>
      <p className="text-lg font-semibold text-text-main mt-1">{value}</p>
    </div>
  );
}
