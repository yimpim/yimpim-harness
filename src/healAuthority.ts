/**
 * Two checks the heal worker's answers are held to.
 *
 * 1. AUTHORITY. A test is only "stale" (and the code only "wrong") if something stronger than the test says so: the written spec, the commit that
 *    changed the app's behaviour, the app's own code or doc comments. So an answer must cite at least one such source outside the test.
 *    A citation is either a commit hash, or a place in a file WITH THE EXACT WORDS relied on:
 *        {"at": "docs/SPEC.md:532", "quote": "Yes/No buttons that send the fallback's own style"}
 *    The quote must appear in that file within a few lines of the cited line. A line number alone proves nothing: a real run cited lines of the
 *    Home-screen section as support for a rule that lives 70 lines away. Copying words is something a model cannot fake.
 *
 * 2. DIRECTION. Edits to a test must not leave more tests failing than before. After an edit the failing count is compared with the one before it;
 *    a higher count (or a file that no longer runs at all) means the edit made things worse and it is undone.
 *
 * Nothing here knows a language: citations are paths, lines, quotes and commit hashes, and the count reads the runner's own summary line.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { isTestPath } from "./focusTests.js";

export interface CiteCheck {
  /** Citations that hold. */
  good: string[];
  /** Citations that could not be verified, each with why (and where the words really are, when they are somewhere else in the file). */
  bad: string[];
  /** How many good citations are outside the tests: a spec, the app's code, a commit. At least one is required. */
  authorities: number;
}

