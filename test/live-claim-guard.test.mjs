// v0.20.0 first-claim guard: a fresh session may not TOFU-bind to an agent id
// that is currently LIVE on the bus (fresh heartbeat, live transport marker,
// or another live bound session) without that agent's token or an explicit
// force. The live hit this guards against (2026-07-06): a dev session ran a
// diagnostic against `disavow-liaison` and silently became a second session
// acting as it. Read-only status/ping never binding is pinned in
// tofu-binding.test.mjs; this file covers the claim paths, the
// absent-vs-unreadable evidence split, the session-binding markers, and
// doctor's duplicate-session-binding check.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-claim-"));
// The doctor tests run in-process against this dir (ROOT is baked into
// dist/store.js at import); the guard tests use per-test subdirs, reached
// only by spawned servers.
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const serverPath = path.resolve("dist/server.js");

// Every spawned client is tracked and closed in the file-level after() as
// well: a test that fails between spawn and its own close() would otherwise
// leave a connected child holding the runner's event loop open forever.
const liveClients = [];
after(async () => {
  for (const c of liveClients) {
    try { await c.close(); } catch { /* already closed */ }
  }
});

// TMUX_PANE leaks from the developer's real tmux session into spawned
// children and would randomly satisfy the same-pane exception — every spawn
// pins it (empty = "not in tmux") unless a test opts into a specific pane.
async function spawnClient(dir, extraEnv = {}) {
  const c = new Client({ name: "claim-test", version: "0" }, { capabilities: {} });
  await c.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: { ...process.env, AGENT_COORD_DIR: dir, TMUX_PANE: "", ...extraEnv },
      stderr: "ignore",
    }),
  );
  liveClients.push(c);
  return c;
}

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

function errMsg(err, result) {
  if (err) return err.message ?? String(err);
  if (result?.isError) return result.content?.[0]?.text ?? "";
  return "";
}

async function tryCall(client, name, args) {
  let threw, result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (e) {
    threw = e;
  }
  return { msg: errMsg(threw, result), result };
}

function sessionMarkers(dir) {
  const d = path.join(dir, "sessions");
  try {
    return readdirSync(d)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(path.join(d, n), "utf8")));
  } catch {
    return [];
  }
}

async function pollUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("guard: a fresh session cannot claim an id with a fresh heartbeat", async () => {
  const dir = path.join(tmp, "fresh-heartbeat");
  const owner = await spawnClient(dir);
  await owner.callTool({ name: "register", arguments: { agentId: "victim" } });

  const dev = await spawnClient(dir);
  const claim = await tryCall(dev, "register", { agentId: "victim" });
  assert.match(claim.msg, /'victim' is live on this bus/, claim.msg);
  assert.match(claim.msg, /fresh registry heartbeat/, claim.msg);
  // A refused claim must not have bound the session as a side effect: the dev
  // session is still free to take its own id.
  const own = await dev.callTool({ name: "register", arguments: { agentId: "dev-session" } });
  assert.equal(parsed(own).ok, true);
  await owner.close();
  await dev.close();
});

test("guard: send_message as the first claim of a live id is refused too", async () => {
  const dir = path.join(tmp, "spoof-send");
  const owner = await spawnClient(dir);
  await owner.callTool({ name: "register", arguments: { agentId: "victim" } });

  const spoof = await spawnClient(dir);
  const claim = await tryCall(spoof, "send_message", { from: "victim", text: "not really victim" });
  assert.match(claim.msg, /'victim' is live on this bus/, claim.msg);
  await owner.close();
  await spoof.close();
});

test("guard: force:true claims a live id, and the marker records via=force", async () => {
  const dir = path.join(tmp, "force");
  const owner = await spawnClient(dir);
  await owner.callTool({ name: "register", arguments: { agentId: "victim" } });

  const dev = await spawnClient(dir);
  const forced = await dev.callTool({ name: "register", arguments: { agentId: "victim", force: true } });
  assert.equal(parsed(forced).ok, true);
  const vias = sessionMarkers(dir).filter((m) => m.agentId === "victim").map((m) => m.via);
  assert.ok(vias.includes("force"), `expected a via=force session marker, got ${JSON.stringify(vias)}`);
  await owner.close();
  await dev.close();
});

