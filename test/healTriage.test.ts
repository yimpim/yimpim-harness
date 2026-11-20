/**
 * The heal worker works the way a person does: it is handed the facts the repository can answer, it decides each cause on its own, it fixes
 * the test-side ones and hands only the code defects on, and it can check a value at run time instead of guessing.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { healTests, failureText, renderHealReport } from "../src/testHeal.js";
import { runProbe } from "../src/healEdits.js";
import { listTestFiles } from "../src/focusTests.js";

let dir = "";
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const TEST = "__tests__/dash.test.ts";

/** A small project: a screen that calls a function the test's mock lacks, shows new copy, and has one real bug. */
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-"));
  git("init", "-q");
  write("src/store.ts", "export async function getSession() {}\nexport async function getToken() {}\n");
  write("app/screen.ts", "import { getSession, getToken } from '../src/store';\nexport const label = 'Reconnecting';\nexport const isRunning = (s: string) => s === 'RUNNING';\n");
  write(
    TEST,
    [
      "jest.mock('../src/store', () => ({",
      "  getSession: async () => 1,",
      "}));",
      "// MARKER-LABEL expects Offline",
      "// MARKER-RUNNING expects running to be running",
    ].join("\n")
  );
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Fails with one stale-mock cause, one stale-copy cause and one real-bug cause; each marker, once fixed or absent, removes its failures. */
const run = async (root: string) => {
  const t = fs.readFileSync(path.join(root, TEST), "utf8");
  const out: string[] = [`FAIL ${TEST}`];
  if (!t.includes("getToken")) for (let i = 0; i < 6; i++) out.push(`  ● mount ${i}\n    TypeError: (0 , _store.getToken) is not a function\n      at app/screen.ts:1:1`);
  if (t.includes("expects Offline")) for (let i = 0; i < 3; i++) out.push(`  ● label ${i}\n    expect(received).toContain(expected) // indexOf\n\n    Expected substring: "Offline"\n    Received string:    "Reconnecting"\n      at app/screen.ts:2:1`);
  // The code defect never goes away: it is the code's, and the worker must not touch it.
  for (let i = 0; i < 2; i++) out.push(`  ● running ${i}\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: true\n    Received: false\n      at app/screen.ts:3:1`);
  return { ok: false, output: out.join("\n") };
};

describe("the worker is handed the facts, not just the failure", () => {
  test("the failure text carries evidence for the cause it can look up", () => {
    const t = failureText("FAIL " + TEST + "\n  ● a\n    TypeError: (0 , _store.getToken) is not a function\n      at app/screen.ts:1:1\n", dir, TEST);
    assert.match(t, /EVIDENCE \(collected from the repository, not guessed\)/);
    assert.match(t, /`getToken` is defined at src\/store\.ts:2/);
    assert.match(t, /__tests__\/dash\.test\.ts:1 mocks that module WITHOUT `getToken`/);
  });
  test("a failure with nothing to look up has no empty evidence heading", () => {
    assert.doesNotMatch(failureText("FAIL x\n  ● a\n    Error: boom\n", dir, TEST), /EVIDENCE/);
  });
  test("the first prompt the model sees contains it", async () => {
    let first = "";
    await healTests({
      repoRoot: dir,
      run,
      settle: false,
      call: async (messages) => {
        if (!first) first = messages.map((m) => m.content).join("\n");
        return JSON.stringify({ verdict: "unclear", reason: "looked" });
      },
    });
    assert.match(first, /EVIDENCE \(collected from the repository, not guessed\)/);
    assert.match(first, /mocks that module WITHOUT `getToken`/);
    assert.match(first, /Work like this\./);
    assert.match(first, /"verdict":"mixed"/);
  });
});

