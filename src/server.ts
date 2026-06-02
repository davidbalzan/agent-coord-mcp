#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ensureDirs } from "./store.js";
import {
  attachAgentSchema,
  attachAgentTool,
  clearTransportSchema,
  clearTransportTool,
  detachAgentSchema,
  detachAgentTool,
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
function buildServer(): McpServer {
  const server = new McpServer({
    name: "agent-coord",
    version: "0.1.0",
  });

  server.tool(
    "join",
    "Recommended session-start call. Does register + auto-attach (if running inside tmux) + read inbox in one round-trip. Pass attach=false to skip the transport, attach={...overrides} to customize, or omit it to let the server auto-detect $TMUX_PANE. Returns the registration, attach result, any unread inbox messages, and the default channel's topic + MOTD (room rules) so you see them on connect.",
    joinSchema,
    async (args) => jsonResult(await joinTool(args))
  );

  server.tool(
    "register",
    "Register this agent in the shared registry. Lower-level than `join` — does not attach a transport or drain the inbox. Prefer `join` unless you need explicit control.",
    registerSchema,
    async (args) => jsonResult(await registerTool(args))
  );

  server.tool(
    "unregister",
    "Tear down this agent: detach any attached transport (kills the pusher) and remove the registry entry. Clean shutdown counterpart to `join`.",
    unregisterSchema,
    async (args) => jsonResult(await unregisterTool(args))
  );

  server.tool(
    "status",
    "Introspect this agent's coord state: registration, attached transport, inbox depth and unread count, and whether this MCP server is running inside tmux. Useful for debugging 'why isn't my DM landing'.",
    statusSchema,
    async (args) => jsonResult(await statusTool(args))
  );

  server.tool(
    "heartbeat",
    "Refresh this agent's lastHeartbeat timestamp.",
    heartbeatSchema,
    async (args) => jsonResult(await heartbeatTool(args))
  );

  server.tool(
    "list_agents",
    "List all known agents and whether they appear online (heartbeat <5min).",
    listAgentsSchema,
    async () => jsonResult(await listAgentsTool())
  );

  server.tool(
    "send_message",
    "Send a message. If 'to' is set, goes to that agent's inbox (DM); otherwise to a channel — pass 'room' (e.g. 'seo' or '#seo') to target a specific channel, or omit it for the default 'general' channel.",
    sendMessageSchema,
    async (args) => jsonResult(await sendMessageTool(args))
  );

  server.tool(
    "read_messages",
    "Read new messages from inbox|room|status. For source='room', pass 'room' to read a specific channel (default 'general'). Advances the per-channel cursor unless peek=true.",
    readMessagesSchema,
    async (args) => jsonResult(await readMessagesTool(args))
  );

  server.tool(
    "post_status",
    "Append a status broadcast to the shared status stream.",
    postStatusSchema,
    async (args) => jsonResult(await postStatusTool(args))
  );

  server.tool(
    "prune",
    "Trim room/status/inbox JSONL to entries newer than `olderThanDays` (default 7). Removes inbox files for agents no longer in the registry unless removeOrphanInboxes=false. Pass dryRun=true to preview.",
    pruneSchema,
    async (args) => jsonResult(await pruneTool(args))
  );

  server.tool(
    "wait_for_message",
    "Block (max 60s) until a new message appears on the given source, then return it. For source='room', pass 'room' to wait on a specific channel (default 'general').",
    waitForMessageSchema,
    async (args) => jsonResult(await waitForMessageTool(args))
  );

  server.tool(
    "list_rooms",
    "List all channels with their topic, MOTD (room rules), members, message count, and last activity.",
    listRoomsSchema,
    async () => jsonResult(await listRoomsTool())
  );

  server.tool(
    "join_room",
    "Join a channel (creating it if new). Adds this agent to the channel's membership so the notification hooks push its messages, and returns the channel's topic, MOTD, members, and unread count.",
    joinRoomSchema,
    async (args) => jsonResult(await joinRoomTool(args))
  );

  server.tool(
    "leave_room",
    "Leave a channel — removes this agent from its membership. Cannot leave the default 'general' channel.",
    leaveRoomSchema,
    async (args) => jsonResult(await leaveRoomTool(args))
  );

  server.tool(
    "set_room_topic",
    "Set a channel's topic (a short one-line description). Posts a system notice to the channel.",
    setRoomTopicSchema,
    async (args) => jsonResult(await setRoomTopicTool(args))
  );

  server.tool(
    "set_room_motd",
    "Set a channel's MOTD / room rules (shown to agents on join). Posts a system notice to the channel.",
    setRoomMotdSchema,
    async (args) => jsonResult(await setRoomMotdTool(args))
  );

  server.tool(
    "rename_agent",
    "Rename an agent (NICK): migrates its registry entry, inbox, cursor, and channel memberships to the new id, then broadcasts a rename notice to its channels. If a live tmux-push transport is attached it is detached first (the pusher is bound to the old id) — re-attach as the new id (join/attach_agent) to restore real-time delivery; the response sets detachedTransport + a warning when this happens.",
    renameAgentSchema,
    async (args) => jsonResult(await renameAgentTool(args))
  );

  server.tool(
    "attach_agent",
    "Start the tmux-push transport for an agent: spawns hooks/tmux-pusher.mjs as a background process so peer DMs (and optionally room messages) get typed into the agent's tmux pane in real time. tmuxTarget defaults to the MCP server's own $TMUX_PANE if this server is running inside tmux. allowlist restricts which peer agentIds can push. Updates list_agents to show transport=tmux-push.",
    attachAgentSchema,
    async (args) => jsonResult(await attachAgentTool(args))
  );

  server.tool(
    "detach_agent",
    "Stop the tmux-push transport for an agent: kills the pusher process and clears the transport marker.",
    detachAgentSchema,
    async (args) => jsonResult(await detachAgentTool(args))
  );

  server.tool(
    "report_transport",
    "Publish a transport marker for an agent (used by the remote tmux pusher, scripts/coord-pusher.mjs, to surface itself in list_agents). Set transport='tmux-push-remote' and optionally host/tmuxTarget. Liveness for remote markers is heartbeat-based — keep calling heartbeat or this marker gets GC'd after staleness.",
    reportTransportSchema,
    async (args) => jsonResult(await reportTransportTool(args))
  );

  server.tool(
    "clear_transport",
    "Idempotent delete of an agent's transport marker. The wire-callable counterpart to detach_agent for remote pushers: it only removes the marker — there's no local process to kill.",
    clearTransportSchema,
    async (args) => jsonResult(await clearTransportTool(args))
  );

  return server;
}

async function main() {
  ensureDirs();
  // Transport selector. AGENT_COORD_HTTP_PORT set → run as a long-lived HTTP
  // daemon (Streamable HTTP transport + bearer-token auth). Otherwise the
  // historical stdio behavior (per-client subprocess spawned by Claude Code).
  const httpPort = process.env.AGENT_COORD_HTTP_PORT;
  if (httpPort) {
    await startHttp(parseInt(httpPort, 10));
  } else {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

async function startHttp(port: number): Promise<void> {
  const token = process.env.AGENT_COORD_TOKEN;
  if (!token) {
    console.error(
      "[agent-coord-mcp] AGENT_COORD_TOKEN is required when running in HTTP mode. Refusing to start an unauthenticated network listener.",
    );
    process.exit(1);
  }
  const bind = process.env.AGENT_COORD_BIND ?? "127.0.0.1";
  const expected = `Bearer ${token}`;

  // One transport+server pair per client session. The SDK exposes session
  // affinity via the `mcp-session-id` header: a new request without it is
  // an init (create new pair); follow-ups carry the id (look up the pair).
  // We cannot share one stateful transport across clients (it errors with
  // "Server already initialized"), and stateless mode rejects reuse.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function makeSessionTransport(): Promise<StreamableHTTPServerTransport> {
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
    const server = buildServer();
    await server.connect(transport);
    return transport;
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

      // Bearer-token gate. Constant-time compare isn't worthwhile here — the
      // attacker model for the LAN/personal case is "someone on the same
      // network" who can already observe traffic; TLS termination is the
      // answer to that, not auth-side timing tricks.
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
        res.end("unauthorized\n");
        return;
      }

      // Session routing. Existing session id → reuse its transport; new client
      // (no id, POST init) → mint a fresh transport+server pair; anything else
      // is a protocol error.
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("missing or unknown mcp-session-id\n");
          return;
        }
        transport = await makeSessionTransport();
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

  http.listen(port, bind, () => {
    console.error(`[agent-coord-mcp] http listening on ${bind}:${port} (token required)`);
    if (bind !== "127.0.0.1" && bind !== "localhost") {
      console.error(
        `[agent-coord-mcp] WARNING: bound to ${bind} without TLS. Front with a TLS reverse proxy ` +
          `(or restrict to a private network e.g. Tailscale/WireGuard) before exposing publicly.`,
      );
    }
  });
}

main().catch((err) => {
  console.error("[agent-coord-mcp] fatal:", err);
  process.exit(1);
});
