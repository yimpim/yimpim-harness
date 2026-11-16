import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, validatePlan } from "../src/planner.js";

const phase = (id: string, executor: string, files: string[]) => ({
  id,
  name: id,
  executor,
  goal: `do ${id}`,
  files,
  changes: files.length ? ["change it"] : [],
  verification: ["it works"],
});

const planWith = (symptoms: unknown[], phases: unknown[]) =>
  parsePlan("```json\n" + JSON.stringify({ goal: "g", symptoms, phases }) + "\n```", "g").plan;

test("a symptom mapped only to a QA phase is rejected", () => {
  const plan = planWith(
    [{ symptom: "crypto toast", phases: [2] }],
    [phase("p1", "EDITOR", ["src/a.ts"]), phase("p2", "QA", [])]
  );
  const errors = validatePlan(plan);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /crypto toast/);
});

test("a symptom mapped to an EDITOR phase passes", () => {
  const plan = planWith(
    [{ symptom: "dropped events toast", likelyCause: "stale baseline", confidence: "suspected", phases: [1] }],
    [phase("p1", "EDITOR", ["src/a.ts"])]
  );
  assert.deepEqual(validatePlan(plan), []);
});

test("noCodeChangeBecause is accepted, and an unmapped symptom is not", () => {
  const ok = planWith(
    [{ symptom: "old APK installed", phases: [], noCodeChangeBecause: "user must reinstall the build" }],
    [phase("p1", "EDITOR", ["src/a.ts"])]
  );
  assert.deepEqual(validatePlan(ok), []);
  const bad = planWith([{ symptom: "desktop not responding", phases: [] }], [phase("p1", "EDITOR", ["src/a.ts"])]);
  assert.equal(validatePlan(bad).length, 1);
});

test("plans without symptoms are unaffected", () => {
  const plan = planWith([], [phase("p1", "EDITOR", ["src/a.ts"])]);
  assert.deepEqual(validatePlan(plan), []);
});

test("'the code already handles it' cannot dismiss a reported failure", () => {
  const plan = planWith(
    [{ symptom: "crypto toast in release", phases: [], noCodeChangeBecause: "the polyfill is already implemented in crypto.ts" }],
    [phase("p1", "EDITOR", ["src/a.ts"])]
  );
  const errors = validatePlan(plan);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /real build/);
});

test("an invalid causedBy is dropped, not a planning failure", () => {
  const plan = planWith(
    [
      { symptom: "crypto toast", phases: [1] },
      { symptom: "desktop not responding", phases: [1], causedBy: 1 },
      { symptom: "bad link", phases: [1], causedBy: 3 },
    ],
    [phase("p1", "EDITOR", ["src/a.ts"])]
  );
  const errors = validatePlan(plan);
  assert.equal(errors.length, 0);
  assert.equal(plan.symptoms[1].causedBy, 1);
  assert.equal(plan.symptoms[2].causedBy, undefined);
});
