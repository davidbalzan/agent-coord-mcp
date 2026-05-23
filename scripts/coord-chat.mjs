#!/usr/bin/env node
/**
 * coord-chat — minimal IRC-style TUI so a human can join the agent-coord bus.
 *
 * Usage:
 *   node scripts/coord-chat.mjs [--id <name>] [--dir <path>]
 *   coord-chat [--id <name>] [--dir <path>]    # if installed via npm bin
 *
 * Defaults: --id $USER, --dir $AGENT_COORD_DIR || ~/agent-coord
 *
 * Commands at the prompt:
 *   <text>             → post to shared room
 *   /dm <id> <text>    → DM a specific agent
 *   /list              → show registered agents + transports
 *   /help              → show commands
 *   /quit              → unregister and exit
 *
 * Dependency-light: only proper-lockfile (already a package dep) for the
 * read-modify-write on agents.json. JSONL appends are single small writes
 * (POSIX atomic under PIPE_BUF), no lock needed.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  watch,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import lockfile from "proper-lockfile";

// ---------- args ----------

const args = parseArgs(process.argv.slice(2));
const ID = args.id ?? process.env.USER ?? "human";
const ROOT = args.dir ?? process.env.AGENT_COORD_DIR ?? path.join(homedir(), "agent-coord");

const INBOX_DIR = path.join(ROOT, "inbox");
const CURSOR_DIR = path.join(ROOT, "cursors");
const TRANSPORT_DIR = path.join(ROOT, "transports");
const AGENTS_FILE = path.join(ROOT, "agents.json");
const ROOM_FILE = path.join(ROOT, "room.jsonl");
const INBOX_FILE = path.join(INBOX_DIR, `${sanitize(ID)}.jsonl`);
const CURSOR_FILE = path.join(CURSOR_DIR, `${sanitize(ID)}.json`);

mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(CURSOR_DIR, { recursive: true });

// ---------- register and start UI ----------

await register();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${ID}> `,
});

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

say(dim(`coord-chat — agentId=${ID}  dir=${ROOT}`));
say(dim("commands: <text>=room  /dm <id> <text>  /list  /help  /quit"));

await drainAndPrint();

try { watch(INBOX_FILE, () => void drainAndPrint()); } catch {}
try { watch(ROOM_FILE, () => void drainAndPrint()); } catch {}
setInterval(() => void drainAndPrint(), 1000);

rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  try {
    if (text === "/quit" || text === "/exit") {
      await unregister();
      say("bye.");
      process.exit(0);
    } else if (text === "/help") {
      say("commands: <text>=room  /dm <id> <text>  /list  /help  /quit");
    } else if (text === "/list") {
      await printAgents();
    } else if (text.startsWith("/dm ")) {
      const m = text.match(/^\/dm\s+(\S+)\s+([\s\S]+)$/);
      if (!m) say(red("usage: /dm <agentId> <text>"));
      else await sendDm(m[1], m[2]);
    } else if (text.startsWith("/")) {
      say(red(`unknown command: ${text.split(" ")[0]}`));
    } else {
      await sendRoom(text);
    }
  } catch (e) {
    say(red(`error: ${e?.message ?? e}`));
  }
  rl.prompt();
});

process.on("SIGINT", async () => {
  try { await unregister(); } catch {}
  process.stdout.write("\n");
  say("bye.");
  process.exit(0);
});

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") out.id = argv[++i];
    else if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("coord-chat — minimal TUI for agent-coord-mcp");
      console.log("usage: coord-chat [--id <name>] [--dir <path>]");
      console.log("at prompt: <text>=room  /dm <id> <text>  /list  /quit");
      process.exit(0);
    }
  }
  return out;
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Write output without clobbering whatever the user is typing.
function say(line) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(line + "\n");
  if (typeof rl !== "undefined") rl.prompt(true);
}

async function withLock(file, fn) {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try { return await fn(); } finally { await release(); }
}

async function ensureFile(file) {
  if (!existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "");
  }
}

async function register() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    const now = Date.now();
    const existing = reg[ID];
    reg[ID] = {
      agentId: ID,
      role: existing?.role ?? "human",
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
    };
    writeJsonAtomic(AGENTS_FILE, reg);
  });
}

async function unregister() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    delete reg[ID];
    writeJsonAtomic(AGENTS_FILE, reg);
  });
}

async function sendDm(to, text) {
  const target = path.join(INBOX_DIR, `${sanitize(to)}.jsonl`);
  await appendMessage(target, { from: ID, to, text });
  say(dim(`→ DM sent to ${to}`));
}

async function sendRoom(text) {
  await appendMessage(ROOM_FILE, { from: ID, text });
}

async function appendMessage(file, partial) {
  await ensureFile(file);
  const entry = { id: randomUUID(), ts: Date.now(), ...partial };
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

async function drainAndPrint() {
  const cursor = readJsonSafe(CURSOR_FILE, {});
  let changed = false;

  const inboxAll = readJsonl(INBOX_FILE);
  const inboxOff = cursor.inboxOffset ?? 0;
  for (let i = inboxOff; i < inboxAll.length; i++) {
    const m = inboxAll[i];
    if (m && m.from !== ID) printMsg("DM", m);
  }
  if (inboxAll.length > inboxOff) {
    cursor.inboxOffset = inboxAll.length;
    changed = true;
  }

  const roomAll = readJsonl(ROOM_FILE);
  const roomOff = cursor.roomOffset ?? 0;
  for (let i = roomOff; i < roomAll.length; i++) {
    const m = roomAll[i];
    if (m && m.from !== ID) printMsg("room", m);
  }
  if (roomAll.length > roomOff) {
    cursor.roomOffset = roomAll.length;
    changed = true;
  }

  if (changed) writeJsonAtomic(CURSOR_FILE, cursor);
}

function printMsg(kind, m) {
  const t = new Date(m.ts).toLocaleTimeString();
  const color = kind === "DM" ? cyan : yellow;
  say(`${color(`[${kind} ${t} ${m.from}]`)} ${m.text ?? ""}`);
}

async function printAgents() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  const ids = Object.keys(reg).sort();
  if (!ids.length) return say(dim("(no agents)"));
  for (const id of ids) {
    const a = reg[id];
    const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
    const live = marker && marker.pid && pidAlive(marker.pid);
    const status = live || now - a.lastHeartbeat < STALE ? "online " : "offline";
    const trans = live ? ` transport=${marker.transport}` : "";
    say(`  ${id.padEnd(20)} ${status}${trans}  role=${a.role ?? "-"}`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  });
}

function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
