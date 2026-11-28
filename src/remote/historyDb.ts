/**
 * SQLite-backed durable history store using Node's built-in `node:sqlite`
 * (`DatabaseSync`), WAL mode, and normalized per-repo partitioning.
 *
 * Zero external dependencies and zero native compilation: runs identically on
 * Windows, macOS, Linux, VMs, and Docker under Node 22+.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskIndexEntry, TaskSnapshotPhase, TaskSnapshotWire, TaskSnapshotWorker } from "./protocol.js";

export interface HistoryEntry {
  eventId?: number;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

const SEGMENT_FILENAME = /^(.+)_(\d+)-(open|\d+)\.jsonl$/;

/**
 * Normalize a repository root path for consistent SQLite keying across calls.
 * Strips trailing separators and lowercases on Windows so `C:\Repo` and
 * `c:\repo\` always map to the same partition.
 */
export function normalizeRepoRoot(repoRoot: string): string {
  const resolved = path.resolve(repoRoot).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function defaultDbPath(): string {
  if (process.env.YIMPIM_HISTORY_DB && process.env.YIMPIM_HISTORY_DB.trim()) {
    return path.resolve(process.env.YIMPIM_HISTORY_DB.trim());
  }
  return path.join(os.homedir(), ".yimpim", "yimpim.db");
}

let activeDb: DatabaseSync | null = null;
let activeDbPath: string | null = null;
let customDbPathForTesting: string | undefined;
let exitHookRegistered = false;
const migratedReposMemory = new Set<string>();
const openTaskIdByRepo = new Map<string, string | null>();
const openBetweenStartByRepo = new Map<string, number>();

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    closeHistoryDb();
  });
}

/** Checkpoint WAL and close the active SQLite connection cleanly. */
export function closeHistoryDb(): void {
  if (!activeDb) return;
  const db = activeDb;
  activeDb = null;
  activeDbPath = null;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Best-effort checkpoint on shutdown.
  }
  try {
    db.close();
  } catch {
    // Already closed.
  }
}

/**
 * Test-only seam to isolate SQLite tests against a temporary database file
 * without touching `~/.yimpim/yimpim.db`.
 */
export function _resetHistoryDbForTesting(dbPath?: string): void {
  closeHistoryDb();
  customDbPathForTesting = dbPath;
  migratedReposMemory.clear();
  openTaskIdByRepo.clear();
  openBetweenStartByRepo.clear();
}

