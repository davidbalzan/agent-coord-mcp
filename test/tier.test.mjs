// Unit tests for the pure delivery-tier logic (hooks/tier.mjs).
// Imported directly — no build step, no I/O, no coord state.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyTier,
  effectiveTier,
  isGateRunnerRole,
  TierQueue,
  formatBatch,
  injectLine,
} from "../hooks/tier.mjs";

const dm = (text, extra = {}) => ({ kind: "DM", from: "peer", to: "me", text, ...extra });
const room = (text, extra = {}) => ({ kind: "room #proj", from: "peer", text, ...extra });

test("push-now prefixes classify urgent in DMs and rooms", () => {
  for (const make of [dm, room]) {
    assert.equal(classifyTier(make("BLOCKER: lane stuck on CI")), "urgent");
    assert.equal(classifyTier(make("DAVID_DECISION: prod rollback?")), "urgent");
    assert.equal(classifyTier(make("GO: P2 slice — spec follows")), "urgent");
    assert.equal(classifyTier(make("/clear")), "urgent"); // control, injected raw
  }
});

test("prefixes are literal and case-sensitive; prose lookalikes queue", () => {
  assert.equal(classifyTier(room("GO ahead and take your time")), "routine");
  assert.equal(classifyTier(room("GOAL is not a GO prefix")), "routine");
  assert.equal(classifyTier(room("blocker: lowercase is chatter")), "routine");
  assert.equal(classifyTier(room("done: lowercase"), { gateRunner: true }), "routine");
  assert.equal(classifyTier(room("re: BLOCKER: quoted mid-body")), "routine");
});

test("routine traffic queues silently", () => {
  assert.equal(classifyTier(room("FYI: docs updated")), "routine");
  assert.equal(classifyTier(room("AGENT_ACTION: rebasing lane branch")), "routine");
  assert.equal(classifyTier(room("RISK: flaky test on main")), "routine");
  assert.equal(classifyTier(room("unprefixed chatter")), "routine");
  assert.equal(classifyTier({ kind: "room #proj", from: "peer" }), "routine"); // no text
});

test("DONE: in a room routes to the gate runner only (DMs are always urgent)", () => {
  const done = "DONE: owner/repo#7 — merged scope, 12/12 green";
  assert.equal(classifyTier(dm(done)), "urgent"); // DM — push-now regardless of gate
  assert.equal(classifyTier(room(done)), "routine");
  assert.equal(classifyTier(room(done), { gateRunner: true }), "urgent");
});

test("DMs are always urgent — point-to-point asks never queue", () => {
  assert.equal(classifyTier(dm("unprefixed relay of a David question")), "urgent");
  assert.equal(classifyTier(dm("FYI: even low-priority DMs push now")), "urgent");
  assert.equal(classifyTier(room("unprefixed chatter stays routine")), "routine");
});

test("SCOPE: is honored only from trusted (coordinator/gate) senders", () => {
  const trustedSenders = new Set(["proj-coordinator"]);
  const scope = "SCOPE: countersigned — widen slice to hooks/";
  assert.equal(classifyTier(room(scope)), "routine"); // no trust context
  assert.equal(classifyTier(room(scope), { trustedSenders }), "routine"); // untrusted peer
  assert.equal(
    classifyTier({ ...room(scope), from: "proj-coordinator" }, { trustedSenders }),
    "urgent",
  );
  assert.equal(
    classifyTier({ ...room("SCOPE CHANGE: agreed"), from: "proj-coordinator" }, { trustedSenders }),
    "urgent",
  );
});

test("server-set urgent flag pushes regardless of text; not text-spoofable", () => {
  assert.equal(classifyTier(dm("[agent-coord] context reset by /clear…", { urgent: true })), "urgent");
  assert.equal(classifyTier(dm("anything at all", { urgent: true })), "urgent");
  // The flag must be the boolean true set server-side, not truthy text games.
  assert.equal(classifyTier(room("FYI: fake", { urgent: "yes" })), "routine");
  // system join/part notices stay routine.
  assert.equal(classifyTier(room("worker-9 has joined", { system: true })), "routine");
});

test("effectiveTier: enabled=false restores legacy push-everything", () => {
  assert.equal(effectiveTier(room("FYI: routine"), { enabled: false }), "urgent");
  assert.equal(effectiveTier(room("FYI: routine"), { enabled: true }), "routine");
  assert.equal(effectiveTier(room("FYI: routine"), {}), "routine"); // default: tiers on
});

test("isGateRunnerRole matches QA/coordinator roles only", () => {
  assert.equal(isGateRunnerRole("qa"), true);
  assert.equal(isGateRunnerRole("quality-controller"), true);
  assert.equal(isGateRunnerRole("coordinator"), true);
  assert.equal(isGateRunnerRole("merge gate"), true);
  assert.equal(isGateRunnerRole("repo-owner"), false);
  assert.equal(isGateRunnerRole("consumer-owner"), false);
  assert.equal(isGateRunnerRole(undefined), false);
});

test("TierQueue: routine-only ingest never pushes; trigger drains the backlog", () => {
  const q = new TierQueue();
  const r1 = { ...room("FYI: one"), tier: "routine" };
  const r2 = { ...room("RISK: two"), tier: "routine" };
  assert.equal(q.ingest([r1]), null);
  assert.equal(q.ingest([r2]), null);
  assert.equal(q.ingest([]), null);
  assert.equal(q.size(), 2);

  const trigger = { ...dm("BLOCKER: go now"), tier: "urgent" };
  const batch = q.ingest([trigger]);
  assert.deepEqual(batch, [trigger, r1, r2]); // trigger first, backlog coalesced
  assert.equal(q.size(), 0); // drained — next push starts a fresh digest
});

