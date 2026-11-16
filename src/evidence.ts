/**
 * Evidence ledger for the QA verifier.
 *
 * Central policy: a run fails ONLY on positive evidence of a defect.
 * Missing tooling, absent emulators, unavailable displays and unreachable
 * servers lower CONFIDENCE, they never produce a failure.
 */

import { events } from "./events.js";

export type GateTier = "build" | "runtime" | "visual" | "static" | "semantic";

export type GateStatus =
  | "pass"          // executed, and the result was good
  | "fail"          // executed, and produced positive evidence of a defect
  | "skipped"       // not attempted: tooling or environment unavailable
  | "inconclusive"  // attempted, but produced no usable signal
  | "error";        // the check itself broke (never the code under test's fault)

export type EvidenceMethod =
  | "executed"    // a real command ran and we read its exit code/output
  | "observed"    // a runtime artifact was captured (screenshot, log, HTTP response)
  | "inspected"   // source/diff was read and reasoned about (no execution)
  | "unavailable";

export interface EvidenceEntry {
  tier: GateTier;
  gate: string;
  method: EvidenceMethod;
  status: GateStatus;
  /** Only a blocking entry with status "fail" can fail the run. */
  blocking: boolean;
  detail: string;
  artifacts?: string[];
  /** Set when this gate could not run and handed off to another gate. */
  degradedTo?: string;
}

export type Confidence =
  | "verified"     // something actually ran and was observed at runtime
  | "partial"      // built/compiled, but not observed running
  | "static-only"; // nothing executed; conclusions come from reading code

export interface Verdict {
  passed: boolean;
  confidence: Confidence;
  blockingFailures: EvidenceEntry[];
  advisories: EvidenceEntry[];
  degradations: EvidenceEntry[];
  summary: string;
}

export class EvidenceLedger {
  private entries: EvidenceEntry[] = [];

  add(entry: EvidenceEntry): EvidenceEntry {
    this.entries.push(entry);
    events.emit({
      type: "gate.result",
      tier: entry.tier,
      gate: entry.gate,
      status: entry.status,
      blocking: entry.blocking,
      detail: entry.detail,
      artifacts: entry.artifacts,
    });
    const icon = STATUS_ICON[entry.status];
    const tag = entry.blocking ? "GATE" : "ADVISORY";
    console.log(`[QA ${tag}] ${icon} ${entry.gate} — ${entry.detail}`);
    if (entry.degradedTo) {
      console.log(`[QA ${tag}]    ↪ degraded to: ${entry.degradedTo}`);
    }
    return entry;
  }

  /** Convenience: record a gate that could not run because tooling is absent. */
  unavailable(tier: GateTier, gate: string, reason: string, degradedTo: string): EvidenceEntry {
    return this.add({
      tier,
      gate,
      method: "unavailable",
      status: "skipped",
      blocking: false,
      detail: reason,
      degradedTo,
    });
  }

  all(): EvidenceEntry[] {
    return [...this.entries];
  }

  artifacts(): string[] {
    return this.entries.flatMap((e) => e.artifacts ?? []);
  }

  /** Lets a caller skip later, more expensive gates once an earlier one has
   *  already produced a hard failure — e.g. no point launching an emulator
   *  against code that doesn't compile, or that already contradicts the plan. */
  hasBlockingFailure(): boolean {
    return this.entries.some((e) => e.blocking && e.status === "fail");
  }

  private has(tier: GateTier, statuses: GateStatus[]): boolean {
    return this.entries.some((e) => e.tier === tier && statuses.includes(e.status));
  }

  verdict(): Verdict {
    const blockingFailures = this.entries.filter((e) => e.blocking && e.status === "fail");

    // Advisory-worthy status on anything that ISN'T already a blocking
    // failure — deliberately keyed off blockingFailures itself, not
    // `!e.blocking`, so a blocking gate that errored out (rather than
    // cleanly failing or passing) still surfaces here instead of matching
    // neither filter and vanishing from the report. "error" is never itself
    // defect evidence (see GateStatus's own doc — "never the code under
    // test's fault"), so it belongs in advisories even on a blocking entry.
    const advisories = this.entries.filter(
      (e) =>
        !blockingFailures.includes(e) &&
        (e.status === "fail" || e.status === "inconclusive" || e.status === "error")
    );

    const degradations = this.entries.filter((e) => e.status === "skipped" && e.degradedTo);

    // Confidence reflects how much was actually executed/observed, never pass/fail.
    const observedRuntime =
      this.has("runtime", ["pass", "fail"]) || this.has("visual", ["pass", "fail"]);
    const executedBuild = this.has("build", ["pass", "fail"]);

    const confidence: Confidence = observedRuntime
      ? "verified"
      : executedBuild
        ? "partial"
        : "static-only";

    const passed = blockingFailures.length === 0;

    return {
      passed,
      confidence,
      blockingFailures,
      advisories,
      degradations,
      summary: this.renderSummary(passed, confidence, blockingFailures, advisories, degradations),
    };
  }

  private renderSummary(
    passed: boolean,
    confidence: Confidence,
    failures: EvidenceEntry[],
    advisories: EvidenceEntry[],
    degradations: EvidenceEntry[]
  ): string {
    // Markdown-lite headings — this renders to the console banner and the
    // human-facing report only (verdict.summary), never the machine-facing
    // errorOutput REPAIR reads, which is built separately straight from
    // blockingFailures below. Safe to make as legible as it wants to be.
    const lines: string[] = [];
    lines.push(`**Verdict: ${passed ? "PASS" : "FAIL"}**  (confidence: ${confidence})`);
    lines.push("");
    lines.push("**Evidence collected:**");
    for (const e of this.entries) {
      lines.push(`  ${STATUS_ICON[e.status]} [${e.tier}/${e.method}] ${e.gate}: ${e.detail}`);
    }
    if (failures.length > 0) {
      lines.push("");
      lines.push("**Blocking defects:**");
      failures.forEach((f) => lines.push(`  ✗ ${f.gate}: ${f.detail}`));
    }
    if (advisories.length > 0) {
      lines.push("");
      lines.push("**Advisories (human sign-off, not blocking):**");
      advisories.forEach((a) => lines.push(`  ! ${a.gate}: ${a.detail}`));
    }
    if (degradations.length > 0) {
      lines.push("");
      lines.push("**Unavailable tooling (compensated by static review):**");
      degradations.forEach((d) => lines.push(`  ~ ${d.gate}: ${d.detail} → ${d.degradedTo}`));
    }
    return lines.join("\n");
  }
}

const STATUS_ICON: Record<GateStatus, string> = {
  pass: "✓",
  fail: "✗",
  skipped: "~",
  inconclusive: "?",
  error: "!",
};
