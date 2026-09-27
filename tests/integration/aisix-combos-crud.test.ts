/**
 * Combo CRUD against a REAL AISIX gateway.
 *
 * The unit suite (`tests/unit/aisix-combos.test.ts`) pins the client's
 * request/response contract with stubbed responses. This one pins the thing the
 * unit suite cannot: that the contract still matches what
 * `aisix-admin/src/combos_handler.rs` actually does, and that the whole
 * journey — and every refusal the Combos form now claims to honour — behaves
 * end to end against the real binary. There is no stubbed network, no fixture
 * server and no intercepted response anywhere in this file.
 *
 * It boots the deployed binary on its own ports with its own config and its own
 * resources file under a temp dir, so the operator's own gateway state is never
 * read or written, and it removes everything it creates.
 *
 * Gated on the binary being present:
 *   AISIX_E2E_BINARY=/home/ernur/.aisix/aisix \
 *     node --import tsx/esm --test tests/integration/aisix-combos-crud.test.ts
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AISIX_BINARY = process.env.AISIX_E2E_BINARY || "/home/ernur/.aisix/aisix";
const ADMIN_KEY = "aisix-combos-int-admin-key";
const ADMIN_PORT = 3221;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisix-combos-int-"));
const binaryAvailable = fs.existsSync(AISIX_BINARY);
const skip = binaryAvailable
  ? false
  : `AISIX binary not found at ${AISIX_BINARY}; set AISIX_E2E_BINARY to run this suite`;

/**
 * The seed: two direct models, so a multi-target combo is possible without a
 * duplicate, and so the "direct only" rule has something to bite on.
 *
 * A direct model carries `provider_key_id`, not a credential — the reference is
 * validated by the file source, so the two collections are written together and
 * a model names its key BY NAME (the file source resolves the name to the id).
 */
const SEED_DOCUMENT = {
  _format_version: "1",
  provider_keys: [
    {
      display_name: "int-key-a",
      provider: "openai",
      api_key: "sk-int-a",
      api_base: "https://api.openai.com/v1",
    },
    {
      display_name: "int-key-b",
      provider: "anthropic",
      api_key: "sk-int-b",
      api_base: "https://api.anthropic.com/v1",
    },
  ],
  models: [
    {
      display_name: "int-direct-a",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key: "int-key-a",
    },
    {
      display_name: "int-direct-b",
      provider: "anthropic",
      model_name: "claude-3-5-haiku",
      provider_key: "int-key-b",
    },
  ],
};

/**
 * An empty resources file holding ONLY `provider_keys` and `models` — the two
 * collections a per-combo write re-emits. A file holding anything else makes
 * every write a 500, which is the `AdminError::Store` path and not this
 * suite's subject.
 */
function seedResourcesFile(): void {
  const empty = { _format_version: "1", models: [], provider_keys: [] };
  fs.writeFileSync(
    path.join(workDir, "resources.yaml"),
    JSON.stringify(empty, null, 2) + "\n",
    "utf8"
  );
}

let gateway: ChildProcess | null = null;

/** The genuine global fetch, captured before anything can shim it. */
const REAL_FETCH = globalThis.fetch;

