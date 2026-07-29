// Paste + submit, shared by BOTH pushers (hooks/tmux-pusher.mjs and
// scripts/coord-pusher.mjs). One implementation on purpose: the two carried
// copies of this pipeline and they had already drifted — the local one sent two
// Enters with 100ms/50ms delays, the remote one sent a single Enter with no
// delay at all. Same class of defect as three copies of the retention
// predicate. Import it; do not re-implement it.
//
// tmux is injected (`run`, `runStdin`) so this module is pure logic and can be
// tested without a terminal. It never imports node:child_process itself.

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// WHY THESE NUMBERS.
//
// The old defaults (100ms then 50ms) were picked for a multi-line PASTE
// settling, not for a slash command. A real agent TUI does more on "/" than
// accept text: it opens an autocomplete menu, which is rendered on a later
// frame, and the first Enter is consumed selecting from that menu rather than
// submitting. The command then sits in the input looking delivered — which is
// exactly what David hit.
//
// 400ms is a frame-budget argument, not a measurement of one machine: a TUI
// that re-renders at 60fps needs a handful of frames to open a menu, and
// terminal apps commonly debounce input by 100-250ms. 400ms clears that with
// margin while staying under the ~500ms a human reads as instant. 150ms
// between Enters is the same reasoning at smaller scale — enough for the menu
// to close and the input to settle before the submitting Enter.
//
// These are DEFAULTS, not guarantees. That is why verification exists below:
// no delay can be proven sufficient on a machine we have not seen, so the
// pipeline observes the result instead of trusting the clock.
export const ENTER_DELAY_MS = () => envInt("AGENT_COORD_ENTER_DELAY_MS", 400);
export const ENTER_GAP_MS = () => envInt("AGENT_COORD_ENTER_GAP_MS", 150);
// How long to keep checking that the command actually left the input, and how
// often. Bounded and finite — this must not spin, and it must not stall the
// delivery loop behind a pane that will never change.
export const VERIFY_TIMEOUT_MS = () => envInt("AGENT_COORD_SUBMIT_VERIFY_MS", 1500);
export const VERIFY_POLL_MS = () => envInt("AGENT_COORD_SUBMIT_POLL_MS", 100);
// Extra Enters to try when the first pair didn't submit. 0 disables retrying.
export const ENTER_RETRIES = () => envInt("AGENT_COORD_ENTER_RETRIES", 2);
// How long to wait for a BUSY pane to go idle before giving up on a control
// command. 15s covers a short tool call or a model turn's tail; beyond that the
// honest answer is "not now" rather than queueing a slash command behind a
// turn that may run for minutes. 0 disables waiting (paste immediately).
export const CONTROL_IDLE_WAIT_MS = () => envInt("AGENT_COORD_CONTROL_IDLE_WAIT_MS", 15000);

// Pane-state patterns. Defaults match the Claude Code TUI, which is what the
// bus drives; override for another TUI. Empty string disables that check.
//
// These exist because control commands fail in ways a delay cannot fix:
//   BUSY  — the command lands in the TUI's queue and runs only when the
//           current turn ends (observed: minutes later), while the receipt
//           already said "confirmed".
//   DRAFT — unsent text in the input; the paste APPENDS to it, so
//           "draft I was typing" + "/compact" submits as an ordinary MESSAGE
//           to the model. The command never runs at all and a model turn is
//           burned on nonsense. This is the worst observed outcome.
export const BUSY_PATTERN = () => envStr("AGENT_COORD_BUSY_PATTERN", "esc to interrupt");
export const PROMPT_PATTERN = () => envStr("AGENT_COORD_PROMPT_PATTERN", "^\\s*[❯>]\\s?(.*)$");
// Input-line content that means "empty" — placeholder hints, not real text.
export const PLACEHOLDER_PATTERN = () =>
  envStr("AGENT_COORD_PLACEHOLDER_PATTERN", '^(Try ".*"|Press up to edit queued messages|)$');

