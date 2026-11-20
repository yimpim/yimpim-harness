/**
 * What the heal worker's answers are held to: an edit to a test must rest on an authority outside the test (and the citation must exist), an
 * app that contradicts its written spec is reported and never "fixed", and an edit that leaves more tests failing is undone.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyCites, citeProblem, testsFailing, madeWorse } from "../src/healAuthority.js";
import { healTests, renderHealReport, type HealCall } from "../src/testHeal.js";

let dir = "";
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8" });
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const TEST = "__tests__/card.test.ts";
let hash = "";
/** A real citation: the spec line, with the words it says. */
const SPEC_CITE = { at: "docs/SPEC.md:5", quote: "BLOCKING questions have a Dismiss button" };
const APP_CITE = { at: "src/Card.tsx:1", quote: "export const dismiss = 'Dismiss'" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "authority-"));
  git("init", "-q");
  write("docs/SPEC.md", "# Spec\n\nline 3\nline 4\nBLOCKING questions have a Dismiss button.\n");
  write("src/Card.tsx", "export const dismiss = 'Dismiss';\nexport const x = 1;\n");
  write(TEST, "expect(label).toBe('Reject');\nexpect(a).toBe(1);\n// MARK\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Rename Reject to Dismiss on the question card");
  hash = git("rev-parse", "--short", "HEAD").trim();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("citations", () => {
  test("a spec line, an app line and a commit all verify, and the test itself is not an authority", () => {
    const c = verifyCites(dir, [`docs/SPEC.md:5 (BLOCKING has Dismiss)`, "src/Card.tsx:1", `${hash} renamed it`], TEST);
    assert.equal(c.bad.length, 0);
    assert.equal(c.authorities, 3);
    const self = verifyCites(dir, [`${TEST}:1`], TEST);
    assert.equal(self.good.length, 1);
    assert.equal(self.authorities, 0, "citing the test being healed proves nothing");
    assert.match(citeProblem(self) ?? "", /at least one authority OUTSIDE the test file/);
  });
  test("a file or line that does not exist, a commit that does not exist, or nothing at all is refused, with why", () => {
    const c = verifyCites(dir, ["docs/NOPE.md:3", "docs/SPEC.md:999", "deadbee1234 changed it", "just words"], TEST);
    assert.equal(c.authorities, 0);
    assert.equal(c.bad.length, 4);
    const text = citeProblem(c) ?? "";
    assert.match(text, /docs\/NOPE\.md does not exist/);
    assert.match(text, /docs\/SPEC\.md has no line 999/);
    assert.match(text, /deadbee1234 is not a commit/);
    assert.match(citeProblem(verifyCites(dir, undefined, TEST)) ?? "", /must give "cites"/);
  });
  test("one good authority with a bad one next to it is still refused, so nothing unverified rides along", () => {
    const c = verifyCites(dir, ["docs/SPEC.md:5", "docs/NOPE.md:1"], TEST);
    assert.equal(c.authorities, 1);
    assert.match(citeProblem(c) ?? "", /could not be verified/);
  });
  test("with the quote requirement a place alone proves nothing: the exact words next to it do", () => {
    const req = { requireQuote: true };
    assert.equal(verifyCites(dir, [SPEC_CITE], TEST, req).authorities, 1);
    assert.equal(verifyCites(dir, [SPEC_CITE], TEST, req).bad.length, 0);
    const bare = verifyCites(dir, ["docs/SPEC.md:5"], TEST, req);
    assert.equal(bare.authorities, 0);
    assert.match(bare.bad[0], /exists, but no words were quoted/);
    assert.equal(verifyCites(dir, ["docs/SPEC.md:5"], TEST).authorities, 1, "callers that did not ask for quotes behave as before");
    // case, spacing and markdown emphasis are not a different quote
    assert.equal(verifyCites(dir, [{ at: "docs/SPEC.md:5", quote: "**blocking**   questions have a DISMISS button" }], TEST, req).authorities, 1);
  });
  test("the right words at the wrong place are refused, and the worker is told where they really are (a real run cited the Home screen for a rule 70 lines away)", () => {
    const c = verifyCites(dir, [{ at: "docs/SPEC.md:1", quote: "BLOCKING questions have a Dismiss button" }], TEST, { requireQuote: true });
    assert.equal(c.authorities, 0);
    assert.match(c.bad[0], /those words are not at line 1; they are at line 5/);
  });
  test("words that are not in the file, or too few to prove anything, are refused", () => {
    const req = { requireQuote: true };
    assert.match(verifyCites(dir, [{ at: "docs/SPEC.md:5", quote: "APPROVAL cards have a Reject button" }], TEST, req).bad[0], /those words do not appear in that file/);
    assert.match(verifyCites(dir, [{ at: "docs/SPEC.md:5", quote: "Dismiss" }], TEST, req).bad[0], /too short to prove anything/);
  });
  test("a commit hash needs no quote, and a quote on a commit is not required", () => {
    assert.equal(verifyCites(dir, [hash], TEST, { requireQuote: true }).authorities, 1);
  });
  test("a quote in the test file itself is still not an authority", () => {
    assert.equal(verifyCites(dir, [{ at: `${TEST}:1`, quote: "expect(label).toBe('Reject')" }], TEST, { requireQuote: true }).authorities, 0);
  });
  test("a path outside the project is never a citation", () => {
    assert.equal(verifyCites(dir, ["../../etc/hosts:1"], TEST).authorities, 0);
  });
});

