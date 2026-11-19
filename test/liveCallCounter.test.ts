/**
 * The status line counts the STEP (a heal, a repair, a phase's editor): total time and total tokens, which only go up, across every call
 * and every file. A per-call timer reset with each call and jumped when the oldest of several ended. The one per-call signal kept is
 * silence, since a total that has stopped climbing while time passes is a model that has gone quiet.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  trackCall,
  describeTotals,
  describeLiveCalls,
  composeStatus,
  resetStep,
  enterStep,
  stepActive,
  liveCallCount,
  estimateTokens,
  formatTokens,
  formatElapsed,
  QUIET_AFTER_SECS,
} from "../src/liveCalls.js";

const T0 = 1_000_000;
afterEach(() => resetStep());

describe("the total time", () => {
  test("starts with the step's first call and only counts up", () => {
    const end = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.match(describeTotals(T0) as string, /^0s · waiting/);
      assert.match(describeTotals(T0 + 59_000) as string, /^59s ·/);
      assert.match(describeTotals(T0 + 60_000) as string, /^1m 00s ·/);
      assert.match(describeTotals(T0 + 121_000) as string, /^2m 01s ·/);
    } finally {
      end();
    }
  });
  test("does not reset when a call ends and the next one starts", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    a.done(100);
    const b = trackCall("REPAIR", "deepseek/x", T0 + 90_000);
    try {
      assert.match(describeTotals(T0 + 95_000) as string, /^1m 35s · ↓ ~100 tokens/, "counted from the first call, with the first call's tokens kept");
    } finally {
      b();
    }
  });
  test("does not jump when the oldest of several calls ends", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    const b = trackCall("REPAIR", "deepseek/x", T0 + 60_000);
    const before = describeTotals(T0 + 90_000) as string;
    a();
    const after = describeTotals(T0 + 90_000) as string;
    try {
      assert.match(before, /^1m 30s/);
      assert.match(after, /^1m 30s/, "a younger call taking over does not make the clock go back");
    } finally {
      b();
    }
  });
  test("keeps counting between calls, while a test file runs or a decision is made", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    a.done(300);
    assert.equal(liveCallCount(), 0);
    assert.equal(stepActive(), true);
    assert.match(describeTotals(T0 + 20_000) as string, /^20s · ↓ ~300 tokens/);
  });
  test("starts again only when the task is over", () => {
    trackCall("REPAIR", "deepseek/x", T0).done(300);
    resetStep();
    assert.equal(stepActive(), false);
    assert.equal(describeTotals(T0 + 51_000), undefined);
    const b = trackCall("REPAIR", "deepseek/x", T0 + 60_000);
    try {
      assert.match(describeTotals(T0 + 61_000) as string, /^1s · waiting/);
    } finally {
      b();
    }
  });
  test("the end of the task clears the totals, even with a call still in flight", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    try {
      resetStep();
      assert.equal(describeTotals(T0 + 40_000), undefined);
    } finally {
      a();
    }
  });
});

describe("the totals are kept across attempts, for the whole task", () => {
  const LABEL = "Add DESIGNER and SECURITY · REPAIR";

  test("the time is summed over every stretch the persona ran, and not counted while something else ran", () => {
    enterStep(LABEL, T0); // repair attempt 1
    enterStep(undefined, T0 + 60_000); // 1m 00s of repair, then the verifier runs
    enterStep(LABEL, T0 + 150_000); // repair attempt 2, after 1m 30s of something else
    assert.match(describeTotals(T0 + 180_000) as string, /^1m 30s/, "60s + 30s, not 3m");
  });
  test("it does not go back to zero when an attempt ends and the next begins: the case that kept resetting", () => {
    enterStep(LABEL, T0);
    const a = trackCall("REPAIR", "deepseek/x", T0 + 1000);
    a.progress(8000, T0 + 2000);
    a.done(2100);
    enterStep(undefined, T0 + 30_000); // attempt 1 ends
    enterStep(LABEL, T0 + 40_000); // attempt 2 begins
    const line = describeTotals(T0 + 50_000) as string;
    assert.match(line, /^40s/, "30s + 10s");
    assert.match(line, /↓ ~2\.1k tokens/, "the tokens of attempt 1 are still counted");
  });
  test("tokens from a second attempt are added to the first's", () => {
    enterStep(LABEL, T0);
    trackCall("REPAIR", "deepseek/x", T0).done(1000);
    enterStep(undefined, T0 + 5000);
    enterStep(LABEL, T0 + 9000);
    trackCall("REPAIR", "deepseek/x", T0 + 9000).done(500);
    assert.match(describeTotals(T0 + 10_000) as string, /↓ ~1\.5k tokens/);
  });
  test("each persona keeps its own totals, and they are not mixed", () => {
    enterStep("Phase 2 · EDITOR", T0);
    trackCall("EDITOR", "x/m", T0).done(4000);
    enterStep("Phase 2 · REPAIR", T0 + 20_000);
    trackCall("REPAIR", "x/m", T0 + 20_000).done(300);
    assert.match(describeTotals(T0 + 25_000) as string, /^5s · ↓ ~300 tokens/, "the repair's own");
    enterStep("Phase 2 · EDITOR", T0 + 30_000);
    assert.match(describeTotals(T0 + 31_000) as string, /^21s · ↓ ~4\.0k tokens/, "the editor's, where it left off, plus the time since");
  });
  test("paused between attempts, it keeps what it had and the line has nothing to show", () => {
    enterStep(LABEL, T0);
    trackCall("REPAIR", "x/m", T0).done(900);
    enterStep(undefined, T0 + 10_000);
    assert.equal(describeTotals(T0 + 20_000), undefined);
    assert.equal(stepActive(), false, "nothing is running, so the status line is not being redrawn");
  });
  test("with no persona running, a call still gets totals", () => {
    const a = trackCall("REPAIR", "x/m", T0);
    try {
      assert.equal(stepActive(), true);
      assert.match(describeTotals(T0 + 3000) as string, /^3s · waiting/);
    } finally {
      a();
    }
  });
  test("between calls it does not say 'waiting': nothing is out", () => {
    enterStep(LABEL, T0);
    assert.equal(describeTotals(T0 + 4000), "4s");
  });
  test("a new task starts from nothing", () => {
    enterStep(LABEL, T0);
    trackCall("REPAIR", "x/m", T0).done(900);
    resetStep();
    enterStep(LABEL, T0 + 100_000);
    assert.equal(describeTotals(T0 + 101_000), "1s");
  });
});

describe("the total tokens", () => {
  test("are an estimate while a call runs, and the sum over every call in flight", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    const b = trackCall("REPAIR", "deepseek/x", T0);
    try {
      a.progress(4000, T0 + 1000);
      b.progress(2000, T0 + 1000);
      assert.match(describeTotals(T0 + 2000) as string, /↓ ~1\.5k tokens/);
    } finally {
      a();
      b();
    }
  });
  test("when a call finishes, the provider's exact count replaces its estimate, and the total does not drop", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    a.progress(4000, T0 + 1000); // estimate: 1000
    assert.match(describeTotals(T0 + 2000) as string, /↓ ~1\.0k tokens/);
    a.done(1180); // exact
    assert.match(describeTotals(T0 + 3000) as string, /↓ ~1\.2k tokens/);
  });
  test("a call that failed still counts what it produced", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    a.progress(8000, T0 + 1000);
    a();
    assert.match(describeTotals(T0 + 2000) as string, /↓ ~2\.0k tokens/);
  });
  test("ending a call twice counts it once", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    a.done(500);
    a.done(500);
    a();
    assert.match(describeTotals(T0 + 1000) as string, /↓ ~500 tokens/);
  });
  test("nothing produced yet says 'waiting'", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.match(describeTotals(T0 + 5000) as string, /waiting/);
    } finally {
      a();
    }
  });
  test("the estimate is four characters to a token, written compactly", () => {
    assert.equal(estimateTokens(4000), 1000);
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(7000), "7.0k");
    assert.equal(formatTokens(1450), "1.5k");
    assert.equal(formatTokens(12_400), "12.4k");
  });
});

describe("silence", () => {
  test("is said only after a while: a model thinking for a few seconds is not a problem", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    try {
      assert.doesNotMatch(describeTotals(T0 + (QUIET_AFTER_SECS - 1) * 1000) as string, /quiet/);
      assert.match(describeTotals(T0 + QUIET_AFTER_SECS * 1000) as string, /quiet 15s$/);
      assert.match(describeTotals(T0 + 75_000) as string, /quiet 1m 15s$/);
    } finally {
      a();
    }
  });
  test("any call producing anything resets it, however many are waiting", () => {
    const a = trackCall("REPAIR", "deepseek/x", T0);
    const b = trackCall("REPAIR", "deepseek/x", T0);
    try {
      b.progress(40, T0 + 50_000);
      assert.doesNotMatch(describeTotals(T0 + 55_000) as string, /quiet/);
      assert.match(describeTotals(T0 + 80_000) as string, /quiet 30s$/);
    } finally {
      a();
      b();
    }
  });
  test("is not said when no call is in flight", () => {
    trackCall("REPAIR", "deepseek/x", T0).done(10);
    assert.doesNotMatch(describeTotals(T0 + 600_000) as string, /quiet/);
  });
});

describe("the status line", () => {
  test("totals, then what is being waited on", () => {
    const a = trackCall("REPAIR", "deepseek/deepseek-v4.1-flash-1017", T0);
    try {
      a.progress(4000, T0 + 1000);
      const line = composeStatus("REPAIR", T0 + 130_000) as string;
      assert.match(line, /^REPAIR running · calling REPAIR · deepseek-v4\.1-flash-1017 · 2m 10s · ↓ ~1\.0k tokens · quiet 2m 09s/);
    } finally {
      a();
    }
  });
  test("between calls the totals stay on screen", () => {
    trackCall("REPAIR", "deepseek/x", T0).done(2000);
    assert.equal(composeStatus("REPAIR", T0 + 30_000), "REPAIR running · 30s · ↓ ~2.0k tokens…");
  });
  test("with no step under way it is the plain line, or nothing", () => {
    assert.equal(composeStatus("REPAIR", T0), "REPAIR running…");
    assert.equal(composeStatus(undefined, T0), undefined);
  });
  test("the personas being waited on are listed", () => {
    const a = trackCall("REPAIR", "x/one", T0);
    const b = trackCall("VERIFIER", "x/two", T0);
    try {
      assert.equal(describeLiveCalls(), "REPAIR, VERIFIER");
    } finally {
      a();
      b();
    }
  });
});

describe("elapsed time", () => {
  test("seconds to 59, then minutes, then hours", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(59), "59s");
    assert.equal(formatElapsed(60), "1m 00s");
    assert.equal(formatElapsed(605), "10m 05s");
    assert.equal(formatElapsed(3725), "1h 02m 05s");
    assert.equal(formatElapsed(-4), "0s");
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("the stream reports its progress, and a finished call hands its exact token count to the step", () => {
    const src = read("../src/openrouter.ts");
    assert.ok(src.includes("endCall.progress"));
    assert.ok(src.includes("endCall.done(usage?.completion);"));
    assert.ok(src.includes("let chars = content.length + reasoning.length + thought.length;"));
  });
  test("a change of persona only hands the line over: its totals are kept, and only the END OF THE TASK clears them", () => {
    const src = read("../src/index.ts");
    assert.ok(src.includes("if (base !== statusBase || (!base && liveCallCount() === 0)) {"));
    // The change of label enters a step (keeps the totals); it must not reset them.
    const at = src.indexOf("if (base !== statusBase || (!base && liveCallCount() === 0)) {");
    assert.ok(src.slice(at, at + 160).includes("enterStep(base);"));
    assert.ok(!src.slice(at, at + 160).includes("resetStep();"), "no reset when the label changes");
    // Cleared in the two places a task ends (finished, and stopped or failed).
    assert.equal(src.split("statusBase = undefined;\n    resetStep();").length - 1 + src.split("statusBase = undefined;\n      resetStep();").length - 1, 2);
    assert.ok(src.includes("if (liveCallCount() > 0 || stepActive()) refreshStatus();"));
  });
});

describe("calls made before the persona's label appears", () => {
  test("join it when it does, so the count does not start again from zero", () => {
    const a = trackCall("REPAIR", "x/m", T0); // no persona yet: counted under a placeholder
    a.progress(8000, T0 + 1000);
    a.done(2000);
    enterStep("REPAIR", T0 + 20_000); // the label shows up
    assert.match(describeTotals(T0 + 25_000) as string, /^25s · ↓ ~2\.0k tokens/, "the 20s and the 2.0k tokens from before the label are kept");
  });
});
