/**
 * Spec 03 §2.3: a small change stays small. "Change the font to Impact" is routed to `task`, never reaches the questionnaire, and is planned as ONE phase with nothing asked.
 * What can be proven deterministically is everything the harness does around the model: how a router reply is read, which routes can reach the questionnaire, what the Planner is
 * told, and what the harness does with a one-file plan (it adds no phase, no question, and a reply it cannot read degrades to ONE phase, never many). Whether a real Planner model
 * answers a one-file change with one phase is the Planner prompt's job and can only be seen in a live run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseIntentReply, INTENTS } from "../src/routeIntent.js";
import { parsePlan, validatePlan, questionsToAsk, phaseInstructions, decideWithoutAsking, looksEssential } from "../src/planner.js";
import { PLANNER_SYSTEM, INTENT_SYSTEM } from "../src/prompts.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const REQUEST = "change the font to Impact";

/** What a planner model answers for REQUEST: the font lives in one theme file. */
const ONE_FILE_PLAN = JSON.stringify({
  goal: "Use the Impact font",
  assumptions: [],
  clarifyingQuestions: [],
  vagueness: "low",
  suggestedBranch: null,
  phases: [
    {
      id: "phase-1",
      name: "Set the app font to Impact",
      goal: "The app's text uses the Impact font family",
      executor: "EDITOR",
      files: ["src/theme.ts"],
      newFiles: [],
      changes: ['In src/theme.ts set typography.fontFamily to "Impact"'],
      verification: ["Text in the app renders in the Impact font"],
    },
  ],
});

describe("routing: a one-line change is a task", () => {
  test("a router reply of task is read as task, with no roadmap or program hints attached", () => {
    const r = parseIntentReply(JSON.stringify({ intent: "task", branch: null, followsLastAudit: false }));
    assert.equal(r.intent, "task");
    assert.equal(r.roadmapAction, undefined);
    assert.equal(r.reference, undefined);
    assert.ok((INTENTS as readonly string[]).includes("task"));
  });

  test("anything the router answers that is unusable falls to task, the full pipeline, never to a program or roadmap", () => {
    for (const raw of ["", "not json", "{}", '{"intent":"bogus"}', '{"intent":null}']) assert.equal(parseIntentReply(raw).intent, "task", raw);
  });

  test("the router is told that something to be changed is a task, and that program is for a whole product", () => {
    assert.match(INTENT_SYSTEM, /"task" — they want something built, changed, fixed/);
    assert.match(INTENT_SYSTEM, /"program"/);
  });

  test("only the program and roadmap routes can reach the questionnaire: it is called from the roadmap flow alone, and createRoadmap only from handleProgram and the /roadmap command", () => {
    const usesQuestionnaire = fs.readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "intake.ts" && /\brunQuestionnaire\(/.test(src(`src/${f}`)));
    assert.deepEqual(usesQuestionnaire, ["roadmapFlow.ts"]);
    const idx = src("src/index.ts");
    const calls = [...idx.matchAll(/await createRoadmap\(/g)].map((m) => m.index!);
    assert.equal(calls.length, 2, "handleProgram and the /roadmap new|port command");
    const handleProgram = idx.indexOf("const handleProgram = async");
    assert.ok(handleProgram > 0 && calls.some((c) => c > handleProgram && c < handleProgram + 4000), "one is inside handleProgram");
    assert.match(idx.slice(calls[1] - 600, calls[1]), /cmd\.kind === "new" \|\| cmd\.kind === "port"/, "the other is the /roadmap command");
    assert.match(idx, /if \(outcome === "program"\) \{\n\s+const programResult = await handleProgram\(/, "a program route is the only way into handleProgram from the prompt");
  });

  test("the questionnaire is for a new product only: a request that cites a reference, or a project that already has code, does not get it", () => {
    const flow = src("src/roadmapFlow.ts");
    assert.match(flow, /\(deps\.questionMode \?\? "essential"\) !== "autonomous" && wantsQuestionnaire\(deps\.repoRoot, args\)/);
    assert.match(src("src/intake.ts"), /return !args\.referenceDir && isNewProject\(repoRoot\)/);
  });
});

describe("planning: one file is one phase, and nothing is asked", () => {
  test("the Planner is told a phase holds exactly one file, N files make N phases, and a task already done is exactly one phase", () => {
    assert.match(PLANNER_SYSTEM, /Every phase "files" array MUST contain EXACTLY ONE file/);
    assert.match(PLANNER_SYSTEM, /If 4 files need changes, output EXACTLY 4 phases/);
    assert.match(PLANNER_SYSTEM, /return exactly one phase where "goal" states no change is required/);
  });

  test("a one-file plan is accepted as it is: one phase, one file, valid, not degraded, no phase added", () => {
    const r = parsePlan(ONE_FILE_PLAN, REQUEST);
    assert.equal(r.degraded, false);
    assert.equal(r.plan.phases.length, 1);
    assert.equal(r.allPhases.length, 1);
    assert.equal(r.truncatedFromPhaseCount, undefined);
    assert.deepEqual(r.plan.phases[0].files, ["src/theme.ts"]);
    assert.deepEqual(validatePlan(r.plan), []);
    assert.match(phaseInstructions(r.plan, r.plan.phases[0], 0), /phase 1 of 1: Set the app font to Impact/);
  });

  test("nothing is asked for it: no clarifying question and no assumption means no question to the person", () => {
    const r = parsePlan(ONE_FILE_PLAN, REQUEST);
    assert.deepEqual(questionsToAsk(r.plan), []);
  });

  test("a point a font change leaves open is routine, not essential: under the default policy it is decided and recorded, not asked", () => {
    const q = { question: "Should the heading font also change?", options: ["Yes, everywhere", "Only body text"] };
    assert.equal(looksEssential(q), false);
    const d = decideWithoutAsking(q, false);
    assert.equal(d.choice, "Yes, everywhere", "its first option, the Planner's recommendation");
    assert.equal(d.essential, false, "no review flag");
  });

  test("a reply the harness cannot read degrades to ONE phase carrying the request, never a split", () => {
    for (const raw of ["", "I would change the font in the theme.", "{ broken json"]) {
      const r = parsePlan(raw, REQUEST);
      assert.equal(r.degraded, true);
      assert.equal(r.plan.phases.length, 1);
      assert.equal(r.plan.phases[0].goal, REQUEST);
    }
  });
});
