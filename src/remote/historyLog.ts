/**
 * Durable, desktop-side record of every event RemoteSession.push() (client.ts)
 * has ever sent for a repo — independent of any particular broker session's
 * lifetime.
 *
 * Backed by Node's built-in `node:sqlite` (`DatabaseSync`) via `historyDb.ts`
 * in WAL mode (`~/.yimpim/yimpim.db`, overrideable via `YIMPIM_HISTORY_DB`).
 * Legacy `.agent/remote_history/*.jsonl` and `tasks.index` files are imported
 * once, non-destructively, on first access per normalized `repoRoot`.
 */

import { REDACTED_EVENT_KINDS, TaskIndexEntry } from "./protocol.js";
import {
  type HistoryEntry,
  appendHistoryEntryDb,
  readHistoryBacklogDb,
  readFromNewestTaskDb,
  readHistoryBacklogSinceDb,
  readHistoryBacklogSinceEventIdDb,
  listTasksDb,
  readTaskEventsDb,
  reconcileInterruptedTaskDb,
  normalizeRepoRoot,
  closeHistoryDb,
  _resetHistoryDbForTesting,
} from "./historyDb.js";

export type { HistoryEntry };
export { closeHistoryDb, _resetHistoryDbForTesting, normalizeRepoRoot };

/**
 * How many most-recently-started closed tasks this repo retains — oldest
 * whole tasks (and their events + preceding orphaned between-events) are
 * evicted on `task.end` / `reconcileInterruptedTask`.
 */
const MAX_RETAINED_TASKS = 1000;

/** Test-only override for MAX_RETAINED_TASKS. */
let maxRetainedTasksOverride: number | undefined;
export function _setMaxRetainedTasksForTesting(n: number | undefined): void {
  maxRetainedTasksOverride = n;
}

function effectiveRetentionCap(): number {
  return maxRetainedTasksOverride ?? MAX_RETAINED_TASKS;
}

/**
 * Appends one translated event to this repo's durable history log. Best-
 * effort and never throws: losing one history entry is far cheaper than a
 * disk hiccup taking down the whole run.
 *
 * Silently skips the same kinds RemoteSession's live push already redacts
 * when redactLogs is on.
 */
export function appendHistoryEntry(
  repoRoot: string,
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  redactLogs: boolean,
  repoName?: string
): number | undefined {
  if (redactLogs && REDACTED_EVENT_KINDS.has(kind)) return undefined;
  try {
    return appendHistoryEntryDb(repoRoot, kind, payload, at, repoName, effectiveRetentionCap());
  } catch {
    // Best-effort — see doc comment above.
    return undefined;
  }
}

/** Reads this repo's durable history, oldest first — [] if none exist yet. */
export function readHistoryBacklog(repoRoot: string): HistoryEntry[] {
  try {
    return readHistoryBacklogDb(repoRoot);
  } catch {
    return [];
  }
}

/**
 * Deliberately IN-MEMORY, not persisted to disk: resets to 0 on every fresh
 * process start so a resumed process's first pairing never withholds events.
 */
const replayWatermarks = new Map<string, number>();

function readReplayWatermark(repoRoot: string): number {
  return replayWatermarks.get(normalizeRepoRoot(repoRoot)) ?? 0;
}

function writeReplayWatermark(repoRoot: string, count: number): void {
  replayWatermarks.set(normalizeRepoRoot(repoRoot), count);
}

/**
 * Like readHistoryBacklog, but only returns entries not already handed out
 * by a PREVIOUS call to this function for this repo, and advances the
 * watermark to cover them. First call (watermark === 0) is capped to the
 * newest task onward.
 */
export function readHistoryBacklogForReplay(repoRoot: string): HistoryEntry[] {
  const watermark = readReplayWatermark(repoRoot);
  const all = readHistoryBacklog(repoRoot);
  const fresh = watermark === 0 ? readFromNewestTaskDb(repoRoot) : all.slice(Math.min(watermark, all.length));
  writeReplayWatermark(repoRoot, all.length);
  return fresh;
}

/**
 * Entries strictly after a given ISO timestamp, oldest first, capped at `limit`.
 */
export function readHistoryBacklogSince(
  repoRoot: string,
  afterIso: string,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  try {
    return readHistoryBacklogSinceDb(repoRoot, afterIso, limit);
  } catch {
    return { entries: [], truncated: false };
  }
}

/**
 * Entries with `eventId > afterEventId`, oldest first, capped at `limit`.
 */
export function readHistoryBacklogSinceEventId(
  repoRoot: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  try {
    return readHistoryBacklogSinceEventIdDb(repoRoot, afterEventId, limit);
  } catch {
    return { entries: [], truncated: false };
  }
}

/**
 * One page of the History list, newest first.
 */
export function listTasks(
  repoRoot: string,
  limit: number,
  beforeTaskId?: string
): { entries: TaskIndexEntry[]; hasMore: boolean } {
  try {
    return listTasksDb(repoRoot, limit, beforeTaskId);
  } catch {
    return { entries: [], hasMore: false };
  }
}

/**
 * One task's own events only, in `eventId` order, strictly after `afterEventId`.
 */
export function readTaskEvents(
  repoRoot: string,
  taskId: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean; missing: boolean } {
  try {
    return readTaskEventsDb(repoRoot, taskId, afterEventId, limit);
  } catch {
    return { entries: [], truncated: false, missing: true };
  }
}

/**
 * Closes an orphaned task left open by a prior process crash/kill with a
 * synthetic `task.end{state: 'interrupted'}` and runs retention cleanup.
 */
export function reconcileInterruptedTask(repoRoot: string): void {
  try {
    reconcileInterruptedTaskDb(repoRoot, effectiveRetentionCap());
  } catch {
    // Best-effort.
  }
}
