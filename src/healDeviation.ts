/**
 * Deviations: where the spec says one thing, the app does another, and the app WORKS. The test follows the working app so progress is not blocked by a
 * label's casing, and the gap from the spec becomes a follow-up ticket instead of a silent change. A defect (the app is wrong in a way that blocks a
 * user, crashes, loses data, or sends or shows wrong functional data) is a different thing: the test is never bent for it.
 *
 * Bending a test is the riskiest thing a heal can do, so nothing here trusts a claim. A deviation is accepted only with evidence that exists in the
 * repository (the app's file:line and the spec's file:line), only if no assertion was removed or weakened, only within a cap on the tests it changes,
 * and only through the same per-test ratchet as every edit (that part is in testHeal.ts). The follow-up ticket is deduplicated by app file and spec.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { isTestPath } from "./focusTests.js";
import { SAFE } from "./healEdits.js";
import { statsOf } from "./benchScore.js";
import { loadRoadmap, saveRoadmap, addUnits } from "./roadmap.js";

const posix = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The most tests one deviation verdict may change, unless heal.sandbox.deviationTestCap says otherwise. */
export const DEFAULT_DEVIATION_TEST_CAP = 12;

export interface DeviationRecord {
  /** The app code the test now follows. */
  appFile: string;
  appLine: number;
  /** Where the spec says otherwise. */
  specFile: string;
  specLine: number;
  /** One sentence: what the spec requires and what the app does instead. */
  summary: string;
}

export type CheckedDeviation = { ok: true; rec: DeviationRecord } | { ok: false; why: string };

/** "src/a.ts:12" or "src/a.ts:12-30" (the first line is taken). Undefined when it is not that shape. */
export function parseRef(ref: string): { file: string; line: number } | undefined {
  const m = /^(.+?):(\d+)(?:\s*[-–]\s*\d+)?$/.exec(String(ref ?? "").trim());
  return m ? { file: posix(m[1].trim()), line: Number(m[2]) } : undefined;
}

/** Every `path:line` in some text (a model's reason), for handing on as citations to check. */
export function refsIn(text: string): string[] {
  const out = new Set<string>();
  // a file extension starts with a letter: "v1.2:3" is a version and a number, not a place
  for (const m of String(text ?? "").matchAll(/(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d{1,6})\b/g)) out.add(`${m[1]}:${m[2]}`);
  return [...out].slice(0, 8);
}

/** The lines of a file inside the project, or undefined when it is not there, not a file, or outside the project. */
function linesOf(root: string, rel: string): string[] | undefined {
  if (!rel || !SAFE(rel)) return undefined;
  try {
    const abs = path.resolve(root, rel);
    if (!(abs + path.sep).startsWith(path.resolve(root) + path.sep)) return undefined;
    if (!fs.statSync(abs).isFile()) return undefined;
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // the newline that ends the file does not start a line
    return lines;
  } catch {
    return undefined;
  }
}

