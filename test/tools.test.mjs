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

test("send_command rejects a command outside the locked allowlist", async () => {
  const r = await t.sendCommandTool({ from: "lead", to: "sub", command: "/rm" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported|Allowed/);
});

test("send_command requires exactly one of 'to' or 'room'", async () => {
  const none = await t.sendCommandTool({ from: "lead", command: "clear" });
  assert.equal(none.ok, false);
  const both = await t.sendCommandTool({ from: "lead", to: "x", room: "#y", command: "clear" });
  assert.equal(both.ok, false);
});

test("send_command refuses a target with no live tmux transport (gate to tmux)", async () => {
  await t.registerTool({ agentId: "subnotmux" });
  const r = await t.sendCommandTool({ from: "lead", to: "subnotmux", command: "clear" });
  assert.equal(r.ok, false);
  assert.match(r.error, /tmux/i);
});

test("send_command delivers a raw control message to a tmux-attached agent (DM)", async () => {
  await t.registerTool({ agentId: "subtmux" });
  // A remote marker is judged live by registry heartbeat (just refreshed by
  // register), so no real pusher process is needed for this unit test.
  await t.reportTransportTool({ agentId: "subtmux", transport: "tmux-push-remote", host: "test" });

  const r = await t.sendCommandTool({ from: "lead", to: "subtmux", command: "/compact" });
  assert.equal(r.ok, true);
  assert.equal(r.command, "/compact");
  assert.deepEqual(r.delivered, ["subtmux"]);

  const read = await t.readMessagesTool({ agentId: "subtmux", source: "inbox" });
  const m = read.messages.find((x) => x.text === "/compact");
  assert.ok(m, "control message stored in the inbox");
  assert.equal(m.control, true);
});

test("send_command broadcasts to a channel's tmux-attached members only", async () => {
  await t.registerTool({ agentId: "leadX" });
  await t.registerTool({ agentId: "attached" });
  await t.registerTool({ agentId: "detached" });
  await t.reportTransportTool({ agentId: "attached", transport: "tmux-push-remote", host: "test" });
  await t.joinRoomTool({ agentId: "leadX", room: "#crew" });
  await t.joinRoomTool({ agentId: "attached", room: "#crew" });
  await t.joinRoomTool({ agentId: "detached", room: "#crew" });

  const r = await t.sendCommandTool({ from: "leadX", room: "#crew", command: "clear" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.delivered, ["attached"]);
  assert.deepEqual(r.skipped, ["detached"]);

  const read = await t.readMessagesTool({ agentId: "attached", source: "room", room: "#crew" });
  assert.ok(read.messages.some((m) => m.text === "/clear" && m.control === true));
});

test("send_command /clear schedules an identity reminder DM after the configured delay", async () => {
  await t.registerTool({ agentId: "rem-lead" });
  await t.registerTool({ agentId: "rem-worker" });
  await t.reportTransportTool({ agentId: "rem-worker", transport: "tmux-push-remote", host: "test" });

  const r = await t.sendCommandTool({
    from: "rem-lead",
    to: "rem-worker",
    command: "/clear",
    reminderMs: 60, // short enough to keep the test snappy
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reminderScheduled, { delayMs: 60, recipients: ["rem-worker"] });

  // Immediately after the call, only the /clear control message is in the inbox.
  const before = await t.readMessagesTool({ agentId: "rem-worker", source: "inbox", peek: true });
  assert.equal(before.messages.filter((m) => m.text === "/clear").length, 1);
  assert.equal(before.messages.some((m) => m.text?.includes("context reset by /clear")), false);

  // Wait past the reminder delay; the reminder DM should now be present.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await t.readMessagesTool({ agentId: "rem-worker", source: "inbox", peek: true });
  const reminder = after.messages.find((m) => m.text?.includes("context reset by /clear"));
  assert.ok(reminder, "post-/clear reminder DM lands in the recipient's inbox");
  assert.equal(reminder.from, "rem-lead");
  assert.ok(reminder.text.includes("rem-worker"), "reminder names the recipient's agentId");
  assert.ok(reminder.text.includes("status("), "reminder points the agent at status()");
});

test("send_command /clear with reminderMs:0 opts out of the reminder", async () => {
  await t.registerTool({ agentId: "noremind-lead" });
  await t.registerTool({ agentId: "noremind-worker" });
  await t.reportTransportTool({ agentId: "noremind-worker", transport: "tmux-push-remote", host: "test" });

  const r = await t.sendCommandTool({
    from: "noremind-lead",
    to: "noremind-worker",
    command: "/clear",
    reminderMs: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reminderScheduled, undefined);

  // Even after waiting, no reminder should appear.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await t.readMessagesTool({ agentId: "noremind-worker", source: "inbox", peek: true });
  assert.equal(after.messages.some((m) => m.text?.includes("context reset by /clear")), false);
});

test("send_command /compact does NOT schedule a reminder (only /clear does)", async () => {
  await t.registerTool({ agentId: "compact-lead" });
  await t.registerTool({ agentId: "compact-worker" });
  await t.reportTransportTool({ agentId: "compact-worker", transport: "tmux-push-remote", host: "test" });

  const r = await t.sendCommandTool({
    from: "compact-lead",
    to: "compact-worker",
    command: "/compact",
    reminderMs: 50, // even with a value set, /compact skips the reminder
  });
  assert.equal(r.ok, true);
  assert.equal(r.reminderScheduled, undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await t.readMessagesTool({ agentId: "compact-worker", source: "inbox", peek: true });
  assert.equal(after.messages.some((m) => m.text?.includes("context reset by /clear")), false);
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
