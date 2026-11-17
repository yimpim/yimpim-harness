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
    // A behaviour failure the worker could not fix goes to the code fix rather than being given up on; the test is as it was.
    assert.equal(report.results[0].status, "code-bug");
    assert.equal(read("__tests__/d.test.ts"), original);
  });

  test("an already-green suite is left alone", async () => {
    write("__tests__/e.test.ts", "expect(1).toBe(1);\n");
    const report = await healTests({ repoRoot: dir, run, call: async () => assert.fail("no model call expected") });
    assert.match(renderHealReport(report), /already green/);
  });
});

import { failureSignature } from "../src/testHeal.js";

describe("shared causes, missing files and helpers", () => {
  const nativeErr = "Error: [@RNC/AsyncStorage]: NativeModule: AsyncStorage is null.";
  // Each test file fails until jest.setup.js mocks the native module.
  const run = async (root: string, files: string[]) => {
    const mocked = fs.existsSync(path.join(root, "jest.setup.js")) && fs.readFileSync(path.join(root, "jest.setup.js"), "utf8").includes("MOCK");
    const targets = files.length ? files : fs.readdirSync(path.join(root, "__tests__")).map((f) => "__tests__/" + f);
    const bad = mocked ? [] : targets;
    return { ok: bad.length === 0, output: bad.map((f) => `FAIL ${f}\n  ● suite failed to run\n    ${nativeErr}`).join("\n") };
  };

  test("the signature ignores what differs between files", () => {
    assert.equal(failureSignature("FAIL a\n  Error: x 12 at line 4"), failureSignature("FAIL b\n  Error: x 99 at line 8"));
  });

  test("several files with one error get one setup fix, not one 'code bug' each", async () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    write("jest.setup.js", "// setup\n");
    for (const n of ["a", "b", "c"]) write(`__tests__/${n}.test.ts`, "expect(1).toBe(1);\n");
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) =>
        label.startsWith("Shared test setup")
          ? JSON.stringify({ cause: "AsyncStorage had no Jest mock", edits: [{ file: "jest.setup.js", content: "// setup\njest.mock('async-storage'); // MOCK\n" }] })
          : JSON.stringify({ verdict: "code-bug", reason: "module fails to load" }),
    });
    assert.deepEqual(report.results.map((r) => r.status), ["healed", "healed", "healed"]);
    assert.match(report.results[0].note, /shared fix in jest\.setup\.js.*AsyncStorage/);
    assert.ok(report.after?.ok);
  });

  test("a setup change that fixes nothing is put back", async () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    write("jest.setup.js", "// setup\n");
    for (const n of ["a", "b"]) write(`__tests__/${n}.test.ts`, "expect(1).toBe(1);\n");
    await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) =>
        label.startsWith("Shared test setup")
          ? JSON.stringify({ cause: "x", edits: [{ file: "jest.setup.js", content: "// nothing useful\n" }] })
          : JSON.stringify({ verdict: "code-bug", reason: "r" }),
    });
    assert.equal(read("jest.setup.js"), "// setup\n");
  });

  test("a shared fix may not rewrite application code", async () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    write("src/app.ts", "export const a = 1;\n");
    for (const n of ["a", "b"]) write(`__tests__/${n}.test.ts`, "expect(1).toBe(1);\n");
    await healTests({
      repoRoot: dir,
      run,
      call: async (_m, label) =>
        label.startsWith("Shared test setup")
          ? JSON.stringify({ cause: "x", edits: [{ file: "src/app.ts", content: "// gone\n" }] })
          : JSON.stringify({ verdict: "code-bug", reason: "r" }),
    });
    assert.equal(read("src/app.ts"), "export const a = 1;\n");
  });

  test("a worker can ask for a file it was not shown and then decide", async () => {
    write("src/Widget.tsx", "export const label = 'NEW';\n");
    write("__tests__/w.test.ts", "expect(label).toBe('OLD');\n");
    const asked: string[] = [];
    let n = 0;
    const report = await healTests({
      repoRoot: dir,
      run: async (root, files) => {
        const bad = fs.readFileSync(path.join(root, "__tests__/w.test.ts"), "utf8").includes("OLD");
        return { ok: !bad, output: bad ? "FAIL __tests__/w.test.ts\n  ● x\n    Expected: NEW\n    Received: OLD" : "" };
      },
      call: async (messages) => {
        n++;
        if (n === 1) return JSON.stringify({ need: ["src/Widget.tsx", "src/missing.tsx"] });
        asked.push(messages[messages.length - 1].content);
        return JSON.stringify({ verdict: "stale-test", reason: "label changed", test: "expect(label).toBe('NEW');\n" });
      },
    });
    assert.match(asked[0], /export const label = 'NEW'/);
    assert.equal(report.results[0].status, "healed");
  });

  test("a helper inside the tests folder is named as such, with no model call", async () => {
    write("__tests__/helper.test.ts", "export const h = 1;\n");
    const report = await healTests({
      repoRoot: dir,
      files: ["__tests__/helper.test.ts"],
      run: async () => ({ ok: false, output: "FAIL __tests__/helper.test.ts\n  Your test suite must contain at least one test." }),
      call: async () => assert.fail("no model call expected"),
    });
    assert.match(report.results[0].note, /testPathIgnorePatterns/);
  });
});

