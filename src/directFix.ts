/**
 * A fix for a DIAGNOSED defect goes straight to the Editor.
 *
 * When a test fails because the code is wrong, healing has already done the investigation: it read the failing output, found the cause,
 * and named the code and the line. Handing that to a Discovery stage and a Planner meant re-discovering it from scratch with a larger
 * model, then writing a plan for it; a 3-line fix took five minutes and tens of thousands of tokens of planning and still came back
 * unreadable. The diagnosis already says what the plan would say, so the plan is built from it: one phase per failing test file, the code
 * it names as the files, the diagnosis as the change, and "that test file passes" as the check.
 *
 * Nothing here knows a language or a framework. If the diagnosis names no code file that exists, there is nothing to start from and the
 * normal Discovery and Planner run as before.
 */

import fs from "fs";
import path from "path";
import { userNamedFiles } from "./userFiles.js";
import { isTestPath } from "./focusTests.js";
import { statsOf } from "./benchScore.js";
import { lineOfTest, testTitleOf, testBlockEnd } from "./testNames.js";

export interface FixItem {
  file: string;
  reason: string;
}

/** The items of a fix task ("1. path: diagnosis\n   How it fails:\n   ..."). */
export function parseFixTask(text: string): FixItem[] {
  const out: FixItem[] = [];
  const starts = [...text.matchAll(/^(\d+)\. (\S+?): /gm)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? text.length) : text.length;
    const reason = text
      .slice(from, to)
      .split(/\n\s+How it fails:/)[0]
      .trim();
    if (m[2] && reason) out.push({ file: m[2], reason });
  }
  return out;
}

const DEPENDENCY = /(^|\/)(node_modules|\.git|site-packages|dist-packages)(\/|$)/;

/** The project's own code a piece of text names: files that exist, are not tests, and are not dependencies. */
function codeFilesNamed(text: string, repoRoot: string): string[] {
  return userNamedFiles(text, repoRoot).filter((f) => !isTestPath(f) && !DEPENDENCY.test(f) && fs.existsSync(path.join(repoRoot, f)));
}

export interface DirectFix {
  /** What Discovery would have written: the files to work in. */
  discovery: string;
  /** The plan, as the JSON the Planner would have returned. */
  plan: string;
  /** The test files that must pass for the fix to count. */
  tests: string[];
  /** The code files named across all items. */
  files: string[];
}

export function directFixFor(instructions: string, repoRoot: string): DirectFix | undefined {
  const items = parseFixTask(instructions);
  if (items.length === 0) return undefined;
  const all = [...new Set(items.flatMap((i) => codeFilesNamed(i.reason, repoRoot)))];
  if (all.length === 0) return undefined;

  const phases = items.map((item, n) => {
    const own = codeFilesNamed(item.reason, repoRoot);
    return {
      id: `phase-${n + 1}`,
      name: `Fix the code so ${path.basename(item.file)} passes`,
      goal:
        `Fix the CODE so every test in ${item.file} passes. Its assertions are right: never edit, skip, delete or loosen one. ` +
        `The one thing you may change in a test is a MOCK or setup that your change now makes out of date: if another test's jest.mock of a module ` +
        `lacks a function your code now calls, add it there (keep the real module underneath with requireActual), because a change owes the mocks of ` +
        `what it changed an update. Check who else mocks a module before you start calling more of it.`,
      executor: "EDITOR",
      files: own.length > 0 ? own : all,
      newFiles: [] as string[],
      changes: [
        `Fix what the diagnosis found. Read the lines it cites first, and change the code, not the test: ${item.reason.slice(0, 1800)}`,
      ],
      verification: [`${item.file} passes: run it, and no test in it fails`],
    };
  });
  const plan = {
    goal: `Fix the code so ${items.map((i) => i.file).join(", ")} pass${items.length === 1 ? "es" : ""}. They fail because the code is wrong (diagnosed from their failing output), not because they are out of date.`,
    assumptions: [] as string[],
    clarifyingQuestions: [] as string[],
    suggestedBranch: null,
    phases,
  };
  const discovery = [
    "```json",
    JSON.stringify(
      {
        taskFindings: {
          summary: "A failing test was diagnosed as a defect in the code. The diagnosis names the files; no search was needed.",
          existingFiles: all.map((p) => ({ path: p, reason: "named by the diagnosis of the failing test" })),
        },
        uncertainties: [],
      },
      null,
      2
    ),
    "```",
  ].join("\n");
  return { discovery, plan: JSON.stringify(plan), tests: items.map((i) => i.file), files: all };
}

// ---------------------------------------------------------------------------------------------------------------------------- must pass

