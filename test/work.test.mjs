// Phase 8 Task 5: record shapes, the pinned glyph contract, and the legacy
// single-BACKLOG.md import. The real-file round trip lives in
// test/work-roundtrip.test.mjs — that one is the load-bearing test; this one
// pins the edges a real document doesn't happen to contain today.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-work-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
const work = await import("../dist/work.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const EM = " — "; // space + em dash + space
const DOT = " · "; // space + middot + space

function fixtureRepo(name, files) {
  const repo = path.join(tmp, name);
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(repo, rel), body);
  return repo;
}

// ---------- 5.1 record shapes ----------

test("a queue item carries priority, text and done — and nothing glyph-shaped", () => {
  const item = work.parseQueueLine("- [ ] (P2) **Guard binding**" + EM + "detail" + DOT + "acceptance: x");
  assert.equal(item.priority, "P2");
  assert.equal(item.done, false);
  // The whole tail is the item's text: a queue item has no ref/date contract,
  // so splitting on the glyphs here would corrupt it.
  assert.equal(item.text, "**Guard binding**" + EM + "detail" + DOT + "acceptance: x");
  assert.match(item.id, /^q-[0-9a-f]{8}$/);
  assert.equal(work.parseQueueLine("- [x] (P1) done item").done, true);
  assert.equal(work.parseQueueLine("- [ ] no priority tag"), null);
  assert.equal(work.parseQueueLine("- [ ] (P4) out of range"), null);
});

test("a done entry splits ref and date into separate fields", () => {
  const e = work.parseDoneLine("- [x] Ship it" + EM + "owner/repo#12" + DOT + "2026-07-08");
  assert.equal(e.text, "Ship it");
  assert.equal(e.ref, "owner/repo#12");
  assert.equal(e.date, "2026-07-08");
  assert.match(e.id, /^d-[0-9a-f]{8}$/);
});

test("the ref splits on the LAST em dash, not the first", () => {
  const e = work.parseDoneLine("- [x] Fix A" + EM + "and B" + EM + "owner/repo#3" + DOT + "2026-07-08");
  assert.equal(e.text, "Fix A" + EM + "and B");
  assert.equal(e.ref, "owner/repo#3");
});

test("ids are deterministic — same content in, same id out", () => {
  const a = work.parseDoneLine("- [x] X" + EM + "o/r#1" + DOT + "2026-01-01");
  const b = work.parseDoneLine("- [x] X" + EM + "o/r#1" + DOT + "2026-01-01");
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, work.parseDoneLine("- [x] Y" + EM + "o/r#1" + DOT + "2026-01-01").id);
});

test("an entry with no ref or no date is still an entry, not a parse failure", () => {
  // The old contract's failure mode was silence: a line that didn't match
  // produced nothing at all, and the panel just looked empty.
  const bare = work.parseDoneLine("- [x] Something we forgot to cite");
  assert.equal(bare.text, "Something we forgot to cite");
  assert.equal(bare.ref, undefined);
  assert.equal(bare.date, undefined);

  const refOnly = work.parseDoneLine("- [x] Direct to main" + EM + "owner/repo@3bce3ce");
  assert.equal(refOnly.ref, "owner/repo@3bce3ce");
  assert.equal(refOnly.date, undefined);

  // A trailing em dash phrase that is prose, not a ref, stays in the text.
  const prose = work.parseDoneLine("- [x] Something" + EM + "and then some prose");
  assert.equal(prose.text, "Something" + EM + "and then some prose");
  assert.equal(prose.ref, undefined);
});

test("ASCII lookalikes do not satisfy the glyph contract", () => {
  const e = work.parseDoneLine("- [x] Ship it - owner/repo#12 . 2026-07-08");
  // It is still an entry (the line is a checkbox bullet), but the ref/date
  // fields stay empty rather than being invented from the wrong glyphs.
  assert.equal(e.ref, undefined);
  assert.equal(e.date, undefined);
  assert.equal(e.text, "Ship it - owner/repo#12 . 2026-07-08");
});

