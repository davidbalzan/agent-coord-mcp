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
 *
 * Environment fallbacks (used if a flag is omitted):
 *   AGENT_COORD_SERVER     server URL (e.g. http://host:8765/mcp)
 *   AGENT_COORD_TOKEN      bearer token
 *   AGENT_COORD_ID         agentId
 *   AGENT_COORD_TMUX_TARGET tmux target pane (e.g. coord-frontend:agent.0)
 *
 * Safety mirrors tmux-pusher:
 *   - drops messages where from === agentId  (no self-echo)
 *   - drops messages whose text starts with "/" (avoid injected slash commands)
 *   - if allowlist set, drops messages from peers not in it
 *   - single-flight tmux send so two batches never overlap
 *
 * Liveness: heartbeats the server every 60s. The server treats the remote
 * transport marker as live while heartbeats stay fresh; without them, the
 * marker is garbage-collected (see loadLiveTransports in src/tools.ts).
 */

import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
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
async function call(name, args) {
  // SDK zod schemas reject arguments:undefined; send {} for parameter-less tools.
  const r = await client.callTool({ name, arguments: args ?? {} });
  const text = r?.content?.[0]?.text;
  if (typeof text !== "string") return r;
  try { return JSON.parse(text); } catch { return text; }
}

// Register (idempotent), then publish the transport marker so list_agents
// shows us attached. Marker liveness is heartbeat-based server-side.
await call("register", { agentId: AGENT_ID });
await call("report_transport", {
  agentId: AGENT_ID,
  transport: "tmux-push-remote",
  host: hostname(),
  tmuxTarget: TMUX_TARGET,
  since: Date.now(),
});
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

function shouldInject(m) {
  if (!m || m.from === AGENT_ID) return false;
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(m.from)) return false;
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

function formatBatch(batch) {
  const lines = [
    "[agent-coord] incoming peer messages — already consumed from your inbox, do not call read_messages for them:",
  ];
  for (const m of batch) {
    const ts = new Date(m.ts ?? Date.now()).toISOString();
    lines.push(`  [${m.kind} ${ts} from=${m.from}] ${m.text ?? ""}`);
  }
  return lines.join("\n");
}

function injectViaTmux(batch) {
  return new Promise((resolve, reject) => {
    const payload = formatBatch(batch);
    const load = spawn("tmux", ["load-buffer", "-b", BUFFER_NAME, "-"]);
    load.on("error", reject);
    load.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`tmux load-buffer exit ${code}`));
      const paste = spawnSync("tmux", ["paste-buffer", "-b", BUFFER_NAME, "-t", TMUX_TARGET, "-d"]);
      if (paste.status !== 0) return reject(new Error(`tmux paste-buffer: ${(paste.stderr ?? "").toString().trim()}`));
      const enter = spawnSync("tmux", ["send-keys", "-t", TMUX_TARGET, "Enter"]);
      if (enter.status !== 0) return reject(new Error(`tmux send-keys: ${(enter.stderr ?? "").toString().trim()}`));
      resolve();
    });
    load.stdin.end(payload);
  });
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
  const tag = source === "inbox" ? "DM" : `room #${normalizeRoom(room)}`;
  (async () => {
    while (!state.cancelled) {
      let r;
      try {
        r = await call("wait_for_message", { agentId: AGENT_ID, source, room, timeoutMs: 60_000 });
      } catch (e) {
        // Transport hiccup — back off briefly so we don't spin against a dead server.
        process.stderr.write(`[coord-pusher] wait_for_message(${tag}) error: ${e?.message ?? e}\n`);
        await sleep(2_000);
        continue;
      }
      if (state.cancelled) break;
      const msgs = Array.isArray(r?.messages) ? r.messages : [];
      for (const m of msgs) {
        if (shouldInject(m)) pending.push({ kind: tag, ...m });
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

// ---------- shutdown ----------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[coord-pusher] ${signal} → clearing transport marker + closing\n`);
  clearInterval(hbTimer);
  clearInterval(refreshTimer);
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
