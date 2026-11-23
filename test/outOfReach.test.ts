/**
 * A phase stops after one repair attempt when its failures are out of its reach: every failing test is one this phase wrote, what they test is
 * a later phase's production file, and the repair attempt wrote nothing. The failure text follows the shape of a real run's phase 7 report.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failureOutOfReach, describeOutOfReach, type OutOfReachInput } from "../src/outOfReach.js";
import { importedSources } from "../src/testHeal.js";

const TEST = "__tests__/sampleParity.test.ts";
const detail =
  `tests the change can reach (2 of 69): 1 test file(s) passed before this phase and fail now (67 skipped: they do not reach any changed file): ${TEST}\n` +
  `13 failures, 6 distinct causes (the 3 most common are shown).\n\n` +
  `[4×] Expected: true\n  first points at ${TEST}:262\n  254 | \n  257 |   it('app G2: a log with no workerId goes to the open run first', () => {\n`;

const later = [
  { name: "Group G (Step 2): Fix the reducers", files: ["src/models/timeline.ts", "reference/port/timeline.ts"] },
  { name: "QA: full verification", files: [] },
];

const base = (over: Partial<OutOfReachInput> = {}): OutOfReachInput => ({
  failures: [{ tier: "runtime", gate: "Test suite", detail }],
  createdTestFiles: [TEST],
  allowedPaths: [TEST],
  laterPhases: later,
  importsOf: (t) => (t === TEST ? ["src/models/timeline.ts", "reference/port/timeline.ts", "src/models/types.ts"] : []),
  repairEdited: false,
  ...over,
});

describe("when a phase's failure is out of its reach", () => {
  test("the real case: a test this phase wrote fails on a reducer a later phase owns, and repair wrote nothing", () => {
    assert.deepEqual(failureOutOfReach(base()), { testFiles: [TEST], target: "src/models/timeline.ts", owner: "Group G (Step 2): Fix the reducers" });
  });

  test("the target can come from the failure text alone, when the test's imports are unknown", () => {
    const r = failureOutOfReach(base({ importsOf: () => [], failures: [{ tier: "build", gate: "Typecheck", detail: `${TEST}:12: planText is not exported by reference/port/timeline.ts` }] }));
    assert.equal(r?.target, "reference/port/timeline.ts");
  });

  test("a runner printing paths from another root, or with backslashes, still matches", () => {
    const r = failureOutOfReach(base({ failures: [{ tier: "runtime", gate: "Test suite", detail: `FAIL C:\\work\\app\\__tests__\\sampleParity.test.ts` }] }));
    assert.equal(r?.target, "src/models/timeline.ts");
  });

  test("the message names the tests, the file, the later phase and the attempts saved", () => {
    const lines = describeOutOfReach(failureOutOfReach(base())!, 9).join("\n");
    assert.match(lines, /OUT OF REACH\] Every failure is in __tests__\/sampleParity\.test\.ts, which this phase wrote/);
    assert.match(lines, /src\/models\/timeline\.ts,\n\s+which the plan gives to a later phase \("Group G \(Step 2\): Fix the reducers"\)/);
    assert.match(lines, /remaining 9 attempt\(s\) would only repeat this/);
  });
});

describe("when it is not, the phase keeps repairing as before", () => {
  test("repair wrote something", () => {
    assert.equal(failureOutOfReach(base({ repairEdited: true })), undefined);
  });

  test("a failing test this phase did not write (an existing test it broke)", () => {
    assert.equal(failureOutOfReach(base({ createdTestFiles: [] })), undefined);
    const other = `FAIL __tests__/timelineGolden.test.ts\n${detail}`;
    assert.equal(failureOutOfReach(base({ failures: [{ tier: "runtime", gate: "Test suite", detail: other }] })), undefined, "one failing test it did not write is enough to keep going");
  });

  test("a failure that names no test at all (a type error in production code, a build failure)", () => {
    assert.equal(failureOutOfReach(base({ failures: [{ tier: "build", gate: "Typecheck", detail: "src/app.tsx:4: Cannot find name 'x'" }] })), undefined);
    assert.equal(failureOutOfReach(base({ failures: [...base().failures, { tier: "build", gate: "Typecheck", detail: "src/app.tsx:4: error" }] })), undefined);
  });

  test("the code the test exercises is this phase's own (the normal test-plus-fix phase)", () => {
    assert.equal(failureOutOfReach(base({ allowedPaths: [TEST, "src/models/timeline.ts", "reference/port/timeline.ts"] })), undefined);
  });

  test("the code it exercises belongs to no later phase", () => {
    assert.equal(failureOutOfReach(base({ laterPhases: [{ name: "QA", files: [] }] })), undefined);
    assert.equal(failureOutOfReach(base({ laterPhases: [] })), undefined);
  });

  test("no failures", () => {
    assert.equal(failureOutOfReach(base({ failures: [] })), undefined);
  });
});

describe("with the real import reader", () => {
  test("a new test's relative imports resolve to the later phase's files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-reach-"));
    try {
      for (const f of ["src/models/timeline.ts", "reference/port/timeline.ts"]) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.writeFileSync(path.join(root, f), "export {};\n");
      }
      const content = `import { reduceTimeline } from "../src/models/timeline";\nimport * as ref from '../reference/port/timeline';\nimport { describe } from "jest";\n`;
      fs.mkdirSync(path.join(root, "__tests__"));
      fs.writeFileSync(path.join(root, TEST), content);
      const r = failureOutOfReach(base({ importsOf: (t) => importedSources(root, t, fs.readFileSync(path.join(root, t), "utf8")) }));
      assert.equal(r?.target, "src/models/timeline.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("wired into the repair loop", () => {
  const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");

  test("each phase is told the later phases and their files", () => {
    assert.match(idx, /laterPhases: plan\.phases\.slice\(index \+ 1\)\.map\(\(p\) => \(\{ name: p\.name, files: p\.files \}\)\)/);
  });

  test("whether a repair wrote anything is measured around the REPAIR call itself", () => {
    assert.match(idx, /const writesBeforeRepair = agentTools\.writesSoFar\(\);\n\s+try \{\n\s+const repairResult = await runToolAgent\(/);
    assert.match(idx, /lastRepairEdited = agentTools\.writesSoFar\(\) !== writesBeforeRepair;/);
  });

  test("the check runs only after a repair that wrote nothing, before the no-progress logic, and stops the loop with its own reason", () => {
    const at = idx.indexOf("const repairJustEdited = lastRepairEdited;");
    assert.ok(at > 0 && at < idx.indexOf("const currentFailureSignature = failureSignature(result.blockingFailures);"));
    const block = idx.slice(at, at + 1400);
    assert.match(block, /lastRepairEdited = undefined;\n\s+if \(repairJustEdited === false\) \{/);
    assert.match(block, /stopReason = "out_of_reach";[\s\S]*describeOutOfReach\(reach, maxRepairs - attempt\)[\s\S]*break;/);
    assert.match(idx, /stopReason === "out_of_reach" && outOfReach\n\s+\? `the failing test written in \$\{phaseName\} needs a change to \$\{outOfReach\.target\}/);
  });

  test("the agent tools count every write, re-writes included", () => {
    const tools = fs.readFileSync("src/agentTools.ts", "utf8");
    assert.match(tools, /public writesSoFar\(\): number \{\s+return this\.writeEpoch;/);
  });
});
