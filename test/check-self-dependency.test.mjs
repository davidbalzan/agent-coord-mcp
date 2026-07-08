// Unit tests for scripts/check-self-dependency.mjs — the guard against the
// recurring "agent-coord-mcp depends on agent-coord-mcp" defect (see
// docs/QUEUE.md P1; root-caused to an `npm audit fix` run, commit de4e1ee).
// The script reads package.json/package-lock.json relative to its OWN
// location, so each case copies the real script into a scratch dir next to
// a fixture manifest and spawns it there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptSrc = fileURLToPath(new URL("../scripts/check-self-dependency.mjs", import.meta.url));
const realPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

const tmp = mkdtempSync(path.join(tmpdir(), "coord-selfdep-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function makeFixture(name, { pkgExtra = {}, lock } = {}) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(scriptSrc, path.join(dir, "scripts", "check-self-dependency.mjs"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: realPkg.name, version: "0.0.0", ...pkgExtra }, null, 2),
  );
  if (lock !== undefined) {
    writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
  }
  return dir;
}

function run(dir) {
  return spawnSync("node", ["scripts/check-self-dependency.mjs"], { cwd: dir, encoding: "utf8" });
}

test("check-self-dependency passes on a clean manifest with no lockfile", () => {
  const dir = makeFixture("clean-no-lock");
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("check-self-dependency passes on a clean manifest + clean lockfile", () => {
  const dir = makeFixture("clean-with-lock", {
    lock: { packages: { "": { name: realPkg.name, dependencies: { zod: "^4.0.0" } } } },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("check-self-dependency fails when package.json depends on itself", () => {
  const dir = makeFixture("self-dep-pkg", {
    pkgExtra: { dependencies: { [realPkg.name]: "^0.8.0" } },
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`"${realPkg.name}" depends on itself`));
  assert.match(r.stderr, /package\.json's dependencies/);
});

test("check-self-dependency fails when only the lockfile's root package self-depends", () => {
  const dir = makeFixture("self-dep-lock", {
    lock: { packages: { "": { name: realPkg.name, devDependencies: { [realPkg.name]: "^0.8.0" } } } },
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /package-lock\.json's root package/);
});

test("check-self-dependency catches a self-dep in any dependency field", () => {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dir = makeFixture(`field-${field}`, { pkgExtra: { [field]: { [realPkg.name]: "^0.8.0" } } });
    const r = run(dir);
    assert.equal(r.status, 1, `expected ${field} self-dep to be caught`);
  }
});
