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

export type AgentEntry = {
  agentId: string;
  project?: string;
  role?: string;
  registeredAt: number;
  lastHeartbeat: number;
  capabilities?: string[];
};

export type TransportMarker = {
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

export type AgentRegistry = Record<string, AgentEntry>;

// Where a claim can be independently verified. The point is that a consumer
// resolves the ref (gh, git, fs) instead of trusting the message body — a
// `done` record whose PR ref doesn't exist is a false claim, not a typo.
export type Citation = {
  kind: "pr" | "file" | "commit" | "url";
  ref: string;
};

// The protocol vocabulary the fleet already speaks. Today these live as
// case-sensitive prefixes at byte 0 of `text` (hooks/tier.mjs), parsed a
// second time by the UI for alert priority — so a greeting before the prefix
// silently downgrades a production blocker, and the two parsers can disagree
// about the same message. As a field there is nothing to mis-parse.
export type MessageRecordType =
  | "blocker"   // BLOCKER:        work cannot continue
  | "decision"  // DAVID_DECISION: the human must decide
  | "risk"      // RISK:           quality/security/cost/product risk
  | "done"      // DONE:           completed work, must cite
  | "fyi"       // FYI:            no action needed
  | "action"    // AGENT_ACTION:   another agent can handle it
  | "go"        // GO:             a work order
  | "scope"     // SCOPE CHANGE:   amends a contract in flight
  | "verdict";  // (new) a gate PASS/FAIL — has no prefix today

// Structured counterpart to `text`, NOT a replacement: `text` stays required
// because it is the rendering, and a tmux pane can only receive text. Every
// field is optional so a v1 agent that has never heard of `record` behaves
// byte-identically.
//
// UNTRUSTED, exactly like `from`. A peer can claim any type here, so trust
// decisions (the SCOPE countersignature, gate-runner routing) must still
// resolve the sender against the registry — typed is not the same as
// authenticated, and `record` must never become a path to setting `urgent`.
export type MessageRecord = {
  type: MessageRecordType;
  // Type-specific fields (the decision packet's title/context/options/… ).
  // Shapes are pinned per type in Phase 8 Task 3; the envelope stays open so
  // adding one doesn't require a wire change.
  payload?: Record<string, unknown>;
  cites?: Citation[];
};

export type Message = {
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
  // Server-generated push-now override (e.g. the post-/clear identity
  // reminder). Only server code can set this — send_message constructs the
  // Message from fixed fields, so peers cannot smuggle it in.
  urgent?: boolean;
  // Semantic weight of a room post (absent = chatter). Decisions get a longer
  // prune retention (decisionDays), survive live compaction while fresh, and
  // are surfaced verbatim in overflow digests.
  //
  // NAME COLLISION, load-bearing: the pushers render a *synthetic* `kind` on
  // their own copy of the message ("DM" / "room #general") which injectLine
  // and classifyTier read as the channel tag. Never let a stored Message's
  // kind reach those — see the spread order at tmux-pusher.mjs:237. Phase 8
  // Task 3 should rename one of the two.
  kind?: "decision" | "status" | "chatter";
  // Typed protocol record (Phase 8). Optional and additive; see MessageRecord.
  record?: MessageRecord;
};

export type StatusEntry = {
  id: string;
  ts: number;
  agentId: string;
  status: string;
  detail?: string;
};

export type Cursor = {
  inboxOffset?: number;
  roomOffset?: number; // the default channel (`general` → room.jsonl)
  statusOffset?: number;
  // Per-channel read offsets for every non-default channel.
  roomOffsets?: Record<string, number>;
};

export type Source = "inbox" | "room" | "status";

// Resolve the physical file for a (source, agent, channel) tuple.
export function sourceFile(source: Source, agentId: string, room?: string): string {
  if (source === "inbox") return inboxFile(agentId);
  if (source === "status") return STATUS_FILE;
  return roomFile(room ?? DEFAULT_ROOM);
}

// Read/write the cursor offset for a (source, channel). `general` keeps using
// the flat roomOffset key (hook compat); other channels use roomOffsets[chan].
export function getOffset(cursor: Cursor, source: Source, room?: string): number {
  if (source === "inbox") return cursor.inboxOffset ?? 0;
  if (source === "status") return cursor.statusOffset ?? 0;
  const chan = normalizeRoom(room);
  return chan === DEFAULT_ROOM ? cursor.roomOffset ?? 0 : cursor.roomOffsets?.[chan] ?? 0;
}

export function setOffset(cursor: Cursor, source: Source, room: string | undefined, n: number): void {
  if (source === "inbox") { cursor.inboxOffset = n; return; }
  if (source === "status") { cursor.statusOffset = n; return; }
  const chan = normalizeRoom(room);
  if (chan === DEFAULT_ROOM) cursor.roomOffset = n;
  else (cursor.roomOffsets ??= {})[chan] = n;
}

export function sysMsg(from: string, room: string, text: string): Message {
  return { id: randomUUID(), ts: Date.now(), from, room, text, system: true };
}

export const STALE_MS = 5 * 60 * 1000;
export const EVICT_MS = 24 * 60 * 60 * 1000;
export const MAX_WAIT_MS = 60_000;


// ---------- helpers ----------

export async function moveFile(from: string, to: string): Promise<boolean> {
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
