/**
 * Regression tests for RunControl's cross-surface question queueing
 * (provideForNextQuestion / ask): a free-text phone message with no
 * questionId should still bridge the brief race where it arrives right as
 * one question resolves and the next one (e.g. the idle "what should I do"
 * prompt) is about to be registered — but must NOT be applied to a much
 * later, unrelated question if it sat parked well past that window. That's
 * the actual shape of a real bug this guards against: a stray phone reply
 * meant for a question that had already resolved some other way sat queued
 * for minutes, then ambushed the idle "what should I do" prompt once the
 * task finally finished, producing a garbage Advisor answer to a "1" nobody
 * meant as a new instruction.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runControl } from "../src/remote/control.js";

const question = (id: string, idle = false) => ({
  id,
  kind: "blocking" as const,
  idle,
  prompt: "What should I do?",
  fallback: "",
  askedAt: new Date().toISOString(),
});

describe("RunControl — queued answer staleness", () => {
  test("a freshly-queued answer still applies to the next question asked", async () => {
    runControl.reset();
    try {
      const used = runControl.provideForNextQuestion("do the thing");
      assert.equal(used, false, "nothing was pending, so it should have been queued rather than answered immediately");

      const answer = await runControl.ask(question("q1", true));
      assert.equal(answer, "do the thing");
    } finally {
      runControl.reset();
    }
  });

  test("a stale queued answer is discarded, not applied to a much later, unrelated question", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    runControl.reset();
    try {
      runControl.provideForNextQuestion("1");
      // Simulate the actual failure shape: the stray answer was meant for a
      // question that resolved some other way, and only the idle prompt
      // shows up long after — well past any legitimate "typed a task right
      // as the desktop looped back to idle" race.
      t.mock.timers.tick(60_000);

      // Deliberately not awaited: a stale answer must NOT resolve this — it
      // should register a genuine pending waiter instead (checked below) and
      // stay unresolved until something real answers it, same as any other
      // ordinary question nobody has answered yet.
      void runControl.ask(question("q2", true));
      assert.deepEqual(
        runControl.pending().map((q) => q.id),
        ["q2"],
        "discarded, not silently swallowed — the question must be genuinely still pending, waiting for a real answer"
      );
    } finally {
      runControl.reset();
    }
  });

  test("a queued answer still inside the TTL window is honored", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    runControl.reset();
    try {
      runControl.provideForNextQuestion("start a task");
      t.mock.timers.tick(2_000); // comfortably inside the race-bridging window

      const answer = await runControl.ask(question("q3", true));
      assert.equal(answer, "start a task");
    } finally {
      runControl.reset();
    }
  });

  test("provideForNextQuestion answers an already-pending question immediately, bypassing the queue entirely", async () => {
    runControl.reset();
    try {
      const pending = runControl.ask(question("q4"));
      const used = runControl.provideForNextQuestion("install");
      assert.equal(used, true, "a question was already pending, so this should answer it directly rather than queue");
      assert.equal(await pending, "install");
    } finally {
      runControl.reset();
    }
  });
});
