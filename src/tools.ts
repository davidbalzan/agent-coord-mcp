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
  ROOT,
  ROOM_FILE,
  ROOMS_DIR,
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
  rotateAgentToken,
  setRoomMeta,
  transportFile,
  TRANSPORT_DIR,
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
  // Remote pushers run on a different machine; the local pid is meaningless,
  // so we tag the host and use heartbeat-based liveness instead of pidAlive.
  host?: string;
  // mtime of the pusher script the daemon loaded into memory at spawn time
  // (epoch ms). When the on-disk script is upgraded but the daemon isn't
  // restarted, doctor() compares this to the current mtime to flag a stale
  // pusher — the class of bug that silently dropped /clear /compact in v0.8.1.
  // Absent on markers written by older versions (treated as "unknown, skip").
  scriptMtime?: number;
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
  // Control commands (`/clear`, `/compact`) addressed at the agent's CLI, not
  // its operator. The tmux pushers inject these RAW (no banner/prefix) so the
  // TUI runs them as real slash commands; every other consumer ignores them.
  control?: boolean;
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
      capabilities: existing?.capabilities,
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

  // Drop the agent from every channel's membership so it doesn't linger as a
  // ghost in list_rooms / joinedRooms() after it's gone from the registry.
  const leftRooms: string[] = [];
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
    for (const [chan, e] of Object.entries(current)) {
      if (e.members?.includes(args.agentId)) {
        e.members = e.members.filter((m) => m !== args.agentId);
        leftRooms.push(chan);
      }
    }
    return current;
  });
  return { ok: true, removed: existed, detach, leftRooms };
}

// ---------- quit ----------
// Clean shutdown: unregister (detach transport + leave rooms + remove registry
// entry) then exit the MCP process. Only the bound identity can call this —
// prevents one agent from killing another agent's session.

export const quitSchema = { agentId: z.string().min(1) };

export async function quitTool(args: { agentId: string }): Promise<never> {
  await unregisterTool(args);
  // Give stdio a moment to flush the JSON response before exiting
  setTimeout(() => process.exit(0), 150);
  // Return a result so the MCP framework sends the response before the
  // setTimeout fires — the caller will see this before the process dies.
  return { ok: true, message: `'${args.agentId}' unregistered — MCP process exiting` } as never;
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
  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const now = Date.now();
  for (const fname of await listTransportFiles()) {
    const file = path.join(TRANSPORT_DIR, fname);
    const marker = await readJson<TransportMarker | null>(file, null);
    if (!marker || !isMarkerLive(marker, reg, now)) {
      await deleteFile(file);
      continue;
    }
    out.set(marker.agentId, marker);
  }
  return out;
}

