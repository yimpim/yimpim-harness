/** What a fix task from a failing test tells each stage, so the Planner starts from the diagnosis and not from a fragment. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixTaskFor } from "../src/testSettle.js";
import { failureText } from "../src/testHeal.js";

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("the fix task carries the diagnosis and the failure digest", () => {
  test("it states the file, the whole diagnosis, and how it fails", () => {
    const task = fixTaskFor([{ file: "__tests__/dashboard.test.ts", reason: "app/dashboard.tsx:1006 compares the activity to 'RUNNING', but the wire sends 'running'.", failure: "14 failures, 2 distinct causes.\n\n[9×] expected true to be false" }]);
    assert.match(task, /1\. __tests__\/dashboard\.test\.ts: app\/dashboard\.tsx:1006 compares the activity to 'RUNNING'/);
    assert.match(task, /How it fails:\n\s+14 failures, 2 distinct causes\./);
    assert.match(task, /Do not edit, skip or delete these tests/);
  });
});

describe("the wiring", () => {
  const src = read("../src/index.ts");
  // The items are built by fixItemsFor in testHeal.ts (the CLI and the benchmark both use it), so these two look there.
  const heal = read("../src/testHeal.ts");
  test("the diagnosis goes in without the bookkeeping note that said it was reused (and without the report's sandbox lines)", () => {
    assert.ok(src.includes("const items = fixItemsFor(report.results, repoRoot);"), "the CLI builds the items through the shared function");
    const at = heal.indexOf("export function diagnosisOf(");
    const block = heal.slice(at, at + 500);
    assert.ok(block.includes("nothing it depends on changed since it was last diagnosed"), "it names the note it strips");
    assert.ok(block.includes("sandbox: \\["), "and the sandbox's own lines");
  });
  test("the failure is the digest, not the last 40 lines of raw output", () => {
    assert.ok(heal.includes("failure: failureText(b.failure ?? \"\", repoRoot, b.file),"));
    assert.ok(!src.includes(".slice(-40).join(\"\n\").slice(-4000)") && !heal.includes(".slice(-40).join(\"\n\").slice(-4000)"), "the raw tail is gone");
  });
  test("Discovery is told which files the request names, ahead of the repo-map shortlist", () => {
    assert.ok(src.includes("${namedLeads}${discoveryShortlist}"));
    assert.ok(src.includes("The request names these files, so start with them"));
  });
  test("a plan sent back for more detail says why", () => {
    assert.ok(src.includes("The first plan was not specific enough, so the Planner is asked once more. Why:"));
    assert.ok(!src.includes("Plan lacks surgical scope; requesting one corrective pass."));
  });
});

describe("a cut-off reply is asked for again, not used", () => {
  const heal = read("../src/testHeal.ts");
  test("a reply that only parses after repair is treated as incomplete", () => {
    assert.ok(heal.includes("lenient?.repaired"));
    assert.ok(heal.includes("That reply was cut off before it ended."));
  });
  test("failureText still leads with the distinct causes", () => {
    const t = failureText("  ● a\n    Error: boom 1\n  ● b\n    Error: boom 2\n", "/nonexistent", "x.test.ts");
    assert.match(t, /^2 failures, 1 distinct cause\./);
  });
});

describe("stored diagnoses from an older worker are not reused", () => {
  test("the heal logic version was raised when the worker changed", async () => {
    const { HEAL_LOGIC_VERSION } = await import("../src/testLog.js");
    assert.ok(HEAL_LOGIC_VERSION >= 5, "a diagnosis stored by version 4 (which could be cut off mid-sentence) is not reused");
  });
});
