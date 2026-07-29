// P2: remote delivery receipts. scripts/coord-pusher.mjs never stamped
// receipts/<id>.jsonl (a remote host cannot write this filesystem), so a
// control command to a tmux-push-remote agent was NEVER confirmable —
// send_command waited out deliveryTimeoutMs and reported delivery:"pending"
// even when the command demonstrably ran. The fix is a report_receipt wire
// tool; these tests pin both ends of it: the server appends the exact receipt
// shape the local pusher writes, and the pusher forwards only what submit
// verification actually observed (never assume-success).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-test-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------- 1. the wire tool writes the local pusher's receipt shape ----------

test("report_receipt appends the same receipt shape writeReceipts stamps locally", async () => {
  await t.registerTool({ agentId: "rr-agent" });

  const r = await t.reportReceiptTool({
    agentId: "rr-agent",
    id: "msg-1",
    from: "rr-lead",
    control: true,
    submitted: true,
    verified: true,
  });
  assert.equal(r.ok, true);

  const receipts = await store.readJsonl(store.receiptFile("rr-agent"));
  assert.equal(receipts.length, 1);
  const rec = receipts[0];
  assert.equal(rec.id, "msg-1");
  assert.equal(rec.agentId, "rr-agent");
  assert.equal(rec.from, "rr-lead");
  assert.equal(rec.control, true);
  assert.equal(rec.submitted, true);
  assert.equal(rec.verified, true);
  assert.equal(typeof rec.ts, "number");
});

test("an unreported `submitted` stays ABSENT — the server must not invent a verdict", async () => {
  // An ordinary peer-batch receipt proves typing, not execution. If the server
  // defaulted the missing field to true it would recreate assume-success one
  // layer up; if it defaulted to false it would turn honest typed-only
  // receipts into claims of failure. deliveryOutcome keys on the ABSENCE.
  await t.reportReceiptTool({ agentId: "rr-agent", id: "msg-2", from: "peer" });
  const receipts = await store.readJsonl(store.receiptFile("rr-agent"));
  const rec = receipts.find((x) => x.id === "msg-2");
  assert.equal(rec.control, false);
  assert.ok(!("submitted" in rec), "submitted must be absent, not defaulted");
  assert.ok(!("verified" in rec), "verified must be absent, not defaulted");

  const { deliveryOutcome } = await import("../dist/tools/transport.js");
  assert.equal(deliveryOutcome("rr-agent", rec, 8000).delivery, "pending");
});

// ---------- 2. send_command to a REMOTE agent can now confirm ----------

