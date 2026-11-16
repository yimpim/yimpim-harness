/**
 * isToolingFailure must tell "the tool isn't installed" from "the tool ran and
 * the code under test is broken". A real run lost 178 failing tests because
 * ONE stray suite printed "Cannot find module" and the whole result was filed
 * as "toolchain unavailable".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isToolingFailure, describeToolingFailure, reportsTestResults, reportsNoTestsFound } from "../src/verifierTools.js";

const jestRun = `FAIL .agent/x/__tests__/a.test.ts
  ● Test suite failed to run
    Cannot find module '../lib/canonicalJson' from 'src/a.ts'

FAIL __tests__/b.test.ts
  ● thing › works
    Expected: 1
    Received: 2

Test Suites: 2 failed, 5 passed, 7 total
Tests:       3 failed, 40 passed, 43 total`;

describe("isToolingFailure", () => {
  test("a jest run with real failures is a defect even if one suite says 'Cannot find module'", () => {
    assert.equal(isToolingFailure({ code: 1, stdout: jestRun }), false);
  });

  test("jest itself missing is still tooling", () => {
    assert.equal(
      isToolingFailure({ code: 1, stderr: "Error: Cannot find module '/proj/node_modules/jest/bin/jest.js'" }),
      true
    );
  });

  test("a missing binary is still tooling", () => {
    assert.equal(isToolingFailure({ code: "ENOENT" }), true);
    assert.equal(isToolingFailure({ stderr: "'jest' is not recognized as an internal or external command" }), true);
  });

  test("other runners' summaries also count as 'the runner ran'", () => {
    assert.ok(reportsTestResults("# tests 3\n# pass 2\n# fail 1"));
    assert.ok(reportsTestResults("=== 2 failed, 4 passed in 0.31s ==="));
    assert.ok(reportsTestResults("test result: FAILED. 1 passed; 1 failed;"));
    assert.ok(reportsTestResults("--- FAIL: TestThing (0.00s)"));
    assert.ok(reportsTestResults(" Test Files  1 failed | 2 passed (3)"));
    assert.ok(!reportsTestResults("npm ERR! missing script: test"));
  });
});

describe("describeToolingFailure", () => {
  test("shows the line that explains it, not the npm banner", () => {
    const err = {
      stdout: "> app@1.0.0 test\n> jest\n",
      stderr: "sh: 1: jest: command not found\n",
    };
    const text = describeToolingFailure(err);
    assert.match(text, /command not found/);
    assert.doesNotMatch(text, /app@1\.0\.0/);
  });
});

describe("reportsNoTestsFound", () => {
  test("jest with no tests, no results summary", () => {
    const out = "No tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0";
    assert.ok(reportsNoTestsFound(out));
  });
  test("pytest and vitest wording", () => {
    assert.ok(reportsNoTestsFound("collected 0 items\n\n============ no tests ran in 0.01s ============"));
    assert.ok(reportsNoTestsFound("No test files found, exiting with code 1"));
  });
  test("a real failing run is never 'no tests'", () => {
    assert.ok(!reportsNoTestsFound("FAIL a.test.ts\nTest Suites: 1 failed, 1 total\nTests: 2 failed, 2 total"));
    assert.ok(!reportsNoTestsFound("Error: boom"));
  });
});
