import { loadLiveTransports, isMarkerLive, isPidAlive } from "./registry.js";
import { newestMtimeUnder, onDiskBuildMtime, onDiskSourceMtime, SERVER_BUILD_MTIME, SERVER_BUILD_SHA, BUILD_DIR } from "../build.js";
import { registerTool } from "./registry.js";
import { roleInputSchema, type RoleArg } from "../roles.js";
import { attributeWriter, isGitRepo, lastWriterOf, loadScopes, ownsDocument } from "./scopes.js";
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
  listSessionFiles,
  listTransportFiles,
  type SessionBinding,
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

// A receipt as the pusher writes it. `submitted` is present only on control
// receipts from a pusher new enough to VERIFY submission (v0.19.0+).
// `scriptMtime` is the reporting pusher's build identity — the same
// module-graph stamp the transport marker carries (newest mtime across the
// pusher's entry file AND its hooks/ imports, per #28: the stale part is as
// likely submit.mjs as the entrypoint). It is honesty, not security: a lying
// pusher defeats it, exactly like report_transport. The value is that a
// "confirmed" can be tied to the code that did the confirming.
type Receipt = {
  id: string;
  ts: number;
  control?: boolean;
  submitted?: boolean;
  verified?: boolean;
  reason?: string;
  scriptMtime?: number;
};

// Poll an agent's receipt log until a receipt for `msgId` appears or the
// deadline passes. Returns the receipt, or null on timeout. File-only — no
// agent context.
//
// A receipt proves the pusher TYPED the payload into the pane. For a control
// command that is NOT proof it ran: the command can sit in the input behind an
// autocomplete menu, delivered and inert. `submitted` is the field that
// distinguishes them, and `deliveryOutcome` below is the only place allowed to
// turn a receipt into a "confirmed".
async function waitForReceipt(agentId: string, msgId: string, timeoutMs: number): Promise<Receipt | null> {
  const file = receiptFile(agentId);
  const deadline = Date.now() + timeoutMs;
  // First check is immediate; then poll on a short interval.
  for (;;) {
    const receipts = await readJsonl<Receipt>(file);
    const hit = receipts.find((r) => r.id === msgId);
    if (hit) return { ...hit, ts: hit.ts ?? Date.now() };
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, 150));
  }
}

