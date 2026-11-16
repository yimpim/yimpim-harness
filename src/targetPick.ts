/**
 * When an Editor has stalled twice and the one re-plan is spent, somebody has
 * to say exactly where the change goes. It used to be the user, asked "which
 * file path should be targeted?". They cannot answer: they never saw what the
 * Editor read or why it froze. The Planner can, because it can read the code.
 *
 * So the Planner steps in with a read-only pass and answers with the exact
 * file, the exact section, and the exact change, concrete enough to apply with
 * no further investigation. Its answer is accepted only if it names a file that
 * exists (or a new file in a folder that does), so a vague or invented answer
 * fails the phase cleanly instead of sending the Editor off to stall again.
 * Nobody is asked anything.
 */
import fs from "fs";
import path from "path";
import { isSourceCodePath } from "./focusTests.js";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Files the Editor read that are real, existing source files (not tests, docs, folders). */
export function candidateTargets(inspected: string[], repoRoot: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of inspected) {
    const rel = norm(raw.trim());
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    // "search:..." entries and other non-paths
    if (/^(search|grep|list|outline):/i.test(rel) || /\s/.test(rel)) continue;
    if (!isSourceCodePath(rel)) continue;
    try {
      const full = path.resolve(repoRoot, rel);
      if (!full.startsWith(path.resolve(repoRoot))) continue;
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(rel);
    if (out.length >= limit) break;
  }
  return out;
}

/** What the Planner is asked when the Editor is stuck. */
export function buildStallDirectivePrompt(phaseGoal: string, failure: string, readFiles: string[]): string {
  return `An engineer (the Editor) was given the task below, read several files, and never made a single change. You are the Planner and you are stepping in. You can read files.

The engineer cannot ask questions and neither can you. Do NOT ask the user anything and do not ask for more information: decide, from the code, and say exactly where the change goes.

Task:
${phaseGoal.slice(0, 3500)}

Why the engineer stopped:
${failure.slice(0, 500)}

Files they already read (start there; you may read others):
${readFiles.length > 0 ? readFiles.map((f) => `- ${f}`).join("\n") : "(none that were source files)"}

Answer with, for each file that must change (at most 3):
  FILE: the exact path (an existing file, or a new file in a folder that exists).
  SECTION: the exact place in it: the function, component or symbol, and the line range you read.
  CHANGE: precisely what to change there and what it must become, concrete enough to apply with no further investigation.
Read a file before you point at it. Never name a section you have not read. If the change is already in the code, say that and name the lines that show it.`;
}

export interface NamedTarget {
  path: string;
  exists: boolean;
}

/**
 * The files an answer actually names: ones that exist, or new source files in a
 * folder that does. Anything else (a path outside the project, a made-up
 * folder, prose that merely looks like a filename) is ignored.
 */
export function namedTargets(text: string, repoRoot: string): NamedTarget[] {
  const root = path.resolve(repoRoot);
  const seen = new Set<string>();
  const out: NamedTarget[] = [];
  for (const m of text.matchAll(/[\w@./\\-]+\.[A-Za-z0-9]{1,8}/g)) {
    const rel = norm(m[0]).replace(/[.,;:)]+$/, "");
    if (!rel || seen.has(rel) || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
    seen.add(rel);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root)) continue;
    try {
      if (fs.statSync(full).isFile()) {
        out.push({ path: rel, exists: true });
        continue;
      }
    } catch {}
    try {
      if (isSourceCodePath(rel) && fs.statSync(path.dirname(full)).isDirectory()) out.push({ path: rel, exists: false });
    } catch {}
  }
  return out;
}

/** The Planner's answer, as the binding instruction the Editor is re-run with. */
export function renderPlannerDirective(plan: string, targets: NamedTarget[]): string {
  return (
    `PLANNER DIRECTIVE — the Editor stalled without making a change, so the Planner read the code and decided exactly what to change.\n` +
    `Target file(s): ${targets.map((t) => (t.exists ? t.path : `${t.path} (new file)`)).join(", ")}\n` +
    `Inspect the named file(s) FIRST, make the change described below, and do not return without an edit to them: reasoning or exploration alone will not satisfy this phase.\n\n` +
    plan.trim()
  );
}
