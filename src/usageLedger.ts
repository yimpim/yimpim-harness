/**
 * Lifetime usage ledger — the desktop's own durable record of what it has
 * spent, so totals survive restarts and can be shown on any paired phone.
 *
 * Why a separate file and not .agent/remote_history: that log is per repo,
 * only written while a remote session is registered, and evicts old tasks, so
 * summing it undercounts. This one is per DESKTOP (user-level, under
 * ~/.yimpim), written for every model call regardless of pairing.
 *
 * What it keeps:
 *   - lifetime totals, split by worker role and by model — never evicted;
 *   - a bounded window of recent tasks, each with its own totals, per-role
 *     split, and per-phase totals (so "what did phase 3 cost" is answerable,
 *     and the spend outside any phase — Discovery, Planning — is the task
 *     total minus its phases).
 *
 * Counts, durations and model ids only: no prompts, code or file paths. Phase
 * names are kept (they are short labels) so the phone can tell phases apart.
 *
 * Cost note: a provider does not always report a price. `pricedCalls` is kept
 * next to `calls` so a reader can say "$1.23+" (a floor) instead of presenting
 * a partial sum as exact.
 *
 * Several yimpim processes (one per repo) may run at once, so a flush is a
 * read-merge-write of THIS process's pending deltas into whatever is on disk,
 * never a blind overwrite of the file with an in-memory copy.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { formatCost, formatTokens } from "./events.js";

export interface LedgerBucket {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  /** Calls that reported a price; cost is exact only when this equals calls. */
  pricedCalls: number;
}

export type LedgerTaskState = "running" | "done" | "failed" | "aborted" | "interrupted";

export interface LedgerPhase {
  id: string;
  name: string;
  executor?: string;
  /** Undefined while the phase is still running. */
  passed?: boolean;
  usage: LedgerBucket;
  byAgent: Record<string, LedgerBucket>;
}

export interface LedgerTask {
  taskId: string;
  repo?: string;
  /** Short label for the task (first line of its prompt, clipped) - display only. */
  title?: string;
  startedAt: string;
  endedAt?: string;
  state: LedgerTaskState;
  /** Process that owns a running task — lets a later process mark it interrupted if it died. */
  pid?: number;
  usage: LedgerBucket;
  byAgent: Record<string, LedgerBucket>;
  phases: LedgerPhase[];
}

export interface LedgerFile {
  v: 1;
  desktopId: string;
  since: string;
  updatedAt: string;
  totals: LedgerBucket;
  /** Tasks ever started on this desktop - unlike `tasks`, never evicted. */
  taskCount: number;
  byAgent: Record<string, LedgerBucket>;
  byModel: Record<string, LedgerBucket>;
  tasks: LedgerTask[];
}

export interface UsageCall {
  /** Worker role, already normalised by the caller (e.g. VERIFIER sub-roles -> "QA"). */
  role: string;
  model: string;
  prompt: number;
  completion: number;
  total: number;
  cost?: number;
  /** Set only while a task is actually running. */
  taskId?: string;
  repo?: string;
  /** Set only while a phase is running. */
  phase?: { id: string; name: string; executor?: string };
}

const MAX_TASKS = 100;
const MAX_PHASES_PER_TASK = 60;
const MAX_MODEL_KEYS = 200;
const FLUSH_DEBOUNCE_MS = 2000;

const emptyBucket = (): LedgerBucket => ({ calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, pricedCalls: 0 });

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function addInto(dst: LedgerBucket, src: LedgerBucket): void {
  dst.calls += src.calls;
  dst.prompt += src.prompt;
  dst.completion += src.completion;
  dst.total += src.total;
  dst.cost += src.cost;
  dst.pricedCalls += src.pricedCalls;
}

function bucketIn(map: Record<string, LedgerBucket>, key: string): LedgerBucket {
  return (map[key] ??= emptyBucket());
}

function mergeMap(dst: Record<string, LedgerBucket>, src: Record<string, LedgerBucket>): void {
  for (const [k, v] of Object.entries(src)) addInto(bucketIn(dst, k), v);
}

function cloneBucket(b: LedgerBucket): LedgerBucket {
  return { ...b };
}