describe("a file that is part stale test and part code defect", () => {
  const mixed = {
    verdict: "mixed",
    reason: "The mock lacks getToken and the label copy changed on purpose; isRunning compares against the wrong constant.",
    edits: [
      { find: "  getSession: async () => 1,\n", replace: "  getSession: async () => 1,\n  getToken: async () => 'mock-token',\n" },
      { find: "// MARKER-LABEL expects Offline", replace: "// MARKER-LABEL expects Reconnecting" },
    ],
    codeBugs: ["app/screen.ts:3 isRunning compares the raw state to 'RUNNING', so a running desktop is never running"],
  };

  // First answer: mixed, with its test-side edits. It is then shown what STILL fails and says that what is left is the code.
  const twoStepCall = () => {
    let n = 0;
    return async () => (++n === 1 ? JSON.stringify(mixed) : JSON.stringify({ verdict: "code-bug", reason: "What still fails is the code.", codeBugs: mixed.codeBugs }));
  };
  test("the test-side causes are fixed and kept, and only the code defect is handed on", async () => {
    const report = await healTests({ repoRoot: dir, run, settle: false, call: twoStepCall() });
    const r = report.results[0];
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    // The stale parts are fixed in the file, and the code defect's part is untouched.
    assert.match(read(TEST), /getToken: async \(\) => 'mock-token'/);
    assert.match(read(TEST), /expects Reconnecting/);
    assert.match(read(TEST), /MARKER-RUNNING expects running to be running/);
    // What is handed on names the defect and what is left, and is the failure that remains (only the code's two tests).
    assert.match(r.note, /app\/screen\.ts:3 isRunning compares the raw state/);
    assert.match(r.note, /Still failing after the test-side fixes: 2/);
    assert.match(r.note, /out-of-date parts were fixed: 3 lines changed/); // one line added to the mock, one changed (counted as removed + added)
    assert.match(r.failure ?? "", /running 0/);
    assert.doesNotMatch(r.failure ?? "", /getToken|label 0/);
  });
  test("a smaller failure count is not enough: the worker is shown what still fails and, while some of it is the test's, keeps fixing it", async () => {
    const prompts: string[] = [];
    let n = 0;
    const r = (
      await healTests({
        repoRoot: dir,
        run,
        settle: false,
        call: async (messages) => {
          prompts.push(messages[messages.length - 1].content);
          n++;
          if (n === 1) return JSON.stringify({ ...mixed, edits: [mixed.edits[0]] }); // fixes the mock only; the stale label copy still fails
          if (n === 2) return JSON.stringify({ verdict: "mixed", reason: "the label copy", edits: [mixed.edits[1]], codeBugs: mixed.codeBugs });
          return JSON.stringify({ verdict: "code-bug", reason: "only the code is left", codeBugs: mixed.codeBugs });
        },
      })
    ).results[0];
    assert.equal(n, 3, "it was not handed on after the first answer, although the count had dropped");
    assert.match(prompts[1], /FOCUS: work on ONE cause at a time|Go through EVERY cause that still fails/);
    assert.match(prompts[1], /3 failing|label 0/, "it was shown the stale-copy failures that were still there");
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    assert.match(read(TEST), /expects Reconnecting/);
  });
  test("saying 'code-bug' with no test fix made first puts the file back and makes no claim of partial progress", async () => {
    const before = read(TEST);
    const r = (await healTests({ repoRoot: dir, run, settle: false, call: async () => JSON.stringify({ verdict: "code-bug", reason: "code" }) })).results[0];
    assert.equal(r.partial, undefined);
    assert.equal(read(TEST), before);
  });
  test("a partial result is not a failed heal: it earns no strike, so it is not parked", async () => {
    await healTests({ repoRoot: dir, run, settle: false, call: twoStepCall() });
    const log = JSON.parse(fs.readFileSync(path.join(dir, ".agent", "test-log.json"), "utf8"));
    assert.equal(log.files[TEST]?.healStrikes, undefined);
  });
  test("the report says which part is which", async () => {
    const report = await healTests({ repoRoot: dir, run, settle: false, call: twoStepCall() });
    const text = renderHealReport(report);
    assert.match(text, /Part test, part code\. The out-of-date parts of these tests were fixed/);
    assert.doesNotMatch(text, /tests left untouched/);
  });
  test("'mixed' with no change to the test is simply a code defect, and the file is as it was", async () => {
    const before = read(TEST);
    const r = (await healTests({ repoRoot: dir, run, settle: false, call: async () => JSON.stringify({ verdict: "mixed", reason: "all code", codeBugs: ["app/screen.ts:3 wrong"] }) })).results[0];
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, undefined);
    assert.equal(read(TEST), before);
  });
  test("a 'mixed' answer whose edits moved nothing is not progress: it is not handed on as if it were", async () => {
    const before = read(TEST);
    const r = (
      await healTests({
        repoRoot: dir,
        run,
        settle: false,
        call: async () => JSON.stringify({ verdict: "mixed", reason: "r", edits: [{ find: "// MARKER-RUNNING expects running to be running", replace: "// MARKER-RUNNING touched" }], codeBugs: ["app/screen.ts:3 wrong"] }),
      })
    ).results[0];
    assert.notEqual(r.partial, true);
    assert.equal(read(TEST), before, "put back when the same failure came back");
  });
  test("a file that is entirely a code defect is still reported the old way", async () => {
    const report = await healTests({ repoRoot: dir, run, settle: false, call: async () => JSON.stringify({ verdict: "code-bug", reason: "app/screen.ts:3 wrong" }) });
    assert.match(renderHealReport(report), /The CODE is wrong here \(tests left untouched/);
  });
});

