// Tests for the bus-wide `doctor` health check. Own temp dir so the seeded
// corruption is isolated from the other suites.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-doctor-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

// Ignore checks that depend on real external state rather than bus JSONL
// contents: `environment` warns when tmux isn't on PATH, and
// `wedged-local-pushers` probes real tmux panes by target id — both
// machine-dependent and orthogonal to what these tests seed on disk.
const stateFindings = (r) => r.findings.filter((f) => f.check !== "environment" && f.check !== "wedged-local-pushers");

test("doctor reports a clean bus as healthy and touches nothing", async () => {
  await t.registerTool({ agentId: "solo" });
  const r = await t.doctorTool({});
  assert.equal(r.ok, true);
  assert.equal(r.fixApplied, false);
  assert.equal(r.fixed, undefined);
  assert.equal(stateFindings(r).every((f) => f.level === "ok"), true, JSON.stringify(stateFindings(r).filter((f) => f.level !== "ok")));
});

test("doctor detects seeded corruption, fixes it, and a follow-up run is clean", async () => {
  // Orphan membership: a member that isn't in the registry.
  await store.addMember("#ghostchan", "ghostmember");
  // Orphan inbox: a DM to an unregistered recipient.
  await t.sendMessageTool({ from: "solo", to: "nobody", text: "hi" });
  // Cursor past EOF for a *registered* agent (isolates from orphan-cursor).
  await t.registerTool({ agentId: "reader2" });
  await store.writeJson(store.cursorFile("reader2"), { inboxOffset: 999 });
  // Malformed JSONL line in the default room.
  appendFileSync(store.ROOM_FILE, "{ this is not valid json\n");
  // Stale transport marker (pid that cannot be alive).
  await store.writeJson(store.transportFile("deadagent"), {
    agentId: "deadagent",
    transport: "tmux-push",
    pid: 2147483646,
    since: Date.now(),
  });

  const report = await t.doctorTool({});
  const by = Object.fromEntries(report.findings.map((f) => [f.check, f]));
  assert.equal(report.healthy, false);
  assert.equal(by["orphan-room-memberships"].level, "warn");
  assert.ok(by["orphan-room-memberships"].items.includes("ghostmember"));
  assert.equal(by["orphan-inboxes-cursors"].level, "warn");
  assert.equal(by["cursor-past-eof"].level, "error");
  assert.equal(by["malformed-jsonl"].level, "warn");
  assert.equal(by["orphan-transport-markers"].level, "warn");

  const fixRun = await t.doctorTool({ fix: true });
  assert.equal(fixRun.fixApplied, true);
  assert.ok(fixRun.fixed.length >= 5, JSON.stringify(fixRun.fixed));

  // Clean follow-up: every state finding back to ok.
  const after2 = await t.doctorTool({});
  const offenders = stateFindings(after2).filter((f) => f.level !== "ok");
  assert.equal(offenders.length, 0, JSON.stringify(offenders));
});

test("doctor judges remote markers by heartbeat, not pid", async () => {
  // A remote pusher publishes a marker with pid 0 (foreign host) and keeps the
  // registry heartbeat fresh. It must NOT be flagged as a dead-pid orphan.
  await t.registerTool({ agentId: "remoteagent" }); // fresh heartbeat
  await store.writeJson(store.transportFile("remoteagent"), {
    agentId: "remoteagent",
    transport: "tmux-push-remote",
    pid: 0,
    host: "otherbox",
    since: Date.now(),
  });
  const fresh = await t.doctorTool({});
  assert.equal(
    fresh.findings.find((f) => f.check === "orphan-transport-markers").level,
    "ok",
    "fresh remote marker (pid 0) must not be flagged as a dead pid",
  );

  // Age the heartbeat past STALE_MS (5 min) → the remote marker is now stale.
  await store.updateJson(store.AGENTS_FILE, {}, (cur) => {
    cur.remoteagent.lastHeartbeat = Date.now() - 10 * 60 * 1000;
    return cur;
  });
  const stale = await t.doctorTool({});
  const f = stale.findings.find((x) => x.check === "orphan-transport-markers");
  assert.equal(f.level, "warn");
  assert.ok(f.items.some((i) => i.includes("remoteagent")));
});

test("doctor flags a stale local pusher (loaded mtime < on-disk mtime)", async () => {
  // Live marker for a registered agent. transport:"tmux-push" with our own pid
  // (so isPidAlive passes), and a scriptMtime well in the past. The doctor's
  // check stats hooks/tmux-pusher.mjs which is current → the past mtime is
  // strictly less → warn.
  await t.registerTool({ agentId: "staleagent" });
  await store.updateJson(
    store.transportFile("staleagent"),
    {},
    () => ({
      agentId: "staleagent",
      transport: "tmux-push",
      pid: process.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: 1, // epoch=Jan 1 1970 → definitely older than any built script
    }),
  );

  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "stale-pusher-script");
    assert.ok(f, "stale-pusher-script finding present");
    assert.equal(f.level, "warn");
    assert.ok(f.items.some((i) => i.includes("staleagent")));
    assert.ok(f.detail.includes("control commands"));
  } finally {
    // MUST NOT leak: this marker pairs our own pid with a tmux target we don't
    // own, which is exactly the shape the wedged-pusher reaper SIGTERMs. Left
    // behind, a later doctor({fix:true}) in this file kills the test runner.
    await store.deleteFile(store.transportFile("staleagent"));
  }
});

