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
import type { TaskIndexEntry } from "./protocol.js";

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
