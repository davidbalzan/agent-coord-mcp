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
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
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

// Message-rendering state + helpers. Declared up here (above the top-level
// printRecent() call) so they're initialized before first use — const/let
// don't hoist the way function declarations do.

// Consecutive messages from the same sender within this window are visually
// grouped: the second one drops its header/blank line and just continues the
// gutter, Slack-style.
const GROUP_WINDOW = 2 * 60 * 1000;
let lastBlock = { who: null, ts: 0, kind: null };

// Matches "@<this agent>" not followed by a name char, so we can flag messages
// that ping the current user. ID may contain regex metachars — escape it.
const SELF_MENTION_RE = new RegExp(
  "@" + ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9._-])",
);
const mentionsSelf = (text) => SELF_MENTION_RE.test(text ?? "");

// Recency at a glance: "now" / "5m" for fresh messages, falling back to a wall
// clock for anything over an hour (a stale "63m" reads worse than "08:34").
function relTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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
  brightGreen:   (s) => `\x1b[92m${s}\x1b[0m`,
  brightYellow:  (s) => `\x1b[93m${s}\x1b[0m`,
  brightBlue:    (s) => `\x1b[94m${s}\x1b[0m`,
  brightMagenta: (s) => `\x1b[95m${s}\x1b[0m`,
  brightCyan:    (s) => `\x1b[96m${s}\x1b[0m`,
};

// Stable per-agent color via a persistent registry shared by all coord-chat
// sessions. First time we see an agentId we pick the next unused palette
// slot — guarantees no collisions until the palette is exhausted. After that
// we fall back to hashing so behavior stays deterministic.
const AGENT_COLORS = [
  A.green, A.yellow, A.blue, A.magenta, A.cyan,
  A.brightGreen, A.brightYellow, A.brightBlue, A.brightMagenta, A.brightCyan,
];
// Will be initialized after ROOT is set, just below.

// ---------- register and start UI ----------

await register();

// Visual separator above the prompt — delimits "typing area starts here."
// Embedded in the prompt string itself so readline owns the redraw; no
// scroll-region gymnastics needed (those don't survive tmux cleanly).
const TTY = !!process.stdout.isTTY;
let COLS = process.stdout.columns || 80;
const sepLine = () => A.dim("─".repeat(Math.max(10, COLS)));

// `lastLineWasSep` tracks whether the line directly above the cursor is a
// separator that we own. When true, say() is delivering an async message —
// it should move up, overwrite the sep with the message, drop a fresh sep,
// re-prompt with preserved input. When false (e.g. just after the user
// pressed Enter), say() is printing synchronous command output — it should
// write naturally and let the post-Enter logic re-establish the input area.
let lastLineWasSep = false;

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
  "/dm", "/list", "/who", "/whoami", "/last", "/find", "/clear", "/cls",
  "/me", "/status", "/prune", "/kick", "/wipe-room",
  "/help", "/?", "/quit", "/exit",
];

const STATUS_FILE_PATH = path.join(ROOT, "status.jsonl");
const COLOR_MAP_FILE = path.join(ROOT, "chat-colors.json");

function completer(line) {
  // Tab-complete slash commands, DM targets, and @mentions mid-message.
  // On multi-match with no common-prefix advancement, surface the options
  // on the first Tab via say() — default readline UX hides them until a
  // second Tab, which most users assume means "nothing happened."
  let hits = [];
  let substr = line;

  // @mention completion takes priority — checked first because it can
  // appear inside a slash command argument (e.g. `/dm bob hey @ali`) or
  // in a plain room message.
  const mentionMatch = line.match(/@([A-Za-z0-9._-]*)$/);
  if (mentionMatch) {
    const partial = mentionMatch[1];
    const ids = onlineAgentIds().filter((id) => id !== ID && id.startsWith(partial));
    hits = ids.map((id) => `@${id} `);
    substr = mentionMatch[0]; // tell readline to replace just the @partial part
  } else if (line.startsWith("/dm ")) {
    const partial = line.slice(4);
    const ids = onlineAgentIds().filter((id) => id !== ID && id.startsWith(partial));
    hits = ids.map((id) => `/dm ${id} `);
  } else if (line.startsWith("/")) {
    hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
  }
  if (hits.length > 1 && commonPrefix(hits).length <= substr.length) {
    const display = hits.map((h) => h.trim()).join("  ");
    say(A.dim("  ┄ " + display));
  }
  return [hits, substr];
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

// Auto-offer the logged-in agents the instant "@" is typed (editor-style),
// so you don't have to press Tab to discover who's reachable. We only observe
// keypresses — readline still owns input. setImmediate lets readline insert
// the "@" into its line buffer before we inspect it.
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", (str) => {
    if (str === "@") setImmediate(showMentionPicker);
  });
}

