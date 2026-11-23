/**
 * A phase that only writes a test meant to fail is folded into the phase with the fix. The fixture is the shape of a real run's phases 7 and 8
 * (the 9-phase run whose phase 7 stalled): a test-only phase whose check reads "...fails on the unpatched reducers", then a phase fixing two
 * reducers. Names and paths are neutral; the structure and the failure wording are as the planner wrote them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isRedTestPhase, mergeRedTestPhases, expectsFailure, describeRedTestMerge } from "../src/redTestMerge.js";
import { parsePlan, type PlannedPhase } from "../src/planner.js";

const phase = (p: Partial<PlannedPhase> & { id: string; name: string }): PlannedPhase =>
  ({ goal: "", executor: "EDITOR", files: [], newFiles: [], changes: [], verification: [], ...p }) as PlannedPhase;

const before = phase({
  id: "phase-6",
  name: "Group F: Cost tab note",
  goal: "Add the unfinished-worker note to the cost tab.",
  files: ["src/components/CostTab.tsx"],
  verification: ["[A14] The cost tab shows the note while a worker is unfinished."],
});
const red = phase({
  id: "phase-7",
  name: "Group G (Step 1): Failing reducer parity test from a real sample log",
  goal: "Write a failing reducer test from reference/sample-log before modifying either reducer, asserting G1–G6 routing rules against both src/models/timeline.ts and reference/port/timeline.ts.",
  files: ["__tests__/sampleParity.test.ts"],
  newFiles: ["__tests__/sampleParity.test.ts"],
  changes: [
    "Create __tests__/sampleParity.test.ts that loads the real log events from reference/sample-log/*.jsonl.",
    "Add assertions covering G1–G6 on the sample plus targeted real-shape cases.",
    "Confirm the test file typechecks cleanly and fails against the unpatched src/models/timeline.ts (establishing the red baseline required before Phase 8).",
  ],
  verification: ["[A15] __tests__/sampleParity.test.ts compiles under `npm run typecheck` and fails on the unpatched reducers for the Group G1–G6 gaps."],
});
const fix = phase({
  id: "phase-8",
  name: "Group G (Step 2): Fix src/models/timeline.ts and reference port together",
  goal: "Fix G1–G6 routing in both src/models/timeline.ts and reference/port/timeline.ts together.",
  files: ["src/models/timeline.ts", "reference/port/timeline.ts"],
  changes: ["G1: route a log with workerId only to that worker.", "G2: check the newest open run first."],
  verification: [
    "[A16] __tests__/sampleParity.test.ts passes against both src/models/timeline.ts and reference/port/timeline.ts.",
    "[A17] __tests__/timelineGolden.test.ts passes.",
  ],
  contracts: { signatures: ["export function planText(status: string, plan?: string): string"], types: [], constraints: [] },
});
const qa = phase({ id: "phase-9", name: "QA: full verification", goal: "Run typecheck and the whole suite.", executor: "QA", verification: ["[A18] npm test exits 0."] });

describe("recognising a red-test phase", () => {
  test("the real phase 7 is one; the fix phase, the phase before it and the QA phase are not", () => {
    assert.equal(isRedTestPhase(red), true);
    for (const p of [before, fix, qa]) assert.equal(isRedTestPhase(p), false, p.name);
  });

  test("the wording that expects a failure", () => {
    for (const s of [
      "fails on the unpatched reducers",
      "fails against the unpatched src/models/timeline.ts",
      "establishing the red baseline",
      "the new test should fail until the fix lands",
      "is expected to fail before the change",
      "red-baseline",
    ])
      assert.equal(expectsFailure(s), true, s);
    for (const s of ["npm test passes", "fixes the failing tests", "the test fails no more", "every failing case is fixed", "returns failure codes"])
      assert.equal(expectsFailure(s), false, s);
  });

  test("a test-only phase that expects its tests to PASS is ordinary work (fixing or adding tests), not a red step", () => {
    assert.equal(isRedTestPhase(phase({ id: "t", name: "t", goal: "Fix the failing tests in the parser suite.", files: ["test/parser.test.ts"], verification: ["[A1] test/parser.test.ts passes."] })), false);
    assert.equal(isRedTestPhase(phase({ id: "t", name: "t", goal: "Add tests for the cart.", files: ["__tests__/cart.test.ts"], verification: ["[A1] The new tests pass."] })), false);
  });

  test("a phase that touches production code is never a red step, whatever its checks say", () => {
    assert.equal(isRedTestPhase({ ...red, files: [...red.files, "src/models/timeline.ts"] }), false);
  });

  test("its goal alone is enough when the checks are vague", () => {
    assert.equal(isRedTestPhase({ ...red, changes: [], verification: ["[A1] The test file exists."] }), true);
  });
});

describe("merging it into the fix", () => {
  const { phases, merges } = mergeRedTestPhases([before, red, fix, qa]);
  const merged = phases[1];

  test("phases 7 and 8 become one; the rest are untouched", () => {
    assert.deepEqual(phases.map((p) => p.id), ["phase-6", "phase-8", "phase-9"]);
    assert.equal(phases[0], before);
    assert.equal(phases[2], qa);
    assert.deepEqual(merges, [{ from: { id: "phase-7", name: red.name }, into: { id: "phase-8", name: fix.name } }]);
  });

  test("the merged phase keeps the fix phase's id and name, and owns the test and both reducers", () => {
    assert.equal(merged.id, "phase-8");
    assert.equal(merged.name, fix.name);
    assert.equal(merged.executor, "EDITOR");
    assert.deepEqual(merged.files, ["__tests__/sampleParity.test.ts", "src/models/timeline.ts", "reference/port/timeline.ts"]);
    assert.deepEqual(merged.newFiles, ["__tests__/sampleParity.test.ts"]);
  });

  test("every check expecting failure is gone, and the checks that the test passes remain", () => {
    assert.ok(merged.verification.every((v) => !expectsFailure(v)));
    assert.deepEqual(merged.verification, fix.verification);
    assert.ok(merged.changes.every((c) => !expectsFailure(c)), "no change line asks for a red baseline either");
  });

  test("the test is still written first, and the goal carries what the test must cover", () => {
    assert.equal(merged.changes[0], red.changes[0]);
    assert.match(merged.changes.join("\n"), /Write that test first, then make the production change below/);
    assert.ok(merged.changes.includes("G2: check the newest open run first."));
    assert.match(merged.goal, /^Fix G1–G6 routing/);
    assert.match(merged.goal, /must pass by the end: Write a failing reducer test/);
  });

  test("contracts are kept", () => {
    assert.deepEqual((merged.contracts as any).signatures, ["export function planText(status: string, plan?: string): string"]);
  });

  test("the line printed about it names both phases", () => {
    assert.match(describeRedTestMerge(merges[0]), /Merged "Group G \(Step 1\).*" into "Group G \(Step 2\).*": a phase that only writes a failing test cannot pass on its own/);
  });
});

describe("edges", () => {
  test("two red steps in a row both end up in the fix", () => {
    const red2 = { ...red, id: "phase-7b", name: "Step 1b", files: ["__tests__/more.test.ts"], newFiles: ["__tests__/more.test.ts"] };
    const { phases, merges } = mergeRedTestPhases([red, red2, fix]);
    assert.deepEqual(phases.map((p) => p.id), ["phase-8"]);
    assert.equal(merges.length, 2);
    assert.deepEqual(phases[0].files, ["__tests__/sampleParity.test.ts", "__tests__/more.test.ts", "src/models/timeline.ts", "reference/port/timeline.ts"]);
  });

  test("a red step with nothing after it, or only a QA phase after it, is left alone", () => {
    assert.deepEqual(mergeRedTestPhases([before, red]).phases.map((p) => p.id), ["phase-6", "phase-7"]);
    assert.deepEqual(mergeRedTestPhases([red, qa]).phases.map((p) => p.id), ["phase-7", "phase-9"]);
  });

  test("a resumed plan: completed phases are never merged or merged into", () => {
    assert.deepEqual(mergeRedTestPhases([before, red, fix, qa], new Set(["phase-6"])).phases.map((p) => p.id), ["phase-6", "phase-8", "phase-9"]);
    assert.deepEqual(mergeRedTestPhases([before, red, fix, qa], new Set(["phase-7"])).phases.map((p) => p.id), ["phase-6", "phase-7", "phase-8", "phase-9"]);
    assert.deepEqual(mergeRedTestPhases([before, red, fix, qa], new Set(["phase-8"])).phases.map((p) => p.id), ["phase-6", "phase-7", "phase-8", "phase-9"]);
  });

  test("a plan with no red step is returned as it was", () => {
    const { phases, merges } = mergeRedTestPhases([before, fix, qa]);
    assert.deepEqual(phases, [before, fix, qa]);
    assert.deepEqual(merges, []);
  });
});

describe("wired in", () => {
  test("parsePlan merges before the phase cap and the verification IDs, and reports it", () => {
    const raw = JSON.stringify({ goal: "parity", causalAnalysis: "", phases: [before, red, fix, qa] });
    const parsed = parsePlan(raw, "parity");
    assert.equal(parsed.degraded, false);
    assert.deepEqual(parsed.plan.phases.map((p) => p.id), ["phase-6", "phase-8", "phase-9"]);
    assert.deepEqual(parsed.allPhases.map((p) => p.id), ["phase-6", "phase-8", "phase-9"]);
    assert.equal(parsed.redTestMerges?.length, 1);
    const ids = parsed.plan.phases.flatMap((p) => p.verification.map((v) => v.match(/^\[(A\d+)\]/)?.[1]));
    assert.equal(new Set(ids).size, ids.length, "verification IDs stay unique");
  });

  test("--resume folds the cached plan's remaining red steps, and both plan announcements print the merge", () => {
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.match(idx, /mergeRedTestPhases\(cachedState\.plan\.phases, new Set\(cachedState\.completedPhaseIds \?\? \[\]\)\)/);
    assert.equal(idx.split("for (const m of parsed.redTestMerges ?? []) console.log(describeRedTestMerge(m));").length - 1, 2);
  });

  test("the Planner is told a test and its fix are one phase", () => {
    const prompts = fs.readFileSync("src/prompts.ts", "utf8").replace(/\r\n/g, "\n");
    assert.match(prompts, /EXCEPTION — A TEST AND ITS FIX ARE ONE PHASE/);
    assert.match(prompts, /NEVER plan a phase that only writes a test meant to fail/);
  });
});
