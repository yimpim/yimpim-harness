/**
 * The Editor keeps its tests current: before it may conclude, the tests its change can reach are run; a test its change made stale is sent back to it once for each
 * distinct set of failures; what it cannot fix goes to the heal before QA; it may not "fix" a test by deleting, skipping or thinning it.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EditorSweep, outputFailed, type SweepDeps } from "../src/editorSweep.js";
import { AgentTools, TOOLS_SCHEMA, RUN_AFFECTED_TESTS_TOOL, READ_ONLY_TOOLS_SCHEMA, PLANNER_TOOLS_SCHEMA, DISCOVERY_TOOLS_SCHEMA } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";

let root = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const w = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), s);
};
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const TEST = "__tests__/a.test.ts";
const GREEN = "Tests:       2 passed, 2 total";
const RED = (title = "Poll › restarts once") => `FAIL ${TEST}\n  ● ${title}\n\n    expect(received).toBe(expected)\n    Expected: 1\n    Received: 2\n      at src/a.ts:3:1\n\nTests:       1 failed, 1 passed, 2 total`;

/** A sweep whose runner is a script: what each test file prints, and a record of every file it was asked to run. */
const make = (over: Partial<SweepDeps> & { output?: () => string } = {}) => {
  const ran: string[] = [];
  const healed: string[][] = [];
  const out = over.output ?? (() => GREEN);
  const deps: SweepDeps = {
    repoRoot: root,
    written: () => ["src/a.ts"],
    select: () => ({ selected: [TEST] }),
    failsBefore: async () => new Set<string>(),
    runFile: async (f) => (ran.push(f), { refused: false, text: "", output: out() }),
    heal: async (files) => (healed.push(files), { results: files.map((file) => ({ file, status: "healed", note: "", attempts: 1 }) as any) }),
    ...over,
  };
  return { sweep: new EditorSweep(deps), ran, healed };
};

describe("outputFailed", () => {
  test("Jest and Vitest style failures, and nothing for a green run", () => {
    assert.equal(outputFailed(RED()), true);
    assert.equal(outputFailed("Test Suites: 1 failed, 1 total"), true);
    assert.equal(outputFailed("\u001b[31mFAIL\u001b[0m __tests__/x.test.ts"), true);
    assert.equal(outputFailed(GREEN), false);
    assert.equal(outputFailed(""), false);
  });
});

describe("a test the change made stale", () => {
  test("is sent back with the failing title and a digest, once; the second time with the same failures there is no third bounce, and the heal gets those files", async () => {
    const { sweep, healed } = make({ output: () => RED() });
    const first = await sweep.check();
    assert.equal(first.kind, "bounce");
    const m = (first as any).message as string;
    assert.match(m, /^your change breaks 1 test file that passed before it: __tests__\/a\.test\.ts \(failing: Poll › restarts once\)\./);
    assert.match(m, /Expected: 1/);
    assert.match(m, /update the test \(change the expected value or selector; never delete or weaken an assertion\); if the test is right, fix your code\. Run run_affected_tests to check, then conclude again\.$/);
    const second = await sweep.check();
    assert.equal(healed.length, 1);
    assert.deepEqual(healed[0], [TEST]);
    assert.equal(second.kind, "clean", "the heal brought it up to date");
    assert.match((second as any).note, /was brought up to date by the heal/);
  });

  test("what the heal cannot settle goes to QA as it is, said plainly, and the heal is asked only once", async () => {
    const { sweep, healed } = make({ output: () => RED(), heal: async (files) => (healed2.push(files), { results: files.map((file) => ({ file, status: "code-bug", note: "app bug", attempts: 1 }) as any) }) });
    const healed2: string[][] = [];
    await sweep.check();
    const handed = await sweep.check();
    assert.equal(handed.kind, "handed");
    assert.match((handed as any).note, /1 test file is still red after the heal and go to QA as they are: __tests__\/a\.test\.ts \(code-bug\)/);
    const third = await sweep.check();
    assert.equal(third.kind, "handed");
    assert.equal(healed2.length, 1);
    assert.equal(healed.length, 0);
  });

  test("a different set of failures after the Editor's fix is a new bounce, not the end of the line", async () => {
    let title = "Poll › restarts once";
    const { sweep } = make({ output: () => RED(title) });
    assert.equal((await sweep.check()).kind, "bounce");
    title = "Poll › shows a label";
    assert.equal((await sweep.check()).kind, "bounce");
  });

  test("green after the Editor's fix: concluded, with the count in the note (it goes into the conclusion)", async () => {
    let red = true;
    const { sweep } = make({ output: () => (red ? RED() : GREEN) });
    assert.equal((await sweep.check()).kind, "bounce");
    red = false;
    assert.deepEqual(await sweep.check(), { kind: "clean", note: "1 affected test file pass" });
  });

  test("without a heal to hand to, the tests go to QA as they are", async () => {
    const { sweep } = make({ output: () => RED(), heal: undefined });
    await sweep.check();
    assert.equal((await sweep.check()).kind, "handed");
  });

  test("a new phase forgets everything: the same failures bounce again", async () => {
    const { sweep } = make({ output: () => RED() });
    assert.equal((await sweep.check()).kind, "bounce");
    sweep.reset();
    assert.equal((await sweep.check()).kind, "bounce");
  });
});

