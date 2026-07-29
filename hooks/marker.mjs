// The transport-marker rewrite contract, extracted so it is testable.
//
// The marker has TWO writers with different authority: attach_agent CREATES
// it (authoritative — a fresh attach owns every field, including provenance
// stamps like serverBuildMtime that only the server can know), and the pusher
// REWRITES it at startup (partial — it owns its pid, target, and the
// scriptMtime of the code it actually loaded, and must not touch the rest).
//
// A rewrite that rebuilds the marker from scratch drops every field the other
// writer owns. That is not hypothetical: an earlier from-scratch rewrite
// dropped scriptMtime and silently disabled doctor's stale-pusher-script
// check for every local pusher — a marker field a rewrite can drop is a
// health check that can be switched off by accident.
export function mergeTransportMarker(existing, own) {
  // Spread order IS the contract: fields this writer does not own survive;
  // fields it does own win.
  return { ...(existing && typeof existing === "object" ? existing : {}), ...own };
}
