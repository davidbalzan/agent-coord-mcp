#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDirs } from "./store.js";
import {
  attachAgentSchema,
  attachAgentTool,
  detachAgentSchema,
  detachAgentTool,
  heartbeatSchema,
  heartbeatTool,
  joinSchema,
  joinTool,
  listAgentsSchema,
  listAgentsTool,
  postStatusSchema,
  postStatusTool,
  pruneSchema,
  pruneTool,
  readMessagesSchema,
  readMessagesTool,
  registerSchema,
  registerTool,
  sendMessageSchema,
  sendMessageTool,
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

async function main() {
  ensureDirs();

  const server = new McpServer({
    name: "agent-coord",
    version: "0.1.0",
  });

  server.tool(
    "join",
    "Recommended session-start call. Does register + auto-attach (if running inside tmux) + read inbox in one round-trip. Pass attach=false to skip the transport, attach={...overrides} to customize, or omit it to let the server auto-detect $TMUX_PANE. Returns the registration, attach result, and any unread inbox messages.",
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
    "Send a message. If 'to' is set, goes to that agent's inbox; otherwise to the shared room.",
    sendMessageSchema,
    async (args) => jsonResult(await sendMessageTool(args))
  );

  server.tool(
    "read_messages",
    "Read new messages from inbox|room|status. Advances the cursor unless peek=true.",
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
    "Block (max 60s) until a new message appears on the given source, then return it.",
    waitForMessageSchema,
    async (args) => jsonResult(await waitForMessageTool(args))
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[agent-coord-mcp] fatal:", err);
  process.exit(1);
});
