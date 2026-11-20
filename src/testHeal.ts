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
import { runSuite, failingTestFiles, type SuiteRun } from "./testRun.js";
import { runSuiteLogged, unchangedGreen, verdictFor, saveVerdict, recordHealOutcome } from "./testLog.js";
import { verifyCites, citeProblem, madeWorse, testsFailing, testsPassing, regressions, failingNames } from "./healAuthority.js";
import { beginTrial, endTrial, recoverTrial } from "./healCheckpoint.js";
import { listTestFiles } from "./focusTests.js";
import { reachableFiles } from "./testGraph.js";
import { digestFailure } from "./failureDigest.js";
import { evidenceText } from "./failureEvidence.js";
import { applyEditsLenient, parseEdits, presentLargeFile, readRange, searchRepo, runProbe, LARGE_FILE_LINES } from "./healEdits.js";
import { removeTest, renderRemoval, recordRemoved } from "./testSettle.js";

export { runSuite, failingTestFiles, type SuiteRun };

const execFileAsync = promisify(execFile);

export type HealStatus = "healed" | "already-green" | "code-bug" | "app-deviation" | "unclear" | "unhealed" | "rewritten" | "removed";

export interface HealResult {
  file: string;
  status: HealStatus;
  /** One line: what was wrong and what was done. */
  note: string;
  /** The last output of this file's failing run (set when it was not healed). */
  failure?: string;
  attempts: number;
  /**
   * Set when the test-side causes were fixed and what still fails is the CODE: the file keeps those fixes, and `failure` is what is left,
   * which is what a fix task is for. Without it a file that is part stale test and part real bug could be neither healed nor handed on.
   */
  partial?: boolean;
  /**
   * Places where the APP contradicts the written spec that the test follows. Nothing is changed for these and nothing is sent to a fix task:
   * whether the spec or the app is right is a decision for a person, and a Planner asked to "fix" it would rewrite product code.
   */
  deviations?: string[];
}

export type HealCall = (messages: { role: "system" | "user" | "assistant"; content: string }[], label: string, json: boolean) => Promise<string>;

export interface HealOptions {
  repoRoot: string;
  call: HealCall;
  log?: (line: string) => void;
  /** Heal only these test files; default is every failing file in the full run. */
  files?: string[];
  /** Decide every file that could not be healed (rewrite it from scratch, or remove it). Default: on, except when `files` is given. */
  settle?: boolean;
  /** Look at every test, ignoring what the test log says is unchanged since its last green run, and ignore stored diagnoses. */
  all?: boolean;
  /** Replaces the real test runner (tests). */
  run?: (repoRoot: string, files: string[]) => Promise<SuiteRun>;
  /**
   * An answer that edits the test (or says the app deviates from its spec) must cite an authority outside the test, and every citation must
   * exist (healAuthority.ts). On for real runs; off by default so a caller that does not ask for it behaves as before.
   */
  requireCites?: boolean;
  /**
   * The stronger model's call. Causes the first model could not settle (it PARKED them) go to it, in a fresh conversation that says what is already fixed.
   * Unset: parked causes are reported as they are.
   */
  escalate?: HealCall;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

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

/** A lookup result that carries nothing: a search that matched nothing or could not run. */
const NO_RESULT = /\n\((no matches|search text too short|the search could not run|the probe printed nothing[^)]*|probe refused[^)]*|probe found no line[^)]*)\)$/;

/** Lines added plus lines removed between two versions (order is ignored: it is a count of what is different, not a diff). */
export function changedLines(a: string, b: string): number {
  const tally = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split(/\r?\n/)) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const A = tally(a);
  const B = tally(b);
  let n = 0;
  for (const [l, c] of B) n += Math.max(0, c - (A.get(l) ?? 0));
  for (const [l, c] of A) n += Math.max(0, c - (B.get(l) ?? 0));
  return n;
}

