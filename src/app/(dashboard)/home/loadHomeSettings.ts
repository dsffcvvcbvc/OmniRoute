export type HomeSettings = { setupComplete?: unknown };

/**
 * AGENT.md v2.0 §3.2 + Law 5 Case A: Home settings read from native AISIX
 * Admin API instead of SQLite (`@/lib/db/settings` is Node-only and cannot
 * bundle into the static SPA). Best-effort: any failure degrades to defaults.
 */
export async function loadHomeSettings(): Promise<HomeSettings> {
  try {
    const res = await fetch("/admin/v1/resources", { cache: "no-store" });
    if (!res.ok) return { setupComplete: false };
    const data = await res.json().catch(() => null);
    const setupComplete =
      typeof data?.setupComplete === "boolean"
        ? data.setupComplete
        : Array.isArray(data)
          ? true
          : false;
    return { setupComplete };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Home] Failed to load settings; rendering with defaults: ${message}`);
    return { setupComplete: false };
  }
}
