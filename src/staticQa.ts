/**
 * Static QA: the always-available verification path.
 *
 * When an emulator, browser, display or toolchain is missing, this is what
 * compensates. It reads the actual change set (including untracked files, which
 * `git diff HEAD` alone omits) and audits it against the stated requirements.
 *
 * The reviewer here is a QA specialist: it judges whether requirements are met
 * and reports defects with evidence. It never proposes patches or writes code.
 */

import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { STATIC_QA_SYSTEM } from "./prompts.js";
import { LOCK_FILE_NAMES } from "./orchestrator.js";
import { uiSignals } from "./uiLint.js";
import { fileReader, securitySignals } from "./securityLint.js";
import { isScratchPath } from "./scratch.js";

const execFileAsync = promisify(execFile);

export interface ChangeSet {
  /** Unified diff for tracked edits, plus synthesized blocks for new files. */
  diff: string;
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  isEmpty: boolean;
  /**
   * Changed files whose working-tree content is empty or whitespace only.
   * This is an intentional emptying (typically the first half of retiring a
   * file that will be confirmed for deletion at the end of the run), NOT a
   * missing implementation — the diff for such a file is pure removals, which
   * a reviewer would otherwise read as "the requirement was dropped".
   */
  emptied?: string[];
  /**
   * Repo-relative paths the agent staged for deletion this run (intent only;
   * nothing has been unlinked). Supplied by the caller from the run's own
   * staging record — git cannot know this, since staging is never persisted to
   * the working tree. Treated exactly like `emptied` by static review.
   */
  stagedDeletions?: string[];
  /**
   * Lock files (package-lock.json, yarn.lock, ...) that changed this phase —
   * tracked separately from `modified`/`added` rather than silently invisible.
   * Deliberately excluded from `diff`/`modified`/`added` (see IGNORED_PATH_RE's
   * own comment: a lock file's own diff is enormous, auto-generated noise no
   * reviewer can usefully judge), but a phase whose entire goal IS "update a
   * dependency" still needs SOME trace that something real happened — without
   * this, a lock-file-only change (no package.json version bump, e.g. a
   * transitive bump or a lockfile regenerated after a manual edit) was
   * completely invisible to every gate: `isEmpty` read true (a real phase
   * reported as "no changes produced"), and if something else incidental
   * happened to be dirty too (a log file from launching the app to probe it),
   * that became the only visible "change", making a genuinely successful
   * dependency update look like it touched nothing relevant at all.
   *
   * Optional (defaults to empty wherever read), like `emptied`/
   * `stagedDeletions` above, so every existing hand-built ChangeSet (tests,
   * any future caller) keeps working unchanged with no lock-file awareness.
   */
  lockFiles?: string[];
  /** The project has a design system (design-system/MASTER.md), so hard-coded colours are worth flagging. */
  designSystem?: boolean;
  /** Where the change was collected, so checks that need a whole file can read it. */
  repoRoot?: string;
}

/** `src\Foo.ts` / `./src/Foo.ts` -> `src/Foo.ts`, for consistent set lookups. */
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".kts", ".java", ".py", ".rb", ".go",
  ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".m", ".mm", ".php", ".sh", ".bash",
  ".html", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro", ".json", ".yaml",
  ".yml", ".toml", ".xml", ".gradle", ".md", ".txt", ".sql", ".proto", ".graphql",
  // Flutter is entirely Dart; without this, a Flutter change would be treated
  // as opaque, unreviewable content rather than actual source.
  ".dart",
]);

const MAX_NEW_FILE_CHARS = 12000;

/**
 * A single diff line beyond this length is virtually never something a text
 * reviewer can usefully judge character-by-character — a base64 blob, a
 * minified bundle, or (the case this was written for) a generated Android
 * vector drawable's `pathData` attribute, which can run to tens of thousands
 * of characters for one detailed icon. Left alone, one such line can consume
 * the entire per-file DIFF_CHAR_CAP below on its own, starving every other
 * line of review budget while costing a full model round-trip's worth of
 * tokens and wall-clock time for content that is pure numeric noise to an
 * LLM — the same "real cost, zero signal" shape as the QA_REVIEW.md fix
 * (see isHarnessArtifactPath), just at the line level instead of the file
 * level. Truncated per-line rather than dropping the line or the file
 * entirely, so whatever else sits on or near it (an attribute name, a
 * surrounding element) still reaches the reviewer.
 */
const MAX_DIFF_LINE_CHARS = 2000;

export function truncateLongDiffLines(diff: string): string {
  return diff
    .split("\n")
    .map((line) =>
      line.length > MAX_DIFF_LINE_CHARS
        ? `${line.slice(0, MAX_DIFF_LINE_CHARS)} ...[${line.length - MAX_DIFF_LINE_CHARS} more chars on this line omitted — looks like generated or binary-like data, not reviewable prose]`
        : line
    )
    .join("\n");
}

