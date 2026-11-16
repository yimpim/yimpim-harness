/** The desktop side of usage telemetry: counts only, never content. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RemoteTelemetry } from "../src/remote/telemetry.js";

describe("RemoteTelemetry (desktop)", () => {
  test("a passed phase: worker runs, phase result, files and seconds — counts only", () => {
    const t = new RemoteTelemetry();
    t.observeEvent("phase.start", { phaseId: "p1", name: "SECRET NAME", executor: "EDITOR" }, 1_000);
    t.observeEvent("worker.end", { agent: "EDITOR" });
    t.observeEvent("file.changed", { phaseId: "p1", path: "src/secret.ts" });
    t.observeEvent("file.changed", { phaseId: "p1", path: "src/other.ts" });
    t.observeEvent("worker.end", { agent: "QA" });
    t.observeEvent("phase.end", { phaseId: "p1", passed: true }, 13_400);

    const r = t.drain()!;
    assert.deepEqual(r.counters, {
      editor_runs: 1,
      qa_runs: 1,
      total_files_changed: 2,
      phases_completed: 1,
      total_execution_seconds: 12,
    });
    assert.equal(r.lastFailureReason, undefined);
    const wire = JSON.stringify(r);
    assert.equal(wire.includes("SECRET"), false, "no phase names / paths in the report");
    assert.equal(wire.includes("secret.ts"), false);
  });

  test("a failed phase sets a coarse reason label and counts a failure", () => {
    const t = new RemoteTelemetry();
    t.observeEvent("phase.end", { phaseId: "p9", passed: false });
    const r = t.drain()!;
    assert.equal(r.counters.phases_failed, 1);
    assert.equal(r.lastFailureReason, "phase_failed");
  });

  test("SETUP is counted per SETUP phase, even with zero model calls (clean install)", () => {
    const t = new RemoteTelemetry();
    t.observeEvent("phase.start", { phaseId: "p1", executor: "SETUP" });
    t.observeEvent("phase.end", { phaseId: "p1", passed: true });
    t.observeEvent("phase.start", { phaseId: "p2", executor: "QA" });
    assert.equal(t.drain()!.counters.setup_runs, 1);
  });

  test("a SETUP diagnosis worker is not counted a second time", () => {
    const t = new RemoteTelemetry();
    t.observeEvent("phase.start", { phaseId: "p1", executor: "SETUP" });
    t.observeEvent("worker.end", { agent: "SETUP" });
    assert.equal(t.drain()!.counters.setup_runs, 1);
  });

  test("prompts are 'message' verbs only; aborts counted; attach chunks and answers are not prompts", () => {
    const t = new RemoteTelemetry();
    t.observeCommand("message");
    t.observeCommand("answer");
    t.observeCommand("attach");
    t.observeCommand("attach");
    t.observeCommand("abort");
    t.observeCommand("ping");
    assert.deepEqual(t.drain()!.counters, { total_prompts: 1, user_aborts: 1 });
  });

  test("drain resets, and restore puts a failed post's counters back", () => {
    const t = new RemoteTelemetry();
    t.observeEvent("worker.end", { agent: "EDITOR" });
    const first = t.drain();
    assert.equal(t.drain(), undefined);
    t.observeEvent("worker.end", { agent: "EDITOR" });
    t.restore(first);
    assert.equal(t.drain()!.counters.editor_runs, 2);
  });
});
