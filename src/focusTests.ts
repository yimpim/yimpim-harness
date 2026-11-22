/**
 * Two tiers of tests, kept apart on purpose.
 *
 *  - MAIN suite: the project's permanent tests, one owner per source file. A
 *    change to a file's behavior means changing that file's test, not adding a
 *    parallel one.
 *  - FOCUS tests: throwaway tests an agent writes to prove ONE change, under
 *    `<testRoot>/_focus/`. QA runs just those. When the phase passes they are
 *    reviewed by a model: by default thrown away, and only kept (by UPDATING
 *    the permanent tests that already cover that behavior, or adding one when
 *    nothing does) if they describe lasting behavior. Then deleted — so a later
 *    full run only ever sees main tests.
 *
 * Nothing here knows a language or a framework by name beyond file naming
 * conventions; running tests goes through the project's own test script.
 */

import fsSync from "fs";
import { lazyIgnore, NATIVE_TREES, inTestOrSpecDir, TEST_DIR, SPEC_DIR_NAMES } from "./projectPaths.js";

import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const FOCUS_DIRNAME = "_focus";

// The shared ignore list (projectPaths.ts) plus the native trees an Expo prebuild writes.
const SKIP_DIRS = lazyIgnore(NATIVE_TREES);
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|kt|java|go|rs|swift|dart|cs|rb|php|vue|svelte)$/i;

const posix = (p: string) => p.replace(/\\/g, "/");
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// ------------------------------------------------------------ classification

export function isTestPath(rel: string): boolean {
  const p = posix(rel);
  return (
    inTestOrSpecDir(p) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/i.test(p) ||
    /_test\.(py|go)$/i.test(p)
  );
}

/**
 * A user's test file the harness may rewrite without it counting against a phase's file budget or being warned about as out of plan (a repair reconciling stale assertions after an
 * intentional change). Test directories and executable test file names, in any language. NOT exempt: the harness's own paths (reference/, .yimpim/), specification folders (spec/, specs/),
 * and documents (*.md), which stay warned and counted. Separate from isTestPath, which other callers rely on (it treats specs/ as tests).
 */
export const EXEMPT_TEST_CEILING = 25;
/** A folder name that holds the user's tests (exempt), and the names that stay protected: specification folders and the harness's own places. */
const TEST_SEGMENT = new RegExp("^(" + TEST_DIR + ")$", "i");
const PROTECTED_SEGMENT = new RegExp("^(" + [...SPEC_DIR_NAMES, "reference", "\\.yimpim"].join("|") + ")$", "i");
export function isScopeExemptPath(rel: string): boolean {
  const p = posix(rel).replace(/^\.\//, "");
  const segs = p.split("/");
  if (segs.some((s) => PROTECTED_SEGMENT.test(s))) return false;
  if (/\.(md|mdx|markdown)$/i.test(p)) return false;
  if (isFocusPath(p)) return true;
  if (segs.slice(0, -1).some((s) => TEST_SEGMENT.test(s))) return true;
  const base = segs[segs.length - 1];
  return (
    /\.test\.[a-z0-9]+$/i.test(base) ||
    (CODE_EXT.test(base) && (/\.spec\.[a-z0-9]+$/i.test(base) || /_test\.[a-z0-9]+$/i.test(base) || /^test_[^/]+\.[a-z0-9]+$/i.test(base)))
  );
}

export function isFocusPath(rel: string): boolean {
  return new RegExp(`(^|/)${FOCUS_DIRNAME}/`).test(posix(rel));
}

/** A source file a test could meaningfully own (not a test, not data/config/docs). */
export function isSourceCodePath(rel: string): boolean {
  const p = posix(rel);
  return CODE_EXT.test(p) && !isTestPath(p) && !isFocusPath(p) && !/(^|\/)(node_modules|\.agent|\.expo|dist|build)\//.test(p);
}

/** "dashboard.extra.test.ts" / "test_dashboard.py" / "dashboard_test.go" -> "dashboard". */
export function testSubjectKey(rel: string): string {
  let base = path.posix.basename(posix(rel)).replace(/\.[a-z0-9]+$/i, "");
  base = base.replace(/\.(test|spec)$/i, "").replace(/_test$/i, "").replace(/^test_/i, "");
  return squash(base.split(".")[0]);
}

export function sourceKey(rel: string): string {
  return squash(path.posix.basename(posix(rel)).replace(/\.[a-z0-9]+$/i, ""));
}

// ------------------------------------------------------------------ discovery

/** Every test file in the repo (repo-relative, posix), skipping vendor/build dirs. */
export function listTestFiles(repoRoot: string, opts: { includeFocus?: boolean } = {}): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string) => {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > 30000) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = posix(path.relative(repoRoot, path.join(dir, e.name)));
        // A probe copy (healEdits.runProbe) that a crash left behind is not a test of the project's.
        if (CODE_EXT.test(rel) && isTestPath(rel) && (opts.includeFocus || !isFocusPath(rel)) && !/(^|\/)zz_probe_/.test(rel)) out.push(rel);
      }
    }
  };
  walk(repoRoot);
  return out;
}

