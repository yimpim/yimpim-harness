import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitJobs, unplannedJobs } from "../src/jobsList.js";
import type { Plan } from "../src/planner.js";

const REQUEST =
  "Read first: reference/APP_SPEC.md. Android is the source of truth. Do these jobs in order. For each one, report what you changed.\n\n" +
  "1. Generic worker card. Brief rules 2 and 6: an agent name the phone does not recognise (for example EXISTENCE) becomes a plain card titled with the agent name.\n" +
  "2. Designer and Security workers. See reference/specs/ROADMAP_SPEC.md section 9. An agent name containing design or logo is Designer.\n" +
  "3. Longer questions. See reference/APP_SPEC.md section 5. Show the whole prompt. Let choices wrap.\n" +
  "4. Roadmap card. See reference/specs/ROADMAP_SPEC.md and the contract. Parse roadmap.state.";

const plan = (over: Partial<Plan> = {}): Plan =>
  ({
    goal: "Render EXISTENCE and other unrecognized agent names as GENERIC worker cards titled with the agent name",
    assumptions: ["Scope is limited to GENERIC handling; the separate DESIGNER and SECURITY worker types are not included."],
    followUpTasks: [],
    phases: [
      { id: "p1", name: "Add GENERIC worker type", goal: "Extend the worker vocabulary with the generic type", files: ["src/models/dashboardPhase.ts"], newFiles: [], changes: ["Add GENERIC to WorkerType"] },
      { id: "p2", name: "Classify unknown agents as GENERIC", goal: "Unrecognized agent names no longer become Editor workers", files: ["src/models/timeline.ts"], newFiles: [], changes: ["fallback returns GENERIC"] },
    ],
    ...over,
  }) as unknown as Plan;

describe("numbered jobs in a request", () => {
  test("the list is read out in order, with the shared context before it", () => {
    const { preamble, jobs } = splitJobs(REQUEST);
    assert.match(preamble, /Read first: reference\/APP_SPEC\.md/);
    assert.deepEqual(jobs.map((j) => j.n), [1, 2, 3, 4]);
    assert.match(jobs[1].text, /^Designer and Security workers/);
    assert.match(jobs[3].text, /Parse roadmap\.state/);
  });
  test("numbers inside a sentence ('section 9.') are not jobs; a single item or a plain request has none", () => {
    assert.equal(splitJobs("See section 9. Then do it.").jobs.length, 0);
    assert.equal(splitJobs("1. Only one job here").jobs.length, 0);
    assert.equal(splitJobs("build the login screen").jobs.length, 0);
  });
  test("a plan that covers only job 1 leaves jobs 2, 3 and 4 queued, each with the shared context", () => {
    const left = unplannedJobs(REQUEST, plan());
    assert.equal(left.length, 3);
    assert.match(left[0], /Read first: reference\/APP_SPEC\.md/);
    assert.match(left[0], /Do only job 2 of 4/);
    assert.match(left[0], /Designer and Security workers/);
    assert.match(left[2], /Do only job 4 of 4/);
    assert.ok(left.every((l) => !/Generic worker card/.test(l)));
  });
  test("a plan that covers every job queues nothing", () => {
    const all = plan({
      phases: [
        ...plan().phases,
        { id: "p3", name: "Designer and Security worker cards", goal: "designer security workers", files: [], newFiles: [], changes: [] },
        { id: "p4", name: "Longer questions wrap", goal: "longer questions show whole prompt", files: [], newFiles: [], changes: [] },
        { id: "p5", name: "Roadmap card", goal: "roadmap card from roadmap.state", files: [], newFiles: [], changes: [] },
      ] as any,
    });
    assert.deepEqual(unplannedJobs(REQUEST, all), []);
  });
  test("a job the Planner already queued is not queued twice", () => {
    const queued = plan({ followUpTasks: ["Designer and Security workers: classify design/logo and secur/pentest agent names"] });
    const left = unplannedJobs(REQUEST, queued);
    assert.equal(left.length, 2);
    assert.ok(left.every((l) => !/Do only job 2 of 4/.test(l)));
  });
  test("assumptions do not count as coverage", () => {
    const left = unplannedJobs(REQUEST, plan());
    assert.ok(left.some((l) => /Designer and Security/.test(l)), "the assumption that mentions them is not a plan");
  });
});
