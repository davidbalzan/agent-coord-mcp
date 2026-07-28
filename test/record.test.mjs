// Phase 8 Task 3: per-type payload shapes, citation enforcement on `done`, and
// the typed→text renderer. Throwaway state dir per file (see tools.test.mjs for
// the env-before-import rationale).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-record-test-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const { messageRecordSchema, sendMessageTool } = await import("../dist/tools/messaging.js");
const { renderRecord } = await import("../dist/tools/render.js");
const { registerTool } = await import("../dist/tools/registry.js");
store.ensureDirs();

// Sender 'a' is a coordinator: `go`/`scope` are coordinator-only at the send
// path (Task 4 record authority), and this file is about citations and
// rendering, not about who may emit what.
await registerTool({ agentId: "a", role: { roleId: "coordinator" } });

after(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (rec) => messageRecordSchema.safeParse(rec).success;

const DECISION = {
  title: "publish v0.17.0 to npm",
  context: "tag exists, npm latest is 3 versions behind",
  options: ["publish now", "hold for the pusher restart"],
  recommendation: "publish now — the restart is independent",
  ifNoAction: "consumers stay on 0.13.0",
};

// ---------- 3.1 per-type payload shapes ----------

test("a record-less send is always valid (v1 senders unaffected)", async () => {
  const r = await sendMessageTool({ from: "a", to: "b", text: "plain v1 message" });
  assert.equal(r.ok, true);
});

test("payload is optional on every arm — no new required field on the wire", () => {
  for (const type of ["blocker", "risk", "fyi", "action", "go", "scope", "decision", "verdict", "done"]) {
    assert.ok(ok({ type }), `${type} must accept a bare record`);
  }
});

test("summary types accept {summary} and reject a malformed one", () => {
  for (const type of ["blocker", "risk", "fyi", "action", "go", "scope", "done"]) {
    assert.ok(ok({ type, payload: { summary: "one line" } }), type);
    assert.ok(!ok({ type, payload: { summary: "" } }), `${type}: empty summary`);
    assert.ok(!ok({ type, payload: { summary: 42 } }), `${type}: non-string summary`);
  }
});

test("decision requires all five packet fields or none — not a partial", () => {
  assert.ok(ok({ type: "decision", payload: DECISION }));
  for (const missing of Object.keys(DECISION)) {
    const partial = { ...DECISION };
    delete partial[missing];
    assert.ok(
      !ok({ type: "decision", payload: partial }),
      `decision missing ${missing} must be rejected — a truncated packet is worse than none`,
    );
  }
  assert.ok(!ok({ type: "decision", payload: { ...DECISION, options: [] } }), "empty options");
  assert.ok(!ok({ type: "decision", payload: { ...DECISION, options: "a" } }), "options must be a list");
});

test("verdict pins result and the sha it was issued against", () => {
  assert.ok(ok({ type: "verdict", payload: { result: "pass", headRefOid: "a7f4471" } }));
  assert.ok(ok({ type: "verdict", payload: { result: "fail", headRefOid: "a7f4471", notes: "2 red" } }));
  assert.ok(!ok({ type: "verdict", payload: { result: "maybe", headRefOid: "a7f4471" } }));
  assert.ok(!ok({ type: "verdict", payload: { result: "pass" } }), "a verdict with no sha is unfalsifiable");
});

test("an unknown type is rejected; unknown payload KEYS ride through", () => {
  assert.ok(!ok({ type: "gossip", payload: { summary: "x" } }));
  // A v3 sender's extra keys must survive rather than being silently stripped.
  const parsed = messageRecordSchema.safeParse({
    type: "fyi",
    payload: { summary: "hi", v3Field: { nested: true } },
  });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.payload.v3Field, { nested: true });
});

test("a wrong-shaped payload for a claimed type is rejected, not coerced", () => {
  // decision's shape must not be accepted under a summary type, and vice versa.
  assert.ok(!ok({ type: "fyi", payload: DECISION }), "decision packet under fyi has no summary");
  assert.ok(!ok({ type: "decision", payload: { summary: "not a packet" } }));
});

// ---------- 3.2 citation enforcement on `done` ----------

