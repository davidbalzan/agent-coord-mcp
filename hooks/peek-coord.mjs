#!/usr/bin/env node
// Claude Code hook: drains unread agent-coord messages into the next turn
// without making the agent poll. Reads ~/agent-coord/ directly (no MCP roundtrip).
//
// Usage (in settings.json):
//   UserPromptSubmit  -> node /path/to/peek-coord.mjs --mode=user-prompt
//   Stop              -> node /path/to/peek-coord.mjs --mode=stop
//
// Required env: AGENT_COORD_ID (the agent's id, matches register({agentId}))
// Optional env: AGENT_COORD_DIR (default ~/agent-coord)
// Optional env: AGENT_COORD_INCLUDE_ROOM=1 to also drain the shared room

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.slice(7)) ?? "user-prompt";

const ROOT =
  process.env.AGENT_COORD_DIR ??
  process.env.CLAUDE_COORD_DIR ??
  path.join(homedir(), "agent-coord");

// Default channel — declared up here so the hoisted joinedRooms()/roomFile()
// helpers, called during the top-level drain below, don't trip the const TDZ.
const DEFAULT_ROOM = "general";

// Prefer the agentId that is actually attached to this tmux pane (via the
// transports/ registry) over the env-provided one. This is what lets the
// generic settings.json hook command — which derives AGENT_COORD_ID from the
// cwd basename — still resolve to the agent that registered with a custom id
// (e.g. "claude-david" rather than "linkaroo.io"). Without this, peek reads
// the wrong cursor + inbox files and the m.from === AGENT_ID self-filter
// below never matches the agent's own room posts.
const AGENT_ID = resolveAgentId();
if (!AGENT_ID) {
  // No agent id configured and no tmux transport match — silently no-op so
  // the hook never blocks the user.
  process.exit(0);
}

const INBOX = path.join(ROOT, "inbox", `${sanitize(AGENT_ID)}.jsonl`);
const CURSOR = path.join(ROOT, "cursors", `${sanitize(AGENT_ID)}.json`);
const INCLUDE_ROOM = process.env.AGENT_COORD_INCLUDE_ROOM === "1";

const cursor = readJson(CURSOR, {});
const out = [];

const inbox = drain(INBOX, cursor, "inboxOffset");
// Control commands (/clear, /compact) only mean anything typed into a live CLI
// by a tmux pusher; surfaced as hook context text they're inert noise. Consume
// them (the cursor already advanced in drain) but don't render them.
for (const m of inbox) if (!m.control) out.push(fmt("dm", null, m));

if (INCLUDE_ROOM) {
  // Drain every channel this agent has joined, each against its own offset
  // (general → roomOffset, others → roomOffsets[chan]).
  for (const chan of joinedRooms()) {
    const room = drainRoom(chan, cursor);
    for (const m of room) {
      if (m.from === AGENT_ID) continue; // don't echo our own posts back
      if (m.control) continue; // tmux-only control command — see note above
      out.push(fmt("room", chan, m));
    }
  }
}

if (out.length === 0) process.exit(0);

writeJsonAtomic(CURSOR, cursor);

const banner =
  `[agent-coord] ${out.length} unread message(s) for "${AGENT_ID}". ` +
  `These were delivered via hook; do not call read_messages for them again.\n`;
const body = banner + out.join("\n");

if (MODE === "stop") {
  // Stop hook: emit JSON to keep the session going with the new context.
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: body }) + "\n"
  );
} else {
  // UserPromptSubmit (and any other mode): plain stdout is appended to context.
  process.stdout.write(body + "\n");
}

// ---------- helpers ----------

// Parse a JSONL file into entries, dropping blank/malformed lines. Offsets
// index into THIS parsed array — identical to the MCP server (readJsonl) and
// the pusher, so the shared cursor means the same position for all three. (The
// older "slice raw lines, then parse" approach counted malformed lines toward
// the offset and could desync the cursor against the MCP server.)
function readJsonlParsed(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function drain(file, cursor, key) {
  const all = readJsonlParsed(file);
  const start = cursor[key] ?? 0;
  const slice = all.slice(start);
  if (slice.length > 0) cursor[key] = start + slice.length;
  return slice;
}

// Drain a channel against its per-channel offset, reading from the file the
// channel maps to (general → room.jsonl, others → rooms/<chan>.jsonl).
function drainRoom(chan, cursor) {
  const c = normalizeRoom(chan);
  const all = readJsonlParsed(roomFile(c));
  const start = getRoomOffset(cursor, c);
  const slice = all.slice(start);
  if (slice.length > 0) setRoomOffset(cursor, c, start + slice.length);
  return slice;
}

function fmt(source, chan, m) {
  const ts = new Date(m.ts ?? Date.now()).toISOString();
  const who = m.from ?? "?";
  const tag = source === "room" ? `room #${normalizeRoom(chan)}` : "dm";
  return `  [${tag} ${ts} from=${who}] ${m.text ?? ""}`;
}

// ---------- channel helpers (mirror src/store.ts) ----------

function normalizeRoom(name) {
  if (!name) return DEFAULT_ROOM;
  const n = String(name).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

function roomFile(chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? path.join(ROOT, "room.jsonl") : path.join(ROOT, "rooms", `${sanitize(c)}.jsonl`);
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
  const reg = readJson(path.join(ROOT, "rooms.json"), {});
  const out = new Set([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e && Array.isArray(e.members) && e.members.includes(AGENT_ID)) out.add(chan);
  }
  return [...out];
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveAgentId() {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    const fromTransport = lookupAgentByPane(pane);
    if (fromTransport) return fromTransport;
  }
  return process.env.AGENT_COORD_ID || null;
}

function lookupAgentByPane(pane) {
  const dir = path.join(ROOT, "transports");
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(path.join(dir, name), null);
    if (data && data.tmuxTarget === pane && typeof data.agentId === "string") {
      return data.agentId;
    }
  }
  return null;
}