export function getHistoryDbPath(): string {
  return customDbPathForTesting ?? defaultDbPath();
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tasks (
      repo_root        TEXT NOT NULL,
      task_id          TEXT NOT NULL,
      repo_name        TEXT,
      title            TEXT NOT NULL DEFAULT '',
      prompt           TEXT NOT NULL DEFAULT '',
      state            TEXT NOT NULL DEFAULT 'running',
      phase_count      INTEGER,
      tokens_used      INTEGER,
      cost_usd         REAL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      snapshot_json    TEXT,
      first_event_id   INTEGER NOT NULL,
      last_event_id    INTEGER,
      started_at       TEXT NOT NULL,
      ended_at         TEXT,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (repo_root, task_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      seq_order    INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root    TEXT NOT NULL,
      event_id     INTEGER,
      task_id      TEXT,
      kind         TEXT NOT NULL,
      at           TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migrated_repos (
      repo_root   TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_repo_seq ON events (repo_root, seq_order);
    CREATE INDEX IF NOT EXISTS idx_events_repo_event_id ON events (repo_root, event_id);
    CREATE INDEX IF NOT EXISTS idx_events_repo_task ON events (repo_root, task_id, seq_order);
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_first ON tasks (repo_root, first_event_id DESC);

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

export function getHistoryDb(): DatabaseSync {
  const targetPath = getHistoryDbPath();
  if (activeDb && activeDbPath === targetPath) {
    return activeDb;
  }
  closeHistoryDb();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new DatabaseSync(targetPath);
  initSchema(db);
  activeDb = db;
  activeDbPath = targetPath;
  registerExitHook();
  return db;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

function parseLegacyJsonlLine(line: string): HistoryEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed.kind === "string" &&
      typeof parsed.at === "string" &&
      parsed.payload &&
      typeof parsed.payload === "object"
    ) {
      return {
        ...(typeof parsed.eventId === "number" ? { eventId: parsed.eventId } : {}),
        kind: parsed.kind,
        payload: parsed.payload,
        at: parsed.at,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function legacyHistoryDir(rawRepoRoot: string): string {
  return path.join(rawRepoRoot, ".agent", "remote_history");
}

/**
 * One-time, non-destructive import of legacy `.agent/remote_history/*.jsonl`
 * and `tasks.index` files into SQLite for `repoRoot`. Never deletes or modifies
 * the original JSONL files on disk.
 */
export function ensureRepoMigrated(rawRepoRoot: string): string {
  const norm = normalizeRepoRoot(rawRepoRoot);
  const db = getHistoryDb();
  if (migratedReposMemory.has(norm)) {
    return norm;
  }

  const already = db.prepare("SELECT 1 FROM migrated_repos WHERE repo_root = ?").get(norm);
  if (already) {
    migratedReposMemory.add(norm);
    // Restore open-task tracking from DB on process restart.
    const openRow = db
      .prepare("SELECT task_id FROM tasks WHERE repo_root = ? AND last_event_id IS NULL ORDER BY first_event_id DESC LIMIT 1")
      .get(norm) as { task_id?: string } | undefined;
    openTaskIdByRepo.set(norm, openRow?.task_id ?? null);
    return norm;
  }

  const dir = legacyHistoryDir(rawRepoRoot);
  let filenames: string[] = [];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    // No legacy directory; mark migrated and return.
  }

  interface LegacySeg {
    filename: string;
    taskId?: string;
    firstEventId: number;
    lastEventId?: number;
  }
  const segments: LegacySeg[] = [];
  for (const filename of filenames) {
    const m = SEGMENT_FILENAME.exec(filename);
    if (!m) continue;
    const [, name, firstStr, lastRaw] = m;
    segments.push({
      filename,
      taskId: name === "between" ? undefined : name,
      firstEventId: Number(firstStr),
      lastEventId: lastRaw === "open" ? undefined : Number(lastRaw),
    });
  }
  segments.sort((a, b) => a.firstEventId - b.firstEventId);

  const indexEntries = new Map<string, TaskIndexEntry>();
  try {
    const rawIdx = fs.readFileSync(path.join(dir, "tasks.index"), "utf-8");
    for (const line of rawIdx.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.taskId === "string") {
          indexEntries.set(parsed.taskId, parsed as TaskIndexEntry);
        }
      } catch {
        // Skip corrupt index line.
      }
    }
  } catch {
    // No legacy tasks.index.
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (repo_root, event_id, task_id, kind, at, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const upsertTask = db.prepare(`
    INSERT INTO tasks (
      repo_root, task_id, repo_name, title, prompt, state, phase_count,
      tokens_used, cost_usd, attachments_json, first_event_id, last_event_id,
      started_at, ended_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_root, task_id) DO UPDATE SET
      repo_name = COALESCE(excluded.repo_name, tasks.repo_name),
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE tasks.title END,
      prompt = CASE WHEN excluded.prompt != '' THEN excluded.prompt ELSE tasks.prompt END,
      state = excluded.state,
      phase_count = COALESCE(excluded.phase_count, tasks.phase_count),
      tokens_used = COALESCE(excluded.tokens_used, tasks.tokens_used),
      cost_usd = COALESCE(excluded.cost_usd, tasks.cost_usd),
      last_event_id = COALESCE(excluded.last_event_id, tasks.last_event_id),
      ended_at = COALESCE(excluded.ended_at, tasks.ended_at),
      updated_at = excluded.updated_at
  `);

  let openTaskId: string | null = null;
  let openBetweenStart: number | undefined;
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const seg of segments) {
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(dir, seg.filename), "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      let firstAt = nowIso;
      let lastAt = nowIso;
      let segFirstId = seg.firstEventId;
      let segLastId = seg.lastEventId;
      let segTaskId = seg.taskId;
      let sawStart = false;
      let sawEnd = false;
      let startPrompt = "";
      let startAttachments: unknown[] = [];
      let planGoal = "";
      let phaseCount: number | null = null;
      let endState = seg.lastEventId === undefined ? "running" : "done";
      let tokensUsed: number | null = null;
      let costUsd: number | null = null;

      for (const line of lines) {
        const entry = parseLegacyJsonlLine(line);
        if (!entry) continue;
        if (!sawStart) {
          firstAt = entry.at;
          if (typeof entry.eventId === "number") segFirstId = entry.eventId;
        }
        lastAt = entry.at;
        if (typeof entry.eventId === "number" && seg.lastEventId !== undefined) {
          segLastId = Math.max(segLastId ?? entry.eventId, entry.eventId);
        }
        const payloadTaskId = typeof (entry.payload as any).taskId === "string" ? (entry.payload as any).taskId : undefined;
        if (entry.kind === "task.start") {
          sawStart = true;
          if (payloadTaskId) segTaskId = payloadTaskId;
          if (typeof (entry.payload as any).prompt === "string") startPrompt = firstLine((entry.payload as any).prompt);
          if (Array.isArray((entry.payload as any).attachments)) startAttachments = (entry.payload as any).attachments;
        } else if (entry.kind === "plan.ready") {
          if (typeof (entry.payload as any).goal === "string") planGoal = firstLine((entry.payload as any).goal);
          if (Array.isArray((entry.payload as any).phases)) phaseCount = (entry.payload as any).phases.length;
        } else if (entry.kind === "task.end") {
          sawEnd = true;
          const st = (entry.payload as any).state;
          endState = st === "failed" || st === "aborted" || st === "interrupted" ? st : "done";
          if (typeof (entry.payload as any).tokensUsed === "number") tokensUsed = (entry.payload as any).tokensUsed;
          if (typeof (entry.payload as any).costUsd === "number") costUsd = (entry.payload as any).costUsd;
          if (typeof entry.eventId === "number") segLastId = entry.eventId;
        }
        const effectiveTaskId = segTaskId ?? payloadTaskId ?? null;
        insertEvent.run(
          norm,
          entry.eventId ?? null,
          effectiveTaskId,
          entry.kind,
          entry.at,
          JSON.stringify(entry.payload)
        );
      }

      if (seg.taskId !== undefined) {
        const tid = segTaskId ?? seg.taskId;
        const idx = indexEntries.get(tid);
        const isClosed = seg.lastEventId !== undefined || sawEnd;
        upsertTask.run(
          norm,
          tid,
          idx?.repoName ?? null,
          idx?.title ?? (planGoal || startPrompt),
          idx?.prompt ?? startPrompt,
          idx?.state ?? endState,
          idx?.phaseCount ?? phaseCount,
          idx?.tokensUsed ?? tokensUsed,
          idx?.costUsd ?? costUsd,
          JSON.stringify(idx?.attachments ?? startAttachments),
          idx?.firstEventId ?? segFirstId,
          isClosed ? (idx?.lastEventId ?? segLastId ?? segFirstId) : null,
          idx?.startedAt ?? firstAt,
          isClosed ? (idx?.endedAt ?? lastAt) : null,
          lastAt
        );
        if (!isClosed) {
          openTaskId = tid;
        }
      } else if (seg.lastEventId === undefined) {
        openBetweenStart = seg.firstEventId;
      }
    }

    // Import any tasks.index rows that had no segment file imported yet.
    for (const [tid, idx] of indexEntries) {
      const exists = db.prepare("SELECT 1 FROM tasks WHERE repo_root = ? AND task_id = ?").get(norm, tid);
      if (!exists) {
        upsertTask.run(
          norm,
          tid,
          idx.repoName ?? null,
          idx.title ?? "",
          idx.prompt ?? "",
          idx.state ?? "done",
          idx.phaseCount ?? null,
          idx.tokensUsed ?? null,
          idx.costUsd ?? null,
          JSON.stringify(idx.attachments ?? []),
          idx.firstEventId ?? 0,
          idx.lastEventId ?? null,
          idx.startedAt ?? nowIso,
          idx.endedAt ?? null,
          idx.endedAt ?? idx.startedAt ?? nowIso
        );
      }
    }

    db.prepare("INSERT OR IGNORE INTO migrated_repos (repo_root, migrated_at) VALUES (?, ?)").run(norm, nowIso);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback error.
    }
    throw err;
  }

  migratedReposMemory.add(norm);
  openTaskIdByRepo.set(norm, openTaskId);
  if (openBetweenStart !== undefined) {
    openBetweenStartByRepo.set(norm, openBetweenStart);
  }
  return norm;
}

const SNAPSHOT_EVENT_KINDS = new Set([
  "task.start",
  "plan.ready",
  "phase.start",
  "phase.end",
  "worker.start",
  "worker.end",
  "task.end",
]);

function applyEventToSnapshot(
  current: TaskSnapshotWire | null,
  taskId: string,
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  repoName?: string
): TaskSnapshotWire {
  const base: TaskSnapshotWire = current
    ? { ...current, phases: current.phases.map((p) => ({ ...p, runs: [...p.runs] })) }
    : {
        taskId,
        ...(repoName ? { repoName } : {}),
        goal: "",
        prompt: "",
        state: "running",
        tokensUsed: 0,
        startedAt: at,
        endedAt: null,
        updatedAt: at,
        phases: [],
      };

  base.updatedAt = at;
  if (repoName && !base.repoName) base.repoName = repoName;

  if (kind === "task.start") {
    const prompt = typeof (payload as any).prompt === "string" ? firstLine((payload as any).prompt) : base.prompt;
    base.prompt = prompt;
    if (!base.goal) base.goal = prompt;
    base.state = "running";
    base.startedAt = at;
    base.endedAt = null;
    return base;
  }

  if (kind === "plan.ready") {
    const goal = typeof (payload as any).goal === "string" ? firstLine((payload as any).goal) : "";
    if (goal) base.goal = goal;
    const planned = Array.isArray((payload as any).phases) ? (payload as any).phases : [];
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i] as Record<string, unknown>;
      const pid = typeof p.id === "string" && p.id ? p.id : `phase-${i + 1}`;
      const existing = base.phases.find((x) => x.id === pid);
      if (existing) {
        if (typeof p.name === "string" && p.name) existing.name = p.name;
        if (typeof p.goal === "string" && p.goal) existing.goal = p.goal;
        if (typeof p.executor === "string" && p.executor) existing.executor = p.executor;
      } else {
        base.phases.push({
          id: pid,
          name: typeof p.name === "string" && p.name ? p.name : `Phase ${i + 1}`,
          ...(typeof p.goal === "string" && p.goal ? { goal: p.goal } : {}),
          status: "PENDING",
          index: i,
          ...(typeof p.executor === "string" && p.executor ? { executor: p.executor } : {}),
          runs: [],
        });
      }
    }
    return base;
  }

  if (kind === "phase.start") {
    const pid = typeof (payload as any).phaseId === "string" && (payload as any).phaseId ? (payload as any).phaseId : "phase-0";
    const name = typeof (payload as any).name === "string" && (payload as any).name ? (payload as any).name : pid;
    const goal = typeof (payload as any).goal === "string" ? (payload as any).goal : undefined;
    const index = typeof (payload as any).index === "number" ? (payload as any).index : undefined;
    const executor = typeof (payload as any).executor === "string" ? (payload as any).executor : undefined;
    const existing = base.phases.find((x) => x.id === pid);
    if (existing) {
      existing.name = name;
      existing.status = "IN_PROGRESS";
      if (goal !== undefined) existing.goal = goal;
      if (index !== undefined) existing.index = index;
      if (executor !== undefined) existing.executor = executor;
    } else {
      base.phases.push({
        id: pid,
        name,
        ...(goal !== undefined ? { goal } : {}),
        status: "IN_PROGRESS",
        ...(index !== undefined ? { index } : {}),
        ...(executor !== undefined ? { executor } : {}),
        runs: [],
      });
    }
    return base;
  }

  if (kind === "phase.end") {
    const pid = typeof (payload as any).phaseId === "string" && (payload as any).phaseId ? (payload as any).phaseId : "phase-0";
    const name = typeof (payload as any).name === "string" && (payload as any).name ? (payload as any).name : pid;
    const passed = (payload as any).passed !== false;
    const existing = base.phases.find((x) => x.id === pid);
    if (existing) {
      existing.status = passed ? "COMPLETED" : "ABORTED";
    } else {
      base.phases.push({
        id: pid,
        name,
        status: passed ? "COMPLETED" : "ABORTED",
        runs: [],
      });
    }
    return base;
  }

  if (kind === "worker.start") {
    const agent = typeof (payload as any).agent === "string" ? (payload as any).agent : "WORKER";
    const workerId = typeof (payload as any).workerId === "string" ? (payload as any).workerId : undefined;
    const rawPhaseId =
      typeof (payload as any).parentPhaseId === "string" && (payload as any).parentPhaseId
        ? (payload as any).parentPhaseId
        : typeof (payload as any).phaseId === "string" && (payload as any).phaseId
          ? (payload as any).phaseId
          : undefined;
    const rawPhaseName = typeof (payload as any).phaseName === "string" && (payload as any).phaseName ? (payload as any).phaseName : undefined;

    const isDiscoveryOrPlanning =
      !rawPhaseId &&
      (agent.toUpperCase() === "DISCOVERY" ||
        agent.toUpperCase() === "PLANNER" ||
        agent.toUpperCase() === "TESTABILITY_PLANNER" ||
        (payload as any).stage === "planning");

    const targetPhaseId = rawPhaseId ?? (isDiscoveryOrPlanning ? "discover-plan" : base.phases[base.phases.length - 1]?.id ?? "discover-plan");
    let phase: TaskSnapshotPhase | undefined = base.phases.find((x) => x.id === targetPhaseId);
    if (!phase) {
      phase = {
        id: targetPhaseId,
        name: rawPhaseName ?? (targetPhaseId === "discover-plan" ? "Discover & Plan" : targetPhaseId),
        status: "IN_PROGRESS",
        runs: [],
      };
      base.phases.push(phase);
    } else if (phase.status === "PENDING") {
      phase.status = "IN_PROGRESS";
    }

    const worker: TaskSnapshotWorker = {
      ...(workerId ? { workerId } : {}),
      agent,
      phaseId: targetPhaseId,
      ...(rawPhaseName ? { phaseName: rawPhaseName } : {}),
      startedAt: at,
    };
    phase.runs.push(worker);
    return base;
  }

  if (kind === "worker.end") {
    const agent = typeof (payload as any).agent === "string" ? (payload as any).agent : "WORKER";
    const workerId = typeof (payload as any).workerId === "string" ? (payload as any).workerId : undefined;
    let target: TaskSnapshotWorker | undefined;
    for (let i = base.phases.length - 1; i >= 0 && !target; i--) {
      const runs = base.phases[i].runs;
      for (let j = runs.length - 1; j >= 0; j--) {
        const r = runs[j];
        if (workerId && r.workerId === workerId) {
          target = r;
          break;
        }
        if (!workerId && !r.endedAt && r.agent === agent) {
          target = r;
          break;
        }
      }
    }
    if (!target) {
      let phase = base.phases[base.phases.length - 1];
      if (!phase) {
        phase = { id: "discover-plan", name: "Discover & Plan", status: "IN_PROGRESS", runs: [] };
        base.phases.push(phase);
      }
      target = { ...(workerId ? { workerId } : {}), agent, phaseId: phase.id };
      phase.runs.push(target);
    }
    if (typeof (payload as any).outcome === "string") target.outcome = (payload as any).outcome;
    if (typeof (payload as any).tokensUsed === "number") target.tokensUsed = (payload as any).tokensUsed;
    if (typeof (payload as any).costUsd === "number") target.costUsd = (payload as any).costUsd;
    if (typeof (payload as any).elapsedMs === "number") target.elapsedMs = (payload as any).elapsedMs;
    if (typeof (payload as any).summary === "string") target.summary = (payload as any).summary;
    if (typeof (payload as any).safeCount === "number") target.safeCount = (payload as any).safeCount;
    if (typeof (payload as any).totalJudges === "number") target.totalJudges = (payload as any).totalJudges;
    target.endedAt = at;
    return base;
  }

  if (kind === "task.end") {
    const rawState = (payload as any).state;
    const finalState: TaskSnapshotWire["state"] =
      rawState === "failed" || rawState === "aborted" || rawState === "interrupted" ? rawState : "done";
    base.state = finalState;
    base.endedAt = at;
    if (typeof (payload as any).tokensUsed === "number") base.tokensUsed = (payload as any).tokensUsed;
    else if (typeof (payload as any).tokens === "number") base.tokensUsed = (payload as any).tokens;
    if (typeof (payload as any).costUsd === "number") base.costUsd = (payload as any).costUsd;
    else if (typeof (payload as any).cost === "number") base.costUsd = (payload as any).cost;

    const closedPhaseStatus = finalState === "done" ? "COMPLETED" : "ABORTED";
    const defaultWorkerOutcome = finalState === "done" ? "completed" : finalState;
    for (const p of base.phases) {
      if (p.status === "IN_PROGRESS") {
        p.status = closedPhaseStatus;
      }
      for (const r of p.runs) {
        if (!r.endedAt) {
          r.endedAt = at;
          if (!r.outcome) r.outcome = defaultWorkerOutcome;
        }
      }
    }
    return base;
  }

  return base;
}

