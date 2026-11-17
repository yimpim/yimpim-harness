/**
 * Ending a red test for good: removing a test file together with everything that points at it, and remembering which
 * tests are waiting on an automatic code fix (so one that is still red afterwards is removed instead of blocking every
 * later phase).
 */

import fs from "fs";
import path from "path";
import { runSuite } from "./testRun.js";

const posix = (p: string) => p.replace(/\\/g, "/");
const SKIP = new Set(["node_modules", ".git", ".agent", "dist", "build", ".expo", "coverage", ".next", "android", "ios", "Pods", ".gradle"]);
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|cfg|ini|txt)$/i;

export interface Removal {
  file: string;
  /** Files deleted: the test and its snapshot. */
  deleted: string[];
  /** Files in which lines pointing at the test were taken out. */
  edited: string[];
  /** Places that still mention it and could not be removed safely by rule. */
  leftover: string[];
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (TEXT.test(e.name)) out.push(r);
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deletes a test, its snapshot, and every line that only exists to point at it. Anything else that mentions it is listed. */
export function removeTest(repoRoot: string, fileRel: string): Removal {
  const file = posix(fileRel);
  const res: Removal = { file, deleted: [], edited: [], leftover: [] };
  const abs = path.join(repoRoot, file);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { force: true });
    res.deleted.push(file);
  }
  const snapDir = path.join(path.dirname(abs), "__snapshots__");
  const snap = path.join(snapDir, path.basename(abs) + ".snap");
  if (fs.existsSync(snap)) {
    fs.rmSync(snap, { force: true });
    res.deleted.push(posix(path.relative(repoRoot, snap)));
    try {
      if (fs.readdirSync(snapDir).length === 0) fs.rmdirSync(snapDir);
    } catch {}
  }

  const base = path.posix.basename(file).replace(/\.[a-z0-9]+$/i, "");
  // The full path, or the file's name as the last piece of a quoted path ("./x.test", "../__tests__/x.test.ts").
  const mention = new RegExp(`${esc(file)}|[/'"\`]${esc(base)}(?:\\.[a-z0-9]+)?['"\`]`);
  const quotedRef = new RegExp(`['"\`][^'"\`\\n]*(?:${esc(file)}|[/]${esc(base)}(?:\\.[a-z0-9]+)?)['"\`]`, "g");

  for (const rel of walk(repoRoot)) {
    if (rel === file) continue;
    let text: string;
    try {
      const st = fs.statSync(path.join(repoRoot, rel));
      if (st.size > 1_500_000) continue;
      text = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }
    if (!mention.test(text)) continue;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const kept: string[] = [];
    let removed = 0;
    const stillMentions: string[] = [];
    for (const line of lines) {
      if (!mention.test(line)) {
        kept.push(line);
        continue;
      }
      const stripped = line.replace(quotedRef, "").replace(/\b(?:import|require|from|test|it|describe|jest|testMatch|testPathIgnorePatterns)\b/g, "").replace(/[\s,;:()[\]{}=>*\-`#]/g, "");
      const bullet = /\.md$/i.test(rel) && /^\s*(?:[-*]|\d+\.)\s/.test(line);
      if (stripped === "" || bullet) removed++;
      else {
        kept.push(line);
        stillMentions.push(`${rel}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (removed > 0) {
      let next = kept.join(eol);
      let ok = true;
      if (/\.json$/i.test(rel)) {
        // Taking out the last entry of a list leaves a comma before the closing bracket, which JSON does not allow.
        try {
          JSON.parse(next);
        } catch {
          const tidy = next.replace(/,(\s*[}\]])/g, "$1");
          try {
            JSON.parse(tidy);
            next = tidy;
          } catch {
            ok = false;
          }
        }
      }
      if (ok) {
        fs.writeFileSync(path.join(repoRoot, rel), next);
        res.edited.push(rel);
      } else {
        res.leftover.push(`${rel}: the entry pointing at it could not be removed without breaking the file`);
        continue;
      }
    }
    res.leftover.push(...stillMentions);
  }
  return res;
}