// ---------- 5.2 export matches the glyph contract exactly ----------

test("rendering emits U+2014 and U+00B7, byte for byte", () => {
  const line = work.renderDoneLine({ id: "d-1", text: "Ship it", ref: "owner/repo#12", date: "2026-07-08" });
  assert.equal(line, "- [x] Ship it" + EM + "owner/repo#12" + DOT + "2026-07-08");
  const bytes = Buffer.from(line, "utf8");
  assert.ok(bytes.includes(Buffer.from("—", "utf8")), "em dash U+2014 present");
  assert.ok(bytes.includes(Buffer.from("·", "utf8")), "middot U+00B7 present");
  assert.equal(work.EM_DASH_SEP, EM);
  assert.equal(work.MIDDOT_SEP, DOT);

  // Optional parts are omitted cleanly — no dangling separator.
  assert.equal(work.renderDoneLine({ id: "d", text: "Bare" }), "- [x] Bare");
  assert.equal(work.renderDoneLine({ id: "d", text: "R", ref: "o/r#1" }), "- [x] R" + EM + "o/r#1");
});

test("a parsed line renders back to itself for every line shape", () => {
  const lines = [
    "- [ ] (P1) **Bold**" + EM + "tail" + DOT + "acceptance: y",
    "- [x] (P3) ticked item",
    "- [x] Entry" + EM + "o/r#9" + DOT + "2026-07-08",
    "- [x] Entry with only a ref" + EM + "o/r@abc1234",
    "- [x] Entry with neither",
  ];
  for (const l of lines) {
    const rendered = l.startsWith("- [ ] (") || /^- \[x\] \(P/.test(l)
      ? work.renderQueueLine(work.parseQueueLine(l))
      : work.renderDoneLine(work.parseDoneLine(l));
    assert.equal(rendered, l);
  }
});

test("subsection grouping and the document title survive a round trip", () => {
  const src = [
    "# QUEUE — demo",
    "",
    "## Queue",
    "",
    "### Infra",
    "",
    "- [ ] (P1) infra item",
    "",
    "### Product",
    "",
    "- [ ] (P2) product item",
    "",
  ].join("\n");
  const doc = work.parseWorkDoc(src);
  assert.equal(work.renderWorkDoc(doc), src);
  const items = work.queueItemsOf(doc);
  assert.deepEqual(items.map((i) => i.section), ["Infra", "Product"]);
});

// ---------- 5.3 import, including the legacy layout ----------

test("the legacy single BACKLOG.md is imported via its Queue/Done regions", async () => {
  const legacy = [
    "# BACKLOG — legacy",
    "",
    "Some prose the parser must not touch.",
    "",
    "## Queue",
    "",
    "- [ ] (P1) legacy queue item",
    "- [ ] (P3) another one",
    "",
    "## Done",
    "",
    "- [x] legacy done" + EM + "owner/repo#1" + DOT + "2026-05-01",
    "",
  ].join("\n");
  const repo = fixtureRepo("legacy-repo", { "docs/BACKLOG.md": legacy });

  const imported = await t.importWorkTool({ project: "legacy", repo });
  assert.equal(imported.ok, true);
  assert.deepEqual(
    imported.imported.map((f) => [f.path, f.kind, f.queue, f.done]),
    [["docs/BACKLOG.md", "legacy", 2, 1]],
  );

  const listed = await t.listWorkTool({ project: "legacy" });
  assert.equal(listed.queue.length, 2);
  assert.equal(listed.done[0].ref, "owner/repo#1");

  const exported = await t.exportWorkTool({ project: "legacy", write: true });
  assert.equal(exported.ok, true);
  assert.equal(readFileSync(path.join(repo, "docs/BACKLOG.md"), "utf8"), legacy);
});

test("split QUEUE/DONE win over a legacy BACKLOG.md when both exist", async () => {
  const repo = fixtureRepo("both-repo", {
    "docs/BACKLOG.md": "# BACKLOG\n\n## Queue\n\n- [ ] (P1) stale legacy item\n",
    "docs/QUEUE.md": "# QUEUE — both\n\n## Queue\n\n- [ ] (P1) current item\n",
    "docs/DONE.md": "# DONE — both\n\n## Done\n\n- [x] done" + EM + "o/r#1" + DOT + "2026-01-01\n",
  });
  const imported = await t.importWorkTool({ project: "both", repo });
  assert.deepEqual(imported.imported.map((f) => f.path), ["docs/QUEUE.md", "docs/DONE.md"]);

  const listed = await t.listWorkTool({ project: "both" });
  assert.equal(listed.queue.length, 1);
  assert.equal(listed.queue[0].text, "current item");
});

test("import refuses a directory with no work documents", async () => {
  const repo = fixtureRepo("empty-repo", {});
  const r = await t.importWorkTool({ project: "empty", repo });
  assert.equal(r.ok, false);
  assert.match(r.error, /no work documents/);
});

// ---------- board rows ----------

test("board rows carry the lanes table, and an edited row re-renders", async () => {
  const board = [
    "# WORKSTREAMS — demo",
    "",
    "## Lanes",
    "",
    "| Lane | Owner | State | Current slice | Next GO |",
    "|---|---|---|---|---|",
    "| server | worker-1 | idle | nothing | P3 reaper |",
    "",
  ].join("\n");
  const doc = work.parseWorkDoc(board);
  assert.equal(work.renderWorkDoc(doc), board, "an untouched table replays its own bytes");

  const rows = work.boardRowsOf(doc);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { lane: rows[0].lane, owner: rows[0].owner, state: rows[0].state, nextGo: rows[0].nextGo },
    { lane: "server", owner: "worker-1", state: "idle", nextGo: "P3 reaper" },
  );

  rows[0].state = "busy";
  assert.ok(work.renderWorkDoc(doc).includes("| server | worker-1 | busy | nothing | P3 reaper |"));
});

