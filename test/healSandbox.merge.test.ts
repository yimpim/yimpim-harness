/**
 * What comes back from the sandbox goes through the same per-test ratchet as every edit: it is kept only if it makes strictly more tests pass and
 * turns none that pass now red; app code is never written; a failure in the middle puts the file back. Same fixture as healPerCause.test.ts
 * (three causes: A breaks three tests, B two, C one), with a fake SandboxRun in place of the agent.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, candidateProblem, testsOfCause, type HealCall } from "../src/testHeal.js";
import type { SandboxResult, SandboxRun } from "../src/healSandbox.js";
import { AbortedError } from "../src/remote/control.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
const START = ["test-A1 BAD", "test-A2 BAD", "test-A3 BAD", "test-B1 BAD", "test-B2 BAD", "test-C1 BAD", ""].join("\n");
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbxmerge-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), START);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let runs = 0;
const runner = (text: string) => {
  const bad = [...text.matchAll(/^(test-([ABC]\d)) BAD$/gm)];
  if (bad.length === 0) return { ok: true, output: "Tests: 6 passed, 6 total" };
  const blocks = bad.map((m) => `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`);
  return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${6 - bad.length} passed, 6 total` };
};
const run = async () => (runs++, runner(read()));
const answer = (o: object) => JSON.stringify(o);
const fix = (...ids: string[]) => ids.map((id) => ({ find: `test-${id} BAD`, replace: `test-${id} OK` }));
const edits = (...ids: string[]) => answer({ verdict: "stale-test", reason: `fixes ${ids.join(",")}`, edits: fix(...ids) });
const park = (reason = "could not settle it") => answer({ verdict: "park", kind: "unsure", reason });
const model = (...replies: string[]) => {
  const shown: string[] = [];
  const call: HealCall = async (messages) => {
    shown.push(messages[messages.length - 1].content);
    return replies[Math.min(shown.length - 1, replies.length - 1)];
  };
  return { call, shown };
};
/** The first model fixes A and parks B and C: what is left for the sandbox. */
const firstModel = () => model(edits("A1", "A2", "A3"), park("B needs the reducer"), park("C needs the reducer"));
/** A sandbox that answers with whatever it is given, and records what it was asked. */
const sandbox = (make: (a: Parameters<SandboxRun>[0]) => Partial<SandboxResult> | Promise<Partial<SandboxResult>>) => {
  const asked: Parameters<SandboxRun>[0][] = [];
  const fn: SandboxRun = async (a) => {
    asked.push(a);
    return { appFilesTouched: [], conclusion: "done", stop: "concluded", rounds: 3, cost: 0.42, runs: 5, ...(await make(a)) };
  };
  return { fn, asked };
};
const fixed = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.replace(`test-${id} BAD`, `test-${id} OK`), text);
const heal = async (call: HealCall, sb: SandboxRun, extra: { escalate?: HealCall; log?: (l: string) => void; runFn?: typeof run } = {}) =>
  (await healTests({ repoRoot: dir, run: extra.runFn ?? run, call, sandbox: sb, escalate: extra.escalate, settle: false, log: extra.log })).results[0];

describe("a candidate from the sandbox, through the ratchet", () => {
  test("it fixes what was parked: kept, healed, the sandbox asked once with everything it needs to know", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), conclusion: "the reducer is debounced; the test now waits for it" }));
    const logs: string[] = [];
    const r = await heal(firstModel().call, sb.fn, { log: (l) => logs.push(l) });
    assert.equal(r.status, "healed");
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 OK\ntest-B2 OK\ntest-C1 OK\n");
    assert.equal(sb.asked.length, 1, "B's candidate also settled C, so C was never sent");
    const a = sb.asked[0];
    assert.equal(a.cause.message, "Error: cause B broke");
    assert.equal(a.cause.count, 2);
    assert.deepEqual(a.cause.tests, ["test-B1", "test-B2"]);
    assert.equal(a.cause.reason, "B needs the reducer");
    assert.match(a.ledger.join("\n"), /\[3× fixed\] Error: cause A broke/);
    assert.match(a.firstModelNotes, /fixes A1,A2,A3/);
    assert.match(a.failureDigest, /cause B broke/);
    assert.match(a.testText, /test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD/, "the sandbox is handed the file as the first model left it");
    assert.match(r.note, /sandbox settled the rest/);
    assert.match(r.note, /sandbox: \[2×\] Error: cause B broke → kept \(\+3 passing\) \[5 test runs, \$0\.42\]/);
    assert.ok(logs.some((l) => /↗ .*2 causes the first model could not settle go to the sandbox/.test(l)));
  });

  test("a candidate that fixes B but breaks A, which the first model fixed, is rejected and the file goes back to the first model's result", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2").replace("test-A1 OK", "test-A1 BAD") }));
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 BAD\n", "exactly what the first model left");
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true, "the first model's progress is kept");
    assert.match(r.note, /it fixed test-B1 \| test-B2, but it broke test-A1, which passed before/);
  });

  test("a candidate that makes no more tests pass is rejected (a change that only moves things around is not kept)", async () => {
    const sb = sandbox((a) => ({ candidate: `// a comment\n${a.testText}` }));
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 BAD\n");
    assert.match(r.note, /not kept: it did not make any more tests pass/);
  });

  test("a candidate that skips a test is refused BEFORE anything is run", async () => {
    const sb = sandbox((a) => ({ candidate: `xit('quietly skipped', () => {});\n${fixed(a.testText, "B1", "B2", "C1")}` }));
    const before = runs;
    const r = await heal(firstModel().call, sb.fn);
    const ranForCandidate = runs - before;
    assert.match(r.note, /its test file was refused: it skips tests that were running/);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 BAD\n");
    assert.ok(ranForCandidate <= 6, "no extra run was made for the refused candidate");
  });

  test("part of a cause fixed: kept, and what is left is still named with its new count", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1") }));
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 OK\ntest-B2 BAD\ntest-C1 BAD\n");
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true);
    assert.match(r.note, /\[1×\] Error: cause B broke/, "B is down to one");
    assert.match(r.note, /\[1×\] Error: cause C broke/);
    assert.equal(sb.asked.length, 2, "B (partly settled) and then C each went once");
  });
});

