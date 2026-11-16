/**
 * Keeps the repo map true to the code, whatever happened to the code.
 *
 * A fingerprint says a file changed. It does not say where a function went, and
 * the ways code changes are not a short list: a function moved, renamed or
 * deleted; a file renamed, split into several, merged into one, or deleted; a
 * method moved to another class; a new file added; an edit made by hand outside
 * this tool. So there is one rule, not one rule per case:
 *
 *     re-derive the entry from the source, and for every symbol it recorded
 *     that is no longer in its file, find out where that symbol lives now.
 *
 * Where it lives now comes from the code itself (a declaration scan of the
 * changed files, then a project-wide search for the name), never from a model.
 * What cannot be established is dropped, not guessed: a name declared in many
 * places is ambiguous and is not relocated, and a language this does not read is
 * only re-stamped, never reinterpreted.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { isSourceCodePath } from "./focusTests.js";
import { DEFAULT_MAX_ENTRIES, RepoMapEntry, fileState, fingerprintOf, loadRepoMap, saveRepoMap } from "./repoMap.js";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "try", "return", "new", "function", "constructor", "super", "this",
  "await", "yield", "with", "when", "match", "case", "default", "get", "set", "of", "in", "is", "as", "fn", "def", "end",
]);

type Lang = "js" | "py" | "kt" | "java" | "cs" | "go" | "rs" | "swift" | "rb" | "php";

const EXT: Record<string, Lang> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  py: "py", kt: "kt", kts: "kt", java: "java", cs: "cs", go: "go", rs: "rs", swift: "swift", rb: "rb", php: "php",
};

export function languageOf(rel: string): Lang | undefined {
  return EXT[(rel.split(".").pop() ?? "").toLowerCase()];
}

const RULES: Record<Lang, RegExp[]> = {
  js: [
    /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm,
    /^[ \t]+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(?::[^{;=\n]+)?\{/gm,
  ],
  py: [/^[ \t]*(?:async\s+)?def\s+(\w+)/gm, /^[ \t]*class\s+(\w+)/gm],
  kt: [/^[ \t]*(?:[\w@]+\s+)*?(?:fun|class|object|interface)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/gm],
  java: [
    /^[ \t]*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/gm,
    /^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w<>\[\],?. ]+?\s+(\w+)\s*\([^)\n]*\)\s*(?:throws [\w, .]+)?\s*\{/gm,
  ],
  cs: [
    /^[ \t]*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|enum|record|struct)\s+(\w+)/gm,
    /^[ \t]*(?:(?:public|private|protected|internal|static|override|virtual|async|abstract)\s+)+[\w<>\[\],?. ]+?\s+(\w+)\s*\([^)\n]*\)\s*\{/gm,
  ],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm, /^type\s+(\w+)\s/gm],
  rs: [/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/gm],
  swift: [/^[ \t]*(?:[\w@()]+\s+)*(?:func|class|struct|enum|protocol|extension)\s+(\w+)/gm],
  rb: [/^[ \t]*(?:def|class|module)\s+(?:self\.)?(\w+)/gm],
  php: [/^[ \t]*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait)\s+(\w+)/gm],
};

/**
 * The names a source file declares, or undefined for a language this does not
 * read (the caller must then leave the entry's symbols alone, not empty them).
 */
export function extractDeclaredSymbols(source: string, rel: string): string[] | undefined {
  const lang = languageOf(rel);
  if (!lang) return undefined;
  const out = new Set<string>();
  const text = source.slice(0, 400_000);
  for (const re of RULES[lang]) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name && name.length >= 2 && !KEYWORDS.has(name) && !(lang === "py" && name.startsWith("__"))) out.add(name);
    }
  }
  if (lang === "js") {
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const exported = part.trim().split(/\s+as\s+/i).pop()?.trim();
        if (exported && /^[A-Za-z_$][\w$]*$/.test(exported) && !KEYWORDS.has(exported)) out.add(exported);
      }
    }
  }
  return [...out];
}

export interface SyncOptions {
  /** Files a task just changed (paths relative to the repo root). */
  touched?: string[];
  /** True when QA passed on these changes, so a confirmation may be kept for them. */
  viaTask?: boolean;
  /** What to call a brand-new source file a task added to the map. */
  addNew?: string;
  maxEntries?: number;
}

