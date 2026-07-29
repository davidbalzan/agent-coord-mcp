# DONE — agent-coord-mcp

The completion log — **append-only, the executor is the sole writer** (or the coordinator pulling from
`docs/QUEUE.md`). On completing a queue item, append one line with its PR ref. Nobody else writes here,
and the executor writes nowhere else in the queue seam (it never touches `docs/QUEUE.md`).

**Done-line format (pinned — required, not just an example):**

```
- [x] <task> — owner/repo#N · YYYY-MM-DD
```

Use the **em-dash `—` (U+2014)** before the PR ref and the **middot ` · ` (U+00B7)** before the date —
exact glyphs, not ASCII. Parsers that consume this file (e.g. the agent-coord-ui BacklogPanel) split on
those glyphs; an ASCII hyphen/period renders the panel empty.

## Done

- [x] A receipt names the pusher build that confirmed it, so a confirmed verdict from a stale or unstamped reporter is annotated without being downgraded — davidbalzan/agent-coord-mcp#40 · 2026-07-29
- [x] First-claim identity guard: a live agent id cannot be TOFU-claimed without its token, force, or its own pane, and unreadable evidence refuses rather than reading as verified-absent — davidbalzan/agent-coord-mcp#42 · 2026-07-29
- [x] `doctor` reaps wedged local pushers (pid alive, tmux pane gone) under fix, verified against real tmux rather than fixtures — davidbalzan/agent-coord-mcp@af2ca41 · 2026-07-29
- [x] Absence is not exemption: an unstamped marker is unverifiable, never ok, flipped for both freshness fields in one commit (it is also what made the provenance rescue work at all: pre-#30 servers never wrote the stamp, so the drift comparison had nothing to compare and all three stale markers were caught by the absence path) — davidbalzan/agent-coord-mcp#36 · 2026-07-29
- [x] `dist-behind-source`: the affirmative catch for merged-but-never-rebuilt, the disk behind itself rather than a process behind its dist — davidbalzan/agent-coord-mcp#32 · 2026-07-29
- [x] Server build identity sampled at load, stamped on markers as provenance, checked by doctor; marker rewrites merge instead of rebuild — davidbalzan/agent-coord-mcp#30 · 2026-07-29
- [x] The draft guard reads styling, so a TUI ghost suggestion is chrome rather than a draft (verified live end to end on an idle pane whose ghost suggestion was `/compact` itself; also the first genuine demonstration that the draft-refusal path protects a real typed draft) — davidbalzan/agent-coord-mcp#34 · 2026-07-29
- [x] The doctor suite cancelled itself on a missed exit event (the 25% gate flake; no signal involved, an event-loop drain) — davidbalzan/agent-coord-mcp#31 · 2026-07-29
- [x] The remote pusher reports delivery receipts over the wire (report_receipt; remote control commands are confirmable for the first time) — davidbalzan/agent-coord-mcp#27 · 2026-07-29
- [x] Pusher freshness covers the loaded module graph; pattern kills scoped per agent — davidbalzan/agent-coord-mcp#28 · 2026-07-29
- [x] The submit verifier reads the input line, not a tail window (P1b false negative; verified live, an idle pane with populated scrollback confirms twice, including with `/compact` already echoed into the transcript) — davidbalzan/agent-coord-mcp#25 · 2026-07-29
- [x] Control commands are verified as submitted rather than assumed (P1; verified live, busy pane declines with nothing pasted, draft pane refuses with the draft intact) — davidbalzan/agent-coord-mcp#21 · 2026-07-29
- [x] Read-only status/ping never establish a TOFU identity binding (P2 partial, item 2 of 3; items 1 & 3 pending architecture steer) — davidbalzan/agent-coord-mcp#12 · 2026-07-08
- [x] `coord-pusher` hard-fails on startup register/report_transport errors — davidbalzan/agent-coord-mcp#10 · 2026-07-08
- [x] `rename_agent` refreshes in-process token map without requiring SIGHUP — davidbalzan/agent-coord-mcp#8 · 2026-07-08
- [x] Compact injection format over the tiered formatter (v0.14.0) — davidbalzan/agent-coord-mcp#6 · 2026-07-03
- [x] coord-chat `/doctor` command + `--doctor` CLI flag (v0.13.0) — davidbalzan/agent-coord-mcp#5 · 2026-07-03
- [x] Delivery tiers + digest batching in the pusher (v0.12.0) — davidbalzan/agent-coord-mcp#4 · 2026-07-03
- [x] Liveness ping/ack, server-side, zero model tokens (v0.11.0) — davidbalzan/agent-coord-mcp#3 · 2026-07-03
- [x] Status-stream recency window (v0.10.1) — davidbalzan/agent-coord-mcp#2 · 2026-07-03
- [x] Self-dependency removed from package.json (direct to main; the queue item calling it "recurring" was closed 2026-07-29 as stale: `git log -S` finds exactly two commits touching that line ever, introduced by an `npm audit fix` whose message claimed lockfile-only, and 83 commits later it has not returned; the residual risk is filed as the manifest-diff class, not this line) — davidbalzan/agent-coord-mcp@3bce3ce · 2026-06-12
