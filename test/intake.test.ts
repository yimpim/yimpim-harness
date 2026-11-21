/**
 * From one sentence to a roadmap: a new product gets a questionnaire written for a person who is not technical (sections, follow-ups, a brief to confirm, "Decide for me"),
 * the look is settled into a design brief before any screen is built, and a small change on an existing app stays small.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ideaMessages } from "../src/roadmapPlan.js";
import { runQuestionnaire, parseBatch, questionnaireMessages, wantsQuestionnaire, withDesignUnit, writeDesignBrief, DECIDE_FOR_ME, MAX_ROUNDS, MAX_FOLLOW_UP_QUESTIONS, type AskedQuestion } from "../src/intake.js";
import { createRoadmap } from "../src/roadmapFlow.js";
import { loadRoadmap } from "../src/roadmap.js";
import { readDesignBrief } from "../src/uiDesign.js";
import { ConfigSchema } from "../src/config.js";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "intake-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

const Q = (question: string, options = ["A", "B", "C"], recommended = options[0]) => ({ question, why: `why ${question}`, options, recommended });
const SECTIONS = {
  sections: [
    { id: "purpose", title: "What it is for and who uses it", questions: [Q("Who will use it?", ["Just me", "My family", "A team"], "My family")] },
    { id: "look", title: "Look and feel", questions: [Q("How should it feel?", ["Calm", "Playful", "Bold"], "Calm"), Q("Light or dark?", ["Light", "Dark", "Both"], "Both")] },
  ],
};

/** A model that knows which of the three kinds of call it is being asked for. */
const model = (opts: { questionnaire?: any; followUp?: any; plan?: any; reconcile?: any } = {}) => {
  const calls: { kind: string; content: string }[] = [];
  const complete = async (m: any[]) => {
    const sys: string = m[0].content;
    const user: string = m[1].content;
    const kind = sys.startsWith("You write a questionnaire") ? (user.includes("FOLLOW-UP") ? "followUp" : "questionnaire") : sys.startsWith("Some questions were not answered") ? "reconcile" : "plan";
    calls.push({ kind, content: user });
    if (kind === "questionnaire") return JSON.stringify(opts.questionnaire ?? SECTIONS);
    if (kind === "followUp") return JSON.stringify(opts.followUp ?? { sections: [] });
    if (kind === "reconcile") return JSON.stringify(opts.reconcile ?? { answers: [] });
    return JSON.stringify(
      opts.plan ?? {
        units: [
          { title: "Data model", area: "Data", summary: "The items and their fields", acceptance: ["Items can be saved"] },
          { title: "Inventory list screen", area: "UI", summary: "A screen that lists the items", acceptance: ["The list shows every item"], deps: ["Data model"] },
          { title: "Add item screen", area: "UI", summary: "A form to add an item", acceptance: ["An item can be added"] },
        ],
        conventions: ["Keep it simple"],
        questions: [],
        assumptions: [],
      }
    );
  };
  return { complete, calls };
};
const asker = (answers: (q: AskedQuestion) => string | undefined) => {
  const asked: AskedQuestion[] = [];
  return {
    asked,
    ask: async (q: AskedQuestion) => {
      asked.push(q);
      const a = answers(q);
      if (a === undefined) throw new Error("nobody");
      return a;
    },
  };
};

