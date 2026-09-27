import { expect, test } from "@playwright/test";

import {
  ADMIN_KEY,
  PageWatch,
  authenticate,
  readAdminSnapshot,
  readContent,
  writeEvidence,
} from "./harness";

/**
 * 07 — THE ADMIN SURFACES.
 *
 * Two states, and the whole point is that they are distinguishable. An operator
 * with no key and an operator looking at a gateway that has nothing configured
 * both see a list-shaped region; if the app cannot tell them apart, one of them
 * is being told a falsehood — either "you have no keys" (there may be some) or
 * "here are your keys" (there may be none).
 *
 * So the assertions are made against what the REAL gateway holds, read over
 * HTTP with the same credential the browser uses — not against a count written
 * into this file. If the gateway has three keys, the signed-in surface has to
 * show three; if it has none, it has to say so. The signed-out surface has to
 * name the refusal, and must NOT present the refusal as an empty list.
 *
 * The signed-out and wrong-key tests CLEAR the credential rather than relying
 * on the environment not having set it, so they run identically whether or not
 * `AISIX_SPA_ADMIN_KEY` is exported. The signed-in test genuinely needs a
 * credential; without one it FAILS with instructions, because a silent skip
 * there would leave the most load-bearing assertion in this file unrun.
 *
 * `NEXT_PUBLIC_AISIX_ADMIN` is not used: the SPA and the admin API share one
 * origin by design, so the key travels as a request header — what an ingress
 * in front of the admin port does.
 */

const PROVIDERS = "/dashboard/providers";
const COMBOS = "/dashboard/combos";

/** Present no credential at all, whatever the environment supplied. */
async function presentNoCredential(
  context: import("@playwright/test").BrowserContext
): Promise<void> {
  await context.setExtraHTTPHeaders({});
}

function requireAdminKey(): string {
  if (!ADMIN_KEY) {
    throw new Error(
      "AISIX_SPA_ADMIN_KEY is not set. The signed-in admin surface cannot be exercised without " +
        "a real credential from the gateway's own config (admin.admin_keys in the file passed to " +
        "--config). Export it and re-run; do not substitute a made-up key, which would make " +
        "this file assert the wrong thing."
    );
  }
  return ADMIN_KEY;
}

