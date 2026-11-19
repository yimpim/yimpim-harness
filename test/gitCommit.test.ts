import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitOnly, type Git } from "../src/gitCommit.js";

const run = promisify(execFile);
let dir = "";
const git: Git = async (args) => (await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: dir, maxBuffer: 20 * 1024 * 1024 })).stdout;
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const files = async (rev = "HEAD") => (await git(["show", "--name-only", "--format=", rev])).split(/\r?\n/).filter(Boolean).sort();
const staged = async () => (await git(["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean).sort();

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitcommit-"));
  await git(["init", "-q"]);
  write("a.ts", "a1\n");
  write("b.ts", "b1\n");
  write("gone.ts", "bye\n");
  write(".gitignore", "ignored.log\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a commit takes only the files it is given", () => {
  test("something the person already staged is not swept into it, and stays staged", async () => {
    write("a.ts", "a2\n");
    write("b.ts", "b2\n");
    await git(["add", "b.ts"]); // the person's own, staged before the phase committed
    const done = await commitOnly(git, ["a.ts"], "phase");
    assert.deepEqual(done, ["a.ts"]);
    assert.deepEqual(await files(), ["a.ts"]);
    assert.deepEqual(await staged(), ["b.ts"], "the person's staged file is still waiting for them");
  });

  test("a plain commit would have taken it (the problem this prevents)", async () => {
    write("a.ts", "a2\n");
    write("b.ts", "b2\n");
    await git(["add", "b.ts"]);
    await git(["add", "a.ts"]);
    await git(["commit", "-q", "-m", "plain"]);
    assert.deepEqual(await files(), ["a.ts", "b.ts"]);
  });

  test("new, changed and deleted files are all committed", async () => {
    write("new.ts", "n\n");
    write("a.ts", "a2\n");
    fs.rmSync(path.join(dir, "gone.ts"));
    const done = await commitOnly(git, ["new.ts", "a.ts", "gone.ts"], "phase");
    assert.deepEqual([...done].sort(), ["a.ts", "gone.ts", "new.ts"]);
    assert.deepEqual(await files(), ["a.ts", "gone.ts", "new.ts"]);
    assert.equal((await git(["status", "--porcelain"])).trim(), "");
  });

  test("an unrelated edit the person has not staged is left alone", async () => {
    write("a.ts", "a2\n");
    write("b.ts", "b2\n");
    await commitOnly(git, ["a.ts"], "phase");
    assert.match(await git(["status", "--porcelain"]), / M b\.ts/);
  });
});

describe("a path that cannot be staged does not fail the commit", () => {
  test("an ignored file is skipped with a warning and the rest is committed", async () => {
    write("a.ts", "a2\n");
    write("ignored.log", "noise\n");
    const warnings: string[] = [];
    const done = await commitOnly(git, ["ignored.log", "a.ts"], "phase", (l) => warnings.push(l));
    assert.deepEqual(done, ["a.ts"]);
    assert.ok(warnings.some((w) => w.includes("ignored.log")));
    assert.deepEqual(await files(), ["a.ts"]);
  });
  test("only ignored paths: nothing is committed and nothing throws", async () => {
    write("ignored.log", "noise\n");
    assert.deepEqual(await commitOnly(git, ["ignored.log"], "phase"), []);
  });
});

describe("nothing to commit is not an error", () => {
  test("a path whose content is unchanged", async () => {
    assert.deepEqual(await commitOnly(git, ["a.ts"], "phase"), []);
    assert.equal((await git(["log", "--oneline"])).trim().split("\n").length, 1);
  });
  test("an empty list", async () => {
    assert.deepEqual(await commitOnly(git, [], "phase"), []);
  });
});

describe("a very long list of files still commits", () => {
  test("past the command-line size limit the paths go in a file, and the temp file is cleaned up", async () => {
    const names: string[] = [];
    for (let i = 0; i < 400; i++) {
      const rel = `src/generated/some/deeply/nested/folder/structure/to/make/it/long/file_number_${i}_with_a_long_name.ts`;
      write(rel, `export const n${i} = ${i};\n`);
      names.push(rel);
    }
    write("b.ts", "b2\n");
    await git(["add", "b.ts"]);
    assert.ok(names.join("\n").length > 20_000, "long enough to use the file route");
    const done = await commitOnly(git, names, "big phase");
    assert.equal(done.length, 400);
    assert.equal((await files()).length, 400);
    assert.deepEqual(await staged(), ["b.ts"], "still only the given files");
    const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`yimpim-commit-${process.pid}-`));
    assert.deepEqual(left, []);
  });
});

describe("the wiring", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("a phase, a setup phase and the carry-over commit all go through commitOnly, none through a bare commit", () => {
    assert.equal((src.match(/commitOnly\(/g) ?? []).length >= 3, true);
    assert.match(src, /import \{ commitOnly \} from "\.\/gitCommit\.js";/);
    // Every commit message the harness writes for a phase or a carry-over is the argument of commitOnly, never of a bare git commit.
    for (const m of src.matchAll(/\$\{config\.git\.commitPrefix\}: (completed phase|carry over)/g)) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 260), m.index);
      assert.match(before, /commitOnly\(/, `"${m[1]}" is committed through commitOnly`);
      assert.doesNotMatch(before, /"commit",\s*"-m",\s*$/);
    }
  });
});
