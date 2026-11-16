/**
 * Regression tests for RemoteSession's wiring into the durable history log
 * (historyLog.ts): push() must persist everything it sends — including
 * `status`, which never flows through translateForRemote/remoteEventTranslator
 * at all and is what the Android app's own history feature is entirely keyed
 * on — while excluding the large, on-demand chunk kinds; and replayHistory()
 * must seed a fresh session's outbox WITHOUT re-appending to the log (or it
 * would duplicate a little more on every single re-pair) and must preserve
 * each entry's original timestamp rather than stamping "now" on old history.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteSession, phoneCommandEcho } from "../src/remote/client.js";
import { readHistoryBacklog, readHistoryBacklogSinceEventId, readTaskEvents, reconcileInterruptedTask } from "../src/remote/historyLog.js";
import { decodePairing, open, seal, Envelope } from "../src/remote/protocol.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-remoteclient-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Enough of a broker mock for start()/stop() to complete without a real
 *  network call — /v1/register, /v1/events, /v1/unregister all no-op OK. */
function stubBrokerFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v1/register")) {
      return new Response(JSON.stringify({ sessionId: "s_test", agentToken: "at_test" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

async function makeConnectedSession(repoRoot: string, redactLogs = false): Promise<RemoteSession> {
  const session = new RemoteSession({
    brokerUrl: "https://broker.example.invalid",
    allowAnswer: true,
    redactLogs,
    repoRoot,
  });
  await session.start("run1", "test-repo", {
    onAbort: () => {},
    onAnswer: () => {},
    onAttach: () => {},
    onMessage: () => {},
    onFetchDiff: () => {},
    onGetModelConfig: () => {},
    onListModels: () => {},
    onSetModel: () => {},
  });
  return session;
}

/**
 * Starts a FRESH session (its own key/sessionId, as a real new pairing or
 * reconnect would get), runs `act` against it, flushes on stop(), and
 * returns every event actually decrypted off the wire -- i.e. exactly what
 * a phone on the other end would have seen. `fetchSessionId` just has to be
 * unique per call so concurrent calls' stubbed /v1/register responses never
 * collide.
 */
async function collectLiveDecoded(
  repoRoot: string,
  fetchSessionId: string,
  act: (session: RemoteSession) => void | Promise<void>
): Promise<any[]> {
  const originalFetch = globalThis.fetch;
  let envelopes: Envelope[] = [];
  (globalThis as any).fetch = (async (url: string, init: any) => {
    const u = String(url);
    if (u.endsWith("/v1/register")) {
      return new Response(JSON.stringify({ sessionId: fetchSessionId, agentToken: `at_${fetchSessionId}` }), { status: 200 });
    }
    if (u.endsWith("/v1/events") && init?.body) {
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed.events)) envelopes = envelopes.concat(parsed.events);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const session = new RemoteSession({ brokerUrl: "https://broker.example.invalid", allowAnswer: true, redactLogs: false, repoRoot });
    const pairingUrl = await session.start("run1", "test-repo", {
      onAbort: () => {},
      onAnswer: () => {},
      onAttach: () => {},
      onMessage: () => {},
      onFetchDiff: () => {},
      onGetModelConfig: () => {},
      onListModels: () => {},
      onSetModel: () => {},
    } as any);
    const key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");
    await act(session);
    await session.stop("test done");
    return envelopes.map((env) => open<any>(key, env));
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

/** Canonical form for an "identical after key sorting" comparison (DESKTOP_EVENT_CONTRACT_V2_TASK.md's own acceptance-criterion wording). */
function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc: any, k) => {
        acc[k] = sortKeysDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

// DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 1: "for any event,
// the JSON sent live, the JSON replayed into a new pairing, and the JSON
// returned by fetch_history are byte-for-byte equal after key sorting."
// Both "replayed into a new pairing" and "returned by fetch_history" go
// through the exact same RemoteSession.replayHistory() in this codebase --
// the only difference is which slice of the durable log is handed to it
// (the full backlog for a fresh pairing, vs. just the entries after some
// eventId for a gap-recovery fetch_history) -- so this test exercises both
// call shapes against the one live-pushed event to lock in that equivalence.
describe("DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance: replay identity", () => {
  test("the same event is byte-for-byte identical (after key sorting) whether sent live, replayed into a fresh pairing, or returned via fetch_history", async () => {
    const repoRoot = await makeTempRepo();

    const livePayload = (
      await collectLiveDecoded(repoRoot, "s_live", (session) => {
        session.push("worker.start", {
          taskId: "task-1",
          workerId: "w-1",
          agent: "EDITOR",
          phaseId: "phase-2",
          phaseName: "Implementation & Review",
          acceptanceCriteria: ["Favorites persist across restart"],
        });
      })
    ).find((e) => e.kind === "worker.start");
    assert.ok(livePayload, "the live push must have gone out");

    // "Replayed into a new pairing": the same mechanism connectRemote (index.ts)
    // uses for a brand-new/reconnecting phone -- the FULL durable backlog.
    const fullBacklog = readHistoryBacklog(repoRoot);
    const replayedPayload = (
      await collectLiveDecoded(repoRoot, "s_replay", (session) => {
        session.replayHistory(fullBacklog);
      })
    ).find((e) => e.kind === "worker.start");
    assert.ok(replayedPayload);

    // "Returned by fetch_history": the same mechanism index.ts's onFetchHistory
    // handler uses -- a slice selected by eventId, handed to the same replayHistory().
    const { entries: gapEntries } = readHistoryBacklogSinceEventId(repoRoot, 0, 500);
    const fetchedPayload = (
      await collectLiveDecoded(repoRoot, "s_fetch", (session) => {
        session.replayHistory(gapEntries);
      })
    ).find((e) => e.kind === "worker.start");
    assert.ok(fetchedPayload);

    const canon = (o: any) => JSON.stringify(sortKeysDeep(o));
    assert.equal(canon(replayedPayload), canon(livePayload), "a fresh-pairing replay of this event must be byte-identical (after key sorting) to the live event");
    assert.equal(canon(fetchedPayload), canon(livePayload), "fetch_history's re-served copy of this event must be byte-identical (after key sorting) to the live event");
  });

  // DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 5: "a >500-event
  // task pages correctly" and "byte-identical to live" -- for the NEW
  // task-scoped fetch_history{taskId}, not just the repo-wide cursor above.
  test("fetch_history{taskId}'s re-served event is byte-identical (after key sorting) to the live event", async () => {
    const repoRoot = await makeTempRepo();

    const livePayload = (
      await collectLiveDecoded(repoRoot, "s_live2", (session) => {
        session.push("task.start", { taskId: "task-1", runId: "run-1", prompt: "do it", attachments: [] });
        session.push("worker.start", { taskId: "task-1", workerId: "w-1", agent: "EDITOR" });
      })
    ).find((e) => e.kind === "worker.start");
    assert.ok(livePayload);

    const { entries } = readTaskEvents(repoRoot, "task-1", 0, 500);
    const fetchedPayload = (
      await collectLiveDecoded(repoRoot, "s_fetch2", (session) => {
        session.replayHistory(entries);
      })
    ).find((e) => e.kind === "worker.start");
    assert.ok(fetchedPayload);

    const canon = (o: any) => JSON.stringify(sortKeysDeep(o));
    assert.equal(canon(fetchedPayload), canon(livePayload));
  });
});

// DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 6: "two tasks run
// back to back in one process -> no event of task B carries task A's id, and
// the first status of B has zeroed usage fields." The zeroed-usage half is
// already covered at the source (events.test.ts's usageDelta isolation
// tests -- buildUsageStatusPatch in index.ts is just usageDelta wrapped); this
// covers the taskId half end to end through the real push()/durable-log path.
describe("DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance: isolation (two tasks back to back)", () => {
  test("no event belonging to task B's run is ever found carrying task A's id in the durable log", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);

      // Task A, start to finish.
      session.push("task.start", { taskId: "task-A", runId: "run1", prompt: "first task", attachments: [] });
      session.push("worker.start", { taskId: "task-A", workerId: "w-1", agent: "EDITOR" });
      session.push("worker.end", { taskId: "task-A", workerId: "w-1", agent: "EDITOR", outcome: "completed" });
      session.push("task.end", { taskId: "task-A", state: "done", tokensUsed: 500 });

      // Task B, in the SAME process/session right after -- the exact "loops
      // back to the prompt" case this criterion is about.
      session.push("task.start", { taskId: "task-B", runId: "run1", prompt: "second task", attachments: [] });
      session.push("worker.start", { taskId: "task-B", workerId: "w-2", agent: "EDITOR" });
      session.push("worker.end", { taskId: "task-B", workerId: "w-2", agent: "EDITOR", outcome: "completed" });
      session.push("task.end", { taskId: "task-B", state: "done", tokensUsed: 80 });

      const entries = readHistoryBacklog(repoRoot);
      const taskBStartIndex = entries.findIndex((e) => e.kind === "task.start" && e.payload.taskId === "task-B");
      assert.ok(taskBStartIndex >= 0, "task B's task.start must be in the log");

      const afterTaskBStarted = entries.slice(taskBStartIndex);
      assert.ok(
        !afterTaskBStarted.some((e) => (e.payload as any).taskId === "task-A"),
        "once task B has started, nothing in the log from that point on may still carry task A's id"
      );
      // And task A's own events, symmetrically, must never carry task B's id.
      const beforeTaskBStarted = entries.slice(0, taskBStartIndex);
      assert.ok(
        !beforeTaskBStarted.some((e) => (e.payload as any).taskId === "task-B"),
        "task A's own events must never carry task B's id either"
      );

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 5: "every task.start
// is followed by exactly one task.end (including after a crash/restart ->
// interrupted). A corrective planner pass carries retryOf." The retryOf half
// is covered in remoteEventTranslator.test.ts; this is the full task-lifecycle
// half, end to end: two tasks pushed live through a real session (the first
// ending cleanly), then a THIRD task.start with no task.end at all -- the
// process ending mid-task, exactly like a crash -- followed by the same
// reconcileInterruptedTask() a real restart calls at startup.
describe("DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance: lifecycle (crash -> interrupted)", () => {
  test("every task.start in the durable log has exactly one task.end, including a crashed one closed retroactively as 'interrupted'", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      session.push("task.start", { taskId: "task-1", runId: "run1", prompt: "first task", attachments: [] });
      session.push("task.end", { taskId: "task-1", state: "done", tokensUsed: 500 });
      session.push("task.start", { taskId: "task-2", runId: "run1", prompt: "second task", attachments: [] });
      // No task.end for task-2 -- the process dies here (crash / kill / /stop
      // racing process exit), exactly like the real failure mode.
      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    // The next startup, before anything else touches the log.
    reconcileInterruptedTask(repoRoot);

    const entries = readHistoryBacklog(repoRoot);
    const starts = entries.filter((e) => e.kind === "task.start");
    const ends = entries.filter((e) => e.kind === "task.end");
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2, "every task.start must have exactly one task.end, including the crashed one");

    const endByTaskId = new Map(ends.map((e) => [(e.payload as any).taskId, e.payload]));
    assert.equal((endByTaskId.get("task-1") as any)?.state, "done");
    assert.equal((endByTaskId.get("task-2") as any)?.state, "interrupted");
  });
});

describe("RemoteSession.push — durable persistence", () => {
  test("persists status pushes, not just translated agent events", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      session.push("worker.start", { agent: "EDITOR" });
      session.updateStatus({ state: "running", tokensUsed: 42 });

      const kinds = readHistoryBacklog(repoRoot).map((e) => e.kind);
      // start() itself fires one initial updateStatus({}) — see its own
      // comment — so "status" appears at least twice here.
      assert.ok(kinds.includes("worker.start"), "translated agent events must still be captured");
      assert.ok(kinds.filter((k) => k === "status").length >= 2, "status pushes must be captured too — this is what the Android app's history is keyed on");

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("excludes screenshot.chunk and diff.chunk — large, on-demand, not part of a task summary", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      session.push("screenshot.chunk", { id: "x", label: "shot", mime: "image/png", seq: 0, total: 1, data: "abc" });
      session.push("diff.chunk", { changeId: "c1", path: "a.ts", seq: 0, total: 1, data: "abc" });
      session.push("file.changed", { agent: "EDITOR", path: "a.ts", action: "modified", added: 1, removed: 0 });

      const kinds = readHistoryBacklog(repoRoot).map((e) => e.kind);
      assert.ok(!kinds.includes("screenshot.chunk"));
      assert.ok(!kinds.includes("diff.chunk"));
      assert.ok(kinds.includes("file.changed"));

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("respects redactLogs the same way the live stream does", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot, true);
      session.push("log", { level: "info", message: "quotes project content" });
      session.push("worker.start", { agent: "EDITOR" });

      const kinds = readHistoryBacklog(repoRoot).map((e) => e.kind);
      assert.ok(!kinds.includes("log"), "a redacted kind must never reach durable storage when the user opted into redaction");
      assert.ok(kinds.includes("worker.start"));

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("RemoteSession.replayHistory", () => {
  test("does not re-append replayed entries to the durable log", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      session.push("worker.start", { agent: "EDITOR" });
      const before = readHistoryBacklog(repoRoot);

      session.replayHistory(before);
      const after = readHistoryBacklog(repoRoot);

      assert.deepEqual(after, before, "replaying history must not duplicate it in the durable log");

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("preserves each entry's original timestamp rather than stamping now", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
        repoRoot,
      });
      const pairingUrl = await session.start("run1", "test-repo", {
        onAbort: () => {},
        onAnswer: () => {},
        onAttach: () => {},
        onMessage: () => {},
        onFetchDiff: () => {},
        onGetModelConfig: () => {},
        onListModels: () => {},
        onSetModel: () => {},
      });
      const fragment = pairingUrl.split("#")[1];
      const key = Buffer.from(decodePairing(fragment).key, "base64url");

      const oldEntry = { kind: "worker.start", payload: { agent: "EDITOR" }, at: "2020-01-01T00:00:00.000Z" };
      session.replayHistory([oldEntry]);

      let sentEnvelopes: Envelope[] = [];
      (globalThis as any).fetch = (async (url: string, init: any) => {
        const u = String(url);
        if (u.endsWith("/v1/events") && init?.body) {
          const parsed = JSON.parse(init.body);
          if (Array.isArray(parsed.events)) sentEnvelopes = sentEnvelopes.concat(parsed.events);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      await session.stop("test done");

      const decoded = sentEnvelopes.map((env) => open<any>(key, env));
      const replayed = decoded.find((e) => e.kind === "worker.start");
      assert.ok(replayed, "the replayed entry must have been flushed to the broker");
      assert.equal(replayed.at, "2020-01-01T00:00:00.000Z", "replayHistory must preserve the original timestamp, not stamp the current time");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// "session.end" is NEVER durably persisted, for ANY reason -- not just a
// re-pair's own OLD-session teardown. It describes an ephemeral BROKER
// SESSION ending, not the task. Replaying it into a brand-new, very-much-
// alive session (which is exactly what durable persistence would eventually
// cause, since replay sends it exactly like any other historical event)
// would wrongly tell that new session to discard its own credentials and
// stop polling -- REMOTE_SPEC.md's own documented session.end contract.
// (An earlier version of this exclusion only covered the "re-pairing"
// reason specifically, on the theory that OTHER reasons like "desktop
// exited" were worth keeping as a human-visible history entry -- that
// reasoning conflated "useful to show in a timeline" with "safe to replay
// as a live instruction," which this corrects.)
describe("RemoteSession.stop — session.end is never durably persisted", () => {
  test('"re-pairing" is not durably persisted', async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      await session.stop("re-pairing");

      const entries = readHistoryBacklog(repoRoot);
      assert.ok(!entries.some((e) => e.kind === "session.end"));
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("a genuine end reason (e.g. the user exiting) is ALSO not durably persisted", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      await session.stop("desktop exited");

      const entries = readHistoryBacklog(repoRoot);
      assert.ok(
        !entries.some((e) => e.kind === "session.end"),
        "replaying session.end into a future, still-alive session would wrongly disconnect it, regardless of why THIS session ended"
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// The bug this fixes: command.accepted used to push only { verb }, so a
// phone's own typed text (its very first task prompt, an answer to a
// question, a rejection reason) was never captured anywhere durable --
// rebuilding history from a replay/recovery brought back everything the
// DESKTOP said, but never what the user actually typed.
describe("phoneCommandEcho", () => {
  test("echoes a message's text back", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "message", text: "Build a login screen" }, false), {
      verb: "message",
      text: "Build a login screen",
    });
  });

  test("echoes an answer's text alongside its questionId, and taskId when a task is currently running", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "answer", questionId: "q1", answer: "yes, use red" }, false, "task-1"), {
      verb: "answer",
      questionId: "q1",
      text: "yes, use red",
      taskId: "task-1",
    });
  });

  test("echoes a reject's reason, when given", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "reject", questionId: "q1", reason: "wrong screen" }, false, "task-1"), {
      verb: "reject",
      questionId: "q1",
      text: "wrong screen",
      taskId: "task-1",
    });
  });

  test("approve carries its questionId but has no free text to echo", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "approve", questionId: "q1" }, false, "task-1"), {
      verb: "approve",
      questionId: "q1",
      taskId: "task-1",
    });
  });

  test("a verb with no text/questionId at all (ping) echoes just the verb", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "ping" }, false), { verb: "ping" });
  });

  test("redactLogs strips the free text but keeps the questionId correlation id (never content, always safe)", () => {
    assert.deepEqual(phoneCommandEcho({ verb: "message", text: "secret project detail" }, true), { verb: "message" });
    assert.deepEqual(phoneCommandEcho({ verb: "answer", questionId: "q1", answer: "secret" }, true, "task-1"), {
      verb: "answer",
      questionId: "q1",
      taskId: "task-1",
    });
  });

  test("message never carries taskId, even when a task happens to be running -- the message might start a brand-new one, and the new task's id isn't minted until well after this point", () => {
    const out = phoneCommandEcho({ verb: "message", text: "do the next thing" }, false, "task-old");
    assert.equal((out as any).taskId, undefined);
  });
});

