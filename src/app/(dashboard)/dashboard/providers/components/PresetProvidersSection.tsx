"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, Input } from "@/shared/components";
import { fetchPresetProviders, type AisixPresetProvider } from "@/shared/utils/aisixPresets";
import { matchesSearch } from "@/shared/utils/turkishText";
import { providerText, type ProviderMessageTranslator } from "../[id]/providerCredentialText";

/**
 * `missing`  — the core build has no `preset_providers` endpoint (404/405).
 * `denied`   — the core answered 401/403: it HAS the endpoint but wants an
 *               admin key. Without this the picker would render empty and read
 *               as "this gateway ships no vendors", which is a different fact.
 * `error`    — anything else. The list is unknown, not empty.
 */
type PresetLoadState = "loading" | "ready" | "missing" | "denied" | "error";

function isPresetConfigured(preset: AisixPresetProvider, configuredIds: Set<string>): boolean {
  return configuredIds.has(preset.id.toLowerCase()) || configuredIds.has(preset.name.toLowerCase());
}

function buildPresetOnboardingHref(preset: AisixPresetProvider): string {
  const params = new URLSearchParams();
  params.set("preset", preset.id);
  params.set("presetName", preset.name);
  if (preset.baseUrl) params.set("presetBaseUrl", preset.baseUrl);
  // The auth shape decides WHICH credential the operator pastes, so it travels
  // with the handoff instead of being rediscovered in the form.
  if (preset.authShape) params.set("presetAuth", preset.authShape);
  if (preset.authHeader) params.set("presetAuthHeader", preset.authHeader);
  return `/dashboard/providers/new?${params.toString()}`;
}

/**
 * Search box + auth-shape filter, so 190 vendors stay a list an operator can use.
 * `matchesSearch` (not a raw `toLowerCase().includes`) so a Turkish dotted/dotless
 * İ query still finds "İdeogram" — a vendor name in the catalog.
 */
function presetMatchesQuery(preset: AisixPresetProvider, query: string): boolean {
  return (
    matchesSearch(preset.name, query) ||
    matchesSearch(preset.id, query) ||
    matchesSearch(preset.baseUrl, query)
  );
}

/** Stable group key: the auth shape, with the credential header disambiguating. */
function presetGroupKey(preset: AisixPresetProvider): string {
  if (!preset.authShape) return "unknown";
  return preset.authHeader ? `${preset.authShape}:${preset.authHeader}` : preset.authShape;
}

/**
 * Core-shipped preset catalog (`GET :3001/admin/v1/preset_providers`):
 * the 190 vendors a provider key can point at, each with a shortcut that
 * prefills the `/dashboard/providers/new` wizard form.
 *
 * Every backend state degrades to an explicit line — 404/405 (no catalog on
 * this core build), 401/403 (catalog exists, admin key missing), load error
 * with a working Retry, or "all provisioned" — never a spinner without a
 * timeout (the fetch itself is time-bounded) and never an empty grid that
 * looks like a gateway with no vendors.
 */
