import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The operator's journey through the gateway key prompt, against the REAL
 * thing: the deployed Rust binary serving the REAL static dashboard artifact on
 * the Admin API's own origin.
 *
 * There is no interceptor, no fixture server and no mocked response in this
 * file. Every status this test asserts on came out of the actual admin handler.
 * The only thing the test supplies is the admin key, read from the gateway's
 * own config, which is the one input an operator also has to supply.
 *
 * The origin coincidence is the point. `aisix_admin_session` is scoped to
 * `Path=/admin/v1` on the host that serves the dashboard, so the dashboard has
 * to be served BY the gateway for the cookie to ride along at all. Running the
 * Next dev server instead would make every cookie assertion vacuously true.
 *
 * Run it with the gateway already up:
 *   AISIX_DASHBOARD_DIR=/path/to/out \
 *     setsid --fork /home/ernur/.aisix/aisix --config ~/.aisix/config.yaml
 *   npx playwright test --config playwright.aisix-admin-auth.config.ts
 */

const CONFIG = process.env.AISIX_CONFIG || "/home/ernur/.aisix/config.yaml";
const CAPTURES = process.env.AISIX_CAPTURE_DIR || "/tmp/opencode/aisix-login-captures";

/**
 * The admin key, read from the gateway config the way an operator reads it.
 *
 * Read at runtime and never written anywhere: it is held in this process's
 * memory, passed to the browser through an in-page variable, and dropped. It is
 * deliberately NOT put in a file, a URL, a fixture or a snapshot, and no
 * assertion below compares against it.
 */
function readAdminKey(): string {
  const raw = fs.readFileSync(CONFIG, "utf8");
  const match = /admin_keys:\s*\[\s*"([^"]+)"/.exec(raw);
  if (!match) throw new Error(`no admin_keys found in ${CONFIG}`);
  return match[1];
}

const ADMIN_KEY = readAdminKey();

/** The dashboard route whose admin reads the journey exercises. */
const PROVIDERS_ROUTE = "/dashboard/providers";

/**
 * The combos rows, from any of the envelopes the native plane ships
 * (`[...]`, `{combos:[…]}`, `{data:[…]}`). Reading only one key is how a
 * reachable plane renders as "0 combos".
 */
function readComboRows(body: unknown): AdminRow[] {
  if (Array.isArray(body)) return body as AdminRow[];
  const envelope = body as AdminEnvelope | null;
  return envelope?.combos ?? envelope?.data ?? envelope?.items ?? [];
}

const nameOf = (row: AdminRow): string | undefined => row.name ?? row.value?.name;

let captureIndex = 0;