describe("what the sandbox may say instead of a candidate", () => {
  test("an app bug: the cause stays parked as the app's, the evidence is in the note, and the status is code-bug", async () => {
    const sb = sandbox(() => ({ stop: "code-bug", conclusion: "APP BUG: src/x.ts:12 renders the wrong thing; the spec says otherwise.", appFilesTouched: ["src/x.ts"] }));
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true, "the first model's fixes are kept");
    assert.match(r.note, /src\/x\.ts:12/);
    assert.match(r.note, /evidence: app files changed in the sandbox: src\/x\.ts/);
    assert.match(read(), /^test-A1 OK/);
  });

  test("it ran out of budget: the cause stays parked with the reason, the cost is in the report, nothing is lost", async () => {
    const sb = sandbox(() => ({ stop: "budget", conclusion: "budget: $0.80 of $0.75 spent on this cause", cost: 0.8 }));
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true);
    assert.match(r.note, /the sandbox could not settle it \(budget\)/);
    assert.match(r.note, /\[5 test runs, \$0\.80\]/);
  });

  test("a sandbox that could not be made (the preflight): said so, and the heal ends as it would without one", async () => {
    const sb = sandbox(() => ({ stop: "preflight", conclusion: "the sandbox does not reproduce the failure", runs: 0, cost: 0 }));
    const r = await heal(firstModel().call, sb.fn);
    assert.match(r.note, /→ not run: the sandbox does not reproduce the failure/);
    assert.equal(r.partial, true);
  });

  test("a sandbox that throws does not end the heal: the other cause still goes", async () => {
    let n = 0;
    const sb = sandbox(async (a) => {
      if (n++ === 0) throw new Error("provider exploded");
      return { candidate: fixed(a.testText, "C1") };
    });
    const r = await heal(firstModel().call, sb.fn);
    assert.equal(sb.asked.length, 2);
    assert.match(r.note, /→ failed: provider exploded/);
    assert.match(read(), /test-C1 OK/);
  });

  test("a user Stop is not swallowed", async () => {
    const sb = sandbox(() => {
      throw new AbortedError("stopped by the user");
    });
    await assert.rejects(() => heal(firstModel().call, sb.fn), AbortedError);
  });
});

describe("safety of the merge itself", () => {
  test("a crash while the candidate is being judged puts the file back at once and leaves no record behind", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      // runs: 1 the suite's first look, 2 the file on its own, 3 after the first model's edits, 4 the sandbox's candidate: that one crashes
      if (calls >= 4) throw new Error("runner crashed");
      return runner(read());
    };
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1") }));
    await assert.rejects(() => heal(firstModel().call, sb.fn, { runFn: flaky as any }), /runner crashed/);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 BAD\n", "the candidate was undone");
    const pending = path.join(dir, ".agent", "heal-pending");
    assert.deepEqual(fs.existsSync(pending) ? fs.readdirSync(pending) : [], []);
  });

  test("when a sandbox is given, the JSON stronger-model pass is not also run", async () => {
    let escalated = 0;
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1") }));
    await heal(firstModel().call, sb.fn, { escalate: async () => (escalated++, park()) });
    assert.equal(escalated, 0);
  });

  test("the sandbox is never called when the first model settles everything", async () => {
    const sb = sandbox(() => ({}));
    const r = await heal(model(edits("A1", "A2", "A3", "B1", "B2", "C1")).call, sb.fn);
    assert.equal(r.status, "healed");
    assert.equal(sb.asked.length, 0);
  });
});

describe("candidateProblem", () => {
  const file = (n: number, extra = "") => Array.from({ length: n }, (_, i) => `test('t${i}', () => { expect(${i}).toBe(${i}); });`).join("\n") + extra;
  test("fewer tests, thinner assertions, a skip, a .only: all refused; an ordinary fix is not", () => {
    assert.match(candidateProblem(file(5), file(4)) ?? "", /4 tests where there were 5/);
    assert.match(candidateProblem(file(5), file(5).replace(/expect\(\d\)\.toBe\(\d\)/g, "void 0")) ?? "", /0 assertions where there were 5/);
    assert.match(candidateProblem(file(5), file(5, "\nxit('x', () => {});")) ?? "", /skips/);
    assert.match(candidateProblem(file(5), file(5).replace("test('t0'", "test.only('t0'")) ?? "", /\.only/);
    assert.equal(candidateProblem(file(5), file(5).replace("toBe(1)", "toBe(2)")), undefined);
    assert.equal(candidateProblem(file(5), file(6)), undefined, "more tests are fine");
  });
});

describe("testsOfCause", () => {
  test("lists the failing tests whose failure carries the cause's error line", () => {
    const out = "  ● Suite › a\n    Error: cause A broke\n\n  ● Suite › b\n    Error: cause B broke 12\n\n  ● Suite › c\n    Error: cause B broke 99\n\n  ● Console\n    Error: cause A broke\n";
    assert.deepEqual(testsOfCause(out, "Error: cause A broke"), ["Suite › a"]);
    assert.deepEqual(testsOfCause(out, "Error: cause B broke #"), ["Suite › b", "Suite › c"], "numbers are taken out of the signature, as the digest does");
    assert.deepEqual(testsOfCause(out, "something else"), []);
  });
});
