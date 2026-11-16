/**
 * Regression tests for the durable desktop-side history log (historyLog.ts):
 * a freshly-paired session (see connectRemote in index.ts) replays this
 * backlog through the exact same push() path a live event uses, so it needs
 * to survive round-tripping in order, skip redacted kinds the same way the
 * live stream already does, and tolerate a corrupt line rather than failing
 * the whole read.
 *
 * Storage is one file per task (plus one per idle "between" segment, for
 * everything that happens outside any task) under `.agent/remote_history/`,
 * named `<taskId>_<firstEventId>-<lastEventId>.jsonl` (or
 * `between_<firstEventId>-<lastEventId>.jsonl`) once closed,
 * `..._<firstEventId>-open.jsonl` while still active — see historyLog.ts's
 * own top-of-file comment for why (a single ever-growing file eventually has
 * to trim, which means permanently losing early history; per-task files
 * never need to). eventId itself stays ONE counter for the whole repo,
 * continuing across every file — a filename's range only ever records
 * where that segment landed, never a per-file restart.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendHistoryEntry,
  readHistoryBacklog,
  readHistoryBacklogForReplay,
  readHistoryBacklogSince,
  readHistoryBacklogSinceEventId,
  readTaskEvents,
  listTasks,
  reconcileInterruptedTask,
  _setMaxRetainedTasksForTesting,
} from "../src/remote/historyLog.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-historylog-test-"));
  tempDirs.push(dir);
  return dir;
}

function historyDir(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "remote_history");
}

/** Writes a CLOSED segment file directly — simulates history that already
 *  existed on disk before this process started. */
function writeClosedSegment(repoRoot: string, name: string, firstEventId: number, lastEventId: number, entries: unknown[]): void {
  const dir = historyDir(repoRoot);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, `${name}_${firstEventId}-${lastEventId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** Writes a STILL-OPEN segment file directly — simulates a task (or between)
 *  that was active when a prior process ended, never yet finalized. */
function writeOpenSegment(repoRoot: string, name: string, firstEventId: number, entries: unknown[]): void {
  const dir = historyDir(repoRoot);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, `${name}_${firstEventId}-open.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** The one segment file currently open for this repo — there's always
 *  exactly one once anything has been appended. */
function findOpenSegmentFile(repoRoot: string): string {
  const dir = historyDir(repoRoot);
  const open = fsSync.readdirSync(dir).find((f) => f.endsWith("-open.jsonl"));
  if (!open) throw new Error(`no open segment found in ${dir}`);
  return path.join(dir, open);
}

/** Reads tasks.index directly, for assertions that want the raw lines rather
 *  than going through listTasks's own paging/newest-first behavior. */
function readRawTaskIndex(repoRoot: string): any[] {
  let raw: string;
  try {
    raw = fsSync.readFileSync(path.join(historyDir(repoRoot), "tasks.index"), "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("readHistoryBacklog", () => {
  test("returns [] when no history file exists yet", async () => {
    const repoRoot = await makeTempRepo();
    assert.deepEqual(readHistoryBacklog(repoRoot), []);
  });

  test("round-trips appended entries in order, each carrying the eventId it was assigned", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "worker.end", { agent: "EDITOR", outcome: "passed" }, "2026-01-01T00:00:05.000Z", false);

    const entries = readHistoryBacklog(repoRoot);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      eventId: 1,
      kind: "worker.start",
      payload: { agent: "EDITOR" },
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(entries[1], {
      eventId: 2,
      kind: "worker.end",
      payload: { agent: "EDITOR", outcome: "passed" },
      at: "2026-01-01T00:00:05.000Z",
    });
  });

  // DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 2: "eventId strictly
  // increases across the whole durable log, including across desktop restarts.
  // Test: write, restart, write -> no reuse, no gap reset." allocateEventId's
  // in-memory counter is scoped per-repoRoot and seeded lazily on first use --
  // writing the "pre-restart" entries directly to disk (bypassing
  // appendHistoryEntry, so this process's in-memory map is never seeded for
  // this repoRoot) and only THEN calling appendHistoryEntry simulates exactly
  // what a real restart looks like: a fresh process, with no in-memory state
  // at all, whose first-ever append for this repo must still continue from
  // whatever the file already holds.
  test("eventId continues from the highest value on disk after a simulated restart — no reuse, no gap", async () => {
    const repoRoot = await makeTempRepo();
    const preRestart = [
      { eventId: 1, kind: "task.start", payload: { taskId: "task-1" }, at: "2026-01-01T00:00:00.000Z" },
      { eventId: 2, kind: "worker.start", payload: { taskId: "task-1" }, at: "2026-01-01T00:00:01.000Z" },
      { eventId: 3, kind: "worker.end", payload: { taskId: "task-1" }, at: "2026-01-01T00:00:02.000Z" },
    ];
    // Still open — this task never got its own task.end before the (simulated) crash.
    writeOpenSegment(repoRoot, "task-1", 1, preRestart);

    // "Restart": the first appendHistoryEntry call for this repoRoot in THIS
    // process — ensureInitialized has never scanned this repo's directory
    // yet, so this exercises the lazy-seed-from-disk path exactly once.
    const postRestartId = appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:03.000Z", false);
    assert.equal(postRestartId, 4, "must continue from the highest id already on disk, not reset to 1");

    const nextId = appendHistoryEntry(repoRoot, "log", { message: "after restart" }, "2026-01-01T00:00:04.000Z", false);
    assert.equal(nextId, 5, "must keep incrementing normally after the restart, with no gap");

    const allIds = readHistoryBacklog(repoRoot).map((e) => e.eventId);
    assert.deepEqual(allIds, [1, 2, 3, 4, 5]);
  });

  // DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 7 (back-compat),
  // at the data layer: a log file written before eventId existed (every line
  // has no eventId field at all, just {kind, payload, at}) must still parse
  // cleanly and keep working once eventId-aware code starts appending to it
  // — additive-only means the OLD rows are tolerated forever, not migrated.
  test("a pre-eventId log (every line missing the field entirely) still parses, and new appends number from 1 without touching the old rows", async () => {
    const repoRoot = await makeTempRepo();
    const preEventIdEra = [
      { kind: "worker.start", payload: { agent: "EDITOR" }, at: "2026-01-01T00:00:00.000Z" },
      { kind: "worker.end", payload: { agent: "EDITOR", outcome: "passed" }, at: "2026-01-01T00:00:01.000Z" },
    ];
    // Open, not closed: a CLOSED segment's seed comes from its filename alone
    // (never read for content), so an open segment is the only way to prove
    // the seed falls back to scanning actual lines when none are numbered.
    writeOpenSegment(repoRoot, "between", 1, preEventIdEra);

    const parsed = readHistoryBacklog(repoRoot);
    assert.equal(parsed.length, 2);
    assert.ok(parsed.every((e) => e.eventId === undefined), "old rows must parse with no eventId, not a fabricated one");

    // No numbered entry exists yet, so the seed is 0 and the next id is 1 —
    // NOT 3, which a naive "highest index + 1" would wrongly produce.
    const newId = appendHistoryEntry(repoRoot, "log", { message: "first entry in the eventId era" }, "2026-01-01T00:00:02.000Z", false);
    assert.equal(newId, 1);

    // The legacy, `at`-based cursor (what an old phone build still uses) must
    // keep working unchanged over a log that mixes both eras.
    const { entries } = readHistoryBacklogSince(repoRoot, "1970-01-01T00:00:00.000Z", 100);
    assert.equal(entries.length, 3, "the legacy cursor must still see every entry, old and new alike");

    // The NEW, eventId-based cursor correctly skips the old, unnumbered rows
    // entirely (readHistoryBacklogSinceEventId's own documented behavior) —
    // it has no way to place them in an id-ordered page, so it only ever
    // returns the one new, numbered entry.
    const { entries: newOnly } = readHistoryBacklogSinceEventId(repoRoot, 0, 100);
    assert.equal(newOnly.length, 1);
    assert.equal(newOnly[0].eventId, 1);
  });

  test("skips a corrupt line instead of failing the whole read", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:00.000Z", false);
    await fs.appendFile(findOpenSegmentFile(repoRoot), "not valid json at all\n");
    appendHistoryEntry(repoRoot, "worker.end", { agent: "EDITOR", outcome: "passed" }, "2026-01-01T00:00:05.000Z", false);

    const entries = readHistoryBacklog(repoRoot);
    assert.equal(entries.length, 2, "the corrupt middle line must be skipped, not fatal");
    assert.equal(entries[0].kind, "worker.start");
    assert.equal(entries[1].kind, "worker.end");
  });
});

