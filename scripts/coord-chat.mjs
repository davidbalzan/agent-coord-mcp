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
let ID = args.id ?? process.env.USER ?? "human"; // reassignable so /nick can rebind it
const ROOT = args.dir ?? process.env.AGENT_COORD_DIR ?? path.join(homedir(), "agent-coord");
// Pin the env so a dynamically-imported dist tool (e.g. /doctor's doctorTool)
// binds store.js's ROOT to the same dir when --dir overrode the default.
process.env.AGENT_COORD_DIR = ROOT;

// Message-rendering state + helpers. Declared up here (above the top-level
// printRecent() call) so they're initialized before first use — const/let
// don't hoist the way function declarations do.

// Consecutive messages from the same sender within this window are visually
// grouped: the second one drops its header/blank line and just continues the
// gutter, Slack-style.
const GROUP_WINDOW = 2 * 60 * 1000;
let lastBlock = { who: null, ts: 0, kind: null };

// Whether the ephemeral suggestion hint is currently occupying the slot above
// the prompt (see drawHint/clearHint). Declared early so say(), called during
// startup replay, can reference it without tripping the const/let TDZ.
let hintActive = false;

// Matches "@<this agent>" not followed by a name char, so we can flag messages
// that ping the current user. ID may contain regex metachars — escape it.
let SELF_MENTION_RE = new RegExp(
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
const ROOMS_DIR = path.join(ROOT, "rooms");
const ROOMS_FILE = path.join(ROOT, "rooms.json");
let INBOX_FILE = path.join(INBOX_DIR, `${sanitize(ID)}.jsonl`);
let CURSOR_FILE = path.join(CURSOR_DIR, `${sanitize(ID)}.json`);

mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(CURSOR_DIR, { recursive: true });
mkdirSync(ROOMS_DIR, { recursive: true });

// ---------- channels ----------
// Mirrors src/store.ts: `general` keeps using room.jsonl + the flat roomOffset
// cursor key (hook/back-compat); other channels live in rooms/<chan>.jsonl with
// their offset under cursor.roomOffsets[chan]. currentRoom is the focused
// channel that plain text posts to; we tail every channel we've joined.
const DEFAULT_ROOM = "general";
let currentRoom = DEFAULT_ROOM;
const ignored = new Set(); // session-local /ignore — agentIds whose msgs we hide

function normalizeRoom(name) {
  if (!name) return DEFAULT_ROOM;
  const n = String(name).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

function roomFile(chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? ROOM_FILE : path.join(ROOMS_DIR, `${sanitize(c)}.jsonl`);
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

function getRooms() {
  const reg = readJsonSafe(ROOMS_FILE, {});
  if (!reg[DEFAULT_ROOM]) reg[DEFAULT_ROOM] = { createdAt: 0, createdBy: "system", members: [] };
  return reg;
}

// Channels this agent has joined (always includes the default channel).
function joinedRooms() {
  const reg = getRooms();
  const out = new Set([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e.members?.includes(ID)) out.add(chan);
  }
  return [...out];
}

async function updateRooms(mutate) {
  await withLock(ROOMS_FILE, async () => {
    const reg = readJsonSafe(ROOMS_FILE, {});
    mutate(reg);
    writeJsonAtomic(ROOMS_FILE, reg);
  });
}

const watchedRooms = new Set();
function watchRoom(chan) {
  const f = roomFile(chan);
  if (watchedRooms.has(f)) return;
  try {
    watch(f, () => void drainAndPrint());
    watchedRooms.add(f);
  } catch {
    // file may not exist yet; the 1s interval drain covers it until it does
  }
}

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

// ---------- non-interactive --doctor ----------
// `coord-chat --doctor [--fix]` runs the same health check as the MCP doctor
// tool and prints its report, then exits — no registration, no TUI. Same
// renderer as the /doctor slash command, so CLI and in-chat output match.
if (args.doctor) {
  const ok = await runDoctor(!!args.fix, (l) => process.stdout.write(l + "\n"));
  process.exit(ok ? 0 : 1);
}

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
  "/dm", "/msg", "/list", "/who", "/whoami", "/whois", "/last", "/find",
  "/clear", "/cls", "/me", "/status", "/away", "/back", "/ignore", "/unignore",
  "/nick", "/join", "/part", "/leave", "/rooms", "/channels", "/topic", "/motd",
  "/rules", "/prune", "/kick", "/wipe-room", "/doctor",
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
  } else if (/^\/whois\s/.test(line)) {
    const partial = line.replace(/^\/whois\s+/, "");
    hits = onlineAgentIds().filter((id) => id.startsWith(partial)).map((id) => `/whois ${id} `);
  } else {
    // Channel-name completion for the channel-taking commands.
    const cm = line.match(/^\/(join|part|leave|msg)\s+#?(\S*)$/);
    if (cm) {
      const cmd = cm[1];
      const partial = cm[2];
      const chans = Object.keys(getRooms()).filter((c) => c.startsWith(partial));
      hits = chans.map((c) => `/${cmd} #${c} `);
    } else if (line.startsWith("/")) {
      hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    }
  }
  if (hits.length > 1) {
    // Show the options as an ephemeral hint and hand readline only the common
    // prefix — a single-element completion means its native multi-column dump
    // never lands in scrollback. Tab still advances to the shared prefix.
    const display = hits.map((h) => h.trim()).join("  ");
    drawHint(A.dim("  ┄ " + display));
    const cp = commonPrefix(hits);
    return [[cp.length >= substr.length ? cp : substr], substr];
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
  process.stdin.on("keypress", (str, key) => {
    // setImmediate lets readline mutate its line buffer first, then we inspect
    // it / redraw the slot above the prompt.
    if (str === "@") { setImmediate(showMentionPicker); return; }
    // Tab is the completer's — it draws/keeps the hint itself. Every other key
    // dismisses a showing hint so the view snaps back to a clean separator.
    if (key && key.name === "tab") return;
    if (hintActive) setImmediate(clearHint);
  });
}

// Banner — printed once on launch. Keep it tight; this is a CLI, not a poster.
printBanner();
// Show recent context (last 3 messages from inbox + room) then fast-forward
// the cursor so the same entries don't show up again via the watcher path.
fastForwardCursors();
await printRecent(3);

// Surface the focused channel's topic + MOTD (room rules) on launch — same
// banner /join shows — so the rules are seen on connect, not just on switch.
// Skip the bare header when neither is set, to avoid noise.
{
  const e = getRooms()[normalizeRoom(currentRoom)];
  if (e?.topic || e?.motd) showRoomBanner(currentRoom);
}

// Lay down the first separator. From this point, async incoming messages
// (via the watcher → drainAndPrint → say) know they can use the cursor
// games to slot themselves above the prompt.
process.stdout.write(sepLine() + "\n");
lastLineWasSep = true;

try { watch(INBOX_FILE, () => void drainAndPrint()); } catch {}
for (const chan of joinedRooms()) watchRoom(chan);
try { watch(AGENTS_FILE, () => refreshPrompt()); } catch {}
const drainTimer = setInterval(() => void drainAndPrint(), 1000);
const promptTimer = setInterval(refreshPrompt, 5000);

// Single teardown path: stop the poll timers and release the terminal so we
// exit cleanly no matter which route we leave by (/quit, SIGINT, EOF).
let toreDown = false;
function shutdown() {
  if (toreDown) return;
  toreDown = true;
  clearInterval(drainTimer);
  clearInterval(promptTimer);
  teardownFooter();
  try { rl.close(); } catch {}
}

rl.prompt();

// Serialize line handling: readline fires 'line' events back-to-back for
// pasted/piped input, and our handlers are async (channel switches, file RMW).
// Chaining them guarantees e.g. "/join #x" fully completes — currentRoom set —
// before the next line posts, so a message can't leak into the old channel.
let lineChain = Promise.resolve();
rl.on("line", (line) => {
  lineChain = lineChain.then(() => handleLine(line)).catch(() => {});
});

async function handleLine(line) {
  const text = line.trim();
  if (!text) return rl.prompt();
  // The user's typed-and-submitted line is now in scrollback; it is NOT a
  // separator slot we own. Sync output from commands should write naturally.
  lastLineWasSep = false;
  try {
    if (text === "/quit" || text === "/exit" || text.startsWith("/quit ") || text.startsWith("/exit ")) {
      const msg = text.replace(/^\/(quit|exit)\s*/, "").trim();
      for (const chan of joinedRooms()) await sendSystem(chan, msg ? `has quit (${msg})` : "has quit");
      await unregister();
      shutdown();
      process.stdout.write(A.dim("bye.\n"));
      process.exit(0);
    } else if (text === "/help" || text === "/?") {
      printHelp();
    } else if (text === "/list" || text === "/who") {
      await printAgents();
    } else if (text === "/rooms" || text === "/channels") {
      listRooms();
    } else if (text.startsWith("/join ") || text === "/join") {
      const chan = text.slice(5).trim();
      if (!chan) say(A.red("usage: /join <#channel>"));
      else await joinRoom(chan);
    } else if (text === "/part" || text.startsWith("/part ") || text === "/leave" || text.startsWith("/leave ")) {
      await partRoom(text.replace(/^\/(part|leave)\s*/, "").trim());
    } else if (text === "/topic" || text.startsWith("/topic ")) {
      await setTopic(text.slice(6).trim());
    } else if (text === "/motd" || text.startsWith("/motd ") || text === "/rules" || text.startsWith("/rules ")) {
      await setMotd(text.replace(/^\/(motd|rules)\s*/, "").trim());
    } else if (text.startsWith("/msg ")) {
      const m = text.match(/^\/msg\s+(\S+)\s+([\s\S]+)$/);
      if (!m) say(A.red("usage: /msg <#channel> <text>"));
      else { await sendRoom(m[2], m[1]); say(A.dim(`→ sent to #${normalizeRoom(m[1])}`)); }
    } else if (text.startsWith("/whois ")) {
      const target = text.slice(7).trim();
      if (!target) say(A.red("usage: /whois <agent>"));
      else whois(target);
    } else if (text === "/away" || text.startsWith("/away ")) {
      await setAway(text.slice(5).trim());
    } else if (text === "/back") {
      await setBack();
    } else if (text.startsWith("/ignore")) {
      ignoreAgent(text.slice(7).trim());
    } else if (text.startsWith("/unignore")) {
      unignoreAgent(text.slice(9).trim());
    } else if (text === "/nick" || text.startsWith("/nick ")) {
      await nick(text.slice(5).trim());
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
    } else if (text === "/doctor" || text.startsWith("/doctor ")) {
      const fix = text.slice(7).trim() === "--fix";
      await runDoctor(fix, say);
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
}

process.on("SIGINT", async () => {
  try { await unregister(); } catch {}
  shutdown();
  process.stdout.write("\n" + A.dim("bye.\n"));
  process.exit(0);
});

process.on("exit", () => {
  // Final safety net — restore terminal state if we exit via any path.
  shutdown();
});

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") out.id = argv[++i];
    else if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--doctor") out.doctor = true;
    else if (argv[i] === "--fix") out.fix = true;
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("coord-chat — minimal TUI for agent-coord-mcp");
      console.log("usage: coord-chat [--id <name>] [--dir <path>]");
      console.log("       coord-chat --doctor [--fix]   health-check coord state, print report, exit");
      console.log("at prompt: <text>=room  /dm <id> <text>  /list  /doctor  /quit");
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

// Ephemeral suggestion line (the @mention / completion picker). It borrows the
// separator slot directly above the prompt: drawn there, then wiped back to a
// real separator on the next keystroke — so it never piles up in scrollback.
function drawHint(content) {
  if (typeof rl === "undefined" || !lastLineWasSep) return;
  process.stdout.write("\x1b[1A\r\x1b[2K");  // up to the slot, clear it
  process.stdout.write(content + "\n");       // draw the hint in place of the sep
  rl.prompt(true);                            // redraw prompt + preserved input
  hintActive = true;
}

function clearHint() {
  if (typeof rl === "undefined" || !lastLineWasSep) { hintActive = false; return; }
  if (!hintActive) return;
  process.stdout.write("\x1b[1A\r\x1b[2K");  // up to the hint slot, clear it
  process.stdout.write(sepLine() + "\n");     // restore the separator
  rl.prompt(true);
  hintActive = false;
}

function say(line) {
  hintActive = false; // any real output reclaims the slot the hint borrowed
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
  const chan = A.dim("#") + normalizeRoom(currentRoom);
  return `${agentColor(ID)(ID)} ${agentColor(currentRoom)(chan)} ${A.dim(`(${peers})`)}${A.dim(">")} `;
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
    ["<text>",              "post to the current channel"],
    ["/dm <agent> <text>",  "send a direct message"],
    ["/msg <#chan> <text>", "post to a channel without switching to it"],
    ["/me <action>",        "post an IRC-style action (* you wave)"],
    ["/status <text>",      "post to the status broadcast channel"],
    [A.dim("--- channels ---"), ""],
    ["/join <#chan>",       "join (and switch to) a channel, creating it if new"],
    ["/part [#chan]",       "leave the current (or named) channel"],
    ["/rooms",              "list all channels (topic + members)"],
    ["/topic [text]",       "show or set the current channel's topic"],
    ["/motd [text]",        "show or set the channel rules (MOTD)"],
    [A.dim("--- people ---"), ""],
    ["/list, /who",         "show registered agents + transports"],
    ["/whois <agent>",      "show an agent's detail (role, channels, status)"],
    ["/whoami",             "show your registration + transport"],
    ["/nick <name>",        "rename yourself (migrates inbox/history)"],
    ["/away [msg], /back",  "set or clear your away status"],
    ["/ignore <agent>",     "mute an agent for this session (/unignore to undo)"],
    [A.dim("--- history ---"), ""],
    ["/last [n]",           "show last n messages (default 20)"],
    ["/find <text>",        "search recent inbox + channel history"],
    ["/clear",              "clear the screen"],
    [A.dim("--- admin ---"), ""],
    ["/prune [days]",       "drop messages older than N days (default 7)"],
    ["/kick <agent>",       "unregister an agent + kill their pusher"],
    ["/wipe-room",          "truncate the current channel (destructive)"],
    ["/doctor [--fix]",     "health-check coord state (--fix auto-remediates)"],
    [A.dim("---"),          ""],
    ["/help, /?",           "this list"],
    ["/quit [msg], /exit",  "unregister and leave"],
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
  for (const chan of joinedRooms()) setRoomOffset(cur, chan, readJsonl(roomFile(chan)).length);
  writeJsonAtomic(CURSOR_FILE, cur);
}

async function printRecent(n) {
  const inbox = readJsonl(INBOX_FILE).slice(-n).map((m) => ({ ...m, _kind: "DM" }));
  let rooms = [];
  for (const chan of joinedRooms()) {
    rooms = rooms.concat(
      readJsonl(roomFile(chan)).slice(-n).map((m) => ({ ...m, _kind: "room", room: m.room ?? chan })),
    );
  }
  const all = [...inbox, ...rooms].sort((a, b) => a.ts - b.ts).slice(-n);
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
      away: existing?.away,
    };
    writeJsonAtomic(AGENTS_FILE, reg);
  });
  // Record default-channel membership so /rooms + the hooks see us there.
  await updateRooms((reg) => {
    const e = (reg[DEFAULT_ROOM] ??= { createdAt: 0, createdBy: "system", members: [] });
    if (!e.members.includes(ID)) e.members.push(ID);
  });
}

async function unregister() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    delete reg[ID];
    writeJsonAtomic(AGENTS_FILE, reg);
  });
  await updateRooms((reg) => {
    for (const e of Object.values(reg)) {
      if (e.members?.includes(ID)) e.members = e.members.filter((m) => m !== ID);
    }
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

// Run the shared doctor health check and render its structured report through
// `emit` (say for the TUI, console for CLI). Delegates to the compiled MCP
// doctorTool so the output is the single source of truth — no reimplemented,
// drift-prone checks. Returns true when nothing is at error level. `emit` is
// injected so the same renderer serves both /doctor and `--doctor`.
async function runDoctor(fix, emit) {
  let doctorTool;
  try {
    ({ doctorTool } = await import(new URL("../dist/tools/index.js", import.meta.url)));
  } catch (e) {
    emit(A.red(`/doctor unavailable: could not load the doctor tool (${e?.message ?? e}).`));
    emit(A.dim("  This build may be missing dist/ — run `npm run build` in the package."));
    return false;
  }
  const icon = { ok: A.green("✓"), warn: A.yellow("!"), error: A.red("✗") };
  const res = await doctorTool({ fix });
  emit(
    A.bold("coord doctor") +
      A.dim(`  root=${res.root}`) +
      (fix ? A.dim("  (--fix applied)") : ""),
  );
  for (const f of res.findings) {
    emit(`  ${icon[f.level] ?? "?"} ${A.bold(f.check)}  ${f.detail}`);
    for (const item of f.items ?? []) emit(A.dim(`      - ${item}`));
  }
  for (const done of res.fixed ?? []) emit(A.green(`  fixed: ${done}`));
  const s = res.summary;
  emit(
    A.dim("  ") +
      `${A.green(`${s.ok} ok`)}  ${A.yellow(`${s.warn} warn`)}  ${A.red(`${s.error} error`)}` +
      (res.healthy ? A.green("  — healthy") : A.red("  — needs attention")),
  );
  if (!fix && res.findings.some((f) => f.fixable && f.level !== "ok")) {
    emit(A.dim("  run /doctor --fix to auto-remediate fixable findings"));
  }
  return res.summary.error === 0;
}

async function pruneOld(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let total = 0;
  // Per-channel removal counts so we can shift the corresponding cursor
  // offsets — without this, every other agent's offsets would point past the
  // now-shorter file and they'd silently miss messages until enough new ones
  // piled up to overtake the stale offset.
  const roomRemovedByChan = {};
  let statusRemoved = 0;
  const inboxRemoved = {}; // agentId → count

  const files = [];
  for (const chan of Object.keys(getRooms())) files.push({ path: roomFile(chan), kind: "room", chan });
  files.push({ path: STATUS_FILE_PATH, kind: "status" });
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
      if (f.kind === "room") {
        const c = normalizeRoom(f.chan);
        roomRemovedByChan[c] = (roomRemovedByChan[c] ?? 0) + removed;
      } else if (f.kind === "status") statusRemoved += removed;
      else inboxRemoved[f.agentId] = (inboxRemoved[f.agentId] ?? 0) + removed;
    }
  }
  if (Object.keys(roomRemovedByChan).length || statusRemoved || Object.keys(inboxRemoved).length) {
    shiftAllCursors({ roomRemovedByChan, statusRemoved, inboxRemoved });
  }
  say(A.dim(`→ pruned ${total} entries older than ${days}d (cursors adjusted)`));
}

