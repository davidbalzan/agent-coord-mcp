// Unit tests for the pure delivery-tier logic (hooks/tier.mjs).
// Imported directly — no build step, no I/O, no coord state.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyTier,
  effectiveTier,
  isGateRunnerRole,
  TierQueue,
  formatBatch,
  injectLine,
} from "../hooks/tier.mjs";
import { mergeTransportMarker } from "../hooks/marker.mjs";

// `tag` is the pushers' synthetic channel tag. It was called `kind` until the
// Phase 8 rename, which collided with the stored Message.kind (retention
// weight) — see "a stored Message.kind must not overwrite the channel tag".
const dm = (text, extra = {}) => ({ tag: "DM", from: "peer", to: "me", text, ...extra });
const room = (text, extra = {}) => ({ tag: "room #proj", from: "peer", text, ...extra });

test("push-now prefixes classify urgent in DMs and rooms", () => {
  for (const make of [dm, room]) {
    assert.equal(classifyTier(make("BLOCKER: lane stuck on CI")), "urgent");
    assert.equal(classifyTier(make("DAVID_DECISION: prod rollback?")), "urgent");
    assert.equal(classifyTier(make("GO: P2 slice — spec follows")), "urgent");
    assert.equal(classifyTier(make("/clear")), "urgent"); // control, injected raw
  }
});

test("prefixes are literal and case-sensitive; prose lookalikes queue", () => {
  assert.equal(classifyTier(room("GO ahead and take your time")), "routine");
  assert.equal(classifyTier(room("GOAL is not a GO prefix")), "routine");
  assert.equal(classifyTier(room("blocker: lowercase is chatter")), "routine");
  assert.equal(classifyTier(room("done: lowercase"), { gateRunner: true }), "routine");
  assert.equal(classifyTier(room("re: BLOCKER: quoted mid-body")), "routine");
});

test("routine traffic queues silently", () => {
  assert.equal(classifyTier(room("FYI: docs updated")), "routine");
  assert.equal(classifyTier(room("AGENT_ACTION: rebasing lane branch")), "routine");
  assert.equal(classifyTier(room("RISK: flaky test on main")), "routine");
  assert.equal(classifyTier(room("unprefixed chatter")), "routine");
  assert.equal(classifyTier({ tag: "room #proj", from: "peer" }), "routine"); // no text
});

test("DONE: in a room routes to the gate runner only (DMs are always urgent)", () => {
  const done = "DONE: owner/repo#7 — merged scope, 12/12 green";
  assert.equal(classifyTier(dm(done)), "urgent"); // DM — push-now regardless of gate
  assert.equal(classifyTier(room(done)), "routine");
  assert.equal(classifyTier(room(done), { gateRunner: true }), "urgent");
});

test("DMs are always urgent — point-to-point asks never queue", () => {
  assert.equal(classifyTier(dm("unprefixed relay of a David question")), "urgent");
  assert.equal(classifyTier(dm("FYI: even low-priority DMs push now")), "urgent");
  assert.equal(classifyTier(room("unprefixed chatter stays routine")), "routine");
});

test("SCOPE: is honored only from trusted (coordinator/gate) senders", () => {
  const trustedSenders = new Set(["proj-coordinator"]);
  const scope = "SCOPE: countersigned — widen slice to hooks/";
  assert.equal(classifyTier(room(scope)), "routine"); // no trust context
  assert.equal(classifyTier(room(scope), { trustedSenders }), "routine"); // untrusted peer
  assert.equal(
    classifyTier({ ...room(scope), from: "proj-coordinator" }, { trustedSenders }),
    "urgent",
  );
  assert.equal(
    classifyTier({ ...room("SCOPE CHANGE: agreed"), from: "proj-coordinator" }, { trustedSenders }),
    "urgent",
  );
});

test("server-set urgent flag pushes regardless of text; not text-spoofable", () => {
  assert.equal(classifyTier(dm("[agent-coord] context reset by /clear…", { urgent: true })), "urgent");
  assert.equal(classifyTier(dm("anything at all", { urgent: true })), "urgent");
  // The flag must be the boolean true set server-side, not truthy text games.
  assert.equal(classifyTier(room("FYI: fake", { urgent: "yes" })), "routine");
  // system join/part notices stay routine.
  assert.equal(classifyTier(room("worker-9 has joined", { system: true })), "routine");
});

