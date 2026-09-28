import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectDefaults,
  isLiteralDefault,
  parseTables,
  replaceCellAligned,
  syncDefaultCells,
} from "../../scripts/i18n/sync-env-table-cells.mjs";

// `docs/reference/ENVIRONMENT.md` records a machine-derivable Default next to
// hand-written prose, and every locale mirror restates it. Nothing propagated
// it, so commit 432765efeb's `OMNIROUTE_MCP_ENFORCE_SCOPES` true→false flip
// reached 61 of 66 mirrors and missed de, hi, it, ml and bs — five locales
// shipping a default the code contradicts, invisible to the hash-based drift
// gate because unedited mirrors hash-match. These are the invariants that make
// the generator safe to point at all 66.
//
// The fixtures are column-padded on purpose. The real mirrors are prettier-
// formatted, so every row of a table carries the same field widths, and
// `replaceCellAligned` measures that width off the row to refill it. An
// unpadded fixture would make the generator refuse to write, which is correct
// behaviour against a malformed table and useless as a test of the real path.

const SOURCE = [
  "# Env",
  "",
  "| Variable                             | Default    | Source File                     | Description |",
  "| ------------------------------------ | ---------- | ------------------------------- | ----------- |",
  "| `OMNIROUTE_MCP_ENFORCE_SCOPES`       | `false`    | `open-sse/mcp-server/server.ts` | Enforce scopes. |",
  "| `OMNIROUTE_MCP_SCOPES`               | _(all)_    | `open-sse/mcp-server/server.ts` | Comma-separated. |",
  "| `OMNIROUTE_CHAT_HARD_MAX_MESSAGES`   | `0` (disabled) | `src/lib/chat.ts`            | Hard cap. |",
  "| `OMNIROUTE_PUBLIC_BASE_URL`          | `http://localhost:20128` | `src/lib/origin.ts` | Origin. |",
  "",
  "| Variable                             | Required   | Default    | Source File            | Description |",
  "| ------------------------------------ | ---------- | ---------- | ---------------------- | ----------- |",
  "| `OMNIROUTE_STRIP_SYSTEM_PREAMBLE`    | No         | `1`        | `src/lib/prompt.ts`    | Strip it. |",
].join("\n");

const DE_ROWS = [
  "| Variable                             | Default    | Source File                     | Description |",
  "| ------------------------------------ | ---------- | ------------------------------- | ----------- |",
  "| `OMNIROUTE_MCP_ENFORCE_SCOPES`       | `false`    | `open-sse/mcp-server/server.ts` | Erzwingt Scopes. |",
  "| `OMNIROUTE_MCP_SCOPES`               | _(alle)_   | `open-sse/mcp-server/server.ts` | Komma-getrennt. |",
  "| `OMNIROUTE_CHAT_HARD_MAX_MESSAGES`   | `0` (deaktiviert) | `src/lib/chat.ts`       | Harte Grenze. |",
  "| `OMNIROUTE_PUBLIC_BASE_URL`          | `http://localhost:20128` | `src/lib/origin.ts` | Origin. |",
];

test("a literal Default cell is a value; a prose Default cell is a translation", () => {
  for (const literal of ["`true`", "`false`", "`0`", "`1`", "`on`", "`off`", "true", "0"]) {
    assert.equal(isLiteralDefault(literal), true, literal);
  }
  // The corpus-wide trap: 11750 mirror Default cells differ from English only
  // because the phrase is localised (`_(all)_` → `_(alle)_`). Copying English
  // over those would strip a translation in 66 languages.
  for (const prose of [
    "_(unset)_",
    "_(all)_",
    "_(optional)_",
    "`0` (disabled)",
    "`1` (enabled)",
    "`http://localhost:20128`",
    "`rtk`",
    "",
  ]) {
    assert.equal(isLiteralDefault(prose), false, prose);
  }
});

test("a rewritten cell keeps the column width, because prettier rejects a narrow one", () => {
  // `prettier --check` fails on a minimally padded cell in these mirrors
  // (measured), so the generator has to reproduce the column width itself.
  const padded = "| `A`      | `false`    | src/a.ts   |";
  assert.equal(replaceCellAligned(padded, 1, "`true`"), "| `A`      | `true`     | src/a.ts   |");
  // A value that fills the field exactly comes back byte-identical.
  assert.equal(replaceCellAligned(padded, 1, "`false`"), padded);
  // Other fields keep their raw padding.
  assert.equal(replaceCellAligned(padded, 2, "src/b.ts"), "| `A`      | `false`    | src/b.ts   |");
  // A value too wide for the column is refused rather than written misaligned.
  assert.equal(replaceCellAligned(padded, 1, "`a-very-long-literal`"), null);
});

test("defaults are keyed by variable name at the column the header names", () => {
  const defaults = collectDefaults(SOURCE);
  assert.equal(defaults.get("`OMNIROUTE_MCP_ENFORCE_SCOPES`").cell, "`false`");
  assert.equal(defaults.get("`OMNIROUTE_MCP_ENFORCE_SCOPES`").col, 1);
  // "Default" is not always column 1.
  assert.equal(defaults.get("`OMNIROUTE_STRIP_SYSTEM_PREAMBLE`").col, 2);
});

