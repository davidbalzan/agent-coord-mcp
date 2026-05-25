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

// ---------- ANSI helpers ----------

const A = {
  reset: "\x1b[0m",
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// Stable per-agent color from agentId hash. Skip red (reserved for errors)
// and white/black; cycle the remaining 5 bright colors.
const AGENT_COLORS = [A.green, A.yellow, A.blue, A.magenta, A.cyan];
function agentColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

// ---------- register and start UI ----------

await register();

// Visual separator above the prompt — delimits "typing area starts here."
// Embedded in the prompt string itself so readline owns the redraw; no
// scroll-region gymnastics needed (those don't survive tmux cleanly).
const TTY = !!process.stdout.isTTY;
let COLS = process.stdout.columns || 80;
const sepLine = () => A.dim("─".repeat(Math.max(10, COLS)));

// inputAreaReady flips to true after the banner + initial drain finish and
// we lay down the first separator. From that point say() treats the line
// above the prompt as a separator slot it owns.
let inputAreaReady = false;

if (TTY) {
  process.stdout.on("resize", () => {
    COLS = process.stdout.columns || 80;
    if (typeof rl !== "undefined") {
      rl.setPrompt(makePrompt());
      rl.prompt(true);
    }
  });
}

const SLASH_COMMANDS = [
  "/dm", "/list", "/who", "/whoami", "/last", "/clear", "/cls",
  "/me", "/help", "/?", "/quit", "/exit",
];

function completer(line) {
  // Tab-complete slash commands and DM targets. On multi-match with no
  // common-prefix advancement, surface the options on the first Tab via
  // say() — default readline UX hides them until a second Tab, which most
  // users assume means "nothing happened."
  let hits = [];
  if (line.startsWith("/dm ")) {
    const partial = line.slice(4);
    const reg = readJsonSafe(AGENTS_FILE, {});
    const ids = Object.keys(reg).filter((id) => id !== ID && id.startsWith(partial));
    hits = ids.map((id) => `/dm ${id} `);
  } else if (line.startsWith("/")) {
    hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
  }
  if (hits.length > 1 && commonPrefix(hits).length <= line.length) {
    const display = hits.map((h) => h.trim()).join("  ");
    say(A.dim("  ┄ " + display));
  }
  return [hits, line];
}

function commonPrefix(strs) {
  if (strs.length === 0) return "";
  let p = strs[0];
  for (const s of strs.slice(1)) {
    while (s.indexOf(p) !== 0) p = p.slice(0, -1);
  }
  return p;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: makePrompt(),
  completer,
});

// Banner — printed once on launch. Keep it tight; this is a CLI, not a poster.
printBanner();
await drainAndPrint();

// Lay down the first separator, then activate input-area mode so subsequent
// say() calls maintain a sep line directly above the prompt.
process.stdout.write(sepLine() + "\n");
inputAreaReady = true;

try { watch(INBOX_FILE, () => void drainAndPrint()); } catch {}
try { watch(ROOM_FILE, () => void drainAndPrint()); } catch {}
try { watch(AGENTS_FILE, () => refreshPrompt()); } catch {}
setInterval(() => void drainAndPrint(), 1000);
setInterval(refreshPrompt, 5000);

rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  try {
    if (text === "/quit" || text === "/exit") {
      await unregister();
      teardownFooter();
      process.stdout.write(A.dim("bye.\n"));
      process.exit(0);
    } else if (text === "/help" || text === "/?") {
      printHelp();
    } else if (text === "/list" || text === "/who") {
      await printAgents();
    } else if (text === "/whoami") {
      await printWhoami();
    } else if (text === "/clear" || text === "/cls") {
      process.stdout.write("\x1b[2J\x1b[H");
      printBanner();
    } else if (text.startsWith("/last")) {
      const m = text.match(/^\/last(?:\s+(\d+))?$/);
      const n = m && m[1] ? parseInt(m[1], 10) : 20;
      await printRecent(n);
    } else if (text.startsWith("/me ")) {
      const action = text.slice(4).trim();
      if (!action) say(A.red("usage: /me <action>"));
      else await sendRoom(`* ${ID} ${action}`);
    } else if (text.startsWith("/dm ")) {
      const m = text.match(/^\/dm\s+(\S+)\s+([\s\S]+)$/);
      if (!m) say(A.red("usage: /dm <agentId> <text>"));
      else await sendDm(m[1], m[2]);
    } else if (text.startsWith("/")) {
      say(A.red(`unknown command: ${text.split(" ")[0]}`) + A.dim("  (try /help)"));
    } else {
      await sendRoom(text);
    }
  } catch (e) {
    say(A.red(`error: ${e?.message ?? e}`));
  }
  // After Enter, terminal advanced to a new line. Print a fresh separator
  // there so the next prompt sits below a sep line, maintaining the layout.
  process.stdout.write(sepLine() + "\n");
  rl.prompt();
});

process.on("SIGINT", async () => {
  try { await unregister(); } catch {}
  teardownFooter();
  process.stdout.write("\n" + A.dim("bye.\n"));
  process.exit(0);
});

