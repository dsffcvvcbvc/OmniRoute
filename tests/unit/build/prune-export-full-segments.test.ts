import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FULL_SEGMENT_FILENAME,
  findClientRuntimeFullReferences,
  pruneExportFullSegments,
  resolveExportOutDir,
  siblingPayloadCandidates,
} from "../../../scripts/build/pruneExportFullSegments.mjs";

/**
 * AGENT.md §3.3 — the `__next._full.txt` prune.
 *
 * The value of the prune is entirely in its guards: the file is only redundant
 * because (a) the installed Next client router never asks for it and (b) it is
 * byte-identical to the route payload sitting next to it. Both are properties of
 * the Next version in `node_modules`, not of this repo, so a Next upgrade can
 * invalidate the prune silently. Every test below is written so that breaking the
 * thing turns it red — a stub Next tree, a `_full` that differs from its sibling,
 * a client runtime that mentions `_full` — and the last test asserts the guards
 * against the REAL installed Next 16.3.5 tree in this checkout.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A fake `node_modules/next/dist/{client,shared}` tree with controllable contents. */
function makeFakeNext(files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-full-prune-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

/**
 * A minimal export tree:
 *   out/dashboard/home.txt                  (route flight payload)
 *   out/dashboard/home/__next._tree.txt      (the segment the client DOES fetch)
 *   out/dashboard/home/__next._full.txt      (the duplicate under test)
 *   out/index.txt + out/__next._full.txt     (the root route, emitted at out/ root)
 */
function makeExportTree({
  fullContents,
  routeContents,
}: { fullContents?: string; routeContents?: string } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-out-"));
  const payload = routeContents ?? "flight-payload-bytes";

  fs.mkdirSync(path.join(outDir, "dashboard", "home"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "dashboard", "home.txt"), payload);
  fs.writeFileSync(path.join(outDir, "dashboard", "home", "__next._tree.txt"), "tree");
  fs.writeFileSync(
    path.join(outDir, "dashboard", "home", FULL_SEGMENT_FILENAME),
    fullContents ?? payload
  );

  fs.writeFileSync(path.join(outDir, "index.txt"), payload);
  fs.writeFileSync(path.join(outDir, FULL_SEGMENT_FILENAME), fullContents ?? payload);

  return outDir;
}

test("prune removes _full segments that duplicate their route payload and keeps the tree segment", async () => {
  const projectRoot = makeFakeNext();
  const outDir = makeExportTree();

  const result = await pruneExportFullSegments({ projectRoot, outDir });

  assert.equal(result.removed, 2, "both the nested and the root-route _full copy go");
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(path.join(outDir, "dashboard", "home", FULL_SEGMENT_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(outDir, FULL_SEGMENT_FILENAME)), false);
  // The load-bearing segment must survive untouched — see the `_tree` guard in
  // next/dist/esm/client/components/segment-cache/cache.js.
  assert.equal(fs.existsSync(path.join(outDir, "dashboard", "home", "__next._tree.txt")), true);
  assert.equal(
    fs.readFileSync(path.join(outDir, "dashboard", "home.txt"), "utf8"),
    "flight-payload-bytes"
  );
});

test("prune removes nothing when the export contains no _full segment", async () => {
  const projectRoot = makeFakeNext();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-out-empty-"));
  fs.writeFileSync(path.join(outDir, "index.html"), "<html></html>");

  assert.deepEqual(await pruneExportFullSegments({ projectRoot, outDir }), {
    removed: 0,
    bytes: 0,
  });
});

test("prune REFUSES when the Next client/shared runtime references _full", async () => {
  // A future Next that fetches /_full would 404 on every route of a pruned
  // export. The build must fail loudly rather than ship a broken artifact.
  const projectRoot = makeFakeNext({
    ["node_modules/next/dist/client/components/segment-cache/cache.js"]: 'const x = "/_full";\n',
  });
  const outDir = makeExportTree();

  await assert.rejects(
    () => pruneExportFullSegments({ projectRoot, outDir }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /Refusing to remove __next\._full\.txt/);
      assert.match(message, /client\/shared runtime references/);
      // The message must name the file that tripped it, or the next person
      // cannot act on the failure.
      assert.match(message, /segment-cache\/cache\.js/);
      return true;
    }
  );

  assert.equal(
    fs.existsSync(path.join(outDir, "dashboard", "home", FULL_SEGMENT_FILENAME)),
    true,
    "a failed guard must not have deleted anything"
  );
});

