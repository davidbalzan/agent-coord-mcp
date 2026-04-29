#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDirs } from "./store.js";
import {
  heartbeatSchema,
  heartbeatTool,
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
    "register",
    "Register this agent in the shared registry. Call once per session.",
    registerSchema,
    async (args) => jsonResult(await registerTool(args))
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[agent-coord-mcp] fatal:", err);
  process.exit(1);
});
