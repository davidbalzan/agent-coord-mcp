#!/usr/bin/env node
// Guards against this package's own name appearing in its own dependency
// graph. A self-dependency makes `npm install` resolve against an old
// published copy instead of the local source, silently breaking dev installs.
//
// It has happened ONCE, not repeatedly — verified 2026-07-29 by `git log -S`
// over the whole history under both the current name and the pre-rename
// `claude-coord-mcp`: commit de4e1ee (2026-06-06) added
// "agent-coord-mcp": "^0.8.0" to dependencies, and 3bce3ce removed it six
// days later. An earlier version of this comment claimed two reintroductions,
// one of them manual; that second one is not in the history.
//
// What made the one occurrence dangerous is worth keeping, because it
// generalises: de4e1ee is titled `chore: npm audit fix` and its body says
// "Lockfile-only dependency bumps, non-breaking" — while also rewriting a
// dependency block. It passed review BECAUSE the message said the manifest
// was untouched; a reviewer reads the claim, not the diff. This guard is
// cheap insurance against that class, not evidence of a recurring bug.
//
// Runs on `prepare` (every install), `pretest`, and `prepublishOnly`.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function selfDepFields(manifest) {
  return DEP_FIELDS.filter(
    (field) => manifest[field] && Object.prototype.hasOwnProperty.call(manifest[field], pkg.name),
  );
}

const offenders = selfDepFields(pkg);

let lockOffender = false;
try {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const rootPkg = lock.packages?.[""];
  if (rootPkg && selfDepFields(rootPkg).length) lockOffender = true;
} catch {
  /* no lockfile yet (fresh checkout pre-install) — nothing to check */
}

if (offenders.length || lockOffender) {
  console.error(
    `[check-self-dependency] "${pkg.name}" depends on itself` +
      (offenders.length ? ` in package.json's ${offenders.join(", ")}` : "") +
      (lockOffender ? `${offenders.length ? " and" : " in"} package-lock.json's root package` : "") +
      `.\nThis happened once before, added by an "npm audit fix" whose commit message said it was ` +
      `lockfile-only (de4e1ee, removed in 3bce3ce — see docs/DONE.md). If you just ran an audit or ` +
      `dependency update, check what else it changed in package.json. ` +
      `Remove the self-reference from both files and re-run "npm install".`,
  );
  process.exit(1);
}
