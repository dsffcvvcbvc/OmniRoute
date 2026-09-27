import { expect, test, type Page } from "@playwright/test";

import { PageWatch, emptinessMessage, readContent, writeEvidence } from "./harness";

/**
 * 03 — CLIENT-SIDE NAVIGATION into the dynamic routes.
 *
 * Same family of destinations as 02 (`providers/[id]`, `cli-code/[id]`,
 * `media-providers/[kind]`), reached the other way: from a page that is already
 * open, by clicking a link the operator can see. That exercises a different
 * retrieval path — the target's RSC payload has to be fetched and ACCEPTED —
 * and it is the path that degrades differently: a payload served with the
 * wrong content type is not a flight response, and the router's fallback is a
 * full-page navigation that lands the operator on raw flight text instead of
 * content.
 *
 * "Client-side" is asserted, not assumed. A marker is planted on `window`
 * before the click. It survives a router navigation and cannot survive a real
 * document load, so its disappearance is an unambiguous full-page fallback —
 * which is also the symptom a wrong RSC content type produces.
 *
 * The entry hop is the nav item the operator can actually see. Note
 * `/dashboard/media-providers` has no inbound link from anywhere in the served
 * dashboard document, so that one is entered cold (a bookmark is a real entry
 * path) and the DYNAMIC route under it is reached in-app, which is what this
 * file is about.
 */

type Leg = {
  /** How the operator gets to the parent route. */
  entry: { kind: "click" | "cold"; href: string };
  /** The dynamic destination, reached by an in-app click. */
  target: string;
  label: string;
  expectedHref: string;
};

const LEGS: Leg[] = [
  {
    entry: { kind: "click", href: "/dashboard/providers" },
    target: "/dashboard/providers/openai",
    expectedHref: "/dashboard/providers/openai",
    label: "Providers → OpenAI",
  },
  {
    entry: { kind: "click", href: "/dashboard/cli-code" },
    target: "/dashboard/cli-code/opencode",
    expectedHref: "/dashboard/cli-code/opencode",
    label: "CLI Code → OpenCode",
  },
  {
    entry: { kind: "cold", href: "/dashboard/media-providers" },
    target: "/dashboard/media-providers/image",
    expectedHref: "/dashboard/media-providers/image",
    label: "Media providers → Image",
  },
];

/** Plant the marker, click, and report where we landed and whether it was in-app. */
async function clickThrough(
  page: Page,
  href: string
): Promise<{ url: string; clientSide: boolean }> {
  const link = page.locator(`a[href='${href}']`).first();
  await expect(link, `nothing on the current page links to ${href}`).toBeVisible({
    timeout: 45_000,
  });

  await page.evaluate(() => {
    (window as unknown as { __aisixNavMarker?: string }).__aisixNavMarker = "alive";
  });
  await link.click({ timeout: 45_000 });

  // Wait for the router to commit, rather than for a fixed delay: a heavy
  // destination (the provider index drives dozens of reads) can take several
  // seconds to swap, and reading the URL too early reads the OLD route and
  // would report a navigation that did not happen.
  await expect
    .poll(async () => page.evaluate(() => location.pathname), {
      timeout: 45_000,
      message: `clicking ${href} never changed the URL`,
    })
    .toContain(href);

  return page.evaluate(() => ({
    url: `${location.pathname}${location.search}`,
    // A real document load creates a fresh `window`, so the marker is gone.
    clientSide: (window as unknown as { __aisixNavMarker?: string }).__aisixNavMarker === "alive",
  }));
}

test.describe("client-side navigation", () => {
  test("the dashboard entry exposes its nav links as real anchors", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 400 });
    for (const href of ["/dashboard/providers", "/dashboard/cli-code"]) {
      await expect(
        page.locator(`a[href='${href}']`).first(),
        `${href} is not reachable from the dashboard nav`
      ).toBeVisible({ timeout: 30_000 });
    }
  });

  for (const leg of LEGS) {
    test(`${leg.label} navigates in-app and renders content`, async ({ page }) => {
      if (leg.entry.kind === "click") {
        await page.goto("/dashboard", { waitUntil: "load", timeout: 90_000 });
        await readContent(page, { minLength: 400 });
      } else {
        await page.goto(leg.entry.href, { waitUntil: "load", timeout: 90_000 });
        await readContent(page, { minLength: 120, timeoutMs: 75_000 });
      }

      const watch = new PageWatch(page);
      const arrival =
        leg.entry.kind === "click"
          ? await clickThrough(page, leg.entry.href)
          : { url: leg.entry.href, clientSide: true };

      if (leg.entry.kind === "click") {
        expect(
          arrival.clientSide,
          `${leg.entry.href}: the nav click was a full document load`
        ).toBe(true);
        expect(arrival.url, `${leg.entry.href}: the nav click landed elsewhere`).toBe(
          leg.entry.href
        );
        // Give the index route's own Suspense boundary a chance to resolve so
        // the dynamic link is present.
        await readContent(page, { minLength: 120, timeoutMs: 75_000 });
      }

      const landed = await clickThrough(page, leg.expectedHref);
      const content = await readContent(page, { minLength: 120, timeoutMs: 75_000 });

      writeEvidence(`03-${leg.expectedHref.replace(/\//g, "_")}.json`, {
        entry: leg.entry,
        landedOn: landed.url,
        clientSide: landed.clientSide,
        length: content.length,
        loaded: content.loaded,
        head: content.text.slice(0, 300),
        watch: watch.dump(),
      });

      expect(
        landed.clientSide,
        `${leg.expectedHref}: clicking the link caused a full document load instead of a ` +
          "router navigation. On a route whose RSC payload the host cannot serve as a flight " +
          "response, this is what the operator gets instead of content."
      ).toBe(true);
      expect(landed.url, `${leg.expectedHref}: the link landed on a different URL`).toContain(
        leg.expectedHref
      );
      expect(
        content.loaded,
        emptinessMessage(`${leg.expectedHref} (after an in-app navigation)`, content, 120)
      ).toBe(true);
      expect(
        content.length,
        `${leg.expectedHref}: an in-app navigation left the content region empty`
      ).toBeGreaterThanOrEqual(120);
      expect(
        watch.pageErrors,
        `${leg.expectedHref}: uncaught exception during an in-app navigation`
      ).toEqual([]);
    });
  }
});