test("a done record without a pr citation is rejected as a value, not a throw", async () => {
  const r = await sendMessageTool({
    from: "a",
    to: "b",
    text: "DONE: shipped it",
    record: { type: "done", payload: { summary: "shipped it" } },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /pr/);
});

test("done rejects citations that are not a pr, and empty refs", async () => {
  const send = (cites) =>
    sendMessageTool({ from: "a", to: "b", text: "DONE: x", record: { type: "done", cites } });
  assert.equal((await send([{ kind: "commit", ref: "a7f4471" }])).ok, false);
  assert.equal((await send([{ kind: "url", ref: "https://example.com" }])).ok, false);
  assert.equal((await send([{ kind: "pr", ref: "   " }])).ok, false, "whitespace ref is not a citation");
  assert.equal((await send([{ kind: "pr", ref: "owner/repo#7" }])).ok, true);
});

test("only `done` requires a citation — other types send uncited", async () => {
  for (const type of ["blocker", "risk", "fyi", "action", "go", "scope"]) {
    const r = await sendMessageTool({ from: "a", to: "b", text: `${type} msg`, record: { type } });
    assert.equal(r.ok, true, type);
  }
});

test("the send path makes no network call to resolve a ref", async () => {
  // Presence and shape only: a PR that cannot exist is still accepted here,
  // because resolving it is a consumer's job (and the gate's).
  const r = await sendMessageTool({
    from: "a",
    to: "b",
    text: "DONE: x",
    record: { type: "done", cites: [{ kind: "pr", ref: "no/such#999999" }] },
  });
  assert.equal(r.ok, true);
});

// ---------- 3.3 typed → text renderer ----------

test("decision renders the playbook packet layout byte-for-byte", () => {
  assert.equal(
    renderRecord({ type: "decision", payload: DECISION }),
    [
      "DAVID_DECISION: publish v0.17.0 to npm",
      "Context: tag exists, npm latest is 3 versions behind",
      "Options:",
      "1. publish now",
      "2. hold for the pusher restart",
      "Recommendation: publish now — the restart is independent",
      "If no action: consumers stay on 0.13.0",
    ].join("\n"),
  );
});

test("summary types render as <PREFIX>: <summary> with the existing prefixes", () => {
  const cases = {
    blocker: "BLOCKER: db down",
    risk: "RISK: flaky test",
    done: "DONE: merged",
    fyi: "FYI: docs updated",
    action: "AGENT_ACTION: rebasing",
    go: "GO: start the slice",
    scope: "SCOPE CHANGE: widen to hooks/",
  };
  for (const [type, expected] of Object.entries(cases)) {
    const summary = expected.slice(expected.indexOf(": ") + 2);
    assert.equal(renderRecord({ type, payload: { summary } }), expected);
  }
});

test("rendered prefixes are exactly what classifyTier matches", async () => {
  // The whole point of rendering: the text a record produces must tier the
  // same as the prose a v1 agent would have typed by hand.
  const { classifyTier } = await import("../hooks/tier.mjs");
  for (const type of ["blocker", "decision", "go"]) {
    const payload = type === "decision" ? DECISION : { summary: "x" };
    const text = renderRecord({ type, payload });
    assert.equal(classifyTier({ tag: "room #proj", from: "peer", text }), "urgent", type);
  }
});

test("verdict renders under its own prefix, sha included", () => {
  assert.equal(
    renderRecord({ type: "verdict", payload: { result: "pass", headRefOid: "a7f4471" } }),
    "VERDICT: PASS a7f4471",
  );
  assert.equal(
    renderRecord({ type: "verdict", payload: { result: "fail", headRefOid: "a7f4471", notes: "2 red" } }),
    "VERDICT: FAIL a7f4471 — 2 red",
  );
});

test("KNOWN LIMIT: a rendered decision packet spans the single-line parse contract", async () => {
  // Documented, not fixed. injectLine emits ONE header per message
  // (`  [tag HH:MM from] <text>`), and the decision packet is deliberately
  // multi-line — the contract requires reproducing the playbook layout
  // byte-for-byte, because the UI parses it into a decision card.
  //
  // So only the first line carries a header; the other six arrive bare. This
  // is pre-existing (a human typing a packet into send_message has always
  // produced it) but 3.3 makes it machine-generated and routine. Indenting
  // continuation lines would fix it and is explicitly out of scope: it would
  // change rendered output for record-less multi-line messages, which the
  // Task 3 contract forbids. Raised to the coordinator as a RISK.
  const { injectLine } = await import("../hooks/tier.mjs");
  const text = renderRecord({ type: "decision", payload: DECISION });
  const out = injectLine({ tag: "DM", from: "coord", ts: 0, text });
  const lines = out.split("\n");
  const header = /^ {2}\[(\S+) (\d{2}:\d{2}) (\S+)\] (.*)$/;
  assert.equal(lines.length, 7);
  assert.ok(header.test(lines[0]), "first line carries the header");
  assert.ok(
    lines.slice(1).every((l) => !header.test(l)),
    "continuation lines are bare — a parser cannot attribute them",
  );
});

test("an unrenderable record yields null rather than a half-rendered line", () => {
  assert.equal(renderRecord({ type: "fyi" }), null);
  assert.equal(renderRecord({ type: "decision", payload: { title: "only a title" } }), null);
  assert.equal(renderRecord({ type: "verdict", payload: { result: "pass" } }), null);
});

// ---------- 3.3 text wins ----------

test("a caller's text is never overwritten by a rendered record", async () => {
  const r = await sendMessageTool({
    from: "a",
    to: "text-wins",
    text: "BLOCKER: my own wording, kept verbatim",
    record: { type: "blocker", payload: { summary: "generated wording" } },
  });
  assert.equal(r.ok, true);
  const [msg] = await store.readJsonl(store.inboxFile("text-wins"));
  assert.equal(msg.text, "BLOCKER: my own wording, kept verbatim");
  // The record still rides along untouched — text winning is not record losing.
  assert.equal(msg.record.payload.summary, "generated wording");
});

test("an absent text is filled from the record", async () => {
  const r = await sendMessageTool({
    from: "a",
    to: "rendered",
    record: { type: "blocker", payload: { summary: "db down" } },
  });
  assert.equal(r.ok, true);
  const [msg] = await store.readJsonl(store.inboxFile("rendered"));
  assert.equal(msg.text, "BLOCKER: db down");
});

test("neither text nor a renderable record is rejected, not stored empty", async () => {
  assert.equal((await sendMessageTool({ from: "a", to: "b" })).ok, false);
  assert.equal((await sendMessageTool({ from: "a", to: "b", record: { type: "fyi" } })).ok, false);
});

test("record payload never reaches a top-level Message field", async () => {
  // The invariant behind the spread-order lock: payload is caller data. A
  // payload carrying `tag`/`urgent`/`kind` must not promote them.
  await sendMessageTool({
    from: "a",
    to: "no-promote",
    text: "FYI: nested only",
    record: { type: "fyi", payload: { summary: "s", tag: "DM", urgent: true, kind: "decision" } },
  });
  const [msg] = await store.readJsonl(store.inboxFile("no-promote"));
  assert.equal(msg.tag, undefined);
  assert.equal(msg.urgent, undefined);
  assert.equal(msg.kind, undefined);
  // …but they survive where they were put.
  assert.equal(msg.record.payload.tag, "DM");
});
