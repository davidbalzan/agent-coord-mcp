# WORKSTREAMS — agent-coord-mcp

> Live board, owned by the coordinator (`claude-code`). State lives here; chat carries diffs only.
> Inbound queue: `docs/QUEUE.md` · completion log: `docs/DONE.md`.
> **Last updated 2026-07-29.** The prior contents were frozen at 2026-07-03 (v0.13.0, agents
> `mcp-coord` / `coord-mcp-worker-1` / `coord-mcp-qa`) and described a fleet that no longer exists.

## Roles

- **Coordinator + gate:** `claude-code` (pane `%2`). There is no QA or CI agent in this fleet, so the
  coordinator gates — always **non-author**, always from a standalone clone, never a worktree
  (worktrees share one object database, so a gate run inside one can resolve commits the author never
  pushed).
- **Gate method:** full suite ≥3 runs, plus **mutation testing** of whatever the change actually rests
  on. Not ceremony — it caught a real gap in #34: the `-e` capture flag the entire ghost-text fix
  depends on had no test witness, so either capture site could lose it with the suite still green.

## Lanes

> **Five columns, fixed.** `BoardRow` in `src/work.ts` is a 5-tuple and `export_work` renders exactly
> those; a sixth column is dropped on write-back. #38 added a `Pane` column here and broke the
> round-trip for two commits — pane ids live in the Owner cell instead.

| Lane | Owner | State | Current slice | Next GO |
|---|---|---|---|---|
| repo | `ai-workflow-worker-1` (pane `%209`) | working | P2 guard first-use identity binding against claiming a live agent id | next P1/P2 by priority |
| repo | `david-worker-2` (pane `%210`) | gate pending | remote receipt build identity (#40): both pushers stamp a module-graph build id on every receipt; `deliveryOutcome` annotates a confirmed verdict from a stale or unstamped reporter without downgrading it | next GO after gate |

## Release

**0.19.0 merged to main (`57d98f4`), NOT published — publish is David's.**

- `package.json` + lockfile at `0.19.0`; suite 226/226; `npm pack --dry-run` confirms the tarball ships
  `dist/server.js`, `hooks/{tmux-pusher,submit,marker,tier}.mjs`, `scripts/coord-pusher.mjs` — every fix
  in this release lives in those files.
- `prepublishOnly` re-runs the self-dep guard + `tsc`, so the tarball is built fresh at publish time.
- **No git tag yet.** Tagging is already inconsistent here (`v0.13.0` and the `v0.8.x` line are tagged;
  `0.17.0` and `0.18.0` are not).

## Open blockers

**The rollout gap — merging is not deploying.** Every MCP server on this bus predates #28, so:

- all five markers have `serverBuildMtime=ABSENT`, and the pusher that ran the ghost-delivery demo still
  has no `--agent` in argv despite that fix being merged;
- `doctor` run from any current session does **not show** `server-build-drift` or
  `marker-server-provenance` at all — those checks live in code the running servers do not have.
  A stale server cannot self-report; **the absence of the check is itself the tell.**

Clears on session restart, not on `npm publish` (agents run the server from the working checkout by
absolute path). After #36, a restarted session will name every marker that a stale server stamped.

## Pending David decisions

- **None.** The long-standing P1 self-dependency ruling was closed 2026-07-29 as stale: one introduction
  in the whole history (`de4e1ee`, an `npm audit fix` whose message claimed lockfile-only), removed by
  `3bce3ce`, 83 commits clean, and `scripts/check-self-dependency.mjs` already guards it on
  `prepare` / `pretest` / `prepublishOnly`.

## Board

`docs/QUEUE.md`: **1 P1 · 5 P2 · 4 P3.** The single P1 is Phase 8 (partially landed). 0.19.0 closed both other P1s and one P2.

## Notes

- Room `#ai-workflow`. Bus root `~/agent-coord`.
- `researcher-1` / `researcher-2` (panes `%0`/`%1`) belong to a **different project** — not this fleet,
  not ours to restart or re-attach.
- **Recurring defect shape in this repo, hit six times:** a check that reports healthy while the thing it
  checks is not — `scriptMtime` written by its own subject; freshness watching one file of a two-file
  module; the server that stamps freshness never itself checked; a missing stamp read as exemption; the
  draft guard reading terminal chrome as content; the `-e` flag with no witness. When adding a check,
  ask what disables it silently.
- **Corollary, learned the same way:** an inference is not a finding. Three diagnoses on 2026-07-29 were
  wrong until someone measured — `signal-exit` on a stack read as proof of a kill (nothing was killing
  it); three clean runs read as "does not reproduce" (it was 1-in-4); three live refusals read as the
  draft guard working (it was refusing empty inputs).
