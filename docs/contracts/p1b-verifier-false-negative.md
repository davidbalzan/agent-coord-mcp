# CONTRACT — P1b: the submit verifier reports failure on a successful submit

**Owner:** `david-worker-2` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`
**Base:** `origin/main` @ `749e14e` · **Found live by David's own test, 2026-07-28**

## The defect

`/compact` to an idle attached worker **ran**, and the system reported it hadn't:

```
receipt: submitted:false, verified:true,
         "still in the input of pane '%19' after 3 submit attempt(s) — it was typed but did not run"
pane:    * Compacting conversation… (29s)  ▰▰▰▰ 28%
```

This is the inverse of the bug #21 fixed: it used to claim success on failure; it now claims failure
on success. Safer, still wrong, and it has a real cost — a caller acting on `pending` retries, and
the loop had already pressed Enter three times against a command that went through on the first.

## Root cause (diagnosed, verify before trusting it)

`stillInInput` (`hooks/submit.mjs`) squashes the **last `INPUT_TAIL_LINES` of the entire pane** and
asks whether the payload appears anywhere in that window:

```js
const tail = squash(lines.slice(-INPUT_TAIL_LINES).join(" "));
return tail.includes(needle);
```

Claude Code **echoes the submitted command into the transcript**, immediately above the prompt box —
inside that window. So after a successful submit the pane tail still contains `/compact`, and the
verifier concludes it never left the input. It would misfire on essentially every successful submit
into a pane with visible history, which is why worker-2's original repro saw `confirmed`: a freshly
spawned disposable session had an empty scrollback.

## Sub-tasks

1. **Check the input line, not a tail window.** Locate the actual input region (the prompt line —
   `❯` for Claude Code, already env-overridable per the TUI work in #21) and test only that.
   A command echoed into the transcript must not count as "still in the input".
2. **Prove the distinction with a real pane**, not a fixture: an idle pane with a *populated
   scrollback containing the same command text* must verify as submitted. That case is the bug, and
   a fixture with an empty scrollback reproduces the false green.
3. **Bound the retries.** The loop re-sends Enter on a command that already submitted. Extra Enters
   on an empty prompt are mostly harmless, but they are keystrokes into someone else's live session
   — if the human has since typed, they submit that. Decide and state whether a retry should
   re-verify before re-sending.
4. **Unknown must stay unknown.** `pollUntilGone` returning `null` (capture failed) must keep
   reporting the "could not capture" reason, distinct from a confirmed non-submit.

## Boundaries

- The decline paths are CORRECT and verified live — busy pane declined after 15s with nothing
  pasted, draft refused with the draft intact. **Do not touch them.** They pass precisely because
  they return before pasting and never reach the verifier.
- Do not "fix" this by weakening verification back to assume-success. The whole point of #21 is
  that a receipt must not claim what it has not observed.
- No changes to `classifyTier`, records, or delivery tiering.

## Done definition

- `npm test` green with `EXPECTED_TESTS` bumped in the same commit.
- A test that fails against the current `stillInInput`: pane text containing the command in
  scrollback AND an empty input line must report submitted.
- A live repro account against a real TUI with non-empty scrollback: what you saw before and after.
- Own branch off `origin/main`, own PR.

## Also yours, same PR if you like — the one-liner you flagged

`scripts/check-test-count.mjs` compares `# tests`, which read the full 186 during the reporter-gap
sighting (186 tests / 182 pass / 0 fail). Comparing **pass** is the fix you identified. Take it here
rather than opening a third PR.

## Gate

`claude-code`, non-author, from a standalone clone. I will re-run the same three live tests against
an attached worker — that is what found this, and a green suite is not what convinces me.
