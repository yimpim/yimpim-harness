/**
 * The heal sandbox: a disposable copy of the project, exactly as it is now, in which a stronger model may change ANYTHING to find out why a
 * test fails (add logging to app code, change a wait, run one test), the way a person does at their own terminal. Only the test file ever
 * comes back to the real project, and only through the per-test ratchet (see healSandbox merge in testHeal.ts).
 *
 * This file is the LIFECYCLE half: make the copy, prove it reproduces the failure, remove it without touching the real project. The
 * dangerous part is removal: the copy shares the real `node_modules` through a link, and deleting recursively THROUGH that link would delete
 * the real folder. Every link is removed first, on its own, and nothing is ever deleted recursively until none is left.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { SAFE, type RunTests } from "./healEdits.js";
import { failingNames } from "./healAuthority.js";
import { OpenRouterClient, type FunctionTool } from "./openrouter.js";
import type { AgentConfig } from "./config.js";
import { AgentTools, TOOLS_SCHEMA, RUN_TEST_TOOL } from "./agentTools.js";
import { runToolAgent } from "./agentLoop.js";
import { createRepoTools } from "./repoTools.js";
import { events } from "./events.js";
import { AbortedError } from "./remote/control.js";
import { makeCommandReviewer, type ReviewCall } from "./commandReview.js";
import { createRunTestSession, changedFiles } from "./sandboxRunTest.js";

export interface Sandbox {
  /** Absolute path of the worktree root. */
  root: string;
  /** Repo-relative path of the test file (posix). */
  file: string;
  /** Text of the test file as written into the sandbox (the heal's current `last`). */
  startText: string;
  /** The commit the worktree was made from: a `git stash create` snapshot of the working tree, or HEAD. */
  base: string;
  /** Top-level directories shared with the real project through a link (removed before anything else is deleted). */
  links: string[];
}

export type SandboxCreate = { ok: true; sandbox: Sandbox } | { ok: false; reason: string };

/** Directories shared with the real project instead of copied: far too big to copy, and read-only as far as the heal is concerned. */
const SHARED_DIRS = ["node_modules", ".venv"];
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const BASE_DIR = () => path.join(os.tmpdir(), "yimpim-heal");

/** Sandboxes this process is using right now: pruning must never remove one of them. */
const active = new Set<string>();

const hash8 = (s: string) => crypto.createHash("sha1").update(path.resolve(s).toLowerCase()).digest("hex").slice(0, 8);
/** A path in one canonical spelling (real path, lower case): two spellings of one folder compare equal. */
const realLower = (p: string) => {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
};
/** Where sandboxes live, and the name prefix of this project's: exposed so tests (and a prune of a killed run) can find them. */
export const sandboxBase = (): string => BASE_DIR();
export const sandboxPrefix = (repoRoot: string): string => `${hash8(repoRoot)}-`;
const posix = (p: string) => p.replace(/\\/g, "/");

