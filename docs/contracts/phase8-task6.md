# CONTRACT — Phase 8 Task 6: records travel structurally

**Owner:** `ai-workflow-worker-1` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`
**Base:** `origin/phase8/typed-protocol` @ `6ed3259` · **Decision:** David, 2026-07-28 — option C

## Goal

Stop multi-line records being delivered as multi-line bodies a parser must reassemble. The pane
gets one attributed line; the full record is retrieved structurally.

You found this limit yourself while gating your own Task 3 output, and you scoped it out correctly
then. It is now yours to close.

## The reasoning that chose C

The 7-line `DAVID_DECISION` layout exists **because the UI had to parse prose**. Now that `record`
is typed, consumers read the field and the text rendering only has to be legible to a human. So
pane rendering stops being a wire format — the same realisation behind demoting tmux in Phase 9,
which makes this task the seam between the phases.

Rejected, and stay rejected: **prefixing every continuation line** (changes rendered output for
record-less multi-line messages, taxing the byte-identical guarantee Tasks 1–4 were built on), and
**folding packets to one line** (preserves the contract, destroys the decision card).

## The trap — read before designing

`hooks/tmux-pusher.mjs` **shares the cursor file with `read_messages`** (see the module header:
*"the agent calling read_messages won't see anything the pusher already delivered"*). So a naive
"pane gets a digest, agent calls `read_messages` for the body" **cannot work** — the pusher has
already advanced the cursor past it, and the agent retrieves nothing.

The codebase already solved this exact shape once. `read_messages` replaces channel overflow with a
compact `history` digest carrying a **hash**, expanded on demand via `retrieve_room_history({hash})`
— content+scope addressed, TTL'd, scoped to the producing agent so a hash can't be replayed to read
a channel the caller never read. `store.ts` HISTORY_DIR / HISTORY_TTL_MS. Task 6 is that pattern
applied to a single multi-line record. **Reuse it; do not invent a second retrieval mechanism.**

## Sub-tasks

### 6.1 One attributed line per message

A record whose rendering spans multiple lines is delivered to the pane as a single `injectLine` —
the existing `[tag HH:MM from]` header plus a one-line digest and a retrieval handle. No line
without a header ever reaches a pane.

### 6.2 Structural retrieval

The recipient can expand the handle into the full typed record. Reuse the history/CCR mechanism
above, including its scoping: a handle must not let an agent read a message that was never
delivered to it.

### 6.3 Record-less messages unchanged — including multi-line

A message with no `record` renders exactly as it does today, **even when its text spans multiple
lines**. Today those arrive unattributed past line 1; that stays true. This task does not fix
hand-typed multi-line messages, and must not change their bytes. `test/tier.test.mjs` already locks
the single-line case and the two `injectLine` bodies byte-identical across both pushers.

### 6.4 The decision card reads the record

The UI's card is fed by the typed `decision` payload, with the prose layout demoted to a
human-readable fallback. Keep `renderRecord`'s byte-exact §Decision Packet Format output — it stays
correct for humans and for any consumer not yet reading records.

## Boundaries

- **Both pushers stay byte-identical** in `injectLine`. The source-level lock enforces it; do not
  weaken that test.
- **Tiering is settled — do not touch `classifyTier`'s floor logic.** Note the interaction: tiering
  reads the stored `text`, not the pane digest, so a digested `DAVID_DECISION:` still tiers urgent.
  Verify that rather than assume it.
- **Additive.** v1 agents and v1 pushers must keep working against a bus carrying records.
- `src/work.ts` and the work tools belong to Task 5 (`david-worker-2`, rebasing now). No overlap
  expected; coordinate through me if that changes.

## Done definition

- `npm test` green from the 145 baseline. **Assert an expected test count** in whatever you add —
  see the queued P2: the suite has twice reported 4 fewer tests with zero failures, so "0 failures"
  alone is not a gate signal.
- New tests for: a multi-line record delivering as one attributed line; the handle expanding to the
  full record; scoping refusing another agent's handle; a record-less multi-line message rendering
  byte-identically; a digested decision still tiering urgent.
- Commits on your own branch off `6ed3259`; cite PR #17.

## Gate

`claude-code`, non-author. I will read 6.3 hardest — the byte-identical guarantee for record-less
messages is what has made every prior Phase 8 task safe to land on a live bus.