test("effectiveTier: enabled=false restores legacy push-everything", () => {
  assert.equal(effectiveTier(room("FYI: routine"), { enabled: false }), "urgent");
  assert.equal(effectiveTier(room("FYI: routine"), { enabled: true }), "routine");
  assert.equal(effectiveTier(room("FYI: routine"), {}), "routine"); // default: tiers on
});

test("isGateRunnerRole matches QA/coordinator roles only", () => {
  assert.equal(isGateRunnerRole("qa"), true);
  assert.equal(isGateRunnerRole("quality-controller"), true);
  assert.equal(isGateRunnerRole("coordinator"), true);
  assert.equal(isGateRunnerRole("merge gate"), true);
  assert.equal(isGateRunnerRole("repo-owner"), false);
  assert.equal(isGateRunnerRole("consumer-owner"), false);
  assert.equal(isGateRunnerRole(undefined), false);
});

test("TierQueue: routine-only ingest never pushes; trigger drains the backlog", () => {
  const q = new TierQueue();
  const r1 = { ...room("FYI: one"), tier: "routine" };
  const r2 = { ...room("RISK: two"), tier: "routine" };
  assert.equal(q.ingest([r1]), null);
  assert.equal(q.ingest([r2]), null);
  assert.equal(q.ingest([]), null);
  assert.equal(q.size(), 2);

  const trigger = { ...dm("BLOCKER: go now"), tier: "urgent" };
  const batch = q.ingest([trigger]);
  assert.deepEqual(batch, [trigger, r1, r2]); // trigger first, backlog coalesced
  assert.equal(q.size(), 0); // drained — next push starts a fresh digest
});

test("TierQueue: max-age flush drains an overdue routine backlog", () => {
  const q = new TierQueue({ maxAgeMs: 1000 });
  const r1 = { ...room("FYI: one"), tier: "routine" };
  const r2 = { ...room("RISK: two"), tier: "routine" };
  assert.equal(q.ingest([r1], 0), null);
  assert.equal(q.ingest([r2], 400), null);
  // Age is measured from the OLDEST entry, not the newest.
  assert.equal(q.flushOverdue(999), null);
  assert.deepEqual(q.flushOverdue(1000), [r1, r2]);
  assert.equal(q.size(), 0);
  // Drained — nothing further to flush, and the age clock has reset.
  assert.equal(q.flushOverdue(5000), null);
  assert.equal(q.ingest([{ ...room("FYI: three"), tier: "routine" }], 6000), null);
  assert.equal(q.flushOverdue(6999), null); // not overdue relative to new oldest
  assert.equal(q.flushOverdue(7000)?.length, 1);
});

test("TierQueue: urgent drain resets the max-age clock", () => {
  const q = new TierQueue({ maxAgeMs: 1000 });
  q.ingest([{ ...room("FYI: old"), tier: "routine" }], 0);
  const trigger = { ...dm("GO: now"), tier: "urgent" };
  assert.equal(q.ingest([trigger], 500).length, 2); // backlog rode the trigger
  assert.equal(q.flushOverdue(10_000), null); // nothing left to age out
});

test("TierQueue: maxAgeMs of 0 (default) never age-flushes", () => {
  const q = new TierQueue();
  q.ingest([{ ...room("FYI: forever"), tier: "routine" }], 0);
  assert.equal(q.flushOverdue(Number.MAX_SAFE_INTEGER), null);
  assert.equal(q.size(), 1);
});

// 2026-01-01T08:05:00Z — fixed instant so the HH:MM assertion is stable.
const TS_0805 = Date.UTC(2026, 0, 1, 8, 5, 0);

