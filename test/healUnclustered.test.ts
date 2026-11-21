/**
 * Failing tests that no error signature groups (the digest clusters failures by their error line, and a failure with none that it recognises belongs
 * to no cluster) used to be given to nobody: the first model was never pointed at them and no parked cause held them. They now get one sandbox pass of
 * their own. Whatever happens there is said in the report, including a pass that fails: a failed batch must not look like nothing being left.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, type HealCall } from "../src/testHeal.js";
import type { SandboxResult, SandboxRun } from "../src/healSandbox.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
const START = ["test-A1 BAD", "test-A2 BAD", "test-B1 BAD", "test-D1 BAD", ""].join("\n");
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "unclustered-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), START);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A, B fail with a recognisable error; D fails with a block that carries no error line the digest can group. */
const run = async () => {
  const text = read();
  const bad = [...text.matchAll(/^(test-([ABD]\d)) BAD$/gm)];
  if (bad.length === 0) return { ok: true, output: "Tests: 4 passed, 4 total" };
  const blocks = bad.map((m) => (m[2][0] === "D" ? `  ● ${m[1]}\n\n` : `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`));
  return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${4 - bad.length} passed, 4 total` };
};
const answer = (o: object) => JSON.stringify(o);
const edits = (...ids: string[]) => answer({ verdict: "stale-test", reason: `fixes ${ids.join(",")}`, edits: ids.map((id) => ({ find: `test-${id} BAD`, replace: `test-${id} OK` })) });
const park = () => answer({ verdict: "park", kind: "unsure", reason: "needs the reducer" });
const model = (...replies: string[]) => {
  let n = 0;
  const call: HealCall = async () => replies[Math.min(n++, replies.length - 1)];
  return { call };
};
const fixed = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.replace(`test-${id} BAD`, `test-${id} OK`), text);
const base = { appFilesTouched: [], conclusion: "done", stop: "concluded", rounds: 2, cost: 0.1, runs: 2 } as const;

test("tests no error signature groups still get a sandbox pass of their own, after the named causes", async () => {
  const asked: Parameters<SandboxRun>[0][] = [];
  const sb = (async (a: Parameters<SandboxRun>[0]) => {
    asked.push(a);
    // B's pass fixes only B; the unclustered pass then fixes D
    return { ...base, candidate: fixed(a.testText, a.cause.message.startsWith("Unclustered") ? "D1" : "B1") } as SandboxResult;
  }) as SandboxRun;
  // the first model fixes A and parks B; D belongs to no cause
  const r = (await healTests({ repoRoot: dir, run, call: model(edits("A1", "A2"), park()).call, sandbox: sb, settle: false })).results[0];
  assert.ok(asked.length >= 1);
  const last = asked[asked.length - 1];
  assert.match(last.cause.message, /^Unclustered failing tests \(1\)$/);
  assert.deepEqual(last.cause.tests, ["test-D1"]);
  assert.equal(read().includes("BAD"), false, "everything was settled");
  assert.equal(r.status, "healed");
});

test("a sandbox that FAILS on that pass is said in the report, not silently dropped", async () => {
  let n = 0;
  const sb = (async (a: Parameters<SandboxRun>[0]) => {
    // the named cause (B) is settled; the pass for the unclustered tests blows up
    if (a.cause.message.startsWith("Unclustered")) throw new Error("provider exploded");
    n++;
    return { ...base, candidate: fixed(a.testText, "B1") } as SandboxResult;
  }) as SandboxRun;
  const r = (await healTests({ repoRoot: dir, run, call: model(edits("A1", "A2"), park()).call, sandbox: sb, settle: false })).results[0];
  assert.equal(n, 1, "B went to the sandbox first");
  assert.match(r.note, /sandbox: \[1×\] Unclustered failing tests → failed: provider exploded/);
  assert.notEqual(r.status, "healed");
});
