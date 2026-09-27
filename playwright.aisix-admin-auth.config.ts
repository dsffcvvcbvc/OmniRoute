import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the AISIX gateway-login journey.
 *
 * Separate from `playwright.config.ts` because that one starts a Next dev
 * server: this journey must run against the STATIC EXPORT served BY the Rust
 * binary, on the same origin as the Admin API. That origin coincidence is the
 * whole subject — the session cookie is scoped to `/admin/v1` on the host that
 * serves the dashboard, so a dashboard on `localhost:20128` talking to a
 * gateway on `127.0.0.1:3001` is a different origin and can never carry the
 * cookie. Running the real artifact on the real listener is the only way the
 * assertion means anything.
 *
 * The gateway is expected to be running already:
 *   AISIX_DASHBOARD_DIR=/path/to/out \
 *     setsid --fork /home/ernur/.aisix/aisix --config ~/.aisix/config.yaml
 *   npx playwright test --config playwright.aisix-admin-auth.config.ts
 */

const ADMIN_PORT = process.env.AISIX_ADMIN_PORT || "3001";
const dashboardBaseUrl = process.env.AISIX_DASHBOARD_URL || `http://127.0.0.1:${ADMIN_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/aisix-admin-login.spec.ts"],
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    baseURL: dashboardBaseUrl,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
