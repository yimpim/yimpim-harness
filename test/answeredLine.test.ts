/**
 * Every question that is answered is closed in the log with the answer and where it came from. A question left on screen with nothing
 * under it reads as still waiting, and a person scrolling back cannot tell an old one from a new one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { answeredLine, askAnywhere, runControl } from "../src/remote/control.js";

const APPROVAL = "REPAIR wants to run a command:\n  git show HEAD:app/dashboard.tsx\nWhy: Get the committed baseline\nApproving remembers this exact command for this project.\nApprove? (yes/no)";

describe("the line that closes a question", () => {
  test("an approval names the command, not just 'wants to run a command:'", () => {
    const line = answeredLine(APPROVAL, "yes", "terminal");
    assert.equal(line, '   ↳ ✔ Answered "yes" here: REPAIR wants to run a command: git show HEAD:app/dashboard.tsx');
  });
  test("a no is marked as one", () => {
    assert.match(answeredLine(APPROVAL, "no", "terminal"), /^ {3}↳ ✖ Answered "no" here:/);
    assert.match(answeredLine(APPROVAL, "N", "terminal"), /✖/);
    assert.match(answeredLine(APPROVAL, "y", "terminal"), /✔/);
  });
  test("an answer from the phone says so", () => {
    assert.match(answeredLine(APPROVAL, "yes", "phone"), /Answered "yes" from the phone:/);
  });
  test("any other answer is quoted as it was given, without a tick or a cross", () => {
    const line = answeredLine("Roadmap: 0/4 done. Next is U001 \"Job 1\". Continue?", "yes next", "terminal");
    assert.equal(line, '   ↳ Answered "yes next" here: Roadmap: 0/4 done. Next is U001 "Job 1". Continue?');
  });
  test("a long answer or question is cut so it stays one line", () => {
    const line = answeredLine("Q ".repeat(200), "word ".repeat(100), "terminal");
    assert.ok(!line.includes("\n"));
    assert.match(line, /…"/);
    assert.ok(line.length < 300);
  });
  test("a multi-line pasted answer becomes one line", () => {
    assert.ok(!answeredLine("Name it?", "line one\nline two\nline three", "terminal").includes("\n"));
  });
});

describe("asking and answering", () => {
  test("an answer, wherever it comes from, is recorded after the question is closed", async () => {
    runControl.reset();
    const seen: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      const q = { id: "q-test-1", kind: "blocking" as const, prompt: APPROVAL, choices: ["yes", "no"], fallback: "no", askedAt: new Date().toISOString() };
      const pending = askAnywhere(q, APPROVAL);
      await new Promise((r) => setTimeout(r, 10));
      runControl.answer(q.id, "yes");
      assert.equal(await pending, "yes");
    } finally {
      console.log = log;
      runControl.reset();
    }
    assert.ok(seen.some((l) => l.includes('Answered "yes"') && l.includes("git show HEAD:app/dashboard.tsx")), seen.join("\n"));
  });

  test("a stop is not an answer: nothing is claimed", async () => {
    runControl.reset();
    const seen: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      const q = { id: "q-test-2", kind: "blocking" as const, prompt: APPROVAL, choices: ["yes", "no"], fallback: "no", askedAt: new Date().toISOString() };
      const pending = askAnywhere(q, APPROVAL);
      await new Promise((r) => setTimeout(r, 10));
      runControl.requestAbort("keyboard (/stop)");
      await pending;
    } finally {
      console.log = log;
      runControl.reset();
    }
    assert.ok(!seen.some((l) => l.includes("Answered")), seen.join("\n"));
  });
});

describe("the wiring", () => {
  const src = fs.readFileSync(new URL("../src/remote/control.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("every question asked through askAnywhere is closed in the log, with where the answer came from", () => {
    // On the terminal only: a phone gets the answer as question.answered, and an idle prompt's answer as task.start.
    assert.ok(src.includes("if (!runControl.isAborted) logLocal(answeredLine(question.prompt, answer, raw.by));"));
    assert.ok(src.includes('by ??= "terminal";'));
    assert.ok(src.includes('(by ??= "phone")'));
  });
});
