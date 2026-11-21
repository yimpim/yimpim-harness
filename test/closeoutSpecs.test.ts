/**
 * Closing out the specs: the phone is told an answer was taken by default, a planner's clarifying question takes the planner's own default when nobody answers, and what a freshly made
 * design system leaves to do becomes units in the roadmap's "Design" area.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateForRemote } from "../src/remoteEventTranslator.js";
import { defaultAnswerFor, ASSUMPTION_CONFIRM_OPTION, decideWithoutAsking } from "../src/planner.js";
import { designFollowUps, addDesignFollowUps, DESIGN_AREA } from "../src/designFollowUps.js";
import { loadRoadmap, addUnits, saveRoadmap, emptyRoadmap, markDone } from "../src/roadmap.js";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

describe("the phone is told an answer was taken by default", () => {
  const ev = (over: Record<string, unknown> = {}) => ({ type: "question.timedOut", id: "q1", answer: "blue", kind: "blocking", ...over }) as any;
  test("a plain log line, so an older phone shows it too, with the task and worker it belongs to", () => {
    const t = translateForRemote(ev(), undefined, "task-1", "worker-2")!;
    assert.deepEqual(t, { kind: "log", payload: { level: "info", message: 'Nobody answered in time, so "blue" was taken by default', taskId: "task-1", workerId: "worker-2" } });
  });
  test("an approval is said to have been refused; an empty default says 'the default'; a long answer is cut", () => {
    assert.equal((translateForRemote(ev({ kind: "approval", answer: "no" }))!.payload as any).message, 'Nobody answered in time, so it was refused (taken by default): "no"');
    assert.equal((translateForRemote(ev({ answer: "" }))!.payload as any).message, "Nobody answered in time, so the default was taken by default");
    assert.ok(((translateForRemote(ev({ answer: "x".repeat(500) }))!.payload as any).message as string).length < 260);
  });
});

describe("a planner's clarifying question when nobody answers", () => {
  test("an assumption is kept as planned; a question with options takes the first; a free-text question has no default", () => {
    assert.equal(defaultAnswerFor({ question: "The plan assumes: it is web only\nIs that right?", options: [ASSUMPTION_CONFIRM_OPTION, "No"] }), ASSUMPTION_CONFIRM_OPTION);
    assert.equal(defaultAnswerFor({ question: "Which database?", options: ["SQLite", "Postgres"] }), "SQLite");
    assert.equal(defaultAnswerFor({ question: "What name?", options: [] }), "");
  });
  test("it is the same default an unasked point is decided with, so asking and not asking agree", () => {
    for (const q of [{ question: "Which database?", options: ["SQLite", "Postgres"] }, { question: "The plan assumes: x\nIs that right?", options: [ASSUMPTION_CONFIRM_OPTION, "No"] }]) {
      const decided = decideWithoutAsking(q as any, false).choice;
      assert.ok(decided === defaultAnswerFor(q as any) || decided.startsWith("keep as planned"), `${q.question} -> ${decided}`);
    }
  });
  test("the question card carries it as its fallback (it was an empty string before)", () => {
    const idx = src("src/index.ts");
    assert.ok(idx.includes("fallback: defaultAnswerFor(cq),"));
    assert.ok(!/id: `plan_q\$\{round\}_\$\{i\}_\$\{runId\}`[\s\S]{0,300}fallback: "",/.test(idx));
  });
});

describe("what the design system leaves to do becomes units", () => {
  const made = { summary: "Design system written: tokens, components and an icon set (lucide)", files: ["design-system/MASTER.md", "design-system/icons.md"] };

  test("the icon set only when the design system names one; the empty states and the app icon and logo always", () => {
    assert.deepEqual(designFollowUps(made).map((d) => d.title), ["Icon set", "Empty, loading and error states", "App icon and logo"]);
    assert.deepEqual(designFollowUps({ summary: "Design system written", files: ["design-system/MASTER.md"] }).map((d) => d.title), ["Empty, loading and error states", "App icon and logo"]);
    assert.ok(designFollowUps(made).every((d) => d.area === DESIGN_AREA && (d.acceptance ?? []).length >= 2));
    assert.deepEqual(designFollowUps(made).map((d) => d.buildsUi), [false, true, false]);
  });

  const roadmapWith = (titles: { title: string; area?: string }[]) => {
    const rm = emptyRoadmap("a fridge app", "idea");
    addUnits(rm, titles, "plan");
    saveRoadmap(root, rm);
    return rm;
  };

  test("added to the active roadmap in the Design area, depending on the Design system unit when there is one, and never twice", () => {
    roadmapWith([{ title: "Design system", area: "Design" }, { title: "Inventory list screen", area: "UI" }]);
    assert.equal(addDesignFollowUps(root, made), 3);
    const units = loadRoadmap(root)!.units;
    const empty = units.find((u) => u.title === "Empty, loading and error states")!;
    assert.equal(empty.area, "Design");
    assert.equal(empty.addedBy, "plan");
    assert.deepEqual(empty.deps.map((id) => units.find((u) => u.id === id)?.title), ["Design system"]);
    assert.equal(empty.buildsUi, true);
    assert.equal(addDesignFollowUps(root, made), 0, "a second design system does not add them again");
    assert.equal(loadRoadmap(root)!.units.length, 5);
  });

  test("with no Design system unit they depend on nothing; with no roadmap, or a finished one, nothing is added", () => {
    roadmapWith([{ title: "Data model", area: "Data" }]);
    assert.equal(addDesignFollowUps(root, made), 3);
    assert.deepEqual(loadRoadmap(root)!.units.find((u) => u.title === "Icon set")!.deps, []);

    const none = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-none-"));
    try {
      assert.equal(addDesignFollowUps(none, made), 0);
    } finally {
      fs.rmSync(none, { recursive: true, force: true });
    }

    const done = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-done-"));
    try {
      const rm = emptyRoadmap("g", "idea");
      addUnits(rm, [{ title: "Only unit", area: "Core" }], "plan");
      markDone(rm, rm.units[0].id, { files: [], summary: "done" });
      saveRoadmap(done, rm);
      assert.equal(addDesignFollowUps(done, made), 0);
    } finally {
      fs.rmSync(done, { recursive: true, force: true });
    }
  });

  test("it runs right after the design system is made, only when one was actually created", () => {
    const idx = src("src/index.ts");
    assert.ok(idx.includes("if (made?.created) {\n          const added = addDesignFollowUps(repoRoot, made);"));
    assert.ok(idx.indexOf('if (made) console.log("🎨 [DESIGN] " + made.summary);') < idx.indexOf("addDesignFollowUps(repoRoot, made)"));
  });
});