// GHOST TEXT — the ONE place the rendering assumption lives.
//
// Claude Code renders a session-derived SUGGESTED next prompt ("ghost text")
// inside the input box while idle: `❯ ` + ESC[2m + suggestion + ESC[0m. It is
// chrome, not content: nobody typed it, the first keystroke replaces it, and
// it never reaches scrollback. To a plain `capture-pane` it is byte-for-byte
// indistinguishable from a real draft — which made this guard refuse control
// commands against EMPTY inputs fleet-wide (2026-07-29: three live refusals,
// every quoted "draft" was the suggestion; /clear and /compact were
// undeliverable to exactly the agents they were built for). The placeholder
// regex above cannot help: the suggestion is derived from session state, so
// its space of values is unbounded — no content pattern can enumerate it.
// Styling is the only channel that carries the distinction, hence
// `capture-pane -e` below.
//
// SGR 2 (dim/faint) is Claude Code's CURRENT rendering of the suggestion — a
// per-harness rendering detail, not a protocol guarantee. If a harness styles
// suggestions differently, or a release changes it, override or edit HERE and
// nowhere else.
export const GHOST_TEXT_SGR = () => envStr("AGENT_COORD_GHOST_TEXT_SGR", "2");

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}


export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Normalize for comparison: a TUI re-wraps and re-pads its input box, so raw
// substring matching on captured pane text is unreliable.
function squash(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// Terminal escape sequences as they appear in `capture-pane -e` output:
// CSI (colors/attributes, cursor) and OSC (hyperlinks, titles). Anything not
// matched stays in the text — unrecognized bytes read as content, and content
// fails toward refusing, never toward delivering.
const CSI_RE = /\x1b\[[0-9;:?]*[A-Za-z]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(OSC_RE, "").replace(CSI_RE, "");
}

// Split ONE styled line into real (typed) and ghost (suggestion) text by
// walking its SGR state. Dim-attributed spans are ghost; everything else —
// including any styling we do not recognize — is real. See GHOST_TEXT_SGR for
// why dim, and for the asymmetry that makes "unrecognized = real" the safe
// default.
export function partitionStyledLine(styledLine) {
  const ghostAttr = GHOST_TEXT_SGR();
  const src = String(styledLine ?? "");
  let real = "";
  let ghost = "";
  let dim = false;
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\x1b") {
      const rest = src.slice(i);
      const om = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (om) {
        i += om[0].length;
        continue;
      }
      const cm = /^\x1b\[([0-9;:?]*)([A-Za-z])/.exec(rest);
      if (cm) {
        if (cm[2] === "m") {
          // SGR: parameters separated by ; or :. Empty list means reset.
          const params = cm[1] === "" ? ["0"] : cm[1].split(/[;:]/);
          for (const p of params) {
            if (p === "0" || p === "") dim = false; // full reset
            else if (p === "22") dim = false; // "normal intensity" clears dim
            else if (p === ghostAttr) dim = true;
            // 38;5;N color runs share the list; a bare "5"/"2" inside a color
            // spec could false-trigger — handle the extended-color form:
            if (p === "38" || p === "48") break; // rest of list is a color spec
          }
        }
        i += cm[0].length;
        continue;
      }
      // Lone ESC we do not understand: drop the ESC byte, keep going.
      i += 1;
      continue;
    }
    if (dim) ghost += src[i];
    else real += src[i];
    i += 1;
  }
  return { real, ghost };
}

// Is `payload` still sitting in the pane's INPUT LINE?
//
// It asks the input line specifically, and nothing else. The first version
// squashed the last 20 lines of the whole pane and searched that window — but
// Claude Code ECHOES a submitted command into the transcript directly above
// the prompt box, inside that window. So a command that ran perfectly still
// matched, and the verifier reported failure on success (David hit this live:
// the pane read "Compacting conversation… 28%" while the receipt said the
// command "did not run").
//
// It only ever passed in testing because a freshly spawned disposable session
// has an empty scrollback — the one condition that hides a scrollback bug. The
// lesson is narrower than "test on a real TUI": a check that reads scrollback
// has to be tested against a pane that HAS scrollback.
//
// Returns true = still waiting in the input, false = gone (submitted),
// null = UNKNOWN. Unknown is never upgraded to a confirmation: no pane text,
// or no line matching AGENT_COORD_PROMPT_PATTERN, means we cannot tell.
export function stillInInput(paneText, payload) {
  if (paneText === null || paneText === undefined) return null;
  const needle = squash(payload);
  if (!needle) return false;
  const { draft } = readPaneState(paneText);
  if (draft === null) return null; // no recognizable input line — cannot tell
  return squash(draft).includes(needle);
}