// Turn a receipt (or its absence) into the delivery verdict for a CONTROL
// command. Only `submitted === true` earns "confirmed" — anything else is
// pending with a reason the caller can act on. Reporting an unverified
// submission as confirmed is the defect this exists to remove: a check that
// cannot fail loudly is worse than no check.
//
// `pusherSourceMtime` (the caller passes newestPusherSourceMtime()) lets a
// CONFIRMED verdict carry a note when the reporting pusher's build identity
// is behind the on-disk pusher source, or absent entirely. The note never
// downgrades the verdict — the command demonstrably ran — it says whose
// verification logic said so. Absence of the stamp reads as UNKNOWN, never
// as fresh (same ruling as doctor's stale-pusher-script / provenance
// checks: absence is not exemption), and the absence note is issued before
// the on-disk comparison so an unstattable hooks dir cannot silence it.
export function deliveryOutcome(
  agentId: string,
  receipt: Receipt | null,
  timeoutMs: number,
  pusherSourceMtime?: number,
): { delivery: "confirmed" | "pending"; at?: number; reason?: string; note?: string } {
  if (!receipt) {
    return {
      delivery: "pending",
      reason: `no delivery receipt from '${agentId}' within ${timeoutMs}ms — the command was written but may not have reached the pane (stale/wedged pusher). Run doctor or re-attach the agent.`,
    };
  }
  if (receipt.submitted === true) {
    let note: string | undefined;
    if (receipt.scriptMtime === undefined) {
      note = `'${agentId}' confirmed the submission, but its pusher carries no build-identity stamp — the pusher predates receipt provenance and this confirmation cannot be tied to any known code; re-attach the agent (detach_agent + attach_agent) to upgrade it.`;
    } else if (pusherSourceMtime !== undefined && receipt.scriptMtime < pusherSourceMtime - 1) {
      const loaded = new Date(receipt.scriptMtime).toISOString();
      const ondisk = new Date(pusherSourceMtime).toISOString();
      note = `'${agentId}' confirmed the submission, but its pusher loaded its code at ${loaded} and the on-disk pusher source is newer (${ondisk}) — the verification logic behind this confirmation predates the current code; re-attach the agent (detach_agent + attach_agent) to upgrade it.`;
    }
    return { delivery: "confirmed", at: receipt.ts, ...(note ? { note } : {}) };
  }
  if (receipt.submitted === false) {
    return {
      delivery: "pending",
      at: receipt.ts,
      reason:
        receipt.reason ??
        `'${agentId}' pasted the command but could not confirm it was submitted — it may be sitting in the input.`,
    };
  }
  // No `submitted` field: a pre-v0.19.0 pusher that stamps on paste. It may
  // well have worked — but it cannot tell us, and guessing "confirmed" is the
  // lie we are removing. Say what is actually known.
  return {
    delivery: "pending",
    at: receipt.ts,
    reason: `'${agentId}' typed the command into its pane, but its pusher predates submit verification and cannot confirm the command ran — re-attach the agent (detach_agent + attach_agent) to upgrade it.`,
  };
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
    const receipt = wait ? await waitForReceipt(args.to, msg.id, deliveryTimeoutMs) : null;
    const outcome = wait ? deliveryOutcome(args.to, receipt, deliveryTimeoutMs, newestPusherSourceMtime()) : null;
    const confirmed = outcome?.delivery === "confirmed";
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
      ...(wait && outcome
        ? {
            delivery: outcome.delivery,
            confirmed,
            ...(outcome.at !== undefined ? { deliveredAt: outcome.at } : {}),
            // A confirmed delivery can still warn: the note names a reporting
            // pusher whose build identity is stale or absent. `confirmed`
            // stays true — the command ran; the warning is about who said so.
            ...(confirmed ? (outcome.note ? { warning: outcome.note } : {}) : { warning: outcome.reason }),
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
  let pendingReasons: string[] = [];
  let confirmNotes: string[] = [];
  if (wait) {
    const sourceMtime = newestPusherSourceMtime();
    const results = await Promise.all(
      delivered.map(async (m) => ({
        m,
        outcome: deliveryOutcome(m, await waitForReceipt(m, msg.id, deliveryTimeoutMs), deliveryTimeoutMs, sourceMtime),
      })),
    );
    confirmed = results.filter((r) => r.outcome.delivery === "confirmed").map((r) => r.m);
    pending = results.filter((r) => r.outcome.delivery !== "confirmed").map((r) => r.m);
    pendingReasons = results
      .filter((r) => r.outcome.delivery !== "confirmed")
      .map((r) => `${r.m}: ${r.outcome.reason}`);
    confirmNotes = results
      .filter((r) => r.outcome.delivery === "confirmed" && r.outcome.note)
      .map((r) => r.outcome.note!);
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
                warning: `not confirmed as submitted within ${deliveryTimeoutMs}ms — ${pendingReasons.join(" | ")}`,
              }
            : {}),
          // Confirmed members whose reporting pusher is stale or unstamped —
          // the confirmations stand, the notes say whose code issued them.
          ...(confirmNotes.length ? { notes: confirmNotes } : {}),
        }
      : {}),
    ...(reminderMs > 0 ? { reminderScheduled: { delayMs: reminderMs, recipients: delivered } } : {}),
  };
}

