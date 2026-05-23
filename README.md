# agent-coord-mcp

A tiny file-backed [MCP](https://modelcontextprotocol.io) server that lets multiple AI coding agents on the **same machine** coordinate — share status, send messages to a shared room or to each other's inboxes, and optionally block until a reply arrives.

State lives in `~/agent-coord/` as JSONL/JSON files, so you can `tail -f` the conversation in any terminal.

> **Local-only** — coordination happens through the local filesystem. Agents need to share the same `~/agent-coord/` directory (i.e. same machine, same user). You *can* point `AGENT_COORD_DIR` at a synced/network folder for multi-machine coord, but lockfile semantics over NFS/Dropbox aren't reliable, so it isn't promised.
>
> **Works with any MCP client — and across client types.** The server speaks plain MCP over stdio: Claude Code, Cursor, Cline, Continue, Zed AI, custom SDK apps. Anywhere two or more agents can connect to the same stdio MCP server, they can talk. A Claude Code session, a Cursor agent, and a custom Python SDK worker can all share the same room and DM each other — they're just rows in the same JSONL files.
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
| `prune({olderThanDays?, removeOrphanInboxes?, dryRun?})` | Trim room/status/inbox JSONL to entries newer than N days (default 7). Removes inbox files for agents no longer in the registry. Pass `dryRun:true` to preview. |

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

### Cleanup

The registry auto-evicts agents whose last heartbeat is older than 24h on every `list_agents` call. For chat history and inbox trimming, call `prune` periodically (e.g. weekly) — it's safe to run from any agent and supports `dryRun`.

## Override location

Set `AGENT_COORD_DIR=/some/other/path` in the MCP server's env to relocate state. (`CLAUDE_COORD_DIR` is also honored as a legacy alias.) Useful if you want different agent groups isolated, or to put the dir on a synced volume so agents on different machines can collaborate (caveat above).

## Realtime vs. polling

`wait_for_message` is the cheap path: one tool call, server-side `fs.watch` + 500ms poll, capped at 60s. The model only pays for one round-trip per wait.

But the model is fundamentally turn-based — there's no async push that wakes a fully idle agent. For *passive* presence (react when pinged without being told to poll) wire a client-side hook that drains unread messages into the next turn.

### Why this is a feature, not a bug

Delivery is **always tied to a turn the agent is already taking** — a user prompt, a tool result, a Stop-hook continuation. That means:

- **The human stays in control.** Peer agents can't silently kick off work in your session while you're away from the keyboard. Messages land the next time *you* (or your agent's own lifecycle) drive a turn.
- **Billing stays predictable.** No background daemon spinning up extra completions on your subscription.
- **Mixed-client coordination works naturally.** A Claude Code session driven by a human, a headless Claude Agent SDK worker running on a cron, and a Cursor agent in another repo can all participate in the same room — each on its own cadence, each respecting its own client's turn model. The MCP doesn't care who's on the other end of the socket.

If you genuinely need an always-on responder (e.g. a worker that should react within seconds of any DM), build *that specific agent* on the Claude Agent SDK or a similar library where you own the loop, and let it talk to your interactive Claude Code sessions through this same MCP.

### Claude Code hook

A reference hook ships in [`hooks/peek-coord.mjs`](./hooks/peek-coord.mjs). It reads `~/agent-coord/inbox/<id>.jsonl` directly, advances the cursor, and prints unread DMs (and optionally room posts) so Claude Code can inject them into context. No MCP roundtrip, no extra deps.

Two places to wire it:

- **`UserPromptSubmit`** — fires before the agent sees the user's next message. Stdout is appended to context. Good for *"new DMs since last turn"*.
- **`Stop`** — fires when the agent finishes its turn. If there are unread messages, the hook returns `{"decision":"block","reason":"..."}` which keeps the session going and feeds the messages in. Good for *"peer pinged me 2 seconds after I stopped"*.

Add to your project or user `settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_COORD_ID=frontend node /absolute/path/to/agent-coord-mcp/hooks/peek-coord.mjs --mode=user-prompt"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_COORD_ID=frontend node /absolute/path/to/agent-coord-mcp/hooks/peek-coord.mjs --mode=stop"
          }
        ]
      }
    ]
  }
}
```

Set `AGENT_COORD_ID` to whatever you passed to `register({agentId})`. Set `AGENT_COORD_INCLUDE_ROOM=1` to also drain the shared room. Set `AGENT_COORD_DIR` if you've relocated the state directory.

Caveat: the hook writes the cursor file directly (atomic tmp+rename) without taking the MCP server's lockfile, so if the agent calls `read_messages` at the exact instant the hook runs, one of them may double-deliver a message. In practice hooks fire between turns and tool calls fire during them, so this is rare. The hook also banners injected messages with *"do not call read_messages for them again"* to keep the agent from re-fetching.

### Other clients

The script itself is plain Node — no Claude-specific deps — so it ports anywhere you can run a shell command around the agent loop. The MCP protocol doesn't standardize client-side hooks, so the wiring varies:

- **Cursor / Cline / Continue / Zed** — no first-class lifecycle hooks today. Closest workaround is to put *"run `peek-coord.mjs` at turn start and treat its stdout as additional context"* in your rules/system prompt. Less reliable (model can skip it) but functional.
- **Custom SDK agents (`@anthropic-ai/sdk`, `openai`, etc.)** — easiest fit. Shell out to the script (or inline the ~50 lines of logic) right before each completion call and prepend stdout as a system message. Fully deterministic.
- **Client-agnostic fallback** — a `launchd`/`systemd`/cron watcher that tails `inbox/<id>.jsonl` and writes unread entries to a file the agent is told to `Read` on session start. Crude, works everywhere.

## License

MIT — see [LICENSE](./LICENSE).
