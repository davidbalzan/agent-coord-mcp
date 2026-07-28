// Pure delivery-tier logic for the pusher. Side-effect-free, and its only
// import (./roles.mjs) is equally pure — so it can be unit-tested directly and
// adds no I/O to the delivery hot path.
//
// "urgent" = push now (wakes the target agent's model).
// "routine" = queue silently; it rides along as a coalesced digest on the
// next urgent push and stays unread until then.
//
// All prefix checks are case-sensitive: the protocol prefixes are uppercase
// by convention, and a lowercase lookalike is chatter, not a work order.

import { isGateRunner } from "./roles.mjs";

// Typed protocol record → tier (Phase 8). The prefix table below is the same
// vocabulary parsed out of text; reading the field instead removes the parse
// entirely, so a body that leads with a greeting no longer downgrades a
// blocker to routine.
//
// TRUST: `record` is caller-supplied, exactly like `from`. A typed record may
// therefore assert what a text prefix could already assert, and NOTHING more —
// `scope` resolves the sender against trustedSenders and `done` depends on the
// RECIPIENT being a gate runner, exactly as the prefix path does. `go` is
// unconditionally urgent here because literal "GO:" is unconditionally urgent
// in the prefix path too; do NOT "fix" that asymmetry by gating go, and do not
// ungate scope to match go — each mirrors its v1 prefix, which is the whole
// invariant. Typed is not authenticated: anything that would let a peer
// self-declare urgency belongs in the server-set `urgent` flag, not here.
function tierFromRecord(rec, m, opts) {
  switch (rec.type) {
    case "blocker":
    case "decision":
      return "urgent";
    case "go":
      return "urgent";
    case "scope":
      return opts.trustedSenders?.has?.(m.from) ? "urgent" : "routine";
    case "done":
      return opts.gateRunner ? "urgent" : "routine";
    // risk / fyi / action / verdict: real semantics, but not a reason to
    // interrupt someone else's turn. A risk that genuinely needs an immediate
    // turn is a blocker — that judgement stays with the sender.
    default:
      return "routine";
  }
}

export function classifyTier(m, opts = {}) {
  if (!m) return "routine";
  // Server-set push-now override (post-/clear reminder). send_message builds
  // Messages from fixed fields, so a peer cannot smuggle this flag in.
  if (m.urgent === true) return "urgent";
  // DMs are always push-now: they're addressed to this agent by a peer who
  // wants it specifically, and DM volume is tiny next to room traffic. The
  // tiers exist to absorb broadcast noise, not point-to-point asks (the
  // liaison relaying a David question must not sit in a digest queue).
  //
  // `tag`, not `kind`: this is the pushers' synthetic channel tag ("DM" /
  // "room #general"), set on their own copy of the message. It used to be
  // called `kind`, which collided with the stored Message.kind (retention
  // weight, "decision"/"status"/"chatter") — a room post tagged
  // kind:"decision" overwrote the channel tag and rendered as `[decision …]`.
  // The tag is process-local and never persisted, so it was the safe half of
  // the collision to rename; Message.kind is on disk in every JSONL file.
  // NOTE: this returns before the record is read, so a DM can never be
  // downgraded by one. The floor rule below makes that moot, but the ordering
  // is load-bearing if anyone reintroduces a record-first branch.
  if (m.tag === "DM") return "urgent";
  // The record is a FLOOR, not an override: it can raise the tier, never lower
  // it. An earlier version let the record win outright, on the argument that
  // Task 3 renders text from the record so the two agree by construction. That
  // is false when BOTH are supplied — contract 3.3 makes the author's `text`
  // win for rendering, so `{text:"BLOCKER: prod down", record:{type:"fyi"}}`
  // displayed a BLOCKER in the pane and delivered it routine, with the reader
  // unable to see why (`record` is never rendered). That is a REGRESSION IN A
  // SAFETY PROPERTY: in v1, "BLOCKER:" at byte 0 always woke the pane. The
  // trigger is ordinary relay, not malice — an aide forwarding a worker's body
  // under its own `fyi` would silently bury that worker's blocker.
  //
  // max() is not the two-overridable-sources design this phase exists to
  // delete: it is monotone, so there is nothing to disagree about, only a
  // higher claim winning. It also fails safe on an UNKNOWN future record type,
  // which hits the routine default — an old pusher meeting a new vocabulary
  // must not bury a "BLOCKER:" body. The one legitimate downgrade, quoting a
  // blocker mid-body, is already handled by the byte-0 rule.
  // Found by ai-workflow-worker-1 gating 721882a.
  if (m.record && typeof m.record.type === "string") {
    if (tierFromRecord(m.record, m, opts) === "urgent") return "urgent";
  }
  if (typeof m.text !== "string") return "routine";
  const text = m.text.trimStart();
  // Control/slash commands are injected raw and must fire immediately.
  if (text.startsWith("/")) return "urgent";
  if (text.startsWith("BLOCKER:")) return "urgent";
  if (text.startsWith("DAVID_DECISION:")) return "urgent";
  // GO-seed work orders. Literal "GO:" only — /^GO\b/ over-matched prose
  // like "GO ahead…".
  if (text.startsWith("GO:")) return "urgent";
  // Countersigned scope change — only honored from a trusted sender
  // (coordinator/gate ids), since `from` is otherwise unauthenticated.
  if (/^SCOPE(?: CHANGE)?:/.test(text)) {
    return opts.trustedSenders?.has?.(m.from) ? "urgent" : "routine";
  }
  // DONE: is for whoever runs the merge gate (QA/coordinator) — nobody else,
  // DM or room alike.
  if (text.startsWith("DONE:")) return opts.gateRunner ? "urgent" : "routine";
  return "routine";
}

