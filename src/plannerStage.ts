/**
 * The Planner as a phone sees it: ONE worker for the whole planning stage.
 *
 * Planning runs the Planner several times — the first plan, a corrective pass when the plan lacks surgical scope, the check of
 * its own questions against the code, and a re-plan after the user answers. Each of those is its own agent.start/agent.end
 * pair on the event bus, and the remote translator gives each pair a fresh workerId. A phone then shows a stack of Planner
 * cards for what the person experiences as one step.
 *
 * This tracker folds those passes together: the first PLANNER pass opens the worker (its id is minted there), every later pass
 * runs under that same id and sends no worker.start of its own, and close() returns the stage's cumulative totals for the one
 * worker.end. Console output and usage accounting are untouched — this only decides what goes to a paired phone.
 */
export interface PlannerStageEnd {
  /** The one workerId every pass of this stage ran under. */
  workerId: string;
  /** How many Planner passes ran in the stage (first plan, corrective, question check, re-plan). */
  passes: number;
  /** Tokens across every pass, summed from each pass's own agent.end. */
  tokensUsed: number;
  /** Cost across every pass that reported one; undefined when none did. */
  costUsd?: number;
  /** From the stage's start to close. */
  elapsedMs: number;
}

export class PlannerStage {
  private workerId: string | undefined;
  private startedAt: number | undefined;
  private passes = 0;
  private tokens = 0;
  private cost = 0;
  private costKnown = false;

  constructor(
    private readonly mintId: () => string,
    private readonly now: () => number = Date.now
  ) {}

  /** Planning has begun. Clears anything left from an earlier stage. */
  begin(): void {
    this.workerId = undefined;
    this.startedAt = this.now();
    this.passes = 0;
    this.tokens = 0;
    this.cost = 0;
    this.costKnown = false;
  }

  /** True between begin() and close(). Only then do PLANNER passes fold. */
  get active(): boolean {
    return this.startedAt !== undefined;
  }

  /** The stage's workerId once its first pass has opened it; undefined before that. */
  get id(): string | undefined {
    return this.workerId;
  }

  /**
   * A PLANNER pass is starting while planning is active. `fold` is true when the stage's worker is already open (a later pass):
   * that pass must not send a worker.start of its own. The first pass mints the worker id and is not folded.
   */
  startPass(): { workerId: string; fold: boolean } {
    const fold = this.workerId !== undefined;
    this.workerId ??= this.mintId();
    this.passes++;
    return { workerId: this.workerId, fold };
  }

  /** A PLANNER pass ended while planning is active: its own usage joins the stage's totals. Never a worker.end of its own. */
  endPass(tokensUsed?: number, costUsd?: number): void {
    this.tokens += tokensUsed ?? 0;
    if (typeof costUsd === "number") {
      this.cost += costUsd;
      this.costKnown = true;
    }
  }

  /** Planning finished (or failed). Returns the one worker's totals, or undefined when no Planner pass ever opened the worker. */
  close(): PlannerStageEnd | undefined {
    const out: PlannerStageEnd | undefined =
      this.workerId !== undefined && this.startedAt !== undefined
        ? {
            workerId: this.workerId,
            passes: this.passes,
            tokensUsed: this.tokens,
            ...(this.costKnown ? { costUsd: this.cost } : {}),
            elapsedMs: this.now() - this.startedAt,
          }
        : undefined;
    this.startedAt = undefined;
    this.workerId = undefined;
    return out;
  }
}
