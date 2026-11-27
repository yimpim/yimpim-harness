import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isUiUnreachableNote, AutonomousVerifier } from "../src/verifierTools.js";
import { saveResumeState, savePhaseRepairContext, loadPhaseRepairContext } from "../src/resumeState.js";
import { makePanel, formatSecuritySummary } from "../src/commandPanel.js";
import { events } from "../src/events.js";
import { translateForRemote } from "../src/remoteEventTranslator.js";

const tempDirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-qasec-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("uiUnreachable / build-only QA preservation across repairs", () => {
  test("isUiUnreachableNote detects not-yet-wired / later-phase UI notes", () => {
    assert.equal(isUiUnreachableNote("This modal component is not yet wired into App.tsx until a later phase."), true);
    assert.equal(isUiUnreachableNote("Build-only verification: component will be mounted in a later phase."), true);
    assert.equal(isUiUnreachableNote("Not reachable in the running UI yet."), true);
    assert.equal(isUiUnreachableNote("1. Open Settings screen. 2. Tap Save."), false);
    assert.equal(isUiUnreachableNote(undefined), false);
  });

  test("savePhaseRepairContext persists uiUnreachable across repair cycles and resumes", async () => {
    const dir = await makeRepo();
    saveResumeState(dir, {
      instructions: "Build settings modal",
      planOutput: "{}",
      timestamp: new Date().toISOString(),
    });
    savePhaseRepairContext(dir, "phase-1", {
      editorHowToVerify: "Component not yet wired until a later phase.",
      uiUnreachable: true,
      repairHistory: ["Attempt 1: fixed type error"],
    });
    const loaded = loadPhaseRepairContext(dir, "phase-1");
    assert.equal(loaded?.uiUnreachable, true);
  });

  test("AutonomousVerifier skips runtimeVisualGate when uiUnreachable is preserved from Editor across REPAIR", async () => {
    const dir = await makeRepo();
    const verifier = new AutonomousVerifier(
      dir,
      { complete: async () => ({ content: '{"passed":true,"reason":"ok"}' }) } as any,
      {
        git: async () => "",
        status: async () => "",
        diff: async () => "",
      } as any,
      {
        models: { verifier: ["m"], planner: ["m"], editor: ["m"] },
        limits: { maxFileBytes: 50_000 },
        verification: { enabled: true },
        qa: {},
      } as any,
      "sk-test"
    );

    let visualGateCalled = false;
    (verifier as any).runtimeVisualGate = async () => {
      visualGateCalled = true;
      return { observedRuntime: true, visualNote: "" };
    };
    (verifier as any).changeSetGate = async () => ({
      isEmpty: false,
      modified: ["src/NewModal.tsx"],
      added: [],
      deleted: [],
      renamed: [],
      diff: "+export function NewModal() { return null; }",
    });
    (verifier as any).buildGate = async (_p: any, _c: any, ledger: any) => {
      ledger.add({ tier: "build", gate: "tsc", method: "executed", status: "pass", blocking: true, detail: "ok" });
    };
    (verifier as any).semanticGate = async (_g: any, _ch: any, ledger: any) => {
      ledger.add({ tier: "semantic", gate: "semantic", method: "inspected", status: "pass", blocking: false, detail: "ok" });
    };
    (verifier as any).assertionGate = async () => {};
    (verifier as any).selectedTestGate = async () => {};
    (verifier as any).focusedTestGate = async () => {};
    (verifier as any).mustPassOriginalGate = async () => {};

    // Even when the post-repair goal text itself does not repeat the howToVerify note,
    // passing { uiUnreachable: true } preserved from the initial Editor pass skips runtimeVisualGate.
    const res = await verifier.runVerification("Fix TS error in NewModal.tsx", undefined, [], undefined, false, {
      uiUnreachable: true,
    });
    assert.equal(visualGateCalled, false, "runtimeVisualGate must be skipped when uiUnreachable is true");
    assert.equal(res.passed, true);
  });
});

describe("Remote SECURITY event summary enrichment", () => {
  test("formatSecuritySummary formats concise verdict + command summary", () => {
    assert.equal(formatSecuritySummary(2, 3, "npm run build"), "2/3 safe · npm run build");
    assert.equal(formatSecuritySummary(3, 3, "npm test"), "3/3 safe · npm test");
  });

  test("makePanel emits security.review event and translateForRemote forwards summary and verdict fields", async () => {
    const dir = await makeRepo();
    const emitted: any[] = [];
    const off = events.onEmit((ev) => {
      if (ev.type === "security.review") emitted.push(ev);
    });
    try {
      const panel = makePanel([
        { model: "a/m1", call: async () => '{"verdict":"safe","reason":"standard build"}' },
        { model: "b/m2", call: async () => '{"verdict":"safe","reason":"ok"}' },
        { model: "c/m3", call: async () => '{"verdict":"not_safe","reason":"unsure"}' },
      ]);
      const outcome = await panel.reviewCommand({
        argv: ["npm", "run", "build"],
        label: "npm run build",
        purpose: "verify build",
        cwd: dir,
        repoRoot: dir,
        created: [],
      });
      assert.equal(outcome.allow, false);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].summary, "2/3 safe · npm run build");
      assert.equal(emitted[0].safeCount, 2);
      assert.equal(emitted[0].totalCount, 3);

      const wire = translateForRemote(emitted[0], { id: "p1", name: "Build", verification: [] }, "task-1", "w-1", true);
      assert.ok(wire);
      assert.equal(wire.kind, "security.review");
      assert.equal(wire.payload.summary, "2/3 safe · npm run build");
      assert.equal(wire.payload.action, "npm run build");
      assert.equal(wire.payload.parentPhaseId, "p1");
    } finally {
      off();
    }
  });
});
