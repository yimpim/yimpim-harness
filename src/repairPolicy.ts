/**
 * Pure decision logic for the repair loop's cost/looping safeguards.
 *
 * Pulled out of index.ts (which runs `main()` as an import side effect, so it
 * cannot be imported from a test) specifically so these two rules — the ones
 * added to stop the verifier from silently burning the whole repair budget —
 * have real, isolated test coverage instead of being verified by hand-tracing
 * a 500-line function once and hoping it doesn't regress.
 */

export interface BlockingFailure {
  tier: string;
  gate: string;
  detail: string;
}

/**
 * A signature for one verification failure, independent of call order, so two
 * consecutive identical failures are detectable even though the editor
 * genuinely attempted something different in between.
 */
function normalizeFailureDetail(detail: string): string {
  return detail
    // ISO timestamps (e.g. 2026-11-26T21:30:12.345Z)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
    // Durations / timings (e.g. 123ms, 1.45s, 2.3 s)
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<dur>")
    // Ephemeral temp worktree/sandbox directory suffixes
    .replace(/\byimpim-[a-z]+-[A-Za-z0-9_-]+\b/g, "yimpim-tmp")
    // Localhost ephemeral ports
    .replace(/\b(localhost|127\.0\.0\.1):\d+\b/g, "$1:<port>")
    .replace(/\s+/g, " ")
    .trim();
}

export function failureSignature(blockingFailures?: BlockingFailure[]): string {
  return (blockingFailures ?? [])
    .map((f) => `${f.gate}:${normalizeFailureDetail(f.detail)}`)
    .sort()
    .join("\n");
}

/** True only when every blocking failure is visual — the least reliable evidence tier. */
export function isVisualOnlyFailure(blockingFailures?: BlockingFailure[]): boolean {
  return (blockingFailures?.length ?? 0) > 0 && blockingFailures!.every((f) => f.tier === "visual");
}

/**
 * Whether this verification attempt made no measurable progress on the last
 * one: the exact same failure, reported again, after a repair attempt already
 * ran. The very first failure (attempt 0) never counts — there is nothing to
 * compare it to yet.
 */
export function isNoProgress(attempt: number, current: string, previous: string | undefined): boolean {
  return attempt > 0 && current.length > 0 && current === previous;
}

export type RepairProgressOutcome =
  /** Not stuck (yet) — keep going on whichever chain is already active. */
  | { kind: "continue" }
  /** No progress on the PRIMARY model, and a real backup chain exists:
   *  hand off to it instead of stopping. The caller must reset its own
   *  previous-failure baseline to undefined so the backup's first attempt
   *  isn't immediately compared against the primary's stuck failure. */
  | { kind: "switch_to_backup" }
  /** No progress with nowhere left to hand off to — either no real backup
   *  chain was ever configured, or the backup already had its own turn and
   *  got stuck too. Genuinely done. */
  | { kind: "stop" };

/**
 * What a repair loop should do after one verification cycle, given whether
 * that cycle reproduced the exact same failure as the one before it.
 *
 * Exists because those two questions — "did we make progress?" and "should
 * we stop?" — used to be answered as one and the same: any no-progress trip
 * ended the whole phase immediately, regardless of whether a backup model
 * had ever been given a turn. In practice that made a configured backup
 * chain nearly unreachable — a primary model stuck on one blind spot
 * reliably reproduces an identical failure within its first couple of
 * attempts, long before an attempt-count-based halfway switch would have
 * reached it on its own. Separating the two means "no progress" now reads
 * as "this approach is stuck," which is exactly the signal to try the OTHER
 * model, not to give up — stopping is reserved for genuinely having no
 * model left to hand off to.
 */
export function evaluateRepairProgress(
  attempt: number,
  currentFailureSignature: string,
  previousFailureSignature: string | undefined,
  repairUsingBackup: boolean,
  hasRealBackupChain: boolean,
  seenSignatures?: Set<string>
): RepairProgressOutcome {
  const repeated =
    isNoProgress(attempt, currentFailureSignature, previousFailureSignature) ||
    (attempt > 0 && currentFailureSignature.length > 0 && Boolean(seenSignatures?.has(currentFailureSignature)));
  if (!repeated) {
    return { kind: "continue" };
  }
  if (!repairUsingBackup && hasRealBackupChain) {
    return { kind: "switch_to_backup" };
  }
  return { kind: "stop" };
}