async function wipeRoom() {
  const chan = normalizeRoom(currentRoom);
  await ensureFile(roomFile(chan));
  writeFileSync(roomFile(chan), "");
  // Reset every agent's offset for this channel so they re-read from the start
  // of the (now empty) file rather than pointing past EOF.
  resetRoomOffsets(chan);
  say(A.dim(`→ #${chan} wiped (channel cursors reset)`));
}

// Walk every cursor file and shift offsets down by the per-channel removed
// counts. Mirrors what the MCP prune tool does server-side.
function shiftAllCursors({ roomRemovedByChan = {}, statusRemoved = 0, inboxRemoved = {} }) {
  if (!existsSync(CURSOR_DIR)) return;
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    const id = name.replace(/\.json$/, "");
    let touched = false;
    for (const [chan, removed] of Object.entries(roomRemovedByChan)) {
      if (removed <= 0) continue;
      const has = chan === DEFAULT_ROOM ? cur.roomOffset !== undefined : cur.roomOffsets?.[chan] !== undefined;
      if (has) {
        setRoomOffset(cur, chan, Math.max(0, getRoomOffset(cur, chan) - removed));
        touched = true;
      }
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

function resetRoomOffsets(chan) {
  if (!existsSync(CURSOR_DIR)) return;
  const c = normalizeRoom(chan);
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    if (getRoomOffset(cur, c) !== 0) {
      setRoomOffset(cur, c, 0);
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
  let rooms = [];
  for (const chan of joinedRooms()) {
    rooms = rooms.concat(readJsonl(roomFile(chan)).map((m) => ({ ...m, _kind: "room", room: m.room ?? chan })));
  }
  const matches = [...inbox, ...rooms]
    .filter((m) => (m.text ?? "").toLowerCase().includes(t))
    .sort((a, b) => a.ts - b.ts);
  if (!matches.length) return say(A.dim(`(no matches for "${term}")`));
  say(A.bold(`${matches.length} match(es) for "${term}":`));
  for (const m of matches.slice(-20)) printMsg(m._kind, m, { history: true });
}

// ---------- channel commands ----------

function showRoomBanner(chan) {
  const c = normalizeRoom(chan);
  const e = getRooms()[c];
  say(A.bold(agentColor(c)(`#${c}`)) + (e?.topic ? A.dim(" — " + e.topic) : ""));
  if (e?.motd) say(A.dim("  rules: ") + e.motd);
  const members = e?.members ?? [];
  if (members.length) say(A.dim(`  members: ${members.join(", ")}`));
}

async function joinRoom(arg) {
  const chan = normalizeRoom(arg);
  await updateRooms((reg) => {
    const e = (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] });
    if (!e.members.includes(ID)) e.members.push(ID);
  });
  // Fast-forward this channel's offset so we don't replay its whole backlog.
  const cur = readJsonSafe(CURSOR_FILE, {});
  setRoomOffset(cur, chan, readJsonl(roomFile(chan)).length);
  writeJsonAtomic(CURSOR_FILE, cur);
  await sendSystem(chan, `joined #${chan}`);
  currentRoom = chan;
  watchRoom(chan);
  refreshPrompt();
  say(A.dim("→ now in ") + A.bold(agentColor(chan)(`#${chan}`)));
  showRoomBanner(chan);
}

async function partRoom(arg) {
  const chan = normalizeRoom(arg || currentRoom);
  if (chan === DEFAULT_ROOM) return say(A.red("cannot leave #general"));
  if (!joinedRooms().includes(chan)) return say(A.red(`not in #${chan}`));
  await sendSystem(chan, `left #${chan}`);
  await updateRooms((reg) => {
    if (reg[chan]) reg[chan].members = (reg[chan].members ?? []).filter((m) => m !== ID);
  });
  if (normalizeRoom(currentRoom) === chan) {
    currentRoom = DEFAULT_ROOM;
    refreshPrompt();
  }
  say(A.dim("→ left ") + A.bold(`#${chan}`));
}

function listRooms() {
  const reg = getRooms();
  const joined = new Set(joinedRooms());
  const names = Object.keys(reg).sort();
  say(A.bold(`channels (${names.length}):`));
  for (const c of names) {
    const e = reg[c];
    const here =
      normalizeRoom(currentRoom) === c ? A.green("*") : joined.has(c) ? A.dim("·") : " ";
    const count = readJsonl(roomFile(c)).length;
    const topic = e.topic ? A.dim(" — " + e.topic) : "";
    say(`  ${here} ${agentColor(c)(("#" + c).padEnd(16))} ${A.dim(`${(e.members ?? []).length} member(s), ${count} msg`)}${topic}`);
  }
}

async function setTopic(arg) {
  const chan = normalizeRoom(currentRoom);
  if (!arg) {
    const e = getRooms()[chan];
    return say(e?.topic ? A.bold(`#${chan} topic: `) + e.topic : A.dim(`#${chan} has no topic`));
  }
  await updateRooms((reg) => {
    (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] }).topic = arg;
  });
  await sendSystem(chan, `changed topic to: ${arg}`);
  say(A.dim(`→ topic set for #${chan}`));
}

