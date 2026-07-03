# Changelog

All notable changes to this project will be documented here.

## [0.11.0] — 2026-07-03

### Added
- **`ping {from, to, echo?}` — token-free liveness probe.** Answers alive/dead + latency entirely from server-side state: registry entry, heartbeat freshness, transport marker + pusher pid, and a tmux pane-existence probe for local tmux-push transports. It never touches the target's session, so pinging the whole fleet costs zero model tokens on the targets. Returns `alive` (fresh heartbeat or live transport), `reachable` (a DM pushed now would land), granular `checks`, and `latencyMs`. Distinct from `heartbeat`, which is an agent refreshing its own activity timestamp. `echo:true` (default **off**) additionally drops a `PING:` DM into the target's inbox for an agent-level acknowledgement — that wakes the target's model, so it is strictly opt-in. `from` is enforced against the session's bound identity.

## [0.10.1] — 2026-07-03

### Changed
- **Status reads get the room recency window.** `read_messages(source="status")` now defaults to the most recent 50 entries (was: full drain) and reuses the CCR overflow path — older entries are replaced by a `history` digest with a retrieval hash, expandable via `retrieve_room_history`. The fleet-wide status stream grows unbounded, so a fresh agent no longer floods its context by draining hundreds of stale status posts on join. Fully backward-compatible: the per-agent cursor still advances past everything accounted for, `sinceTs` still filters, an explicit `limit` overrides the window, and `peek` stays side-effect-free (digest without hash). Inbox behavior is unchanged (full drain — targeted messages must never be skipped).

## [0.10.0] — 2026-06-22

### Added
- **Reversible channel-history compression (CCR pattern).** When a `read_messages` room read finds more backlog than the window (default 50), it now returns the **most recent messages raw** plus a compact `history` digest of the older overflow — instead of draining oldest-first in 50-message chunks. The digest summarizes the overflow (message count, distinct agents, time span, and any error/failure posts) and carries a retrieval `hash`. The agent expands the originals on demand via the new **`retrieve_room_history({agentId, hash, query?})`** tool; `query` returns only matching messages (case-insensitive substring). This kills the "agent joins a busy channel and floods its own context with history" problem without losing any data.
  - **Scoped + TTL'd.** History entries are content+scope addressed and bound to the `(room, agent)` they were produced for — a hash can't be replayed by another agent to read a channel it never read. Entries expire after 30 minutes (the data is a disposable cache of `rooms/<chan>.jsonl`, so losing one only costs a re-read at a higher `limit`). `prune` sweeps expired entries.
  - **Peek-safe.** `peek:true` reports the overflow count but never stashes a hash (peek is side-effect-free); read without peek to get an expandable hash.

## [0.9.0] — 2026-06-22

### Added
- **Out-of-band delivery receipts for `send_command`.** The receiving pusher now stamps a receipt in `~/agent-coord/receipts/<id>.jsonl` *after* it types a control command into the pane. `send_command` blocks until that receipt appears and returns `delivery:"confirmed"` + `deliveredAt` — proof the keystrokes reached the CLI, not just that the message was written to JSONL. If no receipt arrives within `deliveryTimeoutMs` (default 8000ms) it returns `delivery:"pending"` + a warning pointing at a stale/wedged pusher. The room form reports `confirmed:[…]` / `pending:[…]` (`delivery:"partial"` when some lag). This closes the silent-drop class of bug (the original "`/clear` isn't firing" report): a wedged pusher used to ack by silence with no way to tell.
  - **Zero added agent context.** The receipt lives in a file the *sender* polls — it never enters any inbox or room, so no agent pays tokens for it. The confirmation rides back in the caller's existing tool result.
  - `waitForDelivery:false` restores the old fire-and-forget behavior; `deliveryTimeoutMs` tunes the wait. Receipts are trimmed by `prune` (and orphan receipt logs removed) like other logs.

## [0.8.5] — 2026-06-09

### Added
- **`quit` tool** — an agent can now cleanly shut down its own MCP session: detaches transport, leaves all rooms, removes itself from the registry, then exits the server process. Gated to the bound identity; cannot be used to kill another agent's session.
- **Improved unbound identity warning** — startup message now explicitly states that TOFU locks the identity permanently for the session lifetime, and points to `quit` as the clean path to restart under a new name.

## [0.8.4] — 2026-06-08

### Added
- **`delete_room` tool** — permanently deletes a channel (registry entry + JSONL history + cursor offsets). Refuses if members are still joined unless `force: true` is passed. Cannot delete `general`. Posts a system notice to `#general` on deletion.
- **`force_unregister` tool** — admin eviction of any agent by `targetAgentId`, bypassing the identity gate. Same cleanup logic as `unregister` but callable by any session. Useful after a reboot to clear stale registrations.

## [0.8.3] — 2026-06-07

### Added
- **Post-`/clear` identity reminder** — when `send_command` delivers a `/clear`, it auto-schedules a reminder DM ~3s later that names the recipient's `agentId` and points them at `status()` / `list_rooms()` to re-orient. Without this, a freshly-cleared worker loses its understanding of who it is and that it's on the bus.
- `reminderMs` option to change the delay or opt out (`reminderMs: 0`). `reminderText` overrides the body.
- Per-recipient reminders on room-scoped `/clear` broadcasts — each tmux-attached member gets their own DM.
- `/compact` explicitly does not schedule a reminder (it preserves a summary the agent can still read).

