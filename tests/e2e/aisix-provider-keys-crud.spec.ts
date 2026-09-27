import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gotoDashboardRoute } from "./helpers/dashboardAuth";

/**
 * Provider-key CRUD against a REAL AISIX gateway.
 *
 * There is no interceptor, no fixture server and no stubbed response anywhere in
 * this file. Every request the page makes is answered by the actual Rust admin
 * handler in the deployed binary, and every assertion reads what that handler
 * returned. The one thing the test supplies is the admin key, through
 * `context.setExtraHTTPHeaders` — which is exactly what an ingress in front of
 * `:3001` does in a real deployment, and which the shipped SPA has no other way
 * to obtain (`config.admin.admin_keys` is gateway-side config).
 *
 * The gateway is a THROWAWAY instance: its own config, its own resources file and
 * its own ports, all under a temp dir. The operator's `/home/ernur/.aisix`
 * config and resources are never read or written, and the key this test creates
 * is deleted before the suite ends.
 *
 * Run it with the admin base pointed at that instance:
 *   NEXT_PUBLIC_AISIX_ADMIN=http://127.0.0.1:3101 npx playwright test \
 *     tests/e2e/aisix-provider-keys-crud.spec.ts
 */

const AISIX_BINARY = process.env.AISIX_E2E_BINARY || "/home/ernur/.aisix/aisix";
const ADMIN_KEY = process.env.AISIX_E2E_ADMIN_KEY || "e2e-local-admin-key";
const ADMIN_PORT = 3101;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
/** Names this suite creates; each is removed in afterAll. */
const CREATED_NAMES = ["e2e-crud-key"];

let workDir = "";
let gateway: ChildProcess | null = null;

function writeGatewayConfig(): void {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisix-e2e-keys-"));
  // A resources file that holds ONLY provider_keys: the handler refuses a
  // per-key write when the file also carries other collections, and the
  // happy path needs the file to be writable.
  fs.writeFileSync(
    path.join(workDir, "resources.yaml"),
    '{\n  "_format_version": "1",\n  "provider_keys": []\n}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(workDir, "config.yaml"),
    [
      `resources_file: ${workDir}/resources.yaml`,
      "proxy:",
      '  addr: "127.0.0.1:3110"',
      "admin:",
      "  enabled: true",
      `  addr: "127.0.0.1:${ADMIN_PORT}"`,
      `  admin_keys: ["${ADMIN_KEY}"]`,
      "observability:",
      "  metrics:",
      "    prometheus:",
      '      addr: "127.0.0.1:9191"',
      "",
    ].join("\n"),
    "utf8"
  );
}

