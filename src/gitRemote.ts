/**
 * Per-project, per-machine "does this checkout push to GitHub" preference.
 *
 * Deliberately kept OUT of agent.config.yaml / ConfigSchema: the project
 * config is the FIRST file that exists, in priority order
 * (agent.config.yaml, then .agent/config.yaml) — the two are not merged. A
 * team-shared, committed agent.config.yaml would therefore silently shadow
 * anything written to .agent/config.yaml, and this decision would never take
 * effect on the one repo shape (a project with real config) it matters most
 * for. It also shouldn't live in a committed file at all: whether THIS
 * machine pushes is a personal choice, not something a teammate should
 * inherit just by cloning the repo. So it gets its own small local file.
 */

import fs from "node:fs";
import path from "node:path";
import type { RepoTools } from "./repoTools.js";

/** Parses `origin`'s fetch URL out of `git remote -v`, or undefined if unset. */
export async function detectOrigin(repo: RepoTools): Promise<string | undefined> {
  try {
    const remotes = await repo.git(["remote", "-v"]);
    return remotes.match(/^origin\s+(\S+)\s+\(fetch\)/m)?.[1];
  } catch {
    return undefined;
  }
}

/** A push preference is only ever set to true after this succeeds. */
export async function verifyOriginAccess(repo: RepoTools): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.git(["ls-remote", "origin"]);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export interface PushDenial {
  repoPath: string;
  deniedAccount: string;
}

/**
 * GitHub's own wording for "authenticated, but that account can't write
 * here" — e.g. `remote: Permission to slowGoMan/slowgo-frontend.git denied
 * to yimpimdev-w.`. Almost always a stale or wrong cached credential (git's
 * own credential cache is entirely separate from a browser session, so
 * signing into the right account on github.com does nothing to it), not an
 * actual missing-collaborator problem — worth telling apart from a generic
 * push failure since the fix is a specific command, not "check your access."
 */
export function parsePushDenial(message: string): PushDenial | null {
  const m = message.match(/Permission to (\S+) denied to ([^\s.]+)\.?/);
  return m ? { repoPath: m[1], deniedAccount: m[2] } : null;
}

export function describePushDenial(denial: PushDenial): string[] {
  return [
    `[GIT] ✗ Push denied — GitHub says "${denial.deniedAccount}" doesn't have write access to ${denial.repoPath}.`,
    `[GIT] This is almost always a stale/wrong cached git credential, not an actual permissions problem —`,
    `[GIT] signing into the right account in your browser does NOT update git's own credential cache.`,
    `[GIT]   Check what's cached:  git credential-manager github list`,
    `[GIT]   Clear the wrong one:  git credential-manager github logout ${denial.deniedAccount}`,
    `[GIT] Then retry — the next push prompts a fresh login.`,
  ];
}

export interface PushPreference {
  autoPush: boolean;
  remoteUrl?: string;
  decidedAt: string;
}

function prefPath(repoRoot: string, stateDirectory: string): string {
  return path.join(repoRoot, stateDirectory, "push.json");
}

export function readPushPreference(repoRoot: string, stateDirectory: string): PushPreference | null {
  try {
    const raw = JSON.parse(fs.readFileSync(prefPath(repoRoot, stateDirectory), "utf-8"));
    if (typeof raw?.autoPush === "boolean") return raw as PushPreference;
    return null;
  } catch {
    return null;
  }
}

export function writePushPreference(
  repoRoot: string,
  stateDirectory: string,
  pref: Omit<PushPreference, "decidedAt">
): void {
  const p = prefPath(repoRoot, stateDirectory);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...pref, decidedAt: new Date().toISOString() }, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}
