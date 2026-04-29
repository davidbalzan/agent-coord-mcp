import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { z } from "zod";
import {
  AGENTS_FILE,
  ROOM_FILE,
  STATUS_FILE,
  appendJsonl,
  cursorFile,
  fileSize,
  inboxFile,
  readJson,
  readJsonl,
  updateJson,
} from "./store.js";

type AgentEntry = {
  agentId: string;
  project?: string;
  role?: string;
  registeredAt: number;
  lastHeartbeat: number;
};

type AgentRegistry = Record<string, AgentEntry>;

type Message = {
  id: string;
  ts: number;
  from: string;
  to?: string;
  room?: string;
  text: string;
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
  roomOffset?: number;
  statusOffset?: number;
};

const STALE_MS = 5 * 60 * 1000;
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
  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const now = Date.now();
  const agents = Object.values(reg).map((a) => ({
    ...a,
    online: now - a.lastHeartbeat < STALE_MS,
    secondsSinceHeartbeat: Math.floor((now - a.lastHeartbeat) / 1000),
  }));
  return { agents };
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
  const msg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: args.from,
    to: args.to,
    room: args.room,
    text: args.text,
  };
  const target = args.to ? inboxFile(args.to) : ROOM_FILE;
  await appendJsonl(target, msg);
  return { ok: true, id: msg.id, target };
}

// ---------- read_messages ----------

export const readMessagesSchema = {
  agentId: z.string().min(1),
  source: z.enum(["inbox", "room", "status"]),
  limit: z.number().int().positive().max(500).optional(),
  peek: z.boolean().optional(),
  sinceTs: z.number().optional(),
};

export async function readMessagesTool(args: {
  agentId: string;
  source: "inbox" | "room" | "status";
  limit?: number;
  peek?: boolean;
  sinceTs?: number;
}) {
  const file = sourceFile(args.source, args.agentId);
  const offsetKey = offsetKeyFor(args.source);
  const all = await readJsonl<Message | StatusEntry>(file);

  let limited: (Message | StatusEntry)[] = [];
  let totalNew = 0;

  if (args.peek) {
    const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
    const startOffset = cursor[offsetKey] ?? 0;
    let entries = all.slice(startOffset);
    if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
    totalNew = entries.length;
    limited = args.limit ? entries.slice(0, args.limit) : entries;
  } else {
    await updateJson<Cursor>(cursorFile(args.agentId), {}, (current) => {
      const startOffset = current[offsetKey] ?? 0;
      let entries = all.slice(startOffset);
      if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
      totalNew = entries.length;
      limited = args.limit ? entries.slice(0, args.limit) : entries;
      if (limited.length > 0) current[offsetKey] = startOffset + limited.length;
      return current;
    });
  }

  return { messages: limited, totalNew, returned: limited.length };
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
  timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
};

export async function waitForMessageTool(args: {
  agentId: string;
  source: "inbox" | "room" | "status";
  timeoutMs?: number;
}) {
  const timeout = Math.min(args.timeoutMs ?? 30_000, MAX_WAIT_MS);
  const file = sourceFile(args.source, args.agentId);
  const startSize = await fileSize(file);

  const result = await new Promise<{ changed: boolean }>((resolve) => {
    let settled = false;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      clearTimeout(t);
      resolve({ changed });
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
    const t = setTimeout(() => finish(false), timeout);
  });

  if (!result.changed) {
    return { ok: false, timedOut: true };
  }
  return readMessagesTool({ agentId: args.agentId, source: args.source });
}

// ---------- helpers ----------

function sourceFile(source: "inbox" | "room" | "status", agentId: string): string {
  if (source === "inbox") return inboxFile(agentId);
  if (source === "room") return ROOM_FILE;
  return STATUS_FILE;
}

function offsetKeyFor(source: "inbox" | "room" | "status"): keyof Cursor {
  if (source === "inbox") return "inboxOffset";
  if (source === "room") return "roomOffset";
  return "statusOffset";
}
