import { expect, test } from "@playwright/test";

import {
  BASE_URL,
  MAX_REPEATS_PER_URL_PER_WINDOW,
  PageWatch,
  REQUEST_BUDGET_WINDOW_MS,
  isOverRequestBudget,
  readContent,
  writeEvidence,
} from "./harness";

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

/**
 * The window, the ceiling and the verdict live in `harness.ts`, because the C8
 * negative control has to judge an INJECTED storm against the same numbers this
 * file judges the real page against. A control quoting its own copy of the
 * ceiling proves only that its own copy is what it is — the defect that made C8
 * a control in name only.
 */
const WINDOW_MS = REQUEST_BUDGET_WINDOW_MS;

/**
 * A `/api/*` read on the static export is answered 404 by the HOST, not by the
 * app: the export ships no `src/app/api/**` at all (`getTransientBuildPaths`
 * excludes it), so there is no server that could ever satisfy it. These are
 * permanent by architecture, and a client that settles on the FIRST answer is
 * behaving correctly — the budget above is the ceiling, this is the floor.
 *
 * The count is per-URL rather than a page total on purpose: the page is allowed
 * to read many things once each. What it may not do is read one thing again.
 */
const MAX_REPEATS_PER_API_URL = 1;

/** The three provider-rule rows on `/dashboard/providers/{id}`. */
const PROVIDER_RULE_PATHS = ["param-filters", "interception-rules", "cc-alias"];

/**
 * The refusal affordance of each provider-rule card, by the testid it renders.
 *
 * Named rather than swept by `[role="status"]`, because a role sweep cannot
 * say WHICH card answered and would be satisfied by any status on the page.
 */
const REFUSAL_BANNERS = [
  "param-filters-unavailable-banner",
  "interception-rules-unavailable-banner",
  "cc-alias-unavailable-banner",
] as const;

