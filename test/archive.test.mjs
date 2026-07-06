// v0.15.0 noise-lifecycle tests: archive-not-delete, scoped prune, membership
// TTL, empty-room archival, message kinds, live compaction. Throwaway state
// dir per file (see tools.test.mjs for the env-before-import rationale).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-archive-test-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");
process.env.AGENT_COORD_ROOM_MAX = "20";
process.env.AGENT_COORD_ROOM_KEEP = "10";

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const readArchive = (file) =>
  readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

test("archiveJsonl moves filtered-out entries to the archive file", async () => {
  const live = path.join(tmp, "live.jsonl");
  const arch = path.join(tmp, "arch.jsonl");
  await store.appendJsonl(live, { ts: 1, text: "old" });
  await store.appendJsonl(live, { ts: 2, text: "new" });
  const r = await store.archiveJsonl(live, arch, (e) => e.ts > 1);
  assert.deepEqual(r, { kept: 1, removed: 1, archived: 1 });
  assert.equal((await store.readJsonl(live)).length, 1);
  assert.deepEqual(readArchive(arch)[0], { ts: 1, text: "old" });
});

test("prune archives aged room messages instead of deleting them", async () => {
  await t.registerTool({ agentId: "amy" });
  const old = { id: "m-old", ts: Date.now() - 3 * DAY, from: "amy", room: "general", text: "aged chatter" };
  await store.appendJsonl(store.roomFile("general"), old);
  await t.sendMessageTool({ from: "amy", text: "fresh" });

  const res = await t.pruneTool({ olderThanDays: 1 });
  assert.equal(res.removed.roomMessages, 1);
  const archived = readArchive(store.archiveRoomFile("general"));
  assert.equal(archived.some((m) => m.id === "m-old"), true);
  const liveTexts = (await store.readJsonl(store.roomFile("general"))).map((m) => m.text);
  assert.equal(liveTexts.includes("aged chatter"), false);
  assert.equal(liveTexts.includes("fresh"), true);
});

test("room-scoped prune leaves other channels and status untouched", async () => {
  const oldTs = Date.now() - 3 * DAY;
  await store.appendJsonl(store.roomFile("alpha"), { id: "a1", ts: oldTs, from: "amy", room: "alpha", text: "x" });
  await store.appendJsonl(store.roomFile("beta"), { id: "b1", ts: oldTs, from: "amy", room: "beta", text: "y" });
  await store.appendJsonl(store.STATUS_FILE, { id: "s1", ts: oldTs, agentId: "amy", status: "old" });

  const res = await t.pruneTool({ olderThanDays: 1, room: "#alpha" });
  assert.equal(res.room, "alpha");
  assert.equal(res.removed.roomMessages, 1);
  assert.equal(res.removed.statusEntries, 0);
  assert.equal((await store.readJsonl(store.roomFile("alpha"))).length, 0);
  assert.equal((await store.readJsonl(store.roomFile("beta"))).length, 1);
  assert.equal((await store.readJsonl(store.STATUS_FILE)).length, 1);
});

test("kind=decision outlives olderThanDays but not decisionDays", async () => {
  const mk = (id, ts, kind) => ({ id, ts, from: "amy", room: "kinds", text: id, ...(kind ? { kind } : {}) });
  const now = Date.now();
  await store.appendJsonl(store.roomFile("kinds"), mk("chatter-old", now - 3 * DAY));
  await store.appendJsonl(store.roomFile("kinds"), mk("decision-fresh", now - 3 * DAY, "decision"));
  await store.appendJsonl(store.roomFile("kinds"), mk("decision-ancient", now - 40 * DAY, "decision"));

  await t.pruneTool({ olderThanDays: 1, room: "kinds" });
  const ids = (await store.readJsonl(store.roomFile("kinds"))).map((m) => m.id);
  assert.deepEqual(ids, ["decision-fresh"]);
});

test("prune sweeps members with stale heartbeats and archives dead rooms", async () => {
  await t.registerTool({ agentId: "live-agent" });
  await t.registerTool({ agentId: "stale-agent" });
  await t.joinRoomTool({ agentId: "live-agent", room: "mixed" });
  await t.joinRoomTool({ agentId: "stale-agent", room: "mixed" });
  await t.joinRoomTool({ agentId: "stale-agent", room: "doomed" });

  // Backdate stale-agent's heartbeat past the cutoff.
  await store.updateJson(store.AGENTS_FILE, {}, (reg) => {
    reg["stale-agent"].lastHeartbeat = Date.now() - 3 * DAY;
    return reg;
  });
  // Backdate doomed's join notice so the room counts as inactive.
  await store.rewriteJsonl(store.roomFile("doomed"), () => false);
  await store.appendJsonl(store.roomFile("doomed"), { id: "d1", ts: Date.now() - 3 * DAY, from: "stale-agent", room: "doomed", text: "bye" });

  const res = await t.pruneTool({ olderThanDays: 1 });
  assert.equal(res.removed.staleMembers.includes("stale-agent"), true);
  assert.equal(res.removed.archivedRooms.includes("doomed"), true);

  const rooms = await store.getRooms();
  assert.deepEqual(rooms["mixed"].members, ["live-agent"]);
  assert.equal("doomed" in rooms, false);
  assert.equal(existsSync(store.roomFile("doomed")), false);
  assert.equal(readArchive(store.archiveRoomFile("doomed")).some((m) => m.id === "d1"), true);
});

test("rooms self-compact past the threshold and cursors stay coherent", async () => {
  await t.registerTool({ agentId: "reader" });
  await t.joinRoomTool({ agentId: "reader", room: "busy" });
  await t.readMessagesTool({ agentId: "reader", source: "room", room: "busy" }); // park cursor at head

  // Pad each message so the file clears the 100KB size gate at low counts.
  const pad = "x".repeat(6000);
  for (let i = 0; i < 25; i++) {
    await t.sendMessageTool({ from: "writer", room: "busy", text: `msg-${i} ${pad}` });
  }

  const live = await store.readJsonl(store.roomFile("busy"));
  assert.ok(live.length <= 20, `expected compaction to cap live file, got ${live.length}`);
  assert.ok(readArchive(store.archiveRoomFile("busy")).length > 0);

  // Reader parked before the compacted range must still read without error
  // and see the retained tail (possibly via an overflow digest).
  const read = await t.readMessagesTool({ agentId: "reader", source: "room", room: "busy" });
  assert.equal(read.ok, true);
  assert.ok(read.returned > 0);
});
