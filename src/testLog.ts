/**
 * The test log (`.agent/test-log.json`): for every test file, when it last ran, whether it was green or red, and a
 * fingerprint of everything that run depended on (the test, every file it reaches through imports, and the project-wide
 * test config). Every run through `runSuiteLogged` (QA's test gate, `/tests heal`, the end-of-roadmap run) updates it.
 *
 * A test counts as "unchanged since its last green run" only when that fingerprint still matches. A test file's own
 * modified date is NOT enough: the usual way a green test goes red is that a SOURCE file changed and the test did not.
 * Dates are kept so a person can read the log; the fingerprint is what decides.
 *
 * It also keeps the last diagnosis of a red test against the same fingerprint, so a rerun does not pay to rediscover a
 * code defect it already found and that nobody has touched since.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { runSuite, failingTestFiles, passingTestFiles, type SuiteRun } from "./testRun.js";
import { reachMany, GLOBAL_CONFIG } from "./testGraph.js";
import { listTestFiles } from "./focusTests.js";

/** Bump when healing logic changes enough that an old diagnosis should be made again. */
export const HEAL_LOGIC_VERSION = 4;

const posix = (p: string) => p.replace(/\\/g, "/");

export interface StoredVerdict {
  status: string;
  note: string;
  failure?: string;
  fingerprint: string;
  version: number;
  at: string;
}

export interface LogEntry {
  lastRun: string;
  result: "green" | "red";
  /** The fingerprint of the state that last ran. */
  fingerprint: string;
  greenAt?: string;
  greenFingerprint?: string;
  verdict?: StoredVerdict;
}

interface TestLog {
  version: 1;
  files: Record<string, LogEntry>;
}

const logPath = (root: string) => path.join(root, ".agent", "test-log.json");

export function loadLog(root: string): TestLog {
  try {
    const v = JSON.parse(fs.readFileSync(logPath(root), "utf-8"));
    if (v && typeof v === "object" && v.files && typeof v.files === "object") return v;
  } catch {}
  return { version: 1, files: {} };
}

function saveLog(root: string, log: TestLog): void {
  try {
    fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
    fs.writeFileSync(logPath(root), JSON.stringify(log, null, 2));
  } catch {}
}

const sha = (s: string | Buffer) => crypto.createHash("sha1").update(s).digest("hex");

function globalHash(root: string, cache: Map<string, string>): string {
  const parts: string[] = [];
  try {
    for (const f of fs.readdirSync(root).sort()) {
      if (!GLOBAL_CONFIG.test(f)) continue;
      parts.push(f + ":" + fileHash(root, f, cache));
    }
  } catch {}
  return sha(parts.join("\n"));
}

function fileHash(root: string, rel: string, cache: Map<string, string>): string {
  const hit = cache.get(rel);
  if (hit) return hit;
  let h = "missing";
  try {
    h = sha(fs.readFileSync(path.join(root, rel)));
  } catch {}
  cache.set(rel, h);
  return h;
}

export interface Fingerprint {
  fp: string;
  /** False when some import could not be resolved: its dependencies are not fully known, so it is never skipped. */
  trusted: boolean;
}

/** One fingerprint per test file: hash of the test, everything it reaches, and the project's test config. */
export function fingerprints(root: string, tests: string[]): Map<string, Fingerprint> {
  const cache = new Map<string, string>();
  const g = globalHash(root, cache);
  const reach = reachMany(root, tests.map(posix));
  const out = new Map<string, Fingerprint>();
  for (const t of tests.map(posix)) {
    const r = reach.get(t);
    const files = r ? [...r.files].sort() : [t];
    out.set(t, { fp: sha(g + "\n" + files.map((f) => `${f}\0${fileHash(root, f, cache)}`).join("\n")), trusted: r ? !r.unresolved : false });
  }
  return out;
}

/** Folds one run's result into the log. A run whose output names no passing or failing file proves nothing and records nothing. */
export function recordRun(root: string, requested: string[], run: SuiteRun, now = new Date()): void {
  const all = listTestFiles(root).map(posix);
  const asked = requested.length ? requested.map(posix) : all;
  const failed = new Set(failingTestFiles(run.output));
  const passed = new Set(passingTestFiles(run.output));
  // A clean run proves green for the files the runner reported passing. A helper that sits in the test folder holds no tests, so the
  // runner never reports it: it must not be logged green. When the output names no file at all, a clean run still counts for what was asked.
  const green = run.ok ? (passed.size > 0 ? asked.filter((f) => passed.has(f)) : asked) : asked.filter((f) => passed.has(f) && !failed.has(f));
  const red = [...failed];
  if (green.length === 0 && red.length === 0) return;
  const log = loadLog(root);
  const fps = fingerprints(root, [...new Set([...green, ...red])]);
  const at = now.toISOString();
  for (const f of green) {
    const fp = fps.get(f);
    if (!fp) continue;
    log.files[f] = { ...(log.files[f] ?? {}), lastRun: at, result: "green", fingerprint: fp.fp, greenAt: at, greenFingerprint: fp.fp, verdict: undefined };
  }
  for (const f of red) {
    const fp = fps.get(f);
    if (!fp) continue;
    log.files[f] = { ...(log.files[f] ?? {}), lastRun: at, result: "red", fingerprint: fp.fp };
  }
  for (const f of Object.keys(log.files)) if (!fs.existsSync(path.join(root, f))) delete log.files[f];
  saveLog(root, log);
}

