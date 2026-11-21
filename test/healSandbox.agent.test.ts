/**
 * The sandbox agent: one parked cause worked in a native tool loop inside a disposable copy of the project. A scripted fake model drives the
 * REAL tool loop, the REAL worktree and a real stub test runner, so what is proven here is the behaviour: what the model is offered, what stops
 * it (its own conclusion, the user's dollar budget, three state-based stagnation rules, never a round count), and that only the test file
 * ever comes back.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createSandboxRun,
  StagnationTracker,
  fingerprintOf,
  buildSandboxPrompt,
  interpretOutcome,
  stripAddedLogs,
  SANDBOX_TOOLS_SCHEMA,
  sandboxBase,
  sandboxPrefix,
  type SandboxCause,
} from "../src/healSandbox.js";
import { events } from "../src/events.js";
import { AbortedError } from "../src/remote/control.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const FILE = "__tests__/p.test.ts";
const START = ["test-A1 BAD", "test-A2 BAD", "test-A3 BAD", "test-A4 BAD", "test-A5 BAD", "test-A6 BAD", "test-A7 BAD", "test-A8 BAD", ""].join("\n");
let repo = "";

// A stand-in for jest: prints one failing test per line that still says BAD, in the shape a real runner prints.
const STUB = [
  'const fs = require("fs");',
  'const file = process.argv.find((a) => a.endsWith(".test.ts"));',
  'const lines = fs.readFileSync(file, "utf8").split(/\\r?\\n/);',
  "const bad = lines.map((l) => /^(test-\\w+) BAD$/.exec(l)).filter(Boolean).map((m) => m[1]);",
  'for (const n of bad) console.log("  ● " + n + "\\n    Error: broke\\n");',
  'console.log("Tests:       " + bad.length + " failed, " + (lines.length - 1 - bad.length) + " passed, " + (lines.length - 1) + " total");',
  "process.exit(bad.length ? 1 : 0);",
].join("\n");

const output = (text: string) => {
  const bad = [...text.matchAll(/^(test-\w+) BAD$/gm)].map((m) => m[1]);
  const total = text.split(/\r?\n/).length - 1;
  return bad.length ? `FAIL ${FILE}\n${bad.map((n) => `  ● ${n}\n    Error: broke\n`).join("\n")}\nTests:       ${bad.length} failed, ${total - bad.length} passed, ${total} total` : `Tests: ${total} passed, ${total} total`;
};
/** The heal's own runner, as the preflight uses it: reads whatever file is in the root it is given. */
const run = async (root: string, files: string[]) => {
  const text = fs.readFileSync(path.join(root, files[0]), "utf8");
  return { ok: !/BAD/.test(text), output: output(text) };
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "sbxa-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "__tests__"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, FILE), START);
  fs.writeFileSync(path.join(repo, "src/x.ts"), "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs/SPEC.md"), "# Spec\n\nThe buttons are labelled Yes and No.\n\nOther text.\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "p", scripts: { test: "jest" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(repo, "node_modules/jest/bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/jest/package.json"), JSON.stringify({ name: "jest", bin: "./bin/jest.js" }));
  fs.writeFileSync(path.join(repo, "node_modules/jest/bin/jest.js"), STUB);
  fs.writeFileSync(path.join(repo, "node_modules/marker.txt"), "real dependencies");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------------------------------------ a scripted model

type Call = { name: string; args: Record<string, unknown> };
interface Step {
  calls: Call[];
  /** Dollars this call is billed. */
  cost?: number;
  /** Extra fields on the assistant message (a provider's own: Gemini thought signatures). */
  extra?: Record<string, unknown>;
}
const read = (): Call => ({ name: "read_file", args: { path: FILE } });
const runT = (pattern?: string): Call => ({ name: "run_test", args: { file: FILE, ...(pattern ? { namePattern: pattern } : {}) } });
const fixLine = (id: string, extra = ""): Call => ({ name: "patch_file", args: { path: FILE, search: `test-${id} BAD`, replace: `test-${id} OK${extra}` } });
const conclude = (explanation = "done", status = "FINISHED_PATCHING"): Call => ({ name: "conclude_task", args: { status, explanation } });

function scripted(steps: Step[]) {
  const seen: { tools: string[]; messages: any[] }[] = [];
  let n = 0;
  const client: any = {
    complete: async (_models: string[], messages: any[], opts: any) => {
      seen.push({ tools: (opts?.tools ?? []).map((t: any) => t.function.name), messages: JSON.parse(JSON.stringify(messages)) });
      const step = steps[Math.min(n, steps.length - 1)];
      n++;
      events.recordUsage("HEAL_SANDBOX", "fake/model", { prompt: 1, completion: 1, total: 2, cost: step.cost ?? 0 });
      return {
        role: "assistant",
        content: null,
        ...(step.extra ?? {}),
        tool_calls: step.calls.map((c, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      };
    },
  };
  return { client, seen, count: () => n };
}

const CAUSE: SandboxCause = { message: "Error: broke", count: 8, tests: ["test-A1", "test-A2"], reason: "the first model could not settle it", kind: "unsure" };
const config: any = { prompts: { systemPersona: "You fix tests." }, safety: {}, limits: {} };

async function go(steps: Step[], over: { budgetUsd?: number; stagnation?: number; testText?: string; failureOutput?: string } = {}) {
  const m = scripted(steps);
  const testText = over.testText ?? START;
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const sandboxRun = createSandboxRun({ client: m.client, config, models: ["fake/model"], budgetUsd: over.budgetUsd ?? 0, stagnation: over.stagnation ?? 3, run, securityCall: async () => '{"verdict":"safe"}' });
    const result = await sandboxRun({ repoRoot: repo, file: FILE, testText, failureOutput: over.failureOutput ?? output(testText), failureDigest: "digest of the failure", cause: CAUSE, ledger: [], firstModelNotes: "" });
    return { result, ...m };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}
const worktreesLeft = () => (fs.existsSync(sandboxBase()) ? fs.readdirSync(sandboxBase()).filter((n) => n.startsWith(sandboxPrefix(repo))) : []);

// ------------------------------------------------------------------------------------------------------------------------ the run

describe("a cause worked in the sandbox", () => {
  test("it reads, runs one test, fixes the test file, runs again, concludes: the candidate comes back and everything is cleaned up", async () => {
    const { result } = await go([
      { calls: [read()] },
      { calls: [runT("test-A1")] },
      { calls: [fixLine("A1")] },
      { calls: [runT("test-A1")] },
      { calls: [conclude("replaced the BAD marker")] },
    ]);
    assert.equal(result.stop, "concluded");
    assert.equal(result.runs, 2);
    assert.match(result.candidate ?? "", /test-A1 OK/);
    assert.match(result.candidate ?? "", /test-A2 BAD/, "only what the agent changed");
    assert.match(result.conclusion, /replaced the BAD marker/);
    assert.equal(fs.readFileSync(path.join(repo, FILE), "utf8"), START, "the REAL test file is untouched");
    assert.deepEqual(worktreesLeft(), [], "the sandbox is gone");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules/marker.txt"), "utf8"), "real dependencies");
  });

  test("it is offered exactly the sandbox tools, never a command runner, an install, or a question to a person", async () => {
    const { seen } = await go([{ calls: [conclude()] }]);
    assert.deepEqual([...seen[0].tools].sort(), ["conclude_task", "get_file_outline", "list_files", "patch_file", "read_file", "record_deviation", "run_test", "search_code", "write_file"]);
    assert.deepEqual(SANDBOX_TOOLS_SCHEMA.map((t) => t.function.name).sort(), [...seen[0].tools].sort());
    for (const banned of ["run_project_command", "run_dependency_install", "request_dependency", "ask_user", "defer_question", "stage_file_for_deletion", "run_build_check"]) {
      assert.ok(!seen[0].tools.includes(banned), banned);
    }
  });

  test("a tool the model names without having been offered it is refused, not run", async () => {
    const { seen, result } = await go([{ calls: [{ name: "run_project_command", args: { command: "node -v" } }] }, { calls: [conclude()] }]);
    const toolReply = seen[1].messages.filter((m: any) => m.role === "tool").pop();
    assert.match(toolReply.content, /Tool not available in this sandbox: run_project_command/);
    assert.equal(result.stop, "concluded");
  });

  test("a provider's own fields on the assistant message (Gemini's thought signature) come back on the next request", async () => {
    const { seen } = await go([{ calls: [read()], extra: { reasoning_details: [{ type: "reasoning.encrypted", data: "sig-123" }] } }, { calls: [conclude()] }]);
    const echoed = seen[1].messages.find((m: any) => m.role === "assistant");
    assert.deepEqual(echoed.reasoning_details, [{ type: "reasoning.encrypted", data: "sig-123" }]);
  });

  test("a model that answers in prose without a tool call has finished: its words are the conclusion", async () => {
    const m = scripted([]);
    m.client.complete = async () => ({ role: "assistant", content: "The first model was right: the test is stale and I replaced it." });
    const sandboxRun = createSandboxRun({ client: m.client, config, models: ["fake/model"], budgetUsd: 0, stagnation: 3, run, securityCall: async () => "{}" });
    const origLog = console.log;
    console.log = () => {};
    try {
      const r = await sandboxRun({ repoRoot: repo, file: FILE, testText: START, failureOutput: output(START), failureDigest: "d", cause: CAUSE, ledger: [], firstModelNotes: "" });
      assert.equal(r.stop, "concluded");
      assert.match(r.conclusion, /test is stale/);
    } finally {
      console.log = origLog;
    }
  });
});

describe("what comes back, and what does not", () => {
  test("app code changed for logging is reported by name and never reaches the real project", async () => {
    const { result } = await go([
      { calls: [{ name: "patch_file", args: { path: "src/x.ts", search: "export const x = 1;", replace: "export const x = 1; console.log('x is', x);" } }] },
      { calls: [runT()] },
      { calls: [fixLine("A1")] },
      { calls: [runT()] },
      { calls: [conclude()] },
    ]);
    assert.deepEqual(result.appFilesTouched, ["src/x.ts"]);
    assert.equal(fs.readFileSync(path.join(repo, "src/x.ts"), "utf8"), "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");
  });

  test("console.log lines the agent forgot in the test file are removed from the candidate", async () => {
    const { result } = await go([
      { calls: [{ name: "patch_file", args: { path: FILE, search: "test-A1 BAD", replace: "console.log('PROBE', 1);\ntest-A1 OK" } }] },
      { calls: [runT()] },
      { calls: [conclude()] },
    ]);
    assert.match(result.candidate ?? "", /test-A1 OK/);
    assert.doesNotMatch(result.candidate ?? "", /console\.log/);
  });

  test("an agent that changed nothing in the test file returns no candidate", async () => {
    const { result } = await go([{ calls: [read()] }, { calls: [conclude("nothing to change", "ALREADY_COMPLETED")] }]);
    assert.equal(result.candidate, undefined);
    assert.equal(result.stop, "concluded");
  });

  test("FINISHED_PATCHING after only measuring is accepted here (the Editor's 'you wrote nothing' refusal does not apply to a sandbox)", async () => {
    const { result, count } = await go([{ calls: [runT()] }, { calls: [conclude("the first model's fix is already right; nothing to add")] }]);
    assert.equal(result.stop, "concluded");
    assert.equal(count(), 2, "no bounce back to 'apply the change'");
    assert.equal(result.candidate, undefined);
  });

  test('CANNOT_LOCATE starting "APP BUG:" is a code bug, with the place it named', async () => {
    const { result } = await go([{ calls: [conclude("APP BUG: src/x.ts:12 renders the wrong thing; the spec says otherwise.", "CANNOT_LOCATE")] }]);
    assert.equal(result.stop, "code-bug");
    assert.match(result.conclusion, /src\/x\.ts:12/);
  });

  test("CANNOT_LOCATE without that prefix is just a conclusion", async () => {
    const { result } = await go([{ calls: [conclude("I could not find where the debounce is set.", "CANNOT_LOCATE")] }]);
    assert.equal(result.stop, "concluded");
  });
});

describe("what stops it: its own word, the user's budget, or no progress. Never a count of rounds.", () => {
  test("the budget is the user's number, in dollars: it stops before the call that would pass it", async () => {
    const { result, count } = await go(Array.from({ length: 50 }, () => ({ calls: [read()], cost: 0.3 })), { budgetUsd: 1.75, stagnation: 1000 });
    assert.equal(result.stop, "budget");
    assert.equal(count(), 6, "$0.30 × 5 = $1.50 is under $1.75, so a sixth call is made; $0.30 × 6 = $1.80 ≥ $1.75: no seventh");
    assert.match(result.conclusion, /\$1\.80 of \$1\.75/);
    assert.ok(Math.abs(result.cost - 1.8) < 1e-9);
  });

  test("no budget (0) means no dollar stop", async () => {
    const { result } = await go([...Array.from({ length: 20 }, () => ({ calls: [read()], cost: 5 })), { calls: [conclude()] }], { budgetUsd: 0, stagnation: 1000 });
    assert.equal(result.stop, "concluded");
  });

  test("three test runs in a row that print the same thing, with nothing changed in between: stagnation", async () => {
    const { result, count } = await go(Array.from({ length: 20 }, () => ({ calls: [runT()] })));
    assert.equal(result.stop, "stagnation");
    assert.match(result.conclusion, /3 test runs in a row gave the same result/);
    assert.equal(count(), 3);
  });

  test("the same result after a change is not stagnation of that kind: edit, run, edit, run, ... keeps going", async () => {
    const steps: Step[] = [{ calls: [runT()] }, { calls: [runT()] }];
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]) steps.push({ calls: [fixLine(id)] }, { calls: [runT()] });
    steps.push({ calls: [conclude()] });
    const { result } = await go(steps);
    assert.equal(result.stop, "concluded", "sixteen rounds of honest edit/run, no round limit anywhere");
    assert.equal(result.runs, 10);
  });

  test("three rounds of edits without running a test: stagnation", async () => {
    const { result, count } = await go([{ calls: [fixLine("A1")] }, { calls: [fixLine("A2")] }, { calls: [fixLine("A3")] }, { calls: [fixLine("A4")] }]);
    assert.equal(result.stop, "stagnation");
    assert.match(result.conclusion, /3 rounds of edits without running a test/);
    assert.equal(count(), 3);
  });

  test("re-reading the same file: the first read is new, six repeats after it are stagnation; five repeats and then an experiment: it goes on", async () => {
    const repeats = await go(Array.from({ length: 20 }, () => ({ calls: [read()] })));
    assert.equal(repeats.result.stop, "stagnation");
    assert.match(repeats.result.conclusion, /6 rounds that learned nothing new \(no edit, no test run, nothing read or searched that had not been already\)/);
    assert.equal(repeats.count(), 7, "one new read, then six that showed nothing new");
    const five = await go([...Array.from({ length: 6 }, () => ({ calls: [read()] })), { calls: [runT()] }, { calls: [read()] }, { calls: [conclude()] }]);
    assert.equal(five.result.stop, "concluded");
  });

  test("READING NEW CHUNKS OF A BIG FILE IS PROGRESS: the benchmark's pattern (run once, then read the app file piece by piece) is never cut off", async () => {
    // What a benchmark run actually did, and was wrongly stopped for: one test run, then the test and a 3,683-line app file read in new ranges.
    const chunk = (p: string, a: number, b: number): Call => ({ name: "read_file", args: { path: p, startLine: a, endLine: b } });
    const steps: Step[] = [
      { calls: [{ name: "search_code", args: { pattern: "derives the phase header", path: FILE } }] },
      { calls: [runT("derives the phase header")] },
      { calls: [chunk(FILE, 3100, 3593)] },
      { calls: [chunk(FILE, 2500, 2700)] },
      { calls: [chunk("src/x.ts", 1, 400)] },
      { calls: [chunk("app/dashboard.tsx", 1, 400)] },
      { calls: [chunk("app/dashboard.tsx", 401, 1200)] },
      { calls: [chunk("app/dashboard.tsx", 1201, 2200)] },
      { calls: [chunk("app/dashboard.tsx", 2201, 3000)] },
      { calls: [chunk("app/dashboard.tsx", 3001, 3683)] },
      { calls: [chunk("src/timeline.ts", 1, 400)] },
      { calls: [chunk(FILE, 2400, 2505)] },
      { calls: [fixLine("A1")] },
      { calls: [runT()] },
      { calls: [conclude("found it by reading, then fixed it")] },
    ];
    const { result, count } = await go(steps);
    assert.equal(result.stop, "concluded", "twelve rounds of looking at new things and then an experiment: never stopped");
    assert.equal(count(), steps.length);
  });

  test("a range that overlaps what was read but adds new lines is new; one entirely inside what was read is not", async () => {
    const chunk = (a: number, b: number): Call => ({ name: "read_file", args: { path: "app/big.tsx", startLine: a, endLine: b } });
    // 1-400 new, then 300-500 (adds 401-500, new), then six ranges all inside 1-500 (nothing new)
    const steps: Step[] = [{ calls: [chunk(1, 400)] }, { calls: [chunk(300, 500)] }, ...Array.from({ length: 10 }, (_, i) => ({ calls: [chunk(10 + i * 40, 50 + i * 40)] }))];
    const { result, count } = await go(steps);
    assert.equal(result.stop, "stagnation");
    assert.equal(count(), 8, "two rounds that saw new lines, then six that did not");
  });

  test("a whole-file read covers every range of that file afterwards; an edit to the file makes it new again", async () => {
    const steps: Step[] = [
      { calls: [read()] },
      ...Array.from({ length: 3 }, (_, i) => ({ calls: [{ name: "read_file", args: { path: FILE, startLine: 1 + i, endLine: 3 + i } }] })),
      { calls: [fixLine("A1")] }, // the file changed
      { calls: [read()] }, // new again
      { calls: [runT()] },
      { calls: [conclude()] },
    ];
    const { result } = await go(steps);
    assert.equal(result.stop, "concluded");
  });

  test("a run the gate refused is a round of nothing", async () => {
    fs.writeFileSync(path.join(repo, FILE), START); // unchanged on disk; the agent writes suspicious code into a NEW test file
    const evil = { name: "write_file", args: { path: "__tests__/zz.test.ts", content: "test('x', () => { require('child_process').execSync('rm -rf /'); });\n" } };
    const { result } = await go([{ calls: [evil] }, ...Array.from({ length: 20 }, () => ({ calls: [runT()] }))]);
    // the message says why if the sandbox itself ever fails to start (seen once, under the load of the full parallel suite, never in isolation)
    assert.equal(result.stop, "stagnation", `stopped as "${result.stop}": ${result.conclusion}`);
    assert.equal(result.runs, 0, "nothing was ever run");
  });
});

describe("what it refuses to start", () => {
  test("a sandbox that does not reproduce the failure: no model call at all", async () => {
    const { result, count } = await go([{ calls: [conclude()] }], { failureOutput: output("test-ZZ BAD\n") });
    assert.equal(result.stop, "preflight");
    assert.match(result.conclusion, /does not reproduce the failure/);
    assert.equal(count(), 0);
    assert.deepEqual(worktreesLeft(), []);
  });

  test("a user Stop is not swallowed, and the sandbox is still removed", async () => {
    const m = scripted([]);
    m.client.complete = async () => {
      throw new AbortedError("stopped by the user");
    };
    const sandboxRun = createSandboxRun({ client: m.client, config, models: ["fake/model"], budgetUsd: 0, stagnation: 3, run, securityCall: async () => "{}" });
    const origLog = console.log;
    console.log = () => {};
    try {
      await assert.rejects(() => sandboxRun({ repoRoot: repo, file: FILE, testText: START, failureOutput: output(START), failureDigest: "d", cause: CAUSE, ledger: [], firstModelNotes: "" }), AbortedError);
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(worktreesLeft(), []);
    assert.equal(fs.readFileSync(path.join(repo, "node_modules/marker.txt"), "utf8"), "real dependencies");
  });

  test("any other failure of the model becomes an error result, not a crash, and the sandbox is removed", async () => {
    const m = scripted([]);
    m.client.complete = async () => {
      throw new Error("provider exploded");
    };
    const sandboxRun = createSandboxRun({ client: m.client, config, models: ["fake/model"], budgetUsd: 0, stagnation: 3, run, securityCall: async () => "{}" });
    const origLog = console.log;
    console.log = () => {};
    try {
      const r = await sandboxRun({ repoRoot: repo, file: FILE, testText: START, failureOutput: output(START), failureDigest: "d", cause: CAUSE, ledger: [], firstModelNotes: "" });
      assert.equal(r.stop, "error");
      assert.match(r.conclusion, /provider exploded/);
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(worktreesLeft(), []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ the parts

describe("StagnationTracker", () => {
  const round = (t: StagnationTracker, f: (t: StagnationTracker) => void) => {
    f(t);
    return t.check();
  };
  test("a new result resets the identical-runs count; a repeat after a change does too", () => {
    const t = new StagnationTracker(3);
    t.check();
    assert.equal(round(t, (x) => x.onRun("a")), undefined);
    assert.equal(round(t, (x) => x.onRun("a")), undefined);
    assert.equal(round(t, (x) => x.onRun("b")), undefined, "a new result");
    assert.equal(round(t, (x) => x.onRun("b")), undefined);
    assert.equal(round(t, (x) => (x.onTool("patch_file"), x.onRun("b"))), undefined, "same result but something was changed in between");
    assert.equal(round(t, (x) => x.onRun("b")), undefined);
    assert.match(round(t, (x) => x.onRun("b")) ?? "", /3 test runs in a row/);
  });
  test("a refused run, a repeated read and a repeated search are no progress; an edit or a run clears it", () => {
    const t = new StagnationTracker(2);
    t.check();
    const a = { path: "a.ts", startLine: 1, endLine: 50 };
    assert.equal(round(t, (x) => x.onTool("read_file", a)), undefined, "new");
    assert.equal(round(t, (x) => x.onRefused()), undefined);
    assert.equal(round(t, (x) => x.onTool("read_file", a)), undefined, "a repeat");
    assert.equal(round(t, (x) => x.onRefused()), undefined);
    assert.match(round(t, (x) => x.onTool("read_file", { path: "a.ts", startLine: 10, endLine: 20 })) ?? "", /4 rounds that learned nothing new/);
    const u = new StagnationTracker(2);
    u.check();
    round(u, (x) => x.onTool("search_code", { pattern: "foo" }));
    round(u, (x) => x.onTool("search_code", { pattern: "foo" }));
    round(u, (x) => x.onTool("search_code", { pattern: "foo" }));
    assert.equal(round(u, (x) => x.onTool("patch_file", { path: "a.ts" })), undefined, "an edit clears the count");
  });

  test("novelty: new lines of a file, a new search, a new listing; and what is NOT new", () => {
    const t = new StagnationTracker(1); // stop after 2 rounds with nothing new
    t.check();
    const novel = (name: string, args: Record<string, unknown>) => round(t, (x) => x.onTool(name, args)) === undefined;
    assert.ok(novel("read_file", { path: "src/A.ts", startLine: 1, endLine: 100 }));
    assert.ok(novel("read_file", { path: "src\\a.ts", startLine: 90, endLine: 150 }), "same file (slashes and case do not matter), and lines 101-150 are new");
    assert.ok(novel("search_code", { pattern: "handleBack", path: "app" }));
    assert.ok(novel("search_code", { pattern: "handleBack", path: "src" }), "the same pattern elsewhere is a new search");
    assert.ok(novel("search_code", { patterns: ["b", "a"] }));
    assert.ok(novel("list_files", { recursive: true }));
    assert.ok(novel("get_file_outline", { path: "src/a.ts" }));
    // now nothing new: the next two rounds stop it
    assert.equal(round(t, (x) => x.onTool("search_code", { patterns: ["a", "b"] })), undefined, "the same batch in another order: not new (round 1 of 2)");
    assert.match(round(t, (x) => x.onTool("read_file", { path: "src/a.ts", startLine: 5, endLine: 140 })) ?? "", /2 rounds that learned nothing new/, "inside what was read");
  });

  test("several files read at once: new if any of them is new", () => {
    const t = new StagnationTracker(1);
    t.check();
    round(t, (x) => x.onTool("read_file", { paths: ["a.ts", "b.ts"] }));
    assert.equal(round(t, (x) => x.onTool("read_file", { paths: ["a.ts", "c.ts"] })), undefined, "c.ts is new");
    assert.equal(round(t, (x) => x.onTool("read_file", { paths: ["a.ts", "b.ts"] })), undefined, "nothing new: 1 of 2");
    assert.match(round(t, (x) => x.onTool("read_file", { path: "c.ts", startLine: 3, endLine: 9 })) ?? "", /2 rounds that learned nothing new/);
  });

  test("a read with nothing to read (no path) is not progress", () => {
    const t = new StagnationTracker(1);
    t.check();
    assert.equal(round(t, (x) => x.onTool("read_file", {})), undefined);
    assert.match(round(t, (x) => x.onTool("read_file", {})) ?? "", /2 rounds that learned nothing new/);
  });
  test("it counts the rounds that have ended", () => {
    const t = new StagnationTracker(9);
    t.check();
    t.check();
    t.check();
    assert.equal(t.rounds, 2);
  });
});

describe("fingerprintOf", () => {
  test("the same failures at a different speed, in a different folder, are the same result; a different failure is not", () => {
    const a = "  ● test-A1\n    Error: broke at C:\\x\\sbx1\\src\\x.ts:3\nTests: 1 failed (12 ms)\nTime: 1.2 s";
    const b = "  ● test-A1\n    Error: broke at C:\\x\\sbx2\\src\\x.ts:3\nTests: 1 failed (97 ms)\nTime: 3.9 s";
    assert.equal(fingerprintOf(a, "C:\\x\\sbx1").length, 40);
    assert.equal(fingerprintOf(a, "C:\\x\\sbx1"), fingerprintOf(b.replace("sbx2", "sbx1"), "C:\\x\\sbx1"));
    assert.notEqual(fingerprintOf(a, "C:\\x\\sbx1"), fingerprintOf(a.replace("test-A1", "test-A2"), "C:\\x\\sbx1"));
    assert.notEqual(fingerprintOf(a, "C:\\x\\sbx1"), fingerprintOf(a + "\nPROBE 42", "C:\\x\\sbx1"), "new printed information is a new result");
  });
});

describe("interpretOutcome", () => {
  test("every way the loop can end", () => {
    assert.deepEqual(interpretOutcome("TASK_CONCLUDED: fixed it"), { stop: "concluded", conclusion: "fixed it" });
    assert.deepEqual(interpretOutcome("TASK_ALREADY_SATISFIED: nothing to do"), { stop: "concluded", conclusion: "nothing to do" });
    assert.equal(interpretOutcome("STOPPED: budget: $1.00 of $0.75 spent on this cause").stop, "budget");
    assert.equal(interpretOutcome("STOPPED: stagnation: 3 test runs").stop, "stagnation");
    assert.equal(interpretOutcome("TASK_CONCLUDED: APP BUG: src/a.ts:1 is wrong").stop, "code-bug");
    assert.equal(interpretOutcome(undefined, new Error("ESCALATION_NEEDED: APP BUG: src/a.ts:1")).stop, "code-bug");
    assert.equal(interpretOutcome(undefined, new Error("ESCALATION_NEEDED: could not find it")).stop, "concluded");
    assert.equal(interpretOutcome(undefined, new Error("boom")).stop, "error");
    assert.equal(interpretOutcome("plain words").stop, "concluded");
  });
});

describe("stripAddedLogs", () => {
  test("removes only the single-line console.log/debug the agent added; keeps the ones the file started with and CRLF", () => {
    const start = "a\r\nconsole.log('old');\r\nb\r\n";
    const now = "a\r\nconsole.log('old');\r\n  console.log('PROBE', x);\r\nb\r\nconsole.debug('d');\r\nconst keep = 1;\r\n";
    assert.equal(stripAddedLogs(start, now), "a\r\nconsole.log('old');\r\nb\r\nconst keep = 1;\r\n");
    assert.equal(stripAddedLogs(start, start), start);
  });
});

describe("buildSandboxPrompt", () => {
  test("short, with the cause, what must keep passing, the failure and how to work; large inputs are cut", () => {
    const big = "x".repeat(50_000);
    const p = buildSandboxPrompt({ file: FILE, lineCount: 2670, cause: { ...CAUSE, tests: Array.from({ length: 100 }, (_, i) => `t${i}`), reason: big }, ledger: Array.from({ length: 100 }, (_, i) => `  - fixed ${i}`), firstModelNotes: big, failureDigest: big });
    assert.ok(p.length < 8000, `prompt is ${p.length} characters`);
    for (const part of ["THE CAUSE", "[8×] Error: broke", "WHAT ALREADY PASSES AND MUST KEEP PASSING", "THE TEST FILE: __tests__/p.test.ts (2670 lines)", "THE FAILURE NOW", "HOW TO WORK", "run_test with a namePattern", 'starting with "APP BUG:"', "… and 70 more", "… and 80 more fixed causes"]) {
      assert.ok(p.includes(part), part);
    }
    assert.ok(!p.includes("x".repeat(5000)), "the long text is cut");
  });
});

// ------------------------------------------------------------------------------------------------------------------------ defect or deviation

describe("the rule the stronger model works by: defect or deviation", () => {
  const prompt = (over: Partial<Parameters<typeof buildSandboxPrompt>[0]> = {}) =>
    buildSandboxPrompt({ file: FILE, lineCount: 100, cause: CAUSE, ledger: [], firstModelNotes: "", failureDigest: "digest", ...over });

  test("it says what a defect is (never bend the test) and what a deviation is (follow the working app, record both places)", () => {
    const p = prompt();
    assert.match(p, /DEFECT: the app is wrong in a way that blocks a user, crashes, loses data, or sends or shows WRONG FUNCTIONAL DATA\. NEVER bend the test/);
    assert.match(p, /CANNOT_LOCATE starting "APP BUG:"/);
    assert.match(p, /DEVIATION: the app WORKS but differs from the spec in a cosmetic way \(a label or its casing, wording, order, styling, spacing\)/);
    assert.match(p, /call record_deviation for each one with the app's file:line and the spec's file:line/);
    assert.match(p, /never remove or weaken an assertion/);
    assert.match(p, /Not sure it is only cosmetic\? It is a defect\./);
  });
  test("it tells the model the cap on tests one deviation may change: the configured one, else the default", () => {
    assert.match(prompt({ deviationTestCap: 5 }), /At most 5 tests\s+may change/);
    assert.match(prompt(), /At most 12 tests\s+may change/);
  });
  test("when the first model called the app wrong, the prompt says so and names the places it cited, to be checked not trusted", () => {
    const p = prompt({ cause: { ...CAUSE, kind: "code", refs: ["src/x.ts:2", "docs/SPEC.md:3"] } });
    assert.match(p, /The first model believed the APP is wrong here/);
    assert.match(p, /Places it named \(check them, do not trust them\): src\/x\.ts:2, docs\/SPEC\.md:3/);
    assert.doesNotMatch(prompt(), /believed the APP is wrong/);
  });
  test("it is still short with the rule in it, even with huge inputs", () => {
    const big = "x".repeat(50_000);
    const p = prompt({ cause: { ...CAUSE, kind: "code", refs: Array.from({ length: 8 }, (_, i) => `src/file${i}.ts:${i}`), tests: Array.from({ length: 100 }, (_, i) => `t${i}`), reason: big }, ledger: Array.from({ length: 100 }, (_, i) => `  - fixed ${i}`), firstModelNotes: big, failureDigest: big });
    // Without the failing tests' own code (which has its own 6,500-character bound, see the next tests): the rule text, the cause, the ledger, the digest.
    assert.ok(p.length < 8500, `prompt is ${p.length} characters`);
  });
});

describe("record_deviation: evidence is checked the moment it is given", () => {
  const rec = (args: Record<string, unknown>): Call => ({ name: "record_deviation", args });
  const good = { app: "src/x.ts:2", spec: "docs/SPEC.md:3", summary: "The spec says Yes/No; the app shows yes/no." };
  const lastToolReply = (seen: { messages: any[] }[], at: number) => seen[at].messages.filter((m: any) => m.role === "tool").pop().content as string;

  test("a real app file:line and a real spec file:line are recorded, and come back in the result", async () => {
    const { result, seen } = await go([{ calls: [rec(good)] }, { calls: [conclude()] }]);
    assert.match(lastToolReply(seen, 1), /^Recorded: app src\/x\.ts:2 vs spec docs\/SPEC\.md:3: The spec says Yes\/No/);
    assert.deepEqual(result.deviations, [{ appFile: "src/x.ts", appLine: 2, specFile: "docs/SPEC.md", specLine: 3, summary: "The spec says Yes/No; the app shows yes/no." }]);
  });
  test("a reference that does not exist is refused WITH the reason, so the model can fix it, and is not in the result", async () => {
    const { result, seen } = await go([{ calls: [rec({ ...good, app: "src/nope.ts:2" })] }, { calls: [rec({ ...good, spec: "docs/SPEC.md:99" })] }, { calls: [rec({ ...good, app: FILE + ":1" })] }, { calls: [conclude()] }]);
    assert.match(lastToolReply(seen, 1), /^Not recorded: app: src\/nope\.ts does not exist in the project/);
    assert.match(lastToolReply(seen, 2), /^Not recorded: spec: docs\/SPEC\.md has 5 lines, so line 99 does not exist/);
    assert.match(lastToolReply(seen, 3), /^Not recorded: app: __tests__\/p\.test\.ts is a test file/);
    assert.equal(result.deviations, undefined);
  });
  test("the same deviation recorded twice is one", async () => {
    const { result } = await go([{ calls: [rec(good)] }, { calls: [rec({ ...good, app: "src/x.ts:3", summary: "worded differently here" })] }, { calls: [conclude()] }]);
    assert.equal(result.deviations?.length, 1);
  });
  test("a different spec place is another", async () => {
    const { result } = await go([{ calls: [rec(good)] }, { calls: [rec({ ...good, spec: "docs/SPEC.md:5" })] }, { calls: [conclude()] }]);
    assert.equal(result.deviations?.length, 2);
  });
  test("a model that only records, round after round, is stopped: recording is not an experiment (it used to loop forever)", async () => {
    const { result, count } = await go(Array.from({ length: 20 }, () => ({ calls: [rec(good)] })));
    assert.equal(result.stop, "stagnation");
    assert.match(result.conclusion, /6 rounds that learned nothing new/);
    assert.equal(count(), 6);
  });
  test("so is a model that keeps calling a tool it was never offered", async () => {
    const { result, count } = await go(Array.from({ length: 20 }, () => ({ calls: [{ name: "run_project_command", args: { command: "node -v" } }] })));
    assert.equal(result.stop, "stagnation");
    assert.equal(count(), 6);
  });
  test("recording between real experiments does not count against it", async () => {
    const { result } = await go([{ calls: [runT()] }, { calls: [fixLine("A1")] }, { calls: [runT()] }, { calls: [rec(good)] }, { calls: [fixLine("A2")] }, { calls: [runT()] }, { calls: [conclude()] }]);
    assert.equal(result.stop, "concluded");
  });
  test("outside a heal sandbox the tool does not exist", async () => {
    const { AgentTools } = await import("../src/agentTools.js");
    const tools = new AgentTools(repo, config);
    assert.equal(await tools.recordDeviation(good), "record_deviation is only available in a heal sandbox");
  });
  test("it is not among the default tools, so no ordinary agent is offered it", async () => {
    const { TOOLS_SCHEMA, RECORD_DEVIATION_TOOL } = await import("../src/agentTools.js");
    assert.ok(!TOOLS_SCHEMA.some((t: any) => t.function.name === "record_deviation"));
    assert.deepEqual(RECORD_DEVIATION_TOOL.function.parameters.required, ["app", "spec", "summary"]);
  });
});
