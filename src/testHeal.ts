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
import { listTestFiles } from "./focusTests.js";
import { reachableFiles } from "./testGraph.js";
import { digestFailure } from "./failureDigest.js";
import { evidenceText } from "./failureEvidence.js";
import { applyEdits, parseEdits, presentLargeFile, readRange, searchRepo, runProbe, LARGE_FILE_LINES } from "./healEdits.js";
import { removeTest, renderRemoval, recordRemoved } from "./testSettle.js";

export { runSuite, failingTestFiles, type SuiteRun };

const execFileAsync = promisify(execFile);

export type HealStatus = "healed" | "already-green" | "code-bug" | "unclear" | "unhealed" | "rewritten" | "removed";

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

Work like this.
1. Read the FAILURE section: the distinct causes with how many tests each breaks, the first line of the project's own code each points at, and the EVIDENCE: facts taken from the repository, not guessed (what exists, which test mocks lack what, which commit changed what and whether it touched the test).
2. Decide each cause on its own. Who is wrong?
   - STALE TEST: the test is out of date. A mock (jest.mock) that lacks something the code now calls. Setup the code now needs (a provider, a mocked module, an AppState or timer value, a flag). An expectation about text, labels or structure that the app changed ON PURPOSE (the evidence shows the commit, or the app no longer contains the old text anywhere). Fix these in the test file. A module that fails to load under a test runner is NOT a code bug.
   - CODE DEFECT: the code is wrong. The test asserts documented or sensible behaviour (its comments often cite a spec section) and the code does something else: a regression. Do NOT change the test for these. Say what is wrong and where, as file:line.
   - UNSURE: say so for that cause. Never bend a test to match code that looks wrong, and never change code to match a test that looks old.
3. Check a hunch instead of guessing. You may ask to see lines, to search the project, or to run a probe (below).
4. Make the SMALLEST edits that fix the test-side causes. If the mock lacks something, look at how other tests mock the same module and match them.
Rules for edits: keep every case that is still meaningful, update expected values and calls to match the code, never delete assertions or skip tests to make them pass, never loosen an assertion into one that cannot fail. Mock only what the test already mocked, plus what the code now needs.