test("guard: the agent's token claims a live id; a wrong token fails loudly even for a free id", async () => {
  const dir = path.join(tmp, "token");
  // tokens.json must exist before the servers start — the map loads at startup.
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ victim: "tk_victim" }));

  const owner = await spawnClient(dir);
  await owner.callTool({ name: "register", arguments: { agentId: "victim" } });

  const holder = await spawnClient(dir);
  const ok = await holder.callTool({
    name: "register",
    arguments: { agentId: "victim", token: "tk_victim" },
  });
  assert.equal(parsed(ok).ok, true);

  // A wrong token must never silently succeed via the id-not-live path — a
  // caller that presents a credential is asking for it to be checked.
  const liar = await spawnClient(dir);
  const bad = await tryCall(liar, "register", { agentId: "nobody-owns-this", token: "tk_wrong" });
  assert.match(bad.msg, /does not match tokens\.json/, bad.msg);

  await owner.close();
  await holder.close();
  await liar.close();
});

test("guard: verified-absent binds freely — a stale heartbeat is not a live agent", async () => {
  const dir = path.join(tmp, "stale-heartbeat");
  mkdirSync(dir, { recursive: true });
  const stale = Date.now() - 10 * 60 * 1000; // well past STALE_MS (5m)
  writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      "old-timer": { agentId: "old-timer", registeredAt: stale, lastHeartbeat: stale },
    }),
  );
  const c = await spawnClient(dir);
  const reg = await c.callTool({ name: "register", arguments: { agentId: "old-timer" } });
  assert.equal(parsed(reg).ok, true);
  await c.close();
});

test("guard: a live transport marker alone refuses, without any registry entry", async () => {
  const dir = path.join(tmp, "marker-live");
  mkdirSync(path.join(dir, "transports"), { recursive: true });
  // This test process's own pid: guaranteed alive for the duration.
  writeFileSync(
    path.join(dir, "transports", "victim.json"),
    JSON.stringify({ agentId: "victim", transport: "tmux-push", pid: process.pid, tmuxTarget: "%42", since: Date.now() }),
  );
  const c = await spawnClient(dir);
  const claim = await tryCall(c, "register", { agentId: "victim" });
  assert.match(claim.msg, /live tmux-push transport/, claim.msg);
  await c.close();
});

test("guard: same-pane exception — the id's live pusher types into this session's own pane", async () => {
  const dir = path.join(tmp, "same-pane");
  mkdirSync(path.join(dir, "transports"), { recursive: true });
  writeFileSync(
    path.join(dir, "transports", "victim.json"),
    JSON.stringify({ agentId: "victim", transport: "tmux-push", pid: process.pid, tmuxTarget: "%42", since: Date.now() }),
  );
  // Same marker as the refusal test above; the only difference is the claimer
  // sits in the marker's own pane — the restart-in-place case.
  const c = await spawnClient(dir, { TMUX_PANE: "%42" });
  const reg = await c.callTool({ name: "register", arguments: { agentId: "victim" } });
  assert.equal(parsed(reg).ok, true);
  const vias = sessionMarkers(dir).filter((m) => m.agentId === "victim").map((m) => m.via);
  assert.deepEqual(vias, ["same-pane"]);
  await c.close();
});

test("guard: same-pane never overrides a live bound session — pane evidence beats heartbeats, not sessions", async () => {
  const dir = path.join(tmp, "same-pane-blocked");
  mkdirSync(path.join(dir, "transports"), { recursive: true });
  writeFileSync(
    path.join(dir, "transports", "victim.json"),
    JSON.stringify({ agentId: "victim", transport: "tmux-push", pid: process.pid, tmuxTarget: "%42", since: Date.now() }),
  );
  const first = await spawnClient(dir, { TMUX_PANE: "%42" });
  await first.callTool({ name: "register", arguments: { agentId: "victim" } }); // binds via same-pane
  const second = await spawnClient(dir, { TMUX_PANE: "%42" });
  const claim = await tryCall(second, "register", { agentId: "victim" });
  assert.match(claim.msg, /another live session .* is already bound/, claim.msg);
  await first.close();
  await second.close();
});

test("guard: a wrong token is not rescued by force — a presented credential gets checked", async () => {
  const dir = path.join(tmp, "token-beats-force");
  const c = await spawnClient(dir);
  const claim = await tryCall(c, "register", { agentId: "free-id", token: "tk_wrong", force: true });
  assert.match(claim.msg, /does not match tokens\.json/, claim.msg);
  await c.close();
});

