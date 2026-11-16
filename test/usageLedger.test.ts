import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageLedger, toUsageWire, renderLedger, type UsageCall } from "../src/usageLedger.js";
import { events } from "../src/events.js";
import { ALWAYS_ALLOWED } from "../src/remote/protocol.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-ledger-"));
  file = path.join(dir, "usage-ledger.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(over: Partial<UsageCall> = {}): UsageCall {
  return { role: "EDITOR", model: "m/one", prompt: 100, completion: 50, total: 150, cost: 0.01, ...over };
}

describe("UsageLedger — lifetime totals", () => {
  test("accumulates by worker role and by model, and survives a restart", () => {
    const a = new UsageLedger(file);
    a.recordCall(call());
    a.recordCall(call({ role: "QA", model: "m/two", total: 300, prompt: 200, completion: 100, cost: 0.02 }));
    a.flush();

    // A brand-new instance (a "restarted desktop") reads the same totals.
    const b = new UsageLedger(file);
    const snap = b.snapshot();
    assert.equal(snap.totals.calls, 2);
    assert.equal(snap.totals.total, 450);
    assert.equal(snap.byAgent.EDITOR.total, 150);
    assert.equal(snap.byAgent.QA.total, 300);
    assert.equal(snap.byModel["m/two"].calls, 1);
    assert.ok(Math.abs(snap.totals.cost - 0.03) < 1e-9);
  });

  test("two processes writing the same file add up instead of clobbering each other", () => {
    const a = new UsageLedger(file);
    const b = new UsageLedger(file);
    a.recordCall(call({ total: 100 }));
    b.recordCall(call({ total: 40 }));
    a.flush();
    b.flush();
    a.recordCall(call({ total: 10 }));
    a.flush();
    assert.equal(new UsageLedger(file).snapshot().totals.total, 150);
  });

  test("a call outside any task still counts toward lifetime (/ask while idle)", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ role: "ADVISOR", total: 77 }));
    const snap = a.snapshot();
    assert.equal(snap.totals.total, 77);
    assert.equal(snap.tasks.length, 0);
  });

  test("a corrupt ledger is set aside, not overwritten, and counting restarts", () => {
    fs.writeFileSync(file, "{ not json");
    const a = new UsageLedger(file);
    a.recordCall(call({ total: 5 }));
    assert.equal(a.snapshot().totals.total, 5);
    const kept = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    assert.equal(kept.length, 1, "the unreadable file is preserved for a human");
  });

  test("a failed write keeps the deltas so the next flush retries them", () => {
    const blocked = path.join(dir, "is-a-file");
    fs.writeFileSync(blocked, "x");
    // Parent "directory" is a regular file, so mkdir/write must fail.
    const a = new UsageLedger(path.join(blocked, "usage.json"));
    a.recordCall(call({ total: 9 }));
    a.flush();
    assert.equal(a.dirty, true);
  });
});

