import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { terminalView, setVerbose, isVerbose } from "../src/consoleView.js";

afterEach(() => setVerbose(false));
const hidden = (s: string) => terminalView("log", [s]) === null;

describe("routine bookkeeping is not drawn on the terminal", () => {
  test("a model call that succeeded is hidden; a failed, retried or slow one is shown", () => {
    assert.ok(hidden("[API] openai/gpt-6-luna (REPAIR_PLANNER) ✔ (2.3s)"));
    assert.ok(hidden("\r\x1b[K[API] deepseek/deepseek-v4-flash-0731 (REPAIR) ✔ (6.2s)"));
    assert.ok(!hidden("[API] deepseek/x (EDITOR) (retry 2/3) ✔ (4.0s)"), "a call that needed a retry is worth seeing");
    assert.ok(!hidden("[API] deepseek/x (EDITOR) ❌ (30.1s)"));
    assert.ok(!hidden("[API] Still waiting on deepseek/x (EDITOR) — 60s elapsed"));
  });
  test("files read, searches, memory saves, the environment report and passing gates are hidden", () => {
    for (const l of [
      "[REPAIR] Read file: src/models/timeline.ts (lines 500-570) → 72 lines",
      "[REPAIR_PLANNER] 🔎 Reading discovery target: src/models/timeline.ts...",
      "[REPAIR_PLANNER] 🔎 Bounded inspection: up to 5 file(s) of 1 discovery target(s) — src/models/timeline.ts",
      '[REPAIR] Searched code with pattern: "workerTypeFor" → 19 matches',
      "[MEMORY] 💾 Updated persistent self-improving memory: /repo/.agent/codebase-memory.json",
      "[QA] Project profile:\n  stacks: react-native\n[QA] Environment capabilities:\n  ✓ git",
      "[QA] Running build gate: npm run typecheck",
      "[QA GATE] ✓ npm run typecheck — completed with exit code 0",
      "[QA ADVISORY] ✓ change set — 2 modified, 0 added, 0 deleted, 0 renamed\n  src/a.ts",
      '[COST] "1/5 Classify": 0 tokens across 0 model calls so far.',
    ]) assert.ok(hidden(l), l);
  });
  test("what went wrong or needs a person stays: failed gates, the verdict, repairs, costs of a job, questions", () => {
    for (const l of [
      "[QA GATE] ✗ main test suite kept current — 1 changed file(s) have a permanent test that was not updated",
      "⚠️ [HARD VERIFICATION FAILURE]",
      "[REPAIR LOOP] Triggering repair attempt 1 of 10...",
      "[VERIFIER] 🛡️ Running verification for 1/5 Classify (Attempt 1/11)...",
      "Cost of this job: $0.42",
      "[ROADMAP] Starting U001",
    ]) assert.ok(!hidden(l), l);
  });
  test("warnings and errors are never hidden, even when they look routine", () => {
    assert.deepEqual(terminalView("warn", ["[MEMORY] could not save"]), ["[MEMORY] could not save"]);
    assert.deepEqual(terminalView("error", ["[QA GATE] ✓ x"]), ["[QA GATE] ✓ x"]);
  });
  test("a non-string first argument is left alone", () => {
    const o = { a: 1 };
    assert.deepEqual(terminalView("log", [o]), [o]);
  });
});

describe("the verdict keeps what to act on and drops the repeated gate list", () => {
  const verdict =
    "**Verdict: FAIL**  (confidence: partial)\n\n**Evidence collected:**\n  ✓ [static/inspected] change set: 2 modified\n  ✓ [build/executed] npm run typecheck: ok\n  ✗ [static/inspected] main test suite kept current: 1 file\n\n**Blocking defects:**\n  ✗ main test suite kept current: 1 file";
  test("the headline and the blocking defects remain", () => {
    const out = (terminalView("log", [verdict]) as string[])[0];
    assert.match(out, /Verdict: FAIL/);
    assert.match(out, /Blocking defects/);
    assert.match(out, /✗ main test suite kept current: 1 file/);
    assert.doesNotMatch(out, /Evidence collected/);
    assert.doesNotMatch(out, /change set: 2 modified/);
  });
  test("a pass is the headline alone", () => {
    const pass = "**Verdict: PASS**  (confidence: high)\n\n**Evidence collected:**\n  ✓ [build/executed] typecheck: ok";
    assert.equal((terminalView("log", [pass]) as string[])[0], "**Verdict: PASS**  (confidence: high)");
  });
  test("advisories after the list are kept", () => {
    const adv = "**Verdict: PASS**  (confidence: high)\n\n**Evidence collected:**\n  ✓ a: b\n\n**Advisories (human sign-off, not blocking):**\n  ! screenshot: check it";
    const out = (terminalView("log", [adv]) as string[])[0];
    assert.match(out, /Advisories/);
    assert.doesNotMatch(out, /✓ a: b/);
  });
});

describe("verbose shows everything", () => {
  test("turning it on shows the hidden lines and the full verdict", () => {
    setVerbose(true);
    assert.ok(isVerbose());
    assert.deepEqual(terminalView("log", ["[MEMORY] x"]), ["[MEMORY] x"]);
    const v = "**Verdict: PASS**\n\n**Evidence collected:**\n  ✓ a: b";
    assert.deepEqual(terminalView("log", [v]), [v]);
  });
});