function coerceBucket(raw: any): LedgerBucket {
  return {
    calls: num(raw?.calls),
    prompt: num(raw?.prompt),
    completion: num(raw?.completion),
    total: num(raw?.total),
    cost: num(raw?.cost),
    pricedCalls: num(raw?.pricedCalls),
  };
}

function coerceMap(raw: any): Record<string, LedgerBucket> {
  const out: Record<string, LedgerBucket> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) out[k] = coerceBucket(v);
  }
  return out;
}

function coerceTask(raw: any): LedgerTask | undefined {
  if (!raw || typeof raw.taskId !== "string") return undefined;
  const states: LedgerTaskState[] = ["running", "done", "failed", "aborted", "interrupted"];
  return {
    taskId: raw.taskId,
    ...(typeof raw.repo === "string" ? { repo: raw.repo } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date(0).toISOString(),
    ...(typeof raw.endedAt === "string" ? { endedAt: raw.endedAt } : {}),
    state: states.includes(raw.state) ? raw.state : "interrupted",
    ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
    usage: coerceBucket(raw.usage),
    byAgent: coerceMap(raw.byAgent),
    phases: Array.isArray(raw.phases)
      ? raw.phases
          .filter((p: any) => p && typeof p.id === "string")
          .map((p: any): LedgerPhase => ({
            id: p.id,
            name: typeof p.name === "string" ? p.name : p.id,
            ...(typeof p.executor === "string" ? { executor: p.executor } : {}),
            ...(typeof p.passed === "boolean" ? { passed: p.passed } : {}),
            usage: coerceBucket(p.usage),
            byAgent: coerceMap(p.byAgent),
          }))
      : [],
  };
}

function freshFile(now = new Date()): LedgerFile {
  return {
    v: 1,
    desktopId: crypto.randomUUID(),
    since: now.toISOString(),
    updatedAt: now.toISOString(),
    totals: emptyBucket(),
    taskCount: 0,
    byAgent: {},
    byModel: {},
    tasks: [],
  };
}

function coerceFile(raw: any): LedgerFile {
  const base = freshFile();
  const tasks: LedgerTask[] = Array.isArray(raw?.tasks)
    ? raw.tasks.map(coerceTask).filter((t: LedgerTask | undefined): t is LedgerTask => !!t)
    : [];
  return {
    v: 1,
    desktopId: typeof raw?.desktopId === "string" && raw.desktopId ? raw.desktopId : base.desktopId,
    since: typeof raw?.since === "string" ? raw.since : base.since,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    totals: coerceBucket(raw?.totals),
    // A ledger written before the counter existed: the window is the best floor we have.
    taskCount: typeof raw?.taskCount === "number" ? num(raw.taskCount) : tasks.length,
    byAgent: coerceMap(raw?.byAgent),
    byModel: coerceMap(raw?.byModel),
    tasks,
  };
}

export function defaultLedgerPath(): string {
  return process.env.YIMPIM_USAGE_FILE || path.join(os.homedir(), ".yimpim", "usage-ledger.json");
}

/** First non-empty line, whitespace collapsed, clipped - a label, never the whole prompt. */
function clipTitle(raw?: string): string | undefined {
  if (!raw) return undefined;
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const flat = line.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = exists but not ours; still alive.
    return err?.code === "EPERM";
  }
}

export class UsageLedger {
  private pending = { totals: emptyBucket(), tasks: 0, byAgent: {} as Record<string, LedgerBucket>, byModel: {} as Record<string, LedgerBucket> };
  private hasPending = false;
  /** Tasks THIS process is responsible for, keyed by taskId; dropped once ended and flushed. */
  private owned = new Map<string, LedgerTask>();
  private timer?: NodeJS.Timeout;
  private lastFile?: LedgerFile;

  constructor(private readonly filePath: string = defaultLedgerPath()) {}

  // ------------------------------------------------------------- recording

