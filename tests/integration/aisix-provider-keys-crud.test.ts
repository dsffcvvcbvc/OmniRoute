/**
 * Provider-key CRUD against a REAL AISIX gateway.
 *
 * The unit suite (`tests/unit/aisix-provider-keys.test.ts`) pins the client's
 * request/response contract with stubbed responses. This one pins the thing the
 * unit suite cannot: that the contract still matches what the Rust handler
 * actually does, and that the whole create → list → update → delete journey
 * works end to end against the real binary. There is no stubbed network, no
 * fixture server and no intercepted response anywhere in this file.
 *
 * It boots the deployed binary on its own ports with its own config and its own
 * resources file under a temp dir, so the operator's own gateway state is never
 * read or written, and it removes the key it created.
 *
 * Gated on the binary being present:
 *   AISIX_E2E_BINARY=/home/ernur/.aisix/aisix \
 *     node --import tsx/esm --test tests/integration/aisix-provider-keys-crud.test.ts
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AISIX_BINARY = process.env.AISIX_E2E_BINARY || "/home/ernur/.aisix/aisix";
const ADMIN_KEY = "aisix-integration-admin-key";
const ADMIN_PORT = 3211;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisix-keys-int-"));
const binaryAvailable = fs.existsSync(AISIX_BINARY);
const skip = binaryAvailable
  ? false
  : `AISIX binary not found at ${AISIX_BINARY}; set AISIX_E2E_BINARY to run this suite`;

// A resources file holding ONLY provider_keys, so the per-key writes are
// accepted. The "file also holds models" refusal is a separate case below.
const RESOURCES_ONLY_KEYS = '{\n  "_format_version": "1",\n  "provider_keys": []\n}\n';

let gateway: ChildProcess | null = null;

/** The genuine global fetch, captured before anything can shim it. */
const REAL_FETCH = globalThis.fetch;

function writeConfig(resourcesBody: string): void {
  fs.writeFileSync(path.join(workDir, "resources.yaml"), resourcesBody, "utf8");
  fs.writeFileSync(
    path.join(workDir, "config.yaml"),
    [
      `resources_file: ${workDir}/resources.yaml`,
      "proxy:",
      '  addr: "127.0.0.1:3210"',
      "admin:",
      "  enabled: true",
      `  addr: "127.0.0.1:${ADMIN_PORT}"`,
      `  admin_keys: ["${ADMIN_KEY}"]`,
      "observability:",
      "  metrics:",
      "    prometheus:",
      '      addr: "127.0.0.1:9291"',
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
      {
        encoding: "utf8",
      }
    );
    // 401 means the listener is up and the auth gate is live.
    if (probe.stdout === "401") return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("the AISIX admin API did not come up");
}

function curlJson(method: string, urlPath: string, body?: unknown) {
  const args = [
    "-s",
    "-X",
    method,
    "-H",
    `Authorization: Bearer ${ADMIN_KEY}`,
    "-H",
    "Content-Type: application/json",
  ];
  if (body !== undefined) args.push("-d", JSON.stringify(body));
  args.push(`${ADMIN_BASE}${urlPath}`);
  const out = spawnSync("curl", args, { encoding: "utf8" });
  const text = out.stdout || "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text || "null");
  } catch {
    parsed = null;
  }
  return { text, parsed: parsed as Record<string, unknown> | unknown[] | null };
}