// Does `pid` actually belong to one of our tmux pushers? A transport marker
// records a pid, but a marker can outlive its process and pids get recycled —
// so "pid is alive" is NOT evidence the pid is still the pusher. Anything that
// SIGTERMs a marker's pid must confirm identity first or it will eventually
// kill an unrelated process on the user's machine.
//
// Pushers are spawned as `<node> <.../hooks/tmux-pusher.mjs>` (see
// attachAgentTool), so the script path in the process's argv is the signature.
// Returns false when we cannot confirm — including when `ps` is unavailable.
// Refusing to kill an unverifiable pid is the safe failure: a wedged pusher
// that survives is a nuisance, a wrong SIGTERM is not.
export function isPusherProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.status !== 0) return false; // pid gone, or no usable ps
  return (ps.stdout ?? "").includes(path.basename(resolvePusherPath()));
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
  // `--agent <id>` is inert to the pusher (env stays authoritative) but puts
  // the agentId in argv, so a pattern kill can be scoped to ONE pusher
  // (`pkill -f "tmux-pusher.mjs --agent <id>"`). Without it the only matchable
  // pattern was the script path, and a `pkill -f tmux-pusher.mjs` during one
  // agent's cleanup silently detached every live agent on the bus (2026-07-28).
  const child = spawn(process.execPath, [pusher, "--agent", args.agentId], {
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
  // Stamp the pusher source's freshness so doctor() can flag a stale daemon if
  // it outlives a later upgrade of the on-disk code (see v0.8.1 → v0.8.2 bug
  // report: control commands silently dropped by pre-v0.8 in-memory code).
  const scriptMtime = newestPusherSourceMtime();
  const marker: TransportMarker = {
    agentId: args.agentId,
    transport: "tmux-push",
    pid,
    tmuxTarget: target,
    since: Date.now(),
    scriptMtime,
    // Provenance: the build identity THIS server loaded at startup — not a
    // fresh stat of dist/, because the code doing the stamping is the loaded
    // code, and after an in-place rebuild the two differ (that difference is
    // exactly what doctor's provenance check exists to surface).
    serverBuildMtime: SERVER_BUILD_MTIME,
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

// Freshness basis for the stale-pusher-script mechanism: the newest mtime
// across the pusher's source dir (hooks/*.mjs), NOT just the entry file. The
// pusher imports submit.mjs / tier.mjs / roles.mjs, so a fix touching only an
// import (the #21/#25 control-submit fixes did) leaves tmux-pusher.mjs's own
// mtime unchanged — a single-file stamp/compare reports ok on a pusher running
// exactly the code the fix replaced. Used by both the attach-time stamp and
// doctor's on-disk comparison so the two sides can never drift apart.
// AGENT_COORD_HOOKS_DIR is a test seam only: it redirects what freshness
// MEASURES (against a temp copy of hooks/) so tests never touch the mtimes of
// real sources shared with live pushers — it never changes what attach SPAWNS.
function newestPusherSourceMtime(): number | undefined {
  const dir = process.env.AGENT_COORD_HOOKS_DIR ?? path.dirname(resolvePusherPath());
  return newestMtimeUnder(dir, [".mjs"]);
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
  // Free text, or a declared identity ({roleId, displayName}) — see
  // roleInputSchema. A frozen roleId cannot be changed by re-joining.
  role: roleInputSchema.optional(),
  // attach: undefined → auto-attach if $TMUX_PANE is set; true → always try;
  // false → never; object → attach with overrides.
  attach: z.union([z.boolean(), joinAttachOptionsSchema]).optional(),
  readInbox: z.boolean().optional(),
  // First-claim guard overrides (server.ts guardFirstClaim): claiming an id
  // that is LIVE on the bus refuses unless the call presents that agent's
  // token (tokens.json / coord-token) or force:true. Ignored once bound.
  token: z.string().optional(),
  force: z.boolean().optional(),
};

export async function joinTool(args: {
  agentId: string;
  project?: string;
  role?: RoleArg;
  attach?: boolean | { tmuxTarget?: string; includeRoom?: boolean; allowlist?: string[]; debounceMs?: number };
  readInbox?: boolean;
}) {
  const reg = await registerTool({
    agentId: args.agentId,
    project: args.project,
    role: args.role,
  });
  // A refused role update (frozen roleId) fails the whole join rather than
  // silently attaching a transport under the wrong identity.
  if (!reg.ok) return reg;

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

export const reportReceiptSchema = {
  agentId: z.string().min(1),
  id: z.string().min(1),
  from: z.string().optional(),
  control: z.boolean().optional(),
  submitted: z.boolean().optional(),
  verified: z.boolean().optional(),
  reason: z.string().optional(),
  // Build identity of the reporting pusher: newest mtime across its loaded
  // module graph (entry file + hooks/ imports), sampled once at its startup —
  // the same basis report_transport's scriptMtime uses. Absent → the receipt's
  // provenance is UNKNOWN and deliveryOutcome says so; the server never
  // defaults it (a default here would be assume-fresh, the twin of the
  // assume-success `submitted` refuses to invent).
  scriptMtime: z.number().optional(),
};

// Wire-callable counterpart to the local pusher's receipt stamp (writeReceipts
// in hooks/tmux-pusher.mjs). A remote pusher types into a pane on ANOTHER
// machine and cannot append to this host's receipts/<id>.jsonl, so before this
// existed a control command to a tmux-push-remote agent was never confirmable:
// send_command waited out deliveryTimeoutMs and reported delivery:"pending"
// even when the command demonstrably ran.
//
// The receipt is appended in the exact shape the local pusher writes, so
// waitForReceipt/deliveryOutcome need no remote-specific branch. `submitted`
// is recorded only when the caller reports it — absence means "typed but
// unverified", which deliveryOutcome refuses to call confirmed. The server
// cannot see the remote pane, so it stores what the pusher observed and
// nothing more; defaulting the field here would recreate assume-success one
// layer up. Trust matches report_transport: the identity gate binds agentId
// to the session, so a pusher can only stamp its own agent's receipt file.
export async function reportReceiptTool(args: {
  agentId: string;
  id: string;
  from?: string;
  control?: boolean;
  submitted?: boolean;
  verified?: boolean;
  reason?: string;
  scriptMtime?: number;
}) {
  const receipt: Receipt & { agentId: string; from?: string } = {
    id: args.id,
    agentId: args.agentId,
    ts: Date.now(),
    ...(args.from !== undefined ? { from: args.from } : {}),
    control: args.control === true,
    ...(args.submitted !== undefined ? { submitted: args.submitted } : {}),
    ...(args.verified !== undefined ? { verified: args.verified } : {}),
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.scriptMtime !== undefined ? { scriptMtime: args.scriptMtime } : {}),
  };
  await appendJsonl(receiptFile(args.agentId), receipt);
  return { ok: true, receipt };
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
  //     scriptMtime against the newest on-disk mtime across hooks/*.mjs
  //     catches it — the whole module graph, not just the entry file, because
  //     the control-submit logic lives in submit.mjs and a fix landing there
  //     alone leaves tmux-pusher.mjs's mtime (and a single-file stamp) intact.
  //     Local tmux-push only — for tmux-push-remote the script lives on a
  //     different host so we can't stat it from here.
  {
    const localPusherMtime = newestPusherSourceMtime();
    const stale: string[] = [];
    const unverifiable: string[] = [];
    for (const fname of await listTransportFiles()) {
      const file = path.join(TRANSPORT_DIR, fname);
      const marker = await readJson<TransportMarker | null>(file, null);
      if (!marker || !isMarkerLive(marker, reg, now)) continue;
      if (marker.transport !== "tmux-push") continue; // remote = can't verify (documented limit: can't stat another host)
      if (marker.scriptMtime === undefined) {
        // ABSENCE IS NOT EXEMPTION. The field's own writer once dropped it,
        // and the silent skip here meant the check was disabled by the very
        // thing it monitors — a live pusher we cannot verify is a warn, not
        // an ok (credit agent-coordination-david-dev). Same flip, same
        // commit, as serverBuildMtime below: the two checks must never
        // disagree about what absence means.
        unverifiable.push(`${marker.agentId} (pid ${marker.pid}, no scriptMtime stamp — cannot verify; detach_agent + attach_agent to re-stamp)`);
        continue;
      }
      if (localPusherMtime === undefined) continue;
      if (marker.scriptMtime < localPusherMtime - 1) { // -1ms slack for fs mtime rounding
        const loaded = new Date(marker.scriptMtime).toISOString();
        const ondisk = new Date(localPusherMtime).toISOString();
        stale.push(`${marker.agentId} (pid ${marker.pid}, loaded ${loaded}, on-disk now ${ondisk})`);
      }
    }
    const bad = [...stale, ...unverifiable];
    findings.push({
      check: "stale-pusher-script",
      level: bad.length ? "warn" : "ok",
      detail: bad.length
        ? `${stale.length} attached pusher(s) running pre-upgrade code and ${unverifiable.length} whose freshness cannot be verified (no stamp) — control commands (/clear, /compact) may be silently dropped. Run detach_agent + attach_agent for each, or have the agent relaunch.`
        : "all attached pushers are running the current on-disk script",
      fixable: false,
      items: bad.length ? bad : undefined,
    });
  }

  // 1b². The same staleness class one layer up: doctor itself runs inside an
  //      MCP server process that imported dist/ at startup. `npm run build`
  //      rewrites dist/ under the still-running server, which then keeps
  //      spawning pushers and stamping markers with logic the rebuild
  //      replaced — merging is not deploying, and until the session restarts
  //      no on-disk artifact reflects what this process will actually do.
  //      Self-scoped by construction: each session's doctor reports on the
  //      server it is running in, which is the only process whose loaded
  //      build it can truthfully know.
  {
    const onDisk = onDiskBuildMtime();
    const drifted =
      SERVER_BUILD_MTIME !== undefined && onDisk !== undefined && SERVER_BUILD_MTIME < onDisk - 1;
    const identity = `${SERVER_BUILD_SHA ?? "unknown-sha"} @ ${BUILD_DIR}`;
    findings.push({
      check: "server-build-drift",
      level: drifted ? "warn" : "ok",
      detail: drifted
        ? `this MCP server loaded its build at ${new Date(SERVER_BUILD_MTIME!).toISOString()} but the on-disk build is newer (${new Date(onDisk!).toISOString()}) — the session is running pre-rebuild code and everything it stamps or spawns uses replaced logic. Restart this agent's session. (${identity})`
        : `server is running the current on-disk build (${identity})`,
      fixable: false,
    });
  }

  // 1b²ᵇ. The affirmative catch for merged-but-never-rebuilt: src/ newer than
  //       the compiled build means no restart can help — the artifact every
  //       future session will load is already behind the code. Distinct from
  //       1b² (a process behind its dist); this is the DISK being behind
  //       itself, which is why it can fire on a bus with zero live sessions.
  //       Not inferred from marker state: both sides are statted directly.
  {
    const srcMtime = onDiskSourceMtime();
    const distMtime = onDiskBuildMtime();
    const behind = srcMtime !== undefined && distMtime !== undefined && distMtime < srcMtime - 1;
    findings.push({
      check: "dist-behind-source",
      level: behind ? "warn" : "ok",
      detail: behind
        ? `src/ is newer than the compiled build (src ${new Date(srcMtime!).toISOString()}, dist ${new Date(distMtime!).toISOString()}) — the checkout was updated but never rebuilt, so every session (current and future) runs pre-update code. \`npm run build\`, then restart sessions.`
        : srcMtime === undefined
          ? "no src/ to compare (packaged install) — dist is the only artifact"
          : "compiled build is at least as new as src/",
      fixable: false,
    });
  }

  // 1b³. Marker provenance — which server BUILD stamped each marker. A live
  //      pusher can be perfectly fresh while the marker's stamps were
  //      computed by an outdated server (observed live 2026-07-29: a stale
  //      server's attach stamped single-file freshness that agreed with the
  //      new on-disk check only because tmux-pusher.mjs happened to be the
  //      newest hooks file). Local tmux-push only, same as 1b.
  {
    const onDisk = onDiskBuildMtime();
    const outdated: string[] = [];
    const unverifiable: string[] = [];
    for (const fname of await listTransportFiles()) {
      const file = path.join(TRANSPORT_DIR, fname);
      const marker = await readJson<TransportMarker | null>(file, null);
      if (!marker || !isMarkerLive(marker, reg, now)) continue;
      if (marker.transport !== "tmux-push") continue; // remote = can't verify (documented limit: can't stat another host)
      if (marker.serverBuildMtime === undefined) {
        // ABSENCE IS NOT EXEMPTION — flipped in the same commit as the
        // scriptMtime absence above, so the two checks can never disagree
        // about what a missing stamp means. An unstamped marker was written
        // by a pre-provenance server (or by hand): precisely the population
        // this check exists to police, and the one it must not exempt.
        // Transition is deliberately correct-and-loud: after the upgrade,
        // every pre-existing marker warns at once, each cleared by a session
        // restart + re-attach — the burst is also the only external view of
        // which sessions still run pre-provenance servers, since a stale
        // server cannot self-report (see 1b²).
        unverifiable.push(`${marker.agentId} (no serverBuildMtime stamp — stamped by a pre-provenance server; restart that session, then detach_agent + attach_agent)`);
        continue;
      }
      if (onDisk === undefined) continue;
      if (marker.serverBuildMtime < onDisk - 1) {
        const stamped = new Date(marker.serverBuildMtime).toISOString();
        const current = new Date(onDisk).toISOString();
        outdated.push(`${marker.agentId} (stamped by server build ${stamped}, on-disk build ${current})`);
      }
    }
    const bad = [...outdated, ...unverifiable];
    findings.push({
      check: "marker-server-provenance",
      level: bad.length ? "warn" : "ok",
      detail: bad.length
        ? `${outdated.length} transport marker(s) stamped by a server build older than dist/ and ${unverifiable.length} with no provenance stamp at all — the stamping/spawn logic (freshness basis, pusher argv) predates or cannot be tied to the current code. Restart that agent's session, then detach_agent + attach_agent.`
        : "all local transport markers were stamped by the current server build",
      fixable: false,
      items: bad.length ? bad : undefined,
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
    const wedged: { agentId: string; pid: number; file: string; target: string; isPusher: boolean }[] = [];
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
        // The marker's pid being alive does not make it OUR pid — see
        // isPusherProcess. Record the verdict now so `fix` only ever signals
        // a confirmed pusher.
        wedged.push({
          agentId: marker.agentId,
          pid: marker.pid,
          file,
          target: marker.tmuxTarget,
          isPusher: isPusherProcess(marker.pid),
        });
      }
    }
    if (fix) {
      for (const w of wedged) {
        // Clearing the marker is always safe — the pane is gone either way, so
        // nothing can be delivered through it. Signalling is not: an
        // unverifiable pid is some other process that inherited this number.
        if (w.isPusher) {
          try { process.kill(w.pid, "SIGTERM"); } catch { /* already gone */ }
        }
        await deleteFile(w.file);
        fixed.push(
          w.isPusher
            ? `reaped wedged pusher for ${w.agentId} (pid ${w.pid}, tmux target '${w.target}' gone)`
            : `cleared stale transport marker for ${w.agentId} (tmux target '${w.target}' gone; pid ${w.pid} is not a tmux-pusher — not signalled)`,
        );
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
      items: wedged.length
        ? wedged.map(
            (w) =>
              `${w.agentId} (pid ${w.pid}, tmux target '${w.target}')${w.isPusher ? "" : " — pid is not a tmux-pusher, marker will be cleared without signalling"}`,
          )
        : undefined,
    });
  }

  // 1d. Duplicate session bindings — two live MCP sessions bound to one agent
  //     id means two processes are ACTING as the same agent (the
  //     disavow-liaison shape: a dev session bound onto a live worker's id;
  //     force/token make that possible on purpose, this makes it visible).
  //     Bindings are per-process closure state, so this reads the on-disk
  //     session markers stdio servers write at bind time. A marker whose pid
  //     is dead is litter from a killed session (default signal death skips
  //     exit handlers) — cleaned under fix. Live duplicates are NOT auto-
  //     fixable: doctor cannot know which of two running sessions is the
  //     impostor; the wrong session should `quit` (its marker clears on exit).
  {
    const byAgent = new Map<string, { pid: number; via: string; boundAt: number }[]>();
    const stale: string[] = [];
    for (const file of await listSessionFiles()) {
      const s = await readJson<SessionBinding | null>(file, null);
      if (!s || typeof s.pid !== "number" || !s.agentId || !isPidAlive(s.pid)) {
        stale.push(path.basename(file));
        if (fix) {
          await deleteFile(file);
          fixed.push(`deleted stale session binding ${path.basename(file)}`);
        }
        continue;
      }
      const list = byAgent.get(s.agentId) ?? [];
      list.push({ pid: s.pid, via: s.via ?? "unknown", boundAt: s.boundAt ?? 0 });
      byAgent.set(s.agentId, list);
    }
    const dupes: string[] = [];
    for (const [id, list] of byAgent) {
      if (list.length < 2) continue;
      dupes.push(
        `${id} — ${list
          .map((b) => `pid ${b.pid} (via ${b.via}, bound ${b.boundAt ? new Date(b.boundAt).toISOString() : "unknown"})`)
          .join(" AND ")}`,
      );
    }
    findings.push({
      check: "duplicate-session-binding",
      level: dupes.length ? "warn" : "ok",
      detail: dupes.length
        ? `${dupes.length} agent id(s) bound by more than one live session — two processes are acting as the same agent. Decide which is legitimate; the other should quit (its binding clears on exit).`
        : stale.length
          ? `no duplicate session bindings (${stale.length} stale binding file(s) from dead sessions${fix ? " — cleaned" : "; run doctor with fix:true to clean"})`
          : "no duplicate session bindings",
      fixable: true,
      items: dupes.length ? dupes : undefined,
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

  // 9b. Document scope drift (Phase 8 Task 4). For each document declared in
  //     scopes.json, compare git's last writer against the declared owner.
  //
  //     DETECTION ONLY, never fixable — rewriting or reverting someone else's
  //     file is not a safe automatic repair, and the bus cannot prevent the
  //     write in the first place (agents edit these with ordinary file tools;
  //     enforcement waits for Task 5). Skips silently when no scopes.json
  //     exists (opt-in) or when the declared repo isn't a git checkout, the
  //     same way the wedged-pusher check skips without tmux — a check that
  //     can't observe anything must not guess.
  {
    const scopes = await loadScopes();
    const drift: string[] = [];
    const unattributed: string[] = [];
    let detail: string;
    if (!scopes.documents.length) {
      detail = scopes.configured
        ? `${path.basename(scopes.file)} declares no documents`
        : `no ${path.basename(scopes.file)} — document scopes are opt-in and none are declared`;
    } else if (!isGitRepo(scopes.repo)) {
      detail = `${scopes.documents.length} document(s) declared but '${scopes.repo}' is not a git checkout — last writer is unknowable, check skipped`;
    } else {
      for (const doc of scopes.documents) {
        const writer = lastWriterOf(scopes.repo, doc.path);
        if (!writer) continue; // never committed — nothing has written it yet
        const who = attributeWriter(writer, reg);
        if (!who) {
          // Commits are authored by humans/machine accounts, not agent ids, so
          // an unmappable author is the normal case — reported, never flagged.
          unattributed.push(`${doc.path}: last written by '${writer.author}' (${writer.commit}), not attributable to a registered agent`);
          continue;
        }
        if (ownsDocument(who.agentId, reg[who.agentId], doc.owner)) continue;
        drift.push(
          `${doc.path}: declared owner '${doc.owner}' (${doc.mode}) but last written by '${who.agentId}'` +
            `${who.roleId ? ` [role ${who.roleId}]` : ""} in ${writer.commit} (${writer.when})`,
        );
      }
      detail = drift.length
        ? `${drift.length} document(s) last written by someone other than their declared owner — advisory: coordinate ownership, doctor will not rewrite anyone's file`
        : `${scopes.documents.length} declared document(s) agree with their scope`;
    }
    findings.push({
      check: "document-scope-drift",
      level: drift.length ? "warn" : "ok",
      detail,
      fixable: false,
      items: drift.length ? drift : unattributed.length ? unattributed : undefined,
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