  /** Never throws: usage accounting must not be able to break a task. */
  recordCall(c: UsageCall): void {
    try {
      const priced = typeof c.cost === "number" && Number.isFinite(c.cost) && c.cost >= 0;
      const one: LedgerBucket = {
        calls: 1,
        prompt: num(c.prompt),
        completion: num(c.completion),
        total: num(c.total),
        cost: priced ? (c.cost as number) : 0,
        pricedCalls: priced ? 1 : 0,
      };
      const role = c.role || "unknown";
      const model = c.model || "unknown";
      addInto(this.pending.totals, one);
      addInto(bucketIn(this.pending.byAgent, role), one);
      if (Object.keys(this.pending.byModel).length < MAX_MODEL_KEYS || this.pending.byModel[model]) {
        addInto(bucketIn(this.pending.byModel, model), one);
      }
      this.hasPending = true;

      if (c.taskId) {
        const task = this.ownedTask(c.taskId, c.repo);
        addInto(task.usage, one);
        addInto(bucketIn(task.byAgent, role), one);
        if (c.phase) {
          const phase = this.phaseOf(task, c.phase);
          if (phase) {
            addInto(phase.usage, one);
            addInto(bucketIn(phase.byAgent, role), one);
          }
        }
      }
      this.schedule();
    } catch {
      /* accounting only */
    }
  }

  /**
   * Registers a task the moment it starts, so it is counted (and titled) even
   * if it ends without a single model call. Idempotent.
   */
  beginTask(taskId: string, info: { repo?: string; title?: string } = {}): void {
    try {
      const task = this.ownedTask(taskId, info.repo);
      const title = clipTitle(info.title);
      if (title && !task.title) task.title = title;
      this.schedule();
    } catch {
      /* accounting only */
    }
  }

  /** Marks a phase's outcome. Creates the phase record if no call ran in it (e.g. a clean install). */
  endPhase(taskId: string, phase: { id: string; name: string; executor?: string }, passed: boolean): void {
    try {
      const task = this.ownedTask(taskId);
      const rec = this.phaseOf(task, phase);
      if (rec) rec.passed = passed;
      this.schedule();
    } catch {
      /* accounting only */
    }
  }

  endTask(taskId: string, state: Exclude<LedgerTaskState, "running">): void {
    try {
      const task = this.owned.get(taskId);
      if (task) {
        task.state = state;
        task.endedAt = new Date().toISOString();
        delete task.pid;
      }
      this.flush();
    } catch {
      /* accounting only */
    }
  }

  private ownedTask(taskId: string, repo?: string): LedgerTask {
    let task = this.owned.get(taskId);
    if (!task) {
      task = {
        taskId,
        ...(repo ? { repo } : {}),
        startedAt: new Date().toISOString(),
        state: "running",
        pid: process.pid,
        usage: emptyBucket(),
        byAgent: {},
        phases: [],
      };
      this.owned.set(taskId, task);
      this.pending.tasks++;
      this.hasPending = true;
    } else if (repo && !task.repo) {
      task.repo = repo;
    }
    return task;
  }

  private phaseOf(task: LedgerTask, p: { id: string; name: string; executor?: string }): LedgerPhase | undefined {
    let rec = task.phases.find((x) => x.id === p.id);
    if (!rec) {
      if (task.phases.length >= MAX_PHASES_PER_TASK) return undefined;
      rec = {
        id: p.id,
        name: p.name,
        ...(p.executor ? { executor: p.executor } : {}),
        usage: emptyBucket(),
        byAgent: {},
      };
      task.phases.push(rec);
    }
    return rec;
  }

  // ----------------------------------------------------------- persistence

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private load(): LedgerFile {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return freshFile();
    }
    try {
      return coerceFile(JSON.parse(text));
    } catch {
      // Unreadable: keep the bytes for a human, start a new ledger. Never
      // silently overwrite something we could not parse.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return freshFile();
    }
  }

  /** Merge this process's pending deltas into the file on disk. Never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      const file = this.load();
      addInto(file.totals, this.pending.totals);
      file.taskCount += this.pending.tasks;
      mergeMap(file.byAgent, this.pending.byAgent);
      mergeMap(file.byModel, this.pending.byModel);

      for (const t of this.owned.values()) {
        const rec = JSON.parse(JSON.stringify(t)) as LedgerTask;
        const i = file.tasks.findIndex((x) => x.taskId === t.taskId);
        if (i >= 0) file.tasks[i] = rec;
        else file.tasks.push(rec);
      }
      for (const t of file.tasks) {
        if (t.state === "running" && !this.owned.has(t.taskId) && (!t.pid || !pidAlive(t.pid))) {
          t.state = "interrupted";
          delete t.pid;
        }
      }
      if (file.tasks.length > MAX_TASKS) {
        // Oldest ended tasks go first; a running task is never evicted.
        const excess = file.tasks.length - MAX_TASKS;
        let dropped = 0;
        file.tasks = file.tasks.filter((t) => {
          if (dropped < excess && t.state !== "running") {
            dropped++;
            return false;
          }
          return true;
        });
      }
      file.updatedAt = new Date().toISOString();

      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
      fs.renameSync(tmp, this.filePath);

      // Only after the write landed: a failed write keeps the deltas for next time.
      this.pending = { totals: emptyBucket(), tasks: 0, byAgent: {}, byModel: {} };
      this.hasPending = false;
      for (const [id, t] of this.owned) if (t.state !== "running") this.owned.delete(id);
      this.lastFile = file;
    } catch {
      /* keep pending; the next flush retries */
    }
  }

  /** Current on-disk truth (flushes first, so it includes this process's spend). */
  snapshot(): LedgerFile {
    this.flush();
    return this.lastFile ?? this.load();
  }

  /** True when there are unflushed deltas — exposed for tests. */
  get dirty(): boolean {
    return this.hasPending;
  }
}