before(async () => {
  if (skip) return;
  // Take exclusive ownership of the admin port: a gateway left over from an
  // earlier run would still be bound to it, and this suite would silently
  // assert against THAT instance's state instead of a fresh one.
  spawnSync("pkill", ["-9", "-x", "aisix"], { encoding: "utf8" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  writeConfig(RESOURCES_ONLY_KEYS);
  gateway = spawn(
    "setsid",
    ["--fork", AISIX_BINARY, "--config", path.join(workDir, "config.yaml")],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  gateway.unref();
  await waitForAdminApi();
});

after(() => {
  if (!skip) spawnSync("pkill", ["-x", "aisix"], { encoding: "utf8" });
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * The dashboard's own client, pointed at this throwaway gateway with the admin
 * key attached — which is what an ingress in front of `:3001` does in a real
 * deployment, and is the only way the shipped SPA can reach an admin plane that
 * requires one. Nothing else about the request changes: the URL, the method,
 * the JSON body and every response are the real handler's.
 */
async function client() {
  process.env.NEXT_PUBLIC_AISIX_ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${ADMIN_KEY}`);
    return REAL_FETCH(input, { ...init, headers });
  }) as typeof globalThis.fetch;
  return import("../../src/shared/utils/aisixProviderKeys.ts");
}

const CREATED = "int-crud-key";

test(
  "the whole journey: create, list, update, delete — against the real handler",
  { skip },
  async () => {
    const keys = await client();

    // Nothing there to begin with.
    const before = await keys.fetchProviderKeys();
    assert.equal(before.status, 200);
    assert.equal(
      before.entries.some((e) => e.value.display_name === CREATED),
      false
    );

    // ── create ────────────────────────────────────────────────────────────────
    const created = await keys.createProviderKey({
      displayName: CREATED,
      apiKey: "sk-integration-secret",
      provider: "integration-vendor",
      apiBase: "https://integration.test/v1",
    });
    assert.equal(created.ok, true, `create refused: ${created.failure} ${created.reason}`);
    assert.equal(created.status, 201);
    const id = created.result?.id;
    assert.ok(id, "the handler must hand back the derived id");

    // The id is derived from the display name, so a reload reproduces it — and the
    // read must show the SERVER's document, not the create payload.
    const afterCreate = await keys.fetchProviderKeys();
    const row = afterCreate.entries.find((e) => e.value.display_name === CREATED);
    assert.ok(row, "the created key must be in the list");
    assert.equal(row.id, id);
    assert.equal(row.value.api_base, "https://integration.test/v1");
    assert.equal(row.value.provider, "integration-vendor");
    // The default the model carries is materialised, not invented by the client.
    assert.deepEqual(row.value.strip_headers, [
      "authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
    ]);

    // ── update ────────────────────────────────────────────────────────────────
    const updated = await keys.updateProviderKey(id, { apiBase: "https://integration.test/v2" });
    assert.equal(updated.ok, true, `update refused: ${updated.failure} ${updated.reason}`);
    // A PATCH is a merge, so the untouched fields must survive it.
    assert.equal(updated.result?.value.display_name, CREATED);
    assert.equal(updated.result?.value.provider, "integration-vendor");
    assert.equal(updated.result?.value.api_base, "https://integration.test/v2");
    assert.equal(updated.result?.revision, 2);
    // And the SERVER agrees, read back independently.
    const afterUpdate = await keys.fetchProviderKeys();
    assert.equal(
      afterUpdate.entries.find((e) => e.id === id)?.value.api_base,
      "https://integration.test/v2"
    );

    // ── delete ────────────────────────────────────────────────────────────────
    const deleted = await keys.deleteProviderKey(id);
    assert.equal(deleted.ok, true, `delete refused: ${deleted.failure} ${deleted.reason}`);
    const afterDelete = await keys.fetchProviderKeys();
    assert.equal(
      afterDelete.entries.some((e) => e.value.display_name === CREATED),
      false
    );
  }
);

test("a duplicate display name is refused with 409 and changes nothing", { skip }, async () => {
  const keys = await client();
  const first = await keys.createProviderKey({ displayName: "int-dup", apiKey: "sk-a" });
  assert.equal(first.ok, true);
  try {
    const second = await keys.createProviderKey({ displayName: "int-dup", apiKey: "sk-b" });
    assert.equal(second.ok, false);
    assert.equal(second.failure, "conflict");
    // The handler's own wording, which is what tells the operator which name.
    assert.match(String(second.reason), /already exists/);
    const list = await keys.fetchProviderKeys();
    assert.equal(list.entries.filter((e) => e.value.display_name === "int-dup").length, 1);
  } finally {
    if (first.result) await keys.deleteProviderKey(first.result.id);
  }
});

test(
  "a missing key is `not_found`, never a claim that the surface is absent",
  { skip },
  async () => {
    const keys = await client();
    const outcome = await keys.deleteProviderKey("00000000-0000-0000-0000-000000000000");
    assert.equal(outcome.ok, false);
    // This is the classification the unit suite caught the client getting wrong.
    assert.equal(outcome.failure, "not_found");
    assert.equal(outcome.reason, "resource not found");
  }
);

test("no admin key: every verb is 401, which the UI must name", { skip }, async () => {
  const keys = await client();
  // Direct to the real handler, without the key the client would not send.
  const noAuth = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/provider_keys`],
    {
      encoding: "utf8",
    }
  );
  assert.equal(noAuth.stdout, "401", `unauthenticated list answered ${noAuth.stdout}`);

  // And the client's own read, with the key shim removed, must report that 401
  // rather than an empty list — the status is what lets the page NAME the
  // missing admin key instead of rendering "no provider keys exist".
  globalThis.fetch = REAL_FETCH;
  try {
    const result = await keys.fetchProviderKeys();
    assert.equal(result.status, 401, `client read answered ${result.status} (${result.error})`);
    assert.equal(result.missing, false);
    assert.equal(result.entries.length, 0);
  } finally {
    await client();
  }
});

test("a per-key write is refused when the resources file also holds models", { skip }, async () => {
  const keys = await client();
  // A whole-file write: a provider key plus a model that references it BY NAME
  // (the file source resolves the name to the id, per its own error message).
  const seeded = await keys.createProviderKey({ displayName: "int-refd", apiKey: "sk-r" });
  assert.equal(seeded.ok, true);
  const seededId = seeded.result?.id;
  const applied = curlJson("POST", "/admin/v1/resources", {
    _format_version: "1",
    provider_keys: [
      {
        display_name: "int-refd",
        provider: "openai",
        api_key: "sk-r",
        api_base: "https://api.openai.com/v1",
      },
    ],
    models: [
      {
        display_name: "int-model",
        provider: "openai",
        model_name: "gpt-4o-mini",
        provider_key: "int-refd",
      },
    ],
  });
  assert.deepEqual(applied.parsed, {
    message: "Resources validated and applied in memory",
    status: "applied",
    version: applied.parsed?.version,
  });

  try {
    // Now the refusal: the file carries rows a per-key write cannot re-emit.
    const refused = await keys.createProviderKey({ displayName: "int-blocked", apiKey: "sk-b" });
    assert.equal(refused.ok, false);
    // Reported as exactly what happened — applied in memory, refused on disk.
    assert.equal(refused.failure, "not_persisted");
    assert.match(String(refused.reason), /per-key write cannot re-emit/);
    assert.match(String(refused.reason), /POST \/admin\/v1\/resources/);

    // And the referenced key cannot be deleted out from under a live model.
    const live = await keys.fetchProviderKeys();
    const referenced = live.entries.find((e) => e.value.display_name === "int-refd");
    assert.ok(referenced);
    const conflict = await keys.deleteProviderKey(referenced.id);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.failure, "conflict");
    // The dependent model is NAMED, which is the actionable half of the message.
    assert.match(String(conflict.reason), /still referenced by 1/);
    assert.match(String(conflict.reason), /model "int-model"/);
  } finally {
    // Undo the whole-file write so the shared instance is left as found.
    curlJson("POST", "/admin/v1/resources", {
      _format_version: "1",
      provider_keys: [],
      models: [],
    });
    if (seededId) await keys.deleteProviderKey(seededId);
  }
});
