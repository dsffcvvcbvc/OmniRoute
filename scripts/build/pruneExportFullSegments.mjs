/**
 * AGENT.md §3.3 — drop `__next._full.txt` from the AISIX static SPA export.
 *
 * WHAT IT IS. `output: "export"` copies each route's RSC segment directory into
 * `out/<route>/`. `next/dist/server/app-render/collect-segment-data.js:205`
 * unconditionally puts a second copy of the whole page flight response into that
 * map under the key `/_full`, and
 * `next/dist/export/index.js:721` writes every segment out through
 * `convertSegmentPathToStaticExportFilename` — `'/_full'` → `__next._full.txt`.
 *
 * WHY IT IS PURE DUPLICATION. The `__next._full.txt` next to `<route>.txt` is the
 * SAME bytes: both are the page's complete flight response, one written as the
 * route payload and one written as a segment. Measured on artifact `10928452044`
 * (run `36310115490`): byte-identical to its `<route>.txt` sibling in all 703
 * emitted cases, 472.8 MiB uncompressed / ~148 MiB zipped, 22.7 % of the
 * artifact.
 *
 * WHY NOTHING FETCHES IT. The client router is the only consumer of the segment
 * files and it has no `_full` case at all:
 *
 *   grep -rn "_full" node_modules/next/dist/client/ node_modules/next/dist/shared/
 *   → 0 hits
 *
 * (versus `__next._tree.txt`, which the same cache DOES fetch and therefore
 * cannot be touched — see `rejectRouteCacheEntry` at
 * `next/dist/esm/client/components/segment-cache/cache.js:838`, called at
 * :1260 when the tree segment is missing.)
 *
 * So the file is pure weight. This module deletes it, and — because "Next.js
 * never asks for it" is a property of the installed Next version, not of this
 * repo — it REFUSES to delete on any future version where that stops being true.
 * Two independent guards, both loud:
 *
 *   1. Reference guard. If `_full` appears anywhere in the client/shared runtime
 *      the Next version ships, abort. Shipping a static artifact whose client
 *      router requests a file that was pruned produces a broken SPA, so this
 *      fails the build instead.
 *   2. Equivalence guard. Every candidate must be byte-identical to a sibling
 *      `<route>.txt` / `<route>/index.txt` in the same output tree. If a `_full`
 *      ever diverges from its route payload it is no longer a duplicate, and
 *      deleting it would lose data — so the build stops and names the file.
 *
 * Neither guard is advisory: both throw, and the build script runs this after a
 * successful `next build`, so a violation is a non-zero `build:export`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** The segment file `/_full` is written to. See the module header. */
export const FULL_SEGMENT_FILENAME = "__next._full.txt";

/**
 * Directories whose sources decide whether the client router can ever request a
 * segment file. `_full` outside these is server-only (the exporter itself) and
 * says nothing about client behaviour, so it must not trip guard 1.
 */
export const CLIENT_RUNTIME_DIRS = [
  path.join("node_modules", "next", "dist", "client"),
  path.join("node_modules", "next", "dist", "shared"),
];

/** Recurse a directory and return every regular file path, absolute. */
async function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Guard 1: does the installed Next client/shared runtime mention `_full` at all?
 *
 * Returns the offending files. An empty array means the segment is unreachable
 * from the browser, which is the precondition for pruning it.
 */
export async function findClientRuntimeFullReferences(projectRoot) {
  const offenders = [];

  for (const relDir of CLIENT_RUNTIME_DIRS) {
    const dir = path.join(projectRoot, relDir);
    for (const file of await collectFiles(dir)) {
      // Binary assets (.map blobs, compressed payloads) cannot contain a usable
      // fetch path for this file name, and reading them costs hundreds of MB.
      if (!/\.(js|mjs|cjs|json|txt)$/.test(file)) continue;
      const source = await fs.readFile(file, "utf8").catch(() => "");
      if (source.includes("/_full") || source.includes("__next._full")) offenders.push(file);
    }
  }

  return offenders;
}

/** Guard 2 candidates: the route payloads that `_full` would have to duplicate. */
export function siblingPayloadCandidates(fullSegmentPath) {
  const dir = path.dirname(fullSegmentPath);
  return [path.join(dir, "index.txt"), `${dir}.txt`];
}

/** Recurse `outDir` and return every `__next._full.txt` below it. */
export async function findFullSegmentFiles(outDir) {
  const found = [];
  for (const file of await collectFiles(outDir)) {
    if (path.basename(file) === FULL_SEGMENT_FILENAME) found.push(file);
  }
  return found;
}

/**
 * Delete every `__next._full.txt` under `outDir`.
 *
 * @param {object} options
 * @param {string} options.projectRoot repo root (for the Next runtime scan)
 * @param {string} options.outDir       the export output directory
 * @returns {Promise<{removed: number, bytes: number}>} what was actually deleted
 * @throws when a guard fails — never a partial prune.
 */
export async function pruneExportFullSegments({ projectRoot, outDir }) {
  const offenders = await findClientRuntimeFullReferences(projectRoot);
  if (offenders.length > 0) {
    throw new Error(
      `[export-prune] Refusing to remove ${FULL_SEGMENT_FILENAME}: the installed Next.js ` +
        `client/shared runtime references "_full" in:\n  ${offenders
          .map((file) => path.relative(projectRoot, file))
          .join("\n  ")}\n` +
        "A static export whose client router requests a pruned file is a broken artifact, so the " +
        "build fails here instead of shipping one. Re-measure whether the segment is still " +
        "redundant before relaxing this guard."
    );
  }

  const targets = await findFullSegmentFiles(outDir);
  if (targets.length === 0) return { removed: 0, bytes: 0 };

  // Verify EVERY candidate before deleting ANY of them: a half-pruned export is
  // the one state that is worse than either outcome.
  for (const target of targets) {
    const contents = await fs.readFile(target);
    const candidates = siblingPayloadCandidates(target);
    let duplicated = false;

    for (const candidate of candidates) {
      const sibling = await fs.readFile(candidate).catch(() => null);
      if (sibling && sibling.equals(contents)) {
        duplicated = true;
        break;
      }
    }

    if (!duplicated) {
      throw new Error(
        `[export-prune] Refusing to remove ${path.relative(outDir, target)}: it is NOT ` +
          `byte-identical to any of its route payloads (${candidates
            .map((candidate) => path.relative(outDir, candidate))
            .join(", ")}). It is not a duplicate, so deleting it would drop data that ` +
          "nothing else in the export carries."
      );
    }
  }

  let bytes = 0;
  for (const target of targets) {
    const { size } = await fs.stat(target);
    bytes += size;
  }
  for (const target of targets) {
    await fs.rm(target);
  }

  return { removed: targets.length, bytes };
}

/**
 * `out/` location for an export build. `next.config.mjs` sets `distDir` to
 * `NEXT_DIST_DIR || "out"` when `OMNIROUTE_EXPORT=1`, and `output: "export"`
 * writes into `distDir` itself — so this has to be read from the env rather than
 * from the `.build/next` default the rest of the build script uses.
 */
export function resolveExportOutDir(env = process.env) {
  return path.resolve(env.NEXT_DIST_DIR || "out");
}
