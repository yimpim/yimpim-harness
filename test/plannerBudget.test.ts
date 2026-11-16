/**
 * The Planner may read every file Discovery named, and has the turns to do it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { plannerReadBudget, PLANNER_MIN_INSPECTED_FILES, PLANNER_MAX_INSPECTED_FILES_CEILING, AgentTools } from "../src/agentTools.js";
import { runToolAgent } from "../src/agentLoop.js";
import { AgentConfig } from "../src/config.js";

describe("plannerReadBudget", () => {
  test("every target Discovery named, never fewer than 8, never more than 30", () => {
    assert.equal(plannerReadBudget(6), PLANNER_MIN_INSPECTED_FILES);
    assert.equal(plannerReadBudget(12), 12);
    assert.equal(plannerReadBudget(25), 25);
    assert.equal(plannerReadBudget(99), PLANNER_MAX_INSPECTED_FILES_CEILING);
  });
});

describe("the Planner's turns match what it may read", () => {
  const tempDirs: string[] = [];
  const config = { prompts: { systemPersona: "You are YIMPIM." }, limits: { maxToolRounds: 40 } } as unknown as AgentConfig;
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test("it can read 16 files, one per turn, and still write the plan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-planbudget-"));
    tempDirs.push(dir);
    const files = Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    for (const f of files) await fs.writeFile(path.join(dir, f), `export const x = 1;\n`, "utf-8");

    const tools = new AgentTools(dir, config);
    tools.beginPlannerInspection(files, plannerReadBudget(files.length));

    const queue: any[] = files.map((f, i) => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: f }) } }],
    }));
    let requests = 0;
    const client = {
      async complete() {
        requests++;
        return { choices: [{ message: queue.shift() ?? { role: "assistant", content: "THE PLAN" } }] };
      },
    } as any;

    const result = await runToolAgent({
      prompt: "Plan it.",
      repo: {} as any,
      repoRoot: dir,
      client,
      config,
      agentTools: tools,
      models: ["m"],
      agentName: "PLANNER",
    });

    assert.equal(result, "THE PLAN");
    assert.equal(tools.plannerInspectedThisPass().length, 16);
    assert.equal(requests, 17); // 16 reads, then the plan
  });
});
