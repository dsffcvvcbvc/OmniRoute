import { expect, test } from "@playwright/test";

import { PageWatch, emptinessMessage, readContent, writeEvidence } from "./harness";

/**
 * 02 — DEEP-LINK ENTRY.
 *
 * The scenario that breaks when a route's prerendered RSC tree is missing: the
 * operator types or bookmarks a nested URL and the tab opens on it cold. There
 * is no in-app navigation to fall back on, so whatever the host shipped at that
 * exact path is the whole experience. The refresh half matters separately — a
 * document that only renders once in a lifetime hides a router that cannot
 * rebuild the tree on the second visit.
 *
 * These routes are `<Suspense fallback={null}>` shells, so an empty content
 * region is a plausible failure and `readContent` exists to tell "still
 * loading" from "rendered nothing" — the growth trajectory goes into the
 * failure message so a reader of the log can see which one it was.
 */

const DEEP_ROUTES = [
  "/dashboard/providers/openai",
  "/dashboard/cli-code/opencode",
  "/dashboard/media-providers/image",
] as const;

/** A route that renders its own content is well past a loading skeleton. */
const MIN_CONTENT_CHARS = 120;

test.describe("deep-link entry by URL", () => {
  for (const route of DEEP_ROUTES) {
    test(`cold load of ${route} renders its own content`, async ({ page }) => {
      const watch = new PageWatch(page);

      // No in-app navigation: the URL is the only entry point, as in a
      // bookmark, a pasted link or a fresh tab.
      const response = await page.goto(route, { waitUntil: "load", timeout: 90_000 });
      expect(response, `${route} answered nothing at all`).not.toBeNull();
      expect(
        response!.status(),
        `${route} did not serve a document — a deep link that 404s has no fallback`
      ).toBe(200);

      const content = await readContent(page, { minLength: MIN_CONTENT_CHARS, timeoutMs: 60_000 });
      writeEvidence(`02-cold-${route.replace(/\//g, "_")}.json`, {
        route,
        length: content.length,
        loaded: content.loaded,
        waitedMs: content.waitedMs,
        history: content.history,
        head: content.text.slice(0, 400),
        watch: watch.dump(),
      });

      expect(content.loaded, emptinessMessage(route, content, MIN_CONTENT_CHARS)).toBe(true);
      expect(watch.pageErrors, `${route}: uncaught exception during a cold load`).toEqual([]);
      expect(watch.hydrationErrors(), `${route}: hydration mismatch on a cold load`).toEqual([]);
    });

    test(`refresh of ${route} renders the same content`, async ({ page }) => {
      await page.goto(route, { waitUntil: "load", timeout: 90_000 });
      const first = await readContent(page, { minLength: MIN_CONTENT_CHARS, timeoutMs: 60_000 });
      expect(
        first.loaded,
        emptinessMessage(`${route} (first load)`, first, MIN_CONTENT_CHARS)
      ).toBe(true);

      // F5: the router must rebuild the tree from what the host serves, not
      // from anything the first load happened to leave in memory.
      const watch = new PageWatch(page);
      const response = await page.reload({ waitUntil: "load", timeout: 90_000 });
      expect(response, `${route}: refresh answered nothing`).not.toBeNull();
      expect(response!.status(), `${route}: refresh did not serve a document`).toBe(200);

      const afterRefresh = await readContent(page, {
        minLength: MIN_CONTENT_CHARS,
        timeoutMs: 60_000,
      });
      writeEvidence(`02-refresh-${route.replace(/\//g, "_")}.json`, {
        before: first.length,
        after: afterRefresh.length,
        loaded: afterRefresh.loaded,
        history: afterRefresh.history,
        head: afterRefresh.text.slice(0, 400),
        watch: watch.dump(),
      });

      expect(
        afterRefresh.loaded,
        emptinessMessage(`${route} (after refresh)`, afterRefresh, MIN_CONTENT_CHARS)
      ).toBe(true);
      expect(
        afterRefresh.length,
        `${route}: the content region was populated on the first load (${first.length} chars) ` +
          "and empty after a refresh — the page only renders once in its lifetime"
      ).toBeGreaterThanOrEqual(MIN_CONTENT_CHARS);
      expect(watch.pageErrors, `${route}: uncaught exception after a refresh`).toEqual([]);
    });
  }

  test("the dashboard entry itself renders on a cold load", async ({ page }) => {
    const watch = new PageWatch(page);
    const response = await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    expect(response!.status(), "/dashboard did not serve the SPA entry document").toBe(200);

    const content = await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    writeEvidence("02-entry.json", {
      length: content.length,
      loaded: content.loaded,
      history: content.history,
      watch: watch.dump(),
    });
    expect(content.loaded, emptinessMessage("/dashboard", content, 400)).toBe(true);
  });
});
