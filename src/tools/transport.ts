import { loadLiveTransports, isMarkerLive, isPidAlive } from "./registry.js";
import { registerTool } from "./registry.js";
import { sendMessageTool, readMessagesTool } from "./messaging.js";
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

// ---------- ping ----------

export const pingSchema = {
  from: z.string().min(1),
  to: z.string().min(1),
  echo: z.boolean().optional(),
};

// Liveness probe answered entirely from server-side state — registry entry,
// transport marker, pusher pid, tmux pane. It never touches the target's
// session, so a fleet-wide sweep costs zero model tokens on the targets.
// Distinct from `heartbeat` (the target refreshing its own activity
// timestamp): ping is a third party asking "would a DM land right now?".
// echo=true is the one exception — it drops a PING DM into the target's inbox
// (normal delivery, so the target's model DOES wake); opt-in, default off.
export async function pingTool(args: { from: string; to: string; echo?: boolean }) {
  const t0 = process.hrtime.bigint();
  const now = Date.now();
  const latencyMs = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e3) / 1e3;

  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const entry = reg[args.to];
  if (!entry) {
    return { ok: true, to: args.to, alive: false, reachable: false, reason: "unregistered", latencyMs: latencyMs() };
  }

  const marker = await readJson<TransportMarker | null>(transportFile(args.to), null);
  const heartbeatAgeSec = Math.floor((now - entry.lastHeartbeat) / 1000);
  const heartbeatFresh = now - entry.lastHeartbeat < STALE_MS;

  let transportLive = false;
  let paneAlive: boolean | undefined;
  if (marker) {
    transportLive = isMarkerLive(marker, reg, now);
    if (transportLive && marker.transport === "tmux-push" && marker.tmuxTarget) {
      // The pusher can outlive its pane (agent window closed) — probe the pane.
      const probe = spawnSync("tmux", ["display-message", "-p", "-t", marker.tmuxTarget, "ok"]);
      paneAlive = probe.status === 0;
    }
  }

  const reachable = transportLive && paneAlive !== false;
  const alive = reachable || heartbeatFresh;

  let echoSent = false;
  if (args.echo && alive) {
    await sendMessageTool({
      from: args.from,
      to: args.to,
      text: `PING: echo requested by ${args.from} — DM back if responsive.`,
    });
    echoSent = true;
  }

  return {
    ok: true,
    to: args.to,
    alive,
    reachable,
    ...(alive ? {} : { reason: marker ? "transport-dead" : "heartbeat-stale" }),
    checks: {
      registered: true,
      heartbeatFresh,
      heartbeatAgeSec,
      transport: marker?.transport ?? null,
      transportLive,
      ...(paneAlive !== undefined ? { paneAlive, tmuxTarget: marker?.tmuxTarget } : {}),
    },
    ...(args.echo ? { echoSent } : {}),
    latencyMs: latencyMs(),
  };
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
  // Block until the receiving pusher confirms it actually typed the command
  // into the pane (out-of-band receipt poll — zero added agent context).
  // Default true: a control command you can't confirm is the bug this fixes.
  // Set false for fire-and-forget. The wait is bounded by deliveryTimeoutMs.
  waitForDelivery: z.boolean().optional(),
  deliveryTimeoutMs: z.number().int().min(0).max(30_000).optional(),
};

