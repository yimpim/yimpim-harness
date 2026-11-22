/**
 * What each persona (planner, discovery, editor, repair, QA, ...) cost in time, tokens and money, for the console: one line when a worker finishes, one line when a phase finishes,
 * and a breakdown by persona when the task finishes. The phone gets the same facts from the events (worker.end carries tokens, cost and elapsed time; the status carries per-phase
 * totals); this only adds the desktop's view of them. Time is written the way the live status line writes it ("45s", "1m 30s", "2m 00s").
 */
import { formatElapsed, formatTokens } from "./liveCalls.js";

export interface WorkerRun {
  agent: string;
  ms: number;
  tokens: number;
  cost?: number;
  /** The models this worker was configured with, in order. */
  chain: string[];
  /** Models that answered one or more of its calls although they were not the first in the chain. */
  fallbacks: string[];
}

export interface RoleRow {
  runs: number;
  ms: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
}

/** Workers that run many short calls (the existence check's judges): counted in the totals, but not announced one by one. */
const NOT_ANNOUNCED = new Set(["EXISTENCE"]);
/** A worker is announced when it was long enough to wait for, or big enough to matter. */
const MIN_ANNOUNCE_MS = 5000;
const MIN_ANNOUNCE_TOKENS = 5000;

export const money = (usd: number): string => (usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export class WorkerLedger {
  private live?: { agent: string; chain: string[]; used: Set<string> };
  private task = new Map<string, RoleRow>();
  private phases = new Map<string, Map<string, RoleRow>>();

  /** A worker began (the event bus runs one at a time). */
  start(agent: string, chain: string[]): void {
    this.live = { agent, chain: [...chain], used: new Set() };
  }

  /** A model answered a call inside the running worker. */
  noteModel(model: string): void {
    this.live?.used.add(model);
  }

  /** The worker ended: it is added to the task's and the phase's totals, and described. */
  end(agent: string, ms: number, tokens: number, cost: number | undefined, phaseId?: string): WorkerRun {
    const live = this.live?.agent === agent ? this.live : undefined;
    this.live = undefined;
    const chain = live?.chain ?? [];
    const fallbacks = chain.length > 1 ? [...(live?.used ?? [])].filter((m) => m !== chain[0]) : [];
    const add = (rows: Map<string, RoleRow>) => {
      const row = rows.get(agent) ?? { runs: 0, ms: 0, tokens: 0, cost: 0, costKnown: false };
      row.runs += 1;
      row.ms += Math.max(0, ms);
      row.tokens += Math.max(0, tokens);
      if (cost !== undefined) {
        row.cost += cost;
        row.costKnown = true;
      }
      rows.set(agent, row);
    };
    add(this.task);
    if (phaseId) {
      let rows = this.phases.get(phaseId);
      if (!rows) this.phases.set(phaseId, (rows = new Map()));
      add(rows);
    }
    return { agent, ms, tokens, ...(cost !== undefined ? { cost } : {}), chain, fallbacks };
  }

  /** A new task: nothing carries over. */
  resetTask(): void {
    this.task.clear();
    this.phases.clear();
    this.live = undefined;
  }

  taskRows(): [string, RoleRow][] {
    return [...this.task];
  }

  phaseRows(phaseId: string): [string, RoleRow][] {
    return [...(this.phases.get(phaseId) ?? [])];
  }
}

export function announces(run: WorkerRun): boolean {
  return !NOT_ANNOUNCED.has(run.agent) && (run.ms >= MIN_ANNOUNCE_MS || run.tokens >= MIN_ANNOUNCE_TOKENS);
}

/** `[EDITOR] ✓ 1m 12s · 38.2k tokens · $0.0123`, and which model answered when it was not the first one configured. */
export function workerLine(run: WorkerRun): string {
  const parts = [formatElapsed(run.ms / 1000), `${formatTokens(run.tokens)} tokens`];
  if (run.cost !== undefined) parts.push(money(run.cost));
  if (run.fallbacks.length > 0) parts.push(`${run.fallbacks.join(", ")} answered (fallback for ${run.chain[0]})`);
  return `[${run.agent}] ✓ ${parts.join(" · ")}`;
}

/** The totals of a phase (or a task) as one line: "4m 12s · 120.4k tokens · $0.0521". */
export function totalsLine(ms: number, tokens: number, cost: number | undefined): string {
  return [formatElapsed(ms / 1000), `${formatTokens(tokens)} tokens`, ...(cost !== undefined ? [money(cost)] : [])].join(" · ");
}

/** One row per persona, longest first: "  EDITOR          3 runs   6m 02s   180.2k tokens   $0.1200". */
export function breakdownLines(rows: [string, RoleRow][]): string[] {
  const sorted = [...rows].sort((a, b) => b[1].ms - a[1].ms);
  const nameWidth = Math.max(6, ...sorted.map(([a]) => a.length));
  return sorted.map(([agent, r]) => {
    const runs = `${r.runs} run${r.runs === 1 ? " " : "s"}`.padEnd(7);
    const cost = r.costKnown ? money(r.cost) : "";
    return `  ${agent.padEnd(nameWidth)}  ${runs}  ${formatElapsed(r.ms / 1000).padStart(8)}  ${`${formatTokens(r.tokens)} tokens`.padStart(14)}  ${cost}`.trimEnd();
  });
}

/** A phase's personas on one line: "EDITOR 3m 02s · QA 40s". */
export function phaseWorkersLine(rows: [string, RoleRow][]): string {
  return [...rows]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([agent, r]) => `${agent} ${formatElapsed(r.ms / 1000)}${r.costKnown ? ` ${money(r.cost)}` : ""}`)
    .join(" · ");
}

/** The persona a fallback notice is about: "EDITOR FALLBACK", or plain "FALLBACK" when the call has no persona. */
export function fallbackTag(agent: string | undefined): string {
  const a = (agent ?? "").trim();
  return a ? `${a.toUpperCase()} FALLBACK` : "FALLBACK";
}
