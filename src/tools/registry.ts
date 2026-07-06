import { detachAgentTool } from "./transport.js";
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
  receiptFile,
  listReceiptFiles,
  removeMember,
  rewriteJsonl,
  roomFile,
  rotateAgentToken,
  setRoomMeta,
  stashHistory,
  retrieveHistory,
  pruneHistory,
  transportFile,
  TRANSPORT_DIR,
  updateJson,
  type RoomRegistry,
} from "../store.js";
import {
  type AgentEntry,
  type AgentRegistry,
  type Message,
  type StatusEntry,
  type Cursor,
  type Source,
  type TransportMarker,
  sourceFile,
  getOffset,
  setOffset,
  sysMsg,
  moveFile,
  STALE_MS,
  EVICT_MS,
  MAX_WAIT_MS,
} from "./shared.js";

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

export async function loadLiveTransports(): Promise<Map<string, TransportMarker>> {
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
export function isMarkerLive(marker: TransportMarker, reg: AgentRegistry, now: number): boolean {
  if (marker.transport === "tmux-push-remote") {
    const entry = reg[marker.agentId];
    return !!entry && now - entry.lastHeartbeat < STALE_MS;
  }
  return isPidAlive(marker.pid);
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM = exists but not ours; ESRCH = gone
  }
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

// ---------- force_unregister ----------

export const forceUnregisterSchema = {
  targetAgentId: z.string().min(1),
};

// Admin eviction — same logic as unregister but bypasses the identity gate
// so the caller does not need to be the target agent.
export async function forceUnregisterTool(args: { targetAgentId: string }) {
  return unregisterTool({ agentId: args.targetAgentId });
}