/**
 * Vendor, build output and harness bookkeeping. These are never the subject of
 * a requirement, and including them floods the reviewer with noise. Lock
 * files are handled separately (see LOCK_FILE_RE below) — unlike a build
 * output directory, a lock file changing can legitimately BE the requirement
 * (the task was "update a dependency"), so it gets tracked as a bare fact
 * rather than being as invisible as node_modules/dist/etc.
 */
const IGNORED_PATH_RE =
  /(^|\/)(node_modules|\.git|\.gradle|\.agent|\.idea|\.vscode|__pycache__|\.venv|venv|dist|build|out|target|coverage|\.next|\.nuxt|vendor|Pods)(\/|$)|^PROGRESS\.md$/;

/**
 * Matched separately from IGNORED_PATH_RE — see ChangeSet.lockFiles' own
 * comment. Built from MANIFEST_REGISTRY's own LOCK_FILE_NAMES (orchestrator.ts)
 * rather than a second, hand-maintained list here — every ecosystem that
 * registry already knows how to install dependencies for gets this
 * treatment automatically, with nothing to keep in sync by hand.
 */
const LOCK_FILE_RE = new RegExp(
  `(^|/)(${LOCK_FILE_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`
);

function isReviewable(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  return !IGNORED_PATH_RE.test(normalized) && !LOCK_FILE_RE.test(normalized);
}

function isLockFile(rel: string): boolean {
  return LOCK_FILE_RE.test(rel.replace(/\\/g, "/"));
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Collect everything that changed. Critically this includes untracked files:
 * a phase that only adds new files produces an empty `git diff HEAD`, and
 * treating that as "no work done" is wrong.
 *
 * `excludePaths` is whatever the working tree already had dirty BEFORE this
 * phase started (index.ts's snapshotDirtyPaths, same porcelain format so no
 * normalization is needed) — without this, QA reviewed the user's own
 * unrelated in-progress edits on every single phase of a task, forever, the
 * same bug agentTouchedPaths (index.ts) was already written to avoid for
 * commit/revert but which never reached the verifier's own diff collection.
 */
export async function collectChangeSet(repoRoot: string, excludePaths?: Set<string>): Promise<ChangeSet> {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const lockFiles: string[] = [];
  const excluded = excludePaths ?? new Set<string>();

  let porcelain = "";
  try {
    porcelain = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch (err: any) {
    // Collapsing this into isEmpty was indistinguishable from "the editor
    // genuinely made no changes" — a missing/broken git repo would silently
    // fail every future phase the same way, always blaming the editor.
    // Rethrow so the caller can report this as evidence being UNAVAILABLE,
    // not as proof nothing happened.
    throw new Error(`git status failed (is "${repoRoot}" a git repository?): ${err.message}`);
  }

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3).trim();

    // A rename/copy line reads "old/path -> new/path", not a single path —
    // treating it as one (the old bug here) fed git diff a literal string
    // like "old.txt -> new.txt" as a pathspec, which matches nothing, so the
    // renamed file's actual content changes never reached review at all.
    if (code.includes("R") || code.includes("C")) {
      const arrow = rest.indexOf(" -> ");
      if (arrow === -1) continue; // malformed line — skip rather than misparse
      const from = rest.slice(0, arrow).replace(/^"|"$/g, "");
      const to = rest.slice(arrow + 4).replace(/^"|"$/g, "");
      if (excluded.has(from) || excluded.has(to)) continue;
      if (isLockFile(to)) {
        lockFiles.push(to);
        continue;
      }
      if (!isReviewable(to)) continue;
      // A pre-existing rename's raw porcelain line ("old -> new") won't match
      // excluded's plain-path entries, but the destination path alone often
      // will (e.g. the user had already renamed a file before this phase
      // started) — best-effort, not a guarantee, same as the rest of this
      // exclusion.
      renamed.push({ from, to });
      continue;
    }

    const file = rest.replace(/^"|"$/g, "");
    if (excluded.has(file)) continue;
    if (isLockFile(file)) {
      lockFiles.push(file);
      continue;
    }
    if (!isReviewable(file)) continue;
    if (code.includes("?")) added.push(file);
    else if (code.includes("D")) deleted.push(file);
    else if (code.includes("A")) added.push(file);
    else modified.push(file);
  }

  let diff = "";
  if (modified.length > 0 || deleted.length > 0 || renamed.length > 0) {
    try {
      // -M makes rename detection explicit rather than depending on the
      // user's own diff.renames config — needed for the old+new paths below
      // to actually come back correlated as a rename instead of an
      // unmatched delete+add. Scoped to reviewable paths so vendor churn
      // never reaches the model. -U1 (vs. git's default 3) matters most for a
      // file Repair touched with many small, scattered edits: every one of
      // those becomes its own hunk, so each unneeded context line is paid for
      // once per hunk — on a large file with a dozen small patches, that adds
      // up to most of the file being included as pure padding. Reviewers only
      // need enough context to see WHERE a change sits, not to re-render
      // unchanged code; the deterministic +/- scans above don't touch context
      // lines at all, so this cannot affect their signal.
      diff = await git(repoRoot, [
        "diff", "HEAD", "-M", "-U1", "--",
        ...modified, ...deleted, ...renamed.map((r) => r.from), ...renamed.map((r) => r.to),
      ]);
    } catch {
      // No HEAD yet (fresh repo) — fall through to new-file synthesis.
    }
  }

  // Synthesize diff blocks for untracked files so the reviewer can see them.
  for (const file of added) {
    const ext = path.extname(file).toLowerCase();
    if (ext && !TEXT_EXT.has(ext)) {
      diff += `\n--- /dev/null\n+++ b/${file}\n(new binary or non-source file, contents omitted)\n`;
      continue;
    }
    try {
      const content = truncateLongDiffLines(await fs.readFile(path.join(repoRoot, file), "utf-8"));
      const truncated =
        content.length > MAX_NEW_FILE_CHARS
          ? content.slice(0, MAX_NEW_FILE_CHARS) + "\n... (truncated)"
          : content;
      const body = truncated
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n");
      diff += `\n--- /dev/null\n+++ b/${file}\n@@ new file @@\n${body}\n`;
    } catch {}
  }

  // A changed file that now holds zero bytes (or only whitespace) has been
  // intentionally emptied — an obsolete module being retired ahead of the
  // end-of-run deletion confirmation, not a requirement that went missing.
  // Reading this from the working tree, not the diff, is what makes it
  // reliable: the diff of such a file is 100% removals, which is exactly the
  // shape a reviewer misreads as "the implementation was deleted".
  const emptied: string[] = [];
  for (const file of [...modified, ...added]) {
    try {
      const content = await fs.readFile(path.join(repoRoot, file), "utf-8");
      if (content.trim() === "") emptied.push(file);
    } catch {
      // Unreadable (e.g. binary or removed between status and read) — leave it
      // in the normal review path rather than guessing it was emptied.
    }
  }

  // A lock-file-only change (no package.json bump, e.g. a transitive version
  // resolved, or the lock regenerated after a manual edit) is a real,
  // substantive change — "nothing happened" would be wrong here, the same
  // way it would be wrong for a change that only added new (untracked) files.
  const isEmpty =
    diff.trim().length === 0 &&
    modified.length === 0 &&
    added.length === 0 &&
    deleted.length === 0 &&
    renamed.length === 0 &&
    lockFiles.length === 0;
  const designSystem = await fs.access(path.join(repoRoot, "design-system", "MASTER.md")).then(() => true, () => false);
  return { diff, modified, added, deleted, renamed, isEmpty, emptied, lockFiles, designSystem, repoRoot };
}