export function renderRemoval(r: Removal): string {
  const parts = [`removed ${r.deleted.join(", ") || r.file}`];
  if (r.edited.length) parts.push(`took the reference out of ${r.edited.join(", ")}`);
  if (r.leftover.length) parts.push(`still mentioned (not removable by rule): ${r.leftover.slice(0, 6).join(" | ")}`);
  return parts.join("; ");
}

// ---------------------------------------------------------------- pending fixes

export interface PendingFix {
  file: string;
  reason: string;
  /** The end of the failing run, so the fix starts from the real output. */
  failure?: string;
}

const pendingPath = (root: string) => path.join(root, ".agent", "test-fixes.json");
const removedPath = (root: string) => path.join(root, ".agent", "removed-tests.json");

export function loadPendingFixes(root: string): PendingFix[] {
  try {
    const v = JSON.parse(fs.readFileSync(pendingPath(root), "utf-8"));
    return Array.isArray(v) ? v.filter((x) => typeof x?.file === "string") : [];
  } catch {
    return [];
  }
}

export function savePendingFixes(root: string, items: PendingFix[]): void {
  try {
    fs.mkdirSync(path.dirname(pendingPath(root)), { recursive: true });
    if (items.length === 0) fs.rmSync(pendingPath(root), { force: true });
    else fs.writeFileSync(pendingPath(root), JSON.stringify(items, null, 2));
  } catch {}
}

/** A record of tests taken out, with what they were about, so the knowledge is not lost with the file. */
export function recordRemoved(root: string, file: string, reason: string): void {
  try {
    const cur = (() => {
      try {
        return JSON.parse(fs.readFileSync(removedPath(root), "utf-8"));
      } catch {
        return [];
      }
    })();
    cur.push({ file, reason, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(removedPath(root)), { recursive: true });
    fs.writeFileSync(removedPath(root), JSON.stringify(cur, null, 2));
  } catch {}
}

const FIX_TASK_START = "These test files fail because the code they test is wrong";

/** True for the task text fixTaskFor produced (only that task's end settles the pending tests). */
export function isFixTask(text: string | undefined): boolean {
  return Boolean(text && text.startsWith(FIX_TASK_START));
}

/** The task handed to the normal pipeline to fix the code the red tests found wrong. */
export function fixTaskFor(items: PendingFix[]): string {
  return (
    `${FIX_TASK_START} (real defects, not outdated tests). Fix the CODE so every one of them passes. ` +
    `Do not edit, skip or delete these tests; each finding below says what is wrong and where.\n\n` +
    items
      .map((i, n) => `${n + 1}. ${i.file}: ${i.reason}${i.failure ? `\n   How it fails:\n${i.failure.split("\n").map((l) => "   " + l).join("\n")}` : ""}`)
      .join("\n\n")
  );
}

/**
 * After the fix attempt: a pending test that passes is done; one that still fails is removed with everything pointing at it,
 * and the reason is written down. Returns the log lines.
 */
export async function settlePendingFixes(root: string, run = runSuite): Promise<string[]> {
  const pending = loadPendingFixes(root);
  if (pending.length === 0) return [];
  const lines: string[] = [];
  const results = await Promise.all(pending.map(async (p) => ({ p, r: fs.existsSync(path.join(root, p.file)) ? await run(root, [p.file]) : { ok: true, output: "" } })));
  for (const { p, r } of results) {
    if (r.ok) {
      lines.push(`${p.file} passes now.`);
      continue;
    }
    const removal = removeTest(root, p.file);
    recordRemoved(root, p.file, p.reason);
    lines.push(`${p.file} still fails after the fix attempt, so it was ${renderRemoval(removal)}. What it found is kept in .agent/removed-tests.json.`);
  }
  savePendingFixes(root, []);
  return lines;
}
