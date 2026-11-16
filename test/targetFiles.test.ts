/**
 * A plan must not point the Editor at a file that is not in the repo: that
 * dies later as "could not locate", after earlier phases have already run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lintTargetFiles, missingTargetAssumptions, missingTargetFiles, questionsToAsk } from "../src/planner.js";

const phase = (over: Record<string, unknown>) => ({
  id: "p",
  name: "n",
  goal: "g",
  executor: "EDITOR",
  files: [] as string[],
  newFiles: [] as string[],
  changes: ["c"],
  verification: ["[A1] a thing is visible"],
  ...over,
});
const plan = (phases: any[]): any => ({ goal: "g", assumptions: [], clarifyingQuestions: [], phases });
const has = (...present: string[]) => (rel: string) => present.includes(rel);

describe("missingTargetFiles", () => {
  test("an existing file to change that is not in the repo is reported with its phase", () => {
    const p = plan([phase({ files: ["src/a.ts"] }), phase({ files: ["__tests__/diffScreenshot.test.ts"] })]);
    assert.deepEqual(missingTargetFiles(p, has("src/a.ts")), [{ phase: 2, file: "__tests__/diffScreenshot.test.ts" }]);
  });

  test("a file the phase declares new is fine, and so is one an earlier phase creates", () => {
    const p = plan([
      phase({ files: ["src/new.ts"], newFiles: ["src/new.ts"] }),
      phase({ files: ["src/new.ts", "src/other.ts"] }),
    ]);
    assert.deepEqual(missingTargetFiles(p, has()), [{ phase: 2, file: "src/other.ts" }]);
  });

  test("a file created only by a LATER phase is still missing for an earlier one", () => {
    const p = plan([phase({ files: ["src/late.ts"] }), phase({ files: ["src/late.ts"], newFiles: ["src/late.ts"] })]);
    assert.deepEqual(missingTargetFiles(p, has()), [{ phase: 1, file: "src/late.ts" }]);
  });

  test("path spelling differences do not matter", () => {
    const p = plan([phase({ files: ["./src\\a.ts"] })]);
    assert.deepEqual(missingTargetFiles(p, has("src/a.ts")), []);
  });

  test("QA and SETUP phases, and 'already done' phases, are not judged", () => {
    const p = plan([
      phase({ executor: "QA", files: ["x/gone.ts"] }),
      phase({ executor: "SETUP", files: ["y/gone.ts"] }),
      phase({ goal: "The behavior is already implemented; no change required", files: ["z/gone.ts"] }),
    ]);
    assert.deepEqual(missingTargetFiles(p, has()), []);
  });
});

describe("lint and assumptions", () => {
  test("the corrective-pass message says what to do about it", () => {
    const [msg] = lintTargetFiles(plan([phase({ files: ["__tests__/x.test.ts"] })]), has());
    assert.match(msg, /phase 1 lists "__tests__\/x\.test\.ts" as an existing file/);
    assert.match(msg, /list it in newFiles/);
  });

  test("what is left unresolved becomes a question to the user, not a silent guess", () => {
    const p = plan([phase({ files: ["__tests__/x.test.ts"] })]);
    p.assumptions = missingTargetAssumptions(p, has());
    const [q] = questionsToAsk(p);
    assert.match(q.question, /phase 1 will change "__tests__\/x\.test\.ts", which is not in the repo/);
  });

  test("a plan whose files all exist produces nothing", () => {
    const p = plan([phase({ files: ["src/a.ts"] })]);
    assert.deepEqual(lintTargetFiles(p, has("src/a.ts")), []);
    assert.deepEqual(missingTargetAssumptions(p, has("src/a.ts")), []);
  });
});
