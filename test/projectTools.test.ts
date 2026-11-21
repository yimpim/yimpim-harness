/**
 * Use what the project has before anything new. The Editor is told which test runner and scripts exist; `npx` for a program that is not installed is declined
 * with what IS installed, without interrupting the person; asking for the same program again asks a person.
 */
import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTools, toolsHint, missingTool, missingToolMessage } from "../src/projectTools.js";
import { buildContextualSystemPrompt } from "../src/agentLoop.js";
import { AgentTools } from "../src/agentTools.js";

let root = "";
const w = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), s);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ptools-"));
  w("package.json", JSON.stringify({ scripts: { test: "jest", lint: "eslint .", start: "expo start" } }));
  for (const b of ["jest", "jest.cmd", "tsc", "eslint", "expo"]) w(`node_modules/.bin/${b}`, "");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("what the project has", () => {
  test("scripts, the test script and the installed programs (without .cmd duplicates)", () => {
    const t = projectTools(root);
    assert.equal(t.testScript, "jest");
    assert.deepEqual(Object.keys(t.scripts), ["test", "lint", "start"]);
    assert.deepEqual(t.bins, ["eslint", "expo", "jest", "tsc"]);
  });
  test("the hint names the runner and how to run one file; nothing for a project with neither package.json nor installed programs", () => {
    const h = toolsHint(root);
    assert.match(h, /^\[WHAT THIS PROJECT ALREADY HAS/);
    assert.match(h, /- Tests: `npm test` runs `jest`\. Run one file with `npx jest <file>`\./);
    assert.match(h, /- Installed programs: jest, tsc, eslint, expo\./);
    assert.match(h, /- package.json scripts: test, lint, start\./);
    assert.equal(toolsHint(fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))), "");
  });
  test("the editing agents get it in their instructions; the others do not", () => {
    const cfg: any = { prompts: { systemPersona: "P" } };
    for (const a of ["EDITOR", "REPAIR"]) assert.match(buildContextualSystemPrompt(a, cfg, root), /Run one file with `npx jest <file>`/);
    for (const a of ["DISCOVERY", "PLANNER"]) assert.ok(!buildContextualSystemPrompt(a, cfg, root).includes("WHAT THIS PROJECT ALREADY HAS"));
  });
});

describe("a program that is not installed", () => {
  test("npx, pnpm dlx, yarn dlx and bunx for something not in node_modules/.bin; never for something that is, a path, or another program", () => {
    assert.equal(missingTool(["npx", "vitest", "run", "x"], root), "vitest");
    assert.equal(missingTool(["npx", "--yes", "left-padz"], root), "left-padz");
    assert.equal(missingTool(["pnpm", "dlx", "@scope/tool@1.2.3"], root), "tool");
    assert.equal(missingTool(["yarn", "dlx", "create-thing"], root), "create-thing");
    assert.equal(missingTool(["bunx", "x"], root), "x");
    assert.equal(missingTool(["npx", "jest", "f"], root), undefined);
    assert.equal(missingTool(["npx.cmd", "tsc"], root), undefined);
    assert.equal(missingTool(["npx", "./local/script.js"], root), undefined);
    assert.equal(missingTool(["node", "x.js"], root), undefined);
    assert.equal(missingTool(["npm", "test"], root), undefined);
  });
  test("the message says why, what the project has, and not to ask again", () => {
    const m = missingToolMessage("vitest", root);
    assert.match(m, /^Not run — `vitest` is not installed in this project, so `npx` would download it and run code nobody has seen\./);
    assert.match(m, /This project's tests run with `npm test` \(`jest`\); run one file with `npx jest <file>`\./);
    assert.match(m, /Already installed: jest, tsc, eslint, expo\./);
    assert.match(m, /Use one of those instead, or report it as a manual step\. Do not ask for this program again\.$/);
  });
});

describe("in the harness", () => {
  const config: any = { prompts: { systemPersona: "P" } };
  const savedFile = process.env.YIMPIM_APPROVALS_FILE;
  const ttyIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const ttyOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  before(() => {
    process.env.YIMPIM_APPROVALS_FILE = path.join(os.tmpdir(), `ptools-approvals-${process.pid}.json`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  after(() => {
    if (savedFile === undefined) delete process.env.YIMPIM_APPROVALS_FILE;
    else process.env.YIMPIM_APPROVALS_FILE = savedFile;
    if (ttyIn) Object.defineProperty(process.stdin, "isTTY", ttyIn);
    else delete (process.stdin as any).isTTY;
    if (ttyOut) Object.defineProperty(process.stdout, "isTTY", ttyOut);
    else delete (process.stdout as any).isTTY;
  });

  test("the first time: declined with what the project has, and the person is NOT asked; the second time for the same program a person is asked", async () => {
    const asked: string[] = [];
    const t = new AgentTools(root, config, async (q) => (asked.push(q), "no"));
    const first = await t.runProjectCommand({ command: "npx vitest run __tests__/_focus --reporter=basic", purpose: "run the focus test" });
    assert.match(first, /^Not run — `vitest` is not installed in this project/);
    assert.match(first, /npx jest <file>/);
    assert.equal(asked.length, 0, "nothing for a person to decide");
    const second = await t.runProjectCommand({ command: "npx vitest run __tests__/_focus", purpose: "again" });
    assert.equal(asked.length, 1, "insisting on it asks a person");
    assert.match(second, /declined/);
  });

  test("a program that IS installed is not declined this way (npx jest goes through the normal path)", async () => {
    const asked: string[] = [];
    const t = new AgentTools(root, config, async (q) => (asked.push(q), "no"));
    const out = await t.runProjectCommand({ command: "npx jest __tests__/a.test.ts", purpose: "run it" });
    assert.ok(!/is not installed in this project/.test(out), out.slice(0, 120));
  });

  test("no judge is asked about a program that is not installed (three model calls would be wasted)", async () => {
    const t = new AgentTools(root, config, async () => "no");
    let judged = 0;
    t.setCommandReviewer(async () => (judged++, { allow: true, why: "fine" }), { coversElevated: true });
    const out = await t.runProjectCommand({ command: "npx vitest --version", purpose: "x" });
    assert.match(out, /^Not run — .vitest. is not installed in this project/);
    assert.equal(judged, 0);
  });
});
