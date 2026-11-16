/**
 * Learned UI navigation flows: what a vision model tapped/clicked through, in
 * a past run, to reach the screen a given verification goal is about.
 *
 * Blind vision-guided navigation (see decideNextAndroidStep / decideNextWebStep
 * in verifierTools.ts) rediscovers the same path from scratch every single
 * time it verifies the same goal — which happens a lot, since a failed phase
 * gets re-verified on every repair attempt and again on --resume. Persisting
 * the path a goal actually needed, keyed by that goal's own text, lets a
 * later run replay it directly and skip the vision call entirely, while
 * staying safe if the UI has since changed: replay is abandoned the instant a
 * step's labeled element can't be found on the current screen, and whatever
 * path actually worked this run — replayed, vision-found, or a mix of both —
 * is what gets persisted, so a stale flow self-heals instead of staying wrong.
 *
 * Deliberately keyed by exact goal text, not fuzzy-matched across different
 * goals that might land on the same screen: a wrong-screen replay would be a
 * much worse failure mode than the (bounded, self-correcting) cost of missing
 * a reuse opportunity.
 */

import fsSync from "fs";
import path from "path";
import { NavHint } from "./visualProbes.js";

export interface NavFlowStep {
  /** The tapped/clicked element's own accessible label — not its coordinates,
   *  which drift with layout changes a label usually survives. */
  label: string;
}

export interface NavFlow {
  platform: string;
  goal: string;
  steps: NavFlowStep[];
  updatedAt: string;
}

interface UiFlowsFile {
  flows: NavFlow[];
}

function flowsPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "ui-flows.json");
}

export function loadUiFlows(repoRoot: string): NavFlow[] {
  try {
    const raw = fsSync.readFileSync(flowsPath(repoRoot), "utf-8");
    const data = JSON.parse(raw) as UiFlowsFile;
    return Array.isArray(data.flows) ? data.flows : [];
  } catch {
    return [];
  }
}

export function findUiFlow(repoRoot: string, platform: string, goal: string): NavFlow | undefined {
  return loadUiFlows(repoRoot).find((f) => f.platform === platform && f.goal === goal);
}

/** Same spirit as codebase-memory.json's historicalPitfalls cap: a long-lived
 *  project re-verifying many different requirements over weeks/months would
 *  otherwise accumulate flows for goals nobody asks about anymore, forever.
 *  Evicts the STALEST entries first (oldest updatedAt) when over the limit —
 *  a flow that keeps getting replayed keeps refreshing its own updatedAt, so
 *  active ones naturally survive eviction. */
const MAX_STORED_FLOWS = 200;

export function saveUiFlow(repoRoot: string, platform: string, goal: string, steps: NavFlowStep[]): void {
  // Nothing worth remembering: the target was already on the launch screen.
  if (steps.length === 0) return;

  const flows = loadUiFlows(repoRoot).filter((f) => !(f.platform === platform && f.goal === goal));
  flows.push({ platform, goal, steps, updatedAt: new Date().toISOString() });
  flows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const trimmed = flows.length > MAX_STORED_FLOWS ? flows.slice(flows.length - MAX_STORED_FLOWS) : flows;
  try {
    fsSync.mkdirSync(path.dirname(flowsPath(repoRoot)), { recursive: true });
    fsSync.writeFileSync(flowsPath(repoRoot), JSON.stringify({ flows: trimmed }, null, 2), "utf-8");
  } catch {
    // Best-effort: losing a learned flow just means the next run rediscovers
    // it blind again, same as if none of this existed.
  }
}

/** Finds whichever current hint sits closest to a vision-chosen tap point, so
 *  a freshly vision-decided step can still be recorded under a durable label
 *  instead of raw coordinates that would drift on the next layout change. */
export function nearestHintLabel(hints: NavHint[], xPercent: number, yPercent: number): string | undefined {
  let best: NavHint | undefined;
  let bestDist = Infinity;
  for (const h of hints) {
    const d = Math.hypot(h.xPercent - xPercent, h.yPercent - yPercent);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  // Further than ~8% of screen size away isn't really "the same element" —
  // record the raw coordinate instead of mislabeling an unrelated hint.
  return best && bestDist <= 8 ? best.label : undefined;
}

/**
 * Drives one probe run's replay-then-fallback navigation. Constructed once
 * per probe run, consulted at every step: `nextReplayHint` returns the
 * recorded element to act on next as long as replay is still on-script, and
 * `recordStep` / `finish` capture whatever path is actually taken (replayed
 * or freshly vision-decided) so it can be persisted at the end regardless of
 * which source produced it.
 */
type ReplayStatus = "active" | "completed" | "derailed" | "none";

export class NavFlowReplayer {
  private readonly flow?: NavFlow;
  private cursor = 0;
  private status: ReplayStatus;
  private readonly recorded: NavFlowStep[] = [];

  constructor(private readonly repoRoot: string, private readonly platform: string, private readonly goal: string) {
    this.flow = findUiFlow(repoRoot, platform, goal);
    this.status = this.flow ? "active" : "none";
  }

  /** Looks for this step's recorded label among the hints the caller just
   *  observed. Returns it if found (and advances past it). Returns undefined
   *  either because replay has nothing left to try (`justCompleted` tells the
   *  caller which) or because a recorded label went missing — the screen no
   *  longer matches what was learned, so replay stops trusting the recording
   *  for good rather than risk tapping the wrong thing for the rest of this
   *  run's steps too. */
  nextReplayHint(hints: NavHint[]): NavHint | undefined {
    if (this.status !== "active" || !this.flow) return undefined;
    if (this.cursor >= this.flow.steps.length) {
      this.status = "completed";
      return undefined;
    }
    const wanted = this.flow.steps[this.cursor].label;
    const hit = hints.find((h) => h.label === wanted);
    if (!hit) {
      this.status = "derailed";
      return undefined;
    }
    this.cursor++;
    return hit;
  }

  /** True once every recorded step has been replayed without derailing —
   *  the caller can trust this means "arrived" without spending a vision
   *  call to confirm what the recording already proved last time. */
  get justCompleted(): boolean {
    return this.status === "completed";
  }

  /** Call once per step actually taken, whatever decided it, so the path this
   *  run really followed — not just the one it started out replaying — is
   *  what ends up persisted. */
  recordStep(label: string): void {
    this.recorded.push({ label });
  }

  /** Observed-screen bookkeeping for one navigation run (see navGraph.ts):
   *  the screen QA last identified plus the control it then tapped, so the
   *  NEXT identified screen completes an edge. A replayed step names no
   *  screen, so it breaks the chain rather than guessing across it. */
  decisions = 0;
  prevScreen?: string;
  prevTap?: string;

  /** Labels of every step this run actually took, in order. */
  get tappedLabels(): string[] {
    return this.recorded.map((s) => s.label);
  }

  /** Persist the path this run actually took. Always overwrites any stale
   *  recording, including one that replayed cleanly start to finish — that
   *  just refreshes it as still-current. */
  finish(): void {
    saveUiFlow(this.repoRoot, this.platform, this.goal, this.recorded);
  }
}