/**
 * Gate expensive Hydrogen REPAIR_PLANNER on attempt 1 for simple, local, single-cause
 * build/test errors (<= 2 distinct errors, no external files, no runtime/visual failures,
 * no missing-dependency hint). Cheap REPAIR fixes these directly in 1 pass; if attempt 1
 * fails, attempt 2+ escalates to Hydrogen REPAIR_PLANNER as usual.
 */
export function shouldSkipRepairPlannerOnFirstAttempt(opts: {
  attempt: number;
  madeNoChanges: boolean;
  blockingFailures?: BlockingFailure[];
  externalPathsCount: number;
  runtimeOrVisualFailed: boolean;
  hasManifestHint: boolean;
}): boolean {
  if (opts.madeNoChanges) return true;
  if (opts.attempt !== 1) return false;
  if (opts.externalPathsCount > 0 || opts.runtimeOrVisualFailed || opts.hasManifestHint) return false;
  const distinct = (opts.blockingFailures ?? []).reduce((sum, f) => sum + countDistinctErrors(f.detail), 0);
  return distinct > 0 && distinct <= 2;
}

/**
 * The prompt section (appended to both REPAIR_PLANNER's triage prompt and
 * REPAIR's own repair prompt) authorizing a repair attempt to touch a file
 * outside the current phase's own scope, for exactly this attempt.
 *
 * A build-tier failure SOMETIMES names its own culprit file directly (the
 * compiler says so) — `externalPaths` is that extracted, confirmed list,
 * and takes priority when non-empty. But two things never show up in
 * `externalPaths`, and both have caused a real failure to burn its whole
 * diagnosis budget with nothing to show for it:
 *
 *  - A runtime/visual-tier failure never names a file at all. A real
 *    failure hit this exactly: QA's runtime probe reported a React
 *    "duplicate key" console warning with no file path anywhere in it,
 *    caused by a pre-existing bug in a totally different, unrelated screen
 *    that happened to render during QA's navigation walk — not anything
 *    the current phase's own change touched.
 *  - A build-tier failure about a symbol being MISUSED never names where
 *    that symbol is DEFINED. "Property 'pairedAt' does not exist on type
 *    'SessionSummary'" names the file that misused it, never the file that
 *    declares 'SessionSummary' — a real failure hit this too, six distinct
 *    wrong-API errors (a storage export, a type's shape, an enum used as a
 *    value, two missing theme tokens) all in files REPAIR_PLANNER was
 *    never told it could open.
 *
 * In both cases REPAIR_PLANNER, told it could only inspect the current
 * phase's own files, had no way to ever find the real cause and burned its
 * whole round budget before giving up with no diagnosis at all. Since
 * there's no path to extract here, this grants permission to SEARCH
 * broadly instead of naming one up front — once something real turns up,
 * the same "fix exactly what you concretely found, nothing more"
 * discipline applies as the named-path case.
 *
 * Returns "" when neither applies, so the prompt gains no section at all
 * for the common case (a failure fully explained by the phase's own files).
 */
