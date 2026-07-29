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
// It compares PASS, not `# tests`. The first version compared `# tests`, and
// the sighting that followed showed why that was the wrong number: the runner
// reported `# tests 186 / # pass 182 / # fail 0` — its own totals not adding
// up, four results landing in no bucket at all. `# tests` read the full 186, so
// the guard would have passed a run in which four results were lost. The
// anomaly is a reporter gap, not a short run, and only the pass count sees it.
//
// When you add or remove tests, update EXPECTED_TESTS in the same commit —
// that is the point, not an inconvenience. `AGENT_COORD_EXPECTED_TESTS=n`
// overrides for a one-off (bisecting, a partial run); `=0` disables the check.

import { spawn } from "node:child_process";

const EXPECTED_TESTS = 209;

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
  const pass = num("pass");
  const fail = num("fail");

  if (code !== 0 || (fail ?? 0) > 0) process.exit(code || 1);

  if (expected === 0) {
    console.log(`[check-test-count] count assertion disabled (ran ${tests ?? "?"} tests)`);
    process.exit(0);
  }
  if (pass === null) {
    console.error("[check-test-count] FAIL — no '# pass' summary line in the runner output");
    process.exit(1);
  }
  // The runner's own totals disagreeing is its own finding — report it as such
  // rather than as a count mismatch, so nobody chases a missing test file.
  if (tests !== null && tests !== pass + (fail ?? 0)) {
    console.error(
      `\n[check-test-count] FAIL — the runner's totals do not add up: ${tests} tests, ${pass} pass, ${fail ?? 0} fail.\n` +
        `  ${tests - pass - (fail ?? 0)} result(s) landed in no bucket. This is a reporter gap, not a missing test file.\n`,
    );
    process.exit(1);
  }
  if (pass !== expected) {
    console.error(
      `\n[check-test-count] FAIL — ${pass} tests passed, expected ${expected}.\n` +
        (pass < expected
          ? `  ${expected - pass} result(s) missing. Zero failures does NOT mean green here: a file that fails to load reports nothing.\n` +
            `  Re-run; if the count is stable, a test file is missing or erroring at import.\n`
          : `  ${pass - expected} test(s) were added. Update EXPECTED_TESTS in scripts/check-test-count.mjs in the same commit.\n`),
    );
    process.exit(1);
  }
  console.log(`[check-test-count] ${pass} tests passed, as expected.`);
});
