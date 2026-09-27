/**
 * The admin-key exchange against a REAL AISIX gateway.
 *
 * The unit suite (`tests/unit/aisix-admin-auth.test.ts`) pins the client's
 * decisions with a stubbed fetch. This one pins the thing a stub cannot: that
 * the contract the client implements is the contract
 * `aisix-admin/src/session.rs` and `auth.rs` actually serve. Every answer below
 * comes from the deployed Rust binary. There is no fixture server, no
 * intercepted response and no hand-written JSON standing in for a handler.
 *
 * It boots the binary on its OWN ports with its OWN config and its OWN resources
 * file under a temp dir, so the operator's gateway state is never read or
 * written, and it removes everything it creates. `pkill -x`, never `pkill -f`:
 * the `-f` pattern matches the invoking shell and kills the session.
 *
 * Gated on the binary being present:
 *   AISIX_E2E_BINARY=/home/ernur/.aisix/aisix \
 *     node --import tsx/esm --test tests/integration/aisix-admin-session.test.ts
 */

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AISIX_BINARY = process.env.AISIX_E2E_BINARY || "/home/ernur/.aisix/aisix";
const ADMIN_KEY = "aisix-session-int-admin-key";
const WRONG_KEY = "not-the-admin-key";
const ADMIN_PORT = 3222;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;

const binaryAvailable = fs.existsSync(AISIX_BINARY);
const skip = binaryAvailable
  ? false
  : `AISIX binary not found at ${AISIX_BINARY}; set AISIX_E2E_BINARY to run this suite`;

let workDir = "";
let gateway: ChildProcess | null = null;

function writeGatewayConfig(): void {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisix-session-int-"));
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
      '  addr: "127.0.0.1:3223"',
      "admin:",
      "  enabled: true",
      `  addr: "127.0.0.1:${ADMIN_PORT}"`,
      `  admin_keys: ["${ADMIN_KEY}"]`,
      "observability:",
      "  metrics:",
      "    prometheus:",
      '      addr: "127.0.0.1:9292"',
      // NO `admin.tls`: the shipped plaintext listener, which is what makes
      // cookie auth work over http here. The Secure-only failure mode is a
      // property of a TLS listener and is covered in the browser journey, which
      // asserts the CLIENT's honest handling rather than the server's flag.
      "",
    ].join("\n"),
    "utf8"
  );
}

