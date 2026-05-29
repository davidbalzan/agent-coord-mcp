// Integration tests for the core message-bus flows against a throwaway state
// dir. AGENT_COORD_DIR is set BEFORE importing dist/store.js because ROOT is
// resolved once at module load. Node's test runner gives each file its own
// process, so this env override is isolated.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-test-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

test("DM round-trips and read advances the cursor", async () => {
  await t.registerTool({ agentId: "alice" });
  await t.registerTool({ agentId: "bob" });

  const sent = await t.sendMessageTool({ from: "alice", to: "bob", text: "hi" });
  assert.equal(sent.ok, true);

  const first = await t.readMessagesTool({ agentId: "bob", source: "inbox" });
  assert.equal(first.ok, true);
  assert.equal(first.returned, 1);
  assert.equal(first.messages[0].text, "hi");

  const second = await t.readMessagesTool({ agentId: "bob", source: "inbox" });
  assert.equal(second.returned, 0); // cursor advanced past the only message
});

test("DM to an unregistered recipient still delivers but warns", async () => {
  const res = await t.sendMessageTool({ from: "alice", to: "ghost", text: "x" });
  assert.equal(res.ok, true);
  assert.match(res.warning ?? "", /not a registered agent/);
});

test("unregister strips the agent from channel memberships", async () => {
  await t.registerTool({ agentId: "carol" });
  await t.joinRoomTool({ agentId: "carol", room: "#proj" });

  let rooms = await t.listRoomsTool();
  assert.deepEqual(rooms.rooms.find((r) => r.room === "proj").members, ["carol"]);

  const u = await t.unregisterTool({ agentId: "carol" });
  assert.deepEqual(u.leftRooms, ["proj"]);

  rooms = await t.listRoomsTool();
  assert.deepEqual(rooms.rooms.find((r) => r.room === "proj").members, []);
});

test("rename migrates the inbox and renames channel membership", async () => {
  await t.registerTool({ agentId: "old" });
  await t.joinRoomTool({ agentId: "old", room: "#proj" });
  await t.sendMessageTool({ from: "alice", to: "old", text: "queued-before-rename" });

  const r = await t.renameAgentTool({ agentId: "old", newAgentId: "fresh" });
  assert.equal(r.ok, true);
  assert.equal(r.detachedTransport, false); // no live pusher in tests

  const read = await t.readMessagesTool({ agentId: "fresh", source: "inbox" });
  assert.ok(read.messages.some((m) => m.text === "queued-before-rename"));

  const rooms = await t.listRoomsTool();
  assert.ok(rooms.rooms.find((r) => r.room === "proj").members.includes("fresh"));
});

test("room reads filter out the reader's own posts", async () => {
  await t.registerTool({ agentId: "selfposter" });
  await t.sendMessageTool({ from: "selfposter", room: "#echo", text: "mine" });
  await t.sendMessageTool({ from: "alice", room: "#echo", text: "theirs" });

  const r = await t.readMessagesTool({ agentId: "selfposter", source: "room", room: "#echo" });
  const texts = r.messages.map((m) => m.text);
  assert.ok(!texts.includes("mine"), "own post should be filtered");
  assert.ok(texts.includes("theirs"));
});

test("prune drops old messages and shifts the reader's cursor to stay aligned", async () => {
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await store.appendJsonl(store.ROOM_FILE, { id: "old1", ts: old, from: "x", room: "general", text: "ancient" });
  await store.appendJsonl(store.ROOM_FILE, { id: "new1", ts: Date.now(), from: "x", room: "general", text: "recent" });

  // Reader consumes everything currently in #general → cursor at EOF.
  await t.readMessagesTool({ agentId: "reader", source: "room" });

  const res = await t.pruneTool({ olderThanDays: 7 });
  assert.ok(res.removed.roomMessages >= 1, "should remove the ancient message");

  // Cursor was shifted down by the removed count, so the reader still sees
  // nothing new (no phantom re-delivery of already-read recent messages).
  const after = await t.readMessagesTool({ agentId: "reader", source: "room" });
  assert.equal(after.returned, 0);
});