// Read the pane's input state: is the TUI busy, and is there unsent text?
//
// Accepts BOTH plain and styled (`capture-pane -e`) text — on styled input the
// ghost suggestion is partitioned out of `draft` (see GHOST_TEXT_SGR); plain
// text has no style layer, so everything on the input line reads as content,
// which is the conservative side. `ghost` and `styledInputLine` are null on
// plain input.
//
// `null` for busy/draft means UNKNOWN — the pane could not be captured, or
// this TUI does not look like the one we know how to read. Unknown is never
// treated as "fine": callers either proceed and fall back to verify-by-absence
// or report the uncertainty, but they never upgrade it to a confirmation.
export function readPaneState(paneText) {
  if (paneText === null || paneText === undefined) {
    return { busy: null, draft: null, ghost: null, styledInputLine: null };
  }
  const text = String(paneText);
  const busyRe = BUSY_PATTERN();
  // Busy markers live in the status chrome; match on the de-styled text.
  const busy = busyRe ? new RegExp(busyRe).test(stripAnsi(text)) : null;

  const promptRe = PROMPT_PATTERN();
  let draft = null;
  let ghost = null;
  let styledInputLine = null;
  if (promptRe) {
    const re = new RegExp(promptRe);
    const lines = text.split("\n");
    // The LAST prompt line is the live input; earlier ones are history.
    for (let i = lines.length - 1; i >= 0; i--) {
      // Partition FIRST: the prompt char renders undimmed, so it stays in
      // `real` and the prompt regex matches the de-styled real text. Ghost
      // spans never reach the draft no matter what they contain.
      const { real, ghost: ghostText } = partitionStyledLine(lines[i]);
      const m = re.exec(real.replace(/\s+$/, ""));
      if (!m) continue;
      const content = (m[1] ?? "").trim();
      const placeholder = PLACEHOLDER_PATTERN();
      draft = placeholder && new RegExp(placeholder).test(content) ? "" : content;
      ghost = squash(ghostText) || null;
      styledInputLine = lines[i];
      break;
    }
  }
  return { busy, draft, ghost, styledInputLine };
}

// Submit a CONTROL command (/clear, /compact) — the path that must actually
// run, not merely arrive.
//
// Refuses rather than corrupts. Pasting into a busy pane queues the command
// behind a whole model turn; pasting onto a draft concatenates with it and
// sends the result to the model as chat text. Both were previously reported as
// delivery:"confirmed". Waiting briefly and then declining is slower and
// louder — deliberately, because a control command that silently becomes a
// chat message is worse than one that says it did not run.
export async function submitControl(deps, payload) {
  const { run, target } = deps;
  const capture = () => {
    // -e keeps the style layer — the only channel that distinguishes a real
    // draft from the TUI's ghost suggestion (see GHOST_TEXT_SGR). A plain
    // capture flattens both to identical text and the guard refuses on chrome.
    const cap = run(["capture-pane", "-e", "-p", "-t", target]);
    return cap.status === 0 ? String(cap.stdout ?? "") : null;
  };

  const idleBudget = CONTROL_IDLE_WAIT_MS();
  const deadline = Date.now() + idleBudget;
  let state = readPaneState(capture());
  while (state.busy === true && idleBudget > 0 && Date.now() < deadline) {
    await sleep(VERIFY_POLL_MS() * 5);
    state = readPaneState(capture());
  }
  if (state.busy === true) {
    return {
      submitted: false,
      verified: true,
      pasted: false,
      attempts: 0,
      reason:
        `pane '${target}' is still busy after ${idleBudget}ms — not pasted. A control command sent now would ` +
        `queue behind the running turn instead of executing (raise AGENT_COORD_CONTROL_IDLE_WAIT_MS to wait longer).`,
    };
  }
  if (state.draft) {
    // ASYMMETRY — do not "fix" this branch toward delivering. A false REFUSAL
    // costs one control command: retryable, visible, and self-diagnosing via
    // the styled quote below. A false DELIVERY types keystrokes into someone's
    // real unsent text and submits the concatenation to their model — the
    // exact harm this guard exists to prevent. A harness whose ghost text is
    // NOT dim-styled therefore lands here and refuses; that is the intended
    // conservative direction, and the remedy is teaching GHOST_TEXT_SGR its
    // rendering, never loosening this check.
    return {
      submitted: false,
      verified: true,
      pasted: false,
      attempts: 0,
      reason:
        `pane '${target}' has unsent text in its input (${JSON.stringify(state.draft.slice(0, 40))}…) — not pasted. ` +
        `The command would have been appended to that draft and sent to the model as an ordinary message. ` +
        `Rule: non-dim input-line content is a draft; dim (SGR ${GHOST_TEXT_SGR()}) spans are the TUI's ghost ` +
        `suggestion and are ignored (AGENT_COORD_GHOST_TEXT_SGR overrides). ` +
        `Styled input line: ${JSON.stringify(String(state.styledInputLine ?? "").slice(0, 160))}`,
    };
  }
  return pasteAndSubmit(deps, payload, { bracketed: false, verify: true });
}

