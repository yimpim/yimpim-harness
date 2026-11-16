/**
 * Regression tests for runToolAgent's agent.end guarantee: a paired phone
 * closes a "worker" card on worker.end, and before this, several real exit
 * paths from runToolAgent never fired one at all (conclude_task's
 * ALREADY_COMPLETED/CANNOT_LOCATE/TASK_CONCLUDED branches, and any thrown
 * exception) -- relying entirely on the app's own phase.end fallback to ever
 * close those cards. The app's workaround already works, but the desktop
 * should emit a real completion signal for every worker.start regardless.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runToolAgent, runLabeledCompletion } from "../src/agentLoop.js";
import { AgentTools } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";
import { events, YimpimEvent } from "../src/events.js";
import { AbortedError } from "../src/remote/control.js";

const config = ConfigSchema.parse({});
const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-agentloop-test-"));
  tempDirs.push(dir);
  return dir;
}

function captureAgentLifecycle(): {
  starts: Extract<YimpimEvent, { type: "agent.start" }>[];
  ends: Extract<YimpimEvent, { type: "agent.end" }>[];
  stop: () => void;
} {
  const starts: Extract<YimpimEvent, { type: "agent.start" }>[] = [];
  const ends: Extract<YimpimEvent, { type: "agent.end" }>[] = [];
  const unsubscribe = events.onEmit((e) => {
    if (e.type === "agent.start") starts.push(e);
    if (e.type === "agent.end") ends.push(e);
  });
  return { starts, ends, stop: unsubscribe };
}

/** A tool-call response, in the shape runToolAgent reads via
 *  `response?.choices?.[0]?.message || response?.message || response`. */
function toolCallResponse(name: string, args: Record<string, unknown>) {
  return { message: { tool_calls: [{ id: "call_1", function: { name, arguments: JSON.stringify(args) } }] } };
}

function plainTextResponse(content: string) {
  return { message: { content } };
}

describe("runToolAgent — agent.end fires exactly once per agent.start", () => {
  test("a plain-text response with no tool call emits agent.end 'completed'", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const client = { complete: async () => plainTextResponse("Nothing to do here.") } as any;
      const result = await runToolAgent({
        prompt: "Investigate X",
        repo: {} as any,
        repoRoot,
        client,
        config,
        agentTools: new AgentTools(repoRoot, config),
        models: ["fake/model"],
        agentName: "DISCOVERY",
      });

      assert.equal(result, "Nothing to do here.");
      assert.equal(capture.starts.length, 1);
      assert.equal(capture.ends.length, 1, "exactly one agent.end for the one agent.start");
      assert.equal(capture.ends[0].outcome, "completed");
    } finally {
      capture.stop();
    }
  });

  test("conclude_task(ALREADY_COMPLETED) emits agent.end 'completed'", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const client = {
        complete: async () => toolCallResponse("conclude_task", { status: "ALREADY_COMPLETED", explanation: "already there" }),
      } as any;
      const result = await runToolAgent({
        prompt: "Add X",
        repo: {} as any,
        repoRoot,
        client,
        config,
        agentTools: new AgentTools(repoRoot, config),
        models: ["fake/model"],
        agentName: "EDITOR",
      });

      assert.ok(result.startsWith("TASK_ALREADY_SATISFIED"));
      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].outcome, "completed");
    } finally {
      capture.stop();
    }
  });

  test("conclude_task(TASK_CONCLUDED) emits agent.end 'completed'", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const client = {
        complete: async () => toolCallResponse("conclude_task", { status: "TASK_CONCLUDED", explanation: "done", howToVerify: "tap the button" }),
      } as any;
      const result = await runToolAgent({
        prompt: "Add X",
        repo: {} as any,
        repoRoot,
        client,
        config,
        agentTools: new AgentTools(repoRoot, config),
        models: ["fake/model"],
        agentName: "EDITOR",
      });

      assert.ok(result.startsWith("TASK_CONCLUDED"));
      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].outcome, "completed");
    } finally {
      capture.stop();
    }
  });

  test("conclude_task(CANNOT_LOCATE) emits agent.end 'escalated' BEFORE throwing", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const client = {
        complete: async () => toolCallResponse("conclude_task", { status: "CANNOT_LOCATE", explanation: "no such file" }),
      } as any;

      await assert.rejects(
        () =>
          runToolAgent({
            prompt: "Add X",
            repo: {} as any,
            repoRoot,
            client,
            config,
            agentTools: new AgentTools(repoRoot, config),
            models: ["fake/model"],
            agentName: "EDITOR",
          }),
        /ESCALATION_NEEDED/
      );

      assert.equal(capture.ends.length, 1, "escalation must still close the worker card, not just abandon it");
      assert.equal(capture.ends[0].outcome, "escalated");
    } finally {
      capture.stop();
    }
  });

  test("an unexpected model-call exception still emits agent.end 'interrupted', then re-throws unchanged", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const boom = new Error("OpenRouter 503");
      const client = { complete: async () => { throw boom; } } as any;

      await assert.rejects(
        () =>
          runToolAgent({
            prompt: "Add X",
            repo: {} as any,
            repoRoot,
            client,
            config,
            agentTools: new AgentTools(repoRoot, config),
            models: ["fake/model"],
            agentName: "EDITOR",
          }),
        (err: any) => err === boom
      );

      assert.equal(capture.ends.length, 1, "an uncaught exception must not leave the worker card open forever");
      assert.equal(capture.ends[0].outcome, "interrupted");
    } finally {
      capture.stop();
    }
  });

  test("an AbortedError is labeled 'aborted', not the generic 'interrupted'", async () => {
    const repoRoot = await makeTempRepo();
    const capture = captureAgentLifecycle();
    try {
      const client = { complete: async () => { throw new AbortedError("user pressed stop"); } } as any;

      await assert.rejects(
        () =>
          runToolAgent({
            prompt: "Add X",
            repo: {} as any,
            repoRoot,
            client,
            config,
            agentTools: new AgentTools(repoRoot, config),
            models: ["fake/model"],
            agentName: "EDITOR",
          }),
        AbortedError
      );

      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].outcome, "aborted", "a user-initiated stop should read differently from a generic failure");
    } finally {
      capture.stop();
    }
  });
});