function updateTaskSnapshotInTx(
  db: DatabaseSync,
  norm: string,
  taskId: string,
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  repoName?: string
): void {
  if (!SNAPSHOT_EVENT_KINDS.has(kind)) return;
  const row = db
    .prepare("SELECT snapshot_json, repo_name FROM tasks WHERE repo_root = ? AND task_id = ?")
    .get(norm, taskId) as { snapshot_json?: string | null; repo_name?: string | null } | undefined;
  if (!row) return;

  let existing: TaskSnapshotWire | null = null;
  if (typeof row.snapshot_json === "string" && row.snapshot_json.length > 0) {
    try {
      existing = JSON.parse(row.snapshot_json) as TaskSnapshotWire;
    } catch {
      existing = null;
    }
  }
  const updated = applyEventToSnapshot(existing, taskId, kind, payload, at, repoName ?? row.repo_name ?? undefined);
  db.prepare("UPDATE tasks SET snapshot_json = ?, updated_at = ? WHERE repo_root = ? AND task_id = ?").run(
    JSON.stringify(updated),
    at,
    norm,
    taskId
  );
}

function nextEventIdForRepo(db: DatabaseSync, normRepoRoot: string): number {
  const row = db
    .prepare("SELECT MAX(event_id) AS max_id FROM events WHERE repo_root = ? AND event_id IS NOT NULL")
    .get(normRepoRoot) as { max_id?: number | null } | undefined;
  const maxId = typeof row?.max_id === "number" ? row.max_id : 0;
  return maxId + 1;
}

