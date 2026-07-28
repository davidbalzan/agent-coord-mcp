// Role identity (Phase 8 Task 4): frozen roleId + mutable displayName, and
// gate-runner resolution from the id instead of prose.
//
// Own temp dir — these tests write registry entries.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-roles-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
const srcRoles = await import("../dist/roles.js");
const hookRoles = await import("../hooks/roles.mjs");
const { isGateRunnerRole } = await import("../hooks/tier.mjs");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const readReg = () => JSON.parse(readFileSync(store.AGENTS_FILE, "utf8"));

// ---------- the two mirrors must not drift ----------

test("hooks/roles.mjs and src/roles.ts declare the same role ids", () => {
  for (const key of ["GATE_RUNNER_ROLE_IDS", "COORDINATOR_ROLE_IDS"]) {
    assert.deepEqual([...srcRoles[key]].sort(), [...hookRoles[key]].sort(), `${key} drifted`);
  }
  // ...and resolve identically on the shapes either side actually sees.
  for (const input of ["qa", "merge gate", "Repo Owner", { roleId: "aide", displayName: "Aide" }, { role: "coordinator" }, undefined]) {
    assert.deepEqual(srcRoles.resolveRole(input), hookRoles.resolveRole(input));
    assert.equal(srcRoles.isGateRunner(input), hookRoles.isGateRunner(input));
    assert.equal(srcRoles.isCoordinator(input), hookRoles.isCoordinator(input));
  }
});

// ---------- resolution ----------

test("a plain-string role maps to {roleId, displayName} with a derived id", () => {
  assert.deepEqual(srcRoles.resolveRole("QA / merge gate"), {
    roleId: "qa-merge-gate",
    displayName: "QA / merge gate",
    explicit: false,
  });
  assert.equal(srcRoles.resolveRole(undefined), undefined);
  assert.equal(srcRoles.resolveRole("   "), undefined);
});

test("a declared roleId is explicit and matches only exactly", () => {
  const r = srcRoles.resolveRole({ roleId: "aide", displayName: "David's aide" });
  assert.deepEqual(r, { roleId: "aide", displayName: "David's aide", explicit: true });
  // "gate-keeper" as free text still matches the legacy word rule...
  assert.equal(srcRoles.isGateRunner("gate keeper"), true);
  // ...but once frozen, only the id itself counts.
  assert.equal(srcRoles.isGateRunner({ roleId: "gate-keeper" }), false);
  assert.equal(srcRoles.isGateRunner({ roleId: "gate" }), true);
});

// ---------- gate-runner resolution ----------

test("isGateRunnerRole resolves from roleId, and renaming does not move the gate", () => {
  assert.equal(isGateRunnerRole({ roleId: "qa", displayName: "QA" }), true);
  // The rename that motivated this task: display name churns, id does not.
  assert.equal(isGateRunnerRole({ roleId: "qa", displayName: "quality liaison" }), true);
  assert.equal(isGateRunnerRole({ roleId: "qa", displayName: "totally unrelated name" }), true);
  // A non-gate id is not promoted by gate-ish prose in its display name.
  assert.equal(isGateRunnerRole({ roleId: "repo-owner", displayName: "repo owner (runs the gate script)" }), false);
});

test("isGateRunnerRole keeps the legacy prose match for un-migrated entries", () => {
  assert.equal(isGateRunnerRole("qa"), true);
  assert.equal(isGateRunnerRole("quality-controller"), true);
  assert.equal(isGateRunnerRole("coordinator"), true);
  assert.equal(isGateRunnerRole("merge gate"), true);
  assert.equal(isGateRunnerRole("repo-owner"), false);
  assert.equal(isGateRunnerRole(undefined), false);
  // Whole registry entries resolve too — that is what the pusher passes.
  assert.equal(isGateRunnerRole({ agentId: "a", role: "merge gate" }), true);
  assert.equal(isGateRunnerRole({ agentId: "a", role: "worker" }), false);
});

// ---------- registry back-compat ----------

test("an existing agents.json with plain-string roles loads unmodified", async () => {
  // A v1 entry: `role` free text, no roleId, no other new field. Timestamps are
  // fresh only so list_agents' 24h eviction doesn't drop them mid-test.
  const now = Date.now();
  const legacy = {
    "old-qa": { agentId: "old-qa", role: "qa lead", registeredAt: now, lastHeartbeat: now },
    "old-dev": { agentId: "old-dev", role: "repo owner", registeredAt: now, lastHeartbeat: now },
  };
  writeFileSync(store.AGENTS_FILE, JSON.stringify(legacy));

  const listed = await t.listAgentsTool();
  const byId = Object.fromEntries(listed.agents.map((a) => [a.agentId, a]));
  assert.equal(byId["old-qa"].role, "qa lead");
  assert.equal(byId["old-qa"].roleId, undefined, "no roleId is invented for a legacy entry");
  assert.equal(srcRoles.isGateRunner(byId["old-qa"]), true);
  assert.equal(srcRoles.isGateRunner(byId["old-dev"]), false);

  // Re-registering with new free text still just moves the string (v1 behavior).
  const r = await t.registerTool({ agentId: "old-qa", role: "quality gate" });
  assert.equal(r.ok, true);
  assert.equal(readReg()["old-qa"].role, "quality gate");
  assert.equal(readReg()["old-qa"].roleId, undefined);
});

test("roleId is immutable once declared while displayName stays free", async () => {
  const first = await t.registerTool({ agentId: "aide-1", role: { roleId: "aide", displayName: "curator" } });
  assert.equal(first.ok, true);
  assert.deepEqual(first.resolvedRole, { roleId: "aide", displayName: "curator", explicit: true });

  // Rename #1 and #2 — the churn this task exists to stop.
  const renamed = await t.registerTool({ agentId: "aide-1", role: { displayName: "liaison" } });
  assert.equal(renamed.ok, true);
  assert.equal(readReg()["aide-1"].roleId, "aide");
  assert.equal(readReg()["aide-1"].role, "liaison");

  // A bare string is a display-name change too — it never re-freezes the id.
  const bare = await t.registerTool({ agentId: "aide-1", role: "aide" });
  assert.equal(bare.ok, true);
  assert.equal(readReg()["aide-1"].roleId, "aide");
  assert.equal(readReg()["aide-1"].role, "aide");

  // Changing the id itself is refused, and nothing on disk moves.
  const rejected = await t.registerTool({ agentId: "aide-1", role: { roleId: "liaison" } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /frozen/);
  assert.equal(readReg()["aide-1"].roleId, "aide");

  // Re-declaring the SAME id is a no-op, not a conflict.
  const same = await t.registerTool({ agentId: "aide-1", role: { roleId: "aide", displayName: "aide" } });
  assert.equal(same.ok, true);
});

test("join refuses rather than attaching under a rejected role change", async () => {
  await t.registerTool({ agentId: "gate-1", role: { roleId: "qa" } });
  const j = await t.joinTool({ agentId: "gate-1", role: { roleId: "coordinator" }, attach: false, readInbox: false });
  assert.equal(j.ok, false);
  assert.match(j.error, /frozen/);
  assert.equal(readReg()["gate-1"].roleId, "qa");
});
