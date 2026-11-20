/**
 * Pressing Enter on the pinned prompt: readline ends the line with its own newline before the line handler runs, so the cursor is one row
 * below the prompt. The pinned area is cleared by walking UP a fixed number of rows from the prompt's last row; from one row lower it stopped
 * one row short and left the top row of the area (the status line) on screen: a second copy of the progress line above what was typed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/terminalInput.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
const handle = src.slice(src.indexOf("function handleLine("), src.indexOf("export function slashCompleter") > 0 ? src.indexOf("/**\n * Tab-completion") : undefined);

describe("submitting a line", () => {
  test("the cursor steps back up to the prompt's row before anything clears the pinned area", () => {
    const up = handle.indexOf("readline.moveCursor(process.stdout, 0, -1)");
    const echo = handle.indexOf("writeRawAbove(echoedInput(trimmed))");
    assert.ok(up > 0 && echo > 0, "both are in the line handler");
    assert.ok(up < echo, "the step back comes before the echo clears and redraws");
  });
  test("it only does so for a real terminal with the pinned prompt installed, and not while a paste is still arriving", () => {
    assert.ok(handle.includes("if (rl && process.stdout.isTTY) readline.moveCursor(process.stdout, 0, -1);"));
    assert.ok(handle.indexOf("if (paste.pasting) {") < handle.indexOf("readline.moveCursor(process.stdout, 0, -1)"));
  });
  test("every path out of the handler redraws the pinned area afterwards", () => {
    // clearInputArea in refreshInputArea measures from the (now correct) row, so no path leaves the area half-cleared.
    const exits = handle.split("\n").filter((l) => /refreshInputArea\(\)|settle\(/.test(l)).length;
    assert.ok(exits >= 5, `${exits} exits redraw`);
  });
});
