import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readHomePage(): string {
  return readFileSync(join(repoRoot, "src/app/(dashboard)/home/page.tsx"), "utf8");
}

function readReadinessCard(): string {
  return readFileSync(
    join(repoRoot, "src/app/(dashboard)/dashboard/FirstRunReadinessCard.tsx"),
    "utf8"
  );
}

function readEnKeys(): string[] {
  const en = JSON.parse(readFileSync(join(repoRoot, "src/i18n/messages/en.json"), "utf8")) as {
    home: Record<string, string>;
  };
  return Object.keys(en.home);
}

describe("home page first-run readiness card", () => {
  it("does not hard-redirect incomplete setup to onboarding", () => {
    const source = readHomePage();
    assert.doesNotMatch(source, /redirect\(["']\/dashboard\/onboarding["']\)/);
    assert.match(source, /FirstRunReadinessCard/);
    // Tri-state readiness (HIGH 7): the nag shows ONLY on an explicit `false`.
    // `"unknown"` (unreachable core) hides it without claiming completion, so a
    // Boolean() coercion here would be wrong — it maps "unknown" to "complete".
    assert.match(source, /settings\.setupComplete !== false/);
    assert.doesNotMatch(source, /Boolean\(settings\.setupComplete\)/);
  });

  it("keeps the readiness card dismissable via localStorage", () => {
    const source = readReadinessCard();
    assert.match(source, /omniroute-first-run-readiness-dismissed/);
    assert.match(source, /localStorage/);
    assert.match(source, /readinessContinue/);
    assert.match(source, /readinessDismiss/);
  });

  it("uses t() keys for readiness copy", () => {
    const source = readReadinessCard();
    for (const key of [
      "readinessEyebrow",
      "readinessTitle",
      "readinessSubtitle",
      "readinessStep1",
      "readinessStep2",
      "readinessStep3",
      "readinessStep4",
    ]) {
      assert.match(source, new RegExp(key));
    }
  });

  it("new i18n keys exist in en.json home namespace", () => {
    const keys = readEnKeys();
    for (const key of [
      "readinessEyebrow",
      "readinessTitle",
      "readinessSubtitle",
      "readinessStep1",
      "readinessStep2",
      "readinessStep3",
      "readinessStep4",
      "readinessContinue",
      "readinessDismiss",
    ]) {
      assert.ok(keys.includes(key), `Missing home.${key}`);
    }
  });
});
