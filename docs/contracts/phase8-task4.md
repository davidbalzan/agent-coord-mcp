# CONTRACT — Phase 8 Task 4: role identity & write scopes

**Owner:** `david-worker-2` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`
**Base:** branch `phase8/typed-protocol` @ `721882a`

## Goal

Give roles a stable identity that survives renaming, and make "one writer per file" something
the bus **declares and detects** instead of something convention enforces.

## Scope boundary — read this before planning

The roadmap phrased 4.2/4.3 as "enforce on write". The bus does **not** currently mediate writes
to `docs/QUEUE.md` / `DONE.md` / `WORKSTREAMS.md` — agents edit those with ordinary file tools, so
there is no interception point. Pre-emptive enforcement arrives with Task 5 (work state as data).

So this task delivers, in order of certainty:

1. **Role identity** — fully implementable now.
2. **Record authority** — enforceable now, at the send path, because the server builds every Message.
3. **Document scopes** — *declaration + detection* now; enforcement deferred to Task 5. Do not
   attempt to intercept filesystem writes. Say so in the code comments so the next reader doesn't
   assume the guarantee is stronger than it is.

## Sub-tasks

### 4.1 Stable role identity

`AgentEntry.role` is a free-text string today (`src/tools/shared.ts`, `registry.ts`). Give it a
structured form: a stable `roleId` plus a mutable `displayName`.

- `roleId` is immutable once set; `displayName` is free to change.
- `isGateRunnerRole()` (`hooks/tier.mjs`) must resolve from `roleId`, not from prose matching —
  it currently regex-matches `/\b(qa|quality|coordinator|gate)\b/i` against display text.
- Back-compat: a plain-string `role` still works and maps to `{roleId: <slug>, displayName: <string>}`.
  Existing `agents.json` files must load unmodified.

**Why this exists:** this role has been renamed twice (curator → liaison → aide), each pass churning
500+ occurrences across skills, ids, and scripts, and each time the *identity* was the string.

### 4.2 Record authority

Which roles may emit which `record.type` (Task 1 envelope, `src/tools/shared.ts`):

- `verdict` → gate-runner roles only.
- `go`, `scope` → coordinator roles only (this is the countersignature `classifyTier` already
  trusts by sender id — make it role-derived and keep the sender check).
- everything else → unrestricted.

Enforce in `send_message`, where the server constructs the Message from fixed fields. Reject with
`{ ok: false, error }` matching the identity-binding rejection shape in `src/server.ts`.

**Do not** let this become a trust upgrade: a role is self-declared at `register`/`join` time, so
this is a *consistency* check, not authentication. Comment it as such.

### 4.3 Document scope declaration

A registry of managed documents and their owning role, e.g. `~/agent-coord/scopes.json`:
`{ "docs/QUEUE.md": {"owner": "aide", "mode": "exclusive"}, "docs/DONE.md": {"owner": "coordinator", "mode": "append-only"} }`

- A tool to read it (`list_scopes` or similar) so an agent can ask "may I write this?" before doing so.
- Absent file → everything unowned, no warnings. This must be opt-in.

### 4.4 `doctor` scope-drift check

New check in `src/tools/transport.ts`'s doctor (alongside `stale-pusher-script`,
`wedged-local-pushers`): for each declared document, compare the last writer against the declared
owner, and `warn` on mismatch. Read-only — **not** `fixable`; rewriting someone's file is never a
safe automatic repair.

Deriving "last writer" from git history is acceptable and probably simplest. If the repo isn't a
git checkout, skip the check rather than guessing (mirror how the wedged-pusher check skips when
tmux is absent).

## Boundaries

- **`hooks/tier.mjs` is contested** — `ai-workflow-worker-1` is in it for Task 3. Your only change
  there is `isGateRunnerRole` (4.1). Coordinate before touching anything else in that file.
- **`src/tools/shared.ts` is shared** — you edit the `AgentEntry` region, worker-1 edits the
  `Message` region. Different halves; rebase early and often.
- **Additive only.** An existing `agents.json` must load unchanged, and no required field may
  appear on the wire.
- No transport changes (Phase 9). No work-state datastore (Task 5).

## Done definition

- `npm test` green from the current baseline, with new tests for: string-role back-compat;
  `roleId` immutable while `displayName` changes; gate-runner resolution from `roleId`; each
  record-authority rejection; `doctor` warning on scope drift and skipping cleanly with no
  `scopes.json` and outside a git checkout.
- Existing `agents.json` on this machine loads without migration.
- Commits on your own branch off `721882a`; cite the SHA in your `DONE:` (the base is local-only,
  so there is no PR to open yet).

## Gate

`claude-code`, non-author. 4.2 touches the send path — keep it in its own commit.
