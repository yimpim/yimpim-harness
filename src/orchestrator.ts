/**
 * Editor A -> Editor B handoff and the error interceptor.
 *
 * The orchestrator's phase-execution loop (`runPhaseWithHealing` in
 * index.ts) drives a single agent pass per phase via `runToolAgent`. This
 * module sits between the two and implements the analysis-paralysis
 * countermeasure:
 *
 * - A `ReadTracker` observes every tool call Editor A makes (fed through the
 *   `onToolCall` hook `runToolAgent` exposes). Two consecutive rounds of 8
 *   inspections with no edit in between means Editor A is stalled — reading
 *   without converging.
 * - When that happens, Editor A is benched and Editor B takes over the SAME
 *   phase, receiving a context prompt whose first block is the takeover
 *   directive (analysis-paralysis intervention), the original instructions,
 *   and the file trail Editor A already gathered so it does not re-explore.
 * - Editor B runs under an interceptor: model timeouts, OpenRouter HTTP 5xx
 *   failures and stall conditions are converted into *structured failure
 *   results* (`{ ok: false, failure: { kind, message } }`) instead of raw
 *   exceptions, so the caller's fallback state machine (replan + user
 *   escalation, a later phase) has a typed signal to react to.
 *
 * Everything here is pure orchestrator policy — no OpenRouter client, repo
 * tools or config are touched, which is what makes the takeover prompt
 * injection and the B-invocation contract independently testable.
 *
 * It also owns the three human-in-the-loop gates around the editor pass: the
 * dependency-install approval gate (a manifest edit needs an explicit yes
 * before a package manager runs), the diff-driven post-phase gate
 * (`handlePostPhaseDependencies`, which offers install / skip / abort before
 * QA), and `promptUserApproval`, the terminal yes/no prompt they are built on.
 * All three take their side effects (the prompter, the command runner) as
 * injected callbacks, so their decisions are testable without a terminal or a
 * real install.
 */
import readline from "readline/promises";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { exec, execFile } from "child_process";
import { createHash } from "crypto";
import { ReadTracker } from "./agent/readTracker.js";
import { probeJava, javaAwareEnv, winSafeCommand } from "./capabilities.js";
import { YES_NO, YES_NO_ENTER_NO } from "./promptStyle.js";

/** The analysis-paralysis intervention prepended to Editor B's context prompt. */
export const EDITOR_B_TAKEOVER_DIRECTIVE =
  "You are taking over this task because Editor A stalled in analysis paralysis without making changes. " +
  "The relevant context has already been gathered. Review the task and emit the necessary edit commands. " +
  "You are allowed up to 2 rounds of 8 reads, but you MUST produce concrete file edits.";

/**
 * The Planner-reformulation directive: the fallback that fires on the FIRST
 * Editor B failure of a phase (phase_replan_count === 0).
 *
 * The phase's instructions were written before anyone knew what the editor
 * would actually find, and both editor passes have now proven them
 * unactionable — so this asks for the ONE thing that can still move the phase
 * forward: a surgical rewrite of just this phase, informed by the concrete
 * failure reason and the file trail the editors actually gathered, instead of
 * a second blind attempt with identical wording.
 */
export const PLANNER_REFORMULATION_DIRECTIVE =
  "You are the Planner, reformulating ONE failed phase — not the plan. " +
  "Editor A stalled in analysis paralysis and Editor B failed to take over, so the phase's instructions " +
  "as written are not actionable. Rewrite ONLY this phase's instructions so a single editor pass can act " +
  "on them, using the failure reason and the file trail below as evidence of what does and does not exist. " +
  "Do not expand the phase's scope, do not re-plan other phases, and output ONLY the revised instructions " +
  "as plain text — no preamble, no markdown fences.";

/** Circuit-breaker marker: no fallback left, the human must choose a target. */
export const ESCALATE_TO_USER = "ESCALATE_TO_USER";

/** Every tool call the active editor makes while the caller executes it. */
export type TrackToolCall = (name: string, args: Record<string, unknown>) => void;

export interface EditorHandoffDeps {
  /**
   * Executes one complete editor pass with the given instructions. The second
   * argument is the tool-call sink the pass must feed (wire it into
   * `runToolAgent`'s `onToolCall`), so the orchestrator can track the pass's
   * read/edit pattern. The third argument is the ACTIVE EDITOR VARIANT —
   * `"editorA"` for the primary pass and `"editorB"` for the takeover pass —
   * which the caller uses to select that variant's model chain. Invoked first
   * for Editor A with the original instructions and, only if A stalled, a
   * second time for Editor B with the takeover prompt.
   */
  runEditor: (
    instructions: string,
    trackToolCall: TrackToolCall,
    variant?: "editorA" | "editorB"
  ) => Promise<string>;
  /** Whether the current phase has produced at least one real file write so far. */
  hasWrittenFiles: () => boolean;
  /** The phase instructions Editor A started with; embedded in Editor B's takeover prompt. */
  initialInstructions: string;
}

export type EditorHandoffFailureKind =
  /** The model request exceeded its timeout budget (DOMException `TimeoutError`). */
  | "model_timeout"
  /** OpenRouter returned a 5xx-class error, exhausting the client's retry budget. */
  | "openrouter_error"
  /** The editor stalled again — read rounds without edits — instead of converging. */
  | "stall"
  /** Anything else; still a structured failure so the caller never sees a raw crash. */
  | "other";

export interface EditorHandoffFailure {
  kind: EditorHandoffFailureKind;
  message: string;
  cause?: unknown;
}

export type EditorHandoffResult =
  /** An editor pass produced a usable conclusion (possibly after the A->B handoff). */
  | {
      ok: true;
      result: string;
      usedEditorB: boolean;
      editorAStalled: boolean;
      /** Distinct file paths inspected by Editor A and/or Editor B, unioned across both passes. */
      inspectedPaths: string[];
    }
  /** Editor B could not take over — a structured failure for the fallback state machine. */
  | {
      ok: false;
      editorAStalled: true;
      failure: EditorHandoffFailure;
      /** Distinct file paths inspected by Editor A and/or Editor B, unioned across both passes. */
      inspectedPaths: string[];
    };

/**
 * Builds Editor B's context prompt: the takeover directive first (prepended,
 * not appended — it is the intervention that reframes the whole pass), then
 * the original task instructions, then the list of files Editor A already
 * inspected so Editor B starts from gathered context instead of re-reading.
 */
export function buildEditorBContextPrompt(instructions: string, inspectedPaths: string[]): string {
  const gatheredContext =
    inspectedPaths.length > 0
      ? `\n\nFiles already inspected by Editor A (treat as gathered context — do not blindly re-read them; jump straight to edit decisions):\n${inspectedPaths
          .map((p) => `  - ${p}`)
          .join("\n")}`
      : "\n\nEditor A reported no inspected files before it stalled.";
  return `${EDITOR_B_TAKEOVER_DIRECTIVE}\n\nTask instructions:\n${instructions}${gatheredContext}`;
}

/**
 * The block that turns a user-supplied file path into a hard constraint on
 * Editor A's next pass. Wording is deliberately imperative — the point of the
 * escalation is that a human has just removed the editor's freedom to keep
 * choosing targets, so the constraint has to read as non-negotiable and
 * survive into the prompt verbatim.
 */
export function buildMandatoryTargetConstraint(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) return "";
  return (
    `MANDATORY TARGET FILE — the user has explicitly designated this path after automated escalation: ` +
    `${trimmed}\n` +
    `You MUST apply your change to this file. Inspect it FIRST (before any other file), and either patch it ` +
    `or create it if it does not exist yet. Do not substitute a different file and do not return without an ` +
    `edit to this exact path — reasoning, exploration, or a plan alone will not satisfy this phase.`
  );
}

/**
 * Builds the Planner's reformulation prompt: the reformulation directive, the
 * phase's goal, the structured failure reason injected into
 * `{{failure_reason}}`, and the evidence trail of what the editors actually
 * inspected. The placeholder is substituted literally so callers can template
 * their own wrapper text around it without re-deriving the block.
 */
export function buildPlannerReformulationPrompt(
  phaseGoal: string,
  failureReason: string,
  inspectedPaths: string[]
): string {
  const trail =
    inspectedPaths.length > 0
      ? inspectedPaths.map((p) => `  - ${p}`).join("\n")
      : "  (no files were inspected before the pass ended)";
  return (
    `${PLANNER_REFORMULATION_DIRECTIVE}\n\n` +
    `Phase goal as originally written:\n${phaseGoal}\n\n` +
    `{{failure_reason}} = ${failureReason}\n\n` +
    `--- Files the editors actually inspected before failing ---\n${trail}\n--- end ---`
  );
}

/**
 * Formats the circuit-breaker diagnostic shown to the user when a phase has
 * already spent its one replan and Editor B has failed again.
 *
 * The three things a human needs to answer "which file should I point this
 * at?" are exactly the three lines produced here: what the phase was trying to
 * achieve, why the automated attempts failed, and the concrete file trail both
 * editors walked before giving up (which is usually where the real target is
 * hiding, or conspicuously absent from).
 */
export function formatEscalationSummary(
  phaseGoal: string,
  failureReason: string,
  inspectedPaths: string[]
): string {
  const trail =
    inspectedPaths.length > 0
      ? inspectedPaths.map((p) => `  - ${p}`).join("\n")
      : "  (no files were inspected before the pass ended)";
  return [
    `${ESCALATE_TO_USER}: Editor paralyzed or failing on phase execution.`,
    `Target phase goal:`,
    phaseGoal,
    `Failure reason:`,
    failureReason,
    `Files inspected before giving up (distinct):`,
    trail,
  ].join("\n");
}

/**
 * The replan budget's decision function — the single branch point of the
 * Editor A -> Editor B -> Planner fallback state machine.
 *
 * `phaseReplanCount` is per phase execution and starts at 0:
 *  - `0` -> `"replan"`: the phase is still worth one automated retry, so the
 *    Planner reformulates just this phase and Editor A re-runs with it.
 *  - `>= 1` -> `"escalate"`: the reformulation has already been spent and the
 *    editor still cannot land the phase, so no automated move remains and the
 *    human has to name a target file.
 *
 * Kept pure and separate from index.ts's loop so the budget boundary (exactly
 * one replan, escalation from the second failure onward) is directly testable
 * rather than only observable by reading the orchestrator.
 */
export type EditorFailureAction = "replan" | "escalate";