test("prune is NOT tripped by a server-side-only _full mention", async () => {
  // `next/dist/server/app-render/collect-segment-data.js` is the PRODUCER of the
  // segment. Its presence says nothing about whether the client requests it, so
  // scanning it would make the guard permanently red.
  const projectRoot = makeFakeNext({
    ["node_modules/next/dist/server/app-render/collect-segment-data.js"]:
      "resultMap.set('/_full', fullPageDataBuffer);\n",
  });

  assert.deepEqual(await findClientRuntimeFullReferences(projectRoot), []);
});

test("prune REFUSES when a _full segment differs from every route payload", async () => {
  // If `_full` ever stops being a byte-for-byte copy, it is carrying something
  // the route payload does not, and deleting it would lose data.
  const projectRoot = makeFakeNext();
  const outDir = makeExportTree({ fullContents: "something-else-entirely" });

  await assert.rejects(
    () => pruneExportFullSegments({ projectRoot, outDir }),
    (error: unknown) => {
      assert.match((error as Error).message, /is NOT byte-identical to any of its route payloads/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(outDir, "dashboard", "home", FULL_SEGMENT_FILENAME)), true);
});

test("prune is all-or-nothing: one divergent _full aborts the whole prune", async () => {
  const projectRoot = makeFakeNext();
  const outDir = makeExportTree();
  // The root-route copy is a faithful duplicate; the nested one is not.
  fs.writeFileSync(path.join(outDir, "dashboard", "home", FULL_SEGMENT_FILENAME), "diverged");

  await assert.rejects(() => pruneExportFullSegments({ projectRoot, outDir }));
  assert.equal(
    fs.existsSync(path.join(outDir, FULL_SEGMENT_FILENAME)),
    true,
    "the faithful duplicate must still be present — a half-pruned export is worse than either outcome"
  );
});

test("sibling payload candidates cover both export layouts", () => {
  // `output: "export"` runs with buildExport=true, so `subFolders` is false and
  // `<route>.txt` sits beside the route directory. The root route writes
  // `out/index.txt` while its segments land in `out/` itself, so both forms have
  // to be probed.
  assert.deepEqual(
    siblingPayloadCandidates(path.join("/out", "dashboard", "home", FULL_SEGMENT_FILENAME)),
    [path.join("/out", "dashboard", "home", "index.txt"), "/out/dashboard/home.txt"]
  );
  assert.deepEqual(siblingPayloadCandidates(path.join("/out", FULL_SEGMENT_FILENAME)), [
    path.join("/out", "index.txt"),
    "/out.txt",
  ]);
});

test("resolveExportOutDir follows next.config's distDir for the export profile", () => {
  // next.config.mjs: `distDir = isExportBuild ? NEXT_DIST_DIR || "out" : …`.
  // Reading `.build/next` here would look for the prune in a directory that
  // never receives segment files.
  assert.equal(resolveExportOutDir({}), path.resolve("out"));
  assert.equal(resolveExportOutDir({ NEXT_DIST_DIR: "custom-out" }), path.resolve("custom-out"));
});

test("the installed Next client/shared runtime really does not reference _full", async () => {
  // The live guard, asserted against the real dependency instead of a stub. If a
  // Next upgrade starts fetching /_full this goes red — which is the point: the
  // prune and the installed version can no longer disagree.
  const offenders = await findClientRuntimeFullReferences(REPO_ROOT);

  assert.deepEqual(
    offenders,
    [],
    "next/dist/client or next/dist/shared now references the _full segment. The export " +
      "prune in scripts/build/pruneExportFullSegments.mjs would ship a broken artifact; " +
      "re-measure the duplication before touching the guard."
  );
});

test("build-next-isolated runs the prune on the export profile only", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "build", "build-next-isolated.mjs"),
    "utf8"
  );
  assert.match(
    source,
    /pruneExportFullSegments/,
    "the prune must be wired into the build script, not left as an unreferenced module"
  );
  // The gate must be `result.code === 0 && OMNIROUTE_EXPORT === "1"`: pruning a
  // directory a failed build never finished writing is meaningless, and the
  // standalone profile emits no segment files.
  assert.match(source, /result\.code === 0 && process\.env\.OMNIROUTE_EXPORT === "1"/);
  assert.ok(
    source.indexOf("pruneExportFullSegments") < source.indexOf("const standaloneDir"),
    "the prune must run immediately after next build, before any standalone packaging"
  );
});
