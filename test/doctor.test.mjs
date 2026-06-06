// Tests for the bus-wide `doctor` health check. Own temp dir so the seeded
// corruption is isolated from the other suites.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-doctor-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

// Ignore the environment check — it warns when tmux isn't on PATH, which is
// machine-dependent and orthogonal to bus state.
const stateFindings = (r) => r.findings.filter((f) => f.check !== "environment");

test("doctor reports a clean bus as healthy and touches nothing", async () => {
  await t.registerTool({ agentId: "solo" });
  const r = await t.doctorTool({});
  assert.equal(r.ok, true);
  assert.equal(r.fixApplied, false);
  assert.equal(r.fixed, undefined);
  assert.equal(stateFindings(r).every((f) => f.level === "ok"), true, JSON.stringify(stateFindings(r).filter((f) => f.level !== "ok")));
});

test("doctor detects seeded corruption, fixes it, and a follow-up run is clean", async () => {
  // Orphan membership: a member that isn't in the registry.
  await store.addMember("#ghostchan", "ghostmember");
  // Orphan inbox: a DM to an unregistered recipient.
  await t.sendMessageTool({ from: "solo", to: "nobody", text: "hi" });
  // Cursor past EOF for a *registered* agent (isolates from orphan-cursor).
  await t.registerTool({ agentId: "reader2" });
  await store.writeJson(store.cursorFile("reader2"), { inboxOffset: 999 });
  // Malformed JSONL line in the default room.
  appendFileSync(store.ROOM_FILE, "{ this is not valid json\n");
  // Stale transport marker (pid that cannot be alive).
  await store.writeJson(store.transportFile("deadagent"), {
    agentId: "deadagent",
    transport: "tmux-push",
    pid: 2147483646,
    since: Date.now(),
  });

  const report = await t.doctorTool({});
  const by = Object.fromEntries(report.findings.map((f) => [f.check, f]));
  assert.equal(report.healthy, false);
  assert.equal(by["orphan-room-memberships"].level, "warn");
  assert.ok(by["orphan-room-memberships"].items.includes("ghostmember"));
  assert.equal(by["orphan-inboxes-cursors"].level, "warn");
  assert.equal(by["cursor-past-eof"].level, "error");
  assert.equal(by["malformed-jsonl"].level, "warn");
  assert.equal(by["orphan-transport-markers"].level, "warn");

  const fixRun = await t.doctorTool({ fix: true });
  assert.equal(fixRun.fixApplied, true);
  assert.ok(fixRun.fixed.length >= 5, JSON.stringify(fixRun.fixed));

  // Clean follow-up: every state finding back to ok.
  const after2 = await t.doctorTool({});
  const offenders = stateFindings(after2).filter((f) => f.level !== "ok");
  assert.equal(offenders.length, 0, JSON.stringify(offenders));
});

test("doctor judges remote markers by heartbeat, not pid", async () => {
  // A remote pusher publishes a marker with pid 0 (foreign host) and keeps the
  // registry heartbeat fresh. It must NOT be flagged as a dead-pid orphan.
  await t.registerTool({ agentId: "remoteagent" }); // fresh heartbeat
  await store.writeJson(store.transportFile("remoteagent"), {
    agentId: "remoteagent",
    transport: "tmux-push-remote",
    pid: 0,
    host: "otherbox",
    since: Date.now(),
  });
  const fresh = await t.doctorTool({});
  assert.equal(
    fresh.findings.find((f) => f.check === "orphan-transport-markers").level,
    "ok",
    "fresh remote marker (pid 0) must not be flagged as a dead pid",
  );

  // Age the heartbeat past STALE_MS (5 min) → the remote marker is now stale.
  await store.updateJson(store.AGENTS_FILE, {}, (cur) => {
    cur.remoteagent.lastHeartbeat = Date.now() - 10 * 60 * 1000;
    return cur;
  });
  const stale = await t.doctorTool({});
  const f = stale.findings.find((x) => x.check === "orphan-transport-markers");
  assert.equal(f.level, "warn");
  assert.ok(f.items.some((i) => i.includes("remoteagent")));
});