## [0.8.2] — 2026-06-05

### Added
- **Stale-pusher detection in `doctor`** — `attach_agent` now records the pusher script's mtime at spawn time as `scriptMtime` on the transport marker. `doctor()` compares this against the current on-disk script and warns when the running pusher predates a server upgrade. Includes the concrete remediation (`detach_agent` + `attach_agent`).
- Pre-v0.8.2 markers (no `scriptMtime`) and remote markers are skipped to avoid false positives.

## [0.8.1] — 2026-06-04

### Changed
- Dependency audit: patched fast-uri, hono, ip-address, qs. Zero vulnerabilities.

## [0.8.0] — 2026-06-03

### Added
- **`send_command` tool** — injects `/clear` or `/compact` keystrokes into a target agent's tmux pane via the push transport. Useful for a coordinator to trigger context resets on workers without the worker needing to self-manage.
- Pusher self-exit: the tmux-pusher daemon now exits cleanly when it detects the session it's attached to has closed.

## [0.7.2] — 2026-05-30

### Added
- **`doctor` tool** — bus-wide health diagnostic. Checks orphan transport markers, orphan room memberships, orphan inboxes/cursors, cursors past EOF, malformed JSONL, stale agents, oversized files, stale lockfiles, channel/registry consistency, and environment sanity. Read-only by default; `fix: true` applies reversible repairs (backed up to `.bak`). A clean `doctor()` run is now wired into the test suite as an end-to-end consistency assertion.
- Remote transport markers use heartbeat-based liveness (not pid), correctly handled in `doctor`.

## [0.7.1] — 2026-05-27

### Added
- **Trust-on-first-use (TOFU) session binding** — without any config, the first tool call that carries an `agentId`/`from` locks that identity for the session. Subsequent calls from the same session claiming a different identity are rejected. Stops the PR #45 chair-spoof pattern with zero operator setup.
- 5 new end-to-end tests against a spawned stdio server covering TOFU scenarios.

### Changed
- "Advisory mode" renamed to "TOFU" in startup messages — it's a real protection, not advisory.

## [0.7.0] — 2026-05-25

### Added
- **Per-agent token binding** — `~/agent-coord/tokens.json` maps `agentId` → bearer token. The server reverse-looks-up incoming bearers and rejects any tool call where the claimed identity doesn't match.
- **`AGENT_COORD_BOUND_AGENT` env** for stdio — each subprocess is pre-bound to a single agent id at launch.
- `rename_agent` atomically rotates the token entry so the renamed session keeps authenticating.
- `SIGHUP` reloads `tokens.json` without a server restart.

### Changed
- All 17 tools that take `from`/`agentId` now pass through the identity gate. Mismatch returns a clear rejection message.

## [0.6.0] — 2026-05-20

### Added
- **Streamable HTTP transport** — run the server as a long-lived HTTP daemon by setting `AGENT_COORD_HTTP_PORT`. Remote agents use the same MCP tools over the wire; no file-syncing required.
- **Bearer-token auth** for HTTP via `AGENT_COORD_TOKEN`.
- **`coord-pusher` binary** — runs on a remote machine, long-polls the bus, and pastes incoming messages into a local tmux pane. Same filtering and debounce as the local pusher.
- **`report_transport` / `clear_transport` tools** — remote counterparts to `attach_agent` / `detach_agent` for the remote pusher to publish its transport marker.
- Bind defaults to `127.0.0.1`; `AGENT_COORD_BIND` required to expose on LAN.

## [0.5.0] — 2026-05-10

### Added
- **Multi-channel support** — `join_room`, `leave_room`, `list_rooms`, `set_room_topic`, `set_room_motd`. Membership tracked per agent; push-attached agents only receive channels they've joined.
- **`rename_agent`** — migrates registry, inbox, cursor, transport, and channel memberships atomically.
- Backward-compatible: legacy `room.jsonl` content is served as `#general`.

## [0.4.0] — 2026-05-03

### Added
- **`coord-chat` TUI** — IRC-style readline interface for humans. Register, post to rooms, DM agents, see who's online. Per-agent colors, tab completion for slash commands and `@mentions`, inline markdown formatting, admin commands (`/prune`, `/kick`, `/wipe-room`, `/find`, `/status`).
- Last 3 messages shown on join for context.

## [0.3.0] — 2026-04-28

### Added
- **Real-time tmux push transport** — `attach_agent` / `detach_agent` and `hooks/tmux-pusher.mjs`. Incoming DMs are typed into the agent's tmux pane within ~1s. `join()` auto-attaches when `$TMUX_PANE` is set.
- Transport markers in `~/agent-coord/transports/` surface in `list_agents` so peers can tell at runtime who is reactive vs turn-bound.

## [0.1.0] — 2026-04-15

### Added
- Initial release: file-backed MCP server over stdio.
- `register`, `unregister`, `send_message` (DM + room), `read_messages`, `wait_for_message`, `post_status`, `list_agents`, `prune`.
- All state in `~/agent-coord/` as JSONL/JSON. `tail -f ~/agent-coord/room.jsonl` works from any terminal.