// Banner — printed once on launch. Keep it tight; this is a CLI, not a poster.
printBanner();
// Show recent context (last 3 messages from inbox + room) then fast-forward
// the cursor so the same entries don't show up again via the watcher path.
fastForwardCursors();
await printRecent(3);

// Lay down the first separator. From this point, async incoming messages
// (via the watcher → drainAndPrint → say) know they can use the cursor
// games to slot themselves above the prompt.
process.stdout.write(sepLine() + "\n");
lastLineWasSep = true;

try { watch(INBOX_FILE, () => void drainAndPrint()); } catch {}
try { watch(ROOM_FILE, () => void drainAndPrint()); } catch {}
try { watch(AGENTS_FILE, () => refreshPrompt()); } catch {}
setInterval(() => void drainAndPrint(), 1000);
setInterval(refreshPrompt, 5000);

rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  // The user's typed-and-submitted line is now in scrollback; it is NOT a
  // separator slot we own. Sync output from commands should write naturally.
  lastLineWasSep = false;
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
      // The post-Enter sep write below re-establishes the input area.
      lastLineWasSep = false;
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
    } else if (text.startsWith("/status")) {
      const status = text.slice(7).trim();
      if (!status) say(A.red("usage: /status <text>"));
      else await postStatus(status);
    } else if (text.startsWith("/prune")) {
      const m = text.match(/^\/prune(?:\s+(\d+))?$/);
      const days = m && m[1] ? parseInt(m[1], 10) : 7;
      await pruneOld(days);
    } else if (text.startsWith("/kick ")) {
      const target = text.slice(6).trim();
      if (!target) say(A.red("usage: /kick <agentId>"));
      else await kickAgent(target);
    } else if (text === "/wipe-room") {
      await wipeRoom();
    } else if (text.startsWith("/find ")) {
      const term = text.slice(6).trim();
      if (!term) say(A.red("usage: /find <text>"));
      else await findInHistory(term);
    } else if (text.startsWith("/")) {
      say(A.red(`unknown command: ${text.split(" ")[0]}`) + A.dim("  (try /help)"));
    } else {
      await sendRoom(text);
    }
  } catch (e) {
    say(A.red(`error: ${e?.message ?? e}`));
  }
  // Re-establish the input area: separator above, prompt below. Sets
  // lastLineWasSep so any async incoming messages from here on can use the
  // cursor-game path to slot in above the prompt.
  process.stdout.write(sepLine() + "\n");
  lastLineWasSep = true;
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

function agentColor(id) {
  const map = readJsonSafe(COLOR_MAP_FILE, {});
  const existing = map[id];
  if (typeof existing === "number" && existing >= 0 && existing < AGENT_COLORS.length) {
    return AGENT_COLORS[existing];
  }
  // First sighting — pick the first unused palette slot.
  const used = new Set(Object.values(map).filter((v) => typeof v === "number"));
  let idx = -1;
  for (let i = 0; i < AGENT_COLORS.length; i++) {
    if (!used.has(i)) { idx = i; break; }
  }
  if (idx === -1) {
    // Palette exhausted — deterministic hash fallback. No persist (don't
    // pollute the map with hash assignments that could be wrong).
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AGENT_COLORS[h % AGENT_COLORS.length];
  }
  // Persist. Re-read from disk first to merge any concurrent assignments
  // by other coord-chat processes; last-writer-wins for a single agentId
  // is fine since colors are cosmetic.
  const onDisk = readJsonSafe(COLOR_MAP_FILE, {});
  onDisk[id] = idx;
  try { writeJsonAtomic(COLOR_MAP_FILE, onDisk); } catch { /* best effort */ }
  return AGENT_COLORS[idx];
}

function say(line) {
  if (lastLineWasSep) {
    // Async path: a separator we own sits directly above the prompt; we own
    // that line. Replace it with the incoming message, drop a new sep, and
    // re-render the prompt so user input is preserved.
    process.stdout.write("\x1b[1A\r\x1b[2K");
    process.stdout.write(line + "\n");
    process.stdout.write(sepLine() + "\n");
    if (typeof rl !== "undefined") rl.prompt(true);
    // lastLineWasSep stays true — there's still a sep above the prompt.
  } else {
    // Sync path: no separator above us (startup banner, post-Enter command
    // output). Just write the line at the current cursor.
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(line + "\n");
  }
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
  // Banner lines are static — no need to go through say() and its
  // sep-overwrite logic, which corrupts layout when called after /clear.
  const lines = [
    A.bold(A.cyan("  agent-coord  ")) + A.dim("— shared chat for agents and humans"),
    A.dim(`  agentId=${A.reset}${agentColor(ID)(ID)}${A.dim("  dir=" + ROOT)}`),
    A.dim("  type /help for commands · /quit to leave"),
  ];
  for (const l of lines) process.stdout.write(l + "\n");
}