/** git, started directly (no shell): nothing the model or the project's file names contain can be interpreted as a command. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export async function createSandbox(opts: {
  repoRoot: string;
  file: string;
  testText: string;
  expectFailing: string[];
  run: RunTests;
  log?: (line: string) => void;
}): Promise<SandboxCreate> {
  const { repoRoot, testText, expectFailing, run, log } = opts;
  const file = posix(opts.file).replace(/^\.\//, "");
  if (!file || !SAFE(file)) return { ok: false, reason: `the test file path is not inside the project: ${opts.file}` };

  let base: string;
  try {
    // The sandbox is made from the project, so the project must be at the top of its git repository (the paths git reports are relative to it).
    const top = git(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
    if (realLower(top) !== realLower(repoRoot)) {
      return { ok: false, reason: "the project is not at the top of its git repository, so a sandbox copy cannot be made" };
    }
    // A commit holding the working tree's tracked changes, made WITHOUT touching the working tree, the index or the stash list. Empty when nothing changed.
    const snap = git(repoRoot, ["stash", "create"]).trim();
    base = snap || git(repoRoot, ["rev-parse", "HEAD"]).trim();
  } catch (e: any) {
    return { ok: false, reason: `could not snapshot the project: ${firstLine(e)}` };
  }

  const root = path.join(BASE_DIR(), `${hash8(repoRoot)}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(BASE_DIR(), { recursive: true });
    git(repoRoot, ["worktree", "add", "--detach", root, base]);
  } catch (e: any) {
    removeSandboxDir(root, repoRoot);
    return { ok: false, reason: `git worktree add failed: ${firstLine(e)}` };
  }
  active.add(root);
  const sandbox: Sandbox = { root, file, startText: testText, base, links: [] };

  try {
    // Files git does not track but the tests may need: helpers or mocks the first model created, app files the user has not committed.
    let copied = 0;
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const rel of untracked.map(posix)) {
      if (!SAFE(rel)) continue;
      const from = path.join(repoRoot, rel);
      try {
        const st = fs.lstatSync(from);
        if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
        const to = path.join(root, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        copied++;
      } catch {
        // a file that vanished or cannot be read is simply not copied; the preflight below says whether that mattered
      }
    }

    // The test file as the heal has it now (it can be newer than the snapshot), byte for byte so its line endings survive.
    const testAbs = path.join(root, file);
    fs.mkdirSync(path.dirname(testAbs), { recursive: true });
    fs.writeFileSync(testAbs, testText);

    // Dependencies are shared, not copied.
    for (const dir of SHARED_DIRS) {
      const real = path.join(repoRoot, dir);
      const link = path.join(root, dir);
      if (!fs.existsSync(real) || fs.existsSync(link)) continue;
      fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      sandbox.links.push(dir);
    }
    log?.(`sandbox ready at ${root} (base ${base.slice(0, 8)}, ${copied} untracked file${copied === 1 ? "" : "s"} copied)`);

    // The guard against every environment problem: a missing file, a link the test runner will not follow, a path-sensitive config.
    // An agent must never work in a copy that does not reproduce the failure it was asked to explain.
    const r = await run(root, [file]);
    const got = failingNames(r.output);
    const want = new Set(expectFailing);
    const same = got.length === want.size && got.every((n) => want.has(n));
    if (!same) {
      const reason = `the sandbox does not reproduce the failure: expected ${want.size} failing (${[...want].slice(0, 3).join(" | ") || "none"}), got ${got.length} (${got.slice(0, 3).join(" | ") || "none"})`;
      log?.(reason);
      destroySandbox(sandbox, repoRoot);
      return { ok: false, reason };
    }
    return { ok: true, sandbox };
  } catch (e: any) {
    destroySandbox(sandbox, repoRoot);
    return { ok: false, reason: `could not prepare the sandbox: ${firstLine(e)}` };
  }
}

/** Idempotent, and never throws: it runs in `finally` blocks. */
export function destroySandbox(s: Sandbox, repoRoot: string): void {
  try {
    removeSandboxDir(s.root, repoRoot);
  } catch {
    // nothing more can be done; a later prune retries
  } finally {
    active.delete(s.root);
  }
}

/**
 * Remove a sandbox directory. ORDER MATTERS: every link goes first, each on its own and never recursively, because a recursive delete
 * that follows a link into the real `node_modules` would delete the real project's dependencies.
 */
function removeSandboxDir(root: string, repoRoot: string): void {
  if (!fs.existsSync(root) && !isListed(repoRoot, root)) return;
  unlinkLinks(root);
  gitRemove(repoRoot, root);
  if (fs.existsSync(root)) {
    // Files can be held for a moment (a test runner that is still shutting down, on Windows): once more, then by hand.
    sleep(500);
    unlinkLinks(root);
    gitRemove(repoRoot, root);
  }
  if (fs.existsSync(root)) {
    unlinkLinks(root);
    if (!anyLinkLeft(root)) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // left for the next prune
      }
    }
  }
  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch {
    // not a git repository any more, or git is busy: nothing to prune
  }
}

function gitRemove(repoRoot: string, root: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", root]);
  } catch {
    // reported by the existence check that follows
  }
}

function isListed(repoRoot: string, root: string): boolean {
  try {
    return listWorktrees(repoRoot).some((w) => samePath(w, root));
  } catch {
    return false;
  }
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Remove every symbolic link or junction anywhere under `dir`, the link itself and never what it points at. */
function unlinkLinks(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      removeOneLink(p);
    } else if (st.isDirectory()) {
      unlinkLinks(p);
    }
  }
}