describe("what is not this ticket's", () => {
  test("a test that was already failing before the phase is not bounced", async () => {
    const { sweep } = make({ output: () => RED(), failsBefore: async () => new Set([TEST]) });
    const r = await sweep.check();
    assert.equal(r.kind, "clean");
    assert.match((r as any).note, /already failing before this phase/);
  });
  test("the baseline is taken once per file per phase", async () => {
    let calls = 0;
    const { sweep } = make({ output: () => RED(), failsBefore: async () => (calls++, new Set<string>()) });
    await sweep.check();
    await sweep.check();
    assert.equal(calls, 1);
  });
  test("a phase that wrote no source file (only tests, or nothing) has no sweep and runs nothing", async () => {
    for (const written of [[], [TEST], ["__tests__/_focus/x.test.ts"], [".agent/log.txt"]]) {
      const { sweep, ran } = make({ written: () => written, output: () => RED() });
      assert.deepEqual(await sweep.check(), { kind: "clean" }, JSON.stringify(written));
      assert.equal(ran.length, 0);
    }
  });
  test("when no test reaches the change, nothing is run", async () => {
    const { sweep, ran } = make({ select: () => ({ selected: [] }) });
    assert.deepEqual(await sweep.check(), { kind: "clean" });
    assert.equal(ran.length, 0);
  });
  test("only the tests the selection names are run", async () => {
    const { sweep, ran } = make({ select: () => ({ selected: ["__tests__/a.test.ts", "__tests__/b.test.ts"] }) });
    await sweep.check();
    assert.deepEqual(ran, ["__tests__/a.test.ts", "__tests__/b.test.ts"]);
  });
});

