#!/usr/bin/env node
/**
 * fill-aisix-spa-keys-from-en.mjs — targeted EN-fallback fill for the AISIX SPA
 * export branch (feat/aisix-spa-export).
 *
 * Fills ONLY our new keys (`health.cooldown*` / `health.hotReload*` cards,
 * `home.coreUnreachable*` badge) missing in non-EN locale files with the EN
 * value. Never overwrites existing translations and never touches any other
 * key (e.g. чужой featureFlagProxyPoolSharedEgressOrderDescription stays
 * missing on purpose — pre-existing red owned by another change; likewise the
 * pre-existing `health.cooldown` / `health.cooldownCount` are NOT in TARGETS).
 *
 * Usage:
 *   node scripts/i18n/fill-aisix-spa-keys-from-en.mjs
 *
 * Idempotent. Safe to run repeatedly.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../src/i18n/messages/", import.meta.url).pathname;
const EN = JSON.parse(readFileSync(join(ROOT, "en.json"), "utf-8"));

const TARGETS = {
  health: [
    "cooldownStatusTitle",
    "cooldownStatusDescription",
    "cooldownColKey",
    "cooldownColProvider",
    "cooldownColUntil",
    "cooldownColReason",
    "cooldownEmpty",
    "cooldownLoadFailed",
    "hotReloadTitle",
    "hotReloadDescription",
    "hotReloadOk",
    "hotReloadUnavailable",
    "hotReloadAppliedAt",
    "hotReloadError",
  ],
  home: ["coreUnreachableBadge", "coreUnreachableHint"],
};

for (const [namespace, keys] of Object.entries(TARGETS)) {
  for (const key of keys) {
    if (!(EN[namespace] && key in EN[namespace])) {
      console.error(`[i18n] ${namespace}.${key} missing in en.json — aborting`);
      process.exit(1);
    }
  }
}

let touched = 0;
for (const file of readdirSync(ROOT)) {
  if (!file.endsWith(".json") || file === "en.json") continue;
  const path = join(ROOT, file);
  const data = JSON.parse(readFileSync(path, "utf-8"));
  let added = 0;
  for (const [namespace, keys] of Object.entries(TARGETS)) {
    if (!data[namespace] || typeof data[namespace] !== "object") data[namespace] = {};
    for (const key of keys) {
      if (!(key in data[namespace])) {
        data[namespace][key] = EN[namespace][key];
        added += 1;
      }
    }
  }
  if (added > 0) {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    touched += 1;
    console.log(`[i18n] filled ${added} aisix-spa keys in ${file}`);
  }
}
console.log(`[i18n] done — touched ${touched} locale files`);
