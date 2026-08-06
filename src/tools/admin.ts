import { z } from "zod";
import path from "node:path";
import {
  AGENTS_FILE,
  ARCHIVE_STATUS_FILE,
  CURSOR_DIR,
  DEFAULT_ROOM,
  INBOX_DIR,
  ROOMS_FILE,
  STATUS_FILE,
  archiveInboxFile,
  archiveJsonl,
  archiveRoomFile,
  deleteFile,
  getRooms,
  listCursorFiles,
  listInboxFiles,
  listReceiptFiles,
  normalizeRoom,
  pruneHistory,
  readJson,
  readJsonl,
  rewriteJsonl,
  roomFile,
  updateJson,
  type RoomRegistry,
} from "../store.js";
import {
  type AgentRegistry,
  type Cursor,
  type Message,
  type StatusEntry,
  isDecision,
} from "./shared.js";

// ---------- prune ----------

export const PRUNE_TARGETS = ["rooms", "status", "inbox", "receipts", "members"] as const;
export type PruneTarget = (typeof PRUNE_TARGETS)[number];

export const pruneSchema = {
  olderThanDays: z.number().positive().max(365).optional(),
  decisionDays: z.number().positive().max(365).optional(),
  room: z.string().optional(),
  targets: z.array(z.enum(PRUNE_TARGETS)).optional(),
  removeOrphanInboxes: z.boolean().optional(),
  archiveEmptyRooms: z.boolean().optional(),
  dryRun: z.boolean().optional(),
};

// Retention: decisions live by the (longer) decision cutoff; everything else
// by the standard cutoff. What counts as a decision is `isDecision` — the
// shared predicate, not a fourth copy of the comparison.
function keepEntry(
  e: { ts: number; kind?: string; record?: { type?: string } },
  cutoff: number,
  decisionCutoff: number,
): boolean {
  return isDecision(e) ? e.ts > decisionCutoff : e.ts > cutoff;
}

