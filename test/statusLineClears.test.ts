/** The "<agent> running…" line says what is running now: it goes when the agent ends, instead of lingering until the task finishes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const t = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

test("an ending agent removes its line, or shows the one still running", () => {
  assert.match(t, /if \(event\.type === "agent\.end"\) \{\s*const ended = runningAgentLabels\.findIndex/);
  assert.match(t, /setStatusLine\(left \? `\$\{left\} running…` : undefined\)/);
});
test("a finished or aborted task forgets agents that never reported an end", () => {
  assert.equal((t.match(/runningAgentLabels\.length = 0;/g) ?? []).length, 2);
});
