import { randomUUID } from "node:crypto";
import { existsSync, openSync, watch } from "node:fs";
import { promises as fsp } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import path from "node:path";
import {
  AGENTS_FILE,
  CURSOR_DIR,
  DEFAULT_ROOM,
  INBOX_DIR,
  ROOMS_FILE,
  STATUS_FILE,
  addMember,
  appendJsonl,
  cursorFile,
  deleteFile,
  ensureRoom,
  fileSize,
  getRooms,
  inboxFile,
  listCursorFiles,
  listInboxFiles,
  listTransportFiles,
  logFile,
  memberRooms,
  normalizeRoom,
  pidFile,
  readJson,
  readJsonl,
  removeMember,
  rewriteJsonl,
  roomFile,
  setRoomMeta,
  transportFile,
  updateJson,
  type RoomRegistry,
} from "./store.js";

type AgentEntry = {
  agentId: string;
  project?: string;
  role?: string;
  registeredAt: number;
  lastHeartbeat: number;
  capabilities?: string[];
};

type TransportMarker = {
  agentId: string;
  transport: string;
  pid: number;
  tmuxTarget?: string;
  since: number;
};

type AgentRegistry = Record<string, AgentEntry>;

type Message = {
  id: string;
  ts: number;
  from: string;
  to?: string;
  room?: string;
  text: string;
  // System notices (join/part/topic/nick) — rendered distinctly by clients.
  system?: boolean;
};

type StatusEntry = {
  id: string;
  ts: number;
  agentId: string;
  status: string;
  detail?: string;
};

type Cursor = {
  inboxOffset?: number;
  roomOffset?: number; // the default channel (`general` → room.jsonl)
  statusOffset?: number;
  // Per-channel read offsets for every non-default channel.
  roomOffsets?: Record<string, number>;
};

type Source = "inbox" | "room" | "status";

// Resolve the physical file for a (source, agent, channel) tuple.
function sourceFile(source: Source, agentId: string, room?: string): string {
  if (source === "inbox") return inboxFile(agentId);
  if (source === "status") return STATUS_FILE;
  return roomFile(room ?? DEFAULT_ROOM);
}

// Read/write the cursor offset for a (source, channel). `general` keeps using
// the flat roomOffset key (hook compat); other channels use roomOffsets[chan].
function getOffset(cursor: Cursor, source: Source, room?: string): number {
  if (source === "inbox") return cursor.inboxOffset ?? 0;
  if (source === "status") return cursor.statusOffset ?? 0;
  const chan = normalizeRoom(room);
  return chan === DEFAULT_ROOM ? cursor.roomOffset ?? 0 : cursor.roomOffsets?.[chan] ?? 0;
}

function setOffset(cursor: Cursor, source: Source, room: string | undefined, n: number): void {
  if (source === "inbox") { cursor.inboxOffset = n; return; }
  if (source === "status") { cursor.statusOffset = n; return; }
  const chan = normalizeRoom(room);
  if (chan === DEFAULT_ROOM) cursor.roomOffset = n;
  else (cursor.roomOffsets ??= {})[chan] = n;
}

function sysMsg(from: string, room: string, text: string): Message {
  return { id: randomUUID(), ts: Date.now(), from, room, text, system: true };
}

const STALE_MS = 5 * 60 * 1000;
const EVICT_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 60_000;

// ---------- register ----------

export const registerSchema = {
  agentId: z.string().min(1),
  project: z.string().optional(),
  role: z.string().optional(),
};

export async function registerTool(args: { agentId: string; project?: string; role?: string }) {
  const reg = await updateJson<AgentRegistry>(AGENTS_FILE, {}, (current) => {
    const now = Date.now();
    const existing = current[args.agentId];
    current[args.agentId] = {
      agentId: args.agentId,
      project: args.project ?? existing?.project,
      role: args.role ?? existing?.role,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
    };
    return current;
  });
  return { ok: true, agent: reg[args.agentId] };
}

// ---------- unregister ----------

export const unregisterSchema = { agentId: z.string().min(1) };

export async function unregisterTool(args: { agentId: string }) {
  // If a transport is attached, take it down first so the pusher doesn't keep
  // re-publishing the marker after we drop the registry entry.
  const detach = await detachAgentTool(args);

  let existed = false;
  await updateJson<AgentRegistry>(AGENTS_FILE, {}, (current) => {
    if (current[args.agentId]) {
      existed = true;
      delete current[args.agentId];
    }
    return current;
  });
  return { ok: true, removed: existed, detach };
}