const countAssertions =(s: string) => (s.match(/\b(expect|assert)\w*\s*[.(]|\bassert\s|\bself\.assert/g) ?? []).length;
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

const SYSTEM = `You repair a failing test file. Tests and code drifted apart. Failures usually come from a FEW causes, so handle each CAUSE, not each test.

You are pointed at ONE cause at a time (see FOCUS in the message): do that one, with edits, before thinking about the others. The easy and certain causes come first. What you cannot settle quickly you PARK, and you are given the next one; parked causes are looked at again afterwards by a stronger model. Spending your effort on the hardest cause while the easy ones are untouched is the one thing to avoid.

Work like this.
1. Read the FAILURE section: the distinct causes with how many tests each breaks, the first line of the project's own code each points at, and the EVIDENCE: facts taken from the repository, not guessed (what exists, which test mocks lack what, which commit changed what and whether it touched the test).
2. Decide each cause on its own. Who is wrong?
   - STALE TEST: the test is out of date. A mock (jest.mock) that lacks something the code now calls. Setup the code now needs (a provider, a mocked module, an AppState or timer value, a flag). An expectation about text, labels or structure that the app changed ON PURPOSE (the evidence shows the commit, or the app no longer contains the old text anywhere). Fix these in the test file. A module that fails to load under a test runner is NOT a code bug. A TEST HELPER that calls a handler directly (props.onPress(), a mock callback) bypasses what the real framework applies first (a disabled prop that swallows the press, a guard, event batching): a test that finds a control "firing while disabled" through such a helper has a faulty helper, not a faulty app. Read the helper before blaming the code.
   - CODE DEFECT: the code is wrong. The test asserts documented or sensible behaviour (its comments often cite a spec section) and the code does something else: a regression. Do NOT change the test for these. Say what is wrong and where, as file:line.
   - UNSURE: say so for that cause. Never bend a test to match code that looks wrong, and never change code to match a test that looks old.
   Who is RIGHT is decided by the strongest authority, in this order: (1) the written spec and docs in the repository (docs/, *.md); (2) the commit that last changed the app's behaviour (the evidence names it) and the app's own doc comments (a @deprecated, a note that something is intentional); (3) the app's current code; (4) the test. A test that disagrees with a stronger authority is stale. A test that AGREES with the spec while the app disagrees means the APP deviates from its spec: that is neither a test fix nor yours to change, so say app-deviation (below).
3. Check a hunch instead of guessing. You may ask to see lines, to search the project, or to run a probe (below).
4. Make the SMALLEST edits that fix the test-side causes. If the mock lacks something, look at how other tests mock the same module and match them.
Rules for edits: keep every case that is still meaningful, update expected values and calls to match the code, never delete assertions or skip tests to make them pass, never loosen an assertion into one that cannot fail. Mock only what the test already mocked, plus what the code now needs.

Answer with JSON only, one of:
 {"verdict":"stale-test","reason":"one or two sentences: what was wrong","edits":[{"find":"exact existing text","replace":"new text"}]}
     these edits fix the cause you were pointed at (and any others you are certain of). When you rely on the written spec, a commit or a line of the app's code, you may name it with "cites":[{"at":"path:line","quote":"the exact words"}] or a commit hash: it helps whoever reads the result, and it is never a reason to hold back an answer you are confident in.
 {"verdict":"mixed","reason":"...","edits":[...],"codeBugs":["path:line what is wrong", ...],"appDeviations":["what the spec says, where, and what the app does instead"]}
     some causes are test-side (the edits fix them) and the rest are code defects, each named with its file and line. "appDeviations" is optional: causes where the test follows the written spec and the app does not.
 {"verdict":"code-bug","reason":"path:line what is wrong"}      every cause that is left is a code defect; the test is not changed. Say what shows it (the spec, a doc comment, the commit) in the reason.
 {"verdict":"app-deviation","reason":"..."}
     the test is right according to the written spec and the app does something else. Nothing is changed or fixed: a person decides which is right. Say where the spec says it and where the app differs.
 {"verdict":"park","kind":"unsure","reason":"what you found and what is still unknown"}
     you cannot settle the cause you were pointed at with what you have: park it, do NOT keep digging, and you will be given the next one. kind "code" only if you are sure the app is what is wrong.
 {"verdict":"unclear","reason":"..."}                          only after you have looked and it still does not settle it.
 {"need":["path/one",{"path":"path/two","from":120,"to":260},{"search":"someName"},{"probe":{"file":"__tests__/x.test.ts","before":"the line to print before","log":"String(AppState.currentState)"}}]}
     a string is a whole file; {"path","from","to"} is a range of lines; {"search"} finds where a name is defined, used or mocked; {"probe"} runs a throwaway COPY of the test with one console.log inserted before the line that contains "before", where "log" is a single expression, and shows what it printed. Use it when you need to know a value at run time (is this guard true, what does this mock return). The real test file is never changed by it. Ask instead of guessing.
"edits" are applied in order; each "find" is copied EXACTLY from the file (never the line-number prefix), as short as it can be while matching once. For a test file under ${LARGE_FILE_LINES} lines you may instead return the complete corrected file as "test"; for a longer one ALWAYS use edits and never return the whole file.`;

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

/**
 * What a worker is told about a failure: the digest (distinct causes, counts, the first line of the project's own code each points
 * at) and the start of the raw output. When no cause can be read out of the output, the raw tail, as before.
 */
export function failureText(output: string, repoRoot: string, file: string): string {
  const clean = output.replace(ANSI, "");
  const digest = digestFailure(clean, repoRoot, file);
  if (!digest.text) return clean.slice(-14_000);
  // Facts the repository can answer (what exists, which mocks lack what, which commit changed what), so they are not rediscovered or guessed.
  let evidence = "";
  try {
    evidence = evidenceText(repoRoot, file, digest);
  } catch {
    // evidence is a help, never a reason to fail
  }
  return `${digest.text}${evidence ? `\n\nEVIDENCE (collected from the repository, not guessed)\n${evidence}` : ""}\n\nRAW OUTPUT (start)\n${clean.slice(0, 3000)}`;
}

async function healOneInner(opts: HealOptions, file: string, trace: { output: string }): Promise<HealResult> {
  const { repoRoot } = opts;
  const run = opts.run ?? runSuiteLogged;
  const abs = path.join(repoRoot, file);
  // A trial edit that was never judged (the process was killed after writing it) is put back to the best state before anything else.
  if (recoverTrial(repoRoot, file)) opts.log?.(`  ↺ ${file}: an edit that was being tried when an earlier run was interrupted was undone.`);
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
  // A source file longer than this is not pasted whole: its start, and the lines named in the failure, are enough to begin with.
  const sourceText = sources
    .map((s) => {
      try {
        const text = fs.readFileSync(path.join(repoRoot, s), "utf-8");
        return text.split(/\r?\n/).length > LARGE_FILE_LINES
          ? `--- ${s} (${text.split(/\r?\n/).length} lines; the start is shown, ask for other lines)\n${readRange(repoRoot, s, 1, 200)?.replace(/^--- .*\n/, "") ?? ""}`
          : `--- ${s}\n${text}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
  const history = await gitHistory(repoRoot, [file, ...sources]);

  const lineCount = original.split(/\r?\n/).length;
  const large = lineCount > LARGE_FILE_LINES;
  const digest0 = digestFailure(first.output.replace(ANSI, ""), repoRoot, file);
  const view = large ? presentLargeFile(original, file, digest0, repoRoot) : original;

  let seen = new Set<string>();
  // For each replacement this worker has had applied, how many copies the file must hold for it to still be in (see applyEditsLenient).
  let requiredCopies = new Map<string, number>();
  let current = first;
  let attempts = 0;
  let last = original;
  // ------------------------------------------------------------------------------------------------------ one cause at a time
  // A worker asked about 14 causes at once digs into the hardest one and never commits to the easy ones (five benchmark runs ended at 130 of 164, unchanged,
  // every call a lookup). So it is pointed at ONE cause at a time, the biggest not yet settled. What it cannot settle it PARKS and moves on; what is
  // parked goes to the stronger model afterwards, told what is already fixed so that it cannot go backwards.
  interface Cause {
    key: string;
    message: string;
    count: number;
    at?: string;
    detail?: string;
  }
  const causesOf = (output: string): Cause[] =>
    digestFailure(output.replace(ANSI, ""), repoRoot, file, 80).clusters.map((c) => ({
      key: c.signature,
      message: c.message,
      count: c.count,
      at: c.frame ? `${c.frame.file}:${c.frame.line}` : undefined,
      detail: c.detail,
    }));
  let parked = new Map<string, { kind: "unsure" | "code"; reason: string; message: string; count: number }>();
  /** What has been fixed so far, in the order it was fixed. */
  const ledger: { message: string; fixed: number; by: string }[] = [];
  /** Every batch of edits that was accepted, with the reason the worker gave: the first model's changes, handed on in full to the stronger one. */
  const batches: { reason: string; edits: { find: string; replace: string }[] }[] = [];
  const focusOf = (): Cause | undefined => causesOf(current.output).find((c) => !parked.has(c.key));
  const ledgerLines = (): string[] => ledger.map((l) => `  - [${l.fixed}× fixed] ${l.message}  (by: ${l.by})`);
  const focusText = (): string => {
    const all = causesOf(current.output);
    const f = all.find((c) => !parked.has(c.key));
    if (!f) return "";
    const lines = [
      "FOCUS: work on ONE cause at a time.",
      `Now: [${f.count}×] ${f.message}${f.at ? `  (first points at ${f.at})` : ""}`,
    ];
    if (f.detail) lines.push(f.detail.split("\n").slice(0, 10).join("\n"));
    lines.push(
      "Reply with the edits that fix THIS cause: the easy and certain ones first (a shared helper, a mock, setup, a changed label). If you cannot settle it with what you have, do NOT keep digging: park it with " +
        '{"verdict":"park","kind":"unsure","reason":"what you found"} (kind "code" only if you are sure the app is what is wrong) and you will be given the next one. After your edits are run you are shown what still fails.'
    );
    if (ledger.length > 0) lines.push("ALREADY FIXED (these stay fixed: an edit that breaks a test that passes now is undone automatically):", ...ledgerLines());
    if (parked.size > 0) lines.push("PARKED (leave these for now):", ...[...parked.values()].map((p) => `  - [${p.count}×] ${p.message} — ${p.reason}`));
    const rest = all.filter((c) => !parked.has(c.key) && c.key !== f.key);
    if (rest.length > 0) lines.push(`Still to come after this one: ${rest.length} more cause${rest.length === 1 ? "" : "s"}.`);
    return lines.join("\n");
  };
  const focusTail = (): string => {
    const t = focusText();
    return t ? `\n\n${t}` : "";
  };
  /** The edits of one answer, in a few words, for the ledger. */
  const summarizeEdits = (list: { find: string; replace: string }[] | undefined): string =>
    list && list.length > 0
      ? list
          .slice(0, 2)
          .map((e) => `"${e.find.replace(/\s+/g, " ").slice(0, 50)}" → "${e.replace.replace(/\s+/g, " ").slice(0, 50)}"`)
          .join("; ") + (list.length > 2 ? `; and ${list.length - 2} more` : "")
      : "a rewrite";

  let messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `TEST FILE ${file}\n${view}\n\nFAILURE (this file run on its own)\n${failureText(current.output, repoRoot, file)}\n\n` +
        `SOURCE IT IMPORTS OR NAMES\n${sourceText || "(none could be resolved)"}\n\n` +
        `OTHER FILES IT REACHES (ask for any you need)\n${others.length ? others.join("\n") : "(none)"}\n\nRECENT GIT HISTORY\n${history || "(none)"}${focusTail()}`,
    },
  ];

  // Giving up never throws away progress. When the edits already made leave fewer tests failing than the start (or a file that could not load now
  // loads), they are KEPT and the result says so: a run that fixed 6 of 34 and then could not explain the rest used to put the file back as it was
  // and report no progress at all. With nothing gained, the file goes back exactly as it was. Every edit that was kept passed the made-it-worse
  // check, so the kept state is never worse than the start.
  const giveUp = (status: "unclear" | "unhealed", note: string): HealResult => {
    const before = testsFailing(first.output);
    const now = testsFailing(current.output);
    const better = last !== original && now !== undefined && (before === undefined || now < before);
    if (better) {
      fs.writeFileSync(abs, last);
      const changed = changedLines(original, last);
      const gained = before === undefined ? "the file could not run before and now does" : `${before} failing at the start, ${now} now`;
      return {
        file,
        status,
        partial: true,
        note: `${note}. The test fixes it had already made were KEPT (${gained}; ${changed} line${changed === 1 ? "" : "s"} changed); what is left needs a person.`,
        attempts,
      };
    }
    fs.writeFileSync(abs, original);
    return { file, status, note: `${note}. The file was put back as it was.`, attempts };
  };

  // Set when the last answer was not applied (its edits did not match, or it was refused): the file was not changed and not run again,
  // so the failure is of course the same, and that is no reason to stop: the model is told why and tries again.
  let retryUnchanged = false;
  // Lookups the worker has asked for in this heal, so a repeat is not answered twice.
  let asked = new Set<string>();
  // One conversation with one model. It ends with a result, or with "parked-out": every cause that still fails has been parked.
  const converse = async (callFn: HealCall, stage: "first" | "strong"): Promise<HealResult | "parked-out"> => {
  for (;;) {
    if (!retryUnchanged) {
      const key = failureKey(current.output);
      if (seen.has(key)) {
        return giveUp("unhealed", "the same failure came back");
      }
      seen.add(key);
    }
    retryUnchanged = false;
    attempts++;

    let reply = "";
    let parsed: any;
    for (let dry = 0, malformed = 0; ; ) {
      try {
        reply = await callFn(messages, `Heal ${file}`, true);
      } catch (err: any) {
        return giveUp("unhealed", `the model call failed: ${err?.message ?? err}`);
      }
      const lenient = parseLenient(reply);
      parsed = lenient?.value;
      // A reply that only parses after being repaired was CUT OFF: its reason ends mid-sentence and its edits may be missing the end of
      // the list. An incomplete diagnosis handed on as if it were whole is worse than none, so it is asked for again, shorter.
      if (lenient?.repaired && parsed && typeof parsed === "object" && (typeof parsed.verdict === "string" || Array.isArray(parsed.need))) {
        malformed++;
        if (malformed >= 3) {
          parsed = { verdict: "unclear", reason: "its replies kept being cut off before they ended" };
          break;
        }
        messages.push(
          { role: "assistant", content: reply },
          { role: "user", content: 'That reply was cut off before it ended. Reply again in full, with "reason" in two sentences at most (what is wrong and where, as file:line), then the rest.' }
        );
        continue;
      }
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
          { role: "user", content: 'That was not the JSON object asked for. Reply with ONLY {"verdict":...,"reason":...,"edits":[...]} or {"need":[...]}.' }
        );
        continue;
      }
      messages.push({ role: "assistant", content: reply });
      // Each request is a whole file (by path), a line range, or a search of the repository. One already answered is not answered twice.
      const blocks: string[] = [];
      for (const n of parsed.need as unknown[]) {
        const asking = typeof n === "string" ? `file:${n}` : n && typeof n === "object" ? `${(n as any).search !== undefined ? "search" : "range"}:${JSON.stringify(n)}` : "";
        if (!asking || asked.has(asking)) continue;
        asked.add(asking);
        if (typeof n === "string") {
          const p = n.replace(/\\/g, "/").replace(/^\.\//, "");
          if (provided.has(p) || !fs.existsSync(path.join(repoRoot, p))) continue;
          const body = readRange(repoRoot, p, 1, 800);
          if (!body) continue;
          provided.add(p);
          blocks.push(body);
        } else if (n && typeof n === "object" && typeof (n as any).search === "string") {
          blocks.push(await searchRepo(repoRoot, (n as any).search));
        } else if (n && typeof n === "object" && (n as any).probe && typeof (n as any).probe === "object") {
          // A value at run time, read the way a person would: a throwaway copy of the test with one console.log in it, run once and deleted.
          blocks.push(await runProbe(run, repoRoot, (n as any).probe));
        } else if (n && typeof n === "object" && typeof (n as any).path === "string") {
          const body = readRange(repoRoot, (n as any).path, (n as any).from, (n as any).to);
          if (body) blocks.push(body);
        }
      }
      // Looking is as long as it is useful. What ends it is not a number of rounds but a lookup that turns up nothing new (a file already
      // shown, one that is not there, a search that matches nothing) twice in a row: then it has to decide with what it has.
      const useful = blocks.filter((b) => !NO_RESULT.test(b));
      if (useful.length === 0) {
        dry++;
        if (dry >= 2) {
          // Looking has not settled the cause it was on: park it (the next one is a fresh start) instead of ending the whole file.
          parsed = focusOf() ? { verdict: "park", kind: "unsure", reason: "its lookups turned up nothing new" } : { verdict: "unclear", reason: "its lookups turned up nothing new" };
          break;
        }
        messages.push({
          role: "user",
          content: `${blocks.length ? blocks.join("\n\n") + "\n\n" : ""}Nothing new turned up (those files are already provided or do not exist, or nothing matched). Decide with what you have.`,
        });
        continue;
      }
      dry = 0;
      messages.push({ role: "user", content: blocks.join("\n\n") });
    }
    const verdict = String(parsed?.verdict ?? "");
    const reason = String(parsed?.reason ?? "").trim() || "no reason given";
    // "mixed": some causes are test-side (its edits fix them) and the rest are code defects, each named by the worker.
    const mixed = verdict === "mixed";
    const codeBugs: string[] = Array.isArray(parsed?.codeBugs) ? parsed.codeBugs.map((c: unknown) => String(c).trim()).filter(Boolean) : [];
    const hasChange = Boolean(parseEdits(parsed?.edits)) || (typeof parsed?.test === "string" && parsed.test.trim().length > 0);
    const deviations: string[] = Array.isArray(parsed?.appDeviations) ? parsed.appDeviations.map((c: unknown) => String(c).trim()).filter(Boolean) : [];
    const deviation = verdict === "app-deviation";
    const withDeviations = deviations.length > 0 ? { deviations } : {};

    // The worker could not settle the cause it was pointed at: park it and go on to the next, so one hard cause cannot starve the easy ones.
    if (verdict === "park") {
      const f = focusOf();
      if (!f) return giveUp("unclear", reason);
      parked.set(f.key, { kind: parsed?.kind === "code" ? "code" : "unsure", reason: reason.slice(0, 400), message: f.message, count: f.count });
      if (!focusOf()) return "parked-out";
      messages.push({ role: "assistant", content: reply }, { role: "user", content: `Parked: [${f.count}×] ${f.message}.\n\n${focusText()}` });
      retryUnchanged = true;
      continue;
    }

    // An answer that changes the test, or says the app differs from its spec, has to rest on something stronger than the test itself.
    // Calling the code wrong matters as much as editing the test: it is what sends a fix task to change product code.
    if (opts.requireCites && (deviation || verdict === "code-bug" || ((verdict === "stale-test" || mixed) && hasChange) || (mixed && codeBugs.length > 0))) {
      const problem = citeProblem(verifyCites(repoRoot, parsed?.cites, file, { requireQuote: true }));
      if (problem) {
        messages.push({ role: "assistant", content: reply }, { role: "user", content: `Not applied: ${problem}` });
        const k = `cite:${problem}`;
        if (seen.has(k)) {
          return giveUp("unhealed", "its answer rested on no authority outside the test that could be verified, so nothing was changed");
        }
        seen.add(k);
        retryUnchanged = true;
        continue;
      }
    }

    // A "mixed" answer with nothing to change in the test is simply a code defect.
    if (verdict === "code-bug" || deviation || (mixed && !hasChange)) {
      // The first model's claim that what is left is the CODE's is a claim, and it has been wrong before (a faulty test helper called an app defect). Before a
      // fix task changes product code on its word, the stronger model looks: every cause still failing is handed over, marked as "it believes the app is wrong".
      // The stronger model's own verdict is final.
      if (stage === "first" && opts.escalate) {
        const rest = causesOf(current.output).filter((c) => !parked.has(c.key));
        if (rest.length > 0) {
          const why = [reason, ...codeBugs].join(" ").replace(/\s+/g, " ").slice(0, 600);
          for (const c of rest) parked.set(c.key, { kind: "code", reason: why, message: c.message, count: c.count });
          return "parked-out";
        }
      }
      // Having ALREADY fixed the test-side causes and then been shown what still fails, the worker says what is left is the code: the test
      // edits stay (they moved the failure), and only the code defect is handed on. With no progress made, the file goes back as it was.
      const left = digestFailure(current.output.replace(ANSI, ""), repoRoot, file).total;
      // Progress is fewer failing, or a file that could not load now loads (its failures were hidden behind the load error, so the count rises).
      const loadFixed = testsFailing(first.output) === undefined && testsFailing(current.output) !== undefined;
      if (last !== original && (left < digest0.total || loadFixed)) {
        const changed = changedLines(original, last);
        return {
          file,
          status: deviation ? "app-deviation" : "code-bug",
          partial: true,
          note: `${reason} ${codeBugs.join("; ")} Still failing after the test-side fixes: ${left} (the test's out-of-date parts were fixed: ${changed} line${changed === 1 ? "" : "s"} changed)`.replace(/\s+/g, " ").slice(0, 2400),
          attempts,
          ...withDeviations,
        };
      }
      fs.writeFileSync(abs, original);
      return { file, status: deviation ? "app-deviation" : "code-bug", note: [reason, ...codeBugs].join(" ").slice(0, 2000), attempts, ...withDeviations };
    }
    if (verdict !== "stale-test" && !mixed) {
      return giveUp("unclear", reason);
    }

    // The change: edits applied to the file as it is now, or (for a file that is not large) the whole corrected file.
    let next: string | undefined;
    let skippedNote = "";
    // What was recorded as applied BEFORE this batch: if the batch is undone as worse, the record goes back with the file.
    const copiesBeforeBatch = requiredCopies;
    const edits = parseEdits(parsed?.edits);
    if (edits) {
      // Each edit stands alone: the ones that match are applied and the ones that do not are skipped and reported, so a batch is not lost to
      // one ambiguous "find" (a real run threw away twelve good edits over the tenth, resent the same batch, and gave up).
      const lenient = applyEditsLenient(last, edits, requiredCopies);
      requiredCopies = lenient.required;
      // Three different things, said apart: applied now, already in the file from an earlier answer (not an error: do not resend), and skipped (needs more context).
      skippedNote =
        lenient.skipped.length > 0 || lenient.already > 0
          ? `Of your ${edits.length} edits: ${lenient.applied} applied now; ${lenient.already} already in the file from an earlier answer (do not send those again); ${lenient.skipped.length} SKIPPED because they need more context. ` +
            (lenient.skipped.length > 0 ? `${lenient.skipped.map((x) => x.error).join(" ")} Send only the skipped ones again, each with more surrounding text, if they are still needed. ` : "")
          : "";
      // Everything it sent is already in the file: nothing new to apply. Not an error: show it what still fails and let it carry on.
      if (lenient.applied === 0 && lenient.skipped.length === 0 && lenient.already > 0) {
        const stillFails = digestFailure(current.output.replace(ANSI, ""), repoRoot, file).total;
        messages.push(
          { role: "assistant", content: reply },
          {
            role: "user",
            content:
              `Nothing new to apply: all ${lenient.already} edits you sent are already in the file. Send only NEW edits for what still fails (${stillFails} failing now). ` +
              `If what is left is not the test's own, answer code-bug or app-deviation with citations.\n${failureText(current.output, repoRoot, file)}`,
          }
        );
        const k = `already:${lenient.already}:${failureKey(current.output)}`;
        if (seen.has(k)) {
          return giveUp("unhealed", "it kept sending edits that were already in the file");
        }
        seen.add(k);
        retryUnchanged = true;
        continue;
      }
      const applied = lenient.applied === 0 ? { ok: false as const, error: lenient.skipped[0]?.error ?? "no edit could be applied." } : { ok: true as const, text: lenient.text };
      if (!applied.ok) {
        messages.push({ role: "assistant", content: reply }, { role: "user", content: `Not applied: ${applied.error} The file is unchanged${last === original ? "" : " since your earlier edits, which it contains"}.` });
        // The breaker fires only when NOTHING applied and the very same anchors are skipped again: a different ambiguous edit is a different problem.
        const k = `edit:${lenient.skipped.map((x) => x.find).join("\u0001") || applied.error}`;
        if (seen.has(k)) {
          return giveUp("unhealed", `its edits could not be applied (${applied.error.slice(0, 120)})`);
        }
        seen.add(k);
        retryUnchanged = true;
        continue;
      }
      next = matchEol(original, applied.text);
    } else if (typeof parsed?.test === "string" && parsed.test.trim()) {
      if (large) {
        messages.push({ role: "assistant", content: reply }, { role: "user", content: `This file has ${lineCount} lines: do not return it whole. Reply with "edits": [{"find":"exact existing text","replace":"new text"}].` });
        const k = "whole-file-refused";
        if (seen.has(k)) {
          return giveUp("unhealed", "it kept returning the whole file instead of edits");
        }
        seen.add(k);
        retryUnchanged = true;
        continue;
      }
      next = matchEol(original, parsed.test);
    }
    if (next === undefined) {
      return giveUp("unclear", reason);
    }
    const refusal = gutted(original, next);
    if (refusal) {
      messages.push({ role: "assistant", content: reply }, { role: "user", content: `Refused: ${refusal}. Try again.` });
      const k = `refused:${refusal}`;
      if (seen.has(k)) {
        return giveUp("unhealed", `kept proposing a rewrite that ${refusal}`);
      }
      seen.add(k);
      retryUnchanged = true;
      continue;
    }
    const undoTo = last;
    const runBefore = current;
    beginTrial(repoRoot, file, undoTo, next);
    fs.writeFileSync(abs, next);
    last = next;
    current = await run(repoRoot, [file]);
    trace.output = current.output;
    if (current.ok) {
      endTrial(repoRoot, file);
      // How much it changed, said plainly and never judged: a stale mock is a few lines, a renamed API can be a hundred, and which
      // one this was is for the person reading the report (and the diff) to see, not for a fixed number to decide.
      const changed = changedLines(original, next);
      return { file, status: "healed", note: `${reason} (${changed} line${changed === 1 ? "" : "s"} changed${skippedNote ? "; some of its edits did not apply and were skipped" : ""})`, attempts, ...withDeviations };
    }
    // An edit must never leave MORE tests failing than the run before it had, and must never turn a test that PASSED into a failing one, whatever
    // else it fixes (it can fix two and break two). If it did (or the file no longer runs), it is undone and the worker is told, so a bad batch can
    // never be what the file ends up as, and a later cause can never roll back an earlier one. A file that could not load before has no count to compare with.
    const direction = madeWorse(runBefore.output, current.output);
    const broke = regressions(runBefore.output, current.output, undoTo, next);
    // What the patch DID fix, so a rejection can say both: it fixed these, but broke those that already passed.
    const afterNames = new Set(failingNames(current.output));
    const fixedNow = failingNames(runBefore.output).filter((n) => !afterNames.has(n));
    if (direction.worse || broke.length > 0) {
      fs.writeFileSync(abs, undoTo);
      endTrial(repoRoot, file);
      last = undoTo;
      requiredCopies = copiesBeforeBatch;
      current = runBefore;
      trace.output = runBefore.output;
      messages.push(
        { role: "assistant", content: reply },
        {
          role: "user",
          content:
            (broke.length > 0
              ? `${fixedNow.length > 0 ? `Your patch fixed ${fixedNow.slice(0, 5).join(" | ")}${fixedNow.length > 5 ? " …" : ""}, but ` : "That change "}BROKE ${broke.length} test(s) that already passed${ledger.length > 0 ? " (fixed earlier)" : ""}: ${broke.slice(0, 5).join(" | ")}${broke.length > 5 ? " …" : ""}. Keep both green: fix your cause without breaking them. `
              : `That change made it WORSE: ${direction.was} test(s) failing before, ${direction.now === undefined ? "and now the file does not run at all" : `${direction.now} after`}. `) +
            `It was undone: the file is as it was before that change. ` +
            `Find out why (look at what the new failures are) and try a smaller or different edit.`,
        }
      );
      const k = `worse:${direction.now ?? "none"}:${broke.join("|")}:${next.length}:${next.slice(0, 200)}`;
      if (seen.has(k)) {
        return giveUp("unhealed", broke.length > 0 ? "the same change broke tests that passed again" : "the same change made more tests fail again");
      }
      seen.add(k);
      retryUnchanged = true;
      continue;
    }
    endTrial(repoRoot, file);
    // What this batch fixed goes in the ledger: every cause that now has fewer failures than before.
    {
      const after = causesOf(current.output);
      for (const b of causesOf(runBefore.output)) {
        const fixed = b.count - (after.find((x) => x.key === b.key)?.count ?? 0);
        if (fixed > 0) ledger.push({ message: b.message, fixed, by: summarizeEdits(edits) });
      }
      batches.push({ reason, edits: edits ?? [] });
    }
    // Still failing. Even for a "mixed" answer nothing is handed on yet: the worker has only SAID what is left is code, and a smaller failure
    // count proves nothing (55 -> 35 left 34 failures that were the test's own). It is shown what really still fails, and decides again: if
    // every remaining cause is the code's it answers code-bug (its edits so far are kept), otherwise it goes on fixing the test.
    // Every cause that is left has been parked: there is nothing more to ask this model, so it is time for the hand-off (or the final report).
    if (parked.size > 0 && !focusOf()) return "parked-out";
    const stillFailing = digestFailure(current.output.replace(ANSI, ""), repoRoot, file).total;
    const focus = focusText();
    messages.push(
      { role: "assistant", content: reply },
      {
        role: "user",
        content:
          skippedNote + `Your change is applied and the file still fails (${stillFailing} failing, ${digest0.total} before).\n${failureText(current.output, repoRoot, file)}\n\n` +
          (focus
            ? `${focus}\n\nIf EVERY remaining cause is the code's rather than the test's, answer {"verdict":"code-bug","reason":"...","codeBugs":[...]} instead (your edits so far are kept). Edits are applied to the file as it is now.`
            : `Go through EVERY cause that still fails, not only the one you named: a cause is the code's only if the test is right and the app does the wrong thing. ` +
              `If any is still the test's own (a helper that counts wrongly, a changed label, a stale mock), keep fixing it: return the next edits. ` +
              `Only when every remaining cause is the code's, answer {"verdict":"code-bug","reason":"...","codeBugs":[...]} with no edits (your edits so far are kept). ` +
              `Edits are applied to the file as it is now.`),
      }
    );
  }
  };

  let outcome = await converse(opts.call, "first");
  if (outcome === "parked-out" && opts.escalate && parked.size > 0) {
    // What the first model could not settle goes to the stronger one, in a fresh conversation that begins by saying what is ALREADY FIXED. The ratchet
    // enforces it: an edit that breaks any test that passes now is undone, so the stronger model cannot go backwards.
    const handed = [...parked.values()];
    opts.log?.(`  ↗ ${file}: ${handed.length} cause${handed.length === 1 ? "" : "s"} the first model could not settle go to the stronger model, with what is already fixed.`);
    const nowView = large ? presentLargeFile(last, file, digestFailure(current.output.replace(ANSI, ""), repoRoot, file), repoRoot) : last;
    parked = new Map();
    seen = new Set<string>();
    asked = new Set<string>();
    retryUnchanged = false;
    const fixedText = ledger.length > 0 ? ledgerLines().join("\n") : "  (nothing yet)";
    // The first model's edits, in the order they were made: enough to see what it changed and why, cut short rather than allowed to swamp the prompt.
    let changesText = batches
      .map((b, i) => `  ${i + 1}. ${b.reason.replace(/\s+/g, " ").slice(0, 160)}\n${b.edits.slice(0, 6).map((e) => `       "${e.find.replace(/\s+/g, " ").slice(0, 90)}" → "${e.replace.replace(/\s+/g, " ").slice(0, 90)}"`).join("\n")}${b.edits.length > 6 ? `\n       … and ${b.edits.length - 6} more edits in this batch` : ""}`)
      .join("\n");
    if (changesText.length > 6000) changesText = `${changesText.slice(0, 6000)}\n  … (shortened: the file above holds all of them)`;
    if (!changesText) changesText = "  (none)";
    const handedText = handed.map((p) => `  - [${p.count}×] ${p.message} — ${p.kind === "code" ? "it believed the app is wrong: " : ""}${p.reason}`).join("\n");
    messages = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `TEST FILE ${file}\n${nowView}\n\nFAILURE (this file run on its own, as it is NOW)\n${failureText(current.output, repoRoot, file)}\n\n` +
          `HANDOFF. A first model already worked on this file and fixed part of it: the file above is its result. You are the stronger model, called in for what it could not settle.\n` +
          `It brought the passing tests from ${testsPassing(first.output) ?? "?"} to ${testsPassing(current.output) ?? "?"}. Do not revert or undo its changes unless one of its workarounds directly conflicts with the true root-cause fix for a parked cause, and every test that passes now must stay green: a change that breaks one is undone automatically and you are told which.\n` +
          `ALREADY FIXED (these STAY fixed):\n${fixedText}\n` +
          `ITS CHANGES (already in the file above):\n${changesText}\n` +
          `THE FIRST MODEL COULD NOT SETTLE THESE (they are yours; its notes may be wrong):\n${handedText}\n\n` +
          `SOURCE IT IMPORTS OR NAMES\n${sourceText || "(none could be resolved)"}\n\n` +
          `OTHER FILES IT REACHES (ask for any you need)\n${others.length ? others.join("\n") : "(none)"}\n\nRECENT GIT HISTORY\n${history || "(none)"}${focusTail()}`,
      },
    ];
    outcome = await converse(opts.escalate, "strong");
  }
  if (outcome !== "parked-out") return outcome;

  // Every cause left is parked, by the first model and (when there is one) the stronger one.
  const codeParks = [...parked.values()].filter((p) => p.kind === "code");
  const summary = [...parked.values()].map((p) => `[${p.count}×] ${p.message} — ${p.reason}`).join("; ").slice(0, 1500);
  if (codeParks.length > 0) {
    const note = `${codeParks.map((p) => `${p.message} — ${p.reason}`).join(" ")} Still failing: ${testsFailing(current.output) ?? "?"}.`.slice(0, 2300);
    const before = testsFailing(first.output);
    const now = testsFailing(current.output);
    if (last !== original && now !== undefined && (before === undefined || now < before)) {
      return { file, status: "code-bug", partial: true, note: `${note} (the test's out-of-date parts were fixed: ${changedLines(original, last)} lines changed)`, attempts };
    }
    fs.writeFileSync(abs, original);
    return { file, status: "code-bug", note, attempts };
  }
  return giveUp("unclear", `${parked.size} cause${parked.size === 1 ? "" : "s"} could not be settled: ${summary}`);
}

