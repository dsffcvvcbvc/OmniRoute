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
//   - a locale this build ships no catalogue for changes nothing;
//   - a preference the operator already STORED is honoured again on the next
//     page load, which is the half a switch test can never reach: a preference
//     that is stored and then ignored on entry lasts only until the first
//     refresh.
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

// `LocaleAutoDetect` calls `useRouter()`; the real one needs a Next request
// scope this jsdom tree does not have. Only the `refresh` identity matters here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { SpaIntlProvider } from "@/i18n/SpaIntlProvider";
import { setClientLocale } from "@/i18n/localeChange";
import { buildLocaleMessages, normalizeComplianceEventTypes } from "@/i18n/catalog";
import { LocaleAutoDetect } from "@/shared/components/LocaleAutoDetect";

import arMessages from "@/i18n/messages/ar.json";
import enMessages from "@/i18n/messages/en.json";
import hiMessages from "@/i18n/messages/hi.json";
import idMessages from "@/i18n/messages/id.json";
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

/** Wipe both stores `persistLocale` writes, so each test starts as a cold load. */
function clearStoredLocale(): void {
  document.cookie = "NEXT_LOCALE=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  window.localStorage.removeItem("NEXT_LOCALE");
}

/** Seed the stored preference exactly as `persistLocale` would, pre-hydration. */
function storeLocale(code: string, { cookie = true, local = true } = {}): void {
  if (cookie) document.cookie = `NEXT_LOCALE=${code}; path=/`;
  if (local) window.localStorage.setItem("NEXT_LOCALE", code);
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
    for (const code of ["ja", "hi", "ar", "id"]) {
      await import(`@/i18n/messages/${code}.json`);
    }
  });

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    // The provider reads the STORED preference on mount, so a cookie left
    // behind by the previous test is input, not residue. Without this the file
    // would only pass because of the order its `it` blocks happen to run in.
    clearStoredLocale();
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  async function mount(locale = "en", extra?: React.ReactNode) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SpaIntlProvider locale={locale}>
          {extra}
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
     *
     * This is the PAGE LOAD path — nothing announces anything, so `act` is only
     * here to flush React. `switchTo` is the same wait preceded by the click
     * that announces the change.
     */
    const settle = async (code: string, catalog: unknown) => {
      const expected = read(catalog, "sidebar.settings");
      // 100 x 20 ms = 2 s of real waiting. Bounded well under the runner's 5 s
      // per-test timeout so a real failure reports WHY instead of timing out.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        if (text("locale") === code && text("settings") === expected) return;
      }
      throw new Error(
        `locale did not settle on "${code}" after 100 flushes ` +
          `(locale=${text("locale")}, settings=${text("settings")})`
      );
    };

    /** Let every effect and lazy chunk land, for a locale that must NOT change. */
    const settleNothing = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
    };

    const switchTo = async (code: string, catalog: unknown) => {
      await act(async () => setClientLocale(code));
      await settle(code, catalog);
    };

    return { text, switchTo, settle, settleNothing };
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

  /**
   * Defence in depth at the one place a locale becomes a MODULE PATH. The
   * bundler resolves `import(\`./messages/${activeLocale}.json\`)` to a fixed map
   * of chunks, so this is not a filesystem read — but `activeLocale` originates
   * from a cookie, from `navigator.languages` and from the server, and the
   * invariant belongs beside that import rather than three calls up the chain.
   */
  it("renders the bundled default, not a crash, when mounted with an unknown locale", async () => {
    const view = await mount("klingon");

    expect(view.text("locale")).toBe("klingon");
    expect(view.text("settings")).toBe(read(enMessages, "sidebar.settings"));
  });

  // ── The page-load half ─────────────────────────────────────────────────────
  //
  // Everything above starts from `activeLocale = the server's prop` and changes
  // it by CLICKING. A reload changes nothing: the browser re-fetches the same
  // prerendered bytes, so the only thing that can restore `ja` is the stored
  // preference — and a preference that is stored and then ignored on entry is
  // not a preference. These mount a COLD tree with the store already populated
  // and never call `setClientLocale`, which is exactly what a page load does.

  it("applies a stored ja preference on load — the choice survives the reload", async () => {
    storeLocale("ja");
    const view = await mount();

    await view.settle("ja", jaMessages);

    expect(view.text("locale")).toBe("ja");
    expect(view.text("settings")).toBe(read(jaMessages, "sidebar.settings"));
    expect(document.documentElement.lang).toBe("ja");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("applies a stored ar preference on load, RTL included", async () => {
    storeLocale("ar");
    const view = await mount();

    await view.settle("ar", arMessages);

    expect(view.text("locale")).toBe("ar");
    expect(view.text("settings")).toBe(read(arMessages, "sidebar.settings"));
    expect(document.documentElement.lang).toBe("ar");
    // The direction is the half an English-only flash erases: the export
    // prerenders `dir="ltr"`, so a load that does not re-derive `dir` leaves a
    // right-to-left operator reading a left-to-right document.
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("honours a preference stored only in localStorage, i.e. a blocked cookie", async () => {
    storeLocale("ja", { cookie: false });
    const view = await mount();

    await view.settle("ja", jaMessages);

    expect(view.text("locale")).toBe("ja");
  });

  it("prefers the cookie over localStorage, like the server does", async () => {
    document.cookie = "NEXT_LOCALE=ar; path=/";
    window.localStorage.setItem("NEXT_LOCALE", "ja");
    const view = await mount();

    await view.settle("ar", arMessages);

    expect(view.text("locale")).toBe("ar");
  });

  /**
   * Parity with `src/i18n/request.ts`, which resolves the SAME cookie through
   * `resolveRequestedLocale`. `in` is a real, retired locale (a duplicate of
   * `id`) that a browser may still carry in a year-old cookie; the standalone
   * server lands it on `id`, so the export must not silently answer "English"
   * to the same operator.
   */
  it("resolves a stored alias the same way the server path does (in → id)", async () => {
    storeLocale("in");
    const view = await mount();

    await view.settle("id", idMessages);

    expect(view.text("locale")).toBe("id");
  });

  it("leaves a stored preference that equals the rendered one alone", async () => {
    storeLocale("en");
    const view = await mount();
    await view.settleNothing();

    expect(view.text("locale")).toBe("en");
    expect(view.text("settings")).toBe(read(enMessages, "sidebar.settings"));
    expect(document.documentElement.lang).toBe("en");
  });

  /**
   * An unvalidated stored value is a chunk NAME. `activeLocale` reaches
   * `import(\`./messages/${activeLocale}.json\`)`, and although the bundler
   * resolves that specifier against a fixed map (so it is not a filesystem
   * read), the value originates in a cookie any visitor can set by hand. This
   * asserts the rejection is observable at the render, which is the only place
   * it matters: the garbage never becomes `activeLocale`, so the import guard
   * is never reached with it and the bundled default keeps rendering.
   */
  it("rejects a garbage stored value instead of routing it into a catalogue", async () => {
    // A cookie value cannot contain `;` or whitespace without being encoded, so
    // the two stores are seeded separately: the cookie-borne list stays inside
    // cookie syntax, the localStorage list carries the raw hostile bytes a
    // devtools edit can produce. Both must end at the same place — the bundled
    // default, rendered, with the store left exactly as it was found.
    const inCookie = [
      "../../../etc/passwd",
      "en/../../messages/en",
      "__proto__",
      "klingon",
      "%2e%2e",
    ];
    const inLocalStorage = [
      ...inCookie,
      "ja; path=/",
      'ja" onload=alert(1)',
      "ja\nSet-Cookie: x=1",
      "en ",
      "a".repeat(4096),
    ];

    for (const [hostile, store] of [
      ...inCookie.map((value): [string, "cookie" | "local"] => [value, "cookie"]),
      ...inLocalStorage.map((value): [string, "cookie" | "local"] => [value, "local"]),
    ]) {
      clearStoredLocale();
      if (store === "cookie") storeLocale(hostile, { local: false });
      else storeLocale(hostile, { cookie: false });
      const view = await mount();
      await view.settleNothing();

      expect(view.text("locale"), `"${hostile}" (${store}) became the active locale`).toBe("en");
      expect(view.text("settings"), `"${hostile}" (${store}) changed the rendered catalogue`).toBe(
        read(enMessages, "sidebar.settings")
      );
      expect(document.documentElement.lang, `"${hostile}" (${store}) rewrote <html lang>`).toBe(
        "en"
      );
      // A rejected value is left exactly as found — the loader never launders an
      // unknown code into a stored preference nothing can read.
      if (store === "cookie") {
        expect(document.cookie, `"${hostile}" was rewritten instead of ignored`).toContain(
          `NEXT_LOCALE=${hostile}`
        );
      } else {
        expect(window.localStorage.getItem("NEXT_LOCALE"), `"${hostile}" was rewritten`).toBe(
          hostile
        );
      }
    }
  });

  /**
   * The REAL tree, in the real order: `src/app/layout.tsx` renders
   * `<SpaIntlProvider>{<LocaleAutoDetect/>}</SpaIntlProvider>`, and React flushes
   * a child's passive effect BEFORE its parent's. So the first-visit
   * auto-detection's `setClientLocale` — a `window` CustomEvent — is dispatched
   * before `SpaIntlProvider` has run its own `subscribeLocaleChange`, and an
   * announce-only design drops it on the floor.
   *
   * It survives here because the fix reads the DURABLE store (which
   * `setClientLocale` already wrote synchronously) rather than the event. This
   * test is the reason that choice cannot be "simplified" back into an
   * announce-only one without the suite noticing.
   */
  it("applies the first-visit browser detection on load, in the real tree order", async () => {
    const previous = process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
    Object.defineProperty(navigator, "languages", { value: ["ja-JP"], configurable: true });
    try {
      const view = await mount("en", <LocaleAutoDetect />);

      await view.settle("ja", jaMessages);

      expect(view.text("locale")).toBe("ja");
      expect(view.text("settings")).toBe(read(jaMessages, "sidebar.settings"));
      expect(document.documentElement.lang).toBe("ja");
    } finally {
      process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = previous;
    }
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