// ---------- heartbeat ----------

export const heartbeatSchema = { agentId: z.string().min(1) };

export async function heartbeatTool(args: { agentId: string }) {
  let missing = false;
  await updateJson<AgentRegistry>(AGENTS_FILE, {}, (current) => {
    if (!current[args.agentId]) {
      missing = true;
      return current;
    }
    current[args.agentId].lastHeartbeat = Date.now();
    return current;
  });
  if (missing) return { ok: false, error: `agent '${args.agentId}' not registered` };
  return { ok: true };
}

// ---------- list_agents ----------

export const listAgentsSchema = {} as const;

export async function listAgentsTool() {
  const now = Date.now();
  const evicted: string[] = [];

  // Load live transport markers first so we can refresh heartbeats for agents
  // whose pusher (or other transport daemon) is alive — the live process IS
  // the heartbeat, no separate ping needed.
  const liveTransports = await loadLiveTransports();

  const reg = await updateJson<AgentRegistry>(AGENTS_FILE, {}, (current) => {
    for (const [id, entry] of Object.entries(current)) {
      if (liveTransports.has(id)) {
        entry.lastHeartbeat = now;
        continue;
      }
      if (now - entry.lastHeartbeat > EVICT_MS) {
        evicted.push(id);
        delete current[id];
      }
    }
    return current;
  });

  const agents = Object.values(reg).map((a) => {
    const transport = liveTransports.get(a.agentId);
    const merged = [...(a.capabilities ?? [])];
    if (transport && !merged.includes(transport.transport)) merged.push(transport.transport);
    return {
      ...a,
      online: transport ? true : now - a.lastHeartbeat < STALE_MS,
      secondsSinceHeartbeat: Math.floor((now - a.lastHeartbeat) / 1000),
      capabilities: merged.length > 0 ? merged : undefined,
      transport: transport
        ? { kind: transport.transport, tmuxTarget: transport.tmuxTarget, pid: transport.pid }
        : undefined,
    };
  });
  return { agents, evicted };
}

async function loadLiveTransports(): Promise<Map<string, TransportMarker>> {
  const out = new Map<string, TransportMarker>();
  for (const fname of await listTransportFiles()) {
    const file = path.join(path.dirname(transportFile("x")), fname);
    const marker = await readJson<TransportMarker | null>(file, null);
    if (!marker) {
      await deleteFile(file);
      continue;
    }
    if (!isPidAlive(marker.pid)) {
      await deleteFile(file);
      continue;
    }
    out.set(marker.agentId, marker);
  }
  return out;
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM = exists but not ours; ESRCH = gone
  }
}

// ---------- send_message ----------

export const sendMessageSchema = {
  from: z.string().min(1),
  to: z.string().optional(),
  room: z.string().optional(),
  text: z.string().min(1),
};

export async function sendMessageTool(args: {
  from: string;
  to?: string;
  room?: string;
  text: string;
}) {
  // DM → inbox. Otherwise resolve the channel (default `general`), make sure it
  // exists in the registry, and tag the message with its channel.
  if (args.to) {
    const msg: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: args.from,
      to: args.to,
      text: args.text,
    };
    const target = inboxFile(args.to);
    await appendJsonl(target, msg);
    return { ok: true, id: msg.id, target, room: undefined };
  }

  const chan = normalizeRoom(args.room);
  if (chan !== DEFAULT_ROOM) await ensureRoom(chan, args.from);
  const msg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: args.from,
    room: chan,
    text: args.text,
  };
  const target = roomFile(chan);
  await appendJsonl(target, msg);
  return { ok: true, id: msg.id, target, room: chan };
}

// ---------- read_messages ----------

export const readMessagesSchema = {
  agentId: z.string().min(1),
  source: z.enum(["inbox", "room", "status"]),
  room: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  peek: z.boolean().optional(),
  sinceTs: z.number().optional(),
};