/** Strict ownership: a test whose name is exactly the source file's name. */
export function findOwningTests(sourceRel: string, tests: string[]): string[] {
  const key = sourceKey(sourceRel);
  if (!key) return [];
  return tests.filter((t) => testSubjectKey(t) === key);
}

/** Looser, for guidance only: same-name tests, name-prefixed tests, and tests
 *  that import the file. Never used to demand anything. */
export function findRelatedTests(repoRoot: string, sourceRel: string, tests: string[]): string[] {
  const key = sourceKey(sourceRel);
  if (!key) return [];
  const base = path.posix.basename(posix(sourceRel)).replace(/\.[a-z0-9]+$/i, "");
  const importRe = new RegExp(`['"][^'"]*[/\\\\]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.[a-z]+)?['"]`);
  const related: string[] = [];
  for (const t of tests) {
    const tk = testSubjectKey(t);
    if (tk === key || (tk.startsWith(key) && key.length >= 4)) {
      related.push(t);
      continue;
    }
    try {
      const src = fsSync.readFileSync(path.join(repoRoot, t), "utf-8").slice(0, 60_000);
      if (importRe.test(src)) related.push(t);
    } catch {}
  }
  // Exact owners first.
  return related.sort((a, b) => Number(testSubjectKey(b) === key) - Number(testSubjectKey(a) === key)).slice(0, 8);
}

export function testRootDir(repoRoot: string): string {
  for (const d of ["__tests__", "tests", "test"]) {
    try {
      if (fsSync.statSync(path.join(repoRoot, d)).isDirectory()) return d;
    } catch {}
  }
  return "__tests__";
}

export function focusDir(repoRoot: string): string {
  return `${testRootDir(repoRoot)}/${FOCUS_DIRNAME}`;
}

// --------------------------------------------------------- Editor guidance

/** Appended to an Editor phase's instructions: which tests already cover the
 *  files it will touch, and how to add tests without making a mess. */
export function renderTestGuidance(repoRoot: string, plannedFiles: string[]): string {
  const sources = plannedFiles.filter(isSourceCodePath);
  const tests = listTestFiles(repoRoot);
  const lines: string[] = [];
  for (const f of sources) {
    const related = findRelatedTests(repoRoot, f, tests);
    if (related.length > 0) lines.push(`  - ${f}  ->  ${related.join(", ")}`);
  }
  const fdir = focusDir(repoRoot);
  const parts = [
    ``,
    `TESTS (read this):`,
    lines.length > 0
      ? `Existing tests that already cover the files you will change:\n${lines.join("\n")}\n` +
        `If your change alters what one of those files does, UPDATE the existing test in this same phase. ` +
        `Never create a second test file for a file that already has one.`
      : `No existing test covers the planned files.`,
    `To prove this phase's change, you may write a small focused test under \`${fdir}/\` (one file, only what this change needs). ` +
      `It is temporary: QA runs it, and after the phase passes it is reviewed and almost always just deleted. ` +
      `Do not put permanent tests there. Prefer real code over mocks; mock only what cannot run (network, native modules).`,
    `If this change genuinely needs no test change (a pure refactor, styling, docs), say so in conclude_task's testsNotNeeded with the reason.`,
  ];
  return parts.join("\n");
}

// ----------------------------------------------------------------- manifest

function manifestPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "focus-tests.json");
}

