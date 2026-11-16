/**
 * Regression tests for resolveMergeTarget: /merge used to fall back to a
 * hardcoded "main" with no warning whenever the repo's real default branch
 * couldn't be detected (e.g. a remote just added, no fetch yet) — silently
 * wrong on a master/trunk repo, or one with an unrelated stray "main"
 * branch. This locks in the fix: prefer real detection, fall back to a
 * verified same-name guess, and always say which one happened.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepoTools } from "../src/repoTools.js";
import { detectDefaultBranch, branchExists, resolveMergeTarget, resolveMergeSource } from "../src/gitBranch.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function fakeRepo(cwd: string): RepoTools {
  return {
    git: async (args: string[]) => (await execFileAsync("git", args, { cwd })).stdout,
  } as RepoTools;
}

async function makeTempRepo(defaultBranch: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-gitbranch-test-"));
  tempDirs.push(dir);
  const repo = fakeRepo(dir);
  await repo.git(["init", "-q", "-b", defaultBranch]);
  await repo.git(["config", "user.email", "test@test.com"]);
  await repo.git(["config", "user.name", "test"]);
  await fs.writeFile(path.join(dir, "seed.txt"), "seed\n");
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "-q", "-m", "initial"]);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("detectDefaultBranch", () => {
  test("returns null when there is no origin remote at all", async () => {
    const dir = await makeTempRepo("main");
    assert.equal(await detectDefaultBranch(fakeRepo(dir)), null);
  });
});

describe("branchExists", () => {
  test("true for a real local branch, false for one that was never created", async () => {
    const dir = await makeTempRepo("main");
    const repo = fakeRepo(dir);
    assert.equal(await branchExists(repo, "main"), true);
    assert.equal(await branchExists(repo, "nonexistent-branch"), false);
  });
});

describe("resolveMergeTarget", () => {
  test("prefers a genuinely detected default branch over any guess", async () => {
    // Simulate detection by pointing origin/HEAD at a real ref locally —
    // detectDefaultBranch just reads refs/remotes/origin/HEAD, so a bare
    // symbolic ref is enough without needing an actual remote.
    const dir = await makeTempRepo("trunk");
    const repo = fakeRepo(dir);
    await repo.git(["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    await repo.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);

    const resolution = await resolveMergeTarget(repo);
    assert.deepEqual(resolution, { branch: "trunk", guessed: false });
  });

  test("falls back to a verified 'main' guess when detection fails but main exists", async () => {
    const dir = await makeTempRepo("main");
    const resolution = await resolveMergeTarget(fakeRepo(dir));
    assert.deepEqual(resolution, { branch: "main", guessed: true });
  });

  test("falls back to a verified 'master' guess when main does not exist", async () => {
    const dir = await makeTempRepo("master");
    const resolution = await resolveMergeTarget(fakeRepo(dir));
    assert.deepEqual(resolution, { branch: "master", guessed: true });
  });

  // The exact bug this fixes: a repo whose trunk is neither main nor master
  // (and has no detectable origin/HEAD) used to silently get "main" anyway.
  test("returns undefined rather than guessing wrong on a repo named neither main nor master", async () => {
    const dir = await makeTempRepo("develop");
    const resolution = await resolveMergeTarget(fakeRepo(dir));
    assert.equal(resolution, undefined);
  });
});

describe("resolveMergeSource", () => {
  test("defaults to the current branch when no argument is supplied", () => {
    assert.equal(resolveMergeSource(undefined, "feature-x", "main"), "feature-x");
  });

  test("treats the default branch name as an explicit destination request", () => {
    assert.equal(resolveMergeSource("main", "feature-x", "main"), "feature-x");
  });

  test("accepts the word default as an explicit destination request", () => {
    assert.equal(resolveMergeSource("default", "feature-x", "main"), "feature-x");
  });

  test("keeps other branch names as the source branch", () => {
    assert.equal(resolveMergeSource("release", "feature-x", "main"), "release");
  });
});
