# CONTRACT — Phase 8 Task 5: work state as data

**Owner:** `david-worker-2` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`
**Base:** `origin/phase8/typed-protocol` (pushed — fetch it; PR #17 is open against main)

## Goal

Move the queue / done / board from exact-glyph markdown into the store, while keeping the markdown
as a first-class export. The goal is to stop *parsing* markdown, not to stop *having* it.

## Why this exists

`docs/QUEUE.md` and `docs/DONE.md` are parsed with a contract requiring exact `U+2014` (em dash)
and `U+00B7` (middle dot). A parser once returned **zero items** on the real file while passing
every synthetic test, and the UI rendered an empty panel — silently, not as an error. Markdown was
chosen for good reasons that still hold: David edits the files directly, git diffs them, they are
greppable and reviewable. Those reasons argue for markdown as an *interface*, not as a *datastore*.

## Sub-tasks

### 5.1 Records in the store

Queue items, done entries, and board rows as typed records alongside the rest of the Phase 8
envelope. Minimum fields, taken from what the current parser extracts:

- queue item: `{id, priority: "P1"|"P2"|"P3", text, done: boolean}`
- done entry: `{id, text, ref, date}` — `ref` and `date` are separately parsed today, so they must
  be separate fields, not reassembled from a string
- board row: whatever `WORKSTREAMS.md` genuinely carries; read it before designing

### 5.2 Markdown export

Emit `QUEUE.md` / `DONE.md` from records, reproducing the current glyph contract exactly: the ref
splits on the **last** ` — ` (space + U+2014 + space) and the date is a trailing ` · YYYY-MM-DD`
(space + U+00B7 + space). Preserve `### Subsection` grouping, the `# QUEUE — <project>` title, and
the `## Queue` / `## Done` headers.

### 5.3 Import

Read the existing files into records. Must handle the legacy single-`docs/BACKLOG.md` layout with
`## Queue` / `## Done` regions, since the file precedence rule (split files win, else legacy) is
already documented behaviour.

### 5.4 Round-trip test

`import → export` byte-identical on **this repo's real `docs/QUEUE.md` and `docs/DONE.md`**, not on
fixtures. Fixtures are what let the original parser bug ship. Include the cross-project section and
the non-item prose — anything the parser ignores must survive the round trip untouched.

## Boundaries

- **Markdown stays authoritative until the UI reads records.** Export is the source of truth for
  consumers; if the store is deleted, the markdown must still stand alone. State this in code.
- **No pre-emptive write enforcement yet.** Task 4 deliberately delivered document scopes as
  declaration + `doctor` detection. If this task creates a real interception point, say so in your
  report — it changes what Task 4 promised — but do not silently start rejecting writes.
- **Do not touch rendering or delivery.** Task 6 (records travel structurally) owns that and is
  not yet assigned. `injectLine`, `formatBatch`, and both pushers are out of bounds.
- **Additive.** No required field on the wire; v1 agents unaffected.

## Done definition

- `npm test` green from the 142 baseline, with new tests for: each record shape; export matching
  the glyph contract exactly; legacy `BACKLOG.md` import; and the real-file round trip from 5.4.
- Deleting the store files leaves the markdown working standalone — tested, not asserted.
- Commits on your own branch off `origin/phase8/typed-protocol`; PR #17 is open, so you may now
  cite a PR rather than a bare SHA.

## Gate

`claude-code`, non-author. The round-trip test is the one I will read hardest — a green suite over
fixtures is exactly the shape of the bug this task exists to delete.
