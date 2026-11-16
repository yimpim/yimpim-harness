import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { translateForRemote } from "../src/remoteEventTranslator.js";

const taskId = "task-1";

describe("translateForRemote", () => {
  test("agent.start becomes worker.start enriched with the current phase's context and workerId", () => {
    const out = translateForRemote(
      { type: "agent.start", agent: "EDITOR", models: ["m1", "m2"] },
      { id: "phase-2", name: "Implementation & Review", verification: ["Favorites persist across restart"] },
      taskId,
      "w-1"
    );
    assert.deepEqual(out, {
      kind: "worker.start",
      payload: {
        taskId,
        workerId: "w-1",
        agent: "EDITOR",
        phaseId: "phase-2",
        phaseName: "Implementation & Review",
        acceptanceCriteria: ["Favorites persist across restart"],
        retryOf: undefined,
        attempt: undefined,
        reason: undefined,
        exchangeId: undefined,
      },
    });
  });

  test("agent.start carries retryOf/attempt/reason through when the internal event has them (a corrective planner pass)", () => {
    const out = translateForRemote(
      { type: "agent.start", agent: "PLANNER", models: [], retryOf: "w-1", attempt: 2, reason: "Plan lacks surgical scope" },
      undefined,
      taskId,
      "w-2"
    );
    assert.equal(out?.payload.retryOf, "w-1");
    assert.equal(out?.payload.attempt, 2);
    assert.equal(out?.payload.reason, "Plan lacks surgical scope");
  });

  test("agent.start with no current phase still translates, with phase fields undefined", () => {
    const out = translateForRemote({ type: "agent.start", agent: "QA", models: [] });
    assert.equal(out?.kind, "worker.start");
    assert.equal(out?.payload.phaseId, undefined);
    assert.equal(out?.payload.phaseName, undefined);
  });

  test("agent.end becomes worker.end, carrying the same workerId its worker.start had", () => {
    const out = translateForRemote({ type: "agent.end", agent: "EDITOR", rounds: 4, outcome: "completed" }, undefined, taskId, "w-1");
    assert.deepEqual(out, {
      kind: "worker.end",
      payload: {
        taskId,
        workerId: "w-1",
        agent: "EDITOR",
        outcome: "completed",
        exchangeId: undefined,
        tokensUsed: undefined,
        costUsd: undefined,
      },
    });
  });

  test("agent.end carries this worker's own tokensUsed/costUsd through when present", () => {
    const out = translateForRemote(
      { type: "agent.end", agent: "QA", rounds: 0, outcome: "passed", tokensUsed: 12345, costUsd: 0.0421 },
      undefined,
      taskId,
      "w-2"
    );
    assert.equal(out?.payload.tokensUsed, 12345);
    assert.equal(out?.payload.costUsd, 0.0421);
  });

  test("agent.end carries exchangeId through for ADVISOR", () => {
    const out = translateForRemote(
      { type: "agent.end", agent: "ADVISOR", rounds: 1, outcome: "completed", exchangeId: "ask-1" },
      undefined,
      taskId,
      "w-1",
      true
    );
    assert.equal(out?.payload.exchangeId, "ask-1");
  });

  // Regression: an /ask asked during the idle gap after a task finishes used
  // to leave ADVISOR's worker.start/worker.end carrying that just-finished
  // task's stale id — the exact "contradicts advisor.start/advisor.answer's
  // own no-taskId-while-idle rule" bug flagged in review. Every OTHER agent
  // only ever runs while a task is genuinely active, so this is scoped to
  // ADVISOR specifically rather than gating taskId universally (which would
  // risk breaking the back-compat guarantee that worker.start.taskId is
  // always a plain string for EDITOR/PLANNER/QA/DISCOVERY/REPAIR).
  test("ADVISOR's worker.start/worker.end omit taskId while idle (taskRunning: false), even though a stale taskId is technically available", () => {
    const start = translateForRemote({ type: "agent.start", agent: "ADVISOR", models: [] }, undefined, taskId, "w-1", false);
    assert.equal(start?.payload.taskId, undefined);
    const end = translateForRemote({ type: "agent.end", agent: "ADVISOR", rounds: 1, outcome: "completed" }, undefined, taskId, "w-1", false);
    assert.equal(end?.payload.taskId, undefined);
  });

  test("ADVISOR's worker.start/worker.end DO carry taskId when asked mid-task (taskRunning: true)", () => {
    const start = translateForRemote({ type: "agent.start", agent: "ADVISOR", models: [] }, undefined, taskId, "w-1", true);
    assert.equal(start?.payload.taskId, taskId);
    const end = translateForRemote({ type: "agent.end", agent: "ADVISOR", rounds: 1, outcome: "completed" }, undefined, taskId, "w-1", true);
    assert.equal(end?.payload.taskId, taskId);
  });

  test("every OTHER agent's worker.start/worker.end always carries taskId regardless of taskRunning — the back-compat case, since only ADVISOR can run while no task is active", () => {
    for (const agent of ["EDITOR", "PLANNER", "QA", "DISCOVERY", "REPAIR"]) {
      const start = translateForRemote({ type: "agent.start", agent, models: [] }, undefined, taskId, "w-1", false);
      assert.equal(start?.payload.taskId, taskId, `${agent}'s worker.start must always carry taskId`);
    }
  });

  test("file.write for a new file becomes file.changed with action 'created', carrying its changeId but no phaseId when no phase is current", () => {
    const out = translateForRemote(
      {
        type: "file.write",
        agent: "EDITOR",
        path: "FavoritesRepository.kt",
        created: true,
        added: 42,
        removed: 0,
        changeId: "chg-1",
      },
      undefined,
      taskId,
      "w-1"
    );
    assert.deepEqual(out, {
      kind: "file.changed",
      payload: {
        taskId,
        workerId: "w-1",
        agent: "EDITOR",
        path: "FavoritesRepository.kt",
        action: "created",
        added: 42,
        removed: 0,
        changeId: "chg-1",
        phaseId: undefined,
      },
    });
  });

  test("file.write for an existing file becomes file.changed with action 'modified', enriched with the current phase's id", () => {
    const out = translateForRemote(
      {
        type: "file.write",
        agent: "REPAIR",
        path: "FavoritesViewModel.kt",
        created: false,
        added: 18,
        removed: 4,
        changeId: "chg-2",
      },
      { id: "phase-3", name: "Repair pass", verification: [] }
    );
    assert.equal(out?.payload.action, "modified");
    assert.equal(out?.payload.changeId, "chg-2");
    assert.equal(out?.payload.phaseId, "phase-3");
  });

  test("gate.result passes through tier/gate/status/blocking/detail/artifacts unchanged, enriched with the current phase's id", () => {
    const out = translateForRemote(
      {
        type: "gate.result",
        tier: "semantic",
        gate: "requirement coverage",
        status: "fail",
        blocking: true,
        detail: "UNMET: Favorites persist across restart — no persistence call found",
        artifacts: ["shot_1.png"],
      },
      { id: "phase-2", name: "Implementation & Review", verification: [] },
      taskId,
      "w-1"
    );
    assert.deepEqual(out, {
      kind: "gate.result",
      payload: {
        taskId,
        workerId: "w-1",
        tier: "semantic",
        gate: "requirement coverage",
        status: "fail",
        blocking: true,
        detail: "UNMET: Favorites persist across restart — no persistence call found",
        artifacts: ["shot_1.png"],
        phaseId: "phase-2",
      },
    });
  });

  test("verdict passes through unchanged, enriched with the current phase's id", () => {
    const out = translateForRemote(
      {
        type: "verdict",
        passed: false,
        confidence: "verified",
        blockingFailures: ["requirement coverage: missing persistence"],
        advisories: [],
      },
      { id: "phase-2", name: "Implementation & Review", verification: [] },
      taskId,
      "w-1"
    );
    assert.deepEqual(out, {
      kind: "verdict",
      payload: {
        taskId,
        workerId: "w-1",
        passed: false,
        confidence: "verified",
        blockingFailures: ["requirement coverage: missing persistence"],
        advisories: [],
        phaseId: "phase-2",
      },
    });
  });

  test("phase.start passes through phaseId/name/goal/index/total unchanged", () => {
    const out = translateForRemote(
      {
        type: "phase.start",
        phaseId: "phase-2",
        name: "Implementation & Review",
        goal: "Add persistence for favorited chickens across app restarts",
        index: 1,
        total: 3,
      },
      undefined,
      taskId
    );
    assert.deepEqual(out, {
      kind: "phase.start",
      payload: {
        taskId,
        phaseId: "phase-2",
        name: "Implementation & Review",
        goal: "Add persistence for favorited chickens across app restarts",
        index: 1,
        total: 3,
      },
    });
  });

  test("phase.end passes through phaseId/name/passed/confidence/attempts unchanged", () => {
    const out = translateForRemote(
      {
        type: "phase.end",
        phaseId: "phase-2",
        name: "Implementation & Review",
        passed: true,
        confidence: "verified",
        attempts: 1,
      },
      undefined,
      taskId
    );
    assert.deepEqual(out, {
      kind: "phase.end",
      payload: { taskId, phaseId: "phase-2", name: "Implementation & Review", passed: true, confidence: "verified", attempts: 1 },
    });
  });

  test("an internal event with no remote counterpart translates to undefined", () => {
    assert.equal(translateForRemote({ type: "tool.call", agent: "EDITOR", tool: "read_file", target: "x.kt" }), undefined);
    assert.equal(translateForRemote({ type: "log", level: "info", message: "hi" }), undefined);
  });

  test("advisor.answer carries the exact question and answer text, not a phase-scoped id", () => {
    const out = translateForRemote({ type: "advisor.answer", question: "q", answer: "a" });
    assert.deepEqual(out, { kind: "advisor.answer", payload: { text: "a", question: "q", exchangeId: undefined, taskId: undefined } });
  });

  test("advisor.answer carries exchangeId and taskId when given", () => {
    const out = translateForRemote({ type: "advisor.answer", question: "q", answer: "a", exchangeId: "ask-1" }, undefined, taskId, undefined, true);
    assert.equal(out?.payload.exchangeId, "ask-1");
    assert.equal(out?.payload.taskId, taskId);
  });

  test("advisor.answer omits taskId when asked while idle, even though taskId (the stale, just-finished task's id) is technically available", () => {
    const out = translateForRemote({ type: "advisor.answer", question: "q", answer: "a", exchangeId: "ask-1" }, undefined, taskId, undefined, false);
    assert.equal(out?.payload.taskId, undefined);
  });

  test("advisor.start carries exchangeId, question, and taskId only when taskRunning is true (undefined when asked while idle)", () => {
    const idle = translateForRemote({ type: "advisor.start", exchangeId: "ask-1", question: "what next" });
    assert.deepEqual(idle, { kind: "advisor.start", payload: { exchangeId: "ask-1", question: "what next", taskId: undefined } });

    const midTask = translateForRemote({ type: "advisor.start", exchangeId: "ask-2", question: "why" }, undefined, taskId, undefined, true);
    assert.equal(midTask?.payload.taskId, taskId);
  });

  test("advisor.answer caps a runaway answer/question rather than shipping it whole", () => {
    const longAnswer = "a".repeat(40_000);
    const longQuestion = "q".repeat(5_000);
    const out = translateForRemote({ type: "advisor.answer", question: longQuestion, answer: longAnswer });
    assert.equal(out?.payload.text, "a".repeat(32_000));
    assert.equal(out?.payload.question, "q".repeat(2_000));
  });

  test("manual.steps carries every step's exact text, including the optional phase", () => {
    const out = translateForRemote(
      {
        type: "manual.steps",
        steps: [
          { step: "Set FIREBASE_SERVICE_ACCOUNT_JSON", reason: "needed for push", phase: "Push notifications" },
          { step: "Rotate the Supabase key", reason: "it was exposed" },
        ],
      },
      undefined,
      taskId
    );
    assert.deepEqual(out, {
      kind: "manual.steps",
      payload: {
        taskId,
        steps: [
          { step: "Set FIREBASE_SERVICE_ACCOUNT_JSON", reason: "needed for push", phase: "Push notifications" },
          { step: "Rotate the Supabase key", reason: "it was exposed", phase: undefined },
        ],
      },
    });
  });

  test("manual.steps caps per-field length and the total number of steps", () => {
    const steps = Array.from({ length: 150 }, (_, i) => ({
      step: "x".repeat(3_000),
      reason: "y".repeat(3_000),
      phase: "z".repeat(1_000),
    }));
    const out = translateForRemote({ type: "manual.steps", steps });
    assert.equal(out?.payload.steps.length, 100, "no more than 100 steps should ever be sent");
    assert.equal(out?.payload.steps[0].step.length, 2_000);
    assert.equal(out?.payload.steps[0].reason.length, 2_000);
    assert.equal(out?.payload.steps[0].phase?.length, 500);
  });

  test("plan.ready carries the taskId, runId, goal, degraded flag, and every phase's own goal", () => {
    const out = translateForRemote(
      {
        type: "plan.ready",
        runId: "run-123",
        goal: "g",
        degraded: false,
        phases: [{ id: "p1", name: "n", goal: "pg" }],
      },
      undefined,
      taskId
    );
    assert.deepEqual(out, {
      kind: "plan.ready",
      payload: { taskId, runId: "run-123", goal: "g", degraded: false, phases: [{ id: "p1", name: "n", goal: "pg" }] },
    });
  });

  test("plan.ready's taskId is the reconciliation key (runId alone is not enough -- it's shared across every task in one process)", () => {
    // Two different tasks running back to back in the SAME desktop process
    // share one runId but must get distinct taskIds, or a client merges
    // their phase lists together (the "Phase 5/3" bug this fixes).
    const taskA = translateForRemote(
      { type: "plan.ready", runId: "run-abc", goal: "task A", degraded: false, phases: [] },
      undefined,
      "task-A"
    );
    const taskB = translateForRemote(
      { type: "plan.ready", runId: "run-abc", goal: "task B", degraded: false, phases: [] },
      undefined,
      "task-B"
    );
    assert.equal(taskA?.payload.runId, taskB?.payload.runId, "same process, so runId is legitimately identical");
    assert.notEqual(taskA?.payload.taskId, taskB?.payload.taskId, "different tasks must never share a taskId even within one process");
  });

  test("plan.ready caps per-field length and the total number of phases", () => {
    const phases = Array.from({ length: 150 }, (_, i) => ({
      id: `p${i}`,
      name: "n".repeat(1_000),
      goal: "g".repeat(3_000),
    }));
    const out = translateForRemote({ type: "plan.ready", runId: "run-123", goal: "x".repeat(3_000), degraded: true, phases });
    assert.equal(out?.payload.goal.length, 2_000);
    assert.equal(out?.payload.degraded, true);
    assert.equal(out?.payload.phases.length, 100, "no more than 100 phases should ever be sent");
    assert.equal(out?.payload.phases[0].name.length, 500);
    assert.equal(out?.payload.phases[0].goal.length, 2_000);
  });
});

describe("translateForRemote — error", () => {
  test("becomes a log event at error level, carrying the current task/worker ids", () => {
    const out = translateForRemote(
      { type: "error", message: "OpenRouter: insufficient credits — add credits to continue.", fatal: true },
      undefined,
      taskId,
      "w-9"
    );
    assert.deepEqual(out, {
      kind: "log",
      payload: {
        level: "error",
        message: "OpenRouter: insufficient credits — add credits to continue.",
        taskId,
        workerId: "w-9",
      },
    });
  });

  test("still translates with no current task/worker (e.g. the up-front intent classification call)", () => {
    const out = translateForRemote({ type: "error", message: "insufficient credits", fatal: true });
    assert.equal(out?.kind, "log");
    assert.equal(out?.payload.taskId, undefined);
    assert.equal(out?.payload.workerId, undefined);
  });
});