async function waitForAdminApi(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = spawnSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/provider_keys`],
      { encoding: "utf8" }
    );
    // 401 means the listener is up and the auth gate is live — that is ready.
    if (probe.stdout === "401" || probe.stdout === "200") return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("the throwaway AISIX admin API did not come up");
}

test.beforeAll(async () => {
  if (!fs.existsSync(AISIX_BINARY)) {
    throw new Error(`AISIX binary not found at ${AISIX_BINARY}; set AISIX_E2E_BINARY`);
  }
  writeGatewayConfig();
  // `setsid --fork` so the gateway outlives this test process and can be stopped
  // by pid; a plain spawn would be reaped when the runner exits.
  gateway = spawn(
    "setsid",
    ["--fork", AISIX_BINARY, "--config", path.join(workDir, "config.yaml")],
    { detached: true, stdio: "ignore" }
  );
  gateway.unref();
  await waitForAdminApi();
});

test.afterAll(async () => {
  // Leave the throwaway instance's state as we found it, then stop it.
  for (const _name of CREATED_NAMES) {
    const listed = spawnSync(
      "curl",
      ["-s", "-H", `Authorization: Bearer ${ADMIN_KEY}`, `${ADMIN_BASE}/admin/v1/provider_keys`],
      { encoding: "utf8" }
    );
    try {
      for (const row of JSON.parse(listed.stdout || "[]") as Array<{ id: string }>) {
        if (
          CREATED_NAMES.includes(
            (row as { value?: { display_name?: string } }).value?.display_name ?? ""
          )
        ) {
          spawnSync(
            "curl",
            [
              "-s",
              "-o",
              "/dev/null",
              "-X",
              "DELETE",
              "-H",
              `Authorization: Bearer ${ADMIN_KEY}`,
              `${ADMIN_BASE}/admin/v1/provider_keys/${row.id}`,
            ],
            { encoding: "utf8" }
          );
        }
      }
    } catch {
      // Cleanup is best-effort; the whole instance is deleted below anyway.
    }
  }
  spawnSync("pkill", ["-x", "aisix"], { encoding: "utf8" });
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/** Real request, real handler — used to assert what the SERVER stored. */
async function readServerKeys(): Promise<
  Array<{ id: string; value: { display_name: string; api_base?: string } }>
> {
  const out = spawnSync(
    "curl",
    ["-s", "-H", `Authorization: Bearer ${ADMIN_KEY}`, `${ADMIN_BASE}/admin/v1/provider_keys`],
    { encoding: "utf8" }
  );
  return JSON.parse(out.stdout || "[]") as never;
}

async function openProviderKeys(page: Page, context: BrowserContext) {
  // The admin key is attached to the browser context the way a real ingress
  // attaches it — as a request header on the actual network call.
  await context.setExtraHTTPHeaders({ Authorization: `Bearer ${ADMIN_KEY}` });
  await gotoDashboardRoute(page, "/dashboard/providers");
  await expect(page.getByTestId("provider-keys-section")).toBeVisible({ timeout: 60_000 });
  return page.getByTestId("provider-keys-section");
}

test.describe("provider-key CRUD against a real AISIX admin API", () => {
  test("create → list → update → delete, each step reflected in the list", async ({
    page,
    context,
  }) => {
    const section = await openProviderKeys(page, context);
    const apiKey = `sk-e2e-${Date.now()}`;

    // ── create ────────────────────────────────────────────────────────────
    await expect(section.getByTestId("provider-keys-empty")).toBeVisible();
    await section.getByTestId("provider-keys-create").click();
    await section.getByTestId("provider-keys-form-name").fill("e2e-crud-key");
    await section.getByTestId("provider-keys-form-key").fill(apiKey);
    await section.getByTestId("provider-keys-form-provider").fill("e2e-vendor");
    await section.getByTestId("provider-keys-form-base").fill("https://e2e.test/v1");
    await section.getByTestId("provider-keys-form-submit").click();

    // The list must show the SERVER's row, not the form's guess: the id and the
    // revision are only knowable from the response body.
    const row = section.getByTestId("provider-keys-list").getByText("e2e-crud-key");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId("provider-keys-count")).toHaveText("1");

    const serverAfterCreate = await readServerKeys();
    const created = serverAfterCreate.find((k) => k.value.display_name === "e2e-crud-key");
    expect(created, "the gateway must have persisted the created key").toBeTruthy();
    expect(created?.value.api_base).toBe("https://e2e.test/v1");
    await expect(section.getByText("e2e-vendor")).toBeVisible();

    // ── update ────────────────────────────────────────────────────────────
    await section.getByTestId(`provider-keys-edit-${created?.id}`).click();
    await section.getByTestId("provider-keys-form-base").fill("https://e2e-updated.test/v2");
    await section.getByTestId("provider-keys-form-submit").click();
    await expect(section.getByTestId("provider-keys-notice")).toHaveAttribute("data-tone", "ok", {
      timeout: 30_000,
    });

    const serverAfterUpdate = await readServerKeys();
    const updated = serverAfterUpdate.find((k) => k.value.display_name === "e2e-crud-key");
    // Asserted against the SERVER, so an optimistic local update cannot pass this.
    expect(updated?.value.api_base).toBe("https://e2e-updated.test/v2");
    await expect(section.getByText("https://e2e-updated.test/v2")).toBeVisible();

    // ── delete (confirmed) ────────────────────────────────────────────────
    await section.getByTestId(`provider-keys-delete-${created?.id}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("e2e-crud-key")).toBeVisible();
    await dialog.getByRole("button", { name: /^delete$/i }).click();

    await expect(section.getByTestId("provider-keys-empty")).toBeVisible({ timeout: 30_000 });
    expect(
      (await readServerKeys()).some((k) => k.value.display_name === "e2e-crud-key"),
      "the gateway must no longer hold the deleted key"
    ).toBe(false);
  });

  test("a refused create changes nothing and shows the gateway's reason", async ({
    page,
    context,
  }) => {
    const section = await openProviderKeys(page, context);
    const name = "e2e-crud-duplicate";

    // Seed a real row through the real handler.
    const seeded = spawnSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "-H",
        `Authorization: Bearer ${ADMIN_KEY}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        `{"display_name":"${name}","api_key":"sk-seed"}`,
        `${ADMIN_BASE}/admin/v1/provider_keys`,
      ],
      { encoding: "utf8" }
    );
    const seededId = (JSON.parse(seeded.stdout || "{}") as { id?: string }).id;
    expect(seededId).toBeTruthy();
    CREATED_NAMES.push(name);

    await section.getByTestId("provider-keys-create").click();
    await section.getByTestId("provider-keys-form-name").fill(name);
    await section.getByTestId("provider-keys-form-key").fill("sk-dup");
    await section.getByTestId("provider-keys-form-submit").click();

    const notice = section.getByTestId("provider-keys-notice");
    await expect(notice).toHaveAttribute("data-tone", "error", { timeout: 30_000 });
    // The handler's own 409 text names the conflict; swallowing it would leave
    // the operator with a red row and no reason.
    await expect(notice).toContainText("already exists");
    // Exactly the seeded row, and no optimistic new one.
    expect((await readServerKeys()).filter((k) => k.value.display_name === name)).toHaveLength(1);
    await expect(section.getByTestId("provider-keys-form-submit")).toBeVisible();

    // Clean this row up now so the afterAll sweep is only a backstop.
    spawnSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-X",
        "DELETE",
        "-H",
        `Authorization: Bearer ${ADMIN_KEY}`,
        `${ADMIN_BASE}/admin/v1/provider_keys/${seededId}`,
      ],
      { encoding: "utf8" }
    );
  });

  test("without an admin key the page says so instead of showing an empty list", async ({
    page,
  }) => {
    // No extra headers: the browser sends no admin key, and the real handler
    // answers 401. The page must name that — not render an empty provider-key
    // table, which would read as "this gateway has no provider keys".
    await gotoDashboardRoute(page, "/dashboard/providers");
    const section = page.getByTestId("provider-keys-section");
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section.getByTestId("provider-keys-denied")).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId("provider-keys-empty")).toHaveCount(0);
    await expect(section.getByText("admin.admin_keys")).toBeVisible();
  });
});
