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
import { isTestPath } from "./focusTests.js";
import { parseLenient } from "./jsonRepair.js";
import { runSuite, type SuiteRun } from "./testRun.js";
import { reachableFiles } from "./testGraph.js";

export { runSuite, type SuiteRun };

const execFileAsync = promisify(execFile);

export type HealStatus = "healed" | "already-green" | "code-bug" | "unclear" | "unhealed";

export interface HealResult {
  file: string;
  status: HealStatus;
  /** One line: what was wrong and what was done. */
  note: string;
  /** The last output of this file's failing run (set when it was not healed). */
  failure?: string;
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

/** Files a test names by path in a string (source-pinning tests read them with fs), that exist in the repo. */
export function referencedFiles(repoRoot: string, testRel: string, content: string): string[] {
  const out = new Set<string>();
  const dir = path.posix.dirname(testRel.replace(/\\/g, "/"));
  const re = /['"`]([\w@./-]+\.(?:tsx?|jsx?|mjs|json|py))['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    for (const cand of [m[1], path.posix.normalize(path.posix.join(dir, m[1]))]) {
      const rel = cand.replace(/^\.\//, "");
      if (rel.startsWith("..") || /(^|\/)(node_modules|\.git|\.agent)\//.test(rel) || rel === testRel) continue;
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
- "stale-test": the code's new behaviour is intended and the test still asserts the old one (renamed export, changed output, new argument, moved file, changed text). It ALSO covers a broken test ENVIRONMENT: a native module that needs a mock in Jest (AsyncStorage, expo modules, react-native internals), a missing jest.mock, a provider or wrapper the component now needs. Fix those inside the test file (jest.mock(...) at the top, a wrapper in render). A module that fails to load under Jest is NOT a code bug. Return the whole corrected test file.
- "code-bug": ONLY when the code's behaviour is wrong: the test asserts something sensible and the code now does something else that is a regression. Do NOT change the test. Say what is broken in the code and where.
- "need": you cannot decide without more files. Ask for them: {"need":["path/one","path/two"]}. Any file in the repo can be asked for, including components, config and setup files. Ask instead of guessing.
- "unclear": only after you have asked for what you need and it still does not settle it.
Rules for a stale test: keep every case that is still meaningful, update expected values and calls to match the code you were shown, never delete assertions or skip tests to make it pass, never loosen an assertion into one that cannot fail. Mock only what the test already mocked.
Answer with JSON only: {"verdict":"stale-test|code-bug|unclear","reason":"one sentence","test":"the complete new test file (stale-test only)"} or {"need":[...]}.`;

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
  const trace = { output: "" };
  const r = await healOneInner(opts, file, trace);
  if (r.status !== "healed" && r.status !== "already-green") r.failure = trace.output;
  return r;
}

async function healOneInner(opts: HealOptions, file: string, trace: { output: string }): Promise<HealResult> {
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
  trace.output = first.output;
  if (first.ok) return { file, status: "already-green", note: "passes when run on its own", attempts: 0 };
  if (/must contain at least one test/i.test(first.output)) {
    return {
      file,
      status: "unclear",
      note: "this is a shared helper that sits where Jest looks for tests but has no tests in it. Add it to testPathIgnorePatterns in the Jest config, or move it out of the tests folder",
      attempts: 0,
    };
  }

  const sources = [...new Set([...importedSources(repoRoot, file, original), ...referencedFiles(repoRoot, file, original)])];
  const provided = new Set<string>([file, ...sources]);
  let others: string[] = [];
  try {
    others = reachableFiles(repoRoot, file).filter((f) => !provided.has(f) && !/(^|\/)node_modules\//.test(f));
  } catch {}
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
        `SOURCE IT IMPORTS OR NAMES\n${sourceText || "(none could be resolved)"}\n\n` +
        `OTHER FILES IT REACHES (ask for any you need)\n${others.length ? others.join("\n") : "(none)"}\n\nRECENT GIT HISTORY\n${history || "(none)"}`,
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
    let parsed: any;
    for (let dry = 0, malformed = 0; ; ) {
      try {
        reply = await opts.call(messages, `Heal ${file}`, true);
      } catch (err: any) {
        fs.writeFileSync(abs, original);
        return { file, status: "unhealed", note: `the model call failed: ${err?.message ?? err}`, attempts };
      }
      parsed = parseLenient(reply)?.value;
      if (!Array.isArray(parsed?.need)) {
        if (typeof parsed?.verdict === "string" && parsed.verdict) break;
        // Not the JSON asked for (empty, cut off, or prose): say so and ask again instead of giving up on the file.
        malformed++;
        if (malformed >= 3) {
          parsed = { verdict: "unclear", reason: `the model did not return usable JSON (it said: ${reply.replace(/\s+/g, " ").slice(0, 160) || "nothing"})` };
          break;
        }
        messages.push(
          { role: "assistant", content: reply || "(empty)" },
          { role: "user", content: 'That was not the JSON object asked for. Reply with ONLY {"verdict":...,"reason":...,"test":...} or {"need":[...]}.' }
        );
        continue;
      }
      messages.push({ role: "assistant", content: reply });
      const fresh = (parsed.need as unknown[])
        .map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((p) => !provided.has(p) && !p.startsWith("..") && !/(^|\/)(\.git|\.agent)\//.test(p) && fs.existsSync(path.join(repoRoot, p)) && fs.statSync(path.join(repoRoot, p)).isFile());
      if (fresh.length === 0) {
        dry++;
        if (dry >= 2) {
          parsed = { verdict: "unclear", reason: "it needed files that are not available" };
          break;
        }
        messages.push({ role: "user", content: "Those files are already provided or do not exist. Decide with what you have." });
        continue;
      }
      for (const p of fresh) provided.add(p);
      messages.push({
        role: "user",
        content: fresh.map((p) => `--- ${p}\n${fs.readFileSync(path.join(repoRoot, p), "utf-8").slice(0, 60_000)}`).join("\n\n"),
      });
    }
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
    trace.output = current.output;
    if (current.ok) return { file, status: "healed", note: reason, attempts };
    messages.push(
      { role: "assistant", content: reply },
      { role: "user", content: `That file still fails:\n${current.output.replace(ANSI, "").slice(-12_000)}\n\nReturn the corrected JSON again.` }
    );
    void last;
  }
}

// ------------------------------------------------------------ shared causes

/** The first error-looking line of a failure, with the details that differ between files taken out. */
export function failureSignature(output: string): string {
  const line = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /(Error|Cannot find|is null|is undefined|not a function|Invariant|NativeModule|Unable to resolve)/.test(l));
  return (line ?? "").replace(/\d+/g, "#").replace(/(['"`])[^'"`]{40,}\1/g, "$1…$1").slice(0, 140);
}

const SETUP_NAME = /^(jest|vitest)[.-]setup\.[\w]+$/i;

/** Config files a shared fix may touch: jest config, the setup files it lists, package.json (its jest key only). */
function configFiles(repoRoot: string): string[] {
  const out = new Set<string>();
  for (const f of fs.readdirSync(repoRoot)) {
    if (/^(jest|vitest)\.config\.[\w]+$/.test(f) || SETUP_NAME.test(f) || /^setupTests?\.[\w]+$/.test(f)) out.add(f);
  }
  if (fs.existsSync(path.join(repoRoot, "package.json"))) out.add("package.json");
  const text = [...out].map((f) => {
    try {
      return fs.readFileSync(path.join(repoRoot, f), "utf-8");
    } catch {
      return "";
    }
  }).join("\n");
  for (const m of text.matchAll(/<rootDir>\/([^'"`\s,\]]+)/g)) {
    const rel = m[1].replace(/\\/g, "/");
    if (fs.existsSync(path.join(repoRoot, rel))) out.add(rel);
  }
  return [...out];
}

const ROOT_SYSTEM = `Several test files fail with the same error. That usually means ONE shared cause in the test setup, not many separate test problems: a native module with no Jest mock (AsyncStorage, expo modules), a missing global, a missing transform or preset entry.
You may change only the Jest/test-setup files you are shown (and create a root-level jest.setup.js if none exists, registering it under "jest" in package.json). Do not change application code and do not change any test. Add the smallest fix that makes the shared error go away, for example a jest.mock(...) of the native module in the setup file.
If this is not a setup problem (the application code is really wrong), return no edits.
Answer with JSON only: {"cause":"one sentence","edits":[{"file":"path","content":"the complete new content of that file"}]}`;

/** package.json may change only under its "jest" key. */
function onlyJestKeyChanged(before: string, after: string): boolean {
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    delete a.jest;
    delete b.jest;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Failures with the same error across several files get ONE worker that looks at the test setup. If its edit makes at
 * least one of those files pass it is kept; otherwise every file it touched is put back.
 */
async function sharedCauses(opts: HealOptions, results: HealResult[], log: (l: string) => void): Promise<void> {
  const { repoRoot } = opts;
  const run = opts.run ?? runSuite;
  const open = results.filter((r) => (r.status === "code-bug" || r.status === "unclear" || r.status === "unhealed") && r.failure);
  const groups = new Map<string, HealResult[]>();
  for (const r of open) {
    const sig = failureSignature(r.failure!);
    if (!sig) continue;
    groups.set(sig, [...(groups.get(sig) ?? []), r]);
  }
  const shared = [...groups.entries()].filter(([, g]) => g.length >= 2);
  if (shared.length === 0) return;
  const editable = new Set(configFiles(repoRoot));

  // Groups touch the same few setup files, so they take turns; each one is still all of its files in parallel.
  for (const [sig, group] of shared) {
    log(`${group.length} files fail the same way (${sig}). Looking at the shared test setup…`);
    const shown = [...editable]
      .map((f) => {
        try {
          return `--- ${f}\n${fs.readFileSync(path.join(repoRoot, f), "utf-8").slice(0, 30_000)}`;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");
    let reply = "";
    try {
      reply = await opts.call(
        [
          { role: "system", content: ROOT_SYSTEM },
          {
            role: "user",
            content:
              `SAME ERROR IN ${group.length} FILES: ${group.map((g) => g.file).join(", ")}\n\nONE FAILURE\n${group[0].failure!.replace(ANSI, "").slice(-8000)}\n\n` +
              `SETUP FILES YOU MAY CHANGE\n${shown || "(none exist; you may create jest.setup.js)"}`,
          },
        ],
        `Shared test setup: ${sig.slice(0, 60)}`,
        true
      );
    } catch {
      continue;
    }
    const parsed = parseLenient(reply)?.value;
    const edits: { file: string; content: string }[] = Array.isArray(parsed?.edits)
      ? parsed.edits.filter((e: any) => typeof e?.file === "string" && typeof e?.content === "string")
      : [];
    if (edits.length === 0) continue;
    const backups = new Map<string, string | undefined>();
    let ok = true;
    for (const e of edits) {
      const rel = e.file.replace(/\\/g, "/").replace(/^\.\//, "");
      const creating = !fs.existsSync(path.join(repoRoot, rel));
      if (!(editable.has(rel) || (creating && SETUP_NAME.test(rel)))) ok = false;
      if (rel === "package.json" && !onlyJestKeyChanged(fs.readFileSync(path.join(repoRoot, rel), "utf-8"), e.content)) ok = false;
      if (!ok) break;
      backups.set(rel, creating ? undefined : fs.readFileSync(path.join(repoRoot, rel), "utf-8"));
    }
    if (!ok) {
      log("  The proposed setup change touched something it may not, so it was dropped.");
      continue;
    }
    for (const e of edits) {
      const rel = e.file.replace(/\\/g, "/").replace(/^\.\//, "");
      const old = backups.get(rel);
      fs.writeFileSync(path.join(repoRoot, rel), old && old.includes("\r\n") ? e.content.replace(/\r?\n/g, "\r\n") : e.content);
    }
    const reran = await Promise.all(group.map(async (g) => ({ g, r: await run(repoRoot, [g.file]) })));
    const fixed = reran.filter((x) => x.r.ok);
    if (fixed.length === 0) {
      for (const [rel, old] of backups) {
        if (old === undefined) fs.rmSync(path.join(repoRoot, rel), { force: true });
        else fs.writeFileSync(path.join(repoRoot, rel), old);
      }
      log("  That did not make any of them pass, so the setup was put back.");
      continue;
    }
    const cause = String(parsed?.cause ?? "shared test setup").trim();
    for (const x of fixed) {
      x.g.status = "healed";
      x.g.note = `shared fix in ${[...backups.keys()].join(", ")}: ${cause}`;
      x.g.failure = undefined;
    }
    for (const x of reran.filter((y) => !y.r.ok)) x.g.failure = x.r.output;
    log(`  ✓ ${fixed.length} of ${group.length} fixed by changing ${[...backups.keys()].join(", ")}: ${cause}`);
    for (const rel of backups.keys()) editable.add(rel);
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
  await sharedCauses(opts, results, log);
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
