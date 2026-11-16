/**
 * The repo map (`.agent/repo_map.json`) is the project's one memory of where
 * things are. Each entry is a component: its path, a short summary, its
 * exports. This module adds what makes an entry safe to rely on, without a
 * second store:
 *
 *   - a fingerprint (size and modified time) of the file as it was when the
 *     entry was written, so a file that changed since is flagged for every agent;
 *   - for entries a task PASSED QA on: the symbols that matter, the feature it
 *     belongs to, and the flow, with `confirmedAt`. These describe the file as it
 *     was, so they are dropped the moment the file's fingerprint no longer
 *     matches. Updated in place, never appended.
 *
 * Nothing here is a fact to trust. It is a lead that says how old it is.
 */
import fs from "fs";
import path from "path";
import { parseTaskFindingsQuiet } from "./discoveryParsing.js";

export interface RepoMapEntry {
  path: string;
  summary?: string;
  exports?: string[];
  lastUpdated?: number;
  /** The file as it was when this entry was written. */
  size?: number;
  mtimeMs?: number;
  /** Set only from a task that passed QA. */
  confirmedAt?: string;
  symbols?: string[];
  feature?: string;
  flow?: string[];
}

/** Components the map remembers. A file on disk: cheap, so it scales with the project. */
export const DEFAULT_MAX_ENTRIES = 1000;
/** Components pasted into every agent's prompt. Every call pays for these, so it stays small. */
export const DEFAULT_PROMPT_ENTRIES = 50;

export type FileState = "fresh" | "changed" | "missing" | "unverified";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function repoMapPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "repo_map.json");
}

export function loadRepoMap(repoRoot: string): Record<string, RepoMapEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(repoMapPath(repoRoot), "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveRepoMap(repoRoot: string, map: Record<string, RepoMapEntry>): void {
  const file = repoMapPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf-8");
}

export function fingerprintOf(repoRoot: string, rel: string): { size: number; mtimeMs: number } | undefined {
  try {
    const st = fs.statSync(path.join(repoRoot, rel));
    return st.isFile() ? { size: st.size, mtimeMs: Math.round(st.mtimeMs) } : undefined;
  } catch {
    return undefined;
  }
}

/** How the file compares with what the entry was written against. */
export function fileState(entry: RepoMapEntry, repoRoot: string): FileState {
  const now = fingerprintOf(repoRoot, entry.path);
  if (!now) return "missing";
  if (entry.size === undefined || entry.mtimeMs === undefined) {
    // An entry written before fingerprints existed still says WHEN it was
    // written: a file modified after that is newer than what the entry knew.
    if (typeof entry.lastUpdated === "number") return now.mtimeMs > entry.lastUpdated ? "changed" : "fresh";
    return "unverified";
  }
  return now.size === entry.size && now.mtimeMs === entry.mtimeMs ? "fresh" : "changed";
}

/**
 * What an entry becomes when a component is (re)registered. A confirmation
 * (symbols, feature, flow) describes the file as it was, so it survives only if
 * the file is still exactly that file; otherwise it is dropped and the entry
 * starts over as an unconfirmed summary.
 */
export function mergeComponentEntry(
  prev: RepoMapEntry | undefined,
  next: { path: string; summary: string; exports: string[] },
  fp: { size: number; mtimeMs: number } | undefined
): RepoMapEntry {
  const base: RepoMapEntry = { path: next.path, summary: next.summary, exports: next.exports, lastUpdated: Date.now() };
  if (!fp) return base;
  const sameFile = !!prev && prev.path === next.path && prev.size === fp.size && prev.mtimeMs === fp.mtimeMs;
  if (!sameFile) return { ...base, ...fp };
  const kept: Partial<RepoMapEntry> = {};
  if (prev!.confirmedAt) kept.confirmedAt = prev!.confirmedAt;
  if (prev!.symbols) kept.symbols = prev!.symbols;
  if (prev!.feature) kept.feature = prev!.feature;
  if (prev!.flow) kept.flow = prev!.flow;
  return { ...base, ...fp, ...kept };
}