describe("appendHistoryEntry — redaction", () => {
  test("skips a redacted kind when redactLogs is on, same policy as the live stream", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "log", { level: "info", message: "secret project detail" }, "2026-01-01T00:00:00.000Z", true);
    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:01.000Z", true);

    const entries = readHistoryBacklog(repoRoot);
    assert.deepEqual(
      entries.map((e) => e.kind),
      ["worker.start"],
      "a redacted kind must never reach durable storage when the user opted into redaction"
    );
  });

  test("keeps a redacted kind when redactLogs is off", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "log", { level: "info", message: "hello" }, "2026-01-01T00:00:00.000Z", false);

    const entries = readHistoryBacklog(repoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "log");
  });
});

// Nothing is ever trimmed by design (see historyLog.ts's own top-of-file
// comment) -- every task (and every idle "between" segment, for everything
// that happens outside any task) gets its own bounded file, so there's no
// single growing file that would ever need a size/entry cap in the first
// place, and no "the oldest tasks get silently deleted" failure mode a
// long-lived project could run into.
describe("appendHistoryEntry — per-task segmentation, never trimmed", () => {
  test("many tasks in one repo each get their own file, and nothing from the earliest one is ever lost", async () => {
    const repoRoot = await makeTempRepo();
    const TASK_COUNT = 50;
    for (let i = 0; i < TASK_COUNT; i++) {
      const taskId = `task-${i}`;
      appendHistoryEntry(repoRoot, "task.start", { taskId, runId: "run-1", prompt: `task ${i}`, attachments: [] }, `2026-01-01T00:0${i}:00.000Z`, false);
      appendHistoryEntry(repoRoot, "worker.start", { taskId, workerId: `w-${i}`, agent: "EDITOR" }, `2026-01-01T00:0${i}:01.000Z`, false);
      appendHistoryEntry(repoRoot, "worker.end", { taskId, workerId: `w-${i}`, agent: "EDITOR", outcome: "completed" }, `2026-01-01T00:0${i}:02.000Z`, false);
      appendHistoryEntry(repoRoot, "task.end", { taskId, state: "done" }, `2026-01-01T00:0${i}:03.000Z`, false);
    }

    const files = fsSync.readdirSync(historyDir(repoRoot));
    const taskFiles = files.filter((f) => f.startsWith("task-"));
    assert.equal(taskFiles.length, TASK_COUNT, "every task must have its own, separately closed file");
    assert.ok(taskFiles.every((f) => !f.endsWith("-open.jsonl")), "a task that ended cleanly must have its file closed, not left open");

    const entries = readHistoryBacklog(repoRoot);
    assert.equal(entries.length, TASK_COUNT * 4);
    // The very first task's own events are still there, untouched -- this is
    // exactly the data loss the old single-file-with-a-cap design risked.
    assert.ok(entries.some((e) => e.kind === "task.start" && e.payload.taskId === "task-0"));
    assert.ok(entries.some((e) => e.kind === "task.end" && e.payload.taskId === "task-0"));
  });

  test("a running task's file is renamed exactly once, at task.end -- never on every intermediate write", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    const afterStart = fsSync.readdirSync(historyDir(repoRoot));
    const openName = afterStart.find((f) => f.startsWith("task-1_"));
    assert.ok(openName?.endsWith("-open.jsonl"));

    // Several more writes into the still-running task -- the LAST id in this
    // segment changes with every one of these, but the filename must not.
    for (let i = 0; i < 20; i++) {
      appendHistoryEntry(repoRoot, "log", { taskId: "task-1", message: `step-${i}` }, `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}.000Z`, false);
      const current = fsSync.readdirSync(historyDir(repoRoot));
      assert.ok(current.includes(openName!), `the open segment's filename must still be exactly "${openName}" after write ${i}, not renamed on every append`);
    }

    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:30.000Z", false);
    const afterEnd = fsSync.readdirSync(historyDir(repoRoot));
    assert.ok(!afterEnd.includes(openName!), "task.end must finally rename it away from -open");
    assert.ok(afterEnd.some((f) => f.startsWith("task-1_") && !f.endsWith("-open.jsonl")), "renamed to its real, final range");
  });

  test("idle-time events between tasks land in their own 'between' file, separate from either task's", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "p1", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);
    appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "what next" }, "2026-01-01T00:00:02.000Z", false);
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2", runId: "run-1", prompt: "p2", attachments: [] }, "2026-01-01T00:00:03.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:04.000Z", false);

    const files = fsSync.readdirSync(historyDir(repoRoot));
    assert.equal(files.filter((f) => f.startsWith("between_")).length, 1, "the idle-time advisor.start belongs in its own between-segment file");
    assert.equal(files.filter((f) => f.startsWith("task-1_")).length, 1);
    assert.equal(files.filter((f) => f.startsWith("task-2_")).length, 1);

    // Still reassembled in the right overall order by the full-backlog reader.
    const kinds = readHistoryBacklog(repoRoot).map((e) => e.kind);
    assert.deepEqual(kinds, ["task.start", "task.end", "advisor.start", "task.start", "task.end"]);
  });
});

// DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 4: tasks.index is
// built from task.start (create), refreshed at plan.ready (title/phaseCount),
// and finalized at task.end (state/endedAt/usage/lastEventId) -- one line
// per task, rewritten in place, never duplicated.
describe("tasks.index (listTasks)", () => {
  test("task.start creates a 'running' entry titled by the prompt's first line", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(
      repoRoot,
      "task.start",
      { taskId: "task-1", runId: "run-1", prompt: "Add a dark mode toggle\nwith a few more details", attachments: ["shot.png"] },
      "2026-01-01T00:00:00.000Z",
      false,
      "sample-app"
    );

    const { entries } = listTasks(repoRoot, 50);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.taskId, "task-1");
    assert.equal(e.repoName, "sample-app");
    assert.equal(e.title, "Add a dark mode toggle", "title falls back to the prompt's first line before any plan.ready");
    assert.equal(e.prompt, "Add a dark mode toggle");
    assert.equal(e.state, "running");
    assert.equal(e.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(e.endedAt, null);
    assert.equal(e.firstEventId, 1);
    assert.equal(e.lastEventId, null);
    assert.deepEqual(e.attachments, ["shot.png"]);
  });

  test("plan.ready upgrades the title to the plan's goal and fills in phaseCount", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "do the thing", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(
      repoRoot,
      "plan.ready",
      { taskId: "task-1", runId: "run-1", goal: "Add a dark mode toggle to Settings", degraded: false, phases: [{ id: "p1", name: "n", goal: "g" }, { id: "p2", name: "n2", goal: "g2" }] },
      "2026-01-01T00:00:05.000Z",
      false
    );

    const { entries } = listTasks(repoRoot, 50);
    assert.equal(entries[0].title, "Add a dark mode toggle to Settings");
    assert.equal(entries[0].phaseCount, 2);
    assert.equal(entries[0].state, "running", "plan.ready must not touch state");
  });

  test("task.end finalizes state/endedAt/tokensUsed/costUsd/lastEventId", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "do it", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    const endId = appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done", tokensUsed: 500, costUsd: 0.02 }, "2026-01-01T00:01:00.000Z", false);

    const { entries } = listTasks(repoRoot, 50);
    assert.equal(entries[0].state, "done");
    assert.equal(entries[0].endedAt, "2026-01-01T00:01:00.000Z");
    assert.equal(entries[0].tokensUsed, 500);
    assert.equal(entries[0].costUsd, 0.02);
    assert.equal(entries[0].lastEventId, endId);
  });

  test("returns newest first, pages with beforeTaskId/hasMore", async () => {
    const repoRoot = await makeTempRepo();
    for (let i = 0; i < 5; i++) {
      appendHistoryEntry(repoRoot, "task.start", { taskId: `task-${i}`, runId: "run-1", prompt: `p${i}`, attachments: [] }, `2026-01-01T00:0${i}:00.000Z`, false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: `task-${i}`, state: "done" }, `2026-01-01T00:0${i}:01.000Z`, false);
    }

    const page1 = listTasks(repoRoot, 2);
    assert.deepEqual(page1.entries.map((e) => e.taskId), ["task-4", "task-3"], "newest first");
    assert.equal(page1.hasMore, true);

    const page2 = listTasks(repoRoot, 2, page1.entries[page1.entries.length - 1].taskId);
    assert.deepEqual(page2.entries.map((e) => e.taskId), ["task-2", "task-1"]);
    assert.equal(page2.hasMore, true);

    const page3 = listTasks(repoRoot, 2, page2.entries[page2.entries.length - 1].taskId);
    assert.deepEqual(page3.entries.map((e) => e.taskId), ["task-0"]);
    assert.equal(page3.hasMore, false);
  });
});

// DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 5: fetch_history{taskId}
// returns exactly that task's own events, byte-identical to what a live push
// would have sent, paged at the caller's limit; an unknown/evicted taskId
// answers missing:true instead of a false "nothing past this point".
describe("readTaskEvents", () => {
  test("returns exactly one task's own events, in eventId order, never another task's or a between-segment's", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "worker.start", { taskId: "task-1" }, "2026-01-01T00:00:01.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:02.000Z", false);
    appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "q" }, "2026-01-01T00:00:03.000Z", false);
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:04.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:05.000Z", false);

    const { entries, truncated, missing } = readTaskEvents(repoRoot, "task-1", 0, 500);
    assert.equal(missing, false);
    assert.equal(truncated, false);
    assert.deepEqual(entries.map((e) => e.kind), ["task.start", "worker.start", "task.end"]);
    assert.ok(entries.every((e) => e.payload.taskId === "task-1" || e.kind === "worker.start"));
  });

  test("pages a task with more than the page size's worth of events", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    for (let i = 0; i < 10; i++) {
      appendHistoryEntry(repoRoot, "log", { taskId: "task-1", message: `step-${i}` }, `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}.000Z`, false);
    }
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:20.000Z", false);
    // 12 events total (start + 10 logs + end); page at 5.
    const page1 = readTaskEvents(repoRoot, "task-1", 0, 5);
    assert.equal(page1.entries.length, 5);
    assert.equal(page1.truncated, true);
    const lastId = page1.entries[page1.entries.length - 1].eventId!;
    const page2 = readTaskEvents(repoRoot, "task-1", lastId, 5);
    assert.equal(page2.entries.length, 5);
    assert.equal(page2.truncated, true);
    const page3 = readTaskEvents(repoRoot, "task-1", page2.entries[page2.entries.length - 1].eventId!, 5);
    assert.equal(page3.entries.length, 2);
    assert.equal(page3.truncated, false);
  });

  test("an unknown taskId answers missing: true, not an empty-but-caught-up result", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);

    const result = readTaskEvents(repoRoot, "task-does-not-exist", 0, 500);
    assert.equal(result.missing, true);
    assert.deepEqual(result.entries, []);
  });

  test("an evicted task (retention already deleted its file) also answers missing: true", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);

    _setMaxRetainedTasksForTesting(1);
    try {
      appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:02.000Z", false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:03.000Z", false); // evicts task-1

      const result = readTaskEvents(repoRoot, "task-1", 0, 500);
      assert.equal(result.missing, true);
    } finally {
      _setMaxRetainedTasksForTesting(undefined);
    }
  });
});