export function decideEditorFailureAction(phaseReplanCount: number): EditorFailureAction {
  return phaseReplanCount >= 1 ? "escalate" : "replan";
}

/**
 * Maps a thrown error from an editor pass to its structured failure kind.
 *
 * The classification targets exactly what this pipeline can actually produce:
 * `OpenRouterClient.complete` (openrouter.ts) throws a DOMException named
 * `TimeoutError` when the 120s request budget is spent, and after retrying
 * 429/5xx responses internally it either throws `HTTP <status>: <body>` (any
 * non-retried status) or lands on the umbrella "Failed all configured model
 * attempts." once every model/retry is exhausted — the 5xx classes and that
 * umbrella message are the reliable fingerprints, since the underlying body
 * text varies. Stall errors carry the agent loop's own
 * `CIRCUIT_BREAKER_STUCK` sentinel or analysis-paralysis wording.
 */
export function classifyEditorError(err: unknown): EditorHandoffFailure {
  const e = err as { name?: unknown; message?: unknown } | undefined;
  const name = typeof e?.name === "string" ? e.name : "";
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");

  if (name === "TimeoutError") {
    return { kind: "model_timeout", message, cause: err };
  }
  if (/\bHTTP 5\d\d\b|STATUS 5\d\d|Provider Error|Failed all configured model attempts/i.test(message)) {
    return { kind: "openrouter_error", message, cause: err };
  }
  if (/\bCIRCUIT_BREAKER_STUCK\b|analysis paralysis|not converging|stall/i.test(message)) {
    return { kind: "stall", message, cause: err };
  }
  return { kind: "other", message, cause: err };
}

/**
 * Turns a classified editor failure into its canonical, user-facing reason
 * string.
 *
 * `classifyEditorError` preserves the raw model/client message (live detail
 * for debugging, and it rides along in `failure.cause`); this produces the
 * stable normalized wording the handoff contract exposes — e.g. an HTTP 500
 * from the model API becomes `Editor B model API error (HTTP 500)` and a
 * tripped 2x8 read budget becomes `Editor B stalled after 16 pure reads` —
 * so callers, logs and the eventual escalation UI never see OpenRouter's
 * raw, per-model error text.
 */
export function normalizeEditorFailureMessage(kind: EditorHandoffFailureKind, rawMessage: string): string {
  switch (kind) {
    case "model_timeout":
      return "Editor B timed out";
    case "openrouter_error": {
      const status = rawMessage.match(/\bHTTP (5\d\d)\b/)?.[1];
      return status ? `Editor B model API error (HTTP ${status})` : "Editor B model API error (HTTP 5xx)";
    }
    case "stall":
      return `Editor B stalled after ${ReadTracker.READS_PER_ROUND * ReadTracker.MAX_CONSECUTIVE_READ_ROUNDS} pure reads`;
    case "other":
      return `Editor B failed with unexpected error: ${rawMessage}`;
  }
}

/**
 * Unions the distinct inspected-file paths of one or more trackers into a
 * stable, de-duplicated list — Editor A's paths first, then any paths only
 * Editor B looked at — so the handoff payload aggregates the full inspection
 * trail across both editor passes.
 */