/** Where, in a text file of the project, some words of a requirement appear: their file and line. */
function findRequirement(root: string, words: string): { file: string; line: number } | undefined {
  const needle = words.replace(/\s+/g, " ").trim().slice(0, 40);
  if (needle.length < 12) return undefined;
  try {
    const out = execFileSync("git", ["grep", "-n", "-I", "-i", "-F", "-m", "1", "-e", needle, "--", "*.md", "*.txt", "*.rst"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const m = /^([^:\n]+):(\d+):/m.exec(out);
    return m ? { file: posix(m[1]), line: Number(m[2]) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A deviation as the agent reported it, checked against the project: the app's file:line must exist and be product code (a test is not what the test
 * follows), the spec's file:line must exist and not be a test. A spec given as the requirement's own words instead of a line must be found in a
 * markdown or text file of the project, and then it has a file and a line like the other kind. Anything else is refused, with the reason.
 */
export function validateDeviation(root: string, raw: { app?: unknown; spec?: unknown; summary?: unknown }): CheckedDeviation {
  const summary = String(raw.summary ?? "").replace(/\s+/g, " ").trim();
  if (summary.length < 10) return { ok: false, why: "summary: say in a sentence what the spec requires and what the app does instead" };

  const app = parseRef(String(raw.app ?? ""));
  if (!app) return { ok: false, why: `app: give the app's code as path:line (for example src/components/X.tsx:120), not "${String(raw.app ?? "").slice(0, 60)}"` };
  if (isTestPath(app.file)) return { ok: false, why: `app: ${app.file} is a test file; give the app code the test now follows` };
  const appLines = linesOf(root, app.file);
  if (!appLines) return { ok: false, why: `app: ${app.file} does not exist in the project` };
  if (app.line < 1 || app.line > appLines.length) return { ok: false, why: `app: ${app.file} has ${appLines.length} lines, so line ${app.line} does not exist` };

  const specRaw = String(raw.spec ?? "").trim();
  let spec = parseRef(specRaw);
  if (!spec) {
    // not a path:line: the requirement's own words, which must really be in a document of the project
    const found = specRaw.length >= 20 ? findRequirement(root, specRaw) : undefined;
    if (!found) return { ok: false, why: `spec: give the spec's place as path:line (for example docs/SPEC.md:461), or its own words (20+ characters) that appear in a .md/.txt file of the project` };
    spec = found;
  }
  if (isTestPath(spec.file)) return { ok: false, why: `spec: ${spec.file} is a test file, which is not a spec` };
  const specLines = linesOf(root, spec.file);
  if (!specLines) return { ok: false, why: `spec: ${spec.file} does not exist in the project` };
  if (spec.line < 1 || spec.line > specLines.length) return { ok: false, why: `spec: ${spec.file} has ${specLines.length} lines, so line ${spec.line} does not exist` };
  if (spec.file.toLowerCase() === app.file.toLowerCase() && spec.line === app.line) return { ok: false, why: "spec and app point at the same line" };

  return { ok: true, rec: { appFile: app.file, appLine: app.line, specFile: spec.file, specLine: spec.line, summary: summary.slice(0, 300) } };
}

/** What identifies one deviation, so the same one found again (another run, another test in the file) is one ticket: the app file and the spec place. */
export function deviationKey(rec: DeviationRecord): string {
  return `${rec.appFile.toLowerCase()}|${rec.specFile.toLowerCase()}:${rec.specLine}`;
}

export function describeDeviation(rec: DeviationRecord): string {
  return `app ${rec.appFile}:${rec.appLine} vs spec ${rec.specFile}:${rec.specLine}: ${rec.summary}`;
}

// ------------------------------------------------------------------------------------------------------------------------ what a bent test may not do

const ASSERTION_LINE = /\bexpect\s*\(|\bassert\w*\s*[.(]|\bself\.assert/;

const lineCounts = (text: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of text.split(/\r?\n/)) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

/**
 * Why a test that was changed to follow the app is refused for REMOVING checks, or undefined. A model can make a test pass by deleting what it checks,
 * so for a deviation the file must still have every assertion, none may be removed without a replacement, and none may become one that cannot fail.
 */
export function deviationGutting(before: string, after: string): string | undefined {
  const a = statsOf(before);
  const b = statsOf(after);
  if (b.asserts < a.asserts) return `it has ${b.asserts} expect(...) calls where there were ${a.asserts}: update what is expected, do not remove a check`;
  const was = lineCounts(before);
  const now = lineCounts(after);
  let removed = 0;
  let added = 0;
  for (const [l, c] of was) if (ASSERTION_LINE.test(l)) removed += Math.max(0, c - (now.get(l) ?? 0));
  for (const [l, c] of now) if (ASSERTION_LINE.test(l)) added += Math.max(0, c - (was.get(l) ?? 0));
  if (removed > added) return `it removes ${removed - added} assertion line${removed - added === 1 ? "" : "s"} without replacing ${removed - added === 1 ? "it" : "them"}`;
  if (b.weak > a.weak) return "it replaces specific assertions with ones that cannot fail (toBeDefined, toBeTruthy ...)";
  return undefined;
}

const TEST_START = /^\s*(?:it|test)(?:\.(?:only|skip|each))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/** The text of each test, by its title (a repeated title is numbered). Lines before the first test are a block of their own: "(setup)". */
function testBlocks(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const starts: { i: number; title: string }[] = [];
  const seen = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = TEST_START.exec(l);
    if (!m) return;
    const n = (seen.get(m[2]) ?? 0) + 1;
    seen.set(m[2], n);
    starts.push({ i, title: n === 1 ? m[2] : `${m[2]} #${n}` });
  });
  const out = new Map<string, string>();
  // trailing whitespace is trimmed so that a test is "the same" whether or not another one follows it (the last one would otherwise carry the file's final blank line)
  const tidy = (s: string) => s.replace(/\s+$/, "");
  if (starts.length === 0) return out.set("(setup)", tidy(text));
  out.set("(setup)", tidy(lines.slice(0, starts[0].i).join("\n")));
  starts.forEach((s, k) => out.set(s.title, tidy(lines.slice(s.i, starts[k + 1]?.i ?? lines.length).join("\n"))));
  return out;
}

/**
 * How many tests a change touches: tests whose text differs, tests that appear or disappear, and the setup above the first test as one more. Approximate
 * (a helper between two tests belongs to the one before it), but it is the number the cap on a deviation is judged by.
 */
export function testsModified(before: string, after: string): number {
  const a = testBlocks(before);
  const b = testBlocks(after);
  let n = 0;
  for (const [title, body] of a) if (b.get(title) !== body) n++;
  for (const title of b.keys()) if (!a.has(title)) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------------------------------ the follow-up ticket

/** The title is built from the dedup key alone, so the same deviation is always the same title and `addUnits` merges it instead of adding a second. */
export function deviationTitle(rec: DeviationRecord): string {
  const h = crypto.createHash("sha1").update(deviationKey(rec)).digest("hex").slice(0, 6);
  return `Match the spec: ${path.posix.basename(rec.appFile)} vs ${path.posix.basename(rec.specFile)}:${rec.specLine} [${h}]`;
}

const AREA = "Spec deviations";

/**
 * Adds a follow-up ticket for each accepted deviation, when the project has a roadmap. The spec's own line is the acceptance criterion. A deviation
 * already in the roadmap (same app file and spec place, whatever its state) is left alone, so repeated runs and several tests in one file never
 * add a second ticket. Returns what happened, one line per deviation. Never throws: a roadmap that cannot be written must not fail a heal.
 */
export function emitDeviationUnits(repoRoot: string, recs: DeviationRecord[]): string[] {
  const out: string[] = [];
  if (recs.length === 0) return out;
  try {
    const rm = loadRoadmap(repoRoot);
    if (!rm) return out; // no roadmap: the report is where it is recorded
    const seen = new Set<string>();
    let changed = false;
    for (const rec of recs) {
      const k = deviationKey(rec);
      if (seen.has(k)) continue;
      seen.add(k);
      const title = deviationTitle(rec);
      const existing = rm.units.find((u) => u.title === title && u.area === AREA);
      if (existing) {
        out.push(`already tracked as ${existing.id}: ${path.posix.basename(rec.appFile)} vs ${rec.specFile}:${rec.specLine}`);
        continue;
      }
      const quote = (linesOf(repoRoot, rec.specFile)?.[rec.specLine - 1] ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      const res = addUnits(
        rm,
        [
          {
            title,
            area: AREA,
            summary: `${rec.summary} The test was changed to match what the app does today (${rec.appFile}:${rec.appLine}); this ticket brings the app to the spec.`,
            refs: [rec.appFile, rec.specFile],
            acceptance: [`${rec.specFile}:${rec.specLine} holds${quote ? `: "${quote}"` : ""}`, "Then change the test back to expect the specified behaviour, and it passes"],
          },
        ],
        "plan",
      );
      changed = changed || res.added.length > 0;
      out.push(res.added.length > 0 ? `follow-up ticket added: ${title}` : `not added: ${res.warnings[0] ?? res.skipped[0] ?? "unknown reason"}`);
    }
    if (changed) saveRoadmap(repoRoot, rm);
  } catch (e: any) {
    out.push(`follow-up ticket not added: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  return out;
}
