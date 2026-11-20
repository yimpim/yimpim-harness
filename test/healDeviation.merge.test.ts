/**
 * Two things that went wrong in a benchmark, and the policy that fixes them.
 *
 * 1. The first model said "the app is wrong" about ONE cause (the yes/no buttons are labelled `yes` where the spec says `Yes`), and with the sandbox on
 *    that single claim ended the whole file after four minutes with 28 tests still failing and the sandbox never run. A claim is about one cause: that cause
 *    is parked, the sweep goes on, and the stronger model decides.
 * 2. Whether a spec-versus-app difference blocks anything is not the cheap model's call, and a test may not be bent to pass without proof. A DEFECT (the
 *    app is wrong in a way that blocks, crashes, loses data or shows wrong functional data) never bends a test. A DEVIATION (cosmetic: a label, its casing,
 *    wording, order, styling) lets the test follow the working app, under four guardrails: concrete evidence, no check removed, the per-test ratchet and a
 *    cap, and one deduplicated follow-up ticket.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, renderHealReport, type HealCall } from "../src/testHeal.js";
import type { SandboxResult, SandboxRun } from "../src/healSandbox.js";
import type { DeviationRecord } from "../src/healDeviation.js";
import { saveRoadmap, loadRoadmap } from "../src/roadmap.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
const START = ["test-A1 BAD", "test-A2 BAD", "test-A3 BAD", "test-B1 BAD", "test-B2 BAD", "test-C1 BAD", ""].join("\n");
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
const write = (text: string) => fs.writeFileSync(path.join(dir, TEST), text);
const FIRST_MODEL_RESULT = "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 BAD\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "devmerge-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "docs"));
  write(START);
  fs.writeFileSync(path.join(dir, "src/App.tsx"), Array.from({ length: 30 }, (_, i) => `// app line ${i + 1}`).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "docs/SPEC.md"), Array.from({ length: 10 }, (_, i) => `Spec line ${i + 1}: the buttons are labelled Yes and No.`).join("\n") + "\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const runner = (text: string) => {
  const bad = [...text.matchAll(/^(test-([ABC]\d)) BAD$/gm)];
  if (bad.length === 0) return { ok: true, output: "Tests: 6 passed, 6 total" };
  const blocks = bad.map((m) => `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`);
  return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${6 - bad.length} passed, 6 total` };
};
const run = async () => runner(read());
const answer = (o: object) => JSON.stringify(o);
const fix = (...ids: string[]) => ids.map((id) => ({ find: `test-${id} BAD`, replace: `test-${id} OK` }));
const edits = (...ids: string[]) => answer({ verdict: "stale-test", reason: `fixes ${ids.join(",")}`, edits: fix(...ids) });
const appWrong = (reason: string) => answer({ verdict: "code-bug", reason, codeBugs: [reason] });
const model = (...replies: string[]) => {
  const shown: string[] = [];
  const call: HealCall = async (messages) => {
    shown.push(messages[messages.length - 1].content);
    return replies[Math.min(shown.length - 1, replies.length - 1)];
  };
  return { call, shown };
};
const fixed = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.replace(`test-${id} BAD`, `test-${id} OK`), text);
const dev = (over: Partial<DeviationRecord> = {}): DeviationRecord => ({ appFile: "src/App.tsx", appLine: 12, specFile: "docs/SPEC.md", specLine: 5, summary: "The spec labels the buttons Yes/No; the app shows yes/no.", ...over });
const sandbox = (make: (a: Parameters<SandboxRun>[0]) => Partial<SandboxResult> | Promise<Partial<SandboxResult>>, cap?: number) => {
  const asked: Parameters<SandboxRun>[0][] = [];
  const fn = (async (a: Parameters<SandboxRun>[0]) => {
    asked.push(a);
    return { appFilesTouched: [], conclusion: "the test now expects what the working app shows", stop: "concluded", rounds: 3, cost: 0.2, runs: 4, ...(await make(a)) } as SandboxResult;
  }) as SandboxRun;
  if (cap !== undefined) fn.deviationTestCap = cap;
  return { fn, asked };
};
const heal = async (call: HealCall, sb?: SandboxRun, log?: (l: string) => void) => (await healTests({ repoRoot: dir, run, call, sandbox: sb, settle: false, log })).results[0];

const CLAIM_B = "src/App.tsx:12 shows yes but docs/SPEC.md:5 says Yes";
/** The first model fixes A, says the app is wrong about B, and parks C too: what is left for the stronger model. */
const claimsB = () => model(edits("A1", "A2", "A3"), appWrong(CLAIM_B), appWrong("src/App.tsx:20 differs from docs/SPEC.md:6"));

