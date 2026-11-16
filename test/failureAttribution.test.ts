/**
 * A failing test the phase did not cause is stale-test debt: the harness works
 * that out from the code, tells repair so, and never skips, asks, or aborts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attributeTestFailure, failingTestFiles, importClosure, renderTestDebtSection } from "../src/failureAttribution.js";

const repo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-"));
  fs.mkdirSync(path.join(dir, "node_modules", "react"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

const REPORT = `FAIL __tests__/timelineGolden.test.ts
  ● timeline golden › replays the sample history
    expect(received).toEqual(expected)
      at Object.toEqual (__tests__/timelineGolden.test.ts:74:20)`;

const APP = {
  "__tests__/timelineGolden.test.ts": `import { reduce } from "../src/models/timeline";\nimport golden from "../reference/golden.json";\n`,
  "src/models/timeline.ts": `import { Event } from "./types";\nimport React from "react";\nimport fs from "fs";\nexport const reduce = () => 1;\n`,
  "src/models/types.ts": `export type Event = {};\n`,
  "reference/golden.json": `{}`,
  "app/dashboard.tsx": `import { reduce } from "../src/models/timeline";\nexport default function Dash() {}\n`,
};

describe("failingTestFiles", () => {
  test("finds the test file named in a Jest report, once, only if it exists", () => {
    const r = repo(APP);
    assert.deepEqual(failingTestFiles(REPORT, r), ["__tests__/timelineGolden.test.ts"]);
    assert.deepEqual(failingTestFiles("FAIL __tests__/gone.test.ts", r), []);
  });
});

describe("importClosure", () => {
  test("follows the project's own imports, through other files, and ignores packages and built-ins", () => {
    const { files, complete } = importClosure("__tests__/timelineGolden.test.ts", repo(APP));
    assert.deepEqual([...files].sort(), ["__tests__/timelineGolden.test.ts", "reference/golden.json", "src/models/timeline.ts", "src/models/types.ts"]);
    assert.equal(complete, true);
  });

  test("an import it cannot resolve makes the closure incomplete rather than guessed", () => {
    const r = repo({ "__tests__/a.test.ts": `import x from "./missing";\n` });
    assert.equal(importClosure("__tests__/a.test.ts", r).complete, false);
  });

  test("Python imports are followed too", () => {
    const r = repo({
      "tests/test_core.py": "from app.core import run\nimport os\n",
      "app/__init__.py": "",
      "app/core.py": "from .util import helper\n",
      "app/util.py": "def helper(): pass\n",
    });
    const { files } = importClosure("tests/test_core.py", r);
    assert.ok(files.has("app/core.py") && files.has("app/util.py"));
  });
});

describe("attributeTestFailure", () => {
  test("a test that loads nothing the phase changed was already failing", () => {
    const a = attributeTestFailure({ failureText: REPORT, changedFiles: ["app/dashboard.tsx"], repoRoot: repo(APP) });
    assert.equal(a.verdict, "unrelated");
    assert.match(a.why, /do not include app\/dashboard\.tsx/);
    assert.deepEqual(a.tests, ["__tests__/timelineGolden.test.ts"]);
  });

  test("a changed file the test loads directly, or only through another file, is related", () => {
    const r = repo(APP);
    assert.equal(attributeTestFailure({ failureText: REPORT, changedFiles: ["src/models/timeline.ts"], repoRoot: r }).verdict, "related");
    const deep = attributeTestFailure({ failureText: REPORT, changedFiles: ["src/models/types.ts"], repoRoot: r });
    assert.equal(deep.verdict, "related");
    assert.match(deep.why, /loads src\/models\/types\.ts/);
  });

  test("a golden fixture the test loads counts as loaded", () => {
    assert.equal(attributeTestFailure({ failureText: REPORT, changedFiles: ["reference/golden.json"], repoRoot: repo(APP) }).verdict, "related");
  });

  test("a config file that can change every test is never called unrelated", () => {
    for (const f of ["package.json", "jest.config.js", "tsconfig.json", ".env", "pyproject.toml"]) {
      assert.equal(attributeTestFailure({ failureText: REPORT, changedFiles: [f], repoRoot: repo(APP) }).verdict, "unknown", f);
    }
  });

  test("a deleted .env.example template cannot affect a test", () => {
    const a = attributeTestFailure({ failureText: REPORT, changedFiles: ["app/dashboard.tsx", ".env.example"], repoRoot: repo(APP) });
    assert.equal(a.verdict, "unrelated");
  });

  test("anything it cannot establish is unknown, which repairs as before", () => {
    const r = repo(APP);
    assert.equal(attributeTestFailure({ failureText: "something failed", changedFiles: ["app/dashboard.tsx"], repoRoot: r }).verdict, "unknown");
    assert.equal(attributeTestFailure({ failureText: REPORT, changedFiles: [], repoRoot: r }).verdict, "unknown");
    const broken = repo({ ...APP, "__tests__/timelineGolden.test.ts": `import x from "./missing";\n` });
    assert.equal(attributeTestFailure({ failureText: REPORT, changedFiles: ["app/dashboard.tsx"], repoRoot: broken }).verdict, "unknown");
  });
});

describe("what repair is told", () => {
  const text = renderTestDebtSection("the test does not load app/dashboard.tsx.\nFailing test file(s): __tests__/timelineGolden.test.ts");

  test("it says the test is stale, not the diff, and that reverting will not help", () => {
    assert.match(text, /STALE TEST — NOT CAUSED BY YOUR DIFF/);
    assert.match(text, /reverting it will not help/);
  });

  test("it demands an in-place update, never an append, a skip, or a red test", () => {
    assert.match(text, /UPDATE THE EXISTING TEST IN PLACE/);
    assert.match(text, /Do not add a second test beside it/);
    assert.match(text, /do not skip or comment it out/);
    assert.match(text, /Do not leave the test red/);
  });

  test("it allows removing a test only when what it covered is gone, and says to report it", () => {
    assert.match(text, /delete it only if the behavior it covered no longer exists at all \(say that you did\)/);
  });

  test("it lets the code be wrong too, judged from the spec", () => {
    assert.match(text, /Code regressed against its spec: fix the code/);
    assert.match(text, /spec or reference files/);
  });

  test("with no note there is nothing to add", () => {
    assert.equal(renderTestDebtSection(""), "");
  });
});
