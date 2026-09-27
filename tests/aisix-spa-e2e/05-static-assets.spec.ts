import { expect, test } from "@playwright/test";

import { BASE_URL, PageWatch, readContent, writeEvidence } from "./harness";

/**
 * 05 — the asset tree.
 *
 * This is the check that would have caught a missing `/_next/static` route, and
 * the one the previous report could not close: it sampled 50 chunk URLs out of
 * the served document, all of which answered 200, and concluded "a missing-file
 * cause is excluded". That conclusion was too strong. What it sampled was the
 * document's own references; what actually decides whether the app boots is
 * every subresource the browser asks for while the page runs — including the
 * ones the router requests later, and the RSC payloads, whose content type the
 * client validates before it will treat them as flight data.
 *
 * So the assertion is on the recorded network log of a real page load, over
 * `/_next/` (chunks, CSS, fonts, icons) and over the `.txt` RSC payloads, and
 * it includes the request a refresh makes. Every one of them has to answer 2xx.
 */

const STATIC_TREE = "/_next/";

/** RSC payloads and the prerendered segment tree, which the client validates by content type. */
const RSC_PATTERN = /\.(?:txt)$/;

test.describe("static assets", () => {
  test("every _next/static request the dashboard makes returns 2xx", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    // Give lazy chunks a chance to be requested: the i18n catalogues, the
    // route chunks the router prefetches.
    await page.waitForTimeout(4000);

    const statics = watch.under(STATIC_TREE);
    writeEvidence("05-static-dashboard.json", {
      requested: statics.map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
      non2xx: watch.non2xx().map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
    });

    // Guard against a vacuous pass: a page that requested nothing would make
    // every element assertion below trivially true.
    expect(
      statics.length,
      "the page requested nothing under /_next/ — the network log is not capturing, so the " +
        "2xx assertions below would pass without proving anything"
    ).toBeGreaterThanOrEqual(5);

    const broken = statics.filter((r) => r.status >= 400);
    expect(
      broken.map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
      "the app could not load its own asset tree; this is the failure that leaves the operator " +
        "with a document that never boots"
    ).toEqual([]);
  });

  test("every RSC payload the router fetches is served as a flight response", async ({ page }) => {
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });

    // An in-app navigation is what makes the client fetch an RSC payload at
    // all; a cold load only reads the embedded one.
    const link = page.locator("a[href='/dashboard/combos']").first();
    await expect(link, "no nav entry to /dashboard/combos").toBeVisible({ timeout: 45_000 });
    await link.click({ timeout: 30_000 });
    await readContent(page, { minLength: 120, timeoutMs: 75_000 });

    const payloads = watch.responses.filter(
      (r) => r.url.startsWith(BASE_URL) && RSC_PATTERN.test(new URL(r.url).pathname)
    );
    writeEvidence("05-rsc-payloads.json", {
      payloads: payloads.map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
    });

    expect(
      payloads.length,
      "the client never fetched an RSC payload, so the content type the router validates " +
        "against was never exercised"
    ).toBeGreaterThan(0);
    expect(
      payloads
        .filter((r) => r.status >= 400)
        .map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
      "an RSC payload the router depends on did not load"
    ).toEqual([]);
  });

  test("a refresh re-requests the asset tree and every request still answers 2xx", async ({
    page,
  }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });

    const watch = new PageWatch(page);
    await page.reload({ waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 75_000 });

    const statics = watch.under(STATIC_TREE);
    writeEvidence("05-static-refresh.json", {
      requested: statics.map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
    });

    expect(
      statics.length,
      "a refresh requested nothing under /_next/ — the reload served the page from cache with " +
        "no subresource fetches, so this run proves nothing about the asset tree"
    ).toBeGreaterThanOrEqual(5);
    expect(
      statics
        .filter((r) => r.status >= 400)
        .map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
      "the asset tree broke on a reload"
    ).toEqual([]);
  });

  test("every file the export ships at the origin root loads", async ({ page }) => {
    // The export writes its chunks, its fonts, its service worker and its
    // ~190 vendor logos at the ORIGIN ROOT (`assetPrefix` and `basePath` are
    // both empty), so a document served from `/dashboard` asks for
    // `/_next/...`, `/sw.js` and `/providers/<vendor>.svg` on the same origin.
    // A host that mounts the dashboard but not those files hands the operator a
    // page with a failed service-worker registration and a grid of empty logo
    // frames — and no error anywhere, because a broken image is not a state.
    //
    // The three prefixes are excluded on purpose, because each is a separate
    // claim with a separate owner: `/_next/` is covered above, `/api/` is the
    // next test, and `.txt` RSC payloads are the one before it.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/media-providers/image", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2500);

    const rootFileFailures = watch
      .non2xx()
      .filter((r) => {
        const path = new URL(r.url).pathname;
        return !path.startsWith("/_next/") && !path.startsWith("/api/") && !path.endsWith(".txt");
      })
      .map((r) => `${r.status} ${new URL(r.url).pathname}`);

    writeEvidence("05-root-files.json", {
      failures: rootFileFailures,
      allSameOriginFailures: watch.non2xx().map((r) => `${r.status} ${new URL(r.url).pathname}`),
    });

    expect(
      rootFileFailures,
      "the document asked the host for files the export ships and the host does not serve: " +
        `${rootFileFailures.length} failed. An operator sees a page whose service worker never ` +
        "registers and whose vendor logos never appear, with nothing on screen to say why."
    ).toEqual([]);
  });

  test("the SPA's own data layer has no unanswered read", async ({ page }) => {
    // The dashboard's data layer calls `/api/*` for settings, health, sync state
    // and per-provider reads. Those handlers live in the Next.js app, which the
    // export does not include — so on this host every one of them is a 404 and
    // the page is running on nothing. This is not a cosmetic warning: the
    // provider detail route turns those 404s into a retry storm (see 08).
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    await page.waitForTimeout(3000);

    const apiFailures = watch
      .non2xx()
      .filter((r) => new URL(r.url).pathname.startsWith("/api/"))
      .map((r) => `${r.status} ${new URL(r.url).pathname}`);

    writeEvidence("05-api-surface.json", { failures: apiFailures });

    expect(
      apiFailures,
      `the dashboard made ${apiFailures.length} reads this host cannot answer: ` +
        `${apiFailures.slice(0, 6).join(", ")}${apiFailures.length > 6 ? " …" : ""}. The export ` +
        "ships no API at all, so this page is running on its prerendered HTML plus whatever the " +
        "native admin plane exposes."
    ).toEqual([]);
  });

  test("the dashboard's service worker registers", async ({ page }) => {
    // Observed from the page rather than from the network log, on purpose.
    // Playwright's page network events do not carry the SERVICE-WORKER script
    // fetch — it is made by the browser's SW machinery, not the frame's loader —
    // so a `sw.js` that answers 404 is invisible to every other assertion in
    // this file. The registration state and the browser's own console line are
    // both visible from inside the page, so those are what this asserts.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    // Registration completes on its own schedule; give it one.
    await page.waitForTimeout(5000);

    const registrations = await page.evaluate(async () => {
      const all = await navigator.serviceWorker.getRegistrations();
      return all.map((registration) => ({
        scope: registration.scope,
        state: registration.active?.state ?? registration.installing?.state ?? null,
        script: registration.active?.scriptURL ?? registration.installing?.scriptURL ?? null,
      }));
    });
    const scriptFailure = watch.consoleErrors.filter((line) =>
      /bad http response code/i.test(line)
    );
    writeEvidence("05-service-worker.json", { registrations, scriptFailure });

    expect(
      registrations.length,
      "the dashboard registered no service worker. The export ships `sw.js`, and the browser " +
        "reports the failed script fetch as 'A bad HTTP response code (404) was received when " +
        "fetching the script' — so the operator loses the offline shell and gets a console error " +
        "on every load, with nothing on the page to explain it"
    ).toBeGreaterThan(0);
    expect(
      scriptFailure,
      "the browser reported a script fetch that answered 404 while the dashboard booted"
    ).toEqual([]);
  });
});
