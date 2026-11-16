/**
 * Regression tests for cancelling a setup picker without choosing anything.
 *
 * Reported directly by the user: /model, /model-sort and /api-key had no way
 * out except Ctrl-C. The keyword half of that fix lives in isCancelAnswer —
 * these words used to be handed to pickModel's model search, where "q" or
 * "back" either reported "nothing matches" or silently narrowed the list to
 * whatever happened to contain that substring, looping with no way out.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isCancelAnswer } from "../src/setup.js";

describe("isCancelAnswer", () => {
  test("recognizes every advertised exit word", () => {
    for (const word of ["q", "quit", "exit", "cancel", "back"]) {
      assert.equal(isCancelAnswer(word), true, `expected "${word}" to cancel`);
    }
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    assert.equal(isCancelAnswer("CANCEL"), true);
    assert.equal(isCancelAnswer("  Quit "), true);
    assert.equal(isCancelAnswer("Back"), true);
  });

  test("never mistakes a real model search term for a cancellation", () => {
    for (const term of ["claude", "gemini", "gpt", "deepseek", "qwen", "backup"]) {
      assert.equal(isCancelAnswer(term), false, `expected "${term}" to be treated as a search`);
    }
  });

  test("a multi-word search containing a cancel word is still a search, not a cancellation", () => {
    assert.equal(isCancelAnswer("claude cancel"), false);
    assert.equal(isCancelAnswer("back to basics"), false);
  });

  test("an empty answer is not a cancellation — it keeps its existing per-role meaning", () => {
    assert.equal(isCancelAnswer(""), false);
    assert.equal(isCancelAnswer("   "), false);
  });
});
