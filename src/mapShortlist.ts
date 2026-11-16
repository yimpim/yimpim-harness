/**
 * Discovery used to be handed the repo map and left to search. It would read
 * for dozens of turns, find the files the map already listed, and run out of
 * turns before writing anything down. This ranks the map's entries against the
 * task so Discovery starts from the likely files and confirms them, instead of
 * rediscovering them.
 *
 * It is plain keyword overlap: the task's words against each entry's name,
 * path, exports, summary and, for entries an earlier task confirmed, its
 * symbols and feature (camelCase and snake_case split, simple plurals folded).
 * No model, no project-specific rules, and a wrong guess costs nothing:
 * Discovery is told the list is a starting point, not an answer.
 *
 * Each line says how far to trust it: confirmed by an earlier passing task and
 * unchanged since, or changed since it was written and to be re-read.
 */

import fs from "fs";
import path from "path";
import { FileState, RepoMapEntry, fileState } from "./repoMap.js";

export type MapEntry = RepoMapEntry;

export interface Shortlisted {
  path: string;
  names: string[];
  summary: string;
  score: number;
  /** Set when it was added because a top hit imports it. */
  via?: string;
  state: FileState;
  /** An earlier task that passed QA confirmed this entry. */
  confirmed: boolean;
  symbols: string[];
  feature?: string;
  flow?: string[];
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "have", "has", "had", "not", "are",
  "was", "were", "will", "would", "should", "could", "can", "does", "did", "its", "our", "your", "you", "all", "any", "out",
  "use", "using", "used", "make", "made", "keep", "get", "gets", "set", "add", "new", "one", "two", "also", "only", "but",
  "how", "why", "what", "which", "where", "who", "them", "they", "their", "there", "here", "just", "like", "need", "needs",
  "after", "before", "should", "update", "change", "fix", "show", "shows", "see", "look", "does", "dont", "isnt", "its",
]);

