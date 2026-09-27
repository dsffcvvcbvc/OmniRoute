import { expect, test } from "@playwright/test";

import { PageWatch, emptinessMessage, readContent, writeEvidence } from "./harness";

/**
 * 01 — the app BOOTS.
 *
 * This is the assertion the previous report could not make. Serving the right
 * bytes with the right content type is not hydration: a document whose scripts
 * never execute looks byte-identical to one that does. So nothing here asserts
 * on the served HTML at all — every assertion is about what the RUNNING page
 * does, which only a hydrated client can do.
 */

test.describe("hydration", () => {
  test("the dashboard boots, hydrates, and stays clean", async ({ page }) => {
    const watch = new PageWatch(page);

    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });

    // ── the real DOM renders ────────────────────────────────────────────────
    const content = await readContent(page, { minLength: 400 });
    writeEvidence("01-hydration-content.json", {
      length: content.length,
      loaded: content.loaded,
      waitedMs: content.waitedMs,
      history: content.history,
    });
    expect(content.loaded, emptinessMessage("/dashboard", content, 400)).toBe(true);

    // ── an uncaught exception is not tolerated ──────────────────────────────
    writeEvidence("01-hydration-watch.json", watch.dump());
    expect(
      watch.pageErrors,
      "uncaught exception(s) during boot — each is an app fault, not a loading state"
    ).toEqual([]);

    // ── and specifically not a hydration mismatch ──────────────────────────
    // React recovers from a mismatch by throwing away the server tree and
    // re-rendering, so the page can look complete and still have hydrated
    // incorrectly. This is the only signal that distinguishes the two.
    expect(
      watch.hydrationErrors(),
      "the client tree disagreed with the prerendered HTML (hydration mismatch)"
    ).toEqual([]);

    // ── a control only a hydrated client can operate changes the document ──
    // Dark mode is a purely client-side preference: the prerendered document
    // cannot carry it, and no server round-trip is involved. A click that
    // mutates the document is therefore proof that React is live, from
    // observable outcome only.
    //
    // Located by its rendered accessibility label rather than by role+name:
    // `getByRole("button", { name: … })` does not resolve this control's
    // accessible name in this build (count 0 against a button that is present,
    // visible and carries the label), so the attribute selector is the
    // reliable handle and is what an operator's own screen reader reads.
    const themeToggle = page.locator(
      "button[aria-label='Switch to dark mode'], button[aria-label='Switch to light mode']"
    );
    await expect(themeToggle, "the theme control is missing from the header").toBeVisible();

    const before = await page.evaluate(() => document.documentElement.className);
    await themeToggle.click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.className), {
        timeout: 20_000,
        message: "clicking the theme control did not change the document",
      })
      .not.toBe(before);
    writeEvidence("01-hydration-theme.json", {
      before,
      after: await page.evaluate(() => document.documentElement.className),
    });
  });

  test("the document is alive after boot: a second interaction is still handled", async ({
    page,
  }) => {
    // A page can hydrate and then die — one route in this export drives a
    // runaway request loop that kills the tab outright. Re-interacting after
    // the first render is what separates "hydrated" from "hydrated and still
    // there".
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });

    // Collapsing the sidebar is client-only state: the rendered width shrinks
    // and the control flips to its expand affordance. Both are observable
    // outcomes, neither is an internal handle.
    const sidebar = page.locator("button[aria-label='Collapse sidebar']");
    await expect(sidebar, "the sidebar collapse control is missing").toBeVisible();
    const widthBefore = await page.evaluate(() => {
      const link = document.querySelector('a[href="/dashboard/providers"]');
      const holder = link?.closest("div");
      return holder ? Math.round(holder.getBoundingClientRect().width) : -1;
    });
    expect(widthBefore, "could not measure the sidebar before the click").toBeGreaterThan(0);

    await sidebar.click();
    await expect(
      page.locator("button[aria-label='Expand sidebar']"),
      "collapsing the sidebar did not flip the control to its expand affordance"
    ).toBeVisible({ timeout: 20_000 });
    const widthAfter = await page.evaluate(() => {
      const link = document.querySelector('a[href="/dashboard/providers"]');
      const holder = link?.closest("div");
      return holder ? Math.round(holder.getBoundingClientRect().width) : -1;
    });
    expect(
      widthAfter,
      "the sidebar did not narrow after the collapse control was used"
    ).toBeLessThan(widthBefore);

    // The page must still answer — a dead renderer surfaces here as a rejected
    // evaluate, which is exactly how the runaway-loop routes fail.
    const stillAlive = await page.evaluate(() => document.readyState);
    expect(stillAlive, "the page stopped responding after the first interaction").toBe("complete");
  });
});
