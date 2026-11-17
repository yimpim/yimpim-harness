/** Test healing: finds red files, rewrites stale tests, leaves code bugs alone, never guts a test. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failingTestFiles, gutted, importedSources, healTests, renderHealReport } from "../src/testHeal.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "heal-"));
  fs.mkdirSync(path.join(dir, "__tests__"));
  fs.mkdirSync(path.join(dir, "src"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, s: string) => fs.writeFileSync(path.join(dir, rel), s);
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

describe("reading a runner's output", () => {
  test("jest, vitest and pytest failures name their files", () => {
    const out = [
      "\u001b[31mFAIL\u001b[0m __tests__/a.test.ts",
      " PASS __tests__/b.test.ts",
      "FAIL  tests/c.test.ts > does a thing",
      "FAILED tests/test_d.py::test_x - assert 1 == 2",
      "FAIL __tests__/a.test.ts",
    ].join("\n");
    assert.deepEqual(failingTestFiles(out).sort(), ["__tests__/a.test.ts", "tests/c.test.ts", "tests/test_d.py"]);
  });
});

describe("a rewrite may not gut the test", () => {
  const before = "it('a',()=>{expect(1).toBe(1);expect(2).toBe(2);expect(3).toBe(3);expect(4).toBe(4);expect(5).toBe(5)});";
  test("dropped assertions are refused", () => {
    assert.match(gutted(before, "it('a',()=>{expect(1).toBe(1)});") ?? "", /assertions/);
  });
  test("newly skipped tests are refused", () => {
    assert.match(gutted(before, before + "it.skip('b',()=>{});") ?? "", /skips/);
  });
  test("a fair update passes", () => {
    assert.equal(gutted(before, before.replace("toBe(5)", "toBe(6)")), undefined);
  });
});

test("imports resolve to the source files the test covers", () => {
  write("src/timeline.ts", "export const x = 1;");
  assert.deepEqual(importedSources(dir, "__tests__/t.test.ts", `import { x } from "../src/timeline";`), ["src/timeline.ts"]);
});

describe("healing", () => {
  // A fake runner: a test file passes once it no longer contains the word OLD.
  const run = async (root: string, files: string[]) => {
    const targets = files.length ? files : fs.readdirSync(path.join(root, "__tests__")).map((f) => "__tests__/" + f);
    const bad = targets.filter((f) => fs.readFileSync(path.join(root, f), "utf8").includes("OLD"));
    return { ok: bad.length === 0, output: bad.map((f) => `FAIL ${f}\n  ● broke\n    Expected: NEW\n    Received: OLD`).join("\n") };
  };

  test("a stale test is rewritten and the suite ends green", async () => {
    write("__tests__/a.test.ts", "expect(x).toBe('OLD');\r\nexpect(y).toBe(1);\r\n".repeat(3));
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async () => JSON.stringify({ verdict: "stale-test", reason: "output text changed", test: "expect(x).toBe('NEW');\nexpect(y).toBe(1);\n".repeat(3) }),
    });
    assert.equal(report.results[0].status, "healed");
    assert.ok(report.after?.ok);
    assert.ok(read("__tests__/a.test.ts").includes("\r\n"), "line endings are kept");
  });

  test("a code bug leaves the test exactly as it was and is reported", async () => {
    const original = "expect(x).toBe('OLD');\n";
    write("__tests__/b.test.ts", original);
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async () => JSON.stringify({ verdict: "code-bug", reason: "src/timeline.ts now drops the last item" }),
    });
    assert.equal(report.results[0].status, "code-bug");
    assert.equal(read("__tests__/b.test.ts"), original);
    assert.match(renderHealReport(report), /CODE is wrong[\s\S]*drops the last item/);
  });

  test("every failing file gets its own worker, started together", async () => {
    for (const n of ["a", "b", "c"]) write(`__tests__/${n}.test.ts`, "expect(x).toBe('OLD');\n");
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const allThere = new Promise<void>((r) => (release = r));
    await healTests({
      repoRoot: dir,
      run,
      call: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Held until all three workers are waiting on the model at once (or, if they were not run together, 3s).
        if (inFlight === 3) release();
        await Promise.race([allThere, new Promise((r) => setTimeout(r, 3000))]);
        inFlight--;
        return JSON.stringify({ verdict: "stale-test", reason: "r", test: "expect(x).toBe('NEW');\n" });
      },
    });
    assert.equal(peak, 3);
  });

  test("the same failure twice puts the file back and gives up", async () => {
    const original = "expect(x).toBe('OLD');\n";
    write("__tests__/d.test.ts", original);
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async () => JSON.stringify({ verdict: "stale-test", reason: "r", test: "expect(x).toBe('OLD');\n// tried\n" }),
    });
    assert.equal(report.results[0].status, "unhealed");
    assert.equal(read("__tests__/d.test.ts"), original);
  });

  test("an already-green suite is left alone", async () => {
    write("__tests__/e.test.ts", "expect(1).toBe(1);\n");
    const report = await healTests({ repoRoot: dir, run, call: async () => assert.fail("no model call expected") });
    assert.match(renderHealReport(report), /already green/);
  });
});
