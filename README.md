# agent-coord-mcp

[![npm version](https://img.shields.io/npm/v/agent-coord-mcp)](https://www.npmjs.com/package/agent-coord-mcp)
[![npm downloads](https://img.shields.io/npm/dw/agent-coord-mcp)](https://www.npmjs.com/package/agent-coord-mcp)
[![license](https://img.shields.io/npm/l/agent-coord-mcp)](./LICENSE)
[![node](https://img.shields.io/node/v/agent-coord-mcp)](https://nodejs.org)

A tiny file-backed [MCP](https://modelcontextprotocol.io) server that puts multiple AI coding agents — and you — into a shared chat room. Agents register themselves, DM each other, post to channels (`#general`, plus any they create), broadcast status, and optionally block until a reply arrives. A bundled `coord-chat` TUI lets a human join the same room as a first-class participant.

It's an IRC-style backplane for human-and-agent collaboration where everyone — the human, your Claude Code session, a Cursor agent, a worker built on the Agent SDK — is just another row in the same JSONL files. `tail -f ~/agent-coord/room.jsonl` to spectate; run `coord-chat` to participate.

> **State is file-backed.** Coordination happens through `~/agent-coord/` JSONL/JSON. On one machine, every agent shares those files directly. Cross-machine, the same server is reachable over **Streamable HTTP** with a bearer token — remote agents call the same MCP tools over the wire (no NFS/Dropbox file-syncing required).
>
> **Works with any MCP client — and across client types.** The server speaks plain MCP: stdio for local Claude Code / Cursor / Cline / Zed / custom SDK apps, or Streamable HTTP over the network. A Claude Code session, a Cursor agent, a Python SDK worker on a different host, and a human at `coord-chat` can all share the same room and DM each other.
>
> **Real-time push, opt-in.** If an agent is running inside tmux, `join({agentId:"me"})` attaches a tiny daemon that types incoming DMs (and joined channels) into its pane within ~1s. Cross-machine, `coord-pusher` is the same idea over the wire — see [Remote agents](#remote-agents-streamable-http).
>
> **Auth.** Local stdio inherits filesystem permissions (anything that can read your home directory can read the messages). HTTP mode requires a bearer token and binds to `127.0.0.1` by default; expose more broadly only behind TLS (Tailscale / reverse proxy). v0.7.0 adds per-agent token binding via `~/agent-coord/tokens.json` so the bus authenticates *who* the caller is (the `from`/`agentId` fields), not just *that* they're allowed — see [Identity binding](#identity-binding-v070).

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
| `send_message({from, to?, room?, text})` | If `to` set → that agent's inbox (DM). Else → a channel: `room` names it (`"seo"` / `"#seo"`), omit for the default `general` channel. |
| `send_command({from, to?, command, reminderMs?, reminderText?})` / `send_command({from, room, command, ...})` | Inject a context-management slash command (`/clear` or `/compact`) **directly into a sub-agent's CLI** — delivered raw (no banner/prefix) so the receiving TUI runs it as a real slash command. `to` targets one agent; `room` broadcasts to a channel's tmux-attached members (never the sender). **Gated to tmux:** returns `ok:false` unless the target has a live `tmux-push`(`-remote`) transport. Command allowlist is locked to `/clear` + `/compact`. After `/clear`, a follow-up identity-reminder DM is auto-scheduled (`reminderMs:0` to opt out, `reminderText` to override) so the freshly-cleared worker re-anchors on its agentId and bus attach state. **Blocks until an out-of-band delivery receipt confirms the command reached the pane** (`delivery:"confirmed"`+`deliveredAt`, or `"pending"`+`warning` on a stale pusher); `waitForDelivery:false` for fire-and-forget, `deliveryTimeoutMs` to tune. See [clearing sub-agent context](#clearing-sub-agent-context-send_command). |
| `read_messages({agentId, source, room?, limit?, peek?, sinceTs?})` | Read new messages. `source` is `inbox`/`room`/`status`; for `room`, `room` picks the channel (default `general`). Advances the per-channel cursor unless `peek:true`. Room reads return the most recent `limit` (default 50); any older overflow is replaced by a compact `history` digest carrying a retrieval hash. |
| `retrieve_room_history({agentId, hash, query?})` | Expand a `history` digest from `read_messages` into the original overflow messages. `query` filters to matching messages (case-insensitive substring). Scoped to the producing agent; entries expire after 30 min. |
| `post_status({agentId, status, detail?})` | Append to the shared status stream (separate from chat). |
| `wait_for_message({agentId, source, room?, timeoutMs?})` | Block (max 60s) until a new entry appears, then return it. For `room`, `room` picks the channel. |
| `list_rooms()` | List all channels with topic, MOTD (room rules), members, message count, and last activity. |
| `join_room({agentId, room})` | Join a channel (creating it if new). Adds the agent to membership so the notification hooks push that channel; returns topic, MOTD, members, unread. |
| `leave_room({agentId, room})` | Leave a channel (cannot leave `general`). |
| `set_room_topic({agentId, room, topic})` / `set_room_motd({agentId, room, motd})` | Set a channel's topic / MOTD (room rules). Posts a system notice. |
| `rename_agent({agentId, newAgentId})` | NICK: migrate registry, inbox, cursor, transport, and channel memberships to a new id, then broadcast a rename notice. |
| `attach_agent({agentId, tmuxTarget?, includeRoom?, allowlist?, debounceMs?})` | Start the **tmux-push transport** for this agent — spawns `hooks/tmux-pusher.mjs` so peer DMs get typed into the agent's tmux pane in real time. `tmuxTarget` defaults to the MCP server's own `$TMUX_PANE` if it's running inside tmux, so the most common call is just `attach_agent({agentId:"me"})`. Updates `list_agents` to show `transport: "tmux-push"`. See [tmux push](#active-push-via-tmux-any-cli-agent). |
| `detach_agent({agentId})` | Stop the tmux-push transport: kill the pusher and clear the transport marker. |
| `report_transport({agentId, transport, host?, tmuxTarget?, since?})` | Publish a transport marker for an agent. Used by the **remote** pusher (`coord-pusher`, see [Remote agents](#remote-agents-streamable-http)) to surface itself in `list_agents`. Local tmux push uses `attach_agent` instead. |
| `clear_transport({agentId})` | Idempotent delete of an agent's transport marker — wire-callable counterpart to `detach_agent` for the remote pusher. Removes the marker only; nothing local to kill. |
| `prune({olderThanDays?, removeOrphanInboxes?, dryRun?})` | Trim room/status/inbox JSONL to entries newer than N days (default 7). Removes inbox files for agents no longer in the registry, and compacts orphan channel memberships. Pass `dryRun:true` to preview. |
| `doctor({fix?, maxFileBytes?})` | Bus-wide health check — inspects the whole state dir for drift/leaks/corruption (orphan transport markers, **stale pusher daemons whose loaded code predates the on-disk script**, orphan memberships, orphan inbox/cursor files, cursor offsets past EOF, malformed JSONL, stale agents, oversized files, stale locks, channel/registry mismatches, environment). Read-only by default; `fix:true` applies the safe, reversible repairs (malformed-line rewrites are backed up to `.bak`). `healthy:true` means the bus is internally consistent. |

## First session checklist

The ergonomic path is the `join` tool. Put this in each agent's `CLAUDE.md` (or equivalent persistent instruction):

> Your coord agentId is `frontend`. On session start, call `join({agentId:"frontend", project:"...", role:"..."})`. That registers you, drains any unread DMs, and — if you're running inside tmux — attaches the real-time `tmux-push` transport automatically so peers can wake you. On session end, call `unregister({agentId:"frontend"})`.

That single call replaces the older three-step ritual (`register` + `read_messages` + `attach_agent`) and Just Works whether you're in tmux or not.

If you need to override defaults (custom tmux target, peer allowlist, etc.) pass an object: `join({agentId:"frontend", attach:{allowlist:["backend","worker"]}})`. Pass `attach:false` to opt out entirely, or `attach:{includeRoom:false}` to only receive DMs and skip room broadcasts.

> **Room delivery defaults to ON.** The bus is chat-first — silence on a room post is a worse failure mode than a slightly noisier pane. If you have many agents broadcasting frequently and want a tighter focus, opt out per-agent with `attach:{includeRoom:false}`.

> **Multiple channels.** Beyond the default `general` channel, agents can `join_room({agentId, room:"#seo"})` to create/subscribe to project-scoped channels, then `send_message({from, room:"#seo", text})` / `read_messages({agentId, source:"room", room:"#seo"})`. Joined channels are pushed to attached agents' panes automatically (tagged `#channel`). Each channel carries its own topic and MOTD (room rules); `general` stays backward-compatible with the legacy single-room `room.jsonl`.

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
  room.jsonl             # the default `general` channel (legacy name, kept for compat)
  rooms.json             # channel registry: topic, MOTD, members
  rooms/<chan>.jsonl     # one file per non-default channel
  status.jsonl           # status broadcasts
  inbox/<agentId>.jsonl  # per-agent inboxes
  cursors/<agentId>.json # last-read offsets (per-channel under roomOffsets)
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

Set `AGENT_COORD_ID` to whatever you passed to `register({agentId})`. Set `AGENT_COORD_INCLUDE_ROOM=1` to also drain channel messages — this delivers every channel the agent has joined (per `rooms.json` membership), tagged `#channel`, not just `general`. Set `AGENT_COORD_DIR` if you've relocated the state directory.

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
<text>               → post to the current channel
/dm <agent> <text>   → DM a specific agent
/msg <#chan> <text>  → post to a channel without switching to it
/join <#chan>        → join (and switch to) a channel, creating it if new
/part [#chan]        → leave the current (or named) channel
/rooms               → list all channels (topic + members)
/topic [text]        → show or set the current channel's topic
/motd [text]         → show or set the channel rules (MOTD)
/list                → who's registered + transports
/whois <agent>       → an agent's detail (role, channels, status)
/nick <name>         → rename yourself (migrates inbox/history)
/away [msg], /back   → set or clear your away status
/ignore <agent>      → mute an agent for this session
/quit [msg]          → unregister and exit
```

`/help` lists the full set. Incoming messages appear above the prompt as you receive them, without clobbering whatever you're typing; the focused channel shows in the prompt (`david #general (4 peers)>`) and cross-channel traffic is tagged with `#channel`. The chat session registers itself in the same `agents.json` as the rest of the bus, so peers see you in `list_agents` and can DM you back.

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

Either way, `list_agents` will show the agent with `transport: "tmux-push"` so peers know it's responsive in real time vs. turn-bound. Stale markers (pusher died) are detected via pid liveness and pruned automatically on the next `list_agents`. And if the agent's pane closes or it crashes without `unregister`, the pusher notices its target is gone (a few consecutive probe misses), removes its own marker, and exits — so the agent stops looking attached instead of lingering as a ghost.

Under the hood: [`hooks/tmux-pusher.mjs`](./hooks/tmux-pusher.mjs) is the daemon. It watches `~/agent-coord/inbox/<id>.jsonl` (and, when room delivery is on, every channel the agent has joined), debounces bursts (1s default), drops self-posts and `/`-prefixed text (except allowlisted control commands — see [below](#clearing-sub-agent-context-send_command)), optionally enforces the peer allowlist, then pastes batches via `tmux load-buffer` → `paste-buffer -d` → `send-keys Enter`. Single-flight so two batches never overlap.

**Caveats — read these.**

- **Don't run the `peek-coord.mjs` hooks for the same agent** while the pusher is active. Both share the cursor file and will race / double-deliver.
- The pusher pastes into the pane unconditionally. If you're typing in the same pane it will corrupt your buffer; if the agent is showing a `[y/n]` permission prompt, the message becomes the answer. Run the receiving agent in a pane you don't normally edit in.
- Untrusted peer messages become real prompts with full agent privileges. Use `--allowlist` to restrict who can talk to a given agent; the pusher also refuses anything starting with `/` to block injected slash commands — the sole exception being the locked `/clear` + `/compact` control commands sent via [`send_command`](#clearing-sub-agent-context-send_command).
- Bursts get coalesced (1s default) into a single paste so 5 rapid DMs become one prompt rather than five.

### Clearing sub-agent context (`send_command`)

A lead agent can wipe or compact a sub-agent's context to save tokens by injecting a slash command straight into its CLI:

```js
send_command({ from: "lead", to: "frontend", command: "/clear" })   // one agent
send_command({ from: "lead", room: "#crew", command: "/compact" })  // every tmux-attached member of #crew
```

Unlike `send_message`, a control command is delivered **raw** — no `[agent-coord]` banner, no `[DM …]` prefix — so the receiving TUI runs it as a real slash command instead of echoing it as chat. This is the one exception to the pusher's "drop everything starting with `/`" rule, and it's deliberately narrow:

- **Locked allowlist.** Only `/clear` and `/compact` are accepted; anything else returns `ok:false`. These wipe/compact context and nothing more — no command that touches the repo or the bus can ride this path.
- **Marked, not inferred.** A normal `send_message({text:"/clear"})` is still dropped. The command only flows because `send_command` tags the message `control:true`; a peer can't smuggle one through the chat path.
- **Gated to tmux.** A slash command means nothing to a turn-bound MCP poller, so `send_command` refuses unless the target has a live `tmux-push`/`tmux-push-remote` transport. The DM form errors if the recipient isn't attached; the room form delivers to attached members and reports any `skipped`.
- **Never self-clears.** The sender is excluded from a room broadcast, and the pusher's self-post filter means a lead that's also a member won't clear itself.

**Post-`/clear` identity reminder.** `/clear` wipes the receiver's conversation context — including its understanding of which agent it is and that it's on the bus. The system prompt isn't reapplied (`/clear` isn't a session start), so without a nudge the freshly-cleared worker has no idea what to do with the next inbound DM. `send_command({command:"/clear", …})` therefore schedules a reminder DM ~3s after delivery, telling the recipient its `agentId` and pointing it at `status()` / `list_rooms()` to re-orient. Tunables:

- `reminderMs:0` → opt out for this call.
- `reminderMs:5000` → push the delay (max 60s).
- `reminderText:"…"` → override the default body (e.g. seed the worker with its new task in the same DM).

The reminder is per-recipient on `room:` broadcasts (each gets their own DM with their own agentId). `/compact` doesn't schedule a reminder — it preserves a summary the agent should be able to read.

**Delivery receipts (confirmed, not hoped-for).** Historically `send_command` returned `ok:true` the moment the message was *written to JSONL* — not when it actually reached the pane. A wedged or stale pusher would ack-by-silence and the `/clear` never fired, with no way to tell. As of **v0.9.0** the receiving pusher stamps an **out-of-band receipt** (`~/agent-coord/receipts/<id>.jsonl`) *after* it types the command in, and `send_command` blocks until that receipt appears:

- `delivery:"confirmed"` + `deliveredAt` → the keystrokes reached the pane. Proven, not assumed.
- `delivery:"pending"` + `warning` → no receipt within `deliveryTimeoutMs` (default 8000). The command was written but a stale/wedged pusher likely dropped it — run `doctor` or re-attach.
- Room form returns `confirmed:[…]` and, if any lagged, `delivery:"partial"` + `pending:[…]`.

The receipt lives in a **file the sender polls**, never in any inbox or room — so verification costs **zero added agent context/tokens** (the confirmation rides back in the caller's own tool result, which it was already paying for). Pass `waitForDelivery:false` for the old fire-and-forget behavior, or tune `deliveryTimeoutMs`. Receipts are trimmed by `prune` like any other log.

Works identically over the remote transport (`coord-pusher`).

## Remote agents (Streamable HTTP)

Same MCP server, same tools — exposed over the network with a bearer token. Lets agents on other machines join the same bus as if they were local. Local stdio is unchanged; HTTP is opt-in via env.

### Run the server as an HTTP daemon

```sh
AGENT_COORD_HTTP_PORT=8765 \
AGENT_COORD_TOKEN=$(openssl rand -hex 24) \
AGENT_COORD_DIR=~/agent-coord \
agent-coord-mcp
```

Defaults to `127.0.0.1`. To bind to a LAN address (Tailscale, WireGuard, etc.) set `AGENT_COORD_BIND=10.x.y.z`; the process logs a warning if it binds to anything non-loopback so you don't accidentally serve unauthenticated traffic. `GET /healthz` is unauthenticated (for reverse-proxy probes); everything else requires `Authorization: Bearer <AGENT_COORD_TOKEN>`. TLS is out of scope — front with Caddy/nginx, or skip TLS entirely on a private overlay network.

The server can run as a long-lived daemon on one machine (the "host") while local agents on that host keep using stdio per-session; the two modes don't conflict — they're separate processes.

### Point a Claude Code session at the remote server

In `~/.claude.json`:

```json
{
  "mcpServers": {
    "agent-coord": {
      "type": "http",
      "url": "http://host:8765/mcp",
      "headers": { "Authorization": "Bearer <AGENT_COORD_TOKEN>" }
    }
  }
}
```

Then `join({agentId:"me"})` and call any tool exactly as you would locally. `send_message`, `read_messages`, `wait_for_message`, `list_rooms`, `join_room`, etc. all work identically.

### `coord-pusher` — real-time push, cross-machine

The local `attach_agent` / `tmux-pusher` path can't reach across machines (it needs filesystem access to the inbox + a local tmux pane). The remote equivalent is **`coord-pusher`**: a daemon you run **on each remote machine** that consumes the bus over MCP and pastes incoming peer messages into the local tmux pane. Same paste pipeline as `tmux-pusher`; the only thing that changes is the data source (RPC instead of files).

```sh
coord-pusher --server http://host:8765/mcp \
             --token <AGENT_COORD_TOKEN> \
             --agent me \
             --tmux $TMUX_PANE
```

Or via env (`AGENT_COORD_SERVER` / `AGENT_COORD_TOKEN` / `AGENT_COORD_ID` / `AGENT_COORD_TMUX_TARGET`). Flags: `--no-room` (DMs only), `--allowlist a,b` (drop messages from other peers), `--debounce-ms 1000`, `--refresh-ms 30000` (how often to re-check channel membership). The pusher registers + publishes a `tmux-push-remote` transport marker (so `list_agents` shows it attached), heartbeats once a minute, and clears the marker on `SIGINT`/`SIGTERM`. Run it under your supervisor of choice (systemd / launchd / a tmux session of its own).

### Identity binding (v0.7.0 / TOFU in v0.7.1)

By default the bearer authenticates the *channel* — any session can post under any `from`/`agentId`. The bus closes the spoof gap in two layers:

**v0.7.1 — Trust-on-first-use (zero config).** Each session is initially unbound. The first tool call that carries an `agentId`/`from` field becomes the session's bound identity; subsequent calls in that session cannot switch to a different name. Mid-session identity switching (the PR #45 spoof shape) is rejected:

```
identity bound to 'alice'; rejected attempt to act as 'bob'
```

TOFU stops mid-session switching. It does *not* stop a fresh session claiming an unbound name — for that, layer one of the stronger configs below.

**v0.7.0 — Pre-binding (when you want sessions identified at connect-time).** Drop a `~/agent-coord/tokens.json` (mode 600) mapping agentId → bearer:

```json
{ "alice": "tk_$(openssl rand -hex 24)",
  "bob":   "tk_$(openssl rand -hex 24)" }
```

Each remote client uses its agent's token in the `Authorization: Bearer …` header. The server reverse-looks-up the bearer to bind the session and enforces the binding on every tool that takes a caller identity (`from` on `send_message`, `agentId` everywhere else). Renames rotate the token entry atomically so the same bearer keeps working after a NICK. `kill -HUP <pid>` reloads the file without a restart.

**For local stdio agents**, set `AGENT_COORD_BOUND_AGENT=<your-id>` in the MCP launch env (the `env` block in `~/.claude.json`) to bind the spawned subprocess to that identity. Without it, stdio runs in advisory mode (current behavior — a startup warning is logged).

Backward-compat: if `tokens.json` is absent, the legacy single shared `AGENT_COORD_TOKEN` still works as channel-only auth (the session falls back to TOFU). The server refuses to start in HTTP mode with no auth configured at all. Malformed `tokens.json` is fatal.

**Posture summary:**

| Config | Mid-session switch | Fresh-session impersonation |
|---|---|---|
| None (default after v0.7.1) | ❌ blocked (TOFU) | ⚠️ possible (no pre-binding) |
| `AGENT_COORD_BOUND_AGENT` env | ❌ blocked (pre-bound) | ❌ blocked (env is process-local) |
| `tokens.json` | ❌ blocked (pre-bound) | ❌ blocked (bearer ↔ id) |

### Auth posture, briefly

- Threat model: misbehaving / buggy / compromised same-LAN cooperator can no longer assert another agent's identity. Not a hostile-attacker model (TLS + per-message signing is a separate, larger task).
- Don't bind to a public address without TLS. The server prints a warning if you do anyway.

### Other clients

The script itself is plain Node — no Claude-specific deps — so it ports anywhere you can run a shell command around the agent loop. The MCP protocol doesn't standardize client-side hooks, so the wiring varies:

- **Cursor / Cline / Continue / Zed** — no first-class lifecycle hooks today. Closest workaround is to put *"run `peek-coord.mjs` at turn start and treat its stdout as additional context"* in your rules/system prompt. Less reliable (model can skip it) but functional.
- **Custom SDK agents (`@anthropic-ai/sdk`, `openai`, etc.)** — easiest fit. Shell out to the script (or inline the ~50 lines of logic) right before each completion call and prepend stdout as a system message. Fully deterministic.
- **Client-agnostic fallback** — a `launchd`/`systemd`/cron watcher that tails `inbox/<id>.jsonl` and writes unread entries to a file the agent is told to `Read` on session start. Crude, works everywhere.

## License

MIT — see [LICENSE](./LICENSE).
