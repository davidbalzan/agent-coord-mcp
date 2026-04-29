# agent-coord-mcp

A tiny file-backed [MCP](https://modelcontextprotocol.io) server that lets multiple AI coding agents on the **same machine** coordinate — share status, send messages to a shared room or to each other's inboxes, and optionally block until a reply arrives.

State lives in `~/agent-coord/` as JSONL/JSON files, so you can `tail -f` the conversation in any terminal.

> **Local-only** — coordination happens through the local filesystem. Agents need to share the same `~/agent-coord/` directory (i.e. same machine, same user). You *can* point `AGENT_COORD_DIR` at a synced/network folder for multi-machine coord, but lockfile semantics over NFS/Dropbox aren't reliable, so it isn't promised.
>
> **Works with any MCP client.** The server speaks plain MCP over stdio: Claude Code, Cursor, Cline, Continue, Zed AI, custom SDK apps. Anywhere two or more agents can connect to the same stdio MCP server, they can talk.
>
> No auth, no encryption. Anything that can read your home directory can read the messages.

## Install

```sh
git clone https://github.com/davidbalzan/agent-coord-mcp.git
cd agent-coord-mcp
npm install            # runs `npm run build` automatically via `prepare`
```

The built entrypoint is `dist/server.js`.

## Connect a client

Each client just needs to launch `node /path/to/agent-coord-mcp/dist/server.js` over stdio.

### Claude Code

```sh
claude mcp add --scope user agent-coord -- node /absolute/path/to/agent-coord-mcp/dist/server.js
```

Or edit `~/.claude.json` directly:

```json
{
  "mcpServers": {
    "agent-coord": {
      "command": "node",
      "args": ["/absolute/path/to/agent-coord-mcp/dist/server.js"]
    }
  }
}
```

### Cursor / Cline / Continue / Zed / etc.

These all use a similar `mcpServers` config block. Drop in the same `command` + `args` shape. Refer to your client's MCP docs for the exact file.

### Custom client (Python / TS)

If you're building an agent with the official MCP SDKs (`@modelcontextprotocol/sdk` in TS, `mcp` in Python), spawn the server as a stdio subprocess and call the tools below — no editor required.

## Tools

| Tool | Purpose |
| --- | --- |
| `register({agentId, project?, role?})` | Announce yourself in `agents.json`. Call once per session. |
| `heartbeat({agentId})` | Refresh your `lastHeartbeat`. |
| `list_agents()` | See all known agents and which look online (heartbeat <5min). |
| `send_message({from, to?, room?, text})` | If `to` set → that agent's inbox. Else → shared room. |
| `read_messages({agentId, source, limit?, peek?, sinceTs?})` | Read new messages. `source` is `inbox`/`room`/`status`. Advances cursor unless `peek:true`. |
| `post_status({agentId, status, detail?})` | Append to the shared status stream (separate from chat). |
| `wait_for_message({agentId, source, timeoutMs?})` | Block (max 60s) until a new entry appears, then return it. |

## Convention for agent IDs

Use the project's directory name or a short stable slug (e.g. `frontend`, `api`, `worker`). Tell each agent — in its `CLAUDE.md`, system prompt, or however your client supports persistent instructions — something like:

> Your coord agentId is `frontend`. On session start, call `register({agentId:"frontend"})` and `read_messages({agentId:"frontend", source:"inbox"})` to see if other agents have left you anything.

## Tail it from a terminal

```sh
# shared room
tail -f ~/agent-coord/room.jsonl

# a specific agent's inbox
tail -f ~/agent-coord/inbox/frontend.jsonl

# status broadcasts
tail -f ~/agent-coord/status.jsonl

# pretty-print live
tail -f ~/agent-coord/room.jsonl | jq -c '{ts: (.ts/1000|todate), from, to, text}'
```

## Files on disk

```
~/agent-coord/
  agents.json            # registry
  room.jsonl             # shared chat
  status.jsonl           # status broadcasts
  inbox/<agentId>.jsonl  # per-agent inboxes
  cursors/<agentId>.json # last-read offsets
```

To reset everything: `rm -rf ~/agent-coord && mkdir -p ~/agent-coord/{inbox,cursors}`.

## Override location

Set `AGENT_COORD_DIR=/some/other/path` in the MCP server's env to relocate state. (`CLAUDE_COORD_DIR` is also honored as a legacy alias.) Useful if you want different agent groups isolated, or to put the dir on a synced volume so agents on different machines can collaborate (caveat above).

## Realtime vs. polling

`wait_for_message` is the cheap path: one tool call, server-side `fs.watch` + 500ms poll, capped at 60s. The model only pays for one round-trip per wait.

The model is fundamentally turn-based — there's no async push that wakes an idle agent. For *passive* presence (react when pinged, even between user turns), wire a client-side hook that runs `read_messages --peek` and injects unread inbox entries into the next prompt. With Claude Code that's a `UserPromptSubmit` hook; other clients have similar mechanisms.

## License

MIT — see [LICENSE](./LICENSE).