// The tests a fix is FOR are its spec, so a fix must not make them pass by changing what they check. But the Editor has to be free to change the test FILE
// around them: fixing a bug can change a hook's signature or need a new mock, and in a 3,500-line file the mocks and helpers are shared by every test in it,
// so a lock on the whole file would turn a clean fix into a dead end (the app fixed, a hundred tests red, the one file that could repair them off limits).
// What is locked is only what the failing tests ASSERT. Setup, mocks, helpers, imports and new tests are free. Only a fix task has any of this: an ordinary
// task (add a feature, remove login) sets an empty list, and nothing is locked.

/** What was locked in one failing test: its name as the runner printed it, and the assertion lines inside its block, as they were when the fix began. */
interface LockedBlock {
  name: string;
  expects: string[];
}

/** One must-pass test file as it was when the fix began. */
interface MustPassFile {
  rel: string;
  /** Its text then; null when it could not be read (nothing can be compared). */
  text: string | null;
  locked: LockedBlock[];
}

/** The test files the fix is FOR, keyed lower-case (a Windows file system does not tell `A.test.ts` from `a.test.ts`). */
const mustPass = new Map<string, MustPassFile>();

const keyOf = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const ASSERTION = /\bexpect\s*\(|\bassert\w*\s*[.(]|\bself\.assert/;
const normalizeLine = (l: string) => l.trim().replace(/\s+/g, " ").replace(/[;,]+$/, "");
const onlyCount = (s: string) => (s.match(/\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/g) ?? []).length;
const tally = (items: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};
/** The normalised assertion lines of the test block that starts at `idx`. */
const assertionsIn = (lines: string[], idx: number): string[] => lines.slice(idx, testBlockEnd(lines, idx) + 1).filter((l) => ASSERTION.test(l)).map(normalizeLine);

/**
 * The test files the fix in progress is FOR: they are expected to be red now and must be green after, so they are not excused as "already failing".
 * With the project's root, each file's text is remembered, and with the NAMES of its failing tests (as the runner prints them) the assertions inside those
 * tests are locked: see lockedProblem. Without names, the file's assertion count is what may not drop.
 */
export function setMustPass(files: string[], repoRoot?: string, opts: { failing?: Record<string, string[]> | Map<string, string[]> } = {}): void {
  mustPass.clear();
  const failingOf = (rel: string): string[] => {
    const f = opts.failing;
    if (!f) return [];
    return (f instanceof Map ? f.get(rel) : f[rel]) ?? [];
  };
  for (const f of files) {
    const rel = f.replace(/\\/g, "/").replace(/^\.\//, "");
    let text: string | null = null;
    if (repoRoot) {
      try {
        text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      } catch {
        text = null;
      }
    }
    const locked: LockedBlock[] = [];
    if (text !== null) {
      const lines = text.split(/\r?\n/);
      for (const name of failingOf(rel)) {
        const idx = lineOfTest(lines, name);
        if (idx >= 0) locked.push({ name, expects: assertionsIn(lines, idx) });
      }
    }
    mustPass.set(keyOf(rel), { rel, text, locked });
  }
}

/** True while a fix for failing tests is in progress: those tests are the spec, so a change must satisfy them and not bend them. */
export function anyMustPass(): boolean {
  return mustPass.size > 0;
}

export function isMustPass(file: string): boolean {
  return mustPass.has(keyOf(file));
}

/**
 * Why `newText` is not an acceptable version of a must-pass test file, or undefined when it is. A test file may change around the failing tests (setup, mocks,
 * helpers, imports, new tests added) but not in what they check:
 *  - no test may disappear (the count of it/test may not drop), none may be skipped, none narrowed with .only;
 *  - every assertion line inside a failing test's block must still be there, unchanged;
 *  - a failing test may not be renamed or removed;
 *  - when no failing test is named, the number of expect(...) in the file may not drop.
 * Anything else is allowed, so that a fix which changes a signature or needs a mock is never trapped behind a locked file.
 */
export function lockedProblem(file: string, newText: string): string | undefined {
  const s = mustPass.get(keyOf(file));
  if (!s || s.text === null) return undefined;
  const was = statsOf(s.text);
  const now = statsOf(newText);
  // skipped and narrowed first: `it.skip(` and `it.only(` also fall out of the test count, and would be reported as a test that was removed
  if (now.skips > was.skips) return "it skips tests that were running";
  if (onlyCount(newText) > onlyCount(s.text)) return "it narrows the file to some tests with .only";
  if (now.tests < was.tests) return `it has ${now.tests} tests where the file had ${was.tests} when the fix began (a test was removed)`;
  const lines = newText.split(/\r?\n/);
  for (const blk of s.locked) {
    const title = testTitleOf(blk.name);
    const idx = lineOfTest(lines, blk.name);
    if (idx < 0) return `the failing test "${title}" is no longer in the file (it was renamed or removed)`;
    const have = tally(assertionsIn(lines, idx));
    for (const [line, n] of tally(blk.expects)) {
      if ((have.get(line) ?? 0) < n) return `an assertion in the failing test "${title}" was changed or removed: ${line.slice(0, 140)}`;
    }
  }
  if (s.locked.length === 0 && now.asserts < was.asserts) return `it has ${now.asserts} expect(...) calls where the file had ${was.asserts} when the fix began`;
  return undefined;
}

const LOCK_HELP =
  "The failing tests' own assertions are the spec for this fix and must stay exactly as written. The file's mocks, setup, helpers and imports may be updated, and new tests added.";

/** The message a refused edit gets, so the Editor knows exactly what it may not do and what it still may. */
export function refusalFor(file: string, problem: string): string {
  return `[MUST PASS] ${file}: ${problem}. ${LOCK_HELP} Change the CODE it tests, or keep to the setup around the tests.`;
}

/**
 * The QA findings that back up the edit-time refusal (a test can also be changed by a command, or by a tool that has no guard), each blocking:
 *  - a must-pass file that now breaks the rules above, or is gone;
 *  - when `appChanged` is false (the change set is known and holds no application code): a fix that changed no code, so a test that passes now passes because
 *    the TEST changed, not because the bug was fixed. `appChanged` undefined means it is not known, and nothing is claimed.
 */
export function mustPassFindings(repoRoot: string, appChanged?: boolean): string[] {
  const out: string[] = [];
  for (const s of mustPass.values()) {
    if (s.text === null) continue;
    let now: string;
    try {
      now = fs.readFileSync(path.join(repoRoot, s.rel), "utf8");
    } catch {
      out.push(`${s.rel} is gone: it was deleted while fixing the code it tests. It is the spec for this fix and must pass as written (git checkout -- ${s.rel}).`);
      continue;
    }
    const problem = lockedProblem(s.rel, now);
    if (problem) out.push(`${s.rel}: ${problem}. ${LOCK_HELP} Put the assertions back (git diff ${s.rel} shows what changed) and change the CODE instead.`);
  }
  if (mustPass.size > 0 && appChanged === false) {
    out.push("no application code was changed. A test that passes now would pass because the TEST was changed, not because the bug was fixed: fix the code the diagnosis names.");
  }
  return out;
}

/** The must-pass test files whose text now differs from what it was when the fix began, with both texts. */
export function changedMustPassTexts(repoRoot: string): { file: string; original: string; current: string }[] {
  const out: { file: string; original: string; current: string }[] = [];
  for (const s of mustPass.values()) {
    if (s.text === null) continue;
    let current: string;
    try {
      current = fs.readFileSync(path.join(repoRoot, s.rel), "utf8");
    } catch {
      continue;
    }
    if (current !== s.text) out.push({ file: s.rel, original: s.text, current });
  }
  return out;
}

/** The lines that differ between two versions of a file, as "- removed" and "+ added", for a person to review. Blank lines are not shown; at most `max`. */
export function reviewDiff(before: string, after: string, max = 14): string[] {
  const a = tally(before.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const b = tally(after.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const out: string[] = [];
  for (const [l, n] of a) for (let i = 0; i < Math.max(0, n - (b.get(l) ?? 0)); i++) out.push(`- ${l.slice(0, 150)}`);
  for (const [l, n] of b) for (let i = 0; i < Math.max(0, n - (a.get(l) ?? 0)); i++) out.push(`+ ${l.slice(0, 150)}`);
  return out.length > max ? [...out.slice(0, max), `… and ${out.length - max} more changed lines`] : out;
}

/**
 * Runs a test file as it was BEFORE the fix, against the code as it is now: the original is written beside the real one under a name the test listing
 * skips (zz_probe_), run, and removed. Passing means the code fix stands on its own; failing means the Editor's version of the file needed setup changes
 * for the fix to work, which a person should look at (a flag, not a failure). Nothing in the project is left behind.
 */
export async function runOriginalCopy(
  run: (root: string, files: string[]) => Promise<{ ok: boolean; output: string }>,
  repoRoot: string,
  file: string,
  originalText: string
): Promise<{ ok: boolean; output: string }> {
  const rel = file.replace(/\\/g, "/");
  const copyRel = `${path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel) + "/"}zz_probe_original_${Date.now().toString(36)}_${path.posix.basename(rel)}`;
  const copyAbs = path.join(repoRoot, copyRel);
  try {
    fs.writeFileSync(copyAbs, originalText);
    return await run(repoRoot, [copyRel]);
  } finally {
    try {
      fs.rmSync(copyAbs, { force: true });
    } catch {
      // a leftover copy is skipped by the test listing
    }
  }
}