export function buildWidenedScopeSection(externalPaths: string[], needsWidenedSearch: boolean): string {
  if (externalPaths.length > 0) {
    return `\n\nWIDENED SCOPE FOR THIS REPAIR ATTEMPT ONLY:
The build error above points at file(s) outside this phase's original scope:
${externalPaths.map((p) => `  - ${p}`).join("\n")}
This usually means this phase's change (a rename, removed export, or changed
signature) broke code in those files that has not been updated to match yet.
You are explicitly authorized to fix EXACTLY those file(s) in addition to
this phase's own files, for this repair attempt only — do not widen scope
beyond what the build error actually names.`;
  }
  if (needsWidenedSearch) {
    return `\n\nWIDENED SEARCH PERMITTED FOR THIS REPAIR ATTEMPT:
The failure above doesn't clearly name which file is actually responsible.
Either it's a runtime/visual defect (there's no compiler to name a file at
all), or it's a compile error about a symbol that's MISUSED in a file you
can see but DEFINED somewhere else — "Property 'x' does not exist on type
'Y'" never says where 'Y' itself lives. The real cause is sometimes a
shared utility, type, or theme file this phase was never told to open, or
even a pre-existing bug in a completely different, unrelated screen — not
anything this phase's own change introduced. If this phase's own files
don't plausibly explain the failure after a focused look, use search_code
and get_symbol_definition across the WHOLE repository for a distinctive
literal from the failure above (an exact message fragment, a type/property/
export name, a specific id/key/string value) to locate the real file — you
are not limited to this phase's own files for that search, and inspecting
a genuinely large candidate set (dozens of files, if a failure references
several distinct symbols at once) is reasonable, not excessive. Once your
search concretely identifies the real file, you are explicitly authorized
to fix EXACTLY that file for this repair attempt only — do not touch
unrelated code in a file you open this way, and do not widen further than
what your search actually confirmed.`;
  }
  return "";
}

/**
 * Rough count of distinct errors described in one gate's failure detail —
 * sized to drive REPAIR_PLANNER's round budget below, never any pass/fail
 * decision. Counts lines containing the standalone word "error" (covers
 * both "error TS1234:" and a generic toolchain's "Error: ..." line) — an
 * already-clustered "[REPEATED Nx ...]" summary line (see
 * clusterRepeatedErrors in verifierTools.ts) only ever contributes its own
 * header line this way, correctly counting as the ONE shared root cause it
 * represents, not the N call sites it collapsed; its own continuation
 * lines ("First 2 occurrences:", bare locations) don't repeat the word.
 * \berror\b with a word boundary deliberately does not match "error" stuck
 * inside a longer identifier (errorContainer, NodeError, onError, ...), so
 * property/function names never inflate the count. A cluster's own example/
 * location lines ("First 2 occurrences:", the indented sample lines, "All
 * Nx occurrences: ...") are always rendered indented by clusterRepeatedErrors,
 * so skipping every indented line keeps a 7x cluster counting as the ONE
 * root cause it is, not 1 (header) + 2 (shown examples) = 3. The generic
 * "Error: Command failed: ..." wrapper every failed npm script prints is
 * excluded too — it names the failure happened, never what it was.
 */
export function countDistinctErrors(detail: string): number {
  return detail
    .split("\n")
    .filter((line) => /^\S/.test(line))
    .filter((line) => !/^Error: Command failed/i.test(line))
    .filter((line) => /\berror\b/i.test(line)).length;
}

/**
 * REPAIR_PLANNER's round budget, scaled to how much there actually is to
 * diagnose. It shares the main Planner's bounded-inspection role (see its
 * own doc comment in agentLoop.ts) and used to share its flat 8-round cap
 * too — sized for the common case of one or two errors, nowhere near
 * enough for a failure describing several distinct root causes across
 * several files. Two real failures hit this: 11 TypeScript errors across
 * 5-6 root causes, and separately 6 distinct wrong-API errors across one
 * file — both burned the full 8 rounds and returned "turn_limit reached"
 * with no diagnosis at all, handing REPAIR a cold start instead of a head
 * start. An earlier version of this scaled off `blockingFailures.length`
 * (the number of FAILED GATES) instead of the error count WITHIN each
 * gate's own detail text — a no-op in practice, since a single failed
 * build command is always exactly one blockingFailure entry no matter how
 * many compiler errors it bundles into that one entry's detail string.
 * Floored at the original 8 (a single simple error is unaffected) and
 * capped at the normal EDITOR/REPAIR ceiling (maxToolRounds) so a
 * pathological error count can't make triage itself unbounded.
 */
export function computeRepairPlannerMaxRounds(
  blockingFailures: BlockingFailure[] | undefined,
  maxToolRoundsCeiling: number
): number {
  const totalErrors = (blockingFailures ?? []).reduce((sum, f) => sum + countDistinctErrors(f.detail), 0);
  return Math.min(maxToolRoundsCeiling, Math.max(8, 8 + totalErrors * 2));
}

