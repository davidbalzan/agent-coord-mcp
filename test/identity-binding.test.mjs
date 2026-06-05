// v0.7.0 identity binding: tokens.json model, token-map reverse lookup,
// rename rotation. The server's request-time enforcement is covered by a
// loopback HTTP test in the verification flow, not here — these tests cover
// the pure logic that doesn't need a running server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-bind-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

test("readTokenMapSync returns null when tokens.json is absent (advisory mode)", () => {
  assert.equal(store.readTokenMapSync(), null);
});

test("readTokenMapSync builds a token→agentId reverse map", () => {
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ alice: "tk_a", bob: "tk_b" }));
  const m = store.readTokenMapSync();
  assert.ok(m instanceof Map);
  assert.equal(m.size, 2);
  assert.equal(m.get("tk_a"), "alice");
  assert.equal(m.get("tk_b"), "bob");
  unlinkSync(store.TOKENS_FILE);
});

test("readTokenMapSync throws on malformed JSON (server should refuse to start)", () => {
  writeFileSync(store.TOKENS_FILE, "{not-json");
  assert.throws(() => store.readTokenMapSync(), /not valid JSON/);
  unlinkSync(store.TOKENS_FILE);
});

test("readTokenMapSync rejects non-object root (arrays, strings, numbers)", () => {
  writeFileSync(store.TOKENS_FILE, '["alice","bob"]');
  assert.throws(() => store.readTokenMapSync(), /JSON object/);
  unlinkSync(store.TOKENS_FILE);
});

test("readTokenMapSync rejects entries with non-string/empty tokens", () => {
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ alice: "" }));
  assert.throws(() => store.readTokenMapSync(), /non-string\/empty token/);
  unlinkSync(store.TOKENS_FILE);
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ alice: 42 }));
  assert.throws(() => store.readTokenMapSync(), /non-string\/empty token/);
  unlinkSync(store.TOKENS_FILE);
});

test("rotateAgentToken moves the bearer to the new id on rename", async () => {
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ carol: "tk_c", dave: "tk_d" }));
  await store.rotateAgentToken("carol", "carol-prime");
  const m = store.readTokenMapSync();
  assert.equal(m.get("tk_c"), "carol-prime", "tk_c now authenticates carol-prime");
  assert.equal(m.get("tk_d"), "dave", "unrelated entries untouched");
  unlinkSync(store.TOKENS_FILE);
});

test("rotateAgentToken is a no-op when tokens.json is absent (advisory mode)", async () => {
  // Just verify it doesn't throw and doesn't create the file.
  await store.rotateAgentToken("alice", "alex");
  assert.equal(store.readTokenMapSync(), null);
});

test("rotateAgentToken is a no-op when the old id isn't in the map", async () => {
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ eve: "tk_e" }));
  await store.rotateAgentToken("nobody", "somebody");
  const m = store.readTokenMapSync();
  assert.equal(m.size, 1);
  assert.equal(m.get("tk_e"), "eve");
  unlinkSync(store.TOKENS_FILE);
});

test("renameAgentTool rotates the token entry when binding is configured", async () => {
  await t.registerTool({ agentId: "frank" });
  writeFileSync(store.TOKENS_FILE, JSON.stringify({ frank: "tk_f", other: "tk_o" }));
  const r = await t.renameAgentTool({ agentId: "frank", newAgentId: "francis" });
  assert.equal(r.ok, true);
  const m = store.readTokenMapSync();
  assert.equal(m.get("tk_f"), "francis", "frank's bearer now authenticates francis");
  assert.equal(m.get("tk_o"), "other", "unrelated entries untouched");
  unlinkSync(store.TOKENS_FILE);
});
