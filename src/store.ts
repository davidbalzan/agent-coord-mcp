import { promises as fs, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// Channels. The default channel `general` keeps using the legacy single-room
// file (room.jsonl) + the flat `roomOffset` cursor key, so existing agents and
// the notification hooks keep working with zero migration. Every other channel
// lives in rooms/<chan>.jsonl with its offset under cursor.roomOffsets[chan].
export const ROOMS_DIR = path.join(ROOT, "rooms");
export const ROOMS_FILE = path.join(ROOT, "rooms.json");
export const DEFAULT_ROOM = "general";

// Per-agent token map for identity-bound bus auth (v0.7.0). Shape on disk:
//   { "alice": "tk_<random-secret>", "bob": "tk_<another-secret>" }
// HTTP transport reverse-looks-up the bearer to bind the session to an
// agentId, then enforces that bound id against every tool call's
// from/agentId field. Absent → advisory mode (legacy behaviour, with a
// startup warning). Should be mode 600; operator-managed.
export const TOKENS_FILE = path.join(ROOT, "tokens.json");

export function ensureDirs(): void {
  for (const d of [ROOT, INBOX_DIR, CURSOR_DIR, TRANSPORT_DIR, PID_DIR, LOG_DIR, ROOMS_DIR]) {
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

// Atomically rotate the token entry for an agent rename (used by
// rename_agent so the same bearer continues to authenticate the renamed
// identity). No-op if the file is absent or the old id isn't in the map.
export async function rotateAgentToken(oldAgentId: string, newAgentId: string): Promise<void> {
  if (!existsSync(TOKENS_FILE)) return;
  await updateJson<Record<string, string>>(TOKENS_FILE, {}, (current) => {
    if (current[oldAgentId] !== undefined) {
      current[newAgentId] = current[oldAgentId];
      delete current[oldAgentId];
    }
    return current;
  });
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