export async function readMessagesTool(args: {
  agentId: string;
  source: Source;
  room?: string;
  limit?: number;
  peek?: boolean;
  sinceTs?: number;
}) {
  const file = sourceFile(args.source, args.agentId, args.room);
  const all = await readJsonl<Message | StatusEntry>(file);

  let limited: (Message | StatusEntry)[] = [];
  let totalNew = 0;

  if (args.peek) {
    const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
    const startOffset = getOffset(cursor, args.source, args.room);
    let entries = all.slice(startOffset);
    if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
    totalNew = entries.length;
    limited = args.limit ? entries.slice(0, args.limit) : entries;
  } else {
    await updateJson<Cursor>(cursorFile(args.agentId), {}, (current) => {
      const startOffset = getOffset(current, args.source, args.room);
      let entries = all.slice(startOffset);
      if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
      totalNew = entries.length;
      limited = args.limit ? entries.slice(0, args.limit) : entries;
      if (limited.length > 0) setOffset(current, args.source, args.room, startOffset + limited.length);
      return current;
    });
  }

  // Drop the agent's own posts on shared channels — reading your own broadcast
  // back is never useful and confuses turn-based agents into self-replies.
  // Cursor has already advanced past them, so they won't reappear.
  const visible =
    args.source === "room" || args.source === "status"
      ? limited.filter((e) => entryAuthor(e) !== args.agentId)
      : limited;

  return {
    messages: visible,
    totalNew,
    returned: visible.length,
    room: args.source === "room" ? normalizeRoom(args.room) : undefined,
  };
}

function entryAuthor(e: Message | StatusEntry): string | undefined {
  return "from" in e ? e.from : e.agentId;
}

// ---------- post_status ----------

export const postStatusSchema = {
  agentId: z.string().min(1),
  status: z.string().min(1),
  detail: z.string().optional(),
};

export async function postStatusTool(args: { agentId: string; status: string; detail?: string }) {
  const entry: StatusEntry = {
    id: randomUUID(),
    ts: Date.now(),
    agentId: args.agentId,
    status: args.status,
    detail: args.detail,
  };
  await appendJsonl(STATUS_FILE, entry);
  return { ok: true, id: entry.id };
}

// ---------- wait_for_message ----------

export const waitForMessageSchema = {
  agentId: z.string().min(1),
  source: z.enum(["inbox", "room", "status"]),
  room: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
};

export async function waitForMessageTool(args: {
  agentId: string;
  source: Source;
  room?: string;
  timeoutMs?: number;
}) {
  const totalTimeout = Math.min(args.timeoutMs ?? 30_000, MAX_WAIT_MS);
  const file = sourceFile(args.source, args.agentId, args.room);
  const deadline = Date.now() + totalTimeout;

  // Loop so that file growth caused only by the agent's own self-posts (which
  // readMessagesTool now filters out for room/status) doesn't return an empty
  // result — keep waiting until we have something to deliver or time out.
  while (Date.now() < deadline) {
    const startSize = await fileSize(file);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const changed = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        try {
          watcher?.close();
        } catch {
          // ignore
        }
        clearTimeout(t);
        resolve(v);
      };

      const check = async () => {
        const sz = await fileSize(file);
        if (sz > startSize) finish(true);
      };

      let watcher: ReturnType<typeof watch> | undefined;
      try {
        watcher = watch(file, () => {
          void check();
        });
      } catch {
        // file may not exist; polling will handle
      }
      const poll = setInterval(() => void check(), 500);
      const t = setTimeout(() => finish(false), remaining);
    });

    if (!changed) break;
    const result = await readMessagesTool({ agentId: args.agentId, source: args.source, room: args.room });
    if (result.returned > 0) return result;
    // otherwise, only self-posts arrived; keep waiting on the remaining budget
  }

  return { ok: false, timedOut: true };
}

// ---------- prune ----------

export const pruneSchema = {
  olderThanDays: z.number().positive().max(365).optional(),
  removeOrphanInboxes: z.boolean().optional(),
  dryRun: z.boolean().optional(),
};

