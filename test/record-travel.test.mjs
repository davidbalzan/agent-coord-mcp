// Phase 8 Task 6: records travel structurally. A typed record whose text
// rendering spans lines is delivered to a pane as ONE attributed line plus a
// handle; the full record is retrieved by id from the source of truth.
// Throwaway state dir per file (see tools.test.mjs for the env-before-import
// rationale).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-travel-test-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const { sendMessageTool, retrieveMessageTool } = await import("../dist/tools/messaging.js");
const { renderRecord } = await import("../dist/tools/render.js");
const { injectLine, classifyTier } = await import("../hooks/tier.mjs");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const TS = Date.UTC(2026, 0, 1, 8, 5, 0);
const DECISION = {
  title: "publish v0.17.0",
  context: "tag exists, npm is 3 behind",
  options: ["publish now", "hold for the restart"],
  recommendation: "publish now",
  ifNoAction: "consumers stay on 0.13.0",
};
const PACKET = renderRecord({ type: "decision", payload: DECISION });
const HEADER = /^ {2}\[(\S+) (\d{2}:\d{2}) (\S+)\] (.*)$/;

// ---------- 6.1 one attributed line per message ----------

test("a multi-line typed record is delivered as ONE attributed line", () => {
  const out = injectLine({
    tag: "room #proj",
    from: "coord",
    ts: TS,
    id: "abc-123",
    text: PACKET,
    record: { type: "decision", payload: DECISION },
  });
  assert.equal(out.split("\n").length, 1, "must not span lines");
  assert.ok(HEADER.test(out), "must satisfy the single-line parse contract");
  assert.equal(
    out,
    "  [#proj 08:05 coord] DAVID_DECISION: publish v0.17.0 [+6 lines · record:decision · retrieve_message id=abc-123]",
  );
});

test("no line without a header ever reaches a pane, for any record type", () => {
  for (const type of ["decision", "blocker", "go", "verdict"]) {
    const text = type === "decision" ? PACKET : `line one\nline two\nline three`;
    const out = injectLine({ tag: "DM", from: "p", ts: TS, id: "i", text, record: { type } });
    for (const line of out.split("\n")) {
      assert.ok(HEADER.test(line), `${type}: unattributed line -> ${JSON.stringify(line)}`);
    }
  }
});

// ---------- 6.3 record-less messages unchanged, INCLUDING multi-line ----------

test("a record-LESS multi-line message renders byte-identically (unfixed, deliberately)", () => {
  // Task 6 does not fix hand-typed multi-line messages and must not change
  // their bytes. They still arrive unattributed past line 1, exactly as before.
  const bare = { tag: "room #proj", from: "coord", ts: TS, id: "abc-123", text: PACKET };
  const out = injectLine(bare);
  assert.equal(out.split("\n").length, 7, "still 7 lines — unchanged");
  assert.equal(out, `  [#proj 08:05 coord] ${PACKET}`);
  const lines = out.split("\n");
  assert.ok(HEADER.test(lines[0]));
  assert.ok(lines.slice(1).every((l) => !HEADER.test(l)), "continuation lines still bare");
});

test("a single-line record is untouched — digesting triggers only on multi-line", () => {
  const base = { tag: "DM", from: "p", ts: TS, id: "i", text: "BLOCKER: db down" };
  assert.equal(injectLine({ ...base, record: { type: "blocker" } }), injectLine(base));
  assert.equal(injectLine({ ...base, record: { type: "blocker" } }), "  [DM 08:05 p] BLOCKER: db down");
});

test("a multi-line record with no id is NOT digested — a handle must be retrievable", () => {
  // Digesting without a usable handle would destroy content with no way back.
  const out = injectLine({ tag: "DM", from: "p", ts: TS, text: PACKET, record: { type: "decision" } });
  assert.equal(out.split("\n").length, 7);
});

// ---------- boundary: tiering reads stored text, not the pane digest ----------

test("a digested DAVID_DECISION still tiers urgent", () => {
  // Tiering runs on the STORED message before rendering exists, and the record
  // floor carries it regardless of what the pane line looks like.
  const stored = { tag: "room #proj", from: "coord", ts: TS, id: "i", text: PACKET, record: { type: "decision" } };
  assert.equal(classifyTier(stored), "urgent");
  // Even if the digest line were the only thing tiering ever saw:
  const digested = injectLine(stored).replace(/^ {2}\[[^\]]+\] /, "");
  assert.equal(classifyTier({ tag: "room #proj", from: "coord", text: digested }), "urgent");
});

