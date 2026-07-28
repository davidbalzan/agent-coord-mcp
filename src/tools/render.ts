// Typed record → the text layout the fleet already reads (Phase 8 Task 3.3).
//
// Every consumer downstream of a message — hooks/tier.mjs's prefix table, the
// UI's alert parser, a human reading a tmux pane — reads `text`. Phase 8 adds
// `record` alongside it, so the rendering must reproduce the byte layout those
// consumers already expect. Nothing downstream changes while agents migrate.
//
// This is a pure function of the record: no clock, no I/O, no registry. It
// never sees `from`, `to`, or anything the sender could use it to forge.

import type { DecisionPayload, MessageRecord, SummaryPayload, VerdictPayload } from "./shared.js";

// The case-sensitive prefixes at byte 0 of `text`, exactly as classifyTier
// matches them. `decision` is absent because it renders as a multi-line block,
// not a one-liner.
const PREFIX: Record<string, string> = {
  blocker: "BLOCKER",
  risk: "RISK",
  done: "DONE",
  fyi: "FYI",
  action: "AGENT_ACTION",
  go: "GO",
  scope: "SCOPE CHANGE",
  // `verdict` has no prefix in the v1 vocabulary — it is new in Phase 8. A gate
  // PASS/FAIL was previously posted as prose, which is why verdicts could not
  // be routed. Rendering it under its own prefix gives it one.
  verdict: "VERDICT",
};

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// The playbook's decision packet (§Decision Packet Format), byte-for-byte —
// the UI parses this into a clickable decision card, and a layout that drifts
// still alerts loudly but loses the card. Returns null when any of the five
// fields is missing, so the caller can reject rather than emit a half packet.
function renderDecision(p: DecisionPayload): string | null {
  if (!isNonEmpty(p.title) || !isNonEmpty(p.context)) return null;
  if (!isNonEmpty(p.recommendation) || !isNonEmpty(p.ifNoAction)) return null;
  if (!Array.isArray(p.options) || p.options.length === 0) return null;
  if (!p.options.every(isNonEmpty)) return null;
  return [
    `DAVID_DECISION: ${p.title}`,
    `Context: ${p.context}`,
    "Options:",
    ...p.options.map((o, i) => `${i + 1}. ${o}`),
    `Recommendation: ${p.recommendation}`,
    `If no action: ${p.ifNoAction}`,
  ].join("\n");
}

// `VERDICT: PASS <sha> — <notes>`. The sha is not optional in the rendering:
// a verdict that doesn't name the commit it was issued against is
// unfalsifiable the moment the branch moves.
function renderVerdict(p: VerdictPayload): string | null {
  if (p.result !== "pass" && p.result !== "fail") return null;
  if (!isNonEmpty(p.headRefOid)) return null;
  const head = `${PREFIX.verdict}: ${p.result.toUpperCase()} ${p.headRefOid}`;
  return isNonEmpty(p.notes) ? `${head} — ${p.notes}` : head;
}

// Render a record to its text form, or null when the payload can't support one
// (absent, or missing a field the layout needs). Null is not an error here —
// the caller decides whether a record without a rendering is fatal, and it only
// is when there's no author-supplied `text` to fall back on.
export function renderRecord(record: MessageRecord): string | null {
  if (!record || typeof record.type !== "string") return null;
  const payload = record.payload as unknown;
  if (payload === undefined || payload === null) return null;
  if (typeof payload !== "object" || Array.isArray(payload)) return null;

  if (record.type === "decision") return renderDecision(payload as DecisionPayload);
  if (record.type === "verdict") return renderVerdict(payload as VerdictPayload);

  const prefix = PREFIX[record.type];
  if (!prefix) return null;
  const { summary } = payload as SummaryPayload;
  return isNonEmpty(summary) ? `${prefix}: ${summary}` : null;
}
