/**
 * Persisted note about the most recent task that genuinely FAILED
 * (.agent/last-failure.json) — not a user-initiated Stop/abort, a real
 * TaskFailedError (repair budget exhausted, no-progress, escalation
 * declined, ...).
 *
 * A fresh follow-up instruction ("continue", "next screen", a vague
 * re-prompt) starts brand-new Discovery/Planning with no automatic link to
 * what the LAST task's own failure actually was — that context only ever
 * survived in `.agent/last-plan.json`'s phaseRepairContext, which is scoped
 * to `--resume`/`/continue` resuming that exact interrupted plan, not to a
 * new instruction starting fresh. Without this, a user who types "fix the
 * bugs that aborted last time, then continue progress.md" is trusting the
 * planner to infer a bug it has no actual record of; the planner usually
 * just picks up the explicit "continue" part instead.
 *
 * Deliberately ephemeral: surfaced to planning once, and cleared the moment
 * SOME task later completes cleanly — not kept around indefinitely, and not
 * tied to verifying the specific defect was really fixed (this app has no
 * reliable way to know that from outside the task that caused it). A clean
 * completion afterward is the simplest honest signal "whatever that was is
 * no longer blocking things," without this nagging every future task
 * forever off one old failure.
 */

import fs from "fs";
import path from "path";

export interface LastFailureInfo {
  taskId: string;
  /** The same human-readable summary already shown to the user at the time
   *  (TaskFailedError's own message) — no separate diagnosis, just reuse of
   *  what was already computed and already true. */
  reason: string;
  at: string;
}

function lastFailurePath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "last-failure.json");
}

export function saveLastFailure(repoRoot: string, info: LastFailureInfo): void {
  try {
    const dir = path.join(repoRoot, ".agent");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lastFailurePath(repoRoot), JSON.stringify(info, null, 2), "utf-8");
  } catch {}
}

export function loadLastFailure(repoRoot: string): LastFailureInfo | null {
  const file = lastFailurePath(repoRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function clearLastFailure(repoRoot: string): void {
  try {
    const file = lastFailurePath(repoRoot);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}
