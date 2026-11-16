import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { events, formatCost } from "../src/events.js";

describe("usage tracking", () => {
  test("usageDelta isolates usage recorded after a snapshot from everything before it", () => {
    const before = events.usageReport();
    events.recordUsage("EDITOR", "some-model", { prompt: 100, completion: 50, total: 150 });
    events.recordUsage("EDITOR", "some-model", { prompt: 10, completion: 5, total: 15 });
    events.recordUsage("VERIFIER", "other-model", { prompt: 20, completion: 10, total: 30 });

    const delta = events.usageDelta(before);
    assert.equal(delta.totals.calls, 3);
    assert.equal(delta.totals.total, 195);
    assert.equal(delta.byAgent.EDITOR.calls, 2);
    assert.equal(delta.byAgent.EDITOR.total, 165);
    assert.equal(delta.byAgent.VERIFIER.calls, 1);
    assert.equal(delta.byAgent.VERIFIER.total, 30);
  });

  test("a second snapshot's delta never includes usage already counted in the first", () => {
    const snap1 = events.usageReport();
    events.recordUsage("DISCOVERY", "model-a", { prompt: 100, completion: 0, total: 100 });

    const snap2 = events.usageReport();
    events.recordUsage("DISCOVERY", "model-a", { prompt: 50, completion: 0, total: 50 });

    const delta2 = events.usageDelta(snap2);
    assert.equal(delta2.byAgent.DISCOVERY.total, 50, "must not include the 100 already recorded before snap2");

    const delta1 = events.usageDelta(snap1);
    assert.equal(delta1.byAgent.DISCOVERY.total, 150, "must include everything recorded since snap1");
  });

  test("an agent bucket with zero new calls since the snapshot is omitted from the delta", () => {
    events.recordUsage("REPAIR", "model-b", { prompt: 5, completion: 5, total: 10 });
    const snap = events.usageReport();
    events.recordUsage("EDITOR", "model-b", { prompt: 5, completion: 5, total: 10 });

    const delta = events.usageDelta(snap);
    assert.equal(delta.byAgent.REPAIR, undefined, "REPAIR had no NEW usage since the snapshot");
    assert.ok(delta.byAgent.EDITOR);
  });

  test("renderUsage uppercases every agent label regardless of how it was recorded", () => {
    const before = events.usageReport();
    events.recordUsage("verifier-visual", "vision-model", { prompt: 1, completion: 1, total: 2 });
    events.recordUsage("intent", "cheap-model", { prompt: 1, completion: 1, total: 2 });
    events.recordUsage("", "some-model", { prompt: 1, completion: 1, total: 2 }); // falls back to "unknown"

    const delta = events.usageDelta(before);
    const rendered = events.renderUsage(delta, "Token usage for this task");
    assert.match(rendered, /VERIFIER-VISUAL/);
    assert.match(rendered, /INTENT/);
    assert.match(rendered, /UNKNOWN/);
    assert.doesNotMatch(rendered, /verifier-visual/);
    assert.match(rendered, /Token usage for this task/);
  });

  test("renderUsage returns empty string for a delta with no calls", () => {
    const snap = events.usageReport();
    assert.equal(events.renderUsage(events.usageDelta(snap)), "");
  });

  test("cost is summed per agent and in totals when a call reports it", () => {
    const before = events.usageReport();
    events.recordUsage("EDITOR", "some-model", { prompt: 100, completion: 50, total: 150, cost: 0.0123 });
    events.recordUsage("EDITOR", "some-model", { prompt: 10, completion: 5, total: 15, cost: 0.0007 });

    const delta = events.usageDelta(before);
    assert.equal(delta.byAgent.EDITOR.costKnown, true);
    assert.ok(Math.abs(delta.byAgent.EDITOR.cost - 0.013) < 1e-9);
    assert.equal(delta.totals.costKnown, true);
    assert.ok(Math.abs(delta.totals.cost - 0.013) < 1e-9);
  });

  test("costKnown stays false for a bucket whose calls never reported a cost", () => {
    const before = events.usageReport();
    events.recordUsage("DISCOVERY", "no-cost-model", { prompt: 10, completion: 5, total: 15 });

    const delta = events.usageDelta(before);
    assert.equal(delta.byAgent.DISCOVERY.costKnown, false);
    assert.equal(delta.byAgent.DISCOVERY.cost, 0);
  });

  test("renderUsage appends a $ figure only for a bucket with known cost", () => {
    const before = events.usageReport();
    events.recordUsage("VERIFIER", "priced-model", { prompt: 10, completion: 5, total: 15, cost: 0.02 });
    events.recordUsage("PLANNER", "unpriced-model", { prompt: 10, completion: 5, total: 15 });

    const delta = events.usageDelta(before);
    const rendered = events.renderUsage(delta, "Token usage for this task");
    const verifierLine = rendered.split("\n").find((l) => l.includes("VERIFIER") && !l.includes("VERIFIER-"));
    const plannerLine = rendered.split("\n").find((l) => l.includes("PLANNER"));
    assert.match(verifierLine!, /\$0\.0200/);
    assert.doesNotMatch(plannerLine!, /\$/);
  });

  test("formatCost uses 4 decimals below a dime and 2 above it", () => {
    assert.equal(formatCost(0.0007), "$0.0007");
    assert.equal(formatCost(0.0999), "$0.0999");
    assert.equal(formatCost(0.1), "$0.10");
    assert.equal(formatCost(12.3456), "$12.35");
  });
});