/**
 * A short, information-dense summary of a repair failure for
 * historicalPitfalls — the project's cross-task "don't repeat this"
 * memory, joined into every future Discovery prompt. A plain
 * `failureSnippet.slice(0, maxChars)` wasted nearly its whole budget on
 * boilerplate every npm-script build failure repeats verbatim: a real
 * stored entry read, in full —
 *
 *   npm run typecheck: exited 1
 *   > yimpim-remote@1.0.0 typecheck
 *   > node -e "if (require('fs').existsSync('tsconfig.json')) require('child_process').execSync('tsc --noEmit', {stdio: 'inherit'})"
 *   __tests__/e
 *
 * — cut off mid-filename, with zero actual defect information surviving.
 * Strips the two kinds of pure command-invocation noise (the leading
 * "<gate>: exited N" summary and any npm-preamble "> ..." line) before
 * truncating, so the character budget goes to the real compiler/test
 * output instead. A no-op for a gate whose detail never had that shape
 * (runtime/visual/semantic failures, which don't run through an npm
 * script at all) — only matching lines are removed, everything else
 * passes through untouched.
 */
export function extractPitfallSummary(failureSnippet: string, maxChars = 200): string {
  const meaningful = failureSnippet
    .split("\n")
    .filter((line) => !/\bexited\s+\d+\s*$/i.test(line) && !/^>\s/.test(line))
    .join("\n")
    .trim();
  return (meaningful.length > 0 ? meaningful : failureSnippet).slice(0, maxChars);
}

/** A gate that runs a test suite (as opposed to a compile, visual or review gate). */
const TEST_GATE_RE = /\b(tests?|jest|vitest|pytest|mocha|spec)\b/i;

export interface UnrelatedFailureVerdict {
  /** True only when EVERY blocking failure is a test-run failure whose text names none of the changed files. */
  unrelated: boolean;
  /** One line for the person deciding what to do, written for either outcome. */
  summary: string;
}

/**
 * Do the failing tests have anything to do with what this phase changed?
 *
 * Deliberately one-sided: it only ever says "unrelated" for a failure made
 * ENTIRELY of test-run output, and only when none of the changed files shows up
 * in that output — not as a full path, not as a file name, not as a word. A
 * stack trace from a real regression names the source file it passes through,
 * so absence is evidence. Anything it cannot judge (a compile error, a visual
 * defect, no changed files, no failure text) counts as related, which is the
 * same as today: repair gets to try.
 *
 * Pure so it can be tested; used to pause for a decision instead of spending a
 * repair loop (and reverting the phase) on failures the change did not cause.
 */
export function failuresUnrelatedToChange(
  failures: BlockingFailure[] | undefined,
  changedFiles: string[]
): UnrelatedFailureVerdict {
  const related = { unrelated: false, summary: "" };
  if (!failures || failures.length === 0 || changedFiles.length === 0) return related;
  if (!failures.every((f) => TEST_GATE_RE.test(f.gate))) return related;

  const text = failures.map((f) => f.detail ?? "").join("\n").toLowerCase();
  if (text.trim().length === 0) return related;

  const hay = text.replace(/\\/g, "/");
  for (const file of changedFiles) {
    const rel = file.replace(/\\/g, "/").toLowerCase();
    const base = (rel.split("/").pop() ?? rel).replace(/\.[a-z0-9]+$/, "");
    if (hay.includes(rel)) return related;
    // A bare, very short or generic name matches everywhere; treat as related
    // rather than risk telling someone a real regression is unrelated.
    if (base.length < 3) return related;
    if (new RegExp(`(^|[^a-z0-9])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay)) return related;
  }
  const shown = changedFiles.slice(0, 4).join(", ") + (changedFiles.length > 4 ? `, +${changedFiles.length - 4} more` : "");
  return {
    unrelated: true,
    summary: `none of the failing test output mentions the file(s) this phase changed (${shown})`,
  };
}
