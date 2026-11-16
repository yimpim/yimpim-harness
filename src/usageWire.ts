/**
 * Usage numbers in the shape the phone gets. All of it is additive to the original status fields, so an app that does not know
 * about it keeps working unchanged.
 */
import type { UsageBucket, UsageReport } from "./events.js";
import { QA_USAGE_SUBROLES } from "./verifierTools.js";

export interface UsageWire {
  tokens: number;
  /** Omitted when no call in this bucket reported a price (show no cost, not $0). */
  costUsd?: number;
}

/** What one phase cost: in total, by agent role (the names a phone sees on worker.start) and by model id. */
export interface PhaseUsageWire extends UsageWire {
  byAgent: Record<string, UsageWire>;
  byModel: Record<string, UsageWire>;
}

const wire = (b: { total: number; cost: number; costKnown: boolean }): UsageWire => ({ tokens: b.total, ...(b.costKnown ? { costUsd: b.cost } : {}) });

/** Per agent role, with QA's internal sub-roles folded into "QA" so the keys match the worker names a phone was told. */
export function rollUpAgentUsage(byAgent: Record<string, UsageBucket>): Record<string, UsageWire> {
  const rows: Record<string, { total: number; cost: number; costKnown: boolean }> = {};
  for (const [agent, bucket] of Object.entries(byAgent)) {
    const role = QA_USAGE_SUBROLES.includes(agent) ? "QA" : agent;
    const row = (rows[role] ??= { total: 0, cost: 0, costKnown: false });
    row.total += bucket.total;
    if (bucket.costKnown) {
      row.cost += bucket.cost;
      row.costKnown = true;
    }
  }
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, wire(v)]));
}

export function phaseUsageWire(delta: UsageReport): PhaseUsageWire {
  return {
    ...wire(delta.totals),
    byAgent: rollUpAgentUsage(delta.byAgent),
    byModel: Object.fromEntries(Object.entries(delta.byModel).map(([m, b]) => [m, wire(b)])),
  };
}
