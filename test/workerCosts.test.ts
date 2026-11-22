/**
 * What each persona cost, on the desktop: a line when a worker finishes (time, tokens, money, and the model that answered when it was a fallback), a line when a phase finishes, and a
 * breakdown by persona when the task finishes. The phone already gets tokens and cost per worker and per phase; the worker's elapsed time now goes to it too.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkerLedger, announces, workerLine, totalsLine, breakdownLines, phaseWorkersLine, fallbackTag, money } from "../src/workerLedger.js";
import { events } from "../src/events.js";
import { formatElapsed } from "../src/liveCalls.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

describe("the worker line", () => {
  test("time is written the way the live status writes it, then tokens, then money", () => {
    const l = new WorkerLedger();
    l.start("EDITOR", ["deepseek/a", "particle/b"]);
    l.noteModel("deepseek/a");
    const run = l.end("EDITOR", 72_000, 38_240, 0.01234, "p1");
    assert.equal(workerLine(run), "[EDITOR] ✓ 1m 12s · 38.2k tokens · $0.0123");
    assert.deepEqual([formatElapsed(45), formatElapsed(60), formatElapsed(90), formatElapsed(3725)], ["45s", "1m 00s", "1m 30s", "1h 02m 05s"]);
    assert.equal(money(1.5), "$1.50");
    assert.equal(money(0.0004), "$0.0004");
  });

  test("no price known: the line says nothing about money rather than $0", () => {
    const l = new WorkerLedger();
    l.start("QA", ["m"]);
    assert.equal(workerLine(l.end("QA", 9000, 12_000, undefined)), "[QA] ✓ 9s · 12.0k tokens");
  });

  test("a call answered by a later model in the chain is named as a fallback; the first model answering is not", () => {
    const l = new WorkerLedger();
    l.start("EDITOR", ["deepseek/a", "particle/b"]);
    l.noteModel("deepseek/a");
    l.noteModel("particle/b");
    const run = l.end("EDITOR", 30_000, 9000, 0.02);
    assert.deepEqual(run.fallbacks, ["particle/b"]);
    assert.match(workerLine(run), /particle\/b answered \(fallback for deepseek\/a\)$/);
    l.start("EDITOR", ["deepseek/a", "particle/b"]);
    l.noteModel("deepseek/a");
    assert.deepEqual(l.end("EDITOR", 30_000, 9000, 0.02).fallbacks, []);
    l.start("PLANNER", ["only/one"]);
    l.noteModel("only/one");
    assert.deepEqual(l.end("PLANNER", 1, 1, 0).fallbacks, [], "a chain of one has no fallback");
  });

  test("a worker is announced when it was long or big, and the existence check's many short judges never are", () => {
    const run = (agent: string, ms: number, tokens: number) => ({ agent, ms, tokens, chain: [], fallbacks: [] });
    assert.equal(announces(run("EDITOR", 5000, 10)), true);
    assert.equal(announces(run("EDITOR", 100, 5000)), true);
    assert.equal(announces(run("EDITOR", 4000, 4000)), false);
    assert.equal(announces(run("EXISTENCE", 90_000, 90_000)), false);
  });
});

describe("totals by persona", () => {
  const filled = () => {
    const l = new WorkerLedger();
    const go = (agent: string, ms: number, tokens: number, cost: number | undefined, phase: string) => {
      l.start(agent, ["m"]);
      l.end(agent, ms, tokens, cost, phase);
    };
    go("EDITOR", 60_000, 20_000, 0.02, "p1");
    go("QA", 20_000, 8000, 0.01, "p1");
    go("EDITOR", 120_000, 50_000, 0.05, "p2");
    go("PLANNER", 15_000, 6000, undefined, "p2");
    return l;
  };

  test("the task's rows add up every run of a persona; a phase's rows are only that phase", () => {
    const l = filled();
    assert.deepEqual(Object.fromEntries(l.taskRows().map(([a, r]) => [a, [r.runs, r.ms, r.tokens]])), { EDITOR: [2, 180_000, 70_000], QA: [1, 20_000, 8000], PLANNER: [1, 15_000, 6000] });
    assert.deepEqual(l.phaseRows("p1").map(([a]) => a), ["EDITOR", "QA"]);
    assert.equal(l.phaseRows("p1").find(([a]) => a === "EDITOR")![1].ms, 60_000);
    assert.deepEqual(l.phaseRows("nope"), []);
  });

  test("the breakdown lists the longest persona first, with runs, time, tokens and money; a persona with no known price shows none", () => {
    const lines = breakdownLines(filled().taskRows());
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ {2}EDITOR {2,}2 runs {2,}3m 00s {2,}70\.0k tokens {2,}\$0\.0700$/);
    assert.match(lines[1], /^ {2}QA {2,}1 run {3,}20s {2,}8\.0k tokens {2,}\$0\.0100$/);
    assert.match(lines[2], /^ {2}PLANNER {2}1 run {3,}15s {2,}6\.0k tokens$/);
  });

  test("a phase's personas on one line, and the totals line", () => {
    assert.equal(phaseWorkersLine(filled().phaseRows("p1")), "EDITOR 1m 00s $0.0200 · QA 20s $0.0100");
    assert.equal(totalsLine(252_000, 120_400, 0.0521), "4m 12s · 120.4k tokens · $0.0521");
    assert.equal(totalsLine(1000, 5, undefined), "1s · 5 tokens");
  });

  test("a new task starts from nothing", () => {
    const l = filled();
    l.resetTask();
    assert.deepEqual(l.taskRows(), []);
    assert.deepEqual(l.phaseRows("p1"), []);
  });
});

describe("how long a worker ran reaches the event", () => {
  test("agent.end carries the elapsed time of its own worker, and the usage it already carried", async () => {
    const bus = events;
    const seen: any[] = [];
    const off = bus.onEmit((e) => seen.push(e));
    bus.emit({ type: "agent.start", agent: "EDITOR", models: ["m"] });
    await new Promise((r) => setTimeout(r, 40));
    bus.emit({ type: "agent.end", agent: "EDITOR", rounds: 1, outcome: "completed" });
    off();
    const end = seen.find((e) => e.type === "agent.end");
    assert.ok(end.elapsedMs >= 30 && end.elapsedMs < 5000, `elapsedMs ${end.elapsedMs}`);
    assert.equal(end.tokensUsed, 0);
  });
  test("an end with no start has no elapsed time (nothing is invented)", () => {
    const bus = events;
    const seen: any[] = [];
    const off = bus.onEmit((e) => seen.push(e));
    bus.emit({ type: "agent.end", agent: "EDITOR", rounds: 1, outcome: "completed" });
    off();
    assert.equal(seen[0].elapsedMs, undefined);
  });
  test("the phone's worker.end carries it, additively", () => {
    assert.match(src("src/remoteEventTranslator.ts"), /costUsd: event\.costUsd,\n\s+\/\/ How long the worker ran[^\n]*\n\s+elapsedMs: event\.elapsedMs,/);
    assert.match(src("src/remote/protocol.ts"), /kind: "worker\.end";[^\n]*costUsd\?: number; elapsedMs\?: number/);
  });
});

describe("a fallback names the persona that fell back", () => {
  test("EDITOR FALLBACK, REPAIR FALLBACK, and plain FALLBACK when a call has no persona", () => {
    assert.equal(fallbackTag("EDITOR"), "EDITOR FALLBACK");
    assert.equal(fallbackTag("repair"), "REPAIR FALLBACK");
    assert.equal(fallbackTag(undefined), "FALLBACK");
    assert.equal(fallbackTag("  "), "FALLBACK");
  });
  test("both notices in the client use it", () => {
    const or = src("src/openrouter.ts");
    assert.ok(or.includes("[${fallbackTag(options?.agent)}] ${requested[0]} failed a recent call"));
    assert.ok(or.includes("[${fallbackTag(options?.agent)}] Switching from ${model}..."));
    assert.ok(!/\[FALLBACK\]/.test(or), "no notice is left without its persona");
  });
});

describe("the desktop shows it", () => {
  const idx = src("src/index.ts");
  test("the listeners are registered once, beside the usage ledger, and a worker's line comes from its own end event", () => {
    assert.equal((idx.match(/workerLedger\.end\(/g) ?? []).length, 1);
    assert.ok(idx.includes("workerLedger.start(event.agent, event.models ?? [])"));
    assert.ok(idx.includes("event.elapsedMs ?? 0, event.tokensUsed ?? 0, event.costUsd, currentPhaseUsageId"));
    assert.ok(idx.includes("workerLedger.noteModel(model);"));
  });
  test("a phase's completion line carries its time, tokens and cost, then its personas; the phone's phase totals are pushed at the same moment as before", () => {
    assert.ok(idx.includes("COMPLETE] ${planned.name} — ${totalsLine(Date.now() - currentPhaseStartedAt, phaseTotals.total"));
    assert.ok(idx.includes("phaseWorkersLine(phaseRows)"));
    assert.ok(idx.includes("remote?.updateStatus({\n        phases: plan.phases.map((p) => ({ id: p.id, name: p.name, status: statuses[p.id] ?? \"pending\" })),\n        ...buildUsageStatusPatch(),"));
  });
  test("the task ends with a total and one row per persona, and a new task (both places one starts) resets the tracker and its clock", () => {
    assert.ok(idx.includes("📊 [TASK TOTAL]"));
    assert.ok(idx.indexOf("📊 [TASK TOTAL]") > idx.indexOf("[ALL PHASES SUCCEEDED]"));
    assert.equal((idx.match(/workerLedger\.resetTask\(\);\n\s+currentTaskStartedAt = Date\.now\(\);/g) ?? []).length, 2);
    assert.ok(idx.includes("currentPhaseStartedAt = Date.now();"));
  });
});
