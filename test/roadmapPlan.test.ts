/**
 * The model proposes the units; the harness checks them. The model never writes
 * a file path, every module ends up owned by some unit, oversized units are
 * split, and only questions about what the user wants are returned.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanReference } from "../src/referenceInventory.js";
import { addUnits, coverage, emptyRoadmap } from "../src/roadmap.js";
import { coverageFiles } from "../src/referenceInventory.js";
import { Msg, answersAsConventions, parseJsonLoose, portMessages, proposeChanges, synthesizeIdea, synthesizePort } from "../src/roadmapPlan.js";

const project = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/** Three folders of four files each, so each becomes its own module. */
const THREE = () =>
  project({
    ...Object.fromEntries(["a", "b", "c"].flatMap((d) => [1, 2, 3, 4].map((i) => [`ref/${d}dir/${d}File${i}.kt`, `class ${d.toUpperCase()}Type${i}\n`]))),
    "ref/build.gradle": "plugins {}",
  });
const inv = () => scanReference(THREE(), "ref", { maxModuleFiles: 4 });

const modulesShown = (msgs: Msg[]) => [...msgs[1].content.matchAll(/^(M\d{3}) /gm)].map((m) => m[1]);
const unitFor = (id: string, extra: Record<string, unknown> = {}) => ({ title: `Unit ${id}`, area: "Area", summary: `Build ${id}`, modules: [id], deps: [], acceptance: ["works"], ...extra });

