#!/usr/bin/env node
/**
 * OmniRoute — env-table Default-cell synchroniser for the docs/i18n mirrors.
 *
 * `docs/reference/ENVIRONMENT.md` records, for every environment variable, a
 * machine-derivable **Default** alongside hand-written prose. Each of the 66
 * locale mirrors under `docs/i18n/<locale>/docs/reference/ENVIRONMENT.md`
 * restates that default in its own language — and until this script existed,
 * nothing propagated it. A single boolean flip in the English source therefore
 * had to be hand-edited into 66 files, and commit 432765efeb
 * ("fix(mcp): resolve the MCP scope-enforcement flag", 2026-09-24) reached 61
 * of them: de, hi, it, ml and bs still shipped `OMNIROUTE_MCP_ENFORCE_SCOPES`
 * = `true` while the code and the English doc said `false`. Nothing noticed,
 * because the drift gate (`check-translation-drift.mjs`) compares hashes — the
 * five locales nobody edited hash-match perfectly and read PASS.
 *
 * This is the missing generator. It copies the **Default cell** of a row from
 * the English source into the mirror, keyed by the variable name in column 0 —
 * not by row position, because the mirrors lag the source (most of them are
 * missing rows the English table gained) and positional pairing silently pairs
 * the wrong rows.
 *
 * Scope is deliberately narrow: only cells that are a bare language-neutral
 * literal — `true`, `false`, `0`, `1`, `on`, `off`, in backticks or bare — are
 * copied. A default written as prose (`_(unset)_`, `_(all)_`,
 * `http://localhost:20128`, `` `0` (disabled) ``) is a *translation*, not a
 * derivation, and this script leaves every one of them alone. Measured over the
 * corpus: 11750 Default cells differ between English and the mirrors purely
 * because of localisation, and none of them is a value error.
 *
 * Column alignment is produced here, not delegated. `prettier --write` across
 * all 66 mirrors measures over 900 s (they are 400–840 KB each, ~35 MB total),
 * so a write pass that shells out to it cannot complete; and delegating is not
 * safe either — `prettier --check` rejects a minimally padded cell
 * (measured), and the pre-commit `lint-staged` pass is not a substitute,
 * because it does not reformat these files on every commit. So a rewritten row
 * keeps its table's field widths via `replaceCellAligned`, which is what
 * prettier would emit.
 *
 * Usage:
 *   node scripts/i18n/sync-env-table-cells.mjs                 # rewrite mirrors
 *   node scripts/i18n/sync-env-table-cells.mjs --check         # exit 1 on any divergence
 *   node scripts/i18n/sync-env-table-cells.mjs --dry-run       # report only
 *   node scripts/i18n/sync-env-table-cells.mjs --locale=de,fr  # narrow the run
 *
 * Programmatic API (tested):
 *   parseTables(text)        → { lines, tables }
 *   collectDefaults(text)    → Map<varName, { cell, col }>
 *   syncDefaultCells(...)    → { text, changes }
 */

import { promises as fs, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const SOURCE_REL = "docs/reference/ENVIRONMENT.md";
const MIRROR_SUBPATH = "docs/reference/ENVIRONMENT.md";

/** A Default cell that carries a value rather than a phrase. */
const LITERAL_DEFAULT = /^(?:`(?:true|false|0|1|on|off)`|(?:true|false|0|1))$/;

/** A table's delimiter row: `|---|---|`, `| :--- | ---: |`, and the like. */
const DELIMITER = /^\s*\|[\s:|-]+\|\s*$/;

export function isLiteralDefault(cell) {
  return LITERAL_DEFAULT.test(String(cell ?? "").trim());
}

/**
 * Splits a markdown table row into its cells, dropping the leading and
 * trailing empty strings the outer pipes produce. `| a | b |` → `["a", "b"]`.
 */
function splitRow(line) {
  const parts = line.split("|");
  parts.shift();
  parts.pop();
  return parts.map((cell) => cell.trim());
}

/**
 * Every markdown table in `text`, in document order, with each row's original
 * line index so a rewrite can address it. A table is a `|`-prefixed header
 * followed by a delimiter row, then `|`-prefixed rows until the first line that
 * is not one.
 */
export function parseTables(text) {
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (!DELIMITER.test(lines[i + 1] ?? "")) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      rows.push({ line: j, cells: splitRow(lines[j]) });
      j++;
    }
    tables.push({ headerLine: i, header: splitRow(lines[i]), rows });
    i = j - 1;
  }
  return { lines, tables };
}

/**
 * `variable name → { cell, col }` for every row of every table in the English
 * source whose header names a `Default` column. A variable that appears twice
 * with two different values, or at two different column indexes, is ambiguous
 * and is dropped rather than guessed at.
 */
export function collectDefaults(text) {
  const found = new Map();
  const ambiguous = new Set();
  for (const table of parseTables(text).tables) {
    const col = table.header.findIndex((h) => /^Default\b/i.test(h.trim()));
    if (col < 0) continue;
    for (const row of table.rows) {
      const name = row.cells[0];
      if (!name || row.cells.length <= col) continue;
      const cell = row.cells[col];
      const prior = found.get(name);
      if (prior && (prior.cell !== cell || prior.col !== col)) ambiguous.add(name);
      else if (!prior) found.set(name, { cell, col });
    }
  }
  for (const name of ambiguous) found.delete(name);
  return found;
}

