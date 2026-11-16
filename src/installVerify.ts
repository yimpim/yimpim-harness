/**
 * After an ecosystem's own add command (`npm install x --ignore-scripts`,
 * `cargo add x`, `dotnet add package x`…) ran, find out which version of the
 * package actually landed, WITHOUT lockfile parsers: snapshot the small text
 * files in the project directory before the command, and afterwards look at
 * the lines that were added. The caller already holds the registry's list of
 * real version strings for the package, so the version is whichever of those
 * strings appears next to the package name in the new lines. That works for
 * any manifest or lockfile format that is text.
 *
 * For Node there is one direct reader (node_modules/<pkg>/package.json),
 * which is the same for npm, pnpm, yarn, bun and Expo.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_FILES_PER_DIR = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Non-recursive snapshot of readable text files in each directory. */
export function snapshotDirs(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of [...new Set(dirs.map((d) => path.resolve(d)))]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (++n > MAX_FILES_PER_DIR) break;
      const file = path.join(dir, e.name);
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        const text = fs.readFileSync(file, "utf8");
        if (text.slice(0, 4096).includes("\u0000")) continue;
        out.set(file, text);
      } catch {
        /* unreadable */
      }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Versions (from `known`) that appear on or just after an ADDED line that
 * mentions `name`. Order of first appearance; unique.
 */
export function addedVersionCandidates(
  name: string,
  known: ReadonlySet<string>,
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const nameRe = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(name.toLowerCase())}($|[^A-Za-z0-9_-])`);
  const tokenRe = /v?\d[0-9A-Za-z.+_~-]*/g;
  const found: string[] = [];
  for (const [file, text] of after) {
    const old = before.get(file);
    if (old === text) continue;
    const oldCounts = new Map<string, number>();
    for (const l of (old ?? "").split(/\r?\n/)) oldCounts.set(l, (oldCounts.get(l) ?? 0) + 1);
    const lines = text.split(/\r?\n/);
    const isNew: boolean[] = lines.map((l) => {
      const c = oldCounts.get(l) ?? 0;
      if (c > 0) {
        oldCounts.set(l, c - 1);
        return false;
      }
      return true;
    });
    for (let i = 0; i < lines.length; i++) {
      if (!isNew[i] || !nameRe.test(lines[i].toLowerCase())) continue;
      const window = lines.slice(i, i + 6).join("\n");
      for (const m of window.matchAll(tokenRe)) {
        const tok = m[0].replace(/[.,;:]+$/, "");
        if (known.has(tok) && !found.includes(tok)) found.push(tok);
      }
    }
  }
  return found;
}

/** Node: the installed package's own package.json, whichever manager put it there. */
export function readNodeModulesVersion(name: string, dirs: string[]): string | undefined {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) return undefined;
  for (const dir of dirs) {
    try {
      const file = path.join(dir, "node_modules", ...name.split("/"), "package.json");
      const v = JSON.parse(fs.readFileSync(file, "utf8"))?.version;
      if (typeof v === "string") return v;
    } catch {
      /* not there */
    }
  }
  return undefined;
}

export interface InstalledVersion {
  versions: string[];
  source: "node_modules" | "manifest-diff" | "none";
}

export function findInstalledVersions(args: {
  ecosystem: string;
  name: string;
  known: ReadonlySet<string>;
  before: Map<string, string>;
  dirs: string[];
}): InstalledVersion {
  if (args.ecosystem === "npm") {
    const v = readNodeModulesVersion(args.name, args.dirs);
    if (v) return { versions: [v], source: "node_modules" };
  }
  const after = snapshotDirs(args.dirs);
  const candidates = addedVersionCandidates(args.name, args.known, args.before, after);
  return candidates.length > 0 ? { versions: candidates, source: "manifest-diff" } : { versions: [], source: "none" };
}
