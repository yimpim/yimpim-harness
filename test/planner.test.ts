/**
 * Regression tests for parsePlan's phase-count cap: a model that proposes
 * more than 12 phases used to have the extras silently dropped with no
 * record anywhere that it happened. This locks in the fix: truncation is
 * now reported back via truncatedFromPhaseCount.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, MAX_PLAN_PHASES, phaseVerificationGoal, validatePlan, Plan, PlannedPhase } from "../src/planner.js";
import { buildConsolidationPrompt, PLANNER_SYSTEM, PLANNER_VERIFY_SYSTEM } from "../src/prompts.js";

function makePhase(n: number) {
  return { id: `phase-${n}`, name: `Phase ${n}`, goal: `Do step ${n}`, files: [], newFiles: [], changes: [], verification: [] };
}

function makePlan(phase: Partial<PlannedPhase>): { plan: Plan; phase: PlannedPhase } {
  const fullPhase: PlannedPhase = {
    id: "phase-1",
    name: "Phase 1",
    goal: "Update the retry timeout",
    files: [],
    newFiles: [],
    changes: [],
    verification: [],
    ...phase,
  };
  const plan: Plan = {
    goal: "Make the retry logic more resilient",
    assumptions: [],
    clarifyingQuestions: [],
    vagueness: "low",
    suggestedBranch: null,
    followUpTasks: [],
    phases: [fullPhase],
  };
  return { plan, phase: fullPhase };
}

function planJson(phaseCount: number): string {
  return JSON.stringify({
    goal: "A big multi-step task",
    assumptions: [],
    clarifyingQuestions: [],
    suggestedBranch: null,
    phases: Array.from({ length: phaseCount }, (_, i) => makePhase(i + 1)),
  });
}

describe("parsePlan", () => {
  test("a plan with 12 or fewer phases is untouched, no truncation reported", () => {
    const result = parsePlan(planJson(5), "fallback goal");
    assert.equal(result.degraded, false);
    assert.equal(result.plan.phases.length, 5);
    assert.equal(result.truncatedFromPhaseCount, undefined);
  });

  test("exactly 12 phases is the boundary — still not truncated", () => {
    const result = parsePlan(planJson(12), "fallback goal");
    assert.equal(result.plan.phases.length, 12);
    assert.equal(result.truncatedFromPhaseCount, undefined);
  });

  test("a plan proposing more than 12 phases is capped, and the drop is reported", () => {
    const result = parsePlan(planJson(20), "fallback goal");
    assert.equal(result.plan.phases.length, 12);
    assert.equal(result.truncatedFromPhaseCount, 20);
  });

  test("every proposed phase is preserved on allPhases even when plan.phases is capped", () => {
    const result = parsePlan(planJson(20), "fallback goal");
    assert.equal(result.allPhases.length, 20);
    assert.deepEqual(
      result.allPhases.map((p) => p.id),
      Array.from({ length: 20 }, (_, i) => `phase-${i + 1}`)
    );
    // The capped list is a prefix of the full proposal, not a different set.
    assert.deepEqual(result.plan.phases, result.allPhases.slice(0, MAX_PLAN_PHASES));
  });

  test("a plan at or below the limit keeps allPhases identical to plan.phases", () => {
    const result = parsePlan(planJson(12), "fallback goal");
    assert.equal(result.allPhases.length, 12);
    assert.deepEqual(result.allPhases, result.plan.phases);
  });

  test("malformed JSON degrades to a single phase, not a crash", () => {
    const result = parsePlan("not json at all", "fallback goal");
    assert.equal(result.degraded, true);
    assert.equal(result.plan.phases.length, 1);
    assert.equal(result.allPhases.length, 1);
  });
});

describe("parsePlan — clarifyingQuestions / vagueness", () => {
  function planWithQuestions(extra: Record<string, unknown>): string {
    return JSON.stringify({
      goal: "Add a button",
      assumptions: [],
      suggestedBranch: null,
      phases: [makePhase(1)],
      ...extra,
    });
  }

  test("vagueness defaults to 'low' when the planner's JSON omits it", () => {
    const result = parsePlan(planWithQuestions({}), "fallback goal");
    assert.equal(result.plan.vagueness, "low");
  });

  test("a 'high' vagueness verdict parses through", () => {
    const result = parsePlan(planWithQuestions({ vagueness: "high" }), "fallback goal");
    assert.equal(result.plan.vagueness, "high");
  });

  test("an unrecognized vagueness value fails the plan shape and degrades, rather than silently coercing", () => {
    const result = parsePlan(planWithQuestions({ vagueness: "extremely vague" }), "fallback goal");
    assert.equal(result.degraded, true);
  });

  test("clarifyingQuestions parses the {question, options} object shape", () => {
    const result = parsePlan(
      planWithQuestions({
        clarifyingQuestions: [
          { question: "Where should the button go?", options: ["Header", "Footer", "Sidebar"] },
        ],
      }),
      "fallback goal"
    );
    assert.equal(result.degraded, false);
    assert.deepEqual(result.plan.clarifyingQuestions, [
      { question: "Where should the button go?", options: ["Header", "Footer", "Sidebar"] },
    ]);
  });

  test("a question with no options is still valid — a genuinely open-ended question", () => {
    const result = parsePlan(
      planWithQuestions({ clarifyingQuestions: [{ question: "What should it be called?" }] }),
      "fallback goal"
    );
    assert.equal(result.degraded, false);
    assert.deepEqual(result.plan.clarifyingQuestions, [{ question: "What should it be called?", options: [] }]);
  });

  test("more than 3 options is truncated to 3, not rejected", () => {
    const result = parsePlan(
      planWithQuestions({
        clarifyingQuestions: [{ question: "Pick one", options: ["A", "B", "C", "D", "E"] }],
      }),
      "fallback goal"
    );
    assert.equal(result.degraded, false);
    assert.deepEqual(result.plan.clarifyingQuestions[0].options, ["A", "B", "C"]);
  });

  test("more than 5 questions is truncated to 5, not rejected", () => {
    const result = parsePlan(
      planWithQuestions({
        clarifyingQuestions: Array.from({ length: 8 }, (_, i) => ({ question: `Q${i + 1}`, options: [] })),
      }),
      "fallback goal"
    );
    assert.equal(result.degraded, false);
    assert.equal(result.plan.clarifyingQuestions.length, 5);
    assert.deepEqual(
      result.plan.clarifyingQuestions.map((q) => q.question),
      ["Q1", "Q2", "Q3", "Q4", "Q5"]
    );
  });
});

describe("parsePlan — followUpTasks (multi-task auto-continue backlog)", () => {
  test("defaults to an empty array when the planner's JSON omits it — the common case", () => {
    const result = parsePlan(planJson(3), "fallback goal");
    assert.deepEqual(result.plan.followUpTasks, []);
  });

  test("a degraded (fallback single-phase) plan also has an empty followUpTasks, never undefined", () => {
    const result = parsePlan("not json at all", "fallback goal");
    assert.deepEqual(result.plan.followUpTasks, []);
  });

  test("carries through deferred chunks the planner explicitly listed", () => {
    const json = JSON.stringify({
      goal: "Redesign every screen to match the new mockups",
      assumptions: [],
      clarifyingQuestions: [],
      suggestedBranch: null,
      followUpTasks: ["Redesign the History screen to match the new mockups", "Redesign the Settings screen to match the new mockups"],
      phases: [makePhase(1)],
    });
    const result = parsePlan(json, "fallback goal");
    assert.deepEqual(result.plan.followUpTasks, [
      "Redesign the History screen to match the new mockups",
      "Redesign the Settings screen to match the new mockups",
    ]);
  });
});

describe("PLANNER_SYSTEM guardrails", () => {
  test("bounds planner inspection to upstream target files, a limited file budget", () => {
    assert.match(PLANNER_SYSTEM, /BOUNDED INSPECTION/);
    assert.match(PLANNER_SYSTEM, /INSPECT ONLY UPSTREAM TARGET FILES/);
    assert.match(PLANNER_SYSTEM, /LIMITED FILE BUDGET/);
    assert.match(PLANNER_SYSTEM, /VERIFY SIGNATURES, TYPES, EXPORTS, AND THE BEHAVIOR YOUR PLAN DEPENDS ON/);
    assert.match(PLANNER_SYSTEM, /never run a broad repository search/);
  });

  test("requires contract specifications instead of raw code blocks or diffs", () => {
    assert.match(PLANNER_SYSTEM, /CONTRACT SPECIFICATIONS, NOT CODE/);
    assert.match(PLANNER_SYSTEM, /NEVER emit full code blocks, function bodies, diffs, or patch hunks/);
    assert.match(PLANNER_SYSTEM, /"contracts"/);
    assert.match(PLANNER_SYSTEM, /"signatures"/);
    assert.match(PLANNER_SYSTEM, /"types"/);
    assert.match(PLANNER_SYSTEM, /"constraints"/);
    // The schema sample must document contracts so the planner emits the shape
    // PhaseSchema/ContractSpecificationsSchema actually parses.
    assert.match(PLANNER_SYSTEM, /VERIFIED CONTRACT SPECIFICATIONS \(NO RAW CODE\)/);
  });

  test("consolidation pass inherits the no-raw-code and contract-preservation rules", () => {
    const prompt = buildConsolidationPrompt("[]", "goal");
    assert.match(prompt, /NEVER omit or weaken a contract/);
    assert.match(prompt, /Still emit NO raw code/);
  });

  test("requires a shared symbol rename/removal to be planned as one phase across every referencing file", () => {
    assert.match(PLANNER_SYSTEM, /EXCEPTION — SHARED SYMBOL RENAME OR REMOVAL/);
    assert.match(PLANNER_SYSTEM, /unable to compile/);
    assert.match(PLANNER_SYSTEM, /until they are updated too/);
    assert.match(PLANNER_SYSTEM, /ALL of those files MUST be planned together as ONE atomic phase/);
    // Unconditional — unlike the 12-phase consolidation exception, this one
    // must not be gated on the phase count, or a rename with room to spare
    // under the cap would still get split one file per phase and break the
    // build at an intermediate phase.
    assert.match(PLANNER_SYSTEM, /unconditional, not gated on the 12-phase limit/);
    // Prose-only mentions (comments, log strings, docs) don't break compilation,
    // so they must stay eligible for ordinary single-file phases.
    assert.match(PLANNER_SYSTEM, /Prose-only mentions .* are NOT coupled this/);
    assert.match(PLANNER_SYSTEM, /they never break compilation/);
    // Rule 4 must point back at the exception, not just restate "compilable".
    assert.match(PLANNER_SYSTEM, /see rule 1's SHARED SYMBOL RENAME OR REMOVAL exception/);
  });

  test("teaches deferring independent excess work to followUpTasks instead of consolidating unrelated chunks", () => {
    assert.match(PLANNER_SYSTEM, /DEFERRING INDEPENDENT EXCESS WORK \(followUpTasks\)/);
    assert.match(PLANNER_SYSTEM, /"followUpTasks"/);
    // Must distinguish this from rule 7's consolidation exception, which is
    // for CLOSELY RELATED files, not independent/unrelated chunks.
    assert.match(PLANNER_SYSTEM, /rule 7's[\s\S]{0,40}consolidation exception is for CLOSELY RELATED files, not for unrelated chunks/);
    assert.match(PLANNER_SYSTEM, /self-contained/);
    assert.match(PLANNER_SYSTEM, /NO memory of this plan/);
  });

  // Regression target: a real 9-screen "work one screen per task, in this
  // order: A, B, C, ..." request silently planned ONLY the first screen and
  // never populated followUpTasks at all -- the old rule only triggered on
  // phase-BUDGET overflow, and one screen alone never got close to the
  // 12-phase limit, so the other 8 screens just evaporated with no
  // automatic continuation ever offered.
  test("teaches that an explicit sequenced worklist triggers followUpTasks even with no phase-budget pressure at all", () => {
    assert.match(PLANNER_SYSTEM, /EXPLICIT SEQUENCED WORKLIST/);
    assert.match(PLANNER_SYSTEM, /work one screen per\s+task/);
    assert.match(PLANNER_SYSTEM, /screen by screen/);
    assert.match(PLANNER_SYSTEM, /chunk 1 ALONE fits[\s\S]{0,20}comfortably/);
    assert.match(PLANNER_SYSTEM, /no budget pressure at all/);
    assert.match(PLANNER_SYSTEM, /8 more screens were ever asked for/);
  });
});

describe("phaseVerificationGoal", () => {
  test("bare verification-only phase renders just the goal and verification bullets", () => {
    const { plan, phase } = makePlan({ verification: ["Retry timeout is 300s"] });
    const goal = phaseVerificationGoal(plan, phase);

    assert.match(goal, /Overall objective: Make the retry logic more resilient/);
    assert.match(goal, /Phase under test: Phase 1/);
    assert.match(goal, /Specifically confirm:\n {2}- Retry timeout is 300s/);
    assert.doesNotMatch(goal, /Specific changes intended for this phase/);
    assert.doesNotMatch(goal, /Contract specifications/);
  });

  test("includes phase.changes under 'Specific changes intended for this phase', so QA can tell an intentionally narrow phase from an incomplete one", () => {
    const { plan, phase } = makePlan({
      changes: ['Bump timeoutDurationMs from 120_000 to 300_000 in openrouter.ts'],
      verification: ["Timeout constant reads 300_000"],
    });
    const goal = phaseVerificationGoal(plan, phase);

    assert.match(goal, /Specific changes intended for this phase:\n {2}- Bump timeoutDurationMs from 120_000 to 300_000 in openrouter\.ts/);
    // Changes must appear before the verification bullets, matching Editor's own instructions ordering.
    assert.ok(goal.indexOf("Specific changes intended for this phase") < goal.indexOf("Specifically confirm"));
  });

  test("resolves nested phase.contracts into 'Contract specifications (already verified by Planner — check the diff matches exactly)' with Signatures/Types/Constraints sub-lines", () => {
    const { plan, phase } = makePlan({
      contracts: {
        signatures: ["function readStreamedCompletion(res: Response): Promise<string>"],
        types: ["interface FunctionTool { name: string; parameters: object }"],
        constraints: ["timeoutDurationMs only guards time-to-first-byte"],
      },
    });
    const goal = phaseVerificationGoal(plan, phase);

    assert.match(goal, /Contract specifications \(already verified by Planner — check the diff matches exactly\):/);
    assert.match(goal, /  Signatures:\n {4}- function readStreamedCompletion\(res: Response\): Promise<string>/);
    assert.match(goal, /  Types:\n {4}- interface FunctionTool \{ name: string; parameters: object \}/);
    assert.match(goal, /  Constraints:\n {4}- timeoutDurationMs only guards time-to-first-byte/);
  });

  test("resolves the contractSpecifications alias the same way as contracts", () => {
    const { plan, phase } = makePlan({
      contractSpecifications: { signatures: ["function foo(x: number): void"], types: [], constraints: [] },
    });
    const goal = phaseVerificationGoal(plan, phase);

    assert.match(goal, /Contract specifications \(already verified by Planner/);
    assert.match(goal, /Signatures:\n {4}- function foo\(x: number\): void/);
  });

  test("resolves flat top-level signatures/types/constraints fields the same way as nested contracts", () => {
    const { plan, phase } = makePlan({
      signatures: ["function bar(): string"],
      types: ["type Bar = string"],
      constraints: ["bar() never returns null"],
    });
    const goal = phaseVerificationGoal(plan, phase);

    assert.match(goal, /Contract specifications \(already verified by Planner/);
    assert.match(goal, /Signatures:\n {4}- function bar\(\): string/);
    assert.match(goal, /Types:\n {4}- type Bar = string/);
    assert.match(goal, /Constraints:\n {4}- bar\(\) never returns null/);
  });

  test("changes, contracts, and verification all render together in order: changes, then contracts, then verification", () => {
    const { plan, phase } = makePlan({
      changes: ["Add the new export"],
      contracts: { signatures: ["function baz(): void"], types: [], constraints: [] },
      verification: ["baz() is exported"],
    });
    const goal = phaseVerificationGoal(plan, phase);

    const changesIdx = goal.indexOf("Specific changes intended for this phase");
    const contractsIdx = goal.indexOf("Contract specifications");
    const verifyIdx = goal.indexOf("Specifically confirm");
    assert.ok(changesIdx >= 0 && contractsIdx > changesIdx && verifyIdx > contractsIdx);
  });
});

describe("buildConsolidationPrompt", () => {
  test("carries the full proposed phases and the 12-phase target constraint", () => {
    const result = parsePlan(planJson(20), "A big multi-step task");
    const prompt = buildConsolidationPrompt(JSON.stringify(result.allPhases), "A big multi-step task");

    assert.match(prompt, /CONSOLIDATION PASS/);
    assert.match(prompt, /A big multi-step task/);
    assert.match(prompt, /12 phases or fewer/);
    assert.match(prompt, /more than 12 phases/);
    assert.match(prompt, /NEVER omit a file/);
    // Every proposed phase must be present, not just the capped 12.
    for (const phase of result.allPhases) {
      assert.ok(prompt.includes(phase.id), `prompt should include ${phase.id}`);
      assert.ok(prompt.includes(phase.goal), `prompt should include the goal for ${phase.id}`);
    }
    assert.ok(prompt.includes("phase-20"), "phase-20 (beyond the cap) must survive into the prompt");
  });

  test("uses PLANNER_VERIFY_SYSTEM instead of PLANNER_SYSTEM when verifyOnly is true", () => {
    const result = parsePlan(planJson(20), "A big regression sweep");
    const normal = buildConsolidationPrompt(JSON.stringify(result.allPhases), "A big regression sweep");
    const verify = buildConsolidationPrompt(JSON.stringify(result.allPhases), "A big regression sweep", true);

    assert.ok(normal.startsWith(PLANNER_SYSTEM));
    assert.ok(verify.startsWith(PLANNER_VERIFY_SYSTEM));
    assert.ok(!verify.startsWith(PLANNER_SYSTEM));
  });
});

describe("validatePlan", () => {
  test("a normal (non-verify) phase with no files or changes is flagged", () => {
    const { plan } = makePlan({ files: [], changes: [], verification: ["it compiles"] });
    const errors = validatePlan(plan);
    assert.ok(errors.some((e) => e.includes("no target files")));
    assert.ok(errors.some((e) => e.includes("no concrete changes")));
  });

  test("verifyOnly relaxes the files/changes checks but still requires verification", () => {
    const { plan } = makePlan({ files: [], changes: [], verification: [] });
    const errors = validatePlan(plan, true);
    assert.ok(!errors.some((e) => e.includes("no target files")), "files check must be skipped for verifyOnly");
    assert.ok(!errors.some((e) => e.includes("no concrete changes")), "changes check must be skipped for verifyOnly");
    assert.ok(errors.some((e) => e.includes("no phase-specific verification")), "verification is still required");
  });

  test("a verifyOnly scenario with files empty and only verification bullets is valid", () => {
    const { plan } = makePlan({
      files: [],
      changes: [],
      verification: ["tapping the toggle cycles light -> dark -> system, icon changes each time"],
    });
    assert.deepEqual(validatePlan(plan, true), []);
  });

  test("a phase whose goal says the behavior does not exist is exempt, even under verifyOnly", () => {
    const { plan } = makePlan({
      goal: "The requested feature does not exist in this codebase — nothing to verify.",
      files: [],
      changes: [],
      verification: [],
    });
    assert.deepEqual(validatePlan(plan, true), []);
  });
});
