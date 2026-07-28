// THE round-trip test (Phase 8 Task 5.4). It runs against THIS REPO'S REAL
// docs/QUEUE.md and docs/DONE.md — not fixtures.
//
// Why that matters, in the words of the bug it exists to delete: a parser once
// returned ZERO items on the real file while passing every synthetic test, and
// the consuming UI rendered an empty panel with no error. A fixture is written
// by the same person as the parser and agrees with it by construction. The
// real file is the only input that can disagree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-work-rt-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
const work = await import("../dist/work.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

// The repo this test file lives in — not a copy, not a fixture directory.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

test("every real work document round-trips byte-identically", () => {
  const docs = ["docs/QUEUE.md", "docs/DONE.md", "docs/WORKSTREAMS.md", "docs/BACKLOG.md"].filter((d) =>
    existsSync(path.join(REPO, d)),
  );
  assert.ok(docs.includes("docs/QUEUE.md") && docs.includes("docs/DONE.md"), "the real documents must exist");

  for (const rel of docs) {
    const src = read(rel);
    const out = work.renderWorkDoc(work.parseWorkDoc(src));
    if (out !== src) {
      const a = src.split("\n");
      const b = out.split("\n");
      const i = a.findIndex((l, n) => l !== b[n]);
      assert.fail(`${rel} line ${i + 1}\n  in : ${JSON.stringify(a[i])}\n  out: ${JSON.stringify(b[i])}`);
    }
    assert.equal(Buffer.byteLength(out), Buffer.byteLength(src), `${rel} byte length`);
  }
});

test("the real QUEUE.md yields the items a human can count, not zero", () => {
  const src = read("docs/QUEUE.md");
  const items = work.queueItemsOf(work.parseWorkDoc(src));
  // The failure this test exists for is "0 items, no error" — so assert the
  // count against the file itself rather than against a number I typed.
  const expected = src.split("\n").filter((l) => /^- \[( |x)\] \(P[123]\) /.test(l)).length;
  assert.ok(expected > 0, "the real file must contain queue items");
  assert.equal(items.length, expected);
  assert.ok(items.every((i) => i.text.length > 0 && /^P[123]$/.test(i.priority)));
});

test("the real DONE.md yields ref and date as separate fields", () => {
  const entries = work.doneEntriesOf(work.parseWorkDoc(read("docs/DONE.md")));
  const expected = read("docs/DONE.md")
    .split("\n")
    .slice(read("docs/DONE.md").split("\n").findIndex((l) => l.trim() === "## Done"))
    .filter((l) => /^- \[x\] /.test(l)).length;
  assert.equal(entries.length, expected);
  assert.ok(entries.length > 0);

  for (const e of entries) {
    assert.ok(e.text.length > 0);
    // Both real ref forms appear in this file: owner/repo#N and owner/repo@sha.
    assert.match(e.ref, /^[^\s]+(#\d+|@[0-9a-f]+)$/);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    // The glyphs must NOT survive inside the fields — that was the datastore
    // leaking into the data model.
    assert.ok(!e.ref.includes("·") && !e.text.endsWith(" —"));
  }
});

test("the prose the parser ignores survives untouched", () => {
  const src = read("docs/QUEUE.md");
  const doc = work.parseWorkDoc(src);
  const out = work.renderWorkDoc(doc);

  // The Cross-project section is bullets that are NOT queue items; the old
  // contract had no place for them at all.
  assert.ok(src.includes("## Cross-project"), "precondition: the real file has a cross-project section");
  const section = (s) => s.slice(s.indexOf("## Cross-project"));
  assert.equal(section(out), section(src));
  assert.equal(work.queueItemsOf(doc).filter((i) => section(src).includes(i.text)).length, 0);

  // The write-rule paragraph and the title line, likewise.
  assert.ok(out.startsWith("# QUEUE — agent-coord-mcp\n"));
  assert.ok(out.includes("**Write rule (single writer per file):**"));
});

test("the fenced done-line EXAMPLE in DONE.md is documentation, not a record", () => {
  const doc = work.parseWorkDoc(read("docs/DONE.md"));
  const entries = work.doneEntriesOf(doc);
  assert.equal(entries.filter((e) => e.text.includes("<task>")).length, 0, "the fenced example must not become an entry");
  assert.ok(work.renderWorkDoc(doc).includes("- [x] <task> — owner/repo#N · YYYY-MM-DD"), "…but it must still be in the output");
});

test("import → export writes the real documents back byte-identically", async () => {
  // The CONTENT is the real repo's; the destination is a copy, so a future
  // divergence surfaces as a failed assertion instead of as this test quietly
  // rewriting the documents it is supposed to be checking.
  const before = {
    "docs/QUEUE.md": read("docs/QUEUE.md"),
    "docs/DONE.md": read("docs/DONE.md"),
    "docs/WORKSTREAMS.md": read("docs/WORKSTREAMS.md"),
  };
  const sandbox = path.join(tmp, "real-copy");
  mkdirSync(path.join(sandbox, "docs"), { recursive: true });
  for (const [rel, src] of Object.entries(before)) writeFileSync(path.join(sandbox, rel), src);
  const readCopy = (rel) => readFileSync(path.join(sandbox, rel), "utf8");

  const imported = await t.importWorkTool({ project: "agent-coord-mcp", repo: sandbox });
  assert.equal(imported.ok, true);
  assert.ok(imported.imported.some((f) => f.path === "docs/QUEUE.md" && f.queue > 0));
  assert.ok(imported.imported.some((f) => f.path === "docs/DONE.md" && f.done > 0));

  // Dry run first: every file must already be identical, so a write is a no-op.
  const dry = await t.exportWorkTool({ project: "agent-coord-mcp" });
  assert.equal(dry.ok, true);
  assert.equal(dry.write, false);
  for (const f of dry.files) assert.equal(f.identical, true, `${f.path} differs before any write`);

  // Then the real write, against the real repo. Nothing may change on disk.
  const written = await t.exportWorkTool({ project: "agent-coord-mcp", write: true });
  assert.equal(written.ok, true);
  for (const f of written.files) assert.equal(f.written, false, `${f.path} was rewritten — it should have been identical`);
  for (const [rel, src] of Object.entries(before)) {
    assert.equal(readCopy(rel), src, `${rel} changed on disk`);
    assert.equal(read(rel), src, `${rel} in the real repo must be untouched`);
  }
});

test("deleting the store leaves the markdown working standalone", async () => {
  await t.importWorkTool({ project: "standalone", repo: REPO });
  const file = store.workFile("standalone");
  assert.ok(existsSync(file));

  rmSync(file); // simulate losing ~/agent-coord/work entirely
  const listed = await t.listWorkTool({ project: "standalone", repo: REPO });
  assert.equal(listed.ok, true);
  assert.equal(listed.source, "markdown", "with no store, the documents answer for themselves");
  assert.ok(listed.queue.length > 0 && listed.done.length > 0);
  // …and the read did not silently recreate the store.
  assert.equal(existsSync(file), false);

  // Exporting from a store that isn't there must REFUSE, not blank the files.
  const exported = await t.exportWorkTool({ project: "standalone", repo: REPO });
  assert.equal(exported.ok, false);
  assert.match(exported.error, /import_work first/);
  assert.equal(read("docs/QUEUE.md").length > 0, true);
});

test("the store directory holds only what was imported", () => {
  const names = readdirSync(store.WORK_DIR);
  assert.ok(names.includes("agent-coord-mcp.json"));
});