function removeOneLink(p: string): void {
  try {
    fs.unlinkSync(p); // a symlink, and a junction, are removed as links: the target is untouched
  } catch {
    try {
      fs.rmdirSync(p); // a junction on some Windows builds: rmdir removes the reparse point, not its contents
    } catch {
      // still there: anyLinkLeft stops the recursive delete
    }
  }
}

function anyLinkLeft(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return true;
      if (st.isDirectory() && anyLinkLeft(p)) return true;
    } catch {
      // gone while looking: fine
    }
  }
  return false;
}

function listWorktrees(repoRoot: string): string[] {
  return git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

/**
 * Remove what a killed run left behind. Called at the start of every heal. Only this project's sandboxes are touched (the directory
 * name carries a hash of the project path), and never one this process is using.
 */
export function pruneStaleSandboxes(repoRoot: string): number {
  const mine = `${hash8(repoRoot)}-`;
  const base = BASE_DIR();
  const found = new Set<string>();
  try {
    for (const w of listWorktrees(repoRoot)) {
      if (samePath(path.dirname(w), base) && path.basename(w).startsWith(mine)) found.add(path.resolve(w));
    }
  } catch {
    // not a git repository: only orphan directories can be found
  }
  try {
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith(mine)) found.add(path.resolve(base, name));
    }
  } catch {
    // nothing has ever been made here
  }
  let removed = 0;
  for (const root of found) {
    if ([...active].some((a) => samePath(a, root))) continue;
    try {
      removeSandboxDir(root, repoRoot);
      if (!fs.existsSync(root)) removed++;
    } catch {
      // left for the next time
    }
  }
  return removed;
}

function firstLine(e: any): string {
  const text = String(e?.stderr || e?.message || e).trim();
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300) ?? "unknown error";
}

// ====================================================================================================================================
// The AGENT half: one parked cause worked by the stronger model in a native tool loop, inside the sandbox.
// ====================================================================================================================================

export interface SandboxCause {
  message: string;
  count: number;
  /** The failing test names of this cause. */
  tests: string[];
  /** What the first model said about it (it may be wrong). */
  reason: string;
  kind: "unsure" | "code";
}

export interface SandboxResult {
  /** The sandbox's test file, when it differs from what it started with (console.log lines the agent added are stripped). */
  candidate?: string;
  /** Repo-relative non-test files changed in the sandbox: logging for an experiment, or the evidence for a code bug. Never copied back. */
  appFilesTouched: string[];
  conclusion: string;
  stop: "concluded" | "code-bug" | "budget" | "stagnation" | "error" | "preflight";
  rounds: number;
  /** Dollars spent on this cause (0 when the provider reports no cost). */
  cost: number;
  /** run_test calls that ran. */
  runs: number;
}

export type SandboxRun = (args: {
  repoRoot: string;
  file: string;
  testText: string;
  /** The runner's output for the file as it is now: what the sandbox must reproduce. */
  failureOutput: string;
  /** failureText(...) from testHeal: the same digest the first model saw. Passed in (not computed here) so this module does not import testHeal. */
  failureDigest: string;
  cause: SandboxCause;
  ledger: string[];
  firstModelNotes: string;
}) => Promise<SandboxResult>;

// ------------------------------------------------------------------------------------------------------------------------ the tools

/** What the sandbox agent may call. Not offered: running a command, installing, asking a person, staging a deletion, registering things. */
export const SANDBOX_TOOL_NAMES = ["read_file", "search_code", "get_file_outline", "list_files", "patch_file", "write_file", "conclude_task"] as const;
export const SANDBOX_TOOLS_SCHEMA: FunctionTool[] = [
  ...TOOLS_SCHEMA.filter((t) => (SANDBOX_TOOL_NAMES as readonly string[]).includes(t.function.name)),
  RUN_TEST_TOOL,
] as unknown as FunctionTool[];

// ------------------------------------------------------------------------------------------------------------------------ progress, judged by state

