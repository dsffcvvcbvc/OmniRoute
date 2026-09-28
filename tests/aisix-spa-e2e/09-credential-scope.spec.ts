import { expect, test } from "@playwright/test";
import {
  ADMIN_KEY,
  BASE_URL,
  authenticate,
  isAdminOrigin,
  localeButton,
  writeEvidence,
} from "./harness";

/**
 * The admin key must reach the admin plane and NOTHING else.
 *
 * `authenticate()` used to install the credential context-wide with
 * `context.setExtraHTTPHeaders`, which Chromium attaches to every request the
 * context issues regardless of origin. The dashboard header paints the language
 * selector unconditionally and `CountryFlag` renders
 * `<img src="https://flagcdn.com/w40/us.png">`, so every test that authenticated
 * and then loaded a dashboard page handed a real gateway's admin key to a
 * public CDN in an `Authorization` header. No assertion anywhere in this suite
 * could see it: `PageWatch` records URLs, not headers, and `scrub()` only
 * cleans what the suite itself writes to disk.
 *
 * A THIRD-PARTY ORIGIN to watch is the whole point of the test, so it is forced
 * explicitly rather than left to whatever the page happens to load. Waiting for
 * the flag image would be the natural way, and it is exactly the wrong one: on
 * a host with no outbound DNS it never settles and the test fails for a reason
 * that has nothing to do with the credential. One `fetch` to a third-party
 * origin is enough — the browser attaches context headers when it issues the
 * request, so the assertion holds whether or not the response ever arrives.
 */

const THIRD_PARTY = "https://flagcdn.com/w40/us.png";

test.describe("credential scope", () => {
  test("the admin key is attached to the admin origin and to nothing else", async ({
    page,
    context,
  }) => {
    // The key is required for this test to mean anything: with no key,
    // `authenticate` returns false, installs nothing, and every assertion
    // below would be vacuously true.
    expect(
      ADMIN_KEY,
      "AISIX_SPA_ADMIN_KEY is unset — a suite that never had the key cannot prove the key " +
        "stayed on one origin. See tests/aisix-spa-e2e/README.md for how to run it."
    ).not.toBe("");

    // Record every request the context issues, with the credential it carried.
    // `request` fires when the request is ISSUED, so a request that is refused,
    // that 404s, or that never gets a response is still recorded — which is
    // what makes the third-party probe below deterministic offline.
    const sent: { url: string; authorization: string | undefined }[] = [];
    context.on("request", (request) => {
      sent.push({
        url: request.url(),
        authorization: request.headers()["authorization"],
      });
    });

    expect(await authenticate(context)).toBe(true);

    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load", timeout: 90_000 });
    await localeButton(page).waitFor({ state: "visible", timeout: 60_000 });

    // Force a cross-origin request deterministically. It is allowed to fail:
    // nothing here asserts on the response, only on what the browser attached
    // to the request.
    await page
      .evaluate((url) => {
        void fetch(url, { mode: "no-cors" }).catch(() => undefined);
      }, THIRD_PARTY)
      .catch(() => undefined);
    await page.waitForTimeout(1_000);

    const offOrigin = sent.filter((entry) => !isAdminOrigin(entry.url));
    const withCredential = sent.filter((entry) => entry.authorization !== undefined);
    const leaked = offOrigin.filter((entry) => entry.authorization !== undefined);
    const sameOriginCredentialMissing = sent
      .filter((entry) => isAdminOrigin(entry.url))
      .filter((entry) => entry.authorization === undefined);

    writeEvidence("09-credential-scope.json", {
      adminOrigin: new URL(BASE_URL).origin,
      total: sent.length,
      offOrigin: offOrigin.map((entry) => entry.url),
      credentialed: withCredential.map((entry) => entry.url),
      leaked: leaked.map((entry) => entry.url),
    });

    // Non-vacuity first. A run where the browser never issued a single
    // cross-origin request proves nothing — the whole defect is invisible to a
    // suite that only ever talks to one origin — so that condition fails here
    // rather than letting every assertion below pass over it.
    expect(
      offOrigin.length,
      "no cross-origin request was observed, so this run cannot see a leak that is defined " +
        "by where a request went"
    ).toBeGreaterThan(0);

    // The defect itself. Names the leaked URL; never names the key.
    expect(
      leaked.map((entry) => entry.url),
      "the admin key was attached to a request that is not the admin plane's own origin — " +
        "a context-wide header hands a real gateway credential to every third party the page " +
        "loads (flagcdn.com is one)"
    ).toEqual([]);

    // …and the other direction, because "scoped" must not become "removed". A
    // fix that dropped the header entirely would pass the assertion above; this
    // is what makes the credential still WORK.
    expect(
      sameOriginCredentialMissing.length,
      "an admin-origin request went out with no Authorization header — the scoping " +
        "removed the credential instead of narrowing it"
    ).toBe(0);
    expect(
      withCredential.length,
      "not one request to the admin origin carried the credential; authenticate() is a no-op"
    ).toBeGreaterThan(0);
  });
});