// ---------------------------------------------------------------- singleton

let shared: UsageLedger | undefined;

/** The process-wide ledger. Flushes on exit so a clean quit never loses the tail. */
export function usageLedger(): UsageLedger {
  if (!shared) {
    shared = new UsageLedger();
    process.once("exit", () => shared?.flush());
  }
  return shared;
}

// --------------------------------------------------------------- wire shape

/** One breakdown row. `cost` is USD; both cost fields are omitted when not informative. */
export interface WireRow {
  tokens: number;
  /** Omitted when no call in this row reported a price. */
  cost?: number;
  /** Present (true) only when some calls had no reported price, so `cost` is a floor. */
  costIsFloor?: true;
}

export type WireTaskStatus = "completed" | "failed" | "aborted" | "interrupted" | "running";

export interface UsageTotalsWire {
  /** Stable per desktop - lets a phone paired to two desktops keep their totals apart. */
  desktopId: string;
  lifetime: {
    tokens: number;
    /** USD. Omitted when no call ever reported a price. */
    cost?: number;
    /** True when some calls had no reported price: `cost` is then a floor ("$1.23+"). */
    costIsFloor: boolean;
    calls: number;
    tasks: number;
    since: string;
    byWorker: ({ worker: string } & WireRow)[];
    byModel: ({ model: string } & WireRow)[];
  };
  /** The most recent task that has ended. Omitted when there is none yet. */
  last?: {
    taskId: string;
    title?: string;
    status: WireTaskStatus;
    tokens: number;
    cost?: number;
    costIsFloor: boolean;
  };
}

const MAX_WIRE_WORKERS = 12;
const MAX_WIRE_MODELS = 10;

/** 4 places: a single task often costs well under a cent, and 2 would show it as $0.00. */
function roundCost(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function costFields(b: LedgerBucket): { cost?: number; floor: boolean } {
  const floor = b.calls > 0 && b.pricedCalls < b.calls;
  if (b.calls > 0 && b.pricedCalls === 0) return { floor };
  return { cost: roundCost(b.cost), floor };
}

function wireRow(b: LedgerBucket): WireRow {
  const { cost, floor } = costFields(b);
  return {
    tokens: b.total,
    ...(cost !== undefined ? { cost } : {}),
    ...(floor ? { costIsFloor: true as const } : {}),
  };
}

const STATUS_FOR_STATE: Record<LedgerTaskState, WireTaskStatus> = {
  done: "completed",
  failed: "failed",
  aborted: "aborted",
  interrupted: "interrupted",
  running: "running",
};

/** Small on purpose: it rides a sealed event on every pairing and task end. */
export function toUsageWire(file: LedgerFile): UsageTotalsWire {
  const byTokens = (a: [string, LedgerBucket], b: [string, LedgerBucket]) => b[1].total - a[1].total;
  const lt = costFields(file.totals);
  const lastTask = [...file.tasks]
    .filter((t) => t.state !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))[0];
  const lastCost = lastTask ? costFields(lastTask.usage) : undefined;
  return {
    desktopId: file.desktopId,
    lifetime: {
      tokens: file.totals.total,
      ...(lt.cost !== undefined ? { cost: lt.cost } : {}),
      costIsFloor: lt.floor,
      calls: file.totals.calls,
      tasks: file.taskCount,
      since: file.since,
      byWorker: Object.entries(file.byAgent)
        .sort(byTokens)
        .slice(0, MAX_WIRE_WORKERS)
        .map(([worker, b]) => ({ worker, ...wireRow(b) })),
      byModel: Object.entries(file.byModel)
        .sort(byTokens)
        .slice(0, MAX_WIRE_MODELS)
        .map(([model, b]) => ({ model, ...wireRow(b) })),
    },
    ...(lastTask && lastCost
      ? {
          last: {
            taskId: lastTask.taskId,
            ...(lastTask.title ? { title: lastTask.title } : {}),
            status: STATUS_FOR_STATE[lastTask.state],
            tokens: lastTask.usage.total,
            ...(lastCost.cost !== undefined ? { cost: lastCost.cost } : {}),
            costIsFloor: lastCost.floor,
          },
        }
      : {}),
  };
}

