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

- [x] `rename_agent` refreshes in-process token map without requiring SIGHUP — davidbalzan/agent-coord-mcp#8 · 2026-07-08
- [x] Compact injection format over the tiered formatter (v0.14.0) — davidbalzan/agent-coord-mcp#6 · 2026-07-03
- [x] coord-chat `/doctor` command + `--doctor` CLI flag (v0.13.0) — davidbalzan/agent-coord-mcp#5 · 2026-07-03
- [x] Delivery tiers + digest batching in the pusher (v0.12.0) — davidbalzan/agent-coord-mcp#4 · 2026-07-03
- [x] Liveness ping/ack — server-side, zero model tokens (v0.11.0) — davidbalzan/agent-coord-mcp#3 · 2026-07-03
- [x] Status-stream recency window (v0.10.1) — davidbalzan/agent-coord-mcp#2 · 2026-07-03
- [x] Self-dependency removed from package.json (direct to main) — davidbalzan/agent-coord-mcp@3bce3ce · 2026-06-12
