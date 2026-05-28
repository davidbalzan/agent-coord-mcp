# Roadmap

The project's shape so far has been: each phase adds one capability without disturbing the previous ones. Local file-backed bus stays the source of truth across all phases — everything new layers *on top* of it, never replaces it.

---

## Phase 1 — Local file-backed bus  ✅ shipped

MCP server speaking stdio. Agents `register`, `send_message` (to inbox or shared room), `read_messages`, `wait_for_message`, `post_status`, `prune`. All state in `~/agent-coord/` as JSONL/JSON; `tail -f` works from any terminal. Designed for multiple AI coding agents on the same machine to share status and DM each other.

## Phase 2 — Real-time push transport  ✅ shipped

Agents are turn-bound by default — without a transport, DMs sit in the inbox until the next user prompt drives a turn. Phase 2 added `attach_agent` / `detach_agent` and the `hooks/tmux-pusher.mjs` daemon: if an agent runs inside tmux, peer DMs get typed into its pane within ~1s, waking it for real. Transport markers in `~/agent-coord/transports/` surface in `list_agents` so peers can tell at runtime who's reactive vs. turn-bound. `join({agentId:"me"})` auto-attaches when `$TMUX_PANE` is set.

## Phase 3 — Human seat  ✅ shipped

`coord-chat` TUI (bundled `bin`). IRC-style readline UI — humans register, post to the room, DM agents, see who's online. Per-agent colors from a persistent `~/agent-coord/chat-colors.json`. Tab completion for slash commands, `/dm` targets, and `@mentions` mid-message. Inline markdown formatter (bold/italic/code/links). Colored gutter on every wrapped line. Admin commands: `/prune`, `/kick`, `/wipe-room`, `/find`, `/status`. Show last 3 messages on join for context.

## Phase 4 — Multi-channel  ✅ shipped

Beyond the default `general` channel: `join_room` / `leave_room` / `list_rooms` / `set_room_topic` / `set_room_motd`. Membership tracked per agent so push-attached agents only get pushed channels they've joined. `rename_agent` (NICK) migrates registry, inbox, cursor, transport, and channel memberships in one call. Backward-compatible: legacy `room.jsonl` content is still served as `#general`.

---

## Phase 5 — Network layer via embedded IRC server  📝 proposed

**Goal.** Let agents and humans on *different machines* share the same bus, using an embedded IRC server that reads/writes the same JSONL state. The local MCP/file path stays unchanged; the IRC layer is the network face.

**Why IRC and not WebSockets / Matrix / NATS.** The product is already IRC-shaped — channels, DMs, nicks, topic, MOTD, membership, server notices. The vocabulary maps 1:1, so the wire format is a translation, not a redesign. Plus a huge ecosystem of mature clients (weechat, irssi, HexChat, browser-based) means humans get great UX for free, no `coord-chat` port required for every platform.

### Scope

- Minimal embedded IRC server (just the verbs we actually use):
  `PRIVMSG`, `JOIN`, `PART`, `NICK`, `TOPIC`, `NAMES`, `LIST`, `MOTD`, `WHO`, `WHOIS`, `PING`, `PASS`, `QUIT`, `CAP LS`, `CAP REQ`, `CAP END`
- Single canonical instance. **No s2s / federation** in this phase — that's a much bigger build, defer.
- TCP listener on localhost first, then bind to LAN address, then optional TLS for public-internet exposure.
- Reads + writes the same `~/agent-coord/` files. JSONL stays the source of truth; the IRC server is a view onto it.
- Local MCP server unchanged. Local agents keep talking to it via stdio; remote agents talk via IRC. Both populate the same JSONL.
- New bin: `coord-irc-server` (or wire it as a flag on the MCP server: `agent-coord-mcp --irc-port 6667`).

### Out of scope for Phase 5

- Server-to-server federation (network of linked instances)
- IRCv3 services (`NickServ`, `ChanServ`) — registry already plays that role
- Public-internet exposure as a default (opt-in only after TLS + auth)
- IRC bouncer / persistent connection handling — clients should reconnect themselves

### Mapping to existing model

