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
  // DISPLAY NAME — free to change. Stays a plain string on disk so existing
  // agents.json files, coord-chat's `/whois`, and every v1 reader keep working
  // untouched.
  role?: string;
  // FROZEN IDENTITY (Phase 8 Task 4). Optional and additive: when absent the id
  // is derived from `role` at read time (resolveRole), which is what every
  // pre-Task-4 entry does. Once DECLARED it is immutable — register rejects an
  // attempt to change it — so a role can be renamed (curator → liaison → aide)
  // without every id, skill and script that keys off it having to move.
  roleId?: string;
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

// The five fields of the playbook's decision packet (§Decision Packet Format).
// Named to match that layout because `renderRecord` reproduces it byte-for-byte
// — the UI parses the rendering into a clickable decision card.
export type DecisionPayload = {
  title: string;
  context: string;
  options: string[];
  recommendation: string;
  ifNoAction: string;
};

// A gate verdict. `headRefOid` pins WHICH commit was gated: a PASS that doesn't
// name the sha it was issued against is unfalsifiable once the branch moves.
export type VerdictPayload = {
  result: "pass" | "fail";
  headRefOid: string;
  notes?: string;
};

// Everything else carries prose. One line, because these render as
// `<PREFIX>: <summary>` and a paragraph in a tmux pane is a wall, not a status.
export type SummaryPayload = { summary: string };

// Message types whose payload is just a summary.
export type SummaryRecordType = "blocker" | "risk" | "fyi" | "action" | "go" | "scope";

// Structured counterpart to `text`, NOT a replacement: `text` is the rendering,
// and a tmux pane can only receive text. A v1 agent that has never heard of
// `record` omits it entirely and behaves byte-identically.
//
// `payload` stays OPTIONAL on every arm — Phase 8 is additive, so no new
// required field may appear on the wire. What is pinned is the shape *if* a
// payload is supplied: a `decision` carrying three of its five fields is
// structurally wrong for the type it claims and is rejected, while a payload
// with extra unknown keys passes through untouched (a v3 sender must not be
// broken by a v2 server, and stripping would silently drop data on the way to
// disk).
//
// `cites` is likewise optional here. `done` requires a PR citation, but that is
// enforced in sendMessageTool as a plain {ok:false,error} rather than a schema
// rejection — see the identity-binding precedent in src/server.ts.
//
// UNTRUSTED, exactly like `from`. A peer can claim any type here, so trust
// decisions (the SCOPE countersignature, gate-runner routing) must still
// resolve the sender against the registry — typed is not the same as
// authenticated, and `record` must never become a path to setting `urgent`.
export type MessageRecord =
  | { type: "decision"; payload?: DecisionPayload; cites?: Citation[] }
  | { type: "verdict"; payload?: VerdictPayload; cites?: Citation[] }
  | { type: "done"; payload?: SummaryPayload; cites?: Citation[] }
  | { type: SummaryRecordType; payload?: SummaryPayload; cites?: Citation[] };

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
  // This field is on disk in every JSONL file, so it is the half of the old
  // name collision that could not move. The pushers' *synthetic* channel tag
  // ("DM" / "room #general"), read by injectLine and classifyTier, was also
  // called `kind` until Phase 8 Task 3 renamed it to `tag` — it is
  // process-local and never persisted, so renaming it cost no migration.
  // The two no longer collide; see hooks/tmux-pusher.mjs's collectSource.
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
