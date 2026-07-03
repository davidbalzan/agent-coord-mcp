# WORKSTREAMS — agent-coord-mcp

> Live board, owned by the coordinator (`mcp-coord`). State lives here; chat carries diffs only.
> Backlog (inbound queue): `docs/BACKLOG.md`.

## Roles

- Gate (routine PRs): `coord-mcp-qa` — ready, isolated clone `~/workspace/agent-coord-mcp-qa`. High-risk (pusher/delivery path, money, migrations) stays with mcp-coord's fan-out gate.

## Lanes

| Lane | Owner | State | Current slice | Next GO |
|---|---|---|---|---|
| server | coord-mcp-worker-1 | idle (all P2s done) | — released at v0.13.0 — | P3 pusher reaper / bare-shell guard (post-release, on David's go) |

## Release readiness (mcp-coord owns the finish line)

**Finish line = "David can push the finished version" when ALL true:**
1. P2 `/doctor` command merged (last open P2) — in progress, worker-1, QA gates.
2. All merged features gated green (done: #2 v0.10.1, #3 v0.11.0, #4 v0.12.0).
3. Tree clean at a tagged release version (target v0.13.0 after /doctor).
4. Coordinator docs (BACKLOG, WORKSTREAMS) committed; strays excluded (see below).

**Excluded from release (strays, do NOT commit):**
- `docs/prd.md` → belongs to agent-coord-ui, not this repo.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` → placeholder junk; repo is npm.

**Stays David's (not part of my finish line):**
- P1 self-dep ruling (fix already merged `3bce3ce`; only the ruling is pending — does NOT block release).
- The actual push/publish/tag + server-restart rollout (ops actions).

**Deferred to post-release (not blockers):** P3 pusher reaper, bare-shell guard, encrypted DMs, reactions.

**Trigger:** when line 1 lands green, mcp-coord DMs david "ready to push" with exact state.

**RELEASE STATUS (2026-07-03):** David approved push. Tag `v0.13.0` → `aba53c6` created + pushed to
origin (verified). `npm publish` BLOCKED on David — mcp-coord is npm-401, won't bootstrap creds; handed
David the 3-command publish sequence. npm `latest` was 0.10.0 (v0.10.1/0.11.0/0.12.0 never published →
0.13.0 jumps the gap). Rollout still needs server/pusher RESTART to take effect.

**VERSION BUMP (2026-07-03):** main bumped 0.13.0 → 0.14.0 (`cf87ae7`, direct-to-main FF) to open the P3
hardening cycle; CHANGELOG `[0.14.0] — Unreleased` stub added. Also re-synced package-lock.json (had
lagged at 0.12.0 — #5 bumped package.json but missed the lockfile). NB: my primary checkout
`~/workspace/agent-coord-mcp` local `main` is DIVERGED/stale (v0.8.10) — I work origin/main via worktrees.

## Open blockers

- None.

## Live-bus health (surfaced by #5 /doctor, read-only confirmed via MCP doctor)

- ERROR: 12 cursors past EOF (delivery stalled). Live agents affected: `playbook-owner` (14>10),
  `sg-ui` (137>0), `sg-fullstack` (122>0 — shadowguard, sg-coordinator's). Rest stale/unregistered.
- WARN: 5 orphan inboxes / 18 orphan cursors / 1 orphan membership (unregistered ids); 6 stale agents.
- RESOLVED 2026-07-03: David approved ("inform and fix"). `doctor --fix` applied — clamped playbook-owner,
  deleted 18 orphan cursors + 5 orphan inboxes + 1 orphan membership. Re-run: 0 error, 10 ok, 1 benign warn
  (6 stale agents auto-evict). sg-ui/sg-fullstack were ORPHAN stale ids, not live sg-coordinator agents.
  Only live agent affected: playbook-owner (cursor clamped → missed msgs now redeliver on its next read).

## Pending David decisions

- [P1] Self-dependency recurrence ruling — fix landed (`3bce3ce`), but queue item asks David to confirm
  the self-dep was a defect (it was flagged "intentional" once) and that recurrence source is external.

## Notes

- v0.8.10 is HEAD (compact message injection format).
- Room: `#coord-mcp`. Coordinator: `mcp-coord` (pane %33, tmux-push).