/** Lower-case words, camelCase and snake/kebab split, plurals folded, noise dropped. */
export function words(text: string): string[] {
  const spaced = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase();
  const out: string[] = [];
  for (const w of spaced.split(" ")) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

function fromEntry(name: string, e: MapEntry, score: number, repoRoot?: string, via?: string): Shortlisted {
  return {
    path: e.path,
    names: [name],
    summary: e.summary ?? "",
    score,
    ...(via ? { via } : {}),
    state: repoRoot ? fileState(e, repoRoot) : "unverified",
    confirmed: !!e.confirmedAt,
    symbols: e.symbols ?? [],
    ...(e.feature ? { feature: e.feature } : {}),
    ...(e.flow ? { flow: e.flow } : {}),
  };
}

/** The map's entries ranked by how much of the task they share, best first. */
export function shortlistFromMap(task: string, map: Record<string, MapEntry>, limit = 8, repoRoot?: string): Shortlisted[] {
  const want = new Set(words(task));
  if (want.size === 0) return [];

  const byPath = new Map<string, Shortlisted>();
  for (const [name, entry] of Object.entries(map ?? {})) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    const pathW = new Set(words(entry.path));
    const nameW = new Set(words(name));
    const exportW = new Set(words((entry.exports ?? []).join(" ")));
    const sumW = new Set(words(entry.summary ?? ""));
    const symW = new Set(words((entry.symbols ?? []).join(" ")));
    const featW = new Set(words(entry.feature ?? ""));
    const flowW = new Set(words((entry.flow ?? []).join(" ")));
    let score = 0;
    for (const w of want) {
      if (pathW.has(w)) score += 3;
      if (nameW.has(w)) score += 3;
      if (exportW.has(w)) score += 2;
      if (symW.has(w)) score += 2;
      if (featW.has(w)) score += 2;
      if (sumW.has(w)) score += 1;
      if (flowW.has(w)) score += 1;
    }
    if (score === 0) continue;
    const prev = byPath.get(entry.path);
    if (prev) {
      prev.score += score;
      prev.names.push(name);
      if (entry.summary && !prev.summary.includes(entry.summary)) prev.summary = `${prev.summary} ${entry.summary}`.trim();
      prev.symbols = [...new Set([...prev.symbols, ...(entry.symbols ?? [])])];
      prev.confirmed = prev.confirmed || !!entry.confirmedAt;
      if (!prev.flow && entry.flow) prev.flow = entry.flow;
      if (!prev.feature && entry.feature) prev.feature = entry.feature;
    } else {
      byPath.set(entry.path, fromEntry(name, entry, score, repoRoot));
    }
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

function trustTag(s: Shortlisted): string {
  if (s.state === "changed") return " [CHANGED since it was recorded: re-read it]";
  if (s.state === "fresh" && s.confirmed) return " [confirmed by an earlier task that passed QA; unchanged since]";
  return "";
}

/** The block added to Discovery's prompt; empty when nothing in the map matches. */
export function renderShortlist(list: Shortlisted[]): string {
  if (list.length === 0) return "";
  const lines = list.map((s) => {
    const head = `- ${s.path} (${s.names.slice(0, 4).join(", ")})${s.via ? ` [imported by ${s.via}]` : ""}${trustTag(s)}: ${s.summary.slice(0, 220)}`;
    return s.symbols.length > 0 ? `${head}\n    symbols: ${s.symbols.slice(0, 10).join(", ")}` : head;
  });
  // One flow per feature, from the entry that carries it.
  const flows = new Map<string, string[]>();
  for (const s of list) if (s.flow && s.feature && s.state !== "changed" && !flows.has(s.feature)) flows.set(s.feature, s.flow);
  const flowText =
    flows.size > 0
      ? `\nHow these fit together, as earlier tasks found it:\n${[...flows.entries()].map(([f, steps]) => `- ${f}: ${steps.join(" → ")}`).join("\n")}\n`
      : "";
  const anyConfirmed = list.some((s) => s.state === "fresh" && s.confirmed);
  return (
    `\n\nLIKELY RELEVANT FILES (the repo map's entries ranked by overlap with this task; a starting point, not an answer):\n` +
    `${lines.join("\n")}\n${flowText}` +
    `Start by reading these. Confirm which ones own the change, note the exact symbols, and write taskFindings. ` +
    (anyConfirmed
      ? `For an entry confirmed by an earlier passing task and unchanged since, take its symbols and flow as your starting point and read only the exact parts this task needs; re-read anything marked CHANGED. `
      : "") +
    `Search elsewhere only if they clearly do not.`
  );
}

/**
 * Files a top hit imports, when those are also in the map. A task about what a
 * screen shows rarely names the model or service behind it, but the screen
 * imports it. Read from the source itself, so it works on any language that
 * writes `from "./x"`, `require("./x")` or `import "./x"`.
 */
export function withImportedNeighbors(
  list: Shortlisted[],
  map: Record<string, MapEntry>,
  repoRoot: string,
  topN = 2,
  max = 8
): Shortlisted[] {
  const stripExt = (p: string) => p.replace(/\\/g, "/").replace(/\.[A-Za-z0-9]+$/, "");
  const inMap = new Map<string, { name: string; entry: MapEntry }[]>();
  for (const [name, e] of Object.entries(map ?? {})) {
    if (!e?.path) continue;
    const key = stripExt(e.path);
    inMap.set(key, [...(inMap.get(key) ?? []), { name, entry: e }]);
  }
  const have = new Set(list.map((s) => s.path));
  const extra: Shortlisted[] = [];
  for (const top of list.slice(0, topN)) {
    let src = "";
    try {
      src = fs.readFileSync(path.join(repoRoot, top.path), "utf-8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from\s+|import\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      let bases: string[] = [];
      if (spec.startsWith(".")) bases = [path.posix.normalize(path.posix.join(path.posix.dirname(top.path.replace(/\\/g, "/")), spec))];
      else if (spec.startsWith("@/")) bases = [`src/${spec.slice(2)}`, spec.slice(2)];
      else continue;
      for (const base of bases) {
        for (const key of [base, `${base}/index`]) {
          const hits = inMap.get(key);
          if (!hits) continue;
          const p = hits[0].entry.path;
          if (have.has(p)) continue;
          have.add(p);
          const item = fromEntry(hits[0].name, hits[0].entry, 0, repoRoot, top.path);
          item.names = hits.map((h) => h.name);
          extra.push(item);
        }
      }
      if (extra.length >= max) break;
    }
  }
  return [...list, ...extra.slice(0, max)];
}