function aggregateInspectedPaths(...trackers: ReadTracker[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const tracker of trackers) {
    for (const p of tracker.inspectedPaths) {
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/**
 * Runs the phase's editor with analysis-paralysis detection and the A->B
 * handoff:
 *
 * 1. Editor A runs with the phase's original instructions while every tool
 *    call it makes feeds a fresh `ReadTracker`.
 * 2. If A completed two full rounds of 8 inspections without any edit (its
 *    own tracker says stalled) AND the phase has no file writes, A is
 *    benched and B takes over with `buildEditorBContextPrompt` and a fresh
 *    read budget of its own.
 * 3. Editor B runs under the interceptor: a thrown model timeout / OpenRouter
 *    5xx / stall error, or B converging on no edits — its own tracker
 *    exhausting the full 2x8 pure-read budget, or returning the
 *    circuit-breaker sentinel — becomes a structured failure result instead
 *    of a raw exception, carrying the union of every inspected file path
 *    across both passes and a normalized failure reason.
 *
 * Editor A's own errors are deliberately NOT intercepted here — index.ts's
 * existing `ESCALATION_NEEDED` handling depends on them propagating
 * unchanged (a CANNOT_LOCATE from a fresh pass is a different contract than a
 * take-over pass failing to land).
 */
export async function runEditorWithHandoff(deps: EditorHandoffDeps): Promise<EditorHandoffResult> {
  const trackerA = new ReadTracker();
  let result = await deps.runEditor(
    deps.initialInstructions,
    (name, args) => trackerA.recordToolCall(name, args),
    "editorA"
  );

  // The tracker counts full read rounds, so a stall here means Editor A read
  // for 2 rounds straight with no edit — analysis paralysis, not a hasty
  // conclusion. Any real write (tracked or not) means A produced something,
  // so the handoff must not fire over it. The circuit-breaker sentinel
  // (`CIRCUIT_BREAKER_STUCK`) is a stall too: the agent loop tripped its own
  // breaker instead of converging on an edit, so Editor A must be benched on
  // the SAME condition Editor B is benched on.
  const editorAStalled =
    (trackerA.hasStalled() && deps.hasWrittenFiles() === false) ||
    result.startsWith("CIRCUIT_BREAKER_STUCK");
  if (!editorAStalled) {
    return {
      ok: true,
      result,
      usedEditorB: false,
      editorAStalled: false,
      inspectedPaths: aggregateInspectedPaths(trackerA),
    };
  }

  console.log(
    `\n[EDITOR A] ⚠️ Stalled: ${ReadTracker.MAX_CONSECUTIVE_READ_ROUNDS} consecutive rounds of ` +
      `${ReadTracker.READS_PER_ROUND} reads with zero edits (analysis paralysis).`
  );
  console.log(`[HANDOFF] Benching Editor A; handing the phase to Editor B with the takeover directive.`);

  const takeoverPrompt = buildEditorBContextPrompt(deps.initialInstructions, [...trackerA.inspectedPaths]);

  // Editor B gets a FRESH tracker: its own "2 rounds of 8 reads" budget,
  // exactly as the takeover directive promises.
  const trackerB = new ReadTracker();
  try {
    result = await deps.runEditor(
      takeoverPrompt,
      (name, args) => trackerB.recordToolCall(name, args),
      "editorB"
    );
  } catch (err) {
    // Timeout / OpenRouter 5xx / stall errors never escape as raw exceptions:
    // the caller's fallback state machine consumes the structured failure
    // with a normalized reason; the raw error stays in `cause` for debugging.
    const classified = classifyEditorError(err);
    return {
      ok: false,
      editorAStalled: true,
      failure: {
        kind: classified.kind,
        message: normalizeEditorFailureMessage(classified.kind, classified.message),
        cause: err,
      },
      inspectedPaths: aggregateInspectedPaths(trackerA, trackerB),
    };
  }

  // Editor B also failed to converge — either its own tracker saw the full
  // 2x8 pure-read budget consumed with no edit (read-loop exhaustion, exactly
  // the condition Editor A's tracker detects for the original pass), or it
  // returned the agent loop's circuit-breaker sentinel. Both mean the
  // directive's "you MUST produce concrete file edits" went unheard, and
  // both become the same structured stall failure the fallback state machine
  // reacts to, with a normalized reason and the raw conclusion in `cause`.
  // Guarded by the writes check: an Editor B that DID edit before stalling
  // or hitting the breaker still produced output, so its result flows
  // through to verification instead.
  if (deps.hasWrittenFiles() === false) {
    const editorBStalled = trackerB.hasStalled() || result.startsWith("CIRCUIT_BREAKER_STUCK");
    if (editorBStalled) {
      return {
        ok: false,
        editorAStalled: true,
        failure: { kind: "stall", message: normalizeEditorFailureMessage("stall", result), cause: result },
        inspectedPaths: aggregateInspectedPaths(trackerA, trackerB),
      };
    }
  }

  return {
    ok: true,
    result,
    usedEditorB: true,
    editorAStalled: true,
    inspectedPaths: aggregateInspectedPaths(trackerA, trackerB),
  };
}

/**
 * What a resolved manifest command actually does:
 *  - `"install"`: fetches/installs the declared dependencies into the project
 *    (`npm install`, `bundle install`, `conan install .`).
 *  - `"restore"`: re-resolves the dependency graph and rebuilds against it
 *    (`./gradlew build --refresh-dependencies`, `cargo check`, `go mod tidy`),
 *    rather than only downloading packages.
 */
export type ManifestAction = "install" | "restore";

/**
 * One dependency manifest family this gate knows how to install for: which
 * written files trigger it, what the file's diff has to touch to count, and
 * the command that makes the project's dependency set match the manifest again.
 *
 * Matching is by BASENAME, not by full path, because the same manifest moves
 * around between ecosystems (a `package.json` at the repo root vs. one inside
 * a workspace package, `libs.versions.toml` under `gradle/`, a `Podfile` in
 * `ios/`) while the install command stays the same. Matching the whole path
 * would silently miss every nested case.
 */
export interface ManifestRuleInput {
  /** Stable identifier for the manifest family, e.g. `"npm"`. */
  id: string;
  /** Human-readable description used in the approval prompt. */
  label: string;
  /**
   * Basename globs that mark a written file as this manifest. `*` matches any
   * run of characters (`*.csproj`); every other pattern is an exact basename.
   * Matching is case-insensitive, since the same manifest is written
   * `Podfile`/`podfile` and `Cargo.toml`/`cargo.toml` depending on whose
   * machine produced it.
   */
  filePatterns: string[];
  /**
   * Substrings that must appear in the manifest's diff for the edit to count
   * as a dependency change (`"<dependency"`, `"[dependencies]"`). An EMPTY
   * list means every edit to this file is a dependency change — a
   * `requirements.txt` has no section markers to look for. Only consulted
   * when a diff is actually available; see `detectChangedManifests`.
   */
  diffTriggers: string[];
  /** The command that installs/syncs dependencies for this manifest. */
  command: string;
  /** What kind of command `command` is. */
  action: ManifestAction;
  /**
   * Maps the manifest's containing directory (relative to the repo root;
   * `""` means the root itself) to the directory the command must actually run
   * in. Defaults to the containing directory — the subproject the manifest
   * belongs to — which is what puts `npm install` in `web/` for
   * `web/package.json` and `pod install` in `ios/` for `ios/Podfile`.
   */
  commandDir?: (manifestDir: string) => string;
  /**
   * Basenames of this ecosystem's generated LOCK file(s), when it has one —
   * distinct from `filePatterns` (the human-edited manifest that declares
   * intent): a lock file is machine-generated, pins resolved versions, and
   * is never itself the subject of a requirement. Omitted for ecosystems
   * with no standard committed lock file (Maven, Gradle by default, vcpkg).
   * The single source LOCK_FILE_NAMES (derived below) is consumed by
   * staticQa.ts's own lock-file handling, so every ecosystem this registry
   * already knows about gets that treatment automatically — see
   * ChangeSet.lockFiles' own comment for why a lock file needs different
   * treatment than ordinary vendor/build noise.
   */
  lockFiles?: string[];
}

/**
 * A manifest family after the registry has built it: the declaration itself
 * plus `getInstallCommand()`, the command that makes the project's dependency
 * set match the manifest again.
 *
 * The command is reached through a method as well as the plain `command`
 * property so the diff-driven gate (`inspectFileForNewDependencies`) and the
 * write-driven gate (`detectChangedManifests`) both ask the SAME declaration
 * for it — several entries deliberately share one `./gradlew` invocation, so
 * there is exactly one place per family that decides what running it means.
 */
export interface ManifestRule extends ManifestRuleInput {
  /** The command that installs/syncs dependencies for this manifest. */
  getInstallCommand: () => string;
}

/**
 * A written file's diff text, used to check a rule's `diffTriggers`. Callers
 * that have a diff pass these in; callers that only know which files were
 * written simply omit them, and every matched manifest then counts.
 */
export interface ManifestDiff {
  /** Path of the changed file, relative to the repo root. */
  path: string;
  /** The file's unified diff (or any text containing its changed lines). */
  text: string;
}

/** A manifest family that a set of written files actually touched. */
export interface ManifestMatch {
  /** Convenience mirror of `rule.id`. */
  id: string;
  /** Convenience mirror of `rule.label`. */
  label: string;
  /** Convenience mirror of `rule.command`. */
  command: string;
  /** Convenience mirror of `rule.action`. */
  action: ManifestAction;
  /** The written manifest file, normalized to forward slashes. */
  path: string;
  /** Directory the command must run in, relative to the repo root (`""` = root). */
  cwd: string;
  /** The full declaration that matched. */
  rule: ManifestRule;
}

/**
 * True when `basename` matches one of a rule's `filePatterns`. `*` is the only
 * wildcard (`*.csproj`); everything else is compared literally, case-folded.
 */
export function matchesManifestPattern(basename: string, pattern: string): boolean {
  const name = String(basename ?? "").trim().toLowerCase();
  const pat = String(pattern ?? "").trim().toLowerCase();
  if (!name || !pat) return false;
  if (!pat.includes("*")) return name === pat;
  const escaped = pat
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Normalizes a relative directory to forward slashes with no leading `./` and
 * no trailing slash; `""` always means "the repo root".
 */
function normalizeRelativeDir(dir: string): string {
  return String(dir ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * The Gradle version catalog sits in a `gradle/` folder that is never where
 * `gradlew` lives — the build root is its PARENT.
 */
function gradleCatalogCommandDir(manifestDir: string): string {
  const normalized = normalizeRelativeDir(manifestDir);
  const stripped = normalized.replace(/(^|\/)gradle$/, "");
  return normalizeRelativeDir(stripped);
}

/**
 * `gradlew`/`gradlew.bat` always live at the Gradle project root — never in
 * a module's own subdirectory. A module-level manifest (`app/build.gradle.kts`,
 * the common case for any multi-module Android project) is NOT where the
 * wrapper lives, so — unlike most other ecosystems, where a manifest's own
 * containing directory is already the right place to run its command —
 * every Gradle Kotlin/Groovy DSL change must always resolve to the repo
 * root, regardless of which module's manifest actually changed. Without
 * this, a change to `app/build.gradle.kts` ran the install command IN
 * `app/`, where no wrapper exists at all: `'gradlew.bat' is not recognized
 * as an internal or external command` — a confusing error that looks like a
 * missing/misnamed binary, not a wrong working directory.
 */
function gradleRootCommandDir(): string {
  return "";
}

/** Paths whose contents are never the project's own dependency manifest. */
const IGNORED_MANIFEST_DIRS = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".git",
  ".venv",
  "venv",
  "target",
  ".gradle",
  "Pods",
  "__pycache__",
  ".tox",
];

/**
 * The dependency lines in a Gradle build script look different in the Kotlin
 * and Groovy DSLs (parens vs. no parens) but share the same configuration
 * names, so both Gradle rules use this one trigger list.
 */
const GRADLE_DEPENDENCY_TRIGGERS = [
  "dependencies",
  "implementation",
  "classpath",
  "compileonly",
  "runtimeonly",
  "annotationprocessor",
  "testimplementation",
  "androidtestimplementation",
  "plugins {",
  "libs.",
];

/**
 * `./gradlew` is POSIX-shell relative-path syntax — cmd.exe (what
 * child_process.exec shells out through on Windows) doesn't resolve a
 * leading `./` the way bash does, and fails with a confusing "'.' is not
 * recognized as an internal or external command" rather than anything that
 * looks like a path problem. cmd.exe DOES implicitly search the current
 * directory for a bare command name (unlike POSIX shells, which require the
 * explicit `./` precisely because they don't), so the fix on Windows is
 * simply dropping the prefix and using the wrapper's actual Windows
 * filename — the same platform check buildGate's own gradle wrapper
 * resolution already makes (capabilities.ts's probeGradleWrapper).
 */
const GRADLE_INSTALL_COMMAND =
  process.platform === "win32" ? "gradlew.bat build --refresh-dependencies" : "./gradlew build --refresh-dependencies";

/**
 * The registry's raw rows: every family declared with its install command
 * literally beside the `filePatterns` / `diffTriggers` that trigger it, so a
 * reviewer can see at a glance what each manifest's command is. The 19
 * supported ecosystems are listed in a stable order; several map to the SAME
 * command (Gradle's Kotlin script, its Groovy script and its version catalog
 * are three triggers for one `./gradlew` invocation), which is why the gate
 * de-duplicates by command-and-directory rather than by manifest.
 * `MANIFEST_REGISTRY` below attaches `getInstallCommand()` to each row.
 */
const MANIFEST_RULES: ManifestRuleInput[] = [
  {
    id: "npm",
    label: "package.json (npm/Node dependencies)",
    filePatterns: ["package.json"],
    diffTriggers: [
      '"dependencies"',
      '"devdependencies"',
      '"peerdependencies"',
      '"optionaldependencies"',
      '"overrides"',
      '"resolutions"',
      '"packagemanager"',
    ],
    // --ignore-scripts: a dependency install must never run an arbitrary
    // postinstall script from a third-party package as a side effect of the
    // editor having touched the manifest.
    command: "npm install --ignore-scripts",
    action: "install",
    // Only one of these three is ever actually present in a given repo
    // (whichever package manager it uses), but listing all three costs
    // nothing and needs no per-project detection.
    lockFiles: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  },
  {
    id: "pip-requirements",
    label: "requirements.txt / constraints.txt (pip dependencies)",
    filePatterns: ["requirements*.txt", "constraints.txt"],
    // No section markers exist in a requirements file — every line is a
    // dependency, so every edit to it counts.
    diffTriggers: [],
    command: "pip install -r requirements.txt",
    action: "install",
  },
  {
    id: "pyproject",
    label: "pyproject.toml (Python project dependencies)",
    filePatterns: ["pyproject.toml"],
    diffTriggers: [
      "[project]",
      "dependencies",
      "[dependency-groups]",
      "[project.optional-dependencies]",
      "[tool.poetry.dependencies]",
      "[tool.poetry.group",
      "[tool.uv]",
    ],
    command: "pip install .",
    action: "install",
    lockFiles: ["poetry.lock", "uv.lock"],
  },
  {
    id: "pipenv",
    label: "Pipfile (Pipenv virtualenv dependencies)",
    filePatterns: ["Pipfile"],
    diffTriggers: ["[packages]", "[dev-packages]", "[requires]"],
    command: "pipenv install",
    action: "install",
    lockFiles: ["Pipfile.lock"],
  },
  {
    id: "gradle-kts",
    label: "build.gradle.kts / settings.gradle.kts (Kotlin DSL dependencies)",
    filePatterns: ["build.gradle.kts", "settings.gradle.kts"],
    diffTriggers: GRADLE_DEPENDENCY_TRIGGERS,
    command: GRADLE_INSTALL_COMMAND,
    action: "restore",
    commandDir: gradleRootCommandDir,
  },
  {
    id: "gradle-groovy",
    label: "build.gradle / settings.gradle (Groovy DSL dependencies)",
    filePatterns: ["build.gradle", "settings.gradle"],
    diffTriggers: GRADLE_DEPENDENCY_TRIGGERS,
    command: GRADLE_INSTALL_COMMAND,
    commandDir: gradleRootCommandDir,
    action: "restore",
  },
  {
    id: "gradle-version-catalog",
    label: "libs.versions.toml (Gradle version catalog)",
    filePatterns: ["libs.versions.toml"],
    diffTriggers: ["[versions]", "[libraries]", "[bundles]", "[plugins]"],
    command: GRADLE_INSTALL_COMMAND,
    action: "restore",
    // The catalog lives in `gradle/`, which is never where `gradlew` is —
    // the Gradle build root is its PARENT directory.
    commandDir: gradleCatalogCommandDir,
  },
  {
    id: "maven",
    label: "pom.xml (Maven dependencies)",
    filePatterns: ["pom.xml"],
    diffTriggers: ["<dependency", "<parent", "<plugin", "<exclusion", "<repositories"],
    command: "mvn -B -DskipTests dependency:resolve",
    action: "restore",
  },
  {
    id: "pub",
    label: "pubspec.yaml (Dart/Flutter dependencies)",
    filePatterns: ["pubspec.yaml"],
    diffTriggers: ["dependencies:", "dev_dependencies:", "dependency_overrides:"],
    command: "flutter pub get",
    action: "install",
    lockFiles: ["pubspec.lock"],
  },
  {
    id: "cargo",
    label: "Cargo.toml (Rust dependencies)",
    filePatterns: ["Cargo.toml"],
    diffTriggers: [
      "[dependencies]",
      "[dev-dependencies]",
      "[build-dependencies]",
      "[workspace.dependencies]",
      "[target.",
      "[patch.",
      "[features]",
    ],
    command: "cargo check",
    action: "restore",
    lockFiles: ["Cargo.lock"],
  },
  {
    id: "go",
    label: "go.mod (Go modules)",
    filePatterns: ["go.mod"],
    // Every line in a go.mod is a module directive.
    diffTriggers: [],
    command: "go mod tidy",
    action: "restore",
    lockFiles: ["go.sum"],
  },
  {
    id: "cocoapods",
    label: "Podfile (iOS CocoaPods dependencies)",
    filePatterns: ["Podfile"],
    diffTriggers: [],
    command: "pod install",
    action: "install",
    lockFiles: ["Podfile.lock"],
  },
  {
    id: "spm",
    label: "Package.swift (Swift Package Manager dependencies)",
    filePatterns: ["Package.swift"],
    diffTriggers: ["dependencies:", ".package("],
    command: "swift package resolve",
    action: "restore",
    lockFiles: ["Package.resolved"],
  },
  {
    id: "composer",
    label: "composer.json (PHP Composer dependencies)",
    filePatterns: ["composer.json"],
    diffTriggers: ['"require"', '"require-dev"', '"repositories"'],
    command: "composer install",
    action: "install",
    lockFiles: ["composer.lock"],
  },
  {
    id: "bundler",
    label: "Gemfile (Ruby Bundler dependencies)",
    filePatterns: ["Gemfile"],
    diffTriggers: [],
    command: "bundle install",
    action: "install",
    lockFiles: ["Gemfile.lock"],
  },
  {
    id: "dotnet",
    label: ".NET project file (*.csproj / *.fsproj / *.vbproj dependencies)",
    filePatterns: ["*.csproj", "*.fsproj", "*.vbproj", "Directory.Packages.props", "packages.config"],
    diffTriggers: ["<packagereference", "<packageversion", "<packagedownload", "<frameworkreference", "<projectreference"],
    command: "dotnet restore",
    action: "restore",
    // Opt-in (<RestorePackagesWithLockFile>) and not every .NET project uses
    // it, but when it IS present it is exactly the same "auto-generated,
    // pins resolved versions" shape as every other lock file here.
    lockFiles: ["packages.lock.json"],
  },
  {
    id: "vcpkg",
    label: "vcpkg.json (C/C++ vcpkg manifest dependencies)",
    filePatterns: ["vcpkg.json"],
    diffTriggers: ['"dependencies"', '"overrides"'],
    command: "vcpkg install",
    action: "install",
  },
  {
    id: "conan",
    label: "conanfile.txt / conanfile.py (C/C++ Conan dependencies)",
    filePatterns: ["conanfile.txt", "conanfile.py"],
    diffTriggers: ["[requires]", "[tool_requires]", "[build_requires]", "requires ="],
    command: "conan install .",
    action: "install",
    // Opt-in (conan lock create), same caveat as the .NET entry above.
    lockFiles: ["conan.lock"],
  },
  {
    id: "mix",
    label: "mix.exs (Elixir Mix dependencies)",
    filePatterns: ["mix.exs"],
    diffTriggers: ["defp deps", "deps =", "{:"],
    command: "mix deps.get",
    action: "install",
    lockFiles: ["mix.lock"],
  },
];

/**
 * The 19 supported dependency-manifest ecosystems, in a stable order, each
 * carrying the `getInstallCommand()` its declaration resolves to. Several
 * entries map to the SAME command (Gradle's Kotlin script, its Groovy script
 * and its version catalog are three triggers for one `./gradlew` invocation),
 * which is why the gate de-duplicates by command-and-directory rather than by
 * manifest.
 */
export const MANIFEST_REGISTRY: ManifestRule[] = MANIFEST_RULES.map((rule) => ({
  ...rule,
  getInstallCommand: () => rule.command,
}));

/**
 * Every known lock-file basename across every ecosystem this registry
 * supports, deduplicated — the single source staticQa.ts's lock-file
 * handling (ChangeSet.lockFiles) is built from, so a dependency-update task
 * on ANY of these 19 ecosystems (not just npm) gets the same treatment:
 * tracked as a real change, never silently invisible, but never flooding a
 * reviewer with its own auto-generated diff either. Adding a 20th ecosystem
 * to MANIFEST_RULES above with its own `lockFiles` entry is the only thing
 * needed for that stack to get this for free — nothing in staticQa.ts
 * itself needs to change.
 */
export const LOCK_FILE_NAMES: string[] = Array.from(
  new Set(MANIFEST_RULES.flatMap((rule) => rule.lockFiles ?? []))
);

/**
 * The DIRECTORY a written file lives in, relative to the repo root — `""` for
 * a root-level file, `"web"` for `web/package.json`, `"buildSrc"` for
 * `buildSrc/pom.xml`. Forward-slashed and with no trailing separator, so it
 * composes cleanly with `path.join`.
 */
function manifestDirOf(relativePath: string): string {
  const normalized = normalizeRelativeDir(relativePath);
  const cut = normalized.lastIndexOf("/");
  return cut === -1 ? "" : normalized.slice(0, cut);
}

/** Whether a diff's text contains any of a rule's triggers (case-insensitive). */
function diffEvidencesManifest(rule: ManifestRule, text: string): boolean {
  const haystack = String(text ?? "").toLowerCase();
  if (!haystack) return false;
  return rule.diffTriggers.some((trigger) => haystack.includes(trigger.toLowerCase()));
}

/**
 * The manifest families a set of written file paths actually touched, with
 * each match carrying the directory its install must run in.
 *
 * `diffs` is optional and deliberately fail-open: when a manifest's diff is
 * supplied, its `diffTriggers` decide whether the edit really was a dependency
 * change (touching `package.json` only to edit the `"scripts"` block must not
 * trigger an install); when no diff is supplied for that file — an untracked
 * new manifest, or a caller that only knows which files were written — the
 * match stands on the basename alone, exactly as before.
 *
 * Paths are ignored when they pass through a vendored/build directory
 * (`node_modules`, `vendor`, `Pods`, `target`, …), since a copy of a manifest
 * inside one is never the project's own dependency declaration.
 */
export function detectChangedManifests(writtenFiles: string[], diffs: ManifestDiff[] = []): ManifestMatch[] {
  const diffByPath = new Map<string, string>();
  for (const diff of diffs) {
    const key = normalizeRelativeDir(String(diff?.path ?? ""));
    if (key) diffByPath.set(key.toLowerCase(), String(diff?.text ?? ""));
  }

  const matches: ManifestMatch[] = [];
  const seen = new Set<string>();

  for (const written of writtenFiles) {
    const normalized = normalizeRelativeDir(String(written ?? ""));
    if (!normalized) continue;
    const segments = normalized.split("/").filter(Boolean);
    if (segments.some((s) => IGNORED_MANIFEST_DIRS.includes(s))) continue;
    const basename = segments[segments.length - 1];
    if (!basename) continue;

    const rule = MANIFEST_REGISTRY.find((candidate) =>
      candidate.filePatterns.some((pattern) => matchesManifestPattern(basename, pattern))
    );
    if (!rule) continue;

    // A diff, when we have real content for this file, is authoritative: an
    // edit that touches none of the dependency markers is not a dependency
    // change. An absent or blank diff stays fail-open — the basename decides,
    // so a brand-new untracked manifest is never silently skipped.
    const diffText = diffByPath.get(normalized.toLowerCase()) ?? "";
    if (diffText.trim() !== "" && rule.diffTriggers.length > 0 && !diffEvidencesManifest(rule, diffText)) {
      continue;
    }

    const manifestDir = manifestDirOf(normalized);
    const cwd = normalizeRelativeDir(rule.commandDir ? rule.commandDir(manifestDir) : manifestDir);

    // Two spellings of the same file ("./package.json" and "package.json")
    // are one change, not two.
    const key = `${rule.id}::${normalized.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    matches.push({ id: rule.id, label: rule.label, command: rule.getInstallCommand(), action: rule.action, path: normalized, cwd, rule });
  }

  // Registry order rather than write order, so the resolved command list is
  // stable regardless of which manifest the editor happened to touch first.
  const registryOrder = new Map<string, number>(
    MANIFEST_REGISTRY.map((rule, i): [string, number] => [rule.id, i])
  );
  return matches.sort((a, b) => (registryOrder.get(a.id) ?? 0) - (registryOrder.get(b.id) ?? 0));
}

/**
 * The distinct install commands implied by a set of written files — empty when
 * nothing dependency-related changed, which is the common case (a pure UI or
 * logic edit should never ask the user anything).
 */
export function resolveInstallCommands(writtenFiles: string[], diffs: ManifestDiff[] = []): string[] {
  const commands: string[] = [];
  for (const match of detectChangedManifests(writtenFiles, diffs)) {
    if (!commands.includes(match.command)) commands.push(match.command);
  }
  return commands;
}

/**
 * The full install plan: one entry per distinct (command, cwd) pair a set of
 * written manifests resolves to. This is what the gate actually executes —
 * `resolveInstallCommands` exists for callers that only need the display
 * strings — so a monorepo with both `web/package.json` and `api/go.mod`
 * installs each in ITS OWN subproject directory instead of both at the root.
 */
export function resolveInstallPlan(writtenFiles: string[], diffs: ManifestDiff[] = []): ManifestMatch[] {
  const plan: ManifestMatch[] = [];
  for (const match of detectChangedManifests(writtenFiles, diffs)) {
    if (plan.some((existing) => existing.command === match.command && existing.cwd === match.cwd)) continue;
    plan.push(match);
  }
  return plan;
}

/**
 * Which approval suffix a prompt is rendered with.
 *  - `"default"`: `(yes/no, Enter = no)` — Enter means NO, the safe default for a
 *    side-effecting command (dependency installs).
 *  - `"explicit"`: `(yes/no)` — no default is implied; the user must answer, which
 *    is what a destructive confirmation (file deletion) asks for.
 */
export type ApprovalPromptStyle = "default" | "explicit";

/** Per-call presentation options for `promptUserApproval`. */
export interface ApprovalPromptOptions {
  /** Which suffix to append when the question does not already carry one. */
  style?: ApprovalPromptStyle;
}

/**
 * Matches a question that ALREADY ends in an approval suffix — `[y/N]`,
 * `[Y/N]`, `[Y/n]`, `[y/n]` — so the helper never stacks a second suffix onto
 * a caller that spelled its own prompt out.
 */
const APPROVAL_SUFFIX_PATTERN = /\s*(\[[yYnN]\/[yYnN]\]|\[yes\/no\]|\(yes\/no[^)]*\))\s*$/;

/**
 * Renders the exact line handed to readline for an approval question.
 *
 * A question that already ends in an approval suffix keeps that suffix
 * verbatim — a caller asking `"Delete 3 files? [Y/N]"` must be asked exactly
 * that, not have `[y/N]` bolted on after it (which would read as two
 * contradictory defaults). Otherwise the suffix is appended per `style`.
 */
export function buildApprovalPromptLine(question: string, style: ApprovalPromptStyle = "default"): string {
  const base = String(question ?? "").trimEnd();
  if (APPROVAL_SUFFIX_PATTERN.test(base)) return `${base}: `;
  return `${base} ${style === "explicit" ? YES_NO : YES_NO_ENTER_NO}: `;
}

/**
 * The single answer parser behind every approval prompt: case-insensitive
 * `y`/`yes` (and any other answer starting with "y", e.g. "yep") is YES;
 * `n`/`no`, a bare Enter, whitespace-only input, and anything unrecognized are
 * NO. The default is deliberately the negative one — the prompts this backs
 * gate side-effecting commands, so silence must never be read as consent.
 */
export function parseApprovalAnswer(answer: string): boolean {
  const value = String(answer ?? "").trim().toLowerCase();
  if (value === "") return false;
  if (value === "n" || value === "no") return false;
  return value.startsWith("y");
}

/**
 * Ask the user a yes/no question on the terminal, then close the interface
 * immediately.
 *
 * The immediate `close()` is the point: a readline Interface left open after
 * its answer keeps stdin flowing in raw mode and swallows the next prompt's
 * keystrokes — the exact back-to-back-prompt failure terminalPrompt.ts exists
 * to work around.
 *
 * The suffix is not hardcoded: a question that already ends in `[Y/N]` /
 * `[y/N]` keeps it exactly as written, and callers that want the explicit
 * all-caps form pass `{ style: "explicit" }`. Anything other than an explicit
 * "y"/"yes" (including a read error, an empty answer, or whitespace) is a NO,
 * because these prompts gate real, side-effecting commands.
 */
export async function promptUserApproval(
  question: string,
  options: ApprovalPromptOptions = {}
): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(buildApprovalPromptLine(question, options.style ?? "default"));
    return parseApprovalAnswer(answer);
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export interface DependencyInstallGateOptions {
  /** The files the phase actually wrote (agentTools.filesWrittenThisPhase()). */
  writtenFiles: string[];
  /** Repository root; a nested manifest's command runs in its own subdirectory of this. */
  cwd: string;
  /**
   * Optional diffs for the written files. When one is supplied for a
   * manifest, its `diffTriggers` decide whether the edit was really a
   * dependency change; with no diff, the basename match alone decides.
   */
  diffs?: ManifestDiff[];
  /** Interactive approval callback; defaults to `promptUserApproval`. */
  prompter?: (message: string) => Promise<boolean>;
  /** Command runner; defaults to a promisified `child_process.exec`. */
  executor?: (command: string, cwd: string) => Promise<void>;
  /** npm registry version check; defaults to `verifyAndFixNpmVersions` (a real
   *  network call). Overridable so tests never need actual registry access. */
  npmVersionVerifier?: (
    absoluteManifestPath: string,
    cwd: string
  ) => Promise<Array<{ pkg: string; from: string; to: string }>>;
}

export interface DependencyInstallGateResult {
  /** True only when the command(s) were approved AND ran without throwing. */
  executed: boolean;
  /** The resolved install command(s) — present whenever any manifest changed. */
  command?: string;
  /**
   * The distinct (command, directory) pairs resolved for this phase, in
   * execution order — `cwd` here is absolute, and already points at the
   * subproject a nested manifest belongs to.
   */
  plan?: Array<{ command: string; cwd: string }>;
}

/**
 * Runs one install command in `cwd`, buffered, rejecting on a non-zero exit so
 * the caller can report the failure without crashing the phase.
 */
/**
 * javaAwareEnv is a no-op for a command that doesn't need Java, so it's
 * applied unconditionally rather than special-cased to gradle commands only
 * — cheapest way to make `gradlew`/`gradlew.bat` findable when Java is only
 * reachable via probeJava's own JAVA_HOME/PATH/Android-Studio-JBR fallback
 * chain, not the plain `process.env` this previously ran with verbatim.
 * Without this, gradlew failed with "JAVA_HOME is not set and no 'java'
 * command could be found in your PATH" on any machine whose only JDK came
 * bundled with Android Studio and was never separately put on PATH — the
 * same resolution QA's own build gate (verifierTools.ts) already does for
 * its own gradle invocation, which this gate never got.
 */
// No timeout here previously — a stalled install (a network hiccup mid-
// download, a hung gradle daemon) could block the whole phase forever, with
// nothing to ever kill it. QA's own build gate (verifierTools.ts) caps its
// gradle invocation at 600s for the same reason; matched here rather than
// left unbounded just because this gate runs a different command.
const INSTALL_COMMAND_TIMEOUT_MS = 600_000;

export function runInstallCommand(command: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    exec(
      command,
      { cwd, maxBuffer: 10 * 1024 * 1024, env: javaAwareEnv(probeJava()), timeout: INSTALL_COMMAND_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/**
 * Same command, but the caller gets the real stdout/stderr back either way
 * instead of a bare resolve/reject — backs run_dependency_install (see its
 * own doc comment in agentTools.ts for why this exists): EDITOR/REPAIR
 * calling this mid-turn needs to actually READ what the package manager
 * said (a version conflict it didn't expect, a SECOND conflict only
 * exposed once the first one's fixed) to iterate, not just learn pass/fail.
 */
export function runInstallCommandCaptured(
  command: string,
  cwd: string
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, maxBuffer: 10 * 1024 * 1024, env: javaAwareEnv(probeJava()), timeout: INSTALL_COMMAND_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        resolve({ ok: !err, output: output || (err ? String(err.message) : "(no output)") });
      }
    );
  });
}

/**
 * Backs the run_dependency_install tool (see its own doc comment in
 * agentTools.ts): lets EDITOR/REPAIR run the SAME install the post-phase
 * gate would eventually run, but mid-turn, so they can actually SEE the
 * real result (a version conflict npm reports, a SECOND conflict only
 * exposed once the first is fixed) and iterate within their own turn —
 * instead of writing a guessed version number, concluding, and finding out
 * only via QA, several minutes later, whether the guess was even close.
 * Reuses detectChangedManifests/resolveAbsoluteInstallPlan — the exact same
 * resolution the post-phase gate uses, so this is never a different or
 * less-trusted command than what would already run automatically; it's
 * the same action, just available earlier, with real output attached.
 */
export async function runDependencyInstallCheck(
  writtenFiles: string[],
  repoRoot: string,
  approve: (planSummary: string) => Promise<boolean>,
  // Overridable so tests never need a real network/package-manager call —
  // same reasoning as handleDependencyInstallGate's own injectable executor.
  // Defaults to the real thing in production.
  executor: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }> = runInstallCommandCaptured,
  // Results already produced this phase, keyed by plan + manifest contents.
  // Without it a model retrying the identical call re-prompted the user and
  // re-ran a command certain to give the identical result - the user was
  // asked to approve the same failing install four times in a row.
  memo?: Map<string, string>
): Promise<string> {
  const matches = detectChangedManifests(writtenFiles);
  if (matches.length === 0) {
    return "No dependency manifest has been changed yet this phase — nothing to install.";
  }
  const plan = resolveAbsoluteInstallPlan(matches, repoRoot);
  const describe = (step: { command: string; cwd: string }) =>
    step.cwd === repoRoot ? step.command : `${step.command} (in ${path.relative(repoRoot, step.cwd)})`;
  const planSummary = plan.map(describe).join(" && ");

  // A command that cannot run here is reported without ever asking the user to
  // approve it - and without a retry loop for the model to fall into.
  for (const step of plan) {
    const blocked = unrunnableInstallReason(step);
    if (blocked) {
      return (
        `Not run — ${blocked}\nDo not call run_dependency_install again: this is an environment problem, not ` +
        `something an edit can fix. Continue without it and flag it as a manual step.`
      );
    }
  }

  let key = planSummary;
  if (memo) {
    const hash = createHash("sha1");
    for (const match of matches) {
      try {
        hash.update(await fs.readFile(path.join(repoRoot, ...match.path.split("/"))));
      } catch {
        hash.update("<unreadable>");
      }
    }
    key = `${planSummary}\n${hash.digest("hex")}`;
    const previous = memo.get(key);
    if (previous !== undefined) {
      return (
        `Not re-run — this exact command already ran for these manifest contents this phase. ` +
        `Its result was:\n${previous}\nChange the manifest (or the environment) before calling this again.`
      );
    }
  }

  let approved = false;
  try {
    approved = await approve(planSummary);
  } catch {
    // A prompt that cannot be answered is a decline, never a crash — same
    // reasoning as the post-phase gate's own approval handling.
  }
  if (!approved) {
    const declined = `Not run — declined: ${planSummary}. You may proceed without installing (the post-phase gate will ask again once this phase concludes), or ask the user to run it manually.`;
    memo?.set(key, declined);
    return declined;
  }

  const lines: string[] = [];
  for (const step of plan) {
    const { ok, output } = await executor(step.command, step.cwd);
    lines.push(`[${ok ? "PASS" : "FAIL"}] ${describe(step)}:\n${output.slice(0, 4000)}`);
    // A failed install makes any later step's result moot — same
    // early-return reasoning as the build check's own command loop.
    if (!ok) break;
  }
  const result = lines.join("\n\n");
  memo?.set(key, result);
  return result;
}

const NPM_VIEW_TIMEOUT_MS = 15_000;

function npmViewStdout(args: string[], cwd: string): Promise<string> {
  // execFile does not go through a shell, so a bare "npm.cmd" on Windows
  // fails to spawn at all (a batch file needs cmd.exe to run it) -- same fix
  // as every other npm/gradle .cmd invocation already in this codebase.
  const { bin, args: finalArgs } = winSafeCommand(process.platform === "win32" ? "npm.cmd" : "npm", args);
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      finalArgs,
      { cwd, timeout: NPM_VIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? "")))
    );
  });
}

/** Does `pkg@range` resolve to at least one version actually published on
 *  the registry? A real, cheap network check — the only way to actually know
 *  this, since an LLM's own belief about what versions exist can be wrong
 *  (a hallucinated version) with no way for it to tell the difference. */
async function npmVersionExists(pkg: string, range: string, cwd: string): Promise<boolean> {
  try {
    const out = await npmViewStdout(["view", `${pkg}@${range}`, "version"], cwd);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** The package's actual latest published version, or undefined if the
 *  package name itself doesn't resolve (a typo, not just a bad version). */
async function npmLatestVersion(pkg: string, cwd: string): Promise<string | undefined> {
  try {
    const out = await npmViewStdout(["view", pkg, "version"], cwd);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Catches a hallucinated npm dependency version — a version string an LLM
 * invented that was never actually published — before `npm install` ever
 * runs, rather than discovering it from a failed install and hoping a blind
 * model retry guesses better the second time. There is no way for a model to
 * verify this from its own training data alone; this is a real registry
 * lookup, the only source of truth for what's actually published.
 *
 * Mutates the manifest in place when it finds and fixes something, and
 * returns what changed for transparent logging — this never silently
 * rewrites a user's file without saying so. Best-effort throughout: a
 * missing/unparseable manifest, a package whose name itself doesn't resolve,
 * or a registry that can't be reached all just leave that entry untouched
 * rather than throwing, so this can never be the reason a phase fails.
 */
export async function verifyAndFixNpmVersions(
  absoluteManifestPath: string,
  cwd: string
): Promise<Array<{ pkg: string; from: string; to: string }>> {
  let raw: string;
  try {
    raw = await fs.readFile(absoluteManifestPath, "utf-8");
  } catch {
    return [];
  }
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }

  const fixes: Array<{ pkg: string; from: string; to: string }> = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      const range = String(deps[name]);
      // Not a registry version at all -- a local path, git/https URL,
      // workspace reference, or dist-tag alias. Nothing to verify against
      // npm for these; leave them exactly as the editor wrote them.
      if (/^(file:|link:|git\+|git:|https?:|workspace:|\*$|latest$|next$)/i.test(range)) continue;
      const exists = await npmVersionExists(name, range, cwd);
      if (exists) continue;
      const latest = await npmLatestVersion(name, cwd);
      if (!latest) continue; // the package name itself doesn't resolve either -- nothing safe to substitute
      deps[name] = `^${latest}`;
      fixes.push({ pkg: name, from: range, to: `^${latest}` });
    }
  }

  if (fixes.length > 0) {
    await fs.writeFile(absoluteManifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }
  return fixes;
}

/**
 * The human-in-the-loop gate between the editor and the verifier.
 *
 * A phase that edits a dependency manifest has changed the project's dependency
 * set, and nothing downstream installs it: the verifier compiles/tests against
 * whatever happens to be on disk, so a new dependency produces a build failure
 * that looks like a code defect and burns the whole repair budget on a problem
 * no code change can fix. Running the install automatically would be worse —
 * it executes arbitrary package-manager scripts against the user's machine.
 *
 * So: detect whether any written file was a dependency manifest, resolve the
 * install command for it, ask the human, and run it only on an explicit yes.
 * Everything about this is best-effort and non-fatal — no manifest changed, a
 * declined prompt, or a failed install all return normally with
 * `executed: false`, leaving the phase to proceed to verification exactly as
 * it would have without the gate.
 */
/**
 * (command, absolute directory) pairs for a set of matched manifests,
 * de-duplicated: gradle's three triggers are one `./gradlew` run, but
 * `npm install` in `web/` and in `web/packages/ui/` are two genuinely
 * different installs and both must happen. Shared between
 * handleDependencyInstallGate (the post-phase gate) and
 * runDependencyInstallCheck (the mid-turn run_dependency_install tool) so
 * both ever resolve to the exact same plan for the exact same manifests —
 * one source of truth for "what would installing these actually run."
 */
/** True for the `gradlew` / `gradlew.bat` / `./gradlew` wrapper commands. */
function isGradleWrapperCommand(command: string): boolean {
  return /^(\.\/)?gradlew(\.bat)?(\s|$)/i.test(command.trim());
}

const GRADLE_WRAPPER_FILE = process.platform === "win32" ? "gradlew.bat" : "gradlew";

/**
 * Where the Gradle wrapper for a changed manifest actually lives. The wrapper
 * sits at the Gradle PROJECT root, which is not always the repo root: an
 * Expo / React Native app keeps it in `android/`, so running `gradlew.bat` at
 * the repo root fails with "not recognized" no matter how many times it is
 * approved. Looks from the manifest's own directory up to the repo root, then
 * in `<repo>/android`. Undefined when no wrapper exists anywhere.
 */
function findGradleWrapperDir(repoRoot: string, manifestPath: string): string | undefined {
  let rel = normalizeRelativeDir(path.posix.dirname(normalizeRelativeDir(manifestPath)));
  if (rel === ".") rel = "";
  const candidates: string[] = [];
  for (;;) {
    candidates.push(rel);
    if (!rel) break;
    const slash = rel.lastIndexOf("/");
    rel = slash === -1 ? "" : rel.slice(0, slash);
  }
  candidates.push("android");
  for (const dir of candidates) {
    const abs = dir ? path.join(repoRoot, ...dir.split("/")) : repoRoot;
    if (fsSync.existsSync(path.join(abs, GRADLE_WRAPPER_FILE))) return abs;
  }
  return undefined;
}

/**
 * Why a resolved install step cannot possibly run here, or undefined when it
 * can (as far as a cheap file check can tell). Today: a Gradle wrapper command
 * whose wrapper is missing from its directory. Callers report this and move
 * on rather than asking the user to approve a command that is certain to
 * fail, and rather than treating that certain failure as a broken phase.
 */
export function unrunnableInstallReason(step: { command: string; cwd: string }): string | undefined {
  if (!isGradleWrapperCommand(step.command)) return undefined;
  if (fsSync.existsSync(path.join(step.cwd, GRADLE_WRAPPER_FILE))) return undefined;
  return (
    `${GRADLE_WRAPPER_FILE} was not found in ${step.cwd} (or in the manifest's parent folders, or <repo>/android), ` +
    `so \`${step.command}\` cannot run. Run the Gradle sync from your IDE, or generate the wrapper ` +
    `(\`gradle wrapper\`) and re-run.`
  );
}

export function resolveAbsoluteInstallPlan(matches: ManifestMatch[], repoRoot: string): Array<{ command: string; cwd: string }> {
  const resolveCwd = (manifestDir: string): string =>
    manifestDir ? path.join(repoRoot, ...manifestDir.split("/")) : repoRoot;
  const plan: Array<{ command: string; cwd: string }> = [];
  for (const match of matches) {
    let absoluteCwd = resolveCwd(match.cwd);
    // Only re-point when a wrapper is actually found somewhere else; if none
    // exists the original directory is kept so the failure is reported there.
    if (isGradleWrapperCommand(match.command) && !fsSync.existsSync(path.join(absoluteCwd, GRADLE_WRAPPER_FILE))) {
      absoluteCwd = findGradleWrapperDir(repoRoot, match.path) ?? absoluteCwd;
    }
    if (!plan.some((step) => step.command === match.command && step.cwd === absoluteCwd)) {
      plan.push({ command: match.command, cwd: absoluteCwd });
    }
  }
  return plan;
}

export async function handleDependencyInstallGate(
  options: DependencyInstallGateOptions
): Promise<DependencyInstallGateResult> {
  const { writtenFiles, cwd } = options;
  const matches = detectChangedManifests(writtenFiles, options.diffs);

  // The overwhelmingly common case: nothing dependency-related was touched, so
  // the user is never interrupted.
  if (matches.length === 0) return { executed: false };

  // Root-relative manifest directory -> absolute directory the command runs
  // in, so a nested manifest installs in its own subproject.
  const resolveCwd = (manifestDir: string): string =>
    manifestDir ? path.join(cwd, ...manifestDir.split("/")) : cwd;

  // Before ever resolving/running an install command: catch a hallucinated
  // npm dependency version against the real registry, so the install this
  // gate is about to run has a chance of succeeding at all. No default here
  // (unlike executor/prompter below) — this makes a real network call, so it
  // only runs when a caller explicitly opts in by supplying one (index.ts
  // passes verifyAndFixNpmVersions; tests simply never pass this option).
  if (options.npmVersionVerifier) {
    for (const match of matches) {
      if (match.id !== "npm") continue;
      const fixes = await options.npmVersionVerifier(path.resolve(cwd, match.path), resolveCwd(match.cwd));
      for (const fix of fixes) {
        console.log(
          `[DEPENDENCIES] 🔧 "${fix.pkg}@${fix.from}" does not exist on npm — corrected to "${fix.to}" (${match.path}).`
        );
      }
    }
  }

  const plan = resolveAbsoluteInstallPlan(matches, cwd);

  for (const step of plan) {
    const blocked = unrunnableInstallReason(step);
    if (blocked) {
      console.warn(`[DEPENDENCIES] ⚠️ Not running the install — ${blocked}`);
      return { executed: false, command: plan.map((s) => s.command).join(" && "), plan };
    }
  }

  const commands = [...new Set(plan.map((step) => step.command))];
  const command = commands.join(" && ");

  console.log(`\n[DEPENDENCIES] This phase changed dependency manifest(s):`);
  for (const match of matches) console.log(`   - ${match.label}  (${match.path})`);
  console.log(`[DEPENDENCIES] Resolved install command: ${command}`);

  // Without a real terminal there is nobody to answer, and a readline question
  // would hang the run forever. Only the DEFAULT prompter is skipped this way —
  // an injected one (tests, a paired phone) is always honored.
  // The prompt shows a nested command's directory, since "npm install" at the
  // repo root and "npm install" in web/ are different things to approve.
  const planSummary = plan.map((step) => (step.cwd === cwd ? step.command : `${step.command}  (in ${step.cwd})`));
  const resolvedPlan = plan;

  const prompter = options.prompter;
  if (!prompter && !process.stdin.isTTY) {
    console.log(
      `[DEPENDENCIES] No interactive terminal available — skipping the install. ` +
        `Run it yourself before relying on this phase's build:\n         ${planSummary.join("\n         ")}`
    );
    return { executed: false, command, plan: resolvedPlan };
  }

  // A prompt that cannot be answered (stdin closed, an injected prompter that
  // throws) is a decline, never a crash — the whole gate is advisory.
  let approved = false;
  try {
    approved = await (prompter ?? promptUserApproval)(
      `Install dependencies now? This runs: ${planSummary.join(" && ")}`
    );
  } catch (err: any) {
    console.warn(`[DEPENDENCIES] ️ Could not ask for approval: ${err?.message ?? err}`);
  }

  if (!approved) {
    console.log(
      `[DEPENDENCIES] Skipped — install was not approved. Verification may fail on the missing ` +
        `dependency; run it manually when ready: ${command}`
    );
    return { executed: false, command, plan: resolvedPlan };
  }

  const executor = options.executor ?? runInstallCommand;
  try {
    for (const step of plan) {
      console.log(`[DEPENDENCIES] ⚙️ Running: ${step.command}  (in ${step.cwd})`);
      await executor(step.command, step.cwd);
    }
    console.log(`[DEPENDENCIES] ✓ Dependencies installed.`);
    return { executed: true, command, plan: resolvedPlan };
  } catch (err: any) {
    // A failed install must never take down the phase — verification is about
    // to report the real consequence far more usefully than this can.
    console.warn(`[DEPENDENCIES] ⚠️ Install command failed: ${err?.message ?? err}`);
    console.warn(`[DEPENDENCIES] Continuing to verification anyway; run it manually if needed: ${command}`);
    return { executed: false, command, plan: resolvedPlan };
  }
}

/** Runs `git` with fixed arguments — no shell, so a filename can never be read as a command. */
function gitStdout(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ""));
    });
  });
}

