/**
 * A stronger-model run read the same code again and again (a lookup with no "from" starts at line 1), the prompt grew from 176k to 475k characters,
 * it cost $2.27, and it never proposed an edit. A lookup now sends only the lines the worker has not been shown, and one that adds nothing says so
 * (and offers a probe): two of those in a row park the cause. Nothing here is a cap: what is judged is what the worker has already seen.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, type HealCall } from "../src/testHeal.js";
import { unseenRanges } from "../src/healEdits.js";

describe("unseenRanges", () => {
  test("nothing shown: the whole request is new", () => assert.deepEqual(unseenRanges(10, 20, []), [[10, 20]]));
  test("a request inside what was shown has nothing new", () => assert.deepEqual(unseenRanges(10, 20, [[1, 100]]), []));
  test("a continuation sends only the lines after the shown ones", () => assert.deepEqual(unseenRanges(2670, 3100, [[1, 2670]]), [[2671, 3100]]));
  test("an overlap at the front sends only the lines before", () => assert.deepEqual(unseenRanges(1, 50, [[30, 80]]), [[1, 29]]));
  test("a gap between two shown ranges is sent, and nothing else", () => assert.deepEqual(unseenRanges(1, 100, [[1, 20], [60, 100]]), [[21, 59]]));
  test("shown ranges given out of order, or overlapping each other, are handled", () => assert.deepEqual(unseenRanges(1, 100, [[50, 70], [1, 30], [25, 55]]), [[71, 100]]));
  test("a range that only touches one shown line still gets its other lines", () => assert.deepEqual(unseenRanges(100, 110, [[1, 100]]), [[101, 110]]));
});

let dir = "";
const TEST = "__tests__/o.test.ts";
const SRC = "src/big.ts";
const START = "test-A1 BAD\n";
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), START);
  fs.writeFileSync(path.join(dir, SRC), Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = async () =>
  read().includes("BAD")
    ? { ok: false, output: `FAIL ${TEST}\n  ● test-A1\n    Error: cause A broke\n      at src/big.ts:1:1\n\nTests:       1 failed, 0 passed, 1 total` }
    : { ok: true, output: "Tests: 1 passed, 1 total" };
const need = (...items: unknown[]) => JSON.stringify({ need: items });
const fixA = JSON.stringify({ verdict: "stale-test", reason: "fixed", edits: [{ find: "test-A1 BAD", replace: "test-A1 OK" }] });
const model = (...replies: string[]) => {
  const shown: string[] = [];
  const call: HealCall = async (messages) => {
    shown.push(messages[messages.length - 1].content);
    return replies[Math.min(shown.length - 1, replies.length - 1)];
  };
  return { call, shown };
};
const heal = (call: HealCall) => healTests({ repoRoot: dir, run, call, settle: false });
const linesIn = (text: string) => [...text.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));

describe("a lookup sends only what the worker has not been shown", () => {
  test("a range, then a bigger one that contains it: only the new lines come back", async () => {
    const m = model(need({ path: SRC, from: 10, to: 20 }), need({ path: SRC, from: 10, to: 40 }), fixA);
    await heal(m.call);
    const first = linesIn(m.shown[1]);
    assert.deepEqual([first[0], first[first.length - 1]], [10, 20]);
    const second = linesIn(m.shown[2]);
    assert.deepEqual([second[0], second[second.length - 1]], [21, 40], "10-20 were already shown, so only 21-40 are sent");
    assert.equal(second.length, 20);
  });
  test("a request with no \"from\" starts at line 1 once, and a continuation after it sends only the rest", async () => {
    const m = model(need({ path: SRC, to: 100 }), need({ path: SRC, from: 100, to: 150 }), fixA);
    await heal(m.call);
    const second = linesIn(m.shown[2]);
    assert.deepEqual([second[0], second[second.length - 1]], [101, 150], "line 100 was already shown");
  });
  test("a range that is entirely shown already says which lines, and offers a probe", async () => {
    const m = model(need({ path: SRC, from: 1, to: 50 }), need({ path: SRC, from: 5, to: 30 }), fixA);
    await heal(m.call);
    assert.match(m.shown[2], /already shown above: lines 5-30 of src\/big\.ts/);
    assert.match(m.shown[2], /Nothing new turned up/);
    assert.match(m.shown[2], /MEASURE what you cannot see by reading: a \{"probe"\}/);
  });
  test("two lookups in a row that add nothing park the cause: a loop of re-reading ends by itself, with no cap on honest lookups", async () => {
    const m = model(need({ path: SRC, from: 1, to: 50 }), need({ path: SRC, from: 1, to: 50 }), need({ path: SRC, from: 2, to: 49 }), fixA);
    const report = await heal(m.call);
    assert.equal(m.shown.length, 3, "the third reply was never asked for: the cause was parked after the second repeat");
    assert.equal(report.results[0].status, "unclear");
    assert.match(report.results[0].note, /lookups turned up nothing new/);
  });
  test("lookups that each add new lines are never cut off, however many there are", async () => {
    const asks = Array.from({ length: 12 }, (_, i) => need({ path: SRC, from: i * 20 + 1, to: i * 20 + 20 }));
    const m = model(...asks, fixA);
    const report = await heal(m.call);
    assert.equal(m.shown.length, 13, "twelve lookups were each answered, then the fix: no cap on honest lookups");
    assert.equal(report.results[0].status, "healed");
  });
  test("after the test changes, a range shown before is sent again (its line numbers are not the same)", async () => {
    const edit = JSON.stringify({ verdict: "stale-test", reason: "partial", edits: [{ find: "test-A1 BAD", replace: "test-A1 BAD\ntest-A2 OK" }] });
    const m = model(need({ path: TEST, from: 1, to: 5 }), edit, need({ path: TEST, from: 1, to: 5 }), JSON.stringify({ verdict: "stale-test", reason: "ok", edits: [{ find: "test-A1 BAD", replace: "test-A1 OK" }] }));
    await heal(m.call);
    assert.doesNotMatch(m.shown[m.shown.length - 2] ?? "", /already shown above/, "the second read of the test came after it had changed");
  });
  test("a whole file asked for by name is still answered once, as before", async () => {
    const m = model(need(SRC), need(SRC), fixA);
    await heal(m.call);
    assert.match(m.shown[1], /--- src\/big\.ts lines 1-30\d of 30\d/);
    assert.match(m.shown[2], /Nothing new turned up/);
  });
});
