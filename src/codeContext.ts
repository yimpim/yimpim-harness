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

// ------------------------------------------------------------------------------------------------------------------------ the read ledger

/** A cheap fingerprint of a file's content on disk: it changes when the file is written. Undefined when it cannot be read. */
function fingerprint(repoRoot: string, rel: string): string | undefined {
  try {
    const st = fs.statSync(path.join(repoRoot, rel));
    return st.isFile() ? `${st.mtimeMs}:${st.size}` : undefined;
  } catch {
    return undefined;
  }
}

/** The line of a file where a quote begins (1-based), found by its first line; undefined when it is not there. */
export function locateQuote(fileText: string, quote: string): number | undefined {
  const first = quote.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return undefined;
  const lines = fileText.split(/\r?\n/);
  const exact = lines.findIndex((l) => l.trim() === first);
  if (exact >= 0) return exact + 1;
  const part = lines.findIndex((l) => l.includes(first));
  return part >= 0 ? part + 1 : undefined;
}

/** Cited places that name a path which exists in the project (relative, safe): the lines are cut to the file. A bare name is not looked up here. */
export function resolveOnDisk(repoRoot: string, refs: CodeRef[]): CodeRef[] {
  const out: CodeRef[] = [];
  for (const r of mergeRefs(refs)) {
    if (!SAFE(r.file)) continue;
    let total: number;
    try {
      const abs = path.join(repoRoot, r.file);
      if (!fs.statSync(abs).isFile()) continue;
      total = fs.readFileSync(abs, "utf-8").split(/\r?\n/).length;
    } catch {
      continue;
    }
    if (r.from === undefined || r.from > total) out.push({ file: r.file });
    else out.push({ file: r.file, from: r.from, to: Math.min(r.to ?? r.from, total) });
  }
  return out;
}

export interface Injected {
  /** The text for a prompt: each range as `--- file lines a-b of N` and its numbered lines. Empty when nothing was left to show. */
  text: string;
  /** Exactly the ranges whose lines are in `text`. */
  included: { file: string; from: number; to: number }[];
}

/**
 * What each stage of one task (existence, discovery, the planner) has been SHOWN, per file, so a later read of lines already in a conversation sends only the lines that are not.
 *
 * The one rule: a range is recorded for a stage only when its text is in that stage's context: it was returned by a read in that stage's conversation, or it was put in that stage's
 * prompt by `inject`/`forward`. Nothing is ever recorded for a stage on the strength of another stage having read it; `forward` is how another stage's reading reaches it, and it records
 * only what it actually wrote into the prompt (up to the cap), so there is no range a stage believes it has seen and has not.
 *
 * A file that changes on disk is forgotten for every stage: its line numbers mean something else now.
 */
export class ReadLedger {
  private prints = new Map<string, string | undefined>();
  private shown = new Map<string, Map<string, [number, number][]>>();

  constructor(private repoRoot: string) {}

  /** A new conversation for this stage: nothing is in its context yet. */
  begin(stage: string): void {
    this.shown.delete(stage);
  }

  /** Forgets a file for every stage when it has changed on disk since it was last recorded. */
  private fresh(file: string): void {
    const now = fingerprint(this.repoRoot, file);
    if (this.prints.has(file) && this.prints.get(file) !== now) for (const m of this.shown.values()) m.delete(file);
    this.prints.set(file, now);
  }

  private files(stage: string): Map<string, [number, number][]> {
    let m = this.shown.get(stage);
    if (!m) this.shown.set(stage, (m = new Map()));
    return m;
  }

  /** The text of lines a..b of `file` is now in `stage`'s context. */
  record(stage: string, file: string, a: number, b: number): void {
    this.fresh(file);
    const m = this.files(stage);
    m.set(file, mergeSpans([...(m.get(file) ?? []), [a, b]]));
  }

  /** The parts of a..b that `stage` has not been shown (all of it when the file changed since). */
  unseen(stage: string, file: string, a: number, b: number): [number, number][] {
    this.fresh(file);
    return unseenRanges(a, b, this.shown.get(stage)?.get(file) ?? []);
  }

  /** What `stage` has been shown and that is still true of the files on disk. */
  rangesOf(stage: string): Map<string, [number, number][]> {
    const out = new Map<string, [number, number][]>();
    for (const file of [...(this.shown.get(stage)?.keys() ?? [])]) {
      this.fresh(file);
      const r = this.shown.get(stage)?.get(file);
      if (r && r.length > 0) out.set(file, r.map((x) => [...x] as [number, number]));
    }
    return out;
  }

  /**
   * Writes the given places into `stage`'s prompt, from the files as they are NOW, in order, up to `cap` characters, and records exactly what was written. Lines the stage already
   * has are not written again. A range that does not fit is cut at a whole line and only the written part is recorded.
   */
  inject(stage: string, refs: CodeRef[], cap = 8000): Injected {
    const parts: string[] = [];
    const included: Injected["included"] = [];
    let used = 0;
    for (const r of refs) {
      if (used >= cap) break;
      if (!SAFE(r.file)) continue;
      let lines: string[];
      try {
        const abs = path.join(this.repoRoot, r.file);
        if (!fs.statSync(abs).isFile()) continue;
        lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
      } catch {
        continue;
      }
      const a = Math.max(1, r.from ?? 1);
      const b = Math.min(lines.length, r.to ?? (r.from === undefined ? Math.min(lines.length, 120) : r.from));
      if (a > b) continue;
      for (const [s, e] of this.unseen(stage, r.file, a, b)) {
        let end = s - 1;
        let size = 0;
        const rows: string[] = [];
        const width = String(e).length;
        for (let n = s; n <= e; n++) {
          const row = `${String(n).padStart(width)}| ${lines[n - 1].slice(0, 300)}`;
          if (used + size + row.length + 1 > cap) break;
          rows.push(row);
          size += row.length + 1;
          end = n;
        }
        if (rows.length === 0) break;
        parts.push(`--- ${r.file} lines ${s}-${end} of ${lines.length}\n${rows.join("\n")}`);
        used += size + 40;
        this.record(stage, r.file, s, end);
        included.push({ file: r.file, from: s, to: end });
        if (end < e) break;
      }
    }
    return { text: parts.join("\n\n"), included };
  }

  /** What `from` has been shown, written into `to`'s prompt (the files in `prefer` first). Only what is written is recorded for `to`. */
  forward(from: string, to: string, cap = 8000, prefer: string[] = []): Injected {
    const order = [...this.rangesOf(from)];
    const rank = (f: string) => (prefer.includes(f) ? 0 : 1);
    order.sort((x, y) => rank(x[0]) - rank(y[0]));
    return this.inject(to, order.flatMap(([file, spans]) => spans.map(([a, b]) => ({ file, from: a, to: b }))), cap);
  }
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = spans.map((s) => [...s] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}