export function appendHistoryEntryDb(
  repoRoot: string,
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  repoName: string | undefined,
  retentionCap: number
): number {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();

  let assignedEventId = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    assignedEventId = nextEventIdForRepo(db, norm);
    const payloadTaskId = typeof (payload as any).taskId === "string" ? (payload as any).taskId : undefined;

    if (kind === "task.start") {
      const taskId = payloadTaskId ?? "unknown";
      openBetweenStartByRepo.delete(norm);
      openTaskIdByRepo.set(norm, taskId);

      db.prepare("INSERT INTO events (repo_root, event_id, task_id, kind, at, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(norm, assignedEventId, taskId, kind, at, JSON.stringify(payload));

      const prompt = typeof (payload as any).prompt === "string" ? firstLine((payload as any).prompt) : "";
      const attachments = Array.isArray((payload as any).attachments) ? (payload as any).attachments : [];
      db.prepare(`
        INSERT INTO tasks (
          repo_root, task_id, repo_name, title, prompt, state, attachments_json,
          first_event_id, last_event_id, started_at, ended_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?, NULL, ?)
        ON CONFLICT(repo_root, task_id) DO UPDATE SET
          repo_name = excluded.repo_name,
          title = excluded.title,
          prompt = excluded.prompt,
          state = 'running',
          attachments_json = excluded.attachments_json,
          first_event_id = excluded.first_event_id,
          last_event_id = NULL,
          started_at = excluded.started_at,
          ended_at = NULL,
          updated_at = excluded.updated_at
      `).run(norm, taskId, repoName ?? null, prompt, prompt, JSON.stringify(attachments), assignedEventId, at, at);
      updateTaskSnapshotInTx(db, norm, taskId, kind, payload, at, repoName);
    } else {
      const currentOpenTask = openTaskIdByRepo.get(norm) ?? null;
      const effectiveTaskId = currentOpenTask ?? (kind === "task.end" ? (payloadTaskId ?? null) : null);
      if (effectiveTaskId === null && !openBetweenStartByRepo.has(norm)) {
        openBetweenStartByRepo.set(norm, assignedEventId);
      }

      db.prepare("INSERT INTO events (repo_root, event_id, task_id, kind, at, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(norm, assignedEventId, effectiveTaskId, kind, at, JSON.stringify(payload));

      if (kind === "plan.ready" && payloadTaskId) {
        const goal = typeof (payload as any).goal === "string" ? firstLine((payload as any).goal) : null;
        const phaseCount = Array.isArray((payload as any).phases) ? (payload as any).phases.length : null;
        db.prepare(`
          UPDATE tasks
          SET title = COALESCE(?, title),
              phase_count = COALESCE(?, phase_count),
              updated_at = ?
          WHERE repo_root = ? AND task_id = ?
        `).run(goal && goal.length > 0 ? goal : null, phaseCount, at, norm, payloadTaskId);
      } else if (kind === "task.end") {
        const tid = payloadTaskId ?? currentOpenTask;
        if (tid) {
          const rawState = (payload as any).state;
          const finalState =
            rawState === "failed" || rawState === "aborted" || rawState === "interrupted" ? rawState : "done";
          const tokensUsed = typeof (payload as any).tokensUsed === "number" ? (payload as any).tokensUsed : null;
          const costUsd = typeof (payload as any).costUsd === "number" ? (payload as any).costUsd : null;
          db.prepare(`
            UPDATE tasks
            SET state = ?,
                ended_at = ?,
                tokens_used = COALESCE(?, tokens_used),
                cost_usd = COALESCE(?, cost_usd),
                last_event_id = ?,
                updated_at = ?
            WHERE repo_root = ? AND task_id = ?
          `).run(finalState, at, tokensUsed, costUsd, assignedEventId, at, norm, tid);
        }
        openTaskIdByRepo.set(norm, null);
      }

      const snapshotTaskId = payloadTaskId ?? effectiveTaskId;
      if (snapshotTaskId && SNAPSHOT_EVENT_KINDS.has(kind)) {
        updateTaskSnapshotInTx(db, norm, snapshotTaskId, kind, payload, at, repoName);
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback error.
    }
    throw err;
  }

  if (kind === "task.end") {
    enforceRetentionDb(repoRoot, retentionCap);
  }

  return assignedEventId;
}

/**
 * Evict closed tasks beyond `cap` (keeping the newest `cap` by `first_event_id`)
 * and cascade-delete all events belonging to evicted tasks as well as any
 * preceding orphaned between-segment events. Never evicts an open task or an
 * active open between-segment.
 */
export function enforceRetentionDb(repoRoot: string, cap: number): number {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const openBetweenStart = openBetweenStartByRepo.get(norm);

  db.exec("BEGIN IMMEDIATE");
  let evictedCount = 0;
  try {
    const closedTasks = db
      .prepare(
        "SELECT task_id, first_event_id FROM tasks WHERE repo_root = ? AND last_event_id IS NOT NULL ORDER BY first_event_id DESC"
      )
      .all(norm) as Array<{ task_id: string; first_event_id: number }>;

    if (closedTasks.length <= cap) {
      db.exec("COMMIT");
      return 0;
    }

    const oldestRetainedFirstEventId = closedTasks[cap - 1].first_event_id;
    const evicted = closedTasks.filter((t) => t.first_event_id < oldestRetainedFirstEventId);
    evictedCount = evicted.length;

    const delTask = db.prepare("DELETE FROM tasks WHERE repo_root = ? AND task_id = ?");
    const delTaskEvents = db.prepare("DELETE FROM events WHERE repo_root = ? AND task_id = ?");
    for (const t of evicted) {
      delTaskEvents.run(norm, t.task_id);
      delTask.run(norm, t.task_id);
    }

    // Cascade-clean orphaned between-segment events strictly older than the
    // oldest retained task, unless a still-open between-segment owns them.
    if (openBetweenStart !== undefined) {
      db.prepare(
        "DELETE FROM events WHERE repo_root = ? AND task_id IS NULL AND event_id IS NOT NULL AND event_id < ? AND event_id < ?"
      ).run(norm, oldestRetainedFirstEventId, openBetweenStart);
    } else {
      db.prepare(
        "DELETE FROM events WHERE repo_root = ? AND task_id IS NULL AND event_id IS NOT NULL AND event_id < ?"
      ).run(norm, oldestRetainedFirstEventId);
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback error.
    }
    throw err;
  }
  return evictedCount;
}

function rowToHistoryEntry(row: { event_id: number | null; kind: string; at: string; payload_json: string }): HistoryEntry | undefined {
  try {
    const payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== "object") return undefined;
    return {
      ...(typeof row.event_id === "number" ? { eventId: row.event_id } : {}),
      kind: row.kind,
      payload,
      at: row.at,
    };
  } catch {
    return undefined;
  }
}

export function readHistoryBacklogDb(repoRoot: string): HistoryEntry[] {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const rows = db
    .prepare("SELECT event_id, kind, at, payload_json FROM events WHERE repo_root = ? ORDER BY seq_order ASC")
    .all(norm) as Array<{ event_id: number | null; kind: string; at: string; payload_json: string }>;
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const e = rowToHistoryEntry(r);
    if (e) out.push(e);
  }
  return out;
}