describe("the questionnaire", () => {
  test("sections are asked in order, in plain words with the options, the recommended one and why it matters; 'Decide for me' is offered on every question", async () => {
    const m = model();
    const a = asker((q) => q.options[1]);
    const r = await runQuestionnaire({ complete: m.complete, ask: a.ask }, { goal: "an app that tracks my fridge inventory" });
    assert.deepEqual(a.asked.map((q) => q.question), ["Who will use it?", "How should it feel?", "Light or dark?"]);
    assert.deepEqual(a.asked[0].options, ["Just me", "My family", "A team", DECIDE_FOR_ME]);
    assert.equal(a.asked[0].recommended, "My family");
    assert.equal(a.asked[0].why, "why Who will use it?");
    assert.deepEqual(r.answered.map((x) => [x.section, x.answer, x.decided]), [["purpose", "My family", false], ["look", "Playful", false], ["look", "Dark", false]]);
    assert.deepEqual(r.look.map((x) => x.answer), ["Playful", "Dark"], "the look answers are kept apart for the design brief");
  });

  test("'Decide for me' takes the recommended option and is recorded as an assumption; on the first question of a section it decides the whole section", async () => {
    const a = asker((q) => (q.question === "How should it feel?" ? DECIDE_FOR_ME : q.options[0]));
    const r = await runQuestionnaire({ complete: model().complete, ask: a.ask }, { goal: "a fridge app" });
    assert.deepEqual(a.asked.map((q) => q.question), ["Who will use it?", "How should it feel?"], "the second question of the section was not asked");
    assert.deepEqual(r.decided.map((x) => [x.question, x.answer]), [["How should it feel?", "Calm"], ["Light or dark?", "Both"]]);
    assert.ok(r.assumptions.some((s) => s === 'Look and feel: "How should it feel?" -> Calm (decided for you; correct it if it is wrong)'));
    assert.equal(r.look.length, 2);
  });

  test("a question nobody answers (an error, or nothing) takes the recommended option and is recorded the same way", async () => {
    const r = await runQuestionnaire({ complete: model().complete, ask: async () => { throw new Error("nobody"); } }, { goal: "x" });
    assert.equal(r.answered.length, 0);
    assert.deepEqual(r.decided.map((x) => x.answer), ["My family", "Calm", "Both"]);
    assert.equal(r.assumptions.length, 3);
  });

  test("an attached brief: one question to confirm what was understood comes first, a section it settles is not asked but stated as an assumption, a correction is kept", async () => {
    const m = model({ questionnaire: { understood: "A fridge tracker for your family, on iPhone.", sections: [{ id: "platform", title: "Where it runs", assumed: "iPhone only", questions: [] }, ...SECTIONS.sections] } });
    const a = asker((q) => (q.question.startsWith("Here is what I understood") ? "Something is wrong" : q.question === "What is wrong, or missing?" ? "It also needs Android" : q.options[0]));
    const r = await runQuestionnaire({ complete: m.complete, ask: a.ask }, { goal: "a fridge app", docs: "BRIEF TEXT" });
    assert.match(a.asked[0].question, /^Here is what I understood from your brief: A fridge tracker for your family, on iPhone\.\nAnything wrong\?$/);
    assert.deepEqual(a.asked[0].options, ["That's right", "Something is wrong"]);
    assert.equal(a.asked[1].question, "What is wrong, or missing?");
    assert.ok(!a.asked.some((q) => /Where it runs/.test(q.question)));
    assert.equal(r.correction, "It also needs Android");
    assert.ok(r.assumptions.some((s) => s.startsWith("Where it runs: iPhone only (from your request or brief")));
    assert.ok(m.calls[0].content.includes("BRIEF TEXT") && m.calls[0].content.includes('"understood"'));
  });

  test("the brief understood correctly: no correction; without a brief there is no such question", async () => {
    const m = model({ questionnaire: { understood: "A fridge tracker.", sections: SECTIONS.sections } });
    const right = await runQuestionnaire({ complete: m.complete, ask: asker(() => "That's right").ask }, { goal: "x", docs: "BRIEF" });
    assert.equal(right.correction, undefined);
    const a = asker((q) => q.options[0]);
    await runQuestionnaire({ complete: m.complete, ask: a.ask }, { goal: "x" });
    assert.ok(!a.asked.some((q) => /understood/.test(q.question)));
  });

  test("follow-ups: an answer that opened something produces a second round of its own questions; never a third", async () => {
    const m = model({ followUp: { sections: [{ id: "accounts", title: "Accounts and sharing", questions: [Q("Can everyone edit, or only you?", ["Everyone", "Only me"], "Everyone")] }] } });
    const a = asker((q) => q.options[0]);
    const r = await runQuestionnaire({ complete: m.complete, ask: a.ask }, { goal: "x" });
    assert.equal(r.rounds, MAX_ROUNDS);
    assert.deepEqual(a.asked.map((q) => q.question), ["Who will use it?", "How should it feel?", "Light or dark?", "Can everyone edit, or only you?"]);
    assert.equal(m.calls.filter((c) => c.kind === "followUp").length, 1, "one follow-up call, then it stops");
    assert.match(m.calls.find((c) => c.kind === "followUp")!.content, /Who will use it\? -> Just me/);
  });

  test("nothing opened up: no second round", async () => {
    const m = model();
    const r = await runQuestionnaire({ complete: m.complete, ask: asker((q) => q.options[0]).ask }, { goal: "x" });
    assert.equal(r.rounds, 1);
  });

  test("a questionnaire that cannot be written leaves nothing behind, so the caller keeps today's path", async () => {
    const r = await runQuestionnaire({ complete: async () => { throw new Error("down"); }, ask: asker(() => "x").ask }, { goal: "x" });
    assert.deepEqual([r.answered.length, r.decided.length, r.assumptions.length], [0, 0, 0]);
    const empty = await runQuestionnaire({ complete: async () => "not json", ask: asker(() => "x").ask }, { goal: "x" });
    assert.equal(empty.rounds, 0);
  });
});