// Poll an agent's receipt log until a receipt for `msgId` appears or the
// deadline passes. Returns the delivery timestamp, or null on timeout. The
// receipt is written by the receiver's pusher AFTER send-keys, so a hit is
// genuine proof the keystrokes reached the pane. File-only — no agent context.
async function waitForReceipt(
  agentId: string,
  msgId: string,
  timeoutMs: number,
): Promise<number | null> {
  const file = receiptFile(agentId);
  const deadline = Date.now() + timeoutMs;
  // First check is immediate; then poll on a short interval.
  for (;;) {
    const receipts = await readJsonl<{ id: string; ts: number }>(file);
    const hit = receipts.find((r) => r.id === msgId);
    if (hit) return hit.ts ?? Date.now();
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, 150));
  }
}

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
          // A just-cleared agent is contextless until this lands — it must
          // push immediately, never queue behind the routine tier.
          urgent: true,
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
  waitForDelivery?: boolean;
  deliveryTimeoutMs?: number;
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
    // Confirm the pusher actually typed it into the pane before we report success
    // (unless explicitly fire-and-forget). Out-of-band receipt poll — the
    // confirmation rides back in THIS tool result, costing no extra agent context.
    const wait = args.waitForDelivery ?? true;
    const deliveryTimeoutMs = args.deliveryTimeoutMs ?? 8000;
    const confirmedAt = wait ? await waitForReceipt(args.to, msg.id, deliveryTimeoutMs) : null;
    const confirmed = confirmedAt !== null;
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
      // delivery: confirmed = pusher typed it into the pane; pending = written but
      // unconfirmed within the timeout (stale/wedged pusher — run doctor). Absent
      // when waitForDelivery:false.
      ...(wait
        ? {
            delivery: confirmed ? "confirmed" : "pending",
            confirmed,
            ...(confirmedAt !== null ? { deliveredAt: confirmedAt } : {}),
            ...(confirmed
              ? {}
              : {
                  warning: `no delivery receipt from '${args.to}' within ${deliveryTimeoutMs}ms — the command was written but may not have reached the pane (stale/wedged pusher). Run doctor or re-attach the agent.`,
                }),
          }
        : {}),
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
  // Confirm each member's pusher typed it in (same msg.id lands in every
  // member's own receipt file). Poll all in parallel within one timeout.
  const wait = args.waitForDelivery ?? true;
  const deliveryTimeoutMs = args.deliveryTimeoutMs ?? 8000;
  let confirmed: string[] = [];
  let pending: string[] = [];
  if (wait) {
    const results = await Promise.all(
      delivered.map(async (m) => ({ m, at: await waitForReceipt(m, msg.id, deliveryTimeoutMs) })),
    );
    confirmed = results.filter((r) => r.at !== null).map((r) => r.m);
    pending = results.filter((r) => r.at === null).map((r) => r.m);
  }
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
    ...(wait
      ? {
          delivery: pending.length === 0 ? "confirmed" : "partial",
          confirmed,
          ...(pending.length
            ? {
                pending,
                warning: `no delivery receipt within ${deliveryTimeoutMs}ms from: ${pending.join(", ")} — written but may not have reached their panes (stale/wedged pusher). Run doctor.`,
              }
            : {}),
        }
      : {}),
    ...(reminderMs > 0 ? { reminderScheduled: { delayMs: reminderMs, recipients: delivered } } : {}),
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
  // transport.js (compiled) lives in dist/tools/; pusher lives in hooks/ at repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "hooks", "tmux-pusher.mjs");
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

  // 1c. Wedged local pushers (pid-alive, pane-dead). v0.8.0 made pushers
  //     self-exit when their own tmux-target probe finds the pane gone, but
  //     that only fires from inside the pusher's own poll loop — if the pane
  //     is killed in a way that loop never observes (or the loop itself is
  //     wedged), the pid stays alive, isMarkerLive's pid-alive check keeps
  //     treating it as live, and list_agents reports it "live" while nothing
  //     can actually be delivered. Local tmux-push only — a tmux-push-remote
  //     marker's pane lives on a different host, unprobeable from here.
  {
    // Without a tmux binary we can't tell "wedged" from "can't probe" — skip
    // rather than flag every local marker as dead.
    const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
    const wedged: { agentId: string; pid: number; file: string; target: string }[] = [];
    if (tmuxAvailable) {
      for (const fname of await listTransportFiles()) {
        const file = path.join(TRANSPORT_DIR, fname);
        const marker = await readJson<TransportMarker | null>(file, null);
        if (!marker || !isMarkerLive(marker, reg, now)) continue;
        if (marker.transport !== "tmux-push") continue; // remote = no local pane to probe
        if (!marker.tmuxTarget) continue; // no target recorded, can't probe
        // has-session actually validates the target and fails on a dead
        // pane/session; `display-message -p -t <target> <literal>` does NOT
        // (tmux 3.6b exits 0 for any target, even a just-killed one, when
        // the format string has no #{...} needing that target resolved).
        const probe = spawnSync("tmux", ["has-session", "-t", marker.tmuxTarget]);
        if (probe.status === 0) continue; // pane alive
        wedged.push({ agentId: marker.agentId, pid: marker.pid, file, target: marker.tmuxTarget });
      }
    }
    if (fix) {
      for (const w of wedged) {
        try { process.kill(w.pid, "SIGTERM"); } catch { /* already gone */ }
        await deleteFile(w.file);
        fixed.push(`reaped wedged pusher for ${w.agentId} (pid ${w.pid}, tmux target '${w.target}' gone)`);
      }
    }
    findings.push({
      check: "wedged-local-pushers",
      level: wedged.length ? "warn" : "ok",
      detail: wedged.length
        ? `${wedged.length} local pusher(s) alive (pid) but their tmux pane is gone — looks attached, delivers nothing. ${fix ? "Reaped (SIGTERM + marker cleared)." : "Run doctor with fix:true to SIGTERM and clear the marker."}`
        : tmuxAvailable
          ? "no wedged local pushers (pid-alive, pane-dead)"
          : "tmux not available — skipped wedged-pusher pane probe",
      fixable: true,
      items: wedged.length ? wedged.map((w) => `${w.agentId} (pid ${w.pid}, tmux target '${w.target}')`) : undefined,
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

