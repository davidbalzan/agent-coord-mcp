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

## Phase 5 — IRC layer for humans (and IRC-native bots)  🅿️ parked

> **Status: parked, not deleted.** Started, then superseded for the *agent* audience by Phase 6 (Remote MCP) — agents speak MCP natively, so translating their structured tool calls through IRC PRIVMSGs was a protocol downgrade for no gain. IRC still has merit for the *human-on-weechat* audience (existing mature clients, no `coord-chat` port required) and can resume as a separate add-on package later if that audience materialises. The scope below stands as the design of record if/when it's picked back up.



**Goal.** Let humans on *different machines* join the same bus using their existing IRC client (weechat, irssi, HexChat, web). Also makes the bus reachable to any IRC-native bot ecosystem that happens to fit. **Not** the recommended path for agents that already speak MCP — those go through Phase 6.

**Why IRC for this audience.** The product is already IRC-shaped — channels, DMs, nicks, topic, MOTD, membership, server notices. Vocabulary maps 1:1, so the wire format is a translation, not a redesign. And the ecosystem of mature IRC clients means humans get great UX for free, no `coord-chat` port required for every platform.

**Why NOT IRC for agent-to-agent.** Agents already speak MCP — structured tool calls (`join`, `send_message`, `list_agents`, etc.). Forcing them through IRC would mean translating each call into PRIVMSG-shaped text and reparsing structured replies out. That's a protocol downgrade for no gain. See Phase 6 for the right answer.

### Scope

- Minimal embedded IRC server (just the verbs we actually use):
  `PRIVMSG`, `JOIN`, `PART`, `NICK`, `TOPIC`, `NAMES`, `LIST`, `MOTD`, `WHO`, `WHOIS`, `PING`, `PASS`, `QUIT`, `CAP LS`, `CAP REQ`, `CAP END`
- Single canonical instance. **No s2s / federation** in this phase — that's a much bigger build, defer.
- TCP listener on localhost first, then bind to LAN address, then optional TLS for public-internet exposure.
- Reads + writes the same `~/agent-coord/` files. JSONL stays the source of truth; the IRC server is a view onto it.
- Local MCP server unchanged. Local agents keep using stdio. Remote *agents* should not use IRC — they should use the remote MCP transport (Phase 6).
- New bin in its own package: `agent-coord-irc`.

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
- An IRC-native bot can use a standard IRC client library (`irc-framework` in TS, `pydle` in Python) to participate.
- The local MCP path is unchanged — existing local agents see no difference.
- `tail -f ~/agent-coord/rooms/general.jsonl` shows messages from both local and remote senders interleaved.

---

## Phase 6 — Remote MCP transport  ✅ shipped (v0.6.0)

Agents on *other machines* join the bus by connecting to the same MCP server they'd connect to locally — over Streamable HTTP instead of stdio. Same tool surface (`join`, `send_message`, `list_rooms`, `join_room`, etc.), zero protocol translation, structured payloads end-to-end. Local stdio is unchanged; HTTP is opt-in via `AGENT_COORD_HTTP_PORT`.

### Delivered

- **Streamable HTTP transport** alongside stdio. Env-driven: `AGENT_COORD_HTTP_PORT` set → run as a long-lived HTTP daemon; unset → stdio per-client (legacy behavior). Same `McpServer` registrations, per-session transport bookkeeping internal to the SDK.
- **Bearer-token auth** via `AGENT_COORD_TOKEN`. `GET /healthz` is unauthenticated for reverse-proxy probes; everything else 401s without `Authorization: Bearer <token>`.
- **Bind defaults to `127.0.0.1`**; explicit `AGENT_COORD_BIND` override required to expose on a LAN address, with a startup warning so it's not accidental. TLS is delegated to a reverse proxy (nginx / Caddy) or a private overlay (Tailscale / WireGuard).
- **`coord-pusher`** — new bin: the remote counterpart to `hooks/tmux-pusher.mjs`. Runs on the remote machine, consumes the bus over MCP (`wait_for_message` long-poll per subscribed source), pastes incoming peer messages into the local tmux pane. Same paste pipeline as the local pusher; same filtering (self-echo, allowlist, slash-prefix); same debounce. Channel membership re-checked periodically via `list_rooms` so newly-`join_room`ed channels start tailing within ~30s.
- **`report_transport` / `clear_transport` MCP tools** — wire-callable counterparts to `attach_agent` / `detach_agent` for the remote pusher to publish its marker (`transport: "tmux-push-remote"`) so `list_agents` surfaces it. Liveness for remote markers is heartbeat-based (the pusher heartbeats every minute), not pid-based.

### Out of scope (deferred to v0.7+)

- TLS termination in the server itself
- OAuth 2.1 flows / per-agent token rotation
- Per-tool authorization
- True multi-machine *state* (the server still reads/writes one filesystem; remote agents reach it via RPC, but the canonical state lives on the host)

### Verified

- Loopback two-process test: HTTP server + `coord-pusher` on the same box delivers both DMs and channel posts to the configured tmux pane within ~1s of arrival.
- `SIGTERM` on the pusher cleanly clears the transport marker via `clear_transport`.
- Stdio mode unchanged; existing local agents see identical behavior.

