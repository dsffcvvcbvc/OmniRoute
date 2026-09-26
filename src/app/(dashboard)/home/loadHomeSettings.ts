import { aisixAdminModelsUrl } from "@/shared/utils/aisixEndpoints";

/**
 * Tri-state home readiness:
 *   - `true` / `false` — the settings payload said so explicitly, or a readable
 *     admin catalog implies a provisioned operator (`true`).
 *   - `"unknown"` — the native admin plane is UNREACHABLE. This is deliberately
 *     distinct from `true`: `true` means "setup is complete", `unknown` means
 *     "no evidence either way". Collapsing them was a product change smuggled
 *     as a default — callers must decide explicitly (Home hides the first-run
 *     nag for `unknown` without claiming the setup is complete).
 */
export type HomeSetupState = boolean | "unknown";

export type HomeSettings = { setupComplete: HomeSetupState };

type SettingsPayload = { setupComplete?: unknown } | null;

/**
 * AGENT.md v2.0 §3.2 + Law 5 Case A: Home settings read from the native AISIX
 * Admin API instead of SQLite (`@/lib/db/settings` is Node-only and cannot
 * bundle into the static SPA).
 *
 * Two things this must get right, both learned the hard way:
 *
 * 1. ABSOLUTE URL. `/home` is a server component that Next **prerenders** for
 *    the static export, so a relative `fetch("/admin/v1/...")` runs in the build
 *    process with no origin to resolve against and always throws.
 * 2. NO ETERNAL `false`. A prerender also means the value is baked into the
 *    HTML — if an unreachable admin plane were reported as "setup not
 *    complete", the first-run readiness card would nag every operator forever,
 *    including those who can never complete a Next/SQLite onboarding wizard in
 *    the Rust core at all. An unreachable plane is therefore reported as
 *    `"unknown"`: no evidence of an unfinished setup, so no nag — and no false
 *    claim of completion either.
 *
 * The loader is injectable so the corrupt-DB regression (#14060) can be
 * exercised without a network round-trip.
 */
async function loadNativeAdminSettings(): Promise<SettingsPayload> {
  const res = await fetch(aisixAdminModelsUrl(), { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as SettingsPayload;
}

export async function loadHomeSettings(
  load: () => Promise<SettingsPayload> = loadNativeAdminSettings
): Promise<HomeSettings> {
  try {
    const data = await load();
    // An explicit boolean (a settings-shaped payload) always wins.
    if (typeof data?.setupComplete === "boolean") {
      return { setupComplete: data.setupComplete };
    }
    // Unreachable admin plane: unknown, not "complete".
    if (data === null || data === undefined) {
      return { setupComplete: "unknown" };
    }
    // Otherwise the native contract applies: a readable admin catalog means the
    // operator already provisioned providers.
    return { setupComplete: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Home] Failed to load settings; core state unknown: ${message}`);
    return { setupComplete: "unknown" };
  }
}
