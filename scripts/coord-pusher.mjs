#!/usr/bin/env node
/**
 * coord-pusher — remote-machine counterpart to hooks/tmux-pusher.mjs.
 *
 * Where tmux-pusher reads the bus directly from the local filesystem,
 * coord-pusher consumes it over MCP (Streamable HTTP) from a server running
 * on another machine, then pastes incoming peer messages into the local tmux
 * pane. This is what makes "wake an idle agent" work cross-machine.
 *
 * Usage:
 *   coord-pusher --server <url> --token <t> --agent <id> --tmux <pane>
 *                [--no-room] [--allowlist a,b]
 *                [--debounce-ms 1000] [--refresh-ms 30000]
 *                [--probe-ms 5000] [--target-grace 3]
 *
 * Environment fallbacks (used if a flag is omitted):
 *   AGENT_COORD_SERVER     server URL (e.g. http://host:8765/mcp)
 *   AGENT_COORD_TOKEN      bearer token
 *   AGENT_COORD_ID         agentId
 *   AGENT_COORD_TMUX_TARGET tmux target pane (e.g. coord-frontend:agent.0)
 *
 * Safety mirrors tmux-pusher:
 *   - drops messages where from === agentId  (no self-echo)
 *   - drops messages whose text starts with "/" (avoid injected slash commands),
 *     EXCEPT control-flagged /clear and /compact from the `send_command` tool,
 *     which are injected RAW so the CLI runs them as slash commands
 *   - if allowlist set, drops messages from peers not in it
 *   - single-flight tmux send so two batches never overlap
 *
 * Liveness: heartbeats the server every 60s. The server treats the remote
 * transport marker as live while heartbeats stay fresh; without them, the
 * marker is garbage-collected (see loadLiveTransports in src/tools.ts). To
 * avoid a ghost agent when the pane is closed/crashed, the pusher also probes
 * its local tmux target and shuts down (clearing the marker) after a few
 * consecutive misses — tunable via --probe-ms / --target-grace.
 */

import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pasteAndSubmit as sharedPasteAndSubmit, submitControl as sharedSubmitControl } from "../hooks/submit.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------- args + env ----------

