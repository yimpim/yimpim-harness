/** What a roadmap remembers: the full brief, clean evidence, open items, and a finished roadmap put away. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyRoadmap, addUnits, markDone, markStarted, saveRoadmap, loadRoadmap, isFinished, openItems, addOpenItem,
  archiveFinishedRoadmap, isEvidenceNoise, unitTaskPrompt, roadmapWire,
} from "../src/roadmap.js";
import { shortTitle, parseRoadmapCommand, manualUpdate, createRoadmap } from "../src/roadmapFlow.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-record-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const twoUnits = (goal = "g") => {
  const rm = emptyRoadmap(goal, "idea");
  addUnits(rm, [{ title: "First", summary: "s1" }, { title: "Second", summary: "s2", deps: ["First"] }]);
  return rm;
};

describe("the full brief is kept", () => {
  test("a long request is stored whole next to the clipped goal", () => {
    const long = "Read first: spec.md. " + "detail ".repeat(200);
    const rm = emptyRoadmap(long, "idea");
    assert.ok(rm.goal.length <= 500);
    assert.equal(rm.brief, long.trim());
  });
  test("a short request needs no separate brief", () => {
    assert.equal(emptyRoadmap("short", "idea").brief, undefined);
  });
  test("each unit's task text carries it", () => {
    const long = "x ".repeat(400);
    const rm = emptyRoadmap(long, "idea");
    addUnits(rm, [{ title: "A" }]);
    assert.match(unitTaskPrompt(rm, rm.units[0]), /The full request this roadmap came from/);
  });
});

describe("evidence is the unit's own work", () => {
  test("logs, review notes and tool caches are left out", () => {
    for (const p of [".expo/dev/logs/start.log", "QA_REVIEW.md", "app/QA_REVIEW.md", "node_modules/x/y.js", "build/out.js", "a/b.log", ".agent/roadmap.json"]) {
      assert.ok(isEvidenceNoise(p), p);
    }
    for (const p of ["src/a.ts", "__tests__/a.test.ts", "reference/specs/ROADMAP_SPEC.md", "app/build.tsx"]) assert.ok(!isEvidenceNoise(p), p);
  });
  test("markDone drops them from the record", () => {
    const rm = twoUnits();
    markDone(rm, "U001", { files: ["src/a.ts", ".expo/dev/logs/start.log", "QA_REVIEW.md", "src\\b.ts"] });
    assert.deepEqual(rm.units[0].done?.files, ["src/a.ts", "src/b.ts"]);
  });
});

describe("done with open items", () => {
  test("the unit stays done, the item is kept and shown", () => {
    const rm = twoUnits();
    markDone(rm, "U001", { summary: "s", openItems: ["server side not in this repo"] });
    assert.equal(rm.units[0].status, "done");
    assert.deepEqual(openItems(rm).map((o) => o.item), ["server side not in this repo"]);
    assert.match(unitTaskPrompt(rm, rm.units[1]), /left open: server side not in this repo/);
    assert.deepEqual(roadmapWire(rm)!.units[0].result?.openItems, ["server side not in this repo"]);
  });
  test("/roadmap open adds a note to a finished unit only", () => {
    const rm = twoUnits();
    markDone(rm, "U001", {});
    saveRoadmap(dir, rm);
    assert.deepEqual(parseRoadmapCommand("open U001 check the broker"), { kind: "open", id: "U001", note: "check the broker" });
    assert.deepEqual(parseRoadmapCommand("open U001"), { kind: "help" });
    assert.equal(manualUpdate(dir, { kind: "open", id: "U001", note: "check the broker" }), "Noted on U001.");
    assert.match(manualUpdate(dir, { kind: "open", id: "U002", note: "x" }), /not a finished unit/);
    assert.equal(addOpenItem(loadRoadmap(dir)!, "U001", "second"), true);
    assert.deepEqual(openItems(loadRoadmap(dir)!).map((o) => o.item), ["check the broker"]);
  });
});

describe("a finished roadmap is put away", () => {
  test("the last unit stamps completedAt; reopening clears it", () => {
    const rm = twoUnits();
    markStarted(rm, "U001");
    markDone(rm, "U001", {});
    assert.equal(rm.completedAt, undefined);
    markDone(rm, "U002", {});
    assert.ok(isFinished(rm) && rm.completedAt);
    rm.units[1].status = "todo";
    saveRoadmap(dir, rm);
    assert.equal(loadRoadmap(dir)!.completedAt, undefined);
  });
  test("archiving moves it to .agent/roadmaps and frees the active slot", () => {
    const rm = twoUnits();
    markDone(rm, "U001", {});
    markDone(rm, "U002", {});
    saveRoadmap(dir, rm);
    const file = archiveFinishedRoadmap(dir)!;
    assert.ok(file.includes(path.join(".agent", "roadmaps")) && fs.existsSync(file));
    assert.equal(loadRoadmap(dir), undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).units.length, 2);
  });
  test("an unfinished roadmap is left alone", () => {
    const rm = twoUnits();
    markDone(rm, "U001", {});
    saveRoadmap(dir, rm);
    assert.equal(archiveFinishedRoadmap(dir), undefined);
    assert.ok(loadRoadmap(dir));
  });
});

describe("titles", () => {
  test("cut at a word with an ellipsis, not mid-word", () => {
    const t = shortTitle("Add server-side validation and database constraints for model role metadata and set_model role IDs, including limits");
    assert.ok(t.length <= 91 && t.endsWith("…") && !/\s…$/.test(t));
    assert.equal(shortTitle("short one"), "short one");
  });
});

describe("a new job after a finished roadmap", () => {
  test("createRoadmap no longer refuses because a finished one exists", async () => {
    const rm = twoUnits();
    markDone(rm, "U001", {});
    markDone(rm, "U002", {});
    saveRoadmap(dir, rm);
    const res = await createRoadmap({ repoRoot: dir, complete: async () => "" } as any, { goal: "something new" }).catch(() => undefined);
    // Whatever the model stub does next, the old roadmap was archived rather than blocking with "already exists".
    assert.ok(!res || !/already exists/.test(res.text));
    assert.ok(fs.readdirSync(path.join(dir, ".agent", "roadmaps")).length === 1);
  });
});