async function setMotd(arg) {
  const chan = normalizeRoom(currentRoom);
  if (!arg) {
    const e = getRooms()[chan];
    return say(e?.motd ? A.bold(`#${chan} rules: `) + e.motd : A.dim(`#${chan} has no rules (MOTD)`));
  }
  await updateRooms((reg) => {
    (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] }).motd = arg;
  });
  await sendSystem(chan, `updated the room rules (MOTD)`);
  say(A.dim(`→ rules (MOTD) set for #${chan}`));
}

// ---------- phase-1 parity commands ----------

function whois(target) {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const a = reg[target];
  if (!a) return say(A.red(`no such agent: ${target}`));
  const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(target)}.json`), null);
  const live = marker && marker.pid && pidAlive(marker.pid);
  const online = live || Date.now() - a.lastHeartbeat < 5 * 60 * 1000;
  const rooms = Object.entries(getRooms())
    .filter(([, e]) => e.members?.includes(target))
    .map(([c]) => `#${c}`);
  say(A.bold("whois ") + agentColor(target)(target) + ":");
  say(`  ${A.cyan("status")}     ${online ? A.green("online") : A.dim("offline")}${a.away ? A.yellow(` (away: ${a.away})`) : ""}`);
  say(`  ${A.cyan("role")}       ${a.role ?? "-"}`);
  say(`  ${A.cyan("seen")}       ${A.dim(relTime(a.lastHeartbeat))}`);
  say(`  ${A.cyan("channels")}   ${rooms.length ? rooms.join(" ") : A.dim("(general)")}`);
  say(`  ${A.cyan("transport")}  ${live ? A.green(marker.transport) : A.dim("none")}`);
}

