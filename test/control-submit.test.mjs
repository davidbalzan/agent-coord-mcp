// P1: control commands land in the pane but are not submitted.
//
// These tests drive hooks/submit.mjs against a FAKE tmux — they pin the logic,
// the tunables and the truthfulness of the outcome. They are NOT the evidence
// that the bug is fixed: the acceptance evidence is the repro account against a
// real agent TUI (see the P1 entry in docs/DONE.md and the commit body). A
// green suite is what shipped this bug in the first place.
//
// What the real TUI showed, and what each case below encodes:
//   BUSY  — command queues behind the running turn, executes minutes later
//   DRAFT — command is APPENDED to unsent input and sent to the model as chat
//   OK    — command leaves the input and runs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-submit-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const submit = await import("../hooks/submit.mjs");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

after(() => rmSync(tmp, { recursive: true, force: true }));

// A fake tmux: `panes` is the sequence of capture-pane outputs to serve.
function fakeTmux({ panes = [], captureFails = false } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    deps: {
      target: "%fake",
      buffer: "buf",
      run(args) {
        calls.push(args.join(" "));
        if (args[0] === "capture-pane") {
          if (captureFails) return { status: 1, stdout: "", stderr: "no such pane" };
          const pane = panes[Math.min(i++, panes.length - 1)] ?? "";
          return { status: 0, stdout: pane, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      async runStdin(args, payload) {
        calls.push(`${args.join(" ")} <<${payload}`);
      },
    },
  };
}

const IDLE = "some history\n────────\n❯ \n────────\n  ⏸ plan mode on · PR #17";
const BUSY = "some history\n❯ \n  ⏸ plan mode on · esc to interrupt · ← for agents";
const HOLDING = (cmd) => `history\n────────\n❯ ${cmd}\n────────\n  ⏸ plan mode on`;

const fastEnv = () => {
  process.env.AGENT_COORD_ENTER_DELAY_MS = "1";
  process.env.AGENT_COORD_ENTER_GAP_MS = "1";
  process.env.AGENT_COORD_SUBMIT_VERIFY_MS = "20";
  process.env.AGENT_COORD_SUBMIT_POLL_MS = "1";
};
fastEnv();

// ---------- 1. tunable timing ----------

test("the Enter timings are tunable and default to raised values", () => {
  delete process.env.AGENT_COORD_ENTER_DELAY_MS;
  delete process.env.AGENT_COORD_ENTER_GAP_MS;
  assert.equal(submit.ENTER_DELAY_MS(), 400, "raised from the old 100ms");
  assert.equal(submit.ENTER_GAP_MS(), 150, "raised from the old 50ms");
  assert.equal(submit.CONTROL_IDLE_WAIT_MS(), 15000);

  process.env.AGENT_COORD_ENTER_DELAY_MS = "900";
  process.env.AGENT_COORD_ENTER_GAP_MS = "0";
  assert.equal(submit.ENTER_DELAY_MS(), 900);
  assert.equal(submit.ENTER_GAP_MS(), 0, "0 is a valid value, not a fallback trigger");
  fastEnv();
});

// ---------- 2. verify submission, don't assume it ----------

test("a command that leaves the input reports submitted+verified", async () => {
  const { deps, calls } = fakeTmux({ panes: [IDLE, IDLE] });
  const r = await submit.submitControl(deps, "/clear");
  assert.deepEqual({ submitted: r.submitted, verified: r.verified }, { submitted: true, verified: true });
  // Raw paste — never bracketed. Bracketing a control command makes the TUI
  // treat it as literal text instead of running it.
  assert.ok(calls.some((c) => c.startsWith("paste-buffer -b")), "control paste must be raw");
  assert.ok(!calls.some((c) => c.includes("paste-buffer -p")), "control commands must NOT be bracketed");
  assert.ok(calls.filter((c) => c.includes("send-keys")).length >= 2, "two Enters");
});

test("a command still sitting in the input reports NOT submitted, with a reason", async () => {
  const { deps, calls } = fakeTmux({ panes: [IDLE, HOLDING("/compact")] });
  const r = await submit.submitControl(deps, "/compact");
  assert.equal(r.submitted, false);
  assert.equal(r.verified, true, "we observed the pane; what we saw was failure");
  assert.match(r.reason, /still in the input/);
  assert.match(r.reason, /AGENT_COORD_ENTER_DELAY_MS/, "the reason must say what to turn");
  // It retried before giving up, rather than declaring failure on one look.
  assert.ok(r.attempts > 1, `expected retries, got ${r.attempts}`);
});

test("an unreadable pane is UNKNOWN, never a confirmation", async () => {
  const { deps } = fakeTmux({ captureFails: true });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false);
  assert.match(r.reason, /could not capture pane/);
  assert.equal(submit.stillInInput(null, "/clear"), null, "unknown is null, not false");
});

// ---------- the two real-TUI failure modes ----------

test("a BUSY pane is not pasted into — the command would queue, not run", async () => {
  process.env.AGENT_COORD_CONTROL_IDLE_WAIT_MS = "10";
  const { deps, calls } = fakeTmux({ panes: [BUSY] });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false);
  assert.equal(r.pasted, false);
  assert.match(r.reason, /still busy/);
  assert.match(r.reason, /queue behind the running turn/);
  assert.ok(!calls.some((c) => c.includes("paste-buffer")), "nothing may be pasted into a busy pane");
  delete process.env.AGENT_COORD_CONTROL_IDLE_WAIT_MS;
});