// Shift every agent's cursor offsets down by the number of entries removed
// ahead of them (append-only + oldest-first removal ⇒ plain subtraction,
// clamped at 0). Shared by prune and live compaction — without this, an
// offset past the new file length makes read_messages return [] forever.
export async function adjustCursors(removals: {
  roomRemovedByChan?: Record<string, number>;
  statusRemoved?: number;
  perAgentInboxRemoved?: Record<string, number>;
}): Promise<string[]> {
  const roomRemovedByChan = removals.roomRemovedByChan ?? {};
  const statusRemoved = removals.statusRemoved ?? 0;
  const perAgentInboxRemoved = removals.perAgentInboxRemoved ?? {};
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
      if (current.statusOffset !== undefined && statusRemoved > 0) {
        current.statusOffset = Math.max(0, current.statusOffset - statusRemoved);
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
  return cursorsAdjusted;
}

export async function pruneTool(args: {
  olderThanDays?: number;
  decisionDays?: number;
  room?: string;
  targets?: PruneTarget[];
  removeOrphanInboxes?: boolean;
  archiveEmptyRooms?: boolean;
  dryRun?: boolean;
}) {
  const days = args.olderThanDays ?? 7;
  const decisionDays = args.decisionDays ?? 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const decisionCutoff = Date.now() - decisionDays * 24 * 60 * 60 * 1000;
  const dryRun = args.dryRun ?? false;
  // `room` scopes every sweep to that channel; `targets` narrows which sweeps
  // run. They compose: `room` only changes the DEFAULT target set, so an
  // explicit `targets` always wins.
  //
  // WHY (regression): this previously read `scopedRoom ? ["rooms"] : args.targets`,
  // which silently DISCARDED an explicit `targets` whenever `room` was passed.
  // `prune {room, targets:["members"], dryRun:true}` therefore reported
  // `orphanMembers: []` because the member sweep never ran — a caller asking
  // "which members are phantoms in this room" got a clean bill of health that
  // had not been computed, while `roomMessages` (the one target the override
  // left enabled) reported real messages a live run would have archived. Field
  // report: two members that `ping` called `unregistered` were invisible here.
  // A sweep must never answer a question it did not evaluate.
  const scopedRoom = args.room ? normalizeRoom(args.room) : undefined;
  const targets = new Set<PruneTarget>(
    args.targets ?? (scopedRoom ? ["rooms"] : [...PRUNE_TARGETS])
  );
  const keep = (e: { ts: number; kind?: string }) => keepEntry(e, cutoff, decisionCutoff);

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const knownAgents = new Set(Object.keys(reg));
  // A member is stale when its agent is gone from the registry (orphan) or
  // hasn't heartbeated since the cutoff (dead session).
  const staleAgent = (m: string) => !knownAgents.has(m) || (reg[m]?.lastHeartbeat ?? 0) <= cutoff;

  const channels = scopedRoom ? [scopedRoom] : Object.keys(await getRooms());
  // The membership sweeps walk the room registry rather than `channels`, so they
  // need the scope predicate explicitly — without it, `room` scoped the message
  // sweep while membership silently swept EVERY room.
  const inScope = (chan: string) => !scopedRoom || chan === scopedRoom;

  if (dryRun) {
    let roomMessages = 0;
    if (targets.has("rooms")) {
      for (const chan of channels) {
        const msgs = await readJsonl<Message>(roomFile(chan));
        roomMessages += msgs.filter((e) => !keep(e)).length;
      }
    }
    const status = targets.has("status") ? await readJsonl<StatusEntry>(STATUS_FILE) : [];
    let inboxRemoved = 0;
    const orphans: string[] = [];
    if (targets.has("inbox")) {
      for (const fname of await listInboxFiles()) {
        const id = fname.replace(/\.jsonl$/, "");
        if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) orphans.push(fname);
        const entries = await readJsonl<Message>(path.join(INBOX_DIR, fname));
        inboxRemoved += entries.filter((e) => e.ts <= cutoff).length;
      }
    }
    const orphanMembers = new Set<string>();
    const staleMembers = new Set<string>();
    const emptyRooms: string[] = [];
    if (targets.has("members")) {
      const rooms = await getRooms();
      for (const [chan, e] of Object.entries(rooms)) {
        if (!inScope(chan)) continue;
        const remaining: string[] = [];
        for (const m of e.members ?? []) {
          if (!knownAgents.has(m)) orphanMembers.add(m);
          else if (staleAgent(m)) staleMembers.add(m);
          else remaining.push(m);
        }
        if (
          (args.archiveEmptyRooms ?? true) &&
          chan !== DEFAULT_ROOM &&
          remaining.length === 0
        ) {
          const msgs = await readJsonl<Message>(roomFile(chan));
          const lastTs = msgs[msgs.length - 1]?.ts ?? 0;
          if (lastTs <= cutoff) emptyRooms.push(chan);
        }
      }
    }
    let receiptsRemoved = 0;
    const orphanReceipts: string[] = [];
    if (targets.has("receipts")) {
      for (const filePath of await listReceiptFiles()) {
        const id = path.basename(filePath).replace(/\.jsonl$/, "");
        const entries = await readJsonl<{ ts: number }>(filePath);
        if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) orphanReceipts.push(id);
        receiptsRemoved += entries.filter((e) => e.ts <= cutoff).length;
      }
    }
    return {
      dryRun: true,
      cutoff,
      olderThanDays: days,
      decisionDays,
      ...(scopedRoom ? { room: scopedRoom } : {}),
      wouldRemove: {
        roomMessages,
        statusEntries: status.filter((e) => e.ts <= cutoff).length,
        inboxMessages: inboxRemoved,
        orphanInboxes: orphans,
        orphanMembers: [...orphanMembers],
        staleMembers: [...staleMembers],
        archivedRooms: emptyRooms,
        receipts: receiptsRemoved,
        orphanReceipts,
      },
    };
  }

  // Per-channel removed counts so we can shift the matching offset in each
  // cursor (default channel → roomOffset, others → roomOffsets[chan]).
  // Aged-out entries are archived to archive/rooms/<chan>.jsonl, never deleted.
  const roomRemovedByChan: Record<string, number> = {};
  let roomRemovedTotal = 0;
  if (targets.has("rooms")) {
    for (const chan of channels) {
      const r = await archiveJsonl<Message>(roomFile(chan), archiveRoomFile(chan), keep);
      if (r.removed > 0) {
        roomRemovedByChan[chan] = r.removed;
        roomRemovedTotal += r.removed;
      }
    }
  }
  const statusResult = targets.has("status")
    ? await archiveJsonl<StatusEntry>(STATUS_FILE, ARCHIVE_STATUS_FILE, (e) => e.ts > cutoff)
    : { kept: 0, removed: 0, archived: 0 };

  let inboxRemoved = 0;
  const deletedOrphans: string[] = [];
  // perAgentInboxRemoved: how many entries were stripped from each *kept* agent's
  // inbox, so we can shift only that agent's inboxOffset cursor below.
  const perAgentInboxRemoved: Record<string, number> = {};
  if (targets.has("inbox")) {
    for (const fname of await listInboxFiles()) {
      const id = fname.replace(/\.jsonl$/, "");
      const filePath = path.join(INBOX_DIR, fname);
      if (!knownAgents.has(id) && (args.removeOrphanInboxes ?? true)) {
        // Orphan inbox: archive everything it held, then drop the live file.
        const r = await archiveJsonl<Message>(filePath, archiveInboxFile(id), () => false);
        inboxRemoved += r.removed;
        await deleteFile(filePath);
        deletedOrphans.push(id);
        continue;
      }
      const r = await archiveJsonl<Message>(filePath, archiveInboxFile(id), (e) => e.ts > cutoff);
      inboxRemoved += r.removed;
      perAgentInboxRemoved[id] = r.removed;
    }
  }

  const cursorsAdjusted = await adjustCursors({
    roomRemovedByChan,
    statusRemoved: statusResult.removed,
    perAgentInboxRemoved,
  });

  // Membership sweep: drop orphans (not in registry) and stale members (no
  // heartbeat since cutoff) so list_rooms / joinedRooms() stop surfacing
  // ghosts. Then archive non-default rooms left with no members and no
  // activity since the cutoff: remaining messages move to the archive, the
  // room leaves the registry, and every cursor forgets its offset — the same
  // cleanup delete_room performs, minus the data loss.
  const orphanMembers = new Set<string>();
  const staleMembers = new Set<string>();
  const archivedRooms: string[] = [];
  if (targets.has("members")) {
    await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
      for (const [chan, e] of Object.entries(current)) {
        if (!inScope(chan)) continue;
        if ((e.members?.length ?? 0) === 0) continue;
        e.members = (e.members ?? []).filter((m) => {
          if (!knownAgents.has(m)) {
            orphanMembers.add(m);
            return false;
          }
          if (staleAgent(m)) {
            staleMembers.add(m);
            return false;
          }
          return true;
        });
      }
      return current;
    });

    if (args.archiveEmptyRooms ?? true) {
      const rooms = await getRooms();
      for (const [chan, e] of Object.entries(rooms)) {
        if (chan === DEFAULT_ROOM || !inScope(chan) || (e.members?.length ?? 0) > 0) continue;
        const file = roomFile(chan);
        const msgs = await readJsonl<Message>(file);
        const lastTs = msgs[msgs.length - 1]?.ts ?? 0;
        if (lastTs > cutoff) continue;
        await archiveJsonl<Message>(file, archiveRoomFile(chan), () => false);
        await deleteFile(file);
        await updateJson<RoomRegistry>(ROOMS_FILE, {}, (current) => {
          delete current[chan];
          return current;
        });
        for (const cname of await listCursorFiles()) {
          await updateJson<Cursor>(path.join(CURSOR_DIR, cname), {}, (current) => {
            if (current.roomOffsets?.[chan] !== undefined) delete current.roomOffsets[chan];
            return current;
          });
        }
        archivedRooms.push(chan);
      }
    }
  }

  // Receipts are out-of-band proof logs with no cursor and no analysis value —
  // trim old entries by ts and delete logs for agents no longer registered.
  // The one stream that is genuinely deleted, not archived.
  let receiptsRemoved = 0;
  const deletedOrphanReceipts: string[] = [];
  if (targets.has("receipts")) {
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
  }

  // Sweep expired reversible-history entries (TTL'd cache; also self-prunes on
  // every read, so this just catches entries on a server with few reads).
  await pruneHistory();

  return {
    dryRun: false,
    cutoff,
    olderThanDays: days,
    decisionDays,
    ...(scopedRoom ? { room: scopedRoom } : {}),
    removed: {
      roomMessages: roomRemovedTotal,
      statusEntries: statusResult.removed,
      inboxMessages: inboxRemoved,
      orphanInboxes: deletedOrphans,
      orphanMembers: [...orphanMembers],
      staleMembers: [...staleMembers],
      archivedRooms,
      receipts: receiptsRemoved,
      orphanReceipts: deletedOrphanReceipts,
    },
    archivedTo: "archive/ (rooms/<chan>.jsonl, status.jsonl, inbox/<agent>.jsonl; receipts deleted)",
    cursorsAdjusted,
  };
}
