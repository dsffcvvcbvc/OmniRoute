import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PresetProvidersSection from "../PresetProvidersSection";

/**
 * The preset section is the only control-plane surface for the 190-vendor
 * catalog, so these assertions pin the three facts that make it usable rather
 * than decorative:
 *
 *   - the AUTH SHAPE is rendered, because it decides which credential the
 *     operator pastes (and the core sends it as an OBJECT);
 *   - a 401 renders as "needs an admin key", never as an empty picker that
 *     reads like "this gateway ships no vendors";
 *   - 190 entries are searchable and filterable by auth shape.
 *
 * The data layer is stubbed at the FETCH boundary only (the module under test
 * is the component), so no request shape is invented here — the parser
 * contract itself is pinned in tests/unit/aisix-preset-providers.test.ts.
 */

const fetchPresetProviders = vi.fn();
const push = vi.fn();

// `has()` is false for every key, which is what `providerText` uses to decide to
// render the call-site fallback. Asserting the FALLBACK is deliberate: it is the
// string an operator sees for any locale that has not translated the key yet,
// and it is the string the i18n completeness gate keeps honest.
const translator = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values).replace(/"([A-Za-z]+)":/g, "$1=")}` : key;
(translator as { has?: unknown }).has = () => false;
vi.mock("next-intl", () => ({ useTranslations: () => translator }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/shared/utils/aisixPresets", async () => {
  const actual = await vi.importActual<typeof import("@/shared/utils/aisixPresets")>(
    "@/shared/utils/aisixPresets"
  );
  return { ...actual, fetchPresetProviders: (...args: unknown[]) => fetchPresetProviders(...args) };
});

const BEARER = {
  id: "agnes",
  display_name: "Agnes",
  base_url: "https://apihub.agnes-ai.com/v1/chat/completions",
  auth: { type: "bearer" },
  headers: [],
};
const HEADER_KEY = {
  id: "haiper",
  display_name: "Haiper",
  base_url: "https://api.haiper.ai/v1",
  auth: { type: "api_key_header", header: "HAIPER_KEY" },
  headers: [],
};

describe("PresetProvidersSection — the AISIX preset catalog control plane", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    push.mockClear();
  });

  afterEach(() => {
    document.body.removeChild(container);
    fetchPresetProviders.mockReset();
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    await act(async () => {
      root.render(<PresetProvidersSection connections={[]} />);
    });
  }

  function setSearch(value: string) {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="preset-providers-search"]'
    );
    if (!input) throw new Error("search input not rendered");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders the auth shape and the credential header the core reported", async () => {
    fetchPresetProviders.mockResolvedValue({
      presets: [
        {
          id: "agnes",
          name: "Agnes",
          baseUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
          authShape: "bearer",
          authHeader: null,
          headers: [],
        },
        {
          id: "haiper",
          name: "Haiper",
          baseUrl: "https://api.haiper.ai/v1",
          authShape: "api_key_header",
          authHeader: "HAIPER_KEY",
          headers: [],
        },
      ],
      missing: false,
      status: 200,
    });
    await render();

    const shapes = [
      ...container.querySelectorAll('[data-testid="preset-providers-auth-shape"]'),
    ].map((node) => node.textContent || "");
    expect(shapes.some((s) => s.includes("bearer"))).toBe(true);
    // The header NAME is the payload: it is what tells the operator which box to
    // paste into, so it must be on screen, not just the shape.
    expect(shapes.some((s) => s.includes("HAIPER_KEY"))).toBe(true);
    expect(container.textContent || "").toContain("apihub.agnes-ai.com");
  });

  it("carries the auth shape and base URL into the onboarding deep link", async () => {
    fetchPresetProviders.mockResolvedValue({
      presets: [
        {
          id: "haiper",
          name: "Haiper",
          baseUrl: "https://api.haiper.ai/v1",
          authShape: "api_key_header",
          authHeader: "HAIPER_KEY",
          headers: [],
        },
      ],
      missing: false,
      status: 200,
    });
    await render();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="preset-providers-provision-haiper"]'
    );
    expect(button).toBeTruthy();
    act(() => {
      button?.click();
    });

    expect(push).toHaveBeenCalledTimes(1);
    const href = String(push.mock.calls[0][0]);
    expect(href).toContain("preset=haiper");
    expect(href).toContain("presetName=Haiper");
    expect(href).toContain("presetBaseUrl=https%3A%2F%2Fapi.haiper.ai%2Fv1");
    // The shape used to be dropped on the floor between the two pages.
    expect(href).toContain("presetAuth=api_key_header");
    expect(href).toContain("presetAuthHeader=HAIPER_KEY");
  });

  it("names the missing admin key on 401 instead of showing an empty catalog", async () => {
    fetchPresetProviders.mockResolvedValue({ presets: [], missing: false, status: 401 });
    await render();

    const denied = container.querySelector('[data-testid="preset-providers-denied"]');
    expect(denied).toBeTruthy();
    expect(denied?.textContent || "").toContain("answered 401");
    expect(denied?.textContent || "").toContain("admin.admin_keys");
    // The failure mode this replaces: a grid with zero vendors, which reads as
    // "this gateway has no preset vendors at all".
    expect(container.querySelector('[data-testid="preset-providers-grid"]')).toBeNull();
    expect(container.querySelector('[data-testid="preset-providers-error"]')).toBeNull();
  });

  it("still distinguishes 404 (no catalog on this build) from 401", async () => {
    fetchPresetProviders.mockResolvedValue({ presets: [], missing: true, status: 404 });
    await render();
    expect(container.querySelector('[data-testid="preset-providers-missing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="preset-providers-denied"]')).toBeNull();
  });

  it("search narrows the catalog instead of dumping every row", async () => {
    const presets = Array.from({ length: 190 }, (_, index) => ({
      id: `vendor-${index}`,
      name: `Vendor ${index}`,
      baseUrl: `https://api.vendor${index}.test/v1`,
      authShape: index % 3 === 0 ? "api_key_header" : "bearer",
      authHeader: null,
      headers: [],
    }));
    fetchPresetProviders.mockResolvedValue({ presets, missing: false, status: 200 });
    await render();

    expect(container.querySelectorAll('[data-testid="preset-providers-grid"] > *').length).toBe(
      190
    );
    // `providerText` interpolates {shown}/{total} into the fallback itself.
    expect(container.querySelector('[data-testid="preset-providers-count"]')?.textContent).toBe(
      "190 of 190"
    );

    setSearch("vendor-7");
    const shown = container.querySelectorAll('[data-testid="preset-providers-grid"] > *').length;
    // vendor-7 plus vendor-70..79 → eleven rows. A flat 190-row dump is what
    // this replaces, and the count is a substring assertion on a *smaller* set
    // than the full render, so it can only pass if the filter really ran.
    expect(shown).toBe(11);

    setSearch("nothing-matches-this");
    expect(container.querySelector('[data-testid="preset-providers-no-matches"]')).toBeTruthy();
  });

  it("groups by auth shape so bearer and header vendors are separable", async () => {
    fetchPresetProviders.mockResolvedValue({
      presets: [
        {
          id: "agnes",
          name: "Agnes",
          baseUrl: "https://apihub.agnes-ai.com/v1",
          authShape: "bearer",
          authHeader: null,
          headers: [],
        },
        {
          id: "haiper",
          name: "Haiper",
          baseUrl: "https://api.haiper.ai/v1",
          authShape: "api_key_header",
          authHeader: "HAIPER_KEY",
          headers: [],
        },
      ],
      missing: false,
      status: 200,
    });
    await render();

    const filters = container.querySelector('[data-testid="preset-providers-auth-filters"]');
    expect(filters).toBeTruthy();
    const labels = [...(filters?.querySelectorAll("button") || [])].map((b) => b.textContent || "");
    // Each group carries its own count, so the operator sees 184-vs-6 at a glance.
    expect(labels.some((l) => l.includes("bearer") && l.includes("(1)"))).toBe(true);
    expect(labels.some((l) => l.includes("api_key_header:HAIPER_KEY") && l.includes("(1)"))).toBe(
      true
    );
  });

  it("marks an unreported auth shape as unknown instead of guessing one", async () => {
    fetchPresetProviders.mockResolvedValue({
      presets: [
        {
          id: "mystery",
          name: "Mystery",
          baseUrl: null,
          authShape: null,
          authHeader: null,
          headers: [],
        },
      ],
      missing: false,
      status: 200,
    });
    await render();

    const shape = container.querySelector('[data-testid="preset-providers-auth-shape"]');
    expect(shape?.textContent).toBe("auth shape unknown");
    expect(container.textContent || "").toContain("base URL not reported");
  });
});

// Referenced so the live-payload fixtures above are not tree-shaken out of the
// file by a reader wondering why they exist.
void BEARER;
void HEADER_KEY;
