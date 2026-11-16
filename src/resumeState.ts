/**
 * Persisted resume state (.agent/last-plan.json).
 *
 * Pulled out of index.ts (which runs `main()` as an import side effect, so
 * it cannot be imported from a test) specifically so this read-modify-write
 * logic has real, isolated test coverage — a mistake here silently breaks
 * `yimpim --resume` and the phase-repair-history-survives-a-restart feature it
 * carries, without ever throwing anything a test would catch by accident.
 */

import fs from "fs";
import path from "path";
import { Plan } from "./planner.js";
import { normalizeVerificationIds } from "./verificationBullets.js";
import type { PhaseProgress } from "./progressNote.js";

export interface ResumeState {
  instructions: string;
  planOutput: string;
  timestamp: string;
  /** Structured plan, when the planner produced one. */
  plan?: Plan;
  /** Phase ids already verified and committed, so a resume skips them. */
  completedPhaseIds?: string[];
  /** What those phases changed, handed to the next phase's brief (see progressNote.ts).
   *  Lives and dies with this file: a new task's plan replaces it whole. */
  progress?: PhaseProgress[];
  /** Per-phase repair history for whichever phase hasn't passed yet — see
   *  PhaseRepairContext. Keyed by phase id; absent once a phase passes. */
  phaseRepairContext?: Record<string, PhaseRepairContext>;
}

/** What a phase's repair loop has learned so far: the Editor's own
 *  how-to-verify notes and the attempt/outcome history built from them (see
 *  runPhaseWithHealing in index.ts). Persisted keyed by phase id so a
 *  `--resume` after exhausting the repair budget doesn't start the exact
 *  same defect from zero — the whole reason this history exists in the
 *  first place is repair attempts that need more than one process's worth
 *  of tries to actually land. */
export interface PhaseRepairContext {
  editorHowToVerify?: string;
  repairHistory: string[];
  /** What the Editor (or a Repair) reported differing from a planned assertion, by id. */
  assertionDeltas?: { id: string; action: string; reason: string; replacement?: string }[];
  /** The Editor's stated reason the permanent tests need no change, if it gave one. */
  testsNotNeeded?: string;
}

function resumeStatePath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "last-plan.json");
}

export function saveResumeState(repoRoot: string, state: ResumeState): void {
  try {
    const dir = path.join(repoRoot, ".agent");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resumeStatePath(repoRoot), JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

export function loadResumeState(repoRoot: string): ResumeState | null {
  const file = resumeStatePath(repoRoot);
  if (fs.existsSync(file)) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf-8"));
      // A plan saved before verification bullets carried IDs gets synthetic
      // ones here, so anything keyed on an ID works the same on old and new.
      try {
        if (Array.isArray(state?.plan?.phases)) normalizeVerificationIds(state.plan);
      } catch {}
      return state;
    } catch {}
  }
  return null;
}

/** What a phase's repair loop has learned so far for THIS phase id, if
 *  anything was ever persisted — undefined for a phase that's never failed
 *  a repair attempt, or on a resume state that predates this feature. */
export function loadPhaseRepairContext(repoRoot: string, phaseId: string): PhaseRepairContext | undefined {
  return loadResumeState(repoRoot)?.phaseRepairContext?.[phaseId];
}

/**
 * Updates just this one phase's repair context within the existing resume
 * state, read-modify-write — called after every repair attempt (not only on
 * final failure) so a crash or Ctrl-C mid-loop still resumes with whatever
 * was learned up to that point, not just what a clean exit would have saved.
 * Passing `undefined` clears the entry (once the phase actually passes —
 * nothing left to remember).
 */
export function savePhaseRepairContext(
  repoRoot: string,
  phaseId: string,
  context: PhaseRepairContext | undefined
): void {
  const state = loadResumeState(repoRoot);
  // No resume state exists yet (planning hasn't saved its own baseline yet)
  // — nothing to attach this to; the phase loop's own save right after
  // planning will exist by the time any repair actually runs.
  if (!state) return;
  const phaseRepairContext = { ...(state.phaseRepairContext ?? {}) };
  if (context) phaseRepairContext[phaseId] = context;
  else delete phaseRepairContext[phaseId];
  saveResumeState(repoRoot, { ...state, phaseRepairContext });
}
