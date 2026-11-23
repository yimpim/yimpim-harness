/**
 * Workers nest: REPAIR (or QA) waits while the security judges decide on a command it wants to run, and the judges are workers of their
 * own, often three at once. The event bus used one slot for "the running worker", so the judges' start overwrote REPAIR's and their end
 * cleared it, and a real phase then printed "REPAIR 0s" with no cost although REPAIR had run for minutes. Each worker now reports its own
 * time and usage, the judges theirs, and together they add up to the whole with nothing counted twice.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { events, type YimpimEvent } from "../src/events.js";
import { WorkerLedger } from "../src/workerLedger.js";

const usage = (total: number, cost: number) => ({ prompt: total, completion: 0, total, cost });

test("an outer worker keeps its own time and cost when workers run inside it, and the inner ones keep theirs", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const ends: Extract<YimpimEvent, { type: "agent.end" }>[] = [];
  const off = events.onEmit((e) => {
    if (e.type === "agent.end") ends.push(e);
  });
  try {
    events.emit({ type: "agent.start", agent: "REPAIR", models: ["m/repair"] });
    events.recordUsage("REPAIR", "m/repair", usage(1000, 0.01));
    mock.timers.tick(30_000);

    // REPAIR asks to run a command: three judges at once.
    for (let i = 0; i < 3; i++) events.emit({ type: "agent.start", agent: "SECURITY", models: ["m/judge"] });
    for (let i = 0; i < 3; i++) events.recordUsage("SECURITY", "m/judge", usage(200, 0.002));
    mock.timers.tick(5_000);
    for (let i = 0; i < 3; i++) events.emit({ type: "agent.end", agent: "SECURITY", rounds: 1, outcome: "completed" });

    events.recordUsage("REPAIR", "m/repair", usage(500, 0.005));
    mock.timers.tick(20_000);
    events.emit({ type: "agent.end", agent: "REPAIR", rounds: 6, outcome: "completed" });
  } finally {
    off();
    mock.timers.reset();
  }

  const repair = ends.find((e) => e.agent === "REPAIR")!;
  assert.equal(repair.elapsedMs, 50_000, "its own 30s + 20s, not the 5s the judges took");
  assert.equal(repair.tokensUsed, 1500);
  assert.ok(Math.abs(repair.costUsd! - 0.015) < 1e-9);

  const judges = ends.filter((e) => e.agent === "SECURITY");
  assert.equal(judges.length, 3);
  assert.equal(judges.reduce((n, e) => n + e.tokensUsed!, 0), 600, "the judges' tokens, counted once between them");
  assert.ok(Math.abs(judges.reduce((n, e) => n + e.costUsd!, 0) - 0.006) < 1e-9);
  assert.equal(judges.reduce((n, e) => n + e.elapsedMs!, 0), 5_000, "the panel's wall time, not three times it");
  assert.equal(repair.tokensUsed! + judges.reduce((n, e) => n + e.tokensUsed!, 0), 2100, "together: everything, once");
});

test("a worker after the nested one is measured normally (nothing left over from the stack)", () => {
  mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  let end: Extract<YimpimEvent, { type: "agent.end" }> | undefined;
  const off = events.onEmit((e) => {
    if (e.type === "agent.end" && e.agent === "QA") end = e;
  });
  try {
    events.emit({ type: "agent.start", agent: "QA", models: [] });
    events.recordUsage("VERIFIER", "m/qa", usage(300, 0.003)); // QA's calls carry other labels; the worker's lifetime still counts them
    mock.timers.tick(12_000);
    events.emit({ type: "agent.end", agent: "QA", rounds: 1, outcome: "completed" });
  } finally {
    off();
    mock.timers.reset();
  }
  assert.equal(end?.elapsedMs, 12_000);
  assert.equal(end?.tokensUsed, 300);
});

test("the ledger keeps which model answered the outer worker when another worker ran inside it", () => {
  const ledger = new WorkerLedger();
  ledger.start("REPAIR", ["m/primary", "m/backup"]);
  ledger.noteModel("m/backup");
  ledger.start("SECURITY", ["m/judge"]);
  ledger.noteModel("m/judge");
  ledger.end("SECURITY", 5000, 600, 0.006, "phase-2");
  const run = ledger.end("REPAIR", 50_000, 1500, 0.015, "phase-2");
  assert.deepEqual(run.fallbacks, ["m/backup"], "the backup answered REPAIR; the judge's model is not REPAIR's");
  const rows = Object.fromEntries(ledger.phaseRows("phase-2"));
  assert.equal(rows.REPAIR.ms, 50_000);
  assert.equal(rows.SECURITY.ms, 5000);
});