describe("UsageLedger — task and phase totals", () => {
  test("attributes calls to the task and phase, and exposes overhead outside phases", () => {
    const a = new UsageLedger(file);
    // Discovery/Planning: in the task, in no phase.
    a.recordCall(call({ role: "DISCOVERY", taskId: "t1", repo: "app", total: 1000 }));
    a.recordCall(call({ role: "PLANNER", taskId: "t1", total: 500 }));
    // Phase 1.
    const p1 = { id: "p1", name: "Add login", executor: "EDITOR" };
    a.recordCall(call({ role: "EDITOR", taskId: "t1", phase: p1, total: 2000 }));
    a.recordCall(call({ role: "QA", taskId: "t1", phase: p1, total: 700 }));
    a.endPhase("t1", p1, true);
    // Phase 2, setup.
    const p2 = { id: "p2", name: "Restore dependencies", executor: "SETUP" };
    a.recordCall(call({ role: "SETUP", taskId: "t1", phase: p2, total: 300 }));
    a.endPhase("t1", p2, false);
    a.endTask("t1", "failed");

    const snap = a.snapshot();
    assert.equal(snap.totals.total, 4500);
    const t = snap.tasks[0];
    assert.equal(t.state, "failed");
    assert.equal(t.repo, "app");
    assert.ok(t.endedAt);
    assert.equal(t.usage.total, 4500);
    assert.equal(t.byAgent.EDITOR.total, 2000);
    assert.deepEqual(t.phases.map((p) => [p.id, p.passed, p.usage.total]), [["p1", true, 2700], ["p2", false, 300]]);
    assert.equal(t.phases[0].byAgent.QA.total, 700);

    // Spend outside any phase (Discovery + Planning) is the task total minus its phases.
    assert.match(renderLedger(snap), /discovery \/ planning \/ other\s+1\.5k tokens/);
  });

  test("tasks are counted when they start, even with no model call, and the count outlives eviction", () => {
    const a = new UsageLedger(file);
    a.beginTask("quiet", { repo: "app", title: "Run npm install" });
    a.endTask("quiet", "done");
    for (let i = 0; i < 120; i++) {
      a.beginTask(`t${i}`);
      a.endTask(`t${i}`, "done");
    }
    const snap = a.snapshot();
    assert.equal(snap.taskCount, 121);
    assert.equal(snap.tasks.length, 100);
    assert.equal(toUsageWire(snap).lifetime.tasks, 121);
  });

  test("beginTask is idempotent and a title is a clipped first line, never the whole prompt", () => {
    const a = new UsageLedger(file);
    const long = `   Fix the login redirect ${"x".repeat(200)}\nsecond line with details`;
    a.beginTask("t1", { title: long });
    a.beginTask("t1", { title: "something else" });
    a.recordCall(call({ taskId: "t1" }));
    a.endTask("t1", "done");
    const snap = a.snapshot();
    assert.equal(snap.taskCount, 1);
    const title = snap.tasks[0].title!;
    assert.ok(title.startsWith("Fix the login redirect"));
    assert.ok(title.length <= 80);
    assert.equal(title.includes("second line"), false);
  });

  test("a phase with no model call (a clean install) is still recorded with its outcome", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ taskId: "t2", total: 10 }));
    a.endPhase("t2", { id: "p1", name: "Install", executor: "SETUP" }, true);
    a.endTask("t2", "done");
    const t = a.snapshot().tasks[0];
    assert.deepEqual(t.phases.map((p) => [p.id, p.passed, p.usage.calls]), [["p1", true, 0]]);
  });

  test("only the newest 100 tasks are kept, but lifetime totals never shrink", () => {
    const a = new UsageLedger(file);
    for (let i = 0; i < 120; i++) {
      a.recordCall(call({ taskId: `t${i}`, total: 1 }));
      a.endTask(`t${i}`, "done");
    }
    const snap = a.snapshot();
    assert.equal(snap.tasks.length, 100);
    assert.equal(snap.totals.total, 120);
    assert.equal(snap.tasks.some((t) => t.taskId === "t0"), false, "oldest evicted");
    assert.equal(snap.tasks.some((t) => t.taskId === "t119"), true);
  });

  test("a task left 'running' by a process that died is reported interrupted", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1, desktopId: "d", since: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        totals: { calls: 1, prompt: 1, completion: 1, total: 2, cost: 0, pricedCalls: 0 },
        byAgent: {}, byModel: {},
        tasks: [{
          taskId: "ghost", startedAt: "2026-01-01T00:00:00.000Z", state: "running", pid: 2147483646,
          usage: { calls: 1, prompt: 1, completion: 1, total: 2, cost: 0, pricedCalls: 0 }, byAgent: {}, phases: [],
        }],
      })
    );
    const snap = new UsageLedger(file).snapshot();
    assert.equal(snap.tasks[0].state, "interrupted");
    assert.equal(snap.desktopId, "d", "the desktop id is stable across loads");
  });
});

describe("cost completeness", () => {
  test("unpriced calls make cost a floor; no priced calls omits cost entirely", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ cost: 0.5 }));
    a.recordCall(call({ cost: undefined }));
    const mixed = toUsageWire(a.snapshot()).lifetime;
    assert.equal(mixed.cost, 0.5);
    assert.equal(mixed.costIsFloor, true);

    const none = new UsageLedger(path.join(dir, "other.json"));
    none.recordCall(call({ cost: undefined }));
    const w = toUsageWire(none.snapshot()).lifetime;
    assert.equal("cost" in w, false, "no price was reported, so there is no known cost to show");
    assert.equal(w.costIsFloor, true);
  });

  test("a genuinely free $0 call counts as priced", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ cost: 0 }));
    const w = toUsageWire(a.snapshot()).lifetime;
    assert.equal(w.cost, 0);
    assert.equal(w.costIsFloor, false);
  });

  test("an empty ledger reports zero cost, not a floor", () => {
    const w = toUsageWire(new UsageLedger(file).snapshot()).lifetime;
    assert.equal(w.cost, 0);
    assert.equal(w.costIsFloor, false);
    assert.equal(w.calls, 0);
  });

  test("a task's cost is rounded to 4 places so a sub-cent task is not shown as $0.00", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ taskId: "t1", cost: 0.004212345 }));
    a.endTask("t1", "done");
    assert.equal(toUsageWire(a.snapshot()).last!.cost, 0.0042);
  });
});

