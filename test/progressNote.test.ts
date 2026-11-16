/**
 * Each phase is told what the earlier ones actually did, so a brief written
 * before any code existed cannot send it to a file that has since moved. The
 * note is bounded, built without a model, and lives only as long as the task.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPhaseProgress, renderProgressNote } from "../src/progressNote.js";
import { loadResumeState, saveResumeState, savePhaseRepairContext } from "../src/resumeState.js";

const phase = (over: Record<string, unknown> = {}) =>
  buildPhaseProgress({
    phaseId: "p1",
    name: "1/3 Scope the live timeline",
    files: ["app/dashboard.tsx", "src/models/timeline.ts"],
    ...over,
  } as any);

describe("buildPhaseProgress", () => {
  test("records what the phase did, with paths in one form and each file once", () => {
    const p = phase({ files: ["src\\a.ts", "src/a.ts", "src/b.ts"] });
    assert.deepEqual(p.files, ["src/a.ts", "src/b.ts"]);
  });

  test("every list is bounded, so a large phase cannot flood the next brief", () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const p = phase({
      files: many,
      sync: {
        moved: many.map((f) => ({ symbol: "s", from: f, to: "x.ts" })),
        renamed: many.map((f) => ({ from: f, to: "y.ts" })),
        removed: many,
        added: many,
      },
      deltas: many.map((f) => ({ id: f, action: "modified", reason: "r".repeat(500) })),
      unverified: many.map(() => "u".repeat(900)),
    });
    assert.ok(p.files.length <= 14);
    assert.ok(p.moved.length <= 8 && p.renamed.length <= 6 && p.removed.length <= 6 && p.added.length <= 6);
    assert.ok(p.differs.length <= 6 && p.differs.every((d) => d.reason.length <= 160));
    assert.ok(p.unverified.length <= 4 && p.unverified.every((u) => u.length <= 200));
  });
});

describe("renderProgressNote", () => {
  test("nothing to say before any phase has finished", () => {
    assert.equal(renderProgressNote([]), "");
  });

  test("says what changed, where things are now, what differed, and what QA could not check", () => {
    const text = renderProgressNote([
      phase({
        sync: {
          moved: [{ symbol: "workerTypeFor", from: "src/models/timeline.ts", to: "src/models/workers.ts" }],
          renamed: [{ from: "src/old.ts", to: "src/new.ts" }],
          removed: ["src/dead.ts"],
          added: ["src/models/workers.ts"],
        },
        deltas: [{ id: "A3", action: "modified", reason: "label wording changed" }],
        unverified: ["dark theme: the app ignores the browser setting"],
      }),
    ]);
    assert.match(text, /WHAT HAS CHANGED SO FAR IN THIS TASK/);
    assert.match(text, /changed app\/dashboard\.tsx, src\/models\/timeline\.ts/);
    assert.match(text, /workerTypeFor moved from src\/models\/timeline\.ts to src\/models\/workers\.ts/);
    assert.match(text, /src\/old\.ts is now src\/new\.ts/);
    assert.match(text, /src\/dead\.ts was deleted/);
    assert.match(text, /\[A3\] modified \(label wording changed\)/);
    assert.match(text, /QA could not verify: dark theme/);
  });

  test("a phase that found the work already done says so", () => {
    const text = renderProgressNote([phase({ files: [], alreadyDone: "the reducer already forwards reason" })]);
    assert.match(text, /changed no files/);
    assert.match(text, /already implemented, nothing changed: the reducer already forwards reason/);
  });

  test("it tells the Editor the brief predates these phases and the code on disk is final", () => {
    const text = renderProgressNote([phase()]);
    assert.match(text, /this brief was written before they ran, so where it disagrees with this, this is right/);
    assert.match(text, /The code on disk is the final word/);
  });

  test("when it must be cut, the most recent phases are kept and the omission is stated", () => {
    const done = Array.from({ length: 12 }, (_, i) =>
      buildPhaseProgress({ phaseId: `p${i}`, name: `Phase number ${i}`, files: Array.from({ length: 10 }, (_, j) => `src/dir${i}/file${j}.ts`) })
    );
    const text = renderProgressNote(done, 900);
    assert.match(text, /Phase number 11/);
    assert.doesNotMatch(text, /Phase number 0"/);
    assert.match(text, /\(\d+ earlier phase\(s\) not shown\)/);
    assert.ok(text.length < 1700, `${text.length} characters`);
  });
});

describe("it lives and dies with the task", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pn-"));
  const base = { instructions: "do it", planOutput: "plan", timestamp: "now" };

  test("it is saved with the resume state, so a --resume still knows what finished phases did", () => {
    const d = dir();
    saveResumeState(d, { ...base, completedPhaseIds: ["p1"], progress: [phase()] });
    assert.equal(loadResumeState(d)!.progress![0].name, "1/3 Scope the live timeline");
  });

  test("a new task's plan replaces it, so it can never grow across tasks", () => {
    const d = dir();
    saveResumeState(d, { ...base, completedPhaseIds: ["p1"], progress: [phase()] });
    saveResumeState(d, { ...base, instructions: "a different task", completedPhaseIds: [] });
    assert.equal(loadResumeState(d)!.progress, undefined);
  });

  test("a repair attempt's own save does not wipe it", () => {
    const d = dir();
    saveResumeState(d, { ...base, completedPhaseIds: ["p1"], progress: [phase()] });
    savePhaseRepairContext(d, "p2", { repairHistory: ["tried x"] });
    assert.equal(loadResumeState(d)!.progress!.length, 1);
  });

  test("no new file is created for it", () => {
    const d = dir();
    saveResumeState(d, { ...base, progress: [phase()] });
    assert.deepEqual(fs.readdirSync(path.join(d, ".agent")), ["last-plan.json"]);
  });
});