test("session markers: an env pre-bound session records via=env", async () => {
  const dir = path.join(tmp, "env-marker");
  const c = await spawnClient(dir, { AGENT_COORD_BOUND_AGENT: "dave" });
  await c.callTool({ name: "register", arguments: { agentId: "dave" } });
  const vias = sessionMarkers(dir).filter((m) => m.agentId === "dave").map((m) => m.via);
  assert.deepEqual(vias, ["env"]);
  await c.close();
});

test("guard: unreadable evidence refuses — corrupt agents.json is cannot-verify, not verified-absent", async () => {
  const dir = path.join(tmp, "corrupt-registry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agents.json"), "{ this is not json");
  const c = await spawnClient(dir);
  const claim = await tryCall(c, "register", { agentId: "anyone" });
  assert.match(claim.msg, /cannot verify/, claim.msg);
  assert.match(claim.msg, /agents\.json exists but cannot be parsed/, claim.msg);
  // force is the documented override once a human has decided.
  const forced = await c.callTool({ name: "register", arguments: { agentId: "anyone", force: true } });
  assert.equal(parsed(forced).ok, true);
  await c.close();
});

test("guard: a corrupt transport marker for the claimed id also refuses", async () => {
  const dir = path.join(tmp, "corrupt-marker");
  mkdirSync(path.join(dir, "transports"), { recursive: true });
  writeFileSync(path.join(dir, "transports", "victim.json"), "{ half a marker");
  const c = await spawnClient(dir);
  const claim = await tryCall(c, "register", { agentId: "victim" });
  assert.match(claim.msg, /cannot verify/, claim.msg);
  assert.match(claim.msg, /transport marker exists but cannot be parsed/, claim.msg);
  await c.close();
});

test("session markers: a bind writes one, a clean close removes it", async () => {
  const dir = path.join(tmp, "marker-lifecycle");
  const c = await spawnClient(dir);
  await c.callTool({ name: "register", arguments: { agentId: "alice" } });
  const markers = sessionMarkers(dir);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].agentId, "alice");
  assert.equal(markers[0].via, "tofu");
  assert.ok(markers[0].pid > 0);
  await c.close();
  // close() SIGTERMs the child; the handler unlinks the marker before exit.
  const gone = await pollUntil(() => sessionMarkers(dir).length === 0);
  assert.equal(gone, true, "session marker should be removed on clean shutdown");
});

test("doctor: two live sessions bound to one id warn as duplicate-session-binding", async () => {
  // Runs in the module-level AGENT_COORD_DIR so the in-process doctorTool
  // sees the same state the spawned servers write.
  const dir = process.env.AGENT_COORD_DIR;
  const a = await spawnClient(dir);
  await a.callTool({ name: "register", arguments: { agentId: "dup-target" } });
  const b = await spawnClient(dir);
  await b.callTool({ name: "register", arguments: { agentId: "dup-target", force: true } });

  const r = await t.doctorTool({});
  const finding = r.findings.find((f) => f.check === "duplicate-session-binding");
  assert.ok(finding, "duplicate-session-binding check must exist");
  assert.equal(finding.level, "warn");
  assert.equal(finding.items.length, 1);
  assert.match(finding.items[0], /^dup-target — /);
  assert.match(finding.items[0], /via tofu/);
  assert.match(finding.items[0], /via force/);

  await a.close();
  await b.close();
  await pollUntil(() => sessionMarkers(dir).length === 0);
  const clean = await t.doctorTool({});
  assert.equal(clean.findings.find((f) => f.check === "duplicate-session-binding").level, "ok");
});

test("doctor: dead-pid session markers are stale litter, cleaned under fix", async () => {
  const dir = process.env.AGENT_COORD_DIR;
  const staleFile = path.join(dir, "sessions", "ghost.2147483646.dead0000.json");
  writeFileSync(
    staleFile,
    JSON.stringify({ agentId: "ghost", pid: 2147483646, boundAt: Date.now(), via: "tofu" }),
  );
  const r = await t.doctorTool({});
  const finding = r.findings.find((f) => f.check === "duplicate-session-binding");
  assert.equal(finding.level, "ok", "a dead session is not a duplicate");
  assert.match(finding.detail, /1 stale binding file/);

  const fixRun = await t.doctorTool({ fix: true });
  assert.ok(fixRun.fixed.some((f) => f.includes("ghost.2147483646.dead0000.json")));
  assert.equal(sessionMarkers(dir).length, 0);
  const clean = await t.doctorTool({});
  assert.equal(clean.findings.find((f) => f.check === "duplicate-session-binding").detail, "no duplicate session bindings");
});
