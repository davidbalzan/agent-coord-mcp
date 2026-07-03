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

  const r = await t.sendCommandTool({
    from: "lead",
    to: "subtmux",
    command: "/compact",
    waitForDelivery: false, // no real pusher in unit tests → skip receipt poll
  });
  assert.equal(r.ok, true);
  assert.equal(r.command, "/compact");
  assert.deepEqual(r.delivered, ["subtmux"]);
  assert.equal(r.delivery, undefined); // fire-and-forget → no delivery field

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

  const r = await t.sendCommandTool({ from: "leadX", room: "#crew", command: "clear", waitForDelivery: false });
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
    waitForDelivery: false,
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
    waitForDelivery: false,
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
    waitForDelivery: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reminderScheduled, undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await t.readMessagesTool({ agentId: "compact-worker", source: "inbox", peek: true });
  assert.equal(after.messages.some((m) => m.text?.includes("context reset by /clear")), false);
});

test("send_command confirms delivery when a receipt appears (out-of-band)", async () => {
  await t.registerTool({ agentId: "rcpt-lead" });
  await t.registerTool({ agentId: "rcpt-worker" });
  await t.reportTransportTool({ agentId: "rcpt-worker", transport: "tmux-push-remote", host: "test" });

  // Simulate the receiving pusher: once the control msg lands in the inbox,
  // stamp a receipt for its id — exactly what tmux-pusher.writeReceipts does
  // after it types the command into the pane.
  const fakePusher = (async () => {
    for (let i = 0; i < 100; i++) {
      const inbox = await store.readJsonl(store.inboxFile("rcpt-worker"));
      const ctrl = inbox.find((m) => m.text === "/clear" && m.control);
      if (ctrl) {
        await store.appendJsonl(store.receiptFile("rcpt-worker"), {
          id: ctrl.id,
          agentId: "rcpt-worker",
          ts: Date.now(),
          control: true,
        });
        return;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  })();

  const r = await t.sendCommandTool({
    from: "rcpt-lead",
    to: "rcpt-worker",
    command: "/clear",
    reminderMs: 0,
    deliveryTimeoutMs: 4000,
  });
  await fakePusher;
  assert.equal(r.ok, true);
  assert.equal(r.delivery, "confirmed");
  assert.equal(r.confirmed, true);
  assert.equal(typeof r.deliveredAt, "number");
});

test("send_command reports pending when no receipt arrives within the timeout", async () => {
  await t.registerTool({ agentId: "stale-lead" });
  await t.registerTool({ agentId: "stale-worker" });
  await t.reportTransportTool({ agentId: "stale-worker", transport: "tmux-push-remote", host: "test" });

  // No fake pusher → no receipt is ever written. A short timeout keeps it snappy.
  const r = await t.sendCommandTool({
    from: "stale-lead",
    to: "stale-worker",
    command: "/clear",
    reminderMs: 0,
    deliveryTimeoutMs: 300,
  });
  assert.equal(r.ok, true);
  assert.equal(r.delivery, "pending");
  assert.equal(r.confirmed, false);
  assert.match(r.warning, /no delivery receipt/);
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

test("room backlog over the window returns recent + an expandable history digest", async () => {
  const chan = "#flood";
  // 60 messages from a non-reader author so none are filtered as own-posts.
  for (let i = 0; i < 60; i++) {
    await t.sendMessageTool({ from: "spammer", room: chan, text: `msg-${i}` });
  }
  const r = await t.readMessagesTool({ agentId: "reader2", source: "room", room: chan });
  assert.equal(r.returned, 50, "returns the recent window");
  assert.equal(r.messages[0].text, "msg-10", "window is the NEWEST 50, not oldest");
  assert.equal(r.messages[49].text, "msg-59");
  assert.ok(r.history, "overflow produced a history digest");
  assert.equal(r.history.older, 10);
  assert.match(r.history.digest, /10 earlier messages compressed/);
  assert.ok(r.history.hash, "digest carries a retrieval hash");

  // Expand the overflow and get back exactly the older 10, oldest-first.
  const exp = await t.retrieveRoomHistoryTool({ agentId: "reader2", hash: r.history.hash });
  assert.equal(exp.ok, true);
  assert.equal(exp.total, 10);
  assert.equal(exp.messages[0].text, "msg-0");
  assert.equal(exp.messages[9].text, "msg-9");

  // Cursor advanced past everything — a second read sees nothing new.
  const again = await t.readMessagesTool({ agentId: "reader2", source: "room", room: chan });
  assert.equal(again.returned, 0);
  assert.equal(again.history, undefined);
});

test("retrieve_room_history filters by query and enforces agent scope", async () => {
  const chan = "#flood2";
  for (let i = 0; i < 55; i++) {
    await t.sendMessageTool({ from: "bot", room: chan, text: i === 3 ? "DEPLOY rollback" : `noise-${i}` });
  }
  const r = await t.readMessagesTool({ agentId: "owner", source: "room", room: chan });
  const hash = r.history.hash;

  const hit = await t.retrieveRoomHistoryTool({ agentId: "owner", hash, query: "deploy" });
  assert.equal(hit.ok, true);
  assert.equal(hit.returned, 1);
  assert.match(hit.messages[0].text, /DEPLOY rollback/);

  // A different agent cannot replay the hash.
  const denied = await t.retrieveRoomHistoryTool({ agentId: "intruder", hash });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "forbidden");

  // Unknown hash is a clean miss, not a throw.
  const miss = await t.retrieveRoomHistoryTool({ agentId: "owner", hash: "deadbeef0000" });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "not_found");
});

test("peek over the window reports overflow count but stashes no hash", async () => {
  const chan = "#peeky";
  for (let i = 0; i < 55; i++) await t.sendMessageTool({ from: "bot", room: chan, text: `p-${i}` });

  const p = await t.readMessagesTool({ agentId: "peeker", source: "room", room: chan, peek: true });
  assert.equal(p.returned, 50);
  assert.ok(p.history);
  assert.equal(p.history.hash, undefined, "peek does not stash");
  assert.match(p.history.digest, /read without peek/);

  // Peek did not advance the cursor: a real read still sees the full backlog.
  const real = await t.readMessagesTool({ agentId: "peeker", source: "room", room: chan });
  assert.equal(real.totalNew, 55);
  assert.ok(real.history.hash);
});

test("status backlog over the window returns newest entries + expandable digest", async () => {
  for (let i = 0; i < 60; i++) {
    await t.postStatusTool({ agentId: "st-poster", status: `st-${i}` });
  }
  const r = await t.readMessagesTool({ agentId: "st-reader", source: "status" });
  assert.ok(r.totalNew >= 60);
  assert.equal(r.returned, 50);
  assert.equal(r.messages[49].status, "st-59");
  assert.equal(r.history.older, r.totalNew - 50);
  assert.ok(r.history.hash);

  const exp = await t.retrieveRoomHistoryTool({ agentId: "st-reader", hash: r.history.hash });
  assert.equal(exp.returned, r.history.older);

  // Cursor advanced past the stashed overflow too — nothing requeues.
  const again = await t.readMessagesTool({ agentId: "st-reader", source: "status" });
  assert.equal(again.totalNew, 0);
});

test("status reads keep sinceTs/limit semantics and peek stashes no hash", async () => {
  const reader = "st-reader-2";
  const before = await t.readMessagesTool({ agentId: reader, source: "status", peek: true });
  assert.equal(before.history.hash, undefined); // peek digests but never stashes
  const cutoff = before.messages[before.messages.length - 1].ts;

  await new Promise((res) => setTimeout(res, 5)); // ensure new posts get a later ts
  for (let i = 0; i < 3; i++) {
    await t.postStatusTool({ agentId: "st-poster", status: `late-${i}` });
  }

  const since = await t.readMessagesTool({ agentId: reader, source: "status", peek: true, sinceTs: cutoff });
  assert.equal(since.totalNew, 3);
  assert.equal(since.messages[0].status, "late-0");

  const limited = await t.readMessagesTool({ agentId: reader, source: "status", limit: 2 });
  assert.equal(limited.returned, 2);
  assert.equal(limited.messages[1].status, "late-2");
  assert.equal(limited.history.older, limited.totalNew - 2);
});

test("ping answers from server-side state without touching the target", async () => {
  const r0 = await t.pingTool({ from: "pinger", to: "ghost-agent" });
  assert.equal(r0.alive, false);
  assert.equal(r0.reason, "unregistered");
  assert.equal(typeof r0.latencyMs, "number");

  await t.registerTool({ agentId: "ping-target" });
  const r1 = await t.pingTool({ from: "pinger", to: "ping-target" });
  assert.equal(r1.alive, true); // fresh heartbeat
  assert.equal(r1.reachable, false); // no transport attached
  assert.equal(r1.checks.transport, null);
  assert.equal(r1.checks.heartbeatFresh, true);

  // Default ping must not deliver anything to the target.
  const inbox = await t.readMessagesTool({ agentId: "ping-target", source: "inbox" });
  assert.equal(inbox.totalNew, 0);

  // Stale heartbeat + no transport → dead.
  const { readFileSync, writeFileSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(store.AGENTS_FILE, "utf8"));
  reg["ping-target"].lastHeartbeat = Date.now() - 10 * 60 * 1000;
  writeFileSync(store.AGENTS_FILE, JSON.stringify(reg));
  const r2 = await t.pingTool({ from: "pinger", to: "ping-target" });
  assert.equal(r2.alive, false);
  assert.equal(r2.reason, "heartbeat-stale");
});

test("ping echo=true drops a PING DM into the target inbox (opt-in only)", async () => {
  await t.registerTool({ agentId: "ping-echo-target" });
  const r = await t.pingTool({ from: "pinger", to: "ping-echo-target", echo: true });
  assert.equal(r.alive, true);
  assert.equal(r.echoSent, true);
  const inbox = await t.readMessagesTool({ agentId: "ping-echo-target", source: "inbox" });
  assert.equal(inbox.totalNew, 1);
  assert.ok(inbox.messages[0].text.startsWith("PING:"));
});
