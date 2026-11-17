/**
 * A file the user names in their request is theirs to put in front of the
 * Planner, not Discovery's to decide about. When someone says "read
 * EXPO_PORT_BRIEF.md, that is what the app needs", Discovery reads it and may
 * or may not list it, and the Planner could only open what Discovery listed. So
 * the brief reached the one stage that has to follow it only by luck, and a
 * plan written without it ended in questions to the person who wrote it.
 *
 * Files the request names are found here and handed to the Planner directly:
 * always readable, and, for documents (a brief, a spec), included in its
 * prompt so it starts from what the user wrote.
 */
import fs from "fs";
import path from "path";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
export const DOC_EXT = /\.(md|markdown|txt|rst|adoc)$/i;
export const SKIP_DIRS = new Set(["node_modules", ".git", ".agent", ".expo", "dist", "build", ".next", ".gradle", "Pods", "vendor", "__pycache__", ".venv", "venv", "target"]);

/** Every file under the repo with this base name (case-insensitive), nearest first. */
function findByBasename(repoRoot: string, name: string, maxDepth = 6, maxVisited = 20000): string[] {
  const want = name.toLowerCase();
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || visited > maxVisited) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.toLowerCase() === want) {
        out.push(norm(path.relative(repoRoot, path.join(dir, e.name))));
      }
    }
  };
  walk(repoRoot, 0);
  return out.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

const squashName = (s: string) => s.toLowerCase().replace(/\b(folder|directory|dir)\b/g, "").replace(/[^a-z0-9]+/g, "");

/**
 * The folder a request means by "my android reference folder": the path itself
 * if that is a folder, otherwise the folder whose name matches once spaces,
 * dashes and case are ignored. Undefined when nothing matches, so a guess never
 * stands in for a folder that is not there.
 */
export function resolveReferenceDir(repoRoot: string, hint: string, maxDepth = 4): string | undefined {
  const root = path.resolve(repoRoot);
  const clean = norm(hint.trim().replace(/^["'`]+|["'`]+$/g, "")).replace(/\/+$/, "");
  if (!clean) return undefined;
  try {
    const full = path.resolve(root, clean);
    if (full.startsWith(root) && !path.isAbsolute(clean) && !clean.split("/").includes("..") && fs.statSync(full).isDirectory()) {
      // The folder's real name, not how it was typed: on a case-insensitive disk
      // "ANDROID-REFERENCE" finds it too, and everything downstream wants one spelling.
      const rel = norm(path.relative(fs.realpathSync.native(root), fs.realpathSync.native(full)));
      return rel || undefined;
    }
  } catch {
    // not a path; try by name
  }
  const want = squashName(clean);
  if (want.length < 3) return undefined;
  let best: { rel: string; depth: number; exact: boolean } | undefined;
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || visited > 20000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const rel = norm(path.relative(root, path.join(dir, e.name)));
      const name = squashName(e.name);
      if (name === want || (name.length >= 4 && (want.includes(name) || name.includes(want)))) {
        const exact = name === want;
        if (!best || (exact && !best.exact) || (exact === best.exact && depth < best.depth)) best = { rel, depth, exact };
      }
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return best?.rel;
}

/** Existing files the request names, by path or by bare file name. */
export function userNamedFiles(request: string, repoRoot: string, max = 8): string[] {
  const root = path.resolve(repoRoot);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of request.matchAll(/[\w@./\\-]+\.[A-Za-z0-9]{1,8}/g)) {
    const token = norm(m[0]).replace(/[.,;:)]+$/, "");
    if (!token || seen.has(token) || path.isAbsolute(token) || token.split("/").includes("..")) continue;
    seen.add(token);
    try {
      const full = path.resolve(root, token);
      if (full.startsWith(root) && fs.statSync(full).isFile()) {
        out.push(token);
        continue;
      }
    } catch {
      // not at that path; try by name
    }
    // A bare file name ("EXPO_PORT_BRIEF.md") is found wherever it lives.
    if (!token.includes("/")) {
      const hit = findByBasename(root, token)[0];
      if (hit && !out.includes(hit)) out.push(hit);
    } else {
      // A path with a typo or a wrong first folder ("eference/x/BRIEF.md"): the file name plus as much of the path as still
      // matches, dropping the front of it one folder at a time.
      const parts = token.split("/");
      const candidates = findByBasename(root, parts[parts.length - 1]);
      let found: string | undefined;
      for (let k = 1; k < parts.length && !found; k++) {
        const tail = parts.slice(k).join("/").toLowerCase();
        found = candidates.find((c) => c.toLowerCase() === tail || c.toLowerCase().endsWith("/" + tail));
      }
      if (!found && candidates.length === 1) found = candidates[0]; // only one file of that name: it is the one meant
      if (found && !out.includes(found)) out.push(found);
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Appends `extra` to `base`, each path once. */
export function mergeUnique(base: string[], extra: string[]): string[] {
  const out = [...base];
  for (const e of extra) if (!out.some((b) => norm(b) === norm(e))) out.push(e);
  return out;
}

/**
 * The text of the documents the request names (a brief, a spec), for the
 * Planner's prompt. Only prose documents: a source file is read through the
 * Planner's own tools. Capped, and said so when cut.
 */
export function renderUserDocuments(files: string[], repoRoot: string, perDoc = 150_000, total = 300_000): string {
  const docs = files.filter((f) => DOC_EXT.test(f));
  if (docs.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  let partial = false;
  for (const rel of docs) {
    if (used >= total) {
      partial = true;
      parts.push(`(${rel} was not included: the documents already fill the space. Open it with read_file.)`);
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }
    const room = Math.min(perDoc, total - used);
    if (text.length > room) partial = true;
    const shown = text.length > room ? `${text.slice(0, room)}\n... (cut: ${text.length - room} more character(s); open ${rel} with read_file for the rest)` : text;
    used += Math.min(text.length, room);
    parts.push(`=== ${rel} ===\n${shown}`);
  }
  if (parts.length === 0) return "";
  const header = partial
    ? `\n\nDOCUMENTS THE USER POINTED YOU TO (PARTIAL: at least one is cut or left out below, so you have NOT seen all of it. This is what they want built, so follow it. Before you ask the user anything, or assume the documents say nothing on a topic, open the missing part with read_file and check it):\n`
    : `\n\nDOCUMENTS THE USER POINTED YOU TO (in full; this is what they want built, so follow it and do not ask them anything it already answers):\n`;
  return header + parts.join("\n\n");
}
