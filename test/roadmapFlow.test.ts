/**
 * The roadmap in use: planned from an idea or a reference, worked through one
 * unit at a time, added to, and checked against the world.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRoadmap, nextUnits } from "../src/roadmap.js";
import {
  MAX_UNIT_ATTEMPTS,
  absorbOverflow,
  absorbUncovered,
  changeRoadmap,
  checkDrift,
  createRoadmap,
  describeDrift,
  failUnit,
  finishUnit,
  manualUpdate,
  parseRoadmapCommand,
  resetRoadmap,
  startNext,
} from "../src/roadmapFlow.js";
import type { Msg } from "../src/roadmapPlan.js";

const repo = (files: Record<string, string> = {}): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const IDEA = {
  units: [
    { title: "Accounts", area: "Foundation", summary: "Sign up.", deps: [], acceptance: ["sign in works"] },
    { title: "Listings", area: "Core", summary: "Post a sale.", deps: ["Accounts"] },
    { title: "Search", area: "Core", deps: ["Listings"] },
  ],
  conventions: ["Mobile first"],
  assumptions: ["Free to use"],
};

describe("planning from an idea", () => {
  test("in the ask-everything mode, the questions are asked and the plan is redone with the answers", async () => {
    const d = repo();
    const calls: Msg[][] = [];
    const asked: string[] = [];
    const out = await createRoadmap(
      {
        repoRoot: d,
        complete: async (m) => {
          calls.push(m);
          return JSON.stringify(calls.length === 1 ? { ...IDEA, questions: [{ question: "Who is it for?", options: ["Neighbors", "Anyone"] }] } : IDEA);
        },
        ask: async (q) => (asked.push(q.question), "Neighbors"),
        questionMode: "all",
      },
      { goal: "a garage sale app" }
    );
    assert.equal(out.ok, true);
    assert.deepEqual(asked, ["Who is it for?"]);
    assert.equal(calls.length, 2);
    assert.match(calls[1][1].content, /Who is it for\? -> Neighbors/);
    const rm = loadRoadmap(d)!;
    assert.equal(rm.kind, "idea");
    assert.equal(rm.units.length, 3);
    assert.ok(rm.conventions.includes("Who is it for? -> Neighbors"));
    assert.ok(rm.conventions.some((c) => /Assumed, not confirmed: Free to use/.test(c)));
    assert.match(out.text, /Roadmap: a garage sale app/);
  });

  test("by default a point that is not hard to undo is decided, recorded, and the plan redone, with nobody asked", async () => {
    const d = repo();
    const calls: Msg[][] = [];
    const asked: string[] = [];
    await createRoadmap(
      {
        repoRoot: d,
        complete: async (m) => (calls.push(m), JSON.stringify(calls.length === 1 ? { ...IDEA, questions: [{ question: "Who is it for?", options: ["Neighbors", "Anyone"] }] } : IDEA)),
        ask: async (q) => (asked.push(q.question), "x"),
      },
      { goal: "g" }
    );
    assert.deepEqual(asked, []);
    assert.equal(calls.length, 2);
    assert.match(calls[1][1].content, /Who is it for\? -> Neighbors \(decided for you/);
    assert.ok(loadRoadmap(d)!.conventions.includes("Decided without asking: Who is it for? -> Neighbors"));
  });

  test("something hard to undo is asked, and with nobody there it is decided and flagged for review", async () => {
    const d = repo();
    await createRoadmap(
      { repoRoot: d, complete: async () => JSON.stringify({ ...IDEA, questions: [{ question: "Use a paid service for maps?", options: ["no", "yes"] }] }) },
      { goal: "g" }
    );
    assert.ok(loadRoadmap(d)!.conventions.some((c) => /^REVIEW: Decided without asking: Use a paid service for maps\? -> no/.test(c)));
  });

  test("in the ask-everything mode with nobody to ask, the open question is written down as such, not guessed away", async () => {
    const d = repo();
    await createRoadmap(
      { repoRoot: d, questionMode: "all", complete: async () => JSON.stringify({ ...IDEA, questions: [{ question: "Which platforms?", options: ["iOS", "Android"] }] }) },
      { goal: "g" }
    );
    assert.ok(loadRoadmap(d)!.conventions.some((c) => /Open question, nobody was available to answer: Which platforms\?/.test(c)));
  });

  test("a plan that is nonsense writes nothing", async () => {
    const d = repo();
    const out = await createRoadmap({ repoRoot: d, complete: async () => "no" }, { goal: "g" });
    assert.equal(out.ok, false);
    assert.equal(loadRoadmap(d), undefined);
  });

  test("an existing roadmap is never overwritten by accident", async () => {
    const d = repo();
    await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "first" });
    const again = await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "second" });
    assert.equal(again.ok, false);
    assert.match(again.text, /already exists.*\/roadmap add.*\/roadmap reset/);
    assert.equal(loadRoadmap(d)!.goal, "first");
    assert.equal((await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "second", replace: true })).ok, true);
    assert.equal(loadRoadmap(d)!.goal, "second");
  });
});

describe("planning from a reference folder", () => {
  const ref = () =>
    repo(Object.fromEntries(["a", "b"].flatMap((x) => [1, 2, 3, 4].map((i) => [`ref/${x}dir/${x}File${i}.kt`, `class ${x.toUpperCase()}Type${i}\n`]))));

  test("every reference file ends up owned, and it says so", async () => {
    const d = ref();
    const out = await createRoadmap(
      {
        repoRoot: d,
        complete: async (m) => {
          const ids = [...m[1].content.matchAll(/^(M\d{3}) /gm)].map((x) => x[1]);
          return JSON.stringify({ units: ids.map((id) => ({ title: `Port ${id}`, area: "App", modules: [id], deps: [] })) });
        },
      },
      { goal: "iOS app", referenceDir: "ref" }
    );
    assert.equal(out.ok, true);
    assert.match(out.text, /Every one of the 8 reference files belongs to a unit/);
    const rm = loadRoadmap(d)!;
    assert.equal(rm.kind, "port");
    assert.equal(rm.reference!.dir, "ref");
    assert.equal(rm.units.flatMap((u) => u.refs).length, 8);
  });

  test("an empty or missing folder is refused with a reason, and nothing is written", async () => {
    const d = repo();
    const out = await createRoadmap({ repoRoot: d, complete: async () => "{}" }, { goal: "g", referenceDir: "nowhere" });
    assert.equal(out.ok, false);
    assert.match(out.text, /no source files under "nowhere"/);
  });
});

describe("working through it", () => {
  const seeded = async () => {
    const d = repo();
    await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "a garage sale app" });
    return d;
  };

  test("the next unit is started, marked in progress, and becomes a task that knows the whole picture", async () => {
    const d = await seeded();
    const { started } = startNext(d);
    assert.equal(started!.unit.title, "Accounts");
    assert.equal(loadRoadmap(d)!.units[0].status, "in_progress");
    assert.match(started!.prompt, /ROADMAP UNIT U001: Accounts/);
    assert.match(started!.prompt, /Do NOT build these here; other units own them: Listings; Search/);
  });

  test("a finished unit leaves its files for the next to build on, and unlocks it", async () => {
    const d = await seeded();
    startNext(d);
    finishUnit(d, "U001", { commit: "abc1234", files: ["src/auth.ts"], summary: "Auth works." });
    const { started } = startNext(d);
    assert.equal(started!.unit.title, "Listings");
    assert.match(started!.prompt, /U001 Accounts \(this unit depends on it\): src\/auth\.ts/);
  });

  test("a unit that was interrupted is picked up again before anything new", async () => {
    const d = await seeded();
    startNext(d);
    assert.equal(startNext(d).started!.unit.id, "U001");
    assert.equal(loadRoadmap(d)!.units[0].attempts, 2);
  });

  test("a failed attempt keeps the unit resumable, and repeated failure parks it with the reason", async () => {
    const d = await seeded();
    for (let i = 1; i < MAX_UNIT_ATTEMPTS; i++) {
      startNext(d);
      assert.equal(failUnit(d, "U001", "build broke").parked, false);
    }
    assert.equal(loadRoadmap(d)!.units[0].status, "in_progress");
    startNext(d);
    assert.equal(failUnit(d, "U001", "build broke").parked, true);
    const u = loadRoadmap(d)!.units[0];
    assert.equal(u.status, "blocked");
    assert.match(u.blockedReason!, /Failed 3 times. Last: build broke/);
    assert.match(startNext(d).reason!, /blocked/);
  });

  test("when everything is done it says so", async () => {
    const d = await seeded();
    for (const id of ["U001", "U002", "U003"]) finishUnit(d, id, { files: [] });
    assert.match(startNext(d).reason!, /Every unit on the roadmap is done/);
  });

  test("without a roadmap there is nothing to start", () => {
    assert.match(startNext(repo()).reason!, /no roadmap/);
  });
});

describe("adding to it", () => {
  test("new units are added, a done unit is protected, and a drop is applied", async () => {
    const d = repo();
    await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "g" });
    finishUnit(d, "U001", { files: [] });
    const text = await changeRoadmap(
      { repoRoot: d, complete: async () => JSON.stringify({ add: [{ title: "Reviews", deps: ["Listings"] }], drop: [{ id: "U003", reason: "later" }, { id: "U001", reason: "x" }] }) },
      "add reviews, drop search"
    );
    assert.match(text, /Added: U004 Reviews/);
    assert.match(text, /Dropped U003 Search \(later\)/);
    assert.match(text, /U001 is already done; not dropped/);
    assert.equal(loadRoadmap(d)!.units.length, 4);
  });

  test("with no roadmap, or no change worth making, it says so and changes nothing", async () => {
    assert.match(await changeRoadmap({ repoRoot: repo(), complete: async () => "{}" }, "x"), /no roadmap yet/);
    const d = repo();
    await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "g" });
    const before = JSON.stringify(loadRoadmap(d));
    assert.match(await changeRoadmap({ repoRoot: d, complete: async () => JSON.stringify({ add: [], drop: [] }) }, "x"), /did not find anything to change/);
    assert.equal(JSON.stringify(loadRoadmap(d)), before);
  });
});

describe("a plan too big for one task", () => {
  test("the overflow becomes units that follow the current task, instead of lines a 'no' deletes", () => {
    const d = repo();
    const r = absorbOverflow(d, { goal: "Redo every screen", planGoal: "Redo the first screens", followUps: ["Redo the settings screens", "Redo the profile screens"] });
    const rm = loadRoadmap(d)!;
    assert.equal(rm.kind, "overflow");
    assert.equal(r.added, 2);
    assert.equal(rm.units[0].status, "in_progress");
    assert.deepEqual(rm.units.map((u) => u.deps), [[], ["U001"], ["U002"]]);
    assert.equal(r.currentUnitId, "U001");
  });

  test("when a roadmap unit is already running, the overflow is added after it, and doing it twice adds nothing twice", () => {
    const d = repo();
    absorbOverflow(d, { goal: "g", planGoal: "Current", followUps: ["Next one"] });
    const again = absorbOverflow(d, { goal: "g", planGoal: "Current", followUps: ["Next one", "Another"], currentUnitId: "U001" });
    assert.equal(loadRoadmap(d)!.units.length, 3);
    assert.equal(again.added, 1);
  });
});

describe("noticing that the world moved", () => {
  const ref = () => repo({ "ref/a/One.kt": "class One\n", "ref/a/Two.kt": "class Two\n" });
  const planned = async () => {
    const d = ref();
    await createRoadmap(
      {
        repoRoot: d,
        complete: async (m) => JSON.stringify({ units: [{ title: "Port it", modules: [[...m[1].content.matchAll(/^(M\d{3}) /gm)][0][1]] }] }),
      },
      { goal: "g", referenceDir: "ref" }
    );
    return d;
  };

  test("new reference files, vanished ones, and finished units whose files are gone are all reported", async () => {
    const d = await planned();
    assert.deepEqual(describeDrift(checkDrift(d)!), []);
    fs.writeFileSync(path.join(d, "ref/a/Three.kt"), "class Three\n");
    fs.rmSync(path.join(d, "ref/a/One.kt"));
    finishUnit(d, "U001", { files: ["src/made.ts"] });
    const drift = checkDrift(d)!;
    assert.deepEqual(drift.uncovered, ["ref/a/Three.kt"]);
    assert.deepEqual(drift.gone, ["ref/a/One.kt"]);
    assert.equal(drift.doneMissing[0].id, "U001");
    assert.equal(describeDrift(drift).length, 3);
  });

  test("new reference files become a unit, so they cannot be forgotten", async () => {
    const d = await planned();
    fs.writeFileSync(path.join(d, "ref/a/Three.kt"), "class Three\n");
    assert.equal(absorbUncovered(d, checkDrift(d)!.uncovered), 1);
    assert.deepEqual(checkDrift(d)!.uncovered, []);
  });
});

describe("commands", () => {
  test("they parse, and anything unclear is help, never a guess", () => {
    assert.deepEqual(parseRoadmapCommand(""), { kind: "show" });
    assert.deepEqual(parseRoadmapCommand("status"), { kind: "show" });
    assert.deepEqual(parseRoadmapCommand("new a garage sale app"), { kind: "new", goal: "a garage sale app" });
    assert.deepEqual(parseRoadmapCommand("port android\\app rebuild for iOS"), { kind: "port", dir: "android/app", goal: "rebuild for iOS" });
    assert.deepEqual(parseRoadmapCommand("run"), { kind: "run" });
    assert.deepEqual(parseRoadmapCommand("continue"), { kind: "run" });
    assert.deepEqual(parseRoadmapCommand("add reviews and ratings"), { kind: "add", request: "reviews and ratings" });
    assert.deepEqual(parseRoadmapCommand("drop u004 not needed"), { kind: "drop", id: "U004", reason: "not needed" });
    assert.deepEqual(parseRoadmapCommand("reopen U002"), { kind: "reopen", id: "U002" });
    for (const unclear of ["new", "port onlyonearg", "drop everything", "reopen", "dance"]) assert.deepEqual(parseRoadmapCommand(unclear), { kind: "help" }, unclear);
  });

  test("drop, reopen and done by hand, and reset", async () => {
    const d = repo();
    await createRoadmap({ repoRoot: d, complete: async () => JSON.stringify(IDEA) }, { goal: "g" });
    assert.match(manualUpdate(d, { kind: "done", id: "U001" }), /Marked done U001/);
    assert.match(manualUpdate(d, { kind: "drop", id: "U001", reason: "" }), /already done/);
    assert.match(manualUpdate(d, { kind: "drop", id: "U003", reason: "x" }), /Dropped U003/);
    assert.match(manualUpdate(d, { kind: "reopen", id: "U003" }), /Reopened U003/);
    assert.match(manualUpdate(d, { kind: "drop", id: "U099", reason: "" }), /No unit U099/);
    assert.deepEqual(nextUnits(loadRoadmap(d)!, 5).map((u) => u.id), ["U002"]);
    assert.equal(resetRoadmap(d), true);
    assert.equal(loadRoadmap(d), undefined);
  });
});

import { commandFromIntent } from "../src/roadmapFlow.js";

describe("what the classifier decided about the roadmap", () => {
  test("each answer becomes the command it means, in whatever words the person used", () => {
    assert.deepEqual(commandFromIntent("show", null), { kind: "show" });
    assert.deepEqual(commandFromIntent("run", null), { kind: "run" });
    assert.deepEqual(commandFromIntent("add", "reviews and ratings"), { kind: "add", request: "reviews and ratings" });
    assert.deepEqual(commandFromIntent("drop", "the search screen"), { kind: "add", request: "drop: the search screen" });
  });

  test("an add or drop with nothing said about it, or no clear action, just shows where things stand", () => {
    assert.deepEqual(commandFromIntent("add", "  "), { kind: "show" });
    assert.deepEqual(commandFromIntent("drop", null), { kind: "show" });
    assert.deepEqual(commandFromIntent(null, null), { kind: "show" });
    assert.deepEqual(commandFromIntent("reformat the disk", "x"), { kind: "show" });
  });

  test("what is said is cleaned and bounded", () => {
    const c = commandFromIntent("add", "a  b\n c " + "z".repeat(900)) as { request: string };
    assert.ok(c.request.startsWith("a b c z"));
    assert.ok(c.request.length <= 500);
  });
});
