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
const ROOM = path.join(ROOT, "room.jsonl");
const CURSOR = path.join(ROOT, "cursors", `${sanitize(AGENT_ID)}.json`);
const INCLUDE_ROOM = process.env.AGENT_COORD_INCLUDE_ROOM === "1";

const cursor = readJson(CURSOR, {});
const out = [];

const inbox = drain(INBOX, cursor, "inboxOffset");
for (const m of inbox) out.push(fmt("inbox", m));

if (INCLUDE_ROOM) {
  const room = drain(ROOM, cursor, "roomOffset");
  for (const m of room) {
    if (m.from === AGENT_ID) continue; // don't echo our own room posts back
    out.push(fmt("room", m));
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

function drain(file, cursor, key) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const start = cursor[key] ?? 0;
  const slice = lines.slice(start);
  const parsed = [];
  for (const line of slice) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }
  if (slice.length > 0) cursor[key] = start + slice.length;
  return parsed;
}

function fmt(source, m) {
  const ts = new Date(m.ts ?? Date.now()).toISOString();
  const who = m.from ?? "?";
  const tag = source === "room" ? "room" : "dm";
  return `  [${tag} ${ts} from=${who}] ${m.text ?? ""}`;
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
