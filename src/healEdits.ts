/**
 * What a heal worker needs to change a few lines of a big file without rewriting all of it, and to look around without being handed
 * everything: find-and-replace edits, a large file shown in pieces, a line range on request, and a search of the repository.
 *
 * Returning a whole corrected file made the answer as long as the file: for a 3,400-line test, tens of thousands of tokens to add two
 * lines, minutes of waiting, and a dropped connection. An edit is a few lines.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { excerptAround, type Digest } from "./failureDigest.js";
import { isTestPath } from "./focusTests.js";

const execFileAsync = promisify(execFile);

/** Past this many lines a file is shown in parts and must be changed with edits. */
export const LARGE_FILE_LINES = 400;

export interface Edit {
  find: string;
  replace: string;
}

export function parseEdits(v: unknown): Edit[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: Edit[] = [];
  for (const e of v) {
    if (!e || typeof (e as any).find !== "string" || typeof (e as any).replace !== "string" || !(e as any).find) return undefined;
    out.push({ find: (e as any).find.replace(/\r\n/g, "\n"), replace: (e as any).replace.replace(/\r\n/g, "\n") });
  }
  return out;
}

export const countOf = (text: string, find: string): number => {
  let n = 0;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) n++;
  return n;
};

/**
 * Applies each edit on its own: one that does not match (or matches more than one place) is SKIPPED and reported, and every other edit is
 * applied. A batch of thirteen good edits is not thrown away because the tenth is ambiguous. Whether the result is any good is not decided
 * here: the test run and the made-it-worse check decide that.
 */
export function applyEditsLenient(
  content: string,
  edits: Edit[],
  /**
   * For each replacement this worker has had applied: how many copies of it the file must hold for the change to still be in. That is the number the
   * file had BEFORE the first such edit, plus one per time it was applied, so a copy of the same line that was always elsewhere in the file cannot make a
   * reverted or never-applied edit look applied.
   */
  required: ReadonlyMap<string, number> = new Map()
): { text: string; applied: number; already: number; required: Map<string, number>; skipped: { n: number; find: string; error: string }[] } {
  let text = content.replace(/\r\n/g, "\n");
  let applied = 0;
  let already = 0;
  const req = new Map(required);
  const skipped: { n: number; find: string; error: string }[] = [];
  for (const [i, e] of edits.entries()) {
    const count = countOf(text, e.find);
    if (count === 0) {
      // Its text is gone because THIS worker's earlier answer already made that same change: an edit sent again, not one that failed. It counts only if
      // the file holds as many copies of the replacement as that change accounts for (see `required`); a copy elsewhere in the file proves nothing.
      const need = req.get(e.replace);
      if (e.replace.trim().length > 0 && e.find !== e.replace && need !== undefined && countOf(text, e.replace) >= need) {
        already++;
        continue;
      }
      skipped.push({ n: i + 1, find: e.find.slice(0, 160), error: `edit ${i + 1}: the text to find was not found (copy it exactly as it is in the file, without the line-number prefix).` });
      continue;
    }
    if (count > 1) {
      skipped.push({ n: i + 1, find: e.find.slice(0, 160), error: `edit ${i + 1}: the text to find matches ${count} places (include more of the surrounding lines so it matches exactly once).` });
      continue;
    }
    const at = text.indexOf(e.find);
    const before = req.get(e.replace) ?? countOf(text, e.replace);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
    applied++;
    req.set(e.replace, before + 1);
  }
  return { text, applied, already, required: req, skipped };
}

/** Applies the edits in order. Each must match exactly once; if any does not, nothing is applied and the reply says which and why. */
export function applyEdits(content: string, edits: Edit[]): { ok: true; text: string } | { ok: false; error: string } {
  let text = content.replace(/\r\n/g, "\n");
  for (const [i, e] of edits.entries()) {
    const n = countOf(text, e.find);
    if (n === 0) {
      return {
        ok: false,
        error:
          `edit ${i + 1}: the text to find was not found. Copy it exactly as it is in the file, without the line-number prefix, ` +
          `or ask to see the lines first with {"need":[{"path":"<file>","from":N,"to":M}]}.`,
      };
    }
    if (n > 1) return { ok: false, error: `edit ${i + 1}: the text to find matches ${n} places. Include more of the surrounding lines so it matches exactly once.` };
    const at = text.indexOf(e.find);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return { ok: true, text };
}

const numbered = (lines: string[], from: number, to: number): string => {
  const width = String(to).length;
  const rows: string[] = [];
  for (let n = from; n <= to; n++) rows.push(`${String(n).padStart(width)}| ${lines[n - 1]}`);
  return rows.join("\n");
};

const OUTLINE = /^\s*(?:describe|it|test|context|suite|beforeEach|beforeAll|afterEach|afterAll)\b.*[(`'"]|^\s*def test_|^\s*func Test|^\s*@Test|^\s*fun\s+[`\w]|^\s*(?:public |private )?(?:void|async def)\s+test/;

/** A large file in parts: its top (imports, mocks, setup), the regions the failure points at, and an outline, all with line numbers. */
export function presentLargeFile(original: string, file: string, digest: Digest | undefined, repoRoot: string): string {
  const lines = original.split(/\r?\n/);
  const out: string[] = [
    `LARGE FILE: ${file} has ${lines.length} lines, so it is shown in parts, numbered ("12| code"; the number is not part of the code). ` +
      `Change it with "edits". To see any other lines ask {"need":[{"path":"${file}","from":N,"to":M}]}.`,
    `\n--- lines 1-${Math.min(160, lines.length)} (imports, mocks, setup)`,
    numbered(lines, 1, Math.min(160, lines.length)),
  ];
  let printed = Math.min(160, lines.length);
  const spots = (digest?.clusters ?? []).flatMap((c) => [c.testFrame, c.frame]).filter((f): f is { file: string; line: number } => !!f && f.file === file);
  for (const s of [...new Set(spots.map((f) => f.line))].sort((a, b) => a - b)) {
    const from = Math.max(printed + 1, s - 30);
    const to = Math.min(lines.length, s + 30);
    if (from > to) continue;
    out.push(`\n--- lines ${from}-${to} (around line ${s}, where the failure points)`, numbered(lines, from, to));
    printed = to;
  }
  const outline = lines
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => OUTLINE.test(l))
    .slice(0, 150)
    .map(([n, l]) => `${n}: ${l.trim().slice(0, 110)}`);
  if (outline.length > 0) out.push(`\n--- outline (line: declaration)`, outline.join("\n"));
  void repoRoot;
  return out.join("\n");
};

export const SAFE = (rel: string) => !rel.startsWith("..") && !path.isAbsolute(rel) && !/(^|\/)(\.git|\.agent|node_modules)(\/|$)/.test(rel);

/** Lines `from..to` of a repository file, numbered. Undefined when the file is missing or off limits. */
export function readRange(repoRoot: string, relRaw: string, from = 1, to = from + 199): string | undefined {
  const rel = relRaw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!SAFE(rel)) return undefined;
  try {
    const abs = path.join(repoRoot, rel);
    if (!fs.statSync(abs).isFile()) return undefined;
    const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
    const a = Math.max(1, Math.floor(Number(from)) || 1);
    const b = Math.min(lines.length, Math.max(a, Math.floor(Number(to)) || a + 199), a + 399);
    return `--- ${rel} lines ${a}-${b} of ${lines.length}\n${numbered(lines, a, b)}`;
  } catch {
    return undefined;
  }
}