describe("parsing what the model wrote", () => {
  test("a question needs words and two options; the recommendation must be one of them; 'Decide for me' is never an option the model gives; at most five", () => {
    const b = parseBatch(JSON.stringify({ sections: [{ id: "x", title: "T", questions: [
      { question: "no options", options: ["only"] },
      { question: "", options: ["a", "b"] },
      { question: "bad recommendation", options: ["a", "b"], recommended: "zzz" },
      { question: "with decide", options: ["a", "Decide for me", "b"], recommended: "b" },
      { question: "many", options: ["1", "2", "3", "4", "5", "6", "7"] },
    ] }] }));
    const qs = b.sections[0].questions;
    assert.deepEqual(qs.map((q) => q.question), ["bad recommendation", "with decide", "many"]);
    assert.equal(qs[0].recommended, "a");
    assert.deepEqual(qs[1].options, ["a", "b"]);
    assert.equal(qs[2].options.length, 5);
  });
  test("a section with no questions is kept only when it says what is assumed; garbage gives nothing", () => {
    assert.equal(parseBatch(JSON.stringify({ sections: [{ id: "a", title: "A", questions: [] }, { id: "b", title: "B", assumed: "web only", questions: [] }] })).sections.length, 1);
    assert.deepEqual(parseBatch("no json at all"), { sections: [] });
    assert.deepEqual(parseBatch(""), { sections: [] });
  });
});

describe("when it applies", () => {
  const files = (n: number) => { for (let i = 0; i < n; i++) { fs.mkdirSync(path.join(root, "src"), { recursive: true }); fs.writeFileSync(path.join(root, `src/f${i}.ts`), "x\n"); } };
  test("a new product in a new or nearly empty project, not a port, and not an existing app", () => {
    assert.equal(wantsQuestionnaire(root, {}), true);
    files(10);
    assert.equal(wantsQuestionnaire(root, {}), true, "ten source files is still new");
    files(11);
    assert.equal(wantsQuestionnaire(root, {}), false);
    assert.equal(wantsQuestionnaire(fs.mkdtempSync(path.join(os.tmpdir(), "e-")), { referenceDir: "reference/app" }), false);
  });
});

