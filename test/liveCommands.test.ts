/**
 * /remote-control (and /rc) work while a task is running: handled the moment they are typed, never queued as the answer to
 * the next question, and without clearing the screen the run is printing to.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerLiveCommands } from "../src/terminalInput.js";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8");

describe("live commands", () => {
  test("they can be registered and removed", () => {
    const off = registerLiveCommands(["/remote-control", "/rc"], () => {});
    off();
    off();
  });
  test("the line handler runs them before queueing text as an answer, case-insensitively", () => {
    const t = src("terminalInput.ts");
    assert.match(t, /const live = liveCommands\.get\(trimmed\.toLowerCase\(\)\);\s*if \(live\) \{/);
    assert.ok(t.indexOf("liveCommands.get(trimmed") < t.indexOf("runControl.provideForNextQuestion(trimmed)"));
  });
  test("pairing mid-run keeps the screen and does not drop a phone already paired", () => {
    const idx = src("index.ts");
    assert.match(idx, /registerLiveCommands\(\["\/remote-control", "\/rc"\]/);
    assert.match(idx, /if \(taskRunning && remote\?\.connected\)/);
    assert.match(idx, /isInteractive\(\) && !keepScreen/);
    assert.match(idx, /pendingAttachments\.push\(p\); \}, taskRunning\)/);
  });
});

import { echoedInput } from "../src/terminalInput.js";
describe("what you typed stays on screen", () => {
  test("it is echoed above the pinned line, long text clipped", () => {
    assert.match(echoedInput("resume where we left off"), /›[^\n]*resume where we left off/);
    assert.match(echoedInput("x".repeat(700)), /\+100 more characters/);
    assert.match(src("terminalInput.ts"), /if \(trimmed\) writeRawAbove\(echoedInput\(trimmed\)\);/);
  });
});