describe("onEmit", () => {
  test("fires on every emit() even though the NDJSON stream itself is never enabled in this test", () => {
    assert.equal(events.isEnabled(), false);
    const seen: string[] = [];
    const unsubscribe = events.onEmit((e) => seen.push(e.type));
    try {
      events.emit({ type: "agent.start", agent: "EDITOR", models: ["m"] });
      events.emit({ type: "agent.end", agent: "EDITOR", rounds: 1, outcome: "completed" });
    } finally {
      unsubscribe();
    }
    assert.deepEqual(seen, ["agent.start", "agent.end"]);
  });

  test("unsubscribe stops further notifications without affecting other subscribers", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = events.onEmit((e) => a.push(e.type));
    const unsubB = events.onEmit((e) => b.push(e.type));
    try {
      events.emit({ type: "agent.start", agent: "REPAIR", models: [] });
      unsubA();
      events.emit({ type: "agent.end", agent: "REPAIR", rounds: 1, outcome: "completed" });
      assert.deepEqual(a, ["agent.start"]);
      assert.deepEqual(b, ["agent.start", "agent.end"]);
    } finally {
      unsubA();
      unsubB();
    }
  });
});

describe("emit() — per-worker usage attribution (agent.end.tokensUsed/costUsd)", () => {
  function captureAgentEnd(): { ends: any[]; stop: () => void } {
    const ends: any[] = [];
    const stop = events.onEmit((e) => {
      if (e.type === "agent.end") ends.push(e);
    });
    return { ends, stop };
  }

  test("sums usage recorded under ANY agent label between agent.start and agent.end onto the end event", () => {
    const capture = captureAgentEnd();
    try {
      events.emit({ type: "agent.start", agent: "QA", models: [] });
      // QA's real calls use three different labels, not "QA" — this is
      // exactly the mismatch that made QA's cost read as zero on a paired
      // phone before this fix (it matched worker cards by agent-label
      // string). Summing by WORKER LIFETIME instead needs no label match.
      events.recordUsage("VERIFIER", "model-a", { prompt: 100, completion: 50, total: 150, cost: 0.01 });
      events.recordUsage("verifier-nav", "model-b", { prompt: 10, completion: 5, total: 15, cost: 0.001 });
      events.recordUsage("verifier-visual", "model-b", { prompt: 20, completion: 10, total: 30, cost: 0.002 });
      events.emit({ type: "agent.end", agent: "QA", rounds: 0, outcome: "passed" });

      assert.equal(capture.ends.length, 1);
      assert.equal(capture.ends[0].tokensUsed, 195);
      assert.ok(Math.abs(capture.ends[0].costUsd - 0.013) < 1e-9);
    } finally {
      capture.stop();
    }
  });

  test("usage recorded BEFORE agent.start is never attributed to the next worker", () => {
    events.recordUsage("EDITOR", "model-a", { prompt: 999, completion: 999, total: 1998 });
    const capture = captureAgentEnd();
    try {
      events.emit({ type: "agent.start", agent: "REPAIR", models: [] });
      events.recordUsage("REPAIR", "model-a", { prompt: 5, completion: 5, total: 10 });
      events.emit({ type: "agent.end", agent: "REPAIR", rounds: 1, outcome: "completed" });

      assert.equal(capture.ends[0].tokensUsed, 10, "must not include the 1998 recorded before this worker started");
    } finally {
      capture.stop();
    }
  });

  test("a worker whose own window never reports a cost never shows a LEAKED nonzero cost from elsewhere", () => {
    // Not asserting costUsd === undefined here: usageDelta's own costKnown is
    // deliberately sticky across the whole process once ANY call anywhere
    // has ever reported a cost (see usageDelta's own doc comment) — a prior
    // test in this file already does, so costUsd can legitimately come back
    // as 0 rather than undefined depending on run order. What must hold
    // regardless of that is isolation: this worker's own window recorded no
    // cost, so if costUsd is present at all it must be exactly 0, never a
    // real-looking leaked amount from a DIFFERENT worker's spend.
    const capture = captureAgentEnd();
    try {
      events.emit({ type: "agent.start", agent: "DISCOVERY", models: [] });
      events.recordUsage("DISCOVERY", "no-cost-model", { prompt: 10, completion: 5, total: 15 });
      events.emit({ type: "agent.end", agent: "DISCOVERY", rounds: 1, outcome: "completed" });

      assert.equal(capture.ends[0].tokensUsed, 15);
      if (capture.ends[0].costUsd !== undefined) {
        assert.equal(capture.ends[0].costUsd, 0);
      }
    } finally {
      capture.stop();
    }
  });

  test("an agent.end with no preceding agent.start carries no usage fields, rather than throwing", () => {
    const capture = captureAgentEnd();
    try {
      assert.doesNotThrow(() => events.emit({ type: "agent.end", agent: "ADVISOR", rounds: 0, outcome: "completed" }));
      assert.equal(capture.ends[0].tokensUsed, undefined);
      assert.equal(capture.ends[0].costUsd, undefined);
    } finally {
      capture.stop();
    }
  });

  test("two workers back to back never leak one's usage into the other's total", () => {
    const capture = captureAgentEnd();
    try {
      events.emit({ type: "agent.start", agent: "EDITOR", models: [] });
      events.recordUsage("EDITOR", "model-a", { prompt: 100, completion: 0, total: 100 });
      events.emit({ type: "agent.end", agent: "EDITOR", rounds: 1, outcome: "completed" });

      events.emit({ type: "agent.start", agent: "REPAIR", models: [] });
      events.recordUsage("REPAIR", "model-a", { prompt: 7, completion: 0, total: 7 });
      events.emit({ type: "agent.end", agent: "REPAIR", rounds: 1, outcome: "completed" });

      assert.equal(capture.ends[0].agent, "EDITOR");
      assert.equal(capture.ends[0].tokensUsed, 100);
      assert.equal(capture.ends[1].agent, "REPAIR");
      assert.equal(capture.ends[1].tokensUsed, 7);
    } finally {
      capture.stop();
    }
  });
});
