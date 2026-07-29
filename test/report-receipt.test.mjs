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
// is evaluated against a fake `call` instead. `scriptMtime` is the pusher's
// module-level build-identity stamp — injected here because the extracted
// function closes over it in production.
function makeReportReceipts(call, scriptMtime) {
  const re = /^async function reportReceipts\([^]*?^}/m;
  const m = PUSHER_SRC.match(re);
  assert.ok(m, "could not find reportReceipts in coord-pusher.mjs");
  const factory = new Function(
    "call",
    "AGENT_ID",
    "process",
    "scriptMtime",
    `${m[0]}\nreturn reportReceipts;`,
  );
  return factory(call, "wire-agent", process, scriptMtime);
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

test("coord-pusher forwards its build identity on every receipt — and omits it when unknown", async () => {
  // An absent stamp must go over the wire as ABSENCE, not null/0 — the server
  // records only what was reported, and deliveryOutcome reads the absence as
  // "unknown provenance", never as fresh.
  const calls = [];
  const withStamp = makeReportReceipts(async (name, args) => {
    calls.push(args);
    return { ok: true };
  }, 777);
  await withStamp([{ id: "s1", from: "lead", control: true, text: "/clear" }], {
    submitted: true,
    verified: true,
  });
  assert.equal(calls[0].scriptMtime, 777);

  const noStamp = makeReportReceipts(async (name, args) => {
    calls.push(args);
    return { ok: true };
  }, undefined);
  await noStamp([{ id: "s2", from: "peer", text: "hi" }]);
  assert.ok(!("scriptMtime" in calls[1]), "unknown build identity must be omitted, never defaulted");
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

// ---------- 4. receipt build identity (provenance — honesty, not security) ----------
//
// A receipt now carries the reporting pusher's build identity: the same
// module-graph mtime stamp the transport marker holds. A lying pusher defeats
// it, exactly like report_transport — the value is that a "confirmed" can be
// tied to the code that did the confirming, and a confirm issued by
// pre-upgrade verification logic says so instead of reading identically to a
// current one.

test("report_receipt stores the reporter's scriptMtime and never invents one", async () => {
  await t.reportReceiptTool({ agentId: "rr-agent", id: "bi-1", control: true, submitted: true, scriptMtime: 12345 });
  await t.reportReceiptTool({ agentId: "rr-agent", id: "bi-2", control: true, submitted: true });
  const receipts = await store.readJsonl(store.receiptFile("rr-agent"));
  assert.equal(receipts.find((x) => x.id === "bi-1").scriptMtime, 12345);
  assert.ok(
    !("scriptMtime" in receipts.find((x) => x.id === "bi-2")),
    "an unreported stamp stays absent — defaulting it would be assume-fresh, the twin of assume-success",
  );
});

test("a confirmed receipt from an outdated pusher stays confirmed — with a note naming the stale code", async () => {
  const { deliveryOutcome } = await import("../dist/tools/transport.js");
  const at = Date.now();
  const basis = at; // stands in for newestPusherSourceMtime()

  const stale = deliveryOutcome(
    "a",
    { id: "1", ts: at, control: true, submitted: true, scriptMtime: basis - 60_000 },
    8000,
    basis,
  );
  assert.equal(stale.delivery, "confirmed", "provenance must never downgrade the verdict — the command ran");
  assert.equal(stale.reason, undefined);
  assert.match(stale.note, /loaded its code at .* on-disk pusher source is newer/);
  assert.match(stale.note, /re-attach/, "tell the operator how to fix it");

  const fresh = deliveryOutcome(
    "a",
    { id: "1", ts: at, control: true, submitted: true, scriptMtime: basis },
    8000,
    basis,
  );
  assert.equal(fresh.delivery, "confirmed");
  assert.equal(fresh.note, undefined, "a current pusher earns an unannotated confirm");

  // Same -1ms slack as doctor's stale-pusher-script: fs mtime rounding must
  // not manufacture staleness.
  const slack = deliveryOutcome(
    "a",
    { id: "1", ts: at, control: true, submitted: true, scriptMtime: basis - 1 },
    8000,
    basis,
  );
  assert.equal(slack.note, undefined);
});

test("an absent build-identity stamp reads as UNKNOWN, never as fresh", async () => {
  // Same ruling as doctor's absence-is-not-exemption flip: the population
  // without a stamp is precisely the one the check exists to see.
  const { deliveryOutcome } = await import("../dist/tools/transport.js");
  const at = Date.now();

  const noStamp = deliveryOutcome("a", { id: "1", ts: at, control: true, submitted: true }, 8000, at);
  assert.equal(noStamp.delivery, "confirmed");
  assert.match(noStamp.note, /no build-identity stamp/);
  assert.match(noStamp.note, /re-attach/);

  // The absence note must not depend on an on-disk basis being available — an
  // unstattable hooks dir silencing it would be the check disabled by its own
  // precondition, the recurring defect shape this repo keeps hitting.
  const noBasis = deliveryOutcome("a", { id: "1", ts: at, control: true, submitted: true }, 8000, undefined);
  assert.match(noBasis.note, /no build-identity stamp/);

  // A stamped receipt with no basis to compare against: nothing truthful to
  // say, so nothing is said (mirrors doctor skipping when it cannot stat).
  const stampedNoBasis = deliveryOutcome(
    "a",
    { id: "1", ts: at, control: true, submitted: true, scriptMtime: 1 },
    8000,
    undefined,
  );
  assert.equal(stampedNoBasis.note, undefined);

  // Pending verdicts are provenance-free: `reason` semantics are untouched.
  const pending = deliveryOutcome(
    "a",
    { id: "1", ts: at, control: true, submitted: false, reason: "still busy", scriptMtime: 1 },
    8000,
    at,
  );
  assert.equal(pending.delivery, "pending");
  assert.equal(pending.reason, "still busy");
  assert.equal(pending.note, undefined);
});

test("send_command surfaces a stale-reporter confirm as confirmed WITH a warning", async () => {
  await t.registerTool({ agentId: "bi-lead" });
  await t.registerTool({ agentId: "bi-agent" });
  await t.reportTransportTool({ agentId: "bi-agent", transport: "tmux-push-remote", host: "test" });

  // The real newestPusherSourceMtime() basis is the repo's hooks/*.mjs —
  // checked-out files whose mtimes are in the past, so a 1970 stamp is
  // deterministically stale and a now+60s stamp deterministically fresh.
  const runOnce = async (cmd, scriptMtime) => {
    const fake = (async () => {
      for (let i = 0; i < 100; i++) {
        const inbox = await store.readJsonl(store.inboxFile("bi-agent"));
        const ctrl = inbox.find((m) => m.text === cmd && m.control);
        if (ctrl) {
          await t.reportReceiptTool({
            agentId: "bi-agent",
            id: ctrl.id,
            control: true,
            submitted: true,
            verified: true,
            scriptMtime,
          });
          return;
        }
        await new Promise((res) => setTimeout(res, 20));
      }
    })();
    const r = await t.sendCommandTool({
      from: "bi-lead",
      to: "bi-agent",
      command: cmd,
      reminderMs: 0,
      deliveryTimeoutMs: 4000,
    });
    await fake;
    return r;
  };

  const stale = await runOnce("/clear", 1000);
  assert.equal(stale.delivery, "confirmed");
  assert.equal(stale.confirmed, true, "the warning must ride WITH the confirm, not replace it");
  assert.match(stale.warning, /on-disk pusher source is newer/);

  const fresh = await runOnce("/compact", Date.now() + 60_000);
  assert.equal(fresh.delivery, "confirmed");
  assert.equal(fresh.confirmed, true);
  assert.equal(fresh.warning, undefined, "a current reporter earns an unannotated confirm");
});

// ---------- 5. both pusher ends actually stamp ----------

const LOCAL_PUSHER_SRC = readFileSync(
  fileURLToPath(new URL("../hooks/tmux-pusher.mjs", import.meta.url)),
  "utf8",
);

test("tmux-pusher's writeReceipts stamps SCRIPT_MTIME — and omits it when unknown", () => {
  // Extract-and-evaluate, same pattern as makeReportReceipts: the receipt
  // line's shape is behavior, not just source text.
  const m = LOCAL_PUSHER_SRC.match(/^function writeReceipts\([^]*?^}/m);
  assert.ok(m, "could not find writeReceipts in tmux-pusher.mjs");
  const written = [];
  const factory = new Function(
    "appendFileSync",
    "RECEIPTS_FILE",
    "AGENT_ID",
    "SCRIPT_MTIME",
    "process",
    `${m[0]}\nreturn writeReceipts;`,
  );

  const withStamp = factory((_f, data) => written.push(data), "rcpt", "local-agent", 4242, process);
  withStamp([{ id: "w1", from: "lead", control: true }], { submitted: true, verified: true });
  const rec = JSON.parse(written[0].trim());
  assert.equal(rec.scriptMtime, 4242, "the module-graph stamp must ride on every local receipt");
  assert.equal(rec.submitted, true);

  const noStamp = factory((_f, data) => written.push(data), "rcpt", "local-agent", undefined, process);
  noStamp([{ id: "w2", from: "peer" }]);
  assert.ok(
    !("scriptMtime" in JSON.parse(written[1].trim())),
    "an unknown stamp must be omitted — absence reads as UNKNOWN downstream, never fresh",
  );
});

test("coord-pusher's stamp covers its module graph, not just the entry file", () => {
  // Source-level, same reasoning as the SCRIPT_MTIME lock in tier.test.mjs:
  // the paste/submit pipeline is imported from ../hooks/submit.mjs, so an
  // entry-only stat reads "fresh" on a pusher whose imports were replaced
  // after it spawned — the false green #28 removed locally, recreated across
  // the wire. This initializer feeds BOTH report_transport and every receipt.
  const body = PUSHER_SRC.match(/const scriptMtime = await \(async \(\) => \{([\s\S]*?)\n\}\)\(\);/);
  assert.ok(body, "scriptMtime initializer not found in coord-pusher.mjs");
  assert.match(body[1], /import\.meta\.url/, "must measure the code actually running");
  assert.match(
    body[1],
    /"hooks"/,
    "must reach into the hooks dir the pipeline is imported from",
  );
  // Must match the CALL on the hooks dir, not merely the import of
  // readdirSync — a mutation that kept the import but dropped the scan loop
  // slipped past the looser /readdirSync/ form of this lock.
  assert.match(
    body[1],
    /readdirSync\(hooksDir\)/,
    "stamp must scan the hooks dir (the loaded module graph), not stat one file",
  );
  // And the marker side must keep riding the same stamp: report_transport
  // and report_receipt sharing one value is what makes "the pusher that
  // attached" and "the pusher that confirmed" the same identity.
  // Anchored on the adjacent `since:` line: a lazy any-gap match would skip
  // ahead to reportReceipts' own spread and pass with the marker stamp gone.
  assert.match(
    PUSHER_SRC,
    /"report_transport",[^]*?since: Date\.now\(\),\s*\.\.\.\(scriptMtime !== undefined \? \{ scriptMtime \} : \{\}\)/,
    "report_transport must carry the same build-identity stamp",
  );
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
