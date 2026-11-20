/**
 * The sandbox is a disposable copy of the project. What matters most is what happens when it is REMOVED: it shares the real
 * node_modules through a link, and a delete that followed the link would destroy the real dependencies. Real git, real temp repos.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSandbox, destroySandbox, pruneStaleSandboxes, sandboxBase, sandboxPrefix } from "../src/healSandbox.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const TEST = "__tests__/p.test.ts";
let repo = "";
const created: string[] = [];

/** What a runner prints for a file with these failing tests. */
const output = (names: string[]) => `FAIL ${TEST}\n${names.map((n) => `  ● ${n}\n    Error: x\n`).join("\n")}\nTests:       ${names.length} failed, 0 passed, ${names.length} total`;
const failing = (...names: string[]) => async () => ({ ok: false, output: output(names) });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "__tests__"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, TEST), "test('a', () => {});\n");
  fs.writeFileSync(path.join(repo, "src/app.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nignored.txt\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  // node_modules is ignored by git, and holds a marker the REAL project must still have after everything
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "marker.txt"), "real dependencies");
});
afterEach(() => {
  for (const s of created.splice(0)) destroySandbox(s as any, repo);
  fs.rmSync(repo, { recursive: true, force: true });
});

async function make(over: Partial<Parameters<typeof createSandbox>[0]> = {}) {
  const r = await createSandbox({ repoRoot: repo, file: TEST, testText: fs.readFileSync(path.join(repo, TEST), "utf8"), expectFailing: ["t1"], run: failing("t1"), ...over });
  if (r.ok) created.push(r.sandbox as any);
  return r;
}
const worktrees = () => git(repo, "worktree", "list", "--porcelain").split(/\r?\n/).filter((l) => l.startsWith("worktree "));

describe("createSandbox: a copy of the project exactly as it is now", () => {
  test("an uncommitted edit to a tracked file is in the sandbox, and the real project is not touched at all", async () => {
    fs.writeFileSync(path.join(repo, "src/app.ts"), "export const x = 2; // edited, not committed\n");
    const statusBefore = git(repo, "status", "--porcelain");
    const stashBefore = git(repo, "stash", "list");
    const r = await make();
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.equal(fs.readFileSync(path.join(r.sandbox.root, "src/app.ts"), "utf8"), "export const x = 2; // edited, not committed\n");
    destroySandbox(r.sandbox, repo);
    assert.equal(git(repo, "status", "--porcelain"), statusBefore, "git status is byte-identical");
    assert.equal(git(repo, "stash", "list"), stashBefore, "no stash entry was made");
    assert.equal(fs.readFileSync(path.join(repo, "src/app.ts"), "utf8"), "export const x = 2; // edited, not committed\n");
  });

  test("an untracked file is copied; an ignored one is not", async () => {
    fs.writeFileSync(path.join(repo, "src/helper.ts"), "export const helper = 1;\n");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "secret-ish");
    const r = await make();
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(fs.existsSync(path.join(r.sandbox.root, "src/helper.ts")), "the untracked helper is there");
    assert.ok(!fs.existsSync(path.join(r.sandbox.root, "ignored.txt")), "an ignored file stays out");
  });

  test("an untracked path the project's own safety check refuses is skipped (.agent holds the tool's own state)", async () => {
    fs.mkdirSync(path.join(repo, ".agent"));
    fs.writeFileSync(path.join(repo, ".agent", "state.json"), "{}");
    const r = await make();
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(!fs.existsSync(path.join(r.sandbox.root, ".agent", "state.json")));
  });

  test("the test text the heal has now is what the sandbox holds, byte for byte (CRLF survives)", async () => {
    const text = "test('a', () => {\r\n  expect(1).toBe(1);\r\n});\r\n";
    const r = await make({ testText: text });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(fs.readFileSync(path.join(r.sandbox.root, TEST)).toString("latin1"), text, "the bytes written are the bytes given");
    assert.ok(fs.readFileSync(path.join(r.sandbox.root, TEST)).includes(Buffer.from("\r\n")), "CRLF is still CRLF");
    assert.equal(r.sandbox.startText, text);
  });

  test("dependencies are shared through a link, so the tests can run", async () => {
    const r = await make();
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.sandbox.links, ["node_modules"]);
    assert.equal(fs.readFileSync(path.join(r.sandbox.root, "node_modules", "marker.txt"), "utf8"), "real dependencies");
    assert.ok(fs.lstatSync(path.join(r.sandbox.root, "node_modules")).isSymbolicLink());
  });
});

