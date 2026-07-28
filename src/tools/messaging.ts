import { adjustCursors } from "./admin.js";
import {
  COORDINATOR_ROLE_IDS,
  GATE_RUNNER_ROLE_IDS,
  resolveRole,
  roleMatches,
} from "../roles.js";
import { ARCHIVE_STATUS_FILE, archiveJsonl, archiveRoomFile } from "../store.js";
import { randomUUID } from "node:crypto";
import { existsSync, openSync, watch } from "node:fs";
import { promises as fsp } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { renderRecord } from "./render.js";
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
  type MessageRecord,
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

// ---------- send_message ----------

// Typed protocol record (Phase 8). Additive: omitting it reproduces v1
// behavior exactly.
const citationSchema = z.object({
  kind: z.enum(["pr", "file", "commit", "url"]),
  ref: z.string().min(1),
});

// Payloads are LOOSE objects: a v3 sender's extra keys ride through to disk
// untouched rather than being silently stripped. That is safe precisely
// because payload is nested — it is caller data, and nothing in it is ever
// read as a top-level Message field (which is what keeps a forged `tag` or
// `urgent` out; see the source-level lock in test/tier.test.mjs).
const summaryPayload = z.looseObject({ summary: z.string().min(1) });

// All five fields, or none. A `decision` carrying three of them is
// structurally wrong for the type it claims — and would render as a truncated
// packet, which is worse than no packet.
const decisionPayload = z.looseObject({
  title: z.string().min(1),
  context: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  recommendation: z.string().min(1),
  ifNoAction: z.string().min(1),
});

const verdictPayload = z.looseObject({
  result: z.enum(["pass", "fail"]),
  headRefOid: z.string().min(1),
  notes: z.string().optional(),
});

