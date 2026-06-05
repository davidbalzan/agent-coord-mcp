// v0.7.1: trust-on-first-use session binding, exercised end-to-end against a
// real spawned stdio server. The pure-logic helpers are covered by
// identity-binding.test.mjs; this file covers the server-side gate behavior
// (closure-state TOFU + mid-session enforcement + rename rebind) which only
// makes sense to test through the actual JSON-RPC surface.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-tofu-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const serverPath = path.resolve("dist/server.js");

async function spawn(dir, extraEnv = {}) {
  const c = new Client({ name: "tofu-test", version: "0" }, { capabilities: {} });
  await c.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: { ...process.env, AGENT_COORD_DIR: dir, ...extraEnv },
      stderr: "ignore",
    }),
  );
  return c;
}

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

// Tools that error throw at the SDK boundary in some shapes and surface as
// isError content in others. This helper folds both into "the message".
function errMsg(err, result) {
  if (err) return err.message ?? String(err);
  if (result?.isError) return result.content?.[0]?.text ?? "";
  return "";
}

test("TOFU: first claim binds the session, subsequent calls match the bind", async () => {
  const dir = path.join(tmp, "happy");
  const c = await spawn(dir);
  const reg = await c.callTool({ name: "register", arguments: { agentId: "alice" } });
  assert.equal(parsed(reg).ok, true);
  const send = await c.callTool({
    name: "send_message",
    arguments: { from: "alice", text: "hello" },
  });
  assert.equal(parsed(send).ok, true);
  await c.close();
});

test("TOFU: mid-session identity switch is rejected with the binding error", async () => {
  const dir = path.join(tmp, "switch");
  const c = await spawn(dir);
  await c.callTool({ name: "register", arguments: { agentId: "alice" } });
  // alice has now claimed the binding. Try to send under bob's name from the
  // same session — should be rejected.
  let threw, result;
  try {
    result = await c.callTool({
      name: "send_message",
      arguments: { from: "bob", text: "spoof" },
    });
  } catch (e) {
    threw = e;
  }
  const msg = errMsg(threw, result);
  assert.match(
    msg,
    /identity bound to 'alice'; rejected attempt to act as 'bob'/,
    `expected binding-rejection, got: ${msg}`,
  );
  await c.close();
});

test("TOFU: rename_agent rebinds the session so the new id can keep acting", async () => {
  const dir = path.join(tmp, "rename");
  const c = await spawn(dir);
  await c.callTool({ name: "register", arguments: { agentId: "carol" } });
  // Bind is now 'carol'. Rename carol → carol-prime.
  const rn = await c.callTool({
    name: "rename_agent",
    arguments: { agentId: "carol", newAgentId: "carol-prime" },
  });
  assert.equal(parsed(rn).ok, true);
  // From this point the session is bound to carol-prime. Acting as carol now
  // should be rejected (the renamed identity supersedes the old one).
  let oldThrew, oldResult;
  try {
    oldResult = await c.callTool({
      name: "send_message",
      arguments: { from: "carol", text: "ghost" },
    });
  } catch (e) {
    oldThrew = e;
  }
  assert.match(errMsg(oldThrew, oldResult), /identity bound to 'carol-prime'/);
  // Acting as the new id should succeed.
  const fresh = await c.callTool({
    name: "send_message",
    arguments: { from: "carol-prime", text: "still here" },
  });
  assert.equal(parsed(fresh).ok, true);
  await c.close();
});

test("pre-bound env beats TOFU: AGENT_COORD_BOUND_AGENT prevents impostor first-claim", async () => {
  const dir = path.join(tmp, "prebound");
  const c = await spawn(dir, { AGENT_COORD_BOUND_AGENT: "dave" });
  // Even though no prior call has claimed an identity, the env pre-bound the
  // session — a first call asserting any other id is rejected immediately.
  let threw, result;
  try {
    result = await c.callTool({ name: "register", arguments: { agentId: "imposter" } });
  } catch (e) {
    threw = e;
  }
  assert.match(errMsg(threw, result), /identity bound to 'dave'/);
  // Acting as dave is fine.
  const ok = await c.callTool({ name: "register", arguments: { agentId: "dave" } });
  assert.equal(parsed(ok).ok, true);
  await c.close();
});

test("identity-less tools (list_agents, list_rooms) don't establish a TOFU bind", async () => {
  const dir = path.join(tmp, "readonly");
  const c = await spawn(dir);
  // Reads without any agentId arg should not establish a binding.
  await c.callTool({ name: "list_agents", arguments: {} });
  await c.callTool({ name: "list_rooms", arguments: {} });
  // Now alice's first claim should still succeed (binding wasn't set by reads).
  const reg = await c.callTool({ name: "register", arguments: { agentId: "alice" } });
  assert.equal(parsed(reg).ok, true);
  await c.close();
});
