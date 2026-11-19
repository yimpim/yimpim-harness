/** A stop typed at this keyboard must not be reported as a stop from the phone, and must not leave a second "stop" waiting at the prompt. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runControl } from "../src/remote/control.js";

const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");

test("a reported stop clears the flag in the same place it is reported, so the idle prompt finds nothing", () => {
  const at = src.indexOf("Completed phases remain committed. Resume with:");
  const after = src.slice(at, at + 700);
  assert.ok(after.includes("runControl.reset();"), "reset right after the stop is reported");
  assert.ok(after.indexOf("runControl.reset();") < after.indexOf("if (activeUnitId) {"), "before anything that follows");
});

test("a stop that arrives while idle says who made it", () => {
  const at = src.indexOf("A stop that arrived while nothing was running");
  const block = src.slice(at, at + 600);
  assert.ok(block.includes('"from the phone"'));
  assert.ok(block.includes("runControl.reason"));
  assert.ok(!src.includes("Stopped from phone. Nothing was running yet"), "the hard-coded 'from phone' is gone");
});

test("the abort state behaves as the fix relies on: set by a stop, clear after reset", () => {
  runControl.reset();
  runControl.requestAbort("keyboard (/stop)");
  assert.equal(runControl.isAborted, true);
  assert.equal(runControl.reason, "keyboard (/stop)");
  runControl.reset();
  assert.equal(runControl.isAborted, false);
  assert.equal(runControl.reason, "");
});
