/**
 * Regression tests for installPersistentInput's two failure modes
 * (src/terminalInput.ts): both used to return the same silent no-op as a
 * successful install, so a terminal that couldn't actually support the
 * pinned input line just silently did nothing, with no indication why — an
 * IDE-embedded terminal panel routinely fails one or both of these checks
 * even though it looks like an ordinary interactive terminal. (This used to
 * guard installEscToAbort, in src/remote/control.ts, before Esc-to-abort was
 * absorbed into the persistent input line — see terminalInput.ts.)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installPersistentInput } from "../src/terminalInput.js";

describe("installPersistentInput", () => {
  test("warns and returns a no-op when stdin is not a TTY, instead of silently pretending the pinned input will work", () => {
    const originalIsTTY = process.stdin.isTTY;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    (process.stdin as any).isTTY = false;
    try {
      const cleanup = installPersistentInput();
      assert.equal(typeof cleanup, "function");
      assert.doesNotThrow(() => cleanup());
      assert.ok(warnings.some((w) => w.includes("not a TTY")), `expected a not-a-TTY warning, got ${JSON.stringify(warnings)}`);
      assert.ok(warnings.some((w) => w.includes("Ctrl+C")), "the warning must name the fallback");
    } finally {
      (process.stdin as any).isTTY = originalIsTTY;
      console.warn = originalWarn;
    }
  });

  test("warns and returns a no-op when stdin has no setRawMode, instead of silently pretending the pinned input will work", () => {
    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = process.stdin.setRawMode;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    (process.stdin as any).isTTY = true;
    (process.stdin as any).setRawMode = undefined;
    try {
      const cleanup = installPersistentInput();
      assert.equal(typeof cleanup, "function");
      assert.doesNotThrow(() => cleanup());
      assert.ok(
        warnings.some((w) => w.includes("raw input mode")),
        `expected a raw-input-mode warning, got ${JSON.stringify(warnings)}`
      );
      assert.ok(warnings.some((w) => w.includes("Ctrl+C")), "the warning must name the fallback");
    } finally {
      (process.stdin as any).isTTY = originalIsTTY;
      (process.stdin as any).setRawMode = originalSetRawMode;
      console.warn = originalWarn;
    }
  });
});
