/** Which tests a change can reach, and whether a failing one was already red. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { selectTests, failsBefore } from "../src/testGraph.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};

function app() {
  write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
  write("tsconfig.json", `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }, }`);
  write("src/ui/Button.tsx", "export const Button = 1;");
  write("src/screens/Settings.tsx", `import { Button } from "../ui/Button";\nexport const S = Button;`);
  write("src/screens/CreateAccount.tsx", `import { validate } from "@/auth/validate";\nexport const C = validate;`);
  write("src/auth/validate.ts", "export const validate = 1;");
  write("__tests__/settings.test.tsx", `import { S } from "../src/screens/Settings";`);
  write("__tests__/account.test.tsx", `import { C } from "@/screens/CreateAccount";`);
}

describe("selecting by what a test reaches", () => {
  test("a settings-only change runs the settings tests and not create account", () => {
    app();
    const sel = selectTests(dir, ["src/screens/Settings.tsx"]);
    assert.deepEqual(sel.selected, ["__tests__/settings.test.tsx"]);
    assert.deepEqual(sel.skipped, ["__tests__/account.test.tsx"]);
  });
  test("a shared component reaches every test that uses it, through other files", () => {
    app();
    assert.deepEqual(selectTests(dir, ["src/ui/Button.tsx"]).selected, ["__tests__/settings.test.tsx"]);
  });
  test("an aliased import (@/ from tsconfig) is followed", () => {
    app();
    assert.deepEqual(selectTests(dir, ["src/auth/validate.ts"]).selected, ["__tests__/account.test.tsx"]);
  });
  test("a changed test file selects itself", () => {
    app();
    assert.deepEqual(selectTests(dir, ["__tests__/account.test.tsx"]).selected, ["__tests__/account.test.tsx"]);
  });
  test("a deleted file selects the tests whose import now cannot be resolved", () => {
    app();
    fs.rmSync(path.join(dir, "src/auth/validate.ts"));
    const sel = selectTests(dir, ["src/auth/validate.ts"]);
    assert.ok(sel.selected.includes("__tests__/account.test.tsx"));
  });
});

describe("when unsure, run it", () => {
  test("a test with an import that cannot be resolved is run even if nothing it reaches changed", () => {
    app();
    write("__tests__/odd.test.ts", `import x from "./does-not-exist";`);
    const sel = selectTests(dir, ["src/screens/Settings.tsx"]);
    assert.ok(sel.selected.includes("__tests__/odd.test.ts") && sel.uncertain.includes("__tests__/odd.test.ts"));
  });
  test("project-wide config runs everything", () => {
    app();
    for (const f of ["package.json", "jest.config.js", "babel.config.js", "tsconfig.json"]) {
      const sel = selectTests(dir, [f]);
      assert.equal(sel.everything, true, f);
      assert.equal(sel.skipped.length, 0);
    }
  });
  test("a jest.mock path counts as a dependency", () => {
    app();
    write("__tests__/mocked.test.ts", `jest.mock("../src/auth/validate");`);
    assert.ok(selectTests(dir, ["src/auth/validate.ts"]).selected.includes("__tests__/mocked.test.ts"));
  });
});

describe("was it already red", () => {
  test("only files that failed on the last commit are reported, new files are not", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    write("__tests__/old-red.test.ts", "RED");
    write("__tests__/old-green.test.ts", "GREEN");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
    write("__tests__/new.test.ts", "RED"); // not committed: it does not exist at HEAD
    const run = async (root: string, files: string[]) => ({
      ok: !fs.readFileSync(path.join(root, files[0]), "utf8").includes("RED"),
      output: "",
    });
    const set = await failsBefore({ repoRoot: dir, files: ["__tests__/old-red.test.ts", "__tests__/old-green.test.ts", "__tests__/new.test.ts"], run });
    assert.deepEqual([...set!], ["__tests__/old-red.test.ts"]);
    // The throwaway worktree is gone.
    assert.ok(!execFileSync("git", ["worktree", "list"], { cwd: dir }).toString().includes("yimpim-base"));
  });
  test("outside a git repository the answer is unknown, not 'clean'", async () => {
    assert.equal(await failsBefore({ repoRoot: dir, files: ["x.test.ts"], run: async () => ({ ok: true, output: "" }) }), undefined);
  });
});

import { passedList } from "../src/verifierTools.js";

describe("the evidence for a green selected run names the tests", () => {
  test("from the runner's PASS lines", () => {
    const s = passedList("PASS __tests__/gapRecovery.test.ts\nPASS __tests__\\eventLog.test.ts\nTests: 9 passed", ["x.test.ts"]);
    assert.match(s, /all passed: __tests__\/gapRecovery\.test\.ts, __tests__\/eventLog\.test\.ts/);
  });
  test("from the selection when the runner prints no PASS lines", () => {
    assert.match(passedList("5 passed", ["tests/test_a.py"]), /all passed: tests\/test_a\.py/);
  });
});