// Tier with the enable switch applied — AGENT_COORD_TIERS=0 restores legacy
// push-everything.
export function effectiveTier(m, opts = {}) {
  return opts.enabled === false ? "urgent" : classifyTier(m, opts);
}

// A gate runner is the agent that consumes DONE: reports (QA / coordinator).
// Resolved from the registry role's frozen `roleId` (Phase 8 Task 4) rather
// than by regex-matching display prose, so renaming the role does not change
// who runs the gate. Registry entries with no declared roleId fall back to the
// legacy word match — see roleMatches in roles.mjs. Env override in both
// directions (AGENT_COORD_GATE_RUNNER=1|0) is applied by the caller.
//
// Accepts a plain string or a whole registry entry ({role, roleId}); pass the
// entry when you have it, or the id is lost.
export function isGateRunnerRole(role) {
  return isGateRunner(role);
}

// In-memory routine queue with the push decision. Ingest classified messages;
// returns the batch to deliver (trigger(s) + entire queued routine backlog)
// or null when nothing urgent arrived — the caller then leaves cursors alone
// so the backlog stays unread and cannot be lost.
//
// maxAgeMs bounds how long routine traffic can sit without an urgent trigger:
// once the OLDEST queued message exceeds it, flushOverdue() drains the whole
// backlog as a routine-only digest. 0 (default) disables age-based flushing.
// Callers pass `now` explicitly so the class stays clock-free and testable.
export class TierQueue {
  constructor(opts = {}) {
    this.routine = [];
    this.maxAgeMs = opts.maxAgeMs ?? 0;
    this.oldestAt = null;
  }
  ingest(msgs, now = 0) {
    const urgent = msgs.filter((m) => m.tier === "urgent");
    const routine = msgs.filter((m) => m.tier !== "urgent");
    if (routine.length > 0 && this.oldestAt === null) this.oldestAt = now;
    this.routine.push(...routine);
    if (urgent.length === 0) return null;
    const batch = [...urgent, ...this.routine];
    this.routine = [];
    this.oldestAt = null;
    return batch;
  }
  // Drain the backlog when its oldest entry has waited past maxAgeMs.
  // Returns the routine-only batch to deliver, or null if nothing is overdue.
  flushOverdue(now) {
    if (this.maxAgeMs <= 0 || this.oldestAt === null) return null;
    if (now - this.oldestAt < this.maxAgeMs) return null;
    const batch = this.routine;
    this.routine = [];
    this.oldestAt = null;
    return batch.length > 0 ? batch : null;
  }
  size() {
    return this.routine.length;
  }
}

// The per-message PARSE CONTRACT line. Agent harnesses read from/room/text
// back out of this, so its shape is load-bearing and MUST stay byte-identical
// to coord-pusher.mjs's `injectLine`. Compact form (v0.14.0, salvaged from
// v0.8.10): `  [<tag> <HH:MM> <from>] <text>` where tag drops the leading
// "room " ("room #general" → "#general"), the timestamp is HH:MM UTC, and the
// "from=" label is dropped (bare id). tag/time/from never contain spaces
// (ids are sanitized), so a parser splits on the first "] " unambiguously.
export function injectLine(m) {
  const tag = String(m.tag ?? "").replace(/^room /, "");
  const d = new Date(m.ts ?? 0);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  let text = m.text ?? "";
  // Phase 8 Task 6: a TYPED record whose rendering spans lines is delivered as
  // ONE attributed line — first line, a count of what was withheld, and the
  // message id as the retrieval handle. Continuation lines used to arrive bare,
  // with no `[tag HH:MM from]` header, so a parser could not attribute them.
  //
  // The handle is the message id, NOT a stashed copy: the full record is
  // already persisted in rooms/<chan>.jsonl or inbox/<id>.jsonl, and
  // retrieve_message reads it back by id (falling through to the append-only
  // archive if compaction moved it). A cache would have had a TTL and lost the
  // record permanently on expiry.
  //
  // Gated on `m.record`: a record-LESS multi-line message is untouched and
  // still arrives unattributed past line 1, exactly as today. Task 6 does not
  // fix hand-typed multi-line messages, and must not change their bytes.
  const nl = text.indexOf("\n");
  if (nl !== -1 && m.record && typeof m.record.type === "string" && m.id) {
    const held = text.split("\n").length - 1;
    text = `${text.slice(0, nl)} [+${held} lines · record:${m.record.type} · retrieve_message id=${m.id}]`;
  }
  return `  [${tag} ${hhmm} ${m.from}] ${text}`;
}

// Render one delivery: urgent verbatim under the banner, then at most ONE
// coalesced digest block carrying the queued routine messages.
export function formatBatch(batch) {
  const urgent = batch.filter((m) => m.tier !== "routine");
  const routine = batch.filter((m) => m.tier === "routine");
  const lines = [];
  if (urgent.length > 0) {
    lines.push("[agent-coord] msgs (pre-consumed, don't re-read):");
    for (const m of urgent) lines.push(injectLine(m));
  }
  if (routine.length > 0) {
    lines.push(`[agent-coord] +${routine.length} routine (pre-consumed, FYI, no reply):`);
    for (const m of routine) lines.push(injectLine(m));
  }
  return lines.join("\n");
}
