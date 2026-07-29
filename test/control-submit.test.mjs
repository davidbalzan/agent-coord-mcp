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
const stillInInputOf = (pane, payload) => submit.stillInInput(pane, payload);
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
// What a real pane looks like AFTER a successful submit: the TUI echoes the
// command into the transcript, directly above an empty prompt box. Taken from
// a live capture of `/compact` mid-run (P1b).
const ECHOED = (cmd) =>
  [
    "  ⏺ earlier turn",
    "",
    `❯ ${cmd}`,
    "",
    "· Compacting conversation…",
    "  ▱▱▱▱▱▱▱▱▱▱ 0%",
    "────────",
    "❯ ",
    "────────",
    "  ⏸ plan mode on",
  ].join("\n");

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

// ---------- P1b: the echo in the transcript is not the input ----------

test("a command echoed into the transcript above an EMPTY input counts as submitted", async () => {
  // The P1b defect: the first verifier squashed the last 20 lines of the whole
  // pane, so the TUI's own echo of a SUCCESSFUL command matched and it reported
  // failure. Live: the pane read "Compacting conversation… 28%" while the
  // receipt said the command "did not run".
  assert.equal(stillInInputOf(ECHOED("/compact"), "/compact"), false);

  const { deps, calls } = fakeTmux({ panes: [IDLE, ECHOED("/compact")] });
  const r = await submit.submitControl(deps, "/compact");
  assert.deepEqual({ submitted: r.submitted, verified: r.verified }, { submitted: true, verified: true });
  // …and it must not have pressed Enter again after the command already ran:
  // those are keystrokes into a live session someone else may be typing in.
  assert.equal(calls.filter((c) => c.includes("send-keys")).length, 2, "exactly the two submitting Enters");
  assert.equal(r.attempts, 1);
});

test("the same command STILL in the input line is not confused with its echo", async () => {
  // Both lines present: the command echoed in the transcript AND sitting in the
  // input. That is a genuine non-submit and must still report as one.
  const pane = ECHOED("/compact").replace("❯ \n", "❯ /compact\n");
  assert.equal(stillInInputOf(pane, "/compact"), true);
});

test("a pane with no readable input line is UNKNOWN, not a confirmation", async () => {
  assert.equal(stillInInputOf("some TUI we do not know how to read\nno prompt here", "/clear"), null);
  const { deps } = fakeTmux({ panes: [IDLE, "no prompt line at all"] });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false);
  assert.match(r.reason, /could not read the input line/);
  assert.match(r.reason, /AGENT_COORD_PROMPT_PATTERN/);
});

test("an unreadable pane is UNKNOWN, never a confirmation", async () => {
  const { deps } = fakeTmux({ captureFails: true });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false);
  assert.match(r.reason, /could not read the input line/);
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
  assert.deepEqual(
    submit.readPaneState(null),
    { busy: null, draft: null, ghost: null, styledInputLine: null },
    "unknown stays unknown",
  );
});

// ---------- ghost text: chrome in the input box is not a draft ----------
//
// Byte-exact input lines from live captures (capture-pane -e, pane %4,
// 2026-07-29 — the investigation that found this guard refusing on chrome):
//
//   GHOST_LINE — an IDLE Claude Code session. The phrase is the TUI's
//   session-derived SUGGESTED next prompt, rendered dim (SGR 2) inside the
//   input box. Nobody typed it; the first keystroke replaces it; it never
//   reaches scrollback. Three live refusals quoted exactly this phrase as an
//   "unsent draft" while the input was empty, making /clear and /compact
//   undeliverable fleet-wide.
//
//   DRAFT_LINE — the controlled counter-experiment: "drafttest123" literally
//   typed via send-keys (then erased). Real typed text renders with NO dim
//   attribute.
const GHOST_LINE = "\u001b[39m❯\u00a0\u001b[2mwait for the gate verdict\u001b[0m";
const DRAFT_LINE = "\u001b[38;5;246m❯\u00a0\u001b[39mdrafttest123";
const styledPane = (inputLine) =>
  ["some history", "────────", inputLine, "────────", "  ⏸ plan mode on · PR #32"].join("\n");

test("the TUI's ghost suggestion is chrome, not a draft — the control command DELIVERS", async () => {
  const { deps, calls } = fakeTmux({ panes: [styledPane(GHOST_LINE), styledPane(GHOST_LINE)] });
  const r = await submit.submitControl(deps, "/compact");
  assert.equal(r.submitted, true, "refusing on ghost text is the defect this fixes");
  assert.equal(r.verified, true);
  assert.ok(
    calls.some((c) => c.startsWith("capture-pane -e")),
    "the guard must capture WITH styling — a plain capture flattens ghost and draft to identical bytes",
  );
});