const EDIT_TOOLS = new Set(["patch_file", "write_file"]);
const READ_TOOLS = new Set(["read_file", "search_code", "get_file_outline", "list_files"]);

/**
 * When to stop an agent that is not making progress, judged by what it has done and what it has learned, never by a count of rounds:
 *  1. the same test result N times in a row with no change made in between;
 *  2. N rounds of edits with no test run (editing blind);
 *  3. 2N rounds of only reading (reading is allowed; reading forever is not).
 * A test run whose result is new (and an edit that is followed by a run) is progress and resets the others. A refused run is a round of nothing.
 */
export class StagnationTracker {
  /** Rounds that have fully ended. */
  rounds = 0;
  /** run_test calls that ran. */
  runs = 0;
  private started = false;
  private lastFp: string | undefined;
  private identical = 0;
  private editSinceRun = false;
  private editRounds = 0;
  private readRounds = 0;
  private cur = { edit: false, run: false, read: false, refused: false };

  constructor(private readonly n: number) {}

  onTool(name: string): void {
    if (EDIT_TOOLS.has(name)) {
      this.cur.edit = true;
      this.editSinceRun = true;
    } else if (READ_TOOLS.has(name)) {
      this.cur.read = true;
    }
  }

  /** A test run that ran, with the fingerprint of what it printed. */
  onRun(fp: string): void {
    this.runs++;
    this.cur.run = true;
    this.identical = fp === this.lastFp && !this.editSinceRun ? this.identical + 1 : 1;
    this.lastFp = fp;
    this.editSinceRun = false;
  }

  /** A run_test the gate refused. */
  onRefused(): void {
    this.cur.refused = true;
  }

  /** Called at the top of every round: closes the one before and says whether to stop. */
  check(): string | undefined {
    if (this.started) this.rounds++;
    this.started = true;
    const c = this.cur;
    this.cur = { edit: false, run: false, read: false, refused: false };
    if (c.run) {
      this.editRounds = 0;
      this.readRounds = 0;
    } else if (c.edit) {
      this.editRounds++;
      this.readRounds = 0;
    } else if (c.read || c.refused) {
      this.readRounds++;
    }
    if (this.identical >= this.n) return `stagnation: ${this.identical} test runs in a row gave the same result with no change in between`;
    if (this.editRounds >= this.n) return `stagnation: ${this.editRounds} rounds of edits without running a test`;
    if (this.readRounds >= this.n * 2) return `stagnation: ${this.readRounds} rounds of reading without running an experiment`;
    return undefined;
  }
}

/** A test result reduced to what matters, so two runs that print the same failures at different speeds count as the same. */
export function fingerprintOf(output: string, root: string): string {
  const names = failingNames(output).sort().join("|");
  const rootPosix = root.replace(/\\/g, "/");
  const norm = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\\/g, "/")
    .split(rootPosix)
    .join("<root>")
    .replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, "<t>")
    .replace(/^\s*Time:.*$/gm, "");
  return crypto.createHash("sha1").update(`${names}\n${norm}`).digest("hex");
}

// ------------------------------------------------------------------------------------------------------------------------ the prompt

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);

