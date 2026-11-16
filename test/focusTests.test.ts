/**
 * Two-tier tests: permanent main suite (one owner per source file) and
 * temporary focused tests that are folded in, promoted or discarded once a
 * phase passes.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FOCUS_DIRNAME,
  checkMainSuiteCoverage,
  classifyFocusTest,
  clearFocusFiles,
  encodeTestsNotNeeded,
  extractTestsNotNeeded,
  finalizeFocusTests,
  findOwningTests,
  focusDir,
  focusedTestCommand,
  isFocusPath,
  isSourceCodePath,
  isTestPath,
  listTestFiles,
  loadFocusFiles,
  parseTestsNotNeeded,
  registerFocusFiles,
  renderTestGuidance,
  renderTestsNotNeededForGoal,
  subjectsOf,
  testSubjectKey,
} from "../src/focusTests.js";
import { AutonomousVerifier, stableGoalKey, HOW_TO_VERIFY_GOAL_MARKER } from "../src/verifierTools.js";
import { EvidenceLedger } from "../src/evidence.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-focus-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const PASS = async () => ({ status: "pass" as const, detail: "ok" });
const YES = async () => ({ keep: true, reason: "major flow" });

describe("naming", () => {
  test("recognises tests, focus files and source files", () => {
    assert.ok(isTestPath("__tests__/a.ts"));
    assert.ok(isTestPath("src/a.test.tsx"));
    assert.ok(isTestPath("tests/test_a.py"));
    assert.ok(isTestPath("pkg/a_test.go"));
    assert.ok(!isTestPath("src/a.ts"));
    assert.ok(isFocusPath("__tests__/_focus/a.test.ts"));
    assert.ok(!isFocusPath("__tests__/a.test.ts"));
    assert.ok(isSourceCodePath("app/dashboard.tsx"));
    assert.ok(!isSourceCodePath("__tests__/dashboard.test.ts"));
    assert.ok(!isSourceCodePath("README.md"));
    assert.ok(!isSourceCodePath(".expo/dev/logs/export.log"));
  });

  test("a test's subject name strips affixes", () => {
    assert.equal(testSubjectKey("__tests__/dashboard.test.ts"), "dashboard");
    assert.equal(testSubjectKey("__tests__/dashboard.extra.test.ts"), "dashboard");
    assert.equal(testSubjectKey("tests/test_dashboard.py"), "dashboard");
    assert.equal(testSubjectKey("pkg/dashboard_test.go"), "dashboard");
    assert.equal(testSubjectKey("__tests__/history-screen.test.ts"), "historyscreen");
  });

  test("ownership is exact by name, not by prefix", () => {
    const tests = ["__tests__/dashboard.test.ts", "__tests__/dashboard-timeline.test.ts", "__tests__/history.test.ts"];
    assert.deepEqual(findOwningTests("app/dashboard.tsx", tests), ["__tests__/dashboard.test.ts"]);
    assert.deepEqual(findOwningTests("src/other.ts", tests), []);
  });
});

describe("discovery and Editor guidance", () => {
  test("listTestFiles skips vendor and focus folders", () => {
    const r = repo({
      "__tests__/a.test.ts": "",
      "__tests__/_focus/b.test.ts": "",
      "node_modules/x/c.test.ts": "",
      "src/d.ts": "",
    });
    assert.deepEqual(listTestFiles(r), ["__tests__/a.test.ts"]);
    assert.equal(listTestFiles(r, { includeFocus: true }).length, 2);
  });

  test("guidance names existing tests (by name and by import) and the focus folder", () => {
    const r = repo({
      "app/dashboard.tsx": "export const x = 1",
      "__tests__/dashboard.test.ts": "import { x } from '../app/dashboard'",
      "__tests__/e2e/flow.test.ts": "import { x } from '../../app/dashboard'",
    });
    const g = renderTestGuidance(r, ["app/dashboard.tsx"]);
    assert.match(g, /app\/dashboard\.tsx\s+->\s+__tests__\/dashboard\.test\.ts/);
    assert.match(g, /__tests__\/e2e\/flow\.test\.ts/);
    assert.match(g, /__tests__\/_focus\//);
    assert.match(g, /testsNotNeeded/);
  });

  test("guidance says so when nothing covers the files", () => {
    const r = repo({ "app/a.tsx": "x" });
    assert.match(renderTestGuidance(r, ["app/a.tsx"]), /No existing test covers/);
  });

  test("the focus folder follows the project's own test root", () => {
    assert.equal(focusDir(repo({ "tests/a.py": "" })), `tests/${FOCUS_DIRNAME}`);
    assert.equal(focusDir(repo({ "src/a.ts": "" })), `__tests__/${FOCUS_DIRNAME}`);
  });
});

describe("focus manifest", () => {
  test("only focus-folder files are tracked, and clearing deletes only those", () => {
    const r = repo({
      "__tests__/_focus/a.test.ts": "x",
      "__tests__/keep.test.ts": "keep",
    });
    registerFocusFiles(r, ["__tests__/_focus/a.test.ts", "__tests__/keep.test.ts", "src/nope.ts"]);
    assert.deepEqual(loadFocusFiles(r), ["__tests__/_focus/a.test.ts"]);
    assert.equal(clearFocusFiles(r), 1);
    assert.ok(!fs.existsSync(path.join(r, "__tests__/_focus/a.test.ts")));
    assert.ok(fs.existsSync(path.join(r, "__tests__/keep.test.ts")));
    assert.deepEqual(loadFocusFiles(r), []);
  });
});

describe("classifyFocusTest", () => {
  test("keeps behavior tests, drops the brittle or empty ones", () => {
    assert.equal(classifyFocusTest("it('x',()=>{ expect(add(1,2)).toBe(3) })").keep, true);
    assert.equal(classifyFocusTest("it('x',()=>{ add(1,2) })").keep, false);
    assert.equal(classifyFocusTest("expect(fn).toHaveBeenNthCalledWith(2, 'a')").keep, false);
    assert.equal(classifyFocusTest("expect(x).toMatchSnapshot()").keep, false);
    const heavy = "jest.mock('a');jest.mock('b');jest.mock('c');jest.mock('d');expect(1).toBe(1)";
    assert.equal(classifyFocusTest(heavy).keep, false);
  });
});

describe("imports", () => {
  test("subjectsOf resolves relative imports to source files only", () => {
    const r = repo({
      "src/lib/math.ts": "export const add = 1",
      "__tests__/helpers.ts": "export {}",
      "__tests__/_focus/m.test.ts": "",
    });
    const content = "import { add } from '../../src/lib/math';\nimport { h } from '../helpers';\nimport x from 'react';";
    assert.deepEqual(subjectsOf(r, "__tests__/_focus/m.test.ts", content), ["src/lib/math.ts"]);
  });
});

describe("main-suite coverage check", () => {
  const base = {
    "app/dashboard.tsx": "x",
    "app/untested.tsx": "x",
    "__tests__/dashboard.test.ts": "t",
  };

  test("a changed file whose test was left alone is flagged", () => {
    const r = repo(base);
    const p = checkMainSuiteCoverage(r, { modified: ["app/dashboard.tsx"], added: [] });
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, "stale-owner");
    assert.match(p[0].message, /testsNotNeeded/);
  });

  test("touching the owning test satisfies it", () => {
    const r = repo(base);
    assert.deepEqual(
      checkMainSuiteCoverage(r, { modified: ["app/dashboard.tsx", "__tests__/dashboard.test.ts"], added: [] }),
      []
    );
  });

  test("a file with no test owner demands nothing", () => {
    const r = repo(base);
    assert.deepEqual(checkMainSuiteCoverage(r, { modified: ["app/untested.tsx"], added: [] }), []);
  });

  test("a second test file for something already tested is flagged", () => {
    const r = repo({ ...base, "__tests__/dashboard.extra.test.ts": "t2" });
    const p = checkMainSuiteCoverage(r, { modified: [], added: ["__tests__/dashboard.extra.test.ts"] });
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, "duplicate-test");
  });

  test("a genuinely new test file is fine", () => {
    const r = repo({ ...base, "__tests__/brandnew.test.ts": "t2" });
    assert.deepEqual(checkMainSuiteCoverage(r, { modified: [], added: ["__tests__/brandnew.test.ts"] }), []);
  });
});

describe("testsNotNeeded transport", () => {
  test("round-trips through the editor result and the QA goal", () => {
    const wire = `TASK_CONCLUDED: done${encodeTestsNotNeeded("pure rename")}\n\n[HOW TO VERIFY]\nx`;
    assert.equal(extractTestsNotNeeded(wire), "pure rename");
    assert.equal(extractTestsNotNeeded("TASK_CONCLUDED: done"), undefined);
    assert.equal(encodeTestsNotNeeded(""), "");
    assert.equal(parseTestsNotNeeded(`goal${renderTestsNotNeededForGoal("pure rename")}`), "pure rename");
    assert.equal(stableGoalKey(`goal${HOW_TO_VERIFY_GOAL_MARKER}h${renderTestsNotNeededForGoal("r")}`), "goal");
  });
});

describe("finalizeFocusTests", () => {
  const focusSrc = "import { add } from '../../src/lib/math';\ntest('adds',()=>{ expect(add(1,2)).toBe(3) })";
  const setup = (extra: Record<string, string> = {}) => {
    const r = repo({
      "src/lib/math.ts": "export const add = (a,b)=>a+b",
      "__tests__/_focus/m.test.ts": focusSrc,
      ...extra,
    });
    registerFocusFiles(r, ["__tests__/_focus/m.test.ts"]);
    return r;
  };

  test("the default is to discard: a review that edits nothing leaves the suite alone", async () => {
    const r = setup({ "__tests__/math.test.ts": "// owner" });
    let asked: any;
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async (req) => { asked = req; },
      run: async () => { throw new Error("nothing changed, nothing to run"); },
    });
    assert.equal(out[0].action, "discarded");
    assert.match(out[0].reason, /permanent suite already covers it/);
    assert.deepEqual(asked.candidates, ["__tests__/math.test.ts"]);
    assert.equal(fs.readFileSync(path.join(r, "__tests__/math.test.ts"), "utf-8"), "// owner");
    assert.ok(!fs.existsSync(path.join(r, "__tests__/_focus")));
    assert.deepEqual(loadFocusFiles(r), []);
  });

  test("candidates include E2E tests that import the code, not only the same-name test", async () => {
    const r = setup({
      "__tests__/math.test.ts": "// owner",
      "__tests__/e2e/flow.test.ts": "import { add } from '../../src/lib/math';",
    });
    let asked: any;
    await finalizeFocusTests({ repoRoot: r, decide: YES, review: async (req) => { asked = req; }, run: PASS });
    assert.ok(asked.candidates.includes("__tests__/e2e/flow.test.ts"));
    assert.equal(asked.candidates[0], "__tests__/math.test.ts", "the exact owner comes first");
    assert.equal(asked.suggestedNew, "__tests__/math.test.ts");
  });

  test("an in-place update that passes is kept, and the focus file is gone", async () => {
    const r = setup({ "__tests__/math.test.ts": "test('old', () => expect(add(1,1)).toBe(3))" });
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async () => fs.writeFileSync(path.join(r, "__tests__/math.test.ts"), "test('new', () => expect(add(1,1)).toBe(2))"),
      run: PASS,
    });
    assert.equal(out[0].action, "updated");
    assert.match(fs.readFileSync(path.join(r, "__tests__/math.test.ts"), "utf-8"), /toBe\(2\)/);
    assert.ok(!fs.existsSync(path.join(r, "__tests__/_focus/m.test.ts")));
  });

  test("a new permanent test is added only when the review creates one, and counts as added", async () => {
    const r = setup();
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async (req) => fs.writeFileSync(path.join(r, req.suggestedNew), "test('x',()=>{})"),
      run: PASS,
    });
    assert.equal(out[0].action, "added");
    assert.ok(fs.existsSync(path.join(r, "__tests__/math.test.ts")));
  });

  test("a change that does not pass is reverted exactly, including a created file", async () => {
    const r = setup({ "__tests__/math.test.ts": "// owner" });
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async () => {
        fs.appendFileSync(path.join(r, "__tests__/math.test.ts"), "\nBROKEN");
        fs.writeFileSync(path.join(r, "__tests__/extra.test.ts"), "x");
      },
      run: async () => ({ status: "fail" as const, detail: "boom" }),
    });
    assert.equal(out[0].action, "discarded");
    assert.equal(fs.readFileSync(path.join(r, "__tests__/math.test.ts"), "utf-8"), "// owner");
    assert.ok(!fs.existsSync(path.join(r, "__tests__/extra.test.ts")));
  });

  test("deleting a whole test file is refused and restored", async () => {
    const r = setup({ "__tests__/math.test.ts": "// owner", "__tests__/other.test.ts": "// other" });
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async () => fs.unlinkSync(path.join(r, "__tests__/other.test.ts")),
      run: PASS,
    });
    assert.equal(out[0].action, "discarded");
    assert.match(out[0].reason, /deleted test file/);
    assert.equal(fs.readFileSync(path.join(r, "__tests__/other.test.ts"), "utf-8"), "// other");
  });

  test("a review pass that throws leaves the suite untouched", async () => {
    const r = setup({ "__tests__/math.test.ts": "// owner" });
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: YES,
      review: async () => {
        fs.appendFileSync(path.join(r, "__tests__/math.test.ts"), "\npartial");
        throw new Error("model died");
      },
      run: PASS,
    });
    assert.equal(out[0].action, "discarded");
    assert.equal(fs.readFileSync(path.join(r, "__tests__/math.test.ts"), "utf-8"), "// owner");
  });

  test("a brittle focus test is discarded without asking any model", async () => {
    const r = repo({ "__tests__/_focus/m.test.ts": "expect(fn).toHaveBeenNthCalledWith(2,'a')" });
    registerFocusFiles(r, ["__tests__/_focus/m.test.ts"]);
    let asked = false;
    const out = await finalizeFocusTests({ repoRoot: r, decide: YES, review: async () => { asked = true; }, run: PASS });
    assert.equal(out[0].action, "discarded");
    assert.equal(asked, false);
  });
});

describe("focusedTestCommand", () => {
  test("uses the project's own test script, or pytest, else nothing", () => {
    const npmRepo = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
    const cmd = focusedTestCommand(npmRepo, ["a.test.ts"])!;
    assert.deepEqual(cmd.args, ["run", "test", "--", "a.test.ts"]);
    const py = repo({ "pytest.ini": "" });
    assert.deepEqual(focusedTestCommand(py, ["t.py"])!.args.slice(0, 3), ["-m", "pytest", "-q"]);
    assert.equal(focusedTestCommand(repo({ "a.txt": "" }), ["x"]), undefined);
  });
});

describe("verifier gates", () => {
  const verifier = (r: string) =>
    new AutonomousVerifier(r, {} as any, {} as any, { models: { verifier: ["m"] } } as any) as any;

  test("mainSuiteGate blocks a stale owner and is excused by a stated reason", () => {
    const r = repo({ "app/dashboard.tsx": "x", "__tests__/dashboard.test.ts": "t" });
    const change = { modified: ["app/dashboard.tsx"], added: [] } as any;

    const blocked = new EvidenceLedger();
    verifier(r).mainSuiteGate("goal", change, blocked);
    assert.equal(blocked.hasBlockingFailure(), true);

    const excused = new EvidenceLedger();
    verifier(r).mainSuiteGate(`goal${renderTestsNotNeededForGoal("rename only")}`, change, excused);
    assert.equal(excused.hasBlockingFailure(), false);
    assert.match(excused.all()[0].detail, /rename only/);
  });

  test("mainSuiteGate is silent in a project with no tests", () => {
    const r = repo({ "app/a.tsx": "x" });
    const ledger = new EvidenceLedger();
    verifier(r).mainSuiteGate("goal", { modified: ["app/a.tsx"], added: [] } as any, ledger);
    assert.equal(ledger.all().length, 0);
  });

  test("focusedTestGate does nothing without focus files", async () => {
    const r = repo({ "src/a.ts": "x" });
    const ledger = new EvidenceLedger();
    await verifier(r).focusedTestGate(ledger);
    assert.equal(ledger.all().length, 0);
  });

  test("focusedTestGate with no runner is advisory, not a failure", async () => {
    const r = repo({ "__tests__/_focus/a.test.ts": "expect(1).toBe(1)" });
    registerFocusFiles(r, ["__tests__/_focus/a.test.ts"]);
    const ledger = new EvidenceLedger();
    await verifier(r).focusedTestGate(ledger);
    assert.equal(ledger.hasBlockingFailure(), false);
    assert.equal(ledger.all()[0].status, "inconclusive");
  });
});

describe("focused run against a real runner", () => {
  const judge = {
    isTooling: (e: any) => e?.code === "ENOENT",
    noTests: (o: string) => /no tests found/i.test(o),
    describe: (e: any) => String(e?.message ?? e),
  };
  const launch = (bin: string, args: string[]) =>
    process.platform === "win32" ? { bin: "cmd.exe", args: ["/d", "/s", "/c", bin, ...args] } : { bin, args };

  const mk = (body: string) =>
    repo({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "__tests__/_focus/a.test.js": `const { test } = require('node:test');\nconst assert = require('node:assert');\n${body}`,
    });

  test("a passing focused file passes, a failing one fails", async () => {
    const ok = mk("test('x', () => assert.strictEqual(1, 1));");
    const bad = mk("test('x', () => assert.strictEqual(1, 2));");
    const { runFocusedTests } = await import("../src/focusTests.js");
    // A nested `node --test` inherits this runner's context and exits 0 regardless.
    const saved = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      assert.equal((await runFocusedTests(ok, ["__tests__/_focus/a.test.js"], judge, launch)).status, "pass");
      assert.equal((await runFocusedTests(bad, ["__tests__/_focus/a.test.js"], judge, launch)).status, "fail");
    } finally {
      if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
    }
  });
});

describe("QA decides, Editor edits", () => {
  const setup = () => {
    const r = repo({
      "src/lib/math.ts": "export const add = 1",
      "__tests__/math.test.ts": "// owner",
      "__tests__/_focus/m.test.ts": "import { add } from '../../src/lib/math';\ntest('a',()=>{ expect(add).toBe(1) })",
    });
    registerFocusFiles(r, ["__tests__/_focus/m.test.ts"]);
    return r;
  };

  test("when QA says no, the Editor review never runs and the suite is untouched", async () => {
    const r = setup();
    let reviewed = false;
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: async () => ({ keep: false, reason: "a small tweak" }),
      review: async () => { reviewed = true; },
      run: PASS,
    });
    assert.equal(reviewed, false);
    assert.equal(out[0].action, "discarded");
    assert.match(out[0].reason, /QA: a small tweak/);
    assert.equal(fs.readFileSync(path.join(r, "__tests__/math.test.ts"), "utf-8"), "// owner");
    assert.ok(!fs.existsSync(path.join(r, "__tests__/_focus")));
  });

  test("QA failing to answer means discard, not keep", async () => {
    const r = setup();
    let reviewed = false;
    const out = await finalizeFocusTests({
      repoRoot: r,
      decide: async () => { throw new Error("model down"); },
      review: async () => { reviewed = true; },
      run: PASS,
    });
    assert.equal(reviewed, false);
    assert.equal(out[0].action, "discarded");
  });

  test("QA's reason is handed to the Editor", async () => {
    const r = setup();
    let seen = "";
    await finalizeFocusTests({
      repoRoot: r,
      decide: async () => ({ keep: true, reason: "new pairing flow" }),
      review: async (req) => { seen = req.reason; },
      run: PASS,
    });
    assert.equal(seen, "new pairing flow");
  });

  test("judgeFocusTest keeps only on an explicit yes", async () => {
    const mk = (content: string) =>
      new AutonomousVerifier(process.cwd(), { complete: async () => ({ content }) } as any, {} as any, { models: { verifier: ["m"] } } as any);
    const req = { focusRel: "__tests__/_focus/a.test.ts", content: "expect(1).toBe(1)", candidates: [] };
    assert.deepEqual(await mk('{"keep": true, "reason": "new flow"}').judgeFocusTest("goal", req), { keep: true, reason: "new flow" });
    assert.equal((await mk('{"keep": false, "reason": "tweak"}').judgeFocusTest("goal", req)).keep, false);
    assert.equal((await mk('{"keep": "yes"}').judgeFocusTest("goal", req)).keep, false);
    assert.equal((await mk("not json").judgeFocusTest("goal", req)).keep, false);
  });
});
