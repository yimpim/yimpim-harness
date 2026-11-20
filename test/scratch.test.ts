/**
 * Scratch files (a parsed test report, a one-off summary script) are not project work: they go in .agent/tmp, are never committed, and are
 * removed when the task ends. A real file is never taken for one.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isScratchPath, scratchTarget, cleanScratch } from "../src/scratch.js";
import { AgentTools } from "../src/agentTools.js";

let dir = "";
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
const write = (rel: string, s = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const exists = (rel: string) => fs.existsSync(path.join(dir, rel));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-"));
  git("init", "-q");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("which files are scratch", () => {
  test("the names an agent leaves at the project root", () => {
    for (const p of [".jest-summary.cjs", ".jest-dashboard-report.json", "jest-failures.txt", "jest-report-view.cjs", "jest-report.json", ".tmp-out.txt", "scratch-test.js", "tmp_notes.txt", ".agent/tmp/x.cjs", "__tests__/zz_probe_ab_x.test.ts"]) {
      assert.equal(isScratchPath(p), true, p);
    }
  });
  test("real project files are never taken for one", () => {
    for (const p of ["docs/summary.md", "src/reportCard.tsx", "src/jest-helpers.ts", "package.json", "jest.config.js", "README.md", "src/tmp/a.ts", "reports/q3.json", "__tests__/a.test.ts"]) {
      assert.equal(isScratchPath(p), false, p);
    }
  });
  test("only a new scratch file at the root is redirected, into the scratch folder", () => {
    assert.equal(scratchTarget(".jest-summary.cjs"), ".agent/tmp/.jest-summary.cjs");
    assert.equal(scratchTarget("./jest-report.json"), ".agent/tmp/jest-report.json");
    assert.equal(scratchTarget("src/jest-x.ts"), undefined);
    assert.equal(scratchTarget("../.jest-x"), undefined);
    assert.equal(scratchTarget("package.json"), undefined);
  });
});

describe("cleaning up at the end of a task", () => {
  test("the scratch folder is emptied, and untracked scratch files made during the session are removed", () => {
    write(".agent/tmp/a.cjs");
    write(".jest-report.json");
    write("jest-failures.txt");
    write("src/app.ts");
    const removed = cleanScratch(dir, [], Date.now() - 60_000);
    assert.deepEqual(removed.sort(), [".agent/tmp/a.cjs", ".jest-report.json", "jest-failures.txt"]);
    assert.equal(exists("src/app.ts"), true);
    assert.equal(exists(".agent/tmp/a.cjs"), false);
  });
  test("a file the project already tracks is never removed, whatever it is called", () => {
    write("jest-report.json");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    assert.deepEqual(cleanScratch(dir, ["jest-report.json"], Date.now() - 60_000), []);
    assert.equal(exists("jest-report.json"), true);
  });
  test("a scratch-named file that was there before the session began is left alone", () => {
    write(".jest-old.json");
    assert.deepEqual(cleanScratch(dir, [], Date.now() + 60_000), []);
    assert.equal(exists(".jest-old.json"), true);
  });
  test("nothing to clean is not an error", () => {
    assert.deepEqual(cleanScratch(dir), []);
  });
});

describe("an agent writing a scratch file", () => {
  const tools = () => new AgentTools(dir, { safety: { blockedDirectories: [".git", ".agent", "node_modules"] } } as any, async () => "no");
  test("a new .jest-* file at the root lands in the scratch folder, and the agent is told the real path", async () => {
    const t = tools();
    const out = await t.writeFile(".jest-summary.cjs", "console.log(1)\n");
    assert.equal(exists(".jest-summary.cjs"), false);
    assert.equal(fs.readFileSync(path.join(dir, ".agent/tmp/.jest-summary.cjs"), "utf8"), "console.log(1)\n");
    assert.match(out, /put in \.agent\/tmp\/ instead of the project/);
    assert.match(out, /node \.agent\/tmp\/\.jest-summary\.cjs/);
    assert.deepEqual(t.cleanScratchFiles(), [".agent/tmp/.jest-summary.cjs"]);
    assert.equal(exists(".agent/tmp/.jest-summary.cjs"), false);
  });
  test("an ordinary file is written where it was asked", async () => {
    await tools().writeFile("src/app.ts", "export {};\n");
    assert.equal(exists("src/app.ts"), true);
  });
  test("a scratch-named file that already exists is rewritten in place, not moved", async () => {
    write("jest-notes.txt", "old\n");
    await tools().writeFile("jest-notes.txt", "new\n");
    assert.equal(fs.readFileSync(path.join(dir, "jest-notes.txt"), "utf8"), "new\n");
  });
});

describe("the wiring", () => {
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("scratch files are never committed, by the carry-over or by a phase, and are removed when a task ends or is stopped", () => {
    assert.ok(index.includes('p === "PROGRESS.md" || p === ".agent" || p.startsWith(".agent/") || isScratchPath(p)'));
    assert.equal(index.split("removeScratch(agentTools);").length - 1, 2);
  });
});
