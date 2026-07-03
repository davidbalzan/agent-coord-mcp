// Pure delivery-tier logic for the pusher. Dependency-free and
// side-effect-free so it can be unit-tested directly and adds no I/O to the
// delivery hot path.
//
// "urgent" = push now (wakes the target agent's model).
// "routine" = queue silently; it rides along as a coalesced digest on the
// next urgent push and stays unread until then.
//
// All prefix checks are case-sensitive: the protocol prefixes are uppercase
// by convention, and a lowercase lookalike is chatter, not a work order.

export function classifyTier(m, opts = {}) {
  if (!m) return "routine";
  // Server-set push-now override (post-/clear reminder). send_message builds
  // Messages from fixed fields, so a peer cannot smuggle this flag in.
  if (m.urgent === true) return "urgent";
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
// Resolved from the registry role, with an env override in both directions
// (AGENT_COORD_GATE_RUNNER=1|0).
export function isGateRunnerRole(role) {
  return /\b(qa|quality|coordinator|gate)\b/i.test(role ?? "");
}

// In-memory routine queue with the push decision. Ingest classified messages;
// returns the batch to deliver (trigger(s) + entire queued routine backlog)
// or null when nothing urgent arrived — the caller then leaves cursors alone
// so the backlog stays unread and cannot be lost.
export class TierQueue {
  constructor() {
    this.routine = [];
  }
  ingest(msgs) {
    const urgent = msgs.filter((m) => m.tier === "urgent");
    this.routine.push(...msgs.filter((m) => m.tier !== "urgent"));
    if (urgent.length === 0) return null;
    const batch = [...urgent, ...this.routine];
    this.routine = [];
    return batch;
  }
  size() {
    return this.routine.length;
  }
}

// The per-message PARSE CONTRACT line. Agent harnesses read from/room/text
// back out of this, so its shape is load-bearing and MUST stay byte-identical
// to coord-pusher.mjs's `injectLine`. Compact form (v0.14.0, salvaged from
// v0.8.10): `  [<kind> <HH:MM> <from>] <text>` where kind drops the leading
// "room " ("room #general" → "#general"), the timestamp is HH:MM UTC, and the
// "from=" label is dropped (bare id). kind/time/from never contain spaces
// (ids are sanitized), so a parser splits on the first "] " unambiguously.
export function injectLine(m) {
  const tag = String(m.kind ?? "").replace(/^room /, "");
  const d = new Date(m.ts ?? 0);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `  [${tag} ${hhmm} ${m.from}] ${m.text ?? ""}`;
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
