#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ensureDirs, readTokenMapSync } from "./store.js";
import {
  attachAgentSchema,
  attachAgentTool,
  clearTransportSchema,
  clearTransportTool,
  detachAgentSchema,
  detachAgentTool,
  doctorSchema,
  doctorTool,
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
  listRoomsSchema,
  listRoomsTool,
  postStatusSchema,
  postStatusTool,
  pruneSchema,
  pruneTool,
  readMessagesSchema,
  readMessagesTool,
  registerSchema,
  registerTool,
  renameAgentSchema,
  renameAgentTool,
  reportTransportSchema,
  reportTransportTool,
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
  waitForMessageSchema,
  waitForMessageTool,
} from "./tools.js";

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
function buildServer(initialBound?: string): McpServer {
  let bound = initialBound;

  // Gate every tool that takes a caller identity. `field: null` (list_agents,
  // list_rooms, prune) bypasses the check entirely.
  function gate(
    field: "agentId" | "from" | null,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) {
    return async (args: Record<string, unknown>) => {
      if (field) {
        const claimed = args[field];
        if (typeof claimed === "string") {
          if (bound === undefined) {
            bound = claimed; // TOFU: first claim wins, then sticky.
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
    "Recommended session-start call. Does register + auto-attach (if running inside tmux) + read inbox in one round-trip. Pass attach=false to skip the transport, attach={...overrides} to customize, or omit it to let the server auto-detect $TMUX_PANE. Returns the registration, attach result, any unread inbox messages, and the default channel's topic + MOTD (room rules) so you see them on connect.",
    joinSchema,
    gate("agentId", joinTool as (a: Record<string, unknown>) => Promise<unknown>),
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
    "status",
    "Introspect this agent's coord state: registration, attached transport, inbox depth and unread count, and whether this MCP server is running inside tmux. Useful for debugging 'why isn't my DM landing'.",
    statusSchema,
    gate("agentId", statusTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "heartbeat",
    "Refresh this agent's lastHeartbeat timestamp.",
    heartbeatSchema,
    gate("agentId", heartbeatTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "list_agents",
    "List all known agents and whether they appear online (heartbeat <5min).",
    listAgentsSchema,
    gate(null, listAgentsTool as () => Promise<unknown>),
  );

  server.tool(
    "send_message",
    "Send a message. If 'to' is set, goes to that agent's inbox (DM); otherwise to a channel — pass 'room' (e.g. 'seo' or '#seo') to target a specific channel, or omit it for the default 'general' channel. The 'from' field is enforced against the session's bound identity when binding is configured.",
    sendMessageSchema,
    gate("from", sendMessageTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "read_messages",
    "Read new messages from inbox|room|status. For source='room', pass 'room' to read a specific channel (default 'general'). Advances the per-channel cursor unless peek=true.",
    readMessagesSchema,
    gate("agentId", readMessagesTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "post_status",
    "Append a status broadcast to the shared status stream.",
    postStatusSchema,
    gate("agentId", postStatusTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  server.tool(
    "prune",
    "Trim room/status/inbox JSONL to entries newer than `olderThanDays` (default 7). Removes inbox files for agents no longer in the registry unless removeOrphanInboxes=false. Pass dryRun=true to preview.",
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
    "Join a channel (creating it if new). Adds this agent to the channel's membership so the notification hooks push its messages, and returns the channel's topic, MOTD, members, and unread count.",
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
        if (bound === undefined) bound = claimed;
        else if (bound !== claimed) {
          throw new Error(`identity bound to '${bound}'; rejected attempt to act as '${claimed}'`);
        }
      }
      const result = await renameAgentTool(args as { agentId: string; newAgentId: string });
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === true) {
        const to = (result as { to?: unknown }).to;
        if (typeof to === "string") bound = to;
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
    "doctor",
    "Bus-wide health check: inspects the whole state dir and reports drift, leaks, and corruption (orphan transport markers / memberships / inboxes, cursor offsets past EOF, malformed JSONL, stale agents, oversized files, stale locks, channel/registry mismatches, environment). Read-only by default; pass fix=true to apply the safe, reversible repairs (malformed-line rewrites are backed up to .bak first). A clean report (healthy=true) means the bus is internally consistent.",
    doctorSchema,
    gate(null, doctorTool as (a: Record<string, unknown>) => Promise<unknown>),
  );

  return server;
}

// Lazy-loaded token map for HTTP identity binding. Hot-reloaded on SIGHUP so
// operators can rotate / add agents without a server restart.
let tokenMap: Map<string, string> | null = null;
function loadTokenMap(initial: boolean): void {
  try {
    tokenMap = readTokenMapSync();
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
    console.error(`[agent-coord-mcp] SIGHUP: token map reloaded (${tokenMap?.size ?? 0} agents)`);
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
        "[agent-coord-mcp] bus identity unbound (stdio) — falling back to TOFU: the " +
          "first tool call's agentId/from claim becomes this session's bound identity " +
          "and subsequent calls cannot switch. For stricter pre-binding, set " +
          "AGENT_COORD_BOUND_AGENT=<your-id> in the MCP launch env.",
      );
    }
    const server = buildServer(boundAgent);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

async function startHttp(port: number): Promise<void> {
  const sharedToken = process.env.AGENT_COORD_TOKEN;
  const bound = tokenMap !== null;
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

  // One transport+server pair per client session. The SDK exposes session
  // affinity via the `mcp-session-id` header: a new request without it is
  // an init (create new pair); follow-ups carry the id (look up the pair).
  // We cannot share one stateful transport across clients (it errors with
  // "Server already initialized"), and stateless mode rejects reuse.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function makeSessionTransport(boundAgent?: string): Promise<StreamableHTTPServerTransport> {
    // `let` + explicit type lets the SDK callbacks close over the binding
    // before it's assigned — they only fire after construction completes.
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => { sessions.set(id, transport); },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
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
    const mode = bound ? `pre-bound (${tokenMap?.size ?? 0} agents)` : "TOFU";
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
