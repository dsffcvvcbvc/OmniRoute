#!/usr/bin/env node
/**
 * Start a THROWAWAY AISIX gateway for the dashboard-SPA E2E suite.
 *
 * Why not just use the operator's running instance? Because the suite has to be
 * runnable while someone else is working on the same binary, and the shared
 * instance owns fixed ports (`:3000` proxy, `:3001` admin) that a parallel
 * session is entitled to stop and restart at any moment. A suite whose
 * fixtures can be pulled out from under it by a neighbouring process is not a
 * suite.
 *
 * So this starts a second instance from the SAME binary with:
 *   - its own config in a temp dir (nothing under ~/.aisix is written),
 *   - its own ports, so it never collides with the operator's,
 *   - a generated admin key, so no real credential is ever written to a file
 *     or printed by a tool that persists output,
 *   - the OPERATOR's `resources.yaml` mounted READ-ONLY, so the provider-key
 *     assertions have real rows to compare the UI against rather than an empty
 *     gateway that would make half the file vacuous.
 *
 * Usage:
 *   node scripts/test/start-aisix-spa-gateway.mjs \
 *     --dashboard-dir "$HOME/.aisix/dashboard" \
 *     --config /home/ernur/.aisix/config.yaml
 *
 * It prints a ready-to-eval line and exits; the gateway keeps running, detached.
 * Stop it with `pkill -x aisix` — by name, never with `-f`, whose pattern also
 * matches the invoking shell and kills the session.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
}
const BINARY = flag("binary", "/home/ernur/.aisix/aisix");
const OPERATOR_CONFIG = flag("config", "/home/ernur/.aisix/config.yaml");
const DASHBOARD_DIR = flag("dashboard-dir", path.join(os.homedir(), ".aisix", "dashboard"));
/**
 * WHY THESE DEFAULTS, AND WHY 127.0.0.2.
 *
 * `src/shared/utils/aisixEndpoints.ts:113-120` resolves the SPA's native bases
 * like this: if the page's hostname is NOT a loopback name, the base is
 * `<page-scheme>://<that-host>:<fixed port>`; if it IS a loopback name
 * (`localhost`, `127.0.0.1`, …) the base falls back to a hard-coded
 * `http://127.0.0.1:<port>`.
 *
 * Two consequences this script is built around:
 *
 *  1. The admin plane MUST be reachable on port 3001 — that is the port the
 *     browser asks for. A throwaway instance on :3101 serves the pages fine but
 *     its admin surfaces can never answer.
 *  2. `127.0.0.2` is not in the loopback-name set, so a dashboard served from
 *     `http://127.0.0.2:3001` resolves its own admin base to
 *     `http://127.0.0.2:3001` — the same origin it was served from, which is
 *     what the deployment is supposed to be (one origin, no CORS). Linux binds
 *     all of 127.0.0.0/8, so this coexists with an operator instance on
 *     127.0.0.1:3001 instead of fighting it for the port.
 */
const HOST = flag("host", "127.0.0.2");
const ADMIN_PORT = Number(flag("admin-port", "3001"));
const PROXY_PORT = Number(flag("proxy-port", "3002"));
const METRICS_PORT = Number(flag("metrics-port", "3003"));

function fail(message) {
  console.error(`start-aisix-spa-gateway: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(BINARY)) fail(`binary not found at ${BINARY}; pass --binary <path>`);
if (!fs.existsSync(DASHBOARD_DIR)) {
  fail(
    `dashboard dir not found at ${DASHBOARD_DIR}. Extract the export artifact there first —\n` +
      "  unzip -q omniroute-dashboard-out.zip -d ~/.aisix/dashboard"
  );
}
if (!fs.existsSync(OPERATOR_CONFIG)) fail(`gateway config not found at ${OPERATOR_CONFIG}`);

/** Recursive — the export writes one `<route>.html` per route, most below `dashboard/`. */
function countHtml(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countHtml(path.join(dir, entry.name));
    else if (entry.name.endsWith(".html")) total += 1;
  }
  return total;
}

const html = countHtml(DASHBOARD_DIR);
if (html === 0)
  fail(`${DASHBOARD_DIR} holds no *.html — the export artifact was not extracted there`);

// The operator's real resources, so the UI has real provider keys to render.
// Never written to, only referenced.
const operatorYaml = fs.readFileSync(OPERATOR_CONFIG, "utf8");
const resourcesMatch = operatorYaml.match(/^\s*resources_file:\s*(\S+)\s*$/m);
if (!resourcesMatch) fail(`could not read resources_file out of ${OPERATOR_CONFIG}`);
const resourcesFile = resourcesMatch[1].replace(/^["']|["']$/g, "");
if (!fs.existsSync(resourcesFile)) fail(`resources_file ${resourcesFile} does not exist`);

/** Is anything already listening on `port`? A silent "address in use" abort costs a confusing debugging round-trip. */
function portInUse(port) {
  const probe = spawnSync(
    "bash",
    ["-c", `exec 3<>/dev/tcp/${HOST}/${port} 2>/dev/null && echo yes || echo no`],
    {
      encoding: "utf8",
    }
  );
  return probe.stdout.trim() === "yes";
}

for (const [label, port] of [
  ["admin", ADMIN_PORT],
  ["proxy", PROXY_PORT],
  ["metrics", METRICS_PORT],
]) {
  if (portInUse(port)) {
    fail(
      `${label} port ${port} is already in use — a previous run's gateway is still up, or another ` +
        "session owns it. Stop it (pkill -x <its process name>) or pass a different " +
        `--${label}-port.`
    );
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "aisix-spa-e2e-"));
const keyPath = path.join(workDir, "admin-key");
const configPath = path.join(workDir, "config.yaml");