function printHelp() {
  const rows = [
    ["<text>",              "post to the shared room"],
    ["/dm <agent> <text>",  "send a direct message"],
    ["/me <action>",        "post an IRC-style action (* you wave)"],
    ["/status <text>",      "post to the status broadcast channel"],
    ["/list, /who",         "show registered agents + transports"],
    ["/whoami",             "show your registration + transport"],
    ["/last [n]",           "show last n messages (default 20)"],
    ["/find <text>",        "search recent inbox + room history"],
    ["/clear",              "clear the screen"],
    [A.dim("--- admin ---"), ""],
    ["/prune [days]",       "drop messages older than N days (default 7)"],
    ["/kick <agent>",       "unregister an agent + kill their pusher"],
    ["/wipe-room",          "truncate the shared room (destructive)"],
    [A.dim("---"),          ""],
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

function fastForwardCursors() {
  // Move our cursor offsets to end-of-file so anything that existed before
  // launch is treated as already-seen. printRecent(N) then shows the last N
  // as historical context, and the watcher path only fires for genuinely
  // new messages going forward.
  const cur = readJsonSafe(CURSOR_FILE, {});
  cur.inboxOffset = readJsonl(INBOX_FILE).length;
  cur.roomOffset = readJsonl(ROOM_FILE).length;
  writeJsonAtomic(CURSOR_FILE, cur);
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

async function postStatus(status) {
  await ensureFile(STATUS_FILE_PATH);
  const entry = { id: randomUUID(), ts: Date.now(), agentId: ID, status };
  appendFileSync(STATUS_FILE_PATH, JSON.stringify(entry) + "\n");
  say(A.dim(`→ status posted: ${status}`));
}

async function pruneOld(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let total = 0;
  // Per-file removal counts so we can shift the corresponding cursor
  // offsets — without this, every other agent's roomOffset/statusOffset/
  // inboxOffset would point past the now-shorter file and they'd silently
  // miss messages until enough new ones piled up to overtake the stale offset.
  let roomRemoved = 0;
  let statusRemoved = 0;
  const inboxRemoved = {}; // agentId → count

  const files = [
    { path: ROOM_FILE, kind: "room" },
    { path: STATUS_FILE_PATH, kind: "status" },
  ];
  if (existsSync(INBOX_DIR)) {
    for (const n of readdirSync(INBOX_DIR)) {
      if (n.endsWith(".jsonl")) {
        files.push({ path: path.join(INBOX_DIR, n), kind: "inbox", agentId: n.replace(/\.jsonl$/, "") });
      }
    }
  }
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    const all = readJsonl(f.path);
    const kept = all.filter((e) => e && e.ts > cutoff);
    const removed = all.length - kept.length;
    if (removed > 0) {
      const body = kept.length ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
      writeFileSync(f.path, body);
      total += removed;
      if (f.kind === "room") roomRemoved += removed;
      else if (f.kind === "status") statusRemoved += removed;
      else inboxRemoved[f.agentId] = (inboxRemoved[f.agentId] ?? 0) + removed;
    }
  }
  if (roomRemoved || statusRemoved || Object.keys(inboxRemoved).length) {
    shiftAllCursors({ roomRemoved, statusRemoved, inboxRemoved });
  }
  say(A.dim(`→ pruned ${total} entries older than ${days}d (cursors adjusted)`));
}

async function wipeRoom() {
  await ensureFile(ROOM_FILE);
  writeFileSync(ROOM_FILE, "");
  // Reset every agent's roomOffset to 0 so they start reading the (now empty)
  // file from the beginning. Otherwise their stale offsets point past EOF.
  resetAllRoomOffsets();
  say(A.dim("→ room wiped (all room cursors reset)"));
}

// Walk every cursor file and shift offsets down by the per-channel removed
// counts. Mirrors what the MCP prune tool does server-side.
function shiftAllCursors({ roomRemoved = 0, statusRemoved = 0, inboxRemoved = {} }) {
  if (!existsSync(CURSOR_DIR)) return;
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    const id = name.replace(/\.json$/, "");
    let touched = false;
    if (cur.roomOffset !== undefined && roomRemoved > 0) {
      cur.roomOffset = Math.max(0, cur.roomOffset - roomRemoved);
      touched = true;
    }
    if (cur.statusOffset !== undefined && statusRemoved > 0) {
      cur.statusOffset = Math.max(0, cur.statusOffset - statusRemoved);
      touched = true;
    }
    const myInbox = inboxRemoved[id] ?? 0;
    if (cur.inboxOffset !== undefined && myInbox > 0) {
      cur.inboxOffset = Math.max(0, cur.inboxOffset - myInbox);
      touched = true;
    }
    if (touched) writeJsonAtomic(cursorPath, cur);
  }
}

function resetAllRoomOffsets() {
  if (!existsSync(CURSOR_DIR)) return;
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    if (cur.roomOffset !== undefined && cur.roomOffset !== 0) {
      cur.roomOffset = 0;
      writeJsonAtomic(cursorPath, cur);
    }
  }
}

