import type { RepoTools } from "./repoTools.js";

/**
 * Git ref names can't contain spaces, and most other punctuation is just
 * asking for shell/tooling trouble even where git would technically accept
 * it. A user typing a branch name in plain English ("api delays") shouldn't
 * need to know git's ref-naming rules, so this normalizes rather than
 * rejects.
 */
export function sanitizeBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export async function currentBranch(repo: RepoTools): Promise<string> {
  return (await repo.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/**
 * The repo's actual default branch, per its remote — not a guess from a
 * hardcoded name list. "main"/"master" covers the common case but silently
 * misses any repo whose primary branch is named something else (release,
 * stable, trunk, whatever a team happens to use). Set automatically on
 * clone; a remote only just added by `git remote add` (no fetch yet) won't
 * have it, so null means "unknown," not "there is no default branch."
 */
export async function detectDefaultBranch(repo: RepoTools): Promise<string | null> {
  try {
    const ref = (await repo.git(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const name = ref.split("/").pop();
    return name || null;
  } catch {
    return null;
  }
}

export async function branchExists(repo: RepoTools, name: string): Promise<boolean> {
  try {
    await repo.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export interface MergeTargetResolution {
  branch: string;
  /** False when this came from detectDefaultBranch (reliable); true when it's
   *  a same-name fallback guess the caller should warn about rather than
   *  trust silently. */
  guessed: boolean;
}

/**
 * Normalize the optional /merge argument. A branch named like the resolved
 * destination is almost always the user's way of saying "merge into this
 * default branch", so treat it as the current source rather than merging a
 * branch into itself. Other names retain the documented source-branch form.
 */
export function resolveMergeSource(rawFrom: string | undefined, current: string, into: string): string {
  const requested = rawFrom ? sanitizeBranchName(rawFrom) : "";
  return !requested || requested === "default" || requested === into ? current : requested;
}

/**
 * What /merge should merge INTO. Prefers the repo's real default branch;
 * falls back to a same-name guess (main, then master) ONLY when it can
 * verify the guess actually exists as a branch — never returns a name that
 * isn't even there, and always tells the caller when it had to guess rather
 * than detect, since a wrong guess here merges into the wrong trunk with no
 * other signal anything was assumed.
 */
export async function resolveMergeTarget(repo: RepoTools): Promise<MergeTargetResolution | undefined> {
  const detected = await detectDefaultBranch(repo);
  if (detected) return { branch: detected, guessed: false };
  if (await branchExists(repo, "main")) return { branch: "main", guessed: true };
  if (await branchExists(repo, "master")) return { branch: "master", guessed: true };
  return undefined;
}

export interface BranchInfo {
  name: string;
  current: boolean;
}

export async function listBranches(repo: RepoTools): Promise<BranchInfo[]> {
  const out = await repo.git(["branch", "--list"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ current: l.startsWith("*"), name: l.replace(/^\*\s*/, "").trim() }));
}

/** Creates the branch off current HEAD if it doesn't exist yet, otherwise just switches to it. */
export async function switchToBranch(repo: RepoTools, name: string): Promise<{ created: boolean }> {
  if (await branchExists(repo, name)) {
    await repo.git(["checkout", name]);
    return { created: false };
  }
  await repo.git(["checkout", "-b", name]);
  return { created: true };
}

export interface MergeResult {
  status: "merged" | "up-to-date" | "conflict";
  detail?: string;
}

/**
 * Merges `from` into `into`, never attempting to resolve a conflict itself —
 * that's exactly the kind of judgment call that can silently produce wrong
 * code, so a conflict aborts cleanly (both branches left exactly as they
 * were) rather than being guessed at. Leaves the working tree on `into`
 * after a successful merge, or back on `from` after an aborted one, so
 * "where am I now" always matches "did this work."
 */
export async function mergeBranch(repo: RepoTools, from: string, into: string): Promise<MergeResult> {
  await repo.git(["checkout", into]);
  try {
    const out = await repo.git(["merge", "--no-edit", from]);
    return { status: /already up to date/i.test(out) ? "up-to-date" : "merged", detail: out };
  } catch (err: any) {
    try {
      await repo.git(["merge", "--abort"]);
    } catch {
      // Nothing to abort (failure happened before a merge actually started) — fine.
    }
    await repo.git(["checkout", from]);
    return { status: "conflict", detail: err.message };
  }
}
