/**
 * A compact picture of the project for the model that reads what the user typed.
 *
 * People refer to things the way they think of them: "my android reference
 * folder", "the brief", "the spec I wrote". Matching those words to a folder or
 * a file with string rules is guesswork. The model that already reads every
 * request can do it properly if it is shown what is actually there, so it is
 * given the project's folders (with how many files each holds) and its
 * documents, and picks from them. Whatever it picks is checked against the disk,
 * so a choice that is not a real folder or file is dropped, never used.
 */
import fs from "fs";
import path from "path";
import { DOC_EXT, SKIP_DIRS } from "./userFiles.js";

export interface Layout {
  /** Folders worth naming, biggest first. */
  dirs: { path: string; files: number }[];
  /** Prose documents (md, txt, rst, adoc). */
  docs: string[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function projectLayout(repoRoot: string, opts: { maxDirs?: number; maxDocs?: number; maxVisited?: number } = {}): Layout {
  const maxDirs = opts.maxDirs ?? 40;
  const maxDocs = opts.maxDocs ?? 40;
  const maxVisited = opts.maxVisited ?? 30_000;
  const root = path.resolve(repoRoot);
  const counts = new Map<string, number>();
  const docs: { path: string; depth: number }[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): number => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const e of entries) {
      if (++visited > maxVisited) return total;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        total += walk(full, depth + 1);
      } else if (e.isFile()) {
        total++;
        if (depth <= 4 && DOC_EXT.test(e.name)) docs.push({ path: norm(path.relative(root, full)), depth });
      }
    }
    const rel = norm(path.relative(root, dir));
    if (rel && depth <= 3) counts.set(rel, total);
    return total;
  };
  walk(root, 0);

  const dirs = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([p, files]) => ({ path: p, files }))
    // A folder is more useful named than its parent when it is most of it; keep both, biggest first.
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, maxDirs);
  return {
    dirs,
    docs: docs.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, maxDocs).map((d) => d.path),
  };
}

/** The block shown to the classifier. Empty for a project too small to need it. */
export function renderLayout(l: Layout): string {
  if (l.dirs.length === 0 && l.docs.length === 0) return "";
  return (
    (l.dirs.length > 0 ? `Project folders (path, number of files):\n${l.dirs.map((d) => `- ${d.path}/ (${d.files})`).join("\n")}\n\n` : "") +
    (l.docs.length > 0 ? `Project documents:\n${l.docs.map((d) => `- ${d}`).join("\n")}\n\n` : "")
  );
}

/** Keeps only the paths that are really files inside the project, once each. */
export function existingFilesOnly(repoRoot: string, paths: unknown, max = 6): string[] {
  const root = path.resolve(repoRoot);
  const out: string[] = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const rel = norm(String(raw ?? "").trim());
    if (!rel || out.includes(rel) || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
    try {
      const full = path.resolve(root, rel);
      if (full.startsWith(root) && fs.statSync(full).isFile()) out.push(rel);
    } catch {
      // not a file
    }
    if (out.length >= max) break;
  }
  return out;
}

/** The folder the model chose, if it is really a folder in the project. */
export function existingDirOnly(repoRoot: string, p: unknown): string | undefined {
  const rel = norm(String(p ?? "").trim()).replace(/\/+$/, "");
  if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) return undefined;
  try {
    const root = path.resolve(repoRoot);
    const full = path.resolve(root, rel);
    return full.startsWith(root) && fs.statSync(full).isDirectory() ? rel : undefined;
  } catch {
    return undefined;
  }
}
