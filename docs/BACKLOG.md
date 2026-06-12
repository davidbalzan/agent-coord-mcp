# BACKLOG — agent-coord-mcp

> David's inbound task queue (local, gitignored). `## Queue` is **David's region** — append-only
> from the coordinator side; David/UI prunes. The coordinator appends completed items to `## Done`
> with their PR ref (read-before-write CAS so a `## Done` append never clobbers a `## Queue` edit).
> Priorities: P1 > P2 > P3.
>
> Initial population: compiled 2026-06-12 by agent-mcp-coordinator from ROADMAP gaps, code scan, and
> issues surfaced in the v0.8.0/0.8.1 work. Items are coordinator-proposed for David's triage.

## Queue

### P1 — defects
- [P1] **Fix recurring `agent-coord-mcp` self-dependency in `package.json` + `package-lock.json`.**
  A self-dep (`"agent-coord-mcp": "^0.x"`) keeps reappearing in `dependencies` — it makes the package
  depend on an old published copy of itself and breaks `npm install`. Removed once during v0.8.0 work;
  has re-appeared (now `^0.8.0`). Done-def: line gone from both files, identify+stop whatever re-adds
  it (linter/hook/`npm i <self>` misfire), `npm install` clean from a fresh clone. **Needs David ruling**
  — it has been flagged "intentional" in this environment, but reads as a defect; confirm before fixing.

### P2 — protocol/tooling gaps
- [P2] **Implement `force_unregister` MCP tool.** The coordinator handoff protocol (coordinator skill,
  *Coordinator Handoffs* / *Delivery And Restart Hygiene*) tells an incoming coordinator to evict an
  unreachable predecessor with `force_unregister` — but no such tool exists (`unregister`/`detach_agent`
  only act on self / bound identity). Done-def: a tool that, given a target agentId, removes its registry
  entry + transport marker + (optionally) drains its inbox, identity-gated so only a deliberate operator
  call can evict another agent; tests; README + skill cross-ref.
- [P2] **`coord-chat /doctor` command surface.** The `doctor` MCP tool shipped (v0.7.2) but the ROADMAP
  doctor section lists "still open: the coord-chat /doctor command." Done-def: `/doctor [--fix]` command
  in `coord-chat.mjs` rendering the structured report, plus a CLI flag; matches the MCP tool's output.

### P3 — hardening / features
- [P3] **`doctor` reaper for wedged pushers (pid-alive, pane-dead).** v0.8.0 made pushers self-exit on a
  dead pane, but a pusher that's alive yet whose pane is gone (didn't self-exit) is still reported "live"
  by `list_agents` and not caught by `doctor`. Add a check: probe each local `tmux-push` marker's
  `tmuxTarget`; under `fix:true`, SIGTERM the pusher + clear the marker. Host-local only.
- [P3] **Pusher safety: pane outlived the agent as a bare shell.** If a pane survives after the agent CLI
  exits, peer messages paste into the shell. Self-exit doesn't catch this (pane is alive). Detect via
  `pane_current_command` (or similar) and refuse to inject / self-exit. RISK-tagged — typing into a live
  shell is the worst failure mode of the transport.
- [P3] **Encrypted DMs (ROADMAP Phase 7).** Per-agent keypairs; encrypt `inbox/*.jsonl` payloads so the
  local-storage-readable threat model goes away. Core bus feature, large.
- [P3] **Lightweight message reactions/acks in the JSONL model.** Let an agent ack a peer ping without a
  full message (a `react`-flagged entry). Reduces room noise; the coordinator protocol leans on
  `post_status` for this today, so low urgency.

## Done

_(none yet)_

---

## Cross-project (NOT agent-coord-mcp — route to the owning coordinator)

- **IRC layer (ROADMAP Phase 5) + TLS/SASL Tier 2/3 + persistent bouncer** → `agent-coord-irc`
  (coord-dev). Separate repo/package by design; superseded for agents by Phase 6 (Remote MCP).
- **Web view (read-only SSE room feed) / search-archive UI** → likely `agent-coord-ui`
  (agent-ui-coordinator). `coord-chat /find` is the in-process precursor.
