import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyEdits, parseEdits, presentLargeFile, readRange, searchRepo, LARGE_FILE_LINES } from "../src/healEdits.js";
import { digestFailure } from "../src/failureDigest.js";

let dir = "";
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edits-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("edits", () => {
  test("a find that matches once is replaced, and nothing else changes", () => {
    const r = applyEdits("a\nb\nc\n", [{ find: "b", replace: "B" }]);
    assert.deepEqual(r, { ok: true, text: "a\nB\nc\n" });
  });
  test("edits apply in order, each to the result of the one before", () => {
    const r = applyEdits("one two", [
      { find: "one", replace: "1" },
      { find: "1 two", replace: "1 2" },
    ]);
    assert.deepEqual(r, { ok: true, text: "1 2" });
  });
  test("text that is not there says so, and says how to look", () => {
    const r = applyEdits("a", [{ find: "zzz", replace: "x" }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /edit 1: the text to find was not found/);
      assert.match(r.error, /"from":N,"to":M/);
    }
  });
  test("text that matches in several places is refused with how many", () => {
    const r = applyEdits("x\nx\nx", [{ find: "x", replace: "y" }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /matches 3 places/);
  });
  test("if any edit fails, none is applied", () => {
    const r = applyEdits("a b", [
      { find: "a", replace: "A" },
      { find: "missing", replace: "x" },
    ]);
    assert.equal(r.ok, false);
  });
  test("a file with Windows line endings matches a find written with plain ones", () => {
    const r = applyEdits("a\r\nb\r\nc\r\n", [{ find: "a\nb", replace: "a\nB" }]);
    assert.deepEqual(r, { ok: true, text: "a\nB\nc\n" });
  });
  test("parsing refuses anything that is not a list of find/replace pairs", () => {
    assert.equal(parseEdits(undefined), undefined);
    assert.equal(parseEdits([]), undefined);
    assert.equal(parseEdits([{ find: "", replace: "x" }]), undefined);
    assert.equal(parseEdits([{ find: "a" }]), undefined);
    assert.deepEqual(parseEdits([{ find: "a", replace: "b" }]), [{ find: "a", replace: "b" }]);
  });
});

describe("a large file is shown in parts", () => {
  const big = [
    "import x from './x';",
    "jest.mock('./store', () => ({ getSession: async () => 1 }));",
    ...Array.from({ length: 700 }, (_, i) => (i % 50 === 0 ? `describe('group ${i}', () => {` : `  it('case ${i}', () => { expect(${i}).toBe(${i}); });`)),
  ].join("\n");
  test("it shows the top (imports and mocks), the lines the failure points at, and an outline, with numbers", () => {
    write("__tests__/big.test.ts", big);
    const digest = digestFailure("TypeError: boom is not a function\n    at render (__tests__/big.test.ts:400:3)", dir, "__tests__/big.test.ts");
    const view = presentLargeFile(big, "__tests__/big.test.ts", digest, dir);
    assert.match(view, /LARGE FILE: __tests__\/big\.test\.ts has 702 lines/);
    assert.match(view, /1\| import x from/);
    assert.match(view, /2\| jest\.mock\('\.\/store'/);
    assert.match(view, /around line 400/);
    assert.match(view, /400\| /);
    assert.match(view, /--- outline/);
    assert.match(view, /describe\('group 50'/);
    assert.ok(view.length < big.length * 0.7, `${view.length} vs ${big.length}`);
    assert.doesNotMatch(view, /it\('case 690'/, "lines far from anything that matters are left out");
  });
  test("the threshold is the one the prompt promises", () => {
    assert.equal(LARGE_FILE_LINES, 400);
  });
});

describe("a worker can look around", () => {
  test("a range is numbered, clamped, and capped", () => {
    write("src/a.ts", Array.from({ length: 1000 }, (_, i) => `L${i + 1}`).join("\n"));
    const r = readRange(dir, "src/a.ts", 10, 12)!;
    assert.match(r, /--- src\/a\.ts lines 10-12 of 1000\n10\| L10\n11\| L11\n12\| L12/);
    assert.match(readRange(dir, "src/a.ts", 990, 5000)!, /lines 990-1000 of 1000/);
    assert.match(readRange(dir, "src/a.ts", 1, 5000)!, /lines 1-400 of 1000/);
  });
  test("it will not read outside the project, in .git, or in dependencies", () => {
    write("src/a.ts", "x");
    for (const p of ["../secret.txt", "/etc/passwd", ".git/config", "node_modules/x/index.js", ".agent/state.json"]) assert.equal(readRange(dir, p, 1, 5), undefined, p);
    assert.equal(readRange(dir, "src/missing.ts"), undefined);
  });
  test("a search finds where a name is used", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    write("src/store.ts", "export async function getSupabaseRefreshToken() {}\n");
    write("__tests__/other.test.ts", "getSupabaseRefreshToken: async () => 'mock-refresh-token',\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = await searchRepo(dir, "getSupabaseRefreshToken");
    assert.match(r, /src\/store\.ts:1:/);
    assert.match(r, /__tests__\/other\.test\.ts:1:/);
  });
  test("no match and a too-short pattern are said plainly", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    write("a.txt", "hello");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assert.match(await searchRepo(dir, "zzzzqq"), /\(no matches\)/);
    assert.match(await searchRepo(dir, "a"), /too short/);
  });
});
