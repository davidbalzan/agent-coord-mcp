// CLI-surface tests for `coord-chat --doctor [--fix]`. Spawns the real script
// as a subprocess so the wiring under test — dynamic import of dist/tools/index.js,
// arg parsing, exit codes, --dir → AGENT_COORD_DIR pinning — is exercised
// end-to-end. The doctor logic itself is covered in doctor.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHAT = fileURLToPath(new URL("../scripts/coord-chat.mjs", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "coord-chat-doctor-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
function runDoctor(dir, ...flags) {
  const r = spawnSync(process.execPath, [CHAT, "--dir", dir, "--doctor", ...flags], {
    encoding: "utf8",
  });
  return { code: r.status, out: stripAnsi(r.stdout ?? "") };
}

test("--doctor on a clean dir exits 0 and renders the report", () => {
  const dir = path.join(tmp, "clean");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({ a: { agentId: "a", role: "repo-owner", lastHeartbeat: Date.now() } }),
  );
  const { code, out } = runDoctor(dir);
  assert.equal(code, 0);
  assert.match(out, /coord doctor/);
  assert.match(out, /orphan-transport-markers/); // a real check name from the tool
  assert.match(out, /0 error/);
});

test("--doctor exits 1 when an error-level finding is present", () => {
  const dir = path.join(tmp, "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({ a: { agentId: "a", role: "repo-owner", lastHeartbeat: Date.now() } }),
  );
  // Cursor offset past EOF for a registered agent → error-level (delivery stalled).
  mkdirSync(path.join(dir, "cursors"), { recursive: true });
  writeFileSync(path.join(dir, "cursors", "a.json"), JSON.stringify({ inboxOffset: 999 }));
  const { code, out } = runDoctor(dir);
  assert.equal(code, 1);
  assert.match(out, /cursor-past-eof/);
});

test("--doctor --fix removes a fixable orphan transport marker", () => {
  const dir = path.join(tmp, "fixable");
  mkdirSync(path.join(dir, "transports"), { recursive: true });
  writeFileSync(path.join(dir, "agents.json"), JSON.stringify({}));
  const marker = path.join(dir, "transports", "ghost.json");
  writeFileSync(
    marker,
    JSON.stringify({ agentId: "ghost", transport: "tmux-push", pid: 999999, tmuxTarget: "%99" }),
  );
  const { out } = runDoctor(dir, "--fix");
  assert.match(out, /fixed:/);
  assert.equal(existsSync(marker), false, "stale marker should be deleted by --fix");
  // Follow-up run is clean of that finding.
  const again = runDoctor(dir);
  assert.match(again.out, /no stale transport markers/);
});
