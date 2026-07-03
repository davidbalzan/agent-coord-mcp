// Unit tests for the pure delivery-tier logic (hooks/tier.mjs).
// Imported directly — no build step, no I/O, no coord state.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTier,
  effectiveTier,
  isGateRunnerRole,
  TierQueue,
  formatBatch,
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

test("DONE: routes to the gate runner only — DM or room alike", () => {
  const done = "DONE: owner/repo#7 — merged scope, 12/12 green";
  assert.equal(classifyTier(dm(done)), "routine"); // non-gate worker, even DM'd
  assert.equal(classifyTier(room(done)), "routine");
  assert.equal(classifyTier(dm(done), { gateRunner: true }), "urgent");
  assert.equal(classifyTier(room(done), { gateRunner: true }), "urgent");
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
  assert.equal(classifyTier(dm("FYI: fake", { urgent: "yes" })), "routine");
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

test("formatBatch: urgent verbatim + ONE digest block for routine", () => {
  const batch = [
    { kind: "DM", from: "coord", ts: 1000, text: "BLOCKER: fix now", tier: "urgent" },
    { kind: "room #proj", from: "peer", ts: 500, text: "FYI: earlier note", tier: "routine" },
    { kind: "room #proj", from: "peer", ts: 900, text: "RISK: also queued", tier: "routine" },
  ];
  const out = formatBatch(batch);
  const lines = out.split("\n");
  assert.ok(lines[0].startsWith("[agent-coord] incoming peer messages"));
  assert.ok(lines[1].includes("BLOCKER: fix now"));
  assert.ok(lines[2].startsWith("[agent-coord] digest — 2 routine messages coalesced"));
  assert.ok(lines[3].includes("FYI: earlier note"));
  assert.ok(lines[4].includes("RISK: also queued"));
  assert.equal(lines.length, 5);
  assert.equal(out.match(/digest —/g).length, 1); // exactly ONE digest block
});