export function loadFocusFiles(repoRoot: string): string[] {
  try {
    const raw = JSON.parse(fsSync.readFileSync(manifestPath(repoRoot), "utf-8"));
    return (Array.isArray(raw?.files) ? raw.files : [])
      .filter((f: unknown): f is string => typeof f === "string" && isFocusPath(f))
      .map(posix)
      .filter((f: string) => fsSync.existsSync(path.join(repoRoot, f)));
  } catch {
    return [];
  }
}

function saveFocusFiles(repoRoot: string, files: string[]): void {
  try {
    fsSync.mkdirSync(path.dirname(manifestPath(repoRoot)), { recursive: true });
    fsSync.writeFileSync(manifestPath(repoRoot), JSON.stringify({ files: [...new Set(files)] }, null, 2), "utf-8");
  } catch {}
}

/** Records any file written under the focus directory (the only place the
 *  harness will later delete from). Returns the full tracked set. */
export function registerFocusFiles(repoRoot: string, written: string[]): string[] {
  const current = loadFocusFiles(repoRoot);
  const add = written.map(posix).filter((f) => isFocusPath(f) && fsSync.existsSync(path.join(repoRoot, f)));
  const all = [...new Set([...current, ...add])];
  if (add.length > 0) saveFocusFiles(repoRoot, all);
  return all;
}

function removeEmptyFocusDir(repoRoot: string): void {
  try {
    const dir = path.join(repoRoot, focusDir(repoRoot));
    if (fsSync.existsSync(dir) && fsSync.readdirSync(dir).length === 0) fsSync.rmdirSync(dir);
  } catch {}
}

/** Deletes every tracked focus file (stale leftovers from an aborted task). */
export function clearFocusFiles(repoRoot: string): number {
  const files = loadFocusFiles(repoRoot);
  for (const f of files) {
    try {
      fsSync.unlinkSync(path.join(repoRoot, f));
    } catch {}
  }
  saveFocusFiles(repoRoot, []);
  removeEmptyFocusDir(repoRoot);
  return files.length;
}

// ---------------------------------------------------------- running tests

export type FocusRunStatus = "pass" | "fail" | "no-tests" | "tooling" | "no-runner";

export interface FocusRun {
  status: FocusRunStatus;
  detail: string;
}

export interface RunJudge {
  isTooling: (err: any) => boolean;
  noTests: (output: string) => boolean;
  describe: (err: any) => string;
}

/** The project's own test command narrowed to specific files, or undefined
 *  when we cannot do that safely for this project type. */
export function focusedTestCommand(repoRoot: string, files: string[]): { bin: string; args: string[] } | undefined {
  const exists = (p: string) => fsSync.existsSync(path.join(repoRoot, p));
  if (exists("package.json")) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
      if (pkg?.scripts?.test) {
        return { bin: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "test", "--", ...files] };
      }
    } catch {}
  }
  if (exists("pytest.ini") || exists("pyproject.toml") || exists("setup.cfg")) {
    return { bin: process.platform === "win32" ? "python" : "python3", args: ["-m", "pytest", "-q", ...files] };
  }
  return undefined;
}

