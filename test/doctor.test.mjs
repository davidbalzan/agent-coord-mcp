// Tests for the bus-wide `doctor` health check. Own temp dir so the seeded
// corruption is isolated from the other suites.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readdirSync, statSync, utimesSync, copyFileSync, writeFileSync } from "node:fs";
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

// Disposable live pid for marker fixtures: doctor's liveness gate needs a
// real process, but pairing OUR OWN pid with a pane we don't own is the exact
// shape doctor({fix:true})'s reaper SIGTERMs — safe only while isPusherProcess
// gates the kill, i.e. one guard away from killing the test runner. A
// throwaway child is killable with zero blast radius.
async function disposablePid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"]);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child;
}

// Temp copy of hooks/*.mjs with every mtime set to `stamp`. Freshness tests
// vary mtimes to stage their scenarios — doing that to the REAL files would
// flip every live pusher's freshness while `node --test` runs other files in
// parallel against the same checkout. The AGENT_COORD_HOOKS_DIR seam points
// doctor's measurement (never attach's spawn) at the copy.
function hooksCopyAt(stamp) {
  const realHooks = fileURLToPath(new URL("../hooks", import.meta.url));
  const copy = mkdtempSync(path.join(tmpdir(), "coord-hooks-"));
  for (const f of readdirSync(realHooks)) {
    if (!f.endsWith(".mjs")) continue;
    copyFileSync(path.join(realHooks, f), path.join(copy, f));
    utimesSync(path.join(copy, f), stamp, stamp);
  }
  return copy;
}

test("touching an imported hooks module alone makes an already-spawned pusher report stale", async () => {
  // The pusher loads submit.mjs (control submission) and tier.mjs/roles.mjs
  // (tiering) at spawn. A marker stamped with the ENTRY file's mtime is what
  // a pusher spawned before a submit.mjs-only fix carries: tmux-pusher.mjs
  // itself untouched, so a check that stats only the entry file sees a
  // matching stamp and reports ok on a pusher running exactly the code the
  // fix replaced — a false green on the mechanism every pusher-side rollout
  // is verified with (#21/#25 both live in submit.mjs).
  const spawnTime = new Date(Date.now() - 60_000);
  const hooksCopy = hooksCopyAt(spawnTime);
  const entryMtime = statSync(path.join(hooksCopy, "tmux-pusher.mjs")).mtimeMs;
  const child = await disposablePid();
  await t.registerTool({ agentId: "graphstale" });
  await store.updateJson(
    store.transportFile("graphstale"),
    {},
    () => ({
      agentId: "graphstale",
      transport: "tmux-push",
      pid: child.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: entryMtime, // spawned when the entry file was current…
    }),
  );
  process.env.AGENT_COORD_HOOKS_DIR = hooksCopy;
  try {
    // …then the imported module alone is updated on disk.
    const now = new Date();
    utimesSync(path.join(hooksCopy, "submit.mjs"), now, now);
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "stale-pusher-script");
    assert.equal(f.level, "warn", "a stale import must not read as fresh");
    assert.ok(f.items.some((i) => i.includes("graphstale")));
  } finally {
    delete process.env.AGENT_COORD_HOOKS_DIR;
    child.kill();
    await store.deleteFile(store.transportFile("graphstale"));
    rmSync(hooksCopy, { recursive: true, force: true });
  }
});

test("a pusher stamped with the newest hooks mtime reports fresh", async () => {
  // The no-false-positive direction: a pusher spawned after every hooks
  // change must not be nagged to re-attach. Stamp exactly what attach_agent
  // stamps at spawn — the newest mtime across hooks/*.mjs.
  const spawnTime = new Date(Date.now() - 60_000);
  const hooksCopy = hooksCopyAt(spawnTime);
  const child = await disposablePid();
  await t.registerTool({ agentId: "freshpusher" });
  await store.updateJson(
    store.transportFile("freshpusher"),
    {},
    () => ({
      agentId: "freshpusher",
      transport: "tmux-push",
      pid: child.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      scriptMtime: spawnTime.getTime(),
    }),
  );
  process.env.AGENT_COORD_HOOKS_DIR = hooksCopy;
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "stale-pusher-script");
    assert.ok(
      !(f.items ?? []).some((i) => i.includes("freshpusher")),
      `fresh pusher flagged stale: ${JSON.stringify(f)}`,
    );
  } finally {
    delete process.env.AGENT_COORD_HOOKS_DIR;
    child.kill();
    await store.deleteFile(store.transportFile("freshpusher"));
    rmSync(hooksCopy, { recursive: true, force: true });
  }
});

