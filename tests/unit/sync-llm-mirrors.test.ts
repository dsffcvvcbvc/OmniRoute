import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIRROR_FILE_NAME, syncLlmMirrors } from "../../scripts/i18n/sync-llm-mirrors.mjs";

const ROOT_LLM = "# OmniRoute\n\n- **Database:** 190 migrations\n";
const FR_HEADER = "# OmniRoute (fr)\n\n> Français\n\n---\n";
const DE_HEADER = "# OmniRoute (de)\n\n> Deutsch\n\n---\n";

function repo({ frBody = "old body\n", deBody = "old body\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-mirrors-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, MIRROR_FILE_NAME), ROOT_LLM);
  for (const [locale, header, body] of [
    ["fr", FR_HEADER, frBody],
    ["de", DE_HEADER, deBody],
  ] as const) {
    fs.mkdirSync(path.join(root, "docs/i18n", locale), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/i18n", locale, MIRROR_FILE_NAME), `${header}\n${body}`);
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function staged(root) {
  return execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
}

test("a stale mirror body is replaced from the root file, the locale header is kept", () => {
  const root = repo();
  const result = syncLlmMirrors({ root });
  assert.equal(result.updated, 2);
  assert.equal(result.unchanged, 0);
  assert.equal(result.missing, 0);

  const fr = fs.readFileSync(path.join(root, "docs/i18n/fr/llm.txt"), "utf8");
  assert.ok(fr.startsWith(FR_HEADER), "the locale heading/language bar must survive");
  assert.match(fr, /190 migrations/);
  // The root's own `# Title` is replaced by the locale heading, not appended.
  assert.doesNotMatch(fr, /# OmniRoute\n\n- /);
  cleanup(root);
});

test("a second run rewrites nothing (the mirror body is a pure function of the root)", () => {
  const root = repo();
  syncLlmMirrors({ root });
  const second = syncLlmMirrors({ root });
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 2);
  cleanup(root);
});

test("--stage commits the rewritten mirrors, and only those", () => {
  const root = repo();
  // A second, unrelated edit in the tree: regeneration must not sweep it in.
  fs.writeFileSync(path.join(root, "docs/i18n/fr/notes.md"), "hand-written\n");

  const skipped = syncLlmMirrors({ root, stage: true, onlyIfStaged: true });
  assert.equal(skipped.skipped, true, "nothing runs while llm.txt is unstaged");
  assert.equal(staged(root).length, 0);

  execFileSync("git", ["add", MIRROR_FILE_NAME], { cwd: root });
  const result = syncLlmMirrors({ root, stage: true, onlyIfStaged: true });

  assert.equal(result.updated, 2);
  assert.equal(result.staged, true);
  assert.deepEqual(staged(root), ["docs/i18n/de/llm.txt", "docs/i18n/fr/llm.txt", "llm.txt"]);
  cleanup(root);
});

test("a locale file without the --- separator is reported, never overwritten", () => {
  const root = repo();
  const orphan = path.join(root, "docs/i18n/de/llm.txt");
  fs.writeFileSync(orphan, "# OmniRoute (de)\n\nno separator here\n");
  execFileSync("git", ["add", MIRROR_FILE_NAME], { cwd: root });

  const result = syncLlmMirrors({ root });
  assert.equal(result.missing, 1);
  assert.equal(result.updated, 1);
  assert.equal(fs.readFileSync(orphan, "utf8"), "# OmniRoute (de)\n\nno separator here\n");
  cleanup(root);
});