/** The manifest family a path belongs to, matched on BASENAME exactly as the write-driven gate does. */
function ruleForManifestPath(filePath: string): ManifestRule | undefined {
  const normalized = normalizeRelativeDir(String(filePath ?? ""));
  if (!normalized) return undefined;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((s) => IGNORED_MANIFEST_DIRS.includes(s))) return undefined;
  const basename = segments[segments.length - 1];
  if (!basename) return undefined;
  return MANIFEST_REGISTRY.find((rule) =>
    rule.filePatterns.some((pattern) => matchesManifestPattern(basename, pattern))
  );
}

/**
 * The lines `git diff -U0` reports as ADDED for one file, with the `+` marker
 * stripped.
 *
 * `-U0` is what makes this trustworthy: with the default three lines of
 * context every unchanged neighbour of an edit would arrive as a "changed"
 * line, and a dependency marker sitting beside an unrelated edit would read as
 * a dependency change. `+++`/`---` are file headers, not content. An untracked
 * file has no diff at all, so callers treat "no diff" as fail-open rather than
 * as "nothing changed".
 */
export function parseAddedDiffLines(diffText: string): string[] {
  const added: string[] = [];
  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
}

/** Whether any ADDED line contains any of a rule's triggers (case-insensitive). */
function addedLinesEvidenceManifest(rule: ManifestRule, addedLines: string[]): boolean {
  const haystack = addedLines.join("\n").toLowerCase();
  if (!haystack) return false;
  return rule.diffTriggers.some((trigger) => haystack.includes(trigger.toLowerCase()));
}

