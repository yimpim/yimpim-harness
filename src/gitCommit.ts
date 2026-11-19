/**
 * Commits exactly the files it is given, and nothing else.
 *
 * A plain `git commit` takes the whole index, so anything already staged (by the person, or by a tool) rode along in a phase's
 * commit, under a message that did not describe it, even though the run says it leaves the person's own changes alone. Naming the
 * paths in the commit itself (`--only`) takes only those; whatever else is staged stays staged for the person to commit.
 */

import fs from "fs";
import os from "os";
import path from "path";

export type Git = (args: string[]) => Promise<string>;

/** Past this many characters of paths, they go in a file: a command line has a length limit (about 32k on Windows). */
const MAX_ARG_CHARS = 20_000;

/**
 * Stages each path on its own (one that cannot be staged, such as an ignored file, is skipped and reported, instead of failing the
 * whole commit), then commits just those. Returns the paths that were committed: empty when there was nothing to commit.
 */
export async function commitOnly(
  git: Git,
  paths: string[],
  message: string,
  warn: (line: string) => void = () => {},
): Promise<string[]> {
  const staged: string[] = [];
  for (const rel of paths) {
    try {
      await git(["add", "--", rel]);
      staged.push(rel);
    } catch (e: any) {
      warn(`[GIT WARNING] Could not stage ${rel}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  if (staged.length === 0) return [];

  // Is there anything to commit among them? Asked of the index, not guessed from an error: git says "nothing to commit" on stdout,
  // which a wrapper that reports only stderr never shows. (Renames are listed as a delete and an add, so both paths are seen.)
  const norm = (p: string) => p.replace(/\\/g, "/");
  const cached = new Set(
    (await git(["-c", "core.quotepath=false", "diff", "--cached", "--no-renames", "--name-only"])).split(/\r?\n/).filter(Boolean).map(norm),
  );
  const pending = staged.filter((p) => cached.has(norm(p)));
  if (pending.length === 0) return [];

  const chars = pending.reduce((n, p) => n + p.length + 1, 0);
  let file: string | undefined;
  try {
    let spec: string[];
    if (chars <= MAX_ARG_CHARS) {
      spec = ["--", ...pending];
    } else {
      file = path.join(os.tmpdir(), `yimpim-commit-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, pending.join("\0"));
      spec = [`--pathspec-from-file=${file}`, "--pathspec-file-nul"];
    }
    await git(["commit", "-m", message, "--only", ...spec]);
    return pending;
  } finally {
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // a leftover temp file is harmless
      }
    }
  }
}
