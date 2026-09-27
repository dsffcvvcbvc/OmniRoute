import { expect, test, type Page } from "@playwright/test";

import { PageWatch, SCRIPT_PATTERNS, localeButton, readContent, writeEvidence } from "./harness";

/**
 * 04 — LOCALE.
 *
 * The export ships 67 catalogues; only the default one is on the critical path
 * and the other 66 arrive as lazy chunks on first use. So there are two
 * separable claims, and a suite that only checks the first will happily pass
 * while the feature is half-dead:
 *
 *   (a) switching in-session swaps the catalogue, `<html lang>` and `dir`;
 *   (b) the choice SURVIVES — a preference the app stores and then ignores on
 *       the next page load is not a preference.
 *
 * Both are asserted. `ja` and `ar` are checked because they are non-Latin and
 * `ar` is right-to-left, so a switch that only ever swaps Latin text would
 * still fail them. The menu is driven by the native names the UI itself
 * renders, and the switch is confirmed by the presence of that script in the
 * visible copy — not by an internal state read.
 */

type LocaleCase = {
  /** The native label as the menu renders it. */
  menuLabel: string;
  /** The code the document must end up declaring. */
  expectedLang: string;
  expectedDir: "ltr" | "rtl";
  script: keyof typeof SCRIPT_PATTERNS;
  label: string;
};

const CASES: LocaleCase[] = [
  {
    menuLabel: "日本語",
    expectedLang: "ja",
    expectedDir: "ltr",
    script: "kana",
    label: "Japanese",
  },
  {
    menuLabel: "العربية",
    expectedLang: "ar",
    expectedDir: "rtl",
    script: "arabic",
    label: "Arabic (RTL)",
  },
];

async function openLocaleMenu(page: Page): Promise<void> {
  const trigger = localeButton(page);
  await expect(trigger, "the header carries no locale control").toBeVisible({ timeout: 45_000 });
  await trigger.click();
  await expect
    .poll(
      async () =>
        page
          .locator("header button")
          .filter({ hasText: "English" })
          .count()
          .catch(() => 0),
      { timeout: 20_000, message: "the locale menu did not open" }
    )
    .toBeGreaterThan(0);
}

async function chooseLocale(page: Page, menuLabel: string): Promise<void> {
  const option = page.locator("header button").filter({ hasText: menuLabel }).last();
  await expect(option, `the locale menu offers no "${menuLabel}"`).toBeVisible({ timeout: 30_000 });
  await option.click();
}

async function readLocaleState(page: Page) {
  // The WHOLE visible copy, not a prefix: a slice of the first few hundred
  // characters is decided by whatever the header happens to contain, and would
  // make the assertion a claim about the toolbar rather than about the page.
  return page.evaluate(() => {
    const body = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    return {
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      cookie: document.cookie,
      bodyLength: body.length,
      body,
    };
  });
}

/** Does the visible copy carry the writing system this locale uses? */
function hasScript(state: { body: string }, script: keyof typeof SCRIPT_PATTERNS): boolean {
  return SCRIPT_PATTERNS[script].test(state.body);
}

test.describe("locale", () => {
  test("the dashboard starts in the default locale", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await expect(localeButton(page), "the header carries no locale control").toBeVisible();
  });

  for (const locale of CASES) {
    test(`switching to ${locale.label} translates the UI and moves lang/dir`, async ({ page }) => {
      const watch = new PageWatch(page);
      await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
      await readContent(page, { minLength: 400 });
      const before = await readLocaleState(page);

      await openLocaleMenu(page);
      await chooseLocale(page, locale.menuLabel);

      // `<html lang>` flips synchronously with the locale change, but the
      // catalogue for the new locale is a LAZY CHUNK that has not arrived yet
      // when it does — so asserting the copy in the same tick as the attribute
      // would be asserting that the network is fast. Poll for the copy
      // instead: the claim is "the UI ends up in that language", not "the UI is
      // in that language microseconds after the click".
      await expect
        .poll(async () => hasScript(await readLocaleState(page), locale.script), {
          timeout: 45_000,
          message:
            `the visible copy never picked up any ${locale.script} text after choosing ` +
            `${locale.menuLabel} — the catalogue chunk did not load, so the page is ` +
            "relabelled but untranslated",
        })
        .toBe(true);

      await expect
        .poll(async () => (await readLocaleState(page)).lang, {
          timeout: 45_000,
          message: `<html lang> never became ${locale.expectedLang} after choosing ${locale.menuLabel}`,
        })
        .toBe(locale.expectedLang);

      const after = await readLocaleState(page);
      writeEvidence(`04-switch-${locale.expectedLang}.json`, {
        before,
        after,
        watch: watch.dump(),
      });

      expect(after.dir, `<html dir> must follow the locale (${locale.expectedDir})`).toBe(
        locale.expectedDir
      );
      expect(
        hasScript(after, locale.script),
        `after choosing ${locale.menuLabel} the visible copy still contains no ` +
          `${locale.script} text, so the catalogue did not load — the page is relabelled but ` +
          `untranslated. Sample: ${after.body.slice(0, 200)}`
      ).toBe(true);
      expect(
        watch.pageErrors,
        `an uncaught exception occurred while switching to ${locale.label}`
      ).toEqual([]);
    });

    test(`a ${locale.label} choice survives a reload`, async ({ page }) => {
      await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
      await readContent(page, { minLength: 400 });
      await openLocaleMenu(page);
      await chooseLocale(page, locale.menuLabel);
      await expect
        .poll(async () => (await readLocaleState(page)).lang, { timeout: 45_000 })
        .toBe(locale.expectedLang);

      // The app stored the choice itself — assert the store first, so a later
      // failure is unambiguously "stored but not honoured", not "never stored".
      const stored = await page.evaluate(() => ({
        cookie: document.cookie,
        local: window.localStorage.getItem("NEXT_LOCALE"),
      }));
      expect(
        `${stored.cookie} ${stored.local}`,
        `choosing ${locale.menuLabel} stored no preference at all, so persistence is untestable`
      ).toContain(locale.expectedLang);

      // Now reload. A static export has no server render to re-read the
      // cookie, so if the client does not re-apply it the operator is back to
      // the default language on every page load.
      const watch = new PageWatch(page);
      await page.reload({ waitUntil: "load", timeout: 90_000 });
      await readContent(page, { minLength: 400, timeoutMs: 75_000 });
      const afterReload = await readLocaleState(page);
      writeEvidence(`04-persist-${locale.expectedLang}.json`, {
        stored,
        afterReload,
        watch: watch.dump(),
      });

      expect(
        afterReload.lang,
        `the operator chose ${locale.label}, the app stored "${stored.cookie}", and after a ` +
          `reload the document declares lang="${afterReload.lang}" — the stored preference is ` +
          "ignored on entry, so the choice lasts only until the first refresh"
      ).toBe(locale.expectedLang);
      expect(afterReload.dir, `<html dir> must still be ${locale.expectedDir} after a reload`).toBe(
        locale.expectedDir
      );
      expect(
        hasScript(afterReload, locale.script),
        `after a reload the UI is no longer in ${locale.label}: ${afterReload.body.slice(0, 200)}`
      ).toBe(true);
    });
  }
});
