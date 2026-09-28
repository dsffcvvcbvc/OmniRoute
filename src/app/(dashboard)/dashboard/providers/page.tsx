"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { Card, CardSkeleton, Badge, Button, CollapsibleSection } from "@/shared/components";
import {
  AGGREGATOR_PROVIDER_IDS,
  EMBEDDING_RERANK_PROVIDER_IDS,
  ENTERPRISE_CLOUD_PROVIDER_IDS,
  IDE_PROVIDER_IDS,
  IMAGE_ONLY_PROVIDER_IDS,
  VIDEO_PROVIDER_IDS,
} from "@/shared/constants/providers";
import { partitionNoAuthEntriesByBlocked } from "@/shared/utils/noAuthProviders";
import { useRouter, useSearchParams } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import { useTranslations } from "next-intl";
import { useSyncedModelsByProvider } from "./hooks/useSyncedModelsByProvider";
import { useProviderUrlFilters } from "./hooks/useProviderUrlFilters";
import {
  buildStaticProviderEntries,
  buildCompatibleProviderGroups,
  connectionMatchesProviderCard,
  filterConfiguredProviderEntries,
  shouldFilterProviderEntriesForDisplayMode,
  shouldShowFirstProviderHint,
  shouldShowProviderSection,
  upsertProviderNodeById,
  loadProviderPageData,
  readConnectionCount,
} from "./providerPageUtils";
import type { ProviderEntry, OpenRouterProviderStatsEntry } from "./providerPageUtils";
import { createProviderStatsReader } from "./providerPageStats";
import ProviderTestResultsView from "./components/ProviderTestResultsView";
import { providerText } from "./[id]/providerCredentialText";
import { OpenRouterProviderStatsProvider } from "./context/openRouterProviderStatsContext";
import {
  shouldSyncProviderDisplayMode,
  writeProviderDisplayModePreference,
  type ProviderDisplayMode,
} from "./providerPageStorage";
import {
  getCodexGlobalServiceMode,
  type CodexGlobalServiceMode,
} from "@/lib/providers/codexFastTier";
import { requestAdminLogin } from "@/shared/utils/aisixAdminAuth";
import { useAisixSessionEpoch } from "@/shared/hooks/useAisixAdminSession";
import dynamic from "next/dynamic";
const AddCompatibleProviderModal = dynamic(
  () => import("./components/AddCompatibleProviderModal"),
  { ssr: false }
);
import { CategoryDot } from "./components/CategoryDot";
const ImportProvidersFromFileModal = dynamic(
  () =>
    import("./components/ImportProvidersFromFileModal").then((m) => m.ImportProvidersFromFileModal),
  { ssr: false }
);
import NoAuthProvidersSection from "./components/NoAuthProvidersSection";
import PresetProvidersSection from "./components/PresetProvidersSection";
import ProviderKeysSection from "./components/ProviderKeysSection";
import HighlightableProviderCard from "./components/HighlightableProviderCard";
import ProviderCountBadge from "./components/ProviderCountBadge";
import ProviderSummaryCard from "./components/ProviderSummaryCard";
import DeprecatedProviderBanner from "./components/DeprecatedProviderBanner";
import {
  buildCompactProviderEntriesForPage,
  getCompactProviderAuthType,
} from "./providerCompactMode";
import { aisixUnsupportedWrite, resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";

type DashboardProviderInfo = {
  id?: string;
  name: string;
  color?: string;
  apiType?: string;
  deprecated?: boolean;
  deprecationReason?: string;
  hasFree?: boolean;
  freeNote?: string;
  [key: string]: unknown;
};

type DashboardProviderEntry = ProviderEntry<DashboardProviderInfo>;

/**
 * "How many of these providers are configured" — or `null` when that was never
 * answered.
 *
 * The number is a count of CONNECTIONS, and connections are only knowable from
 * the admin plane. When the admin plane did not answer, the count is not zero:
 * it is unknown, and `0` would assert that the operator configured nothing on a
 * gateway whose configuration the page was not allowed — or was unable — to
 * read. `null` is what lets the badge say "—/N" instead of making that claim.
 */
function countConfigured<T>(entries: ProviderEntry<T>[], unknown: boolean) {
  return {
    configured: unknown
      ? null
      : entries.filter((entry) => Number(entry.stats?.total || 0) > 0).length,
    total: entries.length,
  };
}

function dedupeProviderEntries(entries: DashboardProviderEntry[]): DashboardProviderEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.providerId)) return false;
    seen.add(entry.providerId);
    return true;
  });
}

function providerEntryHasFree(entry: DashboardProviderEntry): boolean {
  return entry.provider.hasFree === true;
}