const argv = parseArgs(process.argv.slice(2));
const SERVER = argv.server ?? process.env.AGENT_COORD_SERVER;
const TOKEN = argv.token ?? process.env.AGENT_COORD_TOKEN;
const AGENT_ID = argv.agent ?? process.env.AGENT_COORD_ID;
const TMUX_TARGET = argv.tmux ?? process.env.AGENT_COORD_TMUX_TARGET;
const INCLUDE_ROOM = argv["no-room"] ? false : true;
const ALLOWLIST = (argv.allowlist ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEBOUNCE_MS = parseInt(argv["debounce-ms"] ?? "1000", 10);
const REFRESH_MS = parseInt(argv["refresh-ms"] ?? "30000", 10);

if (!SERVER) die("--server (or AGENT_COORD_SERVER) is required");
if (!TOKEN) die("--token (or AGENT_COORD_TOKEN) is required");
if (!AGENT_ID) die("--agent (or AGENT_COORD_ID) is required");
if (!TMUX_TARGET) die("--tmux (or AGENT_COORD_TMUX_TARGET) is required");

const SAFE_ID = AGENT_ID.replace(/[^a-zA-Z0-9._-]/g, "_");
const BUFFER_NAME = `coord-${SAFE_ID}`;

// Verify the tmux target exists up front — same probe tmux-pusher uses, so
// we fail loudly instead of silently dropping messages later.
const probe = spawnSync("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "ok"]);
if (probe.status !== 0) {
  die(`tmux target '${TMUX_TARGET}' not found: ${(probe.stderr ?? "").toString().trim()}`);
}

// ---------- MCP client ----------

const client = new Client({ name: "coord-pusher", version: "0.6.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});

try {
  await client.connect(transport);
} catch (e) {
  die(`failed to connect to ${SERVER}: ${e?.message ?? e}`);
}

// Call a tool and JSON-parse the wrapped text content. The server's tool
// handlers return { content: [{ type:"text", text: JSON.stringify(payload) }] }
// (see jsonResult in src/server.ts), so we unwrap exactly once.
//
// { strict: true } makes an MCP tool error (isError:true — e.g. an
// identity-mismatch on register/report_transport) throw instead of being
// silently returned as parsed data. Startup uses this so a failed
// register/report_transport can't be mistaken for success.
async function call(name, args, { strict = false } = {}) {
  // SDK zod schemas reject arguments:undefined; send {} for parameter-less tools.
  const r = await client.callTool({ name, arguments: args ?? {} });
  const text = r?.content?.[0]?.text;
  const data = typeof text !== "string" ? r : parseOr(text, text);
  if (strict && r?.isError) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}

function parseOr(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// Register (idempotent), then publish the transport marker so list_agents
// shows us attached. Marker liveness is heartbeat-based server-side. Both
// calls are strict: a server-side isError (e.g. identity-mismatch on a
// stale/reused token) must hard-fail the process rather than let us log
// "attached" and heartbeat into the void while delivering nothing.
try {
  await call("register", { agentId: AGENT_ID }, { strict: true });
} catch (e) {
  die(`register failed: ${e?.message ?? e}`);
}
// Build identity of THIS pusher process: newest mtime across the entry file
// AND its ../hooks/*.mjs imports, sampled once at startup. The entry file
// alone is not enough — the paste/submit pipeline lives in hooks/submit.mjs,
// so a fix landing there alone would leave a single-file stamp unchanged and
// a still-running pusher on the old code would read as fresh (#28's lesson,
// carried across the wire). Over-covering hooks siblings we don't import is
// the safe direction: a spurious stale flag is loud and cheap, a false fresh
// silently invalidates rollout verification. Stamped on the transport marker
// AND on every receipt this process reports; undefined on failure — an
// absent stamp reads as UNKNOWN downstream, never as fresh, and a partial
// (entry-only) value could read fresh while submit.mjs is exactly the stale
// part.
const scriptMtime = await (async () => {
  try {
    const { statSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const self = fileURLToPath(import.meta.url);
    let newest = statSync(self).mtimeMs;
    const hooksDir = path.join(path.dirname(self), "..", "hooks");
    for (const f of readdirSync(hooksDir)) {
      if (!f.endsWith(".mjs")) continue;
      let m;
      try {
        m = statSync(path.join(hooksDir, f)).mtimeMs;
      } catch {
        continue; // deleted mid-scan
      }
      if (m > newest) newest = m;
    }
    return newest;
  } catch {
    return undefined; // non-fatal — absence stays honest
  }
})();
try {
  await call(
    "report_transport",
    {
      agentId: AGENT_ID,
      transport: "tmux-push-remote",
      host: hostname(),
      tmuxTarget: TMUX_TARGET,
      since: Date.now(),
      ...(scriptMtime !== undefined ? { scriptMtime } : {}),
    },
    { strict: true },
  );
} catch (e) {
  die(`report_transport failed: ${e?.message ?? e}`);
}
process.stderr.write(
  `[coord-pusher] attached agent='${AGENT_ID}' tmux=${TMUX_TARGET} server=${SERVER} (room=${INCLUDE_ROOM ? "on" : "off"})\n`,
);

// Heartbeat keeps the registry's lastHeartbeat fresh so loadLiveTransports
// doesn't GC our marker. 60s is well under the 5min staleness window.
const hbTimer = setInterval(() => { call("heartbeat", { agentId: AGENT_ID }).catch(() => {}); }, 60_000);

// ---------- tmux inject pipeline (mirrors hooks/tmux-pusher.mjs) ----------

let pending = [];
let debounceTimer = null;
let sending = false;

// Allowlisted control commands (mirrors CONTROL_COMMANDS in src/tools.ts).
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
  if (isControl(m)) return true; // authorized control command — injected raw later
  if (typeof m.text === "string" && m.text.trimStart().startsWith("/")) return false;
  return true;
}

function scheduleFlush() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  debounceTimer = null;
  if (sending) { scheduleFlush(); return; }
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  sending = true;
  try {
    await injectViaTmux(batch);
  } catch (e) {
    process.stderr.write(`[coord-pusher] inject failed: ${e?.message ?? e}\n`);
    pending = [...batch, ...pending];
    scheduleFlush();
  } finally {
    sending = false;
  }
}

// The per-message PARSE CONTRACT line — MUST stay byte-identical to
// hooks/tier.mjs's injectLine (agent harnesses parse from/room/text out of
// it). Compact form (v0.14.0): `  [<tag> <HH:MM> <from>] <text>`, tag drops
// the leading "room ", timestamp is HH:MM UTC, no "from=" label. This pusher
// is standalone (may deploy without hooks/), so the helper is duplicated
// rather than imported; test/tier.test.mjs locks both to the same shape.
function injectLine(m) {
  const tag = String(m.tag ?? "").replace(/^room /, "");
  const d = new Date(m.ts ?? 0);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  let text = m.text ?? "";
  // Phase 8 Task 6: a TYPED record whose rendering spans lines is delivered as
  // ONE attributed line — first line, a count of what was withheld, and the
  // message id as the retrieval handle. Continuation lines used to arrive bare,
  // with no `[tag HH:MM from]` header, so a parser could not attribute them.
  //
  // The handle is the message id, NOT a stashed copy: the full record is
  // already persisted in rooms/<chan>.jsonl or inbox/<id>.jsonl, and
  // retrieve_message reads it back by id (falling through to the append-only
  // archive if compaction moved it). A cache would have had a TTL and lost the
  // record permanently on expiry.
  //
  // Gated on `m.record`: a record-LESS multi-line message is untouched and
  // still arrives unattributed past line 1, exactly as today. Task 6 does not
  // fix hand-typed multi-line messages, and must not change their bytes.
  const nl = text.indexOf("\n");
  if (nl !== -1 && m.record && typeof m.record.type === "string" && m.id) {
    const held = text.split("\n").length - 1;
    text = `${text.slice(0, nl)} [+${held} lines · record:${m.record.type} · retrieve_message id=${m.id}]`;
  }
  return `  [${tag} ${hhmm} ${m.from}] ${text}`;
}

function formatBatch(batch) {
  const lines = ["[agent-coord] msgs (pre-consumed, don't re-read):"];
  for (const m of batch) {
    lines.push(injectLine(m));
  }
  return lines.join("\n");
}

// Order-preserving inject: ordinary messages batch into one banner paste; each
// control command (/clear, /compact) goes in on its own as a RAW line so the
// CLI runs it as a slash command rather than echoing it as chat text.
async function injectViaTmux(batch) {
  // Fail-closed pane guard: never type into a pane that has dropped to a shell
  // (crashed/exited agent CLI). Bracketed paste protects a compliant TUI, but a
  // raw shell would execute pasted lines — so refuse and let the at-least-once
  // cursor redeliver once the agent CLI is back.
  const cmd = paneCurrentCommand();
  if (cmd !== null && SHELL_COMMANDS.has(cmd)) {
    process.stderr.write(
      `[coord-pusher] pane '${TMUX_TARGET}' is at a shell ('${cmd}'), not the agent CLI — skipping inject (will redeliver)\n`,
    );
    return;
  }
  let run = [];
  const flushRun = async () => {
    if (run.length === 0) return;
    await pasteAndSubmit(formatBatch(run), true); // peer content: inert bracketed paste
    await reportReceipts(run); // stamp only AFTER the paste+submit resolves
    run = [];
  };
  for (const m of batch) {
    if (isControl(m)) {
      await flushRun();
      // Verified like the local path: the extra Enters and the capture-pane
      // check are what make a control command actually run. The outcome is
      // reported back over MCP (report_receipt) so send_command can return
      // delivery:"confirmed" for a remote agent — before that wire tool
      // existed this pusher could only log, and a remote control command was
      // never confirmable no matter how well it went.
      const outcome = await submitControlCommand(m.text.trim());
      if (!outcome.submitted) {
        process.stderr.write(`[coord-pusher] control command NOT submitted: ${outcome.reason}\n`);
      }
      await reportReceipts([m], outcome);
    } else {
      run.push(m);
    }
  }
  await flushRun();
}

// Wire counterpart to tmux-pusher's writeReceipts: this pusher cannot append
// to receipts/<id>.jsonl on the server's filesystem, so it reports each
// delivery over MCP and the server writes the same receipt line the local
// path does. `outcome` (control commands only) carries what submit
// verification actually observed — submitted/verified/reason are forwarded
// verbatim and OMITTED entirely for ordinary peer batches, because an absent
// `submitted` means "typed but unverified" and must never be upgraded to a
// claim of execution this pusher did not make.
//
// Best-effort by design: a failed report must not break delivery or crash the
// inject loop (the message IS in the pane by the time we get here). The
// sender just times out to delivery:"pending" — the same honest answer an
// unreported submission always produced. This also covers servers predating
// the report_receipt tool: the unknown-tool error lands here and is logged.
async function reportReceipts(msgs, outcome) {
  for (const m of msgs) {
    if (!m || !m.id) continue;
    try {
      await call(
        "report_receipt",
        {
          agentId: AGENT_ID,
          id: m.id,
          ...(m.from !== undefined ? { from: m.from } : {}),
          control: m.control === true,
          // Our build identity (module-graph mtime, see the startup stamp) —
          // ties this receipt to the code that typed/verified the delivery.
          // Omitted when unknown; the server must not default it.
          ...(scriptMtime !== undefined ? { scriptMtime } : {}),
          ...(outcome
            ? {
                submitted: outcome.submitted === true,
                verified: outcome.verified === true,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
              }
            : {}),
        },
        { strict: true },
      );
    } catch (e) {
      process.stderr.write(`[coord-pusher] report_receipt for ${m.id} failed: ${e?.message ?? e}\n`);
    }
  }
}

// bracketed=true wraps the paste in bracketed-paste markers (paste-buffer -p) so
// a compliant TUI treats the payload as inert data — embedded newlines can't
// submit lines or smuggle a "/command". Control commands (/clear, /compact) must
// paste RAW (bracketed=false) so the TUI still runs them as slash commands.
//
// Paste + submit. The pipeline is ./hooks/submit.mjs, shared with the local
// pusher — this file used to carry its own copy, which had already drifted to a
// SINGLE Enter with no settle delay at all, so a remote agent's control command
// was even less likely to run than a local one. Only tmux is supplied here.
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

// ---------- per-source wait loops + subscription refresh ----------

// One loop per source: inbox (always) plus one per joined channel. Each loop
// long-polls wait_for_message — the server already filters self-posts and
// advances the cursor on returned batches, so we don't need a separate
// read_messages call. A `cancelled` flag is checked between waits so that
// channels we've left stop tailing on their own (within one wait window).
const loops = new Map(); // key → { cancelled }

function loopKey(source, room) { return source === "inbox" ? "inbox" : `room:${normalizeRoom(room)}`; }

function startLoop(source, room) {
  const key = loopKey(source, room);
  if (loops.has(key)) return;
  const state = { cancelled: false };
  loops.set(key, state);
  // Named `label` to match hooks/tmux-pusher.mjs, and to leave `tag` free as
  // the field name it is assigned to below.
  const label = source === "inbox" ? "DM" : `room #${normalizeRoom(room)}`;
  (async () => {
    while (!state.cancelled) {
      let r;
      try {
        r = await call("wait_for_message", { agentId: AGENT_ID, source, room, timeoutMs: 60_000 });
      } catch (e) {
        // Transport hiccup — back off briefly so we don't spin against a dead server.
        process.stderr.write(`[coord-pusher] wait_for_message(${label}) error: ${e?.message ?? e}\n`);
        await sleep(2_000);
        continue;
      }
      if (state.cancelled) break;
      const msgs = Array.isArray(r?.messages) ? r.messages : [];
      for (const m of msgs) {
        // The channel tag lives in `tag` — a stored Message's own `kind`
        // (retention weight) shared the name and overwrote what injectLine
        // renders. Mirrors hooks/tmux-pusher.mjs; the two must stay
        // byte-identical.
        if (shouldInject(m)) pending.push({ ...m, tag: label });
      }
      if (pending.length > 0) scheduleFlush();
    }
    loops.delete(key);
  })();
}

function stopLoop(source, room) {
  const key = loopKey(source, room);
  const s = loops.get(key);
  if (s) s.cancelled = true;
}

function normalizeRoom(name) {
  if (!name) return "general";
  const n = String(name).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || "general";
}

// Always tail the inbox.
startLoop("inbox");

// Periodically reconcile the set of joined channels — `list_rooms` returns
// each channel's members, so we tail the channels containing our agentId.
// New /join_room from the agent's Claude session shows up on the next refresh.
async function refreshSubscriptions() {
  if (!INCLUDE_ROOM) return;
  let rooms;
  try { rooms = (await call("list_rooms"))?.rooms ?? []; } catch (e) {
    process.stderr.write(`[coord-pusher] list_rooms error: ${e?.message ?? e}\n`);
    return;
  }
  const desired = new Set(["general"]);
  for (const r of rooms) if (Array.isArray(r.members) && r.members.includes(AGENT_ID)) desired.add(r.room);
  // Start loops for newly-joined channels.
  for (const chan of desired) startLoop("room", chan);
  // Cancel loops for channels we've left (but never general).
  for (const key of loops.keys()) {
    if (!key.startsWith("room:")) continue;
    const chan = key.slice("room:".length);
    if (chan === "general") continue;
    if (!desired.has(chan)) stopLoop("room", chan);
  }
}
await refreshSubscriptions();
const refreshTimer = setInterval(() => { refreshSubscriptions().catch(() => {}); }, REFRESH_MS);

// ---------- self-exit when the local tmux pane disappears ----------

// If the agent closes its pane or crashes without a clean shutdown, this daemon
// would otherwise keep heartbeating and the server's transport marker would
// stay "live" — a ghost agent in list_agents. Probe the pane periodically and,
// after a small grace (rides out transient tmux hiccups), shut down cleanly
// (which calls clear_transport, removing the marker).
const PROBE_MS = parseInt(argv["probe-ms"] ?? "5000", 10);
const TARGET_GRACE = parseInt(argv["target-grace"] ?? "3", 10);
let targetMisses = 0;
const targetTimer = setInterval(() => {
  const p = spawnSync("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "ok"]);
  if (p.status === 0) { targetMisses = 0; return; }
  if (++targetMisses >= TARGET_GRACE) {
    process.stderr.write(`[coord-pusher] target '${TMUX_TARGET}' gone for ${targetMisses} probe(s)\n`);
    void shutdown("target-gone");
  }
}, PROBE_MS);

// ---------- shutdown ----------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[coord-pusher] ${signal} → clearing transport marker + closing\n`);
  clearInterval(hbTimer);
  clearInterval(refreshTimer);
  clearInterval(targetTimer);
  for (const s of loops.values()) s.cancelled = true;
  try { await call("clear_transport", { agentId: AGENT_ID }); } catch {}
  try { await client.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (name === "no-room") { out["no-room"] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[name] = true; continue; }
    out[name] = next;
    i++;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function die(msg) {
  process.stderr.write(`[coord-pusher] ${msg}\n`);
  process.exit(1);
}
