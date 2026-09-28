import { expect, test } from "@playwright/test";

import {
  ADMIN_KEY,
  MAX_REPEATS_PER_URL_PER_WINDOW,
  PageWatch,
  REQUEST_BUDGET_WINDOW_MS,
  authenticate,
  emptinessMessage,
  isOverRequestBudget,
  readContent,
  writeEvidence,
} from "./harness";

/**
 * THE FALSIFIABILITY AUDIT — the controls for every mechanism the other files
 * in this directory assert on.
 *
 * A check that cannot fail is worse than no check, and a check that cannot fail
 * *quietly* is worse still. So this file holds one control per mechanism the
 * rest of the suite measures with, and each control does the same two things:
 *
 *   1. INJECT. Manufacture the thing the production assertion exists to catch
 *      — a storm of identical GETs, a thrown exception, a document load that
 *      really is a document load, a route that really is absent, a capture that
 *      really is empty. Nothing here is a mock: the storm is 20 real `fetch`
 *      calls to the real gateway, the broken image is a real 404 for a file the
 *      export does not ship, the exception is a real uncaught throw.
 *
 *   2. REQUIRE THE VERDICT TO FLIP. The assertion the production file makes,
 *      applied to the injected capture, must come out the other way. The
 *      control states that positively — `expect(isOverRequestBudget(storm)).toBe(true)`
 *      — instead of stating the negation of a healthy world.
 *
 * ── Why they are GREEN ──────────────────────────────────────────────────────
 *
 * The previous version of this file asserted each control INVERTED, so every
 * test was RED whenever the product was healthy, and the whole file was
 * excluded from every normal run by `testIgnore` in the Playwright config. That
 * bought nothing: a red-by-convention control cannot be told apart from a
 * broken one by the runner, and a green run proved nothing about whether the
 * audit had run at all. It also produced the one defect this file exists to
 * prevent — C8 asserted that a request storm was GONE, which is a statement
 * about the product wearing a control's name, and it passed on exactly the run
 * where the storm had been fixed.
 *
 * So: every control here is green on a healthy deployment and red on a broken
 * one, which means it can — and does — run in EVERY pass. There is no opt-in
 * env var, no `testIgnore`, no `test.fail()`. A green run of this suite has
 * run this file, because this file is part of the suite.
 *
 * A control that needs a credential (C6) says so and fails with instructions
 * rather than skipping, exactly as `07-admin-surfaces.spec.ts` does.
 */

/** Identical same-origin GETs, issued from the page, inside one budget window. */
const STORM_SIZE = 20;

/**
 * The URL the injected storm hammers: a `/api/*` read on the static export,
 * which the host answers 404 in 0 bytes forever. It is the exact URL class the
 * retry loop hammered before the fix, and an answer of nothing keeps the
 * control's own traffic from loading the gateway.
 */
const STORM_PATH = "/api/providers/openai/cc-alias";

