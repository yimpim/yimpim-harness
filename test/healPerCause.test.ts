/**
 * One cause at a time. A worker asked about every cause at once digs into the hardest and never commits to the easy ones (five benchmark runs at
 * 130 of 164, every call a lookup). It is pointed at one cause, parks what it cannot settle, and the parked causes go to the stronger model, which is
 * told what is already fixed and cannot undo it: an edit that turns a passing test red is undone even when the total count falls.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healTests, renderHealReport, type HealCall } from "../src/testHeal.js";
import { failingNames, regressions } from "../src/healAuthority.js";
import { beginTrial, endTrial, recoverTrial } from "../src/healCheckpoint.js";

let dir = "";
const TEST = "__tests__/p.test.ts";
/** Three causes: A breaks three tests, B two, C one. */
const START = ["test-A1 BAD", "test-A2 BAD", "test-A3 BAD", "test-B1 BAD", "test-B2 BAD", "test-C1 BAD", ""].join("\n");
const read = () => fs.readFileSync(path.join(dir, TEST), "utf8");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "percause-"));
  fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST), START);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Each line "test-XN BAD" is a failing test of cause X; the cause is in the error line, the way a runner prints it. */
const run = async () => {
  const bad = [...read().matchAll(/^(test-([ABC]\d)) BAD$/gm)];
  if (bad.length === 0) return { ok: true, output: "Tests: 6 passed, 6 total" };
  const blocks = bad.map((m) => `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`);
  return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${6 - bad.length} passed, 6 total` };
};
const fix = (...ids: string[]) => ids.map((id) => ({ find: `test-${id} BAD`, replace: `test-${id} OK` }));
const answer = (o: object) => JSON.stringify(o);
const park = (kind: "unsure" | "code" = "unsure", reason = "could not settle it") => answer({ verdict: "park", kind, reason });
const edits = (...ids: string[]) => answer({ verdict: "stale-test", reason: `fixes ${ids.join(",")}`, edits: fix(...ids) });
/** A model whose replies are given in order, and that records what it was shown. */
const model = (...replies: string[]) => {
  const shown: string[] = [];
  const call: HealCall = async (messages) => {
    shown.push(messages[messages.length - 1].content);
    return replies[Math.min(shown.length - 1, replies.length - 1)];
  };
  return { call, shown, count: () => shown.length };
};
const heal = (call: HealCall, escalate?: HealCall, log?: (l: string) => void) => healTests({ repoRoot: dir, run, call, escalate, settle: false, log });

describe("one cause at a time", () => {
  test("the first prompt points at the biggest cause and says to park what cannot be settled", async () => {
    const m = model(edits("A1", "A2", "A3", "B1", "B2", "C1"));
    await heal(m.call);
    const firstUser = m.shown[0];
    assert.match(firstUser, /FOCUS: work on ONE cause at a time\./);
    assert.match(firstUser, /Now: \[3×\] Error: cause A broke/);
    assert.match(firstUser, /Still to come after this one: 2 more causes\./);
    assert.match(firstUser, /park it with \{"verdict":"park"/);
  });
  test("after edits that fix a cause, the next prompt says what is fixed and points at the next cause", async () => {
    const m = model(edits("A1", "A2", "A3"), park());
    await heal(m.call);
    const second = m.shown[1];
    assert.match(second, /ALREADY FIXED/);
    assert.match(second, /\[3× fixed\] Error: cause A broke/);
    assert.match(second, /Now: \[2×\] Error: cause B broke/);
  });
  test("parking a cause moves on to the next, and what was fixed stays fixed", async () => {
    const m = model(edits("A1", "A2", "A3"), park("unsure", "B needs the reducer"), edits("C1"));
    const report = await heal(m.call);
    assert.match(m.shown[2], /Parked: \[2×\] Error: cause B broke\./);
    assert.match(m.shown[2], /Now: \[1×\] Error: cause C broke/);
    assert.match(m.shown[2], /PARKED \(leave these for now\):\n {2}- \[2×\] Error: cause B broke — B needs the reducer/);
    // Everything but the parked cause is fixed and kept; with nobody to hand B to, it is reported as it is.
    const r = report.results[0];
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true);
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD\ntest-B2 BAD\ntest-C1 OK\n");
    assert.match(r.note, /1 cause could not be settled: \[2×\] Error: cause B broke — B needs the reducer\./);
    assert.match(r.note, /fixes it had already made were KEPT \(6 failing at the start, 2 now/);
  });
  test("lookups that learn nothing park the cause it was on instead of ending the whole file", async () => {
    const nothing = answer({ need: [{ search: "zzz-no-match-for-this" }] });
    // two empty lookups on cause A park it; then it fixes B and C
    const m = model(nothing, nothing, edits("B1", "B2"), edits("C1"));
    const report = await heal(m.call);
    assert.match(m.shown.join("\n"), /Parked: \[3×\] Error: cause A broke\./);
    assert.equal(read(), "test-A1 BAD\ntest-A2 BAD\ntest-A3 BAD\ntest-B1 OK\ntest-B2 OK\ntest-C1 OK\n", "the easy causes were not starved by the one it could not look into");
    assert.equal(report.results[0].partial, true);
  });
  test("when nothing is left to park the old rule still ends it, keeping what it fixed", async () => {
    fs.writeFileSync(path.join(dir, TEST), "test-A1 BAD\ntest-A2 BAD\n");
    const nothing = answer({ need: [{ search: "zzz-no-match-for-this" }] });
    const report = await heal(model(nothing, nothing).call);
    assert.equal(report.results[0].status, "unclear");
    assert.equal(read(), "test-A1 BAD\ntest-A2 BAD\n");
  });
  test("a cause the worker is sure is the app's is handed on as a code defect, with what was fixed kept", async () => {
    const report = await heal(model(edits("A1", "A2", "A3", "B1", "B2"), park("code", "src/x.ts:1 returns the wrong label")).call);
    const r = report.results[0];
    assert.equal(r.status, "code-bug");
    assert.equal(r.partial, true);
    assert.match(r.note, /Error: cause C broke — src\/x\.ts:1 returns the wrong label/);
    assert.match(read(), /^test-A1 OK\n/);
    assert.match(renderHealReport(report), /Part test, part code/);
  });
});

describe("what the first model could not settle goes to the stronger one, which is told what is fixed", () => {
  test("the stronger model gets a fresh conversation that starts with the ledger and the parked causes, and finishes the job", async () => {
    const logs: string[] = [];
    const cheap = model(edits("A1", "A2", "A3"), park("unsure", "B needs the reducer"), edits("C1"));
    const strong = model(edits("B1", "B2"));
    const report = await heal(cheap.call, strong.call, (l) => logs.push(l));
    assert.equal(report.results[0].status, "healed");
    assert.equal(read(), "test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 OK\ntest-B2 OK\ntest-C1 OK\n");
    assert.equal(cheap.count(), 3);
    assert.equal(strong.count(), 1);
    const handoff = strong.shown[0];
    assert.match(handoff, /HANDOFF\. A first model already worked on this file/);
    assert.match(handoff, /ALREADY FIXED \(these STAY fixed[^\n]*\):\n {2}- \[3× fixed\] Error: cause A broke[^\n]*\n {2}- \[1× fixed\] Error: cause C broke/);
    assert.match(handoff, /THE FIRST MODEL COULD NOT SETTLE THESE[^\n]*:\n {2}- \[2×\] Error: cause B broke — B needs the reducer/);
    assert.match(handoff, /Now: \[2×\] Error: cause B broke/);
    assert.ok(logs.some((l) => /↗ __tests__\/p\.test\.ts: 1 cause the first model could not settle go to the stronger model/.test(l)));
  });
  test("the stronger model sees the file as the first model left it, not the original", async () => {
    const cheap = model(edits("A1", "A2", "A3"), park(), edits("C1"));
    const strong = model(edits("B1", "B2"));
    await heal(cheap.call, strong.call);
    // the file section of the hand-off (before the failure) is the first model's result; the ledger line may quote what it changed
    const fileSection = strong.shown[0].slice(0, strong.shown[0].indexOf("FAILURE (this file run on its own, as it is NOW)"));
    assert.match(fileSection, /test-A1 OK/);
    assert.doesNotMatch(fileSection, /test-A1 BAD/);
  });
  test("it cannot go backwards: an edit that fixes its cause but breaks a test that passed is undone, even though the count FALLS", async () => {
    const cheap = model(edits("A1", "A2", "A3"), park(), edits("C1"));
    // fixes B (2 tests) and breaks A1 (1 test): 2 failing before, 1 after, so the count alone would accept it
    const bad = answer({ verdict: "stale-test", reason: "B, and a little more", edits: [...fix("B1", "B2"), { find: "test-A1 OK", replace: "test-A1 BAD" }] });
    const strong = model(bad, edits("B1", "B2"));
    const report = await heal(cheap.call, strong.call);
    // It says what the patch DID fix as well as what it broke, and that the broken test was fixed earlier: keep both green.
    assert.match(strong.shown[1], /Your patch fixed test-B1 \| test-B2, but BROKE 1 test\(s\) that already passed \(fixed earlier\): test-A1\. Keep both green: fix your cause without breaking them\. It was undone/);
    assert.equal(report.results[0].status, "healed");
    assert.match(read(), /^test-A1 OK\n/, "A stayed fixed");
  });
  test("the stronger model can park too, and what is left is reported with what both fixed kept", async () => {
    const cheap = model(edits("A1", "A2", "A3"), park(), edits("C1"));
    const strong = model(park("unsure", "even the stronger model cannot tell"));
    const r = (await heal(cheap.call, strong.call)).results[0];
    assert.equal(r.status, "unclear");
    assert.equal(r.partial, true);
    assert.match(r.note, /even the stronger model cannot tell/);
    assert.match(read(), /^test-A1 OK\ntest-A2 OK\ntest-A3 OK\ntest-B1 BAD/);
  });
  test("with nothing parked the stronger model is never called", async () => {
    const strong = model(edits("A1"));
    await heal(model(edits("A1", "A2", "A3", "B1", "B2", "C1")).call, strong.call);
    assert.equal(strong.count(), 0);
  });
});

describe("the per-test ratchet", () => {
  test("failing tests are read from the runner's own lines, ignoring console blocks", () => {
    assert.deepEqual(failingNames("FAIL x\n  ● Card › renders the title\n  ● Console\n    log\n  ● Card › sends\n  ● Card › renders the title\n"), ["Card › renders the title", "Card › sends"]);
  });
  test("a test that passed and now fails is a regression; one that was already failing is not", () => {
    const before = "  ● Suite › test-one\n  ● Suite › test-two\n";
    const after = "  ● Suite › test-two\n  ● Suite › test-three\n";
    assert.deepEqual(regressions(before, after, "test-one test-two test-three", "test-one test-two test-three"), ["Suite › test-three"]);
  });
  test("a test the edit renamed or removed is not a regression", () => {
    const before = "  ● Suite › test-one\n";
    const after = "  ● Suite › test-one\n  ● Suite › test-renamed\n";
    assert.deepEqual(regressions(before, after, "test-one test-old", "test-one test-renamed-now"), [], "its old title is gone from the file after the edit");
  });
  test("with no names before (the file could not load) there is nothing to compare", () => {
    assert.deepEqual(regressions("Test suite failed to run", "  ● Suite › test-one\n", "a", "a"), []);
  });
});

describe("a trial edit is written ahead, so a kill cannot leave an unjudged edit on disk", () => {
  test("an interrupted trial is undone the next time the file is healed", async () => {
    const best = "test-A1 BAD\n";
    fs.writeFileSync(path.join(dir, TEST), best);
    beginTrial(dir, TEST, best, "test-A1 OK TRIAL\n");
    fs.writeFileSync(path.join(dir, TEST), "test-A1 OK TRIAL\n"); // the trial was written, then the process died
    const seen: string[] = [];
    const logs: string[] = [];
    await healTests({
      repoRoot: dir,
      settle: false,
      log: (l) => logs.push(l),
      run: async () => {
        seen.push(read());
        return { ok: false, output: `FAIL ${TEST}\n  ● test-A1\n    Error: cause A broke\nTests: 1 failed, 1 total` };
      },
      call: async () => answer({ verdict: "unclear", reason: "stop" }),
    });
    // seen[0] is the suite's first look (before this file's worker starts); the worker's own first run, and the file it ends with, are the best state.
    assert.equal(seen[1], best, "the worker's first run saw the best state, not the unjudged trial");
    assert.equal(read(), best);
    assert.ok(logs.some((l) => /an edit that was being tried when an earlier run was interrupted was undone/.test(l)));
  });
  test("a file the person has edited since is never touched", () => {
    fs.writeFileSync(path.join(dir, TEST), "best\n");
    beginTrial(dir, TEST, "best\n", "trial\n");
    fs.writeFileSync(path.join(dir, TEST), "my own edit\n");
    assert.equal(recoverTrial(dir, TEST), false);
    assert.equal(read(), "my own edit\n");
  });
  test("a finished trial leaves no record, and a repeat recovery does nothing", () => {
    fs.writeFileSync(path.join(dir, TEST), "trial\n");
    beginTrial(dir, TEST, "best\n", "trial\n");
    endTrial(dir, TEST);
    assert.equal(recoverTrial(dir, TEST), false);
    assert.equal(read(), "trial\n");
  });
});

describe("what the stronger model is handed about the first model's work", () => {
  test("the passing counts, the first model's own edits with their reasons, and the rule about not undoing them", async () => {
    const cheap = model(edits("A1", "A2", "A3"), park("unsure", "B needs the reducer"), edits("C1"));
    const strong = model(edits("B1", "B2"));
    await heal(cheap.call, strong.call);
    const h = strong.shown[0];
    assert.match(h, /It brought the passing tests from 0 to 4\./, "6 tests, all failing at the start; 2 still failing after the first model");
    assert.match(h, /Do not revert or undo its changes unless one of its workarounds directly conflicts with the true root-cause fix for a parked cause, and every test that passes now must stay green/);
    assert.match(h, /ITS CHANGES \(already in the file above\):\n {2}1\. fixes A1,A2,A3\n {7}"test-A1 BAD" → "test-A1 OK"/);
    assert.match(h, /\n {2}2\. fixes C1\n {7}"test-C1 BAD" → "test-C1 OK"/);
  });
  test("a batch with many edits is cut short in the hand-off (the file above holds them all), not allowed to swamp the prompt", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `A${i + 1}`);
    fs.writeFileSync(path.join(dir, TEST), [...ids.map((id) => `test-${id} BAD`), "test-C1 BAD", ""].join("\n"));
    const runMany = async () => {
      const bad = [...read().matchAll(/^(test-([AC]\d+)) BAD$/gm)];
      if (bad.length === 0) return { ok: true, output: "Tests: 10 passed, 10 total" };
      const blocks = bad.map((m) => `  ● ${m[1]}\n    Error: cause ${m[2][0]} broke\n      at src/x.ts:1:1\n`);
      return { ok: false, output: `FAIL ${TEST}\n${blocks.join("\n")}\nTests:       ${bad.length} failed, ${10 - bad.length} passed, 10 total` };
    };
    // the first model fixes all nine A tests in ONE batch (nine edits), then parks C
    const cheap = model(answer({ verdict: "stale-test", reason: "all of A", edits: fix(...ids) }), park("unsure", "C is hard"));
    const strong = model(edits("C1"));
    await healTests({ repoRoot: dir, run: runMany, call: cheap.call, escalate: strong.call, settle: false });
    const h = strong.shown[0];
    assert.match(h, /ITS CHANGES \(already in the file above\):\n {2}1\. all of A\n/);
    assert.match(h, /… and 3 more edits in this batch/, "six of the nine are listed, the rest are counted");
    const changes = h.slice(h.indexOf("ITS CHANGES (already in the file above):"), h.indexOf("THE FIRST MODEL COULD NOT SETTLE"));
    assert.equal((changes.match(/→ "test-A\d+ OK"/g) ?? []).length, 6);
    assert.match(h, /It brought the passing tests from 0 to 9\./);
  });
});
