/**
 * No question waits forever. When nobody answers in time, the question's own default is taken and the run goes on, and the choice is written down for a
 * person to review. An approval that protects the machine is DENIED, never allowed. Fake timers, no terminal.
 */
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAnywhere, askChoice, runControl, setAnswerDeadline, setAssumptionRoot, setTimeoutResolver, timeoutAnswer, usableModelAnswer } from "../src/remote/control.js";
import { events, type YimpimEvent } from "../src/events.js";
import { AgentTools } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";
import { SETTINGS } from "../src/settings.js";
import type { PendingQuestion } from "../src/remote/protocol.js";

const MIN = 60_000;
let root = "";
let lines: string[] = [];
let origLog: typeof console.log;
const q = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({ id: `q_${Math.random().toString(36).slice(2)}`, kind: "blocking", prompt: "Which colour?", fallback: "blue", askedAt: new Date().toISOString(), ...over });
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deadline-"));
  mock.timers.enable({ apis: ["setTimeout"] });
  setAnswerDeadline(30 * MIN);
  setAssumptionRoot(root);
  lines = [];
  origLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
});
afterEach(() => {
  console.log = origLog;
  mock.timers.reset();
  setAnswerDeadline(0);
  setAssumptionRoot(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the deadline", () => {
  test("a question nobody answers takes its fallback at exactly the deadline, not before", async () => {
    let done: string | undefined;
    const p = askAnywhere(q(), "p").then((a) => (done = a));
    mock.timers.tick(30 * MIN - 1);
    await flush();
    assert.equal(done, undefined, "one millisecond early: still waiting");
    mock.timers.tick(1);
    await p;
    assert.equal(done, "blue");
  });

  test("an answer before the deadline wins, and no timer is left to fire later", async () => {
    const question = q();
    const p = askAnywhere(question, "p");
    mock.timers.tick(29 * MIN);
    runControl.answer(question.id, "red");
    assert.equal(await p, "red");
    mock.timers.tick(24 * 60 * MIN);
    await flush();
    assert.equal(fs.existsSync(path.join(root, ".agent", "assumptions.md")), false, "a real answer is not an assumption");
  });

  test("the loop's own idle prompt never times out, and neither does a deadline of 0", async () => {
    let idleDone = false;
    void askAnywhere(q({ idle: true }), "p").then(() => (idleDone = true));
    mock.timers.tick(24 * 60 * MIN);
    await flush();
    assert.equal(idleDone, false);
    setAnswerDeadline(0);
    let zeroDone = false;
    void askAnywhere(q(), "p").then(() => (zeroDone = true));
    mock.timers.tick(24 * 60 * MIN);
    await flush();
    assert.equal(zeroDone, false);
  });

  test("a deadline can be given for one question", async () => {
    setAnswerDeadline(0);
    const p = askAnywhere(q({ fallback: "x" }), "p", { deadlineMs: 5 * MIN });
    mock.timers.tick(5 * MIN);
    assert.equal(await p, "x");
  });

  test("askChoice inherits it, and answers with the fallback choice", async () => {
    const p = askChoice(q({ choices: ["blue", "red"], fallback: "red" }));
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "red");
  });
});