// ------------------------------------------------------ Per-file diff split

export interface DiffFileSegment {
  /** Repo-relative path this segment belongs to, or undefined when the diff
   *  could not be attributed to a single file. */
  file?: string;
  /** Unified-diff text for just this file, headers included. */
  diff: string;
}

const GIT_DIFF_HEADER_RE = /^diff --git /;
const SYNTHETIC_NEW_FILE_HEADER_RE = /^--- \/dev\/null\s*$/;

/** `b/x.ts` -> `x.ts`; quoted paths (`"b/my file.ts"`) unquoted first. */
function stripDiffPrefix(raw: string): string | undefined {
  const unquoted = raw.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  return unquoted === "" || unquoted === "/dev/null" ? undefined : unquoted;
}

/** `diff --git a/x.ts b/x.ts` -> `x.ts` (the post-image path). */
function parseGitDiffHeaderPath(header: string): string | undefined {
  // A path containing spaces/specials is quoted as a whole, so tokenizing
  // rather than splitting on whitespace is what keeps `b/my file.ts` intact.
  const parts = header.slice("diff --git ".length).match(/"(?:[^"\\]|\\.)*"|\S+/g);
  if (!parts || parts.length < 2) return undefined;
  return stripDiffPrefix(parts[parts.length - 1]);
}

/**
 * Splits a unified diff into one segment per file, so a multi-file change can
 * be reviewed file-by-file instead of as one blob (where a defect in the last
 * file can hide behind plausible-looking changes in the first, or be cut off
 * entirely by the prompt's size cap).
 *
 * Two boundary kinds are recognized, matching what `collectChangeSet` actually
 * produces: git's own `diff --git a/... b/...` headers, and the synthesized
 * `--- /dev/null` + `+++ b/<path>` blocks emitted for untracked new files.
 *
 * Returns a single whole-diff segment (with no `file`) whenever the diff is
 * synthetic or unstructured — a hand-built test fixture, a plain unified diff
 * with no git headers, or anything whose file attribution can't be determined
 * with certainty. Guessing an attribution would be strictly worse than not
 * splitting at all, since one file's changes could then be blamed on another.
 */