test("touching an imported hooks module alone makes an already-spawned pusher report stale", async () => {
  // The pusher loads submit.mjs (control submission) and tier.mjs/roles.mjs
  // (tiering) at spawn. A marker stamped with the ENTRY file's mtime is what
  // a pusher spawned before a submit.mjs-only fix carries: tmux-pusher.mjs
  // itself untouched, so a check that stats only the entry file sees a
  // matching stamp and reports ok on a pusher running exactly the code the
  // fix replaced — a false green on the mechanism every pusher-side rollout
  // is verified with (#21/#25 both live in submit.mjs).
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));
  const submitPath = path.join(hooksDir, "submit.mjs");
  const entryMtime = statSync(path.join(hooksDir, "tmux-pusher.mjs")).mtimeMs;
  const orig = statSync(submitPath);
  await t.registerTool({ agentId: "graphstale" });
  await store.updateJson(
    store.transportFile("graphstale"),
    {},
    () => ({
      agentId: "graphstale",
      transport: "tmux-push",
      pid: process.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: entryMtime, // spawned when the entry file was current…
    }),
  );
  try {
    // …then the imported module alone is updated on disk (metadata-only
    // touch; content untouched, mtimes restored in finally).
    const now = new Date();
    utimesSync(submitPath, now, now);
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "stale-pusher-script");
    assert.equal(f.level, "warn", "a stale import must not read as fresh");
    assert.ok(f.items.some((i) => i.includes("graphstale")));
  } finally {
    utimesSync(submitPath, orig.atime, orig.mtime);
    // Same leak hazard as above: our own pid paired with a pane we don't own.
    await store.deleteFile(store.transportFile("graphstale"));
  }
});

test("a pusher stamped with the newest hooks mtime reports fresh", async () => {
  // The no-false-positive direction: a pusher spawned after every hooks
  // change must not be nagged to re-attach. Stamp exactly what attach_agent
  // stamps at spawn — the newest mtime across hooks/*.mjs.
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));
  const newest = Math.max(
    ...readdirSync(hooksDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => statSync(path.join(hooksDir, f)).mtimeMs),
  );
  await t.registerTool({ agentId: "freshpusher" });
  await store.updateJson(
    store.transportFile("freshpusher"),
    {},
    () => ({
      agentId: "freshpusher",
      transport: "tmux-push",
      pid: process.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: newest,
    }),
  );
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "stale-pusher-script");
    assert.ok(
      !(f.items ?? []).some((i) => i.includes("freshpusher")),
      `fresh pusher flagged stale: ${JSON.stringify(f)}`,
    );
  } finally {
    await store.deleteFile(store.transportFile("freshpusher"));
  }
});

// Real tmux state, not fixtures — a "wedged" pusher (pid alive, pane dead) is
// only distinguishable from a healthy one by actually probing the pane, so
// this test creates and kills a real tmux session rather than faking targets.
const tmuxOnMachine = spawnSync("tmux", ["-V"]).status === 0;
(tmuxOnMachine ? test : test.skip)(
  "doctor reaps a wedged local pusher (pid-alive, pane-dead) under fix:true, leaves a live one alone",
  async () => {
    const session = `coord-doctor-test-${process.pid}`;
    spawnSync("tmux", ["new-session", "-d", "-s", session]);
    const paneId = spawnSync("tmux", ["display-message", "-p", "-t", session, "#{pane_id}"])
      .stdout.toString()
      .trim();
    assert.ok(paneId, "failed to create a real tmux pane for the test");

    // A real, disposable process for the wedged marker's pid — doctor's fix
    // SIGTERMs it, which must NOT be this test's own pid. It has to *look*
    // like a pusher to `ps`, since the reaper refuses to signal a pid it can't
    // identify as one: node idles on the timer and ignores the trailing
    // argument, which exists purely to put the pusher path in argv.
    const pusherPath = path.resolve("hooks/tmux-pusher.mjs");
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", pusherPath]);
    await new Promise((resolve) => dummy.once("spawn", resolve));

    try {
      // Alive: our own pid, a pane that genuinely exists.
      await t.registerTool({ agentId: "liveagent" });
      await store.updateJson(store.transportFile("liveagent"), {}, () => ({
        agentId: "liveagent",
        transport: "tmux-push",
        pid: process.pid,
        tmuxTarget: paneId,
        since: Date.now(),
      }));

      // Wedged: a real, alive pid (so isPidAlive/isMarkerLive still call it
      // "live"), but a pane id that cannot exist.
      await t.registerTool({ agentId: "wedgedagent" });
      await store.updateJson(store.transportFile("wedgedagent"), {}, () => ({
        agentId: "wedgedagent",
        transport: "tmux-push",
        pid: dummy.pid,
        tmuxTarget: "%999999",
        since: Date.now(),
      }));

      const dry = await t.doctorTool({});
      const dryFinding = dry.findings.find((x) => x.check === "wedged-local-pushers");
      assert.ok(dryFinding, "wedged-local-pushers finding present");
      assert.equal(dryFinding.level, "warn");
      assert.ok(dryFinding.items.some((i) => i.includes("wedgedagent")));
      assert.ok(!dryFinding.items.some((i) => i.includes("liveagent")), "live pusher must not be flagged");
      // Dry run doesn't touch anything — the marker is still on disk.
      assert.ok(await store.readJson(store.transportFile("wedgedagent"), null));

      const fixed = await t.doctorTool({ fix: true });
      assert.ok(fixed.fixed.some((f) => f.includes("wedgedagent") && f.includes("reaped")));
      await new Promise((resolve) => dummy.once("exit", resolve));
      assert.equal(dummy.signalCode, "SIGTERM", "an identified pusher is signalled");
      assert.equal(await store.readJson(store.transportFile("wedgedagent"), null), null, "marker cleared");
      assert.ok(await store.readJson(store.transportFile("liveagent"), null), "live pusher's marker untouched");

      const after = await t.doctorTool({});
      const afterFinding = after.findings.find((x) => x.check === "wedged-local-pushers");
      assert.equal(afterFinding.level, "ok", "clean on a follow-up run");
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session]);
      try { dummy.kill("SIGKILL"); } catch { /* already reaped by doctor's fix */ }
    }
  },
);

