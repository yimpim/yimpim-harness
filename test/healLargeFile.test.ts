/**
 * The case that kept costing money: a very large test file, dozens of tests failing for ONE reason (a mock that no longer provides
 * something the code now uses). The worker must see that one cause, not eighty stack traces and the whole file, and fix it with a
 * small edit, not by writing the whole file out again.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { healTests, failureText } from "../src/testHeal.js";

let dir = "";
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const TEST = "__tests__/dashboard.test.ts";

const MOCK = [
  "jest.mock('../src/storage/secureStore', () => ({",
  "  getSession: async () => mockDashboardSession,",
  "  listSessions: async () => [mockDashboardSession],",
  "  clearSession: async () => undefined,",
  "}));",
].join("\n");

function build(extra = 3000) {
  write("src/storage/secureStore.ts", "export async function getSession() {}\nexport async function getSupabaseRefreshToken() {}\nexport async function getSupabaseAccessToken() {}\n");
  write("__tests__/archiveSummary.test.ts", "jest.mock('../src/storage/secureStore', () => ({\n  getSupabaseRefreshToken: async () => 'mock-refresh-token',\n}));\n");
  const app = [
    "import { getSupabaseRefreshToken } from '../src/storage/secureStore';",
    ...Array.from({ length: 10 }, (_, i) => `// app line ${i + 2}`),
    "void Promise.all([getSupabaseRefreshToken()]);",
  ].join("\n");
  write("app/dashboard.tsx", app);
  const filler = Array.from({ length: extra }, (_, i) => `it('case ${i}', () => { expect(render(${i})).toBeTruthy(); });`).join("\n");
  write(TEST, ["import React from 'react';", MOCK, "", "describe('Dashboard', () => {", filler, "});"].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
}

/** Passes once the mock provides the missing function; until then every test fails the same way. */
const run = async (root: string, files: string[]) => {
  const text = fs.readFileSync(path.join(root, TEST), "utf8");
  if (text.includes("getSupabaseRefreshToken")) return { ok: true, output: "PASS " + TEST };
  const one = (i: number) =>
    `  ● Dashboard › case ${i}\n\n    TypeError: (0 , _secureStore.getSupabaseRefreshToken) is not a function\n\n    > 12 | void Promise.all([getSupabaseRefreshToken()]);\n\n      at app/dashboard.tsx:12:46\n      at react_stack_bottom_frame (node_modules/react-test-renderer/cjs/react-test-renderer.development.js:15755:20)\n      at render (${TEST}:20:16)\n`;
  void files;
  return { ok: false, output: `FAIL ${TEST}\n` + Array.from({ length: 80 }, (_, i) => one(i)).join("\n") + "\nTests: 80 failed, 84 passed, 164 total" };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "healbig-"));
  build();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what the worker is told", () => {
  test("one cause with its count and its source line, not eighty traces", () => {
    const raw = "FAIL " + TEST + "\n" + Array.from({ length: 80 }, (_, i) => `  ● Dashboard › case ${i}\n    TypeError: (0 , _secureStore.getSupabaseRefreshToken) is not a function\n      at app/dashboard.tsx:12:46\n`).join("\n");
    const t = failureText(raw, dir, TEST);
    assert.match(t, /80 failures, 1 distinct cause/);
    assert.match(t, /\[80×\] TypeError: \(0 , _secureStore\.getSupabaseRefreshToken\) is not a function/);
    assert.match(t, /first points at app\/dashboard\.tsx:12/);
    assert.match(t, /RAW OUTPUT \(start\)/);
    assert.ok(t.length < 6500, `${t.length} chars for ${raw.length} of raw output`);
  });
  test("output with no readable cause falls back to the raw tail, as before", () => {
    assert.equal(failureText("nothing useful\nat all", dir, TEST), "nothing useful\nat all");
  });
});

