/**
 * Keeps the persistent per-repo memory (.agent/codebase-memory.json) honest
 * about the disk it describes.
 *
 * The memory is free text the agents wrote on earlier runs. Nothing ever
 * checked it against the repo afterwards, so it kept describing files that were
 * moved or deleted, and one run's misdiagnosis ("this directory is BLOCKED",
 * written when it was merely missing) was handed to every later Discovery and
 * Planner as fact. This runs every time memory is loaded:
 *
 *  - an entry naming files or folders that no longer exist is marked STALE
 *    (or, when only some are gone, annotated with which), so the agents read it
 *    as "was true earlier", not as a fact;
 *  - an entry claiming a directory is blocked/inaccessible is checked against
 *    the disk and the harness's real block list: if the directory is missing the
 *    entry is rewritten to say missing, if it is readable and not blocked the
 *    entry is dropped as contradicted.
 *
 * Idempotent: markers added here are stripped and recomputed on the next load,
 * so an entry whose files come back stops being marked.
 */

import fs from "node:fs";
import path from "node:path";

export interface MemoryText {
  architectureRules: string[];
  liveRules: string[];
  historicalPitfalls: string[];
}

export interface MemoryReconcileStats {
  /** Entries marked or annotated because files they name are gone. */
  staleMarked: number;
  /** "Blocked directory" entries rewritten because the directory is just missing. */
  rewrittenMissing: number;
  /** "Blocked directory" entries dropped because the directory is readable and not blocked. */
  droppedContradicted: number;
}

const STALE_PREFIX_RE = /^\[STALE[^\]]*\]\s*/;
const STALE_SUFFIX_RE = /\s*\(no longer on disk: [^)]*\)\s*$/;
const DEFAULT_BLOCKED = [".git", "node_modules", ".venv", "venv", "__pycache__", ".agent", "dist", "build", ".gradle", ".idea"];
const GENERATED_PREFIXES = ["dist/", "build/", "coverage/", ".expo/", "node_modules/", ".agent/", ".git/", "out/", "target/"];

