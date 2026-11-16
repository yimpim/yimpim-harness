import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseUsageWire, rollUpAgentUsage } from "../src/usageWire.js";

const b = (total: number, cost: number, costKnown = true) => ({ prompt: 0, completion: 0, total, cost, costKnown });

test("QA's sub-roles fold into QA, and an unpriced role has no costUsd", () => {
  const out = rollUpAgentUsage({ EDITOR: b(100, 0.5), VERIFIER: b(10, 0.1), "verifier-nav": b(5, 0.05), PLANNER: b(7, 0, false) });
  assert.deepEqual(out.EDITOR, { tokens: 100, costUsd: 0.5 });
  assert.equal(out.QA.tokens, 15);
  assert.ok(Math.abs((out.QA.costUsd ?? 0) - 0.15) < 1e-9);
  assert.deepEqual(out.PLANNER, { tokens: 7 });
});

test("a phase carries its total, per-role and per-model usage", () => {
  const p = phaseUsageWire({ totals: b(120, 0.6), byAgent: { EDITOR: b(120, 0.6) }, byModel: { "m/x": b(120, 0.6) } });
  assert.deepEqual(p, { tokens: 120, costUsd: 0.6, byAgent: { EDITOR: { tokens: 120, costUsd: 0.6 } }, byModel: { "m/x": { tokens: 120, costUsd: 0.6 } } });
});