export function splitDiffByFile(diff: string): DiffFileSegment[] {
  const lines = diff.split(/\r?\n/);
  // Leading blank lines are an artifact of how synthesized untracked blocks are
  // appended to the git diff output, not a segment of their own.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length) return [{ diff }];

  const boundaries: number[] = [];
  let openFile: string | undefined;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (GIT_DIFF_HEADER_RE.test(line)) {
      boundaries.push(i);
      openFile = parseGitDiffHeaderPath(line);
      continue;
    }
    if (SYNTHETIC_NEW_FILE_HEADER_RE.test(line)) {
      // Bounded to the header pair that immediately follows — scanning the
      // whole rest of the diff could pair this `---` with a LATER file's `+++`
      // and attribute this segment to the wrong file.
      const plus = lines
        .slice(i + 1)
        .find((l) => l.startsWith("+++ ") || GIT_DIFF_HEADER_RE.test(l) || l.startsWith("--- "));
      const plusFile =
        plus && plus.startsWith("+++ ") ? stripDiffPrefix(plus.slice(4).trim()) : undefined;
      // A git diff for a NEWLY ADDED tracked file also contains `--- /dev/null`,
      // but as an interior header line of its own `diff --git` segment — the
      // `+++ b/<same path>` that follows it gives that away. Only a
      // `/dev/null` header introducing a DIFFERENT file starts a new segment.
      if (boundaries.length === 0 || !plusFile || plusFile !== openFile) {
        boundaries.push(i);
        openFile = plusFile;
      }
    }
  }

  if (boundaries.length === 0 || boundaries[0] !== start) return [{ diff }];

  const segments: DiffFileSegment[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const from = boundaries[b];
    const to = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length;
    const header = lines[from];
    const file = GIT_DIFF_HEADER_RE.test(header)
      ? parseGitDiffHeaderPath(header)
      : (() => {
          const plus = lines.slice(from + 1, to).find((l) => l.startsWith("+++ "));
          return plus ? stripDiffPrefix(plus.slice(4).trim()) : undefined;
        })();
    if (!file) return [{ diff }];
    // Only the empty tail the trailing newline produced is dropped — never
    // trailing whitespace on a real diff line, which is meaningful content.
    const chunk = lines.slice(from, to);
    while (chunk.length > 0 && chunk[chunk.length - 1] === "") chunk.pop();
    segments.push({ file, diff: chunk.join("\n") });
  }

  return segments;
}

// ------------------------------------------------------- Deterministic checks

export interface StaticSignal {
  severity: "defect" | "concern";
  message: string;
  /** What the finding is reported against; defaults to the stub/test-removal requirement. */
  requirement?: string;
}