// Retention: desktop keeps the most recent MAX_RETAINED_TASKS tasks (1,000
// at the time of writing) and evicts the single oldest, by whole task, the
// moment a task.end pushes the count past the cap -- never blocking the new
// write, never losing an arbitrary chunk out of a task's own middle the way
// the old byte/entry trim could. The android app already has to tolerate
// older history being gone (that's the whole premise of bounded phone-side
// storage + fetch_history paging), so desktop-side eviction costs it nothing
// new. Pre-existing tasks are written directly to disk (bypassing
// appendHistoryEntry) rather than actually driving 1,000+ real appends --
// faster, and exercises the exact same enforceRetention path either way.
describe("appendHistoryEntry — task retention (keep the most recent N, evict the oldest)", () => {
  const CAP = 1000; // must match MAX_RETAINED_TASKS in historyLog.ts

  function seedClosedTasks(repoRoot: string, count: number): void {
    for (let i = 0; i < count; i++) {
      writeClosedSegment(repoRoot, `task-${i}`, i * 2 + 1, i * 2 + 2, [
        { eventId: i * 2 + 1, kind: "task.start", payload: { taskId: `task-${i}` }, at: "2026-01-01T00:00:00.000Z" },
        { eventId: i * 2 + 2, kind: "task.end", payload: { taskId: `task-${i}`, state: "done" }, at: "2026-01-01T00:00:01.000Z" },
      ]);
    }
  }

  test("once the task count exceeds the cap, task.end evicts exactly the single oldest task", async () => {
    const repoRoot = await makeTempRepo();
    seedClosedTasks(repoRoot, CAP);

    const startId = appendHistoryEntry(repoRoot, "task.start", { taskId: "task-new" }, "2026-01-01T00:01:00.000Z", false);
    const endId = appendHistoryEntry(repoRoot, "task.end", { taskId: "task-new", state: "done" }, "2026-01-01T00:01:01.000Z", false);
    assert.equal(typeof startId, "number", "a new task must never be blocked by having reached the cap");
    assert.equal(typeof endId, "number");

    const taskFiles = fsSync.readdirSync(historyDir(repoRoot)).filter((f) => f.startsWith("task-"));
    assert.equal(taskFiles.length, CAP, `exactly ${CAP} task files must remain, got ${taskFiles.length}`);
    assert.ok(!taskFiles.some((f) => f.startsWith("task-0_")), "the single oldest task must be the one evicted");
    assert.ok(taskFiles.some((f) => f.startsWith("task-1_")), "the second-oldest must survive -- only exactly one was evicted");
    assert.ok(taskFiles.some((f) => f.startsWith("task-new_")), "the brand-new task must survive, not itself be evicted");
  });

  test("a between-segment with no surviving task on either side of it is evicted along with the task it preceded", async () => {
    const repoRoot = await makeTempRepo();
    writeClosedSegment(repoRoot, "between", 1, 1, [{ eventId: 1, kind: "status", payload: { state: "idle" }, at: "2026-01-01T00:00:00.000Z" }]);
    // Re-numbered starting at 2 so this between-segment (id 1) is older than
    // every task, and therefore the first thing evicted once task-0 is.
    for (let i = 0; i < CAP; i++) {
      writeClosedSegment(repoRoot, `task-${i}`, i * 2 + 2, i * 2 + 3, [
        { eventId: i * 2 + 2, kind: "task.start", payload: { taskId: `task-${i}` }, at: "2026-01-01T00:00:00.000Z" },
        { eventId: i * 2 + 3, kind: "task.end", payload: { taskId: `task-${i}`, state: "done" }, at: "2026-01-01T00:00:01.000Z" },
      ]);
    }

    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-new" }, "2026-01-01T00:01:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-new", state: "done" }, "2026-01-01T00:01:01.000Z", false);

    const files = fsSync.readdirSync(historyDir(repoRoot));
    assert.ok(!files.some((f) => f.startsWith("between_")), "a between-segment older than every retained task has no context left and must be evicted too");
  });

  test("does nothing while the task count is at or under the cap", async () => {
    const repoRoot = await makeTempRepo();
    for (let i = 0; i < 5; i++) {
      appendHistoryEntry(repoRoot, "task.start", { taskId: `task-${i}` }, `2026-01-01T00:0${i}:00.000Z`, false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: `task-${i}`, state: "done" }, `2026-01-01T00:0${i}:01.000Z`, false);
    }
    const files = fsSync.readdirSync(historyDir(repoRoot));
    assert.equal(files.filter((f) => f.startsWith("task-")).length, 5, "well under the cap -- nothing should ever be evicted");
  });

  // By the time appendHistoryEntry's OWN task.end branch calls
  // enforceRetention, openSegment has already been cleared for that repo --
  // so the one real place a still-open segment and a retention sweep can
  // coincide is reconcileInterruptedTask's unconditional call at startup,
  // when no task was actually interrupted (the open segment is a between
  // segment, left over from an idle period, not a task).
  test("reconcileInterruptedTask's own retention sweep never evicts the currently-open segment, however old it is", async () => {
    const repoRoot = await makeTempRepo();
    // Left open from "before a restart" -- far older (eventId 1) than every
    // task seeded below (which all start at eventId 2+).
    writeOpenSegment(repoRoot, "between", 1, [{ eventId: 1, kind: "status", payload: { state: "idle" }, at: "2020-01-01T00:00:00.000Z" }]);
    for (let i = 0; i < CAP; i++) {
      writeClosedSegment(repoRoot, `task-${i}`, i * 2 + 2, i * 2 + 3, [
        { eventId: i * 2 + 2, kind: "task.start", payload: { taskId: `task-${i}` }, at: "2026-01-01T00:00:00.000Z" },
        { eventId: i * 2 + 3, kind: "task.end", payload: { taskId: `task-${i}`, state: "done" }, at: "2026-01-01T00:00:01.000Z" },
      ]);
    }

    reconcileInterruptedTask(repoRoot); // no task was interrupted here, but the retention sweep still runs unconditionally

    const openFile = fsSync.readdirSync(historyDir(repoRoot)).find((f) => f.endsWith("-open.jsonl"));
    assert.ok(openFile?.startsWith("between_1-open"), "the still-open between-segment must survive retention no matter how old it is");
  });

  // DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 9, verbatim: "with
  // the limit set to 3 in a test, creating a 4th task evicts the oldest
  // task's file, its index line, and between-files older than the oldest
  // kept task."
  test("acceptance criterion 9: with the limit set to 3, a 4th task evicts the oldest task's file, its index line, and older between-files", async () => {
    const repoRoot = await makeTempRepo();
    _setMaxRetainedTasksForTesting(3);
    try {
      appendHistoryEntry(repoRoot, "task.start", { taskId: "task-0" }, "2026-01-01T00:00:00.000Z", false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: "task-0", state: "done" }, "2026-01-01T00:00:01.000Z", false);
      appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "q" }, "2026-01-01T00:00:02.000Z", false); // between-file, older than every task below
      appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:03.000Z", false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:04.000Z", false);
      appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:05.000Z", false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:06.000Z", false);

      // Still only 3 tasks -- nothing evicted yet.
      let files = fsSync.readdirSync(historyDir(repoRoot));
      assert.ok(files.some((f) => f.startsWith("task-0_")), "task-0 must still be present before the 4th task");
      assert.ok(files.some((f) => f.startsWith("between_")), "the between-file must still be present before the 4th task");

      // The 4th task pushes the count to 4, over the limit of 3.
      appendHistoryEntry(repoRoot, "task.start", { taskId: "task-3" }, "2026-01-01T00:00:07.000Z", false);
      appendHistoryEntry(repoRoot, "task.end", { taskId: "task-3", state: "done" }, "2026-01-01T00:00:08.000Z", false);

      files = fsSync.readdirSync(historyDir(repoRoot));
      assert.ok(!files.some((f) => f.startsWith("task-0_")), "task-0's own file must be evicted");
      assert.ok(!files.some((f) => f.startsWith("between_")), "the between-file older than the oldest kept task must be evicted too");
      for (const id of [1, 2, 3]) {
        assert.ok(files.some((f) => f.startsWith(`task-${id}_`)), `task-${id} must survive`);
      }

      const indexTaskIds = readRawTaskIndex(repoRoot).map((e) => e.taskId);
      assert.ok(!indexTaskIds.includes("task-0"), "task-0's own index line must be evicted too");
      assert.deepEqual(indexTaskIds.sort(), ["task-1", "task-2", "task-3"]);
    } finally {
      _setMaxRetainedTasksForTesting(undefined);
    }
  });
});

