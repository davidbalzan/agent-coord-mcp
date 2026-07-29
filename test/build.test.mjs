// Unit test for the pure freshness scanner in src/build.ts. Runs entirely on
// a temp tree — the whole point of the function being pure over its dir
// argument is that no test ever varies mtimes on real, shared sources.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { newestMtimeUnder } = await import("../dist/build.js");

const tmp = mkdtempSync(path.join(tmpdir(), "coord-build-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("newestMtimeUnder finds the newest matching file recursively and skips the rest", () => {
  const at = (file, ms) => utimesSync(file, new Date(ms), new Date(ms));
  writeFileSync(path.join(tmp, "a.js"), "");
  at(path.join(tmp, "a.js"), 1_000_000);
  mkdirSync(path.join(tmp, "sub"));
  writeFileSync(path.join(tmp, "sub", "b.js"), "");
  at(path.join(tmp, "sub", "b.js"), 2_000_000); // newest match — in a subdir
  writeFileSync(path.join(tmp, "c.txt"), "");
  at(path.join(tmp, "c.txt"), 9_000_000); // newer still, but wrong extension

  assert.equal(newestMtimeUnder(tmp, [".js"]), 2_000_000);
  assert.equal(newestMtimeUnder(tmp, [".js", ".txt"]), 9_000_000);
  assert.equal(
    newestMtimeUnder(path.join(tmp, "does-not-exist"), [".js"]),
    undefined,
    "missing dir must be 'unknown, skip' — never a guess or a throw",
  );
});
