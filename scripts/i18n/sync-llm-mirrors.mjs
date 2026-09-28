#!/usr/bin/env node
/**
 * sync-llm-mirrors.mjs — keep docs/i18n/<locale>/llm.txt in lock-step with
 * the root `llm.txt`. The mirrors are strict copies (no translation): they
 * preserve the per-locale heading + language bar block they already have at
 * the top of the file, then replace everything after the `---` separator with
 * the root body (heading stripped).
 *
 * Usage:
 *   node scripts/i18n/sync-llm-mirrors.mjs                      # rewrite the stale mirrors
 *   node scripts/i18n/sync-llm-mirrors.mjs --stage              # …and `git add` exactly those
 *   node scripts/i18n/sync-llm-mirrors.mjs --if-staged --stage  # …only when llm.txt is staged
 *
 * A mirror body is a PURE function of the root `llm.txt` plus its own locale
 * header, so regeneration can never be wrong — it can only be missing. That is
 * why the pre-commit hook runs `--if-staged --stage` on every commit: an
 * `llm.txt` edit is a one-file change, not a 66-file hand edit (2026-09-28: a
 * migration-count bump staled all 66 mirrors). `check:docs-sync` is the gate
 * that proves the result.
 *
 * Idempotent. Safe to run repeatedly.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

export const MIRROR_FILE_NAME = "llm.txt";

/** The root file's own `# Title` heading is replaced by the locale's heading. */
export function stripTopHeading(content) {
  return content.replace(/^# .+\r?\n+/, "");
}

/**
 * PURE: the mirror text for one locale — its existing header (everything up to
 * and including the first `---` separator on its own line) verbatim, then the
 * root body. Returns null when the locale file has no separator, because a
 * file without one is not a mirror and must not be overwritten.
 */
export function renderMirror(existing, rootBody) {
  const separator = existing.match(/^---\s*$/m);
  if (!separator || separator.index === undefined) return null;
  const header = existing.slice(0, separator.index + separator[0].length).replace(/\r\n/g, "\n");
  return `${header.replace(/\n+$/, "")}\n\n${rootBody.trimStart()}`.replace(/\r\n/g, "\n");
}

/**
 * Paths currently in the git index, relative to `root`. The commit-time trigger:
 * a commit that does not touch the root `llm.txt` cannot have staled a mirror,
 * so there is nothing to regenerate and nothing to stage.
 */
export function stagedPaths(root) {
  return execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}
/**
 * Rewrite every locale mirror from the root file. `stage` additionally adds
 * exactly the rewritten mirrors to the git index — a regenerated-but-unstaged
 * mirror would leave the commit green locally and red in CI, so the two must
 * be one operation. `onlyIfStaged` makes the whole run a no-op unless the root
 * file is itself staged, which is the commit-time trigger.
 *
 * Returns { locales, updated, unchanged, missing, updatedPaths, staged, skipped }.
 */
export function syncLlmMirrors({
  root = ROOT,
  stage = false,
  onlyIfStaged = false,
  log = () => {},
} = {}) {
  const idle = {
    locales: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    updatedPaths: [],
    staged: false,
    skipped: true,
  };
  if (onlyIfStaged && !stagedPaths(root).includes(MIRROR_FILE_NAME)) return idle;

  const rootLlm = path.join(root, MIRROR_FILE_NAME);
  if (!fs.existsSync(rootLlm)) {
    throw new Error(`[sync-llm-mirrors] root ${MIRROR_FILE_NAME} not found at ${rootLlm}`);
  }
  const rootBody = stripTopHeading(fs.readFileSync(rootLlm, "utf8")).replace(/\r\n/g, "\n");

  const i18nDir = path.join(root, "docs", "i18n");
  const locales = fs
    .readdirSync(i18nDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const updatedPaths = [];
  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const locale of locales) {
    const target = path.join(i18nDir, locale, MIRROR_FILE_NAME);
    let existing;
    try {
      existing = fs.readFileSync(target, "utf8");
    } catch {
      log(`[sync-llm-mirrors] skip ${locale}: ${MIRROR_FILE_NAME} missing`);
      missing += 1;
      continue;
    }

    const next = renderMirror(existing, rootBody);
    if (next === null) {
      log(`[sync-llm-mirrors] skip ${locale}: missing --- separator`);
      missing += 1;
      continue;
    }

    if (existing.replace(/\r\n/g, "\n") === next) {
      unchanged += 1;
      continue;
    }
    fs.writeFileSync(target, next, "utf8");
    updated += 1;
    updatedPaths.push(path.relative(root, target).split(path.sep).join("/"));
    log(`[sync-llm-mirrors] updated docs/i18n/${locale}/${MIRROR_FILE_NAME}`);
  }

  let staged = false;
  if (stage && updatedPaths.length > 0) {
    // Array args, no shell: a locale directory name is never interpolated into
    // a command string (Hard Rule #13).
    execFileSync("git", ["add", "--", ...updatedPaths], { cwd: root, stdio: "ignore" });
    staged = true;
  }

  return {
    locales: locales.length,
    updated,
    unchanged,
    missing,
    updatedPaths,
    staged,
    skipped: false,
  };
}

function main() {
  const args = process.argv.slice(2);
  const result = syncLlmMirrors({
    stage: args.includes("--stage"),
    onlyIfStaged: args.includes("--if-staged"),
    log: console.log,
  });
  if (result.skipped) {
    console.log(`[sync-llm-mirrors] root ${MIRROR_FILE_NAME} is not staged — nothing to do`);
    return;
  }
  console.log(
    `[sync-llm-mirrors] done — updated=${result.updated} unchanged=${result.unchanged} ` +
      `missing=${result.missing} (${result.locales} locales)${result.staged ? " (staged)" : ""}`
  );
  if (result.missing > 0) {
    // A skipped locale cannot be repaired by regeneration; failing loudly beats
    // committing a change CI's mirror check will reject.
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
