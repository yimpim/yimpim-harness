/**
 * Regression tests for the button-style clarifying-question answer mapping
 * (src/remote/control.ts): resolveChoiceAnswer and buildChoicePromptText,
 * pulled out of askChoice specifically so this logic has direct coverage
 * without needing a real TTY/remote session.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveChoiceAnswer, buildChoicePromptText } from "../src/remote/control.js";

describe("resolveChoiceAnswer", () => {
  const choices = ["Top of the screen", "Bottom toolbar", "In the sidebar"];

  test("a typed number maps to the matching choice", () => {
    assert.equal(resolveChoiceAnswer("2", choices, true, "fallback"), "Bottom toolbar");
  });

  test("a number with surrounding whitespace still maps", () => {
    assert.equal(resolveChoiceAnswer("  1  ", choices, true, "fallback"), "Top of the screen");
  });

  test("the choice text itself, in any casing, maps to the canonical choice", () => {
    assert.equal(resolveChoiceAnswer("bottom toolbar", choices, true, "fallback"), "Bottom toolbar");
    assert.equal(resolveChoiceAnswer("IN THE SIDEBAR", choices, true, "fallback"), "In the sidebar");
  });

  test("an out-of-range number falls through to custom text when allowed", () => {
    assert.equal(resolveChoiceAnswer("99", choices, true, "fallback"), "99");
  });

  test("genuine free text is returned as-is when allowCustom is true", () => {
    assert.equal(
      resolveChoiceAnswer("Actually, put it in the header next to the logo", choices, true, "fallback"),
      "Actually, put it in the header next to the logo"
    );
  });

  test("free text falls back when allowCustom is false — a state-machine question has nowhere for it to go", () => {
    assert.equal(resolveChoiceAnswer("something else entirely", choices, false, "fallback"), "fallback");
  });

  test("an empty answer always falls back, custom allowed or not", () => {
    assert.equal(resolveChoiceAnswer("", choices, true, "fallback"), "fallback");
    assert.equal(resolveChoiceAnswer("   ", choices, false, "fallback"), "fallback");
  });

  test("typing the just-printed 'something else' option NUMBER with no follow-up text falls back, not a literal custom answer of just that number", () => {
    // buildChoicePromptText prints choices.length + 1 as the "something
    // else" option's own number — typing just that digit means "I want to
    // type something" with nothing actually typed yet, not a real answer.
    assert.equal(resolveChoiceAnswer(String(choices.length + 1), choices, true, "fallback"), "fallback");
  });
});

describe("buildChoicePromptText", () => {
  test("numbers the choices starting at 1, in order", () => {
    const text = buildChoicePromptText("Where should this go?", ["A", "B", "C"], false);
    assert.match(text, /Where should this go\?/);
    assert.match(text, /1\) A/);
    assert.match(text, /2\) B/);
    assert.match(text, /3\) C/);
  });

  test("appends a numbered 'something else' option when allowCustom is true", () => {
    const text = buildChoicePromptText("Pick one", ["A", "B"], true);
    assert.match(text, /3\) something else — type your own/);
  });

  test("omits the 'something else' option entirely when allowCustom is false", () => {
    const text = buildChoicePromptText("Pick one", ["A", "B"], false);
    assert.ok(!text.includes("something else"));
  });
});