export async function runFocusedTests(
  repoRoot: string,
  files: string[],
  judge: RunJudge,
  launch: (bin: string, args: string[]) => { bin: string; args: string[] } = (bin, args) => ({ bin, args })
): Promise<FocusRun> {
  const cmd = focusedTestCommand(repoRoot, files);
  if (!cmd) return { status: "no-runner", detail: "no test script (package.json `test`) or pytest config to run focused tests with" };
  const l = launch(cmd.bin, cmd.args);
  try {
    await execFileAsync(l.bin, l.args, {
      cwd: repoRoot,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return { status: "pass", detail: `${files.length} file(s) passed` };
  } catch (err: any) {
    const out = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`;
    if (judge.noTests(out)) return { status: "no-tests", detail: "the runner found no tests in those files" };
    if (judge.isTooling(err)) return { status: "tooling", detail: judge.describe(err) };
    const tail = out.split(/\r?\n/).filter((x) => x.trim()).slice(-25).join("\n").slice(0, 3000);
    return { status: "fail", detail: tail || `exited ${err?.code}` };
  }
}

// -------------------------------------------------------- fold-in decision

/** Signs a focused test only proved THIS edit and is not worth keeping. */
export function classifyFocusTest(content: string): { keep: boolean; reason: string } {
  if (!/\b(expect|assert)\w*\s*[.(]|\bassert\s|\bself\.assert|\bt\.(is|true|equal|deepEqual)\b/.test(content)) {
    return { keep: false, reason: "asserts nothing" };
  }
  if (/toHaveBeenNthCalledWith|\.mock\.calls\[|call_args_list|toMatchSnapshot|toMatchInlineSnapshot/.test(content)) {
    return { keep: false, reason: "pins internal call order or a snapshot, which breaks on any refactor" };
  }
  const mocks = (content.match(/\b(jest|vi)\.mock\(|@patch\b|mock\.patch\(/g) ?? []).length;
  if (mocks >= 4) return { keep: false, reason: `needs ${mocks} mocks of its own — too tied to this one edit` };
  return { keep: true, reason: "checks behavior" };
}

const IMPORT_RE = /(\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bjest\.mock\(\s*|\bvi\.mock\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;

/** Non-test source files a test imports by relative path. */
export function subjectsOf(repoRoot: string, testRel: string, content: string): string[] {
  const out: string[] = [];
  const dir = path.posix.dirname(posix(testRel));
  let m: RegExpExecArray | null;
  const re = new RegExp(IMPORT_RE.source, "g");
  while ((m = re.exec(content)) !== null) {
    const base = path.posix.normalize(path.posix.join(dir, m[3]));
    for (const cand of [base, ...["ts", "tsx", "js", "jsx", "mjs"].map((e) => `${base}.${e}`), ...["ts", "tsx", "js"].map((e) => `${base}/index.${e}`)]) {
      try {
        if (fsSync.statSync(path.join(repoRoot, cand)).isFile()) {
          if (isSourceCodePath(cand) && !out.includes(cand)) out.push(cand);
          break;
        }
      } catch {}
    }
  }
  return out;
}

export interface FocusOutcome {
  file: string;
  action: "updated" | "added" | "discarded";
  /** Permanent test file(s) changed or created. */
  target?: string;
  reason: string;
}

export interface FinalizeOptions {
  repoRoot: string;
  /**
   * A review pass by a model with edit tools. It decides whether this focused
   * test says anything lasting and, only if so, edits the PERMANENT suite:
   * changing or replacing the existing tests that already cover the same
   * behavior (candidates, E2E ones included), or adding a new permanent test
   * when nothing covers it. Making no edit is the default and a valid answer.
   */
  review: (req: { focusRel: string; candidates: string[]; suggestedNew: string; reason: string }) => Promise<void>;
  /**
   * QA's judgment, made BEFORE any editing: does this focused test describe
   * lasting behavior that belongs in the permanent suite? Anything but an
   * explicit yes (including an error) discards it.
   */
  decide: (req: { focusRel: string; content: string; candidates: string[] }) => Promise<{ keep: boolean; reason: string }>;
  run: (files: string[]) => Promise<FocusRun>;
}

function readMainTests(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of listTestFiles(repoRoot)) {
    try {
      map.set(rel, fsSync.readFileSync(path.join(repoRoot, rel), "utf-8"));
    } catch {}
  }
  return map;
}

/** Puts the permanent suite back exactly as the snapshot had it. */
function restoreMainTests(repoRoot: string, snapshot: Map<string, string>): void {
  for (const rel of listTestFiles(repoRoot)) {
    if (!snapshot.has(rel)) {
      try {
        fsSync.unlinkSync(path.join(repoRoot, rel));
      } catch {}
    }
  }
  for (const [rel, content] of snapshot) {
    const abs = path.join(repoRoot, rel);
    try {
      if (!fsSync.existsSync(abs) || fsSync.readFileSync(abs, "utf-8") !== content) {
        fsSync.mkdirSync(path.dirname(abs), { recursive: true });
        fsSync.writeFileSync(abs, content, "utf-8");
      }
    } catch {}
  }
}

/**
 * Called once a phase has PASSED. Two roles, in order:
 *   1. QA judges (decide) whether the focused test describes lasting behavior
 *      that belongs in the permanent suite. The default is DISCARD: a small
 *      change proves itself and leaves no lasting test behind.
 *   2. Only on a yes, the Editor reviews the existing permanent tests (review),
 *      finds where that behavior is already covered or now conflicts, and
 *      UPDATES those tests in place (not appending next to them), or adds one
 *      new test when nothing covers it. The harness verifies the result by running every file the review
 * touched, and puts the suite back exactly as it was if that fails or if a test
 * file was deleted. Nothing here asks a person.
 */
export async function finalizeFocusTests(opts: FinalizeOptions): Promise<FocusOutcome[]> {
  const { repoRoot } = opts;
  const files = loadFocusFiles(repoRoot);
  const outcomes: FocusOutcome[] = [];
  if (files.length === 0) return outcomes;
  const root = testRootDir(repoRoot);

  for (const focusRel of files) {
    let content = "";
    try {
      content = fsSync.readFileSync(path.join(repoRoot, focusRel), "utf-8");
    } catch {
      continue;
    }

    const verdict = classifyFocusTest(content);
    if (!verdict.keep) {
      outcomes.push({ file: focusRel, action: "discarded", reason: verdict.reason });
      continue;
    }

    const subjects = subjectsOf(repoRoot, focusRel, content);
    const mainTests = listTestFiles(repoRoot);
    const candidates = [
      ...new Set([
        ...subjects.flatMap((s) => findOwningTests(s, mainTests)),
        ...subjects.flatMap((s) => findRelatedTests(repoRoot, s, mainTests)),
      ]),
    ].slice(0, 6);
    const ext = path.posix.basename(focusRel).match(/\.(test|spec)\.[a-z0-9]+$/i)?.[0] ?? path.posix.extname(focusRel);
    const subjectBase = subjects[0] ? path.posix.basename(subjects[0]).replace(/\.[a-z0-9]+$/i, "") : "";
    const suggestedNew = `${root}/${subjectBase || path.posix.basename(focusRel).replace(/\.[^.]+(\.[^.]+)?$/, "")}${ext}`;

    let decision: { keep: boolean; reason: string };
    try {
      decision = await opts.decide({ focusRel, content, candidates });
    } catch (err: any) {
      decision = { keep: false, reason: `QA could not judge it (${String(err?.message ?? err).slice(0, 80)})` };
    }
    if (!decision.keep) {
      outcomes.push({ file: focusRel, action: "discarded", reason: `QA: ${decision.reason}` });
      continue;
    }

    const before = readMainTests(repoRoot);
    try {
      await opts.review({ focusRel, candidates, suggestedNew, reason: decision.reason });
    } catch (err: any) {
      restoreMainTests(repoRoot, before);
      outcomes.push({ file: focusRel, action: "discarded", reason: `review pass failed (${String(err?.message ?? err).slice(0, 120)})` });
      continue;
    }

    const after = readMainTests(repoRoot);
    const deleted = [...before.keys()].filter((k) => !after.has(k));
    const created = [...after.keys()].filter((k) => !before.has(k));
    const edited = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    if (deleted.length > 0) {
      // Replacing a test inside a file is expected; removing a whole test file is not this pass's call.
      restoreMainTests(repoRoot, before);
      outcomes.push({ file: focusRel, action: "discarded", reason: `the review deleted test file(s) (${deleted.join(", ")}), which is not allowed; reverted` });
      continue;
    }
    const changed = [...created, ...edited];
    if (changed.length === 0) {
      outcomes.push({ file: focusRel, action: "discarded", reason: "QA wanted it kept, but the Editor found the permanent suite already covers it" });
      continue;
    }

    const ran = await opts.run(changed);
    if (ran.status === "pass") {
      outcomes.push({
        file: focusRel,
        action: created.length > 0 ? "added" : "updated",
        target: changed.join(", "),
        reason: created.length > 0 ? "added as a new permanent test" : "updated the existing test(s) that cover this behavior",
      });
    } else {
      restoreMainTests(repoRoot, before);
      outcomes.push({
        file: focusRel,
        action: "discarded",
        reason: ran.status === "fail" ? `the permanent test change did not pass (${changed.join(", ")}); reverted` : `could not verify the permanent test change (${ran.status}); reverted`,
      });
    }
  }

  for (const f of files) {
    try {
      fsSync.unlinkSync(path.join(repoRoot, f));
    } catch {}
  }
  saveFocusFiles(repoRoot, []);
  removeEmptyFocusDir(repoRoot);
  return outcomes;
}

export function renderFocusOutcomes(outcomes: FocusOutcome[]): string[] {
  return outcomes.map((o) =>
    o.action === "discarded"
      ? `discarded ${o.file} — ${o.reason}`
      : `${o.action} ${o.file} -> ${o.target} — ${o.reason}`
  );
}

// ------------------------------------------------- "tests not needed" claim

export const TESTS_NOT_NEEDED_MARKER = "\n\n[TESTS NOT NEEDED]\n";
export const TESTS_NOT_NEEDED_GOAL_MARKER = "\n\nEditor says the permanent tests need no change (a claim):\n";

export function encodeTestsNotNeeded(reason: unknown): string {
  const r = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return r ? `${TESTS_NOT_NEEDED_MARKER}${r}` : "";
}

export function extractTestsNotNeeded(editorResult: string): string | undefined {
  const idx = editorResult.indexOf(TESTS_NOT_NEEDED_MARKER);
  if (idx === -1) return undefined;
  const rest = editorResult.slice(idx + TESTS_NOT_NEEDED_MARKER.length);
  const end = rest.indexOf("\n\n[");
  return (end === -1 ? rest : rest.slice(0, end)).trim() || undefined;
}

export function renderTestsNotNeededForGoal(reason: string | undefined): string {
  return reason ? `${TESTS_NOT_NEEDED_GOAL_MARKER}${reason}` : "";
}

export function parseTestsNotNeeded(goal: string): string | undefined {
  const idx = goal.indexOf(TESTS_NOT_NEEDED_GOAL_MARKER);
  if (idx === -1) return undefined;
  const rest = goal.slice(idx + TESTS_NOT_NEEDED_GOAL_MARKER.length);
  const end = rest.indexOf("\n\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim() || undefined;
}

// --------------------------------------------------- main-suite coverage

export interface CoverageProblem {
  kind: "stale-owner" | "duplicate-test";
  message: string;
}

/**
 * Deterministic check that the permanent suite moved with the code.
 *  - stale-owner: a source file changed, a test named exactly after it exists,
 *    and no such test was touched this phase.
 *  - duplicate-test: a NEW test file was added whose subject already has a test.
 * No owner means no demand (a project with no tests is not blocked here).
 */
export function checkMainSuiteCoverage(
  repoRoot: string,
  change: { modified: string[]; added: string[] },
  /** A test the change is FOR (a fix made to satisfy it): it is the spec, so it is not expected to change along with the code. */
  isFixTarget: (testRel: string) => boolean = () => false
): CoverageProblem[] {
  const modified = change.modified.map(posix);
  const added = change.added.map(posix);
  const touched = new Set([...modified, ...added]);
  const allTests = listTestFiles(repoRoot);
  const problems: CoverageProblem[] = [];

  const stale: string[] = [];
  for (const src of modified.filter(isSourceCodePath)) {
    const owners = findOwningTests(src, allTests);
    if (owners.length > 0 && !owners.some((o) => touched.has(o) || isFixTarget(o))) stale.push(`${src} (owned by ${owners.join(", ")})`);
  }
  if (stale.length > 0) {
    problems.push({
      kind: "stale-owner",
      message:
        `${stale.length} changed file(s) have a permanent test that was not updated: ${stale.slice(0, 6).join("; ")}` +
        `${stale.length > 6 ? "; …" : ""}. Update the test to match the new behavior in this phase, or if behavior genuinely did not change, ` +
        `say so with conclude_task's testsNotNeeded and the reason.`,
    });
  }

  const addedTests = added.filter((f) => isTestPath(f) && !isFocusPath(f) && CODE_EXT.test(f));
  const existing = allTests.filter((t) => !added.includes(t));
  const dupes: string[] = [];
  for (const t of addedTests) {
    const key = testSubjectKey(t);
    if (!key) continue;
    const twin = existing.find((e) => testSubjectKey(e) === key);
    if (twin) dupes.push(`${t} duplicates ${twin}`);
  }
  if (dupes.length > 0) {
    problems.push({
      kind: "duplicate-test",
      message: `a new test file was added for something that already has one: ${dupes.join("; ")}. Put the cases in the existing test file instead.`,
    });
  }
  return problems;
}
