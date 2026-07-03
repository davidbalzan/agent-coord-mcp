// Unit tests for the pure delivery-tier classifier (hooks/tier.mjs).
// Imported directly — no build step, no I/O, no coord state.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTier, isGateRunnerRole } from "../hooks/tier.mjs";

const dm = (text, extra = {}) => ({ kind: "DM", from: "peer", to: "me", text, ...extra });
const room = (text, extra = {}) => ({ kind: "room #proj", from: "peer", text, ...extra });

test("push-now prefixes classify urgent in DMs and rooms", () => {
  for (const make of [dm, room]) {
    assert.equal(classifyTier(make("BLOCKER: lane stuck on CI")), "urgent");
    assert.equal(classifyTier(make("DAVID_DECISION: prod rollback?")), "urgent");
    assert.equal(classifyTier(make("GO: P2 slice — spec follows")), "urgent");
    assert.equal(classifyTier(make("GO worker-1: start now")), "urgent");
    assert.equal(classifyTier(make("SCOPE: countersigned — widen slice to hooks/")), "urgent");
    assert.equal(classifyTier(make("SCOPE CHANGE: agreed with coordinator")), "urgent");
    assert.equal(classifyTier(make("/clear")), "urgent"); // control, injected raw
  }
});

test("routine traffic queues silently", () => {
  assert.equal(classifyTier(room("FYI: docs updated")), "routine");
  assert.equal(classifyTier(room("AGENT_ACTION: rebasing lane branch")), "routine");
  assert.equal(classifyTier(room("RISK: flaky test on main")), "routine");
  assert.equal(classifyTier(room("unprefixed chatter")), "routine");
  assert.equal(classifyTier(room("GOAL is not a GO prefix")), "routine");
  assert.equal(classifyTier({ kind: "room #proj", from: "peer" }), "routine"); // no text
});

test("DONE: routes to the gate runner only", () => {
  const done = "DONE: owner/repo#7 — merged scope, 12/12 green";
  assert.equal(classifyTier(dm(done)), "urgent"); // explicitly addressed
  assert.equal(classifyTier(room(done)), "routine"); // bystander lane
  assert.equal(classifyTier(room(done), { gateRunner: true }), "urgent"); // QA/coordinator
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