// --- Server build identity: the same staleness class one layer up ---

test("server-build-drift warns when the on-disk build is newer than the loaded one", async () => {
  // The loaded side is sampled at module load and deliberately cannot be
  // faked — the thing that measures must be the thing that ran. The
  // discriminating side is the on-disk build, staged newer via the
  // AGENT_COORD_DIST_DIR seam (a temp dir standing in for a rebuilt dist/).
  const fake = mkdtempSync(path.join(tmpdir(), "coord-dist-"));
  writeFileSync(path.join(fake, "rebuilt.js"), "// stands in for a rebuilt module\n");
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(fake, "rebuilt.js"), future, future);
  process.env.AGENT_COORD_DIST_DIR = fake;
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "server-build-drift");
    assert.equal(f.level, "warn", "a server outliving its dist must be visible");
    assert.ok(f.detail.includes("Restart"), "the remedy must be named");
  } finally {
    delete process.env.AGENT_COORD_DIST_DIR;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("server-build-drift is ok when the loaded build is current", async () => {
  // On-disk older than anything this process could have loaded → no drift.
  const fake = mkdtempSync(path.join(tmpdir(), "coord-dist-"));
  writeFileSync(path.join(fake, "old.js"), "// stands in for an old build\n");
  utimesSync(path.join(fake, "old.js"), new Date(1000), new Date(1000));
  process.env.AGENT_COORD_DIST_DIR = fake;
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "server-build-drift");
    assert.equal(f.level, "ok", JSON.stringify(f));
  } finally {
    delete process.env.AGENT_COORD_DIST_DIR;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("dist-behind-source goes red on a deliberately un-rebuilt dist", async () => {
  // The state the fleet actually hit post-#28: checkout updated (src newer),
  // dist never rebuilt. Staged via both measurement seams — a src file
  // touched NOW against a dist whose newest file predates it. No restart can
  // fix this one; the check must say so affirmatively, not infer it.
  const fakeSrc = mkdtempSync(path.join(tmpdir(), "coord-src-"));
  const fakeDist = mkdtempSync(path.join(tmpdir(), "coord-dist-"));
  writeFileSync(path.join(fakeSrc, "updated.ts"), "// stands in for a pulled change\n");
  writeFileSync(path.join(fakeDist, "stale.js"), "// stands in for the old build\n");
  const now = new Date();
  const before = new Date(Date.now() - 60_000);
  utimesSync(path.join(fakeSrc, "updated.ts"), now, now);
  utimesSync(path.join(fakeDist, "stale.js"), before, before);
  process.env.AGENT_COORD_SRC_DIR = fakeSrc;
  process.env.AGENT_COORD_DIST_DIR = fakeDist;
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "dist-behind-source");
    assert.equal(f.level, "warn", "an un-rebuilt dist must be visible");
    assert.ok(f.detail.includes("npm run build"), "the remedy must be named");
  } finally {
    delete process.env.AGENT_COORD_SRC_DIR;
    delete process.env.AGENT_COORD_DIST_DIR;
    rmSync(fakeSrc, { recursive: true, force: true });
    rmSync(fakeDist, { recursive: true, force: true });
  }
});

test("dist-behind-source is ok on a current build and skips a packaged install", async () => {
  // Current build: dist at least as new as src.
  const fakeSrc = mkdtempSync(path.join(tmpdir(), "coord-src-"));
  const fakeDist = mkdtempSync(path.join(tmpdir(), "coord-dist-"));
  writeFileSync(path.join(fakeSrc, "a.ts"), "");
  writeFileSync(path.join(fakeDist, "a.js"), "");
  const stamp = new Date(Date.now() - 60_000);
  utimesSync(path.join(fakeSrc, "a.ts"), stamp, stamp);
  utimesSync(path.join(fakeDist, "a.js"), stamp, stamp);
  process.env.AGENT_COORD_SRC_DIR = fakeSrc;
  process.env.AGENT_COORD_DIST_DIR = fakeDist;
  try {
    const r1 = await t.doctorTool({});
    const f1 = r1.findings.find((x) => x.check === "dist-behind-source");
    assert.equal(f1.level, "ok", JSON.stringify(f1));
    // Packaged install: no src/ at all → "nothing to compare", never a warn.
    process.env.AGENT_COORD_SRC_DIR = path.join(fakeSrc, "does-not-exist");
    const r2 = await t.doctorTool({});
    const f2 = r2.findings.find((x) => x.check === "dist-behind-source");
    assert.equal(f2.level, "ok", JSON.stringify(f2));
    assert.ok(f2.detail.includes("packaged"), "absence must read as unknown, not fresh");
  } finally {
    delete process.env.AGENT_COORD_SRC_DIR;
    delete process.env.AGENT_COORD_DIST_DIR;
    rmSync(fakeSrc, { recursive: true, force: true });
    rmSync(fakeDist, { recursive: true, force: true });
  }
});

