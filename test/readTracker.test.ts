import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ReadTracker,
  classifyTool,
  INSPECTION_TOOLS,
  MUTATION_TOOLS,
} from "../src/agent/readTracker.js";

/** Runs a full round of `READS_PER_ROUND` single-file reads against the tracker. */
function readRound(tracker: ReadTracker, prefix: string): void {
  for (let i = 0; i < ReadTracker.READS_PER_ROUND; i++) {
    tracker.recordToolCall("read_file", { path: `${prefix}-${i}.ts` });
  }
}

describe("classifyTool", () => {
  test("identifies every inspection tool", () => {
    assert.ok(INSPECTION_TOOLS.size === 4, "exactly the four inspection tools are listed");
    for (const tool of INSPECTION_TOOLS) {
      assert.equal(classifyTool(tool), "inspection");
    }
  });

  test("identifies every mutation tool", () => {
    for (const tool of MUTATION_TOOLS) {
      assert.equal(classifyTool(tool), "mutation");
    }
  });

  test("non-read tools are 'other'", () => {
    assert.equal(classifyTool("conclude_task"), "other");
    assert.equal(classifyTool("ask_user"), "other");
    assert.equal(classifyTool("register_component"), "other");
    assert.equal(classifyTool(""), "other");
  });
});

describe("ReadTracker stall detection", () => {
  test("configuration constants match the documented thresholds", () => {
    assert.equal(ReadTracker.READS_PER_ROUND, 8);
    assert.equal(ReadTracker.MAX_CONSECUTIVE_READ_ROUNDS, 2);
  });

  test("2 consecutive rounds of 8 reads with 0 edits triggers a stall", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    assert.equal(tracker.consecutiveReadRounds, 1, "one full round is not enough");
    assert.equal(tracker.hasStalled(), false);

    readRound(tracker, "b");
    assert.equal(tracker.consecutiveReadRounds, 2);
    assert.equal(tracker.hasStalled(), true);
  });

  test("completed rounds survive resetForRound at turn boundaries", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    tracker.resetForRound(); // orchestrator turn boundary between the rounds
    assert.equal(tracker.hasStalled(), false);

    readRound(tracker, "b");
    assert.equal(tracker.hasStalled(), true, "round boundary must not reset the history");
  });

  test("partial rounds are dropped by resetForRound, never counted", () => {
    const tracker = new ReadTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordToolCall("read_file", { path: `partial-${i}.ts` });
    }
    tracker.resetForRound();
    assert.equal(tracker.consecutiveReadRounds, 0, "a 5-read partial round is not a round");

    readRound(tracker, "a");
    assert.equal(tracker.consecutiveReadRounds, 1);
    assert.equal(tracker.hasStalled(), false);
  });

  test("the 8th read rolls the round over into the next one", () => {
    const tracker = new ReadTracker();
    for (let i = 0; i < 9; i++) {
      tracker.recordToolCall("read_file", { path: `f-${i}.ts` });
    }
    assert.equal(tracker.consecutiveReadRounds, 1);
    assert.equal(tracker.readIterationsCount, 1, "the 9th read belongs to the next round");
  });
});

describe("mutation tools reset read streaks", () => {
  test("patch_file clears a completed stall", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    readRound(tracker, "b");
    assert.equal(tracker.hasStalled(), true);

    tracker.recordToolCall("patch_file", { path: "a.ts", search: "x", replace: "y" });
    assert.equal(tracker.hasStalled(), false);
    assert.equal(tracker.consecutiveReadRounds, 0);
    assert.equal(tracker.readIterationsCount, 0);
  });

  test("write_file also resets the streak", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    assert.equal(tracker.consecutiveReadRounds, 1);

    tracker.recordToolCall("write_file", { path: "new.ts", content: "..." });
    assert.equal(tracker.consecutiveReadRounds, 0);
    assert.equal(tracker.readIterationsCount, 0);
  });

  test("an edit before a round completes stops that round from counting", () => {
    const tracker = new ReadTracker();
    for (let i = 0; i < 4; i++) {
      tracker.recordToolCall("read_file", { path: `f-${i}.ts` });
    }
    tracker.recordToolCall("write_file", { path: "new.ts", content: "" });

    readRound(tracker, "a");
    assert.equal(tracker.consecutiveReadRounds, 1);
    assert.equal(tracker.hasStalled(), false);
  });

  test("a stall needs 2 full rounds again after the streak is broken", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    tracker.recordToolCall("patch_file", { path: "a.ts", search: "x", replace: "y" });

    readRound(tracker, "b");
    assert.equal(tracker.hasStalled(), false);
    readRound(tracker, "c");
    assert.equal(tracker.hasStalled(), true);
  });
});

describe("non-mutation non-read calls", () => {
  test("do not break a read streak", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    tracker.recordToolCall("conclude_task", { status: "CANNOT_LOCATE" });

    readRound(tracker, "b");
    assert.equal(tracker.hasStalled(), true, "an intervening non-edit call must not reset the streak");
  });

  test("do not count toward the round's read budget", () => {
    const tracker = new ReadTracker();
    for (let i = 0; i < 7; i++) {
      tracker.recordToolCall("read_file", { path: `f-${i}.ts` });
    }
    tracker.recordToolCall("ask_user", { question: "?" });
    assert.equal(tracker.readIterationsCount, 7);

    tracker.recordToolCall("read_file", { path: "f-7.ts" });
    assert.equal(tracker.consecutiveReadRounds, 1);
  });
});

describe("inspected path tracking", () => {
  test("single and batched inspection args are recorded", () => {
    const tracker = new ReadTracker();
    tracker.recordToolCall("read_file", { path: "a.ts" });
    tracker.recordToolCall("get_file_outline", { paths: ["b.ts", "c.ts"] });
    tracker.recordToolCall("search_code", { path: "src", pattern: "ReadTracker" });
    tracker.recordToolCall("list_files", { path: "test", recursive: true });

    assert.deepEqual([...tracker.inspectedPaths].sort(), ["a.ts", "b.ts", "c.ts", "src", "test"]);
  });

  test("re-inspecting the same file records it once", () => {
    const tracker = new ReadTracker();
    tracker.recordToolCall("read_file", { path: "a.ts" });
    tracker.recordToolCall("read_file", { paths: ["a.ts", "b.ts"] });
    tracker.recordToolCall("list_files", { path: "src" });
    assert.equal(tracker.inspectedPaths.size, 3);
  });

  test("args without a usable file path neither crash nor record", () => {
    const tracker = new ReadTracker();
    tracker.recordToolCall("search_code", { pattern: "foo" });
    tracker.recordToolCall("list_files", { recursive: true });
    tracker.recordToolCall("read_file", { path: 123 });
    tracker.recordToolCall("read_file", { paths: "not-an-array" });

    assert.equal(tracker.inspectedPaths.size, 0);
    assert.equal(tracker.readIterationsCount, 4, "reads still count even without a path");
  });

  test("resetAll clears rounds, history, and recorded paths", () => {
    const tracker = new ReadTracker();
    readRound(tracker, "a");
    readRound(tracker, "b");
    assert.equal(tracker.hasStalled(), true);

    tracker.resetAll();
    assert.equal(tracker.readIterationsCount, 0);
    assert.equal(tracker.consecutiveReadRounds, 0);
    assert.equal(tracker.inspectedPaths.size, 0);
    assert.equal(tracker.hasStalled(), false);
  });
});