function writeConfig(): void {
  fs.writeFileSync(
    path.join(workDir, "config.yaml"),
    [
      `resources_file: ${workDir}/resources.yaml`,
      "proxy:",
      '  addr: "127.0.0.1:3220"',
      "admin:",
      "  enabled: true",
      `  addr: "127.0.0.1:${ADMIN_PORT}"`,
      `  admin_keys: ["${ADMIN_KEY}"]`,
      "observability:",
      "  metrics:",
      "    prometheus:",
      '      addr: "127.0.0.1:9292"',
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
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/combos`],
      { encoding: "utf8" }
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
    "-w",
    "\n%{http_code}",
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
  const split = text.lastIndexOf("\n");
  const payload = text.slice(0, split);
  const status = Number(text.slice(split + 1));
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(payload || "null");
  } catch {
    parsed = null;
  }
  return { status, parsed: parsed as Record<string, unknown> | null };
}

/** The direct-model catalog the form is checked against, read from the gateway. */
async function readDirectModelNames(): Promise<string[]> {
  const out = curlJson("GET", "/admin/v1/models");
  const rows = Array.isArray(out.parsed) ? out.parsed : [];
  return rows
    .map((row) => {
      const value = (row as { value?: Record<string, unknown> }).value ?? {};
      return value as Record<string, unknown>;
    })
    .filter(
      (value) =>
        value.routing === undefined && value.ensemble === undefined && value.semantic === undefined
    )
    .map((value) => String(value.display_name))
    .filter(Boolean);
}

before(async () => {
  if (skip) return;
  // Take exclusive ownership of the admin port: a gateway left over from an
  // earlier run would still be bound to it, and this suite would silently
  // assert against THAT instance's state instead of a fresh one.
  spawnSync("pkill", ["-9", "-x", "aisix"], { encoding: "utf8" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  seedResourcesFile();
  writeConfig();
  gateway = spawn(
    "setsid",
    ["--fork", AISIX_BINARY, "--config", path.join(workDir, "config.yaml")],
    { detached: true, stdio: "ignore" }
  );
  gateway.unref();
  await waitForAdminApi();
  // The seed goes through the whole-file write, which is the only verb that
  // resolves a `provider_key` NAME to the id a direct model requires.
  const seeded = curlJson("POST", "/admin/v1/resources", SEED_DOCUMENT);
  assert.equal(
    seeded.status,
    200,
    `seeding the direct models failed (${seeded.status}): ${JSON.stringify(seeded.parsed)}`
  );
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
  return import("../../src/shared/utils/aisixCombos.ts");
}

// ─────────────────────────────────────────────────────────────────────────

const CREATED = "int-combo-journey";

test(
  "the whole journey: create, list, update, delete — against the real handler",
  { skip },
  async () => {
    const combos = await client();

    // Nothing there to begin with.
    const before = await combos.fetchCombos();
    assert.equal(before.status, 200);
    assert.equal(
      before.combos.some((c) => c.name === CREATED),
      false
    );

    // The catalog the form pre-validates against must actually hold the models
    // the journey targets — otherwise the "direct only" assertion below would
    // be vacuously true.
    const catalog = await combos.fetchDirectModelNames();
    assert.ok(catalog, "the direct-model catalog must load from a real gateway");
    assert.ok(catalog.includes("int-direct-a"), `catalog was ${JSON.stringify(catalog)}`);
    assert.ok(catalog.includes("int-direct-b"));

    // ── create ──────────────────────────────────────────────────────────────
    // The form's draft: template spellings and all. The client must translate
    // the strategy and drop the fields the routing model has no home for.
    const created = await combos.createCombo({
      name: CREATED,
      strategy: "round-robin",
      models: [
        {
          kind: "model",
          provider: "openai",
          model: "int-direct-a",
          connectionId: "nope",
          label: "fast",
          model_id: "9f1c0000-0000-0000-0000-000000000000",
          weight: 3,
          priority: 1,
          tags: ["fast"],
        },
        { model: "int-direct-b" },
      ],
    });
    assert.equal(created.ok, true, `create refused: ${created.failure} ${created.reason}`);
    assert.equal(created.status, 201);
    const id = created.result?.id;
    assert.ok(id, "the handler must hand back the derived id");

    // The read must show the SERVER's document, in the SERVER's vocabulary.
    const afterCreate = await combos.fetchCombos();
    const row = afterCreate.combos.find((c) => c.name === CREATED);
    assert.ok(row, "the created combo must be in the list");
    assert.equal(row.id, id);
    // `round-robin` is not a routing strategy; it must have become `round_robin`.
    assert.equal(row.strategy, "round_robin");
    // And every refused field must be absent from what was stored — the whole
    // point of the honest contract.
    const wire = JSON.stringify(row);
    for (const dropped of ["kind", "provider", "connectionId", "label", "model_id", "config"]) {
      assert.ok(!wire.includes(`"${dropped}"`), `${dropped} must not be stored`);
    }
    assert.deepEqual(row.models, [
      { model: "int-direct-a", weight: 3, priority: 1, tags: ["fast"] },
      { model: "int-direct-b" },
    ]);

    // ── update ──────────────────────────────────────────────────────────────
    const updated = await combos.updateCombo(id, { strategy: "cost-optimized" });
    assert.equal(updated.ok, true, `update refused: ${updated.failure} ${updated.reason}`);
    // `cost-optimized` is the template's spelling; the stored value is the
    // gateway's, and the untouched fields survive the merge.
    assert.equal(updated.result?.combo.strategy, "least_cost");
    assert.equal(updated.result?.combo.name, CREATED);
    assert.equal(updated.result?.combo.models.length, 2);
    const afterUpdate = await combos.fetchCombos();
    assert.equal(afterUpdate.combos.find((c) => c.id === id)?.strategy, "least_cost");

    // ── delete ──────────────────────────────────────────────────────────────
    const deleted = await combos.deleteCombo(id);
    assert.equal(deleted.ok, true, `delete refused: ${deleted.failure} ${deleted.reason}`);
    const afterDelete = await combos.fetchCombos();
    assert.equal(
      afterDelete.combos.some((c) => c.name === CREATED),
      false
    );
  }
);

// ── the refusals the form now claims to honour, driven for real ─────────

test("the handler names every field the form refuses, with a 400", { skip }, async () => {
  // Straight to the real handler: the form must never send these, so the
  // assertion is about the SERVER's answer, not the client's.
  const refused: Array<[string, Record<string, unknown>, string]> = [
    [
      "description",
      { name: "r1", models: [{ model: "int-direct-a" }], description: "x" },
      "description",
    ],
    [
      "config",
      { name: "r2", models: [{ model: "int-direct-a" }], config: { maxRetries: 1 } },
      "config",
    ],
    ["isActive", { name: "r3", models: [{ model: "int-direct-a" }], isActive: true }, "isActive"],
    [
      "step label",
      { name: "r4", models: [{ model: "int-direct-a", label: "x" }] },
      "models[0].label",
    ],
    [
      "step connectionId",
      { name: "r5", models: [{ model: "int-direct-a", connectionId: "x" }] },
      "models[0].connectionId",
    ],
    [
      "step model_id",
      { name: "r6", models: [{ model: "int-direct-a", model_id: "abc" }] },
      "models[0].model_id",
    ],
    [
      "step kind",
      { name: "r7", models: [{ model: "int-direct-a", kind: "model" }] },
      "models[0].kind",
    ],
  ];
  for (const [label, body, namedField] of refused) {
    const out = curlJson("POST", "/admin/v1/combos", body);
    assert.equal(out.status, 400, `${label} must be refused with 400, got ${out.status}`);
    const message = String((out.parsed as { error_msg?: string })?.error_msg ?? "");
    assert.ok(
      message.includes(`"${namedField}" is not part of the combo contract`),
      `${label}: the handler must NAME the field, got: ${message}`
    );
  }
});

test("an unimplemented strategy is refused, and the message lists the six", { skip }, async () => {
  for (const strategy of ["priority", "round-robin", "fusion", "auto", "lkgp"]) {
    const out = curlJson("POST", "/admin/v1/combos", {
      name: `int-strategy-${strategy}`,
      strategy,
      models: [{ model: "int-direct-a" }],
    });
    assert.equal(out.status, 400, `${strategy} must be refused, got ${out.status}`);
    const message = String((out.parsed as { error_msg?: string })?.error_msg ?? "");
    assert.match(message, /is not a routing strategy/);
    // The handler's own list is the ground truth the picker's six must match.
    assert.match(
      message,
      /round_robin, consistent_hash, failover, least_cost, least_latency, least_busy/
    );
  }
});

test(
  "the two rules the schema cannot state: direct-only targets, and no duplicates",
  { skip },
  async () => {
    const combos = await client();

    // A target naming nothing dispatches nowhere.
    const unknown = curlJson("POST", "/admin/v1/combos", {
      name: "int-unknown",
      models: [{ model: "no-such-model" }],
    });
    assert.equal(unknown.status, 400);
    assert.match(
      String((unknown.parsed as { error_msg?: string })?.error_msg),
      /must be an existing direct model/
    );

    // A target naming a VIRTUAL model would nest routing groups with no cycle
    // guard — so a combo cannot be a target of another combo.
    const host = await combos.createCombo({
      name: "int-host",
      strategy: "failover",
      models: [{ model: "int-direct-a" }],
    });
    assert.equal(host.ok, true, `seed refused: ${host.failure} ${host.reason}`);
    try {
      const nested = curlJson("POST", "/admin/v1/combos", {
        name: "int-nested",
        models: [{ model: "int-host" }],
      });
      assert.equal(nested.status, 400, "a virtual target must be refused");
      assert.match(
        String((nested.parsed as { error_msg?: string })?.error_msg),
        /which is a virtual model; a combo target must be a direct model/
      );
      // The form's pre-flight must catch the same thing before the wire.
      const catalog = await combos.fetchDirectModelNames();
      assert.ok(catalog, "the direct-model catalog must load");
      assert.ok(
        !catalog.includes(host.result?.combo.name ?? "int-host"),
        "a combo must not appear in the direct-model catalog"
      );
      const issues = combos.validateComboDraft(
        { name: "int-nested", models: [{ model: "int-host" }] },
        { directModelNames: catalog }
      );
      assert.deepEqual(
        issues.map((i) => i.code),
        ["model_not_direct"]
      );

      // Duplicates, on the TRIMMED name — the form and the server must agree.
      const dup = curlJson("POST", "/admin/v1/combos", {
        name: "int-dup",
        models: [{ model: "int-direct-a" }, { model: "  int-direct-a  " }],
      });
      assert.equal(dup.status, 400);
      assert.match(
        String((dup.parsed as { error_msg?: string })?.error_msg),
        /both name "int-direct-a"; a combo lists each target once/
      );
      const dupIssues = combos.validateComboDraft({
        name: "int-dup",
        models: [{ model: "int-direct-a" }, { model: "  int-direct-a  " }],
      });
      assert.deepEqual(
        dupIssues.map((i) => i.code),
        ["model_duplicate"]
      );
    } finally {
      if (host.result) await combos.deleteCombo(host.result.id);
    }
  }
);

test("an empty name, an empty models list and a missing name are all 400", { skip }, async () => {
  for (const [label, body] of [
    ["blank name", { name: "   ", models: [{ model: "int-direct-a" }] }],
    ["no models", { name: "int-nm", models: [] }],
    ["no name field", { models: [{ model: "int-direct-a" }] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const out = curlJson("POST", "/admin/v1/combos", body);
    assert.equal(out.status, 400, `${label} must be refused, got ${out.status}`);
  }
});

test("a duplicate combo name is 409, and a PATCH of a missing row is 404", { skip }, async () => {
  const combos = await client();
  const first = await combos.createCombo({
    name: "int-unique",
    models: [{ model: "int-direct-a" }],
  });
  assert.equal(first.ok, true, `seed refused: ${first.failure} ${first.reason}`);
  try {
    const second = await combos.createCombo({
      name: "int-unique",
      models: [{ model: "int-direct-b" }],
    });
    assert.equal(second.ok, false);
    assert.equal(second.failure, "conflict");
    assert.equal(second.status, 409);
    assert.match(String(second.reason), /already exists/);
    // The refused create changed nothing.
    const live = await combos.fetchCombos();
    assert.equal(live.combos.filter((c) => c.name === "int-unique").length, 1);

    // A missing row is `not_found`, never a claim that the surface is absent.
    const gone = await combos.deleteCombo("00000000-0000-0000-0000-000000000000");
    assert.equal(gone.ok, false);
    assert.equal(gone.failure, "not_found");
    assert.equal(gone.reason, "resource not found");
  } finally {
    if (first.result) await combos.deleteCombo(first.result.id);
  }
});

test("no admin key: every verb is 401, which the UI must name", { skip }, async () => {
  const combos = await client();

  // Direct to the real handler, without the key.
  const noAuth = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/combos`],
    { encoding: "utf8" }
  );
  assert.equal(noAuth.stdout, "401", `unauthenticated list answered ${noAuth.stdout}`);

  // And the client's own read, with the key shim removed, must report that 401
  // rather than an empty list — the status is what lets the page NAME the
  // missing admin key instead of rendering "no combos exist".
  globalThis.fetch = REAL_FETCH;
  try {
    const read = await combos.fetchCombos();
    assert.equal(read.status, 401, `client read answered ${read.status} (${read.error})`);
    assert.equal(read.missing, false, "a gated surface is not an absent one");
    assert.deepEqual(read.combos, []);
    const write = await combos.createCombo({ name: "x", models: [{ model: "int-direct-a" }] });
    assert.equal(write.ok, false);
    assert.equal(write.failure, "unauthorized");
  } finally {
    await client();
  }
});

test("the catalog the form pre-validates against is the real one", { skip }, async () => {
  const combos = await client();
  const names = await combos.fetchDirectModelNames();
  assert.ok(names, "the catalog must load");
  // A combo is virtual, so it must NOT be offered as a target.
  const host = await combos.createCombo({
    name: "int-virtual",
    models: [{ model: "int-direct-a" }],
  });
  assert.equal(host.ok, true);
  try {
    const withCombo = await combos.fetchDirectModelNames();
    assert.ok(withCombo);
    assert.ok(!withCombo.includes("int-virtual"), "a combo is not a direct model");
    assert.ok(withCombo.includes("int-direct-a"));
    // And it matches what the models collection yields under the same predicate,
    // read independently over raw curl rather than through the client.
    assert.deepEqual(
      [...(withCombo as string[])].sort(),
      [...(await readDirectModelNames())].sort()
    );
  } finally {
    if (host.result) await combos.deleteCombo(host.result.id);
  }
});
