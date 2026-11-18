/** "Check it against the brief" is an audit of the code, and a verify-only task never builds anything to make QA's job easier. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf-8");

describe("verify is read-only", () => {
  test("a verify-only task reports an unreachable state instead of asking the Editor for a test hook", () => {
    const t = src("index.ts");
    assert.match(t, /result\.passed && verifyOnly && !testabilityTried/);
    assert.match(t, /result\.passed && !verifyOnly && !testabilityTried/);
  });
  test("the intent prompt keeps document audits out of verify", () => {
    const p = src("prompts.ts");
    assert.match(p, /NOT "verify": checking WORK AGAINST A DOCUMENT/);
    assert.match(p, /it is "audit"; when they want the missing part built it is "task"/);
  });
});
