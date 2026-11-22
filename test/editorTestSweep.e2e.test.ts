/**
 * Spec 02 test 1, end to end: a scripted model drives the REAL tool loop (runToolAgent as the EDITOR) over a real temp git repo, with the REAL AgentTools, the REAL EditorSweep and the REAL
 * test selection. Only the test runner is a stand-in (a tiny jest look-alike), and the heal is a spy. What is proven is the behaviour a ticket sees: a change that makes a test stale is
 * sent back with the failing title and digest, the Editor updates the test, and the second conclusion is accepted; a test that was already failing is not its ticket's; the same failures
 * twice go to the heal and not into a third bounce; deleting or skipping a test is not a fix.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runToolAgent } from "../src/agentLoop.js";
import { AgentTools } from "../src/agentTools.js";
import { EditorSweep } from "../src/editorSweep.js";
import { ConfigSchema } from "../src/config.js";

const config = ConfigSchema.parse({});
let repo = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), s);
};
const text = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");

const TEST_A = "__tests__/retry.test.ts";
const TEST_OTHER = "__tests__/other.test.ts";

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-e2e-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  put("package.json", JSON.stringify({ name: "p", scripts: { test: "jest" } }));
  put("src/retry.ts", "export function attempts(): number {\n  return 3;\n}\n");
  put("src/other.ts", "export const other = 1;\n");
  put(TEST_A, 'import { attempts } from "../src/retry";\n\ntest("retries three times", () => {\n  expect(attempts()).toBe(3);\n});\n');
  put(TEST_OTHER, 'import { other } from "../src/other";\n\ntest("other is one", () => {\n  expect(other).toBe(1);\n});\n');
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------- the runner: a jest look-alike, and a record of what it was asked to run

const ran: string[] = [];
/** A test file passes when its `.toBe(N)` equals what `attempts()` returns in src/retry.ts (or `other`), and it has not been skipped. Prints the shape jest prints. */
function fakeJest(file: string): { refused: boolean; text: string; output: string } {
  ran.push(file);
  const t = text(file);
  const want = /toBe\((\d+)\)/.exec(t)?.[1];
  const have = file === TEST_A ? /return (\d+);/.exec(text("src/retry.ts"))?.[1] : /other = (\d+)/.exec(text("src/other.ts"))?.[1];
  const title = /test(?:\.skip)?\("([^"]+)"/.exec(t)?.[1] ?? "unnamed";
  const skipped = /test\.skip\(/.test(t);
  const ok = skipped || !want || want === have;
  const output = ok
    ? `PASS ${file}\nTests:       ${skipped ? "1 skipped" : "1 passed"}, 1 total`
    : `FAIL ${file}\n  ● ${title}\n\n    expect(received).toBe(expected)\n    Expected: ${want}\n    Received: ${have}\n      at src/retry.ts:2:3\n\nTests:       1 failed, 1 total`;
  return { refused: false, text: "", output };
}

// ---------------------------------------------------------------------------------------------- a scripted model

type Call = { name: string; args: Record<string, unknown> };
const patch = (p: string, search: string, replace: string): Call => ({ name: "patch_file", args: { path: p, search, replace } });
const conclude = (explanation = "done"): Call => ({ name: "conclude_task", args: { status: "FINISHED_PATCHING", explanation } });
const asks = (name: string): Call => ({ name, args: {} });

function scripted(steps: Call[][]) {
  const seen: { messages: any[] }[] = [];
  let n = 0;
  const client: any = {
    complete: async (_models: string[], messages: any[]) => {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)) });
      const step = steps[Math.min(n, steps.length - 1)];
      n++;
      return { role: "assistant", content: null, tool_calls: step.map((c, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    },
  };
  return { client, seen, count: () => n };
}

