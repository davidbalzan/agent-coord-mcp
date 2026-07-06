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