/** Short on purpose: the agent reads the files it needs with read_file instead of being handed 170k characters of them. */
export function buildSandboxPrompt(a: { file: string; lineCount: number; cause: SandboxCause; ledger: string[]; firstModelNotes: string; failureDigest: string }): string {
  const tests = a.cause.tests.slice(0, 30).map((t) => `    - ${t}`).join("\n") + (a.cause.tests.length > 30 ? `\n    … and ${a.cause.tests.length - 30} more` : "");
  const ledger = a.ledger.length > 0 ? a.ledger.slice(0, 20).join("\n") + (a.ledger.length > 20 ? `\n  … and ${a.ledger.length - 20} more fixed causes` : "") : "  (every test not listed above)";
  return [
    "You are fixing ONE cause of failing tests in a JavaScript/TypeScript project, in a disposable SANDBOX copy of the project.",
    "",
    "THE CAUSE",
    `  [${a.cause.count}×] ${a.cause.message}`,
    "  Failing tests:",
    tests,
    `  What the first model said about it (it may be wrong): ${cut(a.cause.reason, 600)}`,
    "",
    "WHAT ALREADY PASSES AND MUST KEEP PASSING",
    ledger,
    ...(a.firstModelNotes ? ["", "WHAT THE FIRST MODEL CHANGED", cut(a.firstModelNotes, 1000)] : []),
    "",
    `THE TEST FILE: ${a.file} (${a.lineCount} lines). Read it with read_file using line ranges. Search with search_code.`,
    "",
    "THE FAILURE NOW (this file run on its own)",
    cut(a.failureDigest, 3000),
    "",
    "HOW TO WORK",
    "- Reading code cannot show timing (debounces, effects that run later), what an event carries, or what a mock returns. MEASURE: add console.log",
    "  anywhere (the test or the app code), change a wait, then run_test with a namePattern for one test, and read the output. Repeat. This is a",
    "  sandbox: experiments cost nothing and are thrown away.",
    "- Only the TEST FILE comes back to the real project, and only if it makes more tests pass without breaking any that pass now. Changes to app",
    "  code are thrown away (they are fine for logging). Remove your console.log lines from the test file before you finish.",
    "- Fix the TEST when it is out of date. The app's code, its doc comments, the written spec (docs/ or *.md) and recent commits are the authority,",
    "  in about that order of strength. If the APP is what is wrong, do not bend the test: conclude and say exactly where (file:line) and what shows it.",
    "- Never delete tests or assertions, never skip tests, never loosen an assertion into one that cannot fail.",
    "- When the cause's tests pass (run them), or when you are sure the app is at fault, call conclude_task: FINISHED_PATCHING with what you changed",
    '  and why; or CANNOT_LOCATE with what you found and what is still unknown, starting with "APP BUG:" when the app is wrong.',
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------------------------------ outcome

/** What the agent's last word means, from the string `runToolAgent` returned or the error it threw. */
export function interpretOutcome(returned: string | undefined, error?: Error): { stop: SandboxResult["stop"]; conclusion: string } {
  if (error) {
    const m = /^ESCALATION_NEEDED:\s*([\s\S]*)$/.exec(error.message);
    if (m) {
      const text = m[1].trim();
      return { stop: /^APP BUG\b/i.test(text) ? "code-bug" : "concluded", conclusion: text.slice(0, 1500) };
    }
    return { stop: "error", conclusion: error.message.slice(0, 1500) };
  }
  const text = String(returned ?? "").trim();
  const stopped = /^STOPPED:\s*([\s\S]*)$/.exec(text);
  if (stopped) return { stop: /^budget/i.test(stopped[1]) ? "budget" : "stagnation", conclusion: stopped[1].trim().slice(0, 1500) };
  const done = /^(?:TASK_CONCLUDED|TASK_ALREADY_SATISFIED):\s*([\s\S]*)$/.exec(text);
  const body = (done ? done[1] : text).trim();
  // an agent that finished by describing a bug in the app, without the formal exit, still means a code bug
  return { stop: /^APP BUG\b/i.test(body) ? "code-bug" : "concluded", conclusion: body.slice(0, 1500) };
}

/** Removes the single-line console.log/debug statements the agent added (compared with what the file started as): the safety net for a forgotten probe. */
export function stripAddedLogs(startText: string, text: string): string {
  const had = new Map<string, number>();
  for (const l of startText.split(/\r?\n/)) had.set(l, (had.get(l) ?? 0) + 1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    const left = had.get(l) ?? 0;
    if (left > 0) {
      had.set(l, left - 1);
      out.push(l);
    } else if (/^\s*console\.(?:log|debug)\(.*\);?\s*$/.test(l)) {
      continue;
    } else {
      out.push(l);
    }
  }
  return out.join(eol);
}

// ------------------------------------------------------------------------------------------------------------------------ the run

export function createSandboxRun(deps: {
  client: OpenRouterClient;
  config: AgentConfig;
  /** The stronger models: every repair model after the first. */
  models: string[];
  /** Dollars per cause. 0 = no dollar stop (the stagnation rules still apply). */
  budgetUsd: number;
  stagnation: number;
  /** The heal's own runner. */
  run: RunTests;
  /** The security model, for code the gate flags. */
  securityCall: ReviewCall;
  log?: (line: string) => void;
}): SandboxRun {
  const reviewer = makeCommandReviewer(deps.securityCall);
  return async (a) => {
    const log = deps.log ?? (() => {});
    const empty = (stop: SandboxResult["stop"], conclusion: string): SandboxResult => ({ appFilesTouched: [], conclusion, stop, rounds: 0, cost: 0, runs: 0 });
    let created: SandboxCreate;
    try {
      created = await createSandbox({ repoRoot: a.repoRoot, file: a.file, testText: a.testText, expectFailing: failingNames(a.failureOutput), run: deps.run, log });
    } catch (e: any) {
      return empty("preflight", `could not make a sandbox: ${String(e?.message ?? e).slice(0, 300)}`);
    }
    if (!created.ok) return empty("preflight", created.reason);
    const sandbox = created.sandbox;
    const tracker = new StagnationTracker(Math.max(1, deps.stagnation));
    const startUsage = events.usageReport();
    let costWarned = false;
    try {
      const session = createRunTestSession({ root: sandbox.root, base: sandbox.base, gate: { review: reviewer }, fallbackRun: deps.run });
      const tools = new AgentTools(sandbox.root, deps.config, async (_q, fallback) => fallback); // never waits on a person
      tools.beginPhase([], 1_000_000, "heal sandbox"); // the per-phase file cap is for a phase that must stay small: a sandbox is thrown away
      tools.bindSandboxRunTest(async (args) => {
        const r = await session.run(args);
        if (r.refused) tracker.onRefused();
        else tracker.onRun(fingerprintOf(r.output, sandbox.root));
        return r.text;
      });

      const stopWhen = (): string | undefined => {
        const spent = events.usageDelta(startUsage).totals;
        if (deps.budgetUsd > 0) {
          if (spent.costKnown && spent.cost >= deps.budgetUsd) return `budget: $${spent.cost.toFixed(2)} of $${deps.budgetUsd.toFixed(2)} spent on this cause`;
          if (!spent.costKnown && !costWarned) {
            costWarned = true;
            log("sandbox: the provider reports no cost, so only the stagnation rules can stop this run");
          }
        }
        return tracker.check();
      };

      let returned: string | undefined;
      let error: Error | undefined;
      try {
        returned = await runToolAgent({
          prompt: buildSandboxPrompt({ file: a.file, lineCount: a.testText.split(/\r?\n/).length, cause: a.cause, ledger: a.ledger, firstModelNotes: a.firstModelNotes, failureDigest: a.failureDigest }),
          repo: createRepoTools(sandbox.root, deps.config),
          repoRoot: sandbox.root,
          client: deps.client,
          config: deps.config,
          agentTools: tools,
          models: deps.models,
          agentName: "HEAL_SANDBOX",
          tools: SANDBOX_TOOLS_SCHEMA,
          maxRoundsOverride: Number.MAX_SAFE_INTEGER, // budget and stagnation decide, not a round count
          stopWhen,
          onToolCall: (name) => tracker.onTool(name),
          reason: `heal sandbox: ${a.cause.message.slice(0, 60)}`,
        });
      } catch (e: any) {
        if (e instanceof AbortedError) throw e; // a user Stop is not the sandbox's to swallow
        error = e instanceof Error ? e : new Error(String(e));
      }
      const outcome = interpretOutcome(returned, error);

      // What came out: the test file (minus forgotten logging) and the names of the app files that were touched.
      let candidate: string | undefined;
      try {
        const text = stripAddedLogs(sandbox.startText, fs.readFileSync(path.join(sandbox.root, sandbox.file), "utf8"));
        if (text !== sandbox.startText) candidate = text;
      } catch {
        // the file is gone: nothing comes back
      }
      const touched = changedFiles(sandbox.root).filter((f) => f !== sandbox.file);
      const spent = events.usageDelta(startUsage).totals;
      return { candidate, appFilesTouched: touched, conclusion: outcome.conclusion, stop: outcome.stop, rounds: tracker.rounds, cost: spent.costKnown ? spent.cost : 0, runs: tracker.runs };
    } finally {
      destroySandbox(sandbox, a.repoRoot);
    }
  };
}
