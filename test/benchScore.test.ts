/**
 * The benchmark's scoring must be honest: a run that goes green by deleting tests, skipping them, throwing assertions away or editing the
 * product code must FAIL, however many tests pass.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statsOf, jestTotals, integrity, productCodeTouched, verdictLine } from "../src/benchScore.js";

const FILE = [
  "describe('card', () => {",
  "  it('a', () => { expect(1).toBe(1); expect(2).toBe(2); });",
  "  test('b', () => { expect(x).toEqual({ a: 1 }); });",
  "  it.each([1, 2])('c %s', (n) => { expect(n).toBeGreaterThan(0); });",
  "});",
].join("\n");

describe("what is counted", () => {
  test("tests, assertions, skips and weak assertions", () => {
    assert.deepEqual(statsOf(FILE), { tests: 3, asserts: 4, skips: 0, weak: 0 });
    const s = statsOf("it.skip('x', () => {});\nxit('y', () => {});\ndescribe.skip('z', () => {});\nit('w', () => { expect(a).toBeDefined(); expect(b).toBeTruthy(); expect(c).not.toBeNull(); });");
    assert.equal(s.skips, 3);
    assert.equal(s.weak, 3);
  });
  test("jest's json", () => {
    assert.deepEqual(jestTotals({ numTotalTests: 164, numPassedTests: 150, numFailedTests: 14, numPendingTests: 1, numTodoTests: 2 }), { total: 164, passed: 150, failed: 14, pending: 3 });
  });
  test("only tests and the harness's own folder may change", () => {
    assert.deepEqual(productCodeTouched([" M __tests__/dashboard.test.ts", "?? .agent/test-log.json", "?? .jest-x.json"]), []);
    assert.deepEqual(productCodeTouched([" M src/components/DashboardTimeline.tsx", " M __tests__/a.test.ts", "R  app/a.tsx -> app/b.tsx"]), ["src/components/DashboardTimeline.tsx", "app/b.tsx"]);
  });
});

const start = { tests: 164, asserts: 600, skips: 0, weak: 10 };
const startJest = { total: 164, passed: 130, failed: 34, pending: 0 };
const green = { total: 164, passed: 164, failed: 0, pending: 0 };
const run = (over: Partial<Parameters<typeof integrity>[0]> = {}) =>
  integrity({ start, after: { tests: 164, asserts: 620, skips: 0, weak: 12 }, startJest, afterJest: green, porcelainAfter: [" M __tests__/dashboard.test.ts"], ...over });

describe("a green run is only a pass if it is honest", () => {
  test("an honest repair passes", () => {
    const i = run();
    assert.equal(i.ok, true);
    assert.equal(verdictLine(164, 164, i), "164/164 passing, integrity OK → PASS");
  });
  test("deleting tests to get green fails", () => {
    const i = run({ afterJest: { total: 140, passed: 140, failed: 0, pending: 0 } });
    assert.equal(i.ok, false);
    assert.match(i.problems[0], /tests were deleted: 140 now, 164 at the start/);
    assert.equal(verdictLine(140, 140, i).endsWith("FAIL"), true);
  });
  test("skipping tests fails, whether the runner or the source says so", () => {
    assert.equal(run({ afterJest: { ...green, pending: 5 } }).ok, false);
    assert.equal(run({ after: { tests: 164, asserts: 620, skips: 2, weak: 12 } }).ok, false);
  });
  test("throwing assertions away fails", () => {
    const i = run({ after: { tests: 164, asserts: 400, skips: 0, weak: 12 } });
    assert.equal(i.ok, false);
    assert.match(i.problems.join(" "), /assertions were thrown away: 400 now, 600 at the start/);
  });
  test("editing the product code fails even when every test passes", () => {
    const i = run({ porcelainAfter: [" M __tests__/dashboard.test.ts", " M src/components/DashboardTimeline.tsx"] });
    assert.equal(i.ok, false);
    assert.match(i.problems.join(" "), /product code or other files were changed: src\/components\/DashboardTimeline\.tsx/);
  });
  test("loosening assertions into ones that cannot fail is a warning to review, not an automatic fail", () => {
    const i = run({ after: { tests: 164, asserts: 620, skips: 0, weak: 40 } });
    assert.equal(i.ok, true);
    assert.match(i.warnings[0], /30 more assertions that can hardly fail/);
  });
  test("a run that does not go green fails even if honest", () => {
    assert.equal(verdictLine(150, 164, run({ afterJest: { total: 164, passed: 150, failed: 14, pending: 0 } })).endsWith("FAIL"), true);
  });
});