test("injectLine: compact parse-contract format (v0.14.0)", () => {
  // room tag → "#" stripped of "room "; HH:MM UTC; no "from=" label.
  assert.equal(
    injectLine({ tag: "room #general", from: "mcp-coord", ts: TS_0805, text: "GO: start" }),
    "  [#general 08:05 mcp-coord] GO: start",
  );
  // DM tag is left as-is (no "room " prefix to strip).
  assert.equal(
    injectLine({ tag: "DM", from: "peer", ts: TS_0805, text: "hi" }),
    "  [DM 08:05 peer] hi",
  );
  // Missing text renders as empty, hours/minutes always zero-padded.
  assert.equal(injectLine({ tag: "DM", from: "a", ts: Date.UTC(2026, 0, 1, 3, 9) }), "  [DM 03:09 a] ");
});

test("parse contract: from/room/text recoverable from an injectLine", () => {
  // The shape a harness relies on: split on the FIRST "] ", then the 3
  // space-separated header tokens are [tag, HH:MM, from]. text may contain
  // anything (including "]") and is preserved intact.
  const line = injectLine({
    tag: "room #coord-mcp",
    from: "coord-mcp-worker-1",
    ts: TS_0805,
    text: "DONE: owner/repo#5 [gate green] merged",
  });
  const m = line.match(/^ {2}\[(\S+) (\d{2}:\d{2}) (\S+)\] (.*)$/);
  assert.ok(m, "line must match the parse-contract regex");
  assert.equal(m[1], "#coord-mcp"); // room
  assert.equal(m[2], "08:05");
  assert.equal(m[3], "coord-mcp-worker-1"); // from
  assert.equal(m[4], "DONE: owner/repo#5 [gate green] merged"); // text intact, incl. "]"
});

test("formatBatch: compact banners + ONE digest block, compact lines", () => {
  const batch = [
    { tag: "DM", from: "coord", ts: TS_0805, text: "BLOCKER: fix now", tier: "urgent" },
    { tag: "room #proj", from: "peer", ts: TS_0805, text: "FYI: earlier note", tier: "routine" },
    { tag: "room #proj", from: "peer", ts: TS_0805, text: "RISK: also queued", tier: "routine" },
  ];
  const lines = formatBatch(batch).split("\n");
  assert.equal(lines[0], "[agent-coord] msgs (pre-consumed, don't re-read):");
  assert.equal(lines[1], "  [DM 08:05 coord] BLOCKER: fix now");
  assert.equal(lines[2], "[agent-coord] +2 routine (pre-consumed, FYI, no reply):");
  assert.equal(lines[3], "  [#proj 08:05 peer] FYI: earlier note");
  assert.equal(lines[4], "  [#proj 08:05 peer] RISK: also queued");
  assert.equal(lines.length, 5);
});

test("formatBatch: urgent-only batch emits no routine banner", () => {
  const lines = formatBatch([
    { tag: "DM", from: "coord", ts: TS_0805, text: "GO: go", tier: "urgent" },
  ]).split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.includes("routine")));
});

test("parse-contract line is byte-identical across both pushers", () => {
  // The standalone coord-pusher registers on import, so it can't be imported
  // here — assert its injectLine SOURCE matches hooks/tier.mjs's instead. This
  // directly enforces the hard constraint: the parse-contract line must be
  // identical across both delivery paths, or a harness parses one wrong.
  const extract = (url) => {
    const src = readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
    const m = src.match(/function injectLine\(m\) \{([\s\S]*?)\n\}/);
    assert.ok(m, `injectLine not found in ${url}`);
    return m[1].trim();
  };
  assert.equal(extract("../hooks/tier.mjs"), extract("../scripts/coord-pusher.mjs"));
});

// --- Phase 8 Task 1: typed envelope is additive, and the kind→tag collision ---

test("record-less messages render byte-identically (v1 regression lock)", () => {
  // The whole additive premise: a v1 sender that has never heard of `record`
  // must produce the same bytes as before. Locked against the literal strings
  // so a future change to injectLine can't drift them silently.
  assert.equal(
    injectLine({ tag: "DM", ts: TS_0805, from: "peer", text: "hello" }),
    "  [DM 08:05 peer] hello",
  );
  assert.equal(
    injectLine({ tag: "room #proj", ts: TS_0805, from: "peer", text: "hello" }),
    "  [#proj 08:05 peer] hello",
  );
});

