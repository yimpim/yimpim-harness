/**
 * Questions about what is in the code are answered from the code. Only
 * questions about what the user wants are asked, and an answer from the code
 * counts only if its quote is really in the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordFollowUp } from "../src/roadmapFlow.js";
import { loadRoadmap } from "../src/roadmap.js";
import { acceptVerified, answerFromProject, buildVerifyMessages, filesForQuestions, verifyQuestionsFromCode } from "../src/questionVerify.js";

const repo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qv-"));
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put("app/dashboard.tsx", "export default function Dash() {\n  return <PhaseAccordionCard workerRuns={runs} />;\n}\n");
  put("src/models/timeline.ts", "export type WorkerRun = { reason?: string };\n");
  return dir;
};

const QUESTIONS = [
  "Does app/dashboard.tsx pass reducer runs through PhaseAccordionCard.workerRuns?",
  "Should the reason be shown above or below the worker name?",
];

describe("filesForQuestions", () => {
  test("files named in a question come first, then the plan's, then Discovery's, each once", () => {
    const r = repo();
    assert.deepEqual(filesForQuestions(QUESTIONS, ["src/models/timeline.ts", "app/dashboard.tsx"], ["src/models/timeline.ts"], r), [
      "app/dashboard.tsx",
      "src/models/timeline.ts",
    ]);
  });
  test("a file that does not exist, or lies outside the project, is left out", () => {
    assert.deepEqual(filesForQuestions(["see nope/missing.ts and ../../etc/passwd.ts"], ["gone.ts"], [], repo()), []);
  });
});

describe("acceptVerified", () => {
  const files = [{ path: "app/dashboard.tsx", text: "export default function Dash() {\n  return <PhaseAccordionCard workerRuns={runs} />;\n}\n" }];
  const good = { index: 0, kind: "code", answer: "Yes, it passes runs as workerRuns.", confirms: true, file: "app/dashboard.tsx", quote: "<PhaseAccordionCard workerRuns={runs} />" };

  test("an answer whose quote is really in the file is accepted", () => {
    const out = acceptVerified({ answers: [good] }, 2, files);
    assert.equal(out.length, 1);
    assert.equal(out[0].index, 0);
    assert.equal(out[0].confirms, true);
  });

  test("line-number prefixes and spacing differences in the quote do not matter", () => {
    const q = { ...good, quote: "2:   return <PhaseAccordionCard   workerRuns={runs} />;" };
    assert.equal(acceptVerified({ answers: [q] }, 2, files).length, 1);
  });

  test("an invented quote is rejected, so the question is asked", () => {
    assert.deepEqual(acceptVerified({ answers: [{ ...good, quote: "<PhaseAccordionCard runs={workerRuns} reason={r} />" }] }, 2, files), []);
  });

  test("a question about intent, a file that was not supplied, or a tiny quote is not accepted", () => {
    assert.deepEqual(acceptVerified({ answers: [{ ...good, kind: "choice" }] }, 2, files), []);
    assert.deepEqual(acceptVerified({ answers: [{ ...good, file: "app/other.tsx" }] }, 2, files), []);
    assert.deepEqual(acceptVerified({ answers: [{ ...good, quote: "return" }] }, 2, files), []);
  });

  test("a bad index, a repeat, or garbage is ignored", () => {
    assert.deepEqual(acceptVerified({ answers: [{ ...good, index: 9 }] }, 2, files), []);
    assert.equal(acceptVerified({ answers: [good, good] }, 2, files).length, 1);
    assert.deepEqual(acceptVerified(null, 2, files), []);
  });
});

describe("verifyQuestionsFromCode", () => {
  const run = (reply: any, planFiles: string[] = ["app/dashboard.tsx"], r = repo()) =>
    verifyQuestionsFromCode({
      questions: QUESTIONS,
      planFiles,
      discoveryFiles: [],
      repoRoot: r,
      complete: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
    });

  test("the code question is answered and the intent question is left for the user", async () => {
    const out = await run({
      answers: [
        { index: 0, kind: "code", answer: "Yes.", confirms: true, file: "app/dashboard.tsx", quote: "<PhaseAccordionCard workerRuns={runs} />" },
        { index: 1, kind: "choice", answer: "", file: "", quote: "" },
      ],
    });
    assert.deepEqual(out.map((a) => a.index), [0]);
  });

  test("no readable files, a model that fails, or unreadable output means everything is simply asked", async () => {
    assert.deepEqual(await run({ answers: [] }, []), []);
    assert.deepEqual(await run("not json"), []);
    const failing = await verifyQuestionsFromCode({
      questions: QUESTIONS,
      planFiles: ["app/dashboard.tsx"],
      discoveryFiles: [],
      repoRoot: repo(),
      complete: async () => {
        throw new Error("down");
      },
    });
    assert.deepEqual(failing, []);
  });

  test("the prompt tells the model to leave intent alone and never guess", () => {
    const [sys] = buildVerifyMessages(QUESTIONS, [{ path: "a.ts", text: "x" }]);
    assert.match(sys.content, /only the user can answer/);
    assert.match(sys.content, /never guess/);
    assert.match(sys.content, /copied verbatim/);
  });
});

describe("an agent's question in the middle of a task", () => {
  const TASK = "U001: keep the field-retention list. Do not change anything else.";
  const reply = (answers: unknown[]) => async () => JSON.stringify({ answers });
  test("a scope question is settled by the task's own definition, with a quote that is really in it", async () => {
    const got = await answerFromProject({
      question: "history.index carries entries in the spec but not here. Is it okay to leave that out of U001?",
      task: TASK,
      named: [],
      shortlist: [],
      repoRoot: repo(),
      complete: reply([{ index: 0, kind: "code", answer: "Yes: stay inside U001 and log a follow-up.", confirms: false, file: "TASK", quote: "Do not change anything else." }]),
    });
    assert.equal(got?.file, "TASK");
    assert.match(got!.answer, /follow-up/);
  });
  test("a quote that is not in the task is refused, so the user is asked", async () => {
    const got = await answerFromProject({
      question: "Which colour should the badge be?",
      task: TASK,
      named: [],
      shortlist: [],
      repoRoot: repo(),
      complete: reply([{ index: 0, kind: "code", answer: "Blue.", confirms: false, file: "TASK", quote: "The badge is always blue in every theme." }]),
    });
    assert.equal(got, null);
  });
  test("a real product decision is left for the user", async () => {
    const got = await answerFromProject({
      question: "Add a charting dependency or draw it by hand?",
      task: TASK,
      named: [],
      shortlist: ["app/dashboard.tsx"],
      repoRoot: repo(),
      complete: reply([{ index: 0, kind: "choice", answer: "", confirms: false, file: "", quote: "" }]),
    });
    assert.equal(got, null);
  });
  test("ask_user reaches the project first; a failed lookup still asks the user", async () => {
    const { AgentTools } = await import("../src/agentTools.js");
    const src = fs.readFileSync(new URL("../src/agentTools.ts", import.meta.url), "utf-8");
    assert.match(src, /const found = await this\.questionResolver\(question\);\s*if \(found\) \{/);
    assert.match(src, /\} catch \{\s*\/\/ an unanswered question is simply asked/);
    assert.equal(typeof AgentTools.prototype.setQuestionResolver, "function");
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /agentTools\.setQuestionResolver\(async \(question\) => \{/);
    assert.match(src, /Always include your recommendation in the question/);
  });
});

describe("work an agent was told to leave out becomes a follow-up unit", () => {
  test("a scope answer carries the follow-up, which is kept only with a verified quote", () => {
    const files = [{ path: "TASK", text: "U001: keep the field-retention list. Do not change anything else." }];
    const ok = acceptVerified({ answers: [{ index: 0, kind: "code", answer: "Stay inside U001.", file: "TASK", quote: "Do not change anything else.", followUp: "  Make history.index carry entries as the spec says.  " }] }, 1, files);
    assert.equal(ok[0].followUp, "Make history.index carry entries as the spec says.");
    const bad = acceptVerified({ answers: [{ index: 0, kind: "code", answer: "x", file: "TASK", quote: "not in the task at all", followUp: "Do a thing" }] }, 1, files);
    assert.deepEqual(bad, []);
  });
  test("it goes on the roadmap once, even when the same thing is left out twice, and a roadmap that exists is added to", () => {
    const r = repo();
    const id = recordFollowUp(r, "Make history.index carry entries as the spec says.", "Keep the field-retention list");
    assert.match(id!, /^U\d+/);
    assert.equal(recordFollowUp(r, "Make history.index carry entries as the spec says.", "x"), id);
    const rm = loadRoadmap(r)!;
    assert.equal(rm.units.length, 1);
    assert.equal(rm.units[0].area, "Follow-up");
    assert.equal(rm.units[0].addedBy, "overflow");
    recordFollowUp(r, "Rename the retention settings screen.", "x");
    assert.equal(loadRoadmap(r)!.units.length, 2);
    assert.equal(recordFollowUp(r, "   ", "x"), undefined);
  });
  test("the mid-task answer records it and tells the agent", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /if \(got\.followUp\) \{\s*const unit = recordFollowUp\(/);
    assert.match(idx, /The work left out is on the roadmap as/);
  });
});
