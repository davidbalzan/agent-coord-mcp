# QUEUE — agent-coord-mcp

The inbound task queue. Ad-hoc tasks and phase items are added here by the human (or their planning
proxy, the liaison). Intake only: live in-flight state lives in [[WORKSTREAMS]], completions are
recorded in `docs/DONE.md`. Priority via the `(P1)`/`(P2)`/`(P3)` tag; top-to-bottom breaks ties.

**Write rule (single writer per file):** the human / liaison writes here — add / reorder / remove /
edit items, set priority, add acceptance criteria or refs inline. Whoever executes work never edits
this file; it reads the top unblocked item fresh and appends its completion to `docs/DONE.md`.

## Queue

- [ ] (P1) **Recurring `agent-coord-mcp` self-dependency in `package.json` + `package-lock.json`** — a self-dep (`"agent-coord-mcp": "^0.x"`, now `^0.8.0`) keeps reappearing in `dependencies`, making the package depend on an old published copy of itself and breaking `npm install`; removed once during v0.8.0 work. **Needs David ruling** — flagged "intentional" in this environment but reads as a defect; confirm before fixing · acceptance: line gone from both files, the re-add source (linter/hook/`npm i <self>` misfire) identified and stopped, `npm install` clean from a fresh clone.
- [ ] (P2) **Guard first-use identity binding against claiming a live agent id** — a fresh MCP session binds to the first agentId it sees (when `AGENT_COORD_BOUND_AGENT` is unset); even a diagnostic `status {agentId}` claims it, silently creating a second session acting as an already-registered, heartbeating agent (hit live 2026-07-06: a dev session bound itself to `disavow-liaison`) · acceptance: (1) binding to an id with a fresh heartbeat or live transport marker requires that agent's token (`coord-token`) or an explicit `force`; (2) read-only tools (`status`, `ping`) never establish a binding; (3) `doctor` warns when two live sessions bound the same id.
- [ ] (P3) **`doctor` reaper for wedged pushers (pid-alive, pane-dead)** — v0.8.0 made pushers self-exit on a dead pane, but a pusher that's alive yet whose pane is gone is still reported "live" by `list_agents` and missed by `doctor` (distinct from the v0.8.2 stale-pusher-script check) · acceptance: probe each local `tmux-push` marker's `tmuxTarget`; under `fix:true`, SIGTERM the pusher + clear the marker; host-local only.
- [ ] (P3) **Pusher safety: pane outlived the agent as a bare shell** — if a pane survives after the agent CLI exits, peer messages paste into the shell (self-exit misses it, the pane is alive); RISK — typing into a live shell is the worst failure mode of the transport · acceptance: detect via `pane_current_command` and refuse to inject / self-exit.
- [ ] (P3) **Encrypted DMs (ROADMAP Phase 7)** — per-agent keypairs; encrypt `inbox/*.jsonl` payloads so the local-storage-readable threat model goes away; core bus feature, large · acceptance: DM payloads encrypted at rest, decryptable only by the recipient agent.
- [ ] (P3) **Lightweight message reactions/acks in the JSONL model** — let an agent ack a peer ping without a full message (a `react`-flagged entry) to reduce room noise; low urgency (coordinator protocol uses `post_status` today) · acceptance: a `react`-flagged entry type peers/`list` can surface without a full message.

## Cross-project (NOT agent-coord-mcp — route to the owning coordinator)

- **IRC layer (ROADMAP Phase 5) + TLS/SASL Tier 2/3 + persistent bouncer** → `agent-coord-irc` (coord-dev). Separate repo/package by design; superseded for agents by Phase 6 (Remote MCP).
- **Web view (read-only SSE room feed) / search-archive UI** → likely `agent-coord-ui` (agent-ui-coordinator). `coord-chat /find` is the in-process precursor.