export function readFromNewestTaskDb(repoRoot: string): HistoryEntry[] {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const newestTask = db
    .prepare("SELECT first_event_id FROM tasks WHERE repo_root = ? ORDER BY first_event_id DESC LIMIT 1")
    .get(norm) as { first_event_id?: number } | undefined;

  if (!newestTask || typeof newestTask.first_event_id !== "number") {
    return readHistoryBacklogDb(repoRoot);
  }
  const rows = db
    .prepare(
      "SELECT event_id, kind, at, payload_json FROM events WHERE repo_root = ? AND event_id >= ? ORDER BY seq_order ASC"
    )
    .all(norm, newestTask.first_event_id) as Array<{ event_id: number | null; kind: string; at: string; payload_json: string }>;
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const e = rowToHistoryEntry(r);
    if (e) out.push(e);
  }
  return out;
}

export function readHistoryBacklogSinceDb(
  repoRoot: string,
  afterIso: string,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const rows = db
    .prepare(
      "SELECT event_id, kind, at, payload_json FROM events WHERE repo_root = ? AND at > ? ORDER BY seq_order ASC LIMIT ?"
    )
    .all(norm, afterIso, limit + 1) as Array<{ event_id: number | null; kind: string; at: string; payload_json: string }>;
  const truncated = rows.length > limit;
  const slice = truncated ? rows.slice(0, limit) : rows;
  const entries = slice.map(rowToHistoryEntry).filter((e): e is HistoryEntry => e !== undefined);
  return { entries, truncated };
}

