import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideEscape, ESC_GRACE_MS, ESC_CONFIRM_MS } from "../src/terminalInput.js";

const base = { now: 100_000, panelClosedAt: 0, line: "", armedAt: 0 };

describe("Esc closes the picker without also stopping the run", () => {
  test("an Esc right after the picker closed is ignored (a second press, or the same key seen twice)", () => {
    assert.equal(decideEscape({ ...base, panelClosedAt: base.now - 50 }), "ignore");
    assert.equal(decideEscape({ ...base, panelClosedAt: base.now - (ESC_GRACE_MS - 1) }), "ignore");
  });
  test("later than that it is an ordinary Esc again", () => {
    assert.equal(decideEscape({ ...base, panelClosedAt: base.now - ESC_GRACE_MS }), "arm");
  });
});

describe("Esc with something typed clears it and does not stop anything", () => {
  test("a typo in the prompt is cleared", () => {
    assert.equal(decideEscape({ ...base, line: "/models" }), "clear");
  });
  test("even a second press while text is there only clears", () => {
    assert.equal(decideEscape({ ...base, line: "x", armedAt: base.now - 100 }), "clear");
  });
});

describe("stopping a run by Esc takes two presses", () => {
  test("the first only says so", () => {
    assert.equal(decideEscape(base), "arm");
  });
  test("the second, soon after, stops the run", () => {
    assert.equal(decideEscape({ ...base, armedAt: base.now - 500 }), "abort");
    assert.equal(decideEscape({ ...base, armedAt: base.now - (ESC_CONFIRM_MS - 1) }), "abort");
  });
  test("a second press that comes too late is a new first press", () => {
    assert.equal(decideEscape({ ...base, armedAt: base.now - ESC_CONFIRM_MS }), "arm");
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("closing the picker records when, and the Esc handler uses the decision, not a bare abort", () => {
    const src = read("../src/terminalInput.ts");
    assert.match(src, /panel = undefined;\n\s+panelClosedAt = Date\.now\(\);/);
    assert.match(src, /decideEscape\(\{ now, panelClosedAt, line: rl\?\.line \?\? "", armedAt: escArmedAt \}\)/);
    assert.equal(src.split('runControl.requestAbort("keyboard (Esc)")').length - 1, 1, "only the confirmed press stops the run");
  });
  test("/stop still stops at once", () => {
    assert.match(read("../src/terminalInput.ts"), /runControl\.requestAbort\("keyboard \(\/stop\)"\)/);
  });
  test("a phase whose verification was stopped is not passed or committed", () => {
    const src = read("../src/index.ts");
    const at = src.indexOf("if (result.passed) {");
    const guard = src.indexOf("if (runControl.isAborted) throw new AbortedError(runControl.reason);", at);
    const banner = src.indexOf("VERIFICATION PASSED", at);
    assert.ok(at > 0 && guard > at && guard < banner, "the guard comes before the pass banner and the commit");
  });
});