/** A literal search of the repository's tracked files: where a name is defined, used or mocked. */
export async function searchRepo(repoRoot: string, pattern: string): Promise<string> {
  const p = String(pattern ?? "").trim().slice(0, 200);
  if (p.length < 2) return "(search text too short)";
  try {
    const { stdout } = await execFileAsync("git", ["grep", "-n", "-I", "-F", "--max-count=4", "-e", p], { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 });
    const rows = stdout.split(/\r?\n/).filter(Boolean).slice(0, 50).map((l) => l.slice(0, 220));
    return rows.length ? `--- search "${p}"\n${rows.join("\n")}` : `--- search "${p}"\n(no matches)`;
  } catch (e: any) {
    return `--- search "${p}"\n${e?.code === 1 ? "(no matches)" : "(the search could not run)"}`;
  }
}

export { excerptAround };

// ------------------------------------------------------------------------------------------------------------------------------ probe

export type RunTests = (root: string, files: string[]) => Promise<{ ok: boolean; output: string }>;

/**
 * Reads a value at run time the way a person does: a throwaway COPY of the test with one console.log inserted before a line, run once, and
 * deleted. The real test file is never touched. `log` is a single expression, so a probe can look at a value and cannot do anything else.
 */
export async function runProbe(run: RunTests, repoRoot: string, spec: { file?: unknown; before?: unknown; log?: unknown }): Promise<string> {
  const rel = String(spec.file ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const before = String(spec.before ?? "").trim();
  const log = String(spec.log ?? "").trim();
  const head = `--- probe ${rel} before "${before.slice(0, 60)}" (printing ${log.slice(0, 80)})`;
  if (!rel || !SAFE(rel) || !isTestPath(rel)) return `${head}\n(probe refused: it needs a test file inside the project)`;
  if (!before || before.length > 200) return `${head}\n(probe refused: "before" must be the text of one line, up to 200 characters)`;
  if (!log || log.length > 300 || /[;\n\r`]/.test(log)) return `${head}\n(probe refused: "log" must be a single expression, with no semicolon, backtick or line break)`;
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
  } catch {
    return `${head}\n(probe refused: ${rel} cannot be read)`;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(before));
  if (at < 0) return `${head}\n(probe found no line containing that text)`;
  const indent = /^\s*/.exec(lines[at])?.[0] ?? "";
  lines.splice(at, 0, `${indent}console.log('PROBE', ${log});`);
  const copyRel = posixJoin(path.posix.dirname(rel), `zz_probe_${Date.now().toString(36)}_${path.posix.basename(rel)}`);
  const copyAbs = path.join(repoRoot, copyRel);
  try {
    fs.writeFileSync(copyAbs, lines.join(eol));
    const result = await run(repoRoot, [copyRel]);
    const printed = [...new Set(result.output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^PROBE\b/.test(l)))].slice(0, 12);
    if (printed.length === 0) return `${head}\n(the probe printed nothing: that line was not reached, or the expression threw)`;
    return `${head}\n${printed.join("\n")}`;
  } finally {
    try {
      fs.rmSync(copyAbs, { force: true });
    } catch {
      // a leftover copy is skipped by the test listing, and removed with the project's temp files
    }
  }
}

const posixJoin = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);

// ------------------------------------------------------------------------------------------------------------------------ lines already shown
/** The parts of lines a..b that are NOT inside any of the ranges already shown, in order. Empty when all of it has been seen. */
export function unseenRanges(a: number, b: number, shown: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  let at = a;
  for (const [s, e] of [...shown].sort((x, y) => x[0] - y[0])) {
    if (e < at) continue;
    if (s > b) break;
    if (s > at) out.push([at, s - 1]);
    at = Math.max(at, e + 1);
    if (at > b) break;
  }
  if (at <= b) out.push([at, b]);
  return out;
}
