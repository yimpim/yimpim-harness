/**
 * A pass on source review alone is not the same claim as a verified pass: phase.end carries the QA confidence, and the end of a task lists the phases that were never run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { confidenceSummary } from "../src/phaseConfidence.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const row = (label: string, name: string, confidence?: string) => ({ label, name, confidence });

describe("the end-of-task summary", () => {
  test("nothing is said when every phase was verified, or had no verdict", () => {
    assert.deepEqual(confidenceSummary([]), []);
    assert.deepEqual(confidenceSummary([row("1/2", "A", "verified"), row("2/2", "Setup")]), []);
  });
  test("static-only phases are listed by name, out of the phases that had a verdict", () => {
    const lines = confidenceSummary([row("1/3", "Add screen", "verified"), row("2/3", "Wire the poll", "static-only"), row("3/3", "Style it", "static-only")]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⚠️ \[NOT RUN\] 2 of 3 phase\(s\) passed on source review alone/);
    assert.match(lines[0], /2\/3 Wire the poll; 3\/3 Style it/);
  });
  test("partial phases are counted on a second line, and are not called static-only", () => {
    const lines = confidenceSummary([row("1/2", "A", "partial"), row("2/2", "B", "verified")]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ {3}1 more compiled but were not observed running: 1\/2 A$/);
    assert.doesNotMatch(lines[0], /NOT RUN/);
  });
  test("both kinds together give both lines", () => {
    assert.equal(confidenceSummary([row("1/2", "A", "static-only"), row("2/2", "B", "partial")]).length, 2);
  });
});

describe("phase.end carries it", () => {
  test("the passed phase.end reports the confidence of that phase, set where the verdict passes and cleared before each phase so a setup phase never inherits one", () => {
    const idx = src("src/index.ts");
    assert.match(idx, /passed: true,\n\s+confidence: lastPhaseConfidence,\n\s+attempts: lastPhaseRuns,/);
    assert.match(idx, /const confidence = result\.confidence \?\? "static-only";\n\s+lastPhaseConfidence = confidence;/);
    assert.match(idx, /lastPhaseConfidence = undefined;\n\s+const passed =\n\s+planned\.executor === "SETUP"/);
  });
  test("each passed phase is recorded for the summary, and the summary is printed after the success line", () => {
    const idx = src("src/index.ts");
    assert.match(idx, /phaseConfidences\.push\(\{ label, name: planned\.name, confidence: lastPhaseConfidence \}\)/);
    assert.match(idx, /\[ALL PHASES SUCCEEDED\][^\n]*\n\s+for \(const line of confidenceSummary\(phaseConfidences\)\) console\.log\(line\);/);
  });
  test("the remote translator already forwards the field", () => {
    assert.match(src("src/remoteEventTranslator.ts"), /confidence: event\.confidence/);
  });
});