async function waitForAdminApi(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/models`], {
      encoding: "utf8",
    });
    if (probe.stdout === "401") return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("the throwaway AISIX admin API did not come up");
}

before(async () => {
  if (!binaryAvailable) return;
  writeGatewayConfig();
  gateway = spawn("setsid", ["--fork", AISIX_BINARY, "--config", path.join(workDir, "config.yaml")], {
    stdio: "ignore",
    detached: true,
  });
  gateway.unref();
  await waitForAdminApi();
});

after(async () => {
  if (!binaryAvailable) return;
  // `pkill -x` on the process NAME. Never `-f`: the pattern would match this
  // test process's own command line and kill the session running it.
  spawnSync("pkill", ["-x", "aisix"], { stdio: "ignore" });
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/** One raw request, so the assertions read the real wire and not a client. */
async function raw(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; origin?: string } = {}
): Promise<{ status: number; setCookie: string | null; text: string }> {
  const headers: string[] = [];
  if (options.body !== undefined) headers.push("Content-Type: application/json");
  if (options.cookie) headers.push(`Cookie: ${options.cookie}`);
  if (options.origin) headers.push(`Origin: ${options.origin}`);
  const args = ["-s", "-i", "-X", method, `${ADMIN_BASE}${path}`];
  for (const h of headers) args.push("-H", h);
  if (options.body !== undefined) args.push("--data-binary", JSON.stringify(options.body));
  const out = spawnSync("curl", args, { encoding: "utf8" });
  const rawText = out.stdout ?? "";
  const split = rawText.indexOf("\r\n\r\n");
  const head = split === -1 ? rawText : rawText.slice(0, split);
  const body = split === -1 ? "" : rawText.slice(split + 4);
  const statusLine = head.split(/\r?\n/)[0] ?? "";
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
  const setCookie = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("set-cookie:")) ?? null;
  return { status, setCookie, text: body };
}

describe("the admin-key exchange, against the real binary", { skip }, () => {
  test("an admin read with no credential is 401", async () => {
    const res = await raw("GET", "/admin/v1/models");
    assert.equal(res.status, 401);
  });

  test("POST with a wrong key is 401 and never echoes the key", async () => {
    const res = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: WRONG_KEY } });
    assert.equal(res.status, 401);
    // The envelope is a fixed string; the request body is not reflected.
    assert.equal(res.text.includes(WRONG_KEY), false);
  });

  test("POST with a valid key is 204 with NO body", async () => {
    const res = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    assert.equal(res.status, 204);
    // The contract says the only thing the caller needs is the Set-Cookie, so
    // a body here would be something for a client to get wrong.
    assert.equal(res.text.trim(), "");
  });

  test("the 204 sets the documented cookie attributes", async () => {
    const res = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const cookie = res.setCookie ?? "";
    assert.match(cookie, /^set-cookie:\s*aisix_admin_session=/i, cookie);
    assert.match(cookie, /HttpOnly/i, "the cookie must be unreadable by page scripts");
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/admin\/v1/i);
    // No `Max-Age`/`Expires`: a session cookie, discarded with the browser.
    assert.equal(/Max-Age/i.test(cookie), false, cookie);
    assert.equal(/Expires=/i.test(cookie), false, cookie);
    // This listener has no `admin.tls`, so `Secure` must be ABSENT — and a
    // `Secure` cookie here would be dropped by the browser, which is the
    // failure mode the UI has to handle honestly.
    assert.equal(/\bSecure\b/i.test(cookie), false, cookie);
  });

  test("a malformed body is 400, not 401 — the shape was refused, not the key", async () => {
    // The distinction the whole classification rests on: the key was never
    // compared, so reporting this as "bad key" would be a lie.
    const cases: Array<[string, unknown]> = [
      ["not an object", JSON.stringify("nope")],
      ["missing admin_key", JSON.stringify({})],
      ["empty admin_key", JSON.stringify({ admin_key: "" })],
      ["non-string admin_key", JSON.stringify({ admin_key: 42 })],
      ["an unknown field", JSON.stringify({ admin_key: ADMIN_KEY, remember: true })],
    ];
    for (const [label, body] of cases) {
      const res = await raw("POST", "/admin/v1/auth/session", { body });
      assert.equal(res.status, 400, `${label}: ${res.status} ${res.text}`);
      assert.match(res.text, /error_msg/, `${label}: ${res.text}`);
    }
  });

  test("the cookie authenticates every admin read with no header", async () => {
    const login = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const token = (/aisix_admin_session=([^;]+)/.exec(login.setCookie ?? "") ?? [])[1];
    assert.ok(token, "a session cookie was not returned");

    for (const p of ["/admin/v1/models", "/admin/v1/combos", "/admin/v1/provider_keys"]) {
      const res = await raw("GET", p, { cookie: `aisix_admin_session=${token}` });
      assert.equal(res.status, 200, `${p}: ${res.status}`);
    }
  });

  test("a cross-origin unsafe request is 403, and a same-origin one is not", async () => {
    const login = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const token = (/aisix_admin_session=([^;]+)/.exec(login.setCookie ?? "") ?? [])[1];
    const cookie = `aisix_admin_session=${token}`;

    // Same host as the request: allowed.
    const same = await raw("GET", "/admin/v1/combos", { cookie, origin: ADMIN_BASE });
    assert.equal(same.status, 200, `same-origin reads must pass: ${same.status}`);

    // Reads are never guarded (GET is safe), so the 403 is proven on a write.
    const crossWrite = await raw("POST", "/admin/v1/combos", {
      cookie,
      origin: "http://evil.example",
      body: { name: "csrf-probe", models: [{ model: "x" }] },
    });
    assert.equal(crossWrite.status, 403, `cross-origin write must be refused: ${crossWrite.status}`);
    assert.match(crossWrite.text, /cross-origin/, crossWrite.text);

    // A non-browser caller sends no Origin and is allowed through. The body is
    // refused by the handler (the target is not a real direct model), and THAT
    // is the proof the guard did not fire: a 403 here would mean the
    // same-origin check had rejected a caller that sent neither header.
    const noOrigin = spawnSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", `${ADMIN_BASE}/admin/v1/combos`, "-H", `Cookie: ${cookie}`, "-H", "Content-Type: application/json", "--data-binary", JSON.stringify({ name: "scripted-probe", models: [{ model: "x" }] })],
      { encoding: "utf8" }
    );
    assert.notEqual(
      noOrigin.stdout,
      "403",
      `a scripted caller must not be refused by the same-origin guard: ${noOrigin.stdout}`
    );
    assert.equal(noOrigin.stdout, "400", "the refusal is the handler's, not the guard's");
  });

  test("an unknown or forged cookie is 401, never 200", async () => {
    const forged = await raw("GET", "/admin/v1/models", {
      cookie: `aisix_admin_session=${"0".repeat(64)}`,
    });
    assert.equal(forged.status, 401);
  });

  test("DELETE revokes the session, and the same cookie then reads 401", async () => {
    const login = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const token = (/aisix_admin_session=([^;]+)/.exec(login.setCookie ?? "") ?? [])[1];
    const cookie = `aisix_admin_session=${token}`;

    assert.equal((await raw("GET", "/admin/v1/models", { cookie })).status, 200);

    const out = await raw("DELETE", "/admin/v1/auth/session", { cookie });
    assert.equal(out.status, 204);
    // The clearing header repeats `Path` and adds `Max-Age=0`; a clearing
    // header with a different Path would leave the original in place.
    assert.match(out.setCookie ?? "", /Max-Age=0/i, out.setCookie ?? "");
    assert.match(out.setCookie ?? "", /Path=\/admin\/v1/i, out.setCookie ?? "");

    // The session is gone server-side, not just hidden from the browser.
    assert.equal((await raw("GET", "/admin/v1/models", { cookie })).status, 401);
  });

  test("DELETE twice: the second is 401, which the client reads as already signed out", async () => {
    const login = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const token = (/aisix_admin_session=([^;]+)/.exec(login.setCookie ?? "") ?? [])[1];
    const cookie = `aisix_admin_session=${token}`;
    assert.equal((await raw("DELETE", "/admin/v1/auth/session", { cookie })).status, 204);
    assert.equal((await raw("DELETE", "/admin/v1/auth/session", { cookie })).status, 401);
  });

  test("a header key still works, and a PRESENT bad header is not rescued by a good cookie", async () => {
    // The no-fall-through rule: a present credential DECIDES, so a client
    // holding a stale header learns it is wrong instead of being silently
    // authenticated by the cookie.
    const login = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const token = (/aisix_admin_session=([^;]+)/.exec(login.setCookie ?? "") ?? [])[1];
    const cookie = `aisix_admin_session=${token}`;

    const good = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/models`, "-H", `Authorization: Bearer ${ADMIN_KEY}`], { encoding: "utf8" });
    assert.equal(good.stdout, "200");

    const bad = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${ADMIN_BASE}/admin/v1/models`, "-H", `Authorization: Bearer ${WRONG_KEY}`, "-H", `Cookie: ${cookie}`], { encoding: "utf8" });
    assert.equal(bad.stdout, "401", "a bad Authorization must not fall through to a good cookie");
  });

  test("sessions are independent: signing one out does not end the other", async () => {
    // A second session is independent of the first, so this only asserts the
    // isolation the dashboard's one-signed-out-state design relies on: signing
    // one browser out must not sign the other out, and must not be mistaken for
    // a gateway-wide failure.
    const a = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const b = await raw("POST", "/admin/v1/auth/session", { body: { admin_key: ADMIN_KEY } });
    const tokenA = (/aisix_admin_session=([^;]+)/.exec(a.setCookie ?? "") ?? [])[1];
    const tokenB = (/aisix_admin_session=([^;]+)/.exec(b.setCookie ?? "") ?? [])[1];
    assert.notEqual(tokenA, tokenB, "each exchange must mint a distinct session");

    await raw("DELETE", "/admin/v1/auth/session", { cookie: `aisix_admin_session=${tokenA}` });
    assert.equal((await raw("GET", "/admin/v1/models", { cookie: `aisix_admin_session=${tokenA}` })).status, 401);
    assert.equal(
      (await raw("GET", "/admin/v1/models", { cookie: `aisix_admin_session=${tokenB}` })).status,
      200,
      "signing one session out must not end the other"
    );
  });
});
