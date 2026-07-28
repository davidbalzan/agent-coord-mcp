// Phase 8 Task 7: retention reads the typed record.
//
// These tests drive the REAL paths — real sends through send_message until
// live compaction fires on its own size/count thresholds, the real prune tool
// over a real room file, and the real overflow digest from read_messages. Not
// a fixture and not the predicate in isolation: the defect was three call
// sites disagreeing with each other, and only the call sites can show that.
//
// The bug: a v2 agent sending `record:{type:"decision"}` without the legacy
// `kind` had its decision compacted at chatter rate and dropped from digests —
// the phase's own thesis (typed is the truth, legacy is a rendering) failing in
// the one place nobody looked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-retention-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const readRoom = (chan) =>
  readFileSync(store.roomFile(chan), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const has = (entries, text) => entries.some((e) => e.text === text);

// ---------- 7.1 / 7.3: real live compaction ----------

test("a typed decision with no legacy `kind` survives REAL compaction", async () => {
  const chan = "compaction";
  // Two identical decisions, differing only in how they say so: one legacy
  // `kind`, one typed `record`. This is worker-1's repro shape.
  await t.sendMessageTool({ from: "coord", room: chan, text: "LEGACY DECISION", kind: "decision" });
  await t.sendMessageTool({
    from: "coord",
    room: chan,
    text: "TYPED DECISION",
    record: { type: "decision", payload: { title: "t", context: "c", options: ["a"], recommendation: "a", ifNoAction: "n" } },
  });
  await t.sendMessageTool({ from: "coord", room: chan, text: "EARLY CHATTER" });

  // Flood past the real thresholds (1000 entries AND 100KB) so compaction
  // fires from send_message itself, exactly as it does in production.
  const pad = "x".repeat(200);
  for (let i = 0; i < 1100; i++) {
    await t.sendMessageTool({ from: "worker", room: chan, text: `chatter ${i} ${pad}` });
  }

  const after = readRoom(chan);
  assert.ok(statSync(store.roomFile(chan)).size > 100 * 1024, "precondition: past the size gate");
  assert.ok(after.length < 1103, `compaction must have run (still ${after.length} entries)`);
  // The exact kept count depends on where the boundary lands (recent window
  // plus every fresh decision above it), so assert the drop rather than a
  // magic number.
  assert.ok(1103 - after.length > 400, `expected a real compaction, dropped only ${1103 - after.length}`);

  // The point of the test:
  assert.ok(has(after, "TYPED DECISION"), "a typed decision was compacted at chatter rate");
  assert.ok(has(after, "LEGACY DECISION"), "legacy retention must be unchanged");
  assert.ok(!has(after, "EARLY CHATTER"), "precondition: ordinary early chatter WAS compacted away");

  // Nothing is ever deleted — both decisions and the chatter are in the archive.
  const archived = readFileSync(store.archiveRoomFile(chan), "utf8");
  assert.ok(archived.includes("EARLY CHATTER"));
});

// ---------- 7.1 / 7.3: real prune ----------

test("a typed decision with no legacy `kind` survives REAL prune", async () => {
  const chan = "pruning";
  const now = Date.now();
  const old = (extra) => ({
    id: `${Math.random()}`,
    ts: now - 20 * DAY, // older than olderThanDays, younger than decisionDays
    from: "coord",
    room: chan,
    ...extra,
  });
  await store.ensureRoom(chan, "coord");
  await store.appendJsonl(store.roomFile(chan), old({ text: "OLD TYPED DECISION", record: { type: "decision" } }));
  await store.appendJsonl(store.roomFile(chan), old({ text: "OLD LEGACY DECISION", kind: "decision" }));
  await store.appendJsonl(store.roomFile(chan), old({ text: "OLD CHATTER" }));
  await store.appendJsonl(store.roomFile(chan), { id: "fresh", ts: now, from: "coord", room: chan, text: "FRESH" });

  const r = await t.pruneTool({ olderThanDays: 7, decisionDays: 30, room: chan, targets: ["rooms"] });
  assert.equal(r.dryRun, false);
  assert.equal(r.removed.roomMessages, 1, "exactly the one chatter entry");

  const kept = readRoom(chan);
  assert.ok(has(kept, "OLD TYPED DECISION"), "a typed decision was pruned at chatter rate");
  assert.ok(has(kept, "OLD LEGACY DECISION"), "legacy retention must be unchanged");
  assert.ok(has(kept, "FRESH"));
  assert.ok(!has(kept, "OLD CHATTER"), "precondition: ordinary old chatter WAS pruned");
});

test("past the decision cutoff, a typed decision prunes like anything else", async () => {
  // Monotone means "longer retention", not "immortal".
  const chan = "pruning-old";
  const now = Date.now();
  await store.ensureRoom(chan, "coord");
  await store.appendJsonl(store.roomFile(chan), {
    id: "ancient",
    ts: now - 400 * DAY,
    from: "coord",
    room: chan,
    text: "ANCIENT TYPED DECISION",
    record: { type: "decision" },
  });
  await store.appendJsonl(store.roomFile(chan), { id: "fresh2", ts: now, from: "coord", room: chan, text: "FRESH" });

  await t.pruneTool({ olderThanDays: 7, decisionDays: 30, room: chan, targets: ["rooms"] });
  const kept = readRoom(chan);
  assert.ok(!has(kept, "ANCIENT TYPED DECISION"));
  assert.ok(has(kept, "FRESH"));
});

// ---------- 7.1 / 7.3: real overflow digest ----------

test("a typed decision is quoted verbatim in a REAL overflow digest", async () => {
  const chan = "digest";
  await t.sendMessageTool({ from: "coord", room: chan, text: "TYPED DECISION IN DIGEST", record: { type: "decision" } });
  await t.sendMessageTool({ from: "coord", room: chan, text: "LEGACY DECISION IN DIGEST", kind: "decision" });
  for (let i = 0; i < 60; i++) await t.sendMessageTool({ from: "worker", room: chan, text: `noise ${i}` });

  // A small limit forces the CCR overflow path for a reader who has never read.
  const r = await t.readMessagesTool({ agentId: "reader", source: "room", room: chan, limit: 10 });
  assert.ok(r.history, "precondition: the backlog must have overflowed");
  assert.match(r.history.digest, /TYPED DECISION IN DIGEST/);
  assert.match(r.history.digest, /LEGACY DECISION IN DIGEST/);
  assert.match(r.history.digest, /\[decision\] coord:/);
});

// ---------- 7.2: one definition ----------

test("the retention predicate is defined once and agrees everywhere", async () => {
  const { isDecision } = await import("../dist/tools/shared.js");
  assert.equal(isDecision({ kind: "decision" }), true);
  assert.equal(isDecision({ record: { type: "decision" } }), true);
  assert.equal(isDecision({ kind: "decision", record: { type: "fyi" } }), true, "monotone: it only ever grants");
  assert.equal(isDecision({ kind: "status", record: { type: "decision" } }), true);
  assert.equal(isDecision({ kind: "status" }), false);
  assert.equal(isDecision({ record: { type: "fyi" } }), false);
  assert.equal(isDecision({}), false);
  assert.equal(isDecision(undefined), false);

  // 7.2 is the durable half: a fourth copy of `kind === "decision"` in the
  // retention paths is how these three drifted apart in the first place.
  const sources = ["../src/tools/admin.ts", "../src/tools/messaging.ts"].map((f) =>
    readFileSync(new URL(f, import.meta.url), "utf8"),
  );
  for (const src of sources) {
    const copies = src.match(/kind === "decision"/g) ?? [];
    assert.equal(copies.length, 0, "retention must call isDecision, not re-compare the legacy field");
  }
});

// ---------- 7.4: no migration ----------

test("an existing file keeps working unchanged — the rule only ever grants", async () => {
  // A room written entirely by v1 agents (legacy `kind`, no `record` anywhere)
  // must behave exactly as it did before this change.
  const chan = "legacy-only";
  const now = Date.now();
  await store.ensureRoom(chan, "old-agent");
  await store.appendJsonl(store.roomFile(chan), { id: "l1", ts: now - 20 * DAY, from: "old", room: chan, text: "V1 DECISION", kind: "decision" });
  await store.appendJsonl(store.roomFile(chan), { id: "l2", ts: now - 20 * DAY, from: "old", room: chan, text: "V1 STATUS", kind: "status" });
  await store.appendJsonl(store.roomFile(chan), { id: "l3", ts: now - 20 * DAY, from: "old", room: chan, text: "V1 CHATTER" });

  await t.pruneTool({ olderThanDays: 7, decisionDays: 30, room: chan, targets: ["rooms"] });
  const kept = readRoom(chan);
  assert.deepEqual(kept.map((e) => e.text), ["V1 DECISION"]);
  // No field was added to anything on disk.
  assert.equal(kept.every((e) => e.record === undefined), true);
});
