/**
 * A question to a person keeps its technical wording and gets a plain-words explanation under it, for someone who has never
 * programmed. Asked as written when nothing useful can be added.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PLAIN_MARK, buildPlainMessages, needsPlainWords, parsePlain, plainWordsFor, withPlainWords } from "../src/plainWords.js";
import { askAnywhere, runControl, setQuestionExplainer } from "../src/remote/control.js";

const Q = "Should the reducer keep workerRuns in state or derive them in a selector?";
const reply = (o: unknown) => async () => JSON.stringify(o);

describe("which questions get an explanation", () => {
  test("a real question does; the idle prompt, one that already has it, and a tiny one do not", () => {
    assert.equal(needsPlainWords({ prompt: Q }), true);
    assert.equal(needsPlainWords({ prompt: Q, idle: true }), false);
    assert.equal(needsPlainWords({ prompt: `${Q}\n\n(In plain words: where the list is kept.)` }), false);
    assert.equal(needsPlainWords({ prompt: "ok?" }), false);
  });
});

describe("the explanation", () => {
  test("the model is told to keep it plain, short, and to add nothing new", () => {
    const m = buildPlainMessages({ prompt: Q, choices: ["Keep in state", "Derive"] });
    assert.match(m[0].content, /never programmed/);
    assert.match(m[0].content, /No jargon, no code, no file names/);
    assert.match(m[0].content, /Do not add facts, decisions or advice/);
    assert.match(m[1].content, /1\) Keep in state\n2\) Derive/);
  });
  test("it is kept when usable, dropped when the question was already plain, empty, copied, or too long", () => {
    assert.deepEqual(parsePlain(JSON.stringify({ alreadyPlain: false, plain: "(It is asking where the app should remember the list.)" }), Q), { plain: "It is asking where the app should remember the list." });
    assert.equal(parsePlain(JSON.stringify({ alreadyPlain: true, plain: "x".repeat(40) }), Q), null);
    assert.equal(parsePlain(JSON.stringify({ plain: "" }), Q), null);
    assert.equal(parsePlain(JSON.stringify({ plain: Q }), Q), null);
    assert.equal(parsePlain(JSON.stringify({ plain: "y".repeat(900) }), Q), null);
    assert.equal(parsePlain("not json", Q), null);
  });
  test("the technical text is untouched and the explanation sits under it in brackets", () => {
    const out = withPlainWords(Q, "It is asking where the app should remember the list.");
    assert.ok(out.startsWith(Q));
    assert.ok(out.endsWith("\n\n(In plain words: It is asking where the app should remember the list.)"));
  });
  test("a slow or failing model leaves the question as written", async () => {
    assert.equal(await plainWordsFor({ prompt: Q }, async () => { throw new Error("down"); }), null);
    assert.equal(await plainWordsFor({ prompt: Q }, () => new Promise<string>(() => {}), 30), null);
    assert.deepEqual(await plainWordsFor({ prompt: Q }, reply({ alreadyPlain: false, plain: "It is asking where the list is kept." })), { plain: "It is asking where the list is kept." });
  });
});

describe("where it is added", () => {
  afterEach(() => setQuestionExplainer(null));
  test("a question put to a connected phone carries the explanation, and the answer still comes back", async () => {
    let seen = "";
    const listener = (q: { id: string; prompt: string }) => {
      seen = q.prompt;
      setTimeout(() => runControl.answer(q.id, "Derive"), 0);
    };
    runControl.onQuestion(listener as any);
    setQuestionExplainer(async () => ({ plain: "It is asking where the list is kept." }));
    try {
      const answer = await askAnywhere({ id: "pw1", kind: "blocking", prompt: Q, fallback: "", askedAt: "" } as any, `${Q}\n> `);
      assert.equal(answer, "Derive");
      assert.ok(seen.startsWith(Q));
      assert.match(seen, /\(In plain words: It is asking where the list is kept\.\)/);
    } finally {
      runControl.offQuestion(listener as any);
    }
  });
  test("every question goes through the one place, and it is wired to the planner's models", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /setQuestionExplainer\(\(q\) =>\s*plainWordsFor\(q, \(messages\) =>/);
    const ctl = fs.readFileSync(new URL("../src/remote/control.ts", import.meta.url), "utf-8");
    assert.match(ctl, /if \(explainQuestion && \(interactive \|\| runControl\.hasListeners\(\)\)\)/);
  });
});

describe("each option gets a plain gloss too, and what is chosen is the original option", () => {
  const OPTS = ["Keep it in the reducer state", "Derive it in a selector"];
  test("glosses are kept only when there is one per option and each is usable", () => {
    const ok = JSON.stringify({ plain: "It is asking where the app should keep the list.", options: ["The app stores it itself", "The app works it out each time"] });
    assert.deepEqual(parsePlain(ok, Q, 2), { plain: "It is asking where the app should keep the list.", options: ["The app stores it itself", "The app works it out each time"] });
    assert.deepEqual(parsePlain(ok, Q, 3), { plain: "It is asking where the app should keep the list." }, "wrong number of glosses: explanation only");
    assert.deepEqual(parsePlain(ok, Q, 0), { plain: "It is asking where the app should keep the list." });
    assert.deepEqual(parsePlain(JSON.stringify({ plain: "It is asking where the app should keep the list.", options: ["", "ok fine"] }), Q, 2), { plain: "It is asking where the app should keep the list." });
  });
  test("a tap on a phone, or a pick in the terminal, comes back as the original option", async () => {
    let shown: string[] = [];
    const listener = (q: { id: string; choices?: string[] }) => {
      shown = q.choices ?? [];
      setTimeout(() => runControl.answer(q.id, shown[1]), 0);
    };
    runControl.onQuestion(listener as any);
    setQuestionExplainer(async () => ({ plain: "It is asking where the app should keep the list.", options: ["The app works it out each time", "x gloss"].reverse() }));
    try {
      const answer = await askAnywhere({ id: "pw3", kind: "blocking", prompt: Q, choices: OPTS, fallback: "", askedAt: "" } as any, `${Q}\n  1) ${OPTS[0]}\n  2) ${OPTS[1]}\n  > `);
      assert.deepEqual(shown, [`${OPTS[0]} (x gloss)`, `${OPTS[1]} (The app works it out each time)`]);
      assert.equal(answer, OPTS[1]);
    } finally {
      runControl.offQuestion(listener as any);
    }
  });
});