// ---------- queries ----------

test("list_work filters open items by priority and hides ticked ones by default", async () => {
  const repo = fixtureRepo("filter-repo", {
    "docs/QUEUE.md": [
      "# QUEUE — filter",
      "",
      "## Queue",
      "",
      "- [ ] (P1) urgent",
      "- [ ] (P3) later",
      "- [x] (P1) already handled",
      "",
    ].join("\n"),
  });
  await t.importWorkTool({ project: "filter", repo });

  assert.deepEqual((await t.listWorkTool({ project: "filter" })).queue.map((q) => q.text), ["urgent", "later"]);
  assert.deepEqual(
    (await t.listWorkTool({ project: "filter", priority: "P1" })).queue.map((q) => q.text),
    ["urgent"],
  );
  assert.equal((await t.listWorkTool({ project: "filter", includeDone: true })).queue.length, 3);
});

test("export reports the declared write scope without enforcing it", async () => {
  const repo = fixtureRepo("scoped-repo", {
    "docs/QUEUE.md": "# QUEUE — scoped\n\n## Queue\n\n- [ ] (P1) item\n",
  });
  writeFileSync(store.SCOPES_FILE, JSON.stringify({ "docs/QUEUE.md": { owner: "aide", mode: "exclusive" } }));
  await t.registerTool({ agentId: "not-the-aide", role: { roleId: "repo-owner" } });
  await t.importWorkTool({ project: "scoped", repo });

  const r = await t.exportWorkTool({ project: "scoped", agentId: "not-the-aide", write: true });
  // Reported…
  assert.equal(r.ok, true);
  assert.equal(r.files[0].scope.owner, "aide");
  assert.equal(r.files[0].scope.callerOwns, false);
  assert.equal(r.files[0].scope.advisory, true);
  // …and NOT enforced: Task 4 promised declaration + detection, and this must
  // not quietly become the enforcement point.
  assert.equal(r.files[0].identical, true);
  rmSync(store.SCOPES_FILE);
});
