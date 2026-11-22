/**
 * How much of a task was actually run. Each phase's QA verdict carries a confidence (evidence.ts): "verified" (the app was launched and observed), "partial" (it compiled, but was not
 * observed running) or "static-only" (nothing could be executed: source review alone). A pass on source review alone is a real pass, but not the same claim as a verified one, so the end of
 * a task says which phases it was.
 */

export interface PhaseConfidence {
  /** The phase's position label, e.g. "2/5". */
  label: string;
  name: string;
  /** Undefined when the phase had no QA verdict (a setup phase). */
  confidence?: string;
}

/** Lines for the end-of-task summary; empty when every phase that had a verdict was verified. */
export function confidenceSummary(rows: PhaseConfidence[]): string[] {
  const judged = rows.filter((r) => r.confidence);
  const staticOnly = judged.filter((r) => r.confidence === "static-only");
  const partial = judged.filter((r) => r.confidence === "partial");
  if (staticOnly.length === 0 && partial.length === 0) return [];
  const list = (xs: PhaseConfidence[]) => xs.map((r) => `${r.label} ${r.name}`).join("; ");
  const lines: string[] = [];
  if (staticOnly.length > 0) {
    lines.push(`⚠️ [NOT RUN] ${staticOnly.length} of ${judged.length} phase(s) passed on source review alone, because nothing could be executed here: ${list(staticOnly)}`);
  }
  if (partial.length > 0) {
    lines.push(`   ${partial.length} more compiled but were not observed running: ${list(partial)}`);
  }
  return lines;
}
