import { promises as fs, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

export const ROOT =
  process.env.AGENT_COORD_DIR ??
  process.env.CLAUDE_COORD_DIR ??
  path.join(homedir(), "agent-coord");
export const AGENTS_FILE = path.join(ROOT, "agents.json");
export const ROOM_FILE = path.join(ROOT, "room.jsonl");
export const STATUS_FILE = path.join(ROOT, "status.jsonl");
export const INBOX_DIR = path.join(ROOT, "inbox");
export const CURSOR_DIR = path.join(ROOT, "cursors");
export const TRANSPORT_DIR = path.join(ROOT, "transports");
export const PID_DIR = path.join(ROOT, "pids");
export const LOG_DIR = path.join(ROOT, "logs");
// Out-of-band delivery receipts (v0.9.0). A pusher stamps `receipts/<id>.jsonl`
// after it actually types a message into the receiving pane — proof of
// delivery the *sender* can poll for, WITHOUT the receipt ever entering any
// agent's context window (it lives in a file, not an inbox/room). This is what
// lets send_command return a truthful `delivered:true` instead of merely
// `written-to-jsonl:true`, at zero added agent token cost.
export const RECEIPTS_DIR = path.join(ROOT, "receipts");

// Reversible-history cache (CCR pattern, v0.9.x). When read_messages would
// flood an agent with a large channel backlog, the overflow (everything older
// than the recent window) is stashed here as one entry and replaced inline by
// a compact digest carrying a `hash`. The agent expands it on demand via
// retrieve_room_history(hash). Entries are content+scope addressed, TTL'd, and
// scoped to the (room, agent) they were produced for so a hash can't be
// replayed to read a channel the caller never read itself. This is a cache of
// data ALREADY present in rooms/<chan>.jsonl — not a new source of truth — so
// losing it (TTL/eviction) only costs the agent a re-read at a higher limit.
export const HISTORY_DIR = path.join(ROOT, "history");
export const HISTORY_TTL_MS = 30 * 60_000; // session-scale; mirrors headroom DEFAULT_CCR_TTL_SECONDS

// Channels. The default channel `general` keeps using the legacy single-room
// file (room.jsonl) + the flat `roomOffset` cursor key, so existing agents and
// the notification hooks keep working with zero migration. Every other channel
// lives in rooms/<chan>.jsonl with its offset under cursor.roomOffsets[chan].
export const ROOMS_DIR = path.join(ROOT, "rooms");
export const ROOMS_FILE = path.join(ROOT, "rooms.json");
export const DEFAULT_ROOM = "general";

// Cold storage (v0.15.0). Nothing on the bus is ever deleted by prune or
// compaction — aged-out entries are APPENDED here first, one file per room
// (general included, despite its live file being the legacy room.jsonl), plus
// status.jsonl and inbox/<agent>.jsonl. The server never reads these back;
// they exist for offline analysis of what happened in a room. Receipts are
// the one exception: delivery proofs carry no analysis value and are deleted.
export const ARCHIVE_DIR = path.join(ROOT, "archive");
export const ARCHIVE_ROOMS_DIR = path.join(ARCHIVE_DIR, "rooms");
export const ARCHIVE_INBOX_DIR = path.join(ARCHIVE_DIR, "inbox");
export const ARCHIVE_STATUS_FILE = path.join(ARCHIVE_DIR, "status.jsonl");

// Per-agent token map for identity-bound bus auth (v0.7.0). Shape on disk:
//   { "alice": "tk_<random-secret>", "bob": "tk_<another-secret>" }
// HTTP transport reverse-looks-up the bearer to bind the session to an
// agentId, then enforces that bound id against every tool call's
// from/agentId field. Absent → advisory mode (legacy behaviour, with a
// startup warning). Should be mode 600; operator-managed.
export const TOKENS_FILE = path.join(ROOT, "tokens.json");

// Declared write scopes for managed documents (v0.18.0, Phase 8 Task 4).
// Opt-in and operator-managed: absent → nothing is owned and nothing warns.
// ADVISORY. The bus does not mediate writes to docs/QUEUE.md & friends —
// agents edit them with ordinary file tools, so there is no interception
// point. This file lets an agent ASK who owns a document (list_scopes) and
// lets `doctor` DETECT drift after the fact. Pre-emptive enforcement waits
// for Phase 8 Task 5, when work state moves into the store.
export const SCOPES_FILE = path.join(ROOT, "scopes.json");

// Work state as data (v0.18.0, Phase 8 Task 5). One file per project holding
// the parsed QUEUE/DONE/board documents. DERIVED, not authoritative: the
// markdown in the repo remains the source of truth, and deleting this
// directory costs an `import_work`, never data (see src/work.ts).
export const WORK_DIR = path.join(ROOT, "work");
export function workFile(project: string): string {
  return path.join(WORK_DIR, `${sanitize(project)}.json`);
}

export function ensureDirs(): void {
  for (const d of [ROOT, INBOX_DIR, CURSOR_DIR, TRANSPORT_DIR, PID_DIR, LOG_DIR, ROOMS_DIR, RECEIPTS_DIR, HISTORY_DIR, WORK_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  for (const f of [ROOM_FILE, STATUS_FILE]) {
    if (!existsSync(f)) mkdirSync(path.dirname(f), { recursive: true });
  }
}

// Synchronous, deliberate. The result feeds the server's bearer→agent
// reverse-lookup map; we want startup to fail loudly on a malformed file
// rather than silently degrade to advisory mode. Returns null if the file
// is absent (operator hasn't configured binding yet).
export function readTokenMapSync(): Map<string, string> | null {
  if (!existsSync(TOKENS_FILE)) return null;
  const raw = readFileSync(TOKENS_FILE, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `[agent-coord-mcp] ${TOKENS_FILE} is not valid JSON: ${(e as Error).message}. ` +
        `Fix or remove the file (the bus refuses to start with a broken token map).`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[agent-coord-mcp] ${TOKENS_FILE} must be a JSON object mapping agentId → token.`,
    );
  }
  const out = new Map<string, string>();
  for (const [agentId, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `[agent-coord-mcp] ${TOKENS_FILE}: agent "${agentId}" has a non-string/empty token.`,
      );
    }
    out.set(token, agentId);
  }
  return out;
}

// In-process cache of the token map, shared by the HTTP identity-binding
// layer (server.ts) and rotateAgentToken below. A module-level cache (rather
// than each caller re-reading the file) is what lets a rename refresh the
// live server's view without an operator SIGHUP.
let tokenMapCache: Map<string, string> | null = null;
let tokenMapInitialized = false;

// Current in-process token map (bearer -> agentId), or null if unbound (no
// tokens.json). Lazily loads from disk on first call.
export function getTokenMap(): Map<string, string> | null {
  if (!tokenMapInitialized) {
    tokenMapCache = readTokenMapSync();
    tokenMapInitialized = true;
  }
  return tokenMapCache;
}

// Re-read tokens.json from disk and replace the in-process cache. Throws on
// a malformed file — callers decide whether that's fatal (startup) or
// recoverable (SIGHUP, post-rotate refresh).
export function reloadTokenMapSync(): Map<string, string> | null {
  tokenMapCache = readTokenMapSync();
  tokenMapInitialized = true;
  return tokenMapCache;
}

// Atomically rotate the token entry for an agent rename (used by
// rename_agent so the same bearer continues to authenticate the renamed
// identity). No-op if the file is absent or the old id isn't in the map.
export async function rotateAgentToken(oldAgentId: string, newAgentId: string): Promise<void> {
  if (!existsSync(TOKENS_FILE)) return;
  let rotated = false;
  await updateJson<Record<string, string>>(TOKENS_FILE, {}, (current) => {
    if (current[oldAgentId] !== undefined) {
      current[newAgentId] = current[oldAgentId];
      delete current[oldAgentId];
      rotated = true;
    }
    return current;
  });
  if (rotated) {
    // Refresh the in-process cache immediately: without this, the renamed
    // agent's bearer keeps resolving to the OLD id in this process until an
    // operator sends SIGHUP, silently misattributing its calls.
    try {
      reloadTokenMapSync();
    } catch (e) {
      console.error(
        `[agent-coord-mcp] rename_agent: token map reload after rotate failed: ${(e as Error).message} ` +
          `(keeping previous in-process map; send SIGHUP to retry)`,
      );
    }
  }
}

export type RoomEntry = {
  topic?: string;
  motd?: string;
  createdAt: number;
  createdBy: string;
  members: string[];
};
export type RoomRegistry = Record<string, RoomEntry>;

// Normalize a channel name: strip leading '#', lowercase, restrict to a safe
// charset, empty → the default channel. Display layers re-add the '#'.
export function normalizeRoom(name?: string): string {
  if (!name) return DEFAULT_ROOM;
  const n = name.trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

// Resolve a channel to its physical JSONL file. `general` maps to the legacy
// room.jsonl for backward compatibility; everything else to rooms/<chan>.jsonl.
export function roomFile(chan: string): string {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? ROOM_FILE : path.join(ROOMS_DIR, `${sanitize(c)}.jsonl`);
}

function blankRoom(createdBy: string): RoomEntry {
  return { createdAt: Date.now(), createdBy, members: [] };
}

// Read the channel registry, always surfacing `general` even before it has been
// explicitly persisted (it exists implicitly via room.jsonl).
export async function getRooms(): Promise<RoomRegistry> {
  const reg = await readJson<RoomRegistry>(ROOMS_FILE, {});
  if (!reg[DEFAULT_ROOM]) reg[DEFAULT_ROOM] = { createdAt: 0, createdBy: "system", members: [] };
  return reg;
}

export async function ensureRoom(chan: string, createdBy: string): Promise<void> {
  const c = normalizeRoom(chan);
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (cur) => {
    if (!cur[c]) cur[c] = blankRoom(createdBy);
    return cur;
  });
}

export async function setRoomMeta(chan: string, meta: { topic?: string; motd?: string }, by = "system"): Promise<void> {
  const c = normalizeRoom(chan);
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (cur) => {
    const e = (cur[c] ??= blankRoom(by));
    if (meta.topic !== undefined) e.topic = meta.topic;
    if (meta.motd !== undefined) e.motd = meta.motd;
    return cur;
  });
}

export async function addMember(chan: string, agentId: string): Promise<void> {
  const c = normalizeRoom(chan);
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (cur) => {
    const e = (cur[c] ??= blankRoom(agentId));
    if (!e.members.includes(agentId)) e.members.push(agentId);
    return cur;
  });
}

export async function removeMember(chan: string, agentId: string): Promise<void> {
  const c = normalizeRoom(chan);
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (cur) => {
    if (cur[c]) cur[c].members = cur[c].members.filter((m) => m !== agentId);
    return cur;
  });
}

// Channels this agent has joined (always includes the default channel).
export async function memberRooms(agentId: string): Promise<string[]> {
  const reg = await getRooms();
  const out = new Set<string>([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e.members?.includes(agentId)) out.add(chan);
  }
  return [...out];
}

export function transportFile(agentId: string): string {
  return path.join(TRANSPORT_DIR, `${sanitize(agentId)}.json`);
}

export function pidFile(agentId: string, kind: string): string {
  return path.join(PID_DIR, `${kind}-${sanitize(agentId)}.pid`);
}

export function logFile(agentId: string, kind: string): string {
  return path.join(LOG_DIR, `${kind}-${sanitize(agentId)}.log`);
}

export async function listTransportFiles(): Promise<string[]> {
  if (!existsSync(TRANSPORT_DIR)) return [];
  const names = await fs.readdir(TRANSPORT_DIR);
  return names.filter((n) => n.endsWith(".json"));
}

async function ensureFile(file: string): Promise<void> {
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", "utf8");
  }
}

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function appendJsonl(file: string, entry: unknown): Promise<void> {
  await withLock(file, async () => {
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(file, line, "utf8");
  });
}

export async function readJsonl<T = unknown>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const raw = await fs.readFile(file, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await withLock(file, async () => {
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  });
}

async function readJsonNoLock<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function updateJson<T>(file: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> {
  return withLock(file, async () => {
    const current = await readJsonNoLock(file, fallback);
    const next = await mutate(current);
    await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

export function inboxFile(agentId: string): string {
  return path.join(INBOX_DIR, `${sanitize(agentId)}.jsonl`);
}

export function cursorFile(agentId: string): string {
  return path.join(CURSOR_DIR, `${sanitize(agentId)}.json`);
}

// Per-agent delivery-receipt log. The agent's own pusher appends here after it
// types a message into the pane; senders poll it to confirm delivery.
export function receiptFile(agentId: string): string {
  return path.join(RECEIPTS_DIR, `${sanitize(agentId)}.jsonl`);
}

export async function listReceiptFiles(): Promise<string[]> {
  if (!existsSync(RECEIPTS_DIR)) return [];
  const names = await fs.readdir(RECEIPTS_DIR);
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(RECEIPTS_DIR, n));
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function rewriteJsonl<T>(
  file: string,
  filter: (entry: T) => boolean
): Promise<{ kept: number; removed: number }> {
  if (!existsSync(file)) return { kept: 0, removed: 0 };
  return withLock(file, async () => {
    const raw = await fs.readFile(file, "utf8");
    let kept = 0;
    let removed = 0;
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as T;
        if (filter(entry)) {
          out.push(line);
          kept++;
        } else {
          removed++;
        }
      } catch {
        removed++;
      }
    }
    await fs.writeFile(file, out.length ? out.join("\n") + "\n" : "", "utf8");
    return { kept, removed };
  });
}

// Archive destinations for each live JSONL stream.
export function archiveRoomFile(chan: string): string {
  return path.join(ARCHIVE_ROOMS_DIR, `${sanitize(normalizeRoom(chan))}.jsonl`);
}

export function archiveInboxFile(agentId: string): string {
  return path.join(ARCHIVE_INBOX_DIR, `${sanitize(agentId)}.jsonl`);
}

// Like rewriteJsonl, but entries failing the filter are appended to
// archiveFile instead of discarded. The archive append happens under the
// source-file lock and BEFORE the rewrite, so a crash mid-operation can at
// worst duplicate entries into the archive — never lose them. Malformed
// lines are archived verbatim rather than parsed.
export async function archiveJsonl<T>(
  file: string,
  archiveFile: string,
  filter: (entry: T) => boolean
): Promise<{ kept: number; removed: number; archived: number }> {
  if (!existsSync(file)) return { kept: 0, removed: 0, archived: 0 };
  return withLock(file, async () => {
    const raw = await fs.readFile(file, "utf8");
    let kept = 0;
    let removed = 0;
    const keep: string[] = [];
    const archive: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as T;
        if (filter(entry)) {
          keep.push(line);
          kept++;
        } else {
          archive.push(line);
          removed++;
        }
      } catch {
        archive.push(line);
        removed++;
      }
    }
    if (archive.length) {
      await fs.mkdir(path.dirname(archiveFile), { recursive: true });
      await fs.appendFile(archiveFile, archive.join("\n") + "\n", "utf8");
    }
    await fs.writeFile(file, keep.length ? keep.join("\n") + "\n" : "", "utf8");
    return { kept, removed, archived: archive.length };
  });
}

export async function deleteFile(file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  await fs.unlink(file);
  return true;
}

export async function listInboxFiles(): Promise<string[]> {
  if (!existsSync(INBOX_DIR)) return [];
  const names = await fs.readdir(INBOX_DIR);
  return names.filter((n) => n.endsWith(".jsonl"));
}

export async function listCursorFiles(): Promise<string[]> {
  if (!existsSync(CURSOR_DIR)) return [];
  const names = await fs.readdir(CURSOR_DIR);
  return names.filter((n) => n.endsWith(".json"));
}

export async function fileSize(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  const st = await fs.stat(file);
  return st.size;
}

// ---------- reversible history cache (CCR) ----------

export type HistoryEntry<T = unknown> = {
  hash: string;
  room: string;
  forAgent: string; // scope key — only this agent may retrieve (see HISTORY_DIR note)
  createdTs: number;
  messages: T[];
};

function historyFile(hash: string): string {
  return path.join(HISTORY_DIR, `${sanitize(hash)}.json`);
}

// Content+scope address: same backlog read by two agents (or twice by one)
// yields distinct entries, and the hash can't be guessed for a (room, agent)
// pair the caller never read. 12 hex chars ≈ 48 bits — collision-safe at this
// volume, short enough to sit inline in the digest marker.
function historyHash(room: string, forAgent: string, messages: { ts: number }[]): string {
  const first = messages[0]?.ts ?? 0;
  const last = messages[messages.length - 1]?.ts ?? 0;
  const sig = `${room} ${forAgent} ${first} ${last} ${messages.length}`;
  return createHash("sha1").update(sig).digest("hex").slice(0, 12);
}

// Best-effort sweep of expired entries. Cheap (one readdir + stat per file) and
// only the data is a disposable cache, so we swallow all errors.
export async function pruneHistory(now = Date.now()): Promise<void> {
  if (!existsSync(HISTORY_DIR)) return;
  let names: string[];
  try {
    names = await fs.readdir(HISTORY_DIR);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        const f = path.join(HISTORY_DIR, n);
        try {
          const e = await readJsonNoLock<HistoryEntry | null>(f, null);
          if (!e || now - e.createdTs > HISTORY_TTL_MS) await fs.unlink(f).catch(() => {});
        } catch {
          /* leave it; next sweep retries */
        }
      }),
  );
}

// Stash a backlog slice and return its hash. Caller embeds the hash in the
// digest marker it returns to the agent.
export async function stashHistory<T extends { ts: number }>(
  room: string,
  forAgent: string,
  messages: T[],
): Promise<string> {
  const hash = historyHash(room, forAgent, messages);
  const entry: HistoryEntry<T> = { hash, room, forAgent, createdTs: Date.now(), messages };
  await writeJson(historyFile(hash), entry);
  void pruneHistory();
  return hash;
}

export type RetrieveHistoryResult<T = unknown> =
  | { ok: true; room: string; total: number; messages: T[] }
  | { ok: false; reason: "not_found" | "expired" | "forbidden" };

// Expand a stashed backlog. Enforces the (forAgent) scope and TTL. `query`, if
// given, returns only entries whose serialized form contains the substring
// (case-insensitive) — the lossless analogue of headroom's BM25 search-within.
export async function retrieveHistory<T = unknown>(
  hash: string,
  forAgent: string,
  query?: string,
): Promise<RetrieveHistoryResult<T>> {
  const f = historyFile(hash);
  const entry = await readJson<HistoryEntry<T> | null>(f, null);
  if (!entry) return { ok: false, reason: "not_found" };
  if (Date.now() - entry.createdTs > HISTORY_TTL_MS) {
    await deleteFile(f).catch(() => {});
    return { ok: false, reason: "expired" };
  }
  if (entry.forAgent !== forAgent) return { ok: false, reason: "forbidden" };

  let messages = entry.messages;
  if (query && query.trim()) {
    const q = query.toLowerCase();
    messages = messages.filter((m) => JSON.stringify(m).toLowerCase().includes(q));
  }
  return { ok: true, room: entry.room, total: entry.messages.length, messages };
}