test("a REAL typed draft still refuses — the reason quotes the styled line and names the rule", async () => {
  const { deps, calls } = fakeTmux({ panes: [styledPane(DRAFT_LINE)] });
  const r = await submit.submitControl(deps, "/compact");
  assert.equal(r.submitted, false);
  assert.equal(r.pasted, false);
  assert.match(r.reason, /"drafttest123/, "the draft itself is quoted");
  assert.match(r.reason, /Rule: non-dim/, "the rule that fired is named");
  assert.match(r.reason, /AGENT_COORD_GHOST_TEXT_SGR/, "the override is named");
  assert.match(r.reason, /Styled input line:/, "the styled capture is quoted so the next false positive self-diagnoses");
  assert.ok(!calls.some((c) => c.includes("paste-buffer")), "never append a control command to a draft");
});

test("typed text alongside a ghost continuation: the draft is the typed part only", async () => {
  // Mixed line — typed "wait", ghost continuation completing the suggestion.
  const MIXED = "❯\u00a0wait\u001b[2m for the gate verdict\u001b[0m";
  const st = submit.readPaneState(styledPane(MIXED));
  assert.equal(st.draft, "wait");
  assert.equal(st.ghost, "for the gate verdict");

  const { deps } = fakeTmux({ panes: [styledPane(MIXED)] });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false, "the typed part is a real draft");
  assert.match(r.reason, /"wait"/, "quotes what was typed, not the chrome");
});

test("unknown styling fails toward refusing — never toward delivering", async () => {
  // A harness that styles its suggestion some other way (italic here) is
  // indistinguishable from a draft, and the asymmetry decides: a false
  // refusal costs one retryable command; a false delivery types into
  // someone's real unsent text. The fix for such a harness is teaching
  // AGENT_COORD_GHOST_TEXT_SGR its rendering, not loosening the guard.
  const ITALIC = "❯\u00a0\u001b[3msome suggestion styled in a way we do not know\u001b[0m";
  assert.equal(submit.readPaneState(styledPane(ITALIC)).draft, "some suggestion styled in a way we do not know");
  const { deps } = fakeTmux({ panes: [styledPane(ITALIC)] });
  const r = await submit.submitControl(deps, "/clear");
  assert.equal(r.submitted, false);
});

test("partitionStyledLine: the SGR state machine's load-bearing cases", () => {
  // Dim opened, then explicitly cleared by 22 ("normal intensity").
  assert.deepEqual(submit.partitionStyledLine("\u001b[2mghost\u001b[22mreal"), { real: "real", ghost: "ghost" });
  // Compound SGR: dim riding with a color in one sequence.
  assert.deepEqual(submit.partitionStyledLine("\u001b[2;38;5;246mg\u001b[0mr"), { real: "r", ghost: "g" });
  // A bare 2 INSIDE an extended-color spec is a palette index, not dim.
  assert.deepEqual(submit.partitionStyledLine("\u001b[38;5;2mplain\u001b[0m"), { real: "plain", ghost: "" });
  // Empty SGR is a full reset.
  assert.deepEqual(submit.partitionStyledLine("\u001b[2mg\u001b[mr"), { real: "r", ghost: "g" });
});

test("stripAnsi removes CSI and OSC-8 hyperlinks, keeps the text", () => {
  // Shape taken from the live status line: an OSC-8 wrapped PR link.
  const linked = "\u001b[4m\u001b[38;5;220m\u001b]8;id=x;https://github.com/x/y/pull/32\u001b\\#32\u001b[0m\u001b]8;;\u001b\\ done";
  assert.equal(submit.stripAnsi(linked), "#32 done");
});

test("the verifier is not fooled by a ghost that contains the payload", () => {
  // The TUI can suggest the very command that just ran. A plain capture reads
  // that as "still in the input" → false non-submit → the retry path types
  // extra Enters into a live pane on the strength of chrome.
  const GHOST_CMD = "❯\u00a0\u001b[2m/compact\u001b[0m";
  assert.equal(submit.stillInInput(styledPane(GHOST_CMD), "/compact"), false);
  // …while the command genuinely still sitting there (non-dim) reads true.
  const REAL_CMD = "❯\u00a0/compact";
  assert.equal(submit.stillInInput(styledPane(REAL_CMD), "/compact"), true);
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