describe("the roadmap for a new product", () => {
  const flow = (m: ReturnType<typeof model>, ask: any, mode: any = "essential") => ({ repoRoot: root, complete: m.complete, ask, questionMode: mode });

  test("the questionnaire runs, 'decide for me' is an assumption, the plan is made once from the answers, and the look becomes a design brief", async () => {
    const m = model();
    const a = asker((q) => (q.question === "Who will use it?" ? DECIDE_FOR_ME : q.options[1]));
    const res = await createRoadmap(flow(m, a.ask), { goal: "an app that tracks my fridge inventory", verifyExisting: false });
    assert.equal(res.ok, true, res.text);
    assert.equal(m.calls.filter((c) => c.kind === "plan").length, 1, "one planning call, with the answers; the questions were already asked");
    assert.match(m.calls.find((c) => c.kind === "plan")!.content, /How should it feel\? -> Playful/);
    assert.match(m.calls.find((c) => c.kind === "plan")!.content, /Who will use it\? -> My family \(decided for you: nobody was asked\)/);
    const rm = loadRoadmap(root)!;
    assert.ok(rm.conventions.some((c) => /^How should it feel\? -> Playful/.test(c)));
    assert.ok(rm.conventions.some((c) => /^Assumed, not confirmed: What it is for and who uses it: "Who will use it\?" -> My family \(decided for you/.test(c)));
    const brief = readDesignBrief(root);
    assert.match(brief, /# Design brief/);
    assert.match(brief, /How should it feel\?\n {2}- Playful/);
    assert.match(brief, /Light or dark\?\n {2}- Dark/);
  });

  test("the design system is the first unit; screen units depend on it; the data model does not", async () => {
    const res = await createRoadmap(flow(model(), asker((q) => q.options[0]).ask), { goal: "a fridge app", verifyExisting: false });
    assert.equal(res.ok, true, res.text);
    const units = loadRoadmap(root)!.units;
    assert.equal(units[0].title, "Design system");
    assert.equal(units[0].area, "Design");
    const byTitle = (t: string) => units.find((u) => u.title === t)!;
    const depTitles = (t: string) => byTitle(t).deps.map((id) => units.find((u) => u.id === id)?.title);
    assert.ok(depTitles("Inventory list screen").includes("Design system"));
    assert.ok(depTitles("Add item screen").includes("Design system"));
    assert.ok(!depTitles("Data model").includes("Design system"), "non-UI work can go first");
  });

  test("autonomous: nothing is asked and no questionnaire is written; today's path", async () => {
    const m = model();
    const a = asker(() => "x");
    await createRoadmap(flow(m, a.ask, "autonomous"), { goal: "a fridge app", verifyExisting: false });
    assert.equal(a.asked.length, 0);
    assert.ok(!m.calls.some((c) => c.kind === "questionnaire"));
    assert.equal(readDesignBrief(root), "");
  });

  test("nobody to ask: no questionnaire, today's path", async () => {
    const m = model();
    await createRoadmap({ repoRoot: root, complete: m.complete, questionMode: "essential" }, { goal: "a fridge app", verifyExisting: false });
    assert.ok(!m.calls.some((c) => c.kind === "questionnaire"));
  });

  test("an existing app (more than ten source files) getting a big feature list keeps today's path", async () => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `src/f${i}.ts`), "x\n");
    const m = model();
    await createRoadmap(flow(m, asker((q) => q.options[0]).ask), { goal: "add recipes, sharing and a shopping list", verifyExisting: false });
    assert.ok(!m.calls.some((c) => c.kind === "questionnaire"));
    assert.equal(m.calls.filter((c) => c.kind === "plan").length, 1);
  });
});