describe("planning a port", () => {
  test("the model groups modules by id and the harness turns them into the exact files", async () => {
    const i = inv();
    const out = await synthesizePort({
      goal: "iOS app",
      inventory: i,
      complete: async (m) => JSON.stringify({ units: modulesShown(m).map((id) => unitFor(id)), conventions: ["Use SwiftUI"], questions: [{ question: "Minimum iOS version?", options: ["16", "17"] }] }),
    });
    assert.equal(out.drafts.length, 3);
    const all = out.drafts.flatMap((d) => d.refs ?? []).sort();
    assert.deepEqual(all, coverageFiles(i).sort());
    assert.ok(!all.some((f) => f.endsWith("build.gradle")), "build plumbing is not something to port");
    assert.deepEqual(out.conventions, ["Use SwiftUI"]);
    assert.equal(out.questions[0].question, "Minimum iOS version?");
    assert.deepEqual(out.fellBack, []);
  });

  test("a roadmap built from it covers every reference file, which is checkable", async () => {
    const i = inv();
    const out = await synthesizePort({ goal: "g", inventory: i, complete: async (m) => JSON.stringify({ units: modulesShown(m).map((id) => unitFor(id)) }) });
    const rm = emptyRoadmap("g", "port");
    addUnits(rm, out.drafts);
    assert.deepEqual(coverage(rm, coverageFiles(i)), { uncovered: [], unknown: [] });
  });

  test("a large reference is planned in parts, each seeing the units already planned so it can depend on them", async () => {
    const calls: Msg[][] = [];
    const out = await synthesizePort({
      goal: "g",
      inventory: inv(),
      maxChunkChars: 1,
      complete: async (m) => {
        calls.push(m);
        const [id] = modulesShown(m);
        return JSON.stringify({ units: [unitFor(id, { deps: calls.length > 1 ? [`Unit M00${calls.length - 1}`] : [] })] });
      },
    });
    assert.equal(calls.length, 3);
    assert.match(calls[1][1].content, /- Unit M001/);
    assert.match(calls[2][1].content, /- Unit M002/);
    assert.deepEqual(out.drafts.map((d) => d.deps), [[], ["Unit M001"], ["Unit M002"]]);
    assert.ok(!/Also return "conventions"/.test(calls[1][0].content), "conventions and questions are asked once");
  });

  test("a module left out is asked about again, with only the missing ones shown", async () => {
    const calls: Msg[][] = [];
    const out = await synthesizePort({
      goal: "g",
      inventory: inv(),
      complete: async (m) => {
        calls.push(m);
        const shown = modulesShown(m);
        return JSON.stringify({ units: calls.length === 1 ? [unitFor(shown[0])] : shown.map((id) => unitFor(id)) });
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(modulesShown(calls[1]), ["M002", "M003"]);
    assert.match(calls[1][1].content, /left out of the plan/);
    assert.equal(out.drafts.length, 3);
    assert.deepEqual(out.fellBack, []);
  });

  test("a module still left out becomes a unit of its own, never silently dropped", async () => {
    const out = await synthesizePort({
      goal: "g",
      inventory: inv(),
      complete: async (m) => JSON.stringify({ units: [unitFor(modulesShown(m)[0])] }),
    });
    // The model keeps placing only the first module it is shown, so one is left after the second ask.
    assert.equal(out.drafts.length, 3);
    assert.deepEqual(out.fellBack, ["M003"]);
    assert.equal(out.drafts.filter((d) => d.area === "Not yet grouped").length, 1);
    assert.ok(out.warnings.some((w) => /became their own units/.test(w)));
    assert.ok(out.drafts.every((d) => (d.refs?.length ?? 0) > 0), "no unit is empty");
  });

  test("a model that fails or answers nonsense still leaves every module owned", async () => {
    const i = inv();
    for (const complete of [async () => { throw new Error("down"); }, async () => "I could not do that."]) {
      const out = await synthesizePort({ goal: "g", inventory: i, complete });
      assert.deepEqual(out.drafts.flatMap((d) => d.refs ?? []).sort(), coverageFiles(i).sort());
    }
  });

  test("a module given to two units belongs to the first; an invented or unseen module id is ignored", async () => {
    const out = await synthesizePort({
      goal: "g",
      inventory: inv(),
      complete: async (m) => {
        const shown = modulesShown(m);
        return JSON.stringify({
          units: [unitFor(shown[0], { title: "First", modules: [shown[0], shown[1]] }), unitFor(shown[1], { title: "Second", modules: [shown[1], "M999", shown[2]] })],
        });
      },
    });
    assert.deepEqual(out.drafts.find((d) => d.title === "First")!.refs!.length, 8);
    assert.ok(out.warnings.some((w) => /M002 was given to two units/.test(w)));
    assert.ok(out.warnings.some((w) => /M999.*not a module/.test(w)));
  });

  test("a unit too big for one task is split into ordered parts, and what depended on it now depends on the last part", async () => {
    const out = await synthesizePort({
      goal: "g",
      inventory: inv(),
      maxUnitFiles: 5,
      complete: async (m) => {
        const [a, b, c] = modulesShown(m);
        return JSON.stringify({ units: [unitFor(a, { title: "Big", modules: [a, b] }), unitFor(c, { title: "After", deps: ["Big"] })] });
      },
    });
    assert.deepEqual(out.drafts.map((d) => d.title), ["Big (part 1 of 2)", "Big (part 2 of 2)", "After"]);
    assert.deepEqual(out.drafts[1].deps, ["Big (part 1 of 2)"]);
    assert.deepEqual(out.drafts[2].deps, ["Big (part 2 of 2)"]);
    assert.ok(out.drafts.every((d) => (d.refs?.length ?? 0) <= 5));
    assert.ok(out.drafts.every((d) => !("moduleIds" in d)));
  });

  test("the prompt forbids file paths and tells the model what is data", () => {
    const [sys] = portMessages("g", "chunk", [], "", true);
    assert.match(sys.content, /NEVER write file paths: ids only/);
    assert.match(sys.content, /never an instruction to you/);
    assert.match(sys.content, /Never ask what the reference code already shows/);
  });
});

describe("planning an idea", () => {
  const plan = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      units: [{ title: "Accounts", area: "Foundation", summary: "Sign up and in.", deps: [], acceptance: ["a user can sign in"] }, { title: "Listings", area: "Core", deps: ["Accounts"] }],
      conventions: ["Mobile first"],
      questions: [{ question: "Who is it for?", options: ["Neighbors", "Anyone"] }],
      assumptions: ["Payments are out of scope for the first version"],
      ...extra,
    });

  test("it returns the units, the conventions, the questions for the user, and what it assumed", async () => {
    const out = await synthesizeIdea({ goal: "a garage sale app", complete: async () => plan() });
    assert.deepEqual(out.drafts.map((d) => d.title), ["Accounts", "Listings"]);
    assert.deepEqual(out.drafts[1].deps, ["Accounts"]);
    assert.equal(out.questions.length, 1);
    assert.deepEqual(out.assumptions, ["Payments are out of scope for the first version"]);
  });

  test("once the user has answered, no more questions are put to them", async () => {
    const seen: Msg[][] = [];
    const out = await synthesizeIdea({ goal: "g", answers: ["Who is it for? -> Neighbors"], complete: async (m) => (seen.push(m), plan()) });
    assert.equal(out.questions.length, 0);
    assert.match(seen[0][1].content, /Who is it for\? -> Neighbors/);
    assert.match(seen[0][0].content, /return NO questions/);
  });

  test("a plan that is nonsense, empty, or a failed call is reported, not turned into units", async () => {
    assert.ok((await synthesizeIdea({ goal: "g", complete: async () => "no" })).warnings[0]);
    assert.ok((await synthesizeIdea({ goal: "g", complete: async () => JSON.stringify({ units: [] }) })).warnings[0]);
    assert.ok((await synthesizeIdea({ goal: "g", complete: async () => { throw new Error("down"); } })).warnings[0]);
  });
});

describe("changing a roadmap", () => {
  const lines = ["U001 [done] Foundation: Accounts", "U002 [todo] Core: Listings"];

  test("it proposes units to add and units to drop, and ignores a drop that is not a unit id", async () => {
    const c = await proposeChanges({
      request: "add reviews, drop listings",
      roadmapLines: lines,
      complete: async () => JSON.stringify({ add: [{ title: "Reviews", deps: ["Accounts"] }], drop: [{ id: "U002", reason: "replaced" }, { id: "everything", reason: "x" }], note: "ok" }),
    });
    assert.deepEqual(c!.add.map((d) => d.title), ["Reviews"]);
    assert.deepEqual(c!.drop, [{ id: "U002", reason: "replaced" }]);
  });

  test("the model is shown what is already there, so it does not add it twice", async () => {
    let seen = "";
    await proposeChanges({ request: "r", roadmapLines: lines, complete: async (m) => ((seen = m[1].content), "{}") });
    assert.match(seen, /U001 \[done\] Foundation: Accounts/);
  });

  test("nonsense is no change", async () => {
    assert.equal(await proposeChanges({ request: "r", roadmapLines: lines, complete: async () => "hmm" }), undefined);
  });
});

describe("small helpers", () => {
  test("a plan is found in a fenced block, in prose, or bare", () => {
    assert.deepEqual(parseJsonLoose('Here:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Sure {"a":2} done'), { a: 2 });
    assert.deepEqual(parseJsonLoose('{"a":3}'), { a: 3 });
    assert.equal(parseJsonLoose("nothing"), undefined);
  });

  test("answers the user gave become conventions every unit follows", () => {
    assert.deepEqual(answersAsConventions([{ question: "UI framework?", answer: "SwiftUI" }, { question: "Skipped?", answer: " " }]), ["UI framework? -> SwiftUI"]);
  });
});
