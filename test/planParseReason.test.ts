/**
 * An unreadable plan used to be reported as "did not return a valid structured plan" whatever was wrong: the reason was handed to the
 * fallback and thrown away. Now the reason survives (no JSON, JSON that did not parse, JSON of the wrong shape and what was wrong), and the
 * cheap fix (the same plan, asked for again as JSON only) is tried before a full re-plan.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePlan } from "../src/planner.js";

const phase = {
  id: "phase-1",
  name: "Fix it",
  goal: "g",
  executor: "EDITOR",
  files: ["src/a.ts"],
  newFiles: [],
  changes: ["change a"],
  verification: ["it works"],
};
const good = JSON.stringify({ goal: "a goal", assumptions: [], clarifyingQuestions: [], suggestedBranch: null, phases: [phase] });

describe("why a plan could not be read", () => {
  test("a readable plan has no reason", () => {
    const r = parsePlan(good, "fallback");
    assert.equal(r.degraded, false);
    assert.equal(r.degradedReason, undefined);
  });
  test("prose with no plan in it", () => {
    const r = parsePlan("I have looked at the files and I think the fix is to normalize the state. Let me know if you want more detail.", "fallback");
    assert.equal(r.degraded, true);
    assert.match(r.degradedReason ?? "", /no JSON object found/);
  });
  test("JSON cut off before its end says so, in one of the two ways a cut-off reply fails", () => {
    const r = parsePlan(good.slice(0, Math.floor(good.length * 0.6)), "fallback");
    assert.equal(r.degraded, true);
    assert.match(r.degradedReason ?? "", /no JSON object found|JSON did not parse/);
  });
  test("JSON of the wrong shape says what was wrong", () => {
    const r = parsePlan(JSON.stringify({ goal: "x", phases: "not a list" }), "fallback");
    assert.equal(r.degraded, true);
    assert.match(r.degradedReason ?? "", /^JSON did not match the plan shape: /);
    assert.match(r.degradedReason ?? "", /phases/);
  });
  test("the fallback still has its single phase and the raw reply", () => {
    const r = parsePlan("nope", "the goal");
    assert.equal(r.plan.phases.length, 1);
    assert.equal(r.plan.goal, "the goal");
    assert.equal(r.raw, "nope");
  });
});

describe("what happens when it cannot be read", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("the console says why and what the reply looked like, and the reply is kept for a person to read", () => {
    assert.ok(src.includes("The reply was not a readable plan: ${parsed.degradedReason"));
    assert.ok(src.includes('".agent", "planner-raw.txt"'));
  });
  test("the cheap ask (the same plan, JSON only) comes before the full corrective re-plan", () => {
    const cheap = src.indexOf("Asking once for the same plan as JSON only.");
    const reask = src.indexOf("planOutput = await reaskJsonOnly(planOutput);", cheap);
    const corrective = src.indexOf('reason: "Plan lacks surgical scope"', cheap);
    assert.ok(cheap > 0 && reask > cheap && corrective > reask, "reask, then (only if still unreadable or still vague) the full pass");
  });
  test("a plan that is readable after the cheap ask goes on without the expensive pass if it has no other defects", () => {
    assert.ok(src.includes("[PLANNER] ✓ That one was readable."));
    assert.ok(src.includes("...validatePlan(activePlan, verifyOnly),"));
  });
  test("the failure messages carry the reason", () => {
    assert.ok(src.includes("Planner did not return a valid structured plan (${parsed.degradedReason"));
    assert.ok(src.includes("Corrective Planner pass did not return a valid structured plan (${parsed.degradedReason"));
  });
});