// Discriminated on `type`, so an unknown type is rejected outright while a
// known type is checked only against its own shape. `payload` is optional on
// every arm: Phase 8 is additive and may not put a new required field on the
// wire. `cites` is optional here too — `done` needs a PR citation, but that is
// enforced in sendMessageTool as a plain {ok:false,error}, mirroring the
// identity-binding rejection, rather than as a schema throw.
export const messageRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("decision"), payload: decisionPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("verdict"), payload: verdictPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("done"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("blocker"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("risk"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("fyi"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("action"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("go"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
  z.object({ type: z.literal("scope"), payload: summaryPayload.optional(), cites: z.array(citationSchema).optional() }),
]);

// ---------- record authority (Phase 8 Task 4) ----------

// Which roles may emit which record types. Everything not listed here is
// unrestricted — the table is a floor on the three types other agents ACT on,
// not a permission system.
//
// NOT A TRUST BOUNDARY. A role is self-declared at register/join (there is no
// authority issuing them), so this is a CONSISTENCY check: it stops a worker
// from accidentally emitting a `verdict` or countersigning its own `scope`,
// the same way a linter stops a typo. Anything that must actually be
// authenticated has to resolve identity-bound tokens (see tokens.json), never
// this table.
const RECORD_AUTHORITY: Record<string, { roles: Set<string>; label: string }> = {
  verdict: { roles: GATE_RUNNER_ROLE_IDS, label: "gate-runner" },
  go: { roles: COORDINATOR_ROLE_IDS, label: "coordinator" },
  scope: { roles: COORDINATOR_ROLE_IDS, label: "coordinator" },
};

// Rejection shape mirrors the identity-binding rejection in server.ts: the
// caller gets a plain `{ok: false, error}`, and nothing is written.
export async function checkRecordAuthority(
  from: string,
  record: MessageRecord | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!record) return { ok: true };
  const rule = RECORD_AUTHORITY[record.type];
  if (!rule) return { ok: true };

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const entry = reg[from];
  if (roleMatches(entry, rule.roles)) return { ok: true };

  const held = resolveRole(entry);
  return {
    ok: false,
    error:
      `record.type '${record.type}' is restricted to ${rule.label} roles ` +
      `(${[...rule.roles].join(", ")}); sender '${from}' holds ` +
      `${held ? `role '${held.roleId}'` : entry ? "no role" : "no registry entry"}. ` +
      `Send it as text, or register with the role that owns this record type.`,
  };
}

export const sendMessageSchema = {
  from: z.string().min(1),
  to: z.string().optional(),
  room: z.string().optional(),
  // Optional ONLY so a record can fill it (Task 3.3). This relaxes a
  // constraint rather than adding one, so v1 senders are unaffected; a call
  // with neither `text` nor a renderable `record` is rejected in the tool.
  text: z.string().min(1).optional(),
  kind: z.enum(["decision", "status", "chatter"]).optional(),
  record: messageRecordSchema.optional(),
};

export async function sendMessageTool(args: {
  from: string;
  to?: string;
  room?: string;
  text?: string;
  kind?: "decision" | "status" | "chatter";
  record?: MessageRecord;
}) {
  // Record authority first — a sender who may not emit this type is refused
  // before any other check runs, so a rejected record writes nothing anywhere.
  const authority = await checkRecordAuthority(args.from, args.record);
  if (!authority.ok) return { ok: false as const, error: authority.error };

  // A `done` must cite the work it claims. Presence and shape only — resolving
  // the ref against gh/git is a consumer's job, and the send path makes no
  // network calls. Rejected as a value, not a throw, mirroring the
  // identity-binding rejection in src/server.ts.
  if (args.record?.type === "done") {
    const hasPr = (args.record.cites ?? []).some((c) => c.kind === "pr" && c.ref.trim().length > 0);
    if (!hasPr) {
      return {
        ok: false as const,
        error:
          "a 'done' record must carry at least one {kind:'pr'} citation — an uncited DONE is an unverifiable claim",
      };
    }
  }

  // `text` is what every consumer reads, so it must exist. The author's
  // wording ALWAYS wins: a record renders only to fill an absent text, never
  // to overwrite one.
  const text = args.text ?? (args.record ? renderRecord(args.record) : null);
  if (!text) {
    return {
      ok: false as const,
      error: args.record
        ? `record type '${args.record.type}' has no payload to render — supply 'text', or a payload the type's layout can render`
        : "'text' is required when no record is supplied",
    };
  }

  // DM → inbox. Otherwise resolve the channel (default `general`), make sure it
  // exists in the registry, and tag the message with its channel.
  if (args.to) {
    const msg: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: args.from,
      to: args.to,
      text,
      ...(args.record ? { record: args.record } : {}),
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
    text,
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.record ? { record: args.record } : {}),
  };
  const target = roomFile(chan);
  await appendJsonl(target, msg);
  await maybeCompactRoom(chan);
  return { ok: true, id: msg.id, target, room: chan };
}

// ---------- live compaction (self-limiting streams) ----------

// Rooms and the status stream compact themselves on write: once a live file
// grows past its threshold, the oldest entries move to the archive (never
// deleted) and every cursor shifts down. Fresh decisions (< decisionDays old)
// are exempt — they stay in the live file. Cursor adjustment subtracts the
// full removed count, so an agent parked behind a kept decision may re-read
// it once; at-least-once beats silently skipping.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const ROOM_COMPACT_THRESHOLD = envInt("AGENT_COORD_ROOM_MAX", 1000);
const ROOM_COMPACT_KEEP = envInt("AGENT_COORD_ROOM_KEEP", 500);
const STATUS_COMPACT_THRESHOLD = envInt("AGENT_COORD_STATUS_MAX", 2000);
const STATUS_COMPACT_KEEP = envInt("AGENT_COORD_STATUS_KEEP", 1000);
// Skip the entry count entirely while the file is small — the common case on
// every send. ~150 bytes/entry means the threshold can't be hit below this.
const COMPACT_SIZE_GATE = 100 * 1024;
const DECISION_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

async function maybeCompactRoom(chan: string): Promise<void> {
  const file = roomFile(chan);
  if ((await fileSize(file)) < COMPACT_SIZE_GATE) return;
  const entries = await readJsonl<Message>(file);
  if (entries.length <= ROOM_COMPACT_THRESHOLD) return;
  const boundaryTs = entries[entries.length - ROOM_COMPACT_KEEP]!.ts;
  const decisionCutoff = Date.now() - DECISION_FRESH_MS;
  const r = await archiveJsonl<Message>(
    file,
    archiveRoomFile(chan),
    (e) => e.ts >= boundaryTs || (e.kind === "decision" && e.ts > decisionCutoff)
  );
  if (r.removed > 0) await adjustCursors({ roomRemovedByChan: { [chan]: r.removed } });
}

async function maybeCompactStatus(): Promise<void> {
  if ((await fileSize(STATUS_FILE)) < COMPACT_SIZE_GATE) return;
  const entries = await readJsonl<StatusEntry>(STATUS_FILE);
  if (entries.length <= STATUS_COMPACT_THRESHOLD) return;
  const boundaryTs = entries[entries.length - STATUS_COMPACT_KEEP]!.ts;
  const r = await archiveJsonl<StatusEntry>(
    STATUS_FILE,
    ARCHIVE_STATUS_FILE,
    (e) => e.ts >= boundaryTs
  );
  if (r.removed > 0) await adjustCursors({ statusRemoved: r.removed });
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

  let entries: (Message | StatusEntry)[] = [];
  let totalNew = 0;

  // Room and status reads default to 50 entries to prevent agents flooding
  // themselves with full history on join — the status stream grows unbounded
  // across the fleet. Inbox drains fully since it is targeted by nature.
  const effectiveLimit = args.limit ?? (args.source === "inbox" ? undefined : 50);

  if (args.peek) {
    const cursor = await readJson<Cursor>(cursorFile(args.agentId), {});
    const startOffset = getOffset(cursor, args.source, args.room);
    entries = all.slice(startOffset);
    if (args.sinceTs !== undefined) entries = entries.filter((e) => e.ts > args.sinceTs!);
    totalNew = entries.length;
  } else {
    await updateJson<Cursor>(cursorFile(args.agentId), {}, (current) => {
      const startOffset = getOffset(current, args.source, args.room);
      let e = all.slice(startOffset);
      if (args.sinceTs !== undefined) e = e.filter((x) => x.ts > args.sinceTs!);
      totalNew = e.length;
      entries = e;
      // Advance past EVERYTHING we account for here (recent window + any
      // overflow we stash below). The overflow is recoverable via the history
      // hash, so it must not requeue for the next read — that would re-flood.
      if (e.length > 0) setOffset(current, args.source, args.room, startOffset + e.length);
      return current;
    });
  }

  // CCR overflow handling (room and status sources). When the backlog exceeds
  // the window, return the RECENT slice raw and replace the older overflow with
  // a compact digest carrying a retrieval hash. The agent expands it on demand
  // via retrieve_room_history. Peek is side-effect-free, so it never stashes —
  // it reports the count and tells the agent to do a real read to get a hash.
  let recent = entries;
  let history: { digest: string; hash?: string; older: number } | undefined;
  if (args.source !== "inbox" && effectiveLimit && entries.length > effectiveLimit) {
    const overflow = entries.slice(0, entries.length - effectiveLimit);
    recent = entries.slice(entries.length - effectiveLimit);
    const stashKey = args.source === "room" ? normalizeRoom(args.room) : "status";
    if (args.peek) {
      history = { digest: digestOverflow(overflow, undefined), older: overflow.length };
    } else {
      const hash = await stashHistory(stashKey, args.agentId, overflow);
      history = { digest: digestOverflow(overflow, hash), hash, older: overflow.length };
    }
  } else if (effectiveLimit && entries.length > effectiveLimit) {
    // Inbox keeps the legacy oldest-first chunking (no stash) — targeted
    // messages must never be skipped over.
    recent = entries.slice(0, effectiveLimit);
  }

  // Drop the agent's own posts on shared channels — reading your own broadcast
  // back is never useful and confuses turn-based agents into self-replies.
  // Cursor has already advanced past them, so they won't reappear.
  const visible =
    args.source === "room" || args.source === "status"
      ? recent.filter((e) => entryAuthor(e) !== args.agentId)
      : recent;

  return {
    ok: true,
    messages: visible,
    totalNew,
    returned: visible.length,
    room: args.source === "room" ? normalizeRoom(args.room) : undefined,
    ...(history ? { history } : {}),
  };
}

// Lossless summary of a stashed backlog slice: surfaces error/failure posts
// verbatim (the lines that usually matter most in a flood) and collapses the
// rest to counts. Mirrors headroom's content-aware digest, kept deliberately
// simple — the full originals are one retrieve_room_history call away.
function digestOverflow(over: (Message | StatusEntry)[], hash: string | undefined): string {
  const authors = new Set(over.map(entryAuthor).filter(Boolean));
  const errorRe = /\b(error|fatal|fail(ed|ure)?|panic|exception)\b/i;
  const errors = over.filter((m) => errorRe.test(JSON.stringify(m)));
  const first = over[0]?.ts;
  const last = over[over.length - 1]?.ts;
  const span =
    first && last && last > first ? ` over ${Math.round((last - first) / 60000)}m` : "";
  const parts = [
    `[${over.length} earlier message${over.length === 1 ? "" : "s"} compressed`,
    `${authors.size} agent${authors.size === 1 ? "" : "s"}${span}`,
  ];
  if (errors.length) parts.push(`${errors.length} error post${errors.length === 1 ? "" : "s"}`);
  const head = parts.join(", ");
  const tail = hash
    ? ` hash=${hash}] — call retrieve_room_history(hash="${hash}") to expand`
    : `] — read without peek to get an expandable hash`;
  // Decisions are the one thing a digest must not bury — quote them verbatim
  // (capped) below the summary line.
  const decisions = over.filter((m): m is Message => (m as Message).kind === "decision");
  const quoted = decisions
    .slice(-5)
    .map((d) => `  [decision] ${d.from}: ${d.text.length > 200 ? d.text.slice(0, 200) + "…" : d.text}`);
  const decisionBlock = decisions.length
    ? `\n${quoted.join("\n")}${decisions.length > 5 ? `\n  (+${decisions.length - 5} earlier decisions in hash)` : ""}`
    : "";
  return head + tail + decisionBlock;
}

// ---------- retrieve_room_history ----------

export const retrieveRoomHistorySchema = {
  agentId: z.string().min(1),
  hash: z.string().min(1),
  query: z.string().optional(),
};

export async function retrieveRoomHistoryTool(args: {
  agentId: string;
  hash: string;
  query?: string;
}) {
  const res = await retrieveHistory<Message | StatusEntry>(args.hash, args.agentId, args.query);
  if (!res.ok) {
    const reason =
      res.reason === "expired"
        ? "That history entry has expired (30m TTL). Re-read the channel with a higher limit to fetch it again."
        : res.reason === "forbidden"
          ? "That history hash was produced for a different agent and cannot be retrieved by you."
          : "No history entry for that hash. It may have expired or never existed.";
    return { ok: false, reason: res.reason, message: reason };
  }
  return {
    ok: true,
    room: res.room,
    hash: args.hash,
    total: res.total,
    returned: res.messages.length,
    messages: res.messages,
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
  await maybeCompactStatus();
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