export async function pruneTool(args: {
  olderThanDays?: number;
  removeOrphanInboxes?: boolean;
  dryRun?: boolean;
}) {
  const days = args.olderThanDays ?? 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dryRun = args.dryRun ?? false;

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const knownAgents = new Set(Object.keys(reg));

  const channels = Object.keys(await getRooms());

  if (dryRun) {
    let roomMessages = 0;
    for (const chan of channels) {
      const msgs = await readJsonl<Message>(roomFile(chan));
      roomMessages += msgs.filter((e) => e.ts <= cutoff).length;
    }
    const status = await readJsonl<StatusEntry>(STATUS_FILE);
    const inboxFiles = await listInboxFiles();
    let inboxRemoved = 0;
    const orphans: string[] = [];
    for (const fname of inboxFiles) {
      const id = fname.replace(/\.jsonl$/, "");
      if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) orphans.push(fname);
      const entries = await readJsonl<Message>(path.join(INBOX_DIR, fname));
      inboxRemoved += entries.filter((e) => e.ts <= cutoff).length;
    }
    return {
      dryRun: true,
      cutoff,
      olderThanDays: days,
      wouldRemove: {
        roomMessages,
        statusEntries: status.filter((e) => e.ts <= cutoff).length,
        inboxMessages: inboxRemoved,
        orphanInboxes: orphans,
      },
    };
  }

  // Per-channel removed counts so we can shift the matching offset in each
  // cursor (default channel → roomOffset, others → roomOffsets[chan]).
  const roomRemovedByChan: Record<string, number> = {};
  let roomRemovedTotal = 0;
  for (const chan of channels) {
    const r = await rewriteJsonl<Message>(roomFile(chan), (e) => e.ts > cutoff);
    if (r.removed > 0) {
      roomRemovedByChan[chan] = r.removed;
      roomRemovedTotal += r.removed;
    }
  }
  const statusResult = await rewriteJsonl<StatusEntry>(STATUS_FILE, (e) => e.ts > cutoff);

  const inboxFiles = await listInboxFiles();
  let inboxRemoved = 0;
  const deletedOrphans: string[] = [];
  // perAgentInboxRemoved: how many entries were stripped from each *kept* agent's
  // inbox, so we can shift only that agent's inboxOffset cursor below.
  const perAgentInboxRemoved: Record<string, number> = {};
  for (const fname of inboxFiles) {
    const id = fname.replace(/\.jsonl$/, "");
    const filePath = path.join(INBOX_DIR, fname);
    if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) {
      const entries = await readJsonl<Message>(filePath);
      inboxRemoved += entries.length;
      await deleteFile(filePath);
      deletedOrphans.push(id);
      continue;
    }
    const r = await rewriteJsonl<Message>(filePath, (e) => e.ts > cutoff);
    inboxRemoved += r.removed;
    perAgentInboxRemoved[id] = r.removed;
  }

  // Cursor adjustment: appendJsonl is time-ordered and rewriteJsonl removes
  // the oldest entries (ts <= cutoff). Any cursor offset shifts down by the
  // removed count, clamped at 0. Without this, an offset past the new file
  // length would make read_messages return [] forever.
  const cursorsAdjusted: string[] = [];
  for (const cname of await listCursorFiles()) {
    const id = cname.replace(/\.json$/, "");
    const cursorPath = path.join(CURSOR_DIR, cname);
    let touched = false;
    await updateJson<Cursor>(cursorPath, {}, (current) => {
      for (const [chan, removed] of Object.entries(roomRemovedByChan)) {
        if (chan === DEFAULT_ROOM) {
          if (current.roomOffset !== undefined) {
            current.roomOffset = Math.max(0, current.roomOffset - removed);
            touched = true;
          }
        } else if (current.roomOffsets?.[chan] !== undefined) {
          current.roomOffsets[chan] = Math.max(0, current.roomOffsets[chan] - removed);
          touched = true;
        }
      }
      if (current.statusOffset !== undefined && statusResult.removed > 0) {
        current.statusOffset = Math.max(0, current.statusOffset - statusResult.removed);
        touched = true;
      }
      const myInboxRemoved = perAgentInboxRemoved[id] ?? 0;
      if (current.inboxOffset !== undefined && myInboxRemoved > 0) {
        current.inboxOffset = Math.max(0, current.inboxOffset - myInboxRemoved);
        touched = true;
      }
      return current;
    });
    if (touched) cursorsAdjusted.push(id);
  }

  return {
    dryRun: false,
    cutoff,
    olderThanDays: days,
    removed: {
      roomMessages: roomRemovedTotal,
      statusEntries: statusResult.removed,
      inboxMessages: inboxRemoved,
      orphanInboxes: deletedOrphans,
    },
    cursorsAdjusted,
  };
}

// ---------- attach_agent / detach_agent (tmux push transport) ----------

export const attachAgentSchema = {
  agentId: z.string().min(1),
  tmuxTarget: z.string().optional(),
  includeRoom: z.boolean().optional(),
  allowlist: z.array(z.string()).optional(),
  debounceMs: z.number().int().positive().max(60_000).optional(),
};

