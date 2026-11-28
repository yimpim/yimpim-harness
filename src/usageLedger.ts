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
import { DatabaseSync } from "node:sqlite";
import { formatCost, formatTokens } from "./events.js";
import { getHistoryDb } from "./remote/historyDb.js";

export interface LedgerBucket {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  /** Calls that reported a price; cost is exact only when this equals calls. */
  pricedCalls: number;
  /** Prompt tokens the provider served from its prompt cache, and the prompt tokens of the calls that reported it: the hit rate is cached / cachedOf. */
  cached: number;
  cachedOf: number;
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
  /** Prompt tokens served from the provider's cache; undefined when the route did not report it. */
  cached?: number;
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

const emptyBucket = (): LedgerBucket => ({ calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, pricedCalls: 0, cached: 0, cachedOf: 0 });

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
  dst.cached += src.cached;
  dst.cachedOf += src.cachedOf;
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
    cached: num(raw?.cached),
    cachedOf: num(raw?.cachedOf),
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
  private readonly useSharedHistoryDb: boolean;
  private readonly dbPath: string;
  private readonly legacyJsonPath: string;

  constructor(private readonly filePath?: string) {
    const envUsage = process.env.YIMPIM_USAGE_FILE?.trim();
    if (filePath !== undefined) {
      this.useSharedHistoryDb = false;
      this.legacyJsonPath = filePath;
      this.dbPath = filePath.endsWith(".db") || filePath.endsWith(".sqlite") ? filePath : `${filePath}.sqlite`;
    } else if (envUsage) {
      this.useSharedHistoryDb = false;
      this.legacyJsonPath = envUsage;
      this.dbPath = envUsage.endsWith(".db") || envUsage.endsWith(".sqlite") ? envUsage : `${envUsage}.sqlite`;
    } else {
      this.useSharedHistoryDb = true;
      this.legacyJsonPath = defaultLedgerPath();
      this.dbPath = "";
    }
  }

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
        cached: num(c.cached),
        cachedOf: typeof c.cached === "number" ? num(c.prompt) : 0,
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

  private ensureUsageSchema(db: DatabaseSync): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS usage_meta (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        desktop_id      TEXT NOT NULL,
        since           TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        task_count      INTEGER NOT NULL DEFAULT 0,
        totals_json     TEXT NOT NULL,
        legacy_imported INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_buckets (
        kind         TEXT NOT NULL,
        key          TEXT NOT NULL,
        calls        INTEGER NOT NULL DEFAULT 0,
        prompt       INTEGER NOT NULL DEFAULT 0,
        completion   INTEGER NOT NULL DEFAULT 0,
        total        INTEGER NOT NULL DEFAULT 0,
        cost         REAL NOT NULL DEFAULT 0,
        priced_calls INTEGER NOT NULL DEFAULT 0,
        cached       INTEGER NOT NULL DEFAULT 0,
        cached_of    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, key)
      );

      CREATE TABLE IF NOT EXISTS usage_tasks (
        task_id       TEXT PRIMARY KEY,
        repo          TEXT,
        title         TEXT,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        state         TEXT NOT NULL,
        pid           INTEGER,
        usage_json    TEXT NOT NULL,
        by_agent_json TEXT NOT NULL,
        phases_json   TEXT NOT NULL,
        seq_order     INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    if (this.useSharedHistoryDb) {
      const db = getHistoryDb();
      return fn(db);
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      this.ensureUsageSchema(db);
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {
        // Ignore close error.
      }
    }
  }

