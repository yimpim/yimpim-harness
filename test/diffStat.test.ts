import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lineDiffStat, splitLines } from "../src/agentTools.js";

describe("splitLines", () => {
  test("a trailing newline does not count as an extra line", () => {
    assert.deepEqual(splitLines("a\nb\nc\n"), ["a", "b", "c"]);
  });

  test("no trailing newline still splits correctly", () => {
    assert.deepEqual(splitLines("a\nb\nc"), ["a", "b", "c"]);
  });

  test("empty string is zero lines", () => {
    assert.deepEqual(splitLines(""), []);
  });
});

describe("lineDiffStat", () => {
  test("identical text is a zero diff", () => {
    assert.deepEqual(lineDiffStat("a\nb\nc\n", "a\nb\nc\n"), { added: 0, removed: 0 });
  });

  test("a pure append", () => {
    assert.deepEqual(lineDiffStat("a\nb\n", "a\nb\nc\n"), { added: 1, removed: 0 });
  });

  test("a pure deletion", () => {
    assert.deepEqual(lineDiffStat("a\nb\nc\n", "a\nc\n"), { added: 0, removed: 1 });
  });

  test("a single line changed in the middle", () => {
    assert.deepEqual(lineDiffStat("a\nold\nc\n", "a\nnew\nc\n"), { added: 1, removed: 1 });
  });

  // This is the exact bug caught during manual verification: a naive
  // "trim common prefix/suffix, diff everything between" approach reported
  // this as +4/-3 because line3 and line4 sit between the two real edits and
  // got swept in as "changed" along with them, even though neither changed.
  test("two separate changes with unchanged lines between them are diffed independently", () => {
    const before = "line1\nline2\nline3\nline4\nline5\n";
    const after = "line1\nCHANGED\nline3\nline4\nADDED-LINE\nline5\n";
    assert.deepEqual(lineDiffStat(before, after), { added: 2, removed: 1 });
  });

  test("a brand new file (empty before) counts every line as added", () => {
    assert.deepEqual(lineDiffStat("", "a\nb\nc\n"), { added: 3, removed: 0 });
  });

  test("a fully emptied file counts every line as removed", () => {
    assert.deepEqual(lineDiffStat("a\nb\nc\n", ""), { added: 0, removed: 3 });
  });

  test("large inputs fall back to the trim-only stat rather than hanging on an O(n*m) table", () => {
    const bigBefore = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n") + "\n";
    const bigAfter = Array.from({ length: 2000 }, (_, i) => `line-${i}-x`).join("\n") + "\n";
    const start = Date.now();
    const stat = lineDiffStat(bigBefore, bigAfter);
    assert.ok(Date.now() - start < 2000, "must not hang on a large fully-changed file");
    assert.equal(stat.removed, 2000);
    assert.equal(stat.added, 2000);
  });
});
