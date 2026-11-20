/**
 * The heal sandbox: a disposable copy of the project, exactly as it is now, in which a stronger model may change ANYTHING to find out why a
 * test fails (add logging to app code, change a wait, run one test), the way a person does at their own terminal. Only the test file ever
 * comes back to the real project, and only through the per-test ratchet (see healSandbox merge in testHeal.ts).
 *
 * This file is the LIFECYCLE half: make the copy, prove it reproduces the failure, remove it without touching the real project. The
 * dangerous part is removal: the copy shares the real `node_modules` through a link, and deleting recursively THROUGH that link would delete
 * the real folder. Every link is removed first, on its own, and nothing is ever deleted recursively until none is left.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { SAFE, type RunTests } from "./healEdits.js";
import { failingNames } from "./healAuthority.js";

export interface Sandbox {
  /** Absolute path of the worktree root. */
  root: string;
  /** Repo-relative path of the test file (posix). */
  file: string;
  /** Text of the test file as written into the sandbox (the heal's current `last`). */
  startText: string;
  /** The commit the worktree was made from: a `git stash create` snapshot of the working tree, or HEAD. */
  base: string;
  /** Top-level directories shared with the real project through a link (removed before anything else is deleted). */
  links: string[];
}

export type SandboxCreate = { ok: true; sandbox: Sandbox } | { ok: false; reason: string };

/** Directories shared with the real project instead of copied: far too big to copy, and read-only as far as the heal is concerned. */
const SHARED_DIRS = ["node_modules", ".venv"];
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const BASE_DIR = () => path.join(os.tmpdir(), "yimpim-heal");

/** Sandboxes this process is using right now: pruning must never remove one of them. */
const active = new Set<string>();

const hash8 = (s: string) => crypto.createHash("sha1").update(path.resolve(s).toLowerCase()).digest("hex").slice(0, 8);
/** A path in one canonical spelling (real path, lower case): two spellings of one folder compare equal. */
const realLower = (p: string) => {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
};
/** Where sandboxes live, and the name prefix of this project's: exposed so tests (and a prune of a killed run) can find them. */
export const sandboxBase = (): string => BASE_DIR();
export const sandboxPrefix = (repoRoot: string): string => `${hash8(repoRoot)}-`;
const posix = (p: string) => p.replace(/\\/g, "/");

/** git, started directly (no shell): nothing the model or the project's file names contain can be interpreted as a command. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export async function createSandbox(opts: {
  repoRoot: string;
  file: string;
  testText: string;
  expectFailing: string[];
  run: RunTests;
  log?: (line: string) => void;
}): Promise<SandboxCreate> {
  const { repoRoot, testText, expectFailing, run, log } = opts;
  const file = posix(opts.file).replace(/^\.\//, "");
  if (!file || !SAFE(file)) return { ok: false, reason: `the test file path is not inside the project: ${opts.file}` };

  let base: string;
  try {
    // The sandbox is made from the project, so the project must be at the top of its git repository (the paths git reports are relative to it).
    const top = git(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
    if (realLower(top) !== realLower(repoRoot)) {
      return { ok: false, reason: "the project is not at the top of its git repository, so a sandbox copy cannot be made" };
    }
    // A commit holding the working tree's tracked changes, made WITHOUT touching the working tree, the index or the stash list. Empty when nothing changed.
    const snap = git(repoRoot, ["stash", "create"]).trim();
    base = snap || git(repoRoot, ["rev-parse", "HEAD"]).trim();
  } catch (e: any) {
    return { ok: false, reason: `could not snapshot the project: ${firstLine(e)}` };
  }

  const root = path.join(BASE_DIR(), `${hash8(repoRoot)}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(BASE_DIR(), { recursive: true });
    git(repoRoot, ["worktree", "add", "--detach", root, base]);
  } catch (e: any) {
    removeSandboxDir(root, repoRoot);
    return { ok: false, reason: `git worktree add failed: ${firstLine(e)}` };
  }
  active.add(root);
  const sandbox: Sandbox = { root, file, startText: testText, base, links: [] };

  try {
    // Files git does not track but the tests may need: helpers or mocks the first model created, app files the user has not committed.
    let copied = 0;
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const rel of untracked.map(posix)) {
      if (!SAFE(rel)) continue;
      const from = path.join(repoRoot, rel);
      try {
        const st = fs.lstatSync(from);
        if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
        const to = path.join(root, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        copied++;
      } catch {
        // a file that vanished or cannot be read is simply not copied; the preflight below says whether that mattered
      }
    }

    // The test file as the heal has it now (it can be newer than the snapshot), byte for byte so its line endings survive.
    const testAbs = path.join(root, file);
    fs.mkdirSync(path.dirname(testAbs), { recursive: true });
    fs.writeFileSync(testAbs, testText);

    // Dependencies are shared, not copied.
    for (const dir of SHARED_DIRS) {
      const real = path.join(repoRoot, dir);
      const link = path.join(root, dir);
      if (!fs.existsSync(real) || fs.existsSync(link)) continue;
      fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      sandbox.links.push(dir);
    }
    log?.(`sandbox ready at ${root} (base ${base.slice(0, 8)}, ${copied} untracked file${copied === 1 ? "" : "s"} copied)`);

    // The guard against every environment problem: a missing file, a link the test runner will not follow, a path-sensitive config.
    // An agent must never work in a copy that does not reproduce the failure it was asked to explain.
    const r = await run(root, [file]);
    const got = failingNames(r.output);
    const want = new Set(expectFailing);
    const same = got.length === want.size && got.every((n) => want.has(n));
    if (!same) {
      const reason = `the sandbox does not reproduce the failure: expected ${want.size} failing (${[...want].slice(0, 3).join(" | ") || "none"}), got ${got.length} (${got.slice(0, 3).join(" | ") || "none"})`;
      log?.(reason);
      destroySandbox(sandbox, repoRoot);
      return { ok: false, reason };
    }
    return { ok: true, sandbox };
  } catch (e: any) {
    destroySandbox(sandbox, repoRoot);
    return { ok: false, reason: `could not prepare the sandbox: ${firstLine(e)}` };
  }
}

/** Idempotent, and never throws: it runs in `finally` blocks. */
export function destroySandbox(s: Sandbox, repoRoot: string): void {
  try {
    removeSandboxDir(s.root, repoRoot);
  } catch {
    // nothing more can be done; a later prune retries
  } finally {
    active.delete(s.root);
  }
}

