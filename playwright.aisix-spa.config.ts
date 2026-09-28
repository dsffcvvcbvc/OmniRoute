import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the AISIX-hosted dashboard SPA (static export).
 *
 * This is a SEPARATE config from `playwright.config.ts` on purpose. That one
 * boots a Next.js dev server and runs `tests/e2e/**`; these specs drive a real
 * deployed AISIX gateway and live in `tests/aisix-spa-e2e/`, outside the
 * dev-server `testDir`, so `npm run test:e2e` can never pick them up.
 *
 * ── How to run (see tests/aisix-spa-e2e/README.md for the full recipe) ──────
 *
 *   # 1. deploy the export artifact somewhere outside the repo
 *   curl -L -H "Authorization: Bearer $GH_TOKEN" \
 *     "https://api.github.com/repos/dsffcvvcbvc/OmniRoute/actions/artifacts/10932864997/zip" \
 *     -o /tmp/opencode/dashboard-out.zip
 *   unzip -q /tmp/opencode/dashboard-out.zip -d ~/.aisix/dashboard
 *
 *   # 2. start the gateway (admin :3001 serves the dashboard same-origin)
 *   pkill -x aisix
 *   AISIX_DASHBOARD_DIR=$HOME/.aisix/dashboard setsid --fork \
 *     /home/ernur/.aisix/aisix --config /home/ernur/.aisix/config.yaml \
 *     > /tmp/aisix.log 2>&1 < /dev/null
 *
 *   # 3. run the suite
 *   AISIX_SPA_ADMIN_KEY="$(read from ~/.aisix/config.yaml admin.admin_keys)" \
 *     npx playwright test -c playwright.aisix-spa.config.ts
 *
 *   Env:
 *     AISIX_SPA_BASE_URL    gateway admin origin            (default http://127.0.0.1:3001)
 *     AISIX_SPA_ADMIN_KEY   admin.admin_keys[0]             (optional: without it the
 *                           signed-out states are what gets asserted)
 *
 *   Stop the gateway with `pkill -x aisix` — NEVER `pkill -f aisix`, whose
 *   pattern also matches the invoking shell and kills the session.
 *
 * ── trace is off on purpose ─────────────────────────────────────────────────
 * The suite attaches the admin key as a request header (scoped to the admin
 * origin — see `authenticate` in harness.ts), and a Playwright trace archives
 * request headers verbatim. A trace uploaded or attached to an issue would
 * therefore carry a live gateway credential, so the suite records its own
 * scrubbed JSON evidence instead (see `writeEvidence` in harness.ts) and never
 * writes the key to disk. The scoping does not make this safe to turn on: the
 * header is still on every request the authenticated tests make to the admin
 * plane.
 */
const baseURL = process.env.AISIX_SPA_BASE_URL || "http://127.0.0.1:3001";

export default defineConfig({
  testDir: "./tests/aisix-spa-e2e",
  testMatch: "**/*.spec.ts",
  // `negative-controls.spec.ts` is NOT excluded. It used to be, behind
  // AISIX_SPA_NEGATIVE_CONTROLS, because every control in it was an inverted
  // assertion and therefore red on a healthy deployment — which also meant a
  // green run said nothing about whether the falsifiability audit had run at
  // all. The controls are now green on a healthy deployment and red on a
  // broken one (each one injects the fault it exists to catch and requires the
  // production verdict to reject it), so they belong in every pass. A green run
  // of this suite has audited itself.
  // One worker: the gateway is a single shared instance and the dashboard
  // pages are heavy enough that a second Chromium on this host tips it over.
  workers: 1,
  fullyParallel: false,
  // Generous per-test budget. A deep route under the current host takes 6-20 s
  // just to reach a settled content region, and one of these tests opens three
  // pages in sequence.
  timeout: 240_000,
  expect: { timeout: 45_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["line"], ["json", { outputFile: "aisix-spa-results.json" }]]
    : [["list"]],
  use: {
    baseURL,
    navigationTimeout: 90_000,
    // Trace would archive the admin key (see header). Evidence is written by
    // the suite itself, scrubbed.
    trace: "off",
    screenshot: "only-on-failure",
    // A renderer on a memory-starved host dies faster with a video encoder
    // attached than without one.
    launchOptions: { args: ["--disable-dev-shm-usage"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