async function setAway(msg) {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[ID]) {
      reg[ID].away = msg || "away";
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  say(A.dim(`→ marked away${msg ? ": " + msg : ""}`));
}

async function setBack() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[ID]) {
      delete reg[ID].away;
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  say(A.dim("→ welcome back (away cleared)"));
}

function ignoreAgent(target) {
  if (!target) return say(A.red("usage: /ignore <agent>"));
  ignored.add(target);
  say(A.dim(`→ ignoring ${target} (this session)`));
}

function unignoreAgent(target) {
  if (target) {
    ignored.delete(target);
    say(A.dim(`→ no longer ignoring ${target}`));
  } else {
    ignored.clear();
    say(A.dim("→ cleared ignore list"));
  }
}

function moveFileSync(from, to) {
  if (!existsSync(from) || from === to) return;
  try {
    renameSync(from, to);
  } catch {
    try {
      writeFileSync(to, readFileSync(from));
      unlinkSync(from);
    } catch {
      /* best effort */
    }
  }
}

// Full rename (NICK): migrate registry, channel membership, inbox, cursor,
// transport marker, and color, then rebind the in-session identity. Mirrors
// the MCP rename_agent tool.
async function nick(arg) {
  const oldId = ID;
  const newId = (arg || "").trim();
  if (!newId || newId === oldId) return say(A.red("usage: /nick <newname>"));
  if (readJsonSafe(AGENTS_FILE, {})[newId]) return say(A.red(`'${newId}' already exists`));
  const joined = joinedRooms();

  await withLock(AGENTS_FILE, async () => {
    const r = readJsonSafe(AGENTS_FILE, {});
    if (r[oldId]) {
      r[newId] = { ...r[oldId], agentId: newId };
      delete r[oldId];
    }
    writeJsonAtomic(AGENTS_FILE, r);
  });
  await updateRooms((r) => {
    for (const e of Object.values(r)) {
      if (e.members?.includes(oldId)) e.members = e.members.map((m) => (m === oldId ? newId : m));
    }
  });
  moveFileSync(path.join(INBOX_DIR, `${sanitize(oldId)}.jsonl`), path.join(INBOX_DIR, `${sanitize(newId)}.jsonl`));
  moveFileSync(path.join(CURSOR_DIR, `${sanitize(oldId)}.json`), path.join(CURSOR_DIR, `${sanitize(newId)}.json`));
  moveFileSync(path.join(TRANSPORT_DIR, `${sanitize(oldId)}.json`), path.join(TRANSPORT_DIR, `${sanitize(newId)}.json`));
  const cmap = readJsonSafe(COLOR_MAP_FILE, {});
  if (cmap[oldId] !== undefined && cmap[newId] === undefined) {
    cmap[newId] = cmap[oldId];
    writeJsonAtomic(COLOR_MAP_FILE, cmap);
  }

  // Rebind in-session identity, then broadcast under the new name.
  ID = newId;
  INBOX_FILE = path.join(INBOX_DIR, `${sanitize(ID)}.jsonl`);
  CURSOR_FILE = path.join(CURSOR_DIR, `${sanitize(ID)}.json`);
  SELF_MENTION_RE = new RegExp("@" + ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9._-])");
  for (const chan of joined) await sendSystem(chan, `is now known as ${newId} (was ${oldId})`);
  refreshPrompt();
  say(A.dim("→ you are now ") + agentColor(ID)(ID));
}

