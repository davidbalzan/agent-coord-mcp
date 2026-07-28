// Record authority (Phase 8 Task 4): which role may emit which record.type,
// enforced at the send path. Own temp dir — seeds its own registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-authority-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

await t.registerTool({ agentId: "coord", role: { roleId: "coordinator" } });
await t.registerTool({ agentId: "gate", role: { roleId: "qa" } });
await t.registerTool({ agentId: "worker", role: { roleId: "repo-owner" } });
await t.registerTool({ agentId: "roleless" });
await t.registerTool({ agentId: "legacy-qa", role: "quality gate" });

const roomLines = (chan) => {
  const f = store.roomFile(chan);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
};

test("verdict is gate-runners only", async () => {
  const okRes = await t.sendMessageTool({
    from: "gate",
    room: "authz",
    text: "PASS: #123",
    record: { type: "verdict", cites: [{ kind: "pr", ref: "#123" }] },
  });
  assert.equal(okRes.ok, true);

  const res = await t.sendMessageTool({ from: "worker", room: "authz", text: "PASS: #123", record: { type: "verdict" } });
  assert.equal(res.ok, false, "a worker must not emit a verdict");
  assert.match(res.error, /restricted to gate-runner roles/);

  // `coordinator` is itself a gate-runner id (it consumes DONE: when no QA is
  // seated — see GATE_RUNNER_ROLE_IDS), so it may issue verdicts too.
  const byCoord = await t.sendMessageTool({ from: "coord", room: "authz", text: "PASS: #123", record: { type: "verdict" } });
  assert.equal(byCoord.ok, true);

  // A legacy free-text role still resolves — the check is not a migration wall.
  const legacy = await t.sendMessageTool({ from: "legacy-qa", room: "authz", text: "PASS", record: { type: "verdict" } });
  assert.equal(legacy.ok, true);
});

test("go and scope are coordinators only", async () => {
  for (const type of ["go", "scope"]) {
    const good = await t.sendMessageTool({ from: "coord", room: "authz", text: `${type} order`, record: { type } });
    assert.equal(good.ok, true);
    for (const from of ["worker", "gate"]) {
      const res = await t.sendMessageTool({ from, room: "authz", text: `${type} order`, record: { type } });
      assert.equal(res.ok, false, `${from} must not emit '${type}'`);
      assert.match(res.error, /restricted to coordinator roles/);
    }
  }
});

test("a sender with no role (or no registry entry) is refused a restricted type", async () => {
  const noRole = await t.sendMessageTool({ from: "roleless", room: "authz", text: "GO", record: { type: "go" } });
  assert.equal(noRole.ok, false);
  assert.match(noRole.error, /holds no role/);

  const stranger = await t.sendMessageTool({ from: "ghost", room: "authz", text: "GO", record: { type: "go" } });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /no registry entry/);
});

test("every other record type is unrestricted, and untyped sends are untouched", async () => {
  for (const type of ["blocker", "decision", "risk", "fyi", "action"]) {
    const res = await t.sendMessageTool({ from: "worker", room: "authz", text: `${type}!`, record: { type } });
    assert.equal(res.ok, true, `${type} must stay unrestricted`);
  }
  // `done` is unrestricted by role too — it just has to cite (Task 3).
  const done = await t.sendMessageTool({
    from: "worker",
    room: "authz",
    text: "DONE: x",
    record: { type: "done", cites: [{ kind: "pr", ref: "owner/repo#7" }] },
  });
  assert.equal(done.ok, true, "done must stay unrestricted");
  const plain = await t.sendMessageTool({ from: "worker", room: "authz", text: "just chatter" });
  assert.equal(plain.ok, true);
});

test("a rejected record writes nothing — not to the room, not to an inbox", async () => {
  const before = roomLines("authz").length;
  const res = await t.sendMessageTool({ from: "worker", room: "authz", text: "PASS", record: { type: "verdict" } });
  assert.equal(res.ok, false);
  assert.equal(roomLines("authz").length, before);

  const dm = await t.sendMessageTool({ from: "worker", to: "coord", text: "PASS", record: { type: "verdict" } });
  assert.equal(dm.ok, false);
  assert.equal(existsSync(store.inboxFile("coord")), false);
});

test("authority follows the frozen id, not the display name", async () => {
  // Renaming the gate role does not disarm it...
  await t.registerTool({ agentId: "gate", role: { displayName: "release captain" } });
  const still = await t.sendMessageTool({ from: "gate", room: "authz", text: "PASS", record: { type: "verdict" } });
  assert.equal(still.ok, true);

  // ...and a worker cannot acquire it by calling itself one.
  await t.registerTool({ agentId: "worker", role: { displayName: "qa coordinator gate" } });
  const nope = await t.sendMessageTool({ from: "worker", room: "authz", text: "PASS", record: { type: "verdict" } });
  assert.equal(nope.ok, false);
});

test("register echoes what this role may and may not emit", async () => {
  // The onboarding signal: authority is otherwise invisible until a typed send
  // is refused mid-work.
  const worker = await t.registerTool({ agentId: "fresh-worker", role: "dev session" });
  assert.deepEqual(worker.recordAuthority.mayEmit, []);
  assert.deepEqual(worker.recordAuthority.mayNotEmit.sort(), ["go", "scope", "verdict"]);
  assert.match(worker.recordAuthority.note, /register with the owning role/);

  const coord = await t.registerTool({ agentId: "fresh-coord", role: { roleId: "coordinator" } });
  assert.deepEqual(coord.recordAuthority.mayEmit.sort(), ["go", "scope", "verdict"]);
  assert.deepEqual(coord.recordAuthority.mayNotEmit, []);
  assert.equal(coord.recordAuthority.note, undefined);

  // join carries the same echo through (it delegates to register).
  const joined = await t.joinTool({ agentId: "fresh-gate", role: { roleId: "qa" }, attach: false, readInbox: false });
  assert.deepEqual(joined.registered.roleId, "qa");
});
