import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRemovalCommand } from "../src/cleanupCommand.js";

describe("buildRemovalCommand", () => {
  test("uses PowerShell Remove-Item, double-quoted, on win32", () => {
    assert.equal(
      buildRemovalCommand(["src/old.ts", "src/other-old.ts"], "win32"),
      `Remove-Item "src/old.ts", "src/other-old.ts"`
    );
  });

  test("uses rm, single-quoted, on every other platform", () => {
    assert.equal(buildRemovalCommand(["src/old.ts", "src/other-old.ts"], "linux"), `rm 'src/old.ts' 'src/other-old.ts'`);
    assert.equal(buildRemovalCommand(["src/old.ts"], "darwin"), `rm 'src/old.ts'`);
  });

  test("defaults to the real process.platform when none is given", () => {
    const expected = process.platform === "win32" ? `Remove-Item "a"` : `rm 'a'`;
    assert.equal(buildRemovalCommand(["a"]), expected);
  });
});
