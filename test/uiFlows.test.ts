/**
 * Regression tests for the learned-UI-flow replay/self-heal/persist cycle:
 * a recorded path should replay without a vision call while it still
 * matches the live screen, abandon replay the moment a step's element goes
 * missing, and always persist whatever path a run actually took.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NavFlowReplayer, findUiFlow, nearestHintLabel, saveUiFlow, loadUiFlows } from "../src/uiFlows.js";
import { NavHint } from "../src/visualProbes.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-uiflows-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const hint = (label: string, xPercent = 50, yPercent = 50): NavHint => ({ label, xPercent, yPercent });

describe("NavFlowReplayer", () => {
  test("with no prior flow, never replays and records nothing to finish with", async () => {
    const repoRoot = await makeTempRepo();
    const replayer = new NavFlowReplayer(repoRoot, "android", "open settings");

    assert.equal(replayer.nextReplayHint([hint("Settings")]), undefined);
    assert.equal(replayer.justCompleted, false);

    replayer.finish();
    assert.equal(findUiFlow(repoRoot, "android", "open settings"), undefined);
  });

  test("replays a recorded path step by step while every label still matches", async () => {
    const repoRoot = await makeTempRepo();
    saveUiFlow(repoRoot, "android", "open settings", [{ label: "Menu" }, { label: "Settings" }]);

    const replayer = new NavFlowReplayer(repoRoot, "android", "open settings");

    const step1 = replayer.nextReplayHint([hint("Menu", 10, 20), hint("Home", 90, 90)]);
    assert.equal(step1?.label, "Menu");
    assert.equal(replayer.justCompleted, false);

    const step2 = replayer.nextReplayHint([hint("Settings", 30, 40)]);
    assert.equal(step2?.label, "Settings");

    // Every recorded step consumed — the caller should treat this as arrived
    // without spending another vision call to confirm it.
    assert.equal(replayer.nextReplayHint([hint("Settings")]), undefined);
    assert.equal(replayer.justCompleted, true);
  });

  test("abandons replay for the rest of the run the moment a recorded label goes missing", async () => {
    const repoRoot = await makeTempRepo();
    saveUiFlow(repoRoot, "android", "open settings", [{ label: "Menu" }, { label: "Settings" }]);

    const replayer = new NavFlowReplayer(repoRoot, "android", "open settings");
    assert.ok(replayer.nextReplayHint([hint("Menu")]));

    // The UI changed: "Settings" isn't on this screen anymore.
    assert.equal(replayer.nextReplayHint([hint("Preferences")]), undefined);
    assert.equal(replayer.justCompleted, false);

    // Even if a later screenshot happens to show "Settings" again, replay
    // must not resume — the path already proved unreliable this run.
    assert.equal(replayer.nextReplayHint([hint("Settings")]), undefined);
  });

  test("finish() persists whatever path was actually recorded, overwriting a stale one", async () => {
    const repoRoot = await makeTempRepo();
    saveUiFlow(repoRoot, "android", "open settings", [{ label: "Old Menu" }]);

    const replayer = new NavFlowReplayer(repoRoot, "android", "open settings");
    replayer.recordStep("New Menu");
    replayer.recordStep("Settings");
    replayer.finish();

    const flow = findUiFlow(repoRoot, "android", "open settings");
    assert.deepEqual(flow?.steps, [{ label: "New Menu" }, { label: "Settings" }]);
  });

  test("finish() with nothing recorded leaves an existing flow untouched", async () => {
    const repoRoot = await makeTempRepo();
    saveUiFlow(repoRoot, "android", "open settings", [{ label: "Menu" }]);

    const replayer = new NavFlowReplayer(repoRoot, "android", "unrelated goal");
    replayer.finish();

    assert.deepEqual(findUiFlow(repoRoot, "android", "open settings")?.steps, [{ label: "Menu" }]);
    assert.equal(findUiFlow(repoRoot, "android", "unrelated goal"), undefined);
  });

  test("flows are scoped per platform — an android flow never satisfies a web replay", async () => {
    const repoRoot = await makeTempRepo();
    saveUiFlow(repoRoot, "android", "open settings", [{ label: "Menu" }]);

    const replayer = new NavFlowReplayer(repoRoot, "web", "open settings");
    assert.equal(replayer.nextReplayHint([hint("Menu")]), undefined);
    assert.equal(replayer.justCompleted, false);
  });
});

describe("saveUiFlow eviction", () => {
  // Regression test: a long-lived project re-verifying many different
  // requirements over weeks/months used to accumulate a flow entry per
  // unique goal FOREVER, with no cap — unlike historicalPitfalls in
  // codebase-memory.json, which has always self-limited to 15.
  test("evicts the stalest entries once past the stored-flow limit, keeping the most recently touched ones", async () => {
    const repoRoot = await makeTempRepo();

    // Save well past the cap, each with a distinct, increasing updatedAt.
    for (let i = 0; i < 210; i++) {
      saveUiFlow(repoRoot, "android", `goal-${i}`, [{ label: `step-${i}` }]);
      // saveUiFlow timestamps with `new Date().toISOString()` — force a tick
      // so 210 saves in a tight loop don't all collide on the same millisecond.
      await new Promise((r) => setTimeout(r, 1));
    }

    const flows = loadUiFlows(repoRoot);
    assert.equal(flows.length, 200);
    // The oldest ones (goal-0..goal-9) must be gone; the newest must remain.
    assert.equal(findUiFlow(repoRoot, "android", "goal-0"), undefined);
    assert.ok(findUiFlow(repoRoot, "android", "goal-209"));
  });
});

describe("nearestHintLabel", () => {
  test("picks the closest hint by percent distance", () => {
    const hints = [hint("Far", 90, 90), hint("Close", 51, 49), hint("Closer", 50, 50)];
    assert.equal(nearestHintLabel(hints, 50, 50), "Closer");
  });

  test("returns undefined when nothing is close enough to trust as the same element", () => {
    const hints = [hint("Elsewhere", 5, 5)];
    assert.equal(nearestHintLabel(hints, 95, 95), undefined);
  });

  test("returns undefined against an empty hint list", () => {
    assert.equal(nearestHintLabel([], 50, 50), undefined);
  });
});