describe("a default must agree with what the person actually said", () => {
  const TWO_SECTIONS = {
    sections: [
      { id: "purpose", title: "What it is for and who uses it", questions: [Q("Who will use it?", ["Just me", "My household or family"], "My household or family")] },
      { id: "accounts", title: "Accounts and sharing", questions: [Q("How should family members connect?", ["Everyone signs in and joins a shared home", "A shared PIN", "Not applicable: just me"], "Everyone signs in and joins a shared home")] },
    ],
  };
  const justMeThenDecide = (q: AskedQuestion) => (q.question === "Who will use it?" ? "Just me" : DECIDE_FOR_ME);

  test("'Just me', then 'Decide for me' on sharing: the default is checked against the first answer and corrected to 'Not applicable', and the assumption says so", async () => {
    const m = model({ questionnaire: TWO_SECTIONS, reconcile: { answers: [{ question: "How should family members connect?", answer: "Not applicable: just me" }] } });
    const r = await runQuestionnaire({ complete: m.complete, ask: asker(justMeThenDecide).ask }, { goal: "a fridge app" });
    assert.equal(m.calls.filter((c) => c.kind === "reconcile").length, 1);
    assert.match(m.calls.find((c) => c.kind === "reconcile")!.content, /What the person answered:\n- Who will use it\? -> Just me/);
    assert.match(m.calls.find((c) => c.kind === "reconcile")!.content, /Defaults taken for them:\n- How should family members connect\? -> Everyone signs in and joins a shared home \(options: Everyone signs in and joins a shared home \| A shared PIN \| Not applicable: just me\)/);
    assert.equal(r.decided[0].answer, "Not applicable: just me");
    assert.deepEqual(r.assumptions, ['Accounts and sharing: "How should family members connect?" -> Not applicable: just me (decided for you; correct it if it is wrong)']);
  });

  test("it reaches the plan: the roadmap's conventions and the planning call never carry the contradictory default", async () => {
    const m = model({ questionnaire: TWO_SECTIONS, reconcile: { answers: [{ question: "How should family members connect?", answer: "Not applicable: just me" }] } });
    const res = await createRoadmap({ repoRoot: root, complete: m.complete, ask: asker(justMeThenDecide).ask, questionMode: "essential" }, { goal: "a fridge app", verifyExisting: false });
    assert.equal(res.ok, true, res.text);
    const plan = m.calls.find((c) => c.kind === "plan")!.content;
    assert.match(plan, /How should family members connect\? -> Not applicable: just me \(decided for you/);
    assert.ok(!/Everyone signs in and joins a shared home/.test(plan));
    assert.ok(!loadRoadmap(root)!.conventions.some((c) => /Everyone signs in and joins a shared home/.test(c)));
  });

  test("the planner is told that the person's own answer wins over a default", () => {
    const text = ideaMessages("a fridge app", "", ["Who? -> Just me"], [])[0].content;
    assert.match(text, /An answer marked "decided for you" was not chosen by the person: where it contradicts something they DID answer, their own answer wins\./);
  });

  test("a later question carries what the person already answered (for whoever answers it when nobody does); the first carries nothing", async () => {
    const a = asker((q) => q.options[0]);
    await runQuestionnaire({ complete: model({ questionnaire: TWO_SECTIONS }).complete, ask: a.ask }, { goal: "x" });
    assert.equal(a.asked[0].context, undefined);
    assert.equal(a.asked[1].context, "Who will use it? -> Just me");
  });

  test("the model that answers on a time-out is shown it, and the question card carries it", async () => {
    const { resolverPrompt } = await import("../src/questionResolver.js");
    const text = resolverPrompt({ id: "q", kind: "blocking", prompt: "How should family members connect?", fallback: "Everyone signs in", askedAt: "", choices: ["Everyone signs in", "Not applicable: just me"], context: "Who will use it? -> Just me" }, "a fridge app", "");
    assert.match(text, /What the person has already answered \(your answer must agree with it\):\nWho will use it\? -> Just me\nQuestion:/);
    assert.ok(src("src/index.ts").includes("...(q.context ? { context: q.context } : {}),"));
  });

  test("nothing to check when nothing was answered, or when nothing was defaulted: no extra call", async () => {
    const allDecided = model({ questionnaire: TWO_SECTIONS });
    await runQuestionnaire({ complete: allDecided.complete, ask: asker(() => DECIDE_FOR_ME).ask }, { goal: "x" });
    assert.equal(allDecided.calls.filter((c) => c.kind === "reconcile").length, 0, "the person decided everything: there is nothing they said to agree with");
    const allAnswered = model({ questionnaire: TWO_SECTIONS });
    await runQuestionnaire({ complete: allAnswered.complete, ask: asker((q) => q.options[0]).ask }, { goal: "x" });
    assert.equal(allAnswered.calls.filter((c) => c.kind === "reconcile").length, 0);
  });

  test("a change to something that is not one of the question's options, a failing call, or no change: the default stands", async () => {
    for (const reconcile of [{ answers: [{ question: "How should family members connect?", answer: "Everyone shares one login on a sticky note" }] }, { answers: [] }, "not json"]) {
      const m = model({ questionnaire: TWO_SECTIONS, reconcile });
      const r = await runQuestionnaire({ complete: m.complete, ask: asker(justMeThenDecide).ask }, { goal: "x" });
      assert.equal(r.decided[0].answer, "Everyone signs in and joins a shared home");
    }
    const failing = async (msgs: any[]) => {
      if (String(msgs[0].content).startsWith("Some questions were not answered")) throw new Error("down");
      return JSON.stringify(TWO_SECTIONS);
    };
    const r2 = await runQuestionnaire({ complete: failing, ask: asker(justMeThenDecide).ask }, { goal: "x" });
    assert.equal(r2.decided[0].answer, "Everyone signs in and joins a shared home");
  });
});

describe("the planner says which units build screens", () => {
  test("buildsUi from the planner's own answer is stored on the unit and decides the design dependency, whatever the words are", async () => {
    const m = model({
      plan: {
        units: [
          // a screen-sounding title that the planner says builds no UI, and a UI unit with no screen words at all
          { title: "Offline screen cache", area: "Data", summary: "Keep screens' data on the device", buildsUi: false, acceptance: ["Works offline"] },
          { title: "Fridge", area: "Core", summary: "Show what is in the fridge", buildsUi: true, acceptance: ["Shows items"] },
        ],
        conventions: [],
        questions: [],
        assumptions: [],
      },
    });
    const res = await createRoadmap({ repoRoot: root, complete: m.complete, ask: asker((q) => q.options[0]).ask, questionMode: "essential" }, { goal: "a fridge app", verifyExisting: false });
    assert.equal(res.ok, true, res.text);
    const units = loadRoadmap(root)!.units;
    const by = (t: string) => units.find((u) => u.title === t)!;
    assert.equal(by("Offline screen cache").buildsUi, false);
    assert.equal(by("Fridge").buildsUi, true);
    const depTitles = (t: string) => by(t).deps.map((id) => units.find((u) => u.id === id)?.title);
    assert.ok(depTitles("Fridge").includes("Design system"));
    assert.ok(!depTitles("Offline screen cache").includes("Design system"), "the word 'screen' in the title did not make it a UI unit");
  });
  test("a unit that did not say is judged by its words, as a fallback only; a value that is not a plain boolean is ignored", () => {
    const w = withDesignUnit([{ title: "Home screen", area: "UI" }, { title: "Storage", area: "Data" }, { title: "Settings", area: "Core", buildsUi: false }]);
    assert.deepEqual(w.find((d) => d.title === "Home screen")!.deps, ["Design system"]);
    assert.deepEqual(w.find((d) => d.title === "Storage")!.deps ?? [], []);
    assert.deepEqual(w.find((d) => d.title === "Settings")!.deps ?? [], []);
    const src = fs.readFileSync("src/roadmapPlan.ts", "utf8");
    assert.match(src, /u\?\.buildsUi === true \|\| u\?\.buildsUi === "true"/);
    assert.equal((src.match(/"deps":\[\],"buildsUi":false,"acceptance":\[""\]\}/g) ?? []).length, 3, "all three unit shapes the planner is shown");
    assert.match(src, /"buildsUi": true when the unit builds or changes screens, components or styling a person sees, false for data, storage, networking, build or configuration work/);
  });
});