// ------------------------------------------------------------ shared causes

/** The first error-looking line of a failure, with the details that differ between files taken out. */
export function failureSignature(output: string): string {
  const line = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => !/^ats/.test(l) && /(Error|Cannot find|is null|is undefined|not a function|Invariant|NativeModule|Unable to resolve)/.test(l));
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

const ROOT_SYSTEM = `Several test files fail with the same error. That usually means ONE shared cause in the test setup, not many separate test problems: a native or platform module with no mock under the test runner, a missing global, a missing transform or preset entry.
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
  const run = opts.run ?? runSuiteLogged;
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
              `SAME ERROR IN ${group.length} FILES: ${group.map((g) => g.file).join(", ")}\n\nONE FAILURE\n${failureText(group[0].failure!, repoRoot, group[0].file)}\n\n` +
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

// ------------------------------------------------------------------ settling

const SETTLE_SYSTEM = `A test file could not be brought back to green by updating it. It must not stay red: a red test blocks every later change. Decide:
- "rewrite": the feature it covers still exists. Write a NEW, smaller test file from scratch that checks what the code does NOW for the main behaviour that file was about. Prefer this when the feature is real and testable.
- "delete": the test is obsolete, tied to implementation details that no longer exist, or cannot be made reliable. Deleting is fine: a later change that needs this behaviour covered will get a new test.
Answer with JSON only: {"decision":"rewrite|delete","reason":"one sentence","test":"the complete new test file (rewrite only)"}`;

/** A test that cannot even load: a broken environment, not a statement about behaviour. Only these may be rewritten or removed. */
const ENVIRONMENT_FAILURE = /Test suite failed to run|Cannot find module|NativeModule|SyntaxError|Unexpected token|must contain at least one test|Jest encountered an unexpected token/i;

/**
 * Files still red after healing that are not a code defect: each gets a decision. A rewrite must pass or the file is
 * removed; a removal takes the snapshot and every reference with it. A model that cannot be reached never causes a removal.
 */
async function settleUnresolved(opts: HealOptions, results: HealResult[], log: (l: string) => void): Promise<void> {
  const { repoRoot } = opts;
  const run = opts.run ?? runSuiteLogged;
  const open = results.filter((r) => r.status === "unclear" || r.status === "unhealed");
  await Promise.all(
    open.map(async (r) => {
      const abs = path.join(repoRoot, r.file);
      let original = "";
      try {
        original = fs.readFileSync(abs, "utf-8");
      } catch {
        return;
      }
      const helper = /shared helper that sits where Jest looks/.test(r.note);
      if (helper) return; // not a test: the config fix is named in the report
      // A test that loads and then fails on behaviour (an assertion, a render error, something that never starts) may be
      // catching a real defect that nobody could pin down yet. Removing it would hide that, so it is KEPT. It is not sent to a code
      // fix either: no cause was found on the test and none was named in the code, and a Planner asked to change product code to
      // satisfy a test nobody could explain changes what passes today (a real run broke a passing test that way). It is left as it
      // is, and reported with what still fails, for a person to look at.
      if (!ENVIRONMENT_FAILURE.test(r.failure ?? "")) {
        r.note = `it fails on behaviour and the cause could not be pinned on the test or on one piece of code, so nothing was changed and it needs a person (${r.note})`;
        log(`  ? ${r.file}: ${r.note}`);
        return;
      }
      const sources = [...new Set([...importedSources(repoRoot, r.file, original), ...referencedFiles(repoRoot, r.file, original)])];
      const srcText = sources
        .map((s) => {
          try {
            return `--- ${s}\n${fs.readFileSync(path.join(repoRoot, s), "utf-8")}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n\n");
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SETTLE_SYSTEM },
        {
          role: "user",
          content: `TEST FILE ${r.file}\n${original}\n\nWHY IT COULD NOT BE HEALED\n${r.note}\n\nLAST FAILURE\n${failureText(r.failure ?? "", repoRoot, r.file)}\n\nSOURCE\n${srcText || "(none resolved)"}`,
        },
      ];
      let parsed: any;
      for (let bad = 0; ; bad++) {
        let reply = "";
        try {
          reply = await opts.call(messages, `Settle ${r.file}`, true);
        } catch {
          return; // unreachable model: leave it as it was
        }
        parsed = parseLenient(reply)?.value;
        if (parsed?.decision === "rewrite" || parsed?.decision === "delete") break;
        if (bad >= 2) return;
        messages.push({ role: "assistant", content: reply || "(empty)" }, { role: "user", content: 'Reply with ONLY {"decision":"rewrite|delete","reason":...,"test":...}.' });
      }
      const reason = String(parsed.reason ?? "").trim() || r.note;
      if (parsed.decision === "rewrite" && typeof parsed.test === "string" && countAssertions(parsed.test) >= 1) {
        fs.writeFileSync(abs, matchEol(original, parsed.test));
        const again = await run(repoRoot, [r.file]);
        if (again.ok) {
          r.status = "rewritten";
          r.note = `rewritten from scratch against the current code: ${reason}`;
          r.failure = undefined;
          log(`  ↻ ${r.file}: ${r.note}`);
          return;
        }
      }
      const removal = removeTest(repoRoot, r.file);
      recordRemoved(repoRoot, r.file, reason);
      r.status = "removed";
      r.note = `${reason} (${renderRemoval(removal)})`;
      r.failure = undefined;
      log(`  ✂ ${r.file}: ${r.note}`);
    })
  );
}

