import { expect, test } from "@playwright/test";

import {
  BASE_URL,
  PageWatch,
  authenticate,
  readContent,
  readNativeCatalog,
  readNativeHealth,
  writeEvidence,
} from "./harness";

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

/**
 * What a `.txt` RSC payload must be served as on this deployment.
 *
 * There is no Next.js server behind the dashboard here: the Rust static
 * handler's mime table answers, and `.txt` is `text/plain`. The client
 * validates the content type before it will treat a response as flight data,
 * so this is the value whose loss breaks a client-side navigation.
 */
const RSC_CONTENT_TYPE = "text/plain";

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
    const mislabelled = payloads
      .filter((r) => !r.contentType.startsWith(RSC_CONTENT_TYPE))
      .map((r) => `${r.url.replace(BASE_URL, "")} → "${r.contentType || "(no content-type)"}"`);
    writeEvidence("05-rsc-payloads.json", {
      payloads: payloads.map(
        (r) => `${r.status} ${r.contentType || "(none)"} ${r.url.replace(BASE_URL, "")}`
      ),
    });

    expect(
      payloads.length,
      "CONTROL: the client never fetched an RSC payload, so the content type the router " +
        "validates against was never exercised"
    ).toBeGreaterThan(0);
    expect(
      payloads
        .filter((r) => r.status >= 400)
        .map((r) => `${r.status} ${r.url.replace(BASE_URL, "")}`),
      "an RSC payload the router depends on did not load"
    ).toEqual([]);
    // The content type itself, which a status code cannot see. This host has no
    // Next.js server behind the dashboard: the Rust static handler's mime table
    // decides what a `.txt` RSC payload is served as, and the router is handed
    // whatever that says. This test used to be named for the content type while
    // only asserting 2xx, so a host that answered `text/html` — or an HTML error
    // page, which is 200 — passed it while the router was being fed a document
    // instead of a flight payload.
    expect(
      mislabelled,
      `${mislabelled.length} RSC payload(s) were not served as ${RSC_CONTENT_TYPE}. The router ` +
        "parses these as flight data; served as anything else they are not payload, and the " +
        "navigation that asked for them renders from whatever the response happened to be."
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

    // ── Which artifact is this run grading? ─────────────────────────────────
    //
    // Three consecutive recorded runs reported 14, 16 and 16 `404
    // /providers/*.svg` here, and every one of them was filed as a product
    // bug. They were not: the GATEWAY BINARY predated the source. `/providers/*`
    // and `/sw.js` are mounted at the admin origin by
    // `resources_handler.rs::ORIGIN_ROOT_ROUTES` (`:538`) and `lib.rs:240` in
    // the tree under review, and the running binary answers 404 for both. A
    // stale build therefore reports as a defect in the artifact it is not
    // grading, and the run says nothing that lets anyone tell the two apart.
    //
    // So the two origin-root mounts are probed DIRECTLY, from the suite rather
    // than through the page, and recorded whether the test passes or fails.
    // A 404 here with the source present in the tree is a build-provenance
    // finding, not a defect in the artifact under review.
    const provenance = await Promise.all(
      ["/sw.js", "/providers/openai.svg"].map(async (path) => {
        try {
          const res = await fetch(`${BASE_URL}${path}`);
          return `${res.status} ${path}`;
        } catch (error) {
          return `ERR ${path} ${String(error)}`;
        }
      })
    );

    writeEvidence("05-root-files.json", {
      failures: rootFileFailures,
      allSameOriginFailures: watch.non2xx().map((r) => `${r.status} ${new URL(r.url).pathname}`),
      buildProvenance: provenance,
    });

    expect(
      rootFileFailures,
      "the document asked the host for files the export ships and the host does not serve: " +
        `${rootFileFailures.length} failed. An operator sees a page whose service worker never ` +
        "registers and whose vendor logos never appear, with nothing on screen to say why. " +
        `Build provenance, probed directly: ${provenance.join(", ")} — a 404 on /sw.js and on a ` +
        "/providers/*.svg means the RUNNING BINARY predates `ORIGIN_ROOT_ROUTES` " +
        "(resources_handler.rs:538) and is not the build under review. Rebuild and redeploy " +
        "before reading this as a defect in the artifact."
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

/**
 * ── the `/api` surface, classified ─────────────────────────────────────────
 *
 * The test above asserts the SHAPE of the claim ("no unanswered read on
 * /dashboard"). These assert the CAUSE, because "the 404s stopped" and "the 404s
 * stopped for the right reason" are different things and only the second is a
 * fix. A page that merely stopped asking would pass the first test while leaving
 * every capability it used to have silently missing.
 *
 * So each read is pinned to one of exactly two endings, and the assertions are
 * made against the real gateway rather than against a list written here:
 *
 *   REPOINTED  the browser asks a `/admin/v1/*` or `/livez` URL, it answers 2xx,
 *              and the payload is the data the core really holds — compared over
 *              HTTP, not against a hard-coded count.
 *   DECLARED   the browser never asks at all, and the page states the refusal.
 *              Absence of the request is the assertion; a fabricated empty list
 *              would fail it.
 */
const PROVIDER_DETAIL = "/dashboard/providers/openai";

/** The gateway's metrics plane, as `start-aisix-spa-gateway.mjs` maps it. */
const METRICS_PORT = Number(process.env.AISIX_SPA_METRICS_PORT || 3003);

/** Legacy paths the shell used to ask for and must now never ask for. */
const RETIRED_SHELL_READS = [
  "/api/auth/csrf",
  "/api/settings",
  "/api/sync/cloud",
  "/api/token-health",
  "/api/health/ping",
  "/api/health/degradation",
];

/** Legacy paths with no gateway counterpart: never asked, always refused. */
const RETIRED_EXTERNAL_READS = [
  "/api/models/alias",
  "/api/keys",
  "/api/settings/proxy",
  "/api/storage/health",
  "/api/settings/database",
  "/api/settings/compression",
];

function requestedApiPaths(watch: PageWatch): string[] {
  return watch.requests
    .map((r) => new URL(r.url).pathname)
    .filter((pathname) => pathname.startsWith("/api/"));
}

test.describe("the /api surface is classified, not just silenced", () => {
  test("the shell asks no retired /api path", async ({ page, context }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    await page.waitForTimeout(4000);

    const asked = requestedApiPaths(watch);
    const retired = RETIRED_SHELL_READS.filter((path) =>
      asked.some((askedPath) => askedPath === path || askedPath.startsWith(`${path}/`))
    );
    writeEvidence("05-shell-api-surface.json", {
      asked: [...new Set(asked)],
      retired,
      allSameOriginFailures: watch.non2xx().map((r) => `${r.status} ${new URL(r.url).pathname}`),
    });

    expect(
      retired,
      `the shell still asks ${retired.length} legacy /api path(s) this gateway cannot answer: ` +
        `${retired.join(", ")}. Each one is a guaranteed 404 that re-enters its own effect, so the ` +
        "cost is a request storm and not merely a missing number."
    ).toEqual([]);

    // Non-vacuity, stated about the LOG rather than about /api traffic: after the
    // fix the shell is expected to ask NO /api path at all, so "asked.length > 0"
    // would assert the bug back in. What must hold is that the page issued
    // requests and that they were observed — and that a native read it SHOULD
    // make was among them, which is the positive counterpart of the assertion
    // above (see the /livez test for the per-endpoint version).
    expect(
      watch.requests.length,
      "the page issued no requests at all, so the network log is not capturing and the " +
        "assertion above would pass without proving anything"
    ).toBeGreaterThan(0);
    expect(
      watch.responses.filter((r) => r.url.startsWith(BASE_URL)).length,
      "no same-origin response was recorded, so the network log is not capturing responses"
    ).toBeGreaterThan(0);
  });

  test("the repointed liveness read hits the core's own /livez and gets a real answer", async ({
    page,
    context,
  }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    // The strongest form of "repointed": not "a 404 disappeared" but "a request
    // the core actually routes went out and returned what the core holds". The
    // comparison is a live HTTP read of the same endpoint, so an artifact whose
    // browser never reached it cannot pass by coincidence.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    await page.waitForTimeout(4000);

    const native = await readNativeHealth();
    const livez = watch.responses.filter((r) => new URL(r.url).pathname === "/livez");
    writeEvidence("05-livez-repoint.json", {
      gateway: native,
      browserLivez: livez.map((r) => `${r.status} ${new URL(r.url).pathname}`),
    });

    expect(
      native.livezStatus,
      "the gateway's own /livez did not answer, so there is nothing to compare the browser " +
        "against and this test could not distinguish a real repoint from a coincidence"
    ).toBe(200);

    expect(
      livez.length,
      "the browser never asked the core's /livez. The maintenance banner's health check is " +
        "repointed there; if it is not being asked, the banner is still reading a legacy route " +
        "and will report a healthy gateway as down."
    ).toBeGreaterThan(0);
    expect(
      livez.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`),
      "the browser's /livez read was refused even though a direct read of the same endpoint answers"
    ).toEqual([]);
  });

  test("the repointed health read hits the core's own status surface, unauthenticated", async ({
    page,
  }) => {
    // Deliberately run WITHOUT an admin key. The degradation badge is a header
    // control that renders on every page, so it must be answerable by a visitor
    // who has not signed in — and the badge sits on the metrics plane rather than
    // the admin plane precisely because an admin-plane 401 flips the dashboard's
    // global signed-out state (see `useAisixSignedOut`). So this test guards two
    // things at once: that the read is repointed, and that it is not the reason an
    // anonymous visitor got signed out.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    await page.waitForTimeout(4000);

    const native = await readNativeHealth(METRICS_PORT);
    const statusReads = watch.responses.filter((r) => new URL(r.url).pathname === "/status/models");
    const degradationReads = watch.responses.filter(
      (r) => new URL(r.url).pathname === "/api/health/degradation"
    );
    const adminPlaneReads = watch.responses.filter((r) => r.url.includes("/admin/v1/"));
    const signedOutBanner = await page
      .locator("body")
      .innerText()
      .then((text) => /session ended|sign in to the gateway/i.test(text))
      .catch(() => false);
    writeEvidence("05-health-repoint.json", {
      gateway: native,
      browserStatusModels: statusReads.map(
        (r) => `${r.status} :${new URL(r.url).port}${new URL(r.url).pathname}`
      ),
      legacyDegradationReads: degradationReads.length,
      adminPlaneReads: adminPlaneReads.map((r) => `${r.status} ${new URL(r.url).pathname}`),
      signedOutBanner,
    });

    expect(
      native.statusModelsReachable,
      "the gateway's /status/models did not answer, so the repointed read cannot be verified " +
        "against the server truth"
    ).toBe(true);

    // A 0-model snapshot would make the comparison below vacuous.
    expect(
      native.modelCount,
      "the core reported no models in /status/models, so this gateway cannot distinguish a " +
        "repointed read from an empty one"
    ).toBeGreaterThan(0);
    // A status token nobody classified is a vocabulary gap: the gateway is
    // reporting a runtime state the dashboard has never been told how to read,
    // so the operator is not being told about it either. This is an allow-list
    // precisely so that gap is loud instead of being counted as degradation —
    // which is how this oracle came to agree with the bug it was written to
    // catch (`not_applicable`, i.e. every virtual router, counted as a fault).
    expect(
      native.unrecognisedStatusTokens,
      `the core emitted status token(s) ${JSON.stringify(native.unrecognisedStatusTokens)}, which ` +
        `this harness does not know. The token histogram was ${JSON.stringify(native.statusTokens)}. ` +
        "Either the gateway's RuntimeStatus vocabulary has grown and the dashboard's " +
        "classification of it has not been updated, or the payload carries a field this oracle " +
        "misreads. Both are findings, neither may be counted as degradation."
    ).toEqual([]);

    expect(
      statusReads.length,
      "the browser never asked the core's /status/models. The degradation badge is repointed " +
        "there; without it the badge is reading a route that does not exist here and reporting " +
        '"not degraded" from a 404.'
    ).toBeGreaterThan(0);
    expect(
      degradationReads.length,
      "the browser still asked the legacy /api/health/degradation route"
    ).toEqual(0);

    expect(
      signedOutBanner,
      "loading the shell with NO admin key produced a signed-out state. Some shell read went " +
        "to the authenticated admin plane, and a 401 there signs the whole dashboard out — which " +
        "is how the provider index stopped rendering its cards for a signed-out visitor."
    ).toBe(false);
  });

  test("the provider detail page asks none of the three unsupported per-provider reads", async ({
    page,
    context,
  }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    // These are the reads that turned into the retry storm: three sections, one
    // SQLite row each, three guaranteed 404s, and a 404 that re-entered its own
    // effect. The gateway has no resource type for any of them, so the correct
    // ending is that the browser never asks.
    const watch = new PageWatch(page);
    await page.goto(PROVIDER_DETAIL, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(5000);

    const forbidden = ["/param-filters", "/interception-rules", "/cc-alias"].filter((suffix) =>
      watch.requests.some((r) => r.url.includes(suffix))
    );

    writeEvidence("05-provider-extras.json", {
      forbidden,
      allSameOriginFailures: watch.non2xx().map((r) => `${r.status} ${new URL(r.url).pathname}`),
    });

    expect(
      forbidden,
      `the provider detail page still asked ${forbidden.length} per-provider read(s) this ` +
        `gateway cannot answer: ${forbidden.join(", ")}. Each is a 404 that re-enters its own ` +
        "effect, so the page hammers the host instead of rendering."
    ).toEqual([]);
  });

  test("the unsupported per-provider capability is stated on the page, not left blank", async ({
    page,
    context,
  }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    // The other half of "stop asking": an operator looking at the provider page
    // must be able to tell the difference between "this gateway has no filters
    // configured" and "this gateway cannot hold filters". A skeleton that
    // resolves to an empty form claims the first, which is a different claim.
    await page.goto(PROVIDER_DETAIL, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    const refusal = page.locator('[data-testid="provider-extras-unsupported"]');
    await expect(
      refusal,
      "the three per-provider cards were replaced by nothing at all. The operator cannot tell " +
        "an absent capability from an absent configuration, and the page shows a blank region " +
        "where its settings used to be."
    ).toBeVisible({ timeout: 60_000 });

    const reason = page.locator('[data-testid="provider-extras-reason"]');
    await expect(reason, "the refusal card carries no reason").toBeVisible();
    const reasonText = (await reason.innerText()).trim();
    writeEvidence("05-provider-extras-reason.json", { reasonText });

    expect(
      reasonText.length,
      "the refusal is empty. A refusal with no text is a blank region wearing a refusal's " +
        "borders — the operator still learns nothing."
    ).toBeGreaterThan(20);
  });

  test("the model catalog is repointed at the core and shows the core's real rows", async ({
    page,
    context,
  }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    // Proves the repoint delivers DATA, not just a 2xx. The count comes from a
    // live read of /admin/v1/models, so this fails for an empty gateway AND for
    // an artifact whose adapter renders an empty table over a full catalog —
    // the exact failure a URL-only repoint would ship.
    const native = await readNativeCatalog();
    const watch = new PageWatch(page);
    await page.goto("/dashboard/models", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await page.waitForTimeout(3000);

    const catalogReads = watch.responses.filter(
      (r) => new URL(r.url).pathname === "/admin/v1/models"
    );
    const legacyReads = watch.responses.filter(
      (r) => new URL(r.url).pathname === "/api/models/catalog"
    );
    const bodyText = (await page.locator("body").innerText()).slice(0, 20000);
    writeEvidence("05-models-repoint.json", {
      gateway: native,
      browserCatalogReads: catalogReads.map((r) => `${r.status} ${new URL(r.url).pathname}`),
      legacyCatalogReads: legacyReads.length,
    });

    expect(
      native.reachable && native.modelCount > 0,
      "the gateway's /admin/v1/models is empty or unreachable, so this test cannot tell a " +
        "working repoint from an empty page and must not be trusted here"
    ).toBe(true);

    expect(
      catalogReads.length,
      "the browser never asked /admin/v1/models. The model-catalog page is repointed at the " +
        "core's catalog; if it is not being asked, the page is reading a route that does not " +
        "exist here and rendering its failure state."
    ).toBeGreaterThan(0);
    expect(
      legacyReads.length,
      "the browser still asked the legacy /api/models/catalog route"
    ).toEqual(0);

    // A REAL row: the core's own model id must be visible on the page. This is
    // the assertion a shape-mismatch bug cannot survive — the native payload is
    // `{id, value:{model_name, display_name, …}}` and a reader that does not
    // unwrap `value` produces an empty table even though the request succeeded.
    expect(
      bodyText.includes(native.sampleModelId as string) ||
        bodyText.includes(native.sampleDisplayName as string),
      `the core's own catalog rows are not on the page. The gateway holds ${native.modelCount} ` +
        `models across ${native.providers.length} providers, including "${native.sampleModelId}" ` +
        `(label "${native.sampleDisplayName}"), and the page shows none of them. The read is ` +
        "repointed but its payload is not being understood."
    ).toBe(true);
  });

  test("the settings route asks none of the unsupported reads it used to", async ({
    page,
    context,
  }) => {
    // The native reads are on the authenticated admin plane, so the test supplies the
    // gateway credential the way an ingress in front of the admin port does — the same
    // contract `authenticate` is used for in 07. Without it every repointed read is a 401
    // and these assertions would be measuring the credential, not the repoint.
    await authenticate(context);
    const watch = new PageWatch(page);
    await page.goto("/dashboard/settings", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 200, timeoutMs: 90_000 });
    await page.waitForTimeout(3000);

    const asked = requestedApiPaths(watch);
    const stillAsked = RETIRED_EXTERNAL_READS.filter((path) => asked.includes(path));
    writeEvidence("05-other-api-surface.json", { asked: [...new Set(asked)], stillAsked });

    expect(
      stillAsked,
      `the settings route still asked ${stillAsked.length} legacy read(s) this gateway cannot ` +
        `answer: ${stillAsked.join(", ")}`
    ).toEqual([]);

    // NOTE: the storage surface used to be checked from here, behind
    // `if ((await storage.count()) > 0)`. It is not on this route —
    // `SystemStorageTab` is mounted by `/dashboard/settings/general` — so the
    // branch could never be taken and the only check on the regression was a
    // check that did not run. It is a test of its own now, on the route that
    // owns the component.
  });

  test("the storage tab states its absence instead of inventing a database", async ({ page }) => {
    // `SystemStorageTab` used to render a confident "sqlite - ~/.omniroute/
    // storage.sqlite - 0 bytes" on a gateway that has no database at all. Two
    // claims, both observable, and either alone is satisfied by a broken build:
    //
    //   (a) the operator is told the surface is absent, in words;
    //   (b) and nothing was asked for it — on the static export the refusal is
    //       decided BEFORE any request (`resolveAisixSurfaceSupport`), so the
    //       zero-request half is what proves the refusal is the architecture's
    //       answer and not a 404 the card dressed up.
    //
    // (b) alone would pass on a page that renders nothing; (a) alone would pass
    // on a card that asked, got a 404, and apologised. The pair is the claim.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/settings/general", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    const storage = page.getByTestId("system-storage-unsupported");
    await expect(
      storage,
      "the storage tab rendered no refusal. The export ships no database at all, so the honest " +
        "state is 'this build has no storage surface', not a path and a byte count invented by " +
        "the card."
    ).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    const text = (await storage.innerText()).trim();
    const storageReads = watch
      .non2xx()
      .map((r) => new URL(r.url).pathname)
      .filter((path) => path.startsWith("/api/storage") || path.startsWith("/api/db-backups"));
    writeEvidence("05-system-storage.json", {
      refusalText: text,
      storageReads,
      totalRequests: watch.requests.length,
    });

    expect(
      text.length,
      "the storage refusal is empty - the operator is shown a refusal with nothing in it"
    ).toBeGreaterThan(20);
    expect(
      storageReads,
      `the tab was told the surface is absent and asked for it anyway (${storageReads.join(", ")}). ` +
        "The refusal has to be decided before the request; a 404 dressed up as an answer is what " +
        "this used to be."
    ).toEqual([]);
  });
});