export interface SyncResult {
  restamped: number;
  removed: string[];
  renamed: { from: string; to: string }[];
  moved: { symbol: string; from: string; to: string }[];
  added: string[];
  /** Recorded names that exist nowhere now, or in too many places to say which. */
  dropped: { symbol: string; from: string }[];
}

const AMBIGUOUS_OVER = 3;
const MAX_SYMBOLS = 40;

export function syncRepoMap(repoRoot: string, opts: SyncOptions = {}): SyncResult {
  const res: SyncResult = { restamped: 0, removed: [], renamed: [], moved: [], added: [], dropped: [] };
  const map = loadRepoMap(repoRoot);
  const touched = new Set((opts.touched ?? []).map(norm).filter(Boolean));

  const declCache = new Map<string, string[] | undefined>();
  const declaredIn = (rel: string): string[] | undefined => {
    if (declCache.has(rel)) return declCache.get(rel);
    let d: string[] | undefined;
    try {
      const full = path.join(repoRoot, rel);
      if (fs.statSync(full).isFile()) d = extractDeclaredSymbols(fs.readFileSync(full, "utf-8"), rel);
    } catch {
      d = undefined;
    }
    declCache.set(rel, d);
    return d;
  };

  const grepCache = new Map<string, string[]>();
  const grepFiles = (symbol: string): string[] => {
    if (grepCache.has(symbol)) return grepCache.get(symbol)!;
    let files: string[] = [];
    try {
      const out = execFileSync("git", ["grep", "-l", "-w", "-F", "--untracked", "-I", "-e", symbol], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      files = out.split(/\r?\n/).map((l) => norm(l.trim())).filter(Boolean);
    } catch {
      files = []; // not a git repo, no match, or git unavailable: the scan of changed files still applies
    }
    grepCache.set(symbol, files);
    return files;
  };

  /** Where a name is declared now. More than a few places means we cannot say which. */
  const locCache = new Map<string, string[]>();
  const locate = (symbol: string): string[] => {
    if (locCache.has(symbol)) return locCache.get(symbol)!;
    const found = new Set<string>();
    for (const rel of touched) if (declaredIn(rel)?.includes(symbol)) found.add(rel);
    for (const rel of grepFiles(symbol)) {
      if (found.has(rel) || !isSourceCodePath(rel) || !languageOf(rel)) continue;
      if (declaredIn(rel)?.includes(symbol)) found.add(rel);
    }
    const list = [...found];
    locCache.set(symbol, list);
    return list;
  };

  const entryKeyFor = (rel: string) => Object.keys(map).find((k) => norm(map[k].path) === rel);
  const keyFor = (rel: string): string => {
    const parts = rel.split("/");
    const pascal = (s: string) =>
      s.replace(/\.[A-Za-z0-9]+$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    for (const k of [pascal(parts[parts.length - 1]), pascal(parts.slice(-2).join("-")), pascal(parts.slice(-3).join("-"))]) {
      if (k && !map[k]) return k;
    }
    let n = 2;
    const base = pascal(parts[parts.length - 1]) || "Component";
    while (map[`${base}${n}`]) n++;
    return `${base}${n}`;
  };

  const lost: { symbol: string; from: string }[] = [];
  const touchedKeys = new Set<string>();
  const now = Date.now();

  // 1. Re-derive every entry whose file changed, vanished, or was just edited.
  for (const key of Object.keys(map)) {
    const e = map[key];
    let p = norm(e.path);
    const state = fileState(e, repoRoot);
    if (!(state === "changed" || state === "missing" || touched.has(p))) continue;
    const prev = [...new Set([...(e.symbols ?? []), ...(e.exports ?? [])])];

    if (state === "missing") {
      // Renamed or moved wholesale? Then most of its symbols now live in one other file.
      const homes = new Map<string, number>();
      for (const s of prev) {
        const where = locate(s);
        if (where.length > 0 && where.length <= AMBIGUOUS_OVER) for (const w of where) homes.set(w, (homes.get(w) ?? 0) + 1);
      }
      const best = [...homes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && prev.length > 0 && best[1] / prev.length >= 0.5 && !entryKeyFor(best[0])) {
        res.renamed.push({ from: p, to: best[0] });
        e.path = best[0];
        p = best[0];
      } else {
        delete map[key];
        res.removed.push(p);
        for (const s of prev) lost.push({ symbol: s, from: p });
        continue;
      }
    }

    const decl = declaredIn(p);
    const fp = fingerprintOf(repoRoot, p);
    if (decl !== undefined) {
      for (const s of prev) if (!decl.includes(s)) lost.push({ symbol: s, from: p });
      e.symbols = decl.slice(0, MAX_SYMBOLS);
      const keep = (e.exports ?? []).filter((s) => decl.includes(s));
      e.exports = (keep.length > 0 ? keep : decl).slice(0, 4);
    }
    if (fp) Object.assign(e, fp);
    e.lastUpdated = now;
    // A confirmation, and the flow it came with, described the code BEFORE this
    // change. QA passing on the task keeps the confirmation; the flow is no
    // longer verified either way. An edit nobody validated confirms nothing.
    if (opts.viaTask && touched.has(p)) {
      delete e.flow;
    } else {
      delete e.confirmedAt;
      delete e.feature;
      delete e.flow;
    }
    touchedKeys.add(key);
    res.restamped++;
  }

  // 2. Every name that left its file: find where it lives now.
  const seen = new Set<string>();
  for (const { symbol, from } of lost) {
    const id = `${symbol}\u0000${from}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const all = locate(symbol);
    const targets = all.filter((f) => f !== from);
    if (all.length > AMBIGUOUS_OVER || targets.length === 0) {
      res.dropped.push({ symbol, from });
      continue;
    }
    for (const t of targets) {
      let key = entryKeyFor(t);
      if (!key) {
        const fp = fingerprintOf(repoRoot, t);
        if (!fp) continue;
        key = keyFor(t);
        map[key] = {
          path: t,
          summary: `Declares ${symbol} (moved from ${from})`,
          exports: [symbol],
          symbols: (declaredIn(t) ?? [symbol]).slice(0, MAX_SYMBOLS),
          lastUpdated: now,
          ...fp,
        };
        res.added.push(t);
      } else {
        const e = map[key];
        e.symbols = [...new Set([...(e.symbols ?? []), symbol])].slice(0, MAX_SYMBOLS);
        if ((e.exports ?? []).length < 4 && !(e.exports ?? []).includes(symbol)) e.exports = [...(e.exports ?? []), symbol];
        e.lastUpdated = now;
      }
      touchedKeys.add(key);
      res.moved.push({ symbol, from, to: t });
    }
  }

  // 3. A source file a task just added belongs in the map too.
  if (opts.addNew) {
    for (const t of touched) {
      if (entryKeyFor(t) || !isSourceCodePath(t) || !languageOf(t)) continue;
      const decl = declaredIn(t);
      const fp = fingerprintOf(repoRoot, t);
      if (!decl || decl.length === 0 || !fp) continue;
      const key = keyFor(t);
      map[key] = {
        path: t,
        summary: opts.addNew.split(/\s+/).slice(0, 15).join(" "),
        exports: decl.slice(0, 4),
        symbols: decl.slice(0, MAX_SYMBOLS),
        lastUpdated: now,
        ...fp,
        ...(opts.viaTask ? { confirmedAt: new Date().toISOString() } : {}),
      };
      touchedKeys.add(key);
      res.added.push(t);
    }
  }

  const changed = res.restamped + res.removed.length + res.moved.length + res.added.length + res.renamed.length > 0;
  if (!changed) return res;

  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const keys = Object.keys(map);
  if (keys.length > max) {
    keys
      .filter((k) => !touchedKeys.has(k))
      .sort((a, b) => (map[a].lastUpdated ?? 0) - (map[b].lastUpdated ?? 0))
      .slice(0, keys.length - max)
      .forEach((k) => delete map[k]);
  }
  saveRepoMap(repoRoot, map);
  return res;
}

/** One line per thing that happened, for the log; empty when nothing did. */
export function describeSync(r: SyncResult): string[] {
  const out: string[] = [];
  for (const m of r.moved.slice(0, 8)) out.push(`${m.symbol} moved from ${m.from} to ${m.to}`);
  for (const m of r.renamed.slice(0, 4)) out.push(`${m.from} is now ${m.to}`);
  for (const p of r.removed.slice(0, 4)) out.push(`${p} was deleted`);
  for (const p of r.added.slice(0, 4)) out.push(`${p} added to the map`);
  const dropped = r.dropped.length;
  if (dropped > 0) out.push(`${dropped} recorded name(s) no longer exist or are too ambiguous to follow`);
  return out;
}

// Re-exported so one import serves callers that also need the entry type.
export type { RepoMapEntry };
