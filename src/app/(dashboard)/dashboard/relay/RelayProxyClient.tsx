"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { useNotificationStore } from "@/store/notificationStore";
import { useDisplayBaseUrl } from "@/shared/hooks";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

interface RelayToken {
  id: string;
  name: string;
  tokenPrefix: string;
  description: string;
  comboId: string | null;
  allowedModels: string;
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export default function RelayProxyClient() {
  const t = useTranslations("relay");
  const displayBaseUrl = useDisplayBaseUrl();
  const [tokens, setTokens] = useState<RelayToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTokenData, setNewTokenData] = useState<{ rawToken: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", maxRpm: "60", maxRpd: "10000" });
  const addNotification = useNotificationStore((s) => s.addNotification);
  // Relay tokens are a Next.js-only subsystem: the Rust core has no relay proxy,
  // so `/api/relay/tokens*` is a guaranteed 404 in the static SPA. The page
  // therefore states that up front and every mutation refuses BEFORE sending
  // (and with its buttons disabled) instead of firing requests whose 404 was
  // previously swallowed into an empty token list.
  const relayRead = resolveAisixSurfaceSupport("relay", "read");
  const relayWrite = resolveAisixSurfaceSupport("relay", "write");
  const relaySupported = relayRead.supported;
  const writeSupported = relayWrite.supported;

  const refuseRelayWrite = useCallback(
    (action: string): boolean => {
      if (writeSupported) return false;
      addNotification({ type: "error", message: `AISIX-шлюз: ${action}. ${relayWrite.reason}` });
      return true;
    },
    [writeSupported, addNotification, relayWrite.reason]
  );

  const fetchTokens = useCallback(async () => {
    if (!relaySupported) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await fetchAisixJson(resolveAisixRequestUrl("/api/relay/tokens"));
    if (!result.ok) {
      // A 404 here is the definitive "no relay surface" answer: surface it
      // instead of degrading to an empty table that looks like "no tokens yet".
      addNotification({
        type: "error",
        // Literal, not t(): the gateway-only messages deliberately bypass the
        // message catalog (see the combos page's combos-write refusals) so no
        // per-locale key has to be added for a build that only AISIX ships.
        message: result.missing
          ? relayRead.reason
          : `Ошибка загрузки токенов relay (${result.error})`,
      });
      setTokens([]);
      setLoading(false);
      return;
    }
    const data = result.data;
    setTokens(Array.isArray(data) ? (data as RelayToken[]) : []);
    setLoading(false);
  }, [relaySupported, relayRead.reason, addNotification]);

  useEffect(() => {
    void (async () => {
      await fetchTokens();
    })();
  }, [fetchTokens]);

  const createToken = async () => {
    if (!form.name.trim()) return;
    if (refuseRelayWrite(t("createButton"))) return;
    const result = await fetchAisixJson(resolveAisixRequestUrl("/api/relay/tokens"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        description: form.description,
        maxRequestsPerMinute: Number(form.maxRpm),
        maxRequestsPerDay: Number(form.maxRpd),
      }),
    });
    if (!result.ok) {
      addNotification({
        type: "error",
        message: result.missing ? relayWrite.reason : t("createFailed"),
      });
      return;
    }
    const data = (result.data ?? {}) as { rawToken?: unknown; name?: unknown };
    if (typeof data.rawToken !== "string") {
      addNotification({ type: "error", message: t("createFailed") });
      return;
    }
    setNewTokenData({ rawToken: data.rawToken, name: String(data.name ?? form.name) });
    setForm({ name: "", description: "", maxRpm: "60", maxRpd: "10000" });
    setShowCreate(false);
    addNotification({ type: "success", message: t("created") });
    void fetchTokens();
  };

  const toggleToken = async (id: string, enabled: boolean) => {
    if (refuseRelayWrite(t("disable"))) return;
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/relay/tokens/${encodeURIComponent(id)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }
    );
    if (!result.ok) {
      addNotification({
        type: "error",
        message: result.missing ? relayWrite.reason : t("toggleFailed"),
      });
      return;
    }
    void fetchTokens();
  };

  const deleteToken = async (id: string) => {
    if (!confirm(t("deleteConfirm"))) return;
    if (refuseRelayWrite(t("delete"))) return;
    const result = await fetchAisixJson(
      resolveAisixRequestUrl(`/api/relay/tokens/${encodeURIComponent(id)}`),
      { method: "DELETE" }
    );
    if (!result.ok) {
      addNotification({
        type: "error",
        message: result.missing ? relayWrite.reason : t("deleteFailed"),
      });
      return;
    }
    addNotification({ type: "success", message: t("deleted") });
    void fetchTokens();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t("title")}</h1>
          <p className="text-sm text-text-muted mt-1">{t("description")}</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)} disabled={!writeSupported}>
          {showCreate ? t("cancel") : t("newToken")}
        </Button>
      </div>

      {/* AISIX SPA: the relay subsystem is not part of the Rust core. */}
      {!relaySupported && (
        <div
          role="status"
          data-testid="relay-unavailable-banner"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200"
        >
          <span className="material-symbols-outlined text-[18px] text-amber-500 shrink-0">
            block
          </span>
          <span className="flex-1">{relayRead.reason}</span>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <Card>
          <div className="p-4 space-y-4">
            <h2 className="text-sm font-semibold">{t("createTitle")}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t("nameRequired")}</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="my-api-relay"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("tokenDescription")}</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t("descriptionPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("maxPerMinute")}</label>
                <input
                  type="number"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.maxRpm}
                  onChange={(e) => setForm({ ...form, maxRpm: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("maxPerDay")}</label>
                <input
                  type="number"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.maxRpd}
                  onChange={(e) => setForm({ ...form, maxRpd: e.target.value })}
                />
              </div>
            </div>
            <Button onClick={createToken} disabled={!writeSupported || !form.name.trim()}>
              {t("createButton")}
            </Button>
          </div>
        </Card>
      )}

      {/* Token Display (shown once after creation) */}
      {newTokenData && (
        <Card>
          <div className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-green-600 dark:text-green-400">
              {t("createdTitle")}
            </h2>
            <div className="bg-surface/50 border border-border rounded-lg p-3">
              <p className="text-xs text-text-muted mb-1">
                {t.rich("tokenFor", {
                  name: newTokenData.name,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <code className="text-sm font-mono break-all select-all bg-black/10 dark:bg-white/10 px-2 py-1 rounded">
                {newTokenData.rawToken}
              </code>
            </div>
            <p className="text-xs text-text-muted">{t("shownOnce")}</p>
            <Button onClick={() => setNewTokenData(null)}>{t("dismiss")}</Button>
          </div>
        </Card>
      )}

      {/* Usage Guide */}
      <Card>
        <div className="p-4 space-y-2">
          <h2 className="text-sm font-semibold">{t("usage")}</h2>
          <p className="text-xs text-text-muted">{t("usageDescription")}</p>
          <pre className="text-xs bg-surface/50 border border-border rounded-lg p-3 overflow-x-auto">
            {`curl ${displayBaseUrl}/v1/relay/chat/completions \\
  -H "Authorization: Bearer relay_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}]}'`}
          </pre>
        </div>
      </Card>

      {/* Tokens List */}
      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold mb-3">
            {t("tokenCount", { count: tokens.length })}
          </h2>
          {loading ? (
            <p className="text-sm text-text-muted">{t("loading")}</p>
          ) : !relaySupported ? (
            <p className="text-sm text-text-muted">{relayRead.reason}</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            <div className="space-y-2">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="flex items-center justify-between border border-border rounded-lg p-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full ${token.enabled ? "bg-green-500" : "bg-red-500"}`}
                    />
                    <div>
                      <div className="font-medium text-sm">{token.name}</div>
                      <div className="text-xs text-text-muted font-mono">
                        {token.tokenPrefix}...
                      </div>
                      {token.description && (
                        <div className="text-xs text-text-muted mt-0.5">{token.description}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="info" size="sm">
                      {token.maxRequestsPerMinute}/min
                    </Badge>
                    <Badge variant="info" size="sm">
                      {token.maxRequestsPerDay}/day
                    </Badge>
                    <button
                      onClick={() => toggleToken(token.id, !token.enabled)}
                      disabled={!writeSupported}
                      className="text-xs text-primary hover:underline disabled:opacity-40"
                    >
                      {token.enabled ? t("disable") : t("enable")}
                    </button>
                    <button
                      onClick={() => deleteToken(token.id)}
                      disabled={!writeSupported}
                      className="text-xs text-red-500 hover:underline disabled:opacity-40"
                    >
                      {t("delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
