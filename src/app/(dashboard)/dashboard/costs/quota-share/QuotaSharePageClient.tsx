"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/shared/components";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";
import { useNotificationStore } from "@/store/notificationStore";
import { maskEmailLikeValue } from "@/shared/utils/maskEmail";
import { backoffPollDelayMs, isDocumentHidden } from "@/shared/utils/fetchTimeout";
import {
  aisixUnsupportedRead,
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";
import type { QuotaPool } from "@/lib/quota/dimensions";

import { usePools } from "./hooks/usePools";
import { usePoolUsage } from "./hooks/usePoolUsage";
import { useLocalStoragePoolMigration } from "./hooks/useLocalStoragePoolMigration";
import { usePoolsUsageAggregate } from "./hooks/usePoolsUsageAggregate";
import QuotaConceptCard from "./components/QuotaConceptCard";
import QuotaEndpointsCard from "./components/QuotaEndpointsCard";
import PoolCard from "./components/PoolCard";
import PoolWizard from "./components/PoolWizard";

// ────────────────────────────────────────────────────────────────────────────
// Local types (display layer only)
// ────────────────────────────────────────────────────────────────────────────

interface QuotaGroup {
  id: string;
  name: string;
  createdAt: string;
}

interface Connection {
  id: string;
  provider: string;
  name?: string;
  displayName?: string;
  email?: string;
}

interface ApiKey {
  id: string;
  name?: string;
}

interface PlanDimension {
  unit: string;
  window: string;
  limit: number;
}

interface PlanInfo {
  dimensions: PlanDimension[];
  source: "auto" | "manual";
}

// ────────────────────────────────────────────────────────────────────────────
// Side-data polling
// ────────────────────────────────────────────────────────────────────────────

/** Base refresh for connections/keys/plans; backs off exponentially on failure. */
const SIDE_DATA_POLL_MS = 60_000;

// ────────────────────────────────────────────────────────────────────────────
// Stat card helper
// ────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  /** `"—"` marks a value the current gateway does not report. */
  value: string;
  tone?: "green" | "amber" | "red";
}) {
  const color =
    tone === "amber"
      ? "text-amber-400"
      : tone === "red"
        ? "text-red-400"
        : tone === "green"
          ? "text-emerald-400"
          : "text-text-main";
  return (
    <div className="rounded-lg border border-border/40 bg-bg-subtle/30 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">
        {label}
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-tight ${color}`}>{value}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Per-pool wrapper that fetches usage
// ────────────────────────────────────────────────────────────────────────────

function PoolCardWithUsage({
  pool,
  keyLabels,
  connectionLabel,
  provider,
  providers,
  connectionIds,
  onEdit,
  onRemove,
}: {
  pool: QuotaPool;
  keyLabels: Record<string, string>;
  connectionLabel: string;
  provider: string;
  providers?: string[];
  connectionIds?: string[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { usage, unsupported: usageUnsupported } = usePoolUsage(pool.id);
  return (
    <>
      <PoolCard
        pool={pool}
        usage={usage}
        keyLabels={keyLabels}
        connectionLabel={connectionLabel}
        provider={provider}
        providers={providers}
        connectionIds={connectionIds}
        onEdit={onEdit}
        onRemove={onRemove}
      />
      {/* `usage === null` used to render a confident "0 % / 0 borrowed" for a
          pool the gateway cannot actually measure. Say which one it is. */}
      {usageUnsupported && (
        <p
          role="status"
          data-testid="quota-pool-usage-unavailable"
          className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200"
        >
          {aisixUnsupportedRead("quota").reason}
        </p>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

export default function QuotaSharePageClient() {
  const t = useTranslations("quotaShare");
  const { pools, loading, unsupported, unsupportedReason, mutate } = usePools();
  const emailsVisible = useEmailPrivacyStore((s) => s.emailsVisible);
  const notify = useNotificationStore();
  // Quota pools/groups/plans are a Next.js/SQLite subsystem. On the AISIX
  // gateway they do not exist, so every group/pool mutation refuses BEFORE
  // sending and the page says so once instead of silently rendering "0 pools".
  const quotaRead = resolveAisixSurfaceSupport("quota", "read");
  const quotaWrite = resolveAisixSurfaceSupport("quota", "write");
  const writeSupported = quotaWrite.supported;

  const refuseQuotaWrite = useCallback(
    (action: string): boolean => {
      if (writeSupported) return false;
      notify.error(`AISIX-шлюз: ${action} недоступно. ${quotaWrite.reason}`);
      return true;
    },
    [writeSupported, notify, quotaWrite.reason]
  );

  // LS → DB migration hook (B22) — runs once, idempotent
  useLocalStoragePoolMigration({ pools, mutate });

  const [connections, setConnections] = useState<Connection[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [plans, setPlans] = useState<Record<string, PlanInfo>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<QuotaPool | null>(null);

  // ── Group state ───────────────────────────────────────────────────────────
  const [groups, setGroups] = useState<QuotaGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("all");
  const [newGroupInput, setNewGroupInput] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // ── Fetch side data once on mount ─────────────────────────────────────────
  //
  // Provider connections DO have a native read (admin `provider_keys`), so that
  // one keeps working on the gateway; the other two (OmniRoute API keys and the
  // quota plan dimensions) are Next-only and degrade to an explicit null instead
  // of a guessed empty list.

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failuresRef = { current: 0 };

    async function loadSideData() {
      if (!quotaRead.supported) return;
      const [connsData, keysData, plansData] = await Promise.all([
        fetchAisixJson(resolveAisixRequestUrl("/api/providers/client")),
        fetchAisixJson(resolveAisixRequestUrl("/api/keys")),
        fetchAisixJson(resolveAisixRequestUrl("/api/quota/plans")),
      ]);
      if (cancelled) return;
      if (connsData.ok) {
        const conns = (connsData.data ?? {}) as { connections?: Connection[] };
        setConnections(Array.isArray(conns.connections) ? conns.connections : []);
      }
      if (keysData.ok) {
        const keys = keysData.data as ApiKey[] | { keys?: ApiKey[] } | null;
        setApiKeys(Array.isArray(keys) ? keys : Array.isArray(keys?.keys) ? keys.keys : []);
      }
      if (plansData.ok && Array.isArray(plansData.data)) {
        const planMap: Record<string, PlanInfo> = {};
        for (const p of plansData.data as Array<{
          connectionId: string;
          dimensions: PlanDimension[];
          source: "auto" | "manual";
        }>) {
          if (p.connectionId)
            planMap[p.connectionId] = { dimensions: p.dimensions, source: p.source };
        }
        setPlans(planMap);
      }
      // `null` for a 404 is the honest answer for keys/plans; the wizard then
      // shows no key/plan choices instead of a phantom "unlimited" plan.
      const anyFailed = [connsData, keysData, plansData].some((r) => !r.ok && !r.missing);
      failuresRef.current = anyFailed ? failuresRef.current + 1 : 0;
    }

    const tick = async () => {
      if (cancelled) return;
      if (!isDocumentHidden()) {
        await loadSideData();
      }
      if (cancelled) return;
      timer = setTimeout(tick, backoffPollDelayMs(SIDE_DATA_POLL_MS, failuresRef.current));
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [quotaRead.supported]);

  // ── Fetch groups ──────────────────────────────────────────────────────────

  const fetchGroups = useCallback(
    async (options?: { signal?: AbortSignal }) => {
      if (!quotaRead.supported) return;
      const result = await fetchAisixJson(resolveAisixRequestUrl("/api/quota/groups"), {
        signal: options?.signal,
      });
      if (options?.signal?.aborted) return;
      if (result.ok) {
        const data = (result.data ?? {}) as { groups?: QuotaGroup[] };
        setGroups(Array.isArray(data.groups) ? data.groups : []);
        return;
      }
      if (result.missing) {
        // The whole group surface is absent — an empty <select> would read as
        // "you have no groups", so keep the page's unsupported banner honest.
        return;
      }
      notify.error(`Ошибка загрузки групп квот (${result.error})`);
    },
    [quotaRead.supported, notify]
  );

  useEffect(() => {
    if (!quotaRead.supported) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => fetchGroups({ signal: controller.signal }));
    return () => {
      controller.abort();
    };
  }, [fetchGroups, quotaRead.supported]);

  // ── Group actions ─────────────────────────────────────────────────────────

  const handleCreateGroup = useCallback(async () => {
    const name = newGroupInput.trim();
    if (!name) return;
    if (refuseQuotaWrite("Создание группы")) return;
    const result = await fetchAisixJson(resolveAisixRequestUrl("/api/quota/groups"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (result.ok) {
      const data = (result.data ?? {}) as { group?: QuotaGroup };
      if (data.group?.id) setSelectedGroupId(data.group.id);
      await fetchGroups();
    } else {
      notify.error(`Не удалось создать группу (${result.error ?? result.status})`);
    }
    setNewGroupInput("");
    setShowNewGroupInput(false);
  }, [newGroupInput, fetchGroups, refuseQuotaWrite, notify]);

  const handleRenameGroup = useCallback(async () => {
    const name = prompt(
      t("groupNamePrompt"),
      groups.find((g) => g.id === selectedGroupId)?.name ?? ""
    );
    if (!name?.trim()) return;
    if (refuseQuotaWrite("Переименование группы")) return;
    setRenaming(true);
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/quota/groups/${encodeURIComponent(selectedGroupId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      }
    );
    if (result.ok) {
      await fetchGroups();
    } else {
      notify.error(`Не удалось переименовать группу (${result.error ?? result.status})`);
    }
    setRenaming(false);
  }, [selectedGroupId, groups, fetchGroups, t, refuseQuotaWrite, notify]);

  // Delete the selected group. The API blocks deletion while the group still has
  // pools (HTTP 409) and protects the seed "group-demo"; surface both to the user.
  const handleDeleteGroup = useCallback(async () => {
    if (selectedGroupId === "all" || selectedGroupId === "group-demo") return;
    if (!confirm(t("deleteGroupConfirm"))) return;
    if (refuseQuotaWrite("Удаление группы")) return;
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/quota/groups/${encodeURIComponent(selectedGroupId)}`),
      { method: "DELETE" }
    );
    if (result.ok) {
      setSelectedGroupId("all");
      await fetchGroups();
      await mutate();
      return;
    }
    if (result.status === 409) {
      alert(t("deleteGroupHasPools"));
      return;
    }
    notify.error(`Не удалось удалить группу (${result.error ?? result.status})`);
  }, [selectedGroupId, fetchGroups, mutate, t, refuseQuotaWrite, notify]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const keyLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const k of apiKeys) map[k.id] = k.name || k.id.slice(0, 12) + "…";
    return map;
  }, [apiKeys]);

  const connLabel = useCallback(
    (connectionId: string) => {
      const conn = connections.find((c) => c.id === connectionId);
      if (!conn) return connectionId.slice(0, 12);
      const raw = conn.name || conn.email || conn.displayName || conn.id.slice(0, 12);
      return emailsVisible ? raw : maskEmailLikeValue(raw);
    },
    [connections, emailsVisible]
  );

  const connProvider = useCallback(
    (connectionId: string) => connections.find((c) => c.id === connectionId)?.provider || "unknown",
    [connections]
  );

  // connectionId → name of the pool it already belongs to (all members, not just
  // primary). Feeds the wizard's "already used" hint so the one-connection-per-pool
  // rule is explicit instead of silently disabling a checkbox.
  const connectionPoolName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of pools) {
      const name = (p as unknown as { name?: string }).name ?? p.id.slice(0, 8);
      for (const cid of p.connectionIds ?? [p.connectionId]) {
        if (!(cid in map)) map[cid] = name;
      }
    }
    return map;
  }, [pools]);

  // Pools whose groupId matches no loaded group (e.g. legacy pools saved with the
  // "all" sentinel). Surfaced in an "Ungrouped" bucket so they stay editable/deletable.
  const orphanPools = useMemo(() => {
    const known = new Set(groups.map((g) => g.id));
    return pools.filter(
      (p) => !known.has((p as unknown as { groupId?: string }).groupId ?? "group-demo")
    );
  }, [pools, groups]);

  const aggregate = usePoolsUsageAggregate(pools);

  // `null` — not `0` — for the two usage KPIs when the gateway reports no
  // per-pool usage: "not reported" and "nothing is borrowing quota" are
  // opposite facts, and only the second one is worth an alert colour.
  const stats = useMemo(
    () => ({
      activePools: pools.length,
      keysAllocated: pools.reduce((s, p) => s + p.allocations.length, 0),
      avgUtilization: aggregate.unsupported ? null : aggregate.avgUtilizationPercent,
      borrowingNow: aggregate.unsupported ? null : aggregate.borrowingKeyCount,
    }),
    [pools, aggregate]
  );

  // Pools filtered by selected group (kept for stats/empty-state checks)
  const filteredPools = useMemo(
    () =>
      selectedGroupId === "all"
        ? pools
        : pools.filter(
            (p) =>
              ((p as unknown as { groupId?: string }).groupId ?? "group-demo") === selectedGroupId
          ),
    [pools, selectedGroupId]
  );

  // Groups to render as stacked sections
  const groupsToRender = useMemo(
    () => (selectedGroupId === "all" ? groups : groups.filter((g) => g.id === selectedGroupId)),
    [groups, selectedGroupId]
  );

  // ── Computed exclusivity for the pool being edited ───────────────────────
  //
  // A pool is exclusive when it has ≥1 allocation AND every allocated key
  // currently has the pool id in its allowedQuotas array.

  const editingExclusive = useMemo(
    () =>
      !!editing &&
      editing.allocations.length > 0 &&
      editing.allocations.every((a) => {
        const k = apiKeys.find((kk) => kk.id === a.apiKeyId);
        const aq = (k as { allowedQuotas?: string[] } | undefined)?.allowedQuotas;
        return Array.isArray(aq) && aq.includes(editing.id);
      }),
    [editing, apiKeys]
  );

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * A failed delete must never look like a click that did nothing. Without the
   * response check the page just revalidated and left the card in place, so a
   * 401 from an expired session, a 500 or a dropped request were all
   * indistinguishable from "I misclicked" — and the operator would click again.
   */
  const handleRemovePool = useCallback(
    async (id: string) => {
      if (!confirm(t("removeConfirm"))) return;
      if (refuseQuotaWrite("Удаление пула")) return;
      setRemoveError(null);
      const result = await fetchAisixJson(
        resolveAisixRequestUrl(`/api/quota/pools/${encodeURIComponent(id)}`),
        { method: "DELETE" }
      );
      if (!result.ok) {
        const body = (result.data ?? {}) as {
          error?: { message?: string } | string;
          message?: string;
        };
        const detail =
          typeof body.error === "object"
            ? body.error?.message
            : (body.error ?? body.message ?? null);
        const reason = result.missing ? quotaWrite.reason : (result.error ?? null);
        setRemoveError(
          [t("removeFailed"), detail ?? reason].filter(Boolean).join(" — ") || t("removeFailed")
        );
        return;
      }
      await mutate();
    },
    [mutate, t, refuseQuotaWrite, quotaWrite.reason]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Falha ao remover: dispensável, mas nunca silenciosa. */}
      {removeError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-200"
        >
          <span className="material-symbols-outlined text-[16px] text-red-500 shrink-0">error</span>
          <span className="flex-1">{removeError}</span>
          <button
            type="button"
            onClick={() => setRemoveError(null)}
            aria-label={t("dismiss")}
            className="shrink-0 text-red-500 hover:text-red-400 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-[24px] text-primary">pie_chart</span>
            {t("title")}
          </h1>
          <p className="text-sm text-text-muted mt-0.5">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
            disabled={!writeSupported}
          >
            <span className="material-symbols-outlined text-[14px] mr-1">add</span>
            {t("newPool")}
          </Button>
        </div>
      </div>

      {/* AISIX SPA: pools/groups/plans are a Next.js-only subsystem. Without
          this banner an empty pool grid reads as "you have no pools yet". */}
      {unsupported && (
        <div
          role="status"
          data-testid="quota-share-unavailable-banner"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-200"
        >
          <span className="material-symbols-outlined text-[16px] text-amber-500 shrink-0">
            block
          </span>
          <span className="flex-1">{unsupportedReason ?? quotaRead.reason}</span>
        </div>
      )}

      {/* Beta banner — scoped to this page only */}
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-200">
        <span className="material-symbols-outlined text-[16px] text-amber-500 shrink-0">
          science
        </span>
        <span className="flex-1">
          <span className="font-semibold">{t("betaTitle")}</span> — {t("betaText")}
        </span>
        <a
          href="https://github.com/diegosouzapw/OmniRoute/issues/new?labels=quota-share,beta&title=%5Bquota-share%5D%20"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-300 hover:underline"
        >
          <span className="material-symbols-outlined text-[14px]">bug_report</span>
          {t("betaReportLink")}
        </a>
      </div>

      {/* Group bar — a group <select> over an absent collection would only
          ever offer the "all" sentinel, so it is hidden together with its
          create/rename/delete actions. */}
      {quotaRead.supported && (
        <div className="flex items-center gap-2 flex-wrap rounded-lg border border-border/40 bg-bg-subtle/20 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wide text-text-muted font-semibold shrink-0">
            {t("groupLabel")}
          </span>
          <select
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            title={t("groupSelectHint")}
            className="px-2 py-1 rounded border border-border bg-bg-base text-sm text-text-main min-w-[120px]"
          >
            <option value="all">{t("allGroups")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          {showNewGroupInput ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newGroupInput}
                onChange={(e) => setNewGroupInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateGroup();
                  if (e.key === "Escape") {
                    setShowNewGroupInput(false);
                    setNewGroupInput("");
                  }
                }}
                placeholder={t("groupNamePrompt")}
                autoFocus
                className="px-2 py-1 rounded border border-border bg-bg-base text-sm w-36"
              />
              <button
                type="button"
                onClick={() => void handleCreateGroup()}
                disabled={!newGroupInput.trim()}
                className="text-xs px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40"
              >
                {t("newGroup")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewGroupInput(false);
                  setNewGroupInput("");
                }}
                className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text-main transition-colors"
              >
                {t("cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowNewGroupInput(true)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-main transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">add</span>
              {t("newGroup")}
            </button>
          )}
          {selectedGroupId !== "all" && (
            <button
              type="button"
              onClick={() => void handleRenameGroup()}
              disabled={renaming}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-main transition-colors ml-1 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[14px]">edit</span>
              {t("renameGroup")}
            </button>
          )}
          {selectedGroupId !== "all" && selectedGroupId !== "group-demo" && (
            <button
              type="button"
              onClick={() => void handleDeleteGroup()}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-red-400 transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">delete</span>
              {t("deleteGroup")}
            </button>
          )}
        </div>
      )}

      {/* Concept card */}
      <QuotaConceptCard />

      {/* Endpoints card */}
      <QuotaEndpointsCard
        groups={groups}
        pools={pools}
        connections={connections}
        apiKeys={apiKeys}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={t("kpiActivePools")} value={String(stats.activePools)} />
        <StatCard label={t("kpiKeysAllocated")} value={String(stats.keysAllocated)} />
        <StatCard
          label={t("kpiAvgUtilization")}
          value={stats.avgUtilization === null ? "—" : `${Math.round(stats.avgUtilization)}%`}
          tone={
            stats.avgUtilization === null
              ? undefined
              : stats.avgUtilization > 80
                ? "red"
                : stats.avgUtilization > 50
                  ? "amber"
                  : "green"
          }
        />
        <StatCard
          label={t("kpiBorrowingNow")}
          value={stats.borrowingNow === null ? "—" : String(stats.borrowingNow)}
          tone={stats.borrowingNow !== null && stats.borrowingNow > 0 ? "amber" : undefined}
        />
      </div>

      {/* Pool list */}
      {loading ? (
        <div className="text-text-muted text-sm py-10 text-center animate-pulse">
          {t("loading")}
        </div>
      ) : pools.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface py-16 text-center">
          <span className="material-symbols-outlined text-[64px] opacity-15">pie_chart</span>
          <h3 className="mt-3 text-base font-semibold text-text-main">{t("emptyTitle")}</h3>
          <p className="mt-1 text-sm text-text-muted max-w-md mx-auto">{t("emptyDescription")}</p>
          <Button
            variant="primary"
            size="sm"
            className="mt-4"
            disabled={!writeSupported}
            onClick={() => setCreateOpen(true)}
          >
            <span className="material-symbols-outlined text-[14px] mr-1">add</span>
            {t("newPool")}
          </Button>
        </div>
      ) : (
        <>
          {groupsToRender.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-surface py-10 text-center">
              <p className="text-sm text-text-muted">{t("emptyDescription")}</p>
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                disabled={!writeSupported}
                onClick={() => setCreateOpen(true)}
              >
                <span className="material-symbols-outlined text-[14px] mr-1">add</span>
                {t("newPool")}
              </Button>
            </div>
          ) : (
            groupsToRender.map((g) => {
              const groupPools = pools.filter(
                (p) => ((p as unknown as { groupId?: string }).groupId ?? "group-demo") === g.id
              );
              return (
                <div key={g.id} className="flex flex-col gap-3">
                  {/* Per-group heading */}
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-text-muted">
                      folder
                    </span>
                    <span className="text-sm font-semibold text-text-main">{g.name}</span>
                    <span className="text-[11px] text-text-muted">({groupPools.length})</span>
                  </div>
                  {groupPools.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border bg-surface py-6 text-center">
                      <p className="text-sm text-text-muted">{t("emptyDescription")}</p>
                      <Button
                        variant="primary"
                        size="sm"
                        className="mt-3"
                        disabled={!writeSupported}
                        onClick={() => setCreateOpen(true)}
                      >
                        <span className="material-symbols-outlined text-[14px] mr-1">add</span>
                        {t("newPool")}
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {groupPools.map((pool) => (
                        <PoolCardWithUsage
                          key={pool.id}
                          pool={pool}
                          keyLabels={keyLabels}
                          connectionLabel={connLabel(pool.connectionId)}
                          provider={connProvider(pool.connectionId)}
                          providers={[
                            ...new Set(
                              (pool.connectionIds ?? [pool.connectionId]).map(connProvider)
                            ),
                          ]}
                          connectionIds={pool.connectionIds ?? [pool.connectionId]}
                          onEdit={() => setEditing(pool)}
                          onRemove={() => void handleRemovePool(pool.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Ungrouped bucket — pools whose group no longer matches (e.g. legacy
              "all" sentinel). Keeps them visible + editable + deletable. */}
          {selectedGroupId === "all" && orphanPools.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-amber-400">
                  folder_off
                </span>
                <span className="text-sm font-semibold text-text-main">{t("ungroupedTitle")}</span>
                <span className="text-[11px] text-text-muted">({orphanPools.length})</span>
              </div>
              <p className="text-[11px] text-amber-400/80">{t("ungroupedHint")}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {orphanPools.map((pool) => (
                  <PoolCardWithUsage
                    key={pool.id}
                    pool={pool}
                    keyLabels={keyLabels}
                    connectionLabel={connLabel(pool.connectionId)}
                    provider={connProvider(pool.connectionId)}
                    providers={[
                      ...new Set((pool.connectionIds ?? [pool.connectionId]).map(connProvider)),
                    ]}
                    connectionIds={pool.connectionIds ?? [pool.connectionId]}
                    onEdit={() => setEditing(pool)}
                    onRemove={() => void handleRemovePool(pool.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Modals */}
      <PoolWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => void mutate()}
        connections={connections}
        apiKeys={apiKeys}
        plans={plans}
        existingPoolConnectionIds={
          new Set(pools.flatMap((p) => p.connectionIds ?? [p.connectionId]))
        }
        connectionPoolName={connectionPoolName}
        groups={groups}
        selectedGroupId={selectedGroupId}
      />

      {/* Edit wizard — separate instance from create to avoid shared state */}
      <PoolWizard
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void mutate();
          setEditing(null);
        }}
        editPool={editing ?? undefined}
        editPoolExclusive={editingExclusive}
        connections={connections}
        apiKeys={apiKeys}
        plans={plans}
        existingPoolConnectionIds={
          new Set(
            pools
              .filter((p) => p.id !== editing?.id)
              .flatMap((p) => p.connectionIds ?? [p.connectionId])
          )
        }
        connectionPoolName={connectionPoolName}
        groups={groups}
        selectedGroupId={selectedGroupId}
      />
    </div>
  );
}