async function kickAgent(target) {
  let existed = false;
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[target]) {
      existed = true;
      delete reg[target];
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  if (!existed) {
    say(A.red(`agent '${target}' not registered`));
    return;
  }
  // Best-effort: kill their pusher and remove the transport marker so they
  // disappear immediately from list_agents instead of hanging around with a
  // live transport pointer.
  const markerPath = path.join(TRANSPORT_DIR, `${sanitize(target)}.json`);
  const marker = readJsonSafe(markerPath, null);
  if (marker?.pid) {
    try { process.kill(marker.pid, "SIGTERM"); } catch {}
  }
  try { if (existsSync(markerPath)) unlinkSync(markerPath); } catch {}
  // Remove the kicked agent's inbox + cursor so they don't sit orphaned in
  // ~/agent-coord/ taking up listing space and confusing future bookkeeping.
  const inboxPath = path.join(INBOX_DIR, `${sanitize(target)}.jsonl`);
  const cursorPath = path.join(CURSOR_DIR, `${sanitize(target)}.json`);
  try { if (existsSync(inboxPath)) unlinkSync(inboxPath); } catch {}
  try { if (existsSync(cursorPath)) unlinkSync(cursorPath); } catch {}
  say(A.dim(`→ kicked ${target} (registry, transport, inbox, cursor all cleared)`));
}

async function findInHistory(term) {
  const t = term.toLowerCase();
  const inbox = readJsonl(INBOX_FILE).map((m) => ({ ...m, _kind: "DM" }));
  const room = readJsonl(ROOM_FILE).map((m) => ({ ...m, _kind: "room" }));
  const matches = [...inbox, ...room]
    .filter((m) => (m.text ?? "").toLowerCase().includes(t))
    .sort((a, b) => a.ts - b.ts);
  if (!matches.length) return say(A.dim(`(no matches for "${term}")`));
  say(A.bold(`${matches.length} match(es) for "${term}":`));
  for (const m of matches.slice(-20)) printMsg(m._kind, m, { history: true });
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
  const who = m.from ?? "?";
  const color = agentColor(who);
  const gutter = color("▎");
  const prefix = opts.history ? A.dim("  ") : "";

  // Body wraps manually under a continuous gutter — terminal auto-wrap would
  // lose the colored gutter on continuation lines.
  const prefixW = visibleLength(prefix);
  const bodyWidth = Math.max(20, COLS - prefixW - visibleLength(`▎ `));
  const text = (m.text ?? "").split("\n").map(formatBody).join("\n");
  const lines = wrapBody(text, bodyWidth);

  // Group onto the previous block when it's the same live sender within the
  // window — skip the blank line + header, just keep the gutter going.
  const grouped = !opts.history
    && lastBlock.who === who && lastBlock.kind === kind
    && (m.ts - lastBlock.ts) < GROUP_WINDOW;

  if (!grouped) {
    // Header on its own line so the sender is a scannable anchor and the body
    // always starts at a fixed column. "room" is the default and stays
    // implied; only DMs get a badge. A ping to the current user brightens the
    // gutter and adds a ► marker so it pops out of the firehose.
    const pinged = mentionsSelf(m.text);
    const badge = kind === "DM" ? A.bold(A.cyan("DM ")) : "";
    const marker = pinged ? A.bold(A.yellow("► ")) : "";
    const headGutter = pinged ? A.bold(color("▌")) : gutter;
    const header = `${marker}${badge}${A.bold(color(who))} ${A.dim(`· ${relTime(m.ts)}`)}`;
    say("");
    say(`${prefix}${headGutter} ${header}`);
  }
  for (const line of lines) say(`${prefix}${gutter} ${line}`);

  if (!opts.history) lastBlock = { who, ts: m.ts, kind };
}