describe("a reply that is not the JSON asked for", () => {
  const badRun = async (root: string) => {
    const bad = fs.readFileSync(path.join(root, "__tests__/m.test.ts"), "utf8").includes("OLD");
    return { ok: !bad, output: bad ? "FAIL __tests__/m.test.ts\n  ● x\n    Expected: NEW\n    Received: OLD" : "" };
  };
  test("is answered with a request to try again, then used", async () => {
    write("__tests__/m.test.ts", "expect(x).toBe('OLD');\n");
    let n = 0;
    const report = await healTests({
      repoRoot: dir,
      run: badRun,
      call: async () => (++n === 1 ? "Sure! Here is my analysis of the problem…" : JSON.stringify({ verdict: "stale-test", reason: "r", test: "expect(x).toBe('NEW');\n" })),
    });
    assert.equal(report.results[0].status, "healed");
    assert.equal(n, 2);
  });
  test("three in a row end as unclear and say what came back", async () => {
    write("__tests__/m.test.ts", "expect(x).toBe('OLD');\n");
    const report = await healTests({ repoRoot: dir, run: badRun, call: async () => "" });
    assert.equal(report.results[0].status, "code-bug");
    assert.match(report.results[0].note, /did not return usable JSON/);
  });
});

describe("signatures and whole files", () => {
  test("a stack frame is never the signature", () => {
    const a = "FAIL a\n  ● x\n    TypeError: undefined is not a function\n      at defaultOnUncaughtError (node_modules/r/r.js:1:2)";
    assert.match(failureSignature(a), /TypeError/);
    assert.ok(!/defaultOnUncaught/.test(failureSignature(a)));
  });
  test("a big source file reaches the model whole", async () => {
    write("src/Big.tsx", "// start\n" + "x".repeat(200_000) + "\n// the-end\n");
    write("__tests__/b.test.ts", `import "../src/Big";\nexpect(1).toBe('OLD');\n`);
    let seen = "";
    await healTests({
      repoRoot: dir,
      run: async (root) => {
        const bad = fs.readFileSync(path.join(root, "__tests__/b.test.ts"), "utf8").includes("OLD");
        return { ok: !bad, output: bad ? "FAIL __tests__/b.test.ts\n  ● x" : "" };
      },
      call: async (m) => {
        seen = m.map((x) => x.content).join("\n");
        return JSON.stringify({ verdict: "code-bug", reason: "r" });
      },
    });
    assert.ok(seen.includes("// the-end"));
  });
});
