# BACKLOG — agent-coord-mcp

> David's inbound task queue (local, gitignored). `## Queue` is **David's region** — append-only
> from the coordinator side; David/UI prunes. The coordinator appends completed items to `## Done`
> with their PR ref (read-before-write CAS so a `## Done` append never clobbers a `## Queue` edit).
> Priorities: P1 > P2 > P3.
>
> Initial population: compiled 2026-06-12 by agent-mcp-coordinator from ROADMAP gaps, code scan, and
> issues surfaced in the v0.8.0/0.8.1 work; reconciled against HEAD v0.8.9 (main raced ahead during
> compilation — `force_unregister` and a `quit` tool shipped meanwhile and were dropped from here).
> Items are coordinator-proposed for David's triage.

## Queue

### P1 — defects
- [P1] **Fix recurring `agent-coord-mcp` self-dependency in `package.json` + `package-lock.json`.**
  A self-dep (`"agent-coord-mcp": "^0.x"`) keeps reappearing in `dependencies` — it makes the package
  depend on an old published copy of itself and breaks `npm install`. Removed once during v0.8.0 work;
  has re-appeared (now `^0.8.0`). Done-def: line gone from both files, identify+stop whatever re-adds
  it (linter/hook/`npm i <self>` misfire), `npm install` clean from a fresh clone. **Needs David ruling**
  — it has been flagged "intentional" in this environment, but reads as a defect; confirm before fixing.

### P2 — protocol/tooling gaps
- [P2] **`coord-chat /doctor` command surface.** The `doctor` MCP tool shipped (v0.7.2) but the ROADMAP
  doctor section lists "still open: the coord-chat /doctor command." Done-def: `/doctor [--fix]` command
  in `coord-chat.mjs` rendering the structured report, plus a CLI flag; matches the MCP tool's output.


### P3 — hardening / features
- [P3] **`doctor` reaper for wedged pushers (pid-alive, pane-dead).** v0.8.0 made pushers self-exit on a
  dead pane, but a pusher that's alive yet whose pane is gone (didn't self-exit) is still reported "live"
  by `list_agents` and not caught by `doctor`. Distinct from the v0.8.2 `stale-pusher-script` check (which
  flags a pusher running *pre-upgrade code*, not a dead *pane*). Add a check: probe each local `tmux-push`
  marker's `tmuxTarget`; under `fix:true`, SIGTERM the pusher + clear the marker. Host-local only.
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

- [feat] **Compact injection format over the tiered formatter (v0.8.10 salvage).** Re-applied the stranded
  v0.8.10 token optimizations onto the post-#4 formatter, both pushers: short header keeping a "don't
  re-read" hint, HH:MM UTC timestamps, stripped `room ` prefix, dropped `from=` label — extended to the
  new routine-digest block too. davidbalzan/agent-coord-mcp#6 (squash-merged `74ae6f4`, v0.14.0). Gate:
  coord-mcp-qa (build + 64/64) + mcp-coord independent parse-contract verify (adversarial round-trip 5/5:
  brackets/`] `/nested-header/empty-text all recover). Documented non-regression: newline-in-body still
  wraps to header-less continuation lines (same as pre-#6). Supersedes stranded local commit `9b710c6`;
  David's primary checkout reset to origin/main. Owner: coord-mcp-worker-1.

- [P2] **coord-chat `/doctor` command + `--doctor` CLI flag.** Renders the structured doctorTool report
  (single dynamic import of dist doctorTool — no reimplemented checks), `--fix` passthrough, exit 0 healthy
  / 1 on error. davidbalzan/agent-coord-mcp#5 (squash-merged `aba53c6`, v0.13.0; `scripts/coord-chat.mjs` +
  `test/coord-chat-doctor.test.mjs`). Gate: coord-mcp-qa solo (routine) — build + 60/60 + live+scratch
  behavior check vs MCP tool. Closes the last ROADMAP doctor gap. Owner: coord-mcp-worker-1.
  Note: run against the live bus it surfaced 12 stalled cursors + orphans → `doctor --fix` applied
  (David-approved), bus now healthy (0 err).

- [P2] **Delivery tiers + digest batching in the pusher.** Urgent traffic pushes immediately carrying a
  coalesced digest of queued low-tier; routine queues silently, rides the next push; zero self-poll.
  davidbalzan/agent-coord-mcp#4 (squash-merged `a47164a`, v0.12.0). HIGH-RISK (pusher hot path) → fan-out
  gate: v1 FAILED (cursor commit-before-deliver lost coalesced backlog on crash/pane-death/SIGTERM;
  /clear-reminder demoted routine; DM DONE:/SCOPE:/GO over-matched). Reworked → v2 re-gate: commit-after-
  delivery (at-least-once, dup-not-loss), server-side `urgent` flag for reminder (non-spoofable), DM DONE:
  gate-runner-only, SCOPE: trusted-senders-only, literal GO:. Both loss-lens + tier-lens verifiers FIXED,
  57/57. Merged ≠ deployed: pushers pick it up on restart. Owner: coord-mcp-worker-1.

- [P2] **Liveness ping/ack.** `ping {from,to}` answers server-side (registry + pusher pid + tmux pane
  probe), never touches the target session; `echo` opt-in default-off; fleet ping = zero model tokens.
  davidbalzan/agent-coord-mcp#3 (squash-merged `af3631a`, v0.11.0). Gate: build + 47/47 + real-store probe
  (stale-heartbeat-but-live agent → alive, dead → heartbeat-stale, unknown → unregistered, inbox hash
  unchanged). Merged ≠ deployed: servers pick it up on restart. Owner: coord-mcp-worker-1.

- [P2] **Status-stream recency window.** `read_messages(source=status)` now returns newest 50 + expandable
  history digest instead of a full oldest-first drain; cursor/`sinceTs`/`limit`/`peek` semantics kept.
  davidbalzan/agent-coord-mcp#2 (squash-merged `f86a672`, v0.10.1). Gate: build + 45/45 tests + real-store
  probe (436 stale → newest 50 + digest, totalNew honest). Merged ≠ deployed: running servers pick it up
  on restart. Owner: coord-mcp-worker-1.

- [P1] **Self-dependency removed from `package.json`.** Dropped `"agent-coord-mcp": "^0.8.0"` from
  dependencies + re-locked; `npm install` clean, tests green, 0 vulns. Commit `3bce3ce` (direct to main).
  Note: no in-repo hook/script re-adds it — recurrence originates outside the repo (env editing process),
  so watch for it reappearing on future syncs.

---

## Cross-project (NOT agent-coord-mcp — route to the owning coordinator)

- **IRC layer (ROADMAP Phase 5) + TLS/SASL Tier 2/3 + persistent bouncer** → `agent-coord-irc`
  (coord-dev). Separate repo/package by design; superseded for agents by Phase 6 (Remote MCP).
- **Web view (read-only SSE room feed) / search-archive UI** → likely `agent-coord-ui`
  (agent-ui-coordinator). `coord-chat /find` is the in-process precursor.