// Liveness for a transport marker. Local markers carry a real pid we can probe;
// remote markers (tmux-push-remote, pid 0 on a foreign host) can't be — so we
// trust the registry heartbeat the remote pusher refreshes (within STALE_MS).
function isMarkerLive(marker: TransportMarker, reg: AgentRegistry, now: number): boolean {
  if (marker.transport === "tmux-push-remote") {
    const entry = reg[marker.agentId];
    return !!entry && now - entry.lastHeartbeat < STALE_MS;
  }
  return isPidAlive(marker.pid);
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
    // Offline delivery is intentional (the inbox is created on demand), but a
    // typo'd recipient shouldn't vanish silently — surface a warning when the
    // target isn't a known agent so the caller can catch the mistake.
    const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
    const warning = reg[args.to]
      ? undefined
      : `recipient '${args.to}' is not a registered agent — message stored in their inbox but no one may be listening`;
    return { ok: true, id: msg.id, target, room: undefined, warning };
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

// ---------- send_command (context-management control commands) ----------

// The only slash commands a lead may inject into a sub-agent's CLI. Locked on
// purpose: these wipe/compact context (cheap, reversible-by-the-agent), nothing
// that mutates the repo or the bus. Stored WITHOUT the leading slash; the wire
// text is `/${cmd}`.
export const CONTROL_COMMANDS = ["clear", "compact"] as const;

// Transports whose pusher can actually TYPE a slash command into a live CLI.
// A control command is meaningless to a plain MCP poller, so send_command is
// gated to agents currently attached over one of these.
const TMUX_TRANSPORTS = new Set(["tmux-push", "tmux-push-remote"]);

// Normalize "clear" / "/clear" / "  /Clear " → "clear"; null if not allowlisted.
function normalizeControlCommand(raw: string): string | null {
  const c = raw.trim().replace(/^\/+/, "").toLowerCase();
  return (CONTROL_COMMANDS as readonly string[]).includes(c) ? c : null;
}

// Live transports filtered to the tmux-push family (local + remote).
async function liveTmuxTargets(): Promise<Map<string, TransportMarker>> {
  const all = await loadLiveTransports();
  const out = new Map<string, TransportMarker>();
  for (const [id, m] of all) if (TMUX_TRANSPORTS.has(m.transport)) out.set(id, m);
  return out;
}

export const sendCommandSchema = {
  from: z.string().min(1),
  to: z.string().optional(),
  room: z.string().optional(),
  command: z.string().min(1),
  // Default 3000ms. After /clear, schedules an identity-reminder DM to each
  // recipient so a freshly-wiped worker re-anchors on its agentId and bus
  // attach state. Set 0 to opt out. Ignored for non-/clear commands.
  reminderMs: z.number().int().min(0).max(60_000).optional(),
  // Override the auto-generated reminder body if you want something specific.
  reminderText: z.string().optional(),
};

function defaultReminderText(agentId: string): string {
  return (
    `[agent-coord] context reset by /clear. ` +
    `Your bus identity is '${agentId}'. You remain registered and attached — call ` +
    `status({agentId:"${agentId}"}) to re-orient (role, transport, unread) and ` +
    `list_rooms() for the channels you're in. Any DM or channel post you receive ` +
    `next is your new task context.`
  );
}

function scheduleReminders(
  from: string,
  recipients: string[],
  delayMs: number,
  override: string | undefined,
): void {
  const t = setTimeout(async () => {
    for (const r of recipients) {
      try {
        const reminder: Message = {
          id: randomUUID(),
          ts: Date.now(),
          from,
          to: r,
          text: override ?? defaultReminderText(r),
        };
        await appendJsonl(inboxFile(r), reminder);
      } catch (e) {
        process.stderr.write(
          `[send_command] post-/clear reminder to '${r}' failed: ${(e as Error)?.message ?? e}\n`,
        );
      }
    }
  }, delayMs);
  // Don't keep the event loop alive solely for the reminder — the MCP server's
  // transport already holds it open as long as it's connected.
  if (typeof t.unref === "function") t.unref();
}

// Inject a context-management slash command into a sub-agent's live tmux
// session. Writes a control-flagged message the pushers deliver RAW (no banner,
// no `[DM …]` prefix) so the receiving CLI runs it as a real slash command.
// Hard-gated to tmux: refuses unless the target(s) have a live tmux-push(-remote)
// transport, so a command never rots unexecuted in an offline inbox.
export async function sendCommandTool(args: {
  from: string;
  to?: string;
  room?: string;
  command: string;
  reminderMs?: number;
  reminderText?: string;
}) {
  const cmd = normalizeControlCommand(args.command);
  if (!cmd) {
    return {
      ok: false,
      error: `unsupported command '${args.command}'. Allowed: ${CONTROL_COMMANDS.map((c) => "/" + c).join(", ")}`,
    };
  }
  if (!args.to && !args.room) {
    return { ok: false, error: "specify 'to' (a single agent) or 'room' (a channel's tmux-attached members)" };
  }
  if (args.to && args.room) {
    return { ok: false, error: "specify only one of 'to' or 'room'" };
  }

  const text = `/${cmd}`;
  const liveTmux = await liveTmuxTargets();

  // DM: target must itself be tmux-attached.
  if (args.to) {
    const marker = liveTmux.get(args.to);
    if (!marker) {
      return {
        ok: false,
        error: `'${args.to}' has no live tmux-push transport — control commands can only be injected into a tmux session. Attach it (join/attach_agent) or target an attached agent.`,
      };
    }
    const msg: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: args.from,
      to: args.to,
      text,
      control: true,
    };
    const target = inboxFile(args.to);
    await appendJsonl(target, msg);
    // After /clear the receiver forgets its identity and that it's bus-attached
    // (the system prompt isn't re-applied because /clear isn't a session
    // start). Schedule a follow-up DM as a re-anchor; opt out with reminderMs:0.
    const reminderMs = cmd === "clear" ? args.reminderMs ?? 3000 : 0;
    if (reminderMs > 0) scheduleReminders(args.from, [args.to], reminderMs, args.reminderText);
    return {
      ok: true,
      id: msg.id,
      command: text,
      target,
      delivered: [args.to],
      transport: marker.transport,
      ...(reminderMs > 0 ? { reminderScheduled: { delayMs: reminderMs, recipients: [args.to] } } : {}),
    };
  }

  // Room: broadcast to every tmux-attached member (never the sender itself).
  const chan = normalizeRoom(args.room);
  const rooms = await getRooms();
  const members = rooms[chan]?.members ?? [];
  const delivered = members.filter((m) => m !== args.from && liveTmux.has(m));
  if (delivered.length === 0) {
    return {
      ok: false,
      error: `no tmux-attached members in #${chan} to receive '${text}' (${members.length} member(s) total). Control commands only fire in a live tmux session.`,
    };
  }
  const skipped = members.filter((m) => m !== args.from && !liveTmux.has(m));
  const msg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: args.from,
    room: chan,
    text,
    control: true,
  };
  const target = roomFile(chan);
  await appendJsonl(target, msg);
  // Same post-/clear re-anchor as the DM path — one reminder per delivered
  // member, in their own inbox, with their own agentId in the body.
  const reminderMs = cmd === "clear" ? args.reminderMs ?? 3000 : 0;
  if (reminderMs > 0) scheduleReminders(args.from, delivered, reminderMs, args.reminderText);
  return {
    ok: true,
    id: msg.id,
    command: text,
    target,
    room: chan,
    delivered,
    skipped: skipped.length ? skipped : undefined,
    ...(reminderMs > 0 ? { reminderScheduled: { delayMs: reminderMs, recipients: delivered } } : {}),
  };
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

  // Room reads default to 50 messages to prevent agents flooding themselves
  // with full channel history on join. Inbox and status drain fully by default
  // since they are targeted/bounded by nature.
  const effectiveLimit = args.limit ?? (args.source === "room" ? 50 : undefined);

  if (args.peek) {
    const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
    const startOffset = getOffset(cursor, args.source, args.room);
    let entries = all.slice(startOffset);
    if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
    totalNew = entries.length;
    limited = effectiveLimit ? entries.slice(0, effectiveLimit) : entries;
  } else {
    await updateJson<Cursor>(cursorFile(args.agentId), {}, (current) => {
      const startOffset = getOffset(current, args.source, args.room);
      let entries = all.slice(startOffset);
      if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
      totalNew = entries.length;
      limited = effectiveLimit ? entries.slice(0, effectiveLimit) : entries;
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
    ok: true,
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
    const rooms = await getRooms();
    const orphanMembers = new Set<string>();
    for (const e of Object.values(rooms)) {
      for (const m of e.members ?? []) if (!knownAgents.has(m)) orphanMembers.add(m);
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
        orphanMembers: [...orphanMembers],
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

  // Compact channel memberships: drop any member no longer in the registry so
  // list_rooms / joinedRooms() stop surfacing ghosts (mirrors orphan-inbox
  // cleanup). Empty non-default channels are left in place — their history may
  // still matter and `general` must always persist.
  const orphanMembers = new Set<string>();
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
    for (const e of Object.values(current)) {
      const before = e.members?.length ?? 0;
      if (before === 0) continue;
      e.members = (e.members ?? []).filter((m) => {
        const keep = knownAgents.has(m);
        if (!keep) orphanMembers.add(m);
        return keep;
      });
    }
    return current;
  });

  return {
    dryRun: false,
    cutoff,
    olderThanDays: days,
    removed: {
      roomMessages: roomRemovedTotal,
      statusEntries: statusResult.removed,
      inboxMessages: inboxRemoved,
      orphanInboxes: deletedOrphans,
      orphanMembers: [...orphanMembers],
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
  const logFd = openSync(log, "a");
  // Default: deliver room broadcasts too. The bus is chat-first — silence on
  // a room post is a worse failure mode than a slightly noisier pane. Callers
  // who want DM-only can pass includeRoom:false explicitly.
  const includeRoom = args.includeRoom !== false;
  // Use the exact node binary running this server, not bare "node" — the MCP
  // server is often launched via an absolute path (nvm/Homebrew/bundled
  // runtime) that isn't on the spawned child's PATH, which would silently fail
  // the pusher launch ("attached but nothing arrives").
  const child = spawn(process.execPath, [pusher], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
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
  // Stamp the script's mtime so doctor() can flag a stale daemon if it
  // outlives a later upgrade of the on-disk script (see v0.8.1 → v0.8.2 bug
  // report: control commands silently dropped by pre-v0.8 in-memory code).
  let scriptMtime: number | undefined;
  try { scriptMtime = (await fsp.stat(pusher)).mtimeMs; } catch { /* non-fatal */ }
  const marker: TransportMarker = {
    agentId: args.agentId,
    transport: "tmux-push",
    pid,
    tmuxTarget: target,
    since: Date.now(),
    scriptMtime,
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

  // Surface the default channel's topic + MOTD (room rules) in the same
  // round-trip, so a connecting agent sees them without a separate call.
  const rooms = await getRooms();
  const def = rooms[DEFAULT_ROOM];

  return {
    ok: true,
    registered: reg.agent,
    attached: !!attach && attach.ok !== false,
    attach,
    inbox,
    defaultRoom: { room: DEFAULT_ROOM, topic: def?.topic, motd: def?.motd },
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
  await appendJsonl(roomFile(chan), sysMsg(args.agentId, chan, `${args.agentId} has joined`));
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

  // A running pusher has the OLD agentId (and its file paths) baked into its
  // env, so after we migrate the inbox/cursor below it would keep tailing the
  // now-empty old inbox while new DMs land in the new one — silently breaking
  // delivery and orphaning the moved marker. Take it down first; the caller
  // must re-attach under the new id (join/attach_agent) to restore push.
  const liveTransport = await readJson<TransportMarker | null>(transportFile(oldId), null);
  let detachedTransport = false;
  if (liveTransport && isPidAlive(liveTransport.pid)) {
    await detachAgentTool({ agentId: oldId });
    detachedTransport = true;
  }

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

  // Per-agent files: inbox, cursor. (The transport marker was already removed
  // above if a pusher was live; nothing to move otherwise.)
  await moveFile(inboxFile(oldId), inboxFile(newId));
  await moveFile(cursorFile(oldId), cursorFile(newId));
  await moveFile(transportFile(oldId), transportFile(newId));

  // Identity-binding token rotation: if tokens.json exists and had the old
  // id, move its token to the new id atomically. Lets the same bearer keep
  // authenticating after rename — no-op if binding isn't configured.
  await rotateAgentToken(oldId, newId);

  // Broadcast a NICK notice to every channel the agent was in.
  for (const chan of joined) {
    await appendJsonl(roomFile(chan), sysMsg(newId, chan, `is now known as ${newId} (was ${oldId})`));
  }

  return {
    ok: true,
    from: oldId,
    to: newId,
    rooms: joined,
    detachedTransport,
    ...(detachedTransport
      ? { warning: `the live tmux-push transport was detached during rename — re-attach as '${newId}' (e.g. join/attach_agent) to restore real-time delivery` }
      : {}),
  };
}

// ---------- transport markers (for remote pushers) ----------

export const reportTransportSchema = {
  agentId: z.string().min(1),
  transport: z.string().min(1),
  tmuxTarget: z.string().optional(),
  host: z.string().optional(),
  since: z.number().optional(),
  // mtime of the script the remote daemon loaded into memory at spawn time
  // (epoch ms). Lets doctor() flag the remote pusher as stale if its on-disk
  // counterpart has been upgraded since. The remote pusher passes
  // `(await fsp.stat(__filename)).mtimeMs`; absent → doctor skips the check.
  scriptMtime: z.number().optional(),
};

// Called by an external push daemon (typically scripts/coord-pusher.mjs on a
// remote machine) to publish a transport marker so list_agents reflects the
// attachment. The local tmux-push path writes the marker directly inside
// attach_agent; this is the wire-callable equivalent for remote pushers.
export async function reportTransportTool(args: {
  agentId: string;
  transport: string;
  tmuxTarget?: string;
  host?: string;
  since?: number;
  scriptMtime?: number;
}) {
  const marker: TransportMarker = {
    agentId: args.agentId,
    transport: args.transport,
    pid: 0, // not meaningful for remote; liveness comes from heartbeat
    tmuxTarget: args.tmuxTarget,
    host: args.host,
    since: args.since ?? Date.now(),
    scriptMtime: args.scriptMtime,
  };
  await updateJson<TransportMarker>(transportFile(args.agentId), marker, () => marker);
  return { ok: true, marker };
}

export const clearTransportSchema = {
  agentId: z.string().min(1),
};

// Idempotent remote-counterpart to detach_agent: just deletes the marker. Used
// by the remote pusher on graceful shutdown so list_agents stops showing it
// attached. (Does NOT try to kill any process — there's nothing local to kill.)
export async function clearTransportTool(args: { agentId: string }) {
  const removed = await deleteFile(transportFile(args.agentId));
  return { ok: true, removed };
}

// ---------- doctor (bus-wide health check) ----------

type DoctorLevel = "ok" | "warn" | "error";
type DoctorFinding = {
  check: string;
  level: DoctorLevel;
  detail: string;
  fixable: boolean;
  items?: string[];
};

// Count non-empty lines vs successfully-parsed entries in a JSONL file.
// Offsets index the PARSED entries (see readJsonl), so `parsed` is the figure
// cursor math is compared against; `malformed` is the desync risk.
async function scanJsonl(file: string): Promise<{ lines: number; parsed: number; malformed: number }> {
  if (!existsSync(file)) return { lines: 0, parsed: 0, malformed: 0 };
  const raw = await fsp.readFile(file, "utf8");
  let lines = 0;
  let parsed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      JSON.parse(line);
      parsed++;
    } catch {
      // malformed
    }
  }
  return { lines, parsed, malformed: lines - parsed };
}

// Find leftover proper-lockfile lock dirs (`<file>.lock`) across the state
// dirs. Anything older than the threshold is almost certainly orphaned by a
// crashed writer (withLock's stale window is 5s).
async function scanStaleLocks(olderThanMs: number, now: number): Promise<{ path: string; ageMs: number }[]> {
  const out: { path: string; ageMs: number }[] = [];
  const dirs = [ROOT, INBOX_DIR, CURSOR_DIR, ROOMS_DIR, TRANSPORT_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      const p = path.join(dir, name);
      try {
        const st = await fsp.stat(p);
        const ageMs = now - st.mtimeMs;
        if (ageMs > olderThanMs) out.push({ path: p, ageMs });
      } catch {
        // vanished mid-scan
      }
    }
  }
  return out;
}

export const doctorSchema = {
  fix: z.boolean().optional(),
  maxFileBytes: z.number().int().positive().optional(),
};

export async function doctorTool(args: { fix?: boolean; maxFileBytes?: number }) {
  const fix = args.fix ?? false;
  const maxBytes = args.maxFileBytes ?? 5 * 1024 * 1024;
  const now = Date.now();
  const findings: DoctorFinding[] = [];
  const fixed: string[] = [];

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const known = new Set(Object.keys(reg));
  const rooms = await getRooms();
  const channels = Object.keys(rooms);

  // 1. Orphan transport markers (dead local pid, or stale remote heartbeat).
  {
    const dead: string[] = [];
    for (const fname of await listTransportFiles()) {
      const file = path.join(TRANSPORT_DIR, fname);
      const marker = await readJson<TransportMarker | null>(file, null);
      if (!marker || !isMarkerLive(marker, reg, now)) {
        dead.push(file);
        if (fix) {
          await deleteFile(file);
          fixed.push(`deleted stale transport marker ${fname}`);
        }
      }
    }
    findings.push({
      check: "orphan-transport-markers",
      level: dead.length ? "warn" : "ok",
      detail: dead.length ? `${dead.length} stale transport marker(s) (dead pid or expired remote heartbeat)` : "no stale transport markers",
      fixable: true,
      items: dead.length ? dead.map((f) => path.basename(f)) : undefined,
    });
  }

  // 1b. Stale pusher daemons — a long-running pusher loaded its script into
  //     memory at spawn time, so when the on-disk script is later upgraded
  //     (npm i -g a new version), the still-running pid is on the OLD code.
  //     Pre-v0.8.2 pushers had no `control:true` awareness and silently
  //     dropped /clear /compact at the slash-guard — ack:true with no
  //     keystrokes ever reaching the pane. Comparing the marker's stamped
  //     scriptMtime against the on-disk script's current mtime catches it.
  //     Local tmux-push only — for tmux-push-remote the script lives on a
  //     different host so we can't stat it from here.
  {
    let localPusherMtime: number | undefined;
    try { localPusherMtime = (await fsp.stat(resolvePusherPath())).mtimeMs; } catch { /* not packaged? skip */ }
    const stale: string[] = [];
    for (const fname of await listTransportFiles()) {
      const file = path.join(TRANSPORT_DIR, fname);
      const marker = await readJson<TransportMarker | null>(file, null);
      if (!marker || !isMarkerLive(marker, reg, now)) continue;
      if (marker.transport !== "tmux-push") continue; // remote = can't verify
      if (marker.scriptMtime === undefined) continue; // pre-v0.8.2 marker, no info
      if (localPusherMtime === undefined) continue;
      if (marker.scriptMtime < localPusherMtime - 1) { // -1ms slack for fs mtime rounding
        const loaded = new Date(marker.scriptMtime).toISOString();
        const ondisk = new Date(localPusherMtime).toISOString();
        stale.push(`${marker.agentId} (pid ${marker.pid}, loaded ${loaded}, on-disk now ${ondisk})`);
      }
    }
    findings.push({
      check: "stale-pusher-script",
      level: stale.length ? "warn" : "ok",
      detail: stale.length
        ? `${stale.length} attached pusher(s) running pre-upgrade code — control commands (/clear, /compact) may be silently dropped. Run detach_agent + attach_agent for each, or have the agent relaunch.`
        : "all attached pushers are running the current on-disk script",
      fixable: false,
      items: stale.length ? stale : undefined,
    });
  }

  // 2. Orphan room memberships (member not in the registry).
  {
    const orphans = new Set<string>();
    for (const e of Object.values(rooms)) {
      for (const m of e.members ?? []) if (!known.has(m)) orphans.add(m);
    }
    if (fix && orphans.size) {
      await updateJson<RoomRegistry>(ROOMS_FILE, {}, (cur) => {
        for (const e of Object.values(cur)) {
          if (e.members?.length) e.members = e.members.filter((m) => known.has(m));
        }
        return cur;
      });
      fixed.push(`dropped ${orphans.size} orphan membership(s): ${[...orphans].join(", ")}`);
    }
    findings.push({
      check: "orphan-room-memberships",
      level: orphans.size ? "warn" : "ok",
      detail: orphans.size ? `${orphans.size} channel member(s) not in the registry` : "all channel members are registered",
      fixable: true,
      items: orphans.size ? [...orphans] : undefined,
    });
  }

  // 3. Orphan inbox / cursor files (owner not registered).
  {
    const orphanInbox: string[] = [];
    for (const fname of await listInboxFiles()) {
      const id = fname.replace(/\.jsonl$/, "");
      if (!known.has(id)) {
        orphanInbox.push(id);
        if (fix) {
          await deleteFile(path.join(INBOX_DIR, fname));
          fixed.push(`deleted orphan inbox ${fname}`);
        }
      }
    }
    const orphanCursor: string[] = [];
    for (const fname of await listCursorFiles()) {
      const id = fname.replace(/\.json$/, "");
      if (!known.has(id)) {
        orphanCursor.push(id);
        if (fix) {
          await deleteFile(path.join(CURSOR_DIR, fname));
          fixed.push(`deleted orphan cursor ${fname}`);
        }
      }
    }
    const total = orphanInbox.length + orphanCursor.length;
    findings.push({
      check: "orphan-inboxes-cursors",
      level: total ? "warn" : "ok",
      detail: total
        ? `${orphanInbox.length} inbox + ${orphanCursor.length} cursor file(s) for unregistered ids`
        : "no orphan inbox/cursor files",
      fixable: true,
      items: total ? [...new Set([...orphanInbox, ...orphanCursor])] : undefined,
    });
  }

  // Precompute parsed line counts for cursor + malformed checks.
  const counts = new Map<string, { lines: number; parsed: number; malformed: number }>();
  const countFor = async (file: string) => {
    if (!counts.has(file)) counts.set(file, await scanJsonl(file));
    return counts.get(file)!;
  };

  // 4. Cursor offsets past end-of-file (would return [] forever).
  {
    const broken: string[] = [];
    for (const fname of await listCursorFiles()) {
      const id = fname.replace(/\.json$/, "");
      const cursorPath = path.join(CURSOR_DIR, fname);
      const cursor = await readJson<Cursor>(cursorPath, {});
      const overflow: string[] = [];
      const inboxMax = (await countFor(inboxFile(id))).parsed;
      if ((cursor.inboxOffset ?? 0) > inboxMax) overflow.push(`inboxOffset ${cursor.inboxOffset}>${inboxMax}`);
      const roomMax = (await countFor(ROOM_FILE)).parsed;
      if ((cursor.roomOffset ?? 0) > roomMax) overflow.push(`roomOffset ${cursor.roomOffset}>${roomMax}`);
      const statusMax = (await countFor(STATUS_FILE)).parsed;
      if ((cursor.statusOffset ?? 0) > statusMax) overflow.push(`statusOffset ${cursor.statusOffset}>${statusMax}`);
      for (const [chan, off] of Object.entries(cursor.roomOffsets ?? {})) {
        const max = (await countFor(roomFile(chan))).parsed;
        if (off > max) overflow.push(`roomOffsets[${chan}] ${off}>${max}`);
      }
      if (overflow.length) {
        broken.push(`${id}: ${overflow.join(", ")}`);
        if (fix) {
          await updateJson<Cursor>(cursorPath, {}, (c) => {
            if ((c.inboxOffset ?? 0) > inboxMax) c.inboxOffset = inboxMax;
            if ((c.roomOffset ?? 0) > roomMax) c.roomOffset = roomMax;
            if ((c.statusOffset ?? 0) > statusMax) c.statusOffset = statusMax;
            if (c.roomOffsets) {
              for (const chan of Object.keys(c.roomOffsets)) {
                const max = counts.get(roomFile(chan))?.parsed ?? 0;
                if (c.roomOffsets[chan] > max) c.roomOffsets[chan] = max;
              }
            }
            return c;
          });
          fixed.push(`clamped cursor offsets for ${id}`);
        }
      }
    }
    findings.push({
      check: "cursor-past-eof",
      level: broken.length ? "error" : "ok",
      detail: broken.length ? `${broken.length} cursor(s) with an offset past EOF — delivery stalled` : "all cursor offsets are within bounds",
      fixable: true,
      items: broken.length ? broken : undefined,
    });
  }

  // 5. Malformed JSONL lines (silently desync offset math between server + hooks).
  {
    const jsonlFiles = [
      ROOM_FILE,
      STATUS_FILE,
      ...channels.filter((c) => c !== DEFAULT_ROOM).map((c) => roomFile(c)),
      ...(await listInboxFiles()).map((f) => path.join(INBOX_DIR, f)),
    ];
    const bad: string[] = [];
    for (const file of jsonlFiles) {
      const c = await countFor(file);
      if (c.malformed > 0) {
        bad.push(`${path.basename(file)} (${c.malformed})`);
        if (fix) {
          await fsp.copyFile(file, file + ".bak");
          await rewriteJsonl(file, () => true); // drops unparseable lines
          fixed.push(`rewrote ${path.basename(file)} dropping ${c.malformed} malformed line(s) (backup: ${path.basename(file)}.bak)`);
        }
      }
    }
    findings.push({
      check: "malformed-jsonl",
      level: bad.length ? "warn" : "ok",
      detail: bad.length ? `${bad.length} file(s) contain unparseable lines` : "no malformed JSONL lines",
      fixable: true,
      items: bad.length ? bad : undefined,
    });
  }

  // 6. Stale agents (registered, no live transport, heartbeat past EVICT_MS). Report only.
  {
    // Compute liveness WITHOUT deleting dead markers — loadLiveTransports
    // prunes as a side effect, which would make this read-only check mutate
    // state (and pre-empt the orphan-marker fix in check 1).
    const live = new Set<string>();
    for (const fname of await listTransportFiles()) {
      const marker = await readJson<TransportMarker | null>(path.join(TRANSPORT_DIR, fname), null);
      if (marker && isMarkerLive(marker, reg, now)) live.add(marker.agentId);
    }
    const stale: string[] = [];
    for (const [id, a] of Object.entries(reg)) {
      if (live.has(id)) continue;
      if (now - a.lastHeartbeat > EVICT_MS) stale.push(`${id} (${Math.floor((now - a.lastHeartbeat) / 3600000)}h)`);
    }
    findings.push({
      check: "stale-agents",
      level: stale.length ? "warn" : "ok",
      detail: stale.length ? `${stale.length} agent(s) past the eviction window — next list_agents will drop them` : "no stale agents",
      fixable: false,
      items: stale.length ? stale : undefined,
    });
  }

  // 7. Oversized JSONL files. Report only (suggest prune).
  {
    const big: string[] = [];
    const candidates = [
      ROOM_FILE,
      STATUS_FILE,
      ...channels.filter((c) => c !== DEFAULT_ROOM).map((c) => roomFile(c)),
      ...(await listInboxFiles()).map((f) => path.join(INBOX_DIR, f)),
    ];
    for (const file of candidates) {
      const sz = await fileSize(file);
      if (sz > maxBytes) big.push(`${path.basename(file)} (${(sz / 1024 / 1024).toFixed(1)}MB)`);
    }
    findings.push({
      check: "oversized-files",
      level: big.length ? "warn" : "ok",
      detail: big.length ? `${big.length} file(s) over ${(maxBytes / 1024 / 1024).toFixed(0)}MB — consider prune` : "no oversized files",
      fixable: false,
      items: big.length ? big : undefined,
    });
  }

  // 8. Stale lock dirs from crashed writers.
  {
    const locks = await scanStaleLocks(60_000, now);
    for (const l of locks) {
      if (fix) {
        try {
          await fsp.rm(l.path, { recursive: true, force: true });
          fixed.push(`removed stale lock ${path.basename(l.path)}`);
        } catch {
          // ignore
        }
      }
    }
    findings.push({
      check: "stale-locks",
      level: locks.length ? "warn" : "ok",
      detail: locks.length ? `${locks.length} lock dir(s) older than 60s — likely from a crashed writer` : "no stale locks",
      fixable: true,
      items: locks.length ? locks.map((l) => `${path.basename(l.path)} (${Math.floor(l.ageMs / 1000)}s)`) : undefined,
    });
  }

  // 9. Channel/registry consistency: rooms/<chan>.jsonl files without a registry entry.
  {
    const orphanFiles: string[] = [];
    if (existsSync(ROOMS_DIR)) {
      let names: string[] = [];
      try {
        names = await fsp.readdir(ROOMS_DIR);
      } catch {
        // ignore
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const chan = name.replace(/\.jsonl$/, "");
        if (!rooms[chan]) {
          orphanFiles.push(name);
          if (fix) {
            await ensureRoom(chan, "doctor");
            fixed.push(`registered channel '${chan}' (had a JSONL file but no registry entry)`);
          }
        }
      }
    }
    findings.push({
      check: "channel-registry-consistency",
      level: orphanFiles.length ? "warn" : "ok",
      detail: orphanFiles.length ? `${orphanFiles.length} channel file(s) with no registry entry` : "channel files and registry agree",
      fixable: true,
      items: orphanFiles.length ? orphanFiles : undefined,
    });
  }

  // 10. Environment sanity. Report only.
  {
    const tmuxProbe = spawnSync("tmux", ["-V"]);
    const tmuxOk = tmuxProbe.status === 0;
    findings.push({
      check: "environment",
      level: tmuxOk ? "ok" : "warn",
      detail: tmuxOk
        ? `root=${ROOT}; node=${process.execPath}; tmux=${(tmuxProbe.stdout ?? "").toString().trim() || "present"}`
        : `root=${ROOT}; node=${process.execPath}; tmux NOT on PATH — the tmux-push transport will not work`,
      fixable: false,
      items: [`root=${ROOT}`, `execPath=${process.execPath}`, `inTmux=${!!process.env.TMUX_PANE}`],
    });
  }

  const summary = {
    ok: findings.filter((f) => f.level === "ok").length,
    warn: findings.filter((f) => f.level === "warn").length,
    error: findings.filter((f) => f.level === "error").length,
  };
  return {
    ok: true,
    healthy: summary.warn === 0 && summary.error === 0,
    fixApplied: fix,
    root: ROOT,
    findings,
    fixed: fix ? fixed : undefined,
    summary,
  };
}

// ---------- delete_room ----------

export const deleteRoomSchema = {
  agentId: z.string().min(1),
  room: z.string().min(1),
  // When true, kick remaining members instead of refusing.
  force: z.boolean().optional(),
};

export async function deleteRoomTool(args: { agentId: string; room: string; force?: boolean }) {
  const chan = normalizeRoom(args.room);
  if (chan === DEFAULT_ROOM) return { ok: false, error: "cannot delete the default channel" };

  const rooms = await getRooms();
  const entry = rooms[chan];
  if (!entry) return { ok: false, error: `room '${chan}' does not exist` };

  const members = entry.members ?? [];
  if (members.length > 0 && !args.force) {
    return {
      ok: false,
      error: `room '${chan}' still has ${members.length} member(s): ${members.join(", ")}. Pass force=true to delete anyway.`,
      members,
    };
  }

  // Remove from rooms registry.
  await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
    delete current[chan];
    return current;
  });

  // Delete the backing JSONL file.
  const file = roomFile(chan);
  const fileDeleted = await deleteFile(file);

  // Drop the channel offset from every agent's cursor so no offset points into
  // a now-deleted file.
  const cursorsAdjusted: string[] = [];
  for (const fname of await listCursorFiles()) {
    const id = fname.replace(/\.json$/, "");
    const cursorPath = path.join(CURSOR_DIR, fname);
    let touched = false;
    await updateJson<Cursor>(cursorPath, {}, (current) => {
      if (current.roomOffsets?.[chan] !== undefined) {
        delete current.roomOffsets[chan];
        touched = true;
      }
      return current;
    });
    if (touched) cursorsAdjusted.push(id);
  }

  await appendJsonl(ROOM_FILE, sysMsg(args.agentId, DEFAULT_ROOM, `deleted channel #${chan}`));
  return { ok: true, room: chan, fileDeleted, members, cursorsAdjusted };
}

// ---------- force_unregister ----------

export const forceUnregisterSchema = {
  targetAgentId: z.string().min(1),
};

// Admin eviction — same logic as unregister but bypasses the identity gate
// so the caller does not need to be the target agent.
export async function forceUnregisterTool(args: { targetAgentId: string }) {
  return unregisterTool({ agentId: args.targetAgentId });
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