process.on("exit", () => {
  // Final safety net — restore terminal state if we exit via any path.
  teardownFooter();
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

function say(line) {
  if (!inputAreaReady) {
    process.stdout.write(line + "\n");
    return;
  }
  // We're on the prompt line. The line above is the current separator.
  // Move up to it, clear it, drop our message there, then a fresh separator,
  // then re-render the prompt on the next line.
  process.stdout.write("\x1b[1A\r\x1b[2K");
  process.stdout.write(line + "\n");
  process.stdout.write(sepLine() + "\n");
  if (typeof rl !== "undefined") rl.prompt(true);
}

function makePrompt() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  let online = 0;
  for (const id of Object.keys(reg)) {
    if (id === ID) continue;
    const a = reg[id];
    const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
    const live = marker && marker.pid && pidAlive(marker.pid);
    if (live || now - a.lastHeartbeat < STALE) online++;
  }
  const peers = online === 1 ? "1 peer" : `${online} peers`;
  return `${agentColor(ID)(ID)} ${A.dim(`(${peers})`)}${A.dim(">")} `;
}

// No-op stubs kept so the exit paths don't reference deleted functions.
function teardownFooter() {}

function refreshPrompt() {
  if (typeof rl === "undefined") return;
  rl.setPrompt(makePrompt());
  rl.prompt(true);
}

function printBanner() {
  // Compact banner — three lines plus a separator matching the input-area
  // separator width so they look like the same UI element, not two.
  const lines = [
    A.bold(A.cyan("  agent-coord  ")) + A.dim("— shared chat for agents and humans"),
    A.dim(`  agentId=${A.reset}${agentColor(ID)(ID)}${A.dim("  dir=" + ROOT)}`),
    A.dim("  type /help for commands · /quit to leave"),
  ];
  for (const l of lines) say(l);
}

function printHelp() {
  const rows = [
    ["<text>",              "post to the shared room"],
    ["/dm <agent> <text>",  "send a direct message"],
    ["/me <action>",        "post an IRC-style action (* you wave)"],
    ["/list, /who",         "show registered agents + transports"],
    ["/whoami",             "show your registration + transport"],
    ["/last [n]",           "show last n messages (default 20)"],
    ["/clear",              "clear the screen"],
    ["/help, /?",           "this list"],
    ["/quit, /exit",        "unregister and leave"],
  ];
  say(A.bold("commands:"));
  for (const [cmd, desc] of rows) {
    say(`  ${A.cyan(cmd.padEnd(22))} ${A.dim(desc)}`);
  }
}

async function printWhoami() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const a = reg[ID];
  const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(ID)}.json`), null);
  const live = marker && marker.pid && pidAlive(marker.pid);
  say(A.bold("you:"));
  say(`  ${A.cyan("id")}        ${agentColor(ID)(ID)}`);
  say(`  ${A.cyan("role")}      ${a?.role ?? "-"}`);
  say(`  ${A.cyan("dir")}       ${A.dim(ROOT)}`);
  say(`  ${A.cyan("transport")} ${live ? A.green(marker.transport) : A.dim("none")}`);
  say(`  ${A.cyan("registered")} ${a ? A.green("yes") : A.red("no")}`);
}

async function printRecent(n) {
  const inbox = readJsonl(INBOX_FILE).slice(-n).map((m) => ({ ...m, _kind: "DM" }));
  const room = readJsonl(ROOM_FILE).slice(-n).map((m) => ({ ...m, _kind: "room" }));
  const all = [...inbox, ...room].sort((a, b) => a.ts - b.ts).slice(-n);
  if (!all.length) return say(A.dim("(no history)"));
  say(A.bold(`last ${all.length} message(s):`));
  for (const m of all) printMsg(m._kind, m, { history: true });
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
  say(A.dim(`→ DM sent to ${to}`));
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

function printMsg(kind, m, opts = {}) {
  const d = new Date(m.ts);
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const who = m.from ?? "?";
  const tag = kind === "DM" ? A.bold(A.cyan("DM")) : A.dim("room");
  const meta = `${A.dim(t)} ${tag} ${agentColor(who)(who)}`;
  // Multi-line bodies: first line on the meta row, subsequent lines indented
  // to the body column for readability.
  const body = (m.text ?? "").split("\n");
  const indent = "       ";
  const first = body[0] ?? "";
  const rest = body.slice(1).map((l) => indent + A.dim("│ ") + l);
  const prefix = opts.history ? A.dim("  ") : "";
  say(`${prefix}${meta} ${first}`);
  for (const line of rest) say(`${prefix}${line}`);
}

async function printAgents() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  const ids = Object.keys(reg).sort();
  if (!ids.length) return say(A.dim("(no agents)"));
  // Compute column widths from data so things line up.
  const idW = Math.max(8, ...ids.map((i) => i.length));
  const roleW = Math.max(4, ...ids.map((i) => (reg[i].role ?? "-").length));
  say(A.bold(`agents (${ids.length}):`));
  say(
    "  " +
      A.dim(
        `${"id".padEnd(idW)}  ${"status".padEnd(7)}  ${"role".padEnd(roleW)}  transport`,
      ),
  );
  for (const id of ids) {
    const a = reg[id];
    const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
    const live = marker && marker.pid && pidAlive(marker.pid);
    const onlineNow = live || now - a.lastHeartbeat < STALE;
    const dot = onlineNow ? A.green("●") : A.dim("○");
    const status = onlineNow ? "online " : "offline";
    const role = (a.role ?? "-").padEnd(roleW);
    const trans = live ? A.green(marker.transport) : A.dim("none");
    const me = id === ID ? A.dim(" (you)") : "";
    say(`  ${dot} ${agentColor(id)(id.padEnd(idW))}  ${A.dim(status)}  ${role}  ${trans}${me}`);
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
