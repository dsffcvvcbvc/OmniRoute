import { expect, test } from "@playwright/test";

import { PageWatch, writeEvidence } from "./harness";

/**
 * 06 — WHAT THE OPERATOR SEES for a URL that is not in the build.
 *
 * A static host has three available answers for an unknown path — a 404, a
 * silent redirect, or the app's own not-found page — and the one thing it must
 * not do is none of those, i.e. quietly serve something else. The dangerous
 * failure is the quiet one: a redirect loop, or a 200 that shows the dashboard
 * for a route that does not exist, because both leave the operator believing a
 * page exists when it does not.
 *
 * Three cases, all real, none of them skipped:
 *   - a path inside the dashboard mount that the build does not contain;
 *   - a path outside the mount entirely;
 *   - `/connect/codex/<token>` and `/docs/`, which the export does not ship.
 *
 * A "no silent success, no redirect loop" claim needs the response history, not
 * the final one, so both are recorded.
 */

type AbsentCase = { path: string; why: string };

const CASES: AbsentCase[] = [
  {
    path: "/dashboard/providers/definitely-not-a-real-provider-id",
    why: "inside the dashboard mount, but no such route in the build",
  },
  {
    path: "/this-route-does-not-exist-anywhere",
    why: "outside every mount the host serves",
  },
  {
    path: "/connect/codex/a-token-that-was-never-issued",
    why: "the token-exchange page the export does not ship",
  },
  { path: "/docs/getting-started", why: "the documentation tree the export does not ship" },
];

test.describe("absent routes", () => {
  for (const absent of CASES) {
    test(`${absent.path} answers honestly (${absent.why})`, async ({ page }) => {
      const watch = new PageWatch(page);
      const responses: Array<{ status: number; url: string; location: string | null }> = [];
      page.on("response", (response) => {
        if (response.request().resourceType() !== "document") return;
        responses.push({
          status: response.status(),
          url: response.url(),
          location: response.headers()["location"] ?? null,
        });
      });

      const response = await page.goto(absent.path, { waitUntil: "load", timeout: 60_000 });
      expect(response, `${absent.path} produced no response at all`).not.toBeNull();
      // Read the wire body before the page consumes it, and tolerate a body
      // the browser already streamed away — the point is only whether there
      // was anything in it.
      const wireBody = await response!.text().catch(() => "");

      // The page must not have been left spinning on a redirect.
      await page.waitForTimeout(3000);
      const landed = page.url();
      const bodyText = await page.evaluate(() => (document.body?.innerText || "").trim());

      writeEvidence(`06-${absent.path.replace(/\//g, "_")}.json`, {
        path: absent.path,
        why: absent.why,
        finalUrl: landed,
        status: response!.status(),
        documents: responses,
        wireBodyLength: wireBody.length,
        wireBodyHead: wireBody.slice(0, 300),
        renderedBodyLength: bodyText.length,
        consoleErrors: watch.consoleErrors,
      });

      // 1. Not a silent success. A 2xx here would mean the host answered a
      //    URL that is not in the build with something that looks like a page.
      expect(
        response!.status(),
        `${absent.path} answered ${response!.status()} — an unknown route must not be served ` +
          "as if it existed"
      ).toBeGreaterThanOrEqual(400);

      // 2. Not a redirect loop, and not a redirect at all. A 404 IS the honest
      //    answer; a 3xx is not — it sends the operator somewhere they did not
      //    ask for, and a chain of them is the loop case. So the rule is
      //    "no document response was a redirect", not "every response was
      //    under 300" (which would also reject the 404 we want).
      expect(
        responses.length,
        `${absent.path} produced ${responses.length} document responses, which is a redirect ` +
          "chain rather than an answer"
      ).toBeLessThanOrEqual(2);
      for (const hop of responses) {
        const wasRedirect = hop.status >= 300 && hop.status < 400;
        expect(
          wasRedirect,
          `${absent.path} answered with a redirect (${hop.status} → ${hop.location}) instead of ` +
            "answering — the browser was sent somewhere the operator did not ask for"
        ).toBe(false);
        expect(
          hop.location,
          `${absent.path} carried a Location header, so the answer is a redirect, not a refusal`
        ).toBeNull();
      }

      // 3. The operator is told something. An empty body is not an answer an
      //    operator can act on; the requirement is that the failure is visible.
      expect(
        wireBody.length + bodyText.length,
        `${absent.path} answered ${response!.status()} with nothing at all — the operator gets a ` +
          "blank page and no indication that the route does not exist"
      ).toBeGreaterThan(0);

      // 4. And the browser is not left mid-redirect: it settled on the URL it
      //    was asked for, not somewhere else.
      expect(
        new URL(landed).pathname,
        `${absent.path} ended up at ${landed} — the browser was sent somewhere else`
      ).toBe(absent.path);
    });
  }

  test("a known route is not mistaken for an absent one", async ({ page }) => {
    // The inverse control. If the host answered everything with 404 the absent
    // assertions above would pass while the app is unreachable, so prove the
    // distinction is real in the same browser, same host, same run.
    const response = await page.goto("/dashboard/providers/openai", {
      waitUntil: "load",
      timeout: 90_000,
    });
    expect(
      response!.status(),
      "a route that IS in the build answered 4xx — the host cannot tell present from absent"
    ).toBe(200);
  });
});
