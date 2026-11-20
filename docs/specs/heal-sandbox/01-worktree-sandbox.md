# Spec 01 — Sandbox lifecycle: a disposable copy of the repo, exactly as it is now

Goal: give the sandbox agent a complete, runnable copy of the project in which it may change anything, that reproduces the real
failure exactly, and that is removed afterwards without ever touching the real repo or its `node_modules`.

New module: `src/healSandbox.ts` (this spec covers its lifecycle half; spec 03 adds the agent half).

## 1. API

```ts
export interface Sandbox {
  /** Absolute path of the worktree root. */
  root: string;
  /** Repo-relative path of the test file (posix). */
  file: string;
  /** Text of the test file as written into the sandbox (the heal's current `last`). */
  startText: string;
  /** Snapshot commit the worktree was made from (git stash create hash, or HEAD). */
  base: string;
}

export type SandboxCreate =
  | { ok: true; sandbox: Sandbox }
  | { ok: false; reason: string };            // never throws for expected failures

export async function createSandbox(opts: {
  repoRoot: string;
  file: string;                                // repo-relative test file
  testText: string;                            // the heal's current `last`
  expectFailing: string[];                     // failingNames(current.output) from the real repo
  run: RunTests;                               // same runner the heal uses (src/healEdits.ts RunTests)
  log?: (line: string) => void;
}): Promise<SandboxCreate>;

export function destroySandbox(s: Sandbox, repoRoot: string): void;   // idempotent, never throws
export function pruneStaleSandboxes(repoRoot: string): number;        // returns how many were removed
```

## 2. createSandbox — steps, in this order

1. **Snapshot the working tree without touching it.**
   `git -C <repoRoot> stash create` (via `execFileSync("git", [...])`, NO shell). Output is a commit hash, or empty when there
   are no tracked changes. `base = hash || git rev-parse HEAD`.
   - `stash create` includes staged and unstaged changes to TRACKED files. It does not include untracked files (step 4).
   - It does not modify the working tree, the index or the stash list. VERIFY with a test (git status identical before/after).
2. **Location.** `root = path.join(os.tmpdir(), "yimpim-heal", `${hash8(repoRoot)}-${Date.now().toString(36)}`)`.
   Outside the repo, so the repo's tools, watchers and `git status` never see it. Create parent dirs.
3. **Worktree.** `git -C <repoRoot> worktree add --detach <root> <base>`. Detached: no branch is created, so nothing to delete.
   On failure → `{ ok: false, reason: "git worktree add failed: <stderr first line>" }`.
4. **Untracked, non-ignored files.** `git -C <repoRoot> ls-files --others --exclude-standard -z`. Copy each into the same relative
   path under `root` (create dirs). Skip any path that fails `SAFE` (same check as `src/healEdits.ts`) or is over 5 MB.
   Reason: the first model may have created helpers/mocks; the user may have untracked app files a test imports.
5. **The test file.** Write `testText` to `<root>/<file>` (it may differ from the snapshot: the heal's `last` can be newer).
   Keep the file's line endings: if the real file uses CRLF, write CRLF.
6. **Dependencies: junction, not copy.** For each of `node_modules` (and, if present at the repo root, `.venv`):
   - if `<repoRoot>/<dir>` exists and `<root>/<dir>` does not: `fs.symlinkSync(<repoRoot>/<dir>, <root>/<dir>, "junction")`
     on Windows (no admin needed), `"dir"` elsewhere.
   - Nested `node_modules` in workspaces: out of scope; the preflight (step 7) catches a broken environment.
7. **Preflight: the sandbox must reproduce the real failure.**
   `r = await run(root, [file])`; `got = failingNames(r.output)` (from `src/healAuthority.ts`).
   - If `new Set(got)` equals `new Set(expectFailing)` → ok.
   - Otherwise → `destroySandbox`, return `{ ok: false, reason: "the sandbox does not reproduce the failure: expected N failing (…first 3…), got M (…)" }`.
   - A load error (no `Tests:` line, `testsFailing(r.output) === undefined`) when the real run had one is a mismatch too.
   This is the guard against every environment problem: missing untracked file, a junction Jest will not follow, a path-sensitive
   config. Never let an agent work in an environment that does not reproduce the failure.
8. Return `{ ok: true, sandbox }`.

Logging (`opts.log`): one line on create (`sandbox ready at <root> (base <hash8>, N untracked copied)`), one on preflight
mismatch with the reason.

## 3. destroySandbox — order matters (data-loss risk)

1. **Remove every junction/symlink FIRST, non-recursively.** For each dir linked in step 6:
   `const p = path.join(root, dir); if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p)` — on Windows a junction reports
   `isSymbolicLink() === true` under `lstat`; remove it with `fs.unlinkSync(p)` if `rmSync` refuses. NEVER `rmSync(p, { recursive: true })`
   on a link: a recursive delete that follows the junction deletes the REAL `node_modules`.
2. `git -C <repoRoot> worktree remove --force <root>`.
3. If the directory still exists (git failed, files locked by a Jest worker on Windows): retry once after 500 ms, then
   `fs.rmSync(root, { recursive: true, force: true })` — safe only because step 1 already removed the links. Re-check with `lstat`
   that no link remains before the recursive delete; if one does, skip the delete and log it.
4. `git -C <repoRoot> worktree prune`.
5. Swallow and log every error. Never throw from destroy.

## 4. pruneStaleSandboxes

Called at the start of every heal (next to `recoverTrial` in `healOneInner`) so a killed run leaves nothing behind.
- `git worktree list --porcelain` → entries whose path is under `os.tmpdir()/yimpim-heal/` → for each: run the destroy steps
  (links first!).
- Also remove orphan directories under `os.tmpdir()/yimpim-heal/` that git no longer knows, same link-first rule.

## 5. Tests (`test/healSandbox.lifecycle.test.ts`) — real git, temp repos, no network

Build a temp repo with `git init`, a `package.json`, a committed test file, a committed source file, and a fake `node_modules`
directory containing a marker file `node_modules/marker.txt`.

1. uncommitted edit to a tracked file is present in the sandbox; the real repo's `git status --porcelain` is byte-identical before
   and after `createSandbox` + `destroySandbox`; `git stash list` unchanged.
2. untracked, non-ignored file is copied; an ignored file (listed in `.gitignore`) is NOT copied.
3. `testText` differing from disk is what the sandbox holds; CRLF preserved.
4. **junction safety:** after `destroySandbox`, `<repoRoot>/node_modules/marker.txt` still exists. (The most important test.)
5. preflight mismatch: a fake `run` returning a different failing set → `{ ok: false }`, and the worktree is gone
   (`git worktree list` has no tmp entry).
6. `destroySandbox` twice → no throw.
7. stale prune: create a sandbox, do not destroy it, call `pruneStaleSandboxes` → 1, real `node_modules` intact.
8. a path in `ls-files --others` that fails `SAFE` is skipped.

Use a fake `run` (`RunTests`) for the preflight so the tests need no Jest.

## 6. Out of scope

Workspaces with nested `node_modules`, Python virtualenvs outside the repo root, monorepos where the test must run from a
sub-package. The preflight refuses these cleanly; the heal then reports the parked causes as it does today.