/**
 * The dependency manifest a single file's GIT DIFF says was changed — the
 * diff-driven twin of `detectChangedManifests`, for the phase loop, which
 * knows which files the phase was *supposed* to touch and must therefore ask
 * the working tree what actually changed rather than relying on the editor's
 * own write log.
 *
 * `git diff -U0 -- <file>` isolates the file's ADDED lines and those are
 * matched against the family's `diffTriggers`, so touching a `package.json`
 * only to edit its `"scripts"` block is not a dependency change and never
 * interrupts the user. `-U0` (rather than the default three context lines) is
 * what makes that trustworthy: with context, every unchanged neighbour of an
 * unrelated edit would arrive as a changed line and a dependency marker merely
 * sitting nearby would read as a dependency change.
 *
 * Scoping: `filePath` is resolved against `targetDir` and rejected if it
 * escapes it, so a manifest path from a plan can never make the gate run a
 * package manager against a directory outside the repository the user pointed
 * yimpim at. A path that does not resolve inside `targetDir`, is not a
 * manifest, passes through a vendored/build directory, or has a real diff
 * whose added lines touch none of the rule's `diffTriggers` all resolve to
 * `undefined`.
 *
 * Fail-open in exactly one direction, matching `detectChangedManifests`: an
 * untracked file (or a directory that is not a git work tree) yields no diff
 * at all, and no diff means the basename match alone decides — a brand-new
 * `package.json` added by the editor must never be silently skipped just
 * because git had nothing to diff it against.
 */
