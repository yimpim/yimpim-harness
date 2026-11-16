import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export class WorktreeManager {
  private repoDir: string;
  private worktreePath: string;
  private branchName: string;

  constructor(repoDir: string, runId: string) {
    this.repoDir = repoDir;
    this.branchName = `agent/run-${runId}`;
    this.worktreePath = path.resolve(repoDir, ".agent/worktrees", `run-${runId}`);
  }

  public setupWorktree(): string {
    fs.mkdirSync(path.dirname(this.worktreePath), { recursive: true });

    // Ensure the host working tree is not clobbered
    execSync(`git worktree add -b "${this.branchName}" "${this.worktreePath}" HEAD`, {
      cwd: this.repoDir,
      stdio: "pipe",
    });

    return this.worktreePath;
  }

  public cleanupWorktree(keepBranch: boolean = false): void {
    try {
      execSync(`git worktree remove --force "${this.worktreePath}"`, {
        cwd: this.repoDir,
        stdio: "pipe",
      });
      if (!keepBranch) {
        execSync(`git branch -D "${this.branchName}"`, {
          cwd: this.repoDir,
          stdio: "pipe",
        });
      }
    } catch {
      // Best-effort cleanup
    }
  }

  public getWorktreePath(): string {
    return this.worktreePath;
  }

  public getBranchName(): string {
    return this.branchName;
  }
}
