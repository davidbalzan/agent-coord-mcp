// prune: `room` and `targets` compose — neither silently overrides the other.
//
// THE BUG: the target set was computed as
//   scopedRoom ? ["rooms"] : args.targets ?? [...PRUNE_TARGETS]
// so passing `room` DISCARDED an explicit `targets`. A caller asking
// `prune {room, targets:["members"], dryRun:true}` — "which members of this room
// are phantoms?" — got `orphanMembers: []` because the member sweep never ran.
// Not "swept and found clean": never evaluated. Meanwhile `roomMessages` (the one
// target the override left on) reported real messages a live run WOULD have
// archived, so the call did nothing it was asked to and something it wasn't.
//
// Found in the field: two room members that `ping` reported as `unregistered`
// were invisible to the sweep documented to remove exactly them.
//
// WHY NO EXISTING TEST CAUGHT IT: every prior prune test passes
// `{room, targets:["rooms"]}` — the one combination the override left correct,
// because the value it forced happened to equal what those callers asked for.
// The bug lived precisely in the untested combination.
//
// Second defect, same fix: both membership sweeps walk the room registry rather
// than the scoped `channels`, so `room` scoped the message sweep while
// membership swept EVERY room. A room-scoped call could evict members from
// unrelated rooms.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-prune-scope-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

// A phantom member: room membership retains an id the registry has lost.
//
// NOT built with unregister/force_unregister — those deliberately strip the agent
// from every channel's membership (registry.js), so they cannot produce this state.
// The field phantoms therefore arrived by a path that bypasses that cleanup (a
// registry rebuild or a direct edit), which is what this reproduces: drop the
// registry entry only, leaving membership intact.
async function phantomIn(room, agentId) {
  await t.registerTool({ agentId, role: "worker", project: "p" });
  await t.joinRoomTool({ agentId, room });
  const agentsFile = path.join(process.env.AGENT_COORD_DIR, "agents.json");
  const reg = JSON.parse(readFileSync(agentsFile, "utf8"));
  delete reg[agentId];
  writeFileSync(agentsFile, JSON.stringify(reg));
}

const members = async (room) =>
  (await t.listRoomsTool({})).rooms.find((r) => r.room === room)?.members ?? [];

test("room + targets:['members'] actually runs the member sweep (regression)", async () => {
  await phantomIn("alpha", "ghost-alpha");

  const r = await t.pruneTool({ room: "alpha", targets: ["members"], dryRun: true });

  // The regression returned [] here — the sweep was skipped, not clean.
  assert.deepEqual(
    r.wouldRemove.orphanMembers,
    ["ghost-alpha"],
    "explicit targets:['members'] must not be discarded by passing room"
  );
});

test("room scopes the member sweep — a phantom elsewhere is not reported", async () => {
  await phantomIn("beta", "ghost-beta");
  await phantomIn("gamma", "ghost-gamma");

  const r = await t.pruneTool({ room: "beta", targets: ["members"], dryRun: true });

  assert.ok(
    r.wouldRemove.orphanMembers.includes("ghost-beta"),
    "the scoped room's phantom must be reported"
  );
  assert.ok(
    !r.wouldRemove.orphanMembers.includes("ghost-gamma"),
    "a phantom in another room must NOT be reported by a room-scoped sweep"
  );
});

test("room alone still defaults to rooms-only (no member sweep)", async () => {
  await phantomIn("delta", "ghost-delta");

  const r = await t.pruneTool({ room: "delta", dryRun: true });

  // Documented behaviour preserved: `room` narrows the DEFAULT target set.
  assert.deepEqual(
    r.wouldRemove.orphanMembers,
    [],
    "room without targets keeps the rooms-only default"
  );
});

test("no room + targets:['members'] still sweeps every room", async () => {
  await phantomIn("eps-1", "ghost-eps-1");
  await phantomIn("eps-2", "ghost-eps-2");

  const r = await t.pruneTool({ targets: ["members"], dryRun: true });

  for (const id of ["ghost-eps-1", "ghost-eps-2"]) {
    assert.ok(r.wouldRemove.orphanMembers.includes(id), `${id} must be reported`);
  }
});

test("a LIVE room-scoped member prune evicts only the scoped room's phantom", async () => {
  await phantomIn("zeta", "ghost-zeta");
  await phantomIn("eta", "ghost-eta");

  await t.pruneTool({
    room: "zeta",
    targets: ["members"],
    dryRun: false,
    archiveEmptyRooms: false, // keep the rooms so membership is observable
  });

  assert.ok(!(await members("zeta")).includes("ghost-zeta"), "scoped phantom must be evicted");
  assert.ok(
    (await members("eta")).includes("ghost-eta"),
    "an unrelated room's membership must be untouched by a room-scoped prune"
  );
});