| Bus concept | IRC equivalent | Notes |
| --- | --- | --- |
| `agentId` | `NICK` | Same string. NICK changes call `rename_agent` under the hood. |
| `role` | `REALNAME` (the GECOS in `USER`) | Free text, displayed in `WHOIS`. |
| `register` / `unregister` | `USER` + `NICK` / `QUIT` | Standard IRC connection lifecycle. |
| Default room | `#general` | Legacy `room.jsonl` is `#general`'s history. |
| `join_room("seo")` | `JOIN #seo` | Membership row updated in same file. |
| `send_message({room:"#seo",text})` | `PRIVMSG #seo :text` | Both end up appended to `rooms/seo.jsonl`. |
| `send_message({to:"bob",text})` | `PRIVMSG bob :text` | Both end up in `inbox/bob.jsonl`. |
| `set_room_topic` / `set_room_motd` | `TOPIC #seo :…` / `MOTD` | `MOTD` shown to agents on `JOIN`. |
| Status broadcast | server `NOTICE` on a `*services*` channel | Or skip and keep status as MCP-only. |
| `tmux-push` transport | irrelevant for remote agents | They already have a persistent socket. |

### Auth model

Local-only had none. Going networked requires it.

- **Tier 1 (minimum):** `PASS` token before `USER` / `NICK`. Token lives in `~/agent-coord/server-pass` (mode 600). Without correct `PASS`, server rejects the registration.
- **Tier 2 (TLS exposure):** SASL `PLAIN` over TLS. Per-agent credentials, not a shared token.
- **Tier 3 (long term):** SASL `EXTERNAL` with TLS client certs, one cert per agent. Removes shared secrets entirely.

Ship Tier 1 in this phase. Tier 2/3 in a follow-up phase.

### Structured payloads

IRC `PRIVMSG` lines are flat text — our messages carry `id`, `ts`, `from`, `to`, `room`, optional structured fields. Two paths:

1. **IRCv3 `message-tags`** — attach `@id=…;ts=…;coord-from=…` tags to outbound PRIVMSGs. Modern clients see the tags; older clients see only the text body. Lossless for IRCv3-aware peers.
2. **History-via-extension** — implement a custom `CHATHISTORY` (IRCv3-compatible) that pulls from JSONL when an agent connects, so they get the same "last N messages on join" UX `coord-chat` does today.

### Open questions to resolve before building

1. **Bin shape.** Separate `coord-irc-server` process, or fold into the MCP server behind a flag? Separate process is cleaner for isolation; combined is simpler to deploy.
2. **State authority on conflict.** Local agent does `set_room_topic`; remote IRC user does `TOPIC` at the same instant. Both write `rooms/<name>.json`. Use the existing lockfile, last-write-wins is fine.
3. **History replay on `JOIN`.** Always send last N (like `coord-chat` does), or only when client requests via `CHATHISTORY`? Defaulting to last 10 matches the existing UX.
4. **Server name + version reporting.** `agent-coord IRCd 0.x.0` in `001 RPL_WELCOME` and `004 RPL_MYINFO`? Cosmetic but matters for client compat.
5. **Are we comfortable being a network service at all?** Right now the threat model is "anything reading `~/agent-coord/` can read messages." Adding a TCP listener changes that to "anything with the password can read and write." Worth making sure the README leads with that loudly.
6. **Implementation strategy.** Write it from scratch (~500–800 LoC for the verb set above), or wrap an existing minimal Node IRC daemon library? Most of the npm options are unmaintained — likely from-scratch is the path.

### Success criteria

- A human on another machine can `weechat /connect host 6667` and join `#general`.
- An agent on another machine can use a standard IRC client library (`irc-framework` in TS, `pydle` in Python) to register, join rooms, send/receive.
- The local MCP path is unchanged — existing local agents see no difference.
- `tail -f ~/agent-coord/rooms/general.jsonl` shows messages from both local and remote senders interleaved.

---

## Phase 6+ — Possible follow-ups

Listed here so they don't clutter Phase 5, but worth tracking as ideas:

- **TLS + SASL** for IRC layer (Tier 2/3 auth).
- **Server-to-server federation.** Two bus instances on different LANs linked into one chat surface. Hard but real demand if multi-team adoption happens.
- **Web view.** Read-only HTML page that streams the room feed over SSE. Lightweight spectator mode for non-IRC humans.
- **Persistent bouncer behavior.** Hold messages for offline IRC clients and replay on reconnect.
- **Message reactions / threads.** Light IRCv3 reaction support. Useful for "agent acknowledges peer ping" without sending a full message.
- **Search / archive UI.** `/find` in coord-chat is the in-process version; a separate browse tool would help long-term archives.
- **Encrypted DMs.** Per-agent keypairs, encrypt inbox payloads. Local-storage-readable threat model goes away.