export async function attachAgentTool(args: {
  agentId: string;
  tmuxTarget?: string;
  includeRoom?: boolean;
  allowlist?: string[];
  debounceMs?: number;
}) {
  // Resolve target: explicit arg > MCP server's own TMUX_PANE env.
  const target = args.tmuxTarget ?? process.env.TMUX_PANE;
  if (!target) {
    return {
      ok: false,
      error:
        "tmuxTarget not provided and the MCP server is not running inside tmux (no $TMUX_PANE). Pass tmuxTarget explicitly (e.g. '%42' or 'session:window.pane').",
    };
  }

  // Validate target exists.
  const probe = spawnSync("tmux", ["display-message", "-p", "-t", target, "ok"]);
  if (probe.status !== 0) {
    return {
      ok: false,
      error: `tmux target '${target}' not found: ${(probe.stderr ?? "").toString().trim()}`,
    };
  }

  // If something's already attached, refuse rather than spawn a second pusher.
  const existing = await readJson<TransportMarker | null>(transportFile(args.agentId), null);
  if (existing && isPidAlive(existing.pid)) {
    return {
      ok: false,
      error: `agent '${args.agentId}' already has a live ${existing.transport} attached (pid ${existing.pid}). Call detach_agent first.`,
      existing,
    };
  }
  // Clean up dead marker, if any.
  if (existing) await deleteFile(transportFile(args.agentId));

  const pusher = resolvePusherPath();
  if (!existsSync(pusher)) {
    return { ok: false, error: `tmux-pusher not found at ${pusher}` };
  }

  // Detached spawn so the pusher outlives this MCP request/process.
  const log = logFile(args.agentId, "pusher");
  await fsp.mkdir(path.dirname(log), { recursive: true });
  await fsp.mkdir(path.dirname(pidFile(args.agentId, "pusher")), { recursive: true });
  await fsp.mkdir(path.dirname(transportFile(args.agentId)), { recursive: true });
  const out = openSync(log, "a");
  const err = openSync(log, "a");
  // Default: deliver room broadcasts too. The bus is chat-first — silence on
  // a room post is a worse failure mode than a slightly noisier pane. Callers
  // who want DM-only can pass includeRoom:false explicitly.
  const includeRoom = args.includeRoom !== false;
  const child = spawn("node", [pusher], {
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      AGENT_COORD_ID: args.agentId,
      AGENT_COORD_TMUX_TARGET: target,
      ...(includeRoom ? { AGENT_COORD_INCLUDE_ROOM: "1" } : {}),
      ...(args.allowlist && args.allowlist.length > 0
        ? { AGENT_COORD_ALLOWLIST: args.allowlist.join(",") }
        : {}),
      ...(args.debounceMs ? { AGENT_COORD_DEBOUNCE_MS: String(args.debounceMs) } : {}),
    },
  });
  child.unref();
  const pid = child.pid;
  if (!pid) return { ok: false, error: "spawn returned no pid" };

  // Write pid file (for scripts) and transport marker (for list_agents).
  await fsp.writeFile(pidFile(args.agentId, "pusher"), String(pid), "utf8");
  const marker: TransportMarker = {
    agentId: args.agentId,
    transport: "tmux-push",
    pid,
    tmuxTarget: target,
    since: Date.now(),
  };
  // Use updateJson so it lockfile-protects and creates the file atomically.
  await updateJson<TransportMarker>(transportFile(args.agentId), marker, () => marker);

  // Best-effort scan for a peek-coord.mjs hook wired to the same agentId —
  // both consumers share the cursor file and would race / double-deliver.
  const conflictingHook = await detectPeekCoordHook(args.agentId);

  return {
    ok: true,
    agentId: args.agentId,
    transport: "tmux-push",
    tmuxTarget: target,
    pid,
    log,
    ...(conflictingHook
      ? {
          warnings: [
            `peek-coord.mjs hook for agentId='${args.agentId}' detected in ${conflictingHook}. ` +
              `Running both transports causes double-delivery — disable one. ` +
              `Recommend removing the peek-coord hook entry since tmux-push supersedes it.`,
          ],
        }
      : {}),
  };
}

async function detectPeekCoordHook(agentId: string): Promise<string | undefined> {
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  const candidates = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = await fsp.readFile(file, "utf8");
      if (raw.includes("peek-coord.mjs") && raw.includes(`AGENT_COORD_ID=${agentId}`)) {
        return file;
      }
    } catch {
      // unreadable, skip
    }
  }
  return undefined;
}