test("a busy pane that goes idle within the budget IS submitted", async () => {
  process.env.AGENT_COORD_CONTROL_IDLE_WAIT_MS = "500";
  const { deps } = fakeTmux({ panes: [BUSY, BUSY, IDLE, IDLE] });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, true, "waiting for idle is the point — it should still deliver");
  delete process.env.AGENT_COORD_CONTROL_IDLE_WAIT_MS;
});

test("a DRAFT in the input is not pasted onto — it would become a chat message", async () => {
  const { deps, calls } = fakeTmux({ panes: [HOLDING("draft I was typing")] });
  const r = await submit.submitControl(deps, "/compact");
  assert.equal(r.submitted, false);
  assert.equal(r.pasted, false);
  assert.match(r.reason, /unsent text/);
  assert.match(r.reason, /sent to the model as an ordinary message/);
  assert.ok(!calls.some((c) => c.includes("paste-buffer")), "never append a control command to a draft");
});

test("placeholder hints are not drafts", () => {
  assert.equal(submit.readPaneState('❯ Try "how do I log an error?"\n  ⏸ plan').draft, "");
  assert.equal(submit.readPaneState("❯ Press up to edit queued messages\n  ⏸ plan").draft, "");
  assert.equal(submit.readPaneState("❯ \n  ⏸ plan").draft, "");
  assert.equal(submit.readPaneState("❯ real text\n  ⏸ plan").draft, "real text");
  assert.deepEqual(submit.readPaneState(null), { busy: null, draft: null }, "unknown stays unknown");
});

// ---------- 3. truthful receipts ----------

test("send_command reports confirmed ONLY for a verified submission", async () => {
  const t = await import("../dist/tools/index.js");
  const store = await import("../dist/store.js");
  store.ensureDirs();
  const { deliveryOutcome } = await import("../dist/tools/transport.js");

  const at = Date.now();
  assert.equal(deliveryOutcome("a", { id: "1", ts: at, control: true, submitted: true }, 8000).delivery, "confirmed");

  const notSubmitted = deliveryOutcome("a", { id: "1", ts: at, control: true, submitted: false, reason: "still busy" }, 8000);
  assert.equal(notSubmitted.delivery, "pending");
  assert.equal(notSubmitted.reason, "still busy", "the pusher's reason reaches the caller verbatim");

  // A pre-fix pusher stamps on PASTE and has no `submitted` field. That is
  // exactly the receipt that used to be sold as proof of execution.
  const legacy = deliveryOutcome("a", { id: "1", ts: at, control: true }, 8000);
  assert.equal(legacy.delivery, "pending");
  assert.match(legacy.reason, /predates submit verification/);
  assert.match(legacy.reason, /re-attach/, "tell the operator how to fix it");

  const none = deliveryOutcome("a", null, 8000);
  assert.equal(none.delivery, "pending");
  assert.match(none.reason, /no delivery receipt/);
  assert.ok(t.sendCommandTool, "send_command still exists with its existing signature");
});

// ---------- 4. both pushers, one implementation ----------

test("both pushers import the shared pipeline and define no copy of their own", () => {
  const local = readFileSync(path.join(REPO, "hooks/tmux-pusher.mjs"), "utf8");
  const remote = readFileSync(path.join(REPO, "scripts/coord-pusher.mjs"), "utf8");

  for (const [name, src] of [["hooks/tmux-pusher.mjs", local], ["scripts/coord-pusher.mjs", remote]]) {
    assert.match(src, /submit\.mjs"/, `${name} must import the shared pipeline`);
    assert.match(src, /sharedSubmitControl\(tmuxDeps/, `${name} must route control commands through it`);
    // The drift lock: neither file may grow its own send-keys pipeline again.
    // This is the same shape as the injectLine byte-identity lock.
    // Quoted argument, not the word: a comment mentioning send-keys is fine,
    // a call driving it is the drift this locks out.
    assert.equal(
      (src.match(/["']send-keys["']/g) ?? []).length,
      0,
      `${name} must not drive send-keys itself — that is how the two copies drifted (one Enter here, two there)`,
    );
  }
});