describe("1. a claim that the app is wrong parks THAT cause and the sweep goes on (with the sandbox on)", () => {
  test("the first model is asked again after the claim and fixes the next cause; the sandbox gets only the claimed one, as the app's, with the places it named", async () => {
    const m = model(edits("A1", "A2", "A3"), appWrong(CLAIM_B), edits("C1"));
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev()] }));
    const r = await heal(m.call, sb.fn);
    assert.equal(m.shown.length, 3, "the first model was asked three times: the claim did not end the file");
    assert.equal(sb.asked.length, 1);
    const c = sb.asked[0].cause;
    assert.equal(c.kind, "code");
    assert.equal(c.message, "Error: cause B broke");
    assert.match(c.reason, /src\/App\.tsx:12 shows yes but docs\/SPEC\.md:5 says Yes/);
    assert.deepEqual(c.refs, ["src/App.tsx:12", "docs/SPEC.md:5"], "the places it named, for checking");
    assert.match(sb.asked[0].testText, /test-C1 OK/, "C was already fixed by the first model when the sandbox was called");
    assert.equal(r.status, "healed");
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 OK\ntest-B2 OK\ntest-C1 OK\n");
  });

  test("an app-deviation claim is handled the same way: parked and sent on, never a test edit by the cheap model", async () => {
    const m = model(edits("A1", "A2", "A3"), answer({ verdict: "app-deviation", reason: "the test follows the spec", appDeviations: ["docs/SPEC.md:5 says Yes; src/App.tsx:12 shows yes"] }), edits("C1"));
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev()] }));
    const r = await heal(m.call, sb.fn);
    assert.equal(m.shown.length, 3);
    assert.equal(sb.asked[0].cause.kind, "code");
    assert.match(sb.asked[0].cause.reason, /docs\/SPEC\.md:5 says Yes; src\/App\.tsx:12 shows yes/, "what the first model said about the deviation is handed on");
    assert.equal(r.status, "healed");
  });

  test("the first model never edits a test to follow the app by itself: its claim alone changes nothing", async () => {
    const sb = sandbox(() => ({ stop: "concluded", conclusion: "could not settle it" }));
    await heal(model(edits("A1", "A2", "A3"), appWrong(CLAIM_B), appWrong("src/App.tsx:20 differs from docs/SPEC.md:6")).call, sb.fn);
    assert.equal(read(), FIRST_MODEL_RESULT, "B and C are exactly as they were");
  });

  test("with neither a sandbox nor an escalate pass, a claim ends the file as it always did (a fix task is queued for the code)", async () => {
    const r = await heal(model(edits("A1", "A2", "A3"), appWrong(CLAIM_B)).call);
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    assert.equal(read(), FIRST_MODEL_RESULT);
  });
});

describe("2. defect or deviation: the stronger model decides, and the cheap model never bends a test alone", () => {
  test("a DEFECT: the sandbox says the app is wrong; the test is not bent, the status is code-bug with its runtime evidence, the first model's fixes are kept", async () => {
    const sb = sandbox(() => ({ stop: "code-bug", conclusion: "APP BUG: src/App.tsx:12 sends 'no' when 'Yes' is pressed (run_test: Expected 'yes', Received 'no')", appFilesTouched: ["src/App.tsx"] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    assert.match(r.note, /sends 'no' when 'Yes' is pressed/);
    assert.equal(read(), FIRST_MODEL_RESULT, "the test was not bent");
  });

  test("a DEVIATION: the test follows the working app, the deviation is in the report with both places, and nothing is called a code bug", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(r.status, "healed");
    assert.deepEqual(r.acceptedDeviations, ["app src/App.tsx:12 vs spec docs/SPEC.md:5: The spec labels the buttons Yes/No; the app shows yes/no."]);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 OK\ntest-B2 OK\ntest-C1 OK\n");
  });

  test("the report says so, in its own section, separate from a spec contradiction nobody acted on", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev()] }));
    const rep = await healTests({ repoRoot: dir, run, call: claimsB().call, sandbox: sb.fn, settle: false });
    const text = renderHealReport(rep);
    assert.match(text, /The app works but differs from its written spec here\. The test now follows the app/);
    assert.match(text, /__tests__\/p\.test\.ts: app src\/App\.tsx:12 vs spec docs\/SPEC\.md:5/);
    assert.doesNotMatch(text, /nothing was changed or queued: you decide/, "that section is for a deviation nobody acted on");
  });
});

