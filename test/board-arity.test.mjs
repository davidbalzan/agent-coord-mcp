// Board-table arity guard: a lane row whose column count does not match
// BoardRow is refused a record, preserved byte-exactly, and named loudly.
// Before this guard, the parser destructured any arity into the fixed 5-tuple
// and the exporter silently NARROWED 6-column rows / WIDENED 4-column ones —
// hit live 2026-07-29 when #38's extra `Pane` column was dropped on
// write-back, putting main at 224/226 for two commits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-arity-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const work = await import("../dist/work.js");
const t = await import("../dist/tools/index.js");
const store = await import("../dist/store.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const HEADER = "| Lane | Owner | State | Current slice | Next GO |";
const ALIGN = "|---|---|---|---|---|";
const GOOD_ROW = "| server | worker-1 | active | doing things | on go |";
const SIX_COL = "| server | worker-1 | %4 | active | doing things | on go |";
const FOUR_COL = "| server | worker-1 | active | doing things |";

function docOf(...rows) {
  return ["# Board", "", "## Lanes", "", HEADER, ALIGN, ...rows, ""].join("\n");
}

test("a six-column row is refused a record but round-trips byte-identically", () => {
  const src = docOf(GOOD_ROW, SIX_COL);
  const doc = work.parseWorkDoc(src);
  assert.equal(work.renderWorkDoc(doc), src, "render must replay the refused row's exact bytes");
  const rows = work.boardRowsOf(doc);
  assert.equal(rows.length, 1, "only the well-formed row becomes a record");
  assert.equal(rows[0].lane, "server");
  const issues = work.workDocIssues(doc);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /has 6 column\(s\), expected 5/);
  assert.ok(issues[0].includes(SIX_COL), "the issue must quote the offending row");
  // docOf puts the six-column row on 1-based line 8: # Board / blank /
  // ## Lanes / blank / header / align / good row / THIS row.
  assert.match(issues[0], /line 8/, "the issue must name WHICH row by line number");
});

test("a four-column row is refused too — silent widening is the same defect mirrored", () => {
  const src = docOf(FOUR_COL);
  const doc = work.parseWorkDoc(src);
  assert.equal(work.renderWorkDoc(doc), src);
  assert.equal(work.boardRowsOf(doc).length, 0);
  assert.match(work.workDocIssues(doc)[0], /has 4 column\(s\), expected 5/);
});

test("right arity with an EMPTY trailing cell is a legitimate row, not a refusal", () => {
  // `| … | |` — five columns whose Next GO is legitimately empty. A
  // strictness fix must not make the common case fail.
  const emptyTail = "| server | worker-1 | idle | between slices | |";
  const src = docOf(emptyTail);
  const doc = work.parseWorkDoc(src);
  const rows = work.boardRowsOf(doc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nextGo, "");
  assert.equal(work.workDocIssues(doc).length, 0);
  assert.equal(work.renderWorkDoc(doc), src);
});

test("one bad row does not take down the document: records before AND after it survive", () => {
  const second = "| ui | worker-2 | idle | waiting | next |";
  const src = docOf(GOOD_ROW, SIX_COL, second);
  const doc = work.parseWorkDoc(src);
  assert.deepEqual(
    work.boardRowsOf(doc).map((r) => r.lane),
    ["server", "ui"],
  );
  assert.equal(work.renderWorkDoc(doc), src);
});

test("the #38 shape: an entire six-column table round-trips byte-identically with one issue per row", () => {
  const src = [
    "## Lanes",
    "",
    "| Lane | Owner | Pane | State | Current slice | Next GO |",
    "|---|---|---|---|---|---|",
    "| server | worker-1 | %4 | active | x | y |",
    "| ui | worker-2 | %5 | idle | a | b |",
    "",
  ].join("\n");
  const doc = work.parseWorkDoc(src);
  assert.equal(work.renderWorkDoc(doc), src, "the whole widened table must survive untouched");
  assert.equal(work.boardRowsOf(doc).length, 0);
  assert.equal(work.workDocIssues(doc).length, 2);
});

test("a refused row survives the store round-trip (JSON serialize → render)", () => {
  const src = docOf(SIX_COL);
  const doc = work.parseWorkDoc(src);
  const rehydrated = JSON.parse(JSON.stringify(doc));
  assert.equal(work.renderWorkDoc(rehydrated), src);
  assert.equal(work.workDocIssues(rehydrated).length, 1);
});

test("boardCells arity and BOARD_ARITY cannot drift apart", () => {
  // The parser's guard and the renderer's tuple reference the same constant;
  // this pins that widening one side without the other fails a test instead
  // of silently re-opening the narrow/widen gap.
  const row = { id: "b-x", lane: "l", owner: "o", state: "s", currentSlice: "c", nextGo: "n" };
  const rendered = work.renderBoardRow(row);
  const cells = rendered.slice(1, -1).split("|");
  assert.equal(cells.length, work.BOARD_ARITY);
});

test("import_work and export_work surface the refusal; the write-back is byte-faithful", async () => {
  const repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  const board = docOf(GOOD_ROW, SIX_COL);
  writeFileSync(path.join(repo, "docs", "QUEUE.md"), "## Queue\n\n- [ ] (P1) something\n");
  writeFileSync(path.join(repo, "docs", "WORKSTREAMS.md"), board);

  const imp = await t.importWorkTool({ project: "arity-proj", repo });
  assert.equal(imp.ok, true);
  assert.match(imp.warning, /1 table row\(s\) were refused a record/);
  const boardDoc = imp.imported.find((d) => d.path === "docs/WORKSTREAMS.md");
  assert.equal(boardDoc.board, 1, "only the well-formed row is counted");
  assert.match(boardDoc.issues[0], /has 6 column\(s\), expected 5/);

  const list = await t.listWorkTool({ project: "arity-proj" });
  assert.equal(list.board.length, 1);
  assert.equal(list.issues.length, 1);
  assert.match(list.issues[0], /^docs\/WORKSTREAMS\.md: board row at line/);

  const dry = await t.exportWorkTool({ project: "arity-proj" });
  const dryBoard = dry.files.find((f) => f.path === "docs/WORKSTREAMS.md");
  assert.equal(dryBoard.identical, true, "export must not want to change a document it merely cannot model");
  assert.match(dryBoard.issues[0], /refused/);

  const wet = await t.exportWorkTool({ project: "arity-proj", write: true });
  assert.equal(wet.ok, true);
  assert.equal(readFileSync(path.join(repo, "docs", "WORKSTREAMS.md"), "utf8"), board, "write-back byte-identical, extra column intact");
});