/** Repo-relative file or directory paths an entry names, de-duplicated. */
export function extractPathTokens(text: string): string[] {
  const out: string[] = [];
  for (let raw of text.split(/[\s,;()[\]"'`<>|]+/)) {
    raw = raw.replace(/[.:]+$/, "").replace(/:\d+(-\d+)?$/, "");
    if (!raw || raw.includes("://") || raw.includes("*") || raw.includes("{") || raw.includes("..")) continue;
    if (/^([/~]|[A-Za-z]:)/.test(raw)) continue; // absolute or home paths are not repo-relative
    raw = raw.replace(/^\.\//, "");
    if (!raw.includes("/")) continue;
    const isDir = raw.endsWith("/");
    if (isDir) {
      // "ENOENT/" and friends: a directory token must look like a directory name.
      if (!/^[\w@.\-]+(\/[\w@.\-]+)*\/$/.test(raw) || !/[a-z_]/.test(raw)) continue;
    } else if (!/^[\w@.\-]+(\/[\w@.\-]+)*\.[A-Za-z0-9]{1,6}$/.test(raw)) {
      continue;
    }
    if (GENERATED_PREFIXES.some((g) => raw.startsWith(g))) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** The directory an entry says is blocked/inaccessible, if it makes that claim. */
export function findBlockedDirClaim(text: string): string | undefined {
  const m = text.match(
    /([\w@.\-]+(?:\/[\w@.\-]+)*)\/?\s*(?:\([^)]*\)\s*)?(?:is|are)\s+(?:a\s+|an\s+)?(?:BLOCKED|blocked|inaccessible|not accessible|off-limits|forbidden)\b/
  );
  return m ? m[1] : undefined;
}

function existsInRepo(repoRoot: string, rel: string): boolean {
  const abs = path.resolve(repoRoot, rel);
  if (path.relative(repoRoot, abs).startsWith("..")) return true; // outside the repo: not ours to judge
  return fs.existsSync(abs);
}

const INDEX_SKIP = new Set(["node_modules", ".git", ".agent", "dist", "build", ".expo", "coverage", "android", "ios", "Pods", ".gradle", "target"]);

/** Every file under the repo (repo-relative, posix), for the "is this an abbreviated path?" check. */
function listRepoPaths(repoRoot: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 40000) return;
      if (e.isDirectory()) {
        if (!INDEX_SKIP.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(path.relative(repoRoot, path.join(dir, e.name)).replace(/\\/g, "/"));
      }
    }
  };
  walk(repoRoot);
  return out;
}

/**
 * Whether a remembered path is accounted for. Beyond the exact location it
 * accepts two cases that are not staleness: a path written as a SUFFIX of a real
 * one ("dashboard/Models.kt" for "reference/android-ui/dashboard/Models.kt", as
 * notes often abbreviate), and prose that merely contains slashes
 * ("Gradle/manifest/MainApplication.kt" in "no native Gradle/manifest edits"),
 * recognised as a capitalised first segment that is not a real top-level folder.
 * The file listing is built only when something is not found at its exact path.
 */
function makePresenceCheck(repoRoot: string): (rel: string) => boolean {
  let index: string[] | undefined;
  return (rel: string): boolean => {
    if (existsInRepo(repoRoot, rel)) return true;
    const first = rel.split("/")[0];
    if (/^[A-Z]/.test(first) && !fs.existsSync(path.join(repoRoot, first))) return true;
    const want = rel.replace(/\/$/, "");
    index ??= listRepoPaths(repoRoot);
    return index.some((p) => p === want || p.endsWith(`/${want}`) || p.startsWith(`${want}/`) || p.includes(`/${want}/`));
  };
}

function isReadableDir(repoRoot: string, rel: string): boolean {
  try {
    const abs = path.resolve(repoRoot, rel);
    if (!fs.statSync(abs).isDirectory()) return false;
    fs.readdirSync(abs);
    return true;
  } catch {
    return false;
  }
}

function reconcileList(
  list: string[],
  repoRoot: string,
  blocked: Set<string>,
  stats: MemoryReconcileStats
): string[] {
  const out: string[] = [];
  const present = makePresenceCheck(repoRoot);
  for (const original of list) {
    if (typeof original !== "string") {
      out.push(original);
      continue;
    }
    // Start from the text as originally written: drop markers from an earlier load.
    let entry = original.replace(STALE_PREFIX_RE, "").replace(STALE_SUFFIX_RE, "");

    const claimed = findBlockedDirClaim(entry);
    if (claimed) {
      const top = claimed.split("/")[0];
      const reallyBlocked = blocked.has(top) || claimed.split("/").some((seg) => blocked.has(seg));
      if (!reallyBlocked) {
        if (!existsInRepo(repoRoot, claimed)) {
          out.push(
            `[STALE — recorded as blocked, but the folder is simply missing] ${claimed}/ does not exist in the repo right now ` +
              `(moved or deleted), and it is NOT on the harness's block list. Nothing remembered about its contents can be trusted; ` +
              `check the disk before relying on any of it.`
          );
          stats.rewrittenMissing++;
          continue;
        }
        if (isReadableDir(repoRoot, claimed)) {
          stats.droppedContradicted++; // it is readable and not blocked: the claim is wrong
          continue;
        }
      }
    }

    const paths = extractPathTokens(entry);
    const missing = paths.filter((p) => !present(p));
    if (missing.length === 0) {
      out.push(entry);
      continue;
    }
    stats.staleMarked++;
    const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? `, +${missing.length - 3} more` : "");
    if (missing.length === paths.length) {
      out.push(`[STALE — no longer on disk: ${shown}; was true earlier, verify before relying on it] ${entry}`);
    } else {
      out.push(`${entry} (no longer on disk: ${shown})`);
    }
  }
  return out;
}

/** Mutates the memory's rule lists in place; see the file comment. */
export function reconcileMemoryWithDisk(
  memory: MemoryText,
  repoRoot: string,
  blockedDirs: string[] = DEFAULT_BLOCKED
): MemoryReconcileStats {
  const stats: MemoryReconcileStats = { staleMarked: 0, rewrittenMissing: 0, droppedContradicted: 0 };
  const blocked = new Set(blockedDirs);
  memory.architectureRules = reconcileList(memory.architectureRules ?? [], repoRoot, blocked, stats);
  memory.liveRules = reconcileList(memory.liveRules ?? [], repoRoot, blocked, stats);
  memory.historicalPitfalls = reconcileList(memory.historicalPitfalls ?? [], repoRoot, blocked, stats);
  return stats;
}
