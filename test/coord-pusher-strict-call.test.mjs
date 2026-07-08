// Unit test for coord-pusher.mjs's strict-mode tool-call error handling
// (see docs/QUEUE.md P2: pusher silently treated a startup isError as
// success). coord-pusher.mjs can't be imported directly — it registers
// against a real MCP server as a side effect of module load (see the
// same constraint in tier.test.mjs) — so the `call`/`parseOr` source is
// extracted and evaluated against a fake client instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function extractFn(name) {
  const src = readFileSync(
    fileURLToPath(new URL("../scripts/coord-pusher.mjs", import.meta.url)),
    "utf8",
  );
  const re = new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m");
  const m = src.match(re);
  assert.ok(m, `could not find function ${name} in coord-pusher.mjs`);
  return m[0];
}

function makeCall(client) {
  const factory = new Function(
    "client",
    `${extractFn("parseOr")}\n${extractFn("call")}\nreturn call;`,
  );
  return factory(client);
}

test("call() strict:true throws on an MCP tool isError result", async () => {
  const client = {
    callTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "identity bound to 'real-agent'; rejected attempt to act as 'impostor'" }],
    }),
  };
  const call = makeCall(client);
  await assert.rejects(
    () => call("register", { agentId: "impostor" }, { strict: true }),
    /identity bound to 'real-agent'/,
  );
});

test("call() strict:false returns the parsed error text instead of throwing (back-compat)", async () => {
  const client = {
    callTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "some error" }],
    }),
  };
  const call = makeCall(client);
  const result = await call("read_messages", {});
  assert.equal(result, "some error");
});

test("call() strict:true does not throw when isError is absent", async () => {
  const client = {
    callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    }),
  };
  const call = makeCall(client);
  const result = await call("register", { agentId: "real-agent" }, { strict: true });
  assert.deepEqual(result, { ok: true });
});
