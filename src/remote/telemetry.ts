/**
 * Counters-only usage telemetry for the hosted broker.
 *
 * Session traffic is end-to-end encrypted, so the broker can never read a
 * phase or worker outcome out of it. This accumulator watches the events the
 * agent is already pushing and reduces them to a handful of integers that ride
 * alongside the (still sealed) events as a plaintext `metrics` block:
 *
 *   { counters: { editor_runs: 2, phases_completed: 1, ... },
 *     lastFailureReason?: "phase_failed" }
 *
 * By construction it carries NO prompt text, code, file paths, phase names or
 * command output — only counts, durations and one coarse failure label.
 */

export interface MetricsReport {
  counters: Record<string, number>;
  lastFailureReason?: string;
}

/**
 * Worker (agent) name -> the counter its completed run increments.
 *
 * SETUP is deliberately NOT here: a clean install makes no model call at all,
 * so counting the SETUP *worker* would miss most SETUP runs. It is counted
 * once per SETUP phase instead (phase.start with executor "SETUP", below).
 */
const WORKER_COUNTER: Record<string, string> = {
  advisor: "advisor_runs",
  discovery: "discovery_runs",
  editor: "editor_runs",
  repair: "repair_runs",
  qa: "qa_runs",
  verifier: "qa_runs",
};

export class RemoteTelemetry {
  private counters: Record<string, number> = {};
  private lastFailureReason: string | undefined;
  private phaseStartedAt = new Map<string, number>();
  private phaseFiles = new Map<string, number>();

  private bump(field: string, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    this.counters[field] = (this.counters[field] ?? 0) + Math.round(by);
  }

  /** Observe one outbound event (the same kind/payload push() receives). */
  observeEvent(kind: string, payload: Record<string, unknown>, now: number = Date.now()): void {
    switch (kind) {
      case "phase.start": {
        const id = typeof payload.phaseId === "string" ? payload.phaseId : undefined;
        if (id) this.phaseStartedAt.set(id, now);
        if (typeof payload.executor === "string" && payload.executor.toUpperCase() === "SETUP") {
          this.bump("setup_runs");
        }
        return;
      }
      case "file.changed": {
        const id = typeof payload.phaseId === "string" ? payload.phaseId : undefined;
        if (id) this.phaseFiles.set(id, (this.phaseFiles.get(id) ?? 0) + 1);
        else this.bump("total_files_changed");
        return;
      }
      case "phase.end": {
        const id = typeof payload.phaseId === "string" ? payload.phaseId : undefined;
        const passed = payload.passed === true;
        this.bump(passed ? "phases_completed" : "phases_failed");
        if (!passed) this.lastFailureReason = "phase_failed";
        if (id) {
          const started = this.phaseStartedAt.get(id);
          if (started !== undefined) this.bump("total_execution_seconds", (now - started) / 1000);
          const files = this.phaseFiles.get(id);
          if (files) this.bump("total_files_changed", files);
          this.phaseStartedAt.delete(id);
          this.phaseFiles.delete(id);
        }
        return;
      }
      case "worker.end": {
        const agent = typeof payload.agent === "string" ? payload.agent.toLowerCase() : "";
        const field = WORKER_COUNTER[agent];
        if (field) this.bump(field);
        return;
      }
    }
  }

  /**
   * Observe one phone command the desktop actually accepted. "Prompt" means a
   * new instruction typed by the user (verb "message"); attachment chunks and
   * answers to a question are deliberately not prompts.
   */
  observeCommand(verb: string): void {
    if (verb === "message") this.bump("total_prompts");
    else if (verb === "abort") this.bump("user_aborts");
  }

  get pending(): boolean {
    return Object.keys(this.counters).length > 0 || this.lastFailureReason !== undefined;
  }

  /** Take everything accumulated so far (and reset). Undefined when nothing happened. */
  drain(): MetricsReport | undefined {
    if (!this.pending) return undefined;
    const report: MetricsReport = {
      counters: this.counters,
      ...(this.lastFailureReason ? { lastFailureReason: this.lastFailureReason } : {}),
    };
    this.counters = {};
    this.lastFailureReason = undefined;
    return report;
  }

  /** Put a report back after a failed post, so a network blip loses nothing. */
  restore(report: MetricsReport | undefined): void {
    if (!report) return;
    for (const [field, value] of Object.entries(report.counters)) this.bump(field, value);
    if (report.lastFailureReason && this.lastFailureReason === undefined) {
      this.lastFailureReason = report.lastFailureReason;
    }
  }
}
