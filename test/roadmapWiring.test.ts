/**
 * index.ts runs the whole CLI when imported, so it cannot be loaded by a test.
 * These check that the roadmap is actually connected to the run loop: a unit is
 * recorded when its task passes, kept when it fails, and overflow goes onto the
 * roadmap instead of a queue that "no" deletes.
 */
import { test, describe } from "node:test";
import { parseIntentReply } from "../src/routeIntent.js";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("the roadmap is wired into the run loop", () => {
  test("/roadmap is handled before a request is treated as a task, through one shared function", () => {
    assert.match(src, /trimmed === "\/roadmap" \|\| trimmed\.startsWith\("\/roadmap "\)\) \{\n\s+if \(\(await runRoadmapCommand\(parseRoadmapCommand/);
    assert.ok(src.indexOf('trimmed === "/roadmap"') < src.indexOf('trimmed === "/exit"'));
  });

  test("a unit that passes is recorded with the commit and files it produced, before the next one is offered", () => {
    const record = src.indexOf("finishUnit(repoRoot, activeUnitId");
    const offer = src.indexOf("await offerNextUnit()", record);
    assert.ok(record > 0 && offer > record);
    assert.match(src, /finishUnit\(repoRoot, activeUnitId, \{ commit, files, summary/);
    assert.match(src, /diff-tree.{0,40}--name-only/);
  });

  test("answering 'no' to the next unit leaves the roadmap alone", () => {
    const block = src.slice(src.indexOf("const offerNextUnit = async"), src.indexOf("const handleProgram = async"));
    assert.doesNotMatch(block, /saveTaskQueue\(repoRoot, \[\]\)/);
    assert.match(block, /choices: \["yes next", "yes to all", "no"\]/);
  });

  test("a failed unit stays resumable and is parked after repeated failure", () => {
    assert.match(src, /failUnit\(repoRoot, failedUnit, err\.message\)/);
    assert.match(src, /is still in progress\. "\/roadmap run" tries it again/);
    assert.match(src, /failed \$\{MAX_UNIT_ATTEMPTS\} times and is parked as blocked/);
  });

  test("a plan too big for one task goes on the roadmap", () => {
    assert.match(src, /absorbOverflow\(repoRoot, \{/);
    assert.match(src, /This is bigger than one task/);
  });

  test("a unit starts as a normal task, through the same path a queued task takes", () => {
    assert.match(src, /queuedInstructions = started\.prompt;\n\s+activeUnitId = started\.unit\.id;/);
  });

  test("/help lists it", () => {
    assert.match(src, /\/roadmap          A big job split into units/);
  });
});

describe("a unit is never mistaken for a question", () => {
  test("its text skips the intent classifier, which could read it as a question and answer it instead of building it", () => {
    assert.match(src, /!args\.yes && !\(fromQueue && activeUnitId\)\) \{\n\s+requestUsageStart = events\.usageReport\(\);\n\s+costShownForRequest = false;\n\s+const outcome = await answerIfQuestion\(instructions\.trim\(\)/);
  });
});

describe("the classifier decides when a request is a roadmap, not the user typing /roadmap", () => {
  test("the classifier can answer 'program', with the folder to rebuild from, and defaults to 'task' when unsure", async () => {
    const { INTENT_SYSTEM } = await import("../src/prompts.js");
    assert.match(INTENT_SYSTEM, /"program"/);
    assert.match(INTENT_SYSTEM, /"reference": string \| null/);
    assert.match(INTENT_SYSTEM, /Never write a path that is not in the list/);
    assert.match(INTENT_SYSTEM, /SIZE AND BREADTH.*not how long the message is/s);
    assert.match(INTENT_SYSTEM, /a detailed description of ONE feature, screen, bug or\s+refactor is still "task"/);
    assert.match(INTENT_SYSTEM, /When unsure between "task" and "program", choose "task"/);
    assert.match(INTENT_SYSTEM, /Never write a path that is not in the list/);
  });

  test("a program-sized request is handed back to the prompt loop, which offers a roadmap", () => {
    assert.equal(parseIntentReply(JSON.stringify({ intent: "program" })).intent, "program");
    assert.match(src, /if \(intent === "program"\) \{[\s\S]*?return "program";/);
    assert.match(src, /const programResult = await handleProgram\(trimmed, programReferenceHint\);\n\s+if \(programResult === "started"\) continue taskLoop;/);
  });

  test("with nobody to ask, or if the offer is declined, it runs as one task exactly as before", () => {
    const body = src.slice(src.indexOf("const handleProgram = async"), src.indexOf("taskLoop: while (true) {"));
    assert.match(body, /if \(!canAsk\) return "single";/);
    assert.match(body, /if \(!pick\.startsWith\("Plan"\)\) return "single";/);
  });

  test("an existing roadmap is added to, not replaced, and the folder named is looked up, never guessed", () => {
    const body = src.slice(src.indexOf("const handleProgram = async"), src.indexOf("taskLoop: while (true) {"));
    assert.match(body, /a roadmap already exists/);
    assert.match(body, /changeRoadmap\(roadmapDeps\(\), text\)/);
    assert.match(body, /resolveReferenceDir\(repoRoot, hint\)/);
    assert.match(body, /I could not find a folder matching/);
  });

  test("the first unit is offered straight after the roadmap is made, the same way as every later one", () => {
    const body = src.slice(src.indexOf("const handleProgram = async"), src.indexOf("taskLoop: while (true) {"));
    assert.match(body, /await offerNextUnit\(\);/);
  });
});

describe("the model decides, and what it chose is checked", () => {
  test("the classifier can answer 'roadmap' with the action", async () => {
    const { INTENT_SYSTEM } = await import("../src/prompts.js");
    assert.match(INTENT_SYSTEM, /"roadmapAction": "show" \| "run" \| "add" \| "drop" \| null/);
    assert.match(INTENT_SYSTEM, /Only use this when a roadmap exists/);
  });

  test("it is told whether a roadmap exists and what the project contains", () => {
    assert.match(src, /Context about the project \(not part of the request\)/);
    assert.match(src, /roadmapStateLine\(repoRoot\)/);
    assert.match(src, /renderLayout\(projectLayout\(repoRoot\)\)/);
  });

  test("the folders and documents it picks are kept only if they are really there", () => {
    assert.match(src, /turnDocuments = existingFilesOnly\(repoRoot, parsed\?\.documents, 4\)/);
    assert.match(src, /existingDirOnly\(repoRoot, parsed\?\.reference\)/);
  });

  test("documents it chose reach the Planner as if named", () => {
    assert.match(src, /mergeUnique\(userNamedFiles\(instructions, repoRoot\), turnDocuments\)/);
  });

  test("a roadmap request it understood runs the same command as typing it", () => {
    assert.match(src, /commandFromIntent\(said\?\.action, said\?\.request\)/);
    assert.ok(!/parseRoadmapPhrase/.test(src));
  });
});

describe("the spending notice is not a second question", () => {
  test("it rides on the first 'yes next / yes to all' and answering yes acknowledges it, so it is not asked again", () => {
    const block = src.slice(src.indexOf("const offerNextUnit = async"), src.indexOf("const handleProgram = async"));
    assert.match(block, /const noticeHere = !rm\.costNoticeAckedAt;/);
    assert.ok(block.includes("${noticeHere ?") && block.includes("${ROADMAP_SPEND_NOTICE}"), "the notice is part of the question text");
    const yes = block.indexOf("if (noticeHere) {");
    const spend = block.indexOf("confirmRoadmapSpend()");
    assert.ok(yes > 0 && spend > yes, "the acknowledgment is saved before the standalone check runs");
    assert.match(block, /fresh\.costNoticeAckedAt = new Date\(\)\.toISOString\(\)/);
  });
});

describe("a roadmap unit does not re-queue the jobs its own prompt mentions", () => {
  test("the 'jobs the plan does not cover' safety net is skipped while a unit runs", () => {
    assert.match(src, /const dropped = activeUnitId \? \[\] : unplannedJobs\(instructions, activePlan\);/);
  });
});
