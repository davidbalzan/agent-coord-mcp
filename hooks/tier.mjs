// Pure tier classifier for the pusher's delivery decision. Dependency-free
// and side-effect-free so it can be unit-tested directly and adds no I/O to
// the delivery hot path.
//
// "urgent" = push now (wakes the target agent's model).
// "routine" = queue silently; it rides along as a coalesced digest on the
// next urgent push and stays unread until then.

export function classifyTier(m, opts = {}) {
  if (!m || typeof m.text !== "string") return "routine";
  const text = m.text.trimStart();
  // Control/slash commands are injected raw and must fire immediately.
  if (text.startsWith("/")) return "urgent";
  if (text.startsWith("BLOCKER:")) return "urgent";
  if (text.startsWith("DAVID_DECISION:")) return "urgent";
  // GO-seed: coordinator work orders ("GO:", "GO worker-1: …").
  if (/^GO\b/.test(text)) return "urgent";
  // Countersigned scope change.
  if (/^SCOPE(?: CHANGE)?:/i.test(text)) return "urgent";
  if (text.startsWith("DONE:")) {
    // DONE: is for whoever runs the merge gate. A DM is explicitly addressed,
    // so it always pushes; a room DONE: pushes only to a gate runner.
    if (m.to) return "urgent";
    return opts.gateRunner ? "urgent" : "routine";
  }
  return "routine";
}

// A gate runner is the agent that consumes DONE: reports (QA / coordinator).
// Resolved once at pusher startup from the registry role, with an env
// override in both directions (AGENT_COORD_GATE_RUNNER=1|0).
export function isGateRunnerRole(role) {
  return /\b(qa|quality|coordinator|gate)\b/i.test(role ?? "");
}
