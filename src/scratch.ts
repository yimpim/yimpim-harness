/**
 * Scratch files: the one-off reports, summaries and helper scripts an agent makes while it works on something (a test report it parses, a
 * script that prints counts). They are not part of the project, so they must never be committed and should not outlive the task.
 *
 *  - They live in .agent/tmp/. A new file an agent writes under a scratch name at the project root is put there instead, and the agent is told.
 *  - .agent/ is the harness's own folder and is never committed.
 *  - When a task ends, .agent/tmp/ is emptied, and untracked scratch-named files that appeared at the project root during the session
 *    (a report a tool wrote with --outputFile, say) are removed. A file the project already tracks is never touched.
 *
 * The names are matched at the project root only, and narrowly, so a real file such as docs/summary.md or src/reportCard.tsx is never taken for one.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const SCRATCH_DIR = ".agent/tmp";

const ROOT_SCRATCH: RegExp[] = [/^\.(jest|tmp|scratch)/i, /^(jest|scratch|tmp)[-_]/i];

const norm = (rel: string) => rel.replace(/\\/g, "/").replace(/^\.\//, "");

/** True for a file that belongs in the scratch folder, wherever it is now. */
export function isScratchPath(rel: string): boolean {
  const p = norm(rel);
  if (p === SCRATCH_DIR || p.startsWith(`${SCRATCH_DIR}/`)) return true;
  if (/(^|\/)zz_probe_/.test(p)) return true;
  return !p.includes("/") && ROOT_SCRATCH.some((re) => re.test(p));
}

/** Where a NEW file written to `rel` should go instead, when it is scratch at the project root. */
export function scratchTarget(rel: string): string | undefined {
  const p = norm(rel);
  if (p.includes("/") || p.startsWith("..") || !isScratchPath(p)) return undefined;
  return `${SCRATCH_DIR}/${p}`;
}

function tracked(repoRoot: string, rel: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the scratch files of a finished task. Returns what was removed (relative paths).
 * `since` is when the session started: a scratch-named file at the root older than that was there before the harness began.
 */
export function cleanScratch(repoRoot: string, created: Iterable<string> = [], since = Date.now()): string[] {
  const removed: string[] = [];
  const drop = (rel: string) => {
    try {
      fs.rmSync(path.join(repoRoot, rel), { recursive: true, force: true });
      removed.push(rel);
    } catch {
      /* a file in use is left; it is cleaned at the end of the next task */
    }
  };
  try {
    for (const e of fs.readdirSync(path.join(repoRoot, SCRATCH_DIR))) drop(`${SCRATCH_DIR}/${e}`);
  } catch {
    /* no scratch folder */
  }
  const candidates = new Set<string>();
  for (const c of created) if (isScratchPath(norm(c)) && !norm(c).startsWith(`${SCRATCH_DIR}/`)) candidates.add(norm(c));
  try {
    for (const e of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!e.isFile() || !isScratchPath(e.name)) continue;
      try {
        if (fs.statSync(path.join(repoRoot, e.name)).mtimeMs >= since) candidates.add(e.name);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* unreadable root */
  }
  for (const rel of candidates) if (fs.existsSync(path.join(repoRoot, rel)) && !tracked(repoRoot, rel)) drop(rel);
  return removed;
}