// The bug this fixes: connectRemote seeds every freshly (re-)paired session's
// outbox from readHistoryBacklog's FULL result -- every re-pair (leaving and
// reopening the phone app, reconnecting, anything that starts a new session)
// replayed the entire accumulated history again, including a "plan.ready"
// already delivered and rendered on a prior pairing, producing a duplicate
// card each time. readHistoryBacklogForReplay tracks a watermark so only
// genuinely new entries go out on each call.
//
// That watermark is deliberately in-memory (a module-level Map), never
// written to disk: it must reset to 0 on every fresh process start, not just
// every fresh pairing. A disk-backed version of this shipped briefly and
// broke `--resume` (a brand-new process) -- the resumed process's very first
// pairing saw a stale watermark left over from the PREVIOUS process and
// wrongly withheld the task's original goal/prompt event, which is exactly
// what should have gone out in full since this process has no idea what a
// reconnecting phone's own local state still holds.
describe("readHistoryBacklogForReplay", () => {
  // "Returns everything" here only because there's no task at all in this
  // scenario (nothing for the capping below to cap away from) -- see the
  // acceptance-criterion-8 tests further down for the actual capping
  // behavior once more than one task exists.
  test("the first call returns everything, like a fresh pairing catching up from scratch", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "plan.ready", { goal: "g" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "status", { state: "running" }, "2026-01-01T00:00:01.000Z", false);

    const first = readHistoryBacklogForReplay(repoRoot);
    assert.equal(first.length, 2);
    assert.deepEqual(first.map((e) => e.kind), ["plan.ready", "status"]);
  });

  // DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 8: "a fresh
  // pairing receives only the newest task + later between-task events."
  test("acceptance criterion 8: a fresh pairing (watermark still 0) is capped to the newest task onward, not the whole project", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);
    appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "q" }, "2026-01-01T00:00:02.000Z", false);
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:03.000Z", false);
    appendHistoryEntry(repoRoot, "worker.start", { taskId: "task-2" }, "2026-01-01T00:00:04.000Z", false);
    // task-2 still running (no task.end) -- the "newest task, open or closed" case.

    const replayed = readHistoryBacklogForReplay(repoRoot);
    assert.deepEqual(
      replayed.map((e) => e.kind),
      ["task.start", "worker.start"],
      "must start at task-2's own task.start, never task-1's events or the between-segment before it"
    );

    // And the full backlog (what history.list + fetch_history{taskId} can
    // still reach on demand) is unaffected -- capping is a REPLAY concern only.
    assert.equal(readHistoryBacklog(repoRoot).length, 5, "nothing is deleted by this -- only what's replayed live on a fresh pairing is capped");
  });

  test("acceptance criterion 8: still starts at the newest task even when it already ended cleanly before the pairing", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:02.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:03.000Z", false);
    appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "q" }, "2026-01-01T00:00:04.000Z", false);

    const replayed = readHistoryBacklogForReplay(repoRoot);
    assert.deepEqual(
      replayed.map((e) => e.kind),
      ["task.start", "task.end", "advisor.start"],
      "starts at task-2 (the newest task, already closed), never task-1's events"
    );
  });

  test("a SECOND pairing within the same process (watermark already advanced) is NOT re-capped -- it gets exactly what's new since the first", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:01.000Z", false);
    readHistoryBacklogForReplay(repoRoot); // first pairing: capped (but there's only one task, so it's everything anyway)

    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:02.000Z", false);
    const second = readHistoryBacklogForReplay(repoRoot);
    assert.deepEqual(second.map((e) => e.kind), ["task.start"], "the incremental path, not the capped-to-newest-task path, since this isn't the first pairing");
  });

  test("a second call with nothing new returns empty -- no duplicate re-pair replay", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "plan.ready", { goal: "g" }, "2026-01-01T00:00:00.000Z", false);

    const first = readHistoryBacklogForReplay(repoRoot);
    assert.equal(first.length, 1);

    // Simulates re-pairing again (leaving and reopening the app) with no new
    // task activity in between -- this must NOT hand back "plan.ready" again.
    const second = readHistoryBacklogForReplay(repoRoot);
    assert.deepEqual(second, [], "re-pairing with nothing new must not re-deliver already-replayed entries");
  });

  test("a later call only returns entries appended since the previous call", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "plan.ready", { goal: "g" }, "2026-01-01T00:00:00.000Z", false);
    readHistoryBacklogForReplay(repoRoot); // first pairing catches up

    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:05.000Z", false);
    appendHistoryEntry(repoRoot, "worker.end", { agent: "EDITOR" }, "2026-01-01T00:00:10.000Z", false);

    const second = readHistoryBacklogForReplay(repoRoot);
    assert.deepEqual(
      second.map((e) => e.kind),
      ["worker.start", "worker.end"],
      "re-pairing must only replay what happened since the last pairing, not the whole log again"
    );
  });

  test("readHistoryBacklog itself is unaffected by the replay watermark", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "plan.ready", { goal: "g" }, "2026-01-01T00:00:00.000Z", false);
    readHistoryBacklogForReplay(repoRoot);
    readHistoryBacklogForReplay(repoRoot);

    assert.equal(readHistoryBacklog(repoRoot).length, 1, "the full backlog reader must keep returning everything, unaffected by replay bookkeeping");
  });

  test("two different repos never share a watermark", async () => {
    const repoA = await makeTempRepo();
    const repoB = await makeTempRepo();
    appendHistoryEntry(repoA, "plan.ready", { goal: "a" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoB, "plan.ready", { goal: "b" }, "2026-01-01T00:00:00.000Z", false);

    readHistoryBacklogForReplay(repoA); // advances repoA's watermark only

    const stillFreshForB = readHistoryBacklogForReplay(repoB);
    assert.equal(stillFreshForB.length, 1, "repo B's first replay must not be suppressed by repo A's watermark");
  });

});

