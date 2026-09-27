import { expect, test } from "@playwright/test";

import { ADMIN_KEY, PageWatch, authenticate, emptinessMessage, readContent } from "./harness";

/**
 * NEGATIVE CONTROLS — excluded from a normal run on purpose.
 *
 * Per AGENTS.md a check that cannot fail is worse than none. Every assertion in
 * the other files here could, in principle, be unfalsifiable, so this file
 * breaks each mechanism on purpose and REQUIRES it to go red. A control that
 * passes means the assertion it stands for proves nothing.
 *
 * That is also why `playwright.aisix-spa.config.ts` ignores this file: a suite
 * whose audit pass is expected to fail must never be mixed into a run someone
 * is trying to make green.
 *
 * Audit it with:
 *   AISIX_SPA_BASE_URL=… AISIX_SPA_ADMIN_KEY=… \
 *     npx playwright test -c playwright.aisix-spa.config.ts \
 *     tests/aisix-spa-e2e/negative-controls.spec.ts --grep-invert C3b
 *
 * Every test below must be RED. C3b is the one deliberate exception and is
 * named as such: it is a self-check that the failure predicate is faithful,
 * not an inverted control, so it is expected to pass.
 */

test.describe("NEGATIVE CONTROLS — every one of these MUST fail (C3b excepted)", () => {
  test("C1 hydration: the theme control does not change the document", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    const before = await page.evaluate(() => document.documentElement.className);
    await page.locator("button[aria-label='Switch to dark mode']").click();
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => document.documentElement.className);
    // Inverted on purpose.
    expect(after, "CONTROL FAILED: the theme control really does mutate the document").toBe(before);
  });

  test("C2 content region: a page that renders 2000 chars does not reach 200000", async ({
    page,
  }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    const content = await readContent(page, { minLength: 200_000, timeoutMs: 12_000 });
    expect(content.loaded, emptinessMessage("/dashboard", content, 200_000)).toBe(true);
  });

  test("C3 anti-vacuity: a capture of nothing IS caught by the guard", async ({ page }) => {
    // 05 asserts `statics.length >= 5` BEFORE asserting the list is free of
    // 4xx — otherwise a page that requested nothing would pass both. This
    // control runs that same guard against a scope that matches nothing, which
    // is what a broken recorder would look like from the suite's side.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page.waitForTimeout(3000);

    const recorderWorks = watch.under("/_next/");
    expect(
      recorderWorks.length,
      "CONTROL FAILED: the recorder captured no /_next/ requests, so the whole file is void"
    ).toBeGreaterThanOrEqual(5);

    const emptyCapture = watch.under("/_no_such_prefix_/");
    // Inverted on purpose: an empty capture must NOT satisfy the guard.
    expect(
      emptyCapture.length,
      "CONTROL FAILED: the vacuity guard accepted an empty capture"
    ).toBeGreaterThanOrEqual(5);
  });

  test("C3b SELF-CHECK (expected to PASS): the failure predicate is faithful", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page.waitForTimeout(3000);
    const all = watch.non2xx();
    expect(
      all.length,
      "CONTROL FAILED: no non-2xx was recorded at all, so `non2xx()` is not recording"
    ).toBeGreaterThan(0);
    expect(
      all.filter((r) => r.status >= 400).length,
      "CONTROL FAILED: the >= 400 predicate dropped entries the filter returned"
    ).toBe(all.length);
  });

  test("C4 absent routes: a route that IS in the build does not 404", async ({ page }) => {
    const response = await page.goto("/dashboard/providers/openai", {
      waitUntil: "load",
      timeout: 90_000,
    });
    expect(
      response!.status(),
      "CONTROL FAILED: a present route really does answer 404 — the 4xx filter matches everything"
    ).toBeGreaterThanOrEqual(400);
  });

  test("C5 locale: switching to Japanese does NOT change <html lang>", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page
      .locator("header button")
      .filter({ has: page.locator('img[src*="flagcdn"]') })
      .first()
      .click();
    await expect
      .poll(async () => page.locator("header button").filter({ hasText: "English" }).count())
      .toBeGreaterThan(0);
    await page.locator("header button").filter({ hasText: "日本語" }).last().click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.lang), { timeout: 30_000 })
      .toBe("ja");
    const lang = await page.evaluate(() => document.documentElement.lang);
    // Inverted on purpose: the switch really does change it.
    expect(lang, "CONTROL FAILED: the locale switch really does move <html lang>").toBe("en");
  });

  test("C6 admin 401 state: the denial banner is NOT present while signed in", async ({
    page,
    context,
  }) => {
    await authenticate(context, ADMIN_KEY);
    await page.goto("/dashboard/providers", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    const section = page.locator('[data-testid="provider-keys-section"]');
    await expect(section).toBeVisible({ timeout: 60_000 });
    // Inverted on purpose: signed in, there is no denial.
    await expect(
      section.locator('[data-testid="provider-keys-denied"]'),
      "CONTROL FAILED: the denial banner really is absent when the credential is valid"
    ).toBeVisible({ timeout: 10_000 });
  });

  test("C7 client-side nav: the marker DOES die on a real document load", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page.evaluate(() => {
      (window as unknown as { __c?: string }).__c = "alive";
    });
    // A REAL document load, not a router navigation: this is what the marker
    // is supposed to detect.
    await page.goto("/dashboard/combos", { waitUntil: "load", timeout: 90_000 });
    const alive = await page.evaluate(
      () => (window as unknown as { __c?: string }).__c === "alive"
    );
    // Inverted on purpose: after a real load the marker is gone.
    expect(alive, "CONTROL FAILED: a fresh document kept the marker — the check is void").toBe(
      true
    );
  });

  test("C8 request budget: the peak-repeat measure does find a repeat", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    await page.waitForTimeout(5000);
    const peak = watch.peakRepeats(5000);
    // Inverted on purpose: the storm really is above any sane ceiling.
    expect(
      peak.count,
      `CONTROL FAILED: the storm is gone — peak was ${peak.count} on ${peak.key}`
    ).toBeLessThanOrEqual(5);
  });

  test("C9 uncaught exceptions: a deliberately thrown one IS recorded", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("deliberate control exception");
      }, 0);
    });
    await page.waitForTimeout(1500);
    // Inverted on purpose: the recorder really does capture page errors.
    expect(
      watch.pageErrors,
      "CONTROL FAILED: pageerror was not recorded — the exception assertion is void"
    ).toEqual([]);
  });

  test("C10 broken images: the naturalWidth filter DOES find failures", async ({ page }) => {
    await page.goto("/dashboard/media-providers/image", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    await page.waitForTimeout(3000);
    const broken = await page.evaluate(
      () =>
        [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0)
          .length
    );
    // Inverted on purpose: images really are broken on this route.
    expect(broken, "CONTROL FAILED: no broken image was found on this route").toBe(0);
  });
});