// Paste a payload into the target pane and submit it.
//
// deps:
//   runStdin(args, payload) -> Promise<void>   // tmux load-buffer -
//   run(args) -> {status, stdout, stderr}      // spawnSync-shaped
//   target, buffer                             // tmux -t target, buffer name
//
// Returns {submitted, verified, reason?, attempts}. For bracketed peer content
// verification is skipped entirely (`verified:false`, `submitted:true`) — that
// path pastes inert data on the hot path and has never been the problem; only
// control commands are verified.
export async function pasteAndSubmit(deps, payload, { bracketed = false, verify = false } = {}) {
  const { run, runStdin, target, buffer } = deps;

  await runStdin(["load-buffer", "-b", buffer, "-"], payload);
  const paste = run(["paste-buffer", ...(bracketed ? ["-p"] : []), "-b", buffer, "-t", target, "-d"]);
  if (paste.status !== 0) {
    throw new Error(`tmux paste-buffer: ${String(paste.stderr ?? "").trim()}`);
  }

  await sleep(ENTER_DELAY_MS());
  const e1 = run(["send-keys", "-t", target, "Enter"]);
  if (e1.status !== 0) throw new Error(`tmux send-keys: ${String(e1.stderr ?? "").trim()}`);
  await sleep(ENTER_GAP_MS());
  run(["send-keys", "-t", target, "Enter"]);

  if (!verify) return { submitted: true, verified: false, attempts: 1 };

  const retries = ENTER_RETRIES();
  for (let attempt = 1; ; attempt++) {
    const outcome = await pollUntilGone(deps, payload);
    if (outcome === false) return { submitted: true, verified: true, attempts: attempt };
    if (outcome === null) {
      return {
        submitted: false,
        verified: false,
        attempts: attempt,
        reason:
          `could not read the input line of pane '${target}' to verify submission — the command was typed but may not have run ` +
          `(pane capture failed, or no line matched AGENT_COORD_PROMPT_PATTERN for this TUI)`,
      };
    }
    if (attempt > retries) {
      return {
        submitted: false,
        verified: true, // we DID observe the pane; what we observed is failure
        attempts: attempt,
        reason:
          `the command is still in the input of pane '${target}' after ${attempt} submit attempt(s) — ` +
          `it was typed but did not run (raise AGENT_COORD_ENTER_DELAY_MS if this recurs)`,
      };
    }
    // Still sitting there: one more Enter before giving up.
    //
    // Every retry re-verifies FIRST (the loop head above), so an Enter is only
    // ever sent after we have just looked at the input line and seen the
    // command still in it. That ordering is the whole safety argument: these
    // are keystrokes into a live session someone else may be typing in, and an
    // Enter sent on a stale reading would submit whatever they had drafted
    // since. Under the old tail-window check this fired on EVERY successful
    // submit — three Enters into a pane that had already run the command.
    await sleep(ENTER_GAP_MS());
    run(["send-keys", "-t", target, "Enter"]);
  }
}

// Poll capture-pane until the payload leaves the input line, the budget runs
// out, or we run out of ways to tell. true = still there, false = gone,
// null = unknown (capture failed, or no input line we can read).
async function pollUntilGone(deps, payload) {
  const { run, target } = deps;
  const deadline = Date.now() + VERIFY_TIMEOUT_MS();
  let readInput = false;
  for (;;) {
    // Styled capture here too: a ghost suggestion CONTAINING the payload
    // (e.g. the TUI suggesting "/compact" right after it ran) would otherwise
    // read as "still in the input" — a false non-submit whose retry path
    // sends extra Enters into a live pane on the strength of chrome.
    const cap = run(["capture-pane", "-e", "-p", "-t", target]);
    if (cap.status === 0) {
      const verdict = stillInInput(String(cap.stdout ?? ""), payload);
      if (verdict === false) return false;
      if (verdict === true) readInput = true; // we could read the input line
    }
    if (Date.now() >= deadline) return readInput ? true : null;
    await sleep(VERIFY_POLL_MS());
  }
}
