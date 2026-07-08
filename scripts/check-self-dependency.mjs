#!/usr/bin/env node
// Guards against a recurring defect (see docs/QUEUE.md P1): this package's
// own name has twice been reintroduced into its own dependency graph —
// once manually, once by an `npm audit fix` run (commit de4e1ee added
// "agent-coord-mcp": "^0.8.0" back into dependencies while patching
// fast-uri/hono/ip-address/qs). A self-dependency makes `npm install`
// resolve against an old published copy of this package instead of the
// local source, silently breaking dev installs. Run on every `npm install`
// (via the "prepare" script) so a reintroduction fails loudly and
// immediately instead of sitting unnoticed until the next audit.
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
      `.\nThis has recurred before — a prior "npm audit fix" run reintroduced it (see docs/QUEUE.md P1). ` +
      `Remove the self-reference from both files and re-run "npm install".`,
  );
  process.exit(1);
}