export async function inspectFileForNewDependencies(
  filePath: string,
  targetDir: string
): Promise<ManifestRule | undefined> {
  if (typeof filePath !== "string" || filePath.trim() === "") return undefined;
  if (typeof targetDir !== "string" || targetDir.trim() === "") return undefined;

  const root = path.resolve(targetDir);
  const absolute = path.resolve(root, filePath);
  // Containment check on the RESOLVED path, so "../.." and a cross-drive
  // Windows path are rejected the same way.
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.warn(`[DEPENDENCIES] ⚠️ Skipping "${filePath}" — it resolves outside the repository (${absolute}).`);
    return undefined;
  }

  const rule = ruleForManifestPath(relative);
  if (!rule) return undefined;

  let addedLines: string[] = [];
  try {
    addedLines = parseAddedDiffLines(await gitStdout(["diff", "-U0", "--", relative.replace(/\\/g, "/")], root));
  } catch {
    // Not a git work tree, no HEAD yet, or git unavailable — no diff means the
    // basename match alone decides, never a silent skip.
    addedLines = [];
  }

  if (addedLines.length > 0 && rule.diffTriggers.length > 0 && !addedLinesEvidenceManifest(rule, addedLines)) {
    return undefined;
  }

  return rule;
}

/** The three answers the post-phase dependency prompt accepts. */
export type PostPhaseDependencyChoice = "install" | "skip" | "abort";