async function sendRoom(text, chan = currentRoom) {
  const c = normalizeRoom(chan);
  await appendMessage(roomFile(c), { from: ID, room: c, text });
}

// Post a system notice (join/part/topic/nick) to a channel.
async function sendSystem(chan, text) {
  const c = normalizeRoom(chan);
  await appendMessage(roomFile(c), { from: ID, room: c, text, system: true });
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
    if (m && m.from !== ID && !ignored.has(m.from)) printMsg("DM", m);
  }
  if (inboxAll.length > inboxOff) {
    cursor.inboxOffset = inboxAll.length;
    changed = true;
  }

  // Drain every joined channel against its own per-channel offset.
  for (const chan of joinedRooms()) {
    const all = readJsonl(roomFile(chan));
    const off = getRoomOffset(cursor, chan);
    for (let i = off; i < all.length; i++) {
      const m = all[i];
      if (m && m.from !== ID && !ignored.has(m.from)) printMsg("room", { ...m, room: m.room ?? chan });
    }
    if (all.length > off) {
      setRoomOffset(cursor, chan, all.length);
      changed = true;
    }
  }

  if (changed) writeJsonAtomic(CURSOR_FILE, cursor);
}

function printMsg(kind, m, opts = {}) {
  const who = m.from ?? "?";
  const color = agentColor(who);
  const gutter = color("▎");
  const prefix = opts.history ? A.dim("  ") : "";

  // A channel tag when the message isn't from the focused channel, so cross-
  // channel traffic stays legible without cluttering the common single-room case.
  const otherChan = kind === "room" && m.room && normalizeRoom(m.room) !== normalizeRoom(currentRoom);
  const chanTag = otherChan ? agentColor(m.room)(`#${normalizeRoom(m.room)}`) + " " : "";

  // System notices (join/part/topic/nick) render as a dim italic one-liner.
  if (m.system) {
    const tag = chanTag ? `#${normalizeRoom(m.room)} ` : "";
    say("");
    say(`${prefix}\x1b[2;3m  — ${tag}${who} ${m.text ?? ""} —\x1b[0m`);
    if (!opts.history) lastBlock = { who: null, ts: m.ts, kind: null };
    return;
  }

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
    const header = `${marker}${badge}${chanTag}${A.bold(color(who))} ${A.dim(`· ${relTime(m.ts)}`)}`;
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
  drawHint(A.dim("  ┄ ") + list + A.dim("   · Tab to complete"));
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