test.describe("NEGATIVE CONTROLS — the falsifiability audit", () => {
  test("C1 hydration: the document read sees a real mutation, and is not reading a constant", async ({
    page,
  }) => {
    // 01 proves the theme control changes `<html>`. What that leaves open is
    // whether the READ can see a change at all, or is reporting a value it
    // would report whatever the page did. So both directions are captured from
    // the live document: the node the toggle writes, and a node it does not.
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    const themeToggle = page.locator(
      "button[aria-label='Switch to dark mode'], button[aria-label='Switch to light mode']"
    );
    await expect(themeToggle, "the theme control is missing from the header").toBeVisible();

    const readBoth = () =>
      page.evaluate(() => ({
        html: document.documentElement.className,
        body: document.body.className,
      }));
    const before = await readBoth();
    await themeToggle.click();
    await expect
      .poll(async () => (await readBoth()).html, { timeout: 30_000 })
      .not.toBe(before.html);
    const after = await readBoth();

    writeEvidence("C1-theme-read.json", { before, after });
    expect(
      after.html === before.html,
      "the document read did not observe the toggle. Every hydration conclusion in 01 rests on " +
        "this read; a read that cannot see a mutation cannot report a missing one either."
    ).toBe(false);
    expect(
      after.body === before.body,
      `${after.body === before.body ? "" : "CONTROL FAILED: "}the <body> class also changed. The ` +
        "second half of this control needs a node the toggle does not write; a read that cannot " +
        "tell the two nodes apart is not reading the document, it is reporting a value it already " +
        "had."
    ).toBe(true);
  });

  test("C2 content region: a page that does not reach the threshold is reported as empty", async ({
    page,
  }) => {
    // 02 requires a settled content region on every deep route. A `readContent`
    // that returned `{loaded:true}` for a blank page would satisfy all of them
    // at once, so the same call is made here with a threshold the page cannot
    // reach, and must be told the content is missing.
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    const impossible = 200_000;
    const content = await readContent(page, { minLength: impossible, timeoutMs: 12_000 });

    writeEvidence("C2-impossible-threshold.json", {
      loaded: content.loaded,
      length: content.length,
      region: content.region,
    });
    expect(
      content.loaded,
      `CONTROL FAILED: a page that never rendered ${impossible} characters was reported as ` +
        `settled (${emptinessMessage("/dashboard", content, impossible)}). Every deep-route ` +
        "renders assertion in 02 would pass on a blank page."
    ).toBe(false);
  });

  test("C3 anti-vacuity: the capture guard rejects a capture of nothing", async ({ page }) => {
    // 05 asserts `statics.length >= 5` BEFORE asserting the tree is free of 4xx,
    // so a recorder that captured nothing cannot make both true. Both halves of
    // that guard are checked here against a live page: the real prefix, which
    // must clear it, and a prefix that matches nothing, which must not.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page.waitForTimeout(3000);

    const live = watch.under("/_next/");
    const empty = watch.under("/_no_such_prefix_/");
    writeEvidence("C3-anti-vacuity.json", {
      live: live.length,
      empty: empty.length,
    });

    expect(
      live.length,
      "CONTROL FAILED: the recorder captured no /_next/ requests on a page that loads its own " +
        "asset tree, so the empty-capture half below would be satisfied by a dead recorder"
    ).toBeGreaterThanOrEqual(5);
    expect(
      empty.length,
      "CONTROL FAILED: a prefix that matches nothing captured something, so `under()` does not " +
        "filter and the vacuity guard in 05 is measuring the wrong thing"
    ).toBeLessThan(5);
  });

  test("C3b the failure predicate is faithful: non2xx keeps what it is given and drops what it is not", async ({
    page,
  }) => {
    // The self-check for the predicate every "nothing failed" assertion in this
    // directory is made of. If `non2xx()` ever stopped recording, or started
    // filtering, all of them would go vacuous — silently.
    //
    // The previous form of this control OBSERVED a non-2xx and asserted it had
    // been recorded: it navigated to a route and hoped the deployment produced
    // a failure. That is an inverted dependency, and it is not a valid
    // self-check. The audit of falsifiability was satisfiable only on a broken
    // system: on a gateway where everything the page asked for succeeded, the
    // control failed with "no non-2xx was recorded at all", and on a gateway
    // that was already failing it passed. A control that reports the health of
    // the deployment instead of the trustworthiness of the instrument is the
    // C8 defect under a different name, and it is not to be restored as a
    // "simplification".
    //
    // So the condition is INDUCED here, from the page, against the real host:
    // two requests that cannot succeed (a same-origin path nothing serves, and
    // a wrong method on a path that does exist) plus the page's own healthy
    // asset traffic as the contrast. All three halves of the predicate are then
    // checked against facts this test manufactured.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400, timeoutMs: 60_000 });
    await page.waitForTimeout(2000);

    // Same-origin path nothing serves. The host answers 4xx for an unknown
    // route (C4 asserts exactly that), so this is a real answer, not a stub.
    const MISSING_PATH = "/aisix-control-no-such-resource";
    // A wrong METHOD on a path that exists. `PUT` is not what the service
    // worker is registered from, so this is a 4xx/405 rather than a 2xx — and
    // it is the half a same-origin-only filter could not be checked with.
    const WRONG_METHOD_PATH = "/dashboard";
    const induced = await page.evaluate(
      async ({ missing, wrongMethod }) => {
        const answer = async (init: { url: string; method?: string }) => {
          try {
            const res = await fetch(init.url, {
              method: init.method ?? "GET",
              cache: "no-store",
            });
            return `${init.method ?? "GET"} ${new URL(res.url).pathname} → ${res.status}`;
          } catch (error) {
            return `${init.method ?? "GET"} ${init.url} → ERR ${String(error)}`;
          }
        };
        return Promise.all([answer({ url: missing }), answer({ url: wrongMethod, method: "PUT" })]);
      },
      { missing: MISSING_PATH, wrongMethod: WRONG_METHOD_PATH }
    );
    await page.waitForTimeout(1500);

    const all = watch.non2xx();
    const allRecorded = watch.responses;
    // The predicate keys on `status < 400`, so the contrast set has to be
    // compared on the SAME key. Matching on URL alone is wrong: the induced
    // `PUT /dashboard → 405` shares its URL with the document's own
    // `GET /dashboard → 200`, so a URL-only comparison reports a healthy
    // response as leaked and the control fails for a reason that is not the
    // predicate's fault. (It did, once, here.)
    const healthy = allRecorded.filter((r) => r.status < 400);
    writeEvidence("C3b-non2xx.json", {
      induced,
      non2xx: all.map((r) => `${r.status} ${r.url}`),
      sameOriginRecorded: allRecorded.length,
      sameOriginHealthy: healthy.length,
    });

    // (1) The induction actually happened. If the host answered 2xx to a path
    // that does not exist, this control has nothing to check and must say so
    // rather than pass on a coincidence.
    for (const line of induced) {
      expect(
        Number(line.split("→ ")[1]?.trim() ?? 0),
        `the induced request \`${line}\` did not answer 4xx/5xx, so the predicate has nothing ` +
          "to be faithful about. A host that answers 2xx to a path that does not exist is " +
          "itself a finding, and it is not this control's job to absorb it."
      ).toBeGreaterThanOrEqual(400);
    }

    // (2) It was RECORDED. This is the assertion the old form could only make
    // by accident.
    const recordedPaths = all.map((r) => new URL(r.url).pathname);
    expect(
      recordedPaths,
      "a 4xx was induced from the page and `non2xx()` did not report it, so the predicate is " +
        "not recording and every 'nothing failed' assertion in this suite is unfalsifiable. " +
        `Induced: ${induced.join(", ")}`
    ).toContain(MISSING_PATH);

    // (3) It FILTERS. The old second half was a tautology —
    // `all.filter((r) => r.status >= 400).length === all.length` cannot fail,
    // because `non2xx()` applies `status < 400` as its own predicate. The
    // contrast has to be a response that really is 2xx, and there are dozens of
    // them on this page: every `/_next/static` chunk.
    expect(
      healthy.length,
      "the page recorded no 2xx at all, so there is no contrast set and the filtering half of " +
        "the predicate cannot be checked at all"
    ).toBeGreaterThan(0);
    const non2xxKeys = new Set(all.map((r) => `${r.status} ${r.url}`));
    const leaked = healthy
      .filter((r) => non2xxKeys.has(`${r.status} ${r.url}`))
      .map((r) => `${r.status} ${r.url}`);
    expect(
      leaked,
      `${leaked.length} response(s) the page received with a 2xx are in \`non2xx()\`: ` +
        `${leaked.slice(0, 4).join(", ")}. The filter is not filtering, so every 'no 4xx ` +
        "reached the console' assertion in this directory is counting a list it built wrongly."
    ).toEqual([]);
  });

  test("C4 absent routes: the status filter separates a real 404 from a real 200", async ({
    page,
  }) => {
    // 06 asserts that unknown URLs are answered >= 400. A predicate that read
    // ">= 400" off the wrong object — the navigation's own response instead of
    // the response's status, say — would pass on every URL in the suite. Both
    // answers are read from the live gateway here.
    const present = await page.goto("/dashboard/providers/openai", {
      waitUntil: "load",
      timeout: 90_000,
    });
    const absent = await page.goto("/dashboard/no-such-route-aisix-control", {
      waitUntil: "load",
      timeout: 90_000,
    });
    writeEvidence("C4-route-statuses.json", {
      present: present?.status() ?? null,
      absent: absent?.status() ?? null,
    });

    expect(
      present?.status(),
      "a route that is in the build did not answer 2xx, so the >= 400 verdict in 06 cannot be " +
        "distinguished from a broken gateway"
    ).toBeLessThan(400);
    expect(
      absent?.status() ?? 0,
      "a route that does not exist was NOT answered 404, so the 4xx filter matches everything and " +
        "06's absent-route assertions are vacuous"
    ).toBeGreaterThanOrEqual(400);
  });

  test("C5 locale: the language read follows the switch in both directions", async ({ page }) => {
    // 04 asserts that switching to Japanese moves `<html lang>`. A read that
    // returned a constant, or that read some other node, would satisfy it
    // identically — so the read is made on both sides of the switch, from the
    // live document, and has to track the operator's choice.
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    const lang = () => page.evaluate(() => document.documentElement.lang);

    const before = await lang();
    await page
      .locator("header button")
      .filter({ has: page.locator('img[src*="flagcdn"]') })
      .first()
      .click();
    await expect
      .poll(async () => page.locator("header button").filter({ hasText: "English" }).count())
      .toBeGreaterThan(0);
    await page.locator("header button").filter({ hasText: "日本語" }).last().click();
    await expect.poll(lang, { timeout: 30_000 }).toBe("ja");
    const after = await lang();
    writeEvidence("C5-locale-read.json", { before, after });

    expect(
      before === "ja",
      `the document claimed to be ${before} before any switch was made, so the language read is ` +
        "not reading the document's state"
    ).toBe(false);
    expect(
      after,
      "the language read did not follow the switch to ja. Every locale assertion in 04 rests on " +
        "this read; a read that cannot follow a change cannot report a missing one."
    ).toBe("ja");
  });

  test("C6 admin 401 state: the denial banner is a state, not a permanent fixture", async ({
    page,
    context,
  }) => {
    // 07 asserts the provider-key surface refuses loudly with no credential, and
    // is quiet with one. Both halves have to be real, or the pair proves
    // nothing: a banner that is always there satisfies the first, and one that
    // is never there satisfies the second. So the same banner is observed in
    // both states, on the same route, in the same run.
    if (!ADMIN_KEY) {
      throw new Error(
        "AISIX_SPA_ADMIN_KEY is not set, so the SIGNED-IN half of this control cannot be " +
          "observed and the control would be satisfied by a permanently visible banner. Export a " +
          "real credential from the gateway config and re-run — see 07-admin-surfaces.spec.ts, " +
          "which fails with the same instructions."
      );
    }
    const route = "/dashboard/providers";
    const denial = '[data-testid="provider-keys-denied"]';

    await context.setExtraHTTPHeaders({});
    await page.goto(route, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    const banner = page.locator(denial);
    await expect(
      banner,
      "CONTROL FAILED: with no credential the denial banner never appeared, so the signed-out " +
        "half of 07 is unfalsifiable and this control cannot be told apart from a broken locator"
    ).toBeVisible({ timeout: 60_000 });
    const signedOutVisible = await banner.isVisible();

    await authenticate(context);
    await page.goto(route, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    await expect(
      banner,
      "CONTROL FAILED: the denial banner is still on screen with a valid credential. Either the " +
        "banner is not a state, or the credential never reached the gateway — and 07's signed-in " +
        "assertions would have been reading a page that was refusing everything."
    ).toHaveCount(0, { timeout: 30_000 });
    const signedInVisible = await banner.isVisible();
    writeEvidence("C6-denial-banner.json", { signedOutVisible, signedInVisible });

    expect(
      signedOutVisible,
      "the signed-out denial banner was not visible immediately after the wait reported that it was"
    ).toBe(true);
    expect(
      signedInVisible,
      "the signed-in denial banner was still visible immediately after the wait reported that it " +
        "was gone"
    ).toBe(false);
  });

  test("C7 client-side nav: the document marker separates a router nav from a document load", async ({
    page,
  }) => {
    // 03 proves client-side navigation by a `window` marker that survives a
    // router navigation. A marker that is always gone proves the same thing, so
    // both navigations are made and the marker's fate is recorded for each.
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    await page.evaluate(() => {
      (window as unknown as { __c?: string }).__c = "alive";
    });
    const alive = () =>
      page.evaluate(() => (window as unknown as { __c?: string }).__c === "alive");

    const link = page.locator("a[href='/dashboard/combos']").first();
    await expect(link, "no nav entry to /dashboard/combos").toBeVisible({ timeout: 45_000 });
    await link.click({ timeout: 30_000 });
    await readContent(page, { minLength: 120, timeoutMs: 75_000 });
    const afterRouterNav = await alive();

    await page.goto("/dashboard/combos", { waitUntil: "load", timeout: 90_000 });
    const afterDocumentLoad = await alive();
    writeEvidence("C7-marker.json", { afterRouterNav, afterDocumentLoad });

    expect(
      afterRouterNav,
      "the marker did not survive a router navigation, so a client-side-navigation check built on " +
        "it would pass on a full page load too — which is the defect it exists to catch"
    ).toBe(true);
    expect(
      afterDocumentLoad,
      "the marker survived a REAL document load, so the check cannot tell the two navigations " +
        "apart and every client-side-navigation assertion in 03 is unfalsifiable"
    ).toBe(false);
  });

  test("C8 request budget: an injected storm is found, and the production ceiling rejects it", async ({
    page,
  }) => {
    // This is the control the retry-loop fix rests on, and it is the one that
    // used to assert that the storm was GONE — a copy of the production
    // assertion, satisfied by `peak.count === 0`, satisfied by an empty
    // recording, and green on the very run that fixed the defect. So the storm
    // is manufactured here instead of waited for: 20 identical same-origin GETs
    // of the exact `/api/*` path the loop used to hammer, issued by the page
    // itself against the real gateway. The measure is then required to FIND it,
    // and the production verdict is required to REJECT it.
    const watch = new PageWatch(page);
    await page.goto("/dashboard/providers/openai", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });

    const issued = await page.evaluate(
      async ({ path, times }) => {
        // Concurrently, so all of them land inside ONE budget window. Issued one
        // at a time they are spread over several windows by the round trips
        // themselves — measured on the first run of this control: 20 sequential
        // requests spanned more than 5 s and the peak measure reported 11, so
        // the control was measuring the issuing rate of the test rather than
        // finding the storm. `no-store` so none of them is answered out of the
        // HTTP cache instead of the wire, which would leave nothing to record.
        const responses = await Promise.all(
          Array.from({ length: times }, () => fetch(path, { cache: "no-store" }))
        );
        return responses.length;
      },
      { path: STORM_PATH, times: STORM_SIZE }
    );

    const peak = watch.peakRepeats(REQUEST_BUDGET_WINDOW_MS);
    const stormKey = `GET ${STORM_PATH}`;
    const stormCount = watch.requestHistogram().get(stormKey) ?? 0;
    writeEvidence("C8-storm.json", {
      issued,
      stormKey,
      stormCount,
      peak,
      windowMs: REQUEST_BUDGET_WINDOW_MS,
      maxRepeats: MAX_REPEATS_PER_URL_PER_WINDOW,
    });

    // Non-vacuity, first: an empty recording reads as `{key:"", count:0}`, and a
    // control that accepts that proves nothing about a storm it never saw.
    expect(
      peak.key,
      "the recorder saw no same-origin request at all, so nothing below is measuring a storm"
    ).not.toBe("");
    expect(
      issued,
      `the page issued ${issued} of ${STORM_SIZE} storm requests. The control cannot claim the ` +
        "measure finds a storm that was never issued."
    ).toBe(STORM_SIZE);
    expect(
      stormCount,
      `the recorder counted ${stormCount} requests for ${stormKey} when the page issued ` +
        `${STORM_SIZE}. Either the recorder misses requests or the measure cannot count them.`
    ).toBeGreaterThanOrEqual(STORM_SIZE);
    // The production measure, on the injected capture.
    expect(
      peak.count,
      `the peak-repeats measure found ${peak.count} (${peak.key}) when ${STORM_SIZE} identical ` +
        `requests were issued inside ${REQUEST_BUDGET_WINDOW_MS}ms. The request-budget assertion ` +
        "in 08 would be satisfied by a page hammering itself, because the thing it measures does " +
        "not see the thing it is for."
    ).toBeGreaterThanOrEqual(STORM_SIZE);
    // And the verdict 08 asserts with, applied to that capture.
    expect(
      isOverRequestBudget(peak),
      `${STORM_SIZE} repeats of one URL inside ${REQUEST_BUDGET_WINDOW_MS}ms did NOT exceed the ` +
        `ceiling of ${MAX_REPEATS_PER_URL_PER_WINDOW}. The budget assertion in 08 is unfalsifiable.`
    ).toBe(true);
  });

  test("C9 uncaught exceptions: a thrown one is recorded, with its message", async ({ page }) => {
    // 01 and 08 assert that no uncaught exception reaches the page. An
    // exception recorder that recorded nothing would satisfy both, forever, so
    // a real exception is thrown into the page and has to come back out of the
    // recorder carrying the text it was given.
    const watch = new PageWatch(page);
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    const marker = "deliberate control exception";
    await page.evaluate((message) => {
      setTimeout(() => {
        throw new Error(message);
      }, 0);
    }, marker);
    await page.waitForTimeout(1500);

    writeEvidence("C9-page-errors.json", { pageErrors: watch.pageErrors });
    expect(
      watch.pageErrors,
      "an uncaught exception was thrown into the page and the recorder did not see it. Every " +
        "'no uncaught exception' assertion in this suite is unfalsifiable."
    ).toContain(marker);
  });

  test("C10 broken images: the naturalWidth filter finds an image that really is broken", async ({
    page,
  }) => {
    // 08 asserts that no image the dashboard renders is broken. The filter that
    // decides it is `img.complete && img.naturalWidth === 0`, and on a healthy
    // deployment it finds nothing — so the broken half of the claim is
    // manufactured: an <img> pointing at a file the export does not ship, which
    // the real gateway answers 404. The same filter has to see it, and it has
    // to see it as an INCREMENT, so the filter is credited only for the image
    // this control put there.
    //
    // What the page had already rendered is deliberately not part of the claim.
    // Whether the deployment's own logos load is a fact about the deployment —
    // 08's image test is the assertion that owns it, and it is red on a stale
    // artifact. Folding it in here would make this control red for the
    // deployment's sake, which is not what a control is for: a control measures
    // the instrument, and a broken product is the other file's finding.
    await page.goto("/dashboard/media-providers/image", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 60_000 });
    await page.waitForTimeout(2000);

    const countBroken = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0)
            .length
      );
    const beforeInjection = await countBroken();

    const brokenSrc = await page.evaluate(async () => {
      const img = document.createElement("img");
      img.alt = "aisix-negative-control";
      img.src = "/providers/__aisix_no_such_vendor__.svg";
      document.body.appendChild(img);
      await img.decode().catch(() => undefined);
      return img.getAttribute("src") ?? "";
    });
    await page.waitForTimeout(1000);
    const afterInjection = await countBroken();
    writeEvidence("C10-broken-images.json", { beforeInjection, afterInjection, brokenSrc });

    expect(
      brokenSrc,
      "the broken image was not injected, so the filter below is being asked to find nothing " +
        "and cannot be told apart from a filter that finds nothing"
    ).not.toBe("");
    expect(
      afterInjection > beforeInjection,
      `an image pointing at a file the gateway does not serve was added to the page and the ` +
        `naturalWidth filter did not report it (${beforeInjection} → ${afterInjection}). The ` +
        "broken-image assertions in 08 would pass on a grid of empty frames."
    ).toBe(true);
    // The control removes the image it added, so the page is left as it found it.
    await page.evaluate(() => {
      document
        .querySelectorAll('img[alt="aisix-negative-control"]')
        .forEach((node) => node.remove());
    });
  });
});