test("an attached record does not change the rendered line", () => {
  const base = { tag: "DM", ts: TS_0805, from: "peer", text: "BLOCKER: db down" };
  assert.equal(
    injectLine({ ...base, record: { type: "blocker", cites: [{ kind: "pr", ref: "o/r#1" }] } }),
    injectLine(base),
  );
});

test("a stored Message.kind must not overwrite the channel tag", () => {
  // Message.kind ("decision"/"status"/"chatter" — retention weight) used to
  // share its name with the pushers' synthetic channel tag. Spread-last let
  // the stored value win, so a room post tagged kind:"decision" — what the
  // README recommends for GOs and verdicts — rendered as `[decision …]` and
  // broke the parse contract. The tag now lives in `tag`, so the two fields
  // coexist and neither can clobber the other.
  const stored = { ts: TS_0805, from: "coord", room: "proj", text: "GO: ship it", kind: "decision" };
  const tagged = { ...stored, tag: "room #proj" };
  assert.equal(injectLine(tagged), "  [#proj 08:05 coord] GO: ship it");
  // The stored kind must survive the tagging copy untouched — it is what
  // prune() reads for the longer decision retention.
  assert.equal(tagged.kind, "decision");
});

test("a caller-supplied `tag` cannot forge the channel a line renders as", () => {
  // `tag` is now a real field name on the wire's blast radius: `record` and
  // `from` are untrusted, and so is anything else a peer puts on a message.
  // The pushers assign the tag after the spread, so a forged one is dropped.
  const forged = { ts: TS_0805, from: "peer", text: "FYI: not really general", tag: "room #general" };
  assert.equal(injectLine({ ...forged, tag: "DM" }), "  [DM 08:05 peer] FYI: not really general");
  // What the source-level lock below is actually protecting: a forged
  // tag:"DM" WOULD buy urgent delivery if it ever reached classifyTier, since
  // DMs bypass the routine queue. The pushers assigning the tag last is the
  // only thing standing between a peer and a forced interrupt.
  assert.equal(classifyTier({ ...forged, tag: "DM" }), "urgent");
});

test("both pushers tag AFTER the spread (source-level lock)", () => {
  // Same reasoning as the injectLine source check above: assert the fixed
  // spread order in both delivery paths so the bug can't reappear in one.
  // Line-positional, not pattern-matched: the tag value is a template literal
  // (`room #${c}`) whose own braces defeat any naive object-literal regex —
  // an earlier version of this check silently matched nothing. On every line
  // that builds a tagged copy, `...m` must appear before `tag:`.
  //
  // Post-rename this guards a different attacker than it originally did. The
  // stored Message.kind can no longer collide — the names differ now. What
  // remains is that `m` is caller-supplied: a peer that sets `tag` on its own
  // message would forge the channel a line appears to come from (a DM
  // rendering as `[#general …]`). Assigning after the spread makes the
  // pusher's own value win regardless.
  //
  // This is the LAST barrier, not the only one: a forged tag must first reach
  // a stored Message, and send_message builds Messages from fixed named fields
  // and never spreads caller args, while zod strips unknown keys at the tool
  // boundary. Getting one in needs direct JSONL write access. Phase 8's
  // `record.payload` does not change that — it is caller data that may be
  // persisted nested under `record`, but nothing in it reaches a top-level
  // Message field.
  const src = (url) => readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
  let checked = 0;
  for (const f of ["../hooks/tmux-pusher.mjs", "../scripts/coord-pusher.mjs"]) {
    for (const line of src(f).split("\n")) {
      if (!line.includes("...m") || !line.includes("tag:")) continue;
      checked++;
      assert.ok(
        line.indexOf("...m") < line.indexOf("tag:"),
        `${f}: spread after tag lets a caller-supplied tag forge the channel: ${line.trim()}`,
      );
    }
  }
  assert.equal(checked, 3, "expected 3 tagging sites; a moved/renamed one would silently pass");
});