describe("it may update a test, never remove or thin one", () => {
  const TWO = "describe('a', () => {\n  it('one', () => {\n    expect(1).toBe(1);\n  });\n  it('two', () => {\n    expect(2).toBe(2);\n  });\n});\n";
  const commitTest = (text: string) => {
    w(TEST, text);
    w("src/a.ts", "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  };
  test("a test deleted, a .skip, a .only: bounced with the reason, once; a test updated in place is fine", async () => {
    commitTest(TWO);
    const written = () => ["src/a.ts", TEST];
    const { sweep, ran } = make({ written });
    w(TEST, TWO.replace("expect(2).toBe(2);", "expect(2).toBe(3);")); // an updated expectation
    assert.equal((await sweep.check()).kind, "clean");
    assert.equal(ran.length, 1, "it ran");

    w(TEST, "describe('a', () => {\n  it('one', () => {\n    expect(1).toBe(1);\n  });\n});\n");
    const gone = await sweep.check();
    assert.equal(gone.kind, "bounce");
    assert.match((gone as any).message, /a test file you changed is not acceptable: __tests__\/a\.test\.ts: it has 1 tests where there were 2\./);
    assert.match((gone as any).message, /never removed, skipped, narrowed with \.only, or given weaker assertions/);
    assert.notEqual((await sweep.check()).kind, "bounce", "once for the same reason, never a loop");

    const { sweep: s2 } = make({ written });
    w(TEST, TWO.replace("it('two'", "it.only('two'"));
    assert.match(((await s2.check()) as any).message, /narrows the file to some tests with \.only/);
    const { sweep: s3 } = make({ written });
    w(TEST, TWO.replace("it('one'", "it.skip('one'"));
    assert.equal((await s3.check()).kind, "bounce");
  });
  test("a new test file has no earlier version to compare with: accepted", async () => {
    w("src/a.ts", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    w(TEST, "it('new', () => {});\n");
    const { sweep } = make({ written: () => ["src/a.ts", TEST] });
    assert.equal((await sweep.check()).kind, "clean");
  });
});

describe("the gate", () => {
  test("code the gate refuses to run is reported to the Editor, with the reason, and is not mistaken for a test failure", async () => {
    const { sweep } = make({ runFile: async () => ({ refused: true, text: "run_test refused: src/a.ts contains text written to steer a security reviewer. Remove that code; the sandbox does not run it.", output: "" }) });
    const r = await sweep.check();
    assert.equal(r.kind, "bounce");
    assert.match((r as any).message, /^the tests could not be run: run_test refused: src\/a\.ts contains text written to steer/);
  });
});

describe("run_affected_tests", () => {
  test("pass, fail with the digest (and what was already failing), none reached, none yet", async () => {
    const green = make();
    assert.equal(await green.sweep.runNow(), "1 affected test file pass: __tests__/a.test.ts");
    const red = make({ output: () => RED() });
    const text = await red.sweep.runNow();
    assert.match(text, /^1 of 1 affected test file fails \(1 because of your change\)\.\nFailing: Poll › restarts once\n/);
    assert.match(text, /Expected: 1/);
    const before = make({ output: () => RED(), failsBefore: async () => new Set([TEST]) });
    assert.match(await before.sweep.runNow(), /1 of 1 affected test file fails; __tests__\/a\.test\.ts already failed before this phase and are not yours to fix\./);
    assert.match(await make({ select: () => ({ selected: [] }) }).sweep.runNow(), /^No test reaches the files you have changed so far/);
    assert.match(await make({ written: () => [] }).sweep.runNow(), /^No test reaches the files you have changed so far/);
  });
});

describe("in the harness", () => {
  test("AgentTools: no sweep set means no check and a plain answer; a sweep that throws never stands in the way", async () => {
    const t = new AgentTools(root, { safety: {}, limits: {} } as any);
    assert.equal(await t.affectedTestsCheck(), undefined);
    assert.equal(await t.runAffectedTests(), "run_affected_tests is not available here");
    t.setAffectedTests({ check: async () => { throw new Error("boom"); }, runNow: async () => { throw new Error("boom"); }, reset() {} } as any);
    assert.equal(await t.affectedTestsCheck(), undefined);
    assert.match(await t.runAffectedTests(), /^The affected tests could not be run: boom/);
  });
  test("a new phase resets the sweep", () => {
    let resets = 0;
    const t = new AgentTools(root, { safety: {}, limits: {} } as any);
    t.setAffectedTests({ reset: () => resets++ } as any);
    t.beginPhase([], 0, "p1");
    t.beginPhase([], 0, "p2");
    assert.equal(resets, 2);
  });
  test("the tool is offered to the default (editing) tool set only, never to the read-only, planner or discovery sets, and only EDITOR and REPAIR may call it", () => {
    const names = (l: any[]) => l.map((t) => t.function.name);
    assert.ok(names(TOOLS_SCHEMA).includes("run_affected_tests"));
    assert.equal(RUN_AFFECTED_TESTS_TOOL.function.name, "run_affected_tests");
    for (const set of [READ_ONLY_TOOLS_SCHEMA, PLANNER_TOOLS_SCHEMA, DISCOVERY_TOOLS_SCHEMA]) assert.ok(!names(set).includes("run_affected_tests"));
    const loop = src("src/agentLoop.ts");
    assert.ok(loop.includes('} else if (name === "run_affected_tests" && EDITING_AGENTS.has(agentName)) {'));
  });
  test("the Editor's conclusion waits on the sweep, not for a fix whose tests are the spec, and the result goes into the conclusion", () => {
    const loop = src("src/agentLoop.ts");
    const at = loop.indexOf("const swept = await agentTools.affectedTestsCheck();");
    assert.ok(at > loop.indexOf("agentTools.unseenTestReferences()"));
    assert.ok(loop.slice(at - 300, at).includes('EDITING_AGENTS.has(agentName) && args.status === "FINISHED_PATCHING" && !anyMustPass()'));
    assert.ok(loop.includes("`TASK_CONCLUDED: ${args.explanation}${sweepNote ? ` (${sweepNote})` : \"\"}` +"));
  });
  test("the verifier and the sweep select tests with the SAME function, so they cannot drift", () => {
    assert.ok(src("src/verifierTools.ts").includes("({ sel, staleCount } = selectForChange(this.repoRoot, touched));"));
    assert.ok(src("src/editorSweep.ts").includes("selectForChange(r, t).sel"));
    assert.ok(!/selectTests\(this\.repoRoot, touched\)/.test(src("src/verifierTools.ts")));
  });
  test("the sweep screens only what the Editor writes (the tree at the start of the phase counts as run), through the panel, and hands leftovers to the same heal the verifier uses", () => {
    const s = src("src/editorSweep.ts");
    assert.ok(s.includes("preapproveCurrent: true,"));
    const idx = src("src/index.ts");
    assert.ok(idx.includes("review: panelReviewerFor(client, config) ?? makeCommandReviewer("));
    assert.ok(idx.includes("heal: healerFor(client, config, repoRoot,"));
    assert.ok(idx.includes("if (config.heal?.editorSweep !== false) {"));
    assert.ok(!/gemini|hydrogen|deepseek/i.test(s), "no model name is built in");
  });
  test("it is on by default and can be turned off", () => {
    assert.equal((ConfigSchema.shape as any).heal.parse({}).editorSweep, true);
    assert.equal((ConfigSchema.shape as any).heal.parse({ editorSweep: false }).editorSweep, false);
  });
});
