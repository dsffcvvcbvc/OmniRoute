/**
 * The admin key must never be persisted anywhere JavaScript can read.
 *
 * This is a MECHANICAL guard, not a review note. The claim it defends is the
 * reason the whole exchange exists: `session.rs` says a `localStorage` copy of
 * the admin key "would be readable by any script on the origin, which is the
 * exact thing the admin key is not meant to be". A reviewer reading the diff
 * cannot see that a persistence call was added three files away; this can.
 *
 * It scans the SOURCE, so it fails on the commit that introduces the violation
 * rather than on the runtime that would be exploited.
 *
 * The scan is deliberately narrow on what it accepts:
 *   - a token that only APPEARS (no call that writes) is a comment or a
 *     diagnostic string, which is fine;
 *   - a WRITE call whose value is a literal or a constant is fine — that is
 *     how a page stores its own UI preference;
 *   - anything that writes a VARIABLE whose name is about the admin key is a
 *     violation, because a variable is where a key can end up.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "src");

/** The auth path, relative to `src/`. Nothing in it may persist a key. */
const AUTH_MODULES = [
  "shared/utils/aisixAdminAuth.ts",
  "shared/utils/aisixTransportBase.ts",
  "shared/hooks/useAisixAdminSession.ts",
  "shared/components/AdminSessionGate.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const allFiles = walk(SRC);
const rel = (f: string) => path.relative(ROOT, f);

/** A storage sink: the name of the API and the argument that would be stored. */
const WRITE_SINKS: Array<{ pattern: RegExp; sink: string }> = [
  { pattern: /\b(?:localStorage|sessionStorage)\s*\.\s*(setItem|removeItem)\s*\(/, sink: "Web Storage" },
  { pattern: /\bdocument\s*\.\s*cookie\s*=/, sink: "document.cookie" },
  { pattern: /\bindexedDB\b|\bopenDatabase\b/, sink: "IndexedDB" },
];

/** An identifier that would hold the admin key, if one ever reached a sink. */
const KEY_IDENTIFIER = /admin_?key|adminKey|ADMIN_KEY|gatewayKey/i;

/** A value that is provably not a runtime secret. */
const LITERAL_VALUE =
  /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\d+(?:\.\d+)?|true|false|null)\s*,?\s*\)?\s*$/;

describe("the admin key is never persisted anywhere JS can read it", () => {
  test("no file under src/ writes an admin-key-shaped value to a storage sink", () => {
    const violations: string[] = [];

    for (const file of allFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, sink } of WRITE_SINKS) {
          if (!pattern.test(line)) continue;
          // The call must span lines for a multi-line argument list; grab a
          // window so a value on the following line is judged too.
          const window = lines.slice(index, index + 4).join(" ");
          const argument = window.slice(window.indexOf("(") + 1).split(",")[1] ?? "";
          if (LITERAL_VALUE.test(argument.trim())) continue;
          if (KEY_IDENTIFIER.test(window)) {
            violations.push(`${rel(file)}:${index + 1} — ${sink} write of a key-shaped value`);
            return;
          }
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `an admin key reached a JS-readable storage sink:\n${violations.join("\n")}`
    );
  });

  test("the exchange module contains no storage sink call at all", () => {
    // A stricter bar for the one module that holds the key: it must not merely
    // avoid writing a key, it must not know how to write one.
    const source = readFileSync(path.join(SRC, AUTH_MODULES[0]), "utf8");
    for (const { pattern, sink } of WRITE_SINKS) {
      assert.equal(
        pattern.test(source),
        false,
        `${AUTH_MODULES[0]} must contain no ${sink} call: the admin key is an argument, never a resident`
      );
    }
  });

  test("the auth path never mentions the session cookie's name or value", () => {
    // A JS reference to `aisix_admin_session` would be a route to a
    // JS-readable copy of the credential, which is the thing the HttpOnly
    // attribute exists to prevent. The name belongs in a comment at most.
    for (const module of AUTH_MODULES) {
      const source = readFileSync(path.join(SRC, module), "utf8");
      const offending = source
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes("aisix_admin_session") && !line.trim().startsWith("*"));
      assert.deepEqual(
        offending.map((o) => `${module}:${o.n}`),
        [],
        `${module} references the session cookie name outside a comment`
      );
    }
  });

  test("the key is an argument, never a return value", () => {
    // An outcome that carries the key back would let a caller log it, put it in
    // a URL, or store it. Every `AdminSessionOutcome` member is a status name or
    // a server message; none is the key.
    const source = readFileSync(path.join(SRC, AUTH_MODULES[0]), "utf8");
    const outcomeType = source.slice(
      source.indexOf("export type AdminSessionOutcome"),
      source.indexOf("/**\n * The gateway's")
    );
    assert.equal(/adminKey\s*[?:]/.test(outcomeType), false, "the outcome must not carry the key");
    assert.equal(/\bkey\s*[?:]\s*string/.test(outcomeType), false);
  });

  test("no module under src/ puts the admin key in a URL", () => {
    // A key in a query string lands in access logs, `Referer` headers and
    // browser history — the reason the key travels in a body.
    const violations: string[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (!KEY_IDENTIFIER.test(line)) return;
        if (!/[?&](admin_?key|key|api_?key)\s*=/i.test(line)) return;
        violations.push(`${rel(file)}:${index + 1}`);
      });
    }
    assert.deepEqual(violations, [], `an admin key appears in a URL:\n${violations.join("\n")}`);
  });

  test("the login screen's input is a password field with no autofill", () => {
    // Not a persistence sink, but the same class of leak: a `text` input or an
    // autofill hint would put the key in a visible value or in the browser's
    // own saved-forms store, which is readable.
    const source = readFileSync(path.join(SRC, AUTH_MODULES[3]), "utf8");
    const input = source.slice(source.indexOf("<input"), source.indexOf("/>") + 2);
    assert.match(input, /type="password"/, "the key input must be a password field");
    assert.match(input, /autoComplete="off"/, "the key input must opt out of autofill");
    // And it must be uncontrolled by anything persistent: React state is memory
    // only, and the state is cleared on both close and a failed attempt.
    assert.match(source, /setKey\(""\)/, "the key must be dropped from component state");
  });

  test("the exchange clears the signed-in edge so a later 401 re-notifies", () => {
    // Part of the same lifecycle: a re-login must arm the signal again, or a
    // dashboard would never ask for the key a second time — which, with an 8h
    // TTL, would happen within a day.
    const source = readFileSync(path.join(SRC, AUTH_MODULES[0]), "utf8");
    assert.match(source, /function markAisixSignedIn[\s\S]*?signedOut = false;/);
    assert.match(source, /markAisixSignedIn\(\)/);
  });
});