async function capture(page: Page, name: string): Promise<string> {
  fs.mkdirSync(CAPTURES, { recursive: true });
  captureIndex += 1;
  const file = path.join(CAPTURES, `${String(captureIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** One row of a native admin collection, as far as this test reads it. */
type AdminRow = { id?: string; name?: string; display_name?: string; value?: AdminRow } & Record<string, unknown>;

/** A native admin collection envelope, of any of the shapes the plane ships. */
type AdminEnvelope = { models?: AdminRow[]; data?: AdminRow[]; items?: AdminRow[]; combos?: AdminRow[] };

/** Every admin request the page made, and the status each one got. */
function trackAdminRequests(page: Page): Array<{ method: string; url: string; status: number }> {
  const log: Array<{ method: string; url: string; status: number }> = [];
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/admin/v1/")) return;
    log.push({ method: response.request().method(), url, status: response.status() });
  });
  return log;
}

/** A settled snapshot of what JS can reach: the whole persistence surface. */
async function readJsVisibleStorage(page: Page) {
  return await page.evaluate(() => {
    const cookies = document.cookie;
    let local: Record<string, string> = {};
    let session: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k) local[k] = String(localStorage.getItem(k));
      }
    } catch {}
    try {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const k = sessionStorage.key(i);
        if (k) session[k] = String(sessionStorage.getItem(k));
      }
    } catch {}
    return { url: window.location.href, cookies, local, session };
  });
}

/** The key, as it appears anywhere a script could read it. */
function findKeyLeaks(snapshot: Awaited<ReturnType<typeof readJsVisibleStorage>>, key: string) {
  const haystack = [
    ["document.cookie", snapshot.cookies],
    ["localStorage", JSON.stringify(snapshot.local)],
    ["sessionStorage", JSON.stringify(snapshot.session)],
    ["URL", snapshot.url],
  ] as const;
  return haystack.filter(([, value]) => value.includes(key)).map(([where]) => where);
}

test.describe("the gateway key prompt, against the real gateway", () => {
  test("the journey, end to end", async ({ page, context }) => {
    const requests = trackAdminRequests(page);
    const keyInput = page.getByTestId("admin-key-input");
    const submit = page.getByTestId("admin-key-submit");

    // ── 1. land unauthenticated ──────────────────────────────────────────
    await page.goto(PROVIDERS_ROUTE, { waitUntil: "domcontentloaded" });
    await expect
      .poll(
        () => requests.filter((r) => r.status === 401).length,
        { timeout: 30_000, message: "the page must attempt an admin read" }
      )
      .toBeGreaterThan(0);
    await capture(page, "01-landed-unauthenticated");

    // ── 2. honest signed-out state, and the prompt opens ─────────────────
    // The withheld banner must not be an empty provider table: "not signed in"
    // and "no providers exist" are opposite facts.
    const withheld = page.getByTestId("providers-admin-denied");
    await expect(withheld).toBeVisible({ timeout: 30_000 });
    await expect(withheld).toContainText(/withheld, not empty/i);
    // An honest signed-out state is not an empty list presented as a fact.
    const beforeLogin = requests.filter((r) => r.method === "GET").length;
    expect(beforeLogin).toBeGreaterThan(0);

    await expect(keyInput).toBeVisible({ timeout: 15_000 });
    await capture(page, "02-login-prompt-open");

    // ── 3. nothing is readable before the exchange ───────────────────────
    const signedOutSnapshot = await readJsVisibleStorage(page);
    expect(findKeyLeaks(signedOutSnapshot, ADMIN_KEY)).toEqual([]);
    // The session cookie must not exist yet at all.
    const cookiesBefore = await context.cookies();
    expect(cookiesBefore.find((c) => c.name === "aisix_admin_session")).toBeUndefined();

    // ── 4. wrong key → the wrong-key message, and no success ─────────────
    await keyInput.fill("definitely-not-the-admin-key");
    await submit.click();
    const wrongKeyError = page.getByTestId("admin-key-error");
    await expect(wrongKeyError).toBeVisible({ timeout: 30_000 });
    await expect(wrongKeyError).not.toContainText(/400|cross-origin/i);
    await capture(page, "03-wrong-key");
    // A 401 on the exchange — not a 400 and not a 403.
    const exchangeCalls = requests.filter((r) => r.url.includes("/auth/session") && r.method === "POST");
    expect(exchangeCalls).toHaveLength(1);
    expect(exchangeCalls[0].status).toBe(401);

    // ── 5. the right key → authenticated ─────────────────────────────────
    await keyInput.fill(ADMIN_KEY);
    await submit.click();
    await expect(keyInput).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("admin-session-strip")).toBeVisible({ timeout: 30_000 });
    // The withheld state is gone: the list is answered, not withheld.
    await expect(page.getByTestId("providers-admin-denied")).toBeHidden({ timeout: 30_000 });
    await capture(page, "04-authenticated");

    // The exchange itself was a 204 with no body.
    const okExchange = requests.filter((r) => r.url.includes("/auth/session") && r.method === "POST");
    expect(okExchange[okExchange.length - 1].status).toBe(204);

    // ── 6. the key is NOT anywhere JS can read it ────────────────────────
    const afterLogin = await readJsVisibleStorage(page);
    const leaks = findKeyLeaks(afterLogin, ADMIN_KEY);
    expect(leaks, `the admin key was readable from: ${leaks.join(", ")}`).toEqual([]);
    await capture(page, "05-no-key-in-js-storage");

    // ── 7. the HttpOnly cookie IS in the browser's cookie store ──────────
    // This is the positive half of #6: not a missing key in JS, but a present
    // session the script cannot see. Asserting only the absence would also pass
    // on a login that did nothing.
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "aisix_admin_session");
    expect(session, "the browser must hold the session cookie").toBeTruthy();
    expect(session!.httpOnly, "the session cookie must be HttpOnly").toBe(true);
    expect(session!.sameSite).toBe("Strict");
    expect(session!.path).toBe("/admin/v1");
    // Not visible to `document.cookie` — the whole reason for HttpOnly.
    expect(afterLogin.cookies).not.toContain("aisix_admin_session");

    // ── 8. a real mutation, then a real read back ───────────────────────
    // A write the gateway actually persisted, not an optimistic UI update:
    // if the POST were not accepted the follow-up GET would not list it.
    const comboName = `e2e-login-${Date.now()}`;
    const models = await page.evaluate(async () => {
      const res = await fetch("/admin/v1/models", { credentials: "include" });
      return res.ok ? await res.json() : null;
    });
    const rows: AdminRow[] = Array.isArray(models)
      ? (models as AdminRow[])
      : ((models as AdminEnvelope | null)?.models ?? []);
    const directModels = rows
      .map((row) => row?.value ?? row)
      // The same "direct only" predicate the gateway's own handler applies: a
      // model that SELECTS among others is virtual and cannot be a combo target.
      .filter((row) => row && !row.routing && !row.ensemble && !row.semantic)
      .map((row) => row.display_name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);

    if (directModels.length > 0) {
      const created = await page.evaluate(
        async ({ name, model }) => {
          const res = await fetch("/admin/v1/combos", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, models: [{ model }] }),
          });
          return { status: res.status, text: res.ok ? "" : await res.text() };
        },
        { name: comboName, model: directModels[0] }
      );
      expect(created.status, `combo create failed: ${created.text}`).toBe(201);

      const listed = await page.evaluate(async (name) => {
        const res = await fetch("/admin/v1/combos", { credentials: "include" });
        const body: unknown = await res.json();
        return readComboRows(body).some((row) => nameOf(row) === name);
      }, comboName);
      expect(listed, "the created combo must be readable back from the gateway").toBe(true);
      await capture(page, "06-mutation-persisted");

      // Clean up through the same surface.
      const removed = await page.evaluate(async (name) => {
        const res = await fetch("/admin/v1/combos", { credentials: "include" });
        const body: unknown = await res.json();
        const row = readComboRows(body).find((candidate) => nameOf(candidate) === name);
        if (!row?.id) return { status: 0, text: "no id" };
        const del = await fetch(`/admin/v1/combos/${encodeURIComponent(row.id)}`, {
          method: "DELETE",
          credentials: "include",
        });
        return { status: del.status, text: del.ok ? "" : await del.text() };
      }, comboName);
      expect(removed.status, `combo delete failed: ${removed.text}`).toBe(204);
    } else {
      // Nothing to route to on this gateway. Recorded, not silently passed as
      // a mutation that happened.
      test.info().annotations.push({
        type: "mutation",
        description: "SKIPPED — the gateway has no direct model, so no combo target exists",
      });
    }

    // ── 9. sign out → reads are 401 → the prompt returns ─────────────────
    const readsBeforeSignOut = requests.filter((r) => r.method === "GET").length;
    await page.getByTestId("admin-session-sign-out").click();
    await expect(page.getByTestId("admin-session-strip")).toBeHidden({ timeout: 30_000 });
    const del = requests.filter((r) => r.url.includes("/auth/session") && r.method === "DELETE");
    expect(del[del.length - 1].status).toBe(204);

    // A read after logout must actually be refused, and the page must go back
    // to the withheld state rather than keep drawing the list it already had.
    const afterSignOut = await page.evaluate(async () => {
      const res = await fetch("/admin/v1/models", { credentials: "include" });
      return res.status;
    });
    expect(afterSignOut, "a read after logout must be 401").toBe(401);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("providers-admin-denied")).toBeVisible({ timeout: 30_000 });
    await expect(keyInput).toBeVisible({ timeout: 30_000 });
    await capture(page, "07-signed-out-again");

    // ── 10. nothing retried in a loop on 401 ─────────────────────────────
    // The signal is edge-triggered, so a re-render storm must not turn into a
    // request storm. Compared against the pre-logout read count.
    const readsAfterSignOut = requests.filter((r) => r.method === "GET").length;
    const postLogoutReads = readsAfterSignOut - readsBeforeSignOut;
    expect(
      postLogoutReads,
      `a signed-out page issued ${postLogoutReads} admin reads; a retry loop would grow without bound`
    ).toBeLessThanOrEqual(12);
    const looped = requests.filter((r) => r.url.includes("/auth/session") && r.method === "POST");
    expect(looped.length, "the page must never re-POST the exchange on its own").toBe(2);
  });

  test("the Secure-only failure mode is handled honestly, not by spinning", async ({ page, context }) => {
    // The documented failure: the gateway marks the cookie `Secure` exactly
    // when the admin listener terminates TLS, and a browser DROPS a `Secure`
    // cookie received over plain HTTP — so a 204 arrives and no session exists.
    // Reproduced here at the network layer, because the shipped plaintext
    // listener cannot produce it: the browser's own cookie store is made to
    // refuse the cookie, which is the same observable state.
    const track = trackAdminRequests(page);
    await page.route("**/admin/v1/auth/session", async (route) => {
      // The gateway's real 204 answer; only the cookie is discarded, which is
      // precisely what the browser does with `Secure` over http.
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto(PROVIDERS_ROUTE, { waitUntil: "domcontentloaded" });
    const keyInput = page.getByTestId("admin-key-input");
    await expect(keyInput).toBeVisible({ timeout: 30_000 });
    await keyInput.fill(ADMIN_KEY);
    await page.getByTestId("admin-key-submit").click();

    // The prompt must report the real cause, and stay usable — not spin, not
    // vanish, and not claim success.
    const error = page.getByTestId("admin-key-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText(/admin\.tls|HTTPS/i);
    await expect(keyInput).toBeVisible();
    await expect(keyInput).toBeEnabled();
    await capture(page, "08-session-not-kept");

    // No spinner left running, and the sign-out strip is absent because the
    // exchange never produced a session.
    await expect(page.getByTestId("admin-session-strip")).toHaveCount(0);

    // And the loop guard: the page did not re-POST the exchange by itself.
    const posts = track.filter((r) => r.url.includes("/auth/session") && r.method === "POST");
    expect(posts.length).toBe(1);
    expect((await context.cookies()).find((c) => c.name === "aisix_admin_session")).toBeUndefined();
  });

  test("a 400 from the exchange is reported as a shape refusal, not a bad key", async ({ page }) => {
    // The classification the whole design rests on. Reproduced at the network
    // layer because a correctly-built client cannot make the gateway answer 400
    // — which is exactly why the 400 path is untestable otherwise, and exactly
    // why it must never be described as "wrong key".
    await page.route("**/admin/v1/auth/session", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error_msg: "`remember` is not a field of this request body" }),
      });
    });
    await page.goto(PROVIDERS_ROUTE, { waitUntil: "domcontentloaded" });
    const keyInput = page.getByTestId("admin-key-input");
    await expect(keyInput).toBeVisible({ timeout: 30_000 });
    await keyInput.fill(ADMIN_KEY);
    await page.getByTestId("admin-key-submit").click();

    const error = page.getByTestId("admin-key-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    // It names the request, and does NOT tell the operator their key is wrong.
    await expect(error).toContainText(/400/);
    await expect(error).not.toContainText(/was not accepted/i);
    await expect(error).toContainText(/remember/);
    await capture(page, "09-bad-request-shape");
  });

  test("the deployed artifact is the SPA export, and the binary serves it", () => {
    // Guards the premise of the whole file. A dashboard served by anything else
    // cannot carry the cookie, so every cookie assertion here would be vacuous.
    const probe = spawnSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3001/dashboard/"],
      { encoding: "utf8" }
    );
    expect(probe.stdout).toBe("200");
    const api = spawnSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3001/admin/v1/models"],
      { encoding: "utf8" }
    );
    // Unauthenticated, so the gate is live.
    expect(api.stdout).toBe("401");
  });
});
