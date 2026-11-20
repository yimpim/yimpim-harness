/**
 * A write-ahead record for a trial edit. The file on disk is always the best state so far, except for the moment a trial edit is written to be run
 * and, if it turns out worse, undone. If the process is killed in that moment (a memory kill, a closed terminal) the file would be left holding an
 * edit that was never judged. Before a trial the best state is saved; after the decision the record is removed; and the next heal of that file
 * puts the best state back if it finds a record whose trial is still what is on disk. A file the person has edited since is never touched.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const recordPath = (repoRoot: string, file: string) => path.join(repoRoot, ".agent", "heal-pending", `${sha(file.replace(/\\/g, "/")).slice(0, 24)}.json`);

export function beginTrial(repoRoot: string, file: string, best: string, trial: string): void {
  try {
    const p = recordPath(repoRoot, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ file, best, trialHash: sha(trial) }));
  } catch {
    // a checkpoint is a safety net, never a reason to stop healing
  }
}

export function endTrial(repoRoot: string, file: string): void {
  try {
    fs.rmSync(recordPath(repoRoot, file), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** If a trial was interrupted and its edit is still what is on disk, put the best state back. True when it did. */
export function recoverTrial(repoRoot: string, file: string): boolean {
  const p = recordPath(repoRoot, file);
  try {
    if (!fs.existsSync(p)) return false;
    const rec = JSON.parse(fs.readFileSync(p, "utf8")) as { best?: string; trialHash?: string };
    const abs = path.join(repoRoot, file);
    const onDisk = fs.readFileSync(abs, "utf8");
    fs.rmSync(p, { force: true });
    if (typeof rec.best !== "string" || sha(onDisk) !== rec.trialHash) return false;
    fs.writeFileSync(abs, rec.best);
    return true;
  } catch {
    return false;
  }
}