export const detachAgentSchema = {
  agentId: z.string().min(1),
};

export async function detachAgentTool(args: { agentId: string }) {
  const marker = await readJson<TransportMarker | null>(transportFile(args.agentId), null);
  let killed = false;
  if (marker && isPidAlive(marker.pid)) {
    try {
      process.kill(marker.pid, "SIGTERM");
      killed = true;
    } catch {
      // already gone
    }
  }
  await deleteFile(transportFile(args.agentId));
  await deleteFile(pidFile(args.agentId, "pusher"));
  return { ok: true, agentId: args.agentId, killed, hadMarker: marker !== null };
}

function resolvePusherPath(): string {
  // tools.js (compiled) lives in dist/; pusher lives in hooks/ at repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "hooks", "tmux-pusher.mjs");
}

// ---------- status / whoami ----------

export const statusSchema = { agentId: z.string().min(1) };

export async function statusTool(args: { agentId: string }) {
  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const entry = reg[args.agentId];
  const transports = await loadLiveTransports();
  const transport = transports.get(args.agentId);
  const inbox = await readJsonl<Message>(inboxFile(args.agentId));
  const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
  const inboxOffset = cursor.inboxOffset ?? 0;
  const unread = Math.max(0, inbox.length - inboxOffset);
  return {
    agentId: args.agentId,
    registered: !!entry,
    entry,
    attached: !!transport,
    transport,
    inboxDepth: inbox.length,
    inboxUnread: unread,
    inTmux: !!process.env.TMUX_PANE,
    tmuxPane: process.env.TMUX_PANE,
  };
}

// ---------- join (combo: register + auto-attach + read inbox) ----------

const joinAttachOptionsSchema = z.object({
  tmuxTarget: z.string().optional(),
  includeRoom: z.boolean().optional(),
  allowlist: z.array(z.string()).optional(),
  debounceMs: z.number().int().positive().max(60_000).optional(),
});

export const joinSchema = {
  agentId: z.string().min(1),
  project: z.string().optional(),
  role: z.string().optional(),
  // attach: undefined → auto-attach if $TMUX_PANE is set; true → always try;
  // false → never; object → attach with overrides.
  attach: z.union([z.boolean(), joinAttachOptionsSchema]).optional(),
  readInbox: z.boolean().optional(),
};

export async function joinTool(args: {
  agentId: string;
  project?: string;
  role?: string;
  attach?: boolean | { tmuxTarget?: string; includeRoom?: boolean; allowlist?: string[]; debounceMs?: number };
  readInbox?: boolean;
}) {
  const reg = await registerTool({
    agentId: args.agentId,
    project: args.project,
    role: args.role,
  });

  // Decide attach behavior.
  const wantAttach = args.attach === false
    ? false
    : args.attach === true || typeof args.attach === "object"
      ? true
      : !!process.env.TMUX_PANE; // undefined → auto-detect

  // Always present as object | null so callers can branch on a single key
  // instead of "did I pass attach?" — per agent-pa's API review.
  let attach: Awaited<ReturnType<typeof attachAgentTool>> | null = null;
  if (wantAttach) {
    const opts = typeof args.attach === "object" ? args.attach : {};
    attach = await attachAgentTool({ agentId: args.agentId, ...opts });
  }

  const readInbox = args.readInbox ?? true;
  let inbox: Awaited<ReturnType<typeof readMessagesTool>> | null = null;
  if (readInbox) {
    inbox = await readMessagesTool({ agentId: args.agentId, source: "inbox" });
  }

  return {
    ok: true,
    registered: reg.agent,
    attached: !!attach && attach.ok !== false,
    attach,
    inbox,
    inTmux: !!process.env.TMUX_PANE,
  };
}

// ---------- room / channel tools ----------

export const listRoomsSchema = {} as const;

export async function listRoomsTool() {
  const reg = await getRooms();
  const rooms = [];
  for (const [room, e] of Object.entries(reg)) {
    const msgs = await readJsonl<Message>(roomFile(room));
    rooms.push({
      room,
      topic: e.topic,
      motd: e.motd,
      members: e.members ?? [],
      memberCount: (e.members ?? []).length,
      messageCount: msgs.length,
      lastTs: msgs.length ? msgs[msgs.length - 1].ts : undefined,
      createdAt: e.createdAt,
      createdBy: e.createdBy,
    });
  }
  return { rooms };
}

