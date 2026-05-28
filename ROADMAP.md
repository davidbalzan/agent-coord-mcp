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

### Resolved decisions

1. **Packaging — separate repo, separate npm package.** Name: `agent-coord-irc`. Anyone not needing the network face installs `agent-coord-mcp` alone and stays simple. The IRC module is a bolt-on: install it, point it at the same `AGENT_COORD_DIR`, run it. No coupling at build/dist time. Peer-depends on `agent-coord-mcp >=0.4` for the JSONL schema contract.
2. **Conflict resolution — optimistic concurrency.** Topic, MOTD, channel membership, and other small JSON mutations carry a `version` counter (or mtime). Writers do read-check-write under the existing lockfile; on stale version the LAST writer fails with a server NOTICE like `:agent-coord NOTICE #seo :topic changed by alice — reload and retry`. No silent overwrites.
3. **History replay — IRCv3 `CHATHISTORY` only.** No auto-replay on `JOIN`. Clients that want history call `CHATHISTORY LATEST #room * 10` (or `BEFORE`/`AFTER` variants). Modern clients support it natively; older clients see an empty channel until new messages arrive, which is standard IRC behavior. Reduces our verb surface and matches standards instead of inventing a custom replay.
4. **Server name + version reporting.**
   - Server name: `agent-coord` (the daemon *is* the bus, not a separate identity).
   - `001 RPL_WELCOME` → `Welcome to the agent-coord bus, <nick>!`
   - `002 RPL_YOURHOST` → `Your host is <hostname>, running agent-coord-irc <version>`
   - `003 RPL_CREATED` → server start timestamp
   - `004 RPL_MYINFO` → `<hostname> agent-coord-irc/<version> <user_modes> <chan_modes>`
   Version pulled from the IRC module's own `package.json`.
5. **Network exposure — separate module, independent hardening.** Because the IRC server lives in its own repo, its security surface (TLS, auth, rate limiting, ban lists) can evolve and be audited independently of the MCP core. Default bind: `127.0.0.1`. Anything else requires an explicit `--bind` flag plus a printed warning. README leads with the threat-model change.
6. **Implementation — from scratch.** Verb set: `PRIVMSG`, `JOIN`, `PART`, `NICK`, `TOPIC`, `NAMES`, `LIST`, `MOTD`, `WHO`, `WHOIS`, `PING`, `PASS`, `QUIT`, `CAP LS`, `CAP REQ`, `CAP END`, `CHATHISTORY`. Estimated 600–900 LoC. npm IRC daemon options are mostly unmaintained and would fight us on the JSONL-backed state model.

### Build plan

Use the bus itself to coordinate the build — meta but on-brand:

- A dedicated **`#irc-build`** channel on this bus.
- A new Claude Code agent (`irc-dev` or similar) spun up specifically for the new repo, registers with that channel, and is directed via DM/room by this maintainer (coord-dev).
- The new repo (`agent-coord-irc`) starts as a Node + TypeScript project with the same dist/files convention as `agent-coord-mcp`.
- First milestone: localhost-only server accepting `weechat /connect localhost 6667`, JOINing `#general`, and seeing room.jsonl history via `CHATHISTORY`.
- Second milestone: agent-side IRC client wrapper so a non-MCP agent can join via standard `irc-framework`.
- Third milestone: TLS + SASL `PLAIN` for LAN/internet exposure.

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
