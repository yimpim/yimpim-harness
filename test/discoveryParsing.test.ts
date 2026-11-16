import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDiscoveryJson, extractTaskFindings, extractDiscoveryTargetFiles } from "../src/discoveryParsing.js";

const SAMPLE_TASK_FINDINGS = {
  taskFindings: {
    existingFiles: [
      { path: "src/foo.ts", symbols: ["Foo"], relevantCode: "class Foo", whyRelevant: "owns the change" },
      { path: "src/bar.ts", symbols: ["Bar"], relevantCode: "class Bar", whyRelevant: "adjacent caller" },
    ],
    existingFlow: ["User taps X"],
    newFilesNeeded: [],
    uncertainties: [],
  },
};

describe("parseDiscoveryJson", () => {
  test("parses a fenced ```json block", () => {
    const output = "Here is my analysis:\n```json\n" + JSON.stringify(SAMPLE_TASK_FINDINGS) + "\n```";
    const parsed = parseDiscoveryJson(output);
    assert.equal(parsed?.taskFindings?.existingFiles?.length, 2);
  });

  test("parses raw JSON with no fence at all", () => {
    const output = JSON.stringify(SAMPLE_TASK_FINDINGS);
    const parsed = parseDiscoveryJson(output);
    assert.equal(parsed?.taskFindings?.existingFiles?.length, 2);
  });

  // Regression for a real incident: a fast/small Discovery model prefaced its
  // JSON with a sentence of prose despite instructions not to, and the old
  // parser (fenced-block-or-bust) treated any unfenced text as unparseable —
  // discarding every file Discovery had actually found.
  test("recovers JSON that has prose before it and no fence", () => {
    const output = "Based on my investigation, here are the findings:\n" + JSON.stringify(SAMPLE_TASK_FINDINGS);
    const parsed = parseDiscoveryJson(output);
    assert.equal(parsed?.taskFindings?.existingFiles?.length, 2, "prose-prefixed JSON must still be recovered");
  });

  // Regression for the actual production bug: Discovery had `conclude_task`
  // in its tool set, and its own prompt's "conclude immediately" language led
  // a model to call that tool instead of answering with JSON — producing the
  // literal string "TASK_CONCLUDED: <explanation>" as discoveryOutput, with
  // no JSON anywhere in it at all.
  test("returns undefined (not a throw) for a conclude_task-style plain-text answer", () => {
    const output = "TASK_CONCLUDED: Existing codebase memory already covers this task, no further discovery needed.";
    assert.equal(parseDiscoveryJson(output), undefined);
  });

  test("returns undefined for empty or garbage input", () => {
    assert.equal(parseDiscoveryJson(""), undefined);
    assert.equal(parseDiscoveryJson("not json at all, just prose"), undefined);
  });
});

describe("extractTaskFindings", () => {
  test("returns the taskFindings object as pretty JSON when parseable", () => {
    const output = JSON.stringify(SAMPLE_TASK_FINDINGS);
    const result = JSON.parse(extractTaskFindings(output));
    assert.equal(result.existingFiles.length, 2);
  });

  test("falls back to an empty-but-explicit shape, with an uncertainty note, when unparseable", () => {
    const result = JSON.parse(extractTaskFindings("TASK_CONCLUDED: nothing else to say"));
    assert.deepEqual(result.existingFiles, []);
    assert.ok(result.uncertainties[0].includes("did not return a parseable"));
  });
});

describe("extractDiscoveryTargetFiles", () => {
  test("extracts every existingFiles[].path", () => {
    const output = JSON.stringify(SAMPLE_TASK_FINDINGS);
    assert.deepEqual(extractDiscoveryTargetFiles(output), ["src/foo.ts", "src/bar.ts"]);
  });

  test("recovers target files from prose-prefixed, unfenced JSON", () => {
    const output = "Sufficient context found. Findings:\n" + JSON.stringify(SAMPLE_TASK_FINDINGS);
    assert.deepEqual(extractDiscoveryTargetFiles(output), ["src/foo.ts", "src/bar.ts"]);
  });

  // The exact bug the user hit: Discovery called conclude_task, downstream
  // parsing got plain text, Planner's allowlist ended up empty.
  test("returns an empty array (not a crash) for a conclude_task-style answer", () => {
    const output = "TASK_CONCLUDED: Existing codebase memory already covers this task.";
    assert.deepEqual(extractDiscoveryTargetFiles(output), []);
  });

  test("ignores entries with a missing or non-string path", () => {
    const output = JSON.stringify({
      taskFindings: { existingFiles: [{ path: "src/ok.ts" }, { path: 42 }, {}, { path: "" }] },
    });
    assert.deepEqual(extractDiscoveryTargetFiles(output), ["src/ok.ts"]);
  });
});