/** The Editor, run for real over the temp repo with the real sweep. `heal` is the spy that the sweep hands leftovers to. */
async function editor(steps: Call[][], over: { failsBefore?: string[]; heal?: (files: string[]) => Promise<any> } = {}) {
  ran.length = 0;
  const healed: string[][] = [];
  const tools = new AgentTools(repo, config);
  const sweep = new EditorSweep({
    repoRoot: repo,
    written: () => tools.filesWrittenThisPhase(),
    runFile: async (f) => fakeJest(f),
    failsBefore: async () => new Set(over.failsBefore ?? []),
    heal: over.heal ?? (async (files) => (healed.push(files), { results: files.map((file) => ({ file, status: "unclear", note: "could not settle it", attempts: 1 })) })),
  });
  tools.setAffectedTests(sweep);
  tools.beginPhase(["src/retry.ts"], undefined, "retry five times");
  const model = scripted(steps);
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const result = await runToolAgent({
      prompt: "Make attempts() return 5.",
      repo: {} as any,
      repoRoot: repo,
      client: model.client,
      config,
      agentTools: tools,
      models: ["fake/model"],
      agentName: "EDITOR",
      phase: { name: "retry five times", instructions: "Make attempts() return 5 (src/retry.ts)." },
    });
    return { result, healed, ...model };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const toolReplies = (seen: { messages: any[] }[]) => seen.flatMap((s) => s.messages).filter((m) => m.role === "tool").map((m) => String(m.content));
const notYet = (seen: { messages: any[] }[]) => [...new Set(toolReplies(seen).filter((c) => c.startsWith("NOT YET")))];

describe("the Editor changes behaviour that a test checks", () => {
  test("the conclusion is bounced with the failing title and digest, the Editor updates the test, and the second conclusion is accepted; a test that does not reach the change is never run", async () => {
    const m = await editor([
      [patch("src/retry.ts", "return 3;", "return 5;")],
      [conclude("attempts is five")],
      [patch(TEST_A, "toBe(3)", "toBe(5)")],
      [conclude("attempts is five, test updated")],
    ]);
    const bounces = notYet(m.seen);
    assert.equal(bounces.length, 1, `one bounce, got: ${bounces.join(" || ")}`);
    assert.match(bounces[0], /your change breaks 1 test file that passed before it: __tests__\/retry\.test\.ts/);
    assert.match(bounces[0], /retries three times/, "the failing title");
    assert.match(bounces[0], /Expected: 3/);
    assert.match(bounces[0], /Received: 5/, "the digest");
    assert.match(m.result, /^TASK_CONCLUDED: attempts is five, test updated/);
    assert.match(m.result, /(1 affected test file pass)/, "the sweep's note goes into the conclusion");
    assert.equal(text(TEST_A).includes("toBe(5)"), true);
    assert.deepEqual([...new Set(ran)], [TEST_A], "the test that reaches src/other.ts is never run");
    assert.equal(m.count(), 4, "the model was called four times: patch, conclude, fix the test, conclude");
  });

  test("a change no test checks is concluded the first time, with nothing bounced", async () => {
    const m = await editor([[patch("src/retry.ts", "return 3;", "return 3; // still three")], [conclude("comment only")]]);
    assert.deepEqual(notYet(m.seen), []);
    assert.match(m.result, /^TASK_CONCLUDED: comment only/);
  });

  test("a test that was already failing before the phase is not its ticket's: no bounce", async () => {
    const m = await editor([[patch("src/retry.ts", "return 3;", "return 5;")], [conclude("attempts is five")]], { failsBefore: [TEST_A] });
    assert.deepEqual(notYet(m.seen), []);
    assert.match(m.result, /^TASK_CONCLUDED: attempts is five/);
    assert.match(m.result, /already failing before this phase/);
    assert.equal(text(TEST_A).includes("toBe(3)"), true, "the Editor did not touch it");
  });

  test("the same failures twice: no third bounce, the heal gets exactly those files, and what it cannot settle goes on to QA, said plainly", async () => {
    const m = await editor([[patch("src/retry.ts", "return 3;", "return 5;")], [conclude("first")], [conclude("second, the test is not mine")], [conclude("third")]]);
    assert.equal(notYet(m.seen).length, 1, "one bounce only");
    assert.deepEqual(m.healed, [[TEST_A]], "the heal is asked once, with those files");
    assert.match(m.result, /^TASK_CONCLUDED: second, the test is not mine/);
    assert.match(m.result, /still red after the heal and go to QA as they are: __tests__\/retry\.test\.ts \(unclear\)/);
  });

  test("a test 'fixed' by skipping it is bounced with the integrity reason; updating it in place is accepted", async () => {
    const m = await editor([
      [patch("src/retry.ts", "return 3;", "return 5;")],
      [patch(TEST_A, 'test("retries three times"', 'test.skip("retries three times"')],
      [conclude("skipped it")],
      [patch(TEST_A, 'test.skip("retries three times"', 'test("retries five times"'), patch(TEST_A, "toBe(3)", "toBe(5)")],
      [conclude("updated it")],
    ]);
    const bounces = notYet(m.seen);
    assert.equal(bounces.length, 1, bounces.join(" || "));
    assert.match(bounces[0], /a test file you changed is not acceptable: __tests__\/retry\.test\.ts: /);
    assert.match(bounces[0], /never removed, skipped, narrowed with \.only/);
    assert.match(m.result, /^TASK_CONCLUDED: updated it/);
    assert.match(text(TEST_A), /test\("retries five times"/);
  });

  test("run_affected_tests answers with the digest while the Editor is working, before it concludes", async () => {
    const m = await editor([[patch("src/retry.ts", "return 3;", "return 5;")], [asks("run_affected_tests")], [patch(TEST_A, "toBe(3)", "toBe(5)")], [asks("run_affected_tests")], [conclude("done")]]);
    const replies = toolReplies(m.seen);
    assert.ok(replies.some((c) => /1 of 1 affected test file fails \(1 because of your change\)/.test(c) && /Expected: 3/.test(c)), replies.join("\n---\n"));
    assert.ok(replies.some((c) => /1 affected test file pass: __tests__\/retry\.test\.ts/.test(c)));
    assert.deepEqual(notYet(m.seen), [], "it had already fixed the test, so the conclusion was not bounced");
  });
});

describe("no test runner for the project", () => {
  test("no sweep is set: the conclusion is accepted as it always was", async () => {
    const tools = new AgentTools(repo, config);
    tools.beginPhase(["src/retry.ts"], undefined, "p");
    const m = scripted([[patch("src/retry.ts", "return 3;", "return 5;")], [conclude("done")]]);
    const log = console.log;
    console.log = () => {};
    try {
      const result = await runToolAgent({ prompt: "x", repo: {} as any, repoRoot: repo, client: m.client, config, agentTools: tools, models: ["fake/model"], agentName: "EDITOR", phase: { name: "p", instructions: "x" } });
      assert.match(result, /^TASK_CONCLUDED: done/);
      assert.deepEqual(notYet(m.seen), []);
    } finally {
      console.log = log;
    }
  });
});
