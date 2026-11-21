/**
 * What the security judges are told about files the agent staged for deletion at the end of a run: where each came from and whether git can bring it back.
 * "Delete the two scratch tests I made" and "delete the user's uncommitted file" are very different, and only these facts tell them apart.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return "";
  }
}

/** True when any path could point outside the project (absolute, or with a `..` part): never judged by the panel, always shown to the person. */
export function escapesProject(files: string[]): boolean {
  return files.some((f) => path.isAbsolute(f) || f.split(/[\\/]/).includes(".."));
}

/** One line per file, for the judges. */
export function describeStagedDeletions(repoRoot: string, files: string[], ctx: { createdThisRun(f: string): boolean; reasonOf(f: string): string | undefined }): string[] {
  return files.map((f) => {
    const tracked = git(repoRoot, ["ls-files", "--error-unmatch", "--", f]) !== "";
    const changed = tracked && git(repoRoot, ["status", "--porcelain", "--", f]) !== "";
    let lines = 0;
    try {
      lines = fs.readFileSync(path.join(repoRoot, f), "utf8").split(/\r?\n/).length;
    } catch {
      // gone already
    }
    const origin = ctx.createdThisRun(f) ? "created by the agent during this run" : "NOT created by the agent this run";
    const git_ = tracked ? (changed ? "tracked by git, with uncommitted changes" : "tracked by git and unchanged, so git can restore it") : "NOT tracked by git, so it cannot be restored";
    const reason = ctx.reasonOf(f);
    return `- ${f} (${lines} lines; ${origin}; ${git_})${reason ? ` — reason given: ${reason}` : ""}`;
  });
}