describe("what the dry run showed, tightened", () => {
  const many = (n: number, perSection = 5) => ({
    sections: Array.from({ length: Math.ceil(n / perSection) }, (_, s) => ({
      id: `s${s}`,
      title: `Section ${s}`,
      questions: Array.from({ length: Math.min(perSection, n - s * perSection) }, (_, i) => Q(`Question ${s}.${i}`)),
    })),
  });
  test("a model that asks too much is cut off: 15 questions in all, 3 in a section, earliest first; a follow-up round is smaller (6)", () => {
    const b = parseBatch(JSON.stringify(many(40)));
    assert.equal(b.sections.reduce((n, s) => n + s.questions.length, 0), 15, "eight sections of five would be 40; three each would be 24; the total stops it at 15");
    assert.ok(b.sections.every((s) => s.questions.length <= 3), "never more than three in a section");
  });
  test("the cap is on the total, and the first sections keep theirs", () => {
    const b = parseBatch(JSON.stringify(many(100, 3)));
    assert.equal(b.sections.reduce((n, s) => n + s.questions.length, 0), 15);
    assert.deepEqual(b.sections.map((s) => s.questions.length), [3, 3, 3, 3, 3]);
    const follow = parseBatch(JSON.stringify(many(100, 3)), MAX_FOLLOW_UP_QUESTIONS);
    assert.equal(follow.sections.reduce((n, s) => n + s.questions.length, 0), 6);
  });
  test("the instructions say what the dry run showed was missing", () => {
    const text = questionnaireMessages("a fridge app", undefined)[0].content;
    assert.match(text, /at most 15 questions in all and at most 3 in any section; fewer is better/);
    assert.match(text, /make sense whatever the earlier answers were[\s\S]*'Not applicable: just me'/);
    assert.match(text, /'look' section asks up to 3 separate questions: the feel, light or dark or both, and whether they have colours, a logo or apps they like/);
    assert.match(text, /'edges' section asks at least one situation about losing information, and, when anyone else's information could be involved, one about privacy/);
  });
  test("a follow-up round uses the smaller cap in the flow", async () => {
    const m = model({ followUp: many(30, 3) });
    const a = asker((q) => q.options[0]);
    await runQuestionnaire({ complete: m.complete, ask: a.ask }, { goal: "x" });
    assert.equal(a.asked.length, 3 + 6, "the first round's 3 plus at most 6 follow-ups");
  });
  test("a starter template is a new build for the questionnaire too", () => {
    const flow = fs.readFileSync("src/intake.ts", "utf8");
    assert.ok(flow.includes("return !args.referenceDir && isNewProject(repoRoot);"));
  });
});

describe("the design unit", () => {
  test("added only when something builds screens, never twice, and screens already depending on it are left alone", () => {
    assert.equal(withDesignUnit([{ title: "Data model", area: "Data" }, { title: "Sync service", area: "Backend" }]).length, 2);
    const withUi = withDesignUnit([{ title: "Data model", area: "Data" }, { title: "Home screen", area: "UI" }]);
    assert.deepEqual(withUi.map((d) => d.title), ["Design system", "Data model", "Home screen"]);
    assert.deepEqual(withUi[2].deps, ["Design system"]);
    assert.deepEqual(withUi[1].deps ?? [], []);
    assert.equal(withDesignUnit(withUi).length, 3, "not added again");
    const already = withDesignUnit([{ title: "Home screen", area: "UI", deps: ["Design system"] }, { title: "Design system" }]);
    assert.equal(already.length, 2);
  });
  test("the brief is written only when the person was asked about the look", () => {
    assert.equal(writeDesignBrief(root, "g", []), undefined);
    assert.equal(fs.existsSync(path.join(root, "design-system", "BRIEF.md")), false);
    writeDesignBrief(root, "a fridge app", [{ section: "look", question: "Feel?", answer: "Calm", decided: true }], "It must be dark");
    const text = fs.readFileSync(path.join(root, "design-system", "BRIEF.md"), "utf8");
    assert.match(text, /- Feel\?\n {2}- Calm \(decided for you\)/);
    assert.match(text, /Correction to the brief: It must be dark/);
    assert.equal(readDesignBrief(path.join(root, "nope")), "");
  });
  test("ensureDesignSystem builds from the brief when there is one, and is unchanged without it", () => {
    const u = src("src/uiDesign.ts");
    assert.ok(u.includes('const brief = readDesignBrief(ctx.repoRoot);'));
    assert.ok(u.includes(": ctx.request.slice(0, 1500);"));
    assert.equal((u.match(/The request:\\n\$\{request\.slice\(0, 3200\)\}/g) ?? []).length, 2);
  });
});

describe("small changes stay small", () => {
  test("a task never calls the questionnaire: it lives only in the roadmap's new-product path", () => {
    const flow = src("src/roadmapFlow.ts");
    assert.ok(flow.includes('(deps.questionMode ?? "essential") !== "autonomous" && wantsQuestionnaire(deps.repoRoot, args)'));
    assert.ok(!/runQuestionnaire/.test(src("src/index.ts")), "no task path calls it");
    assert.ok(!/runQuestionnaire/.test(src("src/planner.ts")));
  });
  test("a question carries its recommended answer as what is taken when nobody answers, and its why in the prompt", () => {
    const idx = src("src/index.ts");
    assert.ok(idx.includes('prompt: q.why ? `${q.question}\\n(${q.why})` : q.question,'));
    assert.ok(idx.includes('fallback: q.recommended ?? "",'));
    assert.equal((ConfigSchema.shape as any).planning.parse({}).questions, "essential");
  });
});