test("TierQueue: max-age flush drains an overdue routine backlog", () => {
  const q = new TierQueue({ maxAgeMs: 1000 });
  const r1 = { ...room("FYI: one"), tier: "routine" };
  const r2 = { ...room("RISK: two"), tier: "routine" };
  assert.equal(q.ingest([r1], 0), null);
  assert.equal(q.ingest([r2], 400), null);
  // Age is measured from the OLDEST entry, not the newest.
  assert.equal(q.flushOverdue(999), null);
  assert.deepEqual(q.flushOverdue(1000), [r1, r2]);
  assert.equal(q.size(), 0);
  // Drained — nothing further to flush, and the age clock has reset.
  assert.equal(q.flushOverdue(5000), null);
  assert.equal(q.ingest([{ ...room("FYI: three"), tier: "routine" }], 6000), null);
  assert.equal(q.flushOverdue(6999), null); // not overdue relative to new oldest
  assert.equal(q.flushOverdue(7000)?.length, 1);
});

test("TierQueue: urgent drain resets the max-age clock", () => {
  const q = new TierQueue({ maxAgeMs: 1000 });
  q.ingest([{ ...room("FYI: old"), tier: "routine" }], 0);
  const trigger = { ...dm("GO: now"), tier: "urgent" };
  assert.equal(q.ingest([trigger], 500).length, 2); // backlog rode the trigger
  assert.equal(q.flushOverdue(10_000), null); // nothing left to age out
});

test("TierQueue: maxAgeMs of 0 (default) never age-flushes", () => {
  const q = new TierQueue();
  q.ingest([{ ...room("FYI: forever"), tier: "routine" }], 0);
  assert.equal(q.flushOverdue(Number.MAX_SAFE_INTEGER), null);
  assert.equal(q.size(), 1);
});

// 2026-01-01T08:05:00Z — fixed instant so the HH:MM assertion is stable.
const TS_0805 = Date.UTC(2026, 0, 1, 8, 5, 0);

test("injectLine: compact parse-contract format (v0.14.0)", () => {
  // room kind → "#" stripped of "room "; HH:MM UTC; no "from=" label.
  assert.equal(
    injectLine({ kind: "room #general", from: "mcp-coord", ts: TS_0805, text: "GO: start" }),
    "  [#general 08:05 mcp-coord] GO: start",
  );
  // DM kind is left as-is (no "room " prefix to strip).
  assert.equal(
    injectLine({ kind: "DM", from: "peer", ts: TS_0805, text: "hi" }),
    "  [DM 08:05 peer] hi",
  );
  // Missing text renders as empty, hours/minutes always zero-padded.
  assert.equal(injectLine({ kind: "DM", from: "a", ts: Date.UTC(2026, 0, 1, 3, 9) }), "  [DM 03:09 a] ");
});

test("parse contract: from/room/text recoverable from an injectLine", () => {
  // The shape a harness relies on: split on the FIRST "] ", then the 3
  // space-separated header tokens are [kind, HH:MM, from]. text may contain
  // anything (including "]") and is preserved intact.
  const line = injectLine({
    kind: "room #coord-mcp",
    from: "coord-mcp-worker-1",
    ts: TS_0805,
    text: "DONE: owner/repo#5 [gate green] merged",
  });
  const m = line.match(/^ {2}\[(\S+) (\d{2}:\d{2}) (\S+)\] (.*)$/);
  assert.ok(m, "line must match the parse-contract regex");
  assert.equal(m[1], "#coord-mcp"); // room
  assert.equal(m[2], "08:05");
  assert.equal(m[3], "coord-mcp-worker-1"); // from
  assert.equal(m[4], "DONE: owner/repo#5 [gate green] merged"); // text intact, incl. "]"
});

test("formatBatch: compact banners + ONE digest block, compact lines", () => {
  const batch = [
    { kind: "DM", from: "coord", ts: TS_0805, text: "BLOCKER: fix now", tier: "urgent" },
    { kind: "room #proj", from: "peer", ts: TS_0805, text: "FYI: earlier note", tier: "routine" },
    { kind: "room #proj", from: "peer", ts: TS_0805, text: "RISK: also queued", tier: "routine" },
  ];
  const lines = formatBatch(batch).split("\n");
  assert.equal(lines[0], "[agent-coord] msgs (pre-consumed, don't re-read):");
  assert.equal(lines[1], "  [DM 08:05 coord] BLOCKER: fix now");
  assert.equal(lines[2], "[agent-coord] +2 routine (pre-consumed, FYI, no reply):");
  assert.equal(lines[3], "  [#proj 08:05 peer] FYI: earlier note");
  assert.equal(lines[4], "  [#proj 08:05 peer] RISK: also queued");
  assert.equal(lines.length, 5);
});

test("formatBatch: urgent-only batch emits no routine banner", () => {
  const lines = formatBatch([
    { kind: "DM", from: "coord", ts: TS_0805, text: "GO: go", tier: "urgent" },
  ]).split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.includes("routine")));
});

test("parse-contract line is byte-identical across both pushers", () => {
  // The standalone coord-pusher registers on import, so it can't be imported
  // here — assert its injectLine SOURCE matches hooks/tier.mjs's instead. This
  // directly enforces the hard constraint: the parse-contract line must be
  // identical across both delivery paths, or a harness parses one wrong.
  const extract = (url) => {
    const src = readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
    const m = src.match(/function injectLine\(m\) \{([\s\S]*?)\n\}/);
    assert.ok(m, `injectLine not found in ${url}`);
    return m[1].trim();
  };
  assert.equal(extract("../hooks/tier.mjs"), extract("../scripts/coord-pusher.mjs"));
});