// The bug this fixes: screenshot.chunk is deliberately excluded from the
// durable history log (base64 image data would bloat it), so a gate.result
// recovered via fetch_history, or replayed after any reconnect, always names
// the screenshot file but never carries its pixels -- a tile with a filename
// and no image. fetch_screenshot lets the phone ask the desktop to re-serve
// that exact file from disk, on demand, independent of whether the original
// live chunks were ever received.
describe("RemoteSession.pushScreenshot — on-demand recovery", () => {
  test("returns true and sends chunks for a real file", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      const shotPath = path.join(repoRoot, "shot.png");
      await fs.writeFile(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const sent = session.pushScreenshot("shot_1", "shot.png", shotPath);
      assert.equal(sent, true);

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("returns false for a file that no longer exists, without throwing", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      const sent = session.pushScreenshot("shot_1", "gone.png", path.join(repoRoot, ".agent", "screenshots", "gone.png"));
      assert.equal(sent, false, "a missing file must be reported, not silently treated as sent");

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("pushScreenshotUnavailable is durably persisted (unlike screenshot.chunk itself)", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = stubBrokerFetch();
    try {
      const session = await makeConnectedSession(repoRoot);
      session.pushScreenshotUnavailable("expo-web-123.png", "That screenshot no longer exists on disk.");

      const entries = readHistoryBacklog(repoRoot);
      const unavailable = entries.find((e) => e.kind === "screenshot.unavailable");
      assert.ok(unavailable, "screenshot.unavailable is a small text event, not bulky image data -- no reason to exclude it from history");
      assert.equal(unavailable!.payload.path, "expo-web-123.png");

      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// A phone's "is the desktop alive?" probe. The pong must come back, but a ping
// must leave no trace: no durable command.accepted (it would get an eventId and
// surface in fetch_history), and no pong in the durable log either.
describe("RemoteSession ping handling", () => {
  test("answers a ping with a pong, without a command.accepted or any durable history entry", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    let key: Buffer | undefined;
    let commandsServed = 0;
    let envelopes: Envelope[] = [];
    (globalThis as any).fetch = (async (url: string, init: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "s_ping", agentToken: "at_ping" }), { status: 200 });
      }
      if (u.includes("/v1/commands")) {
        if (!key) return new Response(JSON.stringify({ commands: [] }), { status: 200 }); // pre-pairing tick
        if (commandsServed++ > 0) return new Promise<Response>(() => {}); // long-poll: hold open
        const mk = (seq: number, id: string, payload: unknown) =>
          seal(key!, "s_ping", seq, { id, issuedAt: new Date().toISOString(), deviceId: "dev", payload });
        return new Response(
          JSON.stringify({ commands: [mk(0, "c_ping", { verb: "ping" }), mk(1, "c_msg", { verb: "message", text: "hello" })] }),
          { status: 200 }
        );
      }
      if (u.endsWith("/v1/events") && init?.body) {
        const parsed = JSON.parse(init.body);
        if (Array.isArray(parsed.events)) envelopes = envelopes.concat(parsed.events);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const session = new RemoteSession({ brokerUrl: "https://broker.example.invalid", allowAnswer: true, redactLogs: false, repoRoot });
      const handlers: any = {
        onAbort: () => {},
        onAnswer: () => {},
        onAttach: () => {},
        onMessage: () => {},
        onFetchDiff: () => {},
        onGetModelConfig: () => {},
        onListModels: () => {},
        onSetModel: () => {},
      };
      const pairingUrl = await session.start("run1", "test-repo", handlers);
      key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      // Wait (bounded) for the flush loop to carry the pong out.
      const deadline = Date.now() + 2000;
      let decoded: any[] = [];
      while (Date.now() < deadline) {
        decoded = envelopes.map((env) => open<any>(key!, env));
        if (decoded.some((e) => e.kind === "pong")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await session.stop("test done");

      const pong = decoded.find((e) => e.kind === "pong");
      assert.ok(pong, "a ping must be answered with a pong within 2s");
      assert.equal(pong.eventId, undefined, "a pong carries no eventId");

      const accepted = decoded.filter((e) => e.kind === "command.accepted");
      assert.ok(!accepted.some((e) => e.verb === "ping"), "a ping must not echo a command.accepted");
      assert.ok(accepted.some((e) => e.verb === "message"), "control: a non-ping command in the same batch still echoes");

      const kinds = readHistoryBacklog(repoRoot).map((e) => e.kind);
      assert.ok(!kinds.includes("pong"));
      assert.ok(
        !readHistoryBacklog(repoRoot).some((e) => e.kind === "command.accepted" && (e.payload as any).verb === "ping"),
        "a ping must leave nothing in the durable log / fetch_history"
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// Counters-only usage metrics: the broker can't read sealed events, so the
// desktop attaches a plaintext `metrics` block to /v1/events posts.
describe("RemoteSession usage metrics", () => {
  test("posts a counters-only metrics block (prompts, aborts, worker/phase counts) and nothing else", async () => {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    let key: Buffer | undefined;
    let commandsServed = 0;
    const metricsPosts: any[] = [];
    (globalThis as any).fetch = (async (url: string, init: any) => {
      const u = String(url);
      if (u.endsWith("/v1/register")) {
        return new Response(JSON.stringify({ sessionId: "s_m", agentToken: "at_m" }), { status: 200 });
      }
      if (u.includes("/v1/commands")) {
        if (!key) return new Response(JSON.stringify({ commands: [] }), { status: 200 });
        if (commandsServed++ > 0) return new Promise<Response>(() => {});
        const mk = (seq: number, id: string, payload: unknown) =>
          seal(key!, "s_m", seq, { id, issuedAt: new Date().toISOString(), deviceId: "dev", payload });
        return new Response(
          JSON.stringify({
            commands: [
              mk(0, "c1", { verb: "ping" }),
              mk(1, "c2", { verb: "message", text: "build my SECRET-PROJECT thing" }),
              mk(2, "c3", { verb: "abort" }),
            ],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/v1/events") && init?.body) {
        const parsed = JSON.parse(init.body);
        if (parsed.metrics) metricsPosts.push(parsed.metrics);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const session = new RemoteSession({ brokerUrl: "https://broker.example.invalid", allowAnswer: true, redactLogs: false, repoRoot });
      const handlers: any = {
        onAbort: () => {}, onAnswer: () => {}, onAttach: () => {}, onMessage: () => {},
        onFetchDiff: () => {}, onGetModelConfig: () => {}, onListModels: () => {}, onSetModel: () => {},
      };
      const pairingUrl = await session.start("run1", "test-repo", handlers);
      key = Buffer.from(decodePairing(pairingUrl.split("#")[1]).key, "base64url");

      session.push("phase.start", { phaseId: "p1", name: "SECRET-PROJECT phase", executor: "SETUP", index: 0, total: 1 });
      session.push("worker.end", { agent: "EDITOR", workerId: "w1" });
      session.push("file.changed", { phaseId: "p1", path: "src/SECRET-PROJECT.ts" });
      session.push("phase.end", { phaseId: "p1", name: "SECRET-PROJECT phase", passed: true, attempts: 1 });

      const deadline = Date.now() + 3000;
      const total = () =>
        metricsPosts.reduce((acc, m) => {
          for (const [k, v] of Object.entries<number>(m.counters)) acc[k] = (acc[k] ?? 0) + v;
          return acc;
        }, {} as Record<string, number>);
      while (Date.now() < deadline) {
        const t = total();
        if (t.total_prompts && t.user_aborts && t.phases_completed) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await session.stop("test done");

      const t = total();
      assert.equal(t.total_prompts, 1, "one message = one prompt; the ping is not counted");
      assert.equal(t.user_aborts, 1);
      assert.equal(t.editor_runs, 1);
      assert.equal(t.setup_runs, 1, "a SETUP phase is counted even with no model call");
      assert.equal(t.phases_completed, 1);
      assert.equal(t.total_files_changed, 1);

      const wire = JSON.stringify(metricsPosts);
      assert.equal(wire.includes("SECRET"), false, "no prompt text, phase names or paths in the plaintext block");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("RemoteSession register body", () => {
  const handlers: any = {
    onAbort: () => {},
    onAnswer: () => {},
    onAttach: () => {},
    onMessage: () => {},
    onFetchDiff: () => {},
    onGetModelConfig: () => {},
    onListModels: () => {},
    onSetModel: () => {},
  };

  async function registerBody(leaseToken: string | undefined): Promise<any> {
    const repoRoot = await makeTempRepo();
    const originalFetch = globalThis.fetch;
    let sent: any;
    (globalThis as any).fetch = (async (url: string, init: any) => {
      if (String(url).endsWith("/v1/register")) {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ sessionId: "s_reg", agentToken: "at_reg" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const session = new RemoteSession({
        brokerUrl: "https://broker.example.invalid",
        allowAnswer: true,
        redactLogs: false,
        repoRoot,
        ...(leaseToken ? { leaseToken } : {}),
      });
      await session.start("run1", "test-repo", handlers);
      await session.stop("test done");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
    return sent;
  }

  test("sends the Pro lease as proToken when one is configured", async () => {
    const body = await registerBody("lease.jwt.value");
    assert.equal(body.proToken, "lease.jwt.value");
  });

  test("sends no proToken at all when none is configured (Tailscale / self-hosted relays)", async () => {
    const body = await registerBody(undefined);
    assert.ok(!("proToken" in body));
  });
});
