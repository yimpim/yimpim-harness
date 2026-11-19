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
  test("the diagnosis goes in without the bookkeeping note that said it was reused", () => {
    const at = src.indexOf("const items = bugs.map((b) => ({");
    const block = src.slice(at, at + 700);
    assert.ok(block.includes("reason: b.note.replace("), "the stored diagnosis is cleaned before it is sent");
    assert.ok(block.includes("nothing it depends on changed since it was last diagnosed"), "it names the note it strips");
  });
  test("the failure is the digest, not the last 40 lines of raw output", () => {
    assert.ok(src.includes("failure: failureText(b.failure ?? \"\", repoRoot, b.file),"));
    assert.ok(!src.includes(".slice(-40).join(\"\n\").slice(-4000)"), "the raw tail is gone");
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