// ---------- 6.2 structural retrieval ----------

test("the handle expands to the full typed record", async () => {
  const r = await sendMessageTool({
    from: "coord",
    to: "reader",
    record: { type: "decision", payload: DECISION },
  });
  assert.equal(r.ok, true);
  const got = await retrieveMessageTool({ agentId: "reader", id: r.id });
  assert.equal(got.ok, true);
  assert.equal(got.source, "inbox");
  assert.equal(got.archived, false);
  assert.equal(got.record.type, "decision");
  assert.deepEqual(got.record.payload, DECISION);
  // The full multi-line rendering is recoverable too.
  assert.equal(got.message.text, PACKET);
});

test("retrieval works from a room the caller belongs to", async () => {
  await store.addMember("proj", "member-a");
  const r = await sendMessageTool({ from: "coord", room: "proj", record: { type: "decision", payload: DECISION } });
  const got = await retrieveMessageTool({ agentId: "member-a", id: r.id });
  assert.equal(got.ok, true);
  assert.equal(got.source, "room");
  assert.equal(got.room, "proj");
});

test("scoping: a handle for someone else's DM is not retrievable", async () => {
  const r = await sendMessageTool({
    from: "coord",
    to: "victim",
    record: { type: "decision", payload: DECISION },
  });
  const got = await retrieveMessageTool({ agentId: "snooper", id: r.id });
  assert.equal(got.ok, false);
  assert.match(got.error, /never have been delivered to you/);
});

test("scoping: a handle for a room the caller never joined is not retrievable", async () => {
  await store.addMember("private", "insider");
  const r = await sendMessageTool({ from: "insider", room: "private", record: { type: "decision", payload: DECISION } });
  assert.equal((await retrieveMessageTool({ agentId: "outsider", id: r.id })).ok, false);
  // …and the member still can.
  assert.equal((await retrieveMessageTool({ agentId: "insider", id: r.id })).ok, true);
});

test("an unknown id is a clean miss, not a throw", async () => {
  const got = await retrieveMessageTool({ agentId: "reader", id: "no-such-id" });
  assert.equal(got.ok, false);
});

// ---------- the archive fallback: why by-id beats a TTL'd stash ----------

test("a record compaction moved is STILL retrievable from the append-only archive", async () => {
  // Deliberately NOT a `decision`. Task 7 (d1ee0bd) made retention read
  // `record.type === "decision"` as well as the legacy `kind`, so a typed
  // decision now survives compaction for 30 days and cannot be used to
  // exercise the eviction path. An earlier version of this test used one and
  // its precondition stopped holding the moment that landed — which is the fix
  // working, not a regression.
  await store.addMember("bulk", "bulk-reader");
  const r = await sendMessageTool({
    from: "coord",
    room: "bulk",
    record: { type: "blocker", payload: { summary: "compacted away" } },
  });

  // Push past both compaction gates: >1000 entries AND >100KB.
  const pad = "x".repeat(300);
  for (let i = 0; i < 1100; i++) {
    await store.appendJsonl(store.roomFile("bulk"), { id: `filler-${i}`, ts: Date.now(), from: "n", room: "bulk", text: pad });
  }
  await sendMessageTool({ from: "coord", room: "bulk", text: "trigger compaction" });

  const live = await store.readJsonl(store.roomFile("bulk"));
  assert.ok(!live.some((m) => m.id === r.id), "precondition: compaction evicted it from the live file");

  const got = await retrieveMessageTool({ agentId: "bulk-reader", id: r.id });
  assert.equal(got.ok, true, "a stashed copy would have been unrecoverable; the archive is not");
  assert.equal(got.archived, true);
  assert.equal(got.record.type, "blocker");
});

// Suite-integrity counting deliberately lives in scripts/check-test-count.mjs
// (Task 7), NOT here. An earlier version of this file carried its own
// source-scanning counter, written before that script existed; two
// implementations of one job is the exact duplication Task 7.2 exists to
// prevent, so this one was dropped rather than kept alongside it. The script
// is the better home: it gates the whole suite as a pretest, reports the
// direction of a mismatch, and has an env override.