export function readHistoryBacklogSinceEventIdDb(
  repoRoot: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const rows = db
    .prepare(
      "SELECT event_id, kind, at, payload_json FROM events WHERE repo_root = ? AND event_id IS NOT NULL AND event_id > ? ORDER BY event_id ASC LIMIT ?"
    )
    .all(norm, afterEventId, limit + 1) as Array<{ event_id: number | null; kind: string; at: string; payload_json: string }>;
  const truncated = rows.length > limit;
  const slice = truncated ? rows.slice(0, limit) : rows;
  const entries = slice.map(rowToHistoryEntry).filter((e): e is HistoryEntry => e !== undefined);
  return { entries, truncated };
}

export function listTasksDb(
  repoRoot: string,
  limit: number,
  beforeTaskId?: string
): { entries: TaskIndexEntry[]; hasMore: boolean } {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const rows = db
    .prepare(
      `SELECT task_id, repo_name, title, prompt, state, phase_count, tokens_used, cost_usd,
              attachments_json, first_event_id, last_event_id, started_at, ended_at
       FROM tasks
       WHERE repo_root = ?
       ORDER BY first_event_id DESC`
    )
    .all(norm) as Array<{
      task_id: string;
      repo_name: string | null;
      title: string;
      prompt: string;
      state: string;
      phase_count: number | null;
      tokens_used: number | null;
      cost_usd: number | null;
      attachments_json: string;
      first_event_id: number;
      last_event_id: number | null;
      started_at: string;
      ended_at: string | null;
    }>;

  const all: TaskIndexEntry[] = rows.map((r) => {
    let attachments: string[] = [];
    try {
      const parsed = JSON.parse(r.attachments_json);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      attachments = [];
    }
    const entry: TaskIndexEntry = {
      taskId: r.task_id,
      ...(r.repo_name ? { repoName: r.repo_name } : {}),
      title: r.title,
      prompt: r.prompt,
      state: r.state as TaskIndexEntry["state"],
      startedAt: r.started_at,
      endedAt: r.ended_at,
      firstEventId: r.first_event_id,
      lastEventId: r.last_event_id,
      attachments,
    };
    if (typeof r.phase_count === "number") entry.phaseCount = r.phase_count;
    if (typeof r.tokens_used === "number") entry.tokensUsed = r.tokens_used;
    if (typeof r.cost_usd === "number") entry.costUsd = r.cost_usd;
    return entry;
  });

  let start = 0;
  if (beforeTaskId !== undefined) {
    const idx = all.findIndex((e) => e.taskId === beforeTaskId);
    start = idx >= 0 ? idx + 1 : all.length;
  }
  const page = all.slice(start, start + limit);
  const hasMore = start + page.length < all.length;
  return { entries: page, hasMore };
}