test("a marker stamped by an outdated server build is flagged for restart + re-attach", async () => {
  // A live, perfectly healthy pusher whose marker was stamped by a server
  // that predates the current dist: the stamps were computed with replaced
  // logic. scriptMtime is omitted so the stale-pusher-script check skips —
  // provenance must fire on its own.
  const child = await disposablePid();
  await t.registerTool({ agentId: "oldstamp" });
  await store.updateJson(
    store.transportFile("oldstamp"),
    {},
    () => ({
      agentId: "oldstamp",
      transport: "tmux-push",
      pid: child.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      serverBuildMtime: 1, // stamped by a server loaded before any real build
    }),
  );
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "marker-server-provenance");
    assert.equal(f.level, "warn");
    assert.ok(f.items.some((i) => i.includes("oldstamp")));
    assert.ok(f.detail.includes("Restart"), "the remedy must be named");
  } finally {
    child.kill();
    await store.deleteFile(store.transportFile("oldstamp"));
  }
});

test("provenance: current stamps and pre-upgrade markers are not flagged", async () => {
  const build = await import("../dist/build.js");
  const childA = await disposablePid();
  const childB = await disposablePid();
  await t.registerTool({ agentId: "curstamp" });
  await t.registerTool({ agentId: "prestamp" });
  await store.updateJson(
    store.transportFile("curstamp"),
    {},
    () => ({
      agentId: "curstamp",
      transport: "tmux-push",
      pid: childA.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      // Exactly what a current server stamps: the same value doctor compares
      // against, through the same function.
      serverBuildMtime: build.onDiskBuildMtime(),
    }),
  );
  await store.updateJson(
    store.transportFile("prestamp"),
    {},
    () => ({
      agentId: "prestamp",
      transport: "tmux-push",
      pid: childB.pid,
      tmuxTarget: "%0",
      since: Date.now(),
      // No serverBuildMtime: a pre-upgrade marker. SKIP, mirroring the
      // scriptMtime absence semantics — the queued P2 flips both together.
    }),
  );
  try {
    const r = await t.doctorTool({});
    const f = r.findings.find((x) => x.check === "marker-server-provenance");
    assert.ok(
      !(f.items ?? []).some((i) => i.includes("curstamp") || i.includes("prestamp")),
      `falsely flagged: ${JSON.stringify(f)}`,
    );
  } finally {
    childA.kill();
    childB.kill();
    await store.deleteFile(store.transportFile("curstamp"));
    await store.deleteFile(store.transportFile("prestamp"));
  }
});

// Wait for a child to be gone, whether or not its 'exit' event has already
// fired. `await new Promise((r) => child.once("exit", r))` is a missed-event
// race: doctor's fix SIGTERMs the child MID-CALL, so the 'exit' event can be
// emitted while doctorTool's remaining checks are still awaiting — a listener
// attached afterwards waits forever on an event that already happened, and
// with the child dead nothing else keeps the event loop alive, so the whole
// file dies as "Promise resolution is still pending but the event loop has
// already resolved" and every later test cancels (the ~25% gate flake,
// traced 2026-07-29: the test process received NO signal — its loop simply
// drained 6ms after the dummy's SIGTERM). exitCode/signalCode are assigned
// before 'exit' is emitted, so the guard cannot itself race.
function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

test("waitForChildExit resolves even when 'exit' already fired (the flake's shape)", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"]);
  await new Promise((resolve) => child.once("spawn", resolve));
  child.kill("SIGTERM");
  // Reproduce the race deterministically: only proceed once the 'exit' event
  // has demonstrably fired (signalCode set), i.e. the moment the old code
  // started waiting forever.
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.signalCode, "SIGTERM");
  // A ref'd timer keeps the loop alive, so a regression fails this assertion
  // loudly instead of draining the loop and cancelling the rest of the file.
  let timer;
  const winner = await Promise.race([
    waitForChildExit(child).then(() => "exited"),
    new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 2000); }),
  ]);
  clearTimeout(timer);
  assert.equal(winner, "exited", "waitForChildExit must not wait on an 'exit' that already happened");
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
      // The dummy may already be dead by now — see waitForChildExit above.
      await waitForChildExit(dummy);
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
