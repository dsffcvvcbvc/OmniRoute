// @vitest-environment jsdom
//
// AGENT.md §3.3 — the AISIX static SPA export's client-side message catalogue.
//
// `src/app/layout.tsx` hands the root `NextIntlClientProvider` a catalogue
// IMPORTED INSIDE a Client Component rather than passed down as a prop from a
// Server Component, because a prop crossing the RSC boundary is re-serialized
// into the flight payload of every prerendered route (~1.9 GiB of a 2.03 GiB
// artifact). The payoff of that move is only real if the browser still ends up
// with a usable tree, so this file asserts the BEHAVIOUR, not the source shape:
//
//   - the default locale renders synchronously from the bundled catalogue
//     (this is the hydration-critical path — a Suspense-based provider would
//     either flash untranslated keys or need a per-render global on the server);
//   - `setClientLocale()` — the channel `LanguageSelector` and `LocaleAutoDetect`
//     both write to — actually swaps the rendered language, including a
//     non-Latin one and an RTL one, and keeps `<html lang>`/`dir` honest;
//   - a locale this build ships no catalogue for changes nothing.
//
// A static export can only prerender one message tree (src/i18n/request.ts pins
// DEFAULT_LOCALE under OMNIROUTE_EXPORT=1), so before this provider the language
// switcher in the export was a NO-OP: `router.refresh()` re-downloaded the same
// English payload. That gap is what the client-side swap closes.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale, useTranslations } from "next-intl";

// The shared vitest setup (tests/_setup/vitestUiPolyfills.ts) replaces the whole
// `next-intl` module with `useLocale: () => "en"` and a pass-through
// `NextIntlClientProvider`, so under that mock a locale switch is unobservable
// by construction and this suite would pass without testing anything. A
// per-file factory overrides it (Vitest takes the most specific per module id),
// so this suite runs against the REAL provider and the REAL `use-intl`
// context — the thing whose behaviour actually decides whether the switch works.
vi.mock("next-intl", async (importOriginal) => await importOriginal());

import { SpaIntlProvider } from "@/i18n/SpaIntlProvider";
import { setClientLocale } from "@/i18n/localeChange";
import { buildLocaleMessages, normalizeComplianceEventTypes } from "@/i18n/catalog";

import arMessages from "@/i18n/messages/ar.json";
import enMessages from "@/i18n/messages/en.json";
import hiMessages from "@/i18n/messages/hi.json";
import jaMessages from "@/i18n/messages/ja.json";

type Catalog = Record<string, Record<string, string>>;
const read = (catalog: unknown, path: string): string =>
  (catalog as Catalog)[path.split(".")[0]][path.split(".")[1]];

/** A consumer that reads from the same context the real dashboard reads. */
function Probe() {
  const t = useTranslations("sidebar");
  const common = useTranslations("common");
  const locale = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="settings">{t("settings")}</span>
      <span data-testid="save">{common("save")}</span>
    </div>
  );
}

describe("SpaIntlProvider", () => {
  const cleanups: Array<() => void> = [];

  // The provider resolves a non-default locale with a LAZY `import()`. Under
  // Vitest that first resolution also pays Vite's transform of a ~1 MB JSON
  // chunk, which is ~1 s — an order of magnitude slower than the switch itself
  // and pure test-harness latency. Pre-warm the exact specifier shape the
  // provider uses so the switch below is a cache hit and the assertions are
  // about behaviour rather than about the transformer's speed.
  beforeAll(async () => {
    for (const code of ["ja", "hi", "ar"]) {
      await import(`@/i18n/messages/${code}.json`);
    }
  });

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  async function mount(locale = "en") {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SpaIntlProvider locale={locale}>
          <Probe />
        </SpaIntlProvider>
      );
    });
    cleanups.push(() => {
      root.unmount();
      container.remove();
    });

    const text = (testid: string) =>
      container.querySelector(`[data-testid="${testid}"]`)?.textContent;

    /**
     * A non-default catalogue arrives from a LAZY chunk, so the message swap
     * lands one act AFTER the locale swap. Wait for BOTH, and poll with real
     * time between attempts: returning early on the locale alone would let this
     * suite pass without ever covering the swap, and a promise-only flush does
     * not give the module graph time to hand back the chunk.
     */
    const switchTo = async (code: string, catalog: unknown) => {
      const expected = read(catalog, "sidebar.settings");
      // 100 x 20 ms = 2 s of real waiting. Bounded well under the runner's 5 s
      // per-test timeout so a real failure reports WHY instead of timing out.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await act(async () => {
          setClientLocale(code);
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        if (text("locale") === code && text("settings") === expected) return;
      }
      throw new Error(
        `locale did not settle on "${code}" after 100 flushes ` +
          `(locale=${text("locale")}, settings=${text("settings")})`
      );
    };

    return { text, switchTo };
  }

  it("renders the default locale synchronously from the bundled catalogue", async () => {
    const view = await mount();

    expect(view.text("locale")).toBe("en");
    expect(view.text("settings")).toBe(read(enMessages, "sidebar.settings"));
    expect(view.text("save")).toBe(read(enMessages, "common.save"));
  });

  it("switches to a non-Latin locale when the selection channel fires", async () => {
    const view = await mount();

    await view.switchTo("ja", jaMessages);

    expect(view.text("locale")).toBe("ja");
    expect(view.text("settings")).toBe(read(jaMessages, "sidebar.settings"));
    expect(view.text("save")).toBe(read(jaMessages, "common.save"));
    expect(document.documentElement.lang).toBe("ja");
  });

  it("switches to a second non-Latin locale without reloading the page", async () => {
    const view = await mount();

    await view.switchTo("hi", hiMessages);

    expect(view.text("locale")).toBe("hi");
    expect(view.text("settings")).toBe(read(hiMessages, "sidebar.settings"));
    expect(view.text("save")).toBe(read(hiMessages, "common.save"));
  });

  it("flips <html dir> for an RTL locale and back for an LTR one", async () => {
    const view = await mount();

    await view.switchTo("ar", arMessages);
    expect(view.text("locale")).toBe("ar");
    expect(view.text("settings")).toBe(read(arMessages, "sidebar.settings"));
    expect(document.documentElement.dir).toBe("rtl");

    await view.switchTo("en", enMessages);
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists the selection to the cookie the server path also reads", async () => {
    const view = await mount();
    await view.switchTo("ja", jaMessages);

    expect(document.cookie).toContain("NEXT_LOCALE=ja");
  });

  it("ignores a locale this build ships no catalogue for", async () => {
    const view = await mount();

    const applied = await act(async () => setClientLocale("klingon"));

    expect(applied).toBeNull();
    expect(view.text("locale")).toBe("en");
    expect(document.cookie).not.toContain("NEXT_LOCALE=klingon");
  });
});

/**
 * The provider builds its eager EN tree with the synchronous step of
 * `buildLocaleMessages` (the whole function for a non-fallback locale is `async`,
 * and the server render pass plus hydration both need the value NOW). If the two
 * constants ever diverge — e.g. `FALLBACK_LOCALE` stops being `DEFAULT_LOCALE` —
 * the browser would resolve keys differently from the server. This is the
 * assertion that keeps them identical.
 */
describe("SPA eager catalogue parity", () => {
  it("normalizeComplianceEventTypes(en) is exactly buildLocaleMessages('en', en)", async () => {
    const raw = enMessages as unknown as Record<string, unknown>;

    const eager = normalizeComplianceEventTypes(raw);
    const viaPipeline = await buildLocaleMessages("en", raw, async () => raw);

    expect(eager).toEqual(viaPipeline);
  });
});