export function readTaskEventsDb(
  repoRoot: string,
  taskId: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean; missing: boolean } {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const taskExists = db
    .prepare("SELECT 1 FROM tasks WHERE repo_root = ? AND task_id = ?")
    .get(norm, taskId);
  if (!taskExists) {
    return { entries: [], truncated: false, missing: true };
  }
  const rows = db
    .prepare(
      "SELECT event_id, kind, at, payload_json FROM events WHERE repo_root = ? AND task_id = ? AND event_id IS NOT NULL AND event_id > ? ORDER BY event_id ASC LIMIT ?"
    )
    .all(norm, taskId, afterEventId, limit + 1) as Array<{ event_id: number | null; kind: string; at: string; payload_json: string }>;
  const truncated = rows.length > limit;
  const slice = truncated ? rows.slice(0, limit) : rows;
  const entries = slice.map(rowToHistoryEntry).filter((e): e is HistoryEntry => e !== undefined);
  return { entries, truncated, missing: false };
}

export function readTaskSnapshotDb(repoRoot: string, taskId: string): TaskSnapshotWire | null {
  const norm = ensureRepoMigrated(repoRoot);
  const db = getHistoryDb();
  const row = db
    .prepare(
      `SELECT task_id, repo_name, title, prompt, state, tokens_used, cost_usd,
              snapshot_json, started_at, ended_at, updated_at
       FROM tasks
       WHERE repo_root = ? AND task_id = ?`
    )
    .get(norm, taskId) as
    | {
        task_id: string;
        repo_name: string | null;
        title: string;
        prompt: string;
        state: string;
        tokens_used: number | null;
        cost_usd: number | null;
        snapshot_json: string | null;
        started_at: string;
        ended_at: string | null;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;

  if (typeof row.snapshot_json === "string" && row.snapshot_json.length > 0) {
    try {
      return JSON.parse(row.snapshot_json) as TaskSnapshotWire;
    } catch {
      // Fall through to rebuild from events.
    }
  }

  // Lazy backfill for legacy imported tasks that predate Phase 2 snapshot_json.
  let snapshot: TaskSnapshotWire = {
    taskId: row.task_id,
    ...(row.repo_name ? { repoName: row.repo_name } : {}),
    goal: row.title || row.prompt,
    prompt: row.prompt,
    state: (row.state === "running" || row.state === "failed" || row.state === "aborted" || row.state === "interrupted"
      ? row.state
      : "done") as TaskSnapshotWire["state"],
    tokensUsed: typeof row.tokens_used === "number" ? row.tokens_used : 0,
    ...(typeof row.cost_usd === "number" ? { costUsd: row.cost_usd } : {}),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    phases: [],
  };

  const events = db
    .prepare("SELECT kind, at, payload_json FROM events WHERE repo_root = ? AND task_id = ? ORDER BY seq_order ASC")
    .all(norm, taskId) as Array<{ kind: string; at: string; payload_json: string }>;

  for (const ev of events) {
    if (!SNAPSHOT_EVENT_KINDS.has(ev.kind)) continue;
    try {
      const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
      snapshot = applyEventToSnapshot(snapshot, taskId, ev.kind, payload, ev.at, row.repo_name ?? undefined);
    } catch {
      // Skip malformed payload.
    }
  }

  if (row.title && !snapshot.goal) snapshot.goal = row.title;
  if (typeof row.tokens_used === "number" && snapshot.tokensUsed === 0) snapshot.tokensUsed = row.tokens_used;
  if (typeof row.cost_usd === "number" && snapshot.costUsd === undefined) snapshot.costUsd = row.cost_usd;

  try {
    db.prepare("UPDATE tasks SET snapshot_json = ? WHERE repo_root = ? AND task_id = ?").run(
      JSON.stringify(snapshot),
      norm,
      taskId
    );
  } catch {
    // Best-effort cache backfill.
  }

  return snapshot;
}

export function reconcileInterruptedTaskDb(repoRoot: string, retentionCap: number): void {
  const norm = ensureRepoMigrated(repoRoot);
  const openTaskId = openTaskIdByRepo.get(norm);
  if (openTaskId) {
    appendHistoryEntryDb(
      repoRoot,
      "task.end",
      { taskId: openTaskId, state: "interrupted" },
      new Date().toISOString(),
      undefined,
      retentionCap
    );
  }
  enforceRetentionDb(repoRoot, retentionCap);
}