function visibleLength(s) {
  // Strip ANSI SGR sequences so we measure on-screen width, not raw bytes.
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Wrap one message's text, preserving list/indent structure: a leading bullet
// ("- ", "* ", "1. ", "2) ") or whitespace indent is detected so wrapped
// continuation lines hang-indent under the text rather than re-flowing as flat
// prose.
function wrapBody(text, width) {
  if (width <= 0) return [text];
  const out = [];
  for (const raw of text.split("\n")) {
    const mk = raw.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+)?)([\s\S]*)$/);
    const lead = mk ? mk[1] : "";
    const body = mk ? mk[2] : raw;
    const indent = " ".repeat(visibleLength(lead));
    const words = body.length ? body.split(/\s+/) : [];
    if (!words.length) { out.push(lead.trimEnd()); continue; }
    let line = lead + words[0];
    for (let i = 1; i < words.length; i++) {
      const proposed = line + " " + words[i];
      if (visibleLength(proposed) > width) {
        out.push(line);
        line = indent + words[i];
      } else {
        line = proposed;
      }
    }
    out.push(line);
  }
  return out;
}

// Lightweight inline-only "chat markdown" formatter — no dep. Handles bold,
// italic, inline code, links, and @mentions. Order matters: pull out inline
// code spans first so we don't touch their contents, then run the rest.
function formatBody(text) {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return A.dim("`") + A.cyan(part.slice(1, -1)) + A.dim("`");
    }
    let s = part;
    // @mentions first — colored in the mentioned agent's hash color, bold if
    // it's the current user (so you can spot pings at a glance).
    s = s.replace(/@([A-Za-z0-9._-]+)/g, (_, name) => {
      const colored = agentColor(name)(`@${name}`);
      return name === ID ? A.bold(colored) : colored;
    });
    // **bold**
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => A.bold(t));
    // *italic* and _italic_ (avoid matching inside **bold** by requiring
    // non-asterisk neighbors)
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, (_, t) => `\x1b[3m${t}\x1b[0m`);
    s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_, t) => `\x1b[3m${t}\x1b[0m`);
    // [text](url) — show text underlined with a dim, shortened trailing (url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) =>
      `\x1b[4m${t}\x1b[0m${A.dim(` (${shortenUrl(u)})`)}`,
    );
    // Bare URLs — underline only the URL itself, shortened if long
    s = s.replace(/\bhttps?:\/\/[^\s)]+/g, (u) => `\x1b[4m${shortenUrl(u)}\x1b[0m`);
    return s;
  }).join("");
}

// Long URLs eat a whole wrapped line. Collapse to "host/…/last-segment" so the
// link stays recognizable without dominating the message. Short URLs are left
// intact (and remain copy-pasteable).
function shortenUrl(u) {
  if (u.length <= 48) return u;
  try {
    const { host, pathname } = new URL(u);
    const tail = pathname.split("/").filter(Boolean).pop() ?? "";
    const short = tail ? `${host}/…/${tail}` : host;
    return short.length < u.length ? short : u.slice(0, 45) + "…";
  } catch {
    return u.slice(0, 45) + "…";
  }
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

// Agents considered "logged in": a live transport process, or a heartbeat
// within the stale window. Shared by the @mention picker and completer so we
// only ever offer reachable agents.
function onlineAgentIds() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  return Object.keys(reg)
    .filter((id) => {
      const a = reg[id];
      const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
      const live = marker && marker.pid && pidAlive(marker.pid);
      return live || now - (a?.lastHeartbeat ?? 0) < STALE;
    })
    .sort();
}

// Pop the list of logged-in agents the moment "@" starts a mention token, so
// you can see who's reachable without hunting through /list. The list is
// dim/cosmetic and re-renders above the preserved input line.
function showMentionPicker() {
  if (typeof rl === "undefined") return;
  const before = (rl.line ?? "").slice(0, rl.cursor ?? (rl.line ?? "").length);
  // Only when the just-typed "@" opens a fresh token (start of line or after
  // whitespace) — avoids firing inside emails or mid-word.
  if (!/(^|\s)@$/.test(before)) return;
  const ids = onlineAgentIds().filter((id) => id !== ID);
  if (!ids.length) return;
  const list = ids.map((id) => A.green("●") + agentColor(id)(`@${id}`)).join("  ");
  say(A.dim("  ┄ ") + list + A.dim("   · Tab to complete"));
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