describe("wire and terminal views", () => {
  test("wire has the agreed shape: lifetime with byWorker/byModel, plus the last ended task", () => {
    const a = new UsageLedger(file);
    a.beginTask("T-1", { repo: "app", title: "Fix login redirect" });
    a.recordCall(call({ role: "EDITOR", model: "m/one", taskId: "T-1", total: 1000, cost: 0.2 }));
    a.recordCall(call({ role: "QA", model: "m/two", taskId: "T-1", total: 500, cost: undefined }));
    a.endTask("T-1", "done");
    a.beginTask("T-2", { title: "still going" });
    a.recordCall(call({ role: "EDITOR", taskId: "T-2", total: 5 }));

    const w = toUsageWire(a.snapshot());
    assert.equal(w.lifetime.tokens, 1505);
    assert.equal(w.lifetime.tasks, 2);
    assert.equal(w.lifetime.calls, 3);
    assert.deepEqual(w.lifetime.byWorker.map((r) => r.worker), ["EDITOR", "QA"], "sorted by tokens");
    assert.deepEqual(w.lifetime.byWorker[1], { worker: "QA", tokens: 500, costIsFloor: true });
    assert.deepEqual(w.lifetime.byModel.map((r) => r.model), ["m/one", "m/two"]);
    // The running task is not "last"; the most recent ended one is, with the wire's own status word.
    assert.deepEqual(w.last, {
      taskId: "T-1",
      title: "Fix login redirect",
      status: "completed",
      tokens: 1500,
      cost: 0.2,
      costIsFloor: true,
    });
  });

  test("status words map from the ledger's states", () => {
    const a = new UsageLedger(file);
    const statusFor = (state: "failed" | "aborted", id: string) => {
      a.beginTask(id);
      a.recordCall(call({ taskId: id }));
      a.endTask(id, state);
      return toUsageWire(a.snapshot()).last!.status;
    };
    assert.equal(statusFor("failed", "f"), "failed");
    assert.equal(statusFor("aborted", "x"), "aborted");
  });

  test("no ended task yet means no `last`", () => {
    const a = new UsageLedger(file);
    a.beginTask("t", {});
    assert.equal("last" in toUsageWire(a.snapshot()), false);
  });

  test("the wire is small and bounded however many workers and models there are", () => {
    const a = new UsageLedger(file);
    for (let i = 0; i < 60; i++) {
      a.recordCall(call({ role: `W${i}`, model: `vendor/model-${i}`, total: i + 1 }));
    }
    const w = toUsageWire(a.snapshot());
    assert.equal(w.lifetime.byWorker.length, 12);
    assert.equal(w.lifetime.byModel.length, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(w)) < 4_000);
  });

  test("wire carries counts, ids and a short title only — no phase names or paths", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ taskId: "t1", phase: { id: "p1", name: "SECRET PHASE NAME", executor: "EDITOR" } }));
    a.endTask("t1", "done");
    const json = JSON.stringify(toUsageWire(a.snapshot()));
    assert.equal(json.includes("SECRET PHASE NAME"), false);
    assert.equal(json.includes("\\\\"), false);
  });

  test("/usage output shows lifetime, workers, models, and phases of recent tasks", () => {
    const a = new UsageLedger(file);
    a.recordCall(call({ role: "EDITOR", taskId: "t1", repo: "app", phase: { id: "p1", name: "Add login" }, total: 2500 }));
    a.recordCall(call({ role: "QA", cost: undefined, taskId: "t1", phase: { id: "p1", name: "Add login" }, total: 500 }));
    a.endPhase("t1", { id: "p1", name: "Add login" }, true);
    a.endTask("t1", "done");
    const text = renderLedger(a.snapshot());
    assert.match(text, /LIFETIME/);
    assert.match(text, /EDITOR/);
    assert.match(text, /m\/one/);
    assert.match(text, /✓ Add login/);
    assert.match(text, /\$0\.0100\+/, "a partial price is shown as a floor");
  });

  test("an empty ledger says so instead of printing zero rows", () => {
    assert.match(renderLedger(new UsageLedger(file).snapshot()), /Nothing recorded yet/);
  });
});

describe("hooks", () => {
  test("events.recordUsage notifies subscribers, and a throwing subscriber cannot break the call", () => {
    const seen: string[] = [];
    const off1 = events.onUsage(() => {
      throw new Error("boom");
    });
    const off2 = events.onUsage((agent, model, u) => seen.push(`${agent}:${model}:${u.total}`));
    try {
      events.recordUsage("EDITOR", "m/x", { prompt: 1, completion: 2, total: 3 });
    } finally {
      off1();
      off2();
    }
    assert.deepEqual(seen, ["EDITOR:m/x:3"]);
  });

  test("get_usage is a read-only verb every paired phone may use", () => {
    assert.ok(ALWAYS_ALLOWED.includes("get_usage"));
  });
});