const pascal = (s: string) =>
  s
    .replace(/\.[A-Za-z0-9]+$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

function newKey(map: Record<string, RepoMapEntry>, rel: string): string {
  const parts = rel.split("/");
  const tries = [pascal(parts[parts.length - 1]), pascal(parts.slice(-2).join("-")), pascal(parts.slice(-3).join("-"))];
  for (const k of tries) if (k && !map[k]) return k;
  let n = 2;
  while (map[`${tries[0]}${n}`]) n++;
  return `${tries[0]}${n}`;
}

const clampWords = (s: string, n = 15) => {
  const w = s.trim().split(/\s+/);
  return w.length > n ? w.slice(0, n).join(" ") + "..." : s.trim();
};

/**
 * Called when a task has PASSED. Writes what Discovery worked out into the map,
 * in place: an entry for the file is updated, never duplicated, and a file with
 * no entry gets one. Returns what it recorded, or undefined if nothing
 * trustworthy was there to record.
 */
export function recordConfirmedFindings(
  repoRoot: string,
  task: string,
  discoveryOutput: string,
  maxEntries = DEFAULT_MAX_ENTRIES
): { feature: string; files: number } | undefined {
  const findings = parseTaskFindingsQuiet(discoveryOutput);
  const raw: any[] = Array.isArray(findings?.existingFiles) ? findings.existingFiles : [];
  const files: { path: string; symbols: string[]; role: string; fp: { size: number; mtimeMs: number } }[] = [];
  for (const f of raw) {
    const rel = norm(String(f?.path ?? ""));
    if (!rel || files.some((x) => x.path === rel)) continue;
    const why = String(f?.whyRelevant ?? "");
    // The "files it read" stub from a Discovery that ran out of turns was never worked out.
    if (/^Unconfirmed:/i.test(why)) continue;
    const fp = fingerprintOf(repoRoot, rel);
    if (!fp) continue;
    files.push({
      path: rel,
      symbols: (Array.isArray(f?.symbols) ? f.symbols : []).map((s: any) => String(s).slice(0, 80)).filter(Boolean).slice(0, 12),
      role: (why || String(f?.relevantCode ?? "")).replace(/\s+/g, " "),
      fp,
    });
  }
  if (files.length === 0) return undefined;

  const feature = task.trim().split("\n")[0].replace(/\s+/g, " ").slice(0, 100) || "feature";
  const flow = (Array.isArray(findings?.existingFlow) ? findings.existingFlow : []).map((s: any) => String(s).slice(0, 220)).slice(0, 8);
  const map = loadRepoMap(repoRoot);
  const touched = new Set<string>();
  const now = new Date().toISOString();

  files.slice(0, 20).forEach((f, i) => {
    const key = Object.keys(map).find((k) => map[k]?.path === f.path) ?? newKey(map, f.path);
    const prev = map[key];
    const sameFile = !!prev && prev.size === f.fp.size && prev.mtimeMs === f.fp.mtimeMs;
    const symbols = [...new Set([...(sameFile ? prev.symbols ?? [] : []), ...f.symbols])].slice(0, 16);
    const entry: RepoMapEntry = {
      path: f.path,
      summary: prev?.summary || clampWords(f.role) || f.path,
      exports: prev?.exports && prev.exports.length > 0 ? prev.exports : f.symbols.slice(0, 4),
      lastUpdated: Date.now(),
      ...f.fp,
      confirmedAt: now,
      symbols,
      feature,
    };
    // The flow belongs to the feature, so it lives on one entry (the primary
    // file) and is replaced, not added to, when the feature is learned again.
    if (i === 0 && flow.length > 0) entry.flow = flow;
    map[key] = entry;
    touched.add(key);
  });

  const keys = Object.keys(map);
  if (keys.length > maxEntries) {
    keys
      .filter((k) => !touched.has(k))
      .sort((a, b) => (map[a].lastUpdated ?? 0) - (map[b].lastUpdated ?? 0))
      .slice(0, keys.length - maxEntries)
      .forEach((k) => delete map[k]);
  }
  saveRepoMap(repoRoot, map);
  return { feature, files: touched.size };
}

/**
 * What goes into every agent's system prompt: the lean entry, plus a flag when
 * the file changed since the entry was written. The richer fields stay out, so
 * the prompt does not grow; Discovery gets them through its shortlist.
 */
export function promptView(
  map: Record<string, RepoMapEntry>,
  repoRoot: string,
  limit = DEFAULT_PROMPT_ENTRIES
): Record<string, { path: string; summary?: string; exports?: string[]; stale?: true }> {
  const out: Record<string, { path: string; summary?: string; exports?: string[]; stale?: true }> = {};
  // The most recently updated entries: the part of the project being worked on.
  // The rest is still remembered, and Discovery's shortlist ranks the WHOLE map.
  const recent = Object.entries(map)
    .sort((a, b) => (b[1].lastUpdated ?? 0) - (a[1].lastUpdated ?? 0))
    .slice(0, Math.max(1, limit));
  for (const [k, e] of recent) {
    const view: { path: string; summary?: string; exports?: string[]; stale?: true } = { path: e.path, summary: e.summary, exports: e.exports };
    if (fileState(e, repoRoot) === "changed") view.stale = true;
    out[k] = view;
  }
  return out;
}