// A throwaway credential for a throwaway instance. Generated here and written
// with mode 600; it authenticates nothing but this process's own gateway.
const adminKey = `e2e-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
fs.writeFileSync(keyPath, `${adminKey}\n`, { mode: 0o600 });

fs.writeFileSync(
  configPath,
  [
    `resources_file: ${resourcesFile}`,
    "proxy:",
    `  addr: "${HOST}:${PROXY_PORT}"`,
    "admin:",
    "  enabled: true",
    `  addr: "${HOST}:${ADMIN_PORT}"`,
    `  admin_keys: ["${adminKey}"]`,
    "observability:",
    "  metrics:",
    "    prometheus:",
    `      addr: "${HOST}:${METRICS_PORT}"`,
    "",
  ].join("\n"),
  { mode: 0o600 }
);

// The process name a `pkill -x` needs. `comm` is capped at 15 characters by the
// kernel, so a long --binary name is truncated here exactly as it would be in
// the shell — telling the operator the truncated form is the difference between
// a clean stop and a stray gateway left running.
const processName = path.basename(BINARY).slice(0, 15);

const logPath = path.join(workDir, "aisix.log");
const logFd = fs.openSync(logPath, "a");

console.error(
  `start-aisix-spa-gateway: binary=${BINARY}\n` +
    `  dashboard = ${DASHBOARD_DIR} (${html} *.html)\n` +
    `  resources = ${resourcesFile} (read-only)\n` +
    `  admin     = ${HOST}:${ADMIN_PORT}   proxy = ${HOST}:${PROXY_PORT}\n` +
    `  workdir   = ${workDir}\n` +
    `  log       = ${logPath}`
);

// `setsid --fork` so the gateway outlives this script: a plain spawn is in the
// caller's process group and is torn down with the shell that started it, which
// is exactly how a suite ends up testing a dead port. The cost is that we no
// longer hold the child handle, so stopping is by name — `pkill -x aisix` —
// which is also why the ports below are not the defaults: this and the
// operator's own instance can be told apart by their ports, not their names.
const out = spawnSync("setsid", ["--fork", BINARY, "--config", configPath], {
  env: { ...process.env, AISIX_DASHBOARD_DIR: DASHBOARD_DIR },
  stdio: ["ignore", logFd, logFd],
});
if (out.status !== 0)
  fail(`the gateway refused to start (setsid exit ${out.status}); see ${logPath}`);

// Wait for the admin listener. A 401 is the readiness signal: it means the
// listener is up AND the auth gate is live.
const base = `http://${HOST}:${ADMIN_PORT}`;
const deadline = Date.now() + 45_000;
let ready = false;
while (Date.now() < deadline) {
  const probe = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${base}/admin/v1/provider_keys`],
    { encoding: "utf8" }
  );
  if (probe.stdout === "401" || probe.stdout === "200") {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

if (!ready) {
  console.error(fs.readFileSync(logPath, "utf8").slice(-2000));
  fail(`the throwaway gateway did not come up; see ${logPath}`);
}

const dashboardStatus = spawnSync(
  "curl",
  ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${base}/dashboard`],
  { encoding: "utf8" }
).stdout;

console.log(
  [
    "",
    "# ready — paste this into the shell that runs the suite:",
    `export AISIX_SPA_BASE_URL='${base}'`,
    `export AISIX_SPA_ADMIN_KEY="$(cat '${keyPath}')"`,
    `npx playwright test -c playwright.aisix-spa.config.ts`,
    "",
    `# /dashboard answered ${dashboardStatus}`,
    `# stop the gateway: pkill -x ${processName}   (by name, never -f: the -f pattern`,
    "#   also matches the invoking shell and kills the session)",
    "",
  ].join("\n")
);

process.exit(0);
