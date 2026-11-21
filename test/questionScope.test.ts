/**
 * The planner's questionnaire belongs at the start of a completely new build (and in a roadmap's own questionnaire). Every other task is worked on what the
 * worker already knows. A person who chose "all" or "autonomous" keeps that choice.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { taskQuestionMode, isNewProject, looksLikeStarter, sourceFileCount, NEW_PROJECT_MAX_SOURCE_FILES } from "../src/questionScope.js";

let root = "";
const w = (rel: string, s = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), s);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("which mode a task's planner uses", () => {
  test("essential (the default): the full questionnaire for a new build; an ordinary task, or a roadmap unit, asks only what it really needs", () => {
    assert.equal(taskQuestionMode("essential", { newProject: true, inRoadmapUnit: false }), "all");
    assert.equal(taskQuestionMode("essential", { newProject: false, inRoadmapUnit: false }), "essential");
    assert.equal(taskQuestionMode("essential", { newProject: true, inRoadmapUnit: true }), "essential");
    assert.equal(taskQuestionMode("essential", { newProject: false, inRoadmapUnit: true }), "essential");
  });
  test("a person's own choice stands: 'all' asks everything even in a finished project, 'autonomous' never asks even in a new one", () => {
    for (const ctx of [{ newProject: true, inRoadmapUnit: false }, { newProject: false, inRoadmapUnit: false }, { newProject: false, inRoadmapUnit: true }]) {
      assert.equal(taskQuestionMode("all", ctx), "all");
      assert.equal(taskQuestionMode("autonomous", ctx), "autonomous");
    }
  });
});

describe("what a new build is", () => {
  test("an empty folder and one with a few files are new; a project with real source is not", () => {
    assert.equal(isNewProject(root), true);
    for (let i = 0; i < NEW_PROJECT_MAX_SOURCE_FILES; i++) w(`src/f${i}.ts`);
    assert.equal(isNewProject(root), true, "ten source files is still new");
    w("src/more.ts");
    assert.equal(isNewProject(root), false, "eleven is an existing app");
  });
  test("tests, docs, reference material, dependencies, build output and config do not count as the project", () => {
    for (let i = 0; i < 12; i++) {
      w(`__tests__/t${i}.test.ts`);
      w(`node_modules/pkg/i${i}.js`);
      w(`reference/android/R${i}.kt`);
      w(`docs/d${i}.ts`);
      w(`dist/o${i}.js`);
    }
    w("package.json", "{}");
    w("README.md");
    w("app.config.json", "{}");
    w("src/spec.test.ts");
    assert.equal(sourceFileCount(root), 0);
    assert.equal(isNewProject(root), true);
  });
  test("in a git repository the count follows git (tracked and new files, not what .gitignore hides)", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    w(".gitignore", "generated/\n");
    for (let i = 0; i < 4; i++) w(`src/f${i}.ts`);
    for (let i = 0; i < 20; i++) w(`generated/g${i}.ts`);
    assert.equal(sourceFileCount(root), 4);
    assert.equal(isNewProject(root), true);
  });
});

describe("a fresh starter template is a new build, not an existing app", () => {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const initRepo = () => {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
  };
  const commit = (n = 1) => {
    for (let i = 0; i < n; i++) {
      w(`.history/${i}.txt`, String(Math.random()));
      git("add", "-A");
      git("commit", "-q", "-m", `c${i}`);
    }
  };
  const sources = (n: number) => { for (let i = 0; i < n; i++) w(`src/t${i}.tsx`); };

  test("create-expo-app: its own marker files and 14 template files, one commit: a new build", () => {
    initRepo();
    w("package.json", JSON.stringify({ scripts: { "reset-project": "node ./scripts/reset-project.js", start: "expo start" } }));
    w("scripts/reset-project.js");
    w("app/(tabs)/explore.tsx");
    sources(14);
    commit(1);
    assert.equal(looksLikeStarter(root), true);
    assert.equal(isNewProject(root), true);
  });
  test("a Vite scaffold (react.svg, the default App.css) and a create-react-app one are recognised too", () => {
    initRepo();
    w("src/assets/react.svg");
    sources(14);
    commit(1);
    assert.equal(isNewProject(root), true);
    fs.rmSync(path.join(root, "src/assets"), { recursive: true });
    w("src/App.css", ".logo { animation: logo-spin infinite 20s linear; }");
    assert.equal(looksLikeStarter(root), true, "the scaffold's own stylesheet");
  });
  test("an expo blank template is recognised by its own welcome text", () => {
    initRepo();
    w("App.js", "<Text>Open up App.js to start working on your app!</Text>");
    sources(14);
    commit(1);
    assert.equal(isNewProject(root), true);
  });
  test("the same files with real history behind them are an existing app: the marker is still there, but people have built on it", () => {
    initRepo();
    w("scripts/reset-project.js");
    sources(14);
    commit(6);
    assert.equal(looksLikeStarter(root), false);
    assert.equal(isNewProject(root), false);
  });
  test("14 source files with no scaffold marker are an existing app, however few the commits", () => {
    initRepo();
    sources(14);
    commit(1);
    assert.equal(looksLikeStarter(root), false);
    assert.equal(isNewProject(root), false);
  });
  test("a marker does not make a big project new: past 80 source files it is an app", () => {
    initRepo();
    w("scripts/reset-project.js");
    sources(90);
    commit(1);
    assert.equal(isNewProject(root), false);
  });
  test("a scaffold in a folder that is not a repository yet is a new build", () => {
    w("src/assets/react.svg");
    sources(14);
    assert.equal(isNewProject(root), true);
  });
});

describe("the wiring", () => {
  test("the planner's mode comes from it, with the roadmap unit and the project's size", () => {
    const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
    assert.ok(idx.includes("const questionMode: QuestionMode = taskQuestionMode(config.planning.questions, { newProject: isNewProject(repoRoot), inRoadmapUnit: Boolean(activeUnitId) });"));
    assert.ok(!idx.includes("const questionMode: QuestionMode = config.planning.questions;"));
    // the roadmap's own questionnaire follows the same rule: the full one for a completely new build
    assert.ok(idx.includes("questionMode: taskQuestionMode(config.planning.questions, { newProject: isNewProject(repoRoot), inRoadmapUnit: false }),"));
  });
});