describe("the failing count", () => {
  test("it is read from the runner's own summary line", () => {
    assert.equal(testsFailing("Tests:       34 failed, 130 passed, 164 total"), 34);
    assert.equal(testsFailing("\u001b[1mTests:\u001b[22m 3 passed, 3 total"), 0);
    assert.equal(testsFailing(" Tests  3 failed | 10 passed (13)"), 3);
    assert.equal(testsFailing("Test suite failed to run\n  Cannot find module"), undefined);
  });
  test("more failing, or a file that stops running, is worse; a file that could not load before is not judged", () => {
    assert.equal(madeWorse("Tests: 2 failed, 5 total", "Tests: 3 failed, 5 total").worse, true);
    assert.equal(madeWorse("Tests: 2 failed, 5 total", "Tests: 1 failed, 5 total").worse, false);
    assert.equal(madeWorse("Tests: 2 failed, 5 total", "Tests: 2 failed, 5 total").worse, false);
    assert.equal(madeWorse("Tests: 2 failed, 5 total", "Test suite failed to run").worse, true);
    assert.equal(madeWorse("Test suite failed to run", "Tests: 30 failed, 40 total").worse, false, "fixing a load error reveals failures: that is progress");
  });
});

/** A runner whose output follows the file: MARK count decides how many tests fail. */
const runner = (fn: (text: string) => number) => async (root: string) => {
  const failed = fn(fs.readFileSync(path.join(root, TEST), "utf8"));
  return failed === 0
    ? { ok: true, output: "Tests: 5 passed, 5 total" }
    : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom\n      at src/Card.tsx:1:1\nTests:       ${failed} failed, ${5 - failed} passed, 5 total` };
};
const sequence = (...replies: object[]): HealCall => {
  let n = 0;
  return async () => JSON.stringify(replies[Math.min(n++, replies.length - 1)]);
};
const heal = (call: HealCall, run: any, requireCites = true) => healTests({ repoRoot: dir, run, call, settle: false, requireCites });

describe("an edit must rest on an authority", () => {
  const fix = { find: "expect(label).toBe('Reject');", replace: "expect(label).toBe('Dismiss');" };
  const failsWhileReject = runner((t) => (t.includes("'Reject'") ? 2 : 0));

  test("with no citation it is not applied, the worker is told why, and a good citation then goes through", async () => {
    const sent: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      sent.push(messages[messages.length - 1].content);
      return JSON.stringify(++n === 1 ? { verdict: "stale-test", reason: "label renamed", edits: [fix] } : { verdict: "stale-test", reason: "label renamed", cites: [SPEC_CITE, hash], edits: [fix] });
    };
    const r = (await heal(call, failsWhileReject)).results[0];
    assert.equal(r.status, "healed");
    assert.match(sent[1], /Not applied: every answer that changes the test, calls the code wrong, or says the app differs from its spec must give "cites"/);
    assert.match(read(TEST), /toBe\('Dismiss'\)/);
  });
  test("a citation that does not exist is refused, and the same refusal twice ends it with the file untouched", async () => {
    const before = read(TEST);
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", cites: ["docs/NOPE.md:1"], edits: [fix] }), failsWhileReject)).results[0];
    assert.equal(r.status, "unhealed");
    assert.match(r.note, /rested on no authority outside the test that could be verified/);
    assert.equal(read(TEST), before);
  });
  test("it is only asked for when the caller asks: the same answer with no citation is applied otherwise", async () => {
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", edits: [fix] }), failsWhileReject, false)).results[0];
    assert.equal(r.status, "healed");
  });
});

describe("a claim that the code is wrong must be backed too", () => {
  const run = runner(() => 2);
  test("a code-bug verdict with no verified citation is not accepted: it would send a fix task to change product code on a guess", async () => {
    const sent: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      sent.push(messages[messages.length - 1].content);
      return JSON.stringify(++n === 1 ? { verdict: "code-bug", reason: "src/Card.tsx:1 is wrong" } : { verdict: "code-bug", reason: "src/Card.tsx:1 is wrong", cites: [APP_CITE, SPEC_CITE] });
    };
    const r = (await heal(call, run)).results[0];
    assert.equal(r.status, "code-bug");
    assert.match(sent[1], /Not applied: every answer that changes the test, calls the code wrong, or says the app differs from its spec must give "cites"/);
  });
  test("citing real lines that do not say what the worker claims is refused with where the words really are", async () => {
    const sent: string[] = [];
    let n = 0;
    const call: HealCall = async (messages) => {
      sent.push(messages[messages.length - 1].content);
      return JSON.stringify(++n === 1 ? { verdict: "code-bug", reason: "r", cites: [{ at: "docs/SPEC.md:1", quote: "BLOCKING questions have a Dismiss button" }] } : { verdict: "code-bug", reason: "r", cites: [SPEC_CITE] });
    };
    await heal(call, run);
    assert.match(sent[1], /those words are not at line 1; they are at line 5/);
  });
  test("without the requirement (other callers) a code-bug answer needs no citation", async () => {
    const r = (await heal(sequence({ verdict: "code-bug", reason: "r" }), run, false)).results[0];
    assert.equal(r.status, "code-bug");
  });
});

describe("the app differs from its spec", () => {
  const failsAlways = runner(() => 2);
  const deviation = { verdict: "app-deviation", reason: "The spec says BLOCKING cards have Dismiss, but the approval card shows Dismiss where it says Reject.", cites: [SPEC_CITE, APP_CITE] };

  test("nothing is changed, it is not a code bug, and the report says it is for a person to decide", async () => {
    const before = read(TEST);
    const report = await heal(sequence(deviation), failsAlways);
    const r = report.results[0];
    assert.equal(r.status, "app-deviation");
    assert.equal(read(TEST), before);
    const text = renderHealReport(report);
    assert.match(text, /1 where the app differs from its spec/);
    assert.match(text, /The APP differs from its written spec here \(nothing was changed or queued: you decide which is right\)/);
    assert.doesNotMatch(text, /The CODE is wrong here/);
    assert.match(text, /approval card/);
  });
  test("it needs a real citation like any other answer", async () => {
    const r = (await heal(sequence({ verdict: "app-deviation", reason: "r", cites: ["nothing.md:1"] }), failsAlways)).results[0];
    assert.equal(r.status, "unhealed");
  });
  test("it earns no strike and is remembered like a diagnosis, so the same finding is not paid for twice", async () => {
    await heal(sequence(deviation), failsAlways);
    const log = JSON.parse(read(".agent/test-log.json"));
    assert.equal(log.files[TEST]?.healStrikes, undefined);
    assert.equal(log.files[TEST]?.verdict?.status, "app-deviation");
    let called = 0;
    const again = await healTests({ repoRoot: dir, run: failsAlways, call: async () => { called++; return "{}"; }, settle: false, requireCites: true });
    assert.equal(called, 0, "the stored finding was reused");
    assert.equal(again.results[0].status, "app-deviation");
  });
  test("a part-test, part-spec answer fixes the test side and lists the deviation without queueing anything for it", async () => {
    const fix = { find: "expect(label).toBe('Reject');", replace: "expect(label).toBe('Dismiss');" };
    const mixed = { verdict: "mixed", reason: "label renamed", cites: [SPEC_CITE], edits: [fix], codeBugs: [], appDeviations: ["The spec says approvals have Reject, the app shows Dismiss (src/Card.tsx:1)"] };
    const run = runner((t) => (t.includes("'Reject'") ? 2 : 0));
    const report = await heal(sequence(mixed), run);
    assert.equal(report.results[0].status, "healed");
    assert.deepEqual(report.results[0].deviations, ["The spec says approvals have Reject, the app shows Dismiss (src/Card.tsx:1)"]);
    assert.match(renderHealReport(report), /The APP differs from its written spec here/);
  });
});

describe("an edit that makes it worse is undone", () => {
  const cites = [SPEC_CITE];
  test("more failing after the edit puts the file back, tells the worker, and the next edit starts from the undone file", async () => {
    const messagesSeen: string[] = [];
    let n = 0;
    // 2 failing now. The first edit adds a MARK (makes 4 fail); the second removes 'Reject' (fixes it).
    const run = runner((t) => (t.includes("'Reject'") ? (t.includes("BAD") ? 4 : 2) : 0));
    const call: HealCall = async (messages) => {
      messagesSeen.push(messages[messages.length - 1].content);
      n++;
      if (n === 1) return JSON.stringify({ verdict: "stale-test", reason: "r", cites, edits: [{ find: "// MARK", replace: "// MARK BAD" }] });
      return JSON.stringify({ verdict: "stale-test", reason: "r", cites, edits: [{ find: "expect(label).toBe('Reject');", replace: "expect(label).toBe('Dismiss');" }] });
    };
    const r = (await heal(call, run)).results[0];
    assert.match(messagesSeen[1], /That change made it WORSE: 2 test\(s\) failing before, 4 after\. It was undone/);
    assert.equal(r.status, "healed");
    assert.doesNotMatch(read(TEST), /BAD/, "the worse edit is not in the file that was healed");
  });
  test("the same worse change twice ends it with the file as it was", async () => {
    const before = read(TEST);
    const run = runner((t) => (t.includes("BAD") ? 4 : 2));
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", cites, edits: [{ find: "// MARK", replace: "// MARK BAD" }] }), run)).results[0];
    assert.equal(r.status, "unhealed");
    assert.match(r.note, /made more tests fail again/);
    assert.equal(read(TEST), before);
  });
  test("an edit that breaks the file so it no longer runs is undone", async () => {
    const run = async (root: string) => {
      const t = fs.readFileSync(path.join(root, TEST), "utf8");
      return t.includes("BROKEN")
        ? { ok: false, output: "Test suite failed to run\n  SyntaxError: unexpected token" }
        : { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom\nTests:       2 failed, 3 passed, 5 total` };
    };
    const r = (await heal(sequence({ verdict: "stale-test", reason: "r", cites, edits: [{ find: "// MARK", replace: "BROKEN((" }] }), run)).results[0];
    assert.notEqual(r.status, "healed");
    assert.doesNotMatch(read(TEST), /BROKEN/);
  });
  test("fixing a file that could not load is progress even though it reveals failures", async () => {
    const run = async (root: string) => {
      const t = fs.readFileSync(path.join(root, TEST), "utf8");
      return t.includes("FIXED-LOAD")
        ? { ok: false, output: `FAIL ${TEST}\n  ● t\n    Error: boom\nTests:       20 failed, 30 passed, 50 total` }
        : { ok: false, output: "FAIL __tests__/card.test.ts\nTest suite failed to run\n  Cannot find module '../src/missing'" };
    };
    let n = 0;
    const call: HealCall = async () =>
      JSON.stringify(++n === 1 ? { verdict: "stale-test", reason: "r", cites, edits: [{ find: "// MARK", replace: "// FIXED-LOAD" }] } : { verdict: "code-bug", reason: "src/Card.tsx:1 wrong", cites: [APP_CITE, SPEC_CITE] });
    const r = (await heal(call, run)).results[0];
    assert.equal(r.status, "code-bug", "the load fix was kept and judged by what it revealed, not undone");
    assert.equal(r.partial, true);
    assert.match(read(TEST), /FIXED-LOAD/);
  });
});

