/**
 * Regression tests for catching a mistyped or slash-less command before it
 * falls through to task classification. Reported directly by the user: "/hrlp"
 * and "remote-control" (no leading slash) both silently kicked off a full
 * Discovery pass, forcing a Ctrl-C to recover.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectCommandTypo, closestSlashCommand, levenshteinDistance } from "../src/commandTypo.js";

describe("detectCommandTypo", () => {
  test("a near-miss slash command suggests the closest real one", () => {
    const result = detectCommandTypo("/hrlp");
    assert.ok(result);
    assert.match(result!.message, /did you mean \/help/);
  });

  test("a known command's bare name typed without the slash is caught", () => {
    const result = detectCommandTypo("remote-control");
    assert.ok(result);
    assert.match(result!.message, /did you mean \/remote-control/);
  });

  test("a slash command too garbled to suggest anything still refuses, without a wrong guess", () => {
    const result = detectCommandTypo("/zzzzzqqqqq");
    assert.ok(result);
    assert.match(result!.message, /Unknown command/);
    assert.doesNotMatch(result!.message, /did you mean/);
  });

  test("a real, exactly-matching slash command is left alone — not this function's job", () => {
    assert.equal(detectCommandTypo("/help"), undefined);
    assert.equal(detectCommandTypo("/branch"), undefined);
  });

  test("ordinary multi-word task text is never caught, even if it starts with a command-like word", () => {
    assert.equal(detectCommandTypo("help me understand this branch"), undefined);
    assert.equal(detectCommandTypo("remote control the drone from the app"), undefined);
  });

  test("ordinary single-word task text that isn't a known command name is left alone", () => {
    assert.equal(detectCommandTypo("refactor"), undefined);
    assert.equal(detectCommandTypo("format"), undefined);
  });

  test("is case-insensitive for the slash-less exact-match case", () => {
    const result = detectCommandTypo("Remote-Control");
    assert.ok(result);
    assert.match(result!.message, /\/remote-control/);
  });
});

describe("closestSlashCommand", () => {
  test("returns undefined when nothing is close enough to be a plausible typo", () => {
    assert.equal(closestSlashCommand("xyzxyzxyzxyz"), undefined);
  });

  test("scales its tolerance with the candidate word's length", () => {
    // "ask" (3 chars) tolerates at most 1 edit; short commands like "rc"
    // tolerate even less, so this must miss every known command by more
    // than its own length-scaled threshold.
    assert.equal(closestSlashCommand("xz"), undefined);
    assert.equal(closestSlashCommand("ak"), "ask"); // 1 deletion away, within tolerance
  });
});

describe("levenshteinDistance", () => {
  test("zero for identical strings", () => {
    assert.equal(levenshteinDistance("help", "help"), 0);
  });

  test("counts a single substitution as distance 1", () => {
    assert.equal(levenshteinDistance("hrlp", "help"), 1);
  });

  test("counts insertions and deletions correctly", () => {
    assert.equal(levenshteinDistance("hel", "help"), 1);
    assert.equal(levenshteinDistance("helpp", "help"), 1);
  });
});