function overheadOf(task: LedgerTask): LedgerBucket {
  const o = cloneBucket(task.usage);
  for (const p of task.phases) {
    o.calls = Math.max(0, o.calls - p.usage.calls);
    o.prompt = Math.max(0, o.prompt - p.usage.prompt);
    o.completion = Math.max(0, o.completion - p.usage.completion);
    o.total = Math.max(0, o.total - p.usage.total);
    o.cost = Math.max(0, o.cost - p.usage.cost);
    o.pricedCalls = Math.max(0, o.pricedCalls - p.usage.pricedCalls);
  }
  return o;
}

// ----------------------------------------------------------- terminal view

function costText(b: LedgerBucket): string {
  if (b.pricedCalls === 0) return "";
  return `  ${formatCost(b.cost)}${b.pricedCalls < b.calls ? "+" : ""}`;
}

function row(label: string, b: LedgerBucket, width = 12): string {
  return `  ${label.padEnd(width)} ${String(b.calls).padStart(5)} calls  ${formatTokens(b.total).padStart(8)} tokens${costText(b)}`;
}

/** What `/usage` prints. `recentTasks` bounds the task section. */
export function renderLedger(file: LedgerFile, recentTasks = 5): string {
  const lines: string[] = [""];
  lines.push(`Usage on this desktop since ${file.since.slice(0, 10)}:`);
  if (file.totals.calls === 0) {
    lines.push("  Nothing recorded yet — totals start counting from the first model call.", "");
    return lines.join("\n");
  }
  lines.push(row("LIFETIME", file.totals));
  if (file.totals.pricedCalls > 0 && file.totals.pricedCalls < file.totals.calls) {
    lines.push(`  (cost is a floor: ${file.totals.calls - file.totals.pricedCalls} call(s) had no reported price)`);
  }

  const roles = Object.entries(file.byAgent).sort((a, b) => b[1].total - a[1].total);
  if (roles.length > 0) {
    lines.push("", "By worker:");
    for (const [role, b] of roles) lines.push(row(role.toUpperCase(), b));
  }

  const models = Object.entries(file.byModel).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  if (models.length > 0) {
    lines.push("", "Top models:");
    for (const [model, b] of models) lines.push(row(model.length > 34 ? `…${model.slice(-33)}` : model, b, 34));
  }

  const tasks = [...file.tasks].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(0, recentTasks));
  if (tasks.length > 0) {
    lines.push("", `Recent tasks (${tasks.length}):`);
    for (const t of tasks) {
      lines.push(`${row(t.state.toUpperCase(), t.usage, 12)}  ${t.repo ? `[${t.repo}] ` : ""}${t.startedAt.slice(0, 16).replace("T", " ")}`);
      for (const p of t.phases) {
        const mark = p.passed === true ? "✓" : p.passed === false ? "✗" : "…";
        lines.push(`    ${mark} ${p.name.slice(0, 40).padEnd(40)} ${formatTokens(p.usage.total).padStart(8)} tokens${costText(p.usage)}`);
      }
      const oh = overheadOf(t);
      if (oh.calls > 0 && t.phases.length > 0) {
        lines.push(`    · ${"discovery / planning / other".padEnd(40)} ${formatTokens(oh.total).padStart(8)} tokens${costText(oh)}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}
