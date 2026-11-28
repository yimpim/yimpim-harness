/**
 * Unit tests for `src/remote/historyDb.ts` (Phase 1 SQLite history storage):
 * - WAL journal mode & 5000ms busy_timeout PRAGMAs
 * - Normalized repo_root keying (trailing slashes, Windows case-insensitivity)
 * - One-time, non-destructive `.agent/remote_history/*.jsonl` + `tasks.index` import
 * - Cascade cleanup of evicted task events and orphaned between-segment events
 * - Clean `closeHistoryDb()` checkpoint and reopen persistence
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getHistoryDb,
  closeHistoryDb,
  normalizeRepoRoot,
  ensureRepoMigrated,
  appendHistoryEntryDb,
  enforceRetentionDb,
  readHistoryBacklogDb,
  listTasksDb,
  readTaskEventsDb,
  _resetHistoryDbForTesting,
} from "../src/remote/historyDb.js";

const tempDirs: string[] = [];
let dbDir: string;
let dbFile: string;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

before(async () => {
  dbDir = await makeTempDir("yimpim-historydb-store-");
  dbFile = path.join(dbDir, "test-history.db");
  _resetHistoryDbForTesting(dbFile);
});

after(async () => {
  _resetHistoryDbForTesting(undefined);
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("historyDb — PRAGMAs & lifecycle", () => {
  test("initializes SQLite with WAL mode and 5000ms busy_timeout", () => {
    const db = getHistoryDb();
    const journalMode = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
    const busyTimeout = db.prepare("PRAGMA busy_timeout;").get() as { timeout?: number };

    assert.equal(String(journalMode.journal_mode).toLowerCase(), "wal");
    assert.equal(busyTimeout.timeout, 5000);
  });

  test("closeHistoryDb checkpoints WAL and persists data across reopen", async () => {
    const repo = await makeTempDir("yimpim-historydb-reopen-");
    appendHistoryEntryDb(repo, "task.start", { taskId: "task-persist", prompt: "Persist me" }, "2026-01-01T00:00:00.000Z", "demo", 1000);
    appendHistoryEntryDb(repo, "task.end", { taskId: "task-persist", state: "done", tokensUsed: 42, costUsd: 0.01 }, "2026-01-01T00:00:05.000Z", "demo", 1000);

    closeHistoryDb();

    // Reopen the same DB file and verify rows survived cleanly.
    const { entries: tasks } = listTasksDb(repo, 10);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, "task-persist");
    assert.equal(tasks[0].tokensUsed, 42);

    const events = readHistoryBacklogDb(repo);
    assert.equal(events.length, 2);
  });
});

describe("historyDb — normalizeRepoRoot", () => {
  test("strips trailing slashes and normalizes case on Windows", async () => {
    const repo = await makeTempDir("yimpim-historydb-norm-");
    const withTrailing = `${repo}${path.sep}`;
    assert.equal(normalizeRepoRoot(withTrailing), normalizeRepoRoot(repo));

    if (process.platform === "win32") {
      const upper = repo.toUpperCase();
      const lower = repo.toLowerCase();
      assert.equal(normalizeRepoRoot(upper), normalizeRepoRoot(lower));

      appendHistoryEntryDb(upper, "task.start", { taskId: "t-case", prompt: "Case test" }, "2026-01-01T00:00:00.000Z", "demo", 1000);
      const { entries } = listTasksDb(lower, 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].taskId, "t-case");
    }
  });
});

describe("historyDb — one-time non-destructive JSONL import", () => {
  test("imports legacy .agent/remote_history/*.jsonl and tasks.index once without modifying or deleting files", async () => {
    const repo = await makeTempDir("yimpim-historydb-migrate-");
    const legacyDir = path.join(repo, ".agent", "remote_history");
    fsSync.mkdirSync(legacyDir, { recursive: true });

    const segFile = path.join(legacyDir, "task-legacy_1-2.jsonl");
    const segContent =
      [
        JSON.stringify({ eventId: 1, kind: "task.start", payload: { taskId: "task-legacy", prompt: "Legacy task", attachments: [] }, at: "2026-01-01T00:00:00.000Z" }),
        "corrupt non-json line should be skipped",
        JSON.stringify({ eventId: 2, kind: "task.end", payload: { taskId: "task-legacy", state: "done", tokensUsed: 123, costUsd: 0.05 }, at: "2026-01-01T00:00:10.000Z" }),
      ].join("\n") + "\n";
    fsSync.writeFileSync(segFile, segContent, "utf-8");

    const idxFile = path.join(legacyDir, "tasks.index");
    const idxContent =
      JSON.stringify({
        taskId: "task-legacy",
        repoName: "legacy-repo",
        title: "Legacy Goal",
        prompt: "Legacy task",
        state: "done",
        phaseCount: 3,
        tokensUsed: 123,
        costUsd: 0.05,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:10.000Z",
        firstEventId: 1,
        lastEventId: 2,
        attachments: [],
      }) + "\n";
    fsSync.writeFileSync(idxFile, idxContent, "utf-8");

    // First read triggers one-time import.
    const events1 = readHistoryBacklogDb(repo);
    assert.equal(events1.length, 2);
    assert.deepEqual(events1.map((e) => e.eventId), [1, 2]);

    const { entries: tasks } = listTasksDb(repo, 10);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Legacy Goal");
    assert.equal(tasks[0].phaseCount, 3);
    assert.equal(tasks[0].repoName, "legacy-repo");

    // Original files remain completely untouched on disk.
    assert.equal(fsSync.readFileSync(segFile, "utf-8"), segContent);
    assert.equal(fsSync.readFileSync(idxFile, "utf-8"), idxContent);

    // Re-calling ensureRepoMigrated or reopening DB does NOT duplicate imported rows.
    closeHistoryDb();
    ensureRepoMigrated(repo);
    const events2 = readHistoryBacklogDb(repo);
    assert.equal(events2.length, 2, "migration must be idempotent across restarts");
  });
});

describe("historyDb — cascade cleanup on retention eviction", () => {
  test("evicting old tasks removes their task rows, their event rows, and older orphaned between-events", async () => {
    const repo = await makeTempDir("yimpim-historydb-cascade-");

    // Between-event older than everything
    appendHistoryEntryDb(repo, "status", { state: "idle" }, "2026-01-01T00:00:00.000Z", undefined, 100);
    // Task 0
    appendHistoryEntryDb(repo, "task.start", { taskId: "t0", prompt: "p0" }, "2026-01-01T00:00:01.000Z", undefined, 100);
    appendHistoryEntryDb(repo, "worker.start", { taskId: "t0", workerId: "w0" }, "2026-01-01T00:00:02.000Z", undefined, 100);
    appendHistoryEntryDb(repo, "task.end", { taskId: "t0", state: "done" }, "2026-01-01T00:00:03.000Z", undefined, 100);
    // Between-event between t0 and t1
    appendHistoryEntryDb(repo, "advisor.start", { exchangeId: "a1", question: "q" }, "2026-01-01T00:00:04.000Z", undefined, 100);
    // Task 1
    appendHistoryEntryDb(repo, "task.start", { taskId: "t1", prompt: "p1" }, "2026-01-01T00:00:05.000Z", undefined, 100);
    appendHistoryEntryDb(repo, "task.end", { taskId: "t1", state: "done" }, "2026-01-01T00:00:06.000Z", undefined, 100);
    // Task 2
    appendHistoryEntryDb(repo, "task.start", { taskId: "t2", prompt: "p2" }, "2026-01-01T00:00:07.000Z", undefined, 100);
    appendHistoryEntryDb(repo, "task.end", { taskId: "t2", state: "done" }, "2026-01-01T00:00:08.000Z", undefined, 100);

    const evicted = enforceRetentionDb(repo, 2);
    assert.equal(evicted, 1);

    // t0 is gone from both tasks and events
    const t0Events = readTaskEventsDb(repo, "t0", 0, 100);
    assert.equal(t0Events.missing, true);

    const remainingTasks = listTasksDb(repo, 10).entries.map((t) => t.taskId);
    assert.deepEqual(remainingTasks, ["t2", "t1"]);

    // Both orphaned between-events (before t0 and between t0..t1) were cascade-deleted
    const remainingEvents = readHistoryBacklogDb(repo);
    assert.equal(remainingEvents.length, 4, "only t1 and t2 events (2 each) should remain");
    assert.ok(remainingEvents.every((e) => e.payload.taskId === "t1" || e.payload.taskId === "t2"));
  });
});
