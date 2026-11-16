/**
 * What the Editor claimed about a phase (assertion differences, "the permanent
 * tests need no change") is saved with the phase's repair context, so a resumed
 * phase does not lose it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPhaseRepairContext, saveResumeState, savePhaseRepairContext } from "../src/resumeState.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWithResumeState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-resumectx-"));
  dirs.push(dir);
  saveResumeState(dir, { instructions: "i", planOutput: "{}", timestamp: "t" } as any);
  return dir;
}

describe("phase repair context", () => {
  test("assertion differences and the tests-not-needed claim round-trip", () => {
    const dir = repoWithResumeState();
    savePhaseRepairContext(dir, "phase-2", {
      repairHistory: ["Attempt 1: …"],
      editorHowToVerify: "1. tap Save",
      assertionDeltas: [{ id: "A2", action: "modified", reason: "also shows size", replacement: "name and size are visible" }],
      testsNotNeeded: "pure rename",
    });
    const back = loadPhaseRepairContext(dir, "phase-2");
    assert.deepEqual(back?.assertionDeltas, [
      { id: "A2", action: "modified", reason: "also shows size", replacement: "name and size are visible" },
    ]);
    assert.equal(back?.testsNotNeeded, "pure rename");
    assert.equal(back?.editorHowToVerify, "1. tap Save");
    assert.deepEqual(back?.repairHistory, ["Attempt 1: …"]);
  });

  test("a context saved before these fields existed still loads", () => {
    const dir = repoWithResumeState();
    savePhaseRepairContext(dir, "phase-1", { repairHistory: ["old"], editorHowToVerify: "x" });
    const back = loadPhaseRepairContext(dir, "phase-1");
    assert.equal(back?.assertionDeltas, undefined);
    assert.equal(back?.testsNotNeeded, undefined);
    assert.deepEqual(back?.repairHistory, ["old"]);
  });

  test("clearing a phase's context (it passed) removes the claims too", () => {
    const dir = repoWithResumeState();
    savePhaseRepairContext(dir, "phase-3", { repairHistory: [], testsNotNeeded: "docs only" });
    savePhaseRepairContext(dir, "phase-3", undefined);
    assert.equal(loadPhaseRepairContext(dir, "phase-3"), undefined);
  });

  test("saving one phase's context leaves another phase's untouched", () => {
    const dir = repoWithResumeState();
    savePhaseRepairContext(dir, "phase-1", { repairHistory: [], testsNotNeeded: "a" });
    savePhaseRepairContext(dir, "phase-2", { repairHistory: [], testsNotNeeded: "b" });
    assert.equal(loadPhaseRepairContext(dir, "phase-1")?.testsNotNeeded, "a");
    assert.equal(loadPhaseRepairContext(dir, "phase-2")?.testsNotNeeded, "b");
  });
});