describe("a probe: a value at run time, read from a throwaway copy", () => {
  const fakeRun = async (root: string, files: string[]) => {
    const text = fs.readFileSync(path.join(root, files[0]), "utf8");
    const m = /console\.log\('PROBE', (.+)\);/.exec(text);
    return { ok: true, output: m ? `  console.log\n    PROBE ${m[1].includes("AppState") ? "function () {" : "x"}\n\n      at x` : "no probe" };
  };
  test("prints what the inserted line printed, and the copy is deleted, and the real file is untouched", async () => {
    write("__tests__/probe.test.ts", "it('a', () => {\n  const renderer = render();\n  expect(x).toBe(1);\n});\n");
    const before = read("__tests__/probe.test.ts");
    const out = await runProbe(fakeRun, dir, { file: "__tests__/probe.test.ts", before: "expect(x).toBe(1)", log: "String(AppState.currentState)" });
    assert.match(out, /^--- probe __tests__\/probe\.test\.ts before "expect\(x\)\.toBe\(1\)" \(printing String\(AppState\.currentState\)\)\nPROBE function \(\) \{/);
    assert.equal(read("__tests__/probe.test.ts"), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, "__tests__")).filter((f) => f.startsWith("zz_probe_")), []);
  });
  test("the line is inserted with the indentation of the line it goes before", async () => {
    write("__tests__/probe.test.ts", "it('a', () => {\n    expect(x).toBe(1);\n});\n");
    let seen = "";
    await runProbe(async (root, files) => {
      seen = fs.readFileSync(path.join(root, files[0]), "utf8");
      return { ok: true, output: "" };
    }, dir, { file: "__tests__/probe.test.ts", before: "expect(x)", log: "1" });
    assert.match(seen, /\n {4}console\.log\('PROBE', 1\);\n {4}expect\(x\)\.toBe\(1\);/);
  });
  test("nothing printed is said plainly, and counts as nothing learned", async () => {
    write("__tests__/probe.test.ts", "it('a', () => {\n  expect(x).toBe(1);\n});\n");
    const out = await runProbe(async () => ({ ok: true, output: "no probe" }), dir, { file: "__tests__/probe.test.ts", before: "expect(x)", log: "1" });
    assert.match(out, /\(the probe printed nothing: that line was not reached, or the expression threw\)$/);
  });
  test("it refuses what could do more than look: a non-test file, a statement, a path outside the project", async () => {
    write("src/app.ts", "export const a = 1;\n");
    write("__tests__/probe.test.ts", "it('a', () => {\n  expect(x).toBe(1);\n});\n");
    const refuse = async (spec: any) => await runProbe(fakeRun, dir, spec);
    assert.match(await refuse({ file: "src/app.ts", before: "export", log: "1" }), /probe refused: it needs a test file/);
    assert.match(await refuse({ file: "../x.test.ts", before: "x", log: "1" }), /probe refused/);
    assert.match(await refuse({ file: "__tests__/probe.test.ts", before: "expect", log: "fs.rmSync('.'); 1" }), /probe refused: "log" must be a single expression/);
    assert.match(await refuse({ file: "__tests__/probe.test.ts", before: "expect", log: "a\nb" }), /probe refused/);
    assert.match(await refuse({ file: "__tests__/probe.test.ts", before: "", log: "1" }), /probe refused/);
    assert.match(await refuse({ file: "__tests__/probe.test.ts", before: "no such line", log: "1" }), /probe found no line containing that text/);
  });
  test("the worker can ask for one, and gets the answer in its next message", async () => {
    write("__tests__/probe.test.ts", "it('a', () => {\n  expect(x).toBe(1);\n});\n");
    let turn = 0;
    let answer = "";
    await healTests({
      repoRoot: dir,
      run: async (root, files) => ((files[0] ?? "").includes("zz_probe_") ? { ok: true, output: "PROBE 42" } : { ok: false, output: "FAIL __tests__/probe.test.ts\n  ● a\n    Error: boom\n" }),
      settle: false,
      call: async (messages) => {
        turn++;
        if (turn === 1) return JSON.stringify({ need: [{ probe: { file: "__tests__/probe.test.ts", before: "expect(x)", log: "6 * 7" } }] });
        answer = messages[messages.length - 1].content;
        return JSON.stringify({ verdict: "unclear", reason: "looked" });
      },
    });
    assert.match(answer, /PROBE 42/);
  });
  test("a copy a crash left behind is never run as one of the project's tests", () => {
    write("__tests__/zz_probe_abc_probe.test.ts", "it('x', () => {});\n");
    write("__tests__/real.test.ts", "it('y', () => {});\n");
    assert.deepEqual(listTestFiles(dir).filter((f) => f.includes("probe") || f.includes("real")), ["__tests__/real.test.ts"]);
  });
});
