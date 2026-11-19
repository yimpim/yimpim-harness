/** The "<agent> running…" line says what is running now: it goes when the agent ends, instead of lingering until the task finishes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const t = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

test("an ending agent removes its line, or shows the one still running", () => {
  assert.match(t, /if \(event\.type === "agent\.end"\) \{\s*const ended = runningAgentLabels\.findIndex/);
  // The line is composed from the agent still running and the model calls in flight (liveCalls.ts): with neither it is cleared.
  assert.match(t, /const refreshStatus = \(\) => setStatusLine\(composeStatus\(runningAgentLabels\[runningAgentLabels\.length - 1\], Date\.now\(\), /);
  assert.match(t, /splice\(ended, 1\);\s*refreshStatus\(\);/);
});
test("a finished or aborted task forgets agents that never reported an end", () => {
  assert.equal((t.match(/runningAgentLabels\.length = 0;/g) ?? []).length, 2);
});
