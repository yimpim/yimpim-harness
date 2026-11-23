/**
 * A phase that only writes a test which is MEANT to fail ("write a failing test first", "fails on the unpatched code", "red baseline") can never
 * pass: QA treats every failing test as blocking, and the fix lives in a later phase's files, which this phase's repair may not touch. A real
 * 9-phase run lost its whole repair budget, and four diagnosis passes, on exactly that: phase 7 wrote a correct, red 29-case reducer test, QA
 * failed it, repair stalled four times, and the revert set the test aside.
 *
 * So such a phase is folded into the phase after it, deterministically, whatever the planner wrote: the merged phase writes the test first and
 * then the fix, and is verified green as one unit. The planner prompt asks for this too; this is what holds when a model ignores it.
 */

import { isTestPath } from "./focusTests.js";
import type { PlannedPhase } from "./planner.js";

/** Wording that says a check or change expects a test to FAIL. Read from verification bullets and changes only, never from prose elsewhere. */
const EXPECTS_FAILURE =
  /\bred[- ]baseline\b|\b(?:should|must|will|to)\s+fail\b|\bexpected\s+to\s+fail\b|\bfail(?:s|ing)?\s+(?:on|against)\s+the\s+(?:unpatched|unfixed|unmodified|current|existing|original)\b|\bfails?\s+(?:first|initially|before\s+the\s+fix)\b|\bstill\s+fails?\s+until\b/i;

/** A goal that says the phase writes a failing test on purpose. */
const RED_TEST_GOAL = /\b(?:write|add|create)\s+(?:a\s+|the\s+)?(?:new\s+)?failing\b[^.]{0,40}\btests?\b|\btest[- ]first\b|\bred[- ]baseline\b/i;

export function expectsFailure(text: string): boolean {
  return EXPECTS_FAILURE.test(text);
}

const phaseFiles = (p: PlannedPhase): string[] => Array.from(new Set([...(p.files ?? []), ...(p.newFiles ?? [])]));

/** Only test files, and it says (in a check, a change, or its goal) that the test is meant to fail. */
export function isRedTestPhase(p: PlannedPhase): boolean {
  const files = phaseFiles(p);
  if ((p.executor ?? "EDITOR") !== "EDITOR" || files.length === 0 || !files.every(isTestPath)) return false;
  return (p.verification ?? []).some(expectsFailure) || (p.changes ?? []).some(expectsFailure) || RED_TEST_GOAL.test(p.goal ?? "");
}

const union = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]));

function mergeContracts(a: PlannedPhase["contracts"], b: PlannedPhase["contracts"]): PlannedPhase["contracts"] {
  if (!a) return b;
  if (!b) return a;
  const pick = (c: any, k: "signatures" | "types" | "constraints"): string[] => (Array.isArray(c?.[k]) ? c[k] : []);
  return { signatures: union(pick(a, "signatures"), pick(b, "signatures")), types: union(pick(a, "types"), pick(b, "types")), constraints: union(pick(a, "constraints"), pick(b, "constraints")) } as any;
}

/** One phase: the red test's files and work first, then the fix, keeping the fix phase's id and name. Checks that expect failure are dropped. */
export function mergeRedIntoNext(red: PlannedPhase, next: PlannedPhase): PlannedPhase {
  const contracts = mergeContracts(red.contracts, next.contracts);
  return {
    ...next,
    executor: "EDITOR",
    goal: `${next.goal} This phase also writes the test the previous step described, first, and it must pass by the end: ${red.goal}`,
    files: union(phaseFiles(red), next.files),
    newFiles: union(red.newFiles, next.newFiles),
    changes: [
      ...(red.changes ?? []).filter((c) => !expectsFailure(c)),
      "Write that test first, then make the production change below; the test is verified passing with the fix, in this same phase.",
      ...(next.changes ?? []),
    ],
    verification: [...(red.verification ?? []).filter((v) => !expectsFailure(v)), ...(next.verification ?? [])],
    ...(contracts ? { contracts } : {}),
  };
}

export interface RedTestMerge {
  /** The folded-away phase. */
  from: { id: string; name: string };
  /** The phase it now belongs to (its id is kept). */
  into: { id: string; name: string };
}

/**
 * Folds every red-test phase into the phase after it. `done` holds ids already completed (a resumed plan): a phase in it is never merged, and
 * never merged into, since it will not run again. A red-test phase with no later phase to join is left as it is.
 */
export function mergeRedTestPhases(phases: PlannedPhase[], done: ReadonlySet<string> = new Set()): { phases: PlannedPhase[]; merges: RedTestMerge[] } {
  const out = [...phases];
  const merges: RedTestMerge[] = [];
  for (let i = 0; i < out.length - 1; ) {
    const red = out[i];
    const next = out[i + 1];
    if (!done.has(red.id) && !done.has(next.id) && (next.executor ?? "EDITOR") === "EDITOR" && isRedTestPhase(red)) {
      out.splice(i, 2, mergeRedIntoNext(red, next));
      merges.push({ from: { id: red.id, name: red.name }, into: { id: next.id, name: next.name } });
      continue; // the merged phase may itself still be red-only (two test steps in a row): look at it again
    }
    i++;
  }
  return { phases: out, merges };
}

export function describeRedTestMerge(m: RedTestMerge): string {
  return `[PLANNER] Merged "${m.from.name}" into "${m.into.name}": a phase that only writes a failing test cannot pass on its own, so the test and its fix are one phase.`;
}