test("the pusher stamps scriptMtime on its own marker", () => {
  // attach_agent stamps scriptMtime, but the pusher rewrites the marker
  // afterwards — omitting the field clobbered it, and doctor SKIPS markers
  // without it, so the stale-pusher-script check could never fire in
  // production. Source-level because the daemon can't be imported (it exits
  // without its required env).
  const src = readFileSync(
    fileURLToPath(new URL("../hooks/tmux-pusher.mjs", import.meta.url)),
    "utf8",
  );
  const body = src.match(/function writeTransportMarker\(\) \{([\s\S]*?)\n\}/);
  assert.ok(body, "writeTransportMarker not found");
  assert.match(body[1], /scriptMtime:/, "marker must carry scriptMtime or doctor skips it");
});

test("SCRIPT_MTIME covers the pusher's sibling modules, not just the entry file", () => {
  // The control-submit fixes (#21/#25) live in submit.mjs and tiering in
  // tier.mjs/roles.mjs — a stamp taken from import.meta.url alone reads
  // "fresh" on a pusher whose imports were replaced after it spawned, the
  // exact false green doctor's stale-pusher-script check exists to prevent.
  // Source-level for the same reason as above.
  const src = readFileSync(
    fileURLToPath(new URL("../hooks/tmux-pusher.mjs", import.meta.url)),
    "utf8",
  );
  const body = src.match(/const SCRIPT_MTIME = \(\(\) => \{([\s\S]*?)\n\}\)\(\);/);
  assert.ok(body, "SCRIPT_MTIME initializer not found");
  assert.match(
    body[1],
    /readdirSync/,
    "stamp must scan the hooks dir (the loaded module graph), not stat one file",
  );
});

