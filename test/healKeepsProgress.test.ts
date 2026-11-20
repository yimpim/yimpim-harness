/**
 * Giving up must never throw away progress. A real benchmark run fixed 6 of 34 failures, then spent ten calls on a stubborn one, was ended by the
 * "lookups turned up nothing new" rule, and the give-up put the ORIGINAL file back: the report said nothing had been done.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, renderHealReport, type HealCall } from "../src/testHeal.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
const START = "a OLD\nb OLD\nc OLD\n";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeps-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), START);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
/** One failing test per OLD marker. */
const run = async () => {
  const failed = (read().match(/OLD/g) ?? []).length;
  return failed === 0
    ? { ok: true, output: "Tests: 3 passed, 3 total" }
    : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom (${failed} failing)\nTests:       ${failed} failed, ${3 - failed} passed, 3 total` };
};
const fixA = { find: "a OLD", replace: "a NEW" };
const sequence = (...replies: object[]): HealCall => {
  let n = 0;
  return async () => JSON.stringify(replies[Math.min(n++, replies.length - 1)]);
};
const heal = (call: HealCall) => healTests({ repoRoot: dir, run, call, settle: false });

describe("a give-up after progress", () => {
  test("lookups that turn up nothing new, after one fix: the fix is kept, and the result says so", async () => {
    const report = await heal(sequence({ verdict: "stale-test", reason: "a is old", edits: [fixA] }, { need: [{ search: "zzz-nothing-like-this" }] }));
    const r = report.results[0];
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true);
    assert.equal(read(), "a NEW\nb OLD\nc OLD\n", "the fix stays");
    assert.match(r.note, /its lookups turned up nothing new\. The test fixes it had already made were KEPT \(3 failing at the start, 2 now; 2 lines changed\); what is left needs a person\./);
    assert.match(renderHealReport(report), /Left alone:/);
  });
  test("a partial result is not stored as a diagnosis, so the next run carries on from the improved file", async () => {
    await heal(sequence({ verdict: "stale-test", reason: "r", edits: [fixA] }, { need: [{ search: "zzz-nothing-like-this" }] }));
    const p = path.join(dir, ".agent", "test-log.json");
    const log = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { files: {} }; // nothing stored at all is the expected case
    assert.equal(log.files[TEST]?.verdict, undefined);
    assert.equal(log.files[TEST]?.healStrikes, undefined, "progress is not a failed heal");
  });
  test("with no progress at all, the file goes back exactly as it was, and the note says so", async () => {
    const r = (await heal(sequence({ need: [{ search: "zzz-nothing-like-this" }] }))).results[0];
    assert.equal(r.partial, undefined);
    assert.equal(read(), START);
    assert.match(r.note, /The file was put back as it was\.$/);
  });
  test("a later edit that makes things worse is undone, and when it is then given up on, the earlier fix is still there", async () => {
    const worse = { find: "b OLD", replace: "b OLD OLD OLD" };
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", edits: [fixA] }, { verdict: "stale-test", reason: "r", edits: [worse] }))).results[0];
    assert.equal(r.partial, true);
    assert.equal(read(), "a NEW\nb OLD\nc OLD\n", "the worse edit was undone, the good one kept");
    assert.match(r.note, /made more tests fail again/);
  });
  test("it is also kept when the same failure simply comes back", async () => {
    // The second answer changes the file without changing which tests fail, so the same failure comes back and it gives up.
    const noop = { find: "c OLD", replace: "c OLD " };
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", edits: [fixA] }, { verdict: "stale-test", reason: "r", edits: [noop] }))).results[0];
    assert.equal(r.partial, true);
    assert.match(read(), /^a NEW\n/);
  });
});
