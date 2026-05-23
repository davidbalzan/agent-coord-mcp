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
 *
 * Safety:
 *   - drops messages where from === AGENT_COORD_ID (no self-echo)
 *   - drops messages whose text starts with "/" (avoid injected slash commands)
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
 *   - Pasting types into whatever pane state exists. If you're mid-typing in
 *     the same pane, your buffer gets corrupted. Run the receiving agent in a
 *     dedicated pane you don't normally edit in.
 *   - The pusher can't tell if the agent is idle, mid-tool, or showing a
 *     permission prompt. send-keys is unconditional.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const AGENT_ID = process.env.AGENT_COORD_ID;
const TMUX_TARGET = process.env.AGENT_COORD_TMUX_TARGET;
if (!AGENT_ID) die("AGENT_COORD_ID is required");
if (!TMUX_TARGET) die("AGENT_COORD_TMUX_TARGET is required");

const ROOT = process.env.AGENT_COORD_DIR || path.join(homedir(), "agent-coord");
const INCLUDE_ROOM = process.env.AGENT_COORD_INCLUDE_ROOM === "1";
const ALLOWLIST = (process.env.AGENT_COORD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEBOUNCE_MS = parseInt(process.env.AGENT_COORD_DEBOUNCE_MS || "1000", 10);
const POLL_MS = parseInt(process.env.AGENT_COORD_POLL_MS || "1000", 10);

const SAFE_ID = AGENT_ID.replace(/[^a-zA-Z0-9._-]/g, "_");
const INBOX_FILE = path.join(ROOT, "inbox", `${SAFE_ID}.jsonl`);
const ROOM_FILE = path.join(ROOT, "room.jsonl");
const CURSOR_FILE = path.join(ROOT, "cursors", `${SAFE_ID}.json`);
const TRANSPORT_FILE = path.join(ROOT, "transports", `${SAFE_ID}.json`);
const BUFFER_NAME = `coord-${SAFE_ID}`;

mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
mkdirSync(path.dirname(TRANSPORT_FILE), { recursive: true });

// Confirm tmux target exists at startup so we fail loudly instead of silently.
const probe = spawnSync("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "ok"]);
if (probe.status !== 0) {
  die(`tmux target '${TMUX_TARGET}' not found: ${(probe.stderr ?? "").toString().trim()}`);
}

let pending = [];
let debounceTimer = null;
let sending = false;

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

function shouldInject(m) {
  if (!m || m.from === AGENT_ID) return false;
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(m.from)) return false;
  if (typeof m.text === "string" && m.text.trimStart().startsWith("/")) return false;
  return true;
}

function drainSource(label, file, cursorKey, cur) {
  const all = readJsonl(file);
  const off = cur[cursorKey] ?? 0;
  const fresh = all.slice(off);
  if (fresh.length === 0) return false;
  for (const m of fresh) {
    if (shouldInject(m)) pending.push({ kind: label, ...m });
  }
  cur[cursorKey] = off + fresh.length;
  return true;
}

function checkOnce() {
  const cur = readCursor();
  let changed = false;
  if (drainSource("DM", INBOX_FILE, "inboxOffset", cur)) changed = true;
  if (INCLUDE_ROOM && drainSource("ROOM", ROOM_FILE, "roomOffset", cur)) changed = true;
  if (changed) writeCursor(cur);
  if (pending.length > 0) scheduleFlush();
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
  sending = true;
  try {
    await injectViaTmux(batch);
  } catch (e) {
    process.stderr.write(`[tmux-pusher] inject failed: ${e?.message ?? e}\n`);
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
    const tag = m.kind;
    const ts = new Date(m.ts ?? Date.now()).toISOString();
    lines.push(`  [${tag} ${ts} from=${m.from}] ${m.text ?? ""}`);
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
      const paste = spawnSync("tmux", [
        "paste-buffer",
        "-b",
        BUFFER_NAME,
        "-t",
        TMUX_TARGET,
        "-d",
      ]);
      if (paste.status !== 0) {
        return reject(new Error(`tmux paste-buffer: ${(paste.stderr ?? "").toString().trim()}`));
      }
      const enter = spawnSync("tmux", ["send-keys", "-t", TMUX_TARGET, "Enter"]);
      if (enter.status !== 0) {
        return reject(new Error(`tmux send-keys: ${(enter.stderr ?? "").toString().trim()}`));
      }
      resolve();
    });
    load.stdin.end(payload);
  });
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
process.on("SIGINT", () => {
  cleanupMarker();
  process.exit(0);
});
process.on("SIGTERM", () => {
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
  try {
    if (existsSync(ROOM_FILE)) watch(ROOM_FILE, () => checkOnce());
  } catch {
    // ignore
  }
}
setInterval(checkOnce, POLL_MS);

process.stderr.write(
  `[tmux-pusher] watching inbox for '${AGENT_ID}' -> tmux ${TMUX_TARGET} (room=${INCLUDE_ROOM ? "on" : "off"})\n`,
);

function die(msg) {
  process.stderr.write(`[tmux-pusher] ${msg}\n`);
  process.exit(1);
}