/**
 * Remove a sandbox directory. ORDER MATTERS: every link goes first, each on its own and never recursively, because a recursive delete
 * that follows a link into the real `node_modules` would delete the real project's dependencies.
 */
function removeSandboxDir(root: string, repoRoot: string): void {
  if (!fs.existsSync(root) && !isListed(repoRoot, root)) return;
  unlinkLinks(root);
  gitRemove(repoRoot, root);
  if (fs.existsSync(root)) {
    // Files can be held for a moment (a test runner that is still shutting down, on Windows): once more, then by hand.
    sleep(500);
    unlinkLinks(root);
    gitRemove(repoRoot, root);
  }
  if (fs.existsSync(root)) {
    unlinkLinks(root);
    if (!anyLinkLeft(root)) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // left for the next prune
      }
    }
  }
  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch {
    // not a git repository any more, or git is busy: nothing to prune
  }
}

function gitRemove(repoRoot: string, root: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", root]);
  } catch {
    // reported by the existence check that follows
  }
}

function isListed(repoRoot: string, root: string): boolean {
  try {
    return listWorktrees(repoRoot).some((w) => samePath(w, root));
  } catch {
    return false;
  }
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Remove every symbolic link or junction anywhere under `dir`, the link itself and never what it points at. */
function unlinkLinks(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      removeOneLink(p);
    } else if (st.isDirectory()) {
      unlinkLinks(p);
    }
  }
}

function removeOneLink(p: string): void {
  try {
    fs.unlinkSync(p); // a symlink, and a junction, are removed as links: the target is untouched
  } catch {
    try {
      fs.rmdirSync(p); // a junction on some Windows builds: rmdir removes the reparse point, not its contents
    } catch {
      // still there: anyLinkLeft stops the recursive delete
    }
  }
}

function anyLinkLeft(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return true;
      if (st.isDirectory() && anyLinkLeft(p)) return true;
    } catch {
      // gone while looking: fine
    }
  }
  return false;
}

function listWorktrees(repoRoot: string): string[] {
  return git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

/**
 * Remove what a killed run left behind. Called at the start of every heal. Only this project's sandboxes are touched (the directory
 * name carries a hash of the project path), and never one this process is using.
 */
export function pruneStaleSandboxes(repoRoot: string): number {
  const mine = `${hash8(repoRoot)}-`;
  const base = BASE_DIR();
  const found = new Set<string>();
  try {
    for (const w of listWorktrees(repoRoot)) {
      if (samePath(path.dirname(w), base) && path.basename(w).startsWith(mine)) found.add(path.resolve(w));
    }
  } catch {
    // not a git repository: only orphan directories can be found
  }
  try {
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith(mine)) found.add(path.resolve(base, name));
    }
  } catch {
    // nothing has ever been made here
  }
  let removed = 0;
  for (const root of found) {
    if ([...active].some((a) => samePath(a, root))) continue;
    try {
      removeSandboxDir(root, repoRoot);
      if (!fs.existsSync(root)) removed++;
    } catch {
      // left for the next time
    }
  }
  return removed;
}

function firstLine(e: any): string {
  const text = String(e?.stderr || e?.message || e).trim();
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300) ?? "unknown error";
}