test("a marker rewrite preserves fields it does not own", () => {
  // The marker has two writers: attach_agent creates it (and stamps
  // provenance like serverBuildMtime that only the server can know); the
  // pusher rewrites it at startup and owns just its pid/target/scriptMtime.
  // A rewrite that drops an unowned field switches off whichever check reads
  // it — scriptMtime was lost exactly this way once, silently disabling
  // stale-pusher-script. The contract generalises to fields that don't exist
  // yet, hence the deliberately unknown `futureField`.
  const merged = mergeTransportMarker(
    { agentId: "a", scriptMtime: 5, serverBuildMtime: 111, futureField: "keep" },
    { agentId: "a", pid: 42, scriptMtime: 9 },
  );
  assert.equal(merged.serverBuildMtime, 111, "attach_agent's stamp must survive");
  assert.equal(merged.futureField, "keep", "unknown future fields must survive");
  assert.equal(merged.scriptMtime, 9, "the rewriter's own fields must win");
  assert.equal(merged.pid, 42);
  // And the pusher actually routes its rewrite through the contract — a
  // from-scratch object literal would pass the pure test above while
  // production still clobbers. Source-level, same reason as the tests above.
  const src = readFileSync(
    fileURLToPath(new URL("../hooks/tmux-pusher.mjs", import.meta.url)),
    "utf8",
  );
  const body = src.match(/function writeTransportMarker\(\) \{([\s\S]*?)\n\}/);
  assert.ok(body, "writeTransportMarker not found");
  assert.match(body[1], /mergeTransportMarker\(/, "the rewrite must merge, not rebuild");
});

// --- Phase 8 Task 2: typed records drive the tier ---

const rec = (type, extra = {}) => ({ ...room("body text is irrelevant"), record: { type }, ...extra });

test("typed record and matching prefix classify identically", () => {
  const cases = [
    ["blocker", "BLOCKER: lane stuck", {}],
    ["decision", "DAVID_DECISION: rollback?", {}],
    ["go", "GO: take the slice", {}],
    ["risk", "RISK: flaky test", {}],
    ["fyi", "FYI: docs updated", {}],
    ["action", "AGENT_ACTION: rebasing", {}],
    ["done", "DONE: owner/repo#7", { gateRunner: true }],
    ["done", "DONE: owner/repo#7", {}],
  ];
  for (const [type, text, opts] of cases) {
    assert.equal(
      classifyTier(rec(type), opts),
      classifyTier(room(text), opts),
      `${type} must tier the same typed as prefixed`,
    );
  }
});

test("a typed blocker wakes through a greeting-first body", () => {
  // The documented footgun: prefix parsing requires byte 0, so a greeting
  // silently downgrades a production blocker to routine. This is the case the
  // whole phase exists to fix.
  const prose = room("Hey — BLOCKER: prod is down");
  assert.equal(classifyTier(prose), "routine");
  assert.equal(classifyTier({ ...prose, record: { type: "blocker" } }), "urgent");
});

test("typed records confer no trust the prefix wouldn't", () => {
  const trustedSenders = new Set(["proj-coordinator"]);
  // scope: still gated on the SENDER, not on the record being present.
  assert.equal(classifyTier(rec("scope"), { trustedSenders }), "routine");
  assert.equal(
    classifyTier({ ...rec("scope"), from: "proj-coordinator" }, { trustedSenders }),
    "urgent",
  );
  // done: still gated on the RECIPIENT being a gate runner.
  assert.equal(classifyTier(rec("done"), {}), "routine");
  assert.equal(classifyTier(rec("done"), { gateRunner: true }), "urgent");
  // verdict is new and has no prefix; it must not be a self-declared wake.
  assert.equal(classifyTier(rec("verdict"), {}), "routine");
});

test("a record cannot smuggle the server-only urgent flag", () => {
  // `urgent` is set by the server on its own Messages; a peer putting it
  // inside `record` must have no effect (record.urgent is not read at all).
  assert.equal(classifyTier({ ...room("FYI: nope"), record: { type: "fyi", urgent: true } }), "routine");
  // An unknown/garbage type degrades to routine rather than throwing.
  assert.equal(classifyTier({ ...room("x"), record: { type: "not-a-type" } }), "routine");
  assert.equal(classifyTier({ ...room("BLOCKER: x"), record: {} }), "urgent"); // no type → prefix path
});

test("the record is a floor: it raises a tier and can never lower one", () => {
  // Raising is the point of the phase.
  assert.equal(classifyTier({ ...room("FYI: routine-looking"), record: { type: "blocker" } }), "urgent");
  // Lowering is the regression this replaced. An earlier version returned
  // "routine" here: the pane rendered "BLOCKER: …" (text wins for rendering,
  // contract 3.3) while delivery queued it, and `record` is never rendered so
  // the reader could not see why. In v1 a byte-0 BLOCKER always woke the pane;
  // nothing may take that away invisibly.
  assert.equal(classifyTier({ ...room("BLOCKER: urgent-looking"), record: { type: "fyi" } }), "urgent");
});

test("relay cannot bury a peer's blocker under the relayer's own record", () => {
  // The operational trigger, not an adversarial one: an aide or coordinator
  // forwarding a worker's body verbatim under its own `fyi`.
  const relayed = {
    ...room("BLOCKER: prod is down, payments failing"),
    from: "proj-aide",
    record: { type: "fyi", payload: { summary: "forwarding worker report" } },
  };
  assert.equal(classifyTier(relayed), "urgent");
});

test("an unknown future record type cannot bury an urgent body", () => {
  // Forward-compat: a new vocabulary meeting an old pusher hits the routine
  // default in tierFromRecord. The floor keeps the text's claim alive.
  assert.equal(classifyTier({ ...room("BLOCKER: x"), record: { type: "emergency" } }), "urgent");
  // ...and an unknown type over a routine body is still routine.
  assert.equal(classifyTier({ ...room("chatter"), record: { type: "emergency" } }), "routine");
});

test("the floor does not grant trust the prefix path withholds", () => {
  const trustedSenders = new Set(["proj-coordinator"]);
  // scope from an untrusted sender: routine on BOTH paths, so the floor is routine.
  assert.equal(
    classifyTier({ ...room("SCOPE CHANGE: widen slice"), record: { type: "scope" } }, { trustedSenders }),
    "routine",
  );
  // done to a non-gate-runner: same.
  assert.equal(classifyTier({ ...room("DONE: o/r#1"), record: { type: "done" } }, {}), "routine");
});

test("record changes tier only — never the rendered line", () => {
  const base = { tag: "room #proj", ts: TS_0805, from: "peer", text: "BLOCKER: db down" };
  assert.equal(injectLine({ ...base, record: { type: "blocker" } }), injectLine(base));
});