// The broker only keeps the newest 500 events per session in memory
// (MAX_QUEUE in broker.ts) -- a long enough gap (the phone asleep overnight
// through a busy task) can permanently drop events from the broker's buffer
// before the phone ever polls for them. readHistoryBacklogSince is what lets
// the phone ask the desktop -- the only place with the full durable record
// -- to re-serve what the broker lost, via the `fetch_history` command.
describe("readHistoryBacklogSince", () => {
  test("returns only entries strictly after the given timestamp", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "worker.end", { agent: "EDITOR" }, "2026-01-01T00:00:05.000Z", false);
    appendHistoryEntry(repoRoot, "status", { state: "done" }, "2026-01-01T00:00:10.000Z", false);

    const { entries, truncated } = readHistoryBacklogSince(repoRoot, "2026-01-01T00:00:05.000Z", 100);
    assert.deepEqual(entries.map((e) => e.kind), ["status"], "the boundary entry itself must not be re-sent, only what's strictly after it");
    assert.equal(truncated, false);
  });

  test("an `after` at or past the newest entry returns nothing -- genuinely caught up, not a gap", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "worker.start", { agent: "EDITOR" }, "2026-01-01T00:00:00.000Z", false);

    const { entries, truncated } = readHistoryBacklogSince(repoRoot, "2026-01-01T00:00:00.000Z", 100);
    assert.deepEqual(entries, []);
    assert.equal(truncated, false);
  });

  test("caps the result and reports truncated, oldest-first, so a client can page forward", async () => {
    const repoRoot = await makeTempRepo();
    for (let i = 0; i < 10; i++) {
      appendHistoryEntry(repoRoot, "log", { message: `entry-${i}` }, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, false);
    }

    const { entries, truncated } = readHistoryBacklogSince(repoRoot, "1970-01-01T00:00:00.000Z", 3);
    assert.equal(truncated, true);
    assert.deepEqual(
      entries.map((e) => e.payload.message),
      ["entry-0", "entry-1", "entry-2"],
      "must return the OLDEST entries first, not newest, so pagination advances forward through the gap in order"
    );

    // A client pages forward by using the last returned entry's `at` as the next `after`.
    const next = readHistoryBacklogSince(repoRoot, entries[entries.length - 1].at, 3);
    assert.deepEqual(next.entries.map((e) => e.payload.message), ["entry-3", "entry-4", "entry-5"]);
    assert.equal(next.truncated, true);
  });

  test("does not report truncated when the result lands exactly on the cap", async () => {
    const repoRoot = await makeTempRepo();
    for (let i = 0; i < 3; i++) {
      appendHistoryEntry(repoRoot, "log", { message: `entry-${i}` }, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, false);
    }
    const { entries, truncated } = readHistoryBacklogSince(repoRoot, "1970-01-01T00:00:00.000Z", 3);
    assert.equal(entries.length, 3);
    assert.equal(truncated, false, "exactly filling the cap is not the same as there being more beyond it");
  });

  test("an empty or missing history file returns nothing, never throws", async () => {
    const repoRoot = await makeTempRepo();
    const { entries, truncated } = readHistoryBacklogSince(repoRoot, "2026-01-01T00:00:00.000Z", 100);
    assert.deepEqual(entries, []);
    assert.equal(truncated, false);
  });
});

describe("reconcileInterruptedTask", () => {
  test("closes an orphaned task.start (no matching task.end) with a synthetic task.end{state: 'interrupted'}", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "do it", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    reconcileInterruptedTask(repoRoot);
    const entries = readHistoryBacklog(repoRoot);
    const end = entries.find((e) => e.kind === "task.end");
    assert.ok(end, "an orphaned task.start must get a synthetic task.end");
    assert.equal(end!.payload.taskId, "task-1");
    assert.equal(end!.payload.state, "interrupted");
    assert.equal(end!.payload.tokensUsed, undefined, "a crashed process's usage tracker is gone — nothing honest to report");

    // DESKTOP_TASK_HISTORY_FILES_TASK.md acceptance criterion 3: the index
    // line must say interrupted too, not just the event itself.
    const indexEntry = readRawTaskIndex(repoRoot).find((e) => e.taskId === "task-1");
    assert.ok(indexEntry, "the task must still have an index line");
    assert.equal(indexEntry.state, "interrupted");
    assert.equal(indexEntry.lastEventId, end!.eventId);
  });

  test("does nothing when the last task already has a matching task.end", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "do it", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done", tokensUsed: 100 }, "2026-01-01T00:00:05.000Z", false);
    reconcileInterruptedTask(repoRoot);
    const entries = readHistoryBacklog(repoRoot);
    assert.equal(entries.filter((e) => e.kind === "task.end").length, 1, "a task that already ended cleanly must not get a second, synthetic task.end");
  });

  test("two tasks back to back: only the second (unclosed) one is flagged, the first's own task.end is untouched", async () => {
    const repoRoot = await makeTempRepo();
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1", runId: "run-1", prompt: "first", attachments: [] }, "2026-01-01T00:00:00.000Z", false);
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:05.000Z", false);
    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2", runId: "run-1", prompt: "second", attachments: [] }, "2026-01-01T00:00:10.000Z", false);
    reconcileInterruptedTask(repoRoot);
    const entries = readHistoryBacklog(repoRoot);
    const ends = entries.filter((e) => e.kind === "task.end");
    assert.equal(ends.length, 2);
    assert.equal(ends[0].payload.taskId, "task-1");
    assert.equal(ends[0].payload.state, "done");
    assert.equal(ends[1].payload.taskId, "task-2");
    assert.equal(ends[1].payload.state, "interrupted");
  });

  test("no task.start at all is a no-op", async () => {
    const repoRoot = await makeTempRepo();
    reconcileInterruptedTask(repoRoot);
    assert.deepEqual(readHistoryBacklog(repoRoot), []);
  });
});

