# CONTRACT — Phase 8 Task 3: decision payloads, citations, `kind` rename

**Owner:** `ai-workflow-worker-1` · **Gate:** `claude-code` (non-author) · **Repo:** `agent-coord-mcp`

## Goal

Pin the per-type payload shapes on the Phase 8 message envelope, enforce citations on `done`,
render typed records into the text layout today's UI already parses, and resolve the `kind`
name collision.

## Landed already (read first — do not redo)

- `MessageRecord { type, payload?, cites? }` + `Citation` — `src/tools/shared.ts:79-118`
- `messageRecordSchema` + wiring through both send paths — `src/tools/messaging.ts:72-110`
- Regression locks — `test/tier.test.mjs` (record-less rendering byte-identical; spread-order)

## Sub-tasks

### 3.1 Per-type payload shapes

Replace the open `payload?: Record<string, unknown>` with a discriminated union, keeping the
envelope itself unchanged. Minimum shapes:

- `decision` → `{ title, context, options: string[], recommendation, ifNoAction }`
  (the five fields of the playbook's decision packet, §Decision Packet Format)
- `done` → `{ summary }` + **required** `cites` containing at least one `{kind:"pr"}`
- `verdict` → `{ result: "pass"|"fail", headRefOid, notes? }`
- `go` / `scope` → `{ summary }`
- `blocker` / `risk` / `fyi` / `action` → `{ summary }`

Unknown-but-well-formed payloads must not hard-fail a send — reject only what's structurally
wrong for a claimed type. A v1 sender omitting `record` entirely is always valid.

### 3.2 Citation enforcement on `done`

`send_message` rejects a `record.type === "done"` with no `pr` citation. Error shape mirrors the
existing identity-binding rejection (`src/server.ts`, "identity bound to 'X'…") — a plain
`{ ok: false, error }`, not a throw.

**Do not** resolve the ref against `gh` here; that's a consumer's job. Enforce presence and shape
only — no network calls in the send path.

### 3.3 Typed → text renderer

A record must render to the byte layout the current UI parser expects, so nothing downstream
breaks while agents migrate:

- `decision` → the exact `DAVID_DECISION: …` block in playbook §Decision Packet Format
- everything else → `<PREFIX>: <summary>` using the existing uppercase prefixes

When a caller supplies both `text` and `record`, **`text` wins** — never overwrite a human's
wording. Render only to *fill* an absent `text`.

### 3.4 Resolve the `kind` collision

`Message.kind` (`"decision"|"status"|"chatter"`, retention weight) collides by name with the
pushers' synthetic channel tag (`"DM"`/`"room #general"`) read by `injectLine`/`classifyTier`.
This shipped as a real bug (fixed in `hooks/tmux-pusher.mjs:237,262`, `scripts/coord-pusher.mjs:323`).

Rename the **pusher-side** field to `tag` — it is process-local and never persisted, so it costs
no migration; the stored `Message.kind` is on disk in every JSONL file and must not move.
Update `injectLine`, `classifyTier` (`m.kind === "DM"` → `m.tag === "DM"`), both pushers, and
their tests. Keep the two `injectLine` bodies byte-identical — `test/tier.test.mjs` asserts it.

## Boundaries

- **Do NOT touch `classifyTier`'s tier logic** beyond the `kind`→`tag` rename — reading
  `record.type` is Task 2, owned by `claude-code`. Conflicts here are expensive.
- **Do NOT change rendered output for record-less messages.** Locked by test; a diff there is a
  failed gate, not a judgement call.
- **Additive only.** No required field may appear on the wire. v1 and v2 agents share a bus.
- `record` is **caller-supplied and untrusted** — never let it set `urgent`, and never let
  `record.type` alone confer trust (sender still resolves against the registry).
- No changes to transport, `attach_agent`, or anything under Phase 9.

## Done definition

- `npm test` green, with new tests for: each payload shape accepted/rejected; `done` without a PR
  cite rejected; renderer output matching the packet layout byte-for-byte; `text` winning over a
  rendered record; the `kind`→`tag` rename across both pushers.
- A record-less message still renders byte-identically (existing locks pass untouched).
- One PR against `main`, and a `DONE:` citing it (`owner/repo#N`).

## Gate

`claude-code` reviews as non-author. High-risk surface: 3.4 touches the delivery hot path — that
part gets read line-by-line, so keep it in its own commit for reviewability.
