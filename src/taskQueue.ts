/**
 * Persisted multi-task backlog (.agent/task-queue.json).
 *
 * When a single ask naturally decomposes into more work than one task's
 * MAX_PLAN_PHASES budget can hold (e.g. "redesign every screen" across many
 * screens), the planner plans the first chunk fully and lists the rest as
 * short, self-contained follow-up instructions (Plan.followUpTasks). This
 * module is where that list lives between tasks, so the orchestrator can
 * offer to auto-continue through it once the current task finishes cleanly,
 * instead of leaving the user to manually re-prompt for every remaining
 * chunk. Deliberately separate from resumeState.ts: that file is scoped to
 * ONE in-flight task's own phase/repair progress and is overwritten whole
 * every task, whereas this backlog spans many tasks and is only ever
 * read-modify-written (popped from, or appended to).
 */

import fs from "fs";
import path from "path";

function taskQueuePath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "task-queue.json");
}

/** Replaces the saved backlog outright. An empty list deletes the file
 *  rather than leaving a stale `{"items":[]}` around. */
export function saveTaskQueue(repoRoot: string, items: string[]): void {
  const clean = items.map((s) => s.trim()).filter(Boolean);
  try {
    const file = taskQueuePath(repoRoot);
    if (clean.length === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    const dir = path.join(repoRoot, ".agent");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items: clean }, null, 2), "utf-8");
  } catch {}
}

/** The backlog in run order; `[]` when nothing is queued or the file is
 *  missing/unreadable. */
export function loadTaskQueue(repoRoot: string): string[] {
  const file = taskQueuePath(repoRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed?.items)) return [];
    return parsed.items.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0);
  } catch {
    return [];
  }
}