// OAuth-env repair status fetch, extracted so the callback below only sets
// state after the await (errors come back as `null` instead of a setState
// inside the catch block, which the react-hooks compiler rules reject when the
// callback is invoked from an effect).
async function loadOauthEnvRepairStatus(): Promise<{
  available: boolean;
  missingCount: number;
} | null> {
  // The repair wizard rewrites the OAuth client secrets in the NEXT PROCESS's own
  // `.env` file. An AISIX gateway is a Rust binary configured through
  // `admin_keys`/`resources.yaml` — there is no `.env` for it to repair, and no
  // `config.yaml` counterpart to write. So the read is skipped rather than fired
  // into a guaranteed 404, and `null` here is a FINAL answer (the card stays
  // hidden) rather than "not reported": the wizard is absent on this host, not
  // merely idle. See `AisixUnsupportedDomain` → `credentials`.
  if (!resolveAisixSurfaceSupport("credentials", "read").supported) return null;
  try {
    const res = await fetch("/api/system/env/repair", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return null;
    return {
      available: Boolean(data.available),
      missingCount: Number(data.missingCount || 0),
    };
  } catch {
    return null;
  }
}

function ProvidersPageContent() {
  const router = useRouter();
  const [connections, setConnections] = useState<any[]>([]);
  const [providerNodes, setProviderNodes] = useState<any[]>([]);
  const [ccCompatibleProviderEnabled, setCcCompatibleProviderEnabled] = useState(false);
  const [blockedProviders, setBlockedProviders] = useState<string[]>([]);
  const [expirations, setExpirations] = useState<any>(null);
  const [codexGlobalServiceMode, setCodexGlobalServiceMode] =
    useState<CodexGlobalServiceMode>("none");
  const [loading, setLoading] = useState(true);
  // The admin plane did not give us a connection list (401/403, 5xx, a reset
  // connection, the fetch timeout). "How many providers are configured" then has
  // no answer, and 0 is not one: rendered as "—/N" and never derived from.
  const [connectionsUnknown, setConnectionsUnknown] = useState(false);
  // The narrower fact the sign-in banner is about — the credential was turned
  // away, which is the one failure a key prompt fixes.
  const [adminRefused, setAdminRefused] = useState(false);
  // A successful key exchange bumps the epoch and this page re-reads, so the
  // unknown-count state clears itself instead of waiting for a manual reload.
  const adminSessionEpoch = useAisixSessionEpoch();
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] = useState(false);
  const [showAddCcCompatibleModal, setShowAddCcCompatibleModal] = useState(false);
  const [showImportFromFileModal, setShowImportFromFileModal] = useState(false);
  const [testingMode, setTestingMode] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<any>(null);
  const [providerDisplayMode, setProviderDisplayMode] = useState<ProviderDisplayMode>("all");
  const [oauthEnvRepairStatus, setOauthEnvRepairStatus] = useState<{
    available: boolean;
    missingCount: number;
  } | null>(null);
  const [repairingEnv, setRepairingEnv] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const liveModelsByProviderId = useSyncedModelsByProvider();
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  const [openRouterProviderStats, setOpenRouterProviderStats] = useState<
    OpenRouterProviderStatsEntry[] | null
  >([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // #4240: media-category (serviceKind) filter — composes with activeCategory,
  // search and configured-only. null = no serviceKind filter.
  const [activeServiceKind, setActiveServiceKind] = useState<string | null>(null);
  const notify = useNotificationStore();
  const sectionCategoryAliases: Record<string, string> = {
    cloud: "cloudagent",
    noauth: "no-auth",
    proxy: "upstream-proxy",
    web: "webcookie",
  };
  const showSection = (category: string) => {
    const normalizedCategory = sectionCategoryAliases[category] ?? category;
    return shouldShowProviderSection(normalizedCategory, activeCategory, showFreeOnly);
  };
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const webCookieProvidersDesc = providerText(
    t,
    "webCookieProvidersDesc",
    "These providers use browser web sessions, cookies, or web tokens instead of API keys. Open a provider to add the required session credential."
  );
  const ccCompatibleLabel = t("ccCompatibleLabel");
  const addCcCompatibleLabel = t("addCcCompatible");
  const searchParams = useSearchParams();

  const { displayModePreferenceReady } = useProviderUrlFilters({
    searchParams,
    providerDisplayMode,
    setProviderDisplayMode,
    searchQuery,
    setSearchQuery,
    modelSearchQuery,
    setModelSearchQuery,
    activeCategory,
    setActiveCategory,
    showFreeOnly,
    setShowFreeOnly,
    activeServiceKind,
    setActiveServiceKind,
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Each request is time-bounded (see loadProviderPageData); a single
        // stalled connection can no longer wedge `loading` on `true` and freeze
        // the page on its skeleton forever.
        const data = await loadProviderPageData();
        setConnections(data.connections);
        setProviderNodes(data.providerNodes);
        setCcCompatibleProviderEnabled(data.ccCompatibleProviderEnabled);
        if (data.expirations) setExpirations(data.expirations);
        if (data.blockedProviders) setBlockedProviders(data.blockedProviders);
        setCodexGlobalServiceMode(getCodexGlobalServiceMode(data.settings));
        setOpenRouterProviderStats(data.openRouterProviderStats);
        setConnectionsUnknown(data.connectionsUnknown);
        setAdminRefused(data.adminRefused);
      } catch (error) {
        console.log("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [adminSessionEpoch]);

  // Derived once, from the two facts the loader reports, because the same pair
  // of booleans decides four separate things below and they used to be spelled
  // out from `connections.length === 0` four times — which is true even when the
  // array is empty only because the read failed.
  const { known: connectionsKnown, none: noConfiguredConnections } = readConnectionCount(
    connections,
    connectionsUnknown
  );

  useEffect(() => {
    if (!shouldSyncProviderDisplayMode(displayModePreferenceReady, loading)) return;

    // The operator's saved view is theirs. A read that failed is not a reason to
    // rewrite it: flipping to "all" here would persist a preference the operator
    // never chose, and nothing in the UI ever said a preference was discarded.
    const storedDisplayMode =
      noConfiguredConnections && providerDisplayMode === "configured" ? "all" : providerDisplayMode;
    writeProviderDisplayModePreference(storedDisplayMode);
  }, [noConfiguredConnections, displayModePreferenceReady, providerDisplayMode, loading]);

  // "No connections → fall back to the 'all' view" is a state adjustment
  // derived from other state, applied during render (self-invalidating guard,
  // converges in one extra pass) instead of a synchronous setState effect.
  // Guarded on the count being KNOWN, for the same reason as the effect above.
  if (
    shouldSyncProviderDisplayMode(displayModePreferenceReady, loading) &&
    noConfiguredConnections &&
    providerDisplayMode === "configured"
  ) {
    setProviderDisplayMode("all");
  }

  const fetchOauthEnvRepairStatus = useCallback(async () => {
    setOauthEnvRepairStatus(await loadOauthEnvRepairStatus());
  }, []);

  useEffect(() => {
    const run = async () => {
      const status = await loadOauthEnvRepairStatus();
      setOauthEnvRepairStatus(status);
    };
    void run();
  }, []);

  const handleRepairEnv = async () => {
    if (!oauthEnvRepairStatus?.available || repairingEnv) return;
    // Belt-and-braces: the read above already refuses, but a write must never be
    // the thing that discovers the surface is absent.
    if (!resolveAisixSurfaceSupport("credentials", "write").supported) {
      notify.error(aisixUnsupportedWrite("credentials").reason);
      return;
    }

    setRepairingEnv(true);
    try {
      const res = await fetch("/api/system/env/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("repairEnvFailed"));
      }
      notify.success(
        data.backupPath ? `${t("repairEnvSuccess")} (${data.backupPath})` : t("repairEnvSuccess")
      );
      await fetchOauthEnvRepairStatus();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("repairEnvFailed"));
    } finally {
      setRepairingEnv(false);
    }
  };

  const getProviderStats = createProviderStatsReader({
    connections,
    expirations,
    codexGlobalServiceMode,
    t,
  });

  // Toggle all connections for a provider on/off
  const handleToggleProvider = async (providerId: string, authType: string, newActive: boolean) => {
    const matchesToggle = (c: { provider: string; authType?: string }) =>
      connectionMatchesProviderCard(c, providerId, authType as "oauth" | "free" | "apikey");
    const providerConns = connections.filter(matchesToggle);
    // Optimistically update UI
    setConnections((prev) =>
      prev.map((c) => (matchesToggle(c) ? { ...c, isActive: newActive } : c))
    );
    // Fire API calls in parallel
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        })
      )
    );
  };

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000); // 90s max
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId }),
        signal: controller.signal,
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        // Response body is not valid JSON (e.g. truncated due to timeout)
        data = { error: t("providerTestFailed"), results: [], summary: null };
      }
      setTestResults({
        ...data,
        // Normalize error: if API returns an error object { message, details }, extract the string
        error: data.error
          ? typeof data.error === "object"
            ? data.error.message || data.error.error || JSON.stringify(data.error)
            : String(data.error)
          : null,
      });
      if (data?.summary) {
        const { passed, failed, total } = data.summary;
        if (failed === 0) notify.success(t("allTestsPassed", { total }));
        else notify.warning(t("testSummary", { passed, failed, total }));
      }
    } catch (error: any) {
      const isAbort = error?.name === "AbortError";
      const msg = isAbort ? t("providerTestTimeout") : t("providerTestFailed");
      setTestResults({ error: msg, results: [], summary: null });
      notify.error(msg);
    } finally {
      clearTimeout(timeoutId);
      setTestingMode(null);
    }
  };

  const compatibleProviderGroups = useMemo(
    () =>
      buildCompatibleProviderGroups(providerNodes, {
        openaiCompatibleName: t("openaiCompatibleName"),
        anthropicCompatibleName: t("anthropicCompatibleName"),
        claudeCodeCompatibleName: ccCompatibleLabel,
      }),
    [ccCompatibleLabel, providerNodes, t]
  );
  const compatibleProviders = compatibleProviderGroups.openai;
  const anthropicCompatibleProviders = compatibleProviderGroups.anthropic;
  const ccCompatibleProviders = compatibleProviderGroups.claudeCode;

  // Only a KNOWN empty count may move the operator off the "configured" view. An
  // unknown one leaves the saved mode alone, and the filter below then declines
  // to apply itself rather than hiding the whole catalogue behind a set nobody
  // has read.
  const effectiveProviderDisplayMode =
    providerDisplayMode === "configured" && noConfiguredConnections ? "all" : providerDisplayMode;
  const effectiveShowConfiguredOnly = shouldFilterProviderEntriesForDisplayMode(
    effectiveProviderDisplayMode,
    connections.length
  );
  const isCompactProviderDisplay = effectiveProviderDisplayMode === "compact";

  const oauthProviderEntriesAll = buildStaticProviderEntries("oauth", getProviderStats);
  const oauthProviderEntries = filterConfiguredProviderEntries(
    oauthProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const rawNoAuthEntriesAll = buildStaticProviderEntries("no-auth", getProviderStats);
  // Partition rather than drop: blocked no-auth providers stay surfaced on the page
  // (rendered with a "Disabled" badge + Enable button) instead of silently vanishing,
  // which left users unable to find/restore a disabled no-auth provider (#5166/#5183).
  // `noAuthEntriesAll` keeps only the visible (non-blocked) entries, so every downstream
  // aggregate/count/model list that consumes it is unchanged.
  const { visible: noAuthEntriesAll, blocked: blockedNoAuthEntries } =
    partitionNoAuthEntriesByBlocked(rawNoAuthEntriesAll, blockedProviders);
  const noAuthEntries = filterConfiguredProviderEntries(
    noAuthEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const apiKeyProviderEntriesAll = buildStaticProviderEntries("apikey", getProviderStats);
  const llmProviderEntriesAll = apiKeyProviderEntriesAll.filter(
    (entry) =>
      !IMAGE_ONLY_PROVIDER_IDS.has(entry.providerId) &&
      !AGGREGATOR_PROVIDER_IDS.has(entry.providerId) &&
      !ENTERPRISE_CLOUD_PROVIDER_IDS.has(entry.providerId) &&
      !VIDEO_PROVIDER_IDS.has(entry.providerId) &&
      !EMBEDDING_RERANK_PROVIDER_IDS.has(entry.providerId)
  );
  const llmProviderEntries = filterConfiguredProviderEntries(
    llmProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );
  const aggregatorProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    AGGREGATOR_PROVIDER_IDS.has(entry.providerId)
  );
  const aggregatorProviderEntries = filterConfiguredProviderEntries(
    aggregatorProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );
  const imageProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    IMAGE_ONLY_PROVIDER_IDS.has(entry.providerId)
  );
  const imageProviderEntries = filterConfiguredProviderEntries(
    imageProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );
  const enterpriseProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    ENTERPRISE_CLOUD_PROVIDER_IDS.has(entry.providerId)
  );
  const enterpriseProviderEntries = filterConfiguredProviderEntries(
    enterpriseProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );
  const videoProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    VIDEO_PROVIDER_IDS.has(entry.providerId)
  );
  const videoProviderEntries = filterConfiguredProviderEntries(
    videoProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );
  const embeddingRerankProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    EMBEDDING_RERANK_PROVIDER_IDS.has(entry.providerId)
  );
  const embeddingRerankProviderEntries = filterConfiguredProviderEntries(
    embeddingRerankProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const webCookieProviderEntriesAll = buildStaticProviderEntries("web-cookie", getProviderStats);
  const webCookieProviderEntries = filterConfiguredProviderEntries(
    webCookieProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const localProviderEntriesAll = buildStaticProviderEntries("local", getProviderStats);
  const localProviderEntries = filterConfiguredProviderEntries(
    localProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const searchProviderEntriesAll = buildStaticProviderEntries("search", getProviderStats);
  const searchProviderEntries = filterConfiguredProviderEntries(
    searchProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const audioProviderEntriesAll = buildStaticProviderEntries("audio", getProviderStats);
  const audioProviderEntries = filterConfiguredProviderEntries(
    audioProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const cloudAgentProviderEntriesAll = buildStaticProviderEntries("cloud-agent", getProviderStats);
  const cloudAgentProviderEntries = filterConfiguredProviderEntries(
    cloudAgentProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const upstreamProxyEntriesAll = buildStaticProviderEntries("upstream-proxy", getProviderStats);
  const upstreamProxyEntries = filterConfiguredProviderEntries(
    upstreamProxyEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const compatibleProviderEntriesAll = [
    ...compatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
    ...anthropicCompatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
    ...ccCompatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
  ];
  const compatibleProviderEntries = filterConfiguredProviderEntries(
    compatibleProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const staticProviderEntriesAll = dedupeProviderEntries([
    ...oauthProviderEntriesAll,
    ...noAuthEntriesAll,
    ...apiKeyProviderEntriesAll,
    ...webCookieProviderEntriesAll,
    ...localProviderEntriesAll,
    ...searchProviderEntriesAll,
    ...audioProviderEntriesAll,
    ...cloudAgentProviderEntriesAll,
    ...upstreamProxyEntriesAll,
  ] as DashboardProviderEntry[]);
  const dashboardProviderEntriesAll = dedupeProviderEntries([
    ...staticProviderEntriesAll,
    ...compatibleProviderEntriesAll,
  ]);
  const freeSectionEntriesAll = dashboardProviderEntriesAll.filter(providerEntryHasFree);
  const freeSectionEntries = filterConfiguredProviderEntries(
    freeSectionEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    undefined,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  // IDE providers: subset of oauth/apikey providers that are editors/IDEs with
  // built-in AI subscription. Rendered in a dedicated "IDE Providers" section
  // and excluded from the regular OAuth/API Key sections to avoid duplication.
  const ideProviderEntriesAll = [...oauthProviderEntriesAll, ...apiKeyProviderEntriesAll].filter(
    (e) => IDE_PROVIDER_IDS.has(e.providerId)
  );
  const ideProviderEntries = filterConfiguredProviderEntries(
    ideProviderEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const oauthOnlyEntriesAll = oauthProviderEntriesAll
    .filter((e) => e.toggleAuthType === "oauth")
    .filter((e) => !IDE_PROVIDER_IDS.has(e.providerId));

  // Web Fetch providers: filter across all entries by serviceKinds
  const webFetchEntriesAll = dedupeProviderEntries(
    [...staticProviderEntriesAll, ...compatibleProviderEntriesAll].filter((e) => {
      const p = e.provider as DashboardProviderInfo & { serviceKinds?: string[] };
      return p.serviceKinds?.includes("webFetch") === true;
    }) as DashboardProviderEntry[]
  );
  const webFetchEntries = filterConfiguredProviderEntries(
    webFetchEntriesAll,
    effectiveShowConfiguredOnly,
    searchQuery,
    showFreeOnly,
    modelSearchQuery,
    activeServiceKind,
    liveModelsByProviderId,
    connections
  );

  const compactProviderEntries = buildCompactProviderEntriesForPage({
    activeCategory,
    showFreeOnly,
    freeSectionEntries,
    compatibleProviderEntries,
    oauthProviderEntries,
    ideProviderEntries,
    noAuthEntries,
    upstreamProxyEntries,
    llmProviderEntries,
    aggregatorProviderEntries,
    enterpriseProviderEntries,
    embeddingRerankProviderEntries,
    imageProviderEntries,
    videoProviderEntries,
    webCookieProviderEntries,
    searchProviderEntries,
    webFetchEntries,
    audioProviderEntries,
    localProviderEntries,
    cloudAgentProviderEntries,
  });

  const summaryStats = {
    all: countConfigured(dashboardProviderEntriesAll, connectionsUnknown),
    free: countConfigured(freeSectionEntriesAll, connectionsUnknown),
    noauth: countConfigured(noAuthEntriesAll, connectionsUnknown),
    oauth: countConfigured(oauthOnlyEntriesAll, connectionsUnknown),
    apikey: countConfigured(apiKeyProviderEntriesAll, connectionsUnknown),
    compatible: countConfigured(compatibleProviderEntriesAll, connectionsUnknown),
    webcookie: countConfigured(webCookieProviderEntriesAll, connectionsUnknown),
    search: countConfigured(searchProviderEntriesAll, connectionsUnknown),
    audio: countConfigured(audioProviderEntriesAll, connectionsUnknown),
    local: countConfigured(localProviderEntriesAll, connectionsUnknown),
    upstreamproxy: countConfigured(upstreamProxyEntriesAll, connectionsUnknown),
    cloudagent: countConfigured(cloudAgentProviderEntriesAll, connectionsUnknown),
    ide: countConfigured(ideProviderEntriesAll, connectionsUnknown),
    webfetch: countConfigured(webFetchEntriesAll, connectionsUnknown),
  };
  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  // "Add your first provider" is a statement about the operator's configuration,
  // and it is derived from the connection count. When the admin plane did not
  // give us that count there is nothing to derive it from, so the hint is
  // suppressed rather than shown on top of a page that is also saying "we could
  // not read your configuration" — two claims, one of which is now known to be
  // unverified.
  const showFirstProviderHint =
    connectionsKnown &&
    shouldShowFirstProviderHint(connections.length, searchQuery) &&
    !showAllProviders;

  return (
    <OpenRouterProviderStatsProvider entries={openRouterProviderStats ?? []}>
      <div className="flex flex-col gap-6">
        <DeprecatedProviderBanner />

        {showFirstProviderHint && (
          <Card padding="lg">
            <div className="flex flex-col items-center justify-center text-center">
              <div className="flex items-center justify-center size-16 rounded-full bg-primary/10 mb-4">
                <span className="material-symbols-outlined text-[32px] text-primary">dns</span>
              </div>
              <h2 className="text-xl font-semibold text-text-main">
                {t("addFirstProvider") || "Add your first provider"}
              </h2>
              <p className="text-sm text-text-muted mt-2 max-w-md">
                {t("addFirstProviderDesc") ||
                  "Connect an AI provider to start routing requests through OmniRoute. You can use free providers, API keys, or OAuth accounts."}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button icon="add" onClick={() => router.push("/dashboard/providers/new")}>
                  {providerText(t, "onboardingWizard", "Provider Onboarding Wizard")}
                </Button>
                <a
                  href="https://github.com/diegosouzapw/OmniRoute#-documentation"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-border text-text-muted hover:text-text-main hover:bg-bg-subtle transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">help</span>
                  {t("learnMore") || "Learn more"}
                </a>
              </div>
            </div>
          </Card>
        )}

        <ProviderSummaryCard
          activeCategory={activeCategory}
          activeServiceKind={activeServiceKind}
          onServiceKindChange={setActiveServiceKind}
          // Disabled whenever the count cannot justify it: a page that could not
          // read the connections cannot evaluate "configured only", so the chip
          // is withheld rather than letting the operator filter against a set
          // nobody knows.
          disabledConfigured={!connectionsKnown || connections.length === 0}
          displayMode={effectiveProviderDisplayMode}
          modelSearchQuery={modelSearchQuery}
          onBatchTest={handleBatchTest}
          onCategoryChange={(category, freeOnly) => {
            setShowFreeOnly(freeOnly);
            setActiveCategory(freeOnly ? null : category);
          }}
          onDisplayModeChange={setProviderDisplayMode}
          onNewProvider={() => router.push("/dashboard/providers/new")}
          onImportFromFile={() => setShowImportFromFileModal(true)}
          searchQuery={searchQuery}
          setModelSearchQuery={setModelSearchQuery}
          setSearchQuery={setSearchQuery}
          showFreeOnly={showFreeOnly}
          summaryStats={summaryStats}
          t={t}
          tc={tc}
          testingMode={testingMode}
        />

        {/* Expiration Banner */}
        {expirations?.summary &&
          (expirations.summary.expired > 0 || expirations.summary.expiringSoon > 0) && (
            <div
              className={`p-4 rounded-xl flex items-start gap-3 border ${
                expirations.summary.expired > 0
                  ? "bg-red-500/10 border-red-500/20"
                  : "bg-amber-500/10 border-amber-500/20"
              }`}
            >
              <span
                className={`material-symbols-outlined text-[24px] ${
                  expirations.summary.expired > 0 ? "text-red-500" : "text-amber-500"
                }`}
              >
                {expirations.summary.expired > 0 ? "error" : "warning"}
              </span>
              <div className="flex-1">
                <h3
                  className={`font-semibold ${expirations.summary.expired > 0 ? "text-red-500" : "text-amber-500"}`}
                >
                  {expirations.summary.expired > 0
                    ? t("expirationBannerExpired", { count: expirations.summary.expired })
                    : t("expirationBannerExpiringSoon", {
                        count: expirations.summary.expiringSoon,
                      })}
                </h3>
                <p className="text-sm mt-1 opacity-80 text-text-main">
                  {expirations.summary.expired > 0
                    ? t("expirationBannerExpiredDesc")
                    : t("expirationBannerExpiringSoonDesc")}
                </p>
              </div>
            </div>
          )}

        {isCompactProviderDisplay ? (
          compactProviderEntries.length > 0 ? (
            <div
              className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3"
              data-testid="provider-compact-grid"
            >
              {compactProviderEntries.map((entry) => (
                <HighlightableProviderCard
                  key={`compact-${entry.providerId}`}
                  providerId={entry.providerId}
                  provider={entry.provider}
                  stats={entry.stats}
                  authType={getCompactProviderAuthType(entry, showFreeOnly)}
                  onToggle={(active) =>
                    handleToggleProvider(entry.providerId, entry.toggleAuthType, active)
                  }
                />
              ))}
            </div>
          ) : (
            <div
              className="flex items-center justify-center gap-2 py-8 border border-dashed border-border rounded-xl text-text-muted text-sm"
              data-testid="provider-compact-empty"
            >
              <span className="material-symbols-outlined text-[18px]">search_off</span>
              <span>{providerText(t, "noProvidersMatch", "No providers match your search.")}</span>
            </div>
          )
        ) : (
          <>
            {/* The page could not read the CONNECTION LIST. This banner is
                ADDITIVE, not a replacement: the catalog below is a static
                registry that needs no session, so withholding it would hide
                state the failed read does not contradict. What is withheld is
                the connections data — the configured counts — and those are
                drawn as "—" for exactly that reason. (Compact mode already
                worked this way, which is why this only ever aligned the two.)

                The sign-in button is narrower still: it is offered only when the
                CREDENTIAL was refused, because that is the one failure it can
                fix. A 5xx or a timed-out read has no key that would help.

                The testid follows the flag, not the older story: it was
                `providers-admin-denied`, which let a test that grabbed it read
                a 500 as a refusal. */}
            {connectionsUnknown && (
              <div
                className="flex flex-wrap items-center gap-3 py-6 px-4 border border-dashed border-amber-500/40 rounded-xl text-sm"
                data-testid="providers-connections-unknown"
                role="status"
              >
                <span className="material-symbols-outlined text-[18px] text-amber-500">lock</span>
                <span className="text-text-main flex-1 min-w-[240px]">
                  {/* Byte-identical to `providers.aisixConnectionsUnknown` in
                      en.json, like every other `providerText` fallback here.
                      The two answer the same question — is the list below
                      withheld? — so a fallback that said something different
                      would make the answer depend on whether the catalogue
                      loaded, which is the one thing the banner denies. */}
                  {providerText(
                    t,
                    "aisixConnectionsUnknown",
                    "The gateway did not confirm which providers you have configured, so the counts below are shown as — instead of as a number. A dash is not a zero: nothing here claims you have configured nothing."
                  )}
                </span>
                {adminRefused && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="login"
                    onClick={requestAdminLogin}
                    data-testid="providers-sign-in"
                  >
                    {providerText(t, "adminAuthSignIn", "Sign in")}
                  </Button>
                )}
              </div>
            )}
            {/* API Key Compatible Providers — dynamic (OpenAI/Anthropic compatible) */}
            {showSection("compatible") && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("compatibleProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-orange-500"
                      title={t("compatibleLabel")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(compatibleProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {(compatibleProviders.length > 0 ||
                      anthropicCompatibleProviders.length > 0 ||
                      ccCompatibleProviders.length > 0) && (
                      <button
                        onClick={() => handleBatchTest("compatible")}
                        disabled={!!testingMode}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          testingMode === "compatible"
                            ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                            : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                        }`}
                        title={t("testAllCompatible")}
                      >
                        <span
                          className={`material-symbols-outlined text-[14px]${testingMode === "compatible" ? " animate-spin" : ""}`}
                        >
                          play_arrow
                        </span>
                        {testingMode === "compatible" ? t("testing") : t("testAll")}
                      </button>
                    )}
                    {ccCompatibleProviderEnabled && (
                      <Button
                        size="sm"
                        icon="add"
                        onClick={() => setShowAddCcCompatibleModal(true)}
                      >
                        {addCcCompatibleLabel}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      icon="add"
                      onClick={() => setShowAddAnthropicCompatibleModal(true)}
                    >
                      {t("addAnthropicCompatible")}
                    </Button>
                    <Button size="sm" icon="add" onClick={() => setShowAddCompatibleModal(true)}>
                      {t("addOpenAICompatible")}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("compatibleProvidersDesc")}</p>
                {compatibleProviders.length === 0 &&
                anthropicCompatibleProviders.length === 0 &&
                ccCompatibleProviders.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-2 border border-dashed border-border rounded-xl text-text-muted text-sm">
                    <span className="material-symbols-outlined text-[18px]">extension</span>
                    <span>{t("noCompatibleYet")}</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                    {compatibleProviderEntries.map(
                      ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                        <HighlightableProviderCard
                          key={providerId}
                          providerId={providerId}
                          provider={provider}
                          stats={stats}
                          authType={displayAuthType}
                          onToggle={(active) =>
                            handleToggleProvider(providerId, toggleAuthType, active)
                          }
                        />
                      )
                    )}
                  </div>
                )}
              </div>
            )}

            {/* OAuth Providers (including providers that expose free tiers via OAuth) */}
            {showSection("oauth") && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("oauthProviders")}{" "}
                    <span className="size-2.5 rounded-full bg-blue-500" title={t("oauthLabel")} />
                    <ProviderCountBadge
                      {...countConfigured(
                        oauthProviderEntriesAll.filter((e) => !IDE_PROVIDER_IDS.has(e.providerId)),
                        connectionsUnknown
                      )}
                    />
                  </h2>
                  <div className="flex items-center gap-2">
                    {oauthEnvRepairStatus?.available && oauthEnvRepairStatus.missingCount > 0 && (
                      <button
                        onClick={handleRepairEnv}
                        disabled={repairingEnv}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          repairingEnv
                            ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                            : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                        }`}
                        title={t("repairEnvHint")}
                        aria-label={t("repairEnv")}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {repairingEnv ? "sync" : "settings_backup_restore"}
                        </span>
                        {repairingEnv ? t("repairEnvWorking") : t("repairEnv")}
                      </button>
                    )}
                    <button
                      onClick={() => handleBatchTest("oauth")}
                      disabled={!!testingMode}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        testingMode === "oauth"
                          ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                          : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                      }`}
                      title={t("testAllOAuth")}
                      aria-label={t("testAllOAuth")}
                    >
                      <span
                        className={`material-symbols-outlined text-[14px]${testingMode === "oauth" ? " animate-spin" : ""}`}
                      >
                        play_arrow
                      </span>
                      {testingMode === "oauth" ? t("testing") : t("testAll")}
                    </button>
                  </div>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("oauthProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {oauthProviderEntries
                    .filter((e) => !IDE_PROVIDER_IDS.has(e.providerId))
                    .map(({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    ))}
                </div>
              </div>
            )}

            {/* IDE Providers (Cursor, Zed, Trae) — editors with built-in AI subscription */}
            {showSection("ide") && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("ideProviders") || "IDE Providers"}{" "}
                    <span
                      className="size-2.5 rounded-full bg-cyan-500"
                      title={t("ideProviders") || "IDE Providers"}
                    />
                    <ProviderCountBadge
                      {...countConfigured(ideProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("ide")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "ide"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                    aria-label={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "ide" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "ide" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">
                  {t("ideProvidersDesc") ||
                    "Editors with built-in AI subscription. Use the provider page to import credentials directly from the IDE's keychain."}
                </p>
                {ideProviderEntries.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border bg-bg-subtle p-6 text-center text-sm text-text-muted">
                    {t("noIdeProviders") || "No IDE providers match the current filters."}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                    {ideProviderEntries.map(
                      ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                        <HighlightableProviderCard
                          key={`ide-${providerId}`}
                          providerId={providerId}
                          provider={provider}
                          stats={stats}
                          authType={displayAuthType}
                          onToggle={(active) =>
                            handleToggleProvider(providerId, toggleAuthType, active)
                          }
                        />
                      )
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Web / Cookie Providers */}
            {showSection("web") && webCookieProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("webCookieProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-purple-500"
                      title={t("webCookieProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(webCookieProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("web-cookie")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "web-cookie"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "web-cookie" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "web-cookie" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("webCookieProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {webCookieProviderEntries.map(
                    ({ providerId, provider, stats, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType="web-cookie"
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Free Tier Providers */}
            {showSection("free") && freeSectionEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                      {t("freeTierProviders")}
                      <CategoryDot color="bg-green-500" label={t("freeTierLabel")} />
                      <ProviderCountBadge
                        {...countConfigured(freeSectionEntriesAll, connectionsUnknown)}
                      />
                    </h2>
                    <p className="text-sm text-text-muted mt-1">{t("freeAggregated")}</p>
                  </div>
                  <button
                    onClick={() => handleBatchTest("free")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "free"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "free" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "free" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {freeSectionEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={`free-section-${providerId}`}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={toggleAuthType === "free" ? "free" : displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* API Key Providers — fixed list */}
            {showSection("apikey") && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("apiKeyProviders")}{" "}
                    <span className="size-2.5 rounded-full bg-amber-500" title={t("apiKeyLabel")} />
                    <ProviderCountBadge
                      {...countConfigured(apiKeyProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("apikey")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "apikey"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAllApiKey")}
                    aria-label={t("testAllApiKey")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "apikey" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "apikey" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("apiKeyProvidersDesc")}</p>
                {llmProviderEntries.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      {t("llmProviders")}
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                      {llmProviderEntries.map(
                        ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                          <HighlightableProviderCard
                            key={providerId}
                            providerId={providerId}
                            provider={provider}
                            stats={stats}
                            authType={displayAuthType}
                            onToggle={(active) =>
                              handleToggleProvider(providerId, toggleAuthType, active)
                            }
                          />
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* No Auth Providers */}
            {showSection("noauth") &&
              !showFreeOnly &&
              (noAuthEntriesAll.length > 0 || blockedNoAuthEntries.length > 0) && (
                <NoAuthProvidersSection
                  visibleEntries={noAuthEntries}
                  count={countConfigured(noAuthEntriesAll, connectionsUnknown)}
                  blockedEntries={blockedNoAuthEntries}
                  blockedProviders={blockedProviders}
                  onBlockedChange={setBlockedProviders}
                  onError={(msg) => notify.error(msg)}
                  testingMode={testingMode}
                  onBatchTest={handleBatchTest}
                  onToggleProvider={handleToggleProvider}
                />
              )}

            {/* Upstream Proxy Providers */}
            {showSection("proxy") && upstreamProxyEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("upstreamProxyProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-indigo-500"
                      title={t("upstreamProxyProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(upstreamProxyEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("upstream-proxy")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "upstream-proxy"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "upstream-proxy" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "upstream-proxy" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("upstreamProxyProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {upstreamProxyEntries.map(({ providerId, provider, stats, toggleAuthType }) => (
                    <HighlightableProviderCard
                      key={providerId}
                      providerId={providerId}
                      provider={provider}
                      stats={stats}
                      authType="upstream-proxy"
                      onToggle={(active) =>
                        handleToggleProvider(providerId, toggleAuthType, active)
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Web Fetch Providers */}
            {showSection("webfetch") && webFetchEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("webFetchProvidersHeading")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-orange-500"
                      title={t("webFetchTooltip")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(webFetchEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("webFetchProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {webFetchEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={`webfetch-${providerId}`}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Aggregators Gateways */}
            {showSection("apikey") && aggregatorProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("aggregatorsGateways")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-amber-500"
                      title={t("aggregatorsGateways")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(aggregatorProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("aggregatorsGatewaysDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {aggregatorProviderEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Enterprise & Cloud */}
            {showSection("apikey") && enterpriseProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("enterpriseCloud")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-amber-500"
                      title={t("enterpriseCloud")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(enterpriseProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("enterpriseCloudDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {enterpriseProviderEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Cloud Agent Providers */}
            {showSection("cloud") && cloudAgentProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("cloudAgentProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-violet-500"
                      title={t("cloudAgentProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(cloudAgentProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("cloud-agent")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "cloud-agent"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "cloud-agent" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "cloud-agent" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("cloudAgentProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {cloudAgentProviderEntries.map(
                    ({ providerId, provider, stats, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType="cloud-agent"
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Local / Self-Hosted Providers */}
            {showSection("local") && localProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("localProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-emerald-500"
                      title={t("localProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(localProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("local")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "local"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "local" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "local" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("localProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {localProviderEntries.map(({ providerId, provider, stats, toggleAuthType }) => (
                    <HighlightableProviderCard
                      key={providerId}
                      providerId={providerId}
                      provider={provider}
                      stats={stats}
                      authType="local"
                      onToggle={(active) =>
                        handleToggleProvider(providerId, toggleAuthType, active)
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Search Providers */}
            {showSection("search") && searchProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("searchProvidersHeading")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-teal-500"
                      title={t("searchProvidersHeading")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(searchProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("search")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "search"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "search" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "search" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("searchProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {searchProviderEntries.map(({ providerId, provider, stats, toggleAuthType }) => (
                    <HighlightableProviderCard
                      key={providerId}
                      providerId={providerId}
                      provider={provider}
                      stats={stats}
                      authType="search"
                      onToggle={(active) =>
                        handleToggleProvider(providerId, toggleAuthType, active)
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Embeddings & Rerank */}
            {showSection("apikey") && embeddingRerankProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("embeddingRerankProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-amber-500"
                      title={t("embeddingRerankProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(embeddingRerankProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("embeddingRerankProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {embeddingRerankProviderEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Image Providers */}
            {showSection("apikey") && imageProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("imageProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-amber-500"
                      title={t("imageProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(imageProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("imageProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {imageProviderEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {/* Audio Only Providers */}
            {showSection("audio") && audioProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("audioProvidersHeading")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-rose-500"
                      title={t("audioProvidersHeading")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(audioProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                  <button
                    onClick={() => handleBatchTest("audio")}
                    disabled={!!testingMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      testingMode === "audio"
                        ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                    }`}
                    title={t("testAll")}
                  >
                    <span
                      className={`material-symbols-outlined text-[14px]${testingMode === "audio" ? " animate-spin" : ""}`}
                    >
                      play_arrow
                    </span>
                    {testingMode === "audio" ? t("testing") : t("testAll")}
                  </button>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("audioProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {audioProviderEntries.map(({ providerId, provider, stats, toggleAuthType }) => (
                    <HighlightableProviderCard
                      key={providerId}
                      providerId={providerId}
                      provider={provider}
                      stats={stats}
                      authType="audio"
                      onToggle={(active) =>
                        handleToggleProvider(providerId, toggleAuthType, active)
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Video Generation */}
            {showSection("apikey") && videoProviderEntries.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                    {t("videoProviders")}{" "}
                    <span
                      className="size-2.5 rounded-full bg-amber-500"
                      title={t("videoProviders")}
                    />
                    <ProviderCountBadge
                      {...countConfigured(videoProviderEntriesAll, connectionsUnknown)}
                    />
                  </h2>
                </div>
                <p className="text-sm text-text-muted -mt-2">{t("videoProvidersDesc")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                  {videoProviderEntries.map(
                    ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                      <HighlightableProviderCard
                        key={providerId}
                        providerId={providerId}
                        provider={provider}
                        stats={stats}
                        authType={displayAuthType}
                        onToggle={(active) =>
                          handleToggleProvider(providerId, toggleAuthType, active)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Core preset catalog: vendors without a local connection yet. Rendered
            outside the static-catalog category filters on purpose — it is driven
            by `:3001/admin/v1/preset_providers`, not by the local catalog, and
            degrades to its own honest empty state when the core has no catalog. */}
        <PresetProvidersSection connections={connections} />

        {/* Upstream credentials the gateway stores and dispatches with, managed
            through `GET|POST /admin/v1/provider_keys` and
            `GET|PATCH|DELETE /admin/v1/provider_keys/:id`. A component of this
            page rather than its own route: the static export inventory
            (tests/unit/dashboard-spa-static-export.test.ts) pins the set of
            dynamic-segment routes, and a CRUD surface that reads its collection
            at runtime has no honest `generateStaticParams()`. */}
        <ProviderKeysSection />

        <AddCompatibleProviderModal
          isOpen={showAddCompatibleModal}
          mode="openai"
          onClose={() => setShowAddCompatibleModal(false)}
          onCreated={(node) => {
            setProviderNodes((prev) => upsertProviderNodeById(prev, node));
            setShowAddCompatibleModal(false);
            router.push(`/dashboard/providers/${node.id}`);
          }}
        />
        <AddCompatibleProviderModal
          isOpen={showAddAnthropicCompatibleModal}
          mode="anthropic"
          onClose={() => setShowAddAnthropicCompatibleModal(false)}
          onCreated={(node) => {
            setProviderNodes((prev) => upsertProviderNodeById(prev, node));
            setShowAddAnthropicCompatibleModal(false);
            router.push(`/dashboard/providers/${node.id}`);
          }}
        />
        {ccCompatibleProviderEnabled && (
          <AddCompatibleProviderModal
            isOpen={showAddCcCompatibleModal}
            mode="cc"
            title={addCcCompatibleLabel}
            onClose={() => setShowAddCcCompatibleModal(false)}
            onCreated={(node) => {
              setProviderNodes((prev) => upsertProviderNodeById(prev, node));
              setShowAddCcCompatibleModal(false);
              router.push(`/dashboard/providers/${node.id}`);
            }}
          />
        )}
        <ImportProvidersFromFileModal
          isOpen={showImportFromFileModal}
          onClose={() => setShowImportFromFileModal(false)}
          onImported={async () => setConnections((await loadProviderPageData()).connections)}
        />
        {/* Test Results Modal */}
        {testResults && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
            onClick={() => setTestResults(null)}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative bg-bg-primary border border-border rounded-xl w-full max-w-[600px] max-h-[80vh] overflow-y-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-border bg-bg-primary/95 backdrop-blur-sm rounded-t-xl">
                <h3 className="font-semibold">{t("testResults")}</h3>
                <button
                  onClick={() => setTestResults(null)}
                  className="p-1 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
                  aria-label={tc("close")}
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-5">
                <ProviderTestResultsView results={testResults} />
              </div>
            </div>
          </div>
        )}
      </div>
    </OpenRouterProviderStatsProvider>
  );
}

export default function ProvidersPage() {
  return (
    <Suspense fallback={null}>
      <ProvidersPageContent />
    </Suspense>
  );
}