/** Runs the project's tests like runSuite, and logs what happened. */
export async function runSuiteLogged(root: string, files: string[]): Promise<SuiteRun> {
  const r = await runSuite(root, files);
  try {
    recordRun(root, files, r);
  } catch {
    // a log that cannot be written never fails a test run
  }
  return r;
}

/** Tests whose last run was green and whose fingerprint has not changed since: nothing they depend on is different. */
export function unchangedGreen(root: string, tests: string[]): Set<string> {
  const log = loadLog(root);
  const known = tests.map(posix).filter((t) => log.files[t]?.result === "green");
  if (known.length === 0) return new Set();
  const fps = fingerprints(root, known);
  return new Set(known.filter((t) => fps.get(t)?.trusted && fps.get(t)!.fp === log.files[t].greenFingerprint));
}

/**
 * For a phase that changed nothing (it only verifies): every test runs except those the log shows unchanged since their last
 * green run. With an empty log, that is every test.
 */
export function selectUnverified(root: string): { selected: string[]; skipped: string[]; uncertain: string[]; everything: boolean } {
  const all = listTestFiles(root).map(posix);
  const same = unchangedGreen(root, all);
  return { selected: all.filter((t) => !same.has(t)), skipped: all.filter((t) => same.has(t)), uncertain: [], everything: false };
}

/**
 * Tests the log has run before whose dependencies are different now from when they last ran (green or red): an earlier task that
 * stopped mid-edit, an editor that renamed something, a change by hand. A phase selects tests by what IT changed, so these would
 * stay stale until the full suite. A test never logged is not here (nothing says it was ever known), so a first run is not "everything".
 */
export function staleSince(root: string, exclude: string[] = []): string[] {
  const log = loadLog(root);
  const skip = new Set(exclude.map(posix));
  const known = listTestFiles(root).map(posix).filter((t) => log.files[t] && !skip.has(t));
  if (known.length === 0) return [];
  const fps = fingerprints(root, known);
  return known.filter((t) => {
    const f = fps.get(t);
    return !f || !f.trusted || f.fp !== log.files[t].fingerprint;
  });
}

/** The stored diagnosis of a red test, if nothing it depends on has changed since and the healing logic is the same. */
export function verdictFor(root: string, file: string): StoredVerdict | undefined {
  const e = loadLog(root).files[posix(file)];
  const v = e?.verdict;
  if (!v || v.version !== HEAL_LOGIC_VERSION) return undefined;
  const fp = fingerprints(root, [posix(file)]).get(posix(file));
  return fp && fp.fp === v.fingerprint ? v : undefined;
}

export function saveVerdict(root: string, file: string, v: { status: string; note: string; failure?: string }, now = new Date()): void {
  const f = posix(file);
  const log = loadLog(root);
  const fp = fingerprints(root, [f]).get(f);
  if (!fp) return;
  const cur = log.files[f] ?? { lastRun: now.toISOString(), result: "red" as const, fingerprint: fp.fp };
  log.files[f] = { ...cur, verdict: { ...v, failure: v.failure?.slice(-6000), fingerprint: fp.fp, version: HEAL_LOGIC_VERSION, at: now.toISOString() } };
  saveLog(root, log);
}

const stamp = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) : "never");

/** The log as a person reads it. */
export function renderLog(root: string): string {
  const log = loadLog(root);
  const tests = listTestFiles(root).map(posix);
  if (Object.keys(log.files).length === 0) return "No test has been logged yet. Every test run by QA, /tests heal or the end-of-roadmap check is recorded here.";
  const unchanged = unchangedGreen(root, tests);
  const lines: string[] = [];
  let green = 0;
  let stale = 0;
  let red = 0;
  let unknown = 0;
  for (const t of tests) {
    const e = log.files[t];
    if (!e) {
      unknown++;
      lines.push(`  ·  never run      ${t}`);
    } else if (e.result === "red") {
      red++;
      lines.push(`  ✗  red since ${stamp(e.lastRun)}  ${t}${e.verdict ? `  (${e.verdict.status}: ${e.verdict.note.slice(0, 80)})` : ""}`);
    } else if (unchanged.has(t)) {
      green++;
      lines.push(`  ✓  green ${stamp(e.greenAt)}  ${t}`);
    } else {
      stale++;
      lines.push(`  ~  green ${stamp(e.greenAt)}, but something it depends on changed since  ${t}`);
    }
  }
  return [`Test log: ${green} green and unchanged, ${stale} green before a change, ${red} red, ${unknown} never run.`, ...lines].join("\n");
}
