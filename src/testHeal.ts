/**
 * Test healing: brings a red test suite back to green.
 *
 * The full suite is run once and its failures are grouped by test file. Every failing file then gets its own worker,
 * all started at once (nothing caps how many). A worker reads the failing test, the source it imports and the recent
 * git history of both, and decides whether the TEST is stale (the code moved on, the test did not) or the CODE is
 * wrong. A stale test is rewritten and re-run until it passes; a code bug is never "fixed" by editing the test, it is
 * reported for a person (or a later phase) to decide.
 *
 * A worker stops when its last attempt produced a failure it had already seen (no progress), not at a fixed count.
 * The one thing it may never do is get green by gutting the test: dropped assertions and newly skipped tests are
 * refused and the worker is told why.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { focusedTestCommand, isTestPath } from "./focusTests.js";
import { parseLenient } from "./jsonRepair.js";

const execFileAsync = promisify(execFile);

export type HealStatus = "healed" | "already-green" | "code-bug" | "unclear" | "unhealed";

export interface HealResult {
  file: string;
  status: HealStatus;
  /** One line: what was wrong and what was done. */
  note: string;
  attempts: number;
}

export type HealCall = (messages: { role: "system" | "user" | "assistant"; content: string }[], label: string, json: boolean) => Promise<string>;

export interface HealOptions {
  repoRoot: string;
  call: HealCall;
  log?: (line: string) => void;
  /** Heal only these test files; default is every failing file in the full run. */
  files?: string[];
  /** Replaces the real test runner (tests). */
  run?: (repoRoot: string, files: string[]) => Promise<SuiteRun>;
}

export interface SuiteRun {
  ok: boolean;
  output: string;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Test files named as failing in a runner's output (jest, vitest, pytest). */
export function failingTestFiles(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^FAIL\s+(?:[\w-]+\s+)?(\S+\.[a-z0-9]+)\b/i.exec(line);
    if (!m) m = /^FAILED\s+(\S+?\.py)(?:::|\s|$)/.exec(line);
    if (!m) m = /^ERROR\s+(\S+?\.py)(?:::|\s|$)/.exec(line);
    if (m) found.add(m[1].replace(/\\/g, "/"));
  }
  return [...found];
}

/** Runs the project's own test command, narrowed to `files` (the whole suite when empty). */
export async function runSuite(repoRoot: string, files: string[]): Promise<SuiteRun> {
  const cmd = focusedTestCommand(repoRoot, files);
  if (!cmd) return { ok: false, output: "No test script (package.json `test`) or pytest config to run." };
  try {
    const { stdout, stderr } = await execFileAsync(cmd.bin, cmd.args, {
      cwd: repoRoot,
      timeout: 900_000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      shell: process.platform === "win32",
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err: any) {
    return { ok: false, output: `${err?.stdout ?? ""}\n${err?.stderr ?? ""}` };
  }
}

/** Relative imports of a test file that resolve to real files in the repo. */
export function importedSources(repoRoot: string, testRel: string, content: string): string[] {
  const out = new Set<string>();
  const dir = path.posix.dirname(testRel.replace(/\\/g, "/"));
  const re = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const base = path.posix.normalize(path.posix.join(dir, m[1]));
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"]) {
      const rel = base + ext;
      try {
        if (fs.statSync(path.join(repoRoot, rel)).isFile()) {
          out.add(rel);
          break;
        }
      } catch {}
    }
  }
  return [...out];
}

async function gitHistory(repoRoot: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    try {
      const { stdout } = await execFileAsync("git", ["log", "-5", "--format=%h %ad %s", "--date=short", "--", f], { cwd: repoRoot });
      if (stdout.trim()) parts.push(`${f}\n${stdout.trim().split("\n").map((l) => "  " + l).join("\n")}`);
    } catch {}
  }
  return parts.join("\n");
}