export interface HealReport {
  /** Test files left out of the run because nothing they depend on changed since their last green run. */
  unchanged?: number;
  before: SuiteRun;
  failing: string[];
  results: HealResult[];
  after?: SuiteRun;
}

/**
 * Runs the tests that could have changed result: those not known green, or whose fingerprint (the test, what it reaches,
 * the test config) differs from their last green run. With nothing in the log yet, that is simply the whole suite.
 */
async function runStale(opts: HealOptions, run: (root: string, files: string[]) => Promise<SuiteRun>): Promise<{ run: SuiteRun; skipped: number }> {
  const tests = listTestFiles(opts.repoRoot).map((t) => t.replace(/\\/g, "/"));
  const same = opts.all ? new Set<string>() : unchangedGreen(opts.repoRoot, tests);
  if (same.size === 0) return { run: await run(opts.repoRoot, []), skipped: 0 };
  const stale = tests.filter((t) => !same.has(t));
  if (stale.length === 0) return { run: { ok: true, output: "" }, skipped: same.size };
  return { run: await run(opts.repoRoot, stale), skipped: same.size };
}

/** The whole job: run, split by failing file, heal every file at once, run again. */
export async function healTests(opts: HealOptions): Promise<HealReport> {
  const log = opts.log ?? (() => {});
  const run = opts.run ?? runSuiteLogged;
  // Given specific files, only those are looked at and rerun: no full-suite runs around them.
  const scoped = Boolean(opts.files);
  if (!scoped) log("Running the full test suite once to see what is red…");
  let unchanged = 0;
  let before: SuiteRun = { ok: false, output: "" };
  if (!scoped) {
    const first = await runStale(opts, run);
    before = first.run;
    unchanged = first.skipped;
    if (unchanged > 0) log(`${unchanged} test file(s) are unchanged since their last green run and were not rerun (/tests heal all rerun everything).`);
  }
  const failing = opts.files ?? failingTestFiles(before.output);
  if (before.ok && !scoped) return { before, failing: [], results: [], unchanged };
  if (failing.length === 0) return { before, failing, results: [], unchanged };

  // A red test nobody has touched since it was last diagnosed keeps its diagnosis: no model call to find it again.
  const reused = (f: string): HealResult | undefined => {
    if (opts.all) return undefined;
    let v;
    try {
      v = verdictFor(opts.repoRoot, f);
    } catch {
      return undefined;
    }
    if (!v || !["code-bug", "app-deviation", "unclear", "unhealed"].includes(v.status)) return undefined;
    return { file: f, status: v.status as HealStatus, note: `${v.note} (nothing it depends on changed since it was last diagnosed)`, failure: v.failure, attempts: 0 };
  };
  log(`${failing.length} failing test file${failing.length === 1 ? "" : "s"}. One worker each, all at once.`);
  const results = await Promise.all(
    failing.map(async (f) => {
      const r = reused(f) ?? (await healOne(opts, f));
      log(`  ${icon(r.status)} ${r.file}: ${r.note}`);
      return r;
    })
  );
  await sharedCauses(opts, results, log);
  if (opts.settle ?? !scoped) await settleUnresolved(opts, results, log);
  for (const r of results) {
    // Remembered across phases (see LogEntry.healStrikes), so a test that cannot be healed is not paid for again in every one.
    try {
      // A partial result fixed what was test-side and handed the rest on: that is progress, not a failed heal, so it earns no strike.
      if (r.status !== "already-green" && !r.partial) recordHealOutcome(opts.repoRoot, r.file, r);
    } catch {}
    if ((r.status === "code-bug" || r.status === "app-deviation" || ((r.status === "unclear" || r.status === "unhealed") && !r.partial)) && !/the model call failed/.test(r.note)) {
      try {
        saveVerdict(opts.repoRoot, r.file, { status: r.status, note: r.note.replace(/ \(nothing it depends on changed since it was last diagnosed\)$/, ""), failure: r.failure });
      } catch {}
    }
  }
  if (scoped) return { before, failing, results, unchanged };
  log("Running the tests again…");
  const after = (await runStale(opts, run)).run;
  return { before, failing, results, after, unchanged };
}