test.describe("admin surfaces", () => {
  test("the gateway's admin API is reachable and is the truth for these assertions", async () => {
    const snapshot = await readAdminSnapshot();
    writeEvidence("07-admin-snapshot.json", snapshot);
    expect(
      snapshot.reachable,
      "the admin API did not answer, so the UI cannot be compared against a server truth — " +
        "every assertion below would be unfalsifiable"
    ).toBe(true);
    expect(
      snapshot.providerKeyCount,
      "the admin API answered something that is not a list of provider keys"
    ).toBeGreaterThanOrEqual(0);
  });

  test("signed out, the provider-key surface names the 401 and shows no list", async ({
    page,
    context,
  }) => {
    await presentNoCredential(context);
    const watch = new PageWatch(page);
    await page.goto(PROVIDERS, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    const section = page.locator('[data-testid="provider-keys-section"]');
    await expect(section, "the provider-key surface is absent entirely").toBeVisible({
      timeout: 60_000,
    });

    const denied = section.locator('[data-testid="provider-keys-denied"]');
    await expect(
      denied,
      "no admin key was sent, the gateway answered 401, and the surface does not say so — the " +
        "operator cannot tell a refused request from an empty gateway"
    ).toBeVisible({ timeout: 60_000 });

    // The refusal must read as a refusal: it has to point at the thing the
    // operator has to change, or it is not actionable.
    const deniedText = (await denied.innerText()).toLowerCase();
    expect(
      deniedText,
      `the refusal does not name the credential or where to put it: "${deniedText.slice(0, 160)}"`
    ).toMatch(/401|admin key|admin_key/);

    // And it must not double as an empty result.
    await expect(
      section.locator('[data-testid="provider-keys-empty"]'),
      "the surface showed the empty state alongside the refusal — an empty list reads as " +
        "'this gateway has no provider keys', which is a different claim"
    ).toHaveCount(0);
    await expect(section.locator('[data-testid="provider-keys-list"]')).toHaveCount(0);

    writeEvidence("07-providers-signed-out.json", { deniedText, watch: watch.dump() });
  });

  test("a wrong admin key is refused, not silently rendered as empty", async ({
    page,
    context,
  }) => {
    // The negative control for the signed-in test: a credential the gateway
    // does not accept must land the surface in the same refusal state as no
    // credential at all. Without this, "signed in" would only prove that a
    // string was attached to the request.
    const snapshot = await readAdminSnapshot();
    expect(
      snapshot.reachable,
      "the admin API did not answer, so there is nothing to contradict"
    ).toBe(true);
    await context.setExtraHTTPHeaders({ Authorization: "Bearer not-a-valid-admin-key" });

    const watch = new PageWatch(page);
    await page.goto(PROVIDERS, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    const section = page.locator('[data-testid="provider-keys-section"]');
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(
      section.locator('[data-testid="provider-keys-denied"]'),
      "a bogus admin key was accepted and the surface rendered a result — the gateway's 401 was " +
        "ignored or the credential is not actually being checked"
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      section.locator('[data-testid="provider-keys-empty"]'),
      "a rejected credential produced the empty state, which claims the gateway has no keys"
    ).toHaveCount(0);

    writeEvidence("07-providers-bad-key.json", { watch: watch.dump() });
  });

  test("signed in, the provider-key surface shows what the gateway actually holds", async ({
    page,
    context,
  }) => {
    const key = requireAdminKey();
    const snapshot = await readAdminSnapshot();
    expect(snapshot.reachable, "the admin API did not answer").toBe(true);
    await authenticate(context, key);

    const watch = new PageWatch(page);
    await page.goto(PROVIDERS, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });

    const section = page.locator('[data-testid="provider-keys-section"]');
    await expect(section).toBeVisible({ timeout: 60_000 });

    // Wait for the list to reflect the server rather than for a fixed delay:
    // the section header paints long before the rows arrive, and on a gateway
    // holding many keys the read takes seconds.
    //
    // Rows are the list's own children. Located that way rather than by a tag
    // name: the row is a div carrying `data-testid="provider-key-<uuid>"`, and
    // `:not([data-testid^='provider-keys'])` keeps the per-row edit/delete
    // buttons (which share the prefix) out of the count.
    const list = section.locator('[data-testid="provider-keys-list"]');
    const count = section.locator('[data-testid="provider-keys-count"]');
    const empty = section.locator('[data-testid="provider-keys-empty"]');

    if (snapshot.providerKeyCount > 0) {
      await expect(
        list,
        `the gateway holds ${snapshot.providerKeyCount} provider key(s) and the surface rendered ` +
          "no list at all — the signed-in view is not reading the gateway"
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        list.locator(":scope > *"),
        `the gateway holds ${snapshot.providerKeyCount} provider key(s) and the list rendered no ` +
          "row — the signed-in view is not reading the gateway"
      ).toHaveCount(snapshot.providerKeyCount, { timeout: 60_000 });
      // The count the operator reads must be the server's count, not a stale
      // one from a previous render.
      await expect(
        count,
        "the surface shows no key count, so the operator cannot tell how many keys this " +
          "gateway holds"
      ).toHaveText(String(snapshot.providerKeyCount), { timeout: 30_000 });

      // Spot-check names rather than every one: on a gateway with hundreds of
      // keys the list is the size of a database dump, and a per-row assertion
      // over it tests the test runner, not the app. Three is enough to prove
      // the rows are the gateway's rows.
      for (const name of snapshot.providerKeyNames.slice(0, 3)) {
        await expect(
          list.getByText(name, { exact: false }).first(),
          `the gateway holds a key named "${name}" that the surface never renders`
        ).toBeVisible({ timeout: 30_000 });
      }
    } else {
      await expect(
        empty,
        "the gateway holds no provider keys and the surface does not say so"
      ).toBeVisible({ timeout: 60_000 });
    }

    // Signed in must not still be showing the refusal.
    await expect(
      section.locator('[data-testid="provider-keys-denied"]'),
      "a valid admin key was sent and the surface still shows the 401 refusal"
    ).toHaveCount(0);

    writeEvidence("07-providers-signed-in.json", { snapshot, watch: watch.dump() });
  });

  test("the combos surface distinguishes refused from ready", async ({ page, context }) => {
    const key = requireAdminKey();
    const watch = new PageWatch(page);

    // Signed out first, with the credential explicitly removed.
    await presentNoCredential(context);
    await page.goto(COMBOS, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    const required = page.locator('[data-testid="combos-admin-key-required"]');
    await expect(
      required,
      "no admin key was sent, the gateway answered 401, and the combos surface does not say so " +
        "— the operator sees an empty combo list that reads as 'this gateway has no combos'"
    ).toBeVisible({ timeout: 60_000 });
    writeEvidence("07-combos-signed-out.json", { watch: watch.dump() });

    // Then signed in, in the same tab, and the demand must go away.
    await authenticate(context, key);
    const watchAfter = new PageWatch(page);
    await page.goto(COMBOS, { waitUntil: "load", timeout: 90_000 });
    await readContent(page, { minLength: 120, timeoutMs: 90_000 });
    await expect(
      required,
      "an admin key was sent and the combos surface still demands one — the signed-in state is " +
        "indistinguishable from the signed-out one"
    ).toHaveCount(0);
    writeEvidence("07-combos-signed-in.json", { watch: watchAfter.dump() });
  });
});
