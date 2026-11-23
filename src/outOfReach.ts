/**
 * A failure repair cannot fix from inside this phase: every failing test is one this phase wrote, what those tests exercise is production code
 * the plan gives to a LATER phase, and a repair attempt has just made no edit at all. Each further attempt can only repeat that (repair may not
 * touch the later phase's files), so the phase stops after one attempt and says where the fix belongs, instead of spending the rest of its
 * repair budget, and a diagnosis pass before each attempt, on it. A real run spent four attempts and four diagnoses this way.
 */

import { isTestPath } from "./focusTests.js";

export interface LaterPhase {
  name: string;
  files: string[];
}

export interface OutOfReachInput {
  failures: { tier: string; gate: string; detail: string }[];
  /** Test files this phase created (not in HEAD before it, written by the agent). */
  createdTestFiles: string[];
  /** The files this phase may change. */
  allowedPaths: string[];
  /** The phases after this one, in order. */
  laterPhases: LaterPhase[];
  /** Repo-relative files a test file imports (only its relative imports that resolve). */
  importsOf: (testFile: string) => string[];
  /** Whether the repair attempt that just ran wrote anything. */
  repairEdited: boolean;
}

export interface OutOfReach {
  /** The failing tests, all written by this phase. */
  testFiles: string[];
  /** The production file the fix belongs in. */
  target: string;
  /** The later phase that owns it. */
  owner: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
/** Same file, allowing one side to be a suffix of the other (a runner may print a path from a different root). */
const samePath = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
};

/** Path-like tokens in failure text that name a test file. */
function testPathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w@.\/\\-]+\.[A-Za-z0-9]{1,6}/g)) {
    const p = m[0].replace(/\\/g, "/").replace(/^\.\//, "");
    if (isTestPath(p)) out.add(p);
  }
  return [...out];
}

export function failureOutOfReach(input: OutOfReachInput): OutOfReach | undefined {
  if (input.repairEdited || input.failures.length === 0 || input.createdTestFiles.length === 0 || input.laterPhases.length === 0) return undefined;

  // Every failure must name a test, and every test it names must be one this phase created.
  const failing = new Set<string>();
  for (const f of input.failures) {
    const named = testPathsIn(f.detail);
    if (named.length === 0) return undefined;
    for (const t of named) {
      const created = input.createdTestFiles.find((c) => samePath(c, t));
      if (!created) return undefined;
      failing.add(created);
    }
  }

  // What those tests point at: later-phase files the failure text names, then what the failing tests import.
  const details = input.failures.map((f) => f.detail).join("\n");
  const laterFiles = input.laterPhases.flatMap((p) => p.files);
  const candidates = [
    ...laterFiles.filter((f) => norm(details).includes(norm(f))),
    ...[...failing].flatMap((t) => input.importsOf(t)),
  ];
  for (const c of candidates) {
    if (isTestPath(c) || input.allowedPaths.some((a) => samePath(a, c))) continue;
    const owner = input.laterPhases.find((p) => p.files.some((f) => samePath(f, c)));
    if (owner) return { testFiles: [...failing], target: owner.files.find((f) => samePath(f, c)) ?? c, owner: owner.name };
  }
  return undefined;
}

export function describeOutOfReach(r: OutOfReach, attemptsLeft: number): string[] {
  const tests = r.testFiles.join(", ");
  return [
    `⛔ [OUT OF REACH] Every failure is in ${tests}, which this phase wrote, and what it tests is in ${r.target},`,
    `   which the plan gives to a later phase ("${r.owner}"). Repair may not change that file here and made no edit,`,
    `   so the remaining ${attemptsLeft} attempt(s) would only repeat this. Stopping now.`,
    `   The test and its fix belong in one phase: re-plan, or ask for this test and the change to ${r.target} together.`,
  ];
}
