import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "../src/remote/client.js";
import { decodePairing, open, seal, type Envelope } from "../src/remote/protocol.js";

function makeHandlers(onFetchHistory: (cursor: { after?: string; afterEventId?: number; taskId?: string }) => void) {
  return {
    onAbort: () => {},
    onAnswer: () => {},
    onAttach: () => {},
    onMessage: () => {},
    onFetchDiff: () => {},
    onFetchHistory,
    onHistoryList: () => {},
    onFetchScreenshot: () => {},
    onGetModelConfig: () => {},
    onGetUsage: () => {},
    onListModels: () => {},
    onSetModel: () => {},
  };
}

describe("RemoteSession stale gap-recovery cursor hardening", () => {
  test("fresh RemoteSession ignores stale history_replay / fetch_history cursor (afterEventId: 35) and emits clean session status", async () => {
    const origFetch = globalThis.fetch;
    const sentEnvelopes: Envelope[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_fresh", agentToken: "tok_fresh" }), { status: 200 });
      }
      if (u.endsWith("/v1/events") && init?.body) {
        const parsed = JSON.parse(String(init.body));
        if (Array.isArray(parsed.events)) sentEnvelopes.push(...parsed.events);
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const historyCalls: any[] = [];
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
      });

      const pairingUrl = await session.start("run-fresh", "", makeHandlers((c) => historyCalls.push(c)));
      const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      // Drain initial start() events so we inspect only what the stale replay triggers.
      (session as any).outbox.length = 0;

      // Send stale history_replay with afterEventId: 35
      const staleCmd1 = seal(key, "sess_fresh", 1, {
        id: "cmd-stale-1",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "history_replay", afterEventId: 35 },
      });
      (session as any).handleEnvelope(staleCmd1);

      // Also verify fetch_history with afterEventId: 35 behaves identically
      const staleCmd2 = seal(key, "sess_fresh", 2, {
        id: "cmd-stale-2",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "fetch_history", afterEventId: 35 },
      });
      (session as any).handleEnvelope(staleCmd2);

      assert.equal(historyCalls.length, 0, "stale gap-recovery cursors must not invoke onFetchHistory");

      const emitted = ((session as any).outbox as Envelope[]).map((e) => open<any>(key, e));
      assert.ok(!emitted.some((e) => e.kind === "command.accepted"), "must not acknowledge stale cursor");
      assert.ok(!emitted.some((e) => e.kind === "history.fetched"), "must not emit history.fetched for stale cursor");

      const statusEvent = emitted.find((e) => e.kind === "status");
      assert.ok(statusEvent?.status, "must emit a clean status snapshot");
      assert.equal(statusEvent.status.repoName, "(no project)");
      assert.equal(statusEvent.status.state, "idle");
      assert.equal(statusEvent.status.tokensUsed, 0);
      assert.deepEqual(statusEvent.status.pendingQuestions, []);

      await session.stop("test done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("RemoteSession.start() resets recentEvents, nextEventId, and status cleanly across re-pairs and allows valid in-session / taskId cursors", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_repair", agentToken: "tok_repair" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const historyCalls: any[] = [];
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
      });

      const pairingUrl1 = await session.start("run-1", "my-app", makeHandlers((c) => historyCalls.push(c)), {
        projectName: "my-app",
      });
      const key1 = Buffer.from(decodePairing(pairingUrl1.split("#")[1]).key, "base64url");

      // Emit 2 task events -> nextEventId becomes 3
      session.push("task.start", { taskId: "t1", task: "do stuff" });
      session.push("worker.start", { taskId: "t1", worker: "EDITOR" });
      assert.equal((session as any).recentEvents.length, 2);
      assert.equal((session as any).nextEventId, 3);

      // Valid in-session gap recovery (afterEventId: 1 <= nextEventId - 1 = 2) IS forwarded
      const validCmd = seal(key1, "sess_repair", 1, {
        id: "cmd-valid-1",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "fetch_history", afterEventId: 1 },
      });
      (session as any).handleEnvelope(validCmd);
      assert.equal(historyCalls.length, 1);
      assert.equal(historyCalls[0].afterEventId, 1);

      // Task-scoped History lookup (taskId present) is never blocked even with high afterEventId
      const taskLookupCmd = seal(key1, "sess_repair", 2, {
        id: "cmd-task-1",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "fetch_history", taskId: "old-task", afterEventId: 35 },
      });
      (session as any).handleEnvelope(taskLookupCmd);
      assert.equal(historyCalls.length, 2);
      assert.equal(historyCalls[1].taskId, "old-task");

      // Re-start (simulating /remote-control re-pair) must reset ring buffer, nextEventId, and status
      await session.start("run-2", "fresh-app", makeHandlers((c) => historyCalls.push(c)), {
        projectName: "fresh-app",
      });
      assert.deepEqual((session as any).recentEvents, []);
      assert.equal((session as any).nextEventId, 1);
      assert.equal((session as any).hasEmittedTaskEvents, false);
      assert.equal((session as any).status.projectName, "fresh-app");
      assert.equal((session as any).status.tokensUsed, 0);
      assert.deepEqual((session as any).status.pendingQuestions, []);

      await session.stop("test done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("emits immediate status snapshot and empty history.fetched on fresh session (afterEventId: 0) or caught-up cursor (afterEventId === nextEventId - 1)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "sess_empty_replay", agentToken: "tok_empty" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
    }) as any;

    try {
      const historyCalls: any[] = [];
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
      });

      const pairingUrl = await session.start("run-empty", "my-app", makeHandlers((c) => historyCalls.push(c)));
      const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      // 1. Fresh session with afterEventId: 0 -> immediate snapshot + empty history.fetched, no onFetchHistory.
      (session as any).outbox.length = 0;
      const freshCmd = seal(key, "sess_empty_replay", 1, {
        id: "cmd-fresh-0",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "history_replay", afterEventId: 0 },
      });
      (session as any).handleEnvelope(freshCmd);

      assert.equal(historyCalls.length, 0);
      const emittedFresh = ((session as any).outbox as Envelope[]).map((e) => open<any>(key, e));
      assert.ok(emittedFresh.some((e) => e.kind === "status"));
      const fetchedFresh = emittedFresh.find((e) => e.kind === "history.fetched");
      assert.ok(fetchedFresh);
      assert.equal(fetchedFresh.count, 0);
      assert.equal(fetchedFresh.truncated, false);

      // 2. Caught-up session (afterEventId === nextEventId - 1) -> immediate snapshot + empty history.fetched.
      session.push("task.start", { taskId: "t1", task: "work" });
      session.push("worker.start", { taskId: "t1", worker: "EDITOR" });
      const latestEventId = (session as any).nextEventId - 1;
      (session as any).outbox.length = 0;

      const caughtUpCmd = seal(key, "sess_empty_replay", 2, {
        id: "cmd-caught-up",
        issuedAt: new Date().toISOString(),
        deviceId: "phone-1",
        payload: { verb: "history_replay", afterEventId: latestEventId },
      });
      (session as any).handleEnvelope(caughtUpCmd);

      assert.equal(historyCalls.length, 0);
      const emittedCaughtUp = ((session as any).outbox as Envelope[]).map((e) => open<any>(key, e));
      assert.ok(emittedCaughtUp.some((e) => e.kind === "status"));
      const fetchedCaughtUp = emittedCaughtUp.find((e) => e.kind === "history.fetched");
      assert.ok(fetchedCaughtUp);
      assert.equal(fetchedCaughtUp.count, 0);
      assert.equal(fetchedCaughtUp.truncated, false);
      assert.equal(fetchedCaughtUp.lastEventId, latestEventId);

      await session.stop("test done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
