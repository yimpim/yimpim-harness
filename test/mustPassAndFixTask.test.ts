/**
 * When the heal ends with a real app bug, a fix task goes to the Editor (straight, built from the diagnosis, see directFix.ts). The failing tests are its
 * spec, so the fix must not make them pass by changing what they CHECK. But the Editor must stay free to change the test FILE around them: a fix can change a
 * hook's signature or need a mock, and in a 3,500-line file the mocks and helpers are shared by every test in it, so a lock on the whole file would turn a
 * clean fix into a dead end. So: only the failing tests' assertions are locked (refused at once when edited, checked again by QA), setup and new tests are
 * free, the original file is run against the fixed code to tell a self-standing fix from one that needed setup changes, and an ordinary task (add a feature,
 * remove login) has no lock at all.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setMustPass,
  isMustPass,
  anyMustPass,
  lockedProblem,
  mustPassFindings,
  changedMustPassTexts,
  reviewDiff,
  runOriginalCopy,
  refusalFor,
  directFixFor,
  parseFixTask,
} from "../src/directFix.js";
import { AgentTools } from "../src/agentTools.js";
import { AutonomousVerifier } from "../src/verifierTools.js";
import { fixTaskFor, type PendingFix } from "../src/testSettle.js";
import { healTests, diagnosisOf, fixItemsFor, DIAGNOSIS_CHARS, type HealCall, type HealResult } from "../src/testHeal.js";
import type { SandboxResult, SandboxRun } from "../src/healSandbox.js";

let root = "";
const TEST = "__tests__/a.test.ts";
const OTHER = "__tests__/b.test.ts";
const FAILING_NAME = "Dashboard › Poll › restarts the stream once on Back to Live";
const SRC = [
  "import { render } from '../src/render';",
  "jest.mock('../src/x', () => ({ one: 1 }));",
  "",
  "describe('Dashboard', () => {",
  "  describe('Poll', () => {",
  "    it('restarts the stream once on Back to Live', async () => {",
  "      await press('Back to Live');",
  "      expect(pollStartCount()).toBe(2);",
  "      expect(commands()).toEqual(['ping']);",
  "    });",
  "    it('shows a label', () => {",
  "      expect(label()).toBe('Yes');",
  "    });",
  "  });",
  "  describe('Other', () => {",
  "    it('keeps working', () => {",
  "      expect(1).toBe(1);",
  "    });",
  "  });",
  "});",
  "",
].join("\n");
const w = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const lock = (names: string[] = [FAILING_NAME]) => setMustPass([TEST], root, { failing: { [TEST]: names } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mustpass-"));
  w(TEST, SRC);
  w(OTHER, "jest.mock('../src/x', () => ({ one: 1 }));\ntest('b', () => {});\n");
  w("src/x.ts", "export const one = 1;\nexport const two = 2;\n");
});
afterEach(() => {
  setMustPass([]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what a fix may change in the test file: everything except what the failing tests assert", () => {
  test("untouched is fine", () => assert.equal((lock(), lockedProblem(TEST, SRC)), undefined));

  test("setup, mocks, imports and helpers are free: the changes a fix to a hook's signature needs", () => {
    lock();
    const next = SRC.replace("({ one: 1 })", "({ one: 1, two: 2 })").replace("import { render } from '../src/render';", "import { render, renderWith } from '../src/render';\nimport { makeStore } from '../src/store';");
    assert.equal(lockedProblem(TEST, next), undefined);
  });

  test("new tests are free, added anywhere (a regression test for the bug just fixed)", () => {
    lock();
    const next = SRC.replace("  describe('Other'", "    it('does not restart twice', () => {\n      expect(pollStartCount()).toBe(1);\n    });\n  });\n  describe('Other'").replace("  });\n  describe('Other', () => {", "  describe('Other', () => {");
    assert.equal(lockedProblem(TEST, SRC + "\nit('a new regression test', () => {\n  expect(2).toBe(2);\n});\n"), undefined);
    assert.equal(lockedProblem(TEST, next), undefined);
  });

  test("more assertions inside the failing test are fine; only the original ones are locked", () => {
    lock();
    assert.equal(lockedProblem(TEST, SRC.replace("      expect(commands()).toEqual(['ping']);", "      expect(commands()).toEqual(['ping']);\n      expect(extra()).toBe(1);")), undefined);
  });

  test("a test that is NOT failing is not locked: its assertion may change", () => {
    lock();
    assert.equal(lockedProblem(TEST, SRC.replace("toBe('Yes')", "toBe('yes')")), undefined);
  });

  test("re-indenting an assertion and dropping its semicolon (what a formatter does) is not a change to it; a change inside it still is", () => {
    lock();
    assert.equal(lockedProblem(TEST, SRC.replace("      expect(pollStartCount()).toBe(2);", "            expect(pollStartCount()).toBe(2)")), undefined);
    assert.equal(lockedProblem(TEST, SRC.replace("expect(commands()).toEqual(['ping']);", "expect(commands()).toEqual(['ping', 'pong']);")) !== undefined, true);
  });

  test("CHANGING what a failing test asserts is refused, naming the test and the assertion (the tampering the lock exists for)", () => {
    lock();
    const p = lockedProblem(TEST, SRC.replace("expect(pollStartCount()).toBe(2);", "expect(pollStartCount()).toBe(3);"));
    assert.match(p ?? "", /^an assertion in the failing test "restarts the stream once on Back to Live" was changed or removed: expect\(pollStartCount\(\)\)\.toBe\(2\)$/);
  });

  test("DELETING one is refused, and so is weakening it into one that cannot fail", () => {
    lock();
    assert.match(lockedProblem(TEST, SRC.replace("      expect(commands()).toEqual(['ping']);\n", "")) ?? "", /was changed or removed: expect\(commands\(\)\)\.toEqual\(\['ping'\]\)/);
    assert.match(lockedProblem(TEST, SRC.replace("expect(pollStartCount()).toBe(2);", "expect(pollStartCount()).toBeDefined();")) ?? "", /was changed or removed/);
  });

  test("moving the assertion out of the test (leaving the block empty) is refused", () => {
    lock();
    const next = SRC.replace("      expect(pollStartCount()).toBe(2);\n      expect(commands()).toEqual(['ping']);\n", "") + "\nexpect(pollStartCount()).toBe(2);\n";
    assert.match(lockedProblem(TEST, next) ?? "", /was changed or removed/);
  });

  test("renaming or removing the failing test is refused", () => {
    lock();
    assert.match(lockedProblem(TEST, SRC.replace("restarts the stream once on Back to Live", "restarts the stream a few times")) ?? "", /^the failing test "restarts the stream once on Back to Live" is no longer in the file \(it was renamed or removed\)$/);
  });

  test("a test that disappears (the count of tests drops) is refused", () => {
    lock();
    const next = SRC.replace("    it('shows a label', () => {\n      expect(label()).toBe('Yes');\n    });\n", "");
    assert.match(lockedProblem(TEST, next) ?? "", /^it has 2 tests where the file had 3 when the fix began \(a test was removed\)$/);
  });

  test("skipping a test and narrowing the file with .only are each named for what they are", () => {
    lock();
    assert.equal(lockedProblem(TEST, SRC.replace("it('shows a label'", "it.skip('shows a label'")), "it skips tests that were running");
    assert.equal(lockedProblem(TEST, SRC.replace("it('keeps working'", "it.only('keeps working'")), "it narrows the file to some tests with .only");
  });

  test("when no failing test is named, the number of assertions in the file may not drop (and setup is still free)", () => {
    setMustPass([TEST], root, { failing: { [TEST]: [] } });
    assert.match(lockedProblem(TEST, SRC.replace("      expect(1).toBe(1);\n", "")) ?? "", /it has 3 expect\(\.\.\.\) calls where the file had 4/);
    assert.equal(lockedProblem(TEST, SRC.replace("({ one: 1 })", "({ one: 2 })")), undefined);
  });

  test("a failing name that is not in the file locks nothing (and nothing breaks)", () => {
    lock(["Dashboard › Poll › a test that is nowhere"]);
    assert.equal(lockedProblem(TEST, SRC.replace("toBe(2)", "toBe(3)")), undefined, "no block to lock, but the count rule below still applies");
  });

  test("an ordinary task has no lock at all: an empty list, anything goes", () => {
    setMustPass([], root);
    assert.equal(anyMustPass(), false);
    assert.equal(isMustPass(TEST), false);
    assert.equal(lockedProblem(TEST, ""), undefined);
    assert.deepEqual(mustPassFindings(root, false), []);
  });

  test("without the project's root nothing can be compared, so nothing is claimed", () => {
    setMustPass([TEST], undefined, { failing: { [TEST]: [FAILING_NAME] } });
    assert.equal(lockedProblem(TEST, "garbage"), undefined);
  });

  test("a new fix replaces the old lock; names compare without regard to case or slash direction", () => {
    lock();
    assert.equal(isMustPass("__tests__\\A.TEST.ts"), true);
    assert.equal(isMustPass("./__tests__/a.test.ts"), true);
    assert.equal(isMustPass(OTHER), false);
    setMustPass([OTHER], root);
    assert.equal(isMustPass(TEST), false);
  });
});

describe("the Editor's tools: a setup edit goes through, an edit to the failing tests' assertions is refused at once", () => {
  const tools = () => new AgentTools(root, { safety: {}, limits: {} } as any);

  test("a mock or setup change in the must-pass file is allowed, and so is a new test (no dead end)", async () => {
    lock();
    const t = tools();
    await t.patchFile(TEST, "({ one: 1 })", "({ one: 1, two: 2 })");
    assert.match(read(TEST), /two: 2/);
    await t.writeFile(TEST, read(TEST) + "\nit('a regression test', () => {\n  expect(2).toBe(2);\n});\n");
    assert.match(read(TEST), /a regression test/);
  });

  test("changing a failing test's assertion is refused BEFORE anything is written, with the reason and what is still allowed", async () => {
    lock();
    const before = read(TEST);
    await assert.rejects(
      () => tools().patchFile(TEST, "expect(pollStartCount()).toBe(2);", "expect(pollStartCount()).toBe(3);"),
      (e: Error) => {
        assert.match(e.message, /^\[MUST PASS\] __tests__\/a\.test\.ts: an assertion in the failing test "restarts the stream once on Back to Live" was changed or removed: expect\(pollStartCount\(\)\)\.toBe\(2\)\. /);
        assert.match(e.message, /The failing tests' own assertions are the spec for this fix and must stay exactly as written\. The file's mocks, setup, helpers and imports may be updated, and new tests added\./);
        assert.match(e.message, /Change the CODE it tests, or keep to the setup around the tests\.$/);
        return true;
      }
    );
    assert.equal(read(TEST), before, "the file is untouched");
  });

  test("a whole-file write that drops an assertion, a test, or skips one is refused the same way; one that keeps them is not", async () => {
    lock();
    const t = tools();
    await assert.rejects(() => t.writeFile(TEST, SRC.replace("      expect(commands()).toEqual(['ping']);\n", "")), /\[MUST PASS\].*was changed or removed/);
    await assert.rejects(() => t.writeFile(TEST, SRC.replace("it('shows a label'", "it.skip('shows a label'")), /\[MUST PASS\].*skips tests/);
    await assert.rejects(() => t.writeFile(TEST, "test('a', () => {});\n"), /\[MUST PASS\]/);
    assert.equal(read(TEST), SRC);
    await t.writeFile(TEST, SRC.replace("({ one: 1 })", "({ one: 9 })"));
    assert.match(read(TEST), /one: 9/);
  });

  test("however the path is spelled", async () => {
    lock();
    for (const spelling of ["./__tests__/a.test.ts", "__tests__\\a.test.ts", "__TESTS__/A.test.ts", path.join(root, TEST)]) {
      await assert.rejects(() => tools().patchFile(spelling, "toBe(2)", "toBe(3)"), /\[MUST PASS\]/, spelling);
    }
  });

  test("deleting the must-pass file is refused (it holds the failing tests); a different test file may be changed or deleted freely", async () => {
    lock();
    await assert.rejects(() => tools().stageFileForDeletion(TEST, "obsolete"), /\[MUST PASS\].*may not be deleted/);
    await tools().patchFile(OTHER, "({ one: 1 })", "({ one: 1, two: 2 })");
    assert.match(read(OTHER), /two: 2/);
    const res = await tools().stageFileForDeletion(OTHER, "obsolete");
    assert.ok(typeof res === "string");
  });

  test("an ordinary task: no lock, every edit goes through, assertions included", async () => {
    setMustPass([], root);
    await tools().patchFile(TEST, "expect(pollStartCount()).toBe(2);", "expect(pollStartCount()).toBe(3);");
    assert.match(read(TEST), /toBe\(3\)/);
  });

  test("a refusal does not use up the phase's budget of files it may change", async () => {
    lock();
    const t = tools();
    t.beginPhase([], 1, "fix");
    await assert.rejects(() => t.patchFile(TEST, "toBe(2)", "toBe(3)"), /\[MUST PASS\]/);
    await t.patchFile("src/x.ts", "two = 2", "two = 3");
  });
});

describe("QA checks again, as blocking findings", () => {
  test("setup changed and application code changed: nothing to report", () => {
    lock();
    w(TEST, SRC.replace("({ one: 1 })", "({ one: 1, two: 2 })"));
    assert.deepEqual(mustPassFindings(root, true), []);
    assert.deepEqual(mustPassFindings(root, undefined), []);
  });

  test("an assertion changed behind the tools' back (a command, say): a finding that says how to put it back", () => {
    lock();
    w(TEST, SRC.replace("toBe(2)", "toBe(3)"));
    const f = mustPassFindings(root, true);
    assert.equal(f.length, 1);
    assert.match(f[0], /^__tests__\/a\.test\.ts: an assertion in the failing test "restarts the stream once on Back to Live" was changed or removed/);
    assert.match(f[0], /Put the assertions back \(git diff __tests__\/a\.test\.ts shows what changed\) and change the CODE instead\.$/);
  });

  test("the file deleted: a finding", () => {
    lock();
    fs.rmSync(path.join(root, TEST));
    assert.match(mustPassFindings(root, true)[0], /^__tests__\/a\.test\.ts is gone: it was deleted while fixing the code it tests/);
  });

  test("NO application code changed: a finding, because a test that passes then passes because the TEST changed; unknown is not claimed", () => {
    lock();
    assert.match(mustPassFindings(root, false)[0], /^no application code was changed\. A test that passes now would pass because the TEST was changed, not because the bug was fixed/);
    assert.deepEqual(mustPassFindings(root, undefined), []);
    setMustPass([], root);
    assert.deepEqual(mustPassFindings(root, false), [], "an ordinary task has no such rule");
  });

  test("the gate runs these first, as failing, blocking items, with the change set deciding whether application code changed", () => {
    const src = fs.readFileSync("src/verifierTools.ts", "utf8");
    assert.match(src, /const appChanged = change \? \[\.\.\.change\.modified, \.\.\.change\.added\]\.some\(\(p\) => !isTestPath\(p\) && !isEvidenceNoise\(p\)\) : undefined;/);
    assert.match(src, /for \(const finding of mustPassFindings\(this\.repoRoot, appChanged\)\) \{\s*\n\s*ledger\.add\(\{ tier: "build", gate: "the tests this fix must pass are as written", method: "inspected", status: "fail", blocking: true, detail: finding \}\);/);
    assert.ok(src.indexOf("mustPassFindings(this.repoRoot, appChanged)") < src.indexOf("sel = selectTests(this.repoRoot, touched)"));
  });

  test("the original-file check runs after the test gate, and only when nothing blocks yet", () => {
    const src = fs.readFileSync("src/verifierTools.ts", "utf8");
    assert.match(src, /await this\.selectedTestGate\(hasRealChange \? change : undefined, ledger\);\s*\n[^\n]*\n\s*if \(!ledger\.hasBlockingFailure\(\)\) await this\.mustPassOriginalGate\(ledger\);/);
  });

  test("where a fix task starts, the lock is given the project's root and the names of the failing tests saved with the task", () => {
    const src = fs.readFileSync("src/index.ts", "utf8");
    assert.match(src, /if \(direct\) for \(const p of loadPendingFixes\(repoRoot\)\) failingByFile\[p\.file\] = p\.tests \?\? \[\];\s*\n\s*setMustPass\(direct \? direct\.tests : \[\], repoRoot, \{ failing: failingByFile \}\);/);
  });
});

describe("the original file against the fixed code: a self-standing fix, or a flag for a person", () => {
  test("changedMustPassTexts: only files that differ from when the fix began, with both texts", () => {
    lock();
    assert.deepEqual(changedMustPassTexts(root), []);
    w(TEST, SRC.replace("({ one: 1 })", "({ one: 2 })"));
    const c = changedMustPassTexts(root);
    assert.equal(c.length, 1);
    assert.deepEqual([c[0].file, c[0].original === SRC, c[0].current.includes("one: 2")], [TEST, true, true]);
  });

  test("reviewDiff shows what changed as - and +, skips blank lines, and bounds itself", () => {
    const d = reviewDiff("a\n\nb\nc\n", "a\nb\nd\n\n\ne\n");
    assert.deepEqual(d.sort(), ["+ d", "+ e", "- c"]);
    const many = reviewDiff("", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), 5);
    assert.equal(many.length, 6);
    assert.match(many[5], /^… and 25 more changed lines$/);
  });

  test("runOriginalCopy writes the ORIGINAL beside the real file under a name the test listing skips, runs it, and removes it, even if the run throws", async () => {
    lock();
    w(TEST, SRC.replace("toBe(2)", "toBe(3)")); // the Editor's version differs
    const seen: { file: string; text: string }[] = [];
    const run = async (_r: string, files: string[]) => {
      seen.push({ file: files[0], text: read(files[0]) });
      return { ok: true, output: "Tests: 3 passed" };
    };
    const r = await runOriginalCopy(run, root, TEST, SRC);
    assert.equal(r.ok, true);
    assert.match(seen[0].file, /^__tests__\/zz_probe_original_[a-z0-9]+_a\.test\.ts$/);
    assert.equal(seen[0].text, SRC, "the original text, not the Editor's");
    assert.equal(fs.existsSync(path.join(root, seen[0].file)), false, "removed afterwards");
    assert.match(read(TEST), /toBe\(3\)/, "the real file is untouched");
    await assert.rejects(() => runOriginalCopy(async () => { throw new Error("runner crashed"); }, root, TEST, SRC), /runner crashed/);
    assert.deepEqual(fs.readdirSync(path.join(root, "__tests__")).filter((f) => f.startsWith("zz_probe_")), []);
  });

  const gate = async (run: (root: string, files: string[]) => Promise<{ ok: boolean; output: string }>) => {
    const items: any[] = [];
    const v = Object.create(AutonomousVerifier.prototype) as any;
    v.repoRoot = root;
    await v.mustPassOriginalGate({ add: (x: any) => items.push(x) }, run);
    return items;
  };

  test("the file was NOT changed: nothing to check, no extra run", async () => {
    lock();
    let runs = 0;
    const items = await gate(async () => (runs++, { ok: true, output: "" }));
    assert.deepEqual(items, []);
    assert.equal(runs, 0);
  });

  test("the file was changed and the ORIGINAL passes against the fixed code: a passing, non-blocking item", async () => {
    lock();
    w(TEST, SRC.replace("({ one: 1 })", "({ one: 1, two: 2 })"));
    const items = await gate(async () => ({ ok: true, output: "Tests: 3 passed" }));
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].status, items[0].blocking], ["pass", false]);
    assert.match(items[0].detail, /the ORIGINAL file passes against the fixed code too: the fix stands on its own/);
  });

  test("the file was changed and the original does NOT pass: not a failure, a flag, with exactly what changed", async () => {
    lock();
    w(TEST, SRC.replace("({ one: 1 })", "({ one: 1, two: 2 })"));
    const items = await gate(async () => ({ ok: false, output: "Tests: 1 failed" }));
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].status, items[0].blocking], ["inconclusive", false]);
    assert.match(items[0].detail, /^REVIEW THE TEST CHANGES: the original __tests__\/a\.test\.ts does not pass against the fixed code, so the fix needed changes to the file's setup \(its failing tests' assertions are as written\)\. What changed:\n- jest\.mock\('\.\.\/src\/x', \(\) => \(\{ one: 1 \}\)\);\n\+ jest\.mock\('\.\.\/src\/x', \(\) => \(\{ one: 1, two: 2 \}\)\);$/);
  });
});

describe("the diagnosis reaches the Editor whole, without the report's cost lines, with the failing tests' names", () => {
  const DIAGNOSIS =
    "APP BUG: `app/dashboard.tsx:2705` and `app/dashboard.tsx:3033` tear down and restart the live poll stream twice when returning from archive mode via `Back to Live`. " +
    "- The poll-lifecycle `useEffect` (`app/dashboard.tsx:2337-2715`) lists `archiveTaskId` in its dependency array, so ... ".repeat(8) +
    "END-OF-DIAGNOSIS";
  test("diagnosisOf drops the sandbox's lines and the reuse note, and nothing of the diagnosis", () => {
    const note = `Expected: 2 — ${DIAGNOSIS} Still failing: 1. sandbox: [1×] Expected: 2 → app bug: APP BUG: app/dashboard.tsx:2705 … [4 test runs, $0.32] | sandbox: [7×] Unclustered … [4 test runs, $1.23] (the test's out-of-date parts were fixed: 186 lines changed)`;
    const d = diagnosisOf(note);
    assert.ok(d.endsWith("Still failing: 1."), d.slice(-60));
    assert.ok(d.includes("END-OF-DIAGNOSIS"));
    assert.ok(!/\$\d/.test(d) && !/test runs/.test(d) && !/sandbox:/.test(d));
    assert.equal(diagnosisOf("a plain diagnosis (nothing it depends on changed since it was last diagnosed)"), "a plain diagnosis");
    assert.equal(diagnosisOf("a plain diagnosis with no sandbox lines"), "a plain diagnosis with no sandbox lines");
  });
  test("fixItemsFor takes only the files that ended as a code bug, with the failure as a digest and the failing tests' names", () => {
    const results: HealResult[] = [
      { file: TEST, status: "code-bug", note: `${DIAGNOSIS} sandbox: [1×] x [1 test run, $0.10]`, attempts: 1, failure: `  ● ${FAILING_NAME}\n    Error: boom\n` },
      { file: OTHER, status: "healed", note: "fine", attempts: 1 },
      { file: "__tests__/c.test.ts", status: "unclear", note: "no idea", attempts: 1 },
    ];
    const items = fixItemsFor(results, root);
    assert.equal(items.length, 1);
    assert.equal(items[0].file, TEST);
    assert.ok(items[0].reason.includes("END-OF-DIAGNOSIS") && !items[0].reason.includes("$0.10"));
    assert.deepEqual(items[0].tests, [FAILING_NAME], "kept with the task: what THESE assert is what the fix may not change");
  });
  test("round trip: the task parses back to the whole diagnosis, and the real file the diagnosis names is where the Editor starts; the names survive in the pending store's shape", () => {
    w("app/dashboard.tsx", Array.from({ length: 3100 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
    const items: PendingFix[] = fixItemsFor([{ file: TEST, status: "code-bug", note: `${DIAGNOSIS} sandbox: [1×] x [1 test run, $0.10]`, attempts: 1, failure: `  ● ${FAILING_NAME}\n    Error: boom\n` }], root);
    const stored = JSON.parse(JSON.stringify(items)) as PendingFix[];
    assert.deepEqual(stored[0].tests, [FAILING_NAME]);
    const task = fixTaskFor(stored);
    const parsed = parseFixTask(task);
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].reason.includes("END-OF-DIAGNOSIS"), "the whole diagnosis, not the first 700 characters");
    assert.ok(!/\$0\.10|test run/.test(task));
    const d = directFixFor(task, root);
    assert.ok(d, "it goes straight to the Editor");
    assert.deepEqual(d!.files, ["app/dashboard.tsx"]);
    assert.deepEqual(d!.tests, [TEST]);
  });
  test("the heal keeps a long diagnosis whole in its result (it used to cut it to 700 characters)", async () => {
    w(TEST, "test-A1 BAD\ntest-B1 BAD\n");
    const run = async () => {
      const text = read(TEST);
      const bad = [...text.matchAll(/^(test-([AB]\d)) BAD$/gm)];
      if (bad.length === 0) return { ok: true, output: "Tests: 2 passed, 2 total" };
      return { ok: false, output: `FAIL ${TEST}\n${bad.map((m) => `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`).join("\n")}\nTests:       ${bad.length} failed, ${2 - bad.length} passed, 2 total` };
    };
    const replies = [
      JSON.stringify({ verdict: "stale-test", reason: "fixes A1", edits: [{ find: "test-A1 BAD", replace: "test-A1 OK" }] }),
      JSON.stringify({ verdict: "code-bug", reason: "src/x.ts:1 is wrong", codeBugs: ["src/x.ts:1"] }),
    ];
    let n = 0;
    const call: HealCall = async () => replies[Math.min(n++, replies.length - 1)];
    const long = `APP BUG: ${"the mechanism, step by step. ".repeat(50)}END-OF-DIAGNOSIS`;
    assert.ok(long.length > 1400 && long.length <= 1500);
    const sandbox = (async () => ({ appFilesTouched: [], conclusion: long, stop: "code-bug", rounds: 5, cost: 0.3, runs: 4 }) as SandboxResult) as SandboxRun;
    const r = (await healTests({ repoRoot: root, run, call, sandbox, settle: false })).results[0];
    assert.equal(r.status, "code-bug");
    assert.ok(r.note.includes("END-OF-DIAGNOSIS"), "the end of a 1,400+ character diagnosis is still there");
    assert.ok(diagnosisOf(r.note).includes("END-OF-DIAGNOSIS") && !diagnosisOf(r.note).includes("sandbox:"));
    assert.ok(DIAGNOSIS_CHARS >= 1500, "room for all the sandbox writes");
  });
});

describe("the benchmark shows what would be sent", () => {
  test("it builds the task with the same functions the CLI uses, prints it and saves it; it sends nothing", () => {
    const bench = fs.readFileSync("scripts/bench-heal.mjs", "utf8");
    assert.match(bench, /const items = fixItemsFor\(report\.results, REPO\);/);
    assert.match(bench, /fixTask = fixTaskFor\(items\);/);
    assert.match(bench, /directFixFor\(fixTask, REPO\)/);
    assert.match(bench, /fix-task-\$\{stamp\(\)\}-\$\{n\}\.txt/);
    assert.match(fs.readFileSync("src/index.ts", "utf8"), /const items = fixItemsFor\(report\.results, repoRoot\);/);
  });
});

describe("the refusal's wording", () => {
  test("it names the file and the problem and says what is still allowed", () => {
    assert.equal(
      refusalFor("__tests__/a.test.ts", "x was changed"),
      "[MUST PASS] __tests__/a.test.ts: x was changed. The failing tests' own assertions are the spec for this fix and must stay exactly as written. The file's mocks, setup, helpers and imports may be updated, and new tests added. Change the CODE it tests, or keep to the setup around the tests."
    );
  });
});