Answer with JSON only, one of:
 {"verdict":"stale-test","reason":"one or two sentences: what was wrong","edits":[{"find":"exact existing text","replace":"new text"}]}
     every cause is test-side, and these edits fix them.
 {"verdict":"mixed","reason":"...","edits":[...],"codeBugs":["path:line what is wrong", ...]}
     some causes are test-side (the edits fix them) and the rest are code defects, each named with its file and line.
 {"verdict":"code-bug","reason":"path:line what is wrong"}      every cause is a code defect; the test is not changed.
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

  const seen = new Set<string>();
  let current = first;
  let attempts = 0;
  let last = original;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `TEST FILE ${file}\n${view}\n\nFAILURE (this file run on its own)\n${failureText(current.output, repoRoot, file)}\n\n` +
        `SOURCE IT IMPORTS OR NAMES\n${sourceText || "(none could be resolved)"}\n\n` +
        `OTHER FILES IT REACHES (ask for any you need)\n${others.length ? others.join("\n") : "(none)"}\n\nRECENT GIT HISTORY\n${history || "(none)"}`,
    },
  ];

  // Set when the last answer was not applied (its edits did not match, or it was refused): the file was not changed and not run again,
  // so the failure is of course the same, and that is no reason to stop: the model is told why and tries again.
  let retryUnchanged = false;
  // Lookups the worker has asked for in this heal, so a repeat is not answered twice.
  const asked = new Set<string>();
  for (;;) {
    if (!retryUnchanged) {
      const key = failureKey(current.output);
      if (seen.has(key)) {
        fs.writeFileSync(abs, original);
        return { file, status: "unhealed", note: "the same failure came back, so the file was put back as it was", attempts };
      }
      seen.add(key);
    }
    retryUnchanged = false;
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
          parsed = { verdict: "unclear", reason: "its lookups turned up nothing new" };
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
    // A "mixed" answer with nothing to change in the test is simply a code defect.
    if (verdict === "code-bug" || (mixed && !hasChange)) {
      // Having ALREADY fixed the test-side causes and then been shown what still fails, the worker says what is left is the code: the test
      // edits stay (they moved the failure), and only the code defect is handed on. With no progress made, the file goes back as it was.
      const left = digestFailure(current.output.replace(ANSI, ""), repoRoot, file).total;
      if (last !== original && left < digest0.total) {
        const changed = changedLines(original, last);
        return {
          file,
          status: "code-bug",
          partial: true,
          note: `${reason} ${codeBugs.join("; ")} Still failing after the test-side fixes: ${left} (the test's out-of-date parts were fixed: ${changed} line${changed === 1 ? "" : "s"} changed)`.replace(/\s+/g, " ").slice(0, 2400),
          attempts,
        };
      }
      fs.writeFileSync(abs, original);
      return { file, status: "code-bug", note: [reason, ...codeBugs].join(" ").slice(0, 2000), attempts };
    }
    if (verdict !== "stale-test" && !mixed) {
      fs.writeFileSync(abs, original);
      return { file, status: "unclear", note: reason, attempts };
    }

    // The change: edits applied to the file as it is now, or (for a file that is not large) the whole corrected file.
    let next: string | undefined;
    const edits = parseEdits(parsed?.edits);
    if (edits) {
      const applied = applyEdits(last, edits);
      if (!applied.ok) {
        messages.push({ role: "assistant", content: reply }, { role: "user", content: `Not applied: ${applied.error} The file is unchanged${last === original ? "" : " since your earlier edits, which it contains"}.` });
        const k = `edit:${applied.error}`;
        if (seen.has(k)) {
          fs.writeFileSync(abs, original);
          return { file, status: "unhealed", note: `its edits could not be applied (${applied.error.slice(0, 120)})`, attempts };
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
          fs.writeFileSync(abs, original);
          return { file, status: "unhealed", note: "it kept returning the whole file instead of edits", attempts };
        }
        seen.add(k);
        retryUnchanged = true;
        continue;
      }
      next = matchEol(original, parsed.test);
    }
    if (next === undefined) {
      fs.writeFileSync(abs, original);
      return { file, status: "unclear", note: reason, attempts };
    }
    const refusal = gutted(original, next);
    if (refusal) {
      messages.push({ role: "assistant", content: reply }, { role: "user", content: `Refused: ${refusal}. Try again.` });
      const k = `refused:${refusal}`;
      if (seen.has(k)) {
        fs.writeFileSync(abs, original);
        return { file, status: "unhealed", note: `kept proposing a rewrite that ${refusal}`, attempts };
      }
      seen.add(k);
      retryUnchanged = true;
      continue;
    }
    fs.writeFileSync(abs, next);
    last = next;
    current = await run(repoRoot, [file]);
    trace.output = current.output;
    if (current.ok) {
      // How much it changed, said plainly and never judged: a stale mock is a few lines, a renamed API can be a hundred, and which
      // one this was is for the person reading the report (and the diff) to see, not for a fixed number to decide.
      const changed = changedLines(original, next);
      return { file, status: "healed", note: `${reason} (${changed} line${changed === 1 ? "" : "s"} changed)`, attempts };
    }
    // Still failing. Even for a "mixed" answer nothing is handed on yet: the worker has only SAID what is left is code, and a smaller failure
    // count proves nothing (55 -> 35 left 34 failures that were the test's own). It is shown what really still fails, and decides again: if
    // every remaining cause is the code's it answers code-bug (its edits so far are kept), otherwise it goes on fixing the test.
    const stillFailing = digestFailure(current.output.replace(ANSI, ""), repoRoot, file).total;
    messages.push(
      { role: "assistant", content: reply },
      {
        role: "user",
        content:
          `Your change is applied and the file still fails (${stillFailing} failing, ${digest0.total} before).\n${failureText(current.output, repoRoot, file)}\n\n` +
          `Go through EVERY cause that still fails, not only the one you named: a cause is the code's only if the test is right and the app does the wrong thing. ` +
          `If any is still the test's own (a helper that counts wrongly, a changed label, a stale mock), keep fixing it: return the next edits. ` +
          `Only when every remaining cause is the code's, answer {"verdict":"code-bug","reason":"...","codeBugs":[...]} with no edits (your edits so far are kept). ` +
          `Edits are applied to the file as it is now.`,
      }
    );
  }
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
      // catching a real defect that nobody could pin down yet. Removing it would hide that, so it goes to the code fix first;
      // it is removed only if it still fails after that attempt.
      if (!ENVIRONMENT_FAILURE.test(r.failure ?? "")) {
        r.status = "code-bug";
        r.note = `it fails on behaviour and the cause could not be pinned on the test, so the code is fixed first (${r.note})`;
        log(`  🐞 ${r.file}: ${r.note}`);
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
    if (!v || !["code-bug", "unclear", "unhealed"].includes(v.status)) return undefined;
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
    if ((r.status === "code-bug" || r.status === "unclear" || r.status === "unhealed") && !/the model call failed/.test(r.note)) {
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
  s === "healed" || s === "rewritten" ? "✓" : s === "removed" ? "✂" : s === "already-green" ? "·" : s === "code-bug" ? "🐞" : s === "unclear" ? "?" : "✗";

export function renderHealReport(r: HealReport): string {
  const unchangedNote = r.unchanged ? ` ${r.unchanged} test file(s) unchanged since their last green run were not rerun.` : "";
  if (r.failing.length === 0 && r.before.ok) return "The test suite is already green. Nothing to heal." + unchangedNote;
  if (r.failing.length === 0) return "The suite fails but no failing test file could be read from its output, so nothing was changed.";
  const by = (s: HealStatus) => r.results.filter((x) => x.status === s);
  const lines = [
    `Test healing: ${r.failing.length} red file(s) before. ${by("healed").length} healed, ${by("already-green").length} already passing alone, ${by("code-bug").length} are code bugs, ${by("rewritten").length} rewritten, ${by("removed").length} removed, ${by("unclear").length + by("unhealed").length} left alone.`,
  ];
  const bugs = by("code-bug");
  const whole = bugs.filter((b) => !b.partial);
  const partial = bugs.filter((b) => b.partial);
  if (partial.length) lines.push("", "Part test, part code. The out-of-date parts of these tests were fixed; what still fails is the CODE, and a fix is queued for it:", ...partial.map((b) => `  - ${b.file}: ${b.note}`));
  if (whole.length) lines.push("", "The CODE is wrong here (tests left untouched; a fix is queued; a test file is removed afterwards only if nothing in it passes, one that fails in part is kept):", ...whole.map((b) => `  - ${b.file}: ${b.note}`));
  const rewritten = by("rewritten");
  if (rewritten.length) lines.push("", "Rewritten from scratch:", ...rewritten.map((b) => `  - ${b.file}: ${b.note}`));
  const gone = by("removed");
  if (gone.length) lines.push("", "Removed (a later change that needs this covered gets a new test):", ...gone.map((b) => `  - ${b.file}: ${b.note}`));
  const rest = [...by("unclear"), ...by("unhealed")];
  if (rest.length) lines.push("", "Left alone:", ...rest.map((b) => `  - ${b.file}: ${b.note}`));
  if (r.after) lines.push("", (r.after.ok ? "Suite after: green." : `Suite after: still red in ${failingTestFiles(r.after.output).length} file(s).`) + unchangedNote);
  return lines.join("\n");
}