describe("3a. guardrail: concrete evidence", () => {
  const rejected = async (make: Parameters<typeof sandbox>[0], expectWhy: RegExp) => {
    const sb = sandbox(make);
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(read(), FIRST_MODEL_RESULT, "the file is exactly what the first model left");
    assert.match(r.note, expectWhy);
    assert.equal(r.acceptedDeviations, undefined, "nothing was accepted");
    return r;
  };
  test("the test was changed to follow the app but no deviation was recorded: not kept", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2") }), /no deviation was recorded \(the app's file:line and the spec's file:line\), so it was not kept/);
  });
  test("an app reference that is not in the project: not kept", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev({ appFile: "src/Nope.tsx" })] }), /did not hold up against the project \(app: src\/Nope\.tsx does not exist/);
  });
  test("an app reference past the end of the file: not kept", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev({ appLine: 500 })] }), /app: src\/App\.tsx has 30 lines, so line 500 does not exist/);
  });
  test("a spec reference that is not in the project: not kept", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev({ specFile: "docs/Missing.md" })] }), /spec: docs\/Missing\.md does not exist/);
  });
  test("the 'app' is a test file: not kept (a test is not what a test follows)", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev({ appFile: TEST })] }), /is a test file/);
  });
  test("one good record and one that does not hold up: the whole change is not kept", async () => {
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev(), dev({ specLine: 999, appLine: 3 })] }), /did not hold up against the project/);
  });
  test("the evidence is checked against the REAL project, not only the sandbox's copy", async () => {
    // The sandbox's own check passed (it said so), but the file it pointed at is not in the real project.
    fs.rmSync(path.join(dir, "docs/SPEC.md"));
    await rejected((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev()] }), /spec: docs\/SPEC\.md does not exist/);
  });
  test("a change the first model did NOT call spec-versus-app needs no deviation record (an ordinary stale test)", async () => {
    const m = model(edits("A1", "A2", "A3"), answer({ verdict: "park", kind: "unsure", reason: "needs the reducer" }), edits("C1"));
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2") }));
    const r = await heal(m.call, sb.fn);
    assert.equal(r.status, "healed");
    assert.equal(r.acceptedDeviations, undefined);
  });
});

