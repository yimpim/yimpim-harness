import fs from "node:fs/promises";
import path from "node:path";
import { RepoTools } from "./repoTools.js";
import { Config } from "./config.js";

export async function ensureCleanOrExplain(repo: RepoTools, config: Config) {
  const status = (await repo.git(["status", "--porcelain"])).trim();
  if (status && config.recovery.dirtyTreePolicy === "refuse") {
    throw new Error("Repository has pre-existing uncommitted changes. Refusing to edit because dirtyTreePolicy=refuse.");
  }
  return status;
}

export async function checkpoint(repo: RepoTools, phaseName: string): Promise<string> {
  const marker = `ai-agent-checkpoint: ${phaseName}`;
  const status = (await repo.git(["status", "--porcelain"])).trim();
  if (status) {
    // Never stash or overwrite user changes automatically.
    throw new Error("Cannot create a clean Git checkpoint because the working tree is dirty.");
  }
  await repo.git(["commit", "--allow-empty", "-m", marker]);
  return (await repo.git(["rev-parse", "HEAD"])).trim();
}

export async function rollbackTo(repo: RepoTools, commit: string) {
  const status = (await repo.git(["status", "--porcelain"])).trim();
  if (status) {
    await repo.git(["restore", "--worktree", "--staged", "--", "."]);
  }
  await repo.git(["reset", "--hard", commit]);
}

export async function makeBackup(repoRoot: string, config: Config, runId: string, phaseIndex: number) {
  if (!config.recovery.keepBackups) return;
  const dir = path.join(repoRoot, config.recovery.stateDirectory, "backups", runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `phase-${phaseIndex}.status`);
  await fs.writeFile(file, `Backup marker for run ${runId}, phase ${phaseIndex}\n`, "utf8");
}