  private readLegacyJson(): LedgerFile | null {
    let text: string;
    try {
      text = fs.readFileSync(this.legacyJsonPath, "utf8");
    } catch {
      return null;
    }
    try {
      return coerceFile(JSON.parse(text));
    } catch {
      // Unreadable: keep the bytes for a human, start a new ledger. Never
      // silently overwrite something we could not parse.
      try {
        fs.renameSync(this.legacyJsonPath, `${this.legacyJsonPath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return null;
    }
  }

  private ensureMetaAndLegacyImportInTx(db: DatabaseSync): {
    desktopId: string;
    since: string;
    updatedAt: string;
    taskCount: number;
    totals: LedgerBucket;
  } {
    const row = db
      .prepare("SELECT desktop_id, since, updated_at, task_count, totals_json, legacy_imported FROM usage_meta WHERE id = 1")
      .get() as
      | {
          desktop_id: string;
          since: string;
          updated_at: string;
          task_count: number;
          totals_json: string;
          legacy_imported: number;
        }
      | undefined;

    if (row) {
      let totals = emptyBucket();
      try {
        totals = coerceBucket(JSON.parse(row.totals_json));
      } catch {
        totals = emptyBucket();
      }
      return {
        desktopId: row.desktop_id,
        since: row.since,
        updatedAt: row.updated_at,
        taskCount: num(row.task_count),
        totals,
      };
    }

    const legacy = this.readLegacyJson();
    const seed = legacy ?? freshFile();

    db.prepare(
      `INSERT INTO usage_meta (id, desktop_id, since, updated_at, task_count, totals_json, legacy_imported)
       VALUES (1, ?, ?, ?, ?, ?, 1)`
    ).run(seed.desktopId, seed.since, seed.updatedAt, seed.taskCount, JSON.stringify(seed.totals));

    if (legacy) {
      const upsertBucket = db.prepare(`
        INSERT INTO usage_buckets (kind, key, calls, prompt, completion, total, cost, priced_calls, cached, cached_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, key) DO UPDATE SET
          calls = calls + excluded.calls,
          prompt = prompt + excluded.prompt,
          completion = completion + excluded.completion,
          total = total + excluded.total,
          cost = cost + excluded.cost,
          priced_calls = priced_calls + excluded.priced_calls,
          cached = cached + excluded.cached,
          cached_of = cached_of + excluded.cached_of
      `);
      for (const [k, b] of Object.entries(legacy.byAgent)) {
        upsertBucket.run("agent", k, b.calls, b.prompt, b.completion, b.total, b.cost, b.pricedCalls, b.cached, b.cachedOf);
      }
      for (const [k, b] of Object.entries(legacy.byModel)) {
        upsertBucket.run("model", k, b.calls, b.prompt, b.completion, b.total, b.cost, b.pricedCalls, b.cached, b.cachedOf);
      }
      const upsertTask = db.prepare(`
        INSERT OR REPLACE INTO usage_tasks (task_id, repo, title, started_at, ended_at, state, pid, usage_json, by_agent_json, phases_json, seq_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      legacy.tasks.forEach((t, idx) => {
        upsertTask.run(
          t.taskId,
          t.repo ?? null,
          t.title ?? null,
          t.startedAt,
          t.endedAt ?? null,
          t.state,
          t.pid ?? null,
          JSON.stringify(t.usage),
          JSON.stringify(t.byAgent),
          JSON.stringify(t.phases),
          idx + 1
        );
      });
    }

    return {
      desktopId: seed.desktopId,
      since: seed.since,
      updatedAt: seed.updatedAt,
      taskCount: seed.taskCount,
      totals: cloneBucket(seed.totals),
    };
  }

  private readLedgerFileInTx(db: DatabaseSync): LedgerFile {
    const meta = this.ensureMetaAndLegacyImportInTx(db);
    const bucketRows = db
      .prepare("SELECT kind, key, calls, prompt, completion, total, cost, priced_calls, cached, cached_of FROM usage_buckets")
      .all() as Array<{
        kind: string;
        key: string;
        calls: number;
        prompt: number;
        completion: number;
        total: number;
        cost: number;
        priced_calls: number;
        cached: number;
        cached_of: number;
      }>;

    const byAgent: Record<string, LedgerBucket> = {};
    const byModel: Record<string, LedgerBucket> = {};
    for (const r of bucketRows) {
      const b: LedgerBucket = {
        calls: num(r.calls),
        prompt: num(r.prompt),
        completion: num(r.completion),
        total: num(r.total),
        cost: num(r.cost),
        pricedCalls: num(r.priced_calls),
        cached: num(r.cached),
        cachedOf: num(r.cached_of),
      };
      if (r.kind === "agent") byAgent[r.key] = b;
      else if (r.kind === "model") byModel[r.key] = b;
    }

    const taskRows = db
      .prepare(
        "SELECT task_id, repo, title, started_at, ended_at, state, pid, usage_json, by_agent_json, phases_json FROM usage_tasks ORDER BY seq_order ASC"
      )
      .all() as Array<{
        task_id: string;
        repo: string | null;
        title: string | null;
        started_at: string;
        ended_at: string | null;
        state: string;
        pid: number | null;
        usage_json: string;
        by_agent_json: string;
        phases_json: string;
      }>;

    const tasks: LedgerTask[] = [];
    for (const r of taskRows) {
      try {
        const coerced = coerceTask({
          taskId: r.task_id,
          repo: r.repo ?? undefined,
          title: r.title ?? undefined,
          startedAt: r.started_at,
          endedAt: r.ended_at ?? undefined,
          state: r.state,
          pid: r.pid ?? undefined,
          usage: JSON.parse(r.usage_json),
          byAgent: JSON.parse(r.by_agent_json),
          phases: JSON.parse(r.phases_json),
        });
        if (coerced) tasks.push(coerced);
      } catch {
        // Skip malformed row.
      }
    }

    return {
      v: 1,
      desktopId: meta.desktopId,
      since: meta.since,
      updatedAt: meta.updatedAt,
      totals: meta.totals,
      taskCount: meta.taskCount,
      byAgent,
      byModel,
      tasks,
    };
  }

  /** Atomically merge this process's pending deltas into SQLite WAL. Never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      const file = this.withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const meta = this.ensureMetaAndLegacyImportInTx(db);
          addInto(meta.totals, this.pending.totals);
          const nextTaskCount = meta.taskCount + this.pending.tasks;
          const nowIso = new Date().toISOString();

          db.prepare("UPDATE usage_meta SET totals_json = ?, task_count = ?, updated_at = ? WHERE id = 1").run(
            JSON.stringify(meta.totals),
            nextTaskCount,
            nowIso
          );

          const upsertBucket = db.prepare(`
            INSERT INTO usage_buckets (kind, key, calls, prompt, completion, total, cost, priced_calls, cached, cached_of)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, key) DO UPDATE SET
              calls = calls + excluded.calls,
              prompt = prompt + excluded.prompt,
              completion = completion + excluded.completion,
              total = total + excluded.total,
              cost = cost + excluded.cost,
              priced_calls = priced_calls + excluded.priced_calls,
              cached = cached + excluded.cached,
              cached_of = cached_of + excluded.cached_of
          `);
          for (const [k, b] of Object.entries(this.pending.byAgent)) {
            upsertBucket.run("agent", k, b.calls, b.prompt, b.completion, b.total, b.cost, b.pricedCalls, b.cached, b.cachedOf);
          }
          for (const [k, b] of Object.entries(this.pending.byModel)) {
            upsertBucket.run("model", k, b.calls, b.prompt, b.completion, b.total, b.cost, b.pricedCalls, b.cached, b.cachedOf);
          }

          let maxSeq = Number(
            (db.prepare("SELECT COALESCE(MAX(seq_order), 0) AS m FROM usage_tasks").get() as { m?: number } | undefined)?.m ?? 0
          );
          const getExistingSeq = db.prepare("SELECT seq_order FROM usage_tasks WHERE task_id = ?");
          const upsertTask = db.prepare(`
            INSERT INTO usage_tasks (task_id, repo, title, started_at, ended_at, state, pid, usage_json, by_agent_json, phases_json, seq_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
              repo = excluded.repo,
              title = excluded.title,
              started_at = excluded.started_at,
              ended_at = excluded.ended_at,
              state = excluded.state,
              pid = excluded.pid,
              usage_json = excluded.usage_json,
              by_agent_json = excluded.by_agent_json,
              phases_json = excluded.phases_json
          `);

          for (const t of this.owned.values()) {
            const existing = getExistingSeq.get(t.taskId) as { seq_order?: number } | undefined;
            const seq = typeof existing?.seq_order === "number" ? existing.seq_order : ++maxSeq;
            upsertTask.run(
              t.taskId,
              t.repo ?? null,
              t.title ?? null,
              t.startedAt,
              t.endedAt ?? null,
              t.state,
              t.pid ?? null,
              JSON.stringify(t.usage),
              JSON.stringify(t.byAgent),
              JSON.stringify(t.phases),
              seq
            );
          }

          // Reconcile running tasks whose owning process died.
          const runningRows = db
            .prepare("SELECT task_id, pid FROM usage_tasks WHERE state = 'running'")
            .all() as Array<{ task_id: string; pid: number | null }>;
          const markInterrupted = db.prepare("UPDATE usage_tasks SET state = 'interrupted', pid = NULL WHERE task_id = ?");
          for (const r of runningRows) {
            if (!this.owned.has(r.task_id) && (!r.pid || !pidAlive(r.pid))) {
              markInterrupted.run(r.task_id);
            }
          }

          // Evict oldest non-running tasks beyond MAX_TASKS (totals & taskCount never shrink).
          const totalTaskRows = Number(
            (db.prepare("SELECT COUNT(*) AS c FROM usage_tasks").get() as { c?: number } | undefined)?.c ?? 0
          );
          if (totalTaskRows > MAX_TASKS) {
            const excess = totalTaskRows - MAX_TASKS;
            const toDelete = db
              .prepare("SELECT task_id FROM usage_tasks WHERE state != 'running' ORDER BY seq_order ASC LIMIT ?")
              .all(excess) as Array<{ task_id: string }>;
            const del = db.prepare("DELETE FROM usage_tasks WHERE task_id = ?");
            for (const row of toDelete) {
              del.run(row.task_id);
            }
          }

          const snapshotFile = this.readLedgerFileInTx(db);
          db.exec("COMMIT");
          return snapshotFile;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Ignore rollback error.
          }
          throw err;
        }
      });

      // Only after the transaction committed: a failed write keeps the deltas for next time.
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
    if (this.lastFile) return this.lastFile;
    try {
      return this.withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const f = this.readLedgerFileInTx(db);
          db.exec("COMMIT");
          return f;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Ignore rollback error.
          }
          throw err;
        }
      });
    } catch {
      return freshFile();
    }
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
    o.cached = Math.max(0, o.cached - p.usage.cached);
    o.cachedOf = Math.max(0, o.cachedOf - p.usage.cachedOf);
  }
  return o;
}

// ----------------------------------------------------------- terminal view

function costText(b: LedgerBucket): string {
  if (b.pricedCalls === 0) return "";
  return `  ${formatCost(b.cost)}${b.pricedCalls < b.calls ? "+" : ""}`;
}

/** "  cache 42%": the share of prompt tokens served from the provider's cache, over the calls that reported it. Nothing when none did. */
export function cacheText(b: LedgerBucket): string {
  return b.cachedOf > 0 ? `  cache ${Math.round((100 * b.cached) / b.cachedOf)}%` : "";
}

function row(label: string, b: LedgerBucket, width = 12): string {
  return `  ${label.padEnd(width)} ${String(b.calls).padStart(5)} calls  ${formatTokens(b.total).padStart(8)} tokens${costText(b)}${cacheText(b)}`;
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
