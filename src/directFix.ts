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

const mustPass = new Set<string>();

/** The test files the fix in progress is FOR: they are expected to be red now and must be green after, so they are not excused as "already failing". */
export function setMustPass(files: string[]): void {
  mustPass.clear();
  for (const f of files) mustPass.add(f.replace(/\\/g, "/"));
}

/** True while a fix for failing tests is in progress: those tests are the spec, so a change must satisfy them and not bend them. */
export function anyMustPass(): boolean {
  return mustPass.size > 0;
}

export function isMustPass(file: string): boolean {
  return mustPass.has(file.replace(/\\/g, "/"));
}
