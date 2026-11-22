/**
 * A user's own tests are exempt from [SCOPE] warnings and from the phase's file budget (a repair reconciles stale assertions after an intentional change), with a ceiling of their own.
 * Specs, documents and the harness's own paths stay warned about and counted.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import { isScopeExemptPath, isTestPath, EXEMPT_TEST_CEILING } from "../src/focusTests.js";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "exempt-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const tools = (limit = 0) => new AgentTools(root, { safety: {}, limits: { maxFilesPerPhase: limit } } as any);
const warnings = async (fn: () => Promise<void>): Promise<string[]> => {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return seen;
};

describe("which paths are exempt", () => {
  test("test directories and executable test file names, in any language", () => {
    for (const p of [
      "__tests__/a.ts", "app/__tests__/Dash.test.tsx", "tests/test_x.py", "test/a.go", "e2e/login.ts", "src/Tests/Foo.cs",
      "src/a.test.ts", "src/a.spec.ts", "lib/user_test.go", "lib/user_test.dart", "pkg/test_user.py", "tests/fixtures/data.json", ".\\tests\\a.ts",
    ]) assert.equal(isScopeExemptPath(p), true, p);
  });

  test("specs, documents and the harness's own paths are not exempt", () => {
    for (const p of [
      "spec/a.test.ts", "specs/01.md", "specs/a.spec.ts", "docs/specs/x.ts", "README.md", "tests/notes.md", "src/a.test.md", "reference/tests/a.ts", ".yimpim/tests/a.ts", ".yimpim/state.json",
      "src/app.ts", "src/testing.ts", "src/contest.ts", "jest.config.js", "src/a.spec.json", "src/protest/x.ts",
    ]) assert.equal(isScopeExemptPath(p), false, p);
  });

  test("isTestPath is untouched for its other callers (it still treats specs/ as tests)", () => {
    assert.equal(isTestPath("specs/a.ts"), true);
    assert.equal(isScopeExemptPath("specs/a.ts"), false);
  });
});

describe("what a phase does with them", () => {
  test("an out-of-plan test is not warned about; an out-of-plan source, spec, doc or harness file still is", async () => {
    const t = tools();
    t.beginPhase(["src/planned.ts"], undefined as any, "p");
    const quiet = await warnings(async () => {
      await t.writeFile("__tests__/a.test.ts", "x\n");
      await t.writeFile("src/b.spec.ts", "x\n");
    });
    assert.deepEqual(quiet, []);
    const loud = await warnings(async () => {
      for (const f of ["src/other.ts", "specs/s.md", "NOTES.md", "reference/r.ts"]) await t.writeFile(f, "x\n");
    });
    assert.equal(loud.length, 4);
  });

  test("tests do not use the phase's file slots, and the warning's count leaves them out", async () => {
    const t = tools(2);
    t.beginPhase(["src/a.ts"], 2, "p");
    for (let i = 0; i < 6; i++) await t.writeFile(`__tests__/t${i}.test.ts`, "x\n");
    await t.writeFile("src/a.ts", "x\n");
    const w = await warnings(() => t.writeFile("src/b.ts", "x\n"));
    assert.match(w[0], /\(2\/2 used\)/);
    await assert.rejects(() => t.writeFile("src/c.ts", "x\n"), /modified 2 files \(limit 2\)/);
    assert.equal(t.filesWrittenThisPhase().length, 8, "tests are still recorded as written");
  });

  test("spec, doc and harness files are counted against the phase's slots", async () => {
    const t = tools(2);
    t.beginPhase([], 2, "p");
    await t.writeFile("specs/a.md", "x\n");
    await t.writeFile("README.md", "x\n");
    await assert.rejects(() => t.writeFile("src/c.ts", "x\n"), /limit 2/);
  });

  test("the tests have a ceiling of their own, enforced before the write, and a file already written is not another", async () => {
    assert.equal(EXEMPT_TEST_CEILING, 25);
    const t = tools(0);
    t.beginPhase([], undefined as any, "p");
    for (let i = 0; i < 25; i++) await t.writeFile(`tests/t${i}.test.ts`, "x\n");
    await assert.rejects(() => t.writeFile("tests/t25.test.ts", "x\n"), /\[WRITE BUDGET\][^]*25 test files \(limit 25\)/);
    assert.equal(fs.existsSync(path.join(root, "tests/t25.test.ts")), false);
    await t.writeFile("tests/t3.test.ts", "again\n");
    await t.writeFile("src/app.ts", "x\n"); // the main budget is untouched
  });

  test("patching a test is exempt too, and the ceiling resets with the phase", async () => {
    const t = tools(1);
    t.beginPhase([], 1, "p");
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, `tests/p${i}.test.ts`), "old\n");
      await t.patchFile(`tests/p${i}.test.ts`, "old", "new");
    }
    await t.writeFile("src/a.ts", "x\n");
    t.beginPhase([], 1, "next");
    await t.writeFile("src/b.ts", "x\n");
    await t.writeFile("tests/new.test.ts", "x\n");
  });
});
