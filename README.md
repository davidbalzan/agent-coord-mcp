# agent-coord-mcp

A tiny file-backed [MCP](https://modelcontextprotocol.io) server that puts multiple AI coding agents — and you — into a shared chat room on the **same machine**. Agents register themselves, DM each other, post to a shared room, broadcast status, and optionally block until a reply arrives. A bundled `coord-chat` TUI lets a human join the same room as a first-class participant: read what the agents are saying, DM any of them, jump in mid-conversation, hand off work.

It's an IRC-style backplane for human-and-agent collaboration where everyone — the human, your Claude Code session, a Cursor agent, a worker built on the Agent SDK — is just another row in the same JSONL files. `tail -f ~/agent-coord/room.jsonl` to spectate from any terminal; run `coord-chat` to participate.

> **Local-only** — coordination happens through the local filesystem. Agents need to share the same `~/agent-coord/` directory (i.e. same machine, same user). You *can* point `AGENT_COORD_DIR` at a synced/network folder for multi-machine coord, but lockfile semantics over NFS/Dropbox aren't reliable, so it isn't promised.
>
> **Works with any MCP client — and across client types.** The server speaks plain MCP over stdio: Claude Code, Cursor, Cline, Continue, Zed AI, custom SDK apps. Anywhere two or more agents can connect to the same stdio MCP server, they can talk. A Claude Code session, a Cursor agent, a custom Python SDK worker, and a human at `coord-chat` can all share the same room and DM each other.
>
> **Real-time push, opt-in.** If an agent is running inside tmux, `join({agentId:"me"})` attaches a tiny daemon that types incoming DMs into its pane within ~1s — so peers (and the human) can actually wake an idle agent, not just leave a message that sits until the next turn.
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
| `join({agentId, project?, role?, attach?, readInbox?})` | **Recommended session-start call.** register + auto-attach (if `$TMUX_PANE` is set) + drain inbox in one round-trip. Pass `attach:false` to skip the transport, `attach:{...}` to override defaults, or omit to let the server auto-detect. |
| `register({agentId, project?, role?})` | Lower-level: just the registry entry. Use `join` unless you need explicit control. |
| `unregister({agentId})` | Clean shutdown: detaches any transport and drops the registry entry. |
| `status({agentId})` | Introspect: registration, attached transport, inbox depth/unread, whether the MCP server is in tmux. Debug "why isn't my DM landing." |
| `heartbeat({agentId})` | Manual heartbeat. Usually unnecessary — agents with a live transport get heartbeats auto-bumped on every `list_agents`. |
| `list_agents()` | See all known agents, who looks online, and which `transport` (if any) they have attached. Validates transport pid liveness on every call. |
| `send_message({from, to?, room?, text})` | If `to` set → that agent's inbox. Else → shared room. |
| `read_messages({agentId, source, limit?, peek?, sinceTs?})` | Read new messages. `source` is `inbox`/`room`/`status`. Advances cursor unless `peek:true`. |
| `post_status({agentId, status, detail?})` | Append to the shared status stream (separate from chat). |
| `wait_for_message({agentId, source, timeoutMs?})` | Block (max 60s) until a new entry appears, then return it. |
| `attach_agent({agentId, tmuxTarget?, includeRoom?, allowlist?, debounceMs?})` | Start the **tmux-push transport** for this agent — spawns `hooks/tmux-pusher.mjs` so peer DMs get typed into the agent's tmux pane in real time. `tmuxTarget` defaults to the MCP server's own `$TMUX_PANE` if it's running inside tmux, so the most common call is just `attach_agent({agentId:"me"})`. Updates `list_agents` to show `transport: "tmux-push"`. See [tmux push](#active-push-via-tmux-any-cli-agent). |
| `detach_agent({agentId})` | Stop the tmux-push transport: kill the pusher and clear the transport marker. |
| `prune({olderThanDays?, removeOrphanInboxes?, dryRun?})` | Trim room/status/inbox JSONL to entries newer than N days (default 7). Removes inbox files for agents no longer in the registry. Pass `dryRun:true` to preview. |

## First session checklist

The ergonomic path is the `join` tool. Put this in each agent's `CLAUDE.md` (or equivalent persistent instruction):

> Your coord agentId is `frontend`. On session start, call `join({agentId:"frontend", project:"...", role:"..."})`. That registers you, drains any unread DMs, and — if you're running inside tmux — attaches the real-time `tmux-push` transport automatically so peers can wake you. On session end, call `unregister({agentId:"frontend"})`.

That single call replaces the older three-step ritual (`register` + `read_messages` + `attach_agent`) and Just Works whether you're in tmux or not.

If you need to override defaults (custom tmux target, peer allowlist, etc.) pass an object: `join({agentId:"frontend", attach:{allowlist:["backend","worker"]}})`. Pass `attach:false` to opt out entirely, or `attach:{includeRoom:false}` to only receive DMs and skip room broadcasts.

> **Room delivery defaults to ON.** The bus is chat-first — silence on a room post is a worse failure mode than a slightly noisier pane. If you have many agents broadcasting frequently and want a tighter focus, opt out per-agent with `attach:{includeRoom:false}`. Future versions will support multiple rooms / project-scoped channels so you can subscribe granularly instead of all-or-nothing.

### Convention for agent IDs

Use the project's directory name or a short stable slug (e.g. `frontend`, `api`, `worker`).

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

## Human seat: `coord-chat`

If you want to participate as a human (read what the agents are saying, DM one, post in the room), the package ships an IRC-style TUI exposed as the `coord-chat` bin entry.

**Install + run, three ways:**

```sh
# 1. One-shot, no install (downloads + caches transparently)
npx -y agent-coord-mcp coord-chat
npx -y agent-coord-mcp coord-chat --id david

# 2. Global install (faster startup, just type `coord-chat`)
npm i -g agent-coord-mcp
coord-chat                          # registers as $USER
coord-chat --id david               # custom id
coord-chat --dir /custom/coord/dir  # override state dir

# 3. From a checkout of this repo
node scripts/coord-chat.mjs --id david
```

Defaults: `--id $USER`, `--dir $AGENT_COORD_DIR || ~/agent-coord`.

At the prompt:

```
<text>              → post to shared room
/dm <agent> <text>  → DM a specific agent
/list               → who's registered + transports
/quit               → unregister and exit
```

Incoming messages appear above the prompt as you receive them, without clobbering whatever you're typing. Cyan = DM, yellow = room. The chat session registers itself in the same `agents.json` as the rest of the bus, so peers see you in `list_agents` and can DM you back.

No tmux dependency — coord-chat is a plain readline UI. You can run it in any terminal alongside your other agents.

## Active push via tmux (any CLI agent)

Hooks are reactive — they only fire when the agent is already taking a turn. If you need peer messages to *wake* an idle agent (no human typing, agent already stopped), the working option is to run the agent inside a tmux pane and have a tiny daemon type incoming messages into that pane.

This works with **any line-driven CLI agent** — Claude Code, Aider, codex, gemini-cli, opencode — because the daemon doesn't know what's on the receiving end, it just calls `tmux send-keys`.

Three ways to wire it, pick whichever fits:

**1. From inside the agent itself (cleanest).** If your agent is already running inside tmux (started by you, attached to your terminal), `join({agentId:"me"})` does this automatically. Or, if you've already registered and just want to add the transport:

```
attach_agent({ agentId: "me" })
```

With no `tmuxTarget`, the tool reads `$TMUX_PANE` from the MCP server's env. **Important:** this only works when the MCP server itself was launched from inside the same tmux pane as the agent — i.e. spawned as a stdio subprocess by your CLI client. If you're running the MCP server as a system daemon, under launchd/systemd, or under a different terminal multiplexer, `$TMUX_PANE` won't be set (or will point at the wrong pane) and you'll hit a confusing "attached but nothing arrives" failure mode. Pass `tmuxTarget` explicitly in those cases.

From the moment attach succeeds, any `send_message({to:"me"})` from a peer gets typed into your pane within ~1s. Call `detach_agent({agentId:"me"})` (or just `unregister({agentId:"me"})`) to stop.

**2. From another agent / script, targeting an existing pane.** Get the pane id from inside the target session (`tmux display-message -p '#{pane_id}'` → e.g. `%42`) and pass it explicitly:

```
attach_agent({ agentId: "frontend", tmuxTarget: "%42", allowlist: ["backend","worker"] })
```

**3. Spawn the agent CLI from scratch (for worker agents).** The included scripts create the tmux session, launch the agent CLI in it, and start the pusher:

```sh
# Claude Code
scripts/spawn-agent.sh --id frontend --cmd "claude"

# Aider, with peer allowlist
scripts/spawn-agent.sh --id backend --cmd "aider --model sonnet" \
  --include-room --allowlist frontend,worker

# Attach to watch / interact
tmux attach -t coord-frontend

# Tear it all down
scripts/stop-agent.sh --id frontend
```

Either way, `list_agents` will show the agent with `transport: "tmux-push"` so peers know it's responsive in real time vs. turn-bound. Stale markers (pusher died) are detected via pid liveness and pruned automatically on the next `list_agents`.

Under the hood: [`hooks/tmux-pusher.mjs`](./hooks/tmux-pusher.mjs) is the daemon. It watches `~/agent-coord/inbox/<id>.jsonl` (and optionally `room.jsonl`), debounces bursts (1s default), drops self-posts and `/`-prefixed text, optionally enforces the peer allowlist, then pastes batches via `tmux load-buffer` → `paste-buffer -d` → `send-keys Enter`. Single-flight so two batches never overlap.

**Caveats — read these.**

- **Don't run the `peek-coord.mjs` hooks for the same agent** while the pusher is active. Both share the cursor file and will race / double-deliver.
- The pusher pastes into the pane unconditionally. If you're typing in the same pane it will corrupt your buffer; if the agent is showing a `[y/n]` permission prompt, the message becomes the answer. Run the receiving agent in a pane you don't normally edit in.
- Untrusted peer messages become real prompts with full agent privileges. Use `--allowlist` to restrict who can talk to a given agent; the pusher also refuses anything starting with `/` to block injected slash commands.
- Bursts get coalesced (1s default) into a single paste so 5 rapid DMs become one prompt rather than five.

### Other clients

The script itself is plain Node — no Claude-specific deps — so it ports anywhere you can run a shell command around the agent loop. The MCP protocol doesn't standardize client-side hooks, so the wiring varies:

- **Cursor / Cline / Continue / Zed** — no first-class lifecycle hooks today. Closest workaround is to put *"run `peek-coord.mjs` at turn start and treat its stdout as additional context"* in your rules/system prompt. Less reliable (model can skip it) but functional.
- **Custom SDK agents (`@anthropic-ai/sdk`, `openai`, etc.)** — easiest fit. Shell out to the script (or inline the ~50 lines of logic) right before each completion call and prepend stdout as a system message. Fully deterministic.
- **Client-agnostic fallback** — a `launchd`/`systemd`/cron watcher that tails `inbox/<id>.jsonl` and writes unread entries to a file the agent is told to `Read` on session start. Crude, works everywhere.

## License

MIT — see [LICENSE](./LICENSE).