const icon = (s: HealStatus) =>
  s === "healed" || s === "rewritten" ? "✓" : s === "removed" ? "✂" : s === "already-green" ? "·" : s === "code-bug" ? "🐞" : s === "app-deviation" ? "⚖" : s === "unclear" ? "?" : "✗";

export function renderHealReport(r: HealReport): string {
  const unchangedNote = r.unchanged ? ` ${r.unchanged} test file(s) unchanged since their last green run were not rerun.` : "";
  if (r.failing.length === 0 && r.before.ok) return "The test suite is already green. Nothing to heal." + unchangedNote;
  if (r.failing.length === 0) return "The suite fails but no failing test file could be read from its output, so nothing was changed.";
  const by = (s: HealStatus) => r.results.filter((x) => x.status === s);
  const lines = [
    `Test healing: ${r.failing.length} red file(s) before. ${by("healed").length} healed, ${by("already-green").length} already passing alone, ${by("code-bug").length} are code bugs, ${by("app-deviation").length} where the app differs from its spec, ${by("rewritten").length} rewritten, ${by("removed").length} removed, ${by("unclear").length + by("unhealed").length} left alone.`,
  ];
  const bugs = by("code-bug");
  const whole = bugs.filter((b) => !b.partial);
  const partial = bugs.filter((b) => b.partial);
  if (partial.length) lines.push("", "Part test, part code. The out-of-date parts of these tests were fixed; what still fails is the CODE, and a fix is queued for it:", ...partial.map((b) => `  - ${b.file}: ${b.note}`));
  if (whole.length) lines.push("", "The CODE is wrong here (tests left untouched; a fix is queued; a test file is removed afterwards only if nothing in it passes, one that fails in part is kept):", ...whole.map((b) => `  - ${b.file}: ${b.note}`));
  // The app contradicts the written spec the test follows: nothing was changed and nothing is queued. A person decides which is right.
  const deviating = r.results.filter((x) => x.status === "app-deviation" || (x.deviations && x.deviations.length > 0));
  if (deviating.length) {
    lines.push("", "The APP differs from its written spec here (nothing was changed or queued: you decide which is right):");
    for (const d of deviating) {
      if (d.status === "app-deviation") lines.push(`  - ${d.file}: ${d.note}`);
      for (const x of d.deviations ?? []) lines.push(`  - ${d.file}: ${x}`);
    }
  }
  const rewritten = by("rewritten");
  if (rewritten.length) lines.push("", "Rewritten from scratch:", ...rewritten.map((b) => `  - ${b.file}: ${b.note}`));
  const gone = by("removed");
  if (gone.length) lines.push("", "Removed (a later change that needs this covered gets a new test):", ...gone.map((b) => `  - ${b.file}: ${b.note}`));
  const rest = [...by("unclear"), ...by("unhealed")];
  if (rest.length) lines.push("", "Left alone:", ...rest.map((b) => `  - ${b.file}: ${b.note}`));
  if (r.after) lines.push("", (r.after.ok ? "Suite after: green." : `Suite after: still red in ${failingTestFiles(r.after.output).length} file(s).`) + unchangedNote);
  return lines.join("\n");
}