test("a stale literal Default is rewritten from the source, prose is left alone", () => {
  const locale = DE_ROWS.map((r) =>
    r.replace("| `false`    |", "| `true`     |").replace("_(alle)_   |", "_(alle)_    |")
  ).join("\n");
  const { text, changes } = syncDefaultCells({ sourceText: SOURCE, localeText: locale });

  assert.deepEqual(
    changes.map((c) => `${c.name} ${c.from}->${c.to}`),
    ["`OMNIROUTE_MCP_ENFORCE_SCOPES` `true`->`false`"]
  );
  assert.match(text, /`OMNIROUTE_MCP_ENFORCE_SCOPES`\s+\| `false`/);
  // The German description, the localised _(alle)_ and the localised
  // `(deaktiviert)` annotation all survive, and the column width is preserved.
  assert.match(text, /Erzwingt Scopes\./);
  assert.match(text, /_\(alle\)_\s+\|/);
  assert.match(text, /`0` \(deaktiviert\)/);
  // The rewritten row keeps its own length: the value grew by one character and
  // the column absorbed it, so no other field in the table moved.
  const before = locale.split("\n").find((l) => l.includes("OMNIROUTE_MCP_ENFORCE_SCOPES"));
  const after = text.split("\n").find((l) => l.includes("OMNIROUTE_MCP_ENFORCE_SCOPES"));
  assert.equal(after.length, before.length);
  assert.equal(after.split("|").length, before.split("|").length);
  // A second pass is a no-op: the generator is idempotent.
  assert.deepEqual(syncDefaultCells({ sourceText: SOURCE, localeText: text }).changes, []);
});

test("rows are matched by variable name, not position — mirrors lag the source", () => {
  // The real mirrors are a row behind from the row the English source gained,
  // which is why positional table pairing pairs the wrong rows.
  const locale = [
    DE_ROWS[0],
    DE_ROWS[1],
    "| `OMNIROUTE_MCP_SCOPES`               | _(alle)_    | `open-sse/mcp-server/server.ts` | Komma. |",
    "| `OMNIROUTE_MCP_ENFORCE_SCOPES`       | `true`     | `open-sse/mcp-server/server.ts` | Erzwingt. |",
  ].join("\n");
  const { changes } = syncDefaultCells({ sourceText: SOURCE, localeText: locale });
  assert.deepEqual(
    changes.map((c) => c.name),
    ["`OMNIROUTE_MCP_ENFORCE_SCOPES`"]
  );
});

test("a mirror row too narrow for the source's Default column is skipped, not written", () => {
  // `OMNIROUTE_STRIP_SYSTEM_PREAMBLE` lives in the second source table, whose
  // Default is column 2. A mirror row carrying only two cells cannot hold it.
  const locale = [
    "| Variable                             | Required   | Default    | Source File            | Description |",
    "| ------------------------------------ | ---------- | ---------- | ---------------------- | ----------- |",
    "| `OMNIROUTE_STRIP_SYSTEM_PREAMBLE`    | `0`        |",
  ].join("\n");
  const { changes, skipped } = syncDefaultCells({ sourceText: SOURCE, localeText: locale });
  assert.deepEqual(changes, []);
  assert.deepEqual(
    skipped.map((s) => `${s.name}:${s.reason}`),
    ["`OMNIROUTE_STRIP_SYSTEM_PREAMBLE`:row-too-narrow"]
  );
});

test("a mirror table too narrow to hold the new value is skipped, not written misaligned", () => {
  // The column is exactly as wide as the old value, so the new one does not fit
  // and re-padding it would break the alignment the rest of the table relies on.
  const locale = [
    "| Variable                             | Default | Source File            |",
    "| ------------------------------------ | ------- | ---------------------- |",
    "| `OMNIROUTE_MCP_ENFORCE_SCOPES`       | `true` | `open-sse/mcp-server/server.ts` |",
  ].join("\n");
  const { changes, skipped, text } = syncDefaultCells({ sourceText: SOURCE, localeText: locale });
  assert.deepEqual(changes, []);
  assert.deepEqual(
    skipped.map((s) => `${s.name}:${s.reason}`),
    ["`OMNIROUTE_MCP_ENFORCE_SCOPES`:value-does-not-fit-column"]
  );
  assert.equal(text, locale);
});

test("an ambiguous variable is dropped rather than guessed at", () => {
  const source = [
    "| Variable                             | Default    | Description |",
    "| ------------------------------------ | ---------- | ----------- |",
    "| `DUP`                                | `1`        | first |",
    "",
    "| Variable                             | Default    | Description |",
    "| ------------------------------------ | ---------- | ----------- |",
    "| `DUP`                                | `0`        | second |",
  ].join("\n");
  const { changes } = syncDefaultCells({
    sourceText: source,
    localeText: source.replace(
      "| `DUP`                                | `1`",
      "| `DUP`                                | `true` "
    ),
  });
  assert.deepEqual(changes, []);
});

test("parseTables finds the header, the delimiter and the rows of each table", () => {
  const { tables } = parseTables(SOURCE);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].header, ["Variable", "Default", "Source File", "Description"]);
  assert.equal(tables[0].rows.length, 4);
  assert.equal(tables[0].rows[0].cells[0], "`OMNIROUTE_MCP_ENFORCE_SCOPES`");
  assert.equal(tables[1].rows.length, 1);
});

test("a table whose body contains a pipe inside a cell is not mis-parsed into two rows", () => {
  const source = [
    "| Variable                             | Default    | Description |",
    "| ------------------------------------ | ---------- | ----------- |",
    "| `A`                                  | `0`        | set `A=a\\|b` to widen |",
    "| `B`                                  | `1`        | plain |",
  ].join("\n");
  // The escaped pipe stays inside its cell, so both rows still parse and `B`
  // is still addressable.
  const { changes } = syncDefaultCells({
    sourceText: source,
    localeText: source.replace(
      "| `B`                                  | `1`",
      "| `B`                                  | `0`"
    ),
  });
  assert.deepEqual(
    changes.map((c) => c.name),
    ["`B`"]
  );
});