test.describe("request budget and fault tolerance", () => {
  test("a provider detail route does not spin on its own failed reads", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(5000);

    const peak = watch.peakRepeats(WINDOW_MS);
    const counts = watch.requestHistogram();
    writeEvidence("08-request-budget.json", {
      peak,
      windowMs: WINDOW_MS,
      histogram: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([url, count]) => `${count}x ${url}`),
      totalRequests: watch.requests.length,
    });
    // Non-vacuity. A budget is satisfied by a page that read nothing at all —
    // `peakRepeats()` on an empty recording returns `{key:"", count:0}`, and
    // 0 ≤ 5. So the reads this budget is about have to have been issued before
    // "at most 5 repeats of each" is a statement about anything. The next test
    // guards its own claim the same way.
    const providerRuleReads = PROVIDER_RULE_PATHS.map((suffix) => {
      const key = `GET /api/providers/openai/${suffix}`;
      return `${key} → ${counts.get(key) ?? 0}x`;
    });
    expect(
      providerRuleReads.some((line) => !line.endsWith(" → 0x")),
      "the page issued none of the three provider-rule reads, so a ceiling on how often one URL " +
        "may be read was never applied to anything. The histogram above describes a page that " +
        `did not try: ${providerRuleReads.join(", ")}`
    ).toBe(true);
    expect(
      isOverRequestBudget(peak),
      `${peak.key || "(nothing was requested at all)"} was requested ${peak.count} times inside a ` +
        `${WINDOW_MS / 1000}s window, over the ceiling of ` +
        `${MAX_REPEATS_PER_URL_PER_WINDOW}. A failed read is being retried without a ceiling, ` +
        "which starves the page's own renderer until the tab stops responding. A dashboard route " +
        "may fetch; it may not hammer."
    ).toBe(false);
  });

  test("a known-unsupported read is asked ONCE, not retried", async ({ page }) => {
    // The primary defect, stated as its own claim rather than as a rate.
    //
    // A 404 from `/api/*` on this deployment is not a transient failure: the
    // export contains no server-side routes, so the answer cannot change. The
    // measured behaviour before the fix was 47 repeats of each of these three
    // URLs inside a 5 s window — ~70 req/s aggregate, 1 933 requests by 27 s,
    // and a renderer so starved that `page.evaluate(() => 1)` took 15–45 s and
    // a full-page screenshot never completed inside 60 s.
    //
    // This assertion is deliberately not the same one as the rate budget above.
    // A budget can be satisfied by a page that retries a few times and a retry
    // can look like traffic. Counting one URL is the claim itself: permanent
    // absence is answered once.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(8000);

    const histogram = watch.requestHistogram();
    const offenders = [...histogram.entries()]
      .filter(([key, count]) => key.startsWith("GET /api/") && count > MAX_REPEATS_PER_API_URL)
      .sort((a, b) => b[1] - a[1]);
    const providerRuleReads = PROVIDER_RULE_PATHS.map((suffix) => {
      const key = `GET /api/providers/openai/${suffix}`;
      return `${key} → ${histogram.get(key) ?? 0}x`;
    });

    writeEvidence("08-unsupported-once.json", {
      providerRuleReads,
      totalRequests: watch.requests.length,
      offenders: offenders.map(([key, count]) => `${count}x ${key}`),
    });

    // Guard against a vacuous pass: the page must actually have issued reads,
    // otherwise "asked once" is indistinguishable from "asked never".
    expect(
      [...histogram.keys()].some((key) => key.startsWith("GET /api/")),
      "the page issued no /api/* reads at all, so this assertion would pass without proving " +
        "that a read which was issued was issued once"
    ).toBe(true);

    expect(
      offenders,
      `${offenders.length} /api/* URL(s) were requested more than ${MAX_REPEATS_PER_API_URL} ` +
        `time(s). On this deployment /api/* is absent by construction — the export ships no ` +
        `server-side routes — so a second request cannot have a different answer. The provider ` +
        `rule reads were: ${providerRuleReads.join(", ")}`
    ).toEqual([]);
  });

  test("an unsupported read renders a stated refusal, not a spinner or a blank card", async ({
    page,
  }) => {
    // A 404 must never reach the operator as an empty success or an eternal
    // skeleton: "this provider has no filters configured" and "there is no filter
    // store on this deployment" are different facts, and only one of them is true.
    //
    // Each card is waited for BY ITS OWN testid, and only then read. The
    // previous version swept `[role="status"]` the moment the content region
    // settled, which reads the DOM before the subject of the assertion exists:
    // the recorded run wrote `{"statuses": [], "spinnersLeft": 0}` — no banners
    // because the cards had not mounted yet, which reads exactly like a page
    // that renders no refusals at all. A sweep over a role also cannot say WHICH
    // card answered, and would pass on an unrelated status elsewhere on the page.
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    for (const testId of REFUSAL_BANNERS) {
      await expect(
        page.getByTestId(testId),
        `${testId} never rendered. A read the export cannot satisfy has to be stated as a ` +
          "refusal; a card that renders an empty form instead tells the operator this provider " +
          "has nothing configured, which is a different fact and a false one."
      ).toBeVisible({ timeout: 60_000 });
    }

    const refused = await Promise.all(
      REFUSAL_BANNERS.map(async (testId) => ({
        testId,
        text: (await page.getByTestId(testId).innerText()).trim(),
      }))
    );
    const spinnersLeft = await page.locator(".animate-pulse").count();
    writeEvidence("08-refusal-surfaces.json", { statuses: refused, spinnersLeft });

    for (const entry of refused) {
      expect(
        entry.text.length,
        `${entry.testId} rendered an empty refusal — the operator is told nothing`
      ).toBeGreaterThan(20);
    }
    // A skeleton is an infinite spinner in disguise: once every card has stated
    // its refusal, none of them may still be pulsing.
    expect(
      spinnersLeft,
      `${spinnersLeft} skeleton(s) still pulsing after every card stated its refusal`
    ).toBe(0);
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

  test("the provider detail page stays responsive and can actually be captured", async ({
    page,
  }) => {
    // The consequence, not the cause. The retry loop did not merely waste
    // requests: it starved the page's own renderer until a trivial evaluation
    // took 15–45 s and a full-page screenshot never completed inside 60 s (tried
    // twice, both timed out). So this asserts the renderer answers promptly AND
    // that a screenshot completes — the two things a hammering page cannot do.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(3000);

    const evaluateStarted = Date.now();
    await page.evaluate(() => 1 + 1);
    const evaluateMs = Date.now() - evaluateStarted;

    const shotStarted = Date.now();
    await page.screenshot({
      path: "aisix-spa-evidence/08-provider-detail.png",
      fullPage: true,
      timeout: 60_000,
    });
    const screenshotMs = Date.now() - shotStarted;

    const requestRate = watch.requests.length / Math.max(1, (Date.now() - watch.start) / 1000);

    // Recorded BEFORE the assertions below, deliberately. A red run is the run
    // that most needs the numbers: if the assertion fires first, the evidence
    // for why it fired is the thing that gets lost.
    writeEvidence("08-renderer-responsiveness.json", {
      evaluateMs,
      screenshotMs,
      totalRequests: watch.requests.length,
      requestsPerSecond: Number(requestRate.toFixed(2)),
    });

    expect(
      evaluateMs,
      `page.evaluate(() => 1+1) took ${evaluateMs} ms. A page that is hammering its own ` +
        "renderer cannot answer a trivial question; this is the starvation the retry loop caused."
    ).toBeLessThan(5_000);
    // The screenshot completing at all is the assertion — before the fix it
    // never returned inside 60 s. The budget keeps the failure legible.
    expect(
      screenshotMs,
      `a full-page screenshot took ${screenshotMs} ms. The page is too busy to be captured, which ` +
        "means an operator cannot screenshot or report what they are looking at."
    ).toBeLessThan(60_000);
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
