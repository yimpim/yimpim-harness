/** The test log: what ran green when, what is unchanged since, and heal skipping or reusing accordingly. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordRun, unchangedGreen, loadLog, renderLog, verdictFor, saveVerdict } from "../src/testLog.js";
import { passingTestFiles } from "../src/testRun.js";
import { healTests } from "../src/testHeal.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-"));
  write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "export const b = 1;");
  write("__tests__/a.test.ts", `import { a } from "../src/a";\nexpect(a).toBe(1);`);
  write("__tests__/b.test.ts", `import { b } from "../src/b";\nexpect(b).toBe(1);`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const allGreen = () => recordRun(dir, [], { ok: true, output: "" });
const tests = ["__tests__/a.test.ts", "__tests__/b.test.ts"];

describe("what a run teaches the log", () => {
  test("PASS and FAIL lines are read per file, backslashes included", () => {
    assert.deepEqual(passingTestFiles("PASS __tests__\\a.test.ts\n PASS  ui  __tests__/b.test.ts\nFAIL __tests__/c.test.ts"), ["__tests__/a.test.ts", "__tests__/b.test.ts"]);
    recordRun(dir, [], { ok: false, output: "PASS __tests__/a.test.ts\nFAIL __tests__/b.test.ts\n  ● x" });
    const log = loadLog(dir);
    assert.equal(log.files["__tests__/a.test.ts"].result, "green");
    assert.equal(log.files["__tests__/b.test.ts"].result, "red");
    assert.ok(log.files["__tests__/a.test.ts"].greenAt);
  });
  test("a run that names no file proves nothing", () => {
    recordRun(dir, [], { ok: false, output: "npm ERR! missing script" });
    assert.deepEqual(loadLog(dir).files, {});
  });
  test("a clean run of named files marks exactly those green", () => {
    recordRun(dir, ["__tests__/a.test.ts"], { ok: true, output: "" });
    assert.deepEqual(Object.keys(loadLog(dir).files), ["__tests__/a.test.ts"]);
  });
});

describe("unchanged since the last green run means nothing it depends on changed", () => {
  test("an edit to the SOURCE a test imports invalidates it, even though the test file is untouched", () => {
    allGreen();
    assert.deepEqual([...unchangedGreen(dir, tests)].sort(), tests);
    write("src/a.ts", "export const a = 2;");
    assert.deepEqual([...unchangedGreen(dir, tests)], ["__tests__/b.test.ts"]);
  });
  test("an edit to an unrelated file leaves them", () => {
    allGreen();
    write("src/unrelated.ts", "export const z = 1;");
    assert.equal(unchangedGreen(dir, tests).size, 2);
  });
  test("an edit two imports away counts", () => {
    write("src/deep.ts", "export const d = 1;");
    write("src/a.ts", `import { d } from "./deep";\nexport const a = d;`);
    allGreen();
    write("src/deep.ts", "export const d = 2;");
    assert.ok(!unchangedGreen(dir, tests).has("__tests__/a.test.ts"));
  });
  test("a change to the lockfile or test config invalidates everything", () => {
    allGreen();
    write("package.json", JSON.stringify({ scripts: { test: "jest" }, dependencies: { x: "2" } }));
    assert.equal(unchangedGreen(dir, tests).size, 0);
  });
  test("a test with an import that cannot be resolved is never skipped", () => {
    write("__tests__/odd.test.ts", `import x from "./not-there";\nexpect(1).toBe(1);`);
    allGreen();
    assert.ok(!unchangedGreen(dir, [...tests, "__tests__/odd.test.ts"]).has("__tests__/odd.test.ts"));
  });
  test("a red result is never unchanged-green", () => {
    recordRun(dir, [], { ok: false, output: "FAIL __tests__/a.test.ts\nPASS __tests__/b.test.ts" });
    assert.deepEqual([...unchangedGreen(dir, tests)], ["__tests__/b.test.ts"]);
  });
  test("the readable log says which is which", () => {
    allGreen();
    write("src/a.ts", "export const a = 2;");
    const text = renderLog(dir);
    assert.match(text, /1 green and unchanged, 1 green before a change/);
    assert.match(text, /but something it depends on changed since\s+__tests__\/a\.test\.ts/);
  });
});

describe("heal uses the log", () => {
  const failing = (f: string) => `FAIL ${f}\n  ● x\n    Expected: 1`;

  test("tests unchanged since green are not rerun, and nothing red means nothing to heal", async () => {
    allGreen();
    let called = false;
    const report = await healTests({ repoRoot: dir, run: async () => ((called = true), { ok: true, output: "" }), call: async () => assert.fail("no model call") });
    assert.equal(called, false);
    assert.equal(report.unchanged, 2);
  });

  test("only the tests that could have changed result are run", async () => {
    allGreen();
    write("src/a.ts", "export const a = 2;");
    const seen: string[][] = [];
    await healTests({ repoRoot: dir, run: async (_r, files) => (seen.push(files), { ok: true, output: "" }), call: async () => assert.fail("no model call") });
    assert.deepEqual(seen[0], ["__tests__/a.test.ts"]);
  });

  test("`all` ignores the log and runs everything", async () => {
    allGreen();
    const seen: string[][] = [];
    await healTests({ repoRoot: dir, all: true, run: async (_r, files) => (seen.push(files), { ok: true, output: "" }), call: async () => assert.fail("no model call") });
    assert.deepEqual(seen[0], []);
  });

  test("a diagnosis is reused until something the test depends on changes", async () => {
    let calls = 0;
    const opts = {
      repoRoot: dir,
      run: async () => ({ ok: false, output: failing("__tests__/a.test.ts") }),
      call: async () => ((calls++, JSON.stringify({ verdict: "code-bug", reason: "a.ts returns the wrong value" }))),
      settle: false,
    };
    const first = await healTests(opts);
    assert.equal(first.results[0].status, "code-bug");
    const callsAfterFirst = calls;
    const second = await healTests(opts);
    assert.equal(calls, callsAfterFirst, "no model call the second time");
    assert.match(second.results[0].note, /nothing it depends on changed/);
    write("src/a.ts", "export const a = 3;");
    await healTests(opts);
    assert.ok(calls > callsAfterFirst, "diagnosed again once the code changed");
  });

  test("a diagnosis from older healing logic is not trusted", () => {
    saveVerdict(dir, "__tests__/a.test.ts", { status: "code-bug", note: "n" });
    assert.ok(verdictFor(dir, "__tests__/a.test.ts"));
    const log = loadLog(dir);
    log.files["__tests__/a.test.ts"].verdict!.version = 0;
    fs.writeFileSync(path.join(dir, ".agent", "test-log.json"), JSON.stringify(log));
    assert.equal(verdictFor(dir, "__tests__/a.test.ts"), undefined);
  });

  test("going green clears the stored diagnosis", () => {
    saveVerdict(dir, "__tests__/a.test.ts", { status: "code-bug", note: "n" });
    recordRun(dir, ["__tests__/a.test.ts"], { ok: true, output: "" });
    assert.equal(loadLog(dir).files["__tests__/a.test.ts"].verdict, undefined);
  });
});

import { selectUnverified } from "../src/testLog.js";

describe("a phase that changed nothing still runs tests", () => {
  test("with nothing logged, every test runs (a verify-only phase is never left without test evidence)", () => {
    const sel = selectUnverified(dir);
    assert.deepEqual(sel.selected.sort(), tests);
    assert.deepEqual(sel.skipped, []);
  });
  test("tests unchanged since green are skipped, the rest run", () => {
    allGreen();
    write("src/a.ts", "export const a = 2;");
    const sel = selectUnverified(dir);
    assert.deepEqual(sel.selected, ["__tests__/a.test.ts"]);
    assert.deepEqual(sel.skipped, ["__tests__/b.test.ts"]);
  });
  test("a red test is always selected", () => {
    recordRun(dir, [], { ok: false, output: "FAIL __tests__/a.test.ts\nPASS __tests__/b.test.ts" });
    assert.deepEqual(selectUnverified(dir).selected, ["__tests__/a.test.ts"]);
  });
});

import { staleSince } from "../src/testLog.js";

describe("tests gone stale outside the current change are found now", () => {
  test("a test never logged is not stale: a first run is not 'everything'", () => {
    assert.deepEqual(staleSince(dir), []);
  });
  test("a logged test whose source changed since it last ran is stale; one that did not change is not", () => {
    allGreen();
    write("src/a.ts", "export const a = 2;");
    assert.deepEqual(staleSince(dir), ["__tests__/a.test.ts"]);
  });
  test("a red test whose dependencies changed since (it may be fixed) is stale; a red one that did not change is not", () => {
    recordRun(dir, [], { ok: false, output: "FAIL __tests__/a.test.ts\nFAIL __tests__/b.test.ts" });
    write("src/b.ts", "export const b = 2;");
    assert.deepEqual(staleSince(dir), ["__tests__/b.test.ts"]);
  });
  test("tests the change already selects are not listed twice", () => {
    allGreen();
    write("src/a.ts", "export const a = 2;");
    assert.deepEqual(staleSince(dir, ["__tests__/a.test.ts"]), []);
  });
});

describe("a helper in the test folder is not logged as a green test", () => {
  test("a clean full run logs only the files the runner reported passing", () => {
    write("__tests__/e2e/harness.ts", "export const helper = 1;");
    recordRun(dir, [], { ok: true, output: "PASS __tests__/a.test.ts\nPASS __tests__/b.test.ts" });
    const files = Object.keys(loadLog(dir).files).sort();
    assert.deepEqual(files, ["__tests__/a.test.ts", "__tests__/b.test.ts"]);
    write("src/a.ts", "export const a = 2;");
    assert.deepEqual(staleSince(dir), ["__tests__/a.test.ts"], "the helper is never listed as stale");
  });
});

import { recordHealOutcome, healParked, HEAL_PARK_AT } from "../src/testLog.js";

describe("a test that cannot be healed is not paid for again in every phase", () => {
  const red = () => recordRun(dir, [], { ok: false, output: "FAIL __tests__/a.test.ts\nPASS __tests__/b.test.ts" });
  const A = "__tests__/a.test.ts";

  test("one real failure to fix it parks it", () => {
    red();
    assert.equal(healParked(dir, A), false);
    recordHealOutcome(dir, A, { status: "unhealed", note: "the same failure came back, so the file was put back as it was" });
    assert.equal(healParked(dir, A), true);
  });
  test("a model call that failed outright takes two to park it, since it says nothing about the test", () => {
    red();
    recordHealOutcome(dir, A, { status: "unhealed", note: "the model call failed: terminated" });
    assert.equal(healParked(dir, A), false);
    recordHealOutcome(dir, A, { status: "unhealed", note: "the model call failed: terminated" });
    assert.equal(healParked(dir, A), true);
    assert.equal(HEAL_PARK_AT, 2);
  });
  test("a fix clears it", () => {
    red();
    recordHealOutcome(dir, A, { status: "code-bug", note: "the code is wrong" });
    assert.equal(healParked(dir, A), true);
    recordHealOutcome(dir, A, { status: "healed", note: "updated" });
    assert.equal(healParked(dir, A), false);
    assert.equal(loadLog(dir).files[A].healStrikes, undefined);
  });
  test("passing again clears it", () => {
    red();
    recordHealOutcome(dir, A, { status: "code-bug", note: "x" });
    allGreen();
    assert.equal(healParked(dir, A), false);
    assert.equal(loadLog(dir).files[A].healStrikes, undefined);
  });
  test("it stays parked as the code around it changes, which is what happens in every phase", () => {
    red();
    recordHealOutcome(dir, A, { status: "unhealed", note: "same failure" });
    write("src/a.ts", "export const a = 99;");
    assert.equal(healParked(dir, A), true, "the fingerprint changed, the test file did not");
  });
  test("but editing the test file itself tries it again", () => {
    red();
    recordHealOutcome(dir, A, { status: "unhealed", note: "same failure" });
    write(A, `import { a } from "../src/a";\nexpect(a).toBe(2);`);
    assert.equal(healParked(dir, A), false);
  });
  test("a test never logged has nothing to park, and a green one is never parked", () => {
    recordHealOutcome(dir, "__tests__/never.test.ts", { status: "unhealed", note: "x" });
    assert.equal(healParked(dir, "__tests__/never.test.ts"), false);
    allGreen();
    assert.equal(healParked(dir, A), false);
  });
  test("/tests log says so", () => {
    red();
    recordHealOutcome(dir, A, { status: "unhealed", note: "same failure" });
    assert.match(renderLog(dir), /not retried in phases: healing failed; \/tests heal tries again/);
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("every heal outcome is recorded, and the phase gate retries only tests that are not parked", () => {
    assert.match(read("../src/testHeal.ts"), /recordHealOutcome\(opts\.repoRoot, r\.file, r\)/);
    const gate = read("../src/verifierTools.ts");
    assert.match(gate, /const parked = already\.filter\(\(f\) => healParked\(this\.repoRoot, f\)\);/);
    assert.match(gate, /files: retry, call/);
  });
});
