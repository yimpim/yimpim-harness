/**
 * Read-turn accounting and stall detection for code-editing agents.
 *
 * Standalone module (no runtime dependencies) so the analysis-paralysis
 * loop logic has real, isolated test coverage instead of being verified only
 * by hand-tracing the orchestrator's execution loop:
 *
 * - Inspection tools (`read_file`, `search_code`, `list_files`,
 *   `get_file_outline`) accumulate toward the current round's read count.
 * - When a round reaches `READS_PER_ROUND` reads without any edit, it counts
 *   as one full consecutive read round.
 * - `MAX_CONSECUTIVE_READ_ROUNDS` such rounds in a row, with no mutation
 *   tool in between, means the agent has stalled — it is reading without
 *   converging — and the caller should intervene (interrupt the streak,
 *   bench the agent, hand off to a fresh Editor, or escalate to the Planner).
 * - Mutation tools (`patch_file`, `write_file`) reset the read streaks:
 *   a genuine edit is progress, not paralysis.
 *
 * The tracker is intentionally round-based rather than a raw monotonic
 * counter so the orchestrator can call `resetForRound()` at turn boundaries
 * without losing the history already accumulated: full rounds survive,
 * partial rounds are dropped.
 */

/** Tools that only consume information — they inspect, never modify. */
export const INSPECTION_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_code",
  "list_files",
  "get_file_outline",
]);

/**
 * Tools that modify the repository — a real edit breaks a read streak.
 *
 * `stage_file_for_deletion` counts as a mutation: it is the terminal
 * resolution of a file (the editor concluded the file should go), not more
 * inspection, so it must end a read streak exactly like an edit does.
 * Without this, an editor that correctly disposes of a dead file instead of
 * rewriting it would still be scored as "reading without converging".
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "patch_file",
  "write_file",
  "stage_file_for_deletion",
]);

export type ToolCategory = "inspection" | "mutation" | "other";

/** Classifies a tool call for the tracker. Unknown tools are "other". */
export function classifyTool(toolName: string): ToolCategory {
  if (INSPECTION_TOOLS.has(toolName)) return "inspection";
  if (MUTATION_TOOLS.has(toolName)) return "mutation";
  return "other";
}

/**
 * Pulls every file path (single `path` or batched `paths`) out of a tool
 * call's args, tolerating missing or wrongly-typed fields.
 */
function filePathsFromArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const single = args.path;
  if (typeof single === "string" && single.length > 0) out.push(single);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string" && p.length > 0) out.push(p);
    }
  }
  return out;
}

/**
 * Tracks consecutive inspection rounds and the set of distinct file paths an
 * agent has looked at, so a later phase can detect analysis paralysis and
 * hand a stalled Editor's context to a fresh one without re-exploration.
 */
export class ReadTracker {
  /** Reads that complete one full (non-editing) inspection round. */
  static readonly READS_PER_ROUND = 8;
  /** Consecutive full read rounds with zero edits before the agent has stalled. */
  static readonly MAX_CONSECUTIVE_READ_ROUNDS = 2;

  private _readIterationsCount = 0;
  private _consecutiveReadRounds = 0;
  private readonly _inspectedPaths = new Set<string>();

  /** Reads accumulated in the current (possibly partial) round. */
  get readIterationsCount(): number {
    return this._readIterationsCount;
  }

  /** Full rounds of 8 reads that completed without an intervening edit. */
  get consecutiveReadRounds(): number {
    return this._consecutiveReadRounds;
  }

  /** Distinct file paths this tracker has seen inspection tools target. */
  get inspectedPaths(): ReadonlySet<string> {
    return this._inspectedPaths;
  }

  /**
   * Records one tool call. Inspection tools advance the current read round
   * (rolling a completed full round into `consecutiveReadRounds`) and record
   * any file paths they targeted; mutation tools reset both read streaks so
   * a genuine edit restarts the clock.
   */
  recordToolCall(toolName: string, args: Record<string, unknown>): void {
    const category = classifyTool(toolName);

    if (category === "inspection") {
      this._readIterationsCount++;
      for (const p of filePathsFromArgs(args)) {
        this._inspectedPaths.add(p);
      }
      if (this._readIterationsCount >= ReadTracker.READS_PER_ROUND) {
        this._consecutiveReadRounds++;
        this._readIterationsCount = 0;
      }
      return;
    }

    if (category === "mutation") {
      // An edit is progress: the read-streak clock starts over from zero.
      this._readIterationsCount = 0;
      this._consecutiveReadRounds = 0;
    }
    // "other" tools (ask_user, conclude_task, ...) neither advance nor reset
    // the streak — only edits are evidence of convergence.
  }

  /**
   * True once the agent has completed `MAX_CONSECUTIVE_READ_ROUNDS` full
   * rounds of 8 reads with no edit in between.
   */
  hasStalled(): boolean {
    return this._consecutiveReadRounds >= ReadTracker.MAX_CONSECUTIVE_READ_ROUNDS;
  }

  /**
   * Starts a fresh round: drops the current partial round's count. Completed
   * full rounds are preserved (they may already have tripped the stall
   * threshold), so this is safe to call at every turn boundary without
   * losing history. Use `resetAll()` to fully clear the tracker.
   */
  resetForRound(): void {
    this._readIterationsCount = 0;
  }

  /** Wipes everything: current round, consecutive-round history, and all recorded paths. */
  resetAll(): void {
    this._readIterationsCount = 0;
    this._consecutiveReadRounds = 0;
    this._inspectedPaths.clear();
  }
}