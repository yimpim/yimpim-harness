/**
 * By default nothing waits for a person: open points are decided and recorded, and only what is hard to undo is flagged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksEssential, decideWithoutAsking, describeDecision, questionsToAsk } from "../src/planner.js";
import { ConfigSchema } from "../src/config.js";

const q = (question: string, options: string[] = []) => ({ question, options });

describe("question policy", () => {
  test("defaults to asking only the essential points", () => {
    assert.equal((ConfigSchema.parse({}) as any).planning.questions, "essential");
  });
  test("outside the all mode, no essential point is cut by the cap of five", () => {
    const many = Array.from({ length: 8 }, (_, i) => q(`Delete file ${i}?`));
    assert.equal(questionsToAsk({ assumptions: [], clarifyingQuestions: many }).length, 5);
    assert.equal(questionsToAsk({ assumptions: [], clarifyingQuestions: many }, { limit: Infinity }).length, 8);
  });
  test("only dependency, deletion and security points look essential", () => {
    assert.equal(looksEssential(q("Where does the parser live?")), false);
    assert.equal(looksEssential(q("Does BrokerClient.stream reject a non-JSON 200?")), false);
    assert.equal(looksEssential(q("The plan assumes: the 401 policy clears pairing after 120s\nIs that right?")), false);
    assert.equal(looksEssential(q("Should I add a new dependency for retries?")), true);
    assert.equal(looksEssential(q("Delete the old history file?")), true);
    assert.equal(looksEssential(q("Store the token in plain text?")), false);
    assert.equal(looksEssential(q("Store the credentials in plain text?")), true);
    // The question that wrongly reached the person: tearing down a session is not deleting user data.
    assert.equal(looksEssential(q("The plan assumes: A command-bus 401 callback must not independently wipe the session; only the poll retry policy's GIVE_UP should authorize relay-loss teardown.\nIs that right?")), false);
    assert.equal(looksEssential(q("Should the cache be cleared on logout?")), false);
    assert.equal(looksEssential(q("The plan assumes: all security requirements are met by the existing guard\nIs that right?")), false);
    assert.equal(looksEssential(q("Delete the user's old history files?")), true);
    assert.equal(looksEssential(q("Is it acceptable to overwrite the existing database?")), true);
    assert.equal(looksEssential(q("A security trade-off: cache the token on disk?")), true);
  });
  test("an assumption is kept, a question takes its first option, an open one is left to the Planner", () => {
    const a = questionsToAsk({ assumptions: ["Home stays out of scope"], clarifyingQuestions: [] })[0];
    const da = decideWithoutAsking(a, false);
    assert.equal(da.needsReplan, false);
    assert.match(da.choice, /Home stays out of scope/);
    const dq = decideWithoutAsking(q("Scope?", ["history only", "history and home"]), false);
    assert.equal(dq.choice, "history only");
    assert.equal(dq.needsReplan, true);
    assert.match(decideWithoutAsking(q("Anything?"), false).choice, /decide it yourself/);
  });
  test("a decision no code settled says so; the prompts demand the existing convention first", async () => {
    const d = { ...decideWithoutAsking(q("Button colour?", ["red", "blue"]), false), grounded: false };
    assert.match(describeDecision(d), /no existing code settled this/);
    assert.doesNotMatch(describeDecision(decideWithoutAsking(q("x?", ["a"]), false)), /no existing code/);
    const { PLANNER_SYSTEM } = await import("../src/prompts.js");
    assert.match(PLANNER_SYSTEM, /EXISTING CODE IS THE DEFAULT/);
    assert.match(PLANNER_SYSTEM, /Judge\s+"vagueness" only AFTER this check/);
    const { buildVerifyMessages } = await import("../src/questionVerify.js");
    assert.match(buildVerifyMessages(["c?"], [{ path: "a.ts", text: "x" }])[0].content, /An existing convention settles it/);
  });
  test("a hard-to-undo decision is flagged for review", () => {
    const d = decideWithoutAsking(q("Delete the cache?", ["no, keep it", "yes"]), true);
    assert.match(describeDecision(d), /^⚠️ REVIEW/);
    assert.doesNotMatch(describeDecision(decideWithoutAsking(q("Name?", ["a"]), false)), /REVIEW/);
  });
});

describe("the roadmap follows the same policy", () => {
  test("only the essential points are asked; the rest are decided and never wait", async () => {
    const { settleQuestions } = await import("../src/roadmapFlow.js");
    const asked: string[] = [];
    const deps: any = { repoRoot: ".", complete: async () => "", ask: async (x: any) => (asked.push(x.question), "yes") };
    const qs = [q("Which UI framework?", ["Compose", "Views"]), q("Add a new dependency for maps?", ["yes", "no"]), q("Open-ended?")];
    const r = await settleQuestions(deps, qs);
    assert.deepEqual(asked, ["Add a new dependency for maps?"]);
    assert.equal(r.answered.length, 1);
    assert.deepEqual(r.decided.map((d) => d.answer).slice(0, 1), ["Compose"]);
    assert.equal(r.decided.length, 2);
    const nobody = await settleQuestions({ ...deps, ask: undefined }, qs);
    assert.equal(nobody.answered.length, 0);
    assert.equal(nobody.decided.length, 3);
    assert.equal(nobody.decided[1].essential, true);
    assert.equal((await settleQuestions({ ...deps, questionMode: "all" }, qs)).decided.length, 0);
    assert.equal((await settleQuestions({ ...deps, questionMode: "autonomous" }, qs)).answered.length, 0);
  });
});