// DESKTOP_EVENT_CONTRACT_V2_TASK.md acceptance criterion 3: "fetch_history{afterEventId}
// over a log with >=1,200 events, several sharing one millisecond across a page
// boundary, returns every event exactly once." This is exactly the scenario the
// legacy `at`-based cursor (readHistoryBacklogSince) cannot safely handle --
// `e.at > afterIso` has no way to tell apart several events that share the
// cutoff instant, so some land on the wrong side of a page boundary. Paging by
// eventId is immune to this by construction (a strict integer order has no
// ties), which is exactly what this test locks in.
describe("readHistoryBacklogSinceEventId — acceptance criterion 3 (paging)", () => {
  test("pages through >=1,200 events, many sharing one millisecond at the default page boundary, with no event dropped or duplicated", async () => {
    const repoRoot = await makeTempRepo();
    const TOTAL = 1_200;
    const PAGE_SIZE = 500;
    // A cluster of entries straddling the FIRST page boundary (index 500,
    // 0-based) all share the exact same millisecond -- the real-world case
    // ("routine under real load" per readHistoryBacklogSince's own doc
    // comment) a timestamp-based cursor cannot safely page across.
    const TIED_AT = "2026-01-01T00:08:20.000Z";
    for (let i = 0; i < TOTAL; i++) {
      const at = i >= 490 && i < 510 ? TIED_AT : new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
      appendHistoryEntry(repoRoot, "log", { message: `entry-${i}` }, at, false);
    }

    const collected: number[] = [];
    let afterEventId = 0;
    let truncated = true;
    let pages = 0;
    while (truncated) {
      const page = readHistoryBacklogSinceEventId(repoRoot, afterEventId, PAGE_SIZE);
      assert.ok(page.entries.length > 0 || !page.truncated, "a truncated page must never come back empty");
      for (const e of page.entries) {
        assert.equal(typeof e.eventId, "number");
        collected.push(e.eventId!);
      }
      if (page.entries.length > 0) afterEventId = page.entries[page.entries.length - 1].eventId!;
      truncated = page.truncated;
      pages++;
      assert.ok(pages < 20, "paging should have terminated well before this many pages — something is looping");
    }

    assert.equal(collected.length, TOTAL, "every event must be returned exactly once across all pages");
    assert.deepEqual(collected, Array.from({ length: TOTAL }, (_, i) => i + 1), "eventIds must come back strictly in order, 1..TOTAL, with no gap and no duplicate");
  });

  // The test above only ever appends inside ONE open "between" segment (it
  // never calls task.start), so it never actually exercises paging ACROSS
  // separate files. Per-task segmentation means every real session pages
  // across task files and between-segment files interleaved -- this is
  // where a bug in "skip whole files by filename range" or in re-merging
  // adjacent files' entries in order would actually show up.
  test("pages correctly across several separate task/between segment files, in strict eventId order, with page boundaries landing both inside and exactly on a file boundary", async () => {
    const repoRoot = await makeTempRepo();

    // 3 events before any task (between), then 3 tasks of 3 events each,
    // with a 1-event between segment separating tasks 2 and 3 -- 5 files
    // total, 12 events total.
    appendHistoryEntry(repoRoot, "command.accepted", { verb: "message" }, "2026-01-01T00:00:00.000Z", false); // 1
    appendHistoryEntry(repoRoot, "status", { state: "idle" }, "2026-01-01T00:00:01.000Z", false); // 2
    appendHistoryEntry(repoRoot, "attach.done", { name: "a.png" }, "2026-01-01T00:00:02.000Z", false); // 3

    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-1" }, "2026-01-01T00:00:03.000Z", false); // 4
    appendHistoryEntry(repoRoot, "worker.start", { taskId: "task-1" }, "2026-01-01T00:00:04.000Z", false); // 5
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-1", state: "done" }, "2026-01-01T00:00:05.000Z", false); // 6

    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-2" }, "2026-01-01T00:00:06.000Z", false); // 7
    appendHistoryEntry(repoRoot, "worker.start", { taskId: "task-2" }, "2026-01-01T00:00:07.000Z", false); // 8
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-2", state: "done" }, "2026-01-01T00:00:08.000Z", false); // 9

    appendHistoryEntry(repoRoot, "advisor.start", { exchangeId: "ask-1", question: "q" }, "2026-01-01T00:00:09.000Z", false); // 10

    appendHistoryEntry(repoRoot, "task.start", { taskId: "task-3" }, "2026-01-01T00:00:10.000Z", false); // 11
    appendHistoryEntry(repoRoot, "task.end", { taskId: "task-3", state: "done" }, "2026-01-01T00:00:11.000Z", false); // 12

    const files = fsSync.readdirSync(historyDir(repoRoot)).filter((f) => f !== "tasks.index");
    assert.equal(files.length, 5, "5 separate files: 1 leading between, 3 tasks, 1 between in the middle");

    // Page size 4 -- deliberately NOT aligned to any file's own size (3, 3,
    // 1, 3, 2), so page boundaries land both mid-file and exactly on a file
    // boundary across the run.
    const collected: number[] = [];
    let afterEventId = 0;
    let truncated = true;
    let pages = 0;
    while (truncated) {
      const page = readHistoryBacklogSinceEventId(repoRoot, afterEventId, 4);
      for (const e of page.entries) collected.push(e.eventId!);
      if (page.entries.length > 0) afterEventId = page.entries[page.entries.length - 1].eventId!;
      truncated = page.truncated;
      pages++;
      assert.ok(pages < 10, "should have terminated well before this many pages");
    }

    assert.deepEqual(collected, Array.from({ length: 12 }, (_, i) => i + 1), "every event across every file must come back exactly once, in strict eventId order, task and between segments interleaved correctly");

    // And a request starting exactly at a segment's own final eventId must
    // correctly skip that whole (now-irrelevant) file without reading it --
    // verified indirectly here by confirming it still returns precisely the
    // right remaining slice.
    const fromMidTask1 = readHistoryBacklogSinceEventId(repoRoot, 6, 500);
    assert.deepEqual(fromMidTask1.entries.map((e) => e.eventId), [7, 8, 9, 10, 11, 12]);
    assert.equal(fromMidTask1.truncated, false);
  });
});
