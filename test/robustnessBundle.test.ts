/**
 * Model cooldown, the "note" intent, and auto-allowing the project's own test run.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenRouterClient, cooldownFor, orderByHealth, MODEL_COOLDOWN_BASE_MS, MODEL_COOLDOWN_MAX_MS } from "../src/openrouter.js";
import { CommandApprovals, evaluateCommand, isProjectTestRun } from "../src/commandPolicy.js";
import { INTENT_SYSTEM } from "../src/prompts.js";

describe("model health ordering", () => {
  test("healthy models keep their order and come first; cooling ones go last, not away", () => {
    const now = 1_000_000;
    const health = new Map([["a", { failures: 1, cooldownUntil: now + 60_000 }]]);
    assert.deepEqual(orderByHealth(["a", "b", "c"], health, now), ["b", "c", "a"]);
  });

  test("an expired cooldown restores the configured order", () => {
    const now = 1_000_000;
    const health = new Map([["a", { failures: 1, cooldownUntil: now - 1 }]]);
    assert.deepEqual(orderByHealth(["a", "b"], health, now), ["a", "b"]);
  });

  test("with nothing cooling, the chain is untouched", () => {
    assert.deepEqual(orderByHealth(["x", "y"], new Map()), ["x", "y"]);
  });

  test("cooldown doubles per consecutive failure and is capped", () => {
    assert.equal(cooldownFor(1), MODEL_COOLDOWN_BASE_MS);
    assert.equal(cooldownFor(2), MODEL_COOLDOWN_BASE_MS * 2);
    assert.equal(cooldownFor(10), MODEL_COOLDOWN_MAX_MS);
  });
});

describe("OpenRouterClient remembers a failed model across calls", () => {
  const sse = (text: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] })}\n\ndata: [DONE]\n\n`
            )
          );
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const w = process.stdout.write.bind(process.stdout);
    const l = console.log;
    (process.stdout as any).write = () => true;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      (process.stdout as any).write = w;
      console.log = l;
    }
  }

  test("after a model fails a whole call, the next call tries its backup first", async () => {
    const original = globalThis.fetch;
    const tried: string[] = [];
    (globalThis as any).fetch = async (_u: string, init: any) => {
      const model = JSON.parse(init.body).model;
      tried.push(model);
      if (model === "bad/primary") return new Response("nope", { status: 400 });
      return sse("ok");
    };
    try {
      const client = new OpenRouterClient("test-key");
      (client as any).delay = async () => {};
      await quietly(() => client.complete(["bad/primary", "good/backup"], [{ role: "user", content: "hi" }]));
      const firstCallTried = [...tried];
      tried.length = 0;
      await quietly(() => client.complete(["bad/primary", "good/backup"], [{ role: "user", content: "hi again" }]));
      assert.deepEqual(firstCallTried, ["bad/primary", "bad/primary", "good/backup"], "two tries on a model that has a fallback behind it, then the backup");
      assert.deepEqual(tried, ["good/backup"], "the failing primary is not waited on again");
    } finally {
      (globalThis as any).fetch = original;
    }
  });

  test("a recovered model is used first again once its cooldown has passed", () => {
    const client = new OpenRouterClient("test-key");
    (client as any).modelHealth.set("a", { failures: 2, cooldownUntil: Date.now() - 1 });
    assert.deepEqual(orderByHealth(["a", "b"], (client as any).modelHealth), ["a", "b"]);
  });
});

describe("intent classifier knows about plain notes", () => {
  test("the prompt defines a note narrowly and defaults doubtful messages to a task", () => {
    assert.match(INTENT_SYSTEM, /"note"/);
    assert.match(INTENT_SYSTEM, /NO request, question or instruction/);
    assert.match(INTENT_SYSTEM, /If ANY part asks you for anything, or you are unsure, it is NOT a note/);
  });
});

describe("the project's own test run is asked about once, not once per variant", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const project = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-testrun-"));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), c);
    return dir;
  };
  const withTest = (script = "jest") => project({ "package.json": JSON.stringify({ scripts: { test: script, build: "tsc" } }) });
  const approvalsFor = (dir: string) => new CommandApprovals(path.join(dir, "..", "appr-" + path.basename(dir) + ".json"));

  test("a plain test-runner script needs no approval; any other test script asks until one form is approved", () => {
    const plain = withTest();
    assert.equal(evaluateCommand("npm test", { repoRoot: plain, approvals: approvalsFor(plain) }).verdict, "allow");
    assert.equal(evaluateCommand("npm test -- --runInBand", { repoRoot: plain, approvals: approvalsFor(plain) }).verdict, "allow");
    const custom = withTest("node scripts/run-tests.js");
    assert.equal(evaluateCommand("npm test", { repoRoot: custom, approvals: approvalsFor(custom) }).verdict, "ask");
    assert.equal(evaluateCommand("npm test -- --runInBand", { repoRoot: custom, approvals: approvalsFor(custom) }).verdict, "ask");
  });

  test("once one form is approved, the other forms are allowed without asking", () => {
    const dir = withTest();
    const approvals = approvalsFor(dir);
    const first = evaluateCommand("npm test", { repoRoot: dir, approvals });
    if (first.verdict === "deny") throw new Error("unexpected deny");
    approvals.remember(dir, first.argv, first.cwdRel, first.fingerprint);
    for (const cmd of [
      "npm test",
      "npm run test",
      "npm test -- --runInBand",
      "npm test -- --runInBand --silent __tests__/a.test.ts __tests__/b.test.ts",
    ]) {
      assert.equal(evaluateCommand(cmd, { repoRoot: dir, approvals }).verdict, "allow", cmd);
    }
  });

  test("editing the test script asks again, even for a variant of an approved run", () => {
    const dir = withTest();
    const approvals = approvalsFor(dir);
    const first = evaluateCommand("npm test", { repoRoot: dir, approvals });
    if (first.verdict === "deny") throw new Error("unexpected deny");
    approvals.remember(dir, first.argv, first.cwdRel, first.fingerprint);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node evil.js" } }));
    assert.equal(evaluateCommand("npm test -- --runInBand", { repoRoot: dir, approvals }).verdict, "ask");
  });

  test("approving the test run never approves other scripts or package-manager options", () => {
    const dir = withTest();
    const approvals = approvalsFor(dir);
    const first = evaluateCommand("npm test", { repoRoot: dir, approvals });
    if (first.verdict === "deny") throw new Error("unexpected deny");
    approvals.remember(dir, first.argv, first.cwdRel, first.fingerprint);
    assert.equal(evaluateCommand("npm run build", { repoRoot: dir, approvals }).verdict, "ask");
    assert.equal(evaluateCommand("npm test --silent", { repoRoot: dir, approvals }).verdict, "ask");
    assert.notEqual(evaluateCommand("npm test --script-shell=/bin/sh", { repoRoot: dir, approvals }).verdict, "allow");
  });

  test("pytest, cargo test and go test count as test runs only in a project set up for them", () => {
    const py = project({ "pytest.ini": "" });
    assert.ok(isProjectTestRun(["pytest", "-q", "tests/test_a.py"], py));
    assert.ok(isProjectTestRun(["python", "-m", "pytest"], py));
    assert.ok(!isProjectTestRun(["python", "-m", "pip", "install", "x"], py));
    assert.ok(!isProjectTestRun(["pytest"], project({ "a.txt": "" })));
    assert.ok(isProjectTestRun(["cargo", "test"], project({ "Cargo.toml": "" })));
    assert.ok(!isProjectTestRun(["cargo", "build"], project({ "Cargo.toml": "" })));
    assert.ok(isProjectTestRun(["go", "test", "./..."], project({ "go.mod": "" })));
  });

  test("a path outside the project is still refused on a test run", () => {
    const dir = withTest();
    assert.equal(evaluateCommand("npm test -- ../outside.test.ts", { repoRoot: dir }).verdict, "deny");
  });
});
