/**
 * One bad edit must not cost the whole batch. A real benchmark run sent thirteen edits, the tenth matched two places, all thirteen were refused,
 * the same batch was sent again, and the run gave up. Now each edit stands alone.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEditsLenient } from "../src/healEdits.js";
import { healTests, type HealCall } from "../src/testHeal.js";

describe("applying a batch", () => {
  test("the edits that match are applied, and the ones that do not are skipped and said so", () => {
    const text = "a OLD\nb OLD\nDUP\nDUP\n";
    const r = applyEditsLenient(text, [
      { find: "a OLD", replace: "a NEW" },
      { find: "DUP", replace: "X" },
      { find: "not there", replace: "y" },
      { find: "b OLD", replace: "b NEW" },
    ]);
    assert.equal(r.text, "a NEW\nb NEW\nDUP\nDUP\n");
    assert.equal(r.applied, 2);
    assert.deepEqual(r.skipped.map((s) => s.n), [2, 3]);
    assert.match(r.skipped[0].error, /edit 2: the text to find matches 2 places/);
    assert.match(r.skipped[1].error, /edit 3: the text to find was not found/);
  });
  test("when none can apply, nothing changes and applied is 0", () => {
    const r = applyEditsLenient("x\n", [{ find: "q", replace: "z" }]);
    assert.equal(r.applied, 0);
    assert.equal(r.text, "x\n");
  });
  test("edits apply in order, so a later edit sees an earlier one", () => {
    assert.equal(applyEditsLenient("one\n", [{ find: "one", replace: "two" }, { find: "two", replace: "three" }]).text, "three\n");
  });
});

let dir = "";
const TEST = "__tests__/b.test.ts";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lenient-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), "a OLD\nb OLD\nDUP\nDUP\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
/** One failing test per remaining OLD marker, plus one while a bare DUP is still there. */
const run = async () => {
  const t = read();
  const failed = (t.match(/OLD/g) ?? []).length + (/^DUP$/m.test(t) ? 1 : 0);
  return failed === 0
    ? { ok: true, output: "Tests: 4 passed, 4 total" }
    : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom (${failed} failing)\nTests:       ${failed} failed, ${4 - failed} passed, 4 total` };
};

describe("a batch with one ambiguous edit", () => {
  test("keeps the good edits, tells the worker which one was skipped, and the corrected edit finishes it", async () => {
    const seen: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      seen.push(messages[messages.length - 1].content);
      n++;
      if (n === 1) {
        return JSON.stringify({
          verdict: "stale-test",
          reason: "markers are old",
          edits: [{ find: "a OLD", replace: "a NEW" }, { find: "b OLD", replace: "b NEW" }, { find: "DUP", replace: "X" }],
        });
      }
      return JSON.stringify({ verdict: "stale-test", reason: "now the duplicate with its neighbour", edits: [{ find: "DUP\nDUP", replace: "X\nX" }] });
    };
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "healed");
    assert.equal(read(), "a NEW\nb NEW\nX\nX\n", "the two good edits were kept while the ambiguous one was corrected");
    // Three things, said apart: applied now, already in the file (idempotent), and skipped (needs more context).
    assert.match(seen[1], /Of your 3 edits: 2 applied now; 0 already in the file from an earlier answer \(do not send those again\); 1 SKIPPED because they need more context\. edit 3: the text to find matches 2 places/);
    assert.match(seen[1], /Send only the skipped ones again, each with more surrounding text/);
  });
  test("when the skipped edit is never corrected, the good edits are KEPT: giving up does not throw progress away", async () => {
    // Only the good edits ever apply; the ambiguous one is resent unchanged. The same failure comes back, so it ends, and the file is put back.
    const call: HealCall = async () =>
      JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "a OLD", replace: "a NEW" }, { find: "DUP", replace: "X" }] });
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.notEqual(r.status, "healed");
    // The one edit that applied took the file from 3 failing to 2, so that progress stays; what is left is for a person.
    assert.equal(r.partial, true);
    assert.match(r.note, /fixes it had already made were KEPT \(3 failing at the start, 2 now; 2 lines changed\)/);
    assert.equal(read(), "a NEW\nb OLD\nDUP\nDUP\n");
  });
  test("a batch where nothing applies behaves as before: the worker is told, and the same refusal twice ends it", async () => {
    const call: HealCall = async () => JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "nothing like this", replace: "z" }] });
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "unhealed");
    assert.match(r.note, /its edits could not be applied/);
    assert.equal(read(), "a OLD\nb OLD\nDUP\nDUP\n");
  });
});

describe("edits that were already applied are not failures", () => {
  const A = { find: "a OLD", replace: "a NEW" };
  const B = { find: "b OLD", replace: "b NEW" };
  const FIRST = { verdict: "stale-test", reason: "markers are old", edits: [A, B, { find: "DUP", replace: "X" }] };
  const CORRECTED = { find: "DUP\nDUP", replace: "X\nX" };

  test("an edit whose text is gone because its replacement is already there is counted as already applied", () => {
    const r = applyEditsLenient("a NEW\nb OLD\n", [A, B], new Map([["a NEW", 1]]));
    assert.equal(r.already, 1, "A was applied in an earlier answer");
    assert.equal(r.applied, 1);
    assert.deepEqual(r.skipped, []);
    // A copy of the same line that was ALWAYS in the file does not make a reverted edit look applied: the file must hold the copies the change accounts for
    // (one that was already there, plus the one the edit added). Here the edit's copy is gone and only the original remains, so it is not 'already applied'.
    const dup = applyEditsLenient("a NEW\nb OLD\n", [A], new Map([["a NEW", 2]]));
    assert.equal(dup.already, 0);
    assert.equal(dup.skipped.length, 1);
    // ...and with both copies present it is.
    assert.equal(applyEditsLenient("a NEW\na NEW\nb OLD\n", [A], new Map([["a NEW", 2]])).already, 1);
    // the same text sitting in the file by coincidence is NOT proof it was applied: without the record it is a failure like any other
    assert.equal(applyEditsLenient("a NEW\nb OLD\n", [A]).skipped.length, 1);
    // a find that is simply not there, with a replacement that is not there either, is still a failure
    assert.equal(applyEditsLenient("x\n", [{ find: "q", replace: "z" }]).skipped.length, 1);
  });
  test("resending the whole batch with the one correction added does not trip anything: the old edits are already in, the new one applies", async () => {
    let n = 0;
    const call: HealCall = async () => JSON.stringify(++n === 1 ? FIRST : { verdict: "stale-test", reason: "all of it again, corrected", edits: [A, B, CORRECTED] });
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "healed");
    assert.equal(read(), "a NEW\nb NEW\nX\nX\n");
  });
  test("sending ONLY what is already applied is not an error: it is shown what still fails, and carries on", async () => {
    const seen: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      seen.push(messages[messages.length - 1].content);
      n++;
      if (n === 1) return JSON.stringify(FIRST);
      if (n === 2) return JSON.stringify({ verdict: "stale-test", reason: "same two again", edits: [A, B] });
      return JSON.stringify({ verdict: "stale-test", reason: "the duplicate with its neighbour", edits: [CORRECTED] });
    };
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "healed");
    assert.match(seen[2], /Nothing new to apply: all 2 edits you sent are already in the file\. Send only NEW edits for what still fails \(1 failing now\)/);
    assert.equal(read(), "a NEW\nb NEW\nX\nX\n", "the earlier applied edits were kept the whole time");
  });
  test("a worker that keeps sending only already-applied edits ends the run, and what it fixed is kept", async () => {
    let n = 0;
    const call: HealCall = async () => JSON.stringify(++n === 1 ? FIRST : { verdict: "stale-test", reason: "again", edits: [A, B] });
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "unhealed");
    assert.match(r.note, /kept sending edits that were already in the file/);
    assert.equal(r.partial, true);
    assert.equal(read(), "a NEW\nb NEW\nDUP\nDUP\n");
  });
  test("a turn that says 'did not apply' tells the worker that the applied ones are in, so it should not resend them", async () => {
    const seen: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      seen.push(messages[messages.length - 1].content);
      return JSON.stringify(++n === 1 ? FIRST : { verdict: "stale-test", reason: "r", edits: [CORRECTED] });
    };
    await healTests({ repoRoot: dir, run, call, settle: false });
    assert.match(seen[1], /Of your 3 edits: 2 applied now/);
  });
});

describe("the same-error breaker fires only when the same anchors are skipped again with nothing applied", () => {
  test("two DIFFERENT ambiguous edits are two different problems: the second is not mistaken for a repeat", async () => {
    fs.writeFileSync(path.join(dir, TEST), "dup1\ndup1\ndup2\ndup2\n");
    const runDup = async () => {
      const t = read();
      const failed = (/^dup1$/m.test(t) ? 1 : 0) + (/^dup2$/m.test(t) ? 1 : 0);
      return failed === 0
        ? { ok: true, output: "Tests: 2 passed, 2 total" }
        : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom (${failed} failing)\nTests:       ${failed} failed, ${2 - failed} passed, 2 total` };
    };
    let n = 0;
    const call: HealCall = async () =>
      JSON.stringify(
        ++n === 1
          ? { verdict: "stale-test", reason: "r", edits: [{ find: "dup1", replace: "ok1" }] }
          : n === 2
            ? { verdict: "stale-test", reason: "r", edits: [{ find: "dup2", replace: "ok2" }] }
            : { verdict: "stale-test", reason: "r", edits: [{ find: "dup1\ndup1", replace: "ok1\nok1" }, { find: "dup2\ndup2", replace: "ok2\nok2" }] }
      );
    const r = (await healTests({ repoRoot: dir, run: runDup, call, settle: false })).results[0];
    assert.equal(r.status, "healed", "both said 'matches 2 places' for edit 1, but they are different edits");
    assert.equal(read(), "ok1\nok1\nok2\nok2\n");
  });
  test("the SAME ambiguous edit again, with nothing applied, does end it", async () => {
    const call: HealCall = async () => JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "DUP", replace: "X" }] });
    const r = (await healTests({ repoRoot: dir, run, call, settle: false })).results[0];
    assert.equal(r.status, "unhealed");
    assert.equal(read(), "a OLD\nb OLD\nDUP\nDUP\n");
  });
  test("when the whole batch is resent, the report separates new, already-in and skipped", async () => {
    // A marker no edit ever fixes keeps the file failing, so the worker is shown the report after its second answer.
    fs.writeFileSync(path.join(dir, TEST), "a OLD\nb OLD\nDUP\nDUP\nZ OLD\n");
    const runZ = async () => {
      const t = read();
      const failed = (t.match(/OLD/g) ?? []).length + (/^DUP$/m.test(t) ? 1 : 0);
      return failed === 0
        ? { ok: true, output: "Tests: 5 passed, 5 total" }
        : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom (${failed} failing)\nTests:       ${failed} failed, ${5 - failed} passed, 5 total` };
    };
    const first = { find: "a OLD", replace: "a NEW" };
    const second = { find: "b OLD", replace: "b NEW" };
    const seen: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      seen.push(messages[messages.length - 1].content);
      n++;
      if (n === 1) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [first, second, { find: "DUP", replace: "X" }] });
      // everything again: two already in, the ambiguous one still ambiguous, and one NEW correction
      if (n === 2) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [first, second, { find: "DUP", replace: "X" }, { find: "DUP\nDUP", replace: "X\nX" }] });
      return JSON.stringify({ verdict: "unclear", reason: "that is all I can do" });
    };
    await healTests({ repoRoot: dir, run: runZ, call, settle: false });
    assert.match(seen[1], /Of your 3 edits: 2 applied now; 0 already in the file from an earlier answer/, "after turn 1");
    assert.match(seen[2], /Of your 4 edits: 1 applied now; 2 already in the file from an earlier answer \(do not send those again\); 1 SKIPPED because they need more context\. edit 3: the text to find matches 2 places/, "after turn 2, three things said apart");
  });
});

describe("a rollback also rolls back what was recorded as applied", () => {
  test("after a 'made it worse' undo, an edit from the undone batch is not remembered as applied (it would later look 'already in the file')", async () => {
    fs.writeFileSync(path.join(dir, TEST), "F1\nR\nZ\n");
    const runR = async () => {
      const t = read();
      const failed = (/^F1$/m.test(t) ? 1 : 0) + (/^Z$/m.test(t) ? 1 : 0) + (t.includes("BAD") ? 5 : 0);
      return failed === 0
        ? { ok: true, output: "Tests: 3 passed, 3 total" }
        : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom (${failed} failing)\nTests:       ${failed} failed, ${8 - failed} passed, 8 total` };
    };
    const seen: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      seen.push(messages[messages.length - 1].content);
      n++;
      // 1: applies F1->R (R was in the file once, so the change accounts for two copies) and Z->BAD, which makes things worse: undone.
      if (n === 1) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "F1", replace: "R" }, { find: "Z", replace: "BAD" }] });
      // 2: a different edit that brings the file to THREE copies of R (as part of a longer replacement)
      if (n === 2) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "Z", replace: "R\nR" }] });
      // 3: an edit whose find is not there. With the rolled-back record still in place it would look 'already applied' (R is at 2 or more copies).
      if (n === 3) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "GONE", replace: "R" }] });
      return JSON.stringify({ verdict: "unclear", reason: "done" });
    };
    await healTests({ repoRoot: dir, run: runR, call, settle: false });
    assert.match(seen[1], /made it WORSE: 2 test\(s\) failing before, 5 after/);
    assert.match(seen[3], /Not applied: edit 1: the text to find was not found/, "a find that is not there is a failure, not an edit that was already applied");
    assert.doesNotMatch(seen[3], /Nothing new to apply|already in the file/);
  });
});
