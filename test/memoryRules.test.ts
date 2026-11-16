import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLiveRules,
  MAX_LIVE_RULES,
  mergeArchitectureRules,
  MAX_ARCHITECTURE_RULES,
  mergeTechStack,
  MAX_TECH_STACK_ENTRIES,
} from "../src/memoryRules.js";

describe("mergeLiveRules", () => {
  test("merges and deduplicates without exceeding the cap", () => {
    const result = mergeLiveRules(["a", "b"], ["b", "c"]);
    assert.deepEqual(result, ["a", "b", "c"]);
  });

  test("leaves a small list untouched, well under the cap", () => {
    const result = mergeLiveRules(["only rule"], []);
    assert.deepEqual(result, ["only rule"]);
  });

  // Regression target: liveRules used to grow forever (Set-deduplicated, but
  // no ceiling) despite being joined into every Discovery/Editor/Repair
  // prompt as context — an unbounded per-call token cost on a long-lived repo.
  test("caps at MAX_LIVE_RULES, dropping the oldest first", () => {
    const existing = Array.from({ length: MAX_LIVE_RULES }, (_, i) => `rule-${i}`);
    const result = mergeLiveRules(existing, ["new-rule"]);

    assert.equal(result.length, MAX_LIVE_RULES);
    assert.ok(!result.includes("rule-0"), "the oldest rule must be evicted");
    assert.ok(result.includes(`rule-${MAX_LIVE_RULES - 1}`), "the newest existing rule must survive");
    assert.ok(result.includes("new-rule"), "the newly added rule must survive");
    assert.equal(result[result.length - 1], "new-rule", "the newest addition should be last");
  });

  test("adding many new rules at once still caps at MAX_LIVE_RULES, keeping only the most recent", () => {
    const existing = ["old-1", "old-2"];
    const newRules = Array.from({ length: MAX_LIVE_RULES + 5 }, (_, i) => `flood-${i}`);
    const result = mergeLiveRules(existing, newRules);

    assert.equal(result.length, MAX_LIVE_RULES);
    assert.ok(!result.includes("old-1"), "pre-existing rules must be evicted when the flood alone exceeds the cap");
    assert.ok(!result.includes("flood-0"), "the earliest of the new flood must be evicted too");
    assert.ok(result.includes(`flood-${MAX_LIVE_RULES + 4}`), "the very last new rule must survive");
  });

  test("a duplicate re-added rule does not count twice against the cap or reorder", () => {
    const result = mergeLiveRules(["a", "b", "c"], ["b"]);
    assert.deepEqual(result, ["a", "b", "c"]);
  });

  test("empty inputs return an empty list", () => {
    assert.deepEqual(mergeLiveRules([], []), []);
  });
});

// Regression target: architectureRules and techStack had NO cap at all
// (just Set-dedup) and were still joined into every Discovery prompt — a
// real project reached 280 architectureRules and 97 techStack entries, an
// 83KB JSON blob repeated into every single task. Both now get the same
// oldest-dropped-first capping mergeLiveRules already had, just with a more
// generous ceiling since they're meant to hold durable facts, not churn.
describe("mergeArchitectureRules", () => {
  test("merges and deduplicates without exceeding the cap", () => {
    assert.deepEqual(mergeArchitectureRules(["a"], ["a", "b"]), ["a", "b"]);
  });

  test("caps at MAX_ARCHITECTURE_RULES, dropping the oldest first", () => {
    const existing = Array.from({ length: MAX_ARCHITECTURE_RULES }, (_, i) => `rule-${i}`);
    const result = mergeArchitectureRules(existing, ["new-rule"]);
    assert.equal(result.length, MAX_ARCHITECTURE_RULES);
    assert.ok(!result.includes("rule-0"));
    assert.ok(result.includes("new-rule"));
  });

  test("uses a more generous ceiling than liveRules — the whole point of keeping them separate", () => {
    assert.ok(MAX_ARCHITECTURE_RULES > MAX_LIVE_RULES);
  });
});

describe("mergeTechStack", () => {
  test("merges and deduplicates without exceeding the cap", () => {
    assert.deepEqual(mergeTechStack(["React Native"], ["React Native", "Expo"]), ["React Native", "Expo"]);
  });

  test("caps at MAX_TECH_STACK_ENTRIES, dropping the oldest first", () => {
    const existing = Array.from({ length: MAX_TECH_STACK_ENTRIES }, (_, i) => `dep-${i}`);
    const result = mergeTechStack(existing, ["new-dep"]);
    assert.equal(result.length, MAX_TECH_STACK_ENTRIES);
    assert.ok(!result.includes("dep-0"));
    assert.ok(result.includes("new-dep"));
  });
});