/**
 * Replaces one cell of a table row in place, preserving the raw padding of
 * every other field.
 *
 * The mirrors are prettier-formatted, so a table's rows all carry the same
 * field widths. Rewriting a whole row as `| a | b |` strips that alignment and
 * `prettier --check` then rejects the file (verified: it reports a minimally
 * padded cell as a style violation, and re-padding restores it). Measuring the
 * field's own width off the row and refilling it to the same width reproduces
 * exactly what prettier would emit, without running prettier over 66 files
 * that total ~35 MB — a pass that measures over 900 s.
 *
 * The new content is always a bare ASCII literal (`true`, `false`, `0`, `1`,
 * `on`, `off`), for which display width equals character length, so filling
 * by character count is correct. Returns `null` when the value cannot fit the
 * column, which the caller reports rather than writes.
 */
export function replaceCellAligned(line, col, content) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) if (line[i] === "|") pipes.push(i);
  if (pipes.length < col + 2) return null;
  const start = pipes[col] + 1;
  const end = pipes[col + 1];
  const fieldLen = end - start;
  if (content.length + 2 > fieldLen) return null;
  const field = ` ${content}${" ".repeat(fieldLen - content.length - 1)}`;
  return line.slice(0, start) + field + line.slice(end);
}

/**
 * Rewrites `localeText` so every literal Default cell agrees with the English
 * source. Rows are matched by variable name, never by position. A mirror row
 * whose shape does not fit the source's (too few columns) is left alone and
 * reported as skipped rather than written to.
 *
 * Pure: returns a new string plus the list of cells it changed.
 */
export function syncDefaultCells({ sourceText, localeText }) {
  const defaults = collectDefaults(sourceText);
  const { lines, tables } = parseTables(localeText);
  const changes = [];
  const skipped = [];
  const next = lines.slice();
  for (const table of tables) {
    for (const row of table.rows) {
      const name = row.cells[0];
      const entry = name ? defaults.get(name) : undefined;
      if (!entry) continue;
      if (row.cells.length <= entry.col) {
        skipped.push({ line: row.line + 1, name, reason: "row-too-narrow" });
        continue;
      }
      if (!isLiteralDefault(entry.cell)) continue; // prose default — a translation
      if (row.cells[entry.col] === entry.cell) continue;
      const from = row.cells[entry.col];
      row.cells[entry.col] = entry.cell;
      const aligned = replaceCellAligned(lines[row.line], entry.col, entry.cell);
      if (aligned === null) {
        skipped.push({ line: row.line + 1, name, reason: "value-does-not-fit-column" });
        row.cells[entry.col] = from;
        continue;
      }
      next[row.line] = aligned;
      changes.push({ line: row.line + 1, name, from, to: entry.cell });
    }
  }
  return { text: next.join("\n"), changes, skipped };
}

/** Locale codes carrying an ENVIRONMENT.md mirror, in sorted order. */
export function mirrorLocales(root = ROOT) {
  const dir = path.join(root, "docs", "i18n");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((code) => existsSync(path.join(dir, code, MIRROR_SUBPATH)))
    .sort();
}

function parseArgs(argv) {
  const opts = { check: false, dryRun: false, locales: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") opts.check = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--locale=")) {
      opts.locales = new Set(
        arg
          .slice("--locale=".length)
          .split(",")
          .map((s) => s.trim())
      );
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/i18n/sync-env-table-cells.mjs [--check|--dry-run] [--locale=a,b]",
          "",
          "  --check      exit 1 when any mirror's literal Default cell disagrees with",
          "               the English source (CI mode; writes nothing)",
          "  --dry-run    report the cells that would change, write nothing",
          "  --locale     restrict the run to the given locale codes",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const sourceAbs = path.join(ROOT, SOURCE_REL);
  if (!existsSync(sourceAbs)) {
    console.error(`[env-cells] ${SOURCE_REL} not found — nothing to derive from.`);
    process.exit(2);
  }
  const sourceText = await fs.readFile(sourceAbs, "utf8");
  const all = mirrorLocales(ROOT);
  const locales = opts.locales ? all.filter((c) => opts.locales.has(c)) : all;

  const diverged = [];
  const rewritten = [];
  let totalChanges = 0;

  for (const locale of locales) {
    const abs = path.join(ROOT, "docs", "i18n", locale, MIRROR_SUBPATH);
    const localeText = await fs.readFile(abs, "utf8");
    const { text, changes, skipped } = syncDefaultCells({ sourceText, localeText });
    if (skipped.length) {
      for (const s of skipped) diverged.push({ locale, ...s });
    }
    if (changes.length === 0) continue;
    totalChanges += changes.length;
    diverged.push({ locale, changes });
    if (!opts.check && !opts.dryRun) {
      await fs.writeFile(abs, text);
      rewritten.push(abs);
    }
  }

  if (opts.check || opts.dryRun) {
    for (const entry of diverged) {
      if (entry.changes) {
        for (const c of entry.changes) {
          console.log(
            `[env-cells] ${entry.locale} ${c.name}: \`${c.from}\` → \`${c.to}\` (line ${c.line})`
          );
        }
      } else {
        console.log(
          `[env-cells] ${entry.locale} ${entry.name}: NOT written, ${entry.reason} (line ${entry.line})`
        );
      }
    }
  }

  const verb = opts.check ? "divergences" : "cells rewritten";
  console.log(
    `[env-cells] ${locales.length} locales checked against ${SOURCE_REL}: ${totalChanges} ${verb}${rewritten.length ? ` across ${rewritten.length} files` : ""}. Rewritten rows keep their column width; run \`npx prettier --write\` on the changed files anyway if a gate checks formatting.`
  );

  if (opts.check && diverged.length > 0) {
    console.error(
      `[env-cells] FAIL — ${totalChanges} literal Default cells disagree with the English source. Run \`npm run i18n:sync-env-table-cells\` (a single boolean flip must not be hand-edited into 66 files).`
    );
    process.exit(1);
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[env-cells] ERROR", err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