describe("a 3,000-line test file with one stale mock is healed with a small edit", () => {
  test("the worker searches how others mock it, then adds the two missing functions with one edit", async () => {
    const before = read(TEST);
    assert.ok(before.split("\n").length > 3000);
    const seenPrompts: string[] = [];
    let turn = 0;
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (messages) => {
        turn++;
        const prompt = messages.map((m) => m.content).join("\n");
        seenPrompts.push(prompt);
        if (turn === 1) return JSON.stringify({ need: [{ search: "getSupabaseRefreshToken" }] });
        return JSON.stringify({
          verdict: "stale-test",
          reason: "the mock of secureStore lacks the two token functions the dashboard now calls",
          edits: [{ find: "  clearSession: async () => undefined,\n}));", replace: "  clearSession: async () => undefined,\n  getSupabaseRefreshToken: async () => 'mock-refresh-token',\n  getSupabaseAccessToken: async () => 'mock-access-token',\n}));" }],
        });
      },
    });
    assert.equal(report.results[0].status, "healed", report.results[0].note);
    assert.equal(report.results[0].attempts, 1);

    // The first prompt: the cause, its count and its source line, the file in parts, and nowhere near the whole file.
    const first = seenPrompts[0];
    assert.match(first, /80 failures, 1 distinct cause/);
    assert.match(first, /app\/dashboard\.tsx:12/);
    assert.match(first, /LARGE FILE/);
    assert.match(first, /jest\.mock\('\.\.\/src\/storage\/secureStore'/);
    assert.ok(first.length < before.length / 2, `prompt ${first.length} chars vs file ${before.length}`);
    // The search result reached the worker.
    assert.match(seenPrompts[1], /--- search "getSupabaseRefreshToken"/);
    assert.match(seenPrompts[1], /archiveSummary\.test\.ts:2:/);

    // The result: the two functions added, every other line untouched.
    const after = read(TEST);
    assert.match(after, /getSupabaseRefreshToken: async/);
    assert.match(after, /getSupabaseAccessToken: async/);
    assert.equal(after.split("\n").length, before.split("\n").length + 2);
    assert.equal(after.replace(/  getSupabase\w+Token: async \(\) => '[\w-]+',\n/g, ""), before);
  });

  test("a model that returns the whole large file is told to use edits, and cannot overwrite the file that way", async () => {
    const before = read(TEST);
    let turn = 0;
    const replies: string[] = [];
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (messages) => {
        turn++;
        if (turn === 1) return JSON.stringify({ verdict: "stale-test", reason: "r", test: "// whole file\n" });
        replies.push(messages[messages.length - 1].content);
        return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "  clearSession: async () => undefined,", replace: "  clearSession: async () => undefined,\n  getSupabaseRefreshToken: async () => 'x'," }] });
      },
    });
    assert.match(replies[0], /do not return it whole/);
    assert.equal(report.results[0].status, "healed");
    assert.ok(read(TEST).length >= before.length, "the file was never replaced by the short answer");
  });

  test("an edit that does not match is explained, and the file is untouched until one does", async () => {
    const before = read(TEST);
    let turn = 0;
    const feedback: string[] = [];
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async (messages) => {
        turn++;
        if (turn === 1) return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "this text is not in the file", replace: "x" }] });
        feedback.push(messages[messages.length - 1].content);
        return JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "  clearSession: async () => undefined,", replace: "  clearSession: async () => undefined,\n  getSupabaseRefreshToken: async () => 'x'," }] });
      },
    });
    assert.match(feedback[0], /Not applied: edit 1: the text to find was not found/);
    assert.equal(report.results[0].status, "healed");
    assert.notEqual(read(TEST), before);
  });

  test("a failed edit repeated is given up on, and the file is put back", async () => {
    const before = read(TEST);
    const report = await healTests({
      repoRoot: dir,
      run,
      settle: false, // the worker's own verdict, before the later step that sorts what is left
      call: async () => JSON.stringify({ verdict: "stale-test", reason: "r", edits: [{ find: "nope nope", replace: "x" }] }),
    });
    assert.equal(report.results[0].status, "unhealed");
    assert.match(report.results[0].note, /its edits could not be applied/);
    assert.equal(read(TEST), before);
  });
});

describe("a small test file still works the way it did", () => {
  test("the whole corrected file may be returned", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "healsmall-"));
    build(5);
    const report = await healTests({
      repoRoot: dir,
      run,
      call: async () => JSON.stringify({ verdict: "stale-test", reason: "r", test: read(TEST).replace("clearSession: async () => undefined,", "clearSession: async () => undefined,\n  getSupabaseRefreshToken: async () => 'x',") }),
    });
    assert.equal(report.results[0].status, "healed");
  });
});

