/**
 * A question card never outlives its question on the phone. At the deadline it is removed before anything else happens; on a stop it is removed too (it used to stay, with nothing left
 * to answer it); and the line the phone gets says who chose the answer: the question's default, or a model that read it.
 */
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askChoice, runControl, setAnswerDeadline, setAssumptionRoot, setTimeoutResolver } from "../src/remote/control.js";
import { events, type YimpimEvent } from "../src/events.js";
import { translateForRemote } from "../src/remoteEventTranslator.js";
import type { PendingQuestion } from "../src/remote/protocol.js";

const MIN = 60_000;
const q = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({ id: `q_${Math.random().toString(36).slice(2)}`, kind: "blocking", prompt: "Which colour?", fallback: "blue", askedAt: new Date().toISOString(), ...over }) as PendingQuestion;

let resolved: string[] = [];
const onResolved = (id: string) => void resolved.push(id);
let origLog: typeof console.log;
let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qclose-"));
  resolved = [];
  runControl.reset();
  runControl.onQuestionResolved(onResolved);
  origLog = console.log;
  console.log = () => {};
});
afterEach(() => {
  console.log = origLog;
  runControl.offQuestionResolved(onResolved);
  runControl.reset();
  mock.timers.reset();
  setAnswerDeadline(0);
  setAssumptionRoot(undefined);
  setTimeoutResolver(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a stop", () => {
  test("releases the waiting question with its fallback AND tells the listeners, so the phone's status drops it", async () => {
    const question = q();
    const p = runControl.ask(question);
    runControl.requestAbort("phone");
    assert.equal(await p, "blue");
    assert.deepEqual(resolved, [question.id], "the session's resolveQuestion is called for it");
  });
  test("every waiting question is dropped, not just the first", async () => {
    const a = q(), b = q();
    const pa = runControl.ask(a);
    const pb = runControl.ask(b);
    runControl.requestAbort("stop");
    await Promise.all([pa, pb]);
    assert.deepEqual(resolved.sort(), [a.id, b.id].sort());
  });
});

describe("the deadline", () => {
  test("the card is removed at the deadline, before a model is asked to choose", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    setAnswerDeadline(30 * MIN);
    let modelAsked = false;
    let removedBeforeModel: boolean | undefined;
    const question = q({ choices: ["blue", "red"] });
    setTimeoutResolver(async () => {
      modelAsked = true;
      removedBeforeModel = resolved.includes(question.id);
      return { answer: "red", reason: "x" };
    });
    const p = askChoice(question);
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "red");
    assert.equal(modelAsked, true);
    assert.equal(removedBeforeModel, true);
  });
  test("the event says a model chose, and the phone line says so; a default is still 'taken by default'", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    setAnswerDeadline(30 * MIN);
    const seen: YimpimEvent[] = [];
    const off = events.onEmit((e) => void seen.push(e));
    setTimeoutResolver(async () => ({ answer: "red", reason: "x" }));
    const p = askChoice(q({ choices: ["blue", "red"] }));
    mock.timers.tick(30 * MIN);
    await p;
    off();
    const ev = seen.find((e) => e.type === "question.timedOut") as any;
    assert.ok(ev, "the event was emitted");
    assert.equal(ev.byModel, true);
    assert.equal((translateForRemote(ev)!.payload as any).message, 'Nobody answered in time, so a model read the question and chose "red"');
    const byDefault = translateForRemote({ type: "question.timedOut", id: "q", answer: "blue", kind: "blocking" } as any)!.payload as any;
    assert.equal(byDefault.message, 'Nobody answered in time, so "blue" was taken by default');
  });
});