export default function PresetProvidersSection({
  connections,
}: {
  connections: Array<{ provider?: string | null }>;
}) {
  const router = useRouter();
  const t = useTranslations("providers");
  const tCommon = useTranslations("common");
  const text = (key: string, fallback: string, values?: Record<string, unknown>) =>
    providerText(t as ProviderMessageTranslator, key, fallback, values);

  const [state, setState] = useState<PresetLoadState>("loading");
  const [presets, setPresets] = useState<AisixPresetProvider[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [authFilter, setAuthFilter] = useState<string | null>(null);

  const configuredIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conn of connections) {
      if (typeof conn?.provider === "string" && conn.provider.trim().length > 0) {
        ids.add(conn.provider.trim().toLowerCase());
      }
    }
    return ids;
  }, [connections]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState("loading");
      const result = await fetchPresetProviders();
      if (cancelled) return;
      if (result.missing) {
        setPresets([]);
        setState("missing");
        return;
      }
      if (result.status === 401 || result.status === 403) {
        setPresets([]);
        setState("denied");
        return;
      }
      if (result.status === null || result.status < 200 || result.status >= 300) {
        setPresets([]);
        setState("error");
        return;
      }
      setPresets(result.presets);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const unprovisioned = useMemo(
    () => presets.filter((preset) => !isPresetConfigured(preset, configuredIds)),
    [presets, configuredIds]
  );

  /**
   * Group the catalog by auth shape (the field that changes what the operator
   * pastes), with the per-shape vendor count. This is what turns a 190-row
   * dump into something scannable: 184 bearer vendors and 6 header vendors are
   * a different task each.
   */
  const authGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const preset of unprovisioned) {
      const key = presetGroupKey(preset);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [unprovisioned]);

  const visible = useMemo(
    () =>
      unprovisioned.filter(
        (preset) =>
          presetMatchesQuery(preset, query.trim()) &&
          (authFilter === null || presetGroupKey(preset) === authFilter)
      ),
    [unprovisioned, query, authFilter]
  );

  return (
    <div className="flex flex-col gap-4" data-testid="preset-providers-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
          {text("presetCatalogTitle", "Preset providers")}{" "}
          <span
            className="size-2.5 rounded-full bg-teal-500"
            title={text("presetCatalogTitle", "Preset providers")}
          />
        </h2>
      </div>
      <p className="text-sm text-text-muted -mt-2">
        {text(
          "presetCatalogSubtitle",
          "Vendors shipped by the gateway preset catalog that have no local connection yet. Pick one to prefill the key creation form."
        )}
      </p>

      {state === "loading" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" aria-busy="true">
          {[0, 1, 2, 3].map((slot) => (
            <Card key={slot} padding="sm">
              <div className="h-4 w-2/3 rounded bg-black/10 dark:bg-white/10 animate-pulse" />
              <div className="mt-2 h-3 w-full rounded bg-black/5 dark:bg-white/5 animate-pulse" />
              <div className="mt-3 h-8 w-full rounded-lg bg-black/5 dark:bg-white/5 animate-pulse" />
            </Card>
          ))}
        </div>
      )}

      {state === "missing" && (
        <div
          className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm"
          data-testid="preset-providers-missing"
        >
          <span className="material-symbols-outlined text-[18px]">cloud_off</span>
          <span>
            {text(
              "presetCatalogMissing",
              "No preset catalog on this core build — nothing to provision from."
            )}
          </span>
        </div>
      )}

      {state === "denied" && (
        <div
          className="flex flex-wrap items-center gap-3 py-4 px-4 border border-dashed border-amber-500/40 rounded-xl text-sm"
          data-testid="preset-providers-denied"
        >
          <span className="material-symbols-outlined text-[18px] text-amber-500">lock</span>
          <span className="text-text-main flex-1 min-w-[240px]">
            {text(
              "aisixAdminKeyRequired",
              "The gateway answered 401: this catalog needs an admin key. Add one to admin.admin_keys in the gateway config, then reload. The vendor list is hidden, not empty."
            )}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              setReloadToken((token) => token + 1);
            }}
          >
            {tCommon("retry")}
          </Button>
        </div>
      )}

      {state === "error" && (
        <div
          className="flex flex-wrap items-center gap-3 py-4 px-4 border border-dashed border-red-500/40 rounded-xl text-sm"
          data-testid="preset-providers-error"
        >
          <span className="material-symbols-outlined text-[18px] text-red-500">error</span>
          <span className="text-text-main flex-1 min-w-[200px]">
            {text(
              "presetCatalogError",
              "Failed to load the preset catalog. The list is unknown — not empty."
            )}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              setReloadToken((token) => token + 1);
            }}
          >
            {tCommon("retry")}
          </Button>
        </div>
      )}

      {state === "ready" &&
        (unprovisioned.length === 0 ? (
          <div
            className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm"
            data-testid="preset-providers-all-provisioned"
          >
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            <span>
              {text(
                "presetCatalogAllProvisioned",
                "Every preset vendor from the core catalog is already provisioned."
              )}
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder={text(
                    "presetCatalogSearchPlaceholder",
                    "Search by name, id or base URL…"
                  )}
                  aria-label={text(
                    "presetCatalogSearchPlaceholder",
                    "Search by name, id or base URL…"
                  )}
                  data-testid="preset-providers-search"
                />
              </div>
              <span className="text-xs text-text-muted pb-2" data-testid="preset-providers-count">
                {text("presetCatalogShowing", "{shown} of {total}", {
                  shown: visible.length,
                  total: unprovisioned.length,
                })}
              </span>
            </div>

            {/* Auth shape decides which credential the operator pastes, so it is
                both a filter and a visible label — never a hidden detail. */}
            {authGroups.length > 1 && (
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="preset-providers-auth-filters"
              >
                <button
                  type="button"
                  onClick={() => {
                    setAuthFilter(null);
                  }}
                  aria-pressed={authFilter === null}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    authFilter === null
                      ? "border-teal-500/60 bg-teal-500/10 text-teal-600 dark:text-teal-400"
                      : "border-border text-text-muted hover:text-text-main"
                  }`}
                >
                  {tCommon("all")} ({unprovisioned.length})
                </button>
                {authGroups.map(([key, count]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setAuthFilter((current) => (current === key ? null : key));
                    }}
                    aria-pressed={authFilter === key}
                    data-testid={`preset-providers-auth-filter-${key}`}
                    className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                      authFilter === key
                        ? "border-sky-500/60 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                        : "border-border text-text-muted hover:text-text-main"
                    }`}
                  >
                    {key} ({count})
                  </button>
                ))}
              </div>
            )}

            {visible.length === 0 ? (
              <div
                className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm"
                data-testid="preset-providers-no-matches"
              >
                <span className="material-symbols-outlined text-[18px]">search_off</span>
                <span>{tCommon("noResults")}</span>
              </div>
            ) : (
              <div
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[32rem] overflow-y-auto"
                data-testid="preset-providers-grid"
              >
                {visible.map((preset) => (
                  <Card key={preset.id} padding="sm">
                    <div className="flex flex-col gap-2 h-full">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-main truncate" title={preset.name}>
                          {preset.name}
                        </p>
                        {preset.baseUrl ? (
                          <code
                            className="block text-[11px] text-text-muted font-mono truncate"
                            title={preset.baseUrl}
                          >
                            {preset.baseUrl}
                          </code>
                        ) : (
                          <p className="text-[11px] text-text-muted italic">
                            {text("presetCatalogNoBaseUrl", "base URL not reported")}
                          </p>
                        )}
                      </div>
                      {preset.authShape ? (
                        <span
                          className="inline-flex w-fit items-center px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[11px] font-medium"
                          data-testid="preset-providers-auth-shape"
                        >
                          {preset.authShape}
                          {preset.authHeader ? (
                            <span className="ml-1 font-mono opacity-80">
                              {text("presetCatalogAuthHeader", "in {header}", {
                                header: preset.authHeader,
                              })}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span
                          className="inline-flex w-fit items-center px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 text-text-muted text-[11px] font-medium"
                          data-testid="preset-providers-auth-shape"
                        >
                          {text("presetCatalogAuthUnknown", "auth shape unknown")}
                        </span>
                      )}
                      {preset.headers.length > 0 && (
                        <p
                          className="text-[10px] text-text-muted font-mono truncate"
                          title={preset.headers.map((h) => `${h.name}: ${h.value}`).join("\n")}
                        >
                          {preset.headers.map((h) => h.name).join(", ")}
                        </p>
                      )}
                      <Button
                        size="sm"
                        icon="add"
                        className="mt-auto"
                        data-testid={`preset-providers-provision-${preset.id}`}
                        onClick={() => router.push(buildPresetOnboardingHref(preset))}
                      >
                        {text("presetCatalogProvision", "Provision")}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        ))}
    </div>
  );
}