export const joinRoomSchema = {
  agentId: z.string().min(1),
  room: z.string().min(1),
};

export async function joinRoomTool(args: { agentId: string; room: string }) {
  const chan = normalizeRoom(args.room);
  await ensureRoom(chan, args.agentId);
  await addMember(chan, args.agentId);
  const reg = await getRooms();
  const e = reg[chan];
  const all = await readJsonl<Message>(roomFile(chan));
  const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
  const unread = Math.max(0, all.length - getOffset(cursor, "room", chan));
  return {
    ok: true,
    room: chan,
    topic: e?.topic,
    motd: e?.motd,
    members: e?.members ?? [],
    unread,
  };
}

export const leaveRoomSchema = {
  agentId: z.string().min(1),
  room: z.string().min(1),
};

export async function leaveRoomTool(args: { agentId: string; room: string }) {
  const chan = normalizeRoom(args.room);
  if (chan === DEFAULT_ROOM) {
    return { ok: false, error: "cannot leave the default channel" };
  }
  await removeMember(chan, args.agentId);
  return { ok: true, room: chan };
}

export const setRoomTopicSchema = {
  agentId: z.string().min(1),
  room: z.string().min(1),
  topic: z.string(),
};

export async function setRoomTopicTool(args: { agentId: string; room: string; topic: string }) {
  const chan = normalizeRoom(args.room);
  await ensureRoom(chan, args.agentId);
  await setRoomMeta(chan, { topic: args.topic }, args.agentId);
  await appendJsonl(roomFile(chan), sysMsg(args.agentId, chan, `changed topic to: ${args.topic}`));
  return { ok: true, room: chan, topic: args.topic };
}

export const setRoomMotdSchema = {
  agentId: z.string().min(1),
  room: z.string().min(1),
  motd: z.string(),
};

export async function setRoomMotdTool(args: { agentId: string; room: string; motd: string }) {
  const chan = normalizeRoom(args.room);
  await ensureRoom(chan, args.agentId);
  await setRoomMeta(chan, { motd: args.motd }, args.agentId);
  await appendJsonl(roomFile(chan), sysMsg(args.agentId, chan, `updated the room rules (MOTD)`));
  return { ok: true, room: chan, motd: args.motd };
}

// ---------- rename_agent (NICK) ----------

export const renameAgentSchema = {
  agentId: z.string().min(1),
  newAgentId: z.string().min(1),
};

export async function renameAgentTool(args: { agentId: string; newAgentId: string }) {
  const oldId = args.agentId;
  const newId = args.newAgentId;
  if (oldId === newId) return { ok: false, error: "new id is identical to the current id" };

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  if (!reg[oldId]) return { ok: false, error: `agent '${oldId}' not registered` };
  if (reg[newId]) return { ok: false, error: `agent '${newId}' already exists` };

  const joined = await memberRooms(oldId);

  // Registry: move the entry under the new key.
  await updateJson<AgentRegistry>(AGENTS_FILE, {}, (current) => {
    if (current[oldId]) {
      current[newId] = { ...current[oldId], agentId: newId };
      delete current[oldId];
    }
    return current;
  });

  // Channel memberships: rename in place.
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
    for (const e of Object.values(current)) {
      if (e.members?.includes(oldId)) e.members = e.members.map((m) => (m === oldId ? newId : m));
    }
    return current;
  });

  // Per-agent files: inbox, cursor, transport marker.
  await moveFile(inboxFile(oldId), inboxFile(newId));
  await moveFile(cursorFile(oldId), cursorFile(newId));
  await moveFile(transportFile(oldId), transportFile(newId));

  // Broadcast a NICK notice to every channel the agent was in.
  for (const chan of joined) {
    await appendJsonl(roomFile(chan), sysMsg(newId, chan, `is now known as ${newId} (was ${oldId})`));
  }

  return { ok: true, from: oldId, to: newId, rooms: joined };
}

// ---------- helpers ----------

async function moveFile(from: string, to: string): Promise<boolean> {
  if (!existsSync(from)) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch {
    // Cross-device or other rename failure — fall back to copy + unlink.
    const data = await fsp.readFile(from);
    await fsp.writeFile(to, data);
    await fsp.unlink(from);
  }
  return true;
}