// A marker's pid outliving its pusher (or being recycled onto an unrelated
// process) must never turn doctor({fix:true}) into a killer of other people's
// processes. The marker still gets cleared — the pane is gone regardless — but
// no signal is sent unless the pid is verifiably a tmux-pusher.
(tmuxOnMachine ? test : test.skip)(
  "doctor clears a pane-dead marker without signalling when the pid isn't a pusher",
  async () => {
    const bystander = spawn("sleep", ["300"]);
    await new Promise((resolve) => bystander.once("spawn", resolve));

    try {
      await t.registerTool({ agentId: "impostor" });
      await store.updateJson(store.transportFile("impostor"), {}, () => ({
        agentId: "impostor",
        transport: "tmux-push",
        pid: bystander.pid, // alive, but a `sleep`, not tmux-pusher.mjs
        tmuxTarget: "%999998",
        since: Date.now(),
      }));

      const dry = await t.doctorTool({});
      const finding = dry.findings.find((x) => x.check === "wedged-local-pushers");
      assert.ok(finding.items.some((i) => i.includes("impostor") && i.includes("not a tmux-pusher")));

      const fixed = await t.doctorTool({ fix: true });
      assert.ok(fixed.fixed.some((f) => f.includes("impostor") && f.includes("not signalled")));
      assert.equal(await store.readJson(store.transportFile("impostor"), null), null, "marker cleared");
      // The bystander is untouched: still alive, no exit code recorded.
      assert.equal(bystander.exitCode, null, "an unrelated process must not be signalled");
      assert.equal(bystander.signalCode, null);
    } finally {
      try { bystander.kill("SIGKILL"); } catch { /* nothing to clean up */ }
    }
  },
);

test("doctor doesn't warn when the marker has no scriptMtime (pre-v0.8.2 marker)", async () => {
  await t.registerTool({ agentId: "legacy" });
  await store.updateJson(
    store.transportFile("legacy"),
    {},
    () => ({
      agentId: "legacy",
      transport: "tmux-push",
      pid: process.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      // scriptMtime intentionally omitted — pre-v0.8.2 shape.
    }),
  );

  // Take the staleagent marker from the previous test out of the way so it
  // doesn't make this assertion ambiguous.
  await store.deleteFile(store.transportFile("staleagent"));

  const r = await t.doctorTool({});
  const f = r.findings.find((x) => x.check === "stale-pusher-script");
  assert.ok(f);
  assert.equal(f.level, "ok", `pre-v0.8.2 marker should be skipped, got: ${JSON.stringify(f)}`);
});

test("doctor doesn't try to verify remote (tmux-push-remote) markers", async () => {
  await t.registerTool({ agentId: "remote-stale" });
  await store.updateJson(
    store.AGENTS_FILE,
    {},
    (cur) => { cur["remote-stale"].lastHeartbeat = Date.now(); return cur; },
  );
  await store.updateJson(
    store.transportFile("remote-stale"),
    {},
    () => ({
      agentId: "remote-stale",
      transport: "tmux-push-remote",
      pid: 0,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: 1, // ancient, but remote → must not be checked here
      host: "other-host",
    }),
  );

  const r = await t.doctorTool({});
  const f = r.findings.find((x) => x.check === "stale-pusher-script");
  // Even with an ancient remote scriptMtime, the check is local-only.
  assert.equal(f.level, "ok", `remote markers should be skipped, got: ${JSON.stringify(f)}`);
});
