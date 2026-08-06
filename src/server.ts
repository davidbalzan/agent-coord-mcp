#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  ensureDirs,
  getTokenMap,
  reloadTokenMapSync,
  sessionFile,
  type SessionBinding,
} from "./store.js";
import {
  liveClaimEvidence,
  attachAgentSchema,
  attachAgentTool,
  clearTransportSchema,
  clearTransportTool,
  deleteRoomSchema,
  deleteRoomTool,
  detachAgentSchema,
  detachAgentTool,
  doctorSchema,
  doctorTool,
  forceUnregisterSchema,
  forceUnregisterTool,
  heartbeatSchema,
  heartbeatTool,
  joinRoomSchema,
  joinRoomTool,
  joinSchema,
  joinTool,
  leaveRoomSchema,
  leaveRoomTool,
  listAgentsSchema,
  listAgentsTool,
  pingSchema,
  pingTool,
  listRoomsSchema,
  listRoomsTool,
  postStatusSchema,
  postStatusTool,
  pruneSchema,
  pruneTool,
  readMessagesSchema,
  readMessagesTool,
  retrieveMessageSchema,
  retrieveMessageTool,
  retrieveRoomHistorySchema,
  retrieveRoomHistoryTool,
  registerSchema,
  registerTool,
  renameAgentSchema,
  renameAgentTool,
  reportReceiptSchema,
  reportReceiptTool,
  reportTransportSchema,
  reportTransportTool,
  sendCommandSchema,
  sendCommandTool,
  sendMessageSchema,
  sendMessageTool,
  setRoomMotdSchema,
  setRoomMotdTool,
  setRoomTopicSchema,
  setRoomTopicTool,
  statusSchema,
  statusTool,
  unregisterSchema,
  unregisterTool,
  quitSchema,
  quitTool,
  waitForMessageSchema,
  waitForMessageTool,
  listScopesSchema,
  listScopesTool,
  importWorkSchema,
  importWorkTool,
  listWorkSchema,
  listWorkTool,
  exportWorkSchema,
  exportWorkTool,
} from "./tools/index.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// Build a fully-configured McpServer with every tool registered. Returns a
// fresh instance each call — in HTTP mode we need one server per session so
// transports don't share Protocol state.
//
// Identity binding (v0.7.0 + TOFU in v0.7.1):
//   - `initialBound` (when set) pre-binds the session — from a bearer token
//     (HTTP/tokens.json) or AGENT_COORD_BOUND_AGENT env (stdio).
//   - Otherwise the session starts unbound. The first tool call that carries
//     an agentId/from field captures that value as the session's binding —
//     trust-on-first-use. Subsequent calls must match; mid-session identity
//     switching (the PR #45 spoof shape) is rejected.
//   - rename_agent updates the binding to the new id on success so the
//     renamed session keeps working.
//   - First-claim guard (v0.20.0): TOFU no longer lets a fresh session claim
//     an id that is currently LIVE on the bus (fresh heartbeat, live
//     transport, or another live bound session) — that silently created a
//     second session acting as an already-running agent (hit live 2026-07-06:
//     a dev session bound itself to `disavow-liaison`). A live-id claim needs
//     the agent's token or an explicit force (join/register params). See
//     guardFirstClaim for how absent vs unreadable evidence is decided.
//   - `trackSession` (stdio only): each successful bind writes a
//     sessions/<id>.<pid>.<nonce>.json marker so doctor can SEE two live
//     sessions bound to one id — closure state alone cannot be inspected
//     from outside the process. Not tracked for HTTP sessions: tokens.json
//     already enforces their identity and many share one pid, which would
//     make pid-liveness meaningless.
function buildServer(initialBound?: string, opts: { trackSession?: boolean } = {}): McpServer {
  let bound = initialBound;
  const trackSession = opts.trackSession ?? false;
  let sessionMarker: string | undefined;
  let exitHooksInstalled = false;

  // Best-effort: a marker left behind by SIGKILL has a dead pid, which both
  // the guard's evidence read and doctor's duplicate-session-binding check
  // treat as garbage (doctor fix deletes it).
  function recordSessionBinding(agentId: string, via: string): void {
    if (!trackSession) return;
    try {
      const file = sessionFile(agentId, process.pid, randomUUID().slice(0, 8));
      const marker: SessionBinding = {
        agentId,
        pid: process.pid,
        boundAt: Date.now(),
        via,
        ...(process.env.TMUX_PANE ? { tmuxPane: process.env.TMUX_PANE } : {}),
      };
      writeFileSync(file, JSON.stringify(marker, null, 2) + "\n");
      if (sessionMarker) {
        try { unlinkSync(sessionMarker); } catch { /* already gone */ }
      }
      sessionMarker = file;
      if (!exitHooksInstalled) {
        exitHooksInstalled = true;
        const cleanup = () => {
          try { if (sessionMarker) unlinkSync(sessionMarker); } catch { /* already gone */ }
        };
        process.on("exit", cleanup);
        // Default signal death skips 'exit' handlers; SIGHUP stays reserved
        // for the token-map reload in loadTokenMap.
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
          process.on(sig, () => { cleanup(); process.exit(0); });
        }
      }
    } catch { /* marker is observability, never worth failing the bind */ }
  }

  // Decide whether a fresh session may claim `claimed` as its identity, and
  // how. Returns the bind provenance ("tofu" | "token" | "force" |
  // "same-pane") or throws. Ordering is deliberate:
  //   - a presented token must MATCH or the claim fails loudly, even when the
  //     id is not live — a wrong credential silently succeeding via the
  //     not-live path would teach callers that garbage tokens work;
  //   - force is an explicit human/agent decision, honored before evidence;
  //   - evidence that exists but cannot be read REFUSES (cannot-verify ≠
  //     verified-absent; unreadable state must not disable the guard);
  //   - a live id refuses, except when its live pusher types into THIS
  //     process's own tmux pane — two sessions cannot share a pane, so that
  //     is the same seat restarting (the routine fleet-restart case), not a
  //     second session. The exception never applies when another live
  //     session is already bound to the id.
  //   - verified-not-live binds freely: refusing absent evidence would break
  //     every first onboarding, and the guard exists to protect LIVE ids.
  async function guardFirstClaim(claimed: string, args: Record<string, unknown>): Promise<string> {
    const token = typeof args["token"] === "string" ? (args["token"] as string) : undefined;
    if (token !== undefined) {
      if (getTokenMap()?.get(token) === claimed) return "token";
      throw new Error(
        `token presented for '${claimed}' does not match tokens.json (or no token map is loaded). ` +
          `Mint one with scripts/coord-token.mjs add ${claimed} (then SIGHUP the bus), or pass force:true if you are certain.`,
      );
    }
    if (args["force"] === true) return "force";
    const ev = await liveClaimEvidence(claimed, Date.now());
    if (!ev.verifiable) {
      throw new Error(
        `cannot verify whether '${claimed}' is live: ${ev.reasons.join("; ")}. ` +
          `Refusing to bind rather than treating unreadable evidence as absence. ` +
          `Repair the state (doctor), or pass the agent's token or force:true (join/register).`,
      );
    }
    if (ev.live) {
      if (ev.samePane && ev.boundElsewhere === 0) return "same-pane";
      throw new Error(
        `agent '${claimed}' is live on this bus (${ev.reasons.join("; ")}) — refusing to bind this fresh session to it. ` +
          `If you ARE '${claimed}' restarting, re-join from its tmux pane, or pass its token or force:true (join/register). ` +
          `If you are diagnosing, use status/ping (read-only, they never bind) or your own id.`,
      );
    }
    return "tofu";
  }

  // Gate every tool that takes a caller identity. `field: null` (list_agents,
  // list_rooms, prune) bypasses the check entirely.
  //
  // `bindOnClaim: false` (status, ping) means the tool still enforces a
  // mismatch against an *existing* binding, but a fresh (unbound) session
  // never claims one just by naming an agentId — a diagnostic status/ping
  // call must not be able to silently TOFU-bind a session to some other,
  // already-live agent's identity.
  function gate(
    field: "agentId" | "from" | null,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    { bindOnClaim = true }: { bindOnClaim?: boolean } = {},
  ) {
    return async (args: Record<string, unknown>) => {
      if (field) {
        const claimed = args[field];
        if (typeof claimed === "string") {
          if (bound === undefined) {
            if (bindOnClaim) {
              // TOFU: first claim wins, then sticky — but only after the
              // first-claim guard agrees the id isn't someone else's live
              // session (see guardFirstClaim).
              const via = await guardFirstClaim(claimed, args);
              bound = claimed;
              recordSessionBinding(claimed, via);
            }
          } else if (bound !== claimed) {
            throw new Error(
              `identity bound to '${bound}'; rejected attempt to act as '${claimed}'`,
            );
          }
        }
      }
      return jsonResult(await handler(args));
    };
  }

  const server = new McpServer({
    name: "agent-coord",
    version: "0.1.0",
  });

  server.tool(
    "join",
    "Recommended session-start call. Does register + auto-attach (if running inside tmux) + read inbox in one round-trip. Pass attach=false to skip the transport, attach={...overrides} to customize, or omit it to let the server auto-detect $TMUX_PANE. Returns the registration, attach result, any unread inbox messages, and the default channel's topic + MOTD (room rules) so you see them on connect. Calling join binds this MCP process's identity to agentId for the lifetime of the session — no env var or config needed. Each Claude Code session runs its own stdio process so bindings are naturally isolated. Claiming an id that is currently LIVE on the bus (fresh heartbeat, live pusher, or another bound session) is refused unless the claim comes from that agent's own tmux pane or carries the agent's token or force:true — diagnosing someone else's agent is what status/ping are for.",
    joinSchema,
    // join explicitly sets the session binding when unset, so each agent can
    // declare its identity via join rather than relying on env vars.
    async (args: Record<string, unknown>) => {
      const claimed = args["agentId"];
      if (typeof claimed === "string") {
        if (bound === undefined) {
          const via = await guardFirstClaim(claimed, args);
          bound = claimed;
          recordSessionBinding(claimed, via);
        } else if (bound !== claimed) {
          throw new Error(
            `identity bound to '${bound}'; rejected attempt to act as '${claimed}'`,
          );
        }
      }
      return jsonResult(await (joinTool as (a: Record<string, unknown>) => Promise<unknown>)(args));
    },
  );

  server.tool(
    "register",
    "Register this agent in the shared registry. Lower-level than `join` — does not attach a transport or drain the inbox. Prefer `join` unless you need explicit control.",
    registerSchema,
    gate("agentId", registerTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "unregister",
    "Tear down this agent: detach any attached transport (kills the pusher) and remove the registry entry. Clean shutdown counterpart to `join`.",
    unregisterSchema,
    gate("agentId", unregisterTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "quit",
    "Clean shutdown: unregister this agent (detach transport, leave rooms, remove registry entry) then exit the MCP process. Only callable by the session's bound identity. Use this to cleanly hand off before a restart with a new name.",
    quitSchema,
    gate("agentId", quitTool as unknown as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "status",
    "Introspect this agent's coord state: registration, attached transport, inbox depth and unread count, and whether this MCP server is running inside tmux. Useful for debugging 'why isn't my DM landing'. Read-only — naming an agentId here never binds this session's identity.",
    statusSchema,
    gate("agentId", statusTool as (a: Record<string, unknown>) => Promise<unknown>, { bindOnClaim: false }),
  );

  server.tool(
    "heartbeat",
    "Refresh this agent's lastHeartbeat timestamp.",
    heartbeatSchema,
    gate("agentId", heartbeatTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "ping",
    "Liveness probe for another agent, answered entirely from server-side state (registry entry, transport marker, pusher pid, tmux pane) — it never touches the target's session, so a fleet-wide sweep costs zero model tokens on the targets. Returns alive (fresh heartbeat or live transport), reachable (a DM pushed now would land), granular checks, and latencyMs. Distinct from heartbeat, which is an agent refreshing its OWN activity timestamp. Pass echo:true (default off) to additionally drop a PING DM into the target's inbox — that wakes the target's model, so use it sparingly and only when you need an agent-level acknowledgement. 'from' is enforced against the session's bound identity, but read-only — naming 'from' here never binds this session's identity.",
    pingSchema,
    gate("from", pingTool as (a: Record<string, unknown>) => Promise<unknown>, { bindOnClaim: false }),
  );

  server.tool(
    "list_agents",
    "List all known agents and whether they appear online (heartbeat <5min).",
    listAgentsSchema,
    gate(null, listAgentsTool as () => Promise<unknown>),
  );

  server.tool(
    "send_message",
    "Send a message. If 'to' is set, goes to that agent's inbox (DM); otherwise to a channel — pass 'room' (e.g. 'seo' or '#seo') to target a specific channel, or omit it for the default 'general' channel. For channel posts, tag 'kind': 'decision' for GOs/verdicts/agreements that must outlive routine cleanup (kept ~30 days, quoted verbatim in digests), 'status' for progress notes, omit for ordinary chatter. The 'from' field is enforced against the session's bound identity when binding is configured.",
    sendMessageSchema,
    gate("from", sendMessageTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "send_command",
    "Inject a context-management slash command (/clear or /compact) directly into a sub-agent's live tmux session — delivered RAW with no banner or prefix, so the agent's CLI runs it as a real slash command. Target one agent with 'to' or broadcast to a channel's tmux-attached members with 'room' (never the sender). Hard-gated to tmux: returns ok:false if the target has no live tmux-push(-remote) transport. By default BLOCKS until the receiving pusher confirms it actually typed the command into the pane (out-of-band delivery receipt, no added agent context) and returns delivery:'confirmed' with deliveredAt, or delivery:'pending'+warning if no receipt arrived within deliveryTimeoutMs (default 8000) — a stale/wedged pusher. Pass waitForDelivery:false for fire-and-forget. Intended for a lead agent to clear/compact sub-agent context and save tokens. The command allowlist is locked to /clear and /compact; nothing else is accepted. 'from' is enforced against the session's bound identity.",
    sendCommandSchema,
    gate("from", sendCommandTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "read_messages",
    "Read new messages from inbox|room|status. For source='room', pass 'room' to read a specific channel (default 'general'). Room and status reads return the most recent 50 entries per call — pass limit to override (max 500). When the backlog exceeds the window, the older overflow is replaced by a compact `history` digest carrying a retrieval hash; call retrieve_room_history(hash) to expand it. Inbox drains fully by default. Advances the per-channel cursor unless peek=true.",
    readMessagesSchema,
    gate("agentId", readMessagesTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "retrieve_room_history",
    "Expand a compressed channel-history digest returned by read_messages. Pass the `hash` from the `history` field; optionally pass `query` to return only matching messages (case-insensitive substring). Entries are scoped to the agent that produced them and expire after 30 minutes — if expired, re-read the channel with a higher limit instead.",
    retrieveRoomHistorySchema,
    gate("agentId", retrieveRoomHistoryTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "retrieve_message",
    "Expand a `retrieve_message id=<uuid>` handle from a pane digest into the full message and its typed `record`. A record whose text rendering spans multiple lines (a DAVID_DECISION packet) is delivered to a pane as ONE attributed line plus this handle; call it to get the structured record back. Reads the message by id from the channels you can read (your inbox and rooms you belong to), falling through to the append-only archive if compaction moved it — so unlike retrieve_room_history there is no TTL and nothing to expire. A handle for a message never delivered to you is simply not found.",
    retrieveMessageSchema,
    gate("agentId", retrieveMessageTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "post_status",
    "Append a status broadcast to the shared status stream.",
    postStatusSchema,
    gate("agentId", postStatusTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "prune",
    "Trim room/status/inbox JSONL to entries newer than `olderThanDays` (default 7); kind='decision' posts keep a longer `decisionDays` retention (default 30). Nothing is lost: aged-out entries are archived under archive/ (rooms/<chan>.jsonl, status.jsonl, inbox/<agent>.jsonl) — only receipts are truly deleted. `room` and `targets` compose: `room` scopes every sweep to that channel (and, alone, defaults the sweep to `rooms` only), while `targets` (rooms|status|inbox|receipts|members) selects which sweeps run and always wins over that default — so `{room, targets:['members']}` sweeps membership in that one channel. Sweeps room members that are unregistered or haven't heartbeated since the cutoff, and archives+removes non-default rooms left empty and inactive (disable via archiveEmptyRooms=false). Removes inbox files for agents no longer in the registry unless removeOrphanInboxes=false. Pass dryRun=true to preview.",
    pruneSchema,
    gate(null, pruneTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "wait_for_message",
    "Block (max 60s) until a new message appears on the given source, then return it. For source='room', pass 'room' to wait on a specific channel (default 'general').",
    waitForMessageSchema,
    gate("agentId", waitForMessageTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "list_rooms",
    "List all channels with their topic, MOTD (room rules), members, message count, and last activity.",
    listRoomsSchema,
    gate(null, listRoomsTool as () => Promise<unknown>),
  );

  server.tool(
    "join_room",
    "Join a channel (creating it if new). Adds this agent to the channel's membership so the notification hooks push its messages. Posts a system join notice to the channel. Returns the channel's topic, MOTD, member list, and unread message count — but not the messages themselves. Call read_messages to fetch history if needed.",
    joinRoomSchema,
    gate("agentId", joinRoomTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "leave_room",
    "Leave a channel — removes this agent from its membership. Cannot leave the default 'general' channel.",
    leaveRoomSchema,
    gate("agentId", leaveRoomTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "set_room_topic",
    "Set a channel's topic (a short one-line description). Posts a system notice to the channel.",
    setRoomTopicSchema,
    gate("agentId", setRoomTopicTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "set_room_motd",
    "Set a channel's MOTD / room rules (shown to agents on join). Posts a system notice to the channel.",
    setRoomMotdSchema,
    gate("agentId", setRoomMotdTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "rename_agent",
    "Rename an agent (NICK): migrates its registry entry, inbox, cursor, and channel memberships to the new id, then broadcasts a rename notice to its channels. When tokens.json identity binding is on, the caller's bearer token is atomically rotated to the new id so the same session keeps authenticating after rename. If a live tmux-push transport is attached it is detached first (the pusher is bound to the old id) — re-attach as the new id (join/attach_agent) to restore real-time delivery; the response sets detachedTransport + a warning when this happens.",
    renameAgentSchema,
    // Special: after a successful rename we update the session's bound id
    // too, so the same session can keep operating under the new name without
    // the next call being rejected as a binding mismatch.
    async (args: Record<string, unknown>) => {
      const claimed = args.agentId;
      if (typeof claimed === "string") {
        if (bound === undefined) {
          // Renaming a live agent from a fresh session is still a first
          // claim of that agent's identity — same guard as any other.
          const via = await guardFirstClaim(claimed, args);
          bound = claimed;
          recordSessionBinding(claimed, via);
        } else if (bound !== claimed) {
          throw new Error(`identity bound to '${bound}'; rejected attempt to act as '${claimed}'`);
        }
      }
      const result = await renameAgentTool(args as { agentId: string; newAgentId: string });
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === true) {
        const to = (result as { to?: unknown }).to;
        if (typeof to === "string") {
          bound = to;
          recordSessionBinding(to, "rename");
        }
      }
      return jsonResult(result);
    },
  );

  server.tool(
    "attach_agent",
    "Start the tmux-push transport for an agent: spawns hooks/tmux-pusher.mjs as a background process so peer DMs (and optionally room messages) get typed into the agent's tmux pane in real time. tmuxTarget defaults to the MCP server's own $TMUX_PANE if this server is running inside tmux. allowlist restricts which peer agentIds can push. Updates list_agents to show transport=tmux-push.",
    attachAgentSchema,
    gate("agentId", attachAgentTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "detach_agent",
    "Stop the tmux-push transport for an agent: kills the pusher process and clears the transport marker.",
    detachAgentSchema,
    gate("agentId", detachAgentTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "report_transport",
    "Publish a transport marker for an agent (used by the remote tmux pusher, scripts/coord-pusher.mjs, to surface itself in list_agents). Set transport='tmux-push-remote' and optionally host/tmuxTarget. Liveness for remote markers is heartbeat-based — keep calling heartbeat or this marker gets GC'd after staleness.",
    reportTransportSchema,
    gate("agentId", reportTransportTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "clear_transport",
    "Idempotent delete of an agent's transport marker. The wire-callable counterpart to detach_agent for remote pushers: it only removes the marker — there's no local process to kill.",
    clearTransportSchema,
    gate("agentId", clearTransportTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "report_receipt",
    "Append a delivery receipt for a message this agent's pusher just typed into its pane — the wire-callable counterpart to the local pusher's receipts/<id>.jsonl stamp, for remote pushers (scripts/coord-pusher.mjs) that cannot write this host's filesystem. This is what lets send_command to a tmux-push-remote agent return delivery:'confirmed'. For control commands pass exactly what submit verification observed (submitted/verified/reason); omitting 'submitted' means 'typed but unverified' and is reported as delivery:'pending', never 'confirmed'. 'agentId' (the receiving agent) is enforced against the session's bound identity, so a pusher can only stamp its own agent's receipt file.",
    reportReceiptSchema,
    gate("agentId", reportReceiptTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "doctor",
    "Bus-wide health check: inspects the whole state dir and reports drift, leaks, and corruption (orphan transport markers / memberships / inboxes, cursor offsets past EOF, malformed JSONL, stale agents, oversized files, stale locks, channel/registry mismatches, environment). Read-only by default; pass fix=true to apply the safe, reversible repairs (malformed-line rewrites are backed up to .bak first). A clean report (healthy=true) means the bus is internally consistent.",
    doctorSchema,
    gate(null, doctorTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "list_scopes",
    "Read the declared write scopes for managed documents (~/agent-coord/scopes.json). Call it with 'path' (and your 'agentId') to ask \"may I write this?\" BEFORE editing a shared doc like docs/QUEUE.md; call it bare to list every declared document and its owning role. ADVISORY ONLY: the bus does not mediate file writes, so this answers who owns a document, it does not stop anyone — enforcement arrives when work state moves into the store. Absent scopes.json means nothing is owned and nothing warns (opt-in).",
    listScopesSchema,
    gate(null, listScopesTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "import_work",
    "Read a project's work documents (docs/QUEUE.md + docs/DONE.md, or the legacy docs/BACKLOG.md, plus docs/WORKSTREAMS.md) into typed records: queue items {priority,text,done}, done entries {text,ref,date} and board rows. The markdown stays authoritative — this store is a derived index, and export_work renders it back byte-identically.",
    importWorkSchema,
    gate(null, importWorkTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "list_work",
    "Query a project's work state as records instead of parsing markdown: open queue items (filter by priority), done entries with their ref and date as separate fields, and the board's lane rows. Falls back to reading the documents directly when nothing has been imported, so it works with no store at all.",
    listWorkSchema,
    gate(null, listWorkTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "export_work",
    "Render a project's work documents back out of the store, reproducing the pinned glyph contract exactly (ref after the last ' \u2014 ', date after a trailing ' \u00b7 '). Reports by default; pass write:true to rewrite the files. Refuses to export from an empty store rather than blanking a document. Any declared Task 4 write scope is REPORTED alongside the write, never enforced.",
    exportWorkSchema,
    gate(null, exportWorkTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "delete_room",
    "Permanently delete a channel: removes it from the registry, deletes its JSONL file, and clears all agent cursor offsets for that channel. Refuses if agents are still joined unless force=true. Cannot delete the default 'general' channel. Posts a system notice to #general on success.",
    deleteRoomSchema,
    gate("agentId", deleteRoomTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "force_unregister",
    "Admin eviction: unregisters any agent by targetAgentId regardless of the caller's identity. Detaches the agent's transport, removes it from all channel memberships, and drops its registry entry. Use after a reboot to clean up stale agents that can no longer unregister themselves.",
    forceUnregisterSchema,
    gate(null, forceUnregisterTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  // An env pre-bound session is just as live as a TOFU-bound one — record it
  // so doctor's duplicate check sees it too. (No-op unless trackSession.)
  if (initialBound) recordSessionBinding(initialBound, "env");

  return server;
}

// Token map for HTTP identity binding, held in-process via store.ts's
// shared cache. Hot-reloaded on SIGHUP so operators can rotate / add agents
// without a server restart; also refreshed automatically by rename_agent
// (see rotateAgentToken) so a live rename doesn't need one.
function loadTokenMap(initial: boolean): void {
  try {
    reloadTokenMapSync();
  } catch (e) {
    // On initial load a bad file is fatal — refuse to start in a known-bad
    // auth state. On SIGHUP, log and keep the previous (valid) map.
    if (initial) {
      console.error((e as Error).message);
      process.exit(1);
    }
    console.error(`[agent-coord-mcp] SIGHUP: ${(e as Error).message} (keeping previous map)`);
    return;
  }
  if (!initial) {
    console.error(`[agent-coord-mcp] SIGHUP: token map reloaded (${getTokenMap()?.size ?? 0} agents)`);
  }
}

async function main() {
  ensureDirs();
  loadTokenMap(true);
  process.on("SIGHUP", () => loadTokenMap(false));

  // Transport selector. AGENT_COORD_HTTP_PORT set → run as a long-lived HTTP
  // daemon (Streamable HTTP transport + bearer-token auth). Otherwise the
  // historical stdio behavior (per-client subprocess spawned by Claude Code).
  const httpPort = process.env.AGENT_COORD_HTTP_PORT;
  if (httpPort) {
    await startHttp(parseInt(httpPort, 10));
  } else {
    const boundAgent = process.env.AGENT_COORD_BOUND_AGENT;
    if (!boundAgent) {
      console.error(
        "[agent-coord-mcp] WARNING: AGENT_COORD_BOUND_AGENT is not set.\n" +
          "  The session identity will be locked to whatever agentId is used in the first\n" +
          "  tool call (TOFU). This cannot be changed mid-session.\n" +
          "  To fix: add AGENT_COORD_BOUND_AGENT=<your-agent-id> to the MCP server env\n" +
          "  in your Claude Code MCP config, then restart. Use the `quit` tool to cleanly\n" +
          "  unregister before restarting so the new name starts fresh.",
      );
    }
    const server = buildServer(boundAgent, { trackSession: true });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

async function startHttp(port: number): Promise<void> {
  const sharedToken = process.env.AGENT_COORD_TOKEN;
  const bound = getTokenMap() !== null;
  if (!bound && !sharedToken) {
    console.error(
      "[agent-coord-mcp] HTTP mode needs auth: either set AGENT_COORD_TOKEN (legacy " +
        "shared bearer, advisory identity) or create ~/agent-coord/tokens.json (per-agent " +
        "tokens, enforced identity). Refusing to start an unauthenticated network listener.",
    );
    process.exit(1);
  }
  if (bound && sharedToken) {
    console.error(
      "[agent-coord-mcp] note: tokens.json is present — AGENT_COORD_TOKEN is ignored " +
        "(per-agent tokens take precedence).",
    );
  }
  if (!bound) {
    console.error(
      "[agent-coord-mcp] bus identity unbound (HTTP) — shared bearer auths the channel; " +
        "per-session identity falls back to TOFU (the first agentId/from claim becomes " +
        "the session's bound id, can't switch mid-stream). Create ~/agent-coord/tokens.json " +
        "to pre-bind sessions to identities at connect time.",
    );
  }
  const bindAddr = process.env.AGENT_COORD_BIND ?? "127.0.0.1";
  const sharedExpected = sharedToken ? `Bearer ${sharedToken}` : null;

  // Fail-closed network gate. A non-loopback bind is a real network listener, so
  // it must have (a) enforced per-agent identity and (b) a secured transport. We
  // refuse rather than warn: a shared/advisory token lets any node impersonate
  // any agent, and plaintext leaks bearer tokens to anyone on the path.
  const isLoopbackBind =
    bindAddr === "127.0.0.1" || bindAddr === "localhost" || bindAddr === "::1";
  if (!isLoopbackBind) {
    if (!bound) {
      console.error(
        `[agent-coord-mcp] refusing to bind ${bindAddr} without per-agent tokens: a ` +
          `shared/advisory token lets any node impersonate any agent. Create ` +
          `~/agent-coord/tokens.json (per-agent, enforced identity) for network binds.`,
      );
      process.exit(1);
    }
    if (process.env.AGENT_COORD_INSECURE !== "1") {
      console.error(
        `[agent-coord-mcp] refusing plaintext bind to ${bindAddr}: bearer tokens would ` +
          `travel in cleartext. Put the bus behind TLS or a private overlay ` +
          `(Tailscale/WireGuard), then set AGENT_COORD_INSECURE=1 to acknowledge the ` +
          `transport is secured out-of-band.`,
      );
      process.exit(1);
    }
  }

  // One transport+server pair per client session. The SDK exposes session
  // affinity via the `mcp-session-id` header: a new request without it is
  // an init (create new pair); follow-ups carry the id (look up the pair).
  // We cannot share one stateful transport across clients (it errors with
  // "Server already initialized"), and stateless mode rejects reuse.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  // Which bound agent each session id belongs to, so a session can't be driven
  // by a *different* bearer that merely presents its id (session hijack).
  const sessionAgents = new Map<string, string | undefined>();

  async function makeSessionTransport(boundAgent?: string): Promise<StreamableHTTPServerTransport> {
    // `let` + explicit type lets the SDK callbacks close over the binding
    // before it's assigned — they only fire after construction completes.
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
        sessionAgents.set(id, boundAgent);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        sessionAgents.delete(transport.sessionId);
      }
    };
    const server = buildServer(boundAgent);
    await server.connect(transport);
    return transport;
  }

  // Reverse-lookup: extract bearer from header, map → bound agent. Returns
  // undefined if no map is configured (advisory mode); throws-like return of
  // null if the bearer doesn't match any known agent (caller responds 401).
  function resolveBoundAgent(authHeader: string | undefined): { ok: boolean; agent?: string } {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return { ok: false };
    const bearer = authHeader.slice("Bearer ".length);
    const tokenMap = getTokenMap();
    if (tokenMap) {
      const agent = tokenMap.get(bearer);
      return agent ? { ok: true, agent } : { ok: false };
    }
    // Advisory mode: only check the shared bearer matches.
    return sharedExpected && authHeader === sharedExpected ? { ok: true } : { ok: false };
  }

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Unauthenticated liveness probe so reverse proxies / orchestrators can
      // health-check without needing a credential.
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok\n");
        return;
      }

      // Auth gate. In bound mode the bearer also tells us *which* agent the
      // session is bound to; in advisory mode it just gates entry. Constant-
      // time compare isn't worthwhile here — the attacker model for the
      // LAN/personal case is "someone on the same network" who can already
      // observe traffic; TLS termination is the answer to that.
      const resolved = resolveBoundAgent(req.headers.authorization);
      if (!resolved.ok) {
        res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
        res.end("unauthorized\n");
        return;
      }

      // Session routing. Existing session id → reuse its transport; new client
      // (no id, POST init) → mint a fresh transport+server pair bound to the
      // bearer's agent; anything else is a protocol error.
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
      // Re-bind check: a session is pinned to the agent whose bearer opened it.
      // In bound mode, reject a request whose bearer resolves to a *different*
      // agent than the session was created for — otherwise any valid token plus
      // a leaked session id could drive that session's identity (session hijack).
      if (
        transport &&
        getTokenMap() &&
        typeof sid === "string" &&
        sessionAgents.get(sid) !== resolved.agent
      ) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("session/identity mismatch\n");
        return;
      }
      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("missing or unknown mcp-session-id\n");
          return;
        }
        transport = await makeSessionTransport(resolved.agent);
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[agent-coord-mcp] http request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error\n");
      }
    }
  });

  http.listen(port, bindAddr, () => {
    const mode = bound ? `pre-bound (${getTokenMap()?.size ?? 0} agents)` : "TOFU";
    console.error(`[agent-coord-mcp] http listening on ${bindAddr}:${port} — identity ${mode}`);
    if (bindAddr !== "127.0.0.1" && bindAddr !== "localhost") {
      console.error(
        `[agent-coord-mcp] WARNING: bound to ${bindAddr} without TLS. Front with a TLS reverse proxy ` +
          `(or restrict to a private network e.g. Tailscale/WireGuard) before exposing publicly.`,
      );
    }
  });
}

main().catch((err) => {
  console.error("[agent-coord-mcp] fatal:", err);
  process.exit(1);
});