describe("3b. guardrail: no assertion gutting", () => {
  const withExpects = (n: number) => START + Array.from({ length: n }, (_, i) => `expect(v${i}).toBe(${i});`).join("\n") + "\n";
  const run20 = async (make: (t: string) => string, why: RegExp) => {
    write(withExpects(20));
    const before = read();
    const sb = sandbox((a) => ({ candidate: make(fixed(a.testText, "B1", "B2", "C1")), deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.match(r.note, why);
    assert.equal(read(), fixed(before, "A1", "A2", "A3"), "the first model's result: the gutted change was not kept");
    assert.equal(r.acceptedDeviations, undefined);
  };
  test("removing an expect(...) to get a pass is refused (one in twenty is within the ordinary 95% limit, and still refused here)", async () => {
    await run20((t) => t.replace("expect(v7).toBe(7);\n", ""), /a test changed to follow the app may not lose checks: it has 19 expect\(\.\.\.\) calls where there were 20/);
  });
  test("an assertion turned into one that cannot fail is refused", async () => {
    await run20((t) => t.replace("expect(v7).toBe(7);", "expect(v7).toBeDefined();"), /may not lose checks: it replaces specific assertions with ones that cannot fail/);
  });
  test("changing what is expected, keeping every check, is accepted", async () => {
    write(withExpects(20));
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1").replace("expect(v7).toBe(7);", "expect(label(v7)).toBe('Yes');"), deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(r.status, "healed");
    assert.match(read(), /expect\(label\(v7\)\)\.toBe\('Yes'\);/);
  });
});

describe("3c. guardrail: the ratchet, and a cap on the tests one deviation may change", () => {
  const blocks = ["test-A1 BAD", "test-A2 BAD", "test-A3 BAD", "test('t1', () => {", "test-B1 BAD", "});", "test('t2', () => {", "test-B2 BAD", "});", "test('t3', () => {", "test-C1 BAD", "});", ""].join("\n");
  const attempt = async (cap?: number) => {
    write(blocks);
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev()] }), cap);
    return { r: await heal(claimsB().call, sb.fn), sb };
  };
  test("more tests changed than the cap: not kept, and it says how many", async () => {
    const { r } = await attempt(2);
    assert.match(r.note, /a deviation may change at most 2 tests, and this changes 3/);
    assert.match(read(), /test-B1 BAD/);
  });
  test("within the cap: kept", async () => {
    const { r } = await attempt(3);
    assert.equal(r.status, "healed");
    assert.equal(r.acceptedDeviations?.length, 1);
  });
  test("with no cap given the default (12) applies", async () => {
    const { r } = await attempt();
    assert.equal(r.status, "healed");
  });

  test("a deviation change still goes through the per-test ratchet: it fixed B but broke A, which the first model fixed: not kept", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1").replace("test-A1 OK", "test-A1 BAD"), deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.match(r.note, /it fixed test-B1 \| test-B2 \| test-C1, but it broke test-A1, which passed before/);
    assert.equal(read(), FIRST_MODEL_RESULT);
    assert.equal(r.acceptedDeviations, undefined);
  });
  test("a deviation change that makes no more tests pass is not kept either", async () => {
    const sb = sandbox((a) => ({ candidate: `// follows the app\n${a.testText}`, deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.match(r.note, /it did not make any more tests pass/);
    assert.equal(read(), FIRST_MODEL_RESULT);
  });
});

describe("3d. guardrail: one follow-up ticket per app file and spec place", () => {
  const roadmap = () => saveRoadmap(dir, { version: 1, goal: "g", kind: "idea", conventions: [], units: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);

  test("an accepted deviation becomes a ticket quoting the spec line, and the log says so", async () => {
    roadmap();
    const logs: string[] = [];
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev()] }));
    await heal(claimsB().call, sb.fn, (l) => logs.push(l));
    const rm = loadRoadmap(dir)!;
    assert.equal(rm.units.length, 1);
    assert.equal(rm.units[0].area, "Spec deviations");
    assert.match(rm.units[0].acceptance[0], /docs\/SPEC\.md:5 holds: "Spec line 5: the buttons are labelled Yes and No\."/);
    assert.ok(logs.some((l) => /follow-up ticket added: Match the spec: App\.tsx vs SPEC\.md:5/.test(l)));
  });

  test("the same deviation found for TWO causes in one file is one ticket", async () => {
    roadmap();
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, a.cause.count === 2 ? "B1" : "C1", a.cause.count === 2 ? "B2" : "C1"), deviations: [dev({ appLine: a.cause.count === 2 ? 12 : 14 })] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(sb.asked.length, 2, "both causes went to the sandbox");
    assert.equal(r.status, "healed");
    assert.equal(loadRoadmap(dir)!.units.length, 1, "same app file, same spec place: one ticket");
  });

  test("a second run on a fresh copy of the same problem adds nothing more", async () => {
    roadmap();
    const make = (a: Parameters<SandboxRun>[0]) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev({ appLine: 18 })] });
    await heal(claimsB().call, sandbox(make).fn);
    write(START);
    await heal(claimsB().call, sandbox(make).fn);
    assert.equal(loadRoadmap(dir)!.units.length, 1);
  });

  test("a different spec place is its own ticket", async () => {
    roadmap();
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev(), dev({ specLine: 7 })] }));
    await heal(claimsB().call, sb.fn);
    assert.equal(loadRoadmap(dir)!.units.length, 2);
  });

  test("no roadmap: the deviation is in the report and nothing else happens", async () => {
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2", "C1"), deviations: [dev()] }));
    const r = await heal(claimsB().call, sb.fn);
    assert.equal(r.acceptedDeviations?.length, 1);
    assert.equal(loadRoadmap(dir), undefined);
  });

  test("a rejected change adds no ticket", async () => {
    roadmap();
    const sb = sandbox((a) => ({ candidate: fixed(a.testText, "B1", "B2"), deviations: [dev({ appFile: "src/Nope.tsx" })] }));
    await heal(claimsB().call, sb.fn);
    assert.equal(loadRoadmap(dir)!.units.length, 0);
  });
});
