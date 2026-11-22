/**
 * Limits agree with each other: the schema bounds the numbers, every reader falls back the same way (`??`, so a 0 means 0 and is refused by the schema where 0 is nonsense), the Repair
 * planner reads as many files as the normal planner, the doctor warns only past the default, and a phase reports the runs it actually took.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ConfigSchema } from "../src/config.js";
import { plannerReadBudget, PLANNER_MAX_INSPECTED_FILES, PLANNER_MIN_INSPECTED_FILES } from "../src/agentTools.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const parse = (limits: Record<string, unknown>) => ConfigSchema.safeParse({ limits });

describe("the schema bounds the numeric limits", () => {
  test("defaults: 40 rounds, 10 repair attempts, 3 visual-only", () => {
    const l = ConfigSchema.parse({}).limits;
    assert.equal(l.maxToolRounds, 40);
    assert.equal(l.maxRepairAttemptsPerPhase, 10);
    assert.equal(l.maxVisualOnlyRepairAttempts, 3);
  });
  test("0 repair attempts and 0 visual-only attempts are real settings (no repairs)", () => {
    assert.equal(parse({ maxRepairAttemptsPerPhase: 0 }).success, true);
    assert.equal(parse({ maxVisualOnlyRepairAttempts: 0 }).success, true);
  });
  test("0 rounds, 0 bytes, 0 search results, and fractions are refused, not silently turned into a default", () => {
    for (const bad of [{ maxToolRounds: 0 }, { maxFileBytes: 0 }, { maxSearchResults: 0 }, { maxRepairAttemptsPerPhase: 2.5 }, { maxToolRounds: -1 }]) assert.equal(parse(bad).success, false, JSON.stringify(bad));
  });
});

describe("every reader falls back the same way", () => {
  test("no `|| 3` or `|| 40` on a limit is left in index.ts or agentLoop.ts", () => {
    for (const f of ["src/index.ts", "src/agentLoop.ts"]) assert.doesNotMatch(src(f), /config\.limits\?*\.(maxToolRounds|maxRepairAttemptsPerPhase|maxVisualOnlyRepairAttempts)\s*\|\|/, f);
  });
  test("the code's fallbacks equal the schema defaults", () => {
    const idx = src("src/index.ts");
    assert.match(idx, /maxRepairAttemptsPerPhase \?\? 10/);
    assert.match(idx, /maxVisualOnlyRepairAttempts \?\? 3/);
    assert.match(src("src/agentLoop.ts"), /maxToolRounds \?\? 40/);
  });
});

describe("the Repair planner is not starved", () => {
  test("it is given the planner's read budget for its candidates, not the 5-file default", () => {
    assert.match(src("src/index.ts"), /beginPlannerInspection\(triageCandidateFiles, plannerReadBudget\(triageCandidateFiles\.length\)\)/);
    assert.ok(plannerReadBudget(0) >= PLANNER_MIN_INSPECTED_FILES && plannerReadBudget(0) > PLANNER_MAX_INSPECTED_FILES);
    assert.equal(plannerReadBudget(12), 12);
    assert.equal(plannerReadBudget(99), 30);
  });
});

describe("doctor and phase.end tell the truth", () => {
  test("the doctor warns only above the default of 10, not at the default", () => {
    const d = src("src/doctor.ts");
    assert.match(d, /maxRepairAttemptsPerPhase > 10/);
    assert.doesNotMatch(d, /maxRepairAttemptsPerPhase > 5/);
  });
  test("phase.end reports the verification runs the phase actually took, for a failed and a passed phase", () => {
    const idx = src("src/index.ts");
    assert.match(idx, /lastPhaseRuns = attempt \+ 1;/);
    assert.equal([...idx.matchAll(/attempts: lastPhaseRuns,/g)].length, 2);
    assert.doesNotMatch(idx, /attempts: config\.limits\.maxRepairAttemptsPerPhase \+ 1/);
  });
});
