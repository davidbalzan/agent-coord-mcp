#!/usr/bin/env node
// Run the suite and assert it ran the number of tests we expect.
//
// WHY: `npm test` was twice observed reporting FOUR fewer tests with zero
// failures (119→115, 145→141), never reproducible on a re-run. A suite whose
// count silently varies cannot be used as a gate signal — "all green" and "a
// file failed to load" look identical. This is the same silent-undercount
// class as a QUEUE parser returning zero items while passing every test.
//
// So the count is an assertion, not a statistic. A short run fails loudly.
//
// When you add or remove tests, update EXPECTED_TESTS in the same commit —
// that is the point, not an inconvenience. `AGENT_COORD_EXPECTED_TESTS=n`
// overrides for a one-off (bisecting, a partial run); `=0` disables the check.

import { spawn } from "node:child_process";

const EXPECTED_TESTS = 186;

const expected = Number(process.env.AGENT_COORD_EXPECTED_TESTS ?? EXPECTED_TESTS);
// Same glob the suite always used — `--test test/` would recurse differently
// on some node versions, and a runner that selects a different set of files
// is exactly the failure this script exists to catch.
const child = spawn(process.execPath, ["--test", "test/*.test.mjs"], {
  stdio: ["inherit", "pipe", "inherit"],
  shell: false,
});

let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
  process.stdout.write(chunk);
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  // The TAP summary lines the runner prints once, at the end.
  const num = (label) => {
    const m = out.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const tests = num("tests");
  const fail = num("fail");

  if (code !== 0 || (fail ?? 0) > 0) process.exit(code || 1);

  if (expected === 0) {
    console.log(`[check-test-count] count assertion disabled (ran ${tests ?? "?"} tests)`);
    process.exit(0);
  }
  if (tests === null) {
    console.error("[check-test-count] FAIL — no '# tests' summary line in the runner output");
    process.exit(1);
  }
  if (tests !== expected) {
    console.error(
      `\n[check-test-count] FAIL — ran ${tests} tests, expected ${expected}.\n` +
        (tests < expected
          ? `  ${expected - tests} test(s) did not run. Zero failures does NOT mean green here: a file that fails to load reports nothing.\n` +
            `  Re-run; if the count is stable, a test file is missing or erroring at import.\n`
          : `  ${tests - expected} test(s) were added. Update EXPECTED_TESTS in scripts/check-test-count.mjs in the same commit.\n`),
    );
    process.exit(1);
  }
  console.log(`[check-test-count] ${tests} tests ran, as expected.`);
});
