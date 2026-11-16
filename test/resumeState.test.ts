/**
 * Regression tests for repair history surviving `yimpim --resume`: a phase
 * that exhausted its repair budget used to lose everything it had learned
 * the moment the process ended — the exact scenario the history-threading
 * feature exists for (a fix that needs more than one process's worth of
 * tries) got no benefit from it across a restart.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveResumeState,
  loadResumeState,
  loadPhaseRepairContext,
  savePhaseRepairContext,
} from "../src/resumeState.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-resumestate-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseState = {
  instructions: "add a garage screen",
  planOutput: "{}",
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("saveResumeState / loadResumeState", () => {
  test("round-trips a plain resume state", async () => {
    const repoRoot = await makeTempRepo();
    saveResumeState(repoRoot, { ...baseState, completedPhaseIds: ["phase-1"] });
    assert.deepEqual(loadResumeState(repoRoot)?.completedPhaseIds, ["phase-1"]);
  });

  test("returns null when nothing has ever been saved", async () => {
    const repoRoot = await makeTempRepo();
    assert.equal(loadResumeState(repoRoot), null);
  });
});

describe("savePhaseRepairContext / loadPhaseRepairContext", () => {
  test("does nothing when no resume state exists yet — nothing to attach it to", async () => {
    const repoRoot = await makeTempRepo();
    savePhaseRepairContext(repoRoot, "phase-1", { editorHowToVerify: "tap X", repairHistory: [] });
    assert.equal(loadResumeState(repoRoot), null);
    assert.equal(loadPhaseRepairContext(repoRoot, "phase-1"), undefined);
  });

  test("persists repair context for a phase once a resume state baseline exists", async () => {
    const repoRoot = await makeTempRepo();
    saveResumeState(repoRoot, { ...baseState, completedPhaseIds: [] });

    savePhaseRepairContext(repoRoot, "phase-1", {
      editorHowToVerify: "tap Garage on the main menu",
      repairHistory: ['Attempt 1: you said — "used Ellipsis". QA then found: still truncated.'],
    });

    const context = loadPhaseRepairContext(repoRoot, "phase-1");
    assert.equal(context?.editorHowToVerify, "tap Garage on the main menu");
    assert.equal(context?.repairHistory.length, 1);
  });

  test("updating one phase's context leaves the rest of the resume state and other phases untouched", async () => {
    const repoRoot = await makeTempRepo();
    saveResumeState(repoRoot, { ...baseState, completedPhaseIds: ["phase-1"] });
    savePhaseRepairContext(repoRoot, "phase-2", { editorHowToVerify: "a", repairHistory: [] });
    savePhaseRepairContext(repoRoot, "phase-3", { editorHowToVerify: "b", repairHistory: [] });

    // Overwrite phase-2 only.
    savePhaseRepairContext(repoRoot, "phase-2", { editorHowToVerify: "a-updated", repairHistory: ["x"] });

    const state = loadResumeState(repoRoot);
    assert.deepEqual(state?.completedPhaseIds, ["phase-1"], "unrelated fields must survive the read-modify-write");
    assert.equal(loadPhaseRepairContext(repoRoot, "phase-2")?.editorHowToVerify, "a-updated");
    assert.deepEqual(loadPhaseRepairContext(repoRoot, "phase-3"), { editorHowToVerify: "b", repairHistory: [] });
  });

  test("clearing a phase's context (undefined) removes just that entry — the fix for once a phase passes", async () => {
    const repoRoot = await makeTempRepo();
    saveResumeState(repoRoot, { ...baseState, completedPhaseIds: [] });
    savePhaseRepairContext(repoRoot, "phase-1", { editorHowToVerify: "a", repairHistory: [] });
    savePhaseRepairContext(repoRoot, "phase-2", { editorHowToVerify: "b", repairHistory: [] });

    savePhaseRepairContext(repoRoot, "phase-1", undefined);

    assert.equal(loadPhaseRepairContext(repoRoot, "phase-1"), undefined);
    assert.ok(loadPhaseRepairContext(repoRoot, "phase-2"));
  });

  test("a phase that never failed a repair attempt has no context, even with other phases present", async () => {
    const repoRoot = await makeTempRepo();
    saveResumeState(repoRoot, { ...baseState, completedPhaseIds: [] });
    savePhaseRepairContext(repoRoot, "phase-1", { editorHowToVerify: "a", repairHistory: [] });

    assert.equal(loadPhaseRepairContext(repoRoot, "phase-never-failed"), undefined);
  });
});
