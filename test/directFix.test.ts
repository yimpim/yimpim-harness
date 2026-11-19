/**
 * A fix for a diagnosed defect goes straight to the Editor. The plan it gets is built from the diagnosis, and must be one the rest of the
 * pipeline accepts exactly as it accepts a Planner's plan.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixTaskFor } from "../src/testSettle.js";
import { parseFixTask, directFixFor, setMustPass, isMustPass } from "../src/directFix.js";
import { parsePlan, validatePlan, lintTargetFiles, lintAssumptions } from "../src/planner.js";
import { lintPlanVerification } from "../src/verificationBullets.js";
import { extractDiscoveryTargetFiles } from "../src/discoveryParsing.js";

let dir = "";
const write = (rel: string, s = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "directfix-"));
  write("app/dashboard.tsx");
  write("src/models/sessionSummary.ts");
  write("src/models/timeline.ts");
  write("__tests__/dashboard.test.ts");
  write("__tests__/other.test.ts");
  write("node_modules/@babel/runtime/helpers/asyncToGenerator.js");
});
afterEach(() => {
  setMustPass([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const REASON =
  "app/dashboard.tsx:1006 compares the activity to 'RUNNING' and 'AWAITING_INPUT' from src/models/sessionSummary.ts, but the wire sends 'running', so Stop is never offered.";
const FAILURE = "14 failures, 2 distinct causes.\n\n[9×] expect(received).toContain(expected)\n  at asyncGeneratorStep (node_modules/@babel/runtime/helpers/asyncToGenerator.js:3:17)";

describe("reading a fix task", () => {
  test("the items come back as file and diagnosis, without the failure text", () => {
    const task = fixTaskFor([
      { file: "__tests__/dashboard.test.ts", reason: REASON, failure: FAILURE },
      { file: "__tests__/other.test.ts", reason: "src/models/timeline.ts drops the last status.", failure: "1 failure" },
    ]);
    const items = parseFixTask(task);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.file), ["__tests__/dashboard.test.ts", "__tests__/other.test.ts"]);
    assert.equal(items[0].reason, REASON);
    assert.doesNotMatch(items[0].reason, /How it fails|distinct causes/);
  });
  test("text that is not a fix task has no items", () => {
    assert.deepEqual(parseFixTask("add a settings screen"), []);
  });
});

describe("the plan built from a diagnosis", () => {
  const make = () => directFixFor(fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: REASON, failure: FAILURE }]), dir)!;

  test("it exists when the diagnosis names code, and is one phase for the one failing test file", () => {
    const d = make();
    assert.ok(d);
    const plan = JSON.parse(d.plan);
    assert.equal(plan.phases.length, 1);
    assert.equal(plan.phases[0].executor, "EDITOR");
  });
  test("the phase works in the code the diagnosis names, never in a test, never in a dependency", () => {
    const d = make();
    assert.deepEqual(JSON.parse(d.plan).phases[0].files.sort(), ["app/dashboard.tsx", "src/models/sessionSummary.ts"]);
    assert.deepEqual(d.files.sort(), ["app/dashboard.tsx", "src/models/sessionSummary.ts"]);
    assert.ok(!d.plan.includes("node_modules"));
  });
  test("it carries the diagnosis as the change, says the test must not be edited, and checks that the test passes", () => {
    const phase = JSON.parse(make().plan).phases[0];
    assert.ok(phase.changes[0].includes("Stop is never offered"));
    assert.match(phase.goal, /never edit, skip, delete or loosen one/);
    // ...but a mock that the fix itself makes out of date is the fix's to update (the case where the change broke another test's mock).
    assert.match(phase.goal, /a MOCK or setup that your change now makes out of date/);
    assert.match(phase.goal, /requireActual/);
    assert.match(phase.verification[0], /__tests__\/dashboard\.test\.ts passes/);
  });
  test("the test file that must pass is reported", () => {
    assert.deepEqual(make().tests, ["__tests__/dashboard.test.ts"]);
  });
  test("it passes every check a Planner's plan has to pass, so nothing downstream rejects it", () => {
    const d = make();
    const parsed = parsePlan(d.plan, "fallback");
    assert.equal(parsed.degraded, false, parsed.degradedReason);
    assert.deepEqual(validatePlan(parsed.plan, false), []);
    assert.deepEqual(lintTargetFiles(parsed.plan, (rel: string) => fs.existsSync(path.join(dir, rel))), []);
    assert.deepEqual(lintAssumptions(parsed.plan.assumptions), []);
    assert.deepEqual(lintPlanVerification(parsed.plan, { knownText: `${d.discovery}` }), []);
  });
  test("what Discovery would have produced lists the same files", () => {
    assert.deepEqual(extractDiscoveryTargetFiles(make().discovery).sort(), ["app/dashboard.tsx", "src/models/sessionSummary.ts"]);
  });
});

describe("several failing test files", () => {
  test("each gets its own phase, working in the code its own diagnosis names", () => {
    const d = directFixFor(
      fixTaskFor([
        { file: "__tests__/dashboard.test.ts", reason: REASON, failure: "" },
        { file: "__tests__/other.test.ts", reason: "src/models/timeline.ts drops the last status.", failure: "" },
      ]),
      dir
    )!;
    const phases = JSON.parse(d.plan).phases;
    assert.equal(phases.length, 2);
    assert.deepEqual(phases[1].files, ["src/models/timeline.ts"]);
    assert.deepEqual(d.tests, ["__tests__/dashboard.test.ts", "__tests__/other.test.ts"]);
    assert.equal(parsePlan(d.plan, "f").degraded, false);
  });
  test("one whose diagnosis names no code is given all the code that was named, not nothing", () => {
    const d = directFixFor(
      fixTaskFor([
        { file: "__tests__/dashboard.test.ts", reason: REASON, failure: "" },
        { file: "__tests__/other.test.ts", reason: "the status handling is wrong somewhere", failure: "" },
      ]),
      dir
    )!;
    assert.deepEqual(JSON.parse(d.plan).phases[1].files.sort(), ["app/dashboard.tsx", "src/models/sessionSummary.ts"]);
  });
});

describe("when there is nothing to start from, the normal Discovery and Planner run", () => {
  test("a diagnosis that names no file in the project", () => {
    assert.equal(directFixFor(fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: "the activity handling is wrong", failure: "" }]), dir), undefined);
  });
  test("a diagnosis that names only a test, or only a dependency", () => {
    assert.equal(directFixFor(fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: "__tests__/other.test.ts is wrong", failure: "" }]), dir), undefined);
    assert.equal(directFixFor(fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: "node_modules/@babel/runtime/helpers/asyncToGenerator.js throws", failure: "" }]), dir), undefined);
  });
  test("a file named that does not exist", () => {
    assert.equal(directFixFor(fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: "src/models/gone.ts is wrong", failure: "" }]), dir), undefined);
  });
  test("text that is not a fix task", () => {
    assert.equal(directFixFor("add a settings screen", dir), undefined);
  });
});

describe("the tests a fix is for", () => {
  test("are remembered for the task, matched however the path is written, and cleared", () => {
    setMustPass(["__tests__/dashboard.test.ts"]);
    assert.equal(isMustPass("__tests__/dashboard.test.ts"), true);
    assert.equal(isMustPass("__tests__\\dashboard.test.ts"), true);
    assert.equal(isMustPass("__tests__/other.test.ts"), false);
    setMustPass([]);
    assert.equal(isMustPass("__tests__/dashboard.test.ts"), false);
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  const index = read("../src/index.ts");
  test("a diagnosed fix skips Discovery, the Planner and the security triage, and says so", () => {
    assert.ok(index.includes("const direct = !verifyOnly && isFixTask(instructions) ? directFixFor(instructions, repoRoot) : undefined;"));
    assert.ok(index.includes("const discoveryRaw = direct ? direct.discovery : await runToolAgent({"));
    assert.ok(index.includes("planOutput = direct ? direct.plan : await runToolAgent({"));
    assert.ok(index.includes("config.security.enabled && !verifyOnly && !direct"));
    assert.ok(index.includes("Discovery and the Planner are skipped"));
  });
  test("the set of tests a fix is for is set for EVERY task, so it never leaks into the next one", () => {
    assert.ok(index.includes("setMustPass(direct ? direct.tests : []);"));
  });
  test("the verifier does not excuse a test the fix is for as already failing, and says the fix is not done", () => {
    const v = read("../src/verifierTools.ts");
    assert.ok(v.includes("before.has(f) && !isMustPass(f)"));
    assert.ok(v.includes("the test file(s) this fix is for still fail"));
  });
});

describe("what the console says on the direct path", () => {
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("it does not claim the Planner was given anything or produced anything: no Planner ran", () => {
    assert.ok(index.includes("if (userFiles.length > 0 && !direct) {"));
    assert.ok(index.includes("[FIX] The fix is ${activePlan.phases.length} phase(s), built from the diagnosis."));
  });
});

describe("what the verifier shows REPAIR for a test the phase broke", () => {
  test("it includes the evidence, so a stale mock is seen as a stale mock", () => {
    const v = fs.readFileSync(new URL("../src/verifierTools.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
    assert.ok(v.includes("evidence = digest.text ? evidenceText(this.repoRoot, caused[0], digest) : \"\";"));
    assert.ok(v.includes("EVIDENCE (collected from the repository, not guessed)"));
  });
});