const STUB_MARKERS: { re: RegExp; label: string }[] = [
  { re: /\bTODO\s*\(\s*\)/, label: "Kotlin TODO() will throw at runtime" },
  { re: /\braise\s+NotImplementedError\b/, label: "Python NotImplementedError stub" },
  { re: /\bthrow\s+new\s+(Error|UnsupportedOperationException)\s*\(\s*["'`](not implemented|unimplemented)/i, label: "explicit not-implemented throw" },
  { re: /\bpanic!\s*\(\s*"(not implemented|todo)/i, label: "Rust not-implemented panic" },
  { re: /\bfatalError\s*\(\s*"(not implemented|unimplemented)/i, label: "Swift fatalError stub" },
  { re: /\bthrow\s+UnimplementedError\s*\(/, label: "Dart UnimplementedError stub" },
  { re: /\bthrow\s+new\s+NotImplementedException\s*\(/, label: ".NET NotImplementedException stub" },
];

/** Crude guard against matching a marker that only appears inside a literal. */
function looksLikeLiteral(line: string): boolean {
  const body = line.slice(1).trim();
  return (
    /^(\/\/|#|\*|\/\*)/.test(body) ||  // comment
    /re:\s*\//.test(body) ||           // a regex table entry (as in this file)
    /^["'`]/.test(body)                // a bare string literal
  );
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|[^/]+Test\.(kt|java)$/i;

/**
 * Changed files that must NOT be judged as a dropped/missing implementation.
 *
 * Two ways a file lands here: its working-tree content is now empty or
 * whitespace only (`change.emptied`), or the agent staged it for deletion this
 * run (`change.stagedDeletions`). Both mean the file is being intentionally
 * retired, not that a requirement failed to be implemented — the diff for such
 * a file is pure removals, which is precisely the shape that reads as "the
 * code was deleted" to a reviewer looking only at the diff.
 *
 * Paths are normalized so a staged "\\src\\Foo.ts" still matches the diff's
 * "src/Foo.ts".
 */
export function bypassedMissingDetectionPaths(change: ChangeSet): Set<string> {
  const set = new Set<string>();
  for (const f of change.emptied ?? []) set.add(normalizeRelPath(f));
  // A file git reports as deleted is gone from the working tree entirely — its
  // diff is pure removals, the same "the code was dropped" shape as an emptied
  // file, and likewise a retirement rather than a missing implementation.
  for (const f of change.deleted ?? []) set.add(normalizeRelPath(f));
  for (const f of change.stagedDeletions ?? []) set.add(normalizeRelPath(f));
  return set;
}

/**
 * Harness bookkeeping that belongs to the run, not to the user's project —
 * QA_REVIEW.md (agentLoop.ts's append-only, NEVER-truncated sign-off log),
 * PROGRESS.md, and anything under .agent/. None of these implement a
 * requirement, so judging them against one is meaningless — and QA_REVIEW.md
 * specifically only ever grows, so its "diff" gets bigger every single run it
 * gets touched in, observed at 16k+ characters (26x the size of the actual
 * 0.6k source change in the same phase) while contributing zero signal,
 * yet still costing a full model round-trip same as any other reviewed file.
 *
 * The single source of truth for this classification — index.ts's own
 * isHarnessArtifact re-exports this rather than keeping a second list that
 * could drift out of sync with it.
 */
export function isHarnessArtifactPath(rel: string): boolean {
  const p = normalizeRelPath(rel);
  // .expo/ is Expo's own dev output (logs, caches) — QA's own `expo export`
  // writes into it, so it must never be judged as part of the phase's change.
  // A scratch file (a test report an agent parsed, a throwaway helper script) is not part of the change: judging it against the phase's
  // requirements only produces a screenful of "uncertain" for each one (scratch.ts).
  return p === "PROGRESS.md" || p === "QA_REVIEW.md" || p === ".agent" || p.startsWith(".agent/") || p.startsWith(".expo/") || isScratchPath(p);
}

/** Cheap, deterministic red flags that need no model call. */
export function deterministicSignals(change: ChangeSet): StaticSignal[] {
  const signals: StaticSignal[] = [];

  const addedLines = change.diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  for (const marker of STUB_MARKERS) {
    const hit = addedLines.find((l) => marker.re.test(l) && !looksLikeLiteral(l));
    if (hit) {
      // Deliberately a CONCERN, not a defect: a regex over diff text cannot tell
      // live code from a string, a comment, or a test fixture. The model
      // reviewer sees surrounding context and makes the actual call.
      signals.push({
        severity: "concern",
        message: `Possible runtime stub introduced — ${marker.label}: ${hit.trim().slice(0, 160)}`,
      });
    }
  }

  const deletedTests = change.deleted.filter((f) => TEST_PATH_RE.test(f) || TEST_FILE_RE.test(f));
  if (deletedTests.length > 0) {
    signals.push({
      severity: "defect",
      message: `Test files were deleted: ${deletedTests.join(", ")}. Removing tests is not a valid way to make verification pass.`,
    });
  }

  const removedLines = change.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  if (removedLines > 400 && addedLines.length * 4 < removedLines) {
    signals.push({
      severity: "concern",
      message: `Large net deletion (${removedLines} lines removed vs ${addedLines.length} added) — confirm this was intended.`,
    });
  }

  // The UI code that was written: emoji icons, disabled zoom and similar, checked without a model.
  try {
    signals.push(...uiSignals(splitDiffByFile(change.diff), { designSystem: change.designSystem }));
  } catch {
    // a lint must never break a review
  }
  // Security: secrets, dangerous calls and misconfiguration in any language or platform.
  try {
    signals.push(...securitySignals(splitDiffByFile(change.diff), { readFile: change.repoRoot ? fileReader(change.repoRoot) : undefined }));
  } catch {
    // nor may this
  }

  return signals;
}

// ------------------------------------------------------------ Model reviewer

export interface RequirementFinding {
  requirement: string;
  status: "satisfied" | "missing" | "uncertain";
  evidence: string;
}

export interface StaticReview {
  /** true only when the reviewer found positive evidence of a defect. */
  defectFound: boolean;
  findings: RequirementFinding[];
  concerns: string[];
  summary: string;
  /** Set when the review itself could not be performed. */
  reviewUnavailable?: string;
}

export interface ReviewerDeps {
  /** Returns the raw text content of a JSON-mode completion. */
  ask(system: string, user: string): Promise<string>;
}

const DIFF_ABSENCE_TERMS = /\b(diff|change\s*set|files\s*touched)\b/i;
const EVIDENCE_ABSENCE_TERMS =
  /\b(not present|not touched|not modified|no edit|does(?:n't| not) appear|absent from|not included|not part of)\b/i;

/**
 * Safety net for the exact reasoning slip the CRITICAL RULE above exists to
 * prevent: the reviewer only sees FILES TOUCHED / CHANGE SET, so when a
 * requirement's target file never appears there it has literally no evidence
 * either way — that's "absence of proof", which the prompt says is
 * "uncertain". A reviewer that ignores this and marks it "missing" anyway
 * will usually say so in its own evidence text ("does not appear in the
 * diff", "not present in FILES TOUCHED") — this catches that self-contradiction
 * deterministically rather than trusting the model to follow the rule every
 * time. Only fires on "missing" findings whose own stated evidence names the
 * diff/FILES TOUCHED as the reason, so it does not touch a "missing" verdict
 * backed by an actual line from the diff.
 */
function downgradeUnsupportedMissing(findings: RequirementFinding[]): RequirementFinding[] {
  return findings.map((f) => {
    if (f.status !== "missing") return f;
    if (!DIFF_ABSENCE_TERMS.test(f.evidence) || !EVIDENCE_ABSENCE_TERMS.test(f.evidence)) return f;
    return {
      ...f,
      status: "uncertain" as const,
      evidence:
        `${f.evidence} [downgraded from "missing" to "uncertain": this describes the file's absence from ` +
        `the diff, not a defect visible in the diff — the file may already satisfy the requirement without ` +
        `needing to change.]`,
    };
  });
}

/** How strongly a status asserts something about a requirement. A "missing"
 *  verdict is a confirmed defect, so it must never be softened by another
 *  file reporting the same requirement as satisfied or uncertain. */
const STATUS_RANK: Record<RequirementFinding["status"], number> = {
  missing: 3,
  satisfied: 2,
  uncertain: 1,
};

/**
 * Merges per-file reviews' findings into one list, one entry per requirement,
 * keeping the highest-precedence status seen for it (missing > satisfied >
 * uncertain). Requirements reported by several files have their evidence
 * combined when the statuses agree, so a repair pass sees every file's reason
 * rather than only whichever file happened to be reviewed first.
 */
export function mergeRequirementFindings(groups: RequirementFinding[][]): RequirementFinding[] {
  const byRequirement = new Map<string, RequirementFinding>();
  const order: string[] = [];

  for (const findings of groups) {
    for (const finding of findings) {
      // Normalized so the same requirement echoed back with a different case,
      // markdown backticks or spacing from another file's review still merges
      // into one entry instead of showing up as two competing verdicts.
      const key = finding.requirement.trim().toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ");
      if (key === "") continue;
      const existing = byRequirement.get(key);
      if (!existing) {
        byRequirement.set(key, { ...finding });
        order.push(key);
        continue;
      }
      if (STATUS_RANK[finding.status] > STATUS_RANK[existing.status]) {
        byRequirement.set(key, { ...finding });
      } else if (
        STATUS_RANK[finding.status] === STATUS_RANK[existing.status] &&
        finding.evidence &&
        !existing.evidence.includes(finding.evidence)
      ) {
        byRequirement.set(key, { ...existing, evidence: `${existing.evidence} ${finding.evidence}`.trim() });
      }
    }
  }

  return order.map((key) => byRequirement.get(key)!);
}

/** One parsed model response, or the fields a failure would have produced.
 *  `needsPerFileReview` only ever appears on a triage call's response (see
 *  TRIAGE_SYSTEM_ADDENDUM below) — absent (and so `false`) on every ordinary
 *  per-file call, which never asked for it. */
function parseReviewResponse(
  raw: string
): Pick<StaticReview, "findings" | "concerns" | "summary"> & { needsPerFileReview: boolean } {
  const parsed = JSON.parse(raw || "{}");
  const rawFindings: RequirementFinding[] = Array.isArray(parsed.requirements)
    ? parsed.requirements
        .filter((r: any) => r && typeof r.requirement === "string")
        .map((r: any) => ({
          requirement: String(r.requirement),
          status: ["satisfied", "missing", "uncertain"].includes(r.status) ? r.status : "uncertain",
          evidence: String(r.evidence ?? ""),
        }))
    : [];
  return {
    findings: downgradeUnsupportedMissing(rawFindings),
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
    summary: String(parsed.summary ?? "No summary returned."),
    needsPerFileReview: parsed.needsPerFileReview === true,
  };
}

/**
 * Appended to STATIC_QA_SYSTEM for the triage call only (see staticQaReview).
 * Kept local rather than folded into the shared prompt so every ordinary
 * per-file call's schema stays exactly as-is — this field only ever exists
 * because a triage call combines every file into one view and needs a way to
 * say "isolate these instead" when it isn't confident that view is trustworthy.
 */
const TRIAGE_SYSTEM_ADDENDUM = `TRIAGE MODE — ONE ADDITIONAL FIELD REQUIRED

This particular call shows every changed file's diff combined into one change set, not isolated per file the way
a full review normally would. Judge the requirements exactly as instructed above, but ALSO decide: can this
combined view be trusted, or would isolating each file individually change your answer? Set
"needsPerFileReview": true when a defect could plausibly be hiding behind another file's plausible-looking
change, when the combined diff is too large or tangled to trust a single read-through, or when you are simply
not confident. There is no penalty for asking for a closer look — a second pass will then review each file in
isolation and your answer here will be discarded.

Respond ONLY with valid JSON, extending the schema above with this one extra field:
{
  "requirements": [{"requirement": string, "status": "satisfied"|"missing"|"uncertain", "evidence": string}],
  "concerns": [string],
  "summary": string,
  "needsPerFileReview": boolean
}`;

export async function staticQaReview(
  goal: string,
  change: ChangeSet,
  deps: ReviewerDeps,
  contextNote: string
): Promise<StaticReview> {
  const signals = deterministicSignals(change);
  const deterministicDefects = signals.filter((s) => s.severity === "defect");
  const deterministicConcerns = signals.filter((s) => s.severity === "concern").map((s) => s.message);

  // Files that are intentionally retired — emptied to zero/whitespace, or
  // staged for end-of-run deletion — must never be judged as a missing
  // implementation. Their diff is pure removals, which reads to a reviewer as
  // "the code was dropped", so they are removed from the per-file review units
  // entirely and called out explicitly in FILES TOUCHED so their absence can't
  // be mistaken for a requirement that was never implemented.
  const bypassed = bypassedMissingDetectionPaths(change);
  const isBypassed = (file?: string) => Boolean(file && bypassed.has(normalizeRelPath(file)));

  // YIMPIM's own bookkeeping (QA_REVIEW.md, PROGRESS.md, .agent/*) never
  // implements a requirement, so there is nothing for a semantic review to
  // judge there — see isHarnessArtifactPath's own comment for why this
  // matters more than it looks: QA_REVIEW.md is append-only and NEVER
  // truncated, so its diff only grows, one full model round-trip's worth of
  // cost per phase that touches it, forever, for zero signal.
  const harnessPaths = new Set(
    [...change.modified, ...change.added, ...change.deleted, ...change.renamed.map((r) => r.to)]
      .map(normalizeRelPath)
      .filter(isHarnessArtifactPath)
  );
  const isHarness = (file?: string) => Boolean(file && harnessPaths.has(normalizeRelPath(file)));

  const fileSummary = [
    change.modified.length ? `modified: ${change.modified.join(", ")}` : "",
    change.added.length ? `added: ${change.added.join(", ")}` : "",
    change.deleted.length ? `deleted: ${change.deleted.join(", ")}` : "",
    change.renamed.length ? `renamed: ${change.renamed.map((r) => `${r.from} -> ${r.to}`).join(", ")}` : "",
    bypassed.size
      ? `emptied or staged for deletion (intentionally retired — do NOT flag as a missing/unimplemented requirement): ${[...bypassed].join(", ")}`
      : "",
    harnessPaths.size
      ? `harness bookkeeping, not application code (not reviewed — do NOT flag as a missing/unimplemented requirement): ${[...harnessPaths].join(", ")}`
      : "",
    change.lockFiles && change.lockFiles.length
      ? `lock file(s) also changed, confirming a dependency install actually ran (diff omitted — auto-generated, not meaningful to review line by line; judge the requirement from this fact plus any package.json change above, not from lock file content): ${change.lockFiles.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const DIFF_CHAR_CAP = 60000;
  // Above this file count, a triage call is skipped outright and the diff
  // goes straight to per-file review — a change this scattered is exactly
  // the case per-file isolation exists for, and triage would almost
  // certainly ask for it anyway, so paying for both calls buys nothing.
  const MAX_TRIAGE_FILES = 6;

  // Review one file at a time. A single blob hides a defect in the last file
  // behind plausible changes in the first, and the 60k cap can cut later files
  // out of the prompt entirely. Splitting is only used when every segment can
  // be attributed to a file with certainty — an unstructured/synthetic diff
  // falls back to the single whole-diff review, where nothing can be
  // mis-attributed to the wrong file.
  const segments = splitDiffByFile(change.diff);
  const attributable = segments.every((s) => Boolean(s.file));
  const units: DiffFileSegment[] = attributable ? segments : [{ diff: change.diff }];

  // Drop segments belonging to emptied/staged-deletion files, and to
  // harness bookkeeping (QA_REVIEW.md et al). When attribution is impossible
  // (an unstructured diff) there is no per-file segment to drop, so the
  // whole-diff fallback is kept as-is — nothing can be mis-attributed.
  const reviewableUnits = attributable ? units.filter((u) => !isBypassed(u.file) && !isHarness(u.file)) : units;

  type UnitResult =
    | { ok: true; unit: DiffFileSegment; parsed: ReturnType<typeof parseReviewResponse> }
    | { ok: false; unit: DiffFileSegment; error: string };

  /** One review call for one unit (a single file, or — for triage — every
   *  reviewable file combined into one). `system` is pluggable so the triage
   *  call can ask for the one extra field above without touching the schema
   *  every ordinary per-file call relies on. */
  const askUnit = async (
    unit: DiffFileSegment,
    index: number,
    total: number,
    system: string
  ): Promise<UnitResult> => {
    const lineTruncated = truncateLongDiffLines(unit.diff);
    const diffShown = lineTruncated.slice(0, DIFF_CHAR_CAP);
    // Told explicitly, not left to infer, since a reviewer that doesn't know
    // part of the change set is missing has no reason to mark anything
    // "uncertain" instead of confidently (and wrongly) judging what it saw as
    // the whole picture.
    const truncationNote =
      lineTruncated.length > DIFF_CHAR_CAP
        ? `\n\n[CHANGE SET TRUNCATED: ${lineTruncated.length - DIFF_CHAR_CAP} more characters not shown. Any requirement whose evidence might live in the cut portion must be marked "uncertain", not "missing".]`
        : "";

    const user = `REQUIREMENTS UNDER TEST:
${goal}

VERIFICATION CONTEXT:
${contextNote}

FILES TOUCHED:
${fileSummary || "(none)"}
${unit.file ? `\nFILE UNDER REVIEW: ${unit.file} (file ${index + 1} of ${total}) — the change set below is scoped to this one file. A requirement that this file does not contain must be marked "uncertain" here, NOT "missing": it may be implemented in another file listed above.` : ""}

CHANGE SET:
${diffShown}${truncationNote}`;

    try {
      const parsed = parseReviewResponse(await deps.ask(system, user));
      console.log(`[QA] Semantic review done for ${unit.file ?? "whole change set"}.`);
      return { ok: true as const, unit, parsed };
    } catch (err: any) {
      // The reviewer failing is not evidence of a defect. Fail open on the
      // model, but say so loudly so confidence reflects it.
      return { ok: false as const, unit, error: err.message };
    }
  };

  // Each unit's review is fully independent (same shared, read-only prompt
  // context; no cross-unit state), so they run concurrently rather than one
  // sequential API round-trip per file — with N files that turned a serial
  // N * (single-call latency) wait into a single wait for the slowest call.
  const runPerFileFanOut = (): Promise<UnitResult[]> => {
    console.log(
      `[QA] Semantic review: checking ${reviewableUnits.length} file(s) against requirements in parallel — ` +
        reviewableUnits.map((u) => `${u.file ?? "whole change set"} (${(u.diff.length / 1000).toFixed(1)}k chars)`).join(", ")
    );
    return Promise.all(reviewableUnits.map((unit, i) => askUnit(unit, i, reviewableUnits.length, STATIC_QA_SYSTEM)));
  };

  let results: UnitResult[];

  // A single reviewable unit already costs exactly one call today — there is
  // nothing a triage pass could save there, so it goes straight to review.
  // For more than one, every unit's own system prompt is the same fixed
  // overhead regardless of how small its diff is — the actual cost driver
  // this triage step exists to avoid — so try one combined pass first and
  // only pay for per-file isolation when triage itself asks for it (or the
  // diff is large/scattered enough that it's skipped outright, see
  // MAX_TRIAGE_FILES above).
  const combinedSize = reviewableUnits.reduce((n, u) => n + u.diff.length, 0);
  const triageEligible =
    reviewableUnits.length > 1 && reviewableUnits.length <= MAX_TRIAGE_FILES && combinedSize <= DIFF_CHAR_CAP;

  if (triageEligible) {
    const combinedUnit: DiffFileSegment = { diff: reviewableUnits.map((u) => u.diff).join("\n\n") };
    const triage = await askUnit(combinedUnit, 0, 1, `${STATIC_QA_SYSTEM}\n\n${TRIAGE_SYSTEM_ADDENDUM}`);
    if (triage.ok && !triage.parsed.needsPerFileReview) {
      console.log(
        `[QA] Semantic review: triage reviewed ${reviewableUnits.length} file(s) in one combined pass — confident, skipping per-file fan-out.`
      );
      results = [triage];
    } else {
      if (triage.ok) {
        console.log(`[QA] Semantic review: triage asked for a closer look — falling back to per-file review.`);
      }
      results = await runPerFileFanOut();
    }
  } else {
    results = reviewableUnits.length === 1 ? [await askUnit(reviewableUnits[0], 0, 1, STATIC_QA_SYSTEM)] : await runPerFileFanOut();
  }

  const findingsPerUnit: RequirementFinding[][] = [];
  const concerns: string[] = [];
  const summaries: string[] = [];
  const failures: string[] = [];

  for (const result of results) {
    if (result.ok) {
      findingsPerUnit.push(result.parsed.findings);
      concerns.push(...result.parsed.concerns);
      summaries.push(result.unit.file ? `${result.unit.file}: ${result.parsed.summary}` : result.parsed.summary);
    } else {
      failures.push(`${result.unit.file ?? "change set"}: ${result.error}`);
    }
  }

  const findings = mergeRequirementFindings(findingsPerUnit);

  const review: StaticReview = {
    defectFound: findings.some((f) => f.status === "missing"),
    findings,
    concerns: [...deterministicConcerns, ...Array.from(new Set(concerns))],
    summary: summaries.length > 0 ? summaries.join("\n") : "Static review could not be completed.",
  };

  if (failures.length > 0) {
    review.reviewUnavailable = failures.join("; ");
    review.concerns.push(
      `${failures.length} of ${reviewableUnits.length} file review(s) could not be completed: ${failures.join("; ")}`
    );
  }

  // Deterministic defects stand on their own, independent of the model.
  if (deterministicDefects.length > 0) {
    review.defectFound = true;
    review.findings.push(
      ...deterministicDefects.map((d) => ({
        requirement: d.requirement ?? "No runtime stubs or removed tests introduced",
        status: "missing" as const,
        evidence: d.message,
      }))
    );
  }

  return review;
}

export function renderReview(review: StaticReview): string {
  const lines: string[] = [];
  lines.push(review.summary);
  if (review.reviewUnavailable) {
    lines.push(`(static reviewer unavailable: ${review.reviewUnavailable})`);
  }
  for (const f of review.findings) {
    const icon = f.status === "satisfied" ? "✓" : f.status === "missing" ? "✗" : "?";
    lines.push(`  ${icon} ${f.requirement} — ${f.evidence}`);
  }
  for (const c of review.concerns) lines.push(`  ! ${c}`);
  return lines.join("\n");
}
