#!/usr/bin/env node
/**
 * tmux-pusher.mjs
 *
 * Long-running daemon that watches an agent's coord inbox (and optionally the
 * shared room) and types new messages into a tmux pane running an interactive
 * CLI agent. Works with any line-driven agent CLI: Claude Code, Aider, codex,
 * gemini-cli, opencode, etc.
 *
 * Required env:
 *   AGENT_COORD_ID            agentId registered with the MCP
 *   AGENT_COORD_TMUX_TARGET   tmux target, e.g. "coord-frontend:agent.0"
 *
 * Optional env:
 *   AGENT_COORD_DIR           override state dir (default ~/agent-coord)
 *   AGENT_COORD_INCLUDE_ROOM  "1" to also inject shared-room messages
 *   AGENT_COORD_ALLOWLIST     comma-separated peer agentIds to accept
 *                             (default: accept all)
 *   AGENT_COORD_DEBOUNCE_MS   coalesce window for bursts (default 1000)
 *   AGENT_COORD_POLL_MS       fallback poll interval (default 1000)
 *   AGENT_COORD_TARGET_GRACE  missed pane probes before self-exit (default 3)
 *   AGENT_COORD_MAX_QUEUE_MS  max time routine (channel) traffic may queue
 *                             without an urgent trigger before it flushes as
 *                             a digest (default 15000 = 15s; 0 disables)
 *
 * Safety:
 *   - drops messages where from === AGENT_COORD_ID (no self-echo)
 *   - drops messages whose text starts with "/" (avoid injected slash commands),
 *     EXCEPT control-flagged messages carrying an allowlisted command
 *     (/clear, /compact) sent via the MCP `send_command` tool — those are
 *     injected RAW (no banner/prefix) so the CLI runs them as slash commands
 *   - if allowlist set, drops messages from peers not in it
 *   - serializes tmux sends so two batches never overlap
 *
 * Cursor: shares ~/agent-coord/cursors/<id>.json with the MCP server, so the
 * agent calling read_messages won't see anything the pusher already delivered.
 *
 * Do NOT enable peek-coord.mjs Stop/UserPromptSubmit hooks for the same agent
 * while this daemon runs — both consume the same cursor and would race.
 *
 * Caveats:
 *   - PEER MESSAGES paste into whatever pane state exists. If you're mid-typing
 *     in the same pane, your buffer gets corrupted. Run the receiving agent in
 *     a dedicated pane you don't normally edit in.
 *   - CONTROL COMMANDS (/clear, /compact) are the exception: since they paste
 *     RAW, a pane that is busy or holds an unsent draft would either queue them
 *     behind a running turn or append them to the draft and ship the result to
 *     the model as ordinary text — both observed live, both reporting
 *     delivery:"confirmed". So control submission is CONDITIONAL: it waits
 *     (bounded) for a busy pane to go idle, refuses to paste onto a draft, and
 *     verifies via capture-pane that the command left the input. An unverified
 *     submission reports delivery:"pending" with a reason, never "confirmed".
 *     See hooks/submit.mjs, shared with scripts/coord-pusher.mjs.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  watch,
} from "node:fs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { effectiveTier, isGateRunnerRole, TierQueue, formatBatch } from "./tier.mjs";
import { pasteAndSubmit as sharedPasteAndSubmit, submitControl as sharedSubmitControl } from "./submit.mjs";

const AGENT_ID = process.env.AGENT_COORD_ID;
const TMUX_TARGET = process.env.AGENT_COORD_TMUX_TARGET;
if (!AGENT_ID) die("AGENT_COORD_ID is required");
if (!TMUX_TARGET) die("AGENT_COORD_TMUX_TARGET is required");

const ROOT = process.env.AGENT_COORD_DIR || path.join(homedir(), "agent-coord");
const INCLUDE_ROOM = process.env.AGENT_COORD_INCLUDE_ROOM === "1";
// Default channel + watch registry — declared up here so the hoisted channel
// helpers, called from the top-level checkOnce(), don't trip the const TDZ.
const DEFAULT_ROOM = "general";
const watchedRooms = new Set();
const ALLOWLIST = (process.env.AGENT_COORD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEBOUNCE_MS = parseInt(process.env.AGENT_COORD_DEBOUNCE_MS || "1000", 10);
const POLL_MS = parseInt(process.env.AGENT_COORD_POLL_MS || "1000", 10);
// Consecutive missed pane probes before we conclude the target is gone and
// self-exit. A small grace rides out transient tmux-server hiccups.
const TARGET_GRACE = parseInt(process.env.AGENT_COORD_TARGET_GRACE || "3", 10);
// Delivery tiers: only push-now traffic (BLOCKER/DAVID_DECISION/GO:/
// trusted SCOPE:/DONE-to-gate, controls, server-flagged reminders) wakes the
// agent; everything else queues unread and rides the next push as a coalesced
// digest. AGENT_COORD_TIERS=0 restores legacy push-everything.
const TIERS_ENABLED = process.env.AGENT_COORD_TIERS !== "0";
// Max-age flush: routine traffic never waits longer than this for an urgent
// trigger — once the oldest queued message is overdue, the backlog flushes as
// a routine-only digest. Bounds the silent-fleet failure mode where FYI:/DONE:
// chatter queues forever because nothing urgent ever arrives. Only channel
// traffic queues (DMs are push-now), so the default is short.
const MAX_QUEUE_MS = parseInt(process.env.AGENT_COORD_MAX_QUEUE_MS || "15000", 10);
// Gate runners (QA/coordinator) receive DONE: as push-now; countersigned
// SCOPE: changes are honored only from these trusted ids. Re-resolved from
// the registry every 30s so a role change doesn't strand a stale pusher;
// AGENT_COORD_GATE_RUNNER=1|0 overrides in both directions.
let tierCtx = { enabled: TIERS_ENABLED, gateRunner: false, trustedSenders: new Set() };
function refreshTierCtx() {
  let gateRunner = false;
  const trusted = new Set();
  try {
    const reg = JSON.parse(readFileSync(path.join(ROOT, "agents.json"), "utf8"));
    for (const [id, entry] of Object.entries(reg ?? {})) {
      // Pass the whole entry: the frozen roleId lives beside `role`, and
      // reading only the display string would throw the identity away.
      if (isGateRunnerRole(entry)) trusted.add(id);
    }
    gateRunner = trusted.has(AGENT_ID);
  } catch {
    // No registry yet — conservative default (not a gate runner).
  }
  const env = process.env.AGENT_COORD_GATE_RUNNER;
  if (env === "1" || env === "true") gateRunner = true;
  if (env === "0" || env === "false") gateRunner = false;
  if (gateRunner !== tierCtx.gateRunner) {
    process.stderr.write(`[tmux-pusher] gate-runner resolved: ${gateRunner}\n`);
  }
  tierCtx = { enabled: TIERS_ENABLED, gateRunner, trustedSenders: trusted };
}
refreshTierCtx();
setInterval(refreshTierCtx, 30_000).unref();

const SAFE_ID = AGENT_ID.replace(/[^a-zA-Z0-9._-]/g, "_");
const INBOX_FILE = path.join(ROOT, "inbox", `${SAFE_ID}.jsonl`);
const CURSOR_FILE = path.join(ROOT, "cursors", `${SAFE_ID}.json`);
const TRANSPORT_FILE = path.join(ROOT, "transports", `${SAFE_ID}.json`);
// Out-of-band delivery receipts: stamped AFTER a message is typed into the
// pane, so the sender can poll for proof of delivery without the receipt ever
// entering any agent's context. Mirrors RECEIPTS_DIR in src/store.ts.
const RECEIPTS_FILE = path.join(ROOT, "receipts", `${SAFE_ID}.jsonl`);
const BUFFER_NAME = `coord-${SAFE_ID}`;
// mtime of the script this process actually loaded, sampled once at startup —
// an upgrade to the file on disk afterwards leaves this value behind, which is
// exactly what doctor's stale-pusher-script check compares against.
const SCRIPT_MTIME = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return undefined;
  }
})();

mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
mkdirSync(path.dirname(TRANSPORT_FILE), { recursive: true });
mkdirSync(path.dirname(RECEIPTS_FILE), { recursive: true });

// Confirm tmux target exists at startup so we fail loudly instead of silently.
const probe = spawnSync("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "ok"]);
if (probe.status !== 0) {
  die(`tmux target '${TMUX_TARGET}' not found: ${(probe.stderr ?? "").toString().trim()}`);
}

let pending = [];
let debounceTimer = null;
let sending = false;
let targetMisses = 0;

function readCursor() {
  if (!existsSync(CURSOR_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CURSOR_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCursor(c) {
  const tmp = CURSOR_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, CURSOR_FILE);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Allowlisted control commands the bus may type into this CLI. Mirrors
// CONTROL_COMMANDS in src/tools.ts; kept tiny + literal so a bugged/compromised
// sender can't smuggle an arbitrary slash command past the guard below.
const CONTROL_COMMANDS = new Set(["/clear", "/compact"]);

// Shells we refuse to inject into: if the pane's foreground command is one of
// these, the agent CLI has exited and typing would run pasted text as commands.
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh"]);

// Foreground command of the target pane, or null if it can't be determined
// (in which case we do NOT block — fall back to the bracketed-paste protection).
function paneCurrentCommand() {
  const r = spawnSync("tmux", [
    "display-message",
    "-p",
    "-t",
    TMUX_TARGET,
    "#{pane_current_command}",
  ]);
  if (r.status !== 0) return null;
  return (r.stdout ?? "").toString().trim() || null;
}

function isControl(m) {
  return (
    !!m &&
    m.control === true &&
    typeof m.text === "string" &&
    CONTROL_COMMANDS.has(m.text.trim())
  );
}

function shouldInject(m) {
  if (!m || m.from === AGENT_ID) return false;
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(m.from)) return false;
  // Authorized control command — bypass the slash guard, injected raw later.
  if (isControl(m)) return true;
  if (typeof m.text === "string" && m.text.trimStart().startsWith("/")) return false;
  return true;
}

// In-memory delivery ledger. `stagedOffsets` marks how far we've COLLECTED
// (prevents double-collection across polls); the on-disk cursor — shared
// with read_messages — advances only after a batch is actually pasted. A
// crash/SIGTERM/pane-death between the two rewinds to the on-disk cursor, so
// queued-but-undelivered traffic is redelivered on restart (at-least-once),
// never lost. Routine messages wait in tierQueue until a push-now trigger
// coalesces them; their offset commits travel in pendingCommits alongside.
const stagedOffsets = {};
const tierQueue = new TierQueue({ maxAgeMs: TIERS_ENABLED ? MAX_QUEUE_MS : 0 });
let pendingCommits = [];

function collectSource(label, file, cursorKey, cur, staged) {
  const all = readJsonl(file);
  const off = Math.max(cur[cursorKey] ?? 0, stagedOffsets[cursorKey] ?? 0);
  const fresh = all.slice(off);
  if (fresh.length === 0) return;
  for (const m of fresh) {
    if (shouldInject(m)) {
      // The channel tag lives in `tag`, not `kind`. A stored Message carries
      // its own `kind` ("decision"/"status"/"chatter" — retention weight);
      // sharing the name meant a room post tagged kind:"decision" (what the
      // README recommends for GOs and verdicts) overwrote the channel tag and
      // rendered as `[decision …]` instead of `[#general …]`, breaking
      // injectLine's parse contract. Distinct names remove the collision at
      // the source; assignment still follows the spread so a sender cannot
      // smuggle a `tag` in either.
      const tagged = { ...m, tag: label };
      // Assigned after the spread so a sender can't smuggle a tier field in.
      tagged.tier = effectiveTier(tagged, tierCtx);
      staged.msgs.push(tagged);
    }
  }
  const newOff = off + fresh.length;
  stagedOffsets[cursorKey] = newOff;
  // Offsets are absolute and applied monotonically, so re-applying on a
  // flush retry is harmless.
  staged.commits.push((c) => {
    c[cursorKey] = Math.max(c[cursorKey] ?? 0, newOff);
  });
}

// Collect one channel against its per-channel offset (general → roomOffset,
// others → roomOffsets[chan]); tag collected lines with the channel name.
function collectRoomChannel(chan, cur, staged) {
  const c = normalizeRoom(chan);
  const all = readJsonl(roomFile(c));
  const off = Math.max(getRoomOffset(cur, c), stagedOffsets[`room:${c}`] ?? 0);
  const fresh = all.slice(off);
  if (fresh.length === 0) return;
  for (const m of fresh) {
    if (shouldInject(m)) {
      const tagged = { ...m, tag: `room #${c}` }; // see channel-tag note above
      tagged.tier = effectiveTier(tagged, tierCtx);
      staged.msgs.push(tagged);
    }
  }
  const newOff = off + fresh.length;
  stagedOffsets[`room:${c}`] = newOff;
  staged.commits.push((cc) => setRoomOffset(cc, c, Math.max(getRoomOffset(cc, c), newOff)));
}

// Fold accumulated offset commits into the on-disk cursor. Called from the
// flush success path (delivery confirmed) and for junk-only batches.
function commitOffsets(commits) {
  if (commits.length === 0) return;
  const cur = readCursor();
  for (const c of commits) c(cur);
  writeCursor(cur);
}

function checkOnce() {
  const cur = readCursor();
  const staged = { msgs: [], commits: [] };
  collectSource("DM", INBOX_FILE, "inboxOffset", cur, staged);
  if (INCLUDE_ROOM) {
    // Tail every channel the agent has joined. checkOnce runs on each poll, so
    // channels joined after startup are picked up automatically.
    for (const chan of joinedRooms()) {
      collectRoomChannel(chan, cur, staged);
      watchRoom(chan);
    }
  }
  pendingCommits.push(...staged.commits);
  if (
    staged.msgs.length === 0 &&
    tierQueue.size() === 0 &&
    pending.length === 0 &&
    !sending &&
    pendingCommits.length > 0
  ) {
    // Everything fresh was filtered (self/allowlist/slash) and nothing is
    // queued or in flight — fold the offsets forward now instead of leaving
    // junk to block until a future push.
    commitOffsets(pendingCommits);
    pendingCommits = [];
    return;
  }
  // Tiered delivery: push only when the fresh batch contains a push-now
  // trigger. A routine-only backlog stays queued (on-disk cursor untouched)
  // so an idle agent is never woken — it rides the digest of the next trigger,
  // or flushes on its own once the oldest queued message exceeds MAX_QUEUE_MS.
  const now = Date.now();
  const batch = tierQueue.ingest(staged.msgs, now) ?? tierQueue.flushOverdue(now);
  if (!batch) return;
  pending.push(...batch);
  scheduleFlush();
}

function scheduleFlush() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  debounceTimer = null;
  if (sending) {
    scheduleFlush();
    return;
  }
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const commits = pendingCommits;
  pendingCommits = [];
  sending = true;
  try {
    await injectViaTmux(batch);
    // Delivery confirmed — only now advance the shared on-disk cursor past
    // everything this batch (including its coalesced routine) covers. Dying
    // before this line means redelivery on restart, never loss.
    commitOffsets(commits);
  } catch (e) {
    process.stderr.write(`[tmux-pusher] inject failed: ${e?.message ?? e}\n`);
    pending = [...batch, ...pending];
    pendingCommits = [...commits, ...pendingCommits];
    scheduleFlush();
  } finally {
    sending = false;
  }
}

// formatBatch lives in tier.mjs (pure, unit-tested): urgent verbatim under
// the banner, then at most ONE coalesced digest block of queued routine.

// Inject a batch, preserving order. Runs of ordinary peer messages go in as one
// banner-wrapped paste; each control command (/clear, /compact) is injected on
// its own as a RAW line so the TUI runs it as a slash command — a banner or
// `[DM …]` prefix would turn it into plain chat text instead.
async function injectViaTmux(batch) {
  // Fail-closed pane guard: never type into a pane that has dropped to a shell
  // (crashed/exited agent CLI). Bracketed paste protects a compliant TUI, but a
  // raw shell would execute pasted lines — so refuse and let the at-least-once
  // cursor redeliver once the agent CLI is back.
  const cmd = paneCurrentCommand();
  if (cmd !== null && SHELL_COMMANDS.has(cmd)) {
    process.stderr.write(
      `[tmux-pusher] pane '${TMUX_TARGET}' is at a shell ('${cmd}'), not the agent CLI — skipping inject (will redeliver)\n`,
    );
    return;
  }
  let run = [];
  const flushRun = async () => {
    if (run.length === 0) return;
    await pasteAndSubmit(formatBatch(run), true); // peer content: inert bracketed paste
    writeReceipts(run); // stamp only AFTER the paste+submit resolves
    run = [];
  };
  for (const m of batch) {
    if (isControl(m)) {
      await flushRun();
      // Control commands are VERIFIED: capture-pane confirms the command
      // actually left the input. A receipt that says "typed" was being read
      // as "ran" — see writeReceipts.
      const outcome = await submitControlCommand(m.text.trim());
      writeReceipts([m], outcome);
    } else {
      run.push(m);
    }
  }
  await flushRun();
}

// Append one delivery receipt per message AFTER it has been typed into the
// pane. Receipts are out-of-band proof for the sender (it polls this file),
// never injected into any agent's context — so verification costs zero tokens.
// Best-effort: a failed receipt write must not break delivery, so we swallow.
// `outcome` (control commands only) carries what verification actually saw.
// WITHOUT it a receipt proved the pusher TYPED the command, and send_command
// reported that as delivery:"confirmed" — proof of typing sold as proof of
// execution. `submitted` is the honest field: false means it is still sitting
// in the input, and the sender is told so instead of being reassured.
function writeReceipts(msgs, outcome) {
  const lines = [];
  for (const m of msgs) {
    if (!m || !m.id) continue;
    lines.push(
      JSON.stringify({
        id: m.id,
        agentId: AGENT_ID,
        ts: Date.now(),
        from: m.from,
        control: m.control === true,
        ...(outcome
          ? {
              submitted: outcome.submitted === true,
              verified: outcome.verified === true,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            }
          : {}),
      }),
    );
  }
  if (lines.length === 0) return;
  try {
    appendFileSync(RECEIPTS_FILE, lines.join("\n") + "\n");
  } catch (e) {
    process.stderr.write(`[tmux-pusher] receipt write failed: ${e?.message ?? e}\n`);
  }
}

// bracketed=true wraps the paste in bracketed-paste markers (paste-buffer -p) so
// a compliant TUI treats the payload as inert data — embedded newlines can't
// submit lines or smuggle a "/command". Control commands (/clear, /compact) must
// paste RAW (bracketed=false) so the TUI still runs them as slash commands.
//
// The pipeline itself lives in ./submit.mjs, shared with scripts/coord-pusher.mjs
// so the two cannot drift again. This wrapper only supplies tmux.
const tmuxDeps = {
  target: TMUX_TARGET,
  buffer: BUFFER_NAME,
  run: (args) => spawnSync("tmux", args, { encoding: "utf8" }),
  runStdin: (args, payload) =>
    new Promise((resolve, reject) => {
      const load = spawn("tmux", args);
      load.on("error", reject);
      load.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} exit ${code}`))));
      load.stdin.end(payload);
    }),
};

function pasteAndSubmit(payload, bracketed = false) {
  return sharedPasteAndSubmit(tmuxDeps, payload, { bracketed });
}

// Control commands go through the preflight + verify path, never the plain one.
function submitControlCommand(payload) {
  return sharedSubmitControl(tmuxDeps, payload);
}

// Publish transport marker so list_agents can show this agent is push-capable.
writeTransportMarker();
let markerCleaned = false;
const cleanupMarker = () => {
  if (markerCleaned) return;
  markerCleaned = true;
  try {
    unlinkSync(TRANSPORT_FILE);
  } catch {
    // already gone
  }
};
// Log BEFORE cleaning up. A silent exit that also removes its own marker is
// indistinguishable from "never attached" — on 2026-07-28 all four pushers on
// the bus vanished at once and the cause could not be determined afterwards,
// because every other exit path logs and this one did not. Ruled out at the
// time: dead-pane self-exit (logs), die() (logs), SIGKILL/OOM (the marker
// would have survived), a normal exit (the poll intervals are not unref'd),
// doctor's reaper (has-session returned 0 for every live pane), tests (all
// isolate AGENT_COORD_DIR), coord-chat (not running), stop-agent.sh (would
// have killed the session too) and a parent process-group signal (the pusher
// has its own PGID and SID). That left a signal from outside the repo, with
// nothing recorded to identify it.
function logSignal(sig) {
  process.stderr.write(
    `[tmux-pusher] received ${sig} — cleaning up marker for '${AGENT_ID}' (pane ${TMUX_TARGET}, pid ${process.pid}) and exiting\n`,
  );
}

process.on("SIGINT", () => {
  logSignal("SIGINT");
  cleanupMarker();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logSignal("SIGTERM");
  cleanupMarker();
  process.exit(0);
});
process.on("exit", cleanupMarker);

function writeTransportMarker() {
  const marker = {
    agentId: AGENT_ID,
    transport: "tmux-push",
    pid: process.pid,
    tmuxTarget: TMUX_TARGET,
    since: Date.now(),
    // MUST be included: attach_agent stamps this too, but this write happens
    // afterwards and would otherwise clobber it — and doctor SKIPS markers
    // without it (pre-v0.8.2 shape), so dropping it silently disabled the
    // stale-pusher-script check for every local pusher. Our own mtime is the
    // more truthful value anyway: it is the script THIS process loaded.
    scriptMtime: SCRIPT_MTIME,
  };
  const tmp = TRANSPORT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, TRANSPORT_FILE);
}

// Initial drain in case messages accumulated before the daemon started.
checkOnce();

// Watch + poll fallback.
try {
  if (existsSync(INBOX_FILE)) watch(INBOX_FILE, () => checkOnce());
} catch {
  // file may not exist yet; polling covers it
}
if (INCLUDE_ROOM) {
  for (const chan of joinedRooms()) watchRoom(chan);
}
setInterval(checkOnce, POLL_MS);
// Self-exit when our target pane disappears (agent closed its window or crashed
// without unregister). Without this the daemon lingers with a live pid, so its
// transport marker reads as "live" forever and list_agents keeps the ghost
// agent online. cleanupMarker (also wired to process exit) drops the marker.
setInterval(checkTargetAlive, POLL_MS);

process.stderr.write(
  `[tmux-pusher] watching inbox for '${AGENT_ID}' -> tmux ${TMUX_TARGET} (room=${INCLUDE_ROOM ? "on" : "off"})\n`,
);

// Probe the target pane; after TARGET_GRACE consecutive misses, give up and
// exit cleanly so the marker is removed and the agent stops looking attached.
function checkTargetAlive() {
  const p = spawnSync("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "ok"]);
  if (p.status === 0) {
    targetMisses = 0;
    return;
  }
  targetMisses++;
  if (targetMisses >= TARGET_GRACE) {
    process.stderr.write(
      `[tmux-pusher] target '${TMUX_TARGET}' gone for ${targetMisses} probe(s) — cleaning up and exiting\n`,
    );
    cleanupMarker();
    process.exit(0);
  }
}

function die(msg) {
  process.stderr.write(`[tmux-pusher] ${msg}\n`);
  process.exit(1);
}

// ---------- channel helpers (mirror src/store.ts) ----------

function normalizeRoom(name) {
  if (!name) return DEFAULT_ROOM;
  const n = String(name).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

function roomFile(chan) {
  const c = normalizeRoom(chan);
  // c is already normalized to a filesystem-safe charset.
  return c === DEFAULT_ROOM ? path.join(ROOT, "room.jsonl") : path.join(ROOT, "rooms", `${c}.jsonl`);
}

function getRoomOffset(cursor, chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? cursor.roomOffset ?? 0 : cursor.roomOffsets?.[c] ?? 0;
}

function setRoomOffset(cursor, chan, n) {
  const c = normalizeRoom(chan);
  if (c === DEFAULT_ROOM) cursor.roomOffset = n;
  else (cursor.roomOffsets ??= {})[c] = n;
}

function joinedRooms() {
  let reg = {};
  try {
    const raw = readFileSync(path.join(ROOT, "rooms.json"), "utf8");
    if (raw.trim()) reg = JSON.parse(raw);
  } catch {
    // no registry yet → just the default channel
  }
  const out = new Set([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e && Array.isArray(e.members) && e.members.includes(AGENT_ID)) out.add(chan);
  }
  return [...out];
}

function watchRoom(chan) {
  const f = roomFile(chan);
  if (watchedRooms.has(f)) return;
  try {
    if (existsSync(f)) {
      watch(f, () => checkOnce());
      watchedRooms.add(f);
    }
  } catch {
    // polling covers it until the file exists
  }
}
