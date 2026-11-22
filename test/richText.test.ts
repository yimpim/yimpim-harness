/**
 * Regression tests for the desktop-side markdown-lite renderer. Both sides
 * are meant to agree on the same convention (backtick code spans, **bold**);
 * this locks in the Node half of that contract. The phone's version is tested with the phone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toAnsi, stripAnsi, colorizeRoleTag } from "../src/richText.js";

describe("toAnsi", () => {
  test("wraps a backtick span in the code color escape", () => {
    const result = toAnsi("see `RaceScreen.kt` for the fix");
    assert.match(result, /\x1b\[36mRaceScreen\.kt\x1b\[0m/);
    assert.doesNotMatch(result, /`/);
  });

  test("wraps a **bold** span in the bold escape", () => {
    const result = toAnsi("**Verdict: FAIL**  (confidence: verified)");
    assert.match(result, /\x1b\[1mVerdict: FAIL\x1b\[0m/);
    assert.doesNotMatch(result, /\*\*/);
  });

  test("handles both conventions in the same string", () => {
    const result = toAnsi("**Blocking defects:**\n  ✗ `TextOverflow.Ellipsis` truncates the label");
    assert.match(result, /\x1b\[1mBlocking defects:\x1b\[0m/);
    assert.match(result, /\x1b\[36mTextOverflow\.Ellipsis\x1b\[0m/);
  });

  test("plain text with no markdown markers passes through unchanged", () => {
    const plain = "application started without a fatal runtime error";
    assert.equal(toAnsi(plain), plain);
  });

  test("does not touch existing ANSI escapes already in the string", () => {
    const withAnsi = "\x1b[32m+12\x1b[0m \x1b[31m-3\x1b[0m";
    assert.equal(toAnsi(withAnsi), withAnsi);
  });
});

describe("stripAnsi", () => {
  test("removes color codes and carriage returns, leaving the visible text", () => {
    assert.equal(stripAnsi("\r\x1b[K\x1b[32m+12\x1b[0m \x1b[31m-3\x1b[0m"), "+12 -3");
  });

  test("plain text passes through unchanged", () => {
    const plain = "application started without a fatal runtime error";
    assert.equal(stripAnsi(plain), plain);
  });
});

describe("colorizeRoleTag", () => {
  test("colors a leading [EDITOR] tag, leaving the rest of the line untouched", () => {
    const result = colorizeRoleTag("[EDITOR] Patching file: Foo.kt...");
    assert.match(result, /^\x1b\[96m\[EDITOR\]\x1b\[0m Patching file: Foo\.kt\.\.\.$/);
  });

  test("keeps a leading newline outside the color codes, so it still breaks the line", () => {
    const result = colorizeRoleTag("\n[QA] Starting review...");
    assert.equal(result, "\n\x1b[32m[QA]\x1b[0m Starting review...");
  });

  test("colors every known role with a distinct escape", () => {
    for (const role of ["DISCOVERY", "PLANNER", "EDITOR", "REPAIR", "QA"]) {
      const result = colorizeRoleTag(`[${role}] hello`);
      assert.match(result, /^\x1b\[\d+m\[.+\]\x1b\[0m hello$/);
    }
  });

  test("leaves an infrastructure tag (not a pipeline role) uncolored", () => {
    const plain = "[CONTROL] 🛑 requested";
    assert.equal(colorizeRoleTag(plain), plain);
  });

  test("leaves a role name appearing mid-message alone, not just anywhere in the line", () => {
    const plain = "the [EDITOR] role will patch this next";
    assert.equal(colorizeRoleTag(plain), plain);
  });

  test("plain text with no tag at all passes through unchanged", () => {
    const plain = "application started without a fatal runtime error";
    assert.equal(colorizeRoleTag(plain), plain);
  });
});
