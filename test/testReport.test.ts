/**
 * A failed test run is shown with its own report (the test's name and the
 * Expected/Received diff), and the repair Planner has no way to ask a person
 * for output the harness already had.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTestFailureReport } from "../src/testReport.js";
import { extractBuildFailureDetail } from "../src/verifierTools.js";
import { runToolAgent } from "../src/agentLoop.js";
import { AgentConfig } from "../src/config.js";
import { AgentTools } from "../src/agentTools.js";

const ESC = String.fromCharCode(27);

const JEST = `
> yimpim-remote@1.0.0 test
> jest

${ESC}[31mFAIL${ESC}[39m __tests__/timelineGolden.test.ts
  ${ESC}[1m● timeline golden › replays the sample history into the golden projection${ESC}[22m

    expect(received).toEqual(expected) // deep equality

    ${ESC}[32m- Expected  - 1${ESC}[39m
    ${ESC}[31m+ Received  + 1${ESC}[39m

      Object {
    -   "cards": 4,
    +   "cards": 5,
        "live": false,
      }

      72 |   const actual = project(reduce(events));
      73 |   const expected = golden.projection;
    > 74 |   expect(actual).toEqual(expected);
         |                  ^

      at Object.toEqual (__tests__/timelineGolden.test.ts:74:20)

  console.log
    this is console noise

  ● Console

    console.log
      noise

Test Suites: 1 failed, 1 total
Tests:       1 failed, 11 passed, 12 total
Snapshots:   0 total
Time:        2.4 s
`;

describe("extractTestFailureReport", () => {
  test("a Jest failure keeps the test's name and the Expected/Received diff, not just a stack frame", () => {
    const out = extractTestFailureReport(JEST)!;
    assert.match(out, /timeline golden › replays the sample history/);
    assert.match(out, /Expected {2}- 1/);
    assert.match(out, /"cards": 4/);
    assert.match(out, /"cards": 5/);
    assert.match(out, /Tests:\s+1 failed, 11 passed/);
  });

  test("colour codes and console blocks are gone", () => {
    const out = extractTestFailureReport(JEST)!;
    assert.ok(!out.includes(ESC));
    assert.doesNotMatch(out, /● Console/);
  });

  test("it is what the build gate now reports for a test run", () => {
    const out = extractBuildFailureDetail(JEST);
    assert.match(out, /Received {2}\+ 1/);
    assert.match(out, /toEqual/);
  });

  test("many failures are capped, with how many are not shown", () => {
    const many = Array.from({ length: 9 }, (_, i) => `  ● suite › test ${i}\n\n    expect(a).toBe(b)\n\n    Expected: ${i}\n    Received: ${i + 1}\n`).join("\n");
    const out = extractTestFailureReport(`${many}\nTests: 9 failed, 9 total\n`)!;
    assert.match(out, /test 0/);
    assert.match(out, /3 more failing test\(s\) not shown/);
  });

  test("pytest, go test, cargo test and mocha reports are kept too", () => {
    assert.match(extractTestFailureReport("collected 2 items\n=== FAILURES ===\n_ test_a _\nE   assert 1 == 2\n=== short test summary info ===\nFAILED test_a.py::test_a")!, /E {3}assert 1 == 2/);
    assert.match(extractTestFailureReport("=== RUN   TestA\n--- FAIL: TestA (0.00s)\n    a_test.go:9: got 1, want 2\nFAIL")!, /got 1, want 2/);
    assert.match(extractTestFailureReport("running 1 test\ntest a ... FAILED\n\nfailures:\n\n---- a stdout ----\nassertion failed: x == y\n\ntest result: FAILED. 0 passed; 1 failed")!, /assertion failed: x == y/);
    assert.match(extractTestFailureReport("  1) a\n\n  1 passing\n  1 failing\n\n  1) suite a:\n     AssertionError: expected 1 to equal 2")!, /expected 1 to equal 2/);
  });

  test("output that is not a test run is left to the compiler-error filter", () => {
    assert.equal(extractTestFailureReport("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'."), undefined);
    assert.equal(extractTestFailureReport("> Task :app:compileKotlin FAILED\ne: file.kt: (3, 5): Unresolved reference: x"), undefined);
    assert.match(extractBuildFailureDetail("src/a.ts(3,5): error TS2322: bad type"), /TS2322/);
  });
});

describe("the repair Planner cannot ask a person", () => {
  const tempDirs: string[] = [];
  const config = { prompts: { systemPersona: "You are YIMPIM." }, limits: { maxToolRounds: 6 } } as unknown as AgentConfig;
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const run = async (agentName: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-nask-"));
    tempDirs.push(dir);
    const tools = new AgentTools(dir, config);
    let asked = 0;
    (tools as any).askUser = async () => (asked++, "an answer");
    const toolNames: string[][] = [];
    const requests: any[][] = [];
    const queue: any[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "please paste the diff" }) } }] },
      { role: "assistant", content: "Diagnosis from the code." },
    ];
    const client = {
      async complete(_m: string[], messages: any[], options?: any) {
        requests.push(messages.map((m) => ({ ...m })));
        toolNames.push((options?.tools ?? []).map((t: any) => t?.function?.name));
        return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "done" } }] };
      },
    } as any;
    await runToolAgent({ prompt: "Diagnose.", repo: {} as any, repoRoot: dir, client, config, agentTools: tools, models: ["m"], agentName });
    return { asked, toolNames, requests };
  };

  test("ask_user is not offered to it, and a call to it asks nobody", async () => {
    const r = await run("REPAIR_PLANNER");
    assert.ok(!r.toolNames[0].includes("ask_user"));
    assert.equal(r.asked, 0);
    const refusal = r.requests[1].find((m: any) => m.role === "tool");
    assert.match(String(refusal.content), /You cannot ask the user anything/);
    assert.match(String(refusal.content), /which command would show it/);
  });

  test("other agents are unchanged: the Editor can still ask", async () => {
    const r = await run("EDITOR");
    assert.ok(r.toolNames[0].includes("ask_user"));
    assert.equal(r.asked, 1);
  });
});
