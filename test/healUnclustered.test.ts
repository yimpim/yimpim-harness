/**
 * Failing tests that no error signature groups (the digest clusters failures by their error line, and a failure with none it can group belongs to no
 * cluster) used to be given to nobody. They get sandbox passes of their own, and in SMALL BATCHES: a benchmark run handed seven unrelated ones over in a
 * single prompt, and the agent read the whole spec and the original implementation before touching one; that pass cost $1.23 of the run's $2.07 while
 * the named causes of one to three tests cost $0.07 to $0.32. A batch is at most three tests, in the order they appear in the file, and what is still
 * failing is worked out again before each batch.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, UNCLUSTERED_BATCH, type HealCall } from "../src/testHeal.js";
import type { SandboxResult, SandboxRun } from "../src/healSandbox.js";
import { inFileOrder, testTitleOf, lineOfTest } from "../src/testNames.js";
import { buildSandboxPrompt } from "../src/healSandbox.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
const NAMES = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
/** A and B have a recognisable error; every D test fails with a block that carries no error line the digest can group, and are printed in REVERSE file order. */
const run = async () => {
  const text = read();
  const bad = [...text.matchAll(/^(?:test|it)\('(?:Suite › )?([ABD]\d)', \(\) => \{ \/\/ (BAD|OK)$/gm)].filter((m) => m[2] === "BAD");
  if (bad.length === 0) return { ok: true, output: `Tests: ${NAMES.length + 3} passed, ${NAMES.length + 3} total` };
  const ordered = [...bad].sort((x, y) => (x[1][0] === "D" && y[1][0] === "D" ? y[1].localeCompare(x[1]) : x[1].localeCompare(y[1])));
  const blocks = ordered.map((m) => (m[1][0] === "D" ? `  ● Suite › ${m[1]}\n\n` : `  ● Suite › ${m[1]}\n    Error: cause ${m[1][0]} broke\n      at src/x.ts:1:1\n`));
  return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${NAMES.length + 3 - bad.length} passed, ${NAMES.length + 3} total` };
};
const testLine = (id: string, state = "BAD") => `it('${id}', () => { // ${state}`;
const fileWith = (ids: string[]) => [...ids.map((id) => `${testLine(id)}\n});`), ""].join("\n");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "unclustered-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), fileWith(["A1", "A2", "B1", ...NAMES]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const answer = (o: object) => JSON.stringify(o);
const edits = (...ids: string[]) => answer({ verdict: "stale-test", reason: `fixes ${ids.join(",")}`, edits: ids.map((id) => ({ find: testLine(id), replace: testLine(id, "OK") })) });
const model = (...replies: string[]) => {
  let n = 0;
  const call: HealCall = async () => replies[Math.min(n++, replies.length - 1)];
  return { call };
};
const fixed = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.replace(testLine(id), testLine(id, "OK")), text);
const base = { appFilesTouched: [], conclusion: "done", stop: "concluded", rounds: 2, cost: 0.1, runs: 2 } as const;
const idsOf = (tests: string[]) => tests.map((t) => t.replace("Suite › ", ""));
/** A sandbox that is told what to do for each call, and records what it was asked. */
const sandbox = (decide: (a: Parameters<SandboxRun>[0], n: number) => Partial<SandboxResult> | Promise<Partial<SandboxResult>>) => {
  const asked: Parameters<SandboxRun>[0][] = [];
  const fn = (async (a: Parameters<SandboxRun>[0]) => {
    asked.push(a);
    return { ...base, ...(await decide(a, asked.length)) } as SandboxResult;
  }) as SandboxRun;
  return { fn, asked };
};
/** The first model fixes A and B, leaving only the unclustered D tests. */
const firstModel = () => model(edits("A1", "A2", "B1"));
const heal = async (sb: SandboxRun) => (await healTests({ repoRoot: dir, run, call: firstModel().call, sandbox: sb, settle: false })).results[0];
const fixBatch = (a: Parameters<SandboxRun>[0]) => ({ candidate: fixed(a.testText, ...idsOf(a.cause.tests)) });

describe("unclustered tests go in batches of at most three, in file order", () => {
  test("the batch size is three", () => assert.equal(UNCLUSTERED_BATCH, 3));

  test("seven unclustered tests are seven tests over three passes: 3, 3, 1, each a small cause of its own", async () => {
    const sb = sandbox((a) => fixBatch(a));
    const r = await heal(sb.fn);
    assert.deepEqual(sb.asked.map((a) => a.cause.count), [3, 3, 1]);
    assert.deepEqual(sb.asked.map((a) => a.cause.message), ["Unclustered failing tests (3)", "Unclustered failing tests (3)", "Unclustered failing tests (1)"]);
    assert.equal(r.status, "healed");
    assert.equal(read().includes("BAD"), false);
  });

  test("in the order the tests appear in the FILE, not the order the runner printed them (here, reversed)", async () => {
    const sb = sandbox((a) => fixBatch(a));
    await heal(sb.fn);
    assert.deepEqual(idsOf(sb.asked[0].cause.tests), ["D1", "D2", "D3"]);
    assert.deepEqual(idsOf(sb.asked[1].cause.tests), ["D4", "D5", "D6"]);
    assert.deepEqual(idsOf(sb.asked[2].cause.tests), ["D7"]);
  });

  test("what still fails is worked out again before each batch: one that settles later tests too means fewer passes, and no test is handed over twice", async () => {
    const sb = sandbox((a, n) => ({ candidate: fixed(a.testText, ...idsOf(a.cause.tests), ...(n === 1 ? ["D4", "D5"] : [])) }));
    const r = await heal(sb.fn);
    assert.deepEqual(sb.asked.map((a) => idsOf(a.cause.tests)), [["D1", "D2", "D3"], ["D6", "D7"]], "D4 and D5 were already fixed by the first pass");
    assert.equal(r.status, "healed");
    const all = sb.asked.flatMap((a) => a.cause.tests);
    assert.equal(new Set(all).size, all.length);
  });

  test("a batch that settles nothing is not tried again; the next batches still go", async () => {
    const sb = sandbox((a, n) => (n === 1 ? { stop: "stagnation", conclusion: "no progress" } : fixBatch(a)));
    const r = await heal(sb.fn);
    assert.equal(sb.asked.length, 3, "three passes, and the stuck D1-D3 are not offered a second time");
    assert.deepEqual(idsOf(sb.asked[1].cause.tests), ["D4", "D5", "D6"]);
    assert.match(r.note, /sandbox: \[3×\] Unclustered failing tests \(batch 1, 4 more waiting\) → stopped \(stagnation\): no progress/);
    assert.match(read(), /it\('D1', \(\) => \{ \/\/ BAD/);
    assert.doesNotMatch(read(), /it\('D4', \(\) => \{ \/\/ BAD/);
  });

  test("a batch whose sandbox throws is said in the report and the next batches still go", async () => {
    const sb = sandbox((a, n) => {
      if (n === 1) throw new Error("provider exploded");
      return fixBatch(a);
    });
    const r = await heal(sb.fn);
    assert.equal(sb.asked.length, 3);
    assert.match(r.note, /sandbox: \[3×\] Unclustered failing tests \(batch 1, 4 more waiting\) → failed: provider exploded/);
    assert.notEqual(r.status, "healed", "D1-D3 are still failing");
  });

  test("a batch the sandbox calls an APP BUG is held as the app's: the file ends as a code bug, the other batches' fixes are kept, the test is not bent", async () => {
    const sb = sandbox((a, n) => (n === 1 ? { stop: "code-bug", conclusion: "APP BUG: src/x.ts:12 restarts the stream twice", appFilesTouched: ["src/x.ts"] } : fixBatch(a)));
    const r = await heal(sb.fn);
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    assert.match(r.note, /src\/x\.ts:12 restarts the stream twice/);
    assert.match(r.note, /evidence: app files changed in the sandbox: src\/x\.ts/);
    assert.match(read(), /it\('D1', \(\) => \{ \/\/ BAD/, "the test was not bent");
    assert.doesNotMatch(read(), /it\('D7', \(\) => \{ \/\/ BAD/, "the later batches were still worked");
  });

  test("one to three unclustered tests are one pass", async () => {
    fs.writeFileSync(path.join(dir, TEST), fileWith(["A1", "A2", "B1", "D1", "D2"]));
    const sb = sandbox((a) => fixBatch(a));
    await heal(sb.fn);
    assert.deepEqual(sb.asked.map((a) => idsOf(a.cause.tests)), [["D1", "D2"]]);
  });

  test("they are told these tests may be unrelated and to take them one at a time", async () => {
    const sb = sandbox((a) => fixBatch(a));
    await heal(sb.fn);
    assert.match(sb.asked[0].cause.reason, /not known to share a cause: take them one at a time, in the order listed/);
    assert.equal(sb.asked[0].cause.kind, "unsure");
  });
});

describe("the hand-off does not wait for a named cause to be parked", () => {
  test("when the only failures left are unclustered, the sandbox is called (it used to need some named cause parked as well)", async () => {
    // the first model fixes A and B; the rest are unclustered; nothing is parked
    const sb = sandbox((a) => fixBatch(a));
    const r = await heal(sb.fn);
    assert.ok(sb.asked.length >= 1, "the sandbox was called with nothing parked");
    assert.equal(r.status, "healed");
  });
  test("with no sandbox the behaviour is as before: the unclustered tests are not handed to anyone", async () => {
    const r = (await healTests({ repoRoot: dir, run, call: firstModel().call, settle: false })).results[0];
    assert.notEqual(r.status, "healed");
  });
});

describe("a pass that fails is said in the report, not silently dropped", () => {
  test("a sandbox that throws on a single batch", async () => {
    fs.writeFileSync(path.join(dir, TEST), fileWith(["A1", "A2", "B1", "D1"]));
    const sb = sandbox(() => {
      throw new Error("provider exploded");
    });
    const r = await heal(sb.fn);
    assert.match(r.note, /sandbox: \[1×\] Unclustered failing tests \(batch 1\) → failed: provider exploded/);
    assert.notEqual(r.status, "healed");
  });
});

describe("testNames: finding tests in their file", () => {
  const FILE = ["describe('S', () => {", "  it('first one', () => {", "  });", "  test.skip('second one', () => {", "  });", "  it('third one', () => {", "  });", "});"].join("\n");
  const lines = FILE.split("\n");
  test("a test's line, by the name Jest prints (with ' › ') or the title alone", () => {
    assert.equal(lineOfTest(lines, "S › first one"), 1);
    assert.equal(lineOfTest(lines, "S › second one"), 3);
    assert.equal(lineOfTest(lines, "third one"), 5);
    assert.equal(lineOfTest(lines, "S › not in the file"), -1);
  });
  test("a name joined with ' > ' by another formatter is found too", () => {
    assert.equal(lineOfTest(lines, "S > first one"), 1);
  });
  test("names come back in file order; ones not in the file go last and keep their order", () => {
    assert.deepEqual(inFileOrder(FILE, ["S › third one", "S › nowhere A", "S › first one", "S › nowhere B", "S › second one"]), ["S › first one", "S › second one", "S › third one", "S › nowhere A", "S › nowhere B"]);
    assert.deepEqual(inFileOrder(FILE, []), []);
  });
  test("testTitleOf is shared with the sandbox's extraction", () => assert.equal(testTitleOf("A › B › c d"), "c d"));
});

describe("the prompt's soft hint about reference/", () => {
  const p = buildSandboxPrompt({ file: "__tests__/d.test.ts", lineCount: 10, cause: { message: "m", count: 1, tests: ["S › a"], reason: "r", kind: "unsure" }, ledger: [], firstModelNotes: "", failureDigest: "d" });
  test("it advises searching first and reading just a range, and says it may still read all of it (advice, not a limit)", () => {
    assert.match(p, /reference\/ \(when the project has it\) holds the original implementation and the spec, and it is large\. Use search_code to find the one function or rule/);
    assert.match(p, /do not read it front to back\. You may read all of it if you must\./);
  });
});
