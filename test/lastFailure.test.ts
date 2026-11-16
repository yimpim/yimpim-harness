/**
 * Regression tests for the ephemeral "previous task failed" note
 * (.agent/last-failure.json) — surfaced once to the next fresh plan, then
 * cleared the next time a task completes cleanly. Built because a vague
 * follow-up like "fix the bugs that aborted last time, then continue
 * progress.md" had no actual record to act on: the planner had no way to
 * know what failed, so it tended to just act on the concrete "continue"
 * part and silently drop the vague one.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveLastFailure, loadLastFailure, clearLastFailure } from "../src/lastFailure.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-lastfailure-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("saveLastFailure / loadLastFailure / clearLastFailure", () => {
  test("round-trips a saved failure note", async () => {
    const repoRoot = await makeTempRepo();
    saveLastFailure(repoRoot, {
      taskId: "task-1",
      reason: "Phase 'Fix login' failed: all 10 repair attempts were exhausted",
      at: "2026-10-04T00:00:00.000Z",
    });
    const loaded = loadLastFailure(repoRoot);
    assert.equal(loaded?.taskId, "task-1");
    assert.equal(loaded?.reason, "Phase 'Fix login' failed: all 10 repair attempts were exhausted");
  });

  test("returns null when nothing has ever been saved", async () => {
    const repoRoot = await makeTempRepo();
    assert.equal(loadLastFailure(repoRoot), null);
  });

  test("clearLastFailure removes the note so it is no longer surfaced", async () => {
    const repoRoot = await makeTempRepo();
    saveLastFailure(repoRoot, { taskId: "task-1", reason: "boom", at: "2026-10-04T00:00:00.000Z" });
    clearLastFailure(repoRoot);
    assert.equal(loadLastFailure(repoRoot), null);
  });

  test("clearLastFailure on an already-clear repo is a harmless no-op", async () => {
    const repoRoot = await makeTempRepo();
    assert.doesNotThrow(() => clearLastFailure(repoRoot));
  });

  test("a later save replaces the note outright, not merges with it", async () => {
    const repoRoot = await makeTempRepo();
    saveLastFailure(repoRoot, { taskId: "task-1", reason: "first failure", at: "2026-10-04T00:00:00.000Z" });
    saveLastFailure(repoRoot, { taskId: "task-2", reason: "second failure", at: "2026-10-04T01:00:00.000Z" });
    const loaded = loadLastFailure(repoRoot);
    assert.equal(loaded?.taskId, "task-2");
    assert.equal(loaded?.reason, "second failure");
  });

  test("a malformed last-failure.json is treated as absent, not thrown", async () => {
    const repoRoot = await makeTempRepo();
    await fs.mkdir(path.join(repoRoot, ".agent"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".agent", "last-failure.json"), "not json", "utf-8");
    assert.equal(loadLastFailure(repoRoot), null);
  });
});
