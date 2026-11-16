/**
 * Commands that only run the project's own tests or checks need no approval; anything that fetches, installs or runs code
 * written into the command still asks.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateCommand, isAutoSafeRun, tokenizeCommand } from "../src/commandPolicy.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const argv = (c: string) => (tokenizeCommand(c) as { argv: string[] }).argv;

function project() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-safe-"));
  dirs.push(r);
  fs.mkdirSync(path.join(r, "node_modules", ".bin"), { recursive: true });
  for (const b of ["jest", "tsc", "eslint", "prettier", "cowsay"]) fs.writeFileSync(path.join(r, "node_modules", ".bin", b), "#!/bin/sh\n");
  fs.mkdirSync(path.join(r, "reference"), { recursive: true });
  for (const f of ["reference/relayRetryPolicy.test.ts", "reference/build.js", "a.test.js", "test_math.py", "tool.py"]) fs.writeFileSync(path.join(r, f), "x");
  return r;
}
const decide = (r: string, c: string, created?: { files: string[]; dirs: string[] }) =>
  evaluateCommand(c, { repoRoot: r, platform: "linux", ...(created ? { agentCreated: created } : {}) }).verdict;

describe("runs that need no approval", () => {
  test("a test file run by node with harmless flags, and installed test/check tools", () => {
    const r = project();
    for (const c of [
      "node --experimental-strip-types reference/relayRetryPolicy.test.ts",
      "node a.test.js",
      "node --test",
      "node --test reference",
      "npx jest reference --verbose",
      "npx tsc --noEmit",
      "npm exec eslint .",
      "python test_math.py",
      "python3 -m unittest discover -v",
      "node --version",
      "git --version",
    ]) {
      assert.equal(decide(r, c), "allow", c);
    }
  });
  test("anything that fetches, installs, runs inline code or a non-test script still asks or is refused", () => {
    const r = project();
    for (const c of [
      "node reference/build.js",
      "node -e \"1\"",
      "node --import ./x.js a.test.js",
      "node --require ./x.js a.test.js",
      "node --experimental-strip-types=foo a.test.js",
      "node ../outside.test.js",
      "npx cowsay hi",
      "npx prettier --write .",
      "npx jest@29",
      "python tool.py",
      "python -c \"1\"",
      "node nothere.test.js",
    ]) {
      assert.notEqual(decide(r, c), "allow", c);
    }
  });
  test("a hidden file the agent created this run still makes it ask", () => {
    const r = project();
    assert.equal(decide(r, "node a.test.js", { files: [".hook.js"], dirs: [] }), "ask");
  });
  test("the helper itself", () => {
    const r = project();
    assert.equal(isAutoSafeRun(argv("node a.test.js"), r, r), true);
    assert.equal(isAutoSafeRun(argv("node reference/build.js"), r, r), false);
  });
});

describe("read-only git needs no approval", () => {
  test("status, diff, log and friends run; anything that writes, runs a program or overrides config still asks", () => {
    const r = project();
    for (const c of ["git status -s", "git status", "git diff --stat", "git log --oneline -5", "git show HEAD", "git branch -a", "git remote -v", "git rev-parse HEAD"]) {
      assert.equal(decide(r, c), "allow", c);
    }
    for (const c of ["git commit -m x", "git push", "git checkout main", "git diff --output=x.txt", "git -c core.pager=sh status", "git branch -D x", "git remote add o url", "git log --exec=sh"]) {
      assert.equal(decide(r, c), "ask", c);
    }
  });
});
