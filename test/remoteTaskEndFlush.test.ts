import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "../src/remote/client.js";
import { decodePairing, open, type Envelope } from "../src/remote/protocol.js";

function makeHandlers() {
  return {
    onAbort: () => {},
    onAnswer: () => {},
    onAttach: () => {},
    onMessage: () => {},
    onFetchDiff: () => {},
    onFetchHistory: () => {},
    onHistoryList: () => {},
    onFetchScreenshot: () => {},
    onGetModelConfig: () => {},
    onGetUsage: () => {},
    onListModels: () => {},
    onSetModel: () => {},
  };
}

describe("RemoteSession terminal task_end emission, immediate flush, and taskStatus heartbeats", () => {
  test("emitTaskEnd emits task_end payload with final phase/token/cost stats and flushes immediately without waiting for timer", async () => {
    const origFetch = globalThis.fetch;
    const deliveredBatches: { atMs: number; events: Envelope[] }[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_end", agentToken: "tok_end" }), { status: 200 });
      }
      if (u.endsWith("/v1/events") && init?.body) {
        const parsed = JSON.parse(String(init.body));
        deliveredBatches.push({
          atMs: Date.now(),
          events: Array.isArray(parsed.events) ? parsed.events : [],
        });
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
      });

      const pairingUrl = await session.start("run-multi", "my-repo", makeHandlers(), { projectName: "my-repo" });
      const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      // Simulate a 3-phase task running
      session.updateStatus({
        taskId: "task-multi-1",
        state: "running",
        phases: [
          { id: "p1", name: "Phase 1", status: "passed" },
          { id: "p2", name: "Phase 2", status: "passed" },
          { id: "p3", name: "Phase 3", status: "running" },
        ],
      });
      // Drain initial batches and verify running heartbeat carries taskRunning: true, taskStatus: "running"
      await session.flush();
      const runningEvents = deliveredBatches.flatMap((b) => b.events.map((e) => open<any>(key, e)));
      const runningStatus = runningEvents.filter((e) => e.kind === "status").pop();
      assert.equal(runningStatus.status.taskRunning, true);
      assert.equal(runningStatus.status.taskStatus, "running");

      deliveredBatches.length = 0;

      // Complete multi-phase task and measure flush latency (<200ms, well below the 900ms timer tick)
      const beforeMs = Date.now();
      await session.emitTaskEnd({
        taskId: "task-multi-1",
        state: "done",
        phasesCompleted: 3,
        totalPhases: 3,
        tokens: 42_500,
        cost: 0.184,
      });
      const elapsedMs = Date.now() - beforeMs;
      assert.ok(elapsedMs < 200, `expected immediate flush <200ms, took ${elapsedMs}ms`);

      assert.ok(deliveredBatches.length >= 1, "emitTaskEnd must immediately POST /v1/events");
      const decoded = deliveredBatches.flatMap((b) => b.events.map((e) => open<any>(key, e)));
      const endEvt = decoded.find((e) => e.kind === "task.end");
      assert.ok(endEvt, "must deliver task.end event immediately");
      assert.equal(endEvt.type, "task_end");
      assert.equal(endEvt.status, "completed");
      assert.equal(endEvt.state, "done");
      assert.equal(endEvt.taskId, "task-multi-1");
      assert.equal(endEvt.phasesCompleted, 3);
      assert.equal(endEvt.totalPhases, 3);
      assert.equal(endEvt.tokens, 42_500);
      assert.equal(endEvt.tokensUsed, 42_500);
      assert.equal(endEvt.cost, 0.184);
      assert.equal(endEvt.costUsd, 0.184);

      const finalStatus = decoded.filter((e) => e.kind === "status").pop();
      assert.ok(finalStatus, "must emit reconciled status snapshot");
      assert.equal(finalStatus.status.taskRunning, false);
      assert.equal(finalStatus.status.taskStatus, "completed");

      await session.stop("test done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("emitTaskEnd maps failed and aborted exits to status failed / stopped and taskStatus failed", async () => {
    const origFetch = globalThis.fetch;
    const delivered: Envelope[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_fail", agentToken: "tok_fail" }), { status: 200 });
      }
      if (u.endsWith("/v1/events") && init?.body) {
        const parsed = JSON.parse(String(init.body));
        if (Array.isArray(parsed.events)) delivered.push(...parsed.events);
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
      });
      const pairingUrl = await session.start("run-fail", "my-repo", makeHandlers());
      const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      delivered.length = 0;
      await session.emitTaskEnd({ taskId: "t-fail", state: "failed", phasesCompleted: 1, totalPhases: 3, tokens: 9000 });
      await session.emitTaskEnd({ taskId: "t-abort", state: "aborted", phasesCompleted: 0, totalPhases: 2, tokens: 1200 });

      const decoded = delivered.map((e) => open<any>(key, e));
      const ends = decoded.filter((e) => e.kind === "task.end");
      assert.equal(ends.length, 2);
      assert.equal(ends[0].status, "failed");
      assert.equal(ends[1].status, "stopped");

      const statuses = decoded.filter((e) => e.kind === "status");
      assert.equal(statuses[statuses.length - 1].status.taskRunning, false);
      assert.equal(statuses[statuses.length - 1].status.taskStatus, "failed");

      await session.stop("test done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