describe("the preflight: the sandbox must reproduce the failure", () => {
  test("a different set of failing tests is refused, and nothing is left behind", async () => {
    const before = worktrees().length;
    const r = await make({ run: failing("something else") });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /does not reproduce the failure: expected 1 failing \(t1\), got 1 \(something else\)/);
    assert.equal(worktrees().length, before, "the worktree is gone");
    assert.deepEqual(fs.existsSync(sandboxBase()) ? fs.readdirSync(sandboxBase()).filter((n) => n.startsWith(sandboxPrefix(repo))) : [], []);
    assert.ok(fs.existsSync(path.join(repo, "node_modules", "marker.txt")));
  });
  test("a load error where the real run had failing tests is a mismatch too", async () => {
    const r = await make({ run: async () => ({ ok: false, output: "Test suite failed to run\n  Cannot find module './helper'" }) });
    assert.equal(r.ok, false);
  });
  test("when the real run had nothing to name and the sandbox has nothing to name either, it matches", async () => {
    const r = await make({ expectFailing: [], run: async () => ({ ok: false, output: "Test suite failed to run" }) });
    assert.equal(r.ok, true);
  });
});

describe("destroySandbox: it never deletes through the link", () => {
  test("THE REAL node_modules STILL HAS ITS FILES after the sandbox is removed", async () => {
    const r = await make();
    assert.ok(r.ok);
    if (!r.ok) return;
    const root = r.sandbox.root;
    destroySandbox(r.sandbox, repo);
    assert.ok(!fs.existsSync(root), "the sandbox directory is gone");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "marker.txt"), "utf8"), "real dependencies", "the real dependencies are untouched");
    assert.ok(!worktrees().some((w) => w.includes(path.basename(root))), "git no longer lists it");
  });

  test("a link made INSIDE the sandbox (by code the agent ran) is not followed either", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-outside-"));
    fs.writeFileSync(path.join(outside, "precious.txt"), "do not delete");
    try {
      const r = await make();
      assert.ok(r.ok);
      if (!r.ok) return;
      fs.symlinkSync(outside, path.join(r.sandbox.root, "src", "evil"), process.platform === "win32" ? "junction" : "dir");
      destroySandbox(r.sandbox, repo);
      assert.ok(!fs.existsSync(r.sandbox.root));
      assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "do not delete");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a second destroy does nothing and does not throw", async () => {
    const r = await make();
    assert.ok(r.ok);
    if (!r.ok) return;
    destroySandbox(r.sandbox, repo);
    assert.doesNotThrow(() => destroySandbox(r.sandbox, repo));
    assert.ok(fs.existsSync(path.join(repo, "node_modules", "marker.txt")));
  });
});

describe("pruneStaleSandboxes: what a killed run left behind", () => {
  test("a sandbox nobody is using is removed (real node_modules intact); one this process is using is not", async () => {
    const live = await make();
    assert.ok(live.ok);
    if (!live.ok) return;
    // what a killed run leaves: a registered worktree, with the shared link, that no process is using
    const dead = path.join(sandboxBase(), `${sandboxPrefix(repo)}dead0`);
    fs.mkdirSync(sandboxBase(), { recursive: true });
    git(repo, "worktree", "add", "--detach", dead, "HEAD");
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(dead, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    assert.equal(pruneStaleSandboxes(repo), 1);
    assert.ok(!fs.existsSync(dead), "the abandoned one is gone");
    assert.ok(fs.existsSync(live.sandbox.root), "the one in use is left alone");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "marker.txt"), "utf8"), "real dependencies");
  });
  test("another project's sandboxes are never touched", async () => {
    const other = path.join(sandboxBase(), "ffffffff-someoneelse");
    fs.mkdirSync(other, { recursive: true });
    try {
      assert.equal(pruneStaleSandboxes(repo), 0);
      assert.ok(fs.existsSync(other));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("what it refuses to do", () => {
  test("a project that is not at the top of its git repository", async () => {
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    const r = await createSandbox({ repoRoot: path.join(repo, "packages", "app"), file: TEST, testText: "x", expectFailing: [], run: failing() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not at the top of its git repository/);
  });
  test("a test path that escapes the project", async () => {
    const r = await createSandbox({ repoRoot: repo, file: "../outside.test.ts", testText: "x", expectFailing: [], run: failing() });
    assert.equal(r.ok, false);
  });
});