describe("what a timeout answers", () => {
  test("an approval is always a refusal, whatever its fallback says", () => {
    for (const fb of ["", "no", "n", "deny", "skip", "abort", "cancel", "local", "NO", " Deny "]) {
      assert.deepEqual(timeoutAnswer({ kind: "approval", fallback: fb }), { answer: fb, callerBug: false }, JSON.stringify(fb));
    }
    assert.deepEqual(timeoutAnswer({ kind: "approval", fallback: "yes" }), { answer: "no", callerBug: true });
    assert.deepEqual(timeoutAnswer({ kind: "approval", fallback: "allow" }), { answer: "no", callerBug: true });
  });
  test("anything else takes its own fallback, including 'yes'", () => {
    assert.deepEqual(timeoutAnswer({ kind: "blocking", fallback: "yes" }), { answer: "yes", callerBug: false });
    assert.deepEqual(timeoutAnswer({ kind: "deferred", fallback: "" }), { answer: "", callerBug: false });
  });
  test("an approval whose fallback was 'yes' is refused on timeout, and the caller's mistake is said", async () => {
    const p = askAnywhere(q({ kind: "approval", fallback: "yes", prompt: "X wants to run a command:\n  npm test" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "no");
    assert.ok(lines.some((l) => /was not a refusal for an approval, so "no" was taken/.test(l)), lines.join("\n"));
  });
  test("an approval whose fallback was 'skip' takes 'skip'", async () => {
    const p = askAnywhere(q({ kind: "approval", fallback: "skip" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "skip");
  });
});

describe("it is written down, said, and sent", () => {
  test("a timeout appends a readable block to .agent/assumptions.md, prints one line, and emits the event", async () => {
    const seen: YimpimEvent[] = [];
    const off = events.onEmit((e) => seen.push(e));
    const question = q({ prompt: "Which colour should the header be?\nBlue or red.", fallback: "blue" });
    const p = askAnywhere(question, "p");
    mock.timers.tick(30 * MIN);
    await p;
    off();
    const text = fs.readFileSync(path.join(root, ".agent", "assumptions.md"), "utf8");
    assert.match(text, /^# Assumptions\n\nWhen nobody answered a question in time/);
    assert.match(text, /- Asked: Which colour should the header be\?\n- Took: "blue"\n- Why: no answer within 30 min \(asked .*, id q_/);
    assert.ok(lines.some((l) => /^ {3}↳ ⏱ No answer in 30 min: took "blue" \(written to \.agent\/assumptions\.md\): Which colour should the header be\?$/.test(l)), lines.join("\n"));
    assert.ok(seen.some((e) => e.type === "question.timedOut" && (e as any).answer === "blue" && (e as any).id === question.id));
    // a second one is appended, the header is not repeated
    const p2 = askAnywhere(q({ fallback: "" }), "p");
    mock.timers.tick(30 * MIN);
    await p2;
    const again = fs.readFileSync(path.join(root, ".agent", "assumptions.md"), "utf8");
    assert.equal((again.match(/# Assumptions/g) ?? []).length, 1);
    assert.match(again, /- Took: \(no answer\)/);
  });
});

describe("the other ways of being asked", () => {
  test("ask_user takes a default, and says it back to the agent when nobody answers", async () => {
    const t = new AgentTools(root, { safety: {}, limits: {} } as any, async (_q, fallback) => fallback);
    const tool = (await import("../src/agentTools.js")).TOOLS_SCHEMA.find((x: any) => x.function.name === "ask_user") as any;
    assert.ok(tool.function.parameters.properties.default, "the tool has a default argument");
    assert.match(tool.function.parameters.properties.default.description, /answer you will use if nobody answers in time/);
    // not a terminal here: the default is what comes back
    const withDefault = await t.askUser("Use tabs or spaces?", "spaces");
    assert.match(withDefault, /^Nobody answered, so use your own default: spaces\. State the assumption you made, and continue\.$/);
    const without = await t.askUser("Use tabs or spaces?");
    assert.match(without, /^No human is available to answer/);
  });

  test("the deferred decisions and the visual advisory go through the funnel: no raw prompt is left", () => {
    const loop = fs.readFileSync("src/agentLoop.ts", "utf8").replace(/\r\n/g, "\n");
    assert.ok(!loop.includes("promptOnce"));
    assert.ok(loop.includes('{ id: `deferred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind: "deferred", prompt: `Question: ${item.question}`, fallback: "", askedAt'));
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.ok(idx.includes('const adjustPrompt = await askAnywhere(\n            { id: `visual_${Date.now()}`, kind: "blocking"'));
    assert.ok(!idx.includes('const adjustPrompt = await promptOnce('));
    assert.ok(idx.includes("setAnswerDeadline(Math.round((config.interaction.answerTimeoutMinutes ?? 0) * 60_000));\n  setAssumptionRoot(repoRoot);"));
  });
});

describe("the setting", () => {
  test("30 minutes by default, 0 means wait forever, documented in plain words", () => {
    const i = (ConfigSchema.shape as any).interaction;
    assert.equal(i.parse({}).answerTimeoutMinutes, 30);
    assert.equal(i.parse({ answerTimeoutMinutes: 0 }).answerTimeoutMinutes, 0);
    assert.throws(() => i.parse({ answerTimeoutMinutes: -1 }));
    const s = (SETTINGS as any[]).find((x) => x.key === "interaction.answerTimeoutMinutes");
    assert.ok(s && s.common === true && s.type === "number");
    assert.match(s.description, /refused, never allowed, when nobody answers\. 0 = wait forever\./);
  });
});

describe("approvals are marked as approvals", () => {
  test("the command, install, package and deletion approvals ask as 'approval', and the wiring passes that on", () => {
    const tools = fs.readFileSync("src/agentTools.ts", "utf8").replace(/\r\n/g, "\n");
    assert.equal((tools.match(/this\.askFn\(question, "no", "approval"\)/g) ?? []).length, 3);
    assert.ok(!/this\.askFn\(question, "no"\)/.test(tools));
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.ok(idx.includes('kind: kind === "approval" ? "approval" : "blocking",'));
  });
});

describe("a model answers when nobody does", () => {
  const model = (answer: string, reason = "it keeps the work moving") => async () => ({ answer, reason });
  afterEach(() => setTimeoutResolver(null));

  test("a question with choices takes the model's pick (matched to a choice whatever its casing), and the record says a model decided and why", async () => {
    setTimeoutResolver(model("RED", "easy to change later"));
    const p = askChoice(q({ choices: ["blue", "red"], fallback: "blue", prompt: "Which header colour?" }));
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "red");
    const text = fs.readFileSync(path.join(root, ".agent", "assumptions.md"), "utf8");
    assert.match(text, /- Took: "red"/);
    assert.match(text, /; decided by a model: easy to change later/);
    assert.ok(lines.some((l) => /No answer in 30 min: a model decided "red"/.test(l)), lines.join("\n"));
  });

  test("an answer that is not one of the choices, an error, an empty answer, or no answer in 90 seconds falls back to the question's own default", async () => {
    for (const bad of [model("green"), model(""), async () => { throw new Error("down"); }, async () => undefined]) {
      setTimeoutResolver(bad as any);
      const p = askChoice(q({ choices: ["blue", "red"], fallback: "blue" }));
      mock.timers.tick(30 * MIN);
      assert.equal(await p, "blue");
    }
    setTimeoutResolver(() => new Promise(() => {})); // never answers
    const p = askChoice(q({ choices: ["blue", "red"], fallback: "blue" }));
    mock.timers.tick(30 * MIN);
    await flush();
    mock.timers.tick(90_000);
    assert.equal(await p, "blue");
  });

  test("a custom answer is accepted only where the question allows one", async () => {
    setTimeoutResolver(model("teal"));
    const closed = askChoice(q({ choices: ["blue", "red"], fallback: "blue" }));
    mock.timers.tick(30 * MIN);
    assert.equal(await closed, "blue");
    const open = askChoice(q({ choices: ["blue", "red"], fallback: "blue", allowCustom: true }));
    mock.timers.tick(30 * MIN);
    assert.equal(await open, "teal");
  });

  test("never for an approval, the idle prompt, a deferred decision, or a free-text question with no default", async () => {
    let asked = 0;
    setTimeoutResolver(async () => (asked++, { answer: "yes", reason: "x" }));
    const approval = askAnywhere(q({ kind: "approval", fallback: "no" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await approval, "no");
    const deferred = askAnywhere(q({ kind: "deferred", fallback: "keep" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await deferred, "keep");
    const noDefault = askAnywhere(q({ fallback: "", prompt: "Paste a repo URL" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await noDefault, "");
    assert.equal(asked, 0);
  });

  test("a free-text question that has a default may be answered by the model", async () => {
    setTimeoutResolver(model("Use spaces, two per level"));
    const p = askAnywhere(q({ fallback: "Use the project's existing style", prompt: "Tabs or spaces?" }), "p");
    mock.timers.tick(30 * MIN);
    assert.equal(await p, "Use spaces, two per level");
  });

  test("usableModelAnswer: the rules, directly", () => {
    const withChoices = q({ choices: ["Yes", "No"] });
    assert.equal(usableModelAnswer(withChoices, " yes "), "Yes");
    assert.equal(usableModelAnswer(withChoices, "maybe"), undefined);
    assert.equal(usableModelAnswer(q(), ""), undefined);
    assert.equal(usableModelAnswer(q(), "x".repeat(601)), undefined);
  });

  test("the wiring: on by default, off with the setting, and the model is the planner's", () => {
    assert.equal((ConfigSchema.shape as any).interaction.parse({}).modelAnswersOnTimeout, true);
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.ok(idx.includes("if (config.interaction.modelAnswersOnTimeout !== false) setTimeoutResolver(makeTimeoutResolver({ client, config, repoRoot }));"));
    const r = fs.readFileSync("src/questionResolver.ts", "utf8");
    assert.ok(r.includes("models: deps.config.models.planner,"));
    assert.ok(!/gemini|hydrogen|deepseek/i.test(r), "no model name is built in");
  });

  test("what the model is shown: the goal, the question, the choices and the default, and told they are data", async () => {
    const { resolverPrompt, parseResolverReply } = await import("../src/questionResolver.js");
    const text = resolverPrompt(q({ choices: ["a", "b"], allowCustom: true, fallback: "a", prompt: "Pick one?" }), "a fridge tracker", "README text");
    assert.match(text, /^Project goal: a fridge tracker\nREADME start:\nREADME text\nQuestion:\nPick one\?\nChoices: "a" \| "b" \(or your own answer\)\nThe default if you have no better idea: a$/);
    assert.deepEqual(parseResolverReply(JSON.stringify({ answer: "b", reason: "  because\nit is simpler " }) + " trailing"), { answer: "b", reason: "because it is simpler" });
    assert.equal(parseResolverReply("no json"), undefined);
    assert.equal(parseResolverReply('{"reason":"no answer"}'), undefined);
  });
});
