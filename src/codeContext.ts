/**
 * The one layer that reads lines of a project's files for a model: a bounded, numbered range of a file, the parts of a range not yet shown, and the places a piece of
 * text cites ("DashboardScreen.kt:1720-2040", "app/x.tsx:120", "see Foo.kt"). Heal and repair built it; existence, discovery and the planner use the same code, so a place
 * that is cited is read where it is cited, and a place already read is not sent a second time.
 */
import fs from "fs";
import path from "path";

/** A repo-relative path a model may be shown: inside the project, and not git, agent or dependency folders. */
export const SAFE = (rel: string) => !rel.startsWith("..") && !path.isAbsolute(rel) && !/(^|\/)(\.git|\.agent|node_modules)(\/|$)/.test(rel);

/** Lines from..to, each as `12| code` (the number is not part of the code). */
export const numbered = (lines: string[], from: number, to: number): string => {
  const width = String(to).length;
  const rows: string[] = [];
  for (let n = from; n <= to; n++) rows.push(`${String(n).padStart(width)}| ${lines[n - 1]}`);
  return rows.join("\n");
};

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

// ------------------------------------------------------------------------------------------------------------------------ cited places

/** A place a text cites: a file, and the lines it names (none: the file as a whole). */
export interface CodeRef {
  file: string;
  from?: number;
  to?: number;
}

const EXT = "tsx?|jsx?|mjs|cjs|kt|kts|java|swift|py|go|rs|rb|php|cs|cpp|cc|c|h|hpp|m|mm|dart|vue|svelte|gradle|xml|sql|sh|ps1|html|css|scss|ya?ml|toml|md";
const NAME = `[\\w@./\\\\-]*[\\w@-]\\.(?:${EXT})(?![\\w])`;
const DASH = "\\s*[-\\u2013\\u2014]\\s*";
/**
 * The ways a place is cited, written as the people and the models write them:
 *   file.ts:120   file.ts:120:8   file.kt:1720-2040   file.kt:1720–2040   file.ts#L120   file.ts#L120-L130
 *   file.kt lines 1720-2040   file.kt (line 120)   file.kt, L120-130   file.kt (lines 1720 to 2040)   and a bare file name.
 */
const CITE = new RegExp(
  `(${NAME})(?:` +
    `:(\\d+)(?:${DASH}(\\d+))?(?::\\d+)?` + //                                   :120  :120:8  :1720-2040
    `|#L(\\d+)(?:${DASH}L?(\\d+))?` + //                                         #L120  #L120-L130
    `|[\\s,;(]+(?:lines?|ll?\\.?)\\s*(\\d+)(?:(?:${DASH}|\\s+to\\s+)(\\d+))?` + // " lines 1720-2040"  ", L120"
    `)?`,
  "gi"
);

const posix = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Every place `text` cites, in order. Several citations of the same file are kept (each its own range); a file named bare is a citation with no lines. */
export function parseCodeRefs(text: string): CodeRef[] {
  const out: CodeRef[] = [];
  for (const m of text.matchAll(CITE)) {
    const file = posix(m[1]);
    if (!file || path.isAbsolute(file) || file.split("/").some((s) => s === ".." || s === "node_modules" || s === ".git" || s === ".agent") || /^\d+(\.\d+)+$/.test(file)) continue;
    const a = Number(m[2] ?? m[4] ?? m[6]);
    const bRaw = m[3] ?? m[5] ?? m[7];
    if (!Number.isFinite(a) || a < 1) {
      out.push({ file });
      continue;
    }
    const b = bRaw !== undefined ? Number(bRaw) : a;
    out.push({ file, from: Math.min(a, b), to: Math.max(a, b) });
  }
  return out;
}

/**
 * The places that are one place: ranges of the same file that touch or lie within `gap` lines of each other are merged, and a bare file name is dropped when the same file
 * is cited with lines. A file cited with no lines stays as itself.
 */
export function mergeRefs(refs: CodeRef[], gap = 10): CodeRef[] {
  const byFile = new Map<string, CodeRef[]>();
  for (const r of refs) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const out: CodeRef[] = [];
  for (const [file, list] of byFile) {
    const ranged = list.filter((r) => r.from !== undefined).sort((x, y) => x.from! - y.from!);
    if (ranged.length === 0) {
      out.push({ file });
      continue;
    }
    let cur = { ...ranged[0] };
    for (const r of ranged.slice(1)) {
      if (r.from! <= cur.to! + gap) cur.to = Math.max(cur.to!, r.to!);
      else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Cited places made real: a citation that names a path is kept when that file exists; a bare name ("DashboardScreen.kt") is looked up by its last part among the project's files
 * (up to `maxMatches` files, so a name that is everywhere is not a lead). Lines past the end of the file are cut to it; a range wholly past the end becomes the whole file.
 */
export function resolveRefs(refs: CodeRef[], files: { rel: string; lines: number }[], maxMatches = 2): CodeRef[] {
  const byRel = new Map(files.map((f) => [f.rel, f.lines]));
  const out: CodeRef[] = [];
  for (const r of mergeRefs(refs)) {
    const exact = byRel.has(r.file) ? [r.file] : [];
    const matched = exact.length > 0 ? exact : files.filter((f) => f.rel.endsWith(`/${r.file}`)).map((f) => f.rel);
    if (matched.length === 0 || matched.length > maxMatches) continue;
    for (const rel of matched) {
      const total = byRel.get(rel)!;
      if (r.from === undefined || r.from > total) out.push({ file: rel });
      else out.push({ file: rel, from: r.from, to: Math.min(r.to!, total) });
    }
  }
  return mergeRefs(out, 10);
}
