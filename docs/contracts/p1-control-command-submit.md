# CONTRACT — P1: `/clear` and `/compact` land in the pane but are not submitted

**Owner:** `david-worker-2` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`
**Base:** `origin/phase8/typed-protocol` @ `4f87e24` (186 tests) · **Reported by David, live**

## The defect

Control commands reach the target pane and sit there unsubmitted. David hit this on the real bus.

`hooks/tmux-pusher.mjs` `pasteAndSubmit`: control commands paste **raw** (unbracketed), then it waits
a hardcoded **100ms**, sends `Enter`, waits **50ms**, sends a second `Enter`. Nothing observes the
result. `scripts/coord-pusher.mjs` carries the same pipeline — **fix both or the remote path keeps
the bug.**

**Ruled out already, don't redo it:** the tmux primitives are fine. `load-buffer` → `paste-buffer -d`
→ `send-keys Enter` ×2 submits correctly in a scratch pane. The failure is in how a real agent TUI
handles a slash command against two fixed delays — most likely a race with the autocomplete menu,
which the delays neither wait for nor detect.

## The deeper half

The delivery receipt is stamped when the pusher **pastes**. So `send_command` can return
`delivery:"confirmed"` for a command that never executed — proof of typing sold as proof of
execution. That is the third instance today of a check that cannot fail loudly (the others: a
stale-pusher check disabled by its own subject, and a test suite reporting fewer tests with zero
failures). **A timing fix alone leaves the lie in place.** Both halves are in scope.

## Why this path is structurally fragile — do not "fix" it by bracketing

Ordinary peer messages paste bracketed (`paste-buffer -p`), which makes embedded newlines inert.
Control commands **must** go raw or the TUI treats them as literal text instead of running them. So
this is the one delivery path with no protection, by necessity. Any proposal that brackets control
commands is wrong.

## Sub-tasks

1. **Tunable timing.** `AGENT_COORD_ENTER_DELAY_MS` / `AGENT_COORD_ENTER_GAP_MS`, defaults raised
   from 100/50 to something defensible. Say in a comment why the chosen numbers, not just what.
2. **Verify submission, don't assume it.** After the Enters, confirm via `capture-pane` that the
   command actually left the input. This must not block the delivery hot path or spin — bound it.
3. **Truthful receipts.** An unverified submission reports `delivery:"pending"` with a reason, never
   `"confirmed"`. `send_command`'s existing caller contract (`waitForDelivery`, `deliveryTimeoutMs`)
   keeps working.
4. **Both pushers**, with the shared logic factored so they cannot drift — the `injectLine`
   byte-identity lock is the precedent for how that is held.

## Testing — the hard part, and the acceptance bar

A shell is **not** a sufficient proxy. My scratch-pane test passed while the real bug was live; that
is exactly how this shipped. Reproduce against a **real agent TUI**.

**Do not send `/clear` or `/compact` to any registered agent on the live bus.** It would wipe a
peer's context. Spawn your own disposable session in your own tmux window and target that.

State plainly in your report what you could and could not reproduce. "Tests pass" is not evidence
here — the tests passed before, too.

## Boundaries

- `classifyTier`, `injectLine`, `formatBatch`, and record/digest logic are settled. Control commands
  bypass tiering (`text.startsWith("/")` → urgent); leave that alone.
- Additive: no change to `send_command`'s tool signature or to how a compliant caller uses it.
- If the honest fix needs a behaviour change David should rule on — e.g. control delivery becoming
  slower, or failing loudly where it used to claim success — flag it, don't decide it.

## Done definition

- `npm test` green with `EXPECTED_TESTS` bumped in the same commit.
- Tests for: the tunables taking effect, a verified submission reporting `confirmed`, an unverified
  one reporting `pending` with a reason, and both pushers sharing one implementation.
- A written repro account: what you ran it against, what you saw before and after.
- Push your branch; cite PR #17.

## Gate

`claude-code`, non-author, from a standalone clone of the pushed ref. I will not accept this on
tests alone — I want the repro account, because the failure mode is "everything looks confirmed."