/**
 * The post-phase gate's injectable side effects. Both default to the real
 * terminal prompt / package-manager runner, so the phase loop passes neither —
 * they exist so the gate's three decisions are testable without a terminal or
 * a real install.
 */
export interface PostPhaseDependencyHooks {
  /** Interactive 1/2/3 prompt; defaults to `promptDependencyChoice` on stdin. */
  prompter?: (message: string) => Promise<string>;
  /** Command runner; defaults to a promisified `child_process.exec`. */
  executor?: (command: string, cwd: string) => Promise<void>;
  /** npm registry version check; defaults to `verifyAndFixNpmVersions` (a real
   *  network call). Overridable so tests never need actual registry access. */
  npmVersionVerifier?: (
    absoluteManifestPath: string,
    cwd: string
  ) => Promise<Array<{ pkg: string; from: string; to: string }>>;
}

export interface PostPhaseDependencyResult {
  /**
   * True when the caller must STOP: the user chose to abort, or an approved
   * install failed and verification would only report its consequence as a
   * code defect. A phase that aborts is failed cleanly, not crashed.
   */
  aborted: boolean;
  /** True only when an install was approved AND ran without throwing. */
  executed: boolean;
  /** The manifest families whose diffs evidenced a dependency change. */
  matches: ManifestMatch[];
  /** The resolved install command(s), present whenever any manifest changed. */
  command?: string;
  /** The distinct (command, absolute directory) pairs, in execution order. */
  plan?: Array<{ command: string; cwd: string }>;
  /**
   * Why `aborted` is true, when it is. Distinguishes an explicit human
   * decision (never worth auto-repairing — that would ignore what the user
   * just said) from a mechanical install failure, which is very often a
   * one-line fix (e.g. a hallucinated package version) an Editor pass can
   * plausibly correct on its own before the phase gives up entirely.
   */
  reason?: "user_declined" | "install_failed";
  /** The install command's own error output, when `reason` is "install_failed". */
  errorDetail?: string;
}

/**
 * Asks the user to choose between installing, skipping, or aborting, on the
 * terminal, then closes the interface immediately.
 *
 * The immediate `close()` matters for the same reason it does in
 * `promptUserApproval`: an Interface left open after its answer keeps stdin
 * flowing in raw mode and swallows the next prompt's keystrokes. The prompt
 * carries the option list in its own message so the caller cannot forget to
 * print it, and anything unrecognized (including a read error) is "skip" — the
 * safe, non-destructive default for a gate that sits between the editor and QA.
 */