describe("the wiring", () => {
  const read2 = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("real heal runs do NOT require citations (it stopped the worker from answering), and hand parked causes to the stronger model", () => {
    const idx = read2("../src/index.ts");
    const ver = read2("../src/verifierTools.ts");
    assert.ok(!idx.includes("requireCites: true"));
    assert.ok(!ver.includes("requireCites: true"));
    assert.ok(idx.includes("escalate:") && idx.includes("healModels.slice(1)"));
    assert.ok(ver.includes("files: retry, call, escalate,") && ver.includes("models.slice(1)"));
  });
  test("the worker is told the order of authority and the new verdict", () => {
    const t = read2("../src/testHeal.ts");
    assert.ok(t.includes("Who is RIGHT is decided by the strongest authority, in this order: (1) the written spec"));
    assert.ok(t.includes('{"verdict":"app-deviation"'));
    assert.ok(t.includes('you may name it with "cites"') && t.includes("never a reason to hold back an answer you are confident in"), "citations are optional");
    assert.ok(!t.includes('"cites" is REQUIRED'));
    assert.ok(t.includes('{"verdict":"park"') && t.includes("You are pointed at ONE cause at a time"));
    assert.ok(t.includes("A TEST HELPER that calls a handler directly"), "the lesson from the hand repair: a faulty helper is not a faulty app");
  });
  test("an app-deviation is never queued as a code defect for the fix task", () => {
    assert.ok(read2("../src/index.ts").includes('report.results.filter((r) => r.status === "code-bug")'));
  });
});
