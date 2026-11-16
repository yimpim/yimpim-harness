/**
 * What the earlier phases of this task actually did, handed to the next one.
 *
 * Every phase's brief is written from the plan, before any code existed. By
 * phase 4 the plan can name a file that phase 2 renamed or a function phase 3
 * moved, and the Editor then spends its turns finding where things went. The
 * code on disk is the truth, and the Editor reads it, but the brief is what
 * tells it where to look first.
 *
 * So after each phase passes, the harness (no model) records what changed: the
 * files, any symbol that moved and where to, anything the Editor reported doing
 * differently from the plan, and anything QA could not verify. The next phase's
 * instructions carry the last few of these.
 *
 * It lives inside `.agent/last-plan.json`, which is rewritten whole for each new
 * task, so it cannot accumulate across tasks and needs no file of its own. It is
 * kept so a `--resume` still knows what the committed phases did.
 */

export interface PhaseProgress {
  phaseId: string;
  name: string;
  /** Files this phase changed, as git saw them. */
  files: string[];
  moved: { symbol: string; from: string; to: string }[];
  renamed: { from: string; to: string }[];
  removed: string[];
  added: string[];
  /** Assertions the Editor reported changing, dropping or being unable to confirm here. */
  differs: { id: string; action: string; reason: string }[];
  /** States QA could not reach, with the cause. */
  unverified: string[];
  /** Set when the Editor found the behavior already implemented and changed nothing. */
  alreadyDone?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A phase's record, with every list bounded so a large phase cannot flood the next brief. */
export function buildPhaseProgress(input: {
  phaseId: string;
  name: string;
  files: string[];
  sync?: {
    moved: { symbol: string; from: string; to: string }[];
    renamed: { from: string; to: string }[];
    removed: string[];
    added: string[];
  };
  deltas?: { id: string; action: string; reason: string }[];
  unverified?: string[];
  alreadyDone?: string;
}): PhaseProgress {
  return {
    phaseId: input.phaseId,
    name: clip(input.name, 100),
    files: [...new Set(input.files.map((f) => f.replace(/\\/g, "/")))].slice(0, 14),
    moved: (input.sync?.moved ?? []).slice(0, 8),
    renamed: (input.sync?.renamed ?? []).slice(0, 6),
    removed: (input.sync?.removed ?? []).slice(0, 6),
    added: (input.sync?.added ?? []).slice(0, 6),
    differs: (input.deltas ?? []).slice(0, 6).map((d) => ({ id: d.id, action: d.action, reason: clip(d.reason, 160) })),
    unverified: (input.unverified ?? []).slice(0, 4).map((u) => clip(u, 200)),
    ...(input.alreadyDone ? { alreadyDone: clip(input.alreadyDone, 200) } : {}),
  };
}

function renderOne(p: PhaseProgress): string {
  const lines: string[] = [];
  lines.push(`- "${p.name}": ${p.files.length > 0 ? `changed ${p.files.join(", ")}` : "changed no files"}.`);
  const where: string[] = [
    ...p.moved.map((m) => `${m.symbol} moved from ${m.from} to ${m.to}`),
    ...p.renamed.map((r) => `${r.from} is now ${r.to}`),
    ...p.removed.map((f) => `${f} was deleted`),
    ...p.added.map((f) => `${f} was added`),
  ];
  if (where.length > 0) lines.push(`    where things are now: ${where.join("; ")}.`);
  if (p.differs.length > 0) lines.push(`    done differently from the plan: ${p.differs.map((d) => `[${d.id}] ${d.action} (${d.reason})`).join("; ")}.`);
  if (p.unverified.length > 0) lines.push(`    QA could not verify: ${p.unverified.join("; ")}.`);
  if (p.alreadyDone) lines.push(`    already implemented, nothing changed: ${p.alreadyDone}.`);
  return lines.join("\n");
}

/**
 * The note for the next phase's brief; empty when there is nothing to say. The
 * most recent phases win when it has to be cut, since they are the ones the
 * code on disk reflects last.
 */
export function renderProgressNote(done: PhaseProgress[], maxChars = 2400): string {
  if (done.length === 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const block = renderOne(done[i]);
    if (used + block.length > maxChars && kept.length > 0) break;
    kept.unshift(block);
    used += block.length;
  }
  const omitted = done.length - kept.length;
  return (
    `\n\nWHAT HAS CHANGED SO FAR IN THIS TASK (the earlier phases are finished and committed; this brief was written before they ran, so where it ` +
    `disagrees with this, this is right):\n` +
    (omitted > 0 ? `(${omitted} earlier phase(s) not shown)\n` : "") +
    `${kept.join("\n")}\n` +
    `If this phase names a file or function that moved, was renamed or was deleted, use where it is now. The code on disk is the final word.`
  );
}
