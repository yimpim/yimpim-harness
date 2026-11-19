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

const countOf = (text: string, find: string): number => {
  let n = 0;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) n++;
  return n;
};

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

const SAFE = (rel: string) => !rel.startsWith("..") && !path.isAbsolute(rel) && !/(^|\/)(\.git|\.agent|node_modules)(\/|$)/.test(rel);

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
