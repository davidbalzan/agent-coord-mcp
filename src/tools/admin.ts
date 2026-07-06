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
    let receiptsRemoved = 0;
    const orphanReceipts: string[] = [];
    for (const filePath of await listReceiptFiles()) {
      const id = path.basename(filePath).replace(/\.jsonl$/, "");
      const entries = await readJsonl<{ ts: number }>(filePath);
      if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) orphanReceipts.push(id);
      receiptsRemoved += entries.filter((e) => e.ts <= cutoff).length;
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
        receipts: receiptsRemoved,
        orphanReceipts,
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

  // Receipts are out-of-band proof logs with no cursor — trim old entries by ts
  // and delete logs for agents no longer registered. No offset adjustment needed.
  let receiptsRemoved = 0;
  const deletedOrphanReceipts: string[] = [];
  for (const filePath of await listReceiptFiles()) {
    const id = path.basename(filePath).replace(/\.jsonl$/, "");
    if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) {
      const entries = await readJsonl<{ ts: number }>(filePath);
      receiptsRemoved += entries.length;
      await deleteFile(filePath);
      deletedOrphanReceipts.push(id);
      continue;
    }
    const r = await rewriteJsonl<{ ts: number }>(filePath, (e) => e.ts > cutoff);
    receiptsRemoved += r.removed;
  }

  // Sweep expired reversible-history entries (TTL'd cache; also self-prunes on
  // every read, so this just catches entries on a server with few reads).
  await pruneHistory();

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
      receipts: receiptsRemoved,
      orphanReceipts: deletedOrphanReceipts,
    },
    cursorsAdjusted,
  };
}

