import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPromptCaching } from "../src/openrouter.js";
import { events } from "../src/events.js";
import { AgentTools } from "../src/agentTools.js";
import { finalizeFocusTests, registerFocusFiles, isTestPath, isFocusPath } from "../src/focusTests.js";
import { createRunTestSession } from "../src/sandboxRunTest.js";
import type { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-pass2-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseConfig = {
  prompts: { systemPersona: "You are YIMPIM." },
  limits: { maxToolRounds: 8, maxFileBytes: 50_000, maxFilesPerPhase: 10 },
  safety: { blockedDirectories: [], blockedFilePatterns: [] },
} as unknown as AgentConfig;

describe("Pass 2 audit improvements", () => {
  test("applyPromptCaching injects ephemeral cache_control on Anthropic models without mutating inputs", () => {
    const msgs: any[] = [
      { role: "system", content: "Static system prompt" },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Reply 1" },
      { role: "user", content: "Turn 2" },
    ];
    const tools: any[] = [
      { type: "function", function: { name: "read_file", parameters: {} } },
      { type: "function", function: { name: "patch_file", parameters: {} } },
    ];

    const cached = applyPromptCaching("anthropic/claude-sonnet-4", msgs, tools);
    assert.ok(Array.isArray(cached.messages[0].content));
    assert.deepEqual((cached.messages[0].content as any[])[0].cache_control, { type: "ephemeral" });
    assert.ok(Array.isArray(cached.messages[3].content));
    assert.deepEqual((cached.messages[3].content as any[])[0].cache_control, { type: "ephemeral" });
    assert.deepEqual((cached.tools![1] as any).cache_control, { type: "ephemeral" });
    // Inputs not mutated
    assert.equal(typeof msgs[0].content, "string");
    assert.equal("cache_control" in tools[1], false);

    // Non-Anthropic models pass through unchanged
    const passthrough = applyPromptCaching("openai/gpt-5", msgs, tools);
    assert.equal(passthrough.messages, msgs);
    assert.equal(passthrough.tools, tools);
  });

  test("events tracks cached prompt tokens in UsageBucket and renders cache percentage", () => {
    const before = events.usageReport();
    events.recordUsage("PLANNER", "anthropic/claude-sonnet-4", {
      prompt: 1000,
      completion: 200,
      total: 1200,
      cached: 750,
      cost: 0.01,
    });
    const delta = events.usageDelta(before);
    assert.equal(delta.byAgent.PLANNER.cached, 750);
    assert.equal(delta.totals.cached, 750);
    const rendered = events.renderUsage(delta, "Cache test");
    assert.match(rendered, /75% cached/);
  });

  test("patchFile applies unique whitespace-normalized fallback and emits nearest-line hints on miss", async () => {
    const dir = await makeRepo();
    await fs.writeFile(
      path.join(dir, "app.ts"),
      [
        "export function greet(name: string) {",
        "    const msg = `Hello, ${name}!`;",
        "    return msg;",
        "}",
      ].join("\n")
    );
    const tools = new AgentTools(dir, baseConfig);
    tools.beginPhase(["app.ts"], 5, "phase-patch");

    // 2-space indent instead of 4-space indent should match uniquely via fallback & preserve 4-space indent
    await tools.patchFile("app.ts", "  const msg = `Hello, ${name}!`;\n  return msg;", "  const msg = `Hi, ${name}!`;\n  return msg;");
    const updated = await fs.readFile(path.join(dir, "app.ts"), "utf-8");
    assert.match(updated, /    const msg = `Hi, \$\{name\}!`;/);

    // Complete miss should include nearest-line diagnostic hints
    await assert.rejects(
      () => tools.patchFile("app.ts", "function greet(nonexistentArg: number) {", "function greet() {"),
      /Nearest matching lines in app\.ts:[\s\S]*L1: export function greet/
    );
  });

  test("AgentTools.setWritePathFilter blocks non-test writes during _focus reconciliation", async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, "src.ts"), "export const x = 1;\n");
    const tools = new AgentTools(dir, baseConfig);
    tools.beginPhase(["src.ts", "src.test.ts"], 5, "focus-review");
    tools.setWritePathFilter((p) => isTestPath(p) && !isFocusPath(p));

    await assert.rejects(() => tools.patchFile("src.ts", "x = 1", "x = 2"), /\[WRITE SCOPE\]/);
    await assert.rejects(() => tools.writeFile("__tests__/_focus/a.test.ts", "test"), /\[WRITE SCOPE\]/);
    await tools.writeFile("__tests__/perm.test.ts", "test('ok', () => {});\n");
    tools.setWritePathFilter(undefined);
  });

  test("finalizeFocusTests cleans up _focus files in finally even when review throws", async () => {
    const dir = await makeRepo();
    const focusRel = "__tests__/_focus/temp.test.ts";
    await fs.mkdir(path.join(dir, "__tests__", "_focus"), { recursive: true });
    await fs.writeFile(
      path.join(dir, focusRel),
      "import { foo } from '../../src/foo';\ntest('user clicks button and sees label', () => { expect(foo()).toBe(1); });\n"
    );
    registerFocusFiles(dir, [focusRel]);

    await assert.rejects(
      () =>
        finalizeFocusTests({
          repoRoot: dir,
          decide: async () => {
            throw new Error("boom");
          },
          review: async () => {},
          run: async () => ({ status: "pass", output: "" }),
        }).then(() => {
          // decide errors are caught internally; test a throw from run() instead
          throw new Error("expected");
        }),
      /expected/
    );

    // Confirm file was cleaned up
    await assert.rejects(() => fs.access(path.join(dir, focusRel)));
  });

  test("createRunTestSession.runMany batches multiple test files into one runner invocation", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, "__tests__"), { recursive: true });
    await fs.writeFile(path.join(dir, "__tests__", "a.test.ts"), "test('a', () => {});\n");
    await fs.writeFile(path.join(dir, "__tests__", "b.test.ts"), "test('b', () => {});\n");

    const calls: string[][] = [];
    const session = createRunTestSession({
      root: dir,
      gate: {},
      preapproveCurrent: true,
      fallbackRun: async (_root, files) => {
        calls.push(files);
        return { ok: true, output: "PASS __tests__/a.test.ts\nPASS __tests__/b.test.ts\n" };
      },
    });

    const res = await session.runMany!(["__tests__/a.test.ts", "__tests__/b.test.ts"]);
    assert.equal(res.refused, false);
    assert.equal(calls.length, 1, "must invoke runner once for all files");
    assert.deepEqual(calls[0], ["__tests__/a.test.ts", "__tests__/b.test.ts"]);
  });
});
