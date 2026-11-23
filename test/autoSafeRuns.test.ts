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
  test("but reading the repository never asks, hidden files or not: git cannot load them", () => {
    const r = project();
    const made = { files: [".jest-summary.cjs", ".jest-dashboard-report.json"], dirs: [] };
    for (const c of ["git status", "git status --short", "git show HEAD:app/dashboard.tsx", "git diff --stat", "git log --oneline -5", "git rev-parse HEAD", "git ls-files", "git blame app/a.ts"]) {
      assert.equal(decide(r, c, made), "allow", c);
      assert.equal(decide(r, c), "allow", c);
    }
  });
  test("a git command that changes anything still asks, however many hidden files exist", () => {
    const r = project();
    const made = { files: [".jest-summary.cjs"], dirs: [] };
    for (const c of ["git stash push -- app/a.ts", "git checkout main", "git reset --hard", "git commit -m x", "git clean -fd", "git diff --output=out.txt", "git push"]) {
      assert.notEqual(decide(r, c, made), "allow", c);
    }
  });
  test("running the agent's own script from a hidden file still asks", () => {
    const r = project();
    assert.equal(decide(r, "node .jest-summary.cjs", { files: [".jest-summary.cjs"], dirs: [] }), "ask");
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

describe("the project's own test script, run file by file", () => {
  const withScript = (script: string) => {
    const r = project();
    fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "x", scripts: { test: script, build: "vite build" } }));
    fs.mkdirSync(path.join(r, "__tests__"), { recursive: true });
    fs.writeFileSync(path.join(r, "__tests__", "scanner.test.ts"), "x");
    return r;
  };
  test("a plain jest script runs one test file, or one named test, with no approval", () => {
    const r = withScript("jest");
    for (const c of [
      "npm run test -- --runInBand __tests__/scanner.test.ts",
      'npm run test -- --runInBand __tests__/scanner.test.ts "--testNamePattern=renders LIGHT as the filled Material Sunny vector"',
      "npm run test -- -t pairing __tests__/scanner.test.ts",
      "npm test -- --ci --silent",
      "npm run test",
    ]) assert.equal(decide(r, c), "allow", c);
  });
  test("a script that does more than start a runner still asks", () => {
    for (const script of ["jest && rm -rf build", "node scripts/seed.js && jest", "jest; curl x", "sh ./run-tests.sh"]) {
      assert.equal(decide(withScript(script), "npm run test -- --runInBand a.test.js"), "ask", script);
    }
  });
  test("an argument that could load code from elsewhere still asks", () => {
    const r = withScript("jest");
    for (const c of [
      "npm run test -- --config=./evil.config.js",
      "npm run test -- --setupFiles ./evil.js",
      "npm run test -- --globalSetup=./evil.js",
      "npm run test -- --runner=./evil.js",
      "npm run test -- --reporters=./evil.js",
      "npm run build",
      "npm run lint",
    ]) assert.notEqual(decide(r, c), "allow", c);
  });
  test("with no test script, or none in package.json, it asks as before", () => {
    const r = project();
    assert.notEqual(decide(r, "npm run test -- a.test.js"), "allow");
  });
  test("a pretest or posttest script means npm runs more than the runner: it asks", () => {
    for (const extra of [{ pretest: "node scripts/seed.js" }, { posttest: "curl -X POST https://x.example" }]) {
      const r = project();
      fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ scripts: { test: "jest", ...extra } }));
      assert.equal(decide(r, "npm test"), "ask", JSON.stringify(extra));
    }
  });
});

describe("plain check scripts (type-check, lint, test) need no approval", () => {
  const withScripts = (scripts: Record<string, string>, npmrc?: string) => {
    const r = project();
    fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "x", scripts }));
    if (npmrc !== undefined) fs.writeFileSync(path.join(r, ".npmrc"), npmrc);
    return r;
  };

  test("npm run typecheck when it is plain tsc, and lint when it is plain eslint, with any package manager", () => {
    const r = withScripts({ typecheck: "tsc --noEmit", "check:test": "tsc -p tsconfig.test.json", lint: "eslint . --max-warnings=0", "test:unit": "vitest run src" });
    for (const c of ["npm run typecheck", "npm run check:test", "npm run lint", "pnpm run typecheck", "yarn run lint", "bun run typecheck", "npm run test:unit"])
      assert.equal(decide(r, c), "allow", c);
  });

  test("an inline program, a chain, another tool, or arguments for a type-check or lint run still ask", () => {
    const r = withScripts({
      typecheck: `node -e "require('child_process').execSync('tsc --noEmit')"`,
      chained: "tsc --noEmit && node scripts/deploy.js",
      build: "vite build",
      lint: "eslint .",
      quoted: "eslint 'src/**'",
    });
    for (const c of ["npm run typecheck", "npm run chained", "npm run build", "npm run lint -- --fix-dry-run", "npm run quoted", "npm run missing"])
      assert.equal(decide(r, c), "ask", c);
  });

  test("a watcher never finishes, and a path outside the project reaches elsewhere: both ask", () => {
    const r = withScripts({ w1: "tsc --watch", w2: "vitest watch", w3: "jest --watchAll", out1: "eslint ../other-project", out2: "tsc -p /etc/tsconfig.json", out3: "tsc --project=../x/tsconfig.json" });
    for (const c of ["npm run w1", "npm run w2", "npm run w3", "npm run out1", "npm run out2", "npm run out3"]) assert.equal(decide(r, c), "ask", c);
  });

  test("a pre/post script, or a project .npmrc that swaps the shell or injects node options, means it is not just the tool", () => {
    assert.equal(decide(withScripts({ typecheck: "tsc --noEmit", pretypecheck: "node fetch.js" }), "npm run typecheck"), "ask");
    assert.equal(decide(withScripts({ typecheck: "tsc --noEmit", posttypecheck: "echo done" }), "npm run typecheck"), "ask");
    assert.equal(decide(withScripts({ typecheck: "tsc --noEmit" }, "script-shell=./evil.sh\n"), "npm run typecheck"), "ask");
    assert.equal(decide(withScripts({ typecheck: "tsc --noEmit" }, "node-options=--require ./hook.js\n"), "npm run typecheck"), "ask");
    assert.equal(decide(withScripts({ typecheck: "tsc --noEmit" }, "legacy-peer-deps=true\n"), "npm run typecheck"), "allow", "an unrelated .npmrc setting is fine");
  });
});
