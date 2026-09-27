import { expect, test } from "@playwright/test";

import { BASE_URL, PageWatch, readContent, writeEvidence } from "./harness";

/**
 * 08 — REQUEST BUDGET and FAULT TOLERANCE.
 *
 * The dashboard is allowed to fetch, and it is allowed to fail. What it is not
 * allowed to do is turn a failed fetch into an unbounded loop: a page that
 * re-issues the same GET tens of times a second, forever, starves its own
 * renderer until the tab stops responding and then dies. That is not a slow
 * network and not a missing file — it is the client re-entering its own effect
 * on every failure, and it is invisible to every check that only asks "did the
 * page render".
 *
 * Two claims, both measured from recorded timestamps rather than asserted from
 * a story:
 *
 *   (a) REQUEST BUDGET — no single URL is fetched more than a handful of times
 *       inside a five-second window. A settings or filter read is not a poll.
 *   (b) FAULT TOLERANCE — a failed fetch produces a handled error state, not an
 *       uncaught exception. A rejected promise that reaches `window.onerror` is
 *       an app fault whatever the HTTP layer did.
 *
 * (a) is a budget, not a measurement of the product, so it is stated loosely on
 * purpose: the point is the order of magnitude, and any reasonable ceiling a
 * reviewer picks still separates "a page fetching data" from "a page spinning".
 */

const WINDOW_MS = 5000;
/**
 * Generous. A dashboard route that legitimately refreshes on focus or on a
 * poll would not come close to this, and the observed behaviour is ~40 repeats
 * of the same URL inside a single window.
 */
const MAX_REPEATS_PER_URL_PER_WINDOW = 5;

test.describe("request budget and fault tolerance", () => {
  test("a provider detail route does not spin on its own failed reads", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(5000);

    const peak = watch.peakRepeats(WINDOW_MS);
    const histogram = [...watch.requestHistogram()].sort((a, b) => b[1] - a[1]);
    writeEvidence("08-request-budget.json", {
      peak,
      windowMs: WINDOW_MS,
      histogram: histogram.map(([url, count]) => `${count}x ${url}`),
      totalRequests: watch.requests.length,
    });

    expect(
      peak.count,
      `${peak.key} was requested ${peak.count} times inside a ${WINDOW_MS / 1000}s window. A ` +
        "failed read is being retried without a ceiling, which starves the page's own renderer " +
        "until the tab stops responding. A dashboard route may fetch; it may not hammer."
    ).toBeLessThanOrEqual(MAX_REPEATS_PER_URL_PER_WINDOW);
  });

  test("a failed read surfaces as a handled state, never as an uncaught exception", async ({
    page,
  }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(5000);

    writeEvidence("08-fault-tolerance.json", {
      pageErrors: watch.pageErrors,
      fatalConsole: watch.fatalErrors(),
      non2xx: watch.non2xx().map((r) => `${r.status} ${r.url}`),
    });

    expect(
      watch.pageErrors,
      "reads that fail produced uncaught exceptions. An unhandled rejection is an app fault " +
        "whatever the server answered: the operator gets a console full of stack traces and a " +
        "surface with no error state."
    ).toEqual([]);
  });

  test("every image the dashboard serves itself actually loads", async ({ page }) => {
    // The vendor catalog is drawn with `<img src="/providers/<vendor>.svg">` —
    // files the export ships at the ORIGIN ROOT, because `assetPrefix` is empty
    // in the export. A host that serves the dashboard mount but not the root
    // files hands the operator a grid of empty logo frames, and nothing on the
    // page says why: a broken image is not an error state, it is just a gap in
    // the layout. `naturalWidth === 0` after the load event is the observable.
    //
    // Same-origin images only. The catalog also points some entries at a
    // third-party SVG host, and whether THAT is reachable is a property of the
    // deployment's egress, not of the app — so those are recorded and left out
    // of the verdict, rather than being allowed to decide the result.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/media-providers/image", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    // Let the image requests finish before judging them.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2000);

    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll("img")].map((img) => ({
        src: img.getAttribute("src") ?? "",
        broken: img.complete && img.naturalWidth === 0,
      }))
    );
    const sameOrigin = rendered.filter(
      (img) => !/^https?:\/\//.test(img.src) || img.src.startsWith(BASE_URL)
    );
    const brokenSameOrigin = sameOrigin.filter((img) => img.broken).map((img) => img.src);
    const brokenThirdParty = rendered
      .filter((img) => img.broken && !sameOrigin.includes(img))
      .map((img) => img.src);

    writeEvidence("08-images.json", {
      totalRendered: rendered.length,
      sameOriginRendered: sameOrigin.length,
      brokenSameOrigin,
      brokenThirdParty,
      failedImageRequests: watch
        .non2xx()
        .filter((r) => r.resourceType === "image")
        .map((r) => `${r.status} ${r.url}`),
    });

    expect(
      sameOrigin.length,
      "the page rendered no same-origin images at all, so this assertion would pass without " +
        "proving that the ones it does render load"
    ).toBeGreaterThan(0);
    expect(
      brokenSameOrigin,
      `${brokenSameOrigin.length} of ${sameOrigin.length} images the dashboard served from its own ` +
        "host failed to load. The operator sees a grid of empty frames with no indication of why."
    ).toEqual([]);
  });
});