test("send_command to a tmux-push-remote agent confirms once the pusher reports a verified submission", async () => {
  await t.registerTool({ agentId: "rem-lead" });
  await t.registerTool({ agentId: "rem-agent" });
  await t.reportTransportTool({ agentId: "rem-agent", transport: "tmux-push-remote", host: "test" });

  // Simulate the remote pusher: watch the inbox for the control message, then
  // report the receipt over the WIRE TOOL (not a filesystem append) — the
  // path a remote host actually has.
  const fakeRemotePusher = (async () => {
    for (let i = 0; i < 100; i++) {
      const inbox = await store.readJsonl(store.inboxFile("rem-agent"));
      const ctrl = inbox.find((m) => m.text === "/clear" && m.control);
      if (ctrl) {
        await t.reportReceiptTool({
          agentId: "rem-agent",
          id: ctrl.id,
          from: ctrl.from,
          control: true,
          submitted: true,
          verified: true,
        });
        return;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  })();

  const r = await t.sendCommandTool({
    from: "rem-lead",
    to: "rem-agent",
    command: "/clear",
    reminderMs: 0,
    deliveryTimeoutMs: 4000,
  });
  await fakeRemotePusher;
  assert.equal(r.ok, true);
  assert.equal(r.transport, "tmux-push-remote");
  assert.equal(r.delivery, "confirmed");
  assert.equal(r.confirmed, true);
  assert.equal(typeof r.deliveredAt, "number");
});

test("a remote decline (submitted:false) stays pending with the pusher's reason verbatim", async () => {
  await t.registerTool({ agentId: "dec-lead" });
  await t.registerTool({ agentId: "dec-agent" });
  await t.reportTransportTool({ agentId: "dec-agent", transport: "tmux-push-remote", host: "test" });

  const reason = "pane 'x:0.1' is still busy after 15000ms — not pasted.";
  const fakeRemotePusher = (async () => {
    for (let i = 0; i < 100; i++) {
      const inbox = await store.readJsonl(store.inboxFile("dec-agent"));
      const ctrl = inbox.find((m) => m.text === "/compact" && m.control);
      if (ctrl) {
        await t.reportReceiptTool({
          agentId: "dec-agent",
          id: ctrl.id,
          control: true,
          submitted: false,
          verified: true,
          reason,
        });
        return;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  })();

  const r = await t.sendCommandTool({
    from: "dec-lead",
    to: "dec-agent",
    command: "/compact",
    deliveryTimeoutMs: 4000,
  });
  await fakeRemotePusher;
  assert.equal(r.ok, true);
  assert.equal(r.delivery, "pending");
  assert.equal(r.confirmed, false);
  assert.equal(r.warning, reason, "the remote pusher's reason reaches the caller verbatim");
});

// ---------- 3. the pusher end: what goes over the wire ----------

const PUSHER_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/coord-pusher.mjs", import.meta.url)),
  "utf8",
);

// Same extraction pattern as coord-pusher-strict-call.test.mjs: the module
// registers against a real MCP server on import, so the function under test
// is evaluated against a fake `call` instead.
function makeReportReceipts(call) {
  const re = /^async function reportReceipts\([^]*?^}/m;
  const m = PUSHER_SRC.match(re);
  assert.ok(m, "could not find reportReceipts in coord-pusher.mjs");
  const factory = new Function("call", "AGENT_ID", "process", `${m[0]}\nreturn reportReceipts;`);
  return factory(call, "wire-agent", process);
}

test("coord-pusher forwards the control outcome and omits it for peer batches", async () => {
  const calls = [];
  const reportReceipts = makeReportReceipts(async (name, args, opts) => {
    calls.push({ name, args, opts });
    return { ok: true };
  });

  await reportReceipts(
    [{ id: "c1", from: "lead", control: true, text: "/clear" }],
    { submitted: true, verified: true },
  );
  await reportReceipts([{ id: "p1", from: "peer", text: "hi" }, { id: "p2", from: "peer", text: "yo" }]);

  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.name === "report_receipt"));
  assert.ok(calls.every((c) => c.opts?.strict === true), "isError must throw, not parse as success");
  assert.deepEqual(calls[0].args, {
    agentId: "wire-agent",
    id: "c1",
    from: "lead",
    control: true,
    submitted: true,
    verified: true,
  });
  // Peer receipts: no submitted/verified keys AT ALL — absence is the honest
  // "typed but unverified", and a default here would be assume-success reborn.
  for (const c of calls.slice(1)) {
    assert.equal(c.args.control, false);
    assert.ok(!("submitted" in c.args));
    assert.ok(!("verified" in c.args));
  }
});

test("a failed report_receipt is logged, never thrown — the message is already in the pane", async () => {
  const reportReceipts = makeReportReceipts(async () => {
    throw new Error("Unknown tool: report_receipt"); // server predating the tool
  });
  // Must resolve: a receipt is proof for the SENDER; failing delivery over it
  // would punish the receiving agent for the sender's missing confirmation.
  await reportReceipts([{ id: "x1", from: "lead", control: true, text: "/clear" }], {
    submitted: true,
    verified: true,
  });
});

test("injectViaTmux reports a receipt on both the control and the peer-batch path", () => {
  // Structural lock, same style as the shared-pipeline lock in
  // control-submit.test.mjs: the function above is only wired in if the
  // inject loop actually calls it — after the outcome exists (control) and
  // after the paste resolves (peer batch), never before.
  assert.match(
    PUSHER_SRC,
    /const outcome = await submitControlCommand\(m\.text\.trim\(\)\);[^]*?await reportReceipts\(\[m\], outcome\);/,
    "control path must report the submit outcome",
  );
  assert.match(
    PUSHER_SRC,
    /await pasteAndSubmit\(formatBatch\(run\), true\);[^\n]*\n\s*await reportReceipts\(run\);/,
    "peer-batch path must report only after the paste resolves",
  );
});
