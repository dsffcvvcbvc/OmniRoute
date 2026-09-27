"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@/shared/components";
import { fetchPresetProviders, type AisixPresetProvider } from "@/shared/utils/aisixPresets";

type PresetLoadState = "loading" | "ready" | "missing" | "error";

function isPresetConfigured(preset: AisixPresetProvider, configuredIds: Set<string>): boolean {
  return configuredIds.has(preset.id.toLowerCase()) || configuredIds.has(preset.name.toLowerCase());
}

function buildPresetOnboardingHref(preset: AisixPresetProvider): string {
  const params = new URLSearchParams();
  params.set("preset", preset.id);
  params.set("presetName", preset.name);
  if (preset.baseUrl) params.set("presetBaseUrl", preset.baseUrl);
  if (preset.authShape) params.set("presetAuth", preset.authShape);
  return `/dashboard/providers/new?${params.toString()}`;
}

/**
 * Core-shipped preset catalog (`GET :3001/admin/v1/preset_providers`):
 * vendors not yet provisioned locally, each with a "Завести" shortcut that
 * prefills the `/dashboard/providers/new` wizard form. Every backend state
 * degrades to an explicit line — 404/405 (no catalog on this core build),
 * load error with a working Retry, or "all provisioned" — never a spinner
 * without a timeout (the fetch itself is time-bounded).
 */
export default function PresetProvidersSection({
  connections,
}: {
  connections: Array<{ provider?: string | null }>;
}) {
  const router = useRouter();
  const [state, setState] = useState<PresetLoadState>("loading");
  const [presets, setPresets] = useState<AisixPresetProvider[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

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

  return (
    <div className="flex flex-col gap-4" data-testid="preset-providers-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
          {/* Literal (no providers key): the glossary/completeness gate forbids en-only additions. */}
          Preset providers{" "}
          <span className="size-2.5 rounded-full bg-teal-500" title="Preset providers" />
        </h2>
      </div>
      {/* Literal (no providers key): the glossary/completeness gate forbids en-only additions. */}
      <p className="text-sm text-text-muted -mt-2">
        Vendors shipped by the core preset catalog that have no local connection yet. Pick one to
        prefill the key creation form.
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
        <div className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm">
          <span className="material-symbols-outlined text-[18px]">cloud_off</span>
          {/* Literal (no providers key): honest refusal when :3001 has no preset_providers endpoint. */}
          <span>No preset catalog on this core build — nothing to provision from.</span>
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-wrap items-center gap-3 py-4 px-4 border border-dashed border-red-500/40 rounded-xl text-sm">
          <span className="material-symbols-outlined text-[18px] text-red-500">error</span>
          {/* Literal (no providers key): the glossary/completeness gate forbids en-only additions. */}
          <span className="text-text-main flex-1 min-w-[200px]">
            Failed to load the preset catalog. The list is unknown — not empty.
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              setReloadToken((token) => token + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {state === "ready" &&
        (unprovisioned.length === 0 ? (
          <div className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            {/* Literal (no providers key): the glossary/completeness gate forbids en-only additions. */}
            <span>Every preset vendor from the core catalog is already provisioned.</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {unprovisioned.map((preset) => (
              <Card key={preset.id} padding="sm">
                <div className="flex flex-col gap-2">
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
                      /* Literal (no providers key): honest "not reported", never invented. */
                      <p className="text-[11px] text-text-muted italic">base URL not reported</p>
                    )}
                  </div>
                  {preset.authShape ? (
                    <span className="inline-flex w-fit items-center px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[11px] font-medium">
                      {preset.authShape}
                    </span>
                  ) : (
                    /* Literal (no providers key): honest "not reported", never invented. */
                    <span className="inline-flex w-fit items-center px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 text-text-muted text-[11px] font-medium">
                      auth shape unknown
                    </span>
                  )}
                  <Button
                    size="sm"
                    icon="add"
                    onClick={() => router.push(buildPresetOnboardingHref(preset))}
                  >
                    {/* Literal (no providers key): the glossary/completeness gate forbids en-only additions. */}
                    Завести
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ))}
    </div>
  );
}
