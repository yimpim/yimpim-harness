/**
 * Regression tests for the multi-task backlog (.agent/task-queue.json) — the
 * mechanism behind "N more queued tasks, auto-continue?" (see Plan.followUpTasks
 * and the endTask("done", ...) site in index.ts). A bug here either loses a
 * user's remaining screens/chunks silently, or keeps nagging them to
 * auto-continue a backlog they already declined.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveTaskQueue, loadTaskQueue } from "../src/taskQueue.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-taskqueue-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("saveTaskQueue / loadTaskQueue", () => {
  test("round-trips a saved backlog in order", async () => {
    const repoRoot = await makeTempRepo();
    saveTaskQueue(repoRoot, ["redesign screen B", "redesign screen C"]);
    assert.deepEqual(loadTaskQueue(repoRoot), ["redesign screen B", "redesign screen C"]);
  });

  test("returns an empty array when nothing has ever been saved", async () => {
    const repoRoot = await makeTempRepo();
    assert.deepEqual(loadTaskQueue(repoRoot), []);
  });

  test("saving an empty list deletes the file rather than leaving a stale empty one", async () => {
    const repoRoot = await makeTempRepo();
    saveTaskQueue(repoRoot, ["redesign screen B"]);
    saveTaskQueue(repoRoot, []);
    assert.deepEqual(loadTaskQueue(repoRoot), []);
    await assert.rejects(() => fs.access(path.join(repoRoot, ".agent", "task-queue.json")));
  });

  test("blank/whitespace-only entries are dropped on save", async () => {
    const repoRoot = await makeTempRepo();
    saveTaskQueue(repoRoot, ["redesign screen B", "   ", ""]);
    assert.deepEqual(loadTaskQueue(repoRoot), ["redesign screen B"]);
  });

  test("entries are trimmed on save", async () => {
    const repoRoot = await makeTempRepo();
    saveTaskQueue(repoRoot, ["  redesign screen B  "]);
    assert.deepEqual(loadTaskQueue(repoRoot), ["redesign screen B"]);
  });

  test("a later save replaces the backlog outright rather than merging with it", async () => {
    const repoRoot = await makeTempRepo();
    saveTaskQueue(repoRoot, ["a", "b", "c"]);
    saveTaskQueue(repoRoot, ["x"]);
    assert.deepEqual(loadTaskQueue(repoRoot), ["x"]);
  });

  test("a malformed task-queue.json is treated as empty, not thrown", async () => {
    const repoRoot = await makeTempRepo();
    await fs.mkdir(path.join(repoRoot, ".agent"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".agent", "task-queue.json"), "not json", "utf-8");
    assert.deepEqual(loadTaskQueue(repoRoot), []);
  });

  test("a task-queue.json whose items field isn't an array is treated as empty", async () => {
    const repoRoot = await makeTempRepo();
    await fs.mkdir(path.join(repoRoot, ".agent"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".agent", "task-queue.json"), JSON.stringify({ items: "oops" }), "utf-8");
    assert.deepEqual(loadTaskQueue(repoRoot), []);
  });

  test("non-string entries in a hand-edited file are filtered out rather than crashing the read", async () => {
    const repoRoot = await makeTempRepo();
    await fs.mkdir(path.join(repoRoot, ".agent"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".agent", "task-queue.json"),
      JSON.stringify({ items: ["a real task", 42, null, "  "] }),
      "utf-8"
    );
    assert.deepEqual(loadTaskQueue(repoRoot), ["a real task"]);
  });
});
