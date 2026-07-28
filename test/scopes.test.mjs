// Document write scopes (Phase 8 Task 4): the scopes.json declaration, the
// list_scopes lookup, and doctor's drift detection.
//
// The check is ADVISORY — these tests assert it DETECTS and never repairs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = mkdtempSync(path.join(tmpdir(), "coord-scopes-"));
process.env.AGENT_COORD_DIR = path.join(tmp, "coord");

const store = await import("../dist/store.js");
const t = await import("../dist/tools/index.js");
store.ensureDirs();

after(() => rmSync(tmp, { recursive: true, force: true }));

const scopeFinding = (r) => r.findings.find((f) => f.check === "document-scope-drift");
const writeScopes = (obj) => writeFileSync(store.SCOPES_FILE, JSON.stringify(obj, null, 2));
const clearScopes = () => existsSync(store.SCOPES_FILE) && rmSync(store.SCOPES_FILE);

// A throwaway git repo whose commits are authored as the agent under test —
// git records authors, not agent ids, so that is how a writer is attributable.
function makeRepo(name) {
  const repo = path.join(tmp, name);
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fleet@example.test");
  git("config", "user.name", "fleet");
  return {
    repo,
    commit(file, body, author) {
      writeFileSync(path.join(repo, file), body);
      git("add", file);
      git("-c", `user.name=${author}`, "-c", `user.email=${author}@example.test`, "commit", "-q", "-m", `touch ${file}`, "--author", `${author} <${author}@example.test>`);
    },
  };
}

await t.registerTool({ agentId: "aide-agent", role: { roleId: "aide", displayName: "the aide" } });
await t.registerTool({ agentId: "worker-9", role: { roleId: "repo-owner" } });

// ---------- 4.3 declaration + lookup ----------

test("with no scopes.json nothing is owned and nothing warns", async () => {
  clearScopes();
  const listed = await t.listScopesTool({});
  assert.equal(listed.ok, true);
  assert.equal(listed.configured, false);
  assert.equal(listed.advisory, true);
  assert.deepEqual(listed.documents, []);

  const may = await t.listScopesTool({ path: "docs/QUEUE.md", agentId: "worker-9" });
  assert.equal(may.mayWrite, true);
  assert.equal(may.owned, false);

  const d = scopeFinding(await t.doctorTool({}));
  assert.equal(d.level, "ok");
  assert.equal(d.fixable, false);
  assert.match(d.detail, /opt-in/);
});

test("list_scopes answers 'may I write this?' per document and role", async () => {
  writeScopes({
    "docs/QUEUE.md": { owner: "aide", mode: "exclusive" },
    "./docs/DONE.md": { owner: "coordinator", mode: "append-only" },
    "docs/NOTES.md": { owner: "aide", mode: "shared" },
  });

  const all = await t.listScopesTool({});
  assert.equal(all.configured, true);
  assert.deepEqual(all.documents.map((d) => d.path).sort(), ["docs/DONE.md", "docs/NOTES.md", "docs/QUEUE.md"]);
  assert.match(all.note, /advisory/);

  const owner = await t.listScopesTool({ path: "docs/QUEUE.md", agentId: "aide-agent" });
  assert.equal(owner.mayWrite, true);
  assert.equal(owner.mode, "exclusive");

  const intruder = await t.listScopesTool({ path: "docs/QUEUE.md", agentId: "worker-9" });
  assert.equal(intruder.mayWrite, false);
  assert.match(intruder.reason, /owned by 'aide'/);
  // Even a refusal is advisory — it never claims the write was prevented.
  assert.equal(intruder.advisory, true);

  const shared = await t.listScopesTool({ path: "docs/NOTES.md", agentId: "worker-9" });
  assert.equal(shared.mayWrite, true);

  const undeclared = await t.listScopesTool({ path: "docs/OTHER.md", agentId: "worker-9" });
  assert.equal(undeclared.owned, false);
  assert.equal(undeclared.mayWrite, true);

  // An agentId also works as an owner, for a doc pinned to one specific agent.
  writeScopes({ "docs/QUEUE.md": { owner: "aide-agent" } });
  const byId = await t.listScopesTool({ path: "docs/QUEUE.md", agentId: "aide-agent" });
  assert.equal(byId.mayWrite, true);
});

// ---------- 4.4 doctor drift detection ----------

test("doctor warns when a document's last writer is not its declared owner", async () => {
  const { repo, commit } = makeRepo("drift-repo");
  commit("docs/QUEUE.md", "queue\n", "worker-9"); // the wrong hands
  commit("docs/DONE.md", "done\n", "aide-agent"); // the right ones
  writeScopes({
    repo,
    documents: {
      "docs/QUEUE.md": { owner: "aide", mode: "exclusive" },
      "docs/DONE.md": { owner: "aide-agent", mode: "append-only" },
    },
  });

  const r = await t.doctorTool({});
  const d = scopeFinding(r);
  assert.equal(d.level, "warn");
  assert.equal(d.fixable, false, "rewriting someone's file is never an automatic repair");
  assert.equal(d.items.length, 1);
  assert.match(d.items[0], /docs\/QUEUE\.md/);
  assert.match(d.items[0], /worker-9/);

  // fix:true must not touch the file or claim a repair.
  const fixed = await t.doctorTool({ fix: true });
  assert.equal(scopeFinding(fixed).level, "warn");
  assert.equal((fixed.fixed ?? []).some((f) => /scope|QUEUE/i.test(f)), false);
});

test("doctor is quiet when every document agrees with its scope", async () => {
  const { repo, commit } = makeRepo("clean-repo");
  commit("docs/QUEUE.md", "queue\n", "aide-agent");
  writeScopes({ repo, documents: { "docs/QUEUE.md": { owner: "aide", mode: "exclusive" } } });

  const d = scopeFinding(await t.doctorTool({}));
  assert.equal(d.level, "ok");
  assert.match(d.detail, /agree with their scope/);
});

test("an author who maps to no registered agent is reported, not flagged", async () => {
  const { repo, commit } = makeRepo("human-repo");
  commit("docs/QUEUE.md", "queue\n", "some-human");
  writeScopes({ repo, documents: { "docs/QUEUE.md": { owner: "aide", mode: "exclusive" } } });

  const d = scopeFinding(await t.doctorTool({}));
  assert.equal(d.level, "ok");
  assert.match(d.items[0], /not attributable/);
});

test("doctor skips the check outside a git checkout instead of guessing", async () => {
  const notARepo = path.join(tmp, "plain-dir");
  mkdirSync(notARepo, { recursive: true });
  writeScopes({ repo: notARepo, documents: { "docs/QUEUE.md": { owner: "aide" } } });

  const d = scopeFinding(await t.doctorTool({}));
  assert.equal(d.level, "ok");
  assert.match(d.detail, /not a git checkout/);
});

test("a document git has never seen is not drift", async () => {
  const { repo, commit } = makeRepo("empty-repo");
  commit("docs/DONE.md", "done\n", "aide-agent");
  writeScopes({ repo, documents: { "docs/NEVER.md": { owner: "aide" } } });

  const d = scopeFinding(await t.doctorTool({}));
  assert.equal(d.level, "ok");
});

test("a malformed scopes.json degrades to 'nothing declared'", async () => {
  writeFileSync(store.SCOPES_FILE, "{ not json");
  const listed = await t.listScopesTool({});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.documents, []);
  assert.equal(scopeFinding(await t.doctorTool({})).level, "ok");
  clearScopes();
});
