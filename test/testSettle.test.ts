/** Ending a red test for good: removal with every reference, rewrite-or-delete, and removal after a failed code fix. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTest, savePendingFixes, loadPendingFixes, settlePendingFixes, fixTaskFor, isFixTask } from "../src/testSettle.js";
import { healTests, renderHealReport } from "../src/testHeal.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settle-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const has = (rel: string) => fs.existsSync(path.join(dir, rel));

describe("removing a test takes everything pointing at it", () => {
  test("the file, its snapshot, and the lines that only point at it", () => {
    write("__tests__/old.test.ts", "expect(1).toBe(1);");
    write("__tests__/__snapshots__/old.test.ts.snap", "snap");
    write("__tests__/keep.test.ts", "expect(2).toBe(2);");
    write("jest.config.json", `{\n  "testMatch": [\n    "__tests__/keep.test.ts",\n    "__tests__/old.test.ts"\n  ]\n}`.replace(`"__tests__/keep.test.ts",`, `"__tests__/keep.test.ts",`));
    write("__tests__/e2e/index.ts", `import "../old.test";\nimport "../keep.test";\nexport const x = 1;\n`);
    write("docs/TESTING.md", "# Tests\n- __tests__/old.test.ts covers the old flow\n- __tests__/keep.test.ts covers the rest\n");
    const r = removeTest(dir, "__tests__/old.test.ts");
    assert.ok(!has("__tests__/old.test.ts") && !has("__tests__/__snapshots__"));
    assert.ok(!/old\.test/.test(read("__tests__/e2e/index.ts")));
    assert.ok(read("__tests__/e2e/index.ts").includes('import "../keep.test"'));
    assert.ok(!/old\.test/.test(read("docs/TESTING.md")) && read("docs/TESTING.md").includes("keep.test"));
    assert.deepEqual(r.leftover, []);
  });
  test("a JSON list that would break is left alone and reported", () => {
    write("__tests__/old.test.ts", "x");
    write("cfg.json", `{"a":"__tests__/old.test.ts"}`);
    const r = removeTest(dir, "__tests__/old.test.ts");
    assert.equal(read("cfg.json"), `{"a":"__tests__/old.test.ts"}`);
    assert.ok(r.leftover.length > 0);
  });
  test("a mention inside real code is reported, not rewritten", () => {
    write("__tests__/old.test.ts", "x");
    write("src/runner.ts", `export const run = () => loadSuite("__tests__/old.test.ts", { retries: 2 });\n`);
    const r = removeTest(dir, "__tests__/old.test.ts");
    assert.ok(read("src/runner.ts").includes("loadSuite"));
    assert.ok(r.leftover.some((l) => l.startsWith("src/runner.ts")));
  });
});

describe("a test that cannot be healed gets a decision", () => {
  const run = async (root: string, files: string[]) => {
    const targets = files.length ? files : fs.readdirSync(path.join(root, "__tests__")).filter((f) => f.endsWith(".ts")).map((f) => "__tests__/" + f);
    const bad = targets.filter((f) => fs.readFileSync(path.join(root, f), "utf8").includes("BROKEN"));
    return { ok: bad.length === 0, output: bad.map((f) => `FAIL ${f}\n  ● Test suite failed to run\n    Cannot find module 'x'`).join("\n") };
  };
  const unclear = JSON.stringify({ verdict: "unclear", reason: "cannot tell" });

  test("rewritten from scratch when the feature still exists", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) =>
        label.startsWith("Settle") ? JSON.stringify({ decision: "rewrite", reason: "feature exists", test: "expect(1).toBe(1);\n" }) : unclear,
    });
    assert.equal(report.results[0].status, "rewritten");
    assert.ok(report.after?.ok);
    assert.match(renderHealReport(report), /Rewritten from scratch/);
  });

  test("a rewrite that still fails is removed instead", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) =>
        label.startsWith("Settle") ? JSON.stringify({ decision: "rewrite", reason: "r", test: "BROKEN expect(1).toBe(1);\n" }) : unclear,
    });
    assert.equal(report.results[0].status, "removed");
    assert.ok(!has("__tests__/t.test.ts"));
  });

  test("deleted when obsolete", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) => (label.startsWith("Settle") ? JSON.stringify({ decision: "delete", reason: "feature was removed" }) : unclear),
    });
    assert.equal(report.results[0].status, "removed");
    assert.ok(!has("__tests__/t.test.ts"));
    assert.match(read(".agent/removed-tests.json"), /feature was removed/);
  });

  test("an unreachable model never removes anything", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) => {
        if (label.startsWith("Settle")) throw new Error("network");
        return unclear;
      },
    });
    assert.equal(report.results[0].status, "unclear");
    assert.ok(has("__tests__/t.test.ts"));
  });

  test("a test that loads and fails on behaviour is kept and left for a person, never settled away and never sent to guess at the code", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(started).toBe(true);\n");
    const behaviour = async (root: string, files: string[]) => {
      const targets = files.length ? files : ["__tests__/t.test.ts"];
      const bad = targets.filter((f) => fs.readFileSync(path.join(root, f), "utf8").includes("BROKEN"));
      return { ok: bad.length === 0, output: bad.map((f) => `FAIL ${f}\n  ● it starts\n    expect(received).toBe(expected)\n    Expected: true\n    Received: false`).join("\n") };
    };
    const report = await healTests({
      repoRoot: dir,
      run: behaviour,
      call: async () => JSON.stringify({ verdict: "unclear", reason: "cannot tell why it does not start" }),
    });
    assert.equal(report.results[0].status, "unclear");
    assert.ok(has("__tests__/t.test.ts"), "the test is kept");
    assert.ok(!has(".agent/removed-tests.json"));
  });

  test("a code defect is not deleted by the settle step", async () => {
    write("__tests__/t.test.ts", "BROKEN expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async () => JSON.stringify({ verdict: "code-bug", reason: "eventLog.keyOf is wrong" }),
    });
    assert.equal(report.results[0].status, "code-bug");
    assert.ok(has("__tests__/t.test.ts"));
  });
});

describe("after the code fix attempt", () => {
  test("a pending test that passes stays; one in which NOTHING passes and that still fails is removed and its finding is kept", async () => {
    write("__tests__/fixed.test.ts", "ok");
    write("__tests__/still.test.ts", "BROKEN");
    savePendingFixes(dir, [
      { file: "__tests__/fixed.test.ts", reason: "a" },
      { file: "__tests__/still.test.ts", reason: "keyOf drops the id" },
    ]);
    const lines = await settlePendingFixes(dir, async (root, files) => {
      const broken = fs.readFileSync(path.join(root, files[0]), "utf8").includes("BROKEN");
      return { ok: !broken, output: broken ? "Tests:       3 failed, 3 total" : "" };
    });
    assert.ok(has("__tests__/fixed.test.ts") && !has("__tests__/still.test.ts"));
    assert.equal(lines.length, 2);
    assert.match(read(".agent/removed-tests.json"), /keyOf drops the id/);
    assert.deepEqual(loadPendingFixes(dir), []);
  });
  test("only the fix task's own end triggers it", () => {
    const task = fixTaskFor([{ file: "a.test.ts", reason: "r", failure: "Expected: true\nReceived: false" }]);
    assert.ok(isFixTask(task));
    assert.match(task, /How it fails:\n\s+Expected: true/);
    assert.ok(!isFixTask("add a settings screen"));
    assert.match(task, /Do not edit, skip or delete these tests/);
  });
});

describe("an assertion about null is a behaviour failure, not an environment one", () => {
  test("it is kept and left for a person, never settled away", async () => {
    write("__tests__/n.test.ts", "BROKEN expect(x).not.toBeNull();\n");
    const report = await healTests({
      repoRoot: dir,
      run: async (root) => {
        const bad = fs.readFileSync(path.join(root, "__tests__/n.test.ts"), "utf8").includes("BROKEN");
        return { ok: !bad, output: bad ? "FAIL __tests__/n.test.ts\n  ● returns a value\n    Expected: not null\n    Received: value is null" : "" };
      },
      call: async () => JSON.stringify({ verdict: "unclear", reason: "cannot tell" }),
    });
    assert.equal(report.results[0].status, "unclear");
    assert.ok(fs.existsSync(path.join(dir, "__tests__/n.test.ts")));
  });
});

import { testCounts } from "../src/testSettle.js";

describe("a test file is removed only when nothing in it passes", () => {
  const stillRed = (output: string) => async () => ({ ok: false, output });
  const setup = () => {
    write("__tests__/dash.test.ts", "BROKEN");
    savePendingFixes(dir, [{ file: "__tests__/dash.test.ts", reason: "the code derives the activity from the raw state" }]);
  };
  test("one that still fails in part is KEPT: 150 working tests are not thrown away over 14 failing ones", async () => {
    setup();
    const lines = await settlePendingFixes(dir, stillRed("Tests:       14 failed, 150 passed, 164 total"));
    assert.ok(has("__tests__/dash.test.ts"));
    assert.match(lines[0], /still fails after the fix attempt \(14 of 164 tests\), but 150 of its tests pass, so it was kept and not removed/);
    assert.match(lines[0], /the code derives the activity/);
    assert.deepEqual(loadPendingFixes(dir), []);
    assert.equal(fs.existsSync(path.join(dir, ".agent/removed-tests.json")), false, "nothing was recorded as removed");
  });
  test("one whose runner gives no counts is kept too: nothing is known to be worth losing or not", async () => {
    setup();
    const lines = await settlePendingFixes(dir, stillRed("something failed, no summary here"));
    assert.ok(has("__tests__/dash.test.ts"));
    assert.match(lines[0], /counts could not be read, so it was kept/);
  });
  test("one where nothing passes is still removed, as before", async () => {
    setup();
    const lines = await settlePendingFixes(dir, stillRed("Tests:       5 failed, 5 total"));
    assert.ok(!has("__tests__/dash.test.ts"));
    assert.match(lines[0], /still fails after the fix attempt, so it was/);
  });
  test("a suite that could not run at all (no tests ran) counts as nothing passing", async () => {
    setup();
    await settlePendingFixes(dir, stillRed("Test suite failed to run\nTests:       0 total"));
    assert.ok(!has("__tests__/dash.test.ts"));
  });
});

describe("reading a runner's counts", () => {
  test("Jest and Vitest", () => {
    assert.deepEqual(testCounts("Tests:       14 failed, 150 passed, 164 total"), { failed: 14, passed: 150 });
    assert.deepEqual(testCounts("Tests:  3 failed | 12 passed (15)"), { failed: 3, passed: 12 });
    assert.deepEqual(testCounts(" Tests  1 failed | 4 passed (5)"), { failed: 1, passed: 4 });
    assert.deepEqual(testCounts("Tests:       5 failed, 5 total"), { failed: 5, passed: 0 });
    assert.deepEqual(testCounts("\u001b[1mTests:\u001b[22m       2 failed, 8 passed, 10 total"), { failed: 2, passed: 8 });
  });
  test("pytest", () => {
    assert.deepEqual(testCounts("=========== 2 failed, 8 passed in 3.41s ==========="), { failed: 2, passed: 8 });
    assert.deepEqual(testCounts("====== 4 passed in 0.12s ======"), { failed: 0, passed: 4 });
  });
  test("Mocha", () => {
    assert.deepEqual(testCounts("  150 passing (2s)\n  14 failing"), { failed: 14, passed: 150 });
  });
  test("output with no summary is unknown, not zero", () => {
    assert.equal(testCounts("boom"), undefined);
  });
});