const PATH_TOKEN = /(?:^|[\s("'`,;])((?:[\w.@\-[\]()]+\/)*[\w.@\-[\]()]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?/g;
const HASH_TOKEN = /\b([0-9a-f]{7,40})\b/g;
/** How far from the cited line the quoted words may be. */
const NEAR = 3;
const MIN_QUOTE = 8;

function git(repoRoot: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Case, spacing and markdown emphasis do not count as a different quote. */
const norm = (s: string) => s.toLowerCase().replace(/[*_`"'“”‘’]/g, "").replace(/\s+/g, " ").trim();

interface Cite {
  at: string;
  quote?: string;
}

function toCites(raw: unknown): Cite[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: Cite[] = [];
  for (const c of list) {
    if (typeof c === "string") {
      if (c.trim()) out.push({ at: c.trim() });
    } else if (c && typeof c === "object") {
      const at = String((c as any).at ?? (c as any).path ?? (c as any).commit ?? "").trim();
      const quote = (c as any).quote === undefined ? undefined : String((c as any).quote);
      if (at) out.push({ at, quote });
    }
  }
  return out;
}

/** Does the quote appear near the cited line? When it appears elsewhere in the file, say where, so the worker can correct itself. */
function checkQuote(abs: string, from: number | undefined, to: number | undefined, quote: string): { ok: boolean; why: string } {
  const want = norm(quote);
  if (want.length < MIN_QUOTE) return { ok: false, why: `the quote is too short to prove anything (at least ${MIN_QUOTE} characters of the exact words)` };
  let lines: string[];
  try {
    lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  } catch {
    return { ok: false, why: "the file cannot be read" };
  }
  const lo = from === undefined ? 0 : Math.max(0, from - 1 - NEAR);
  const hi = from === undefined ? lines.length : Math.min(lines.length, (to ?? from) + NEAR);
  if (norm(lines.slice(lo, hi).join(" ")).includes(want)) return { ok: true, why: "" };
  // Elsewhere in the file: find the line it starts on.
  // The line the words BEGIN on (the first stretch of them), then, for words that run over several lines, the window that holds them all.
  const start = want.slice(0, Math.min(want.length, 24));
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]).includes(start)) return { ok: false, why: `those words are not at line ${from}; they are at line ${i + 1}` };
  }
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines.slice(i, i + 4).join(" ")).includes(want)) return { ok: false, why: `those words are not at line ${from}; they are near line ${i + 1}` };
  }
  return { ok: false, why: "those words do not appear in that file" };
}

function checkOne(repoRoot: string, cite: Cite, requireQuote: boolean): { ok: boolean; why: string; outside: boolean } {
  const root = path.resolve(repoRoot);
  let firstWhy = "no file, line or commit that exists";
  for (const m of cite.at.matchAll(PATH_TOKEN)) {
    const rel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      firstWhy = `${rel} does not exist`;
      continue;
    }
    const from = m[2] ? Number(m[2]) : undefined;
    const to = m[3] ? Number(m[3]) : undefined;
    const total = (() => {
      try {
        return fs.readFileSync(abs, "utf8").split(/\r?\n/).length;
      } catch {
        return 0;
      }
    })();
    if (from !== undefined && (from < 1 || from > total)) {
      firstWhy = `${rel} has no line ${from}`;
      continue;
    }
    const outside = !isTestPath(rel);
    if (cite.quote !== undefined) {
      const q = checkQuote(abs, from, to, cite.quote);
      if (!q.ok) {
        firstWhy = `${rel}: ${q.why}`;
        continue;
      }
      return { ok: true, why: "", outside };
    }
    // No words given. Without the quote requirement a real file and line is enough (callers that did not ask for it); with it, a place alone
    // proves nothing and does not count as an authority.
    if (requireQuote && outside) {
      firstWhy = `${rel}${from ? `:${from}` : ""} exists, but no words were quoted: give {"at": "${rel}:${from ?? "LINE"}", "quote": "the exact words you rely on"}`;
      continue;
    }
    return { ok: true, why: "", outside };
  }
  for (const m of cite.at.matchAll(HASH_TOKEN)) {
    if (git(root, ["cat-file", "-e", `${m[1]}^{commit}`])) return { ok: true, why: "", outside: true };
    firstWhy = `${m[1]} is not a commit in this repository`;
  }
  return { ok: false, why: firstWhy, outside: false };
}

/**
 * Checks the citations of an answer. `testFile` is the file being healed: a citation of itself is not an authority. With `requireQuote`, a place in
 * a file only counts when the exact words relied on are quoted and found next to it (a commit hash needs no quote).
 */
export function verifyCites(repoRoot: string, cites: unknown, testFile: string, opts: { requireQuote?: boolean } = {}): CiteCheck {
  const self = testFile.replace(/\\/g, "/");
  const out: CiteCheck = { good: [], bad: [], authorities: 0 };
  for (const cite of toCites(cites)) {
    const label = cite.quote ? `${cite.at} "${cite.quote.slice(0, 50)}"` : cite.at;
    const r = checkOne(repoRoot, cite, opts.requireQuote === true);
    if (!r.ok) {
      out.bad.push(`"${label.slice(0, 120)}" (${r.why})`);
      continue;
    }
    out.good.push(label);
    if (r.outside && !cite.at.replace(/\\/g, "/").includes(self)) out.authorities++;
  }
  return out;
}

/** What to tell the worker when its answer rests on no usable authority. Undefined when it does. */
export function citeProblem(check: CiteCheck): string | undefined {
  if (check.authorities > 0 && check.bad.length === 0) return undefined;
  const parts: string[] = [];
  if (check.authorities === 0) {
    parts.push(
      'every answer that changes the test, calls the code wrong, or says the app differs from its spec must give "cites": at least one authority OUTSIDE the test file, with the exact words it says. For example {"at": "docs/SPEC.md:532", "quote": "Yes/No buttons that send the fallback\'s own style"} (the quote is copied from near that line), or the hash of the commit that changed the behaviour.'
    );
  }
  if (check.bad.length > 0) parts.push(`These citations could not be verified: ${check.bad.join("; ")}. Cite only words you have actually read in the file.`);
  return parts.join(" ");
}

/**
 * How many tests the runner says are failing, read from its own summary line ("Tests: 34 failed, 130 passed, 164 total", or vitest's
 * "Tests  3 failed | 10 passed"). Undefined when the output has no such line, for instance when the file failed to load at all.
 */
export function testsFailing(output: string): number | undefined {
  const clean = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const m = /^\s*Tests:?\s+(.*)$/m.exec(clean);
  if (!m) return undefined;
  const failed = /(\d+)\s+failed/.exec(m[1]);
  return failed ? Number(failed[1]) : 0;
}

/**
 * Did an edit make things worse? Only judged when the run before it did execute tests (a file that could not load before has no count to compare
 * with: fixing the load is progress even when it reveals failures). A file that ran before and no longer runs is worse.
 */
export function madeWorse(before: string, after: string): { worse: boolean; was?: number; now?: number } {
  const was = testsFailing(before);
  if (was === undefined) return { worse: false };
  const now = testsFailing(after);
  return { worse: now === undefined || now > was, was, now };
}