---

## Maintenance — `doctor` health tool  📝 proposed

**Goal.** A single read-mostly diagnostic that inspects the whole `~/agent-coord/` state and reports drift, leaks, and corruption — the "why isn't my DM landing / why is this agent still showing online" questions, answered in one call instead of by hand-tailing JSONL. Complements `status` (one agent) and `list_agents` (registry only) with a *bus-wide* view.

**Why now.** The state is spread across `agents.json`, `rooms.json`, `transports/`, `inbox/`, `cursors/`, and the channel JSONL files, mutated by the MCP server, the hooks, the pushers, and `coord-chat` — all without a single owner. Several known drift modes already exist (orphan memberships from 24h eviction, stale transport markers, cursor offsets past EOF, malformed JSONL lines). `doctor` makes them visible and, opt-in, fixable.

### Scope

A `doctor({ fix?: boolean })` MCP tool (and a `coord-chat /doctor` command + `coord-chat` flag) that runs a fixed set of checks and returns a structured report. `fix:false` (default) is purely diagnostic; `fix:true` applies the safe, reversible repairs and lists what it changed.

**Checks (each → `{ check, level: ok|warn|error, detail, fixable }`):**

1. **Orphan transport markers** — `transports/*.json` whose `pid` is dead (already pruned lazily by `list_agents`; `doctor` reports them eagerly). *Fix: delete the marker.*
2. **Orphan room memberships** — ids in `rooms.json` `members[]` not present in `agents.json` (left by the 24h eviction path, which doesn't strip memberships). *Fix: drop them (same compaction `prune` now does).*
3. **Orphan inboxes / cursors** — `inbox/*.jsonl` and `cursors/*.json` for ids no longer registered. *Fix: delete (gated, mirrors `prune --removeOrphanInboxes`).*
4. **Cursor past EOF** — any cursor offset (`inboxOffset`, `roomOffset`, `roomOffsets[chan]`, `statusOffset`) greater than the current parsed line count of its file → that source returns `[]` forever. *Fix: clamp to the file length.*
5. **Malformed JSONL** — count unparseable lines per file (these silently desync offset math between the MCP server and the hooks). *Fix: `fix:true` rewrites the file dropping bad lines, after a `.bak` copy.*
6. **Stale agents** — registered but `lastHeartbeat` older than `STALE_MS`/`EVICT_MS`, with no live transport. *Report only* (eviction stays a `list_agents` side effect; `doctor` just surfaces it).
7. **Oversized files** — channel/inbox/status JSONL above a size threshold (default 5 MB) → suggests a `prune`. *Report only.*
8. **Lock health** — leftover `*.lock` dirs older than `stale` (5 s) from a crashed writer. *Fix: best-effort release.*
9. **Channel/registry consistency** — `general` always present; every `rooms/<chan>.jsonl` has a matching registry entry and vice-versa.
10. **Environment sanity** — resolved `ROOT`, whether it's on a network/synced FS (lockfile caveat), `process.execPath` the pushers will inherit, and whether `tmux` is on PATH.

### Design notes

- **Read-only by default; every fix reversible or backed up.** `fix:true` never deletes message history without a `.bak` (check 5); membership/marker/cursor repairs are idempotent and safe to re-run.
- **Reuse, don't duplicate.** Checks 2/3 share the compaction logic `prune` already grew; check 4 reuses the cursor-clamp math from `prune`'s offset-shift; PID liveness reuses `isPidAlive`. `doctor` is mostly orchestration over existing primitives.
- **Output doubles as a smoke test.** A clean `doctor` report is the cheapest end-to-end assertion that the bus is internally consistent — useful in CI against a seeded state dir.
- **No new files on disk.** It inspects existing state; the only writes happen under `fix:true`.

### Success criteria

- `doctor()` on a healthy bus returns all-`ok` and touches nothing.
- After killing a pusher with `kill -9` (leaving a marker) and evicting an agent that owned a membership, `doctor()` reports both as `warn`/`fixable`, and `doctor({fix:true})` clears them, with a clean follow-up run.
- A hand-corrupted cursor (offset past EOF) is detected and clamped, restoring delivery.

---

## Phase 7+ — Possible follow-ups

Listed here so they don't clutter Phase 5/6, but worth tracking as ideas:

- **TLS + SASL** for IRC layer (Tier 2/3 auth).
- **Server-to-server federation.** Two bus instances on different LANs linked into one chat surface. Hard but real demand if multi-team adoption happens.
- **Web view.** Read-only HTML page that streams the room feed over SSE. Lightweight spectator mode for non-IRC humans.
- **Persistent bouncer behavior.** Hold messages for offline IRC clients and replay on reconnect.
- **Message reactions / threads.** Light IRCv3 reaction support. Useful for "agent acknowledges peer ping" without sending a full message.
- **Search / archive UI.** `/find` in coord-chat is the in-process version; a separate browse tool would help long-term archives.
- **Encrypted DMs.** Per-agent keypairs, encrypt inbox payloads. Local-storage-readable threat model goes away.
