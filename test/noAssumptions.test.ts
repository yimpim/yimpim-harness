/**
 * The harness never lets a plan quietly rest on a guess: every assumption is
 * asked of the user, and an "assumption" that only defers a checkable fact is
 * pushed back to the Planner. Also: old quarantined files stop being collected
 * by test runners.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASSUMPTION_CONFIRM_OPTION, lintAssumptions, questionsToAsk } from "../src/planner.js";
import { neutralizeLegacyQuarantine } from "../src/quarantine.js";
import { PLANNER_SYSTEM } from "../src/prompts.js";

describe("questionsToAsk", () => {
  test("every assumption becomes a question after the planner's own, capped at 5", () => {
    const qs = questionsToAsk({
      clarifyingQuestions: [{ question: "Which screen?", options: ["Home", "Settings"] }],
      assumptions: ["A worker is current when its run has not ended", "Dates are UTC"],
    });
    assert.equal(qs.length, 3);
    assert.equal(qs[0].question, "Which screen?");
    assert.match(qs[1].question, /The plan assumes: A worker is current/);
    assert.equal(qs[1].options[0], ASSUMPTION_CONFIRM_OPTION);

    const many = questionsToAsk({
      clarifyingQuestions: [],
      assumptions: Array.from({ length: 9 }, (_, i) => `assumption ${i}`),
    });
    assert.equal(many.length, 5);
  });

  test("no assumptions and no questions means nothing to ask", () => {
    assert.deepEqual(questionsToAsk({ clarifyingQuestions: [], assumptions: [] }), []);
    assert.deepEqual(questionsToAsk({ clarifyingQuestions: [], assumptions: ["  "] }), []);
  });

  test("a repeated assumption is asked once", () => {
    const qs = questionsToAsk({ clarifyingQuestions: [], assumptions: ["Same thing", "same thing"] });
    assert.equal(qs.length, 1);
  });
});

describe("lintAssumptions", () => {
  test("flags assumptions that defer a checkable fact to implementation", () => {
    const issues = lintAssumptions([
      "A worker is considered current when its run has not ended; confirm this interpretation against the available worker-run fields during implementation.",
      "The parser strips fields; verify while implementing",
      "Users are signed in before reaching this screen",
    ]);
    assert.equal(issues.length, 2);
    assert.match(issues[0], /read the file or spec that settles it now/);
  });

  test("a plain assumption is left for the user to answer", () => {
    assert.deepEqual(lintAssumptions(["The new button goes in the header"]), []);
  });
});

describe("planner prompt", () => {
  test("tells the Planner to follow a given spec exactly and never defer checkable facts", () => {
    assert.match(PLANNER_SYSTEM, /NEVER GUESS/);
    assert.match(PLANNER_SYSTEM, /FOLLOW THAT EXACTLY/);
    assert.match(PLANNER_SYSTEM, /confirm during implementation/);
  });
});

describe("neutralizeLegacyQuarantine", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  test("renames old quarantined files so no runner collects them, and leaves new ones alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-quar-"));
    dirs.push(dir);
    const base = path.join(dir, ".agent", "rejected", "123");
    fs.mkdirSync(path.join(base, "__tests__"), { recursive: true });
    fs.mkdirSync(path.join(base, "src"), { recursive: true });
    fs.writeFileSync(path.join(base, "__tests__", "a.test.ts"), "old");
    fs.writeFileSync(path.join(base, "src", "b.ts.rejected"), "new");

    assert.equal(neutralizeLegacyQuarantine(dir), 1);
    assert.ok(fs.existsSync(path.join(base, "__tests__", "a.test.ts.rejected")));
    assert.ok(!fs.existsSync(path.join(base, "__tests__", "a.test.ts")));
    assert.equal(fs.readFileSync(path.join(base, "src", "b.ts.rejected"), "utf-8"), "new");
    assert.equal(neutralizeLegacyQuarantine(dir), 0, "idempotent");
  });

  test("a repo with no quarantine folder is fine", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-quar-"));
    dirs.push(dir);
    assert.equal(neutralizeLegacyQuarantine(dir), 0);
  });
});

describe("plannerReadBudget", () => {
  test("grows with the discovery targets, between the default and the ceiling", async () => {
    const { plannerReadBudget, PLANNER_MIN_INSPECTED_FILES, PLANNER_MAX_INSPECTED_FILES_CEILING } = await import("../src/agentTools.js");
    // Every target Discovery named, at least 8, at most the ceiling.
    assert.equal(plannerReadBudget(0), PLANNER_MIN_INSPECTED_FILES);
    assert.equal(plannerReadBudget(3), PLANNER_MIN_INSPECTED_FILES);
    assert.equal(plannerReadBudget(6), 8);
    assert.equal(plannerReadBudget(10), 10);
    assert.equal(plannerReadBudget(20), 20);
    assert.equal(plannerReadBudget(80), PLANNER_MAX_INSPECTED_FILES_CEILING);
    assert.equal(PLANNER_MAX_INSPECTED_FILES_CEILING, 30);
  });
});

describe("assumption question wording depends on whether a spec exists", () => {
  const plan = { clarifyingQuestions: [], assumptions: ["Dates are UTC"] };

  test("with a spec, the correction option says to follow it", () => {
    const [q] = questionsToAsk(plan, { hasSpec: true });
    assert.match(q.options[1], /follow the brief\/spec exactly/);
  });

  test("without a spec, it never mentions one — the user says what to do", () => {
    const [q] = questionsToAsk(plan);
    assert.doesNotMatch(q.options.join(" "), /brief|spec/i);
    assert.match(q.options[1], /I'll say what to do/);
  });

  test("mentionsSpec recognises a spec file or phrase, and not ordinary requests", async () => {
    const { mentionsSpec } = await import("../src/planner.js");
    assert.ok(mentionsSpec("follow reference/timeline-port/EXPO_PORT_BRIEF.md exactly"));
    assert.ok(mentionsSpec("implement what docs/spec.md says"));
    assert.ok(mentionsSpec("do it the way the brief describes"));
    assert.ok(!mentionsSpec("add a dark mode toggle to settings"));
    assert.ok(!mentionsSpec("fix the inspector panel spacing"));
  });
});