describe("runLabeledCompletion — bare (non-tool-calling) planner-style calls get the same lifecycle", () => {
  // REPLAN (refinePhaseInstructions/reformulatePhaseForFallback) and the
  // Planner's overflow-consolidation pass call client.complete() directly,
  // with no tool loop — before runLabeledCompletion existed, they never
  // emitted agent.start/agent.end at all, so a paired phone never showed a
  // worker card for real, billable planner work happening mid-phase.

  test("a successful call emits agent.start then agent.end('completed'), and returns the extracted text", async () => {
    const capture = captureAgentLifecycle();
    try {
      const client = { complete: async () => ({ message: { content: "Rewritten instructions." } }) } as any;
      const text = await runLabeledCompletion({
        client,
        models: ["fake/planner"],
        messages: [{ role: "user", content: "Reformulate this phase." }],
        agentName: "REPLAN",
      });

      assert.equal(text, "Rewritten instructions.");
      assert.equal(capture.starts.length, 1);
      assert.equal(capture.starts[0].agent, "REPLAN");
      assert.deepEqual(capture.starts[0].models, ["fake/planner"]);
      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].agent, "REPLAN");
      assert.equal(capture.ends[0].outcome, "completed");
    } finally {
      capture.stop();
    }
  });

  test("a failed call still emits agent.end('error') before the error propagates", async () => {
    const capture = captureAgentLifecycle();
    try {
      const client = { complete: async () => { throw new Error("model unavailable"); } } as any;

      await assert.rejects(
        () =>
          runLabeledCompletion({
            client,
            models: ["fake/planner"],
            messages: [{ role: "user", content: "Consolidate the proposed phases." }],
            agentName: "PLANNER",
          }),
        /model unavailable/
      );

      assert.equal(capture.starts.length, 1);
      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].agent, "PLANNER");
      assert.equal(capture.ends[0].outcome, "error");
    } finally {
      capture.stop();
    }
  });
});