const countAssertions = (s: string) => (s.match(/\b(expect|assert)\w*\s*[.(]|\bassert\s|\bself\.assert/g) ?? []).length;
const countSkips = (s: string) => (s.match(/\.skip\(|\bxit\(|\bxtest\(|\bxdescribe\(|\.todo\(|@pytest\.mark\.skip|\bunittest\.skip/g) ?? []).length;

/** Why a rewritten test is refused, or undefined when it is acceptable. */
export function gutted(before: string, after: string): string | undefined {
  const a0 = countAssertions(before);
  const a1 = countAssertions(after);
  if (a0 >= 4 && a1 < Math.ceil(a0 * 0.7)) {
    return `it has ${a1} assertions where the original had ${a0}. Update what the assertions expect; do not remove them`;
  }
  if (countSkips(after) > countSkips(before)) return "it skips tests that were running. Make them pass instead of skipping them";
  if (after.trim().length < before.trim().length * 0.4) return "it is much shorter than the original. Keep the coverage";
  return undefined;
}

const SYSTEM = `You repair a failing test file. A project's tests went red because the code changed and the tests were not updated with it.
You decide WHO is wrong:
- "stale-test": the code's new behaviour is intended and the test still asserts the old one (renamed export, changed output, new argument, moved file, changed text). Return the whole corrected test file.
- "code-bug": the test asserts something sensible and the code now breaks it (a regression). Do NOT change the test. Say what is broken in the code and where.
- "unclear": you cannot tell from what you were given.
Rules for a stale test: keep every case that is still meaningful, update expected values and calls to match the code you were shown, never delete assertions or skip tests to make it pass, never loosen an assertion into one that cannot fail. Mock only what the test already mocked.
Answer with JSON only: {"verdict":"stale-test|code-bug|unclear","reason":"one sentence","test":"the complete new test file (stale-test only)"}`;

function matchEol(original: string, next: string): string {
  const crlf = original.includes("\r\n");
  const lf = next.replace(/\r\n/g, "\n");
  return crlf ? lf.replace(/\n/g, "\r\n") : lf;
}

const failureKey = (out: string) =>
  out
    .replace(ANSI, "")
    .split(/\r?\n/)
    .filter((l) => /^\s*(●|✕|×|FAIL|FAILED|expect|Expected|Received|Error|TypeError|AssertionError|Cannot find)/.test(l))
    .join("\n")
    .slice(0, 4000);

async function healOne(opts: HealOptions, file: string): Promise<HealResult> {
  const { repoRoot } = opts;
  const run = opts.run ?? runSuite;
  const abs = path.join(repoRoot, file);
  let original: string;
  try {
    original = fs.readFileSync(abs, "utf-8");
  } catch {
    return { file, status: "unclear", note: "the file could not be read", attempts: 0 };
  }
  if (!isTestPath(file)) return { file, status: "unclear", note: "not a test file, so it is left alone", attempts: 0 };

  let first = await run(repoRoot, [file]);
  if (first.ok) return { file, status: "already-green", note: "passes when run on its own", attempts: 0 };

  const sources = importedSources(repoRoot, file, original);
  const sourceText = sources
    .map((s) => {
      try {
        return `--- ${s}\n${fs.readFileSync(path.join(repoRoot, s), "utf-8").slice(0, 60_000)}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
  const history = await gitHistory(repoRoot, [file, ...sources]);

  const seen = new Set<string>();
  let current = first;
  let attempts = 0;
  let last = original;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `TEST FILE ${file}\n${original}\n\nFAILURE (this file run on its own)\n${current.output.replace(ANSI, "").slice(-14_000)}\n\n` +
        `SOURCE IT IMPORTS\n${sourceText || "(none could be resolved)"}\n\nRECENT GIT HISTORY\n${history || "(none)"}`,
    },
  ];

  for (;;) {
    const key = failureKey(current.output);
    if (seen.has(key)) {
      fs.writeFileSync(abs, original);
      return { file, status: "unhealed", note: "the same failure came back, so the file was put back as it was", attempts };
    }
    seen.add(key);
    attempts++;

    let reply = "";
    try {
      reply = await opts.call(messages, `Heal ${file}`, true);
    } catch (err: any) {
      fs.writeFileSync(abs, original);
      return { file, status: "unhealed", note: `the model call failed: ${err?.message ?? err}`, attempts };
    }
    const parsed = parseLenient(reply)?.value;
    const verdict = String(parsed?.verdict ?? "");
    const reason = String(parsed?.reason ?? "").trim() || "no reason given";
    if (verdict === "code-bug") {
      fs.writeFileSync(abs, original);
      return { file, status: "code-bug", note: reason, attempts };
    }
    if (verdict !== "stale-test" || typeof parsed?.test !== "string" || !parsed.test.trim()) {
      fs.writeFileSync(abs, original);
      return { file, status: "unclear", note: reason, attempts };
    }
    const next = matchEol(original, parsed.test);
    const refusal = gutted(original, next);
    if (refusal) {
      messages.push({ role: "assistant", content: reply }, { role: "user", content: `Refused: ${refusal}. Try again.` });
      const k = `refused:${refusal}`;
      if (seen.has(k)) {
        fs.writeFileSync(abs, original);
        return { file, status: "unhealed", note: `kept proposing a rewrite that ${refusal}`, attempts };
      }
      seen.add(k);
      continue;
    }
    fs.writeFileSync(abs, next);
    last = next;
    current = await run(repoRoot, [file]);
    if (current.ok) return { file, status: "healed", note: reason, attempts };
    messages.push(
      { role: "assistant", content: reply },
      { role: "user", content: `That file still fails:\n${current.output.replace(ANSI, "").slice(-12_000)}\n\nReturn the corrected JSON again.` }
    );
    void last;
  }
}

export interface HealReport {
  before: SuiteRun;
  failing: string[];
  results: HealResult[];
  after?: SuiteRun;
}

/** The whole job: run, split by failing file, heal every file at once, run again. */
export async function healTests(opts: HealOptions): Promise<HealReport> {
  const log = opts.log ?? (() => {});
  const run = opts.run ?? runSuite;
  // Given specific files, only those are looked at and rerun: no full-suite runs around them.
  const scoped = Boolean(opts.files);
  if (!scoped) log("Running the full test suite once to see what is red…");
  const before: SuiteRun = scoped ? { ok: false, output: "" } : await run(opts.repoRoot, []);
  const failing = opts.files ?? failingTestFiles(before.output);
  if (before.ok && !scoped) return { before, failing: [], results: [] };
  if (failing.length === 0) return { before, failing, results: [] };
  log(`${failing.length} failing test file${failing.length === 1 ? "" : "s"}. One worker each, all at once.`);
  const results = await Promise.all(
    failing.map(async (f) => {
      const r = await healOne(opts, f);
      log(`  ${icon(r.status)} ${r.file}: ${r.note}`);
      return r;
    })
  );
  if (scoped) return { before, failing, results };
  log("Running the full suite again…");
  const after = await run(opts.repoRoot, []);
  return { before, failing, results, after };
}

const icon = (s: HealStatus) =>
  s === "healed" ? "✓" : s === "already-green" ? "·" : s === "code-bug" ? "🐞" : s === "unclear" ? "?" : "✗";

export function renderHealReport(r: HealReport): string {
  if (r.failing.length === 0 && r.before.ok) return "The test suite is already green. Nothing to heal.";
  if (r.failing.length === 0) return "The suite fails but no failing test file could be read from its output, so nothing was changed.";
  const by = (s: HealStatus) => r.results.filter((x) => x.status === s);
  const lines = [
    `Test healing: ${r.failing.length} red file(s) before. ${by("healed").length} healed, ${by("already-green").length} already passing alone, ${by("code-bug").length} look like code bugs, ${by("unclear").length + by("unhealed").length} left for a person.`,
  ];
  const bugs = by("code-bug");
  if (bugs.length) lines.push("", "Looks like the CODE is wrong (tests left untouched):", ...bugs.map((b) => `  - ${b.file}: ${b.note}`));
  const rest = [...by("unclear"), ...by("unhealed")];
  if (rest.length) lines.push("", "Not healed:", ...rest.map((b) => `  - ${b.file}: ${b.note}`));
  if (r.after) lines.push("", r.after.ok ? "Full suite after: green." : `Full suite after: still red in ${failingTestFiles(r.after.output).length} file(s).`);
  return lines.join("\n");
}