export async function promptDependencyChoice(question: string): Promise<PostPhaseDependencyChoice> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${question}\n  [1] install    [2] skip    [3] abort\nChoice [2]: `
    );
    return normalizePostPhaseDependencyChoice(answer);
  } catch {
    return "skip";
  } finally {
    rl.close();
  }
}

/** Maps a typed answer onto one of the three choices; anything unrecognized is a skip. */
export function normalizePostPhaseDependencyChoice(answer: string): PostPhaseDependencyChoice {
  const value = String(answer ?? "").trim().toLowerCase();
  if (value === "1" || value === "install" || value === "i" || value === "y" || value === "yes") return "install";
  if (value === "3" || value === "abort" || value === "a" || value === "stop") return "abort";
  return "skip";
}

/**
 * The post-phase interactive gate that sits between the editor and QA.
 *
 * Where `handleDependencyInstallGate` is driven by the editor's own write log,
 * this one is driven by the plan's file list plus each file's real GIT DIFF —
 * the phase loop knows which manifests the phase was meant to touch, and the
 * working tree knows what actually changed. Each file is anchored to its own
 * containing directory (`path.dirname(path.resolve(targetDir, file))`) and
 * rejected outright if that resolves outside `targetDir`, so neither a plan nor
 * an editor can point a package-manager command at anything outside the
 * repository the user chose.
 *
 * The human gets three explicit options:
 *   1. install — run the resolved command(s) now, before QA;
 *   2. skip    — leave the tree alone and let verification proceed;
 *   3. abort   — stop the phase rather than verify against a tree whose
 *                dependencies are known to be missing.
 *
 * Everything about it is best-effort and never throws: no manifest changed, a
 * failed prompt, or a failed install all return normally. An install that was
 * approved and then FAILED does set `aborted`, deliberately — QA would
 * otherwise report the missing dependency as a code defect and burn the repair
 * budget on something no code change can fix. With no interactive terminal and
 * no injected prompter it skips rather than hanging on a question nobody can
 * answer, and it never runs an unapproved install.
 */
export async function handlePostPhaseDependencies(
  modifiedFiles: string[],
  targetDir: string,
  hooks: PostPhaseDependencyHooks = {},
  /**
   * (command, absolute cwd) pairs already successfully installed this phase
   * by handleDependencyInstallGate (the earlier, editor-write-log-driven
   * gate) — index.ts's own live record, since this function has no way to
   * know what ran before it. Without this, the same manifest change (the
   * common case: a file this gate's own diff-based detection ALSO catches)
   * got asked about twice in a row for the same underlying dependency
   * change — once via the write log, once via the diff — with the second
   * ask having no idea the first one already ran.
   */
  alreadyExecuted: Array<{ command: string; cwd: string }> = []
): Promise<PostPhaseDependencyResult> {
  const empty: PostPhaseDependencyResult = { aborted: false, executed: false, matches: [] };

  const files = Array.isArray(modifiedFiles) ? modifiedFiles : [];
  if (files.length === 0) return empty;
  if (typeof targetDir !== "string" || targetDir.trim() === "") return empty;

  // One entry per manifest family whose diff evidences a real dependency
  // change, in registry order so the prompt and the plan are stable.
  const inspected: ManifestRule[] = [];
  for (const file of files) {
    const rule = await inspectFileForNewDependencies(file, targetDir);
    if (rule) inspected.push(rule);
  }

  const registryOrder = new Map<string, number>(MANIFEST_REGISTRY.map((rule, i) => [rule.id, i]));
  inspected.sort((a, b) => (registryOrder.get(a.id) ?? 0) - (registryOrder.get(b.id) ?? 0));

  // Each file is anchored to its OWN directory: a manifest in `web/` installs
  // in `web/`, never at the repo root, and a manifest whose containing
  // directory escapes the repository is dropped before it can.
  const plan: Array<{ command: string; cwd: string }> = [];
  const matches: ManifestMatch[] = [];
  const seen = new Set<string>();
  const root = path.resolve(targetDir);

  for (const rule of inspected) {
    const file = files.find((f) => ruleForManifestPath(f)?.id === rule.id);
    if (file === undefined) continue;

    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      console.warn(`[DEPENDENCIES] ⚠️ Skipping "${file}" — it resolves outside ${root}.`);
      continue;
    }

    // The anchor: the manifest's own containing directory, unless the family
    // declares a different build root (the Gradle catalog lives in gradle/
    // while gradlew lives in its parent; a module-level build.gradle.kts
    // resolves all the way to the project root, since gradlew never lives
    // inside a module's own subdirectory). Resolved ONCE and reused for both
    // `matches` (display) and `plan` (what's actually executed) below — this
    // used to diverge: `plan`'s cwd was the manifest's own raw directory,
    // completely bypassing commandDir, so a module-level Gradle change ran
    // the install command from inside the module (no wrapper there) even
    // though the printed summary correctly showed the resolved root.
    const manifestDir = normalizeRelativeDir(path.dirname(relative).replace(/\\/g, "/"));
    const resolvedDir = normalizeRelativeDir(rule.commandDir ? rule.commandDir(manifestDir) : manifestDir);
    let cwd = path.resolve(root, resolvedDir);
    if (path.relative(root, cwd).startsWith("..")) {
      console.warn(`[DEPENDENCIES] ⚠️ Skipping "${file}" — its directory resolves outside ${root}.`);
      continue;
    }
    // The wrapper is at the Gradle project root, which is not always the repo
    // root (an Expo / React Native app keeps it in android/).
    if (isGradleWrapperCommand(rule.getInstallCommand()) && !fsSync.existsSync(path.join(cwd, GRADLE_WRAPPER_FILE))) {
      cwd = findGradleWrapperDir(root, relative) ?? cwd;
    }

    const key = `${rule.id}::${relative.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Before ever resolving/running an install command: catch a hallucinated
    // npm dependency version against the real registry. Runs even for a
    // brand-new, untracked manifest (the exact case `inspectFileForNewDependencies`
    // fails open for) since there's no diff to have filtered it out of `inspected`.
    // No default (unlike executor/prompter) -- this makes a real network
    // call, so it only runs when a caller explicitly opts in (index.ts passes
    // verifyAndFixNpmVersions; tests simply never pass this option).
    if (rule.id === "npm" && hooks.npmVersionVerifier) {
      const fixes = await hooks.npmVersionVerifier(absolute, cwd);
      for (const fix of fixes) {
        console.log(
          `[DEPENDENCIES] 🔧 "${fix.pkg}@${fix.from}" does not exist on npm — corrected to "${fix.to}" (${normalizeRelativeDir(relative)}).`
        );
      }
    }

    matches.push({
      id: rule.id,
      label: rule.label,
      command: rule.getInstallCommand(),
      action: rule.action,
      path: normalizeRelativeDir(relative),
      cwd: resolvedDir,
      rule,
    });

    if (!plan.some((step) => step.command === rule.getInstallCommand() && step.cwd === cwd)) {
      plan.push({ command: rule.getInstallCommand(), cwd });
    }
  }

  // The overwhelmingly common case: nothing dependency-related changed, so the
  // user is never interrupted and QA runs exactly as it would have.
  if (matches.length === 0) return empty;

  // Drop anything the earlier write-log-driven gate already ran — compared
  // by (command, absolute cwd), the same identity `plan` itself dedupes by.
  // Matches whose id maps to a since-covered command are dropped too, so the
  // printed summary and the plan agree on what (if anything) is actually
  // left to ask about.
  const alreadyDone = new Set(alreadyExecuted.map((e) => `${e.command}::${path.resolve(e.cwd)}`));
  const newPlan = plan.filter((step) => !alreadyDone.has(`${step.command}::${path.resolve(step.cwd)}`));
  const newMatches = matches.filter((m) => newPlan.some((step) => step.command === m.command));

  if (newPlan.length === 0) {
    console.log(
      `\n[DEPENDENCIES] This phase's changes touched dependency manifest(s), but every one was already ` +
        `installed by the pre-verification gate — not asking again:\n` +
        matches.map((m) => `   - ${m.label}  (${m.path})`).join("\n")
    );
    return { aborted: false, executed: true, matches, command: plan.map((s) => s.command).join(" && "), plan };
  }
  if (newPlan.length < plan.length) {
    console.log(
      `[DEPENDENCIES] ${plan.length - newPlan.length} of ${plan.length} resolved install command(s) already ran via the pre-verification gate — only asking about what's left.`
    );
  }

  // A command that cannot run here (a Gradle wrapper that does not exist) is
  // reported and skipped: asking the user to approve something certain to fail,
  // and then aborting the phase when it does, punishes them for an environment
  // gap that no edit and no answer can fix.
  for (const step of newPlan) {
    const blocked = unrunnableInstallReason(step);
    if (blocked) {
      console.warn(
        `[DEPENDENCIES] ⚠️ Not running the install — ${blocked}\n` +
          `[DEPENDENCIES] Continuing to verification; the dependency change is unverified until that is done.`
      );
      return {
        aborted: false,
        executed: false,
        matches: newMatches,
        command: newPlan.map((s) => s.command).join(" && "),
        plan: newPlan,
      };
    }
  }

  const command = [...new Set(newPlan.map((step) => step.command))].join(" && ");
  const planSummary = newPlan.map((step) =>
    path.resolve(step.cwd) === root ? step.command : `${step.command}  (in ${step.cwd})`
  );
  console.log(`\n[DEPENDENCIES] This phase's changes touched dependency manifest(s):`);
  for (const match of newMatches) console.log(`   - ${match.label}  (${match.path})`);
  console.log(`[DEPENDENCIES] Resolved install command: ${command}`);

  // Without a real terminal there is nobody to answer, and a readline question
  // would hang the run forever. Only the DEFAULT prompter is skipped this way —
  // an injected one (tests, a paired phone) is always honored.
  const prompter = hooks.prompter;
  if (!prompter && !process.stdin.isTTY) {
    console.log(
      `[DEPENDENCIES] No interactive terminal available — skipping the install. ` +
        `Run it yourself before relying on this phase's build:\n         ${planSummary.join("\n         ")}`
    );
    return { aborted: false, executed: false, matches: newMatches, command, plan: newPlan };
  }

  // A prompt that cannot be answered (stdin closed, an injected prompter that
  // throws) is a SKIP, never a crash — the whole gate is advisory.
  let choice: PostPhaseDependencyChoice = "skip";
  try {
    choice = normalizePostPhaseDependencyChoice(
      await (prompter ?? promptDependencyChoice)(
        `Install dependencies before QA? This runs: ${planSummary.join(" && ")}`
      )
    );
  } catch (err: any) {
    console.warn(`[DEPENDENCIES] ⚠️ Could not ask for approval: ${err?.message ?? err}`);
  }

  if (choice === "abort") {
    console.error(
      `[DEPENDENCIES] ⛔ Aborted at the user's request — the phase stops before QA rather than ` +
        `verifying against a tree whose dependencies are not installed.`
    );
    return { aborted: true, executed: false, matches: newMatches, command, plan: newPlan, reason: "user_declined" };
  }

  if (choice !== "install") {
    console.log(
      `[DEPENDENCIES] Skipped — verification may fail on the missing dependency; ` +
        `run it manually when ready: ${command}`
    );
    return { aborted: false, executed: false, matches: newMatches, command, plan: newPlan };
  }

  const executor = hooks.executor ?? runInstallCommand;
  try {
    for (const step of newPlan) {
      console.log(`[DEPENDENCIES] ⚙️ Running: ${step.command}  (in ${step.cwd})`);
      await executor(step.command, step.cwd);
    }
    console.log(`[DEPENDENCIES] ✓ Dependencies installed.`);
    return { aborted: false, executed: true, matches: newMatches, command, plan: newPlan };
  } catch (err: any) {
    // An APPROVED install that then failed is the one case where continuing is
    // worse than stopping: QA is about to compile against the very dependency
    // set that just failed to install, and would report that as a code defect.
    console.error(`[DEPENDENCIES] ⛔ Install command failed: ${err?.message ?? err}`);
    console.error(`[DEPENDENCIES] Stopping before QA — fix the install, then re-run: ${command}`);
    return {
      aborted: true,
      executed: false,
      matches: newMatches,
      command,
      plan: newPlan,
      reason: "install_failed",
      errorDetail: err?.message ?? String(err),
    };
  }
}