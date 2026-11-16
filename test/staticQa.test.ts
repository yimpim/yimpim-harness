import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectChangeSet,
  deterministicSignals,
  staticQaReview,
  splitDiffByFile,
  mergeRequirementFindings,
  isHarnessArtifactPath,
  truncateLongDiffLines,
  ChangeSet,
} from "../src/staticQa.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeTempRepo(): Promise<string> {
  const dir = await makeTempDir("yimpim-staticqa-test-");
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "test"]);
  return dir;
}

describe("collectChangeSet", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test("a clean repo with a committed file reports isEmpty", async () => {
    await fs.writeFile(path.join(repo, "index.html"), "<html></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const change = await collectChangeSet(repo);
    assert.equal(change.isEmpty, true);
    assert.deepEqual(change.modified, []);
    assert.deepEqual(change.added, []);
  });

  test("modifying a tracked file is reflected in the diff, not isEmpty", async () => {
    const file = path.join(repo, "index.html");
    await fs.writeFile(file, "<html><body>old</body></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(file, "<html><body>new</body></html>\n");

    const change = await collectChangeSet(repo);
    assert.equal(change.isEmpty, false);
    assert.deepEqual(change.modified, ["index.html"]);
    assert.match(change.diff, /-.*old/);
    assert.match(change.diff, /\+.*new/);
  });

  test("a brand-new untracked file counts as added, with synthesized diff content", async () => {
    await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(path.join(repo, "new-feature.ts"), "export const x = 1;\n");

    const change = await collectChangeSet(repo);
    assert.equal(change.isEmpty, false);
    assert.deepEqual(change.added, ["new-feature.ts"]);
    assert.match(change.diff, /new file/);
    assert.match(change.diff, /export const x = 1;/);
  });

  test("vendor/build noise is excluded from the change set entirely — lock files are tracked separately, not excluded the same way", async () => {
    await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.mkdir(path.join(repo, "node_modules", "somepkg"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", "somepkg", "index.js"), "module.exports = {};\n");
    await fs.writeFile(path.join(repo, "package-lock.json"), "{}\n");
    await fs.writeFile(path.join(repo, "real.ts"), "export const y = 2;\n");

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.added, ["real.ts"], "node_modules/ must never reach the reviewer, and package-lock.json's own diff must not either");
    assert.deepEqual(change.lockFiles, ["package-lock.json"], "but its PRESENCE must be tracked, not silently dropped like node_modules/");
  });

  test("a lock-file-only change (no package.json bump) is NOT reported as isEmpty", async () => {
    await fs.writeFile(path.join(repo, "package.json"), '{"name":"x","dependencies":{}}\n');
    await fs.writeFile(path.join(repo, "package-lock.json"), '{"a":1}\n');
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    // Simulates `npm install` regenerating the lock file with no version
    // bump in package.json itself (e.g. a transitive dependency resolved) —
    // this used to be invisible to every gate, reported as "no changes
    // produced" even though a real dependency install genuinely happened.
    await fs.writeFile(path.join(repo, "package-lock.json"), '{"a":2}\n');

    const change = await collectChangeSet(repo);
    assert.equal(change.isEmpty, false, "a lock-file-only change is a real change, not nothing");
    assert.deepEqual(change.modified, []);
    assert.deepEqual(change.lockFiles, ["package-lock.json"]);
  });

  test("a pre-existing dirty lock file (excludePaths) is excluded, same as any other pre-existing dirty file", async () => {
    await fs.writeFile(path.join(repo, "package-lock.json"), '{"a":1}\n');
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "package-lock.json"), '{"a":2}\n');

    const change = await collectChangeSet(repo, new Set(["package-lock.json"]));
    assert.deepEqual(change.lockFiles, []);
    assert.equal(change.isEmpty, true);
  });

  // The lock-file fix above was found against an npm project, but nothing
  // about "a dependency task's own lock file is invisible to every gate" is
  // npm-specific — the same gap exists for any other ecosystem's lock file.
  // LOCK_FILE_RE is derived from MANIFEST_REGISTRY (orchestrator.ts), not a
  // second hand-maintained list, specifically so this covers every stack the
  // dependency-install gate already knows about, not just the one that
  // happened to surface the bug.
  test("lock files from OTHER ecosystems get the same treatment, not just npm's", async () => {
    await fs.writeFile(path.join(repo, "pubspec.yaml"), "name: x\ndependencies:\n");
    await fs.writeFile(path.join(repo, "composer.json"), '{"require":{}}\n');
    await fs.writeFile(path.join(repo, "Gemfile"), "source 'https://rubygems.org'\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(path.join(repo, "pubspec.lock"), "packages: {}\n");
    await fs.writeFile(path.join(repo, "composer.lock"), '{"packages":[]}\n');
    await fs.writeFile(path.join(repo, "Gemfile.lock"), "GEM\n");

    const change = await collectChangeSet(repo);
    assert.equal(change.isEmpty, false);
    assert.deepEqual(
      [...change.lockFiles!].sort(),
      ["Gemfile.lock", "composer.lock", "pubspec.lock"],
      "Flutter/PHP/Ruby lock files must be tracked the same way package-lock.json is"
    );
    assert.deepEqual(change.modified, [], "none of these lock files' own diffs should be reviewed");
  });

  // This is the exact bug found and fixed in production: without this,
  // a missing/broken git repo was silently reported as isEmpty: true —
  // byte-for-byte indistinguishable from the editor genuinely doing nothing.
  // This is the exact bug found and fixed in production: a rename line from
  // `git status --porcelain` reads "old/path -> new/path", and treating that
  // whole string as one literal path (rather than parsing it) fed git diff a
  // pathspec that matches nothing — silently dropping the renamed file's
  // actual content changes from the change set the reviewer sees.
  test("a pure rename is reported under renamed, not smuggled into modified as a literal 'a -> b' string", async () => {
    await fs.writeFile(path.join(repo, "old.ts"), "export const x = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.rename(path.join(repo, "old.ts"), path.join(repo, "new.ts"));
    await git(repo, ["add", "-A"]);

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.modified, []);
    assert.deepEqual(change.renamed, [{ from: "old.ts", to: "new.ts" }]);
    assert.equal(change.isEmpty, false);
  });

  test("a rename with edited content surfaces the actual diff of what changed", async () => {
    // Enough shared content for git's similarity heuristic to recognize this
    // as a rename rather than an unrelated delete+add — a one-line file with
    // its only line changed scores as 0% similar by git's own reckoning.
    const original = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
    const edited = original.replace("line5 = 5", "line5 = 999");

    await fs.writeFile(path.join(repo, "old.ts"), original);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.rm(path.join(repo, "old.ts"));
    await fs.writeFile(path.join(repo, "new.ts"), edited);
    await git(repo, ["add", "-A"]);

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.renamed, [{ from: "old.ts", to: "new.ts" }]);
    assert.match(change.diff, /-.*line5 = 5;/);
    assert.match(change.diff, /\+.*line5 = 999;/);
  });

  test("a tracked file emptied to zero bytes is reported under emptied", async () => {
    const file = path.join(repo, "obsolete.ts");
    await fs.writeFile(file, "export const gone = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(file, "");

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.emptied, ["obsolete.ts"]);
    assert.deepEqual(change.modified, ["obsolete.ts"], "an emptied file is still a working-tree modification");
  });

  test("a file emptied to whitespace only counts as emptied, not just 0 bytes", async () => {
    const file = path.join(repo, "obsolete.ts");
    await fs.writeFile(file, "export const gone = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(file, "   \n\t\n");

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.emptied, ["obsolete.ts"]);
  });

  test("a file that still has content is not reported under emptied", async () => {
    const file = path.join(repo, "live.ts");
    await fs.writeFile(file, "export const gone = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(file, "export const kept = 2;\n");

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.emptied, []);
  });

  test("a directory that is not a git repository throws, rather than reporting isEmpty", async () => {
    const dir = await makeTempDir("yimpim-staticqa-nogit-");
    await fs.writeFile(path.join(dir, "index.html"), "<html></html>\n");

    await assert.rejects(
      () => collectChangeSet(dir),
      /git status failed/,
      "a missing git repo must surface as an error, never as a silent empty diff"
    );
  });

  // The exact bug this fixes: without excludePaths, a user's own unrelated
  // in-progress edit (present before the phase even started) got reviewed
  // as if it were part of THIS phase's work, every single phase of a task.
  test("excludePaths drops a pre-existing dirty file from modified/added and from the diff text", async () => {
    await fs.writeFile(path.join(repo, "notes.txt"), "old notes\n");
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    // The user's own pre-existing, unrelated edit.
    await fs.writeFile(path.join(repo, "notes.txt"), "the user was already editing this\n");
    // This phase's real work.
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(repo, "new-file.ts"), "export const b = 1;\n");

    const change = await collectChangeSet(repo, new Set(["notes.txt"]));
    assert.deepEqual(change.modified, ["app.ts"]);
    assert.deepEqual(change.added, ["new-file.ts"]);
    assert.doesNotMatch(change.diff, /notes/, "the excluded file's content must never reach the diff the reviewer sees");
    assert.match(change.diff, /export const a = 2/);
  });

  test("excludePaths dropping every changed file reports isEmpty, not a false 'nothing happened'", async () => {
    await fs.writeFile(path.join(repo, "notes.txt"), "old\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "notes.txt"), "new\n");

    const change = await collectChangeSet(repo, new Set(["notes.txt"]));
    assert.equal(change.isEmpty, true);
  });

  test("an untracked excluded file is also dropped, not just tracked modifications", async () => {
    await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    await fs.writeFile(path.join(repo, "scratch.txt"), "the user's own untracked scratch file\n");
    await fs.writeFile(path.join(repo, "real.ts"), "export const y = 2;\n");

    const change = await collectChangeSet(repo, new Set(["scratch.txt"]));
    assert.deepEqual(change.added, ["real.ts"]);
  });

  test("with no excludePaths given, behavior is unchanged (defaults to excluding nothing)", async () => {
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 2;\n");

    const change = await collectChangeSet(repo);
    assert.deepEqual(change.modified, ["app.ts"]);
  });
});

describe("deterministicSignals", () => {
  const changeWith = (diff: string, deleted: string[] = []): ChangeSet => ({
    diff, modified: [], added: [], deleted, renamed: [], isEmpty: false,
  });

  test("flags a Kotlin TODO() stub as a concern, not a hard defect", () => {
    const change = changeWith("+fun foo() { TODO() }\n");
    const signals = deterministicSignals(change);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "concern");
  });

  test("does not flag a TODO() mentioned only in a comment", () => {
    const change = changeWith("+// TODO() explain this later\n");
    assert.equal(deterministicSignals(change).length, 0);
  });

  test("does not flag a TODO() inside a bare string-literal statement", () => {
    const change = changeWith('+"TODO() placeholder for the fixture below";\n');
    assert.equal(deterministicSignals(change).length, 0);
  });

  // The literal guard is deliberately crude (a regex can't parse code), so a
  // TODO() that isn't a leading comment or a bare string start — even one
  // embedded in an assignment — is a known false positive the model reviewer
  // is expected to clear, not something this cheap pre-filter can rule out.
  test("still flags a TODO() embedded mid-line, e.g. inside an assignment", () => {
    const change = changeWith('+const s = "TODO()";\n');
    assert.equal(deterministicSignals(change).length, 1);
  });

  test("flags deleted test files as a hard defect", () => {
    const change = changeWith("", ["src/__tests__/foo.test.ts"]);
    const signals = deterministicSignals(change);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "defect");
    assert.match(signals[0].message, /Test files were deleted/);
  });

  // Fixed alongside the rename-parsing bug: a renamed test file used to be
  // indistinguishable from one that was actually deleted, since the old
  // "smuggle a rename into modified/deleted" parsing put the old path
  // straight into `deleted`. It now never lands there at all.
  test("a renamed test file (coverage preserved, just relocated) is not flagged as deleted", () => {
    const change: ChangeSet = {
      diff: "",
      modified: [],
      added: [],
      deleted: [],
      renamed: [{ from: "src/__tests__/foo.test.ts", to: "src/__tests__/bar.test.ts" }],
      isEmpty: false,
    };
    const signals = deterministicSignals(change);
    assert.deepEqual(signals, []);
  });

  test("flags a large net deletion as a concern", () => {
    const removed = Array.from({ length: 401 }, (_, i) => `-line ${i}`).join("\n");
    const change = changeWith(removed + "\n+one new line\n");
    const signals = deterministicSignals(change);
    assert.ok(signals.some((s) => /Large net deletion/.test(s.message)));
  });

  test("a normal, balanced diff raises no signals", () => {
    const change = changeWith("-const old = 1;\n+const updated = 1;\n");
    assert.deepEqual(deterministicSignals(change), []);
  });
});

describe("staticQaReview", () => {
  const emptyChange: ChangeSet = { diff: "+const x = 1;\n", modified: ["a.ts"], added: [], deleted: [], renamed: [], isEmpty: false };

  test("a 'missing' requirement from the model marks defectFound", async () => {
    const review = await staticQaReview(
      "Add a footer",
      emptyChange,
      { ask: async () => JSON.stringify({
          requirements: [{ requirement: "Add a footer", status: "missing", evidence: "no <footer> present" }],
          concerns: [],
          summary: "not implemented",
        }) },
      "context"
    );
    assert.equal(review.defectFound, true);
    assert.equal(review.findings[0].status, "missing");
  });

  test("a 'missing' verdict whose own evidence says the file isn't in the diff is downgraded to uncertain", async () => {
    // Regression: the reviewer only ever sees FILES TOUCHED / CHANGE SET, so
    // a requirement targeting an untouched file is "absence of proof" (the
    // file might already be correct and simply didn't need editing), not
    // "proof of absence". A reviewer that marks it "missing" anyway usually
    // says so in its own words — this is exactly that self-contradiction.
    const review = await staticQaReview(
      "Fix Kotlin compilation errors in MutationLabViewModel",
      emptyChange,
      { ask: async () => JSON.stringify({
          requirements: [{
            requirement: "Fix Kotlin compilation errors in MutationLabViewModel",
            status: "missing",
            evidence: "No MutationLabViewModel.kt edit appears in the diff. Since the stated requirement " +
              "is not present in FILES TOUCHED, the fix code is absent.",
          }],
          concerns: [],
          summary: "not implemented",
        }) },
      "context"
    );
    assert.equal(review.findings[0].status, "uncertain");
    assert.equal(review.defectFound, false);
  });

  test("a 'missing' verdict backed by an actual line from the diff is left as a real defect", async () => {
    const review = await staticQaReview(
      "Add a footer",
      emptyChange,
      { ask: async () => JSON.stringify({
          requirements: [{
            requirement: "Add a footer",
            status: "missing",
            evidence: "a.ts still has the placeholder `const x = 1;` with no <footer> element added.",
          }],
          concerns: [],
          summary: "not implemented",
        }) },
      "context"
    );
    assert.equal(review.findings[0].status, "missing");
    assert.equal(review.defectFound, true);
  });

  test("only 'satisfied'/'uncertain' never marks defectFound", async () => {
    const review = await staticQaReview(
      "Add a footer",
      emptyChange,
      { ask: async () => JSON.stringify({
          requirements: [
            { requirement: "Add a footer", status: "satisfied", evidence: "footer present" },
            { requirement: "Match brand colors", status: "uncertain", evidence: "cannot tell from source" },
          ],
          concerns: [],
          summary: "looks fine",
        }) },
      "context"
    );
    assert.equal(review.defectFound, false);
  });

  test("a deterministic defect (e.g. a deleted test file) forces defectFound regardless of the model", async () => {
    const change: ChangeSet = { diff: "", modified: [], added: [], deleted: ["a.test.ts"], renamed: [], isEmpty: false };
    const review = await staticQaReview(
      "Add a footer",
      change,
      { ask: async () => JSON.stringify({ requirements: [], concerns: [], summary: "all good" }) },
      "context"
    );
    assert.equal(review.defectFound, true, "a deleted test file must force a defect even if the model saw nothing wrong");
  });

  test("a reviewer that fails outright is reported as unavailable, not as a defect", async () => {
    const review = await staticQaReview(
      "Add a footer",
      emptyChange,
      { ask: async () => { throw new Error("model unreachable"); } },
      "context"
    );
    assert.equal(review.defectFound, false, "the reviewer failing must fail open, never count as a defect");
    assert.match(review.reviewUnavailable ?? "", /model unreachable/);
  });

  test("malformed JSON from the model degrades to reviewUnavailable rather than throwing", async () => {
    const review = await staticQaReview(
      "Add a footer",
      emptyChange,
      { ask: async () => "not json at all" },
      "context"
    );
    assert.equal(review.defectFound, false);
    assert.ok(review.reviewUnavailable);
  });

  // Production bug: a diff over the 60k-char cap used to be sliced with no
  // indication anything was cut, so the reviewer had no reason to treat what
  // it saw as anything but the complete change set.
  test("a diff over the size cap tells the reviewer explicitly that it was truncated", async () => {
    const hugeChange: ChangeSet = {
      diff: "+line\n".repeat(20000), // well over 60,000 characters
      modified: ["big.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    let userPromptSeen = "";
    await staticQaReview(
      "Add a footer",
      hugeChange,
      {
        ask: async (_system, user) => {
          userPromptSeen = user;
          return JSON.stringify({ requirements: [], concerns: [], summary: "all good" });
        },
      },
      "context"
    );
    assert.match(userPromptSeen, /CHANGE SET TRUNCATED/);
  });

  test("a diff under the size cap gets no truncation note", async () => {
    let userPromptSeen = "";
    await staticQaReview(
      "Add a footer",
      emptyChange,
      {
        ask: async (_system, user) => {
          userPromptSeen = user;
          return JSON.stringify({ requirements: [], concerns: [], summary: "all good" });
        },
      },
      "context"
    );
    assert.doesNotMatch(userPromptSeen, /TRUNCATED/);
  });
});

describe("staticQaReview (emptied / staged-deletion files)", () => {
  // The file-retirement flow deliberately empties a file (or the agent stages it
  // for end-of-run deletion) rather than leaving it in place. Its diff is pure
  // removals, which a reviewer would otherwise read as "the code was dropped"
  // and flag as a missing implementation. These files must be excluded from the
  // per-file review units entirely.
  test("an emptied file is excluded from the per-file review units and named in FILES TOUCHED", async () => {
    const change: ChangeSet = {
      diff: `${GIT_DIFF_A}\n${GIT_DIFF_B}`,
      modified: ["src/a.ts", "src/b.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
      emptied: ["src/a.ts"],
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 1, "the emptied file must not be reviewed");
    assert.match(prompts[0], /FILE UNDER REVIEW: src\/b\.ts \(file 1 of 1\)/);
    assert.doesNotMatch(prompts[0], /FILE UNDER REVIEW: src\/a\.ts/);
    assert.match(prompts[0], /emptied or staged for deletion/, "the reviewer must be told the file was intentionally retired");
    assert.match(prompts[0], /src\/a\.ts/);
    assert.doesNotMatch(prompts[0], /\+const a = 2;/, "the emptied file's removals must not reach the reviewer");
  });

  test("a file staged for deletion is excluded from review even when git still reports it with content", async () => {
    const change: ChangeSet = {
      diff: `${GIT_DIFF_A}\n${GIT_DIFF_B}`,
      modified: ["src/a.ts", "src/b.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
      stagedDeletions: ["src/a.ts"],
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /FILE UNDER REVIEW: src\/b\.ts/);
    assert.match(prompts[0], /src\/a\.ts/);
    assert.doesNotMatch(prompts[0], /\+const a = 2;/);
  });

  test("a file git reports as deleted is also bypassed", async () => {
    const change: ChangeSet = {
      diff: `${GIT_DIFF_A}\n${GIT_DIFF_B}`,
      modified: ["src/b.ts"],
      added: [],
      deleted: ["src/a.ts"],
      renamed: [],
      isEmpty: false,
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /FILE UNDER REVIEW: src\/b\.ts/);
  });

  test("bypassed paths are normalized so a backslashed staged path still matches the diff", async () => {
    const change: ChangeSet = {
      diff: `${GIT_DIFF_A}\n${GIT_DIFF_B}`,
      modified: ["src/a.ts", "src/b.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
      stagedDeletions: ["src\\a.ts"],
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /FILE UNDER REVIEW: src\/b\.ts/);
  });

  test("an unstructured diff is still reviewed as one unit (no per-file bypass possible)", async () => {
    const change: ChangeSet = {
      ...UNSTRUCTURED_CHANGE,
      stagedDeletions: ["src/a.ts"],
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("whole change set reviewed");
        },
      },
      "context"
    );
    // No file attribution means no safe way to drop one file's removals — the
    // whole-diff fallback is kept, but the retired files are still named so the
    // reviewer can mark them uncertain rather than missing.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /emptied or staged for deletion/);
  });

  test("a change set where every file is bypassed makes no review call and never marks a defect", async () => {
    let called = false;
    const change: ChangeSet = {
      diff: GIT_DIFF_A,
      modified: ["src/a.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
      emptied: ["src/a.ts"],
    };
    const review = await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async () => {
          called = true;
          return emptyReview("ok");
        },
      },
      "context"
    );
    assert.equal(called, false);
    assert.equal(review.defectFound, false);
    assert.match(review.summary, /could not be completed/);
  });
});

describe("isHarnessArtifactPath", () => {
  test("recognizes QA_REVIEW.md, PROGRESS.md, and anything under .agent/", () => {
    assert.ok(isHarnessArtifactPath("QA_REVIEW.md"));
    assert.ok(isHarnessArtifactPath("PROGRESS.md"));
    assert.ok(isHarnessArtifactPath(".agent"));
    assert.ok(isHarnessArtifactPath(".agent/repo_map.json"));
  });

  test("normalizes a backslashed or ./-prefixed path the same way", () => {
    assert.ok(isHarnessArtifactPath(".\\QA_REVIEW.md"), "a leading './'-style backslash path must still match");
    assert.ok(isHarnessArtifactPath(".agent\\repo_map.json"), "backslash path separators must still match");
  });

  test("does not flag ordinary source files, even ones that merely mention .agent in their name", () => {
    assert.equal(isHarnessArtifactPath("src/agentTools.ts"), false);
    assert.equal(isHarnessArtifactPath("src/index.ts"), false);
    assert.equal(isHarnessArtifactPath("README.md"), false);
  });
});

// Regression target: QA_REVIEW.md is append-only and NEVER truncated
// (agentLoop.ts's appendQaReviewLog), so its diff only grows across a
// project's lifetime — observed in practice at 16k+ characters (26x a real
// 0.6k source change in the same phase) while a semantic reviewer has
// nothing to actually judge there. It must never reach the per-file review
// units, the same way an emptied/staged-deletion file doesn't.
describe("staticQaReview (harness artifacts)", () => {
  test("QA_REVIEW.md is excluded from the per-file review units and named in FILES TOUCHED", async () => {
    const change: ChangeSet = {
      diff: `${GIT_DIFF_A}\n${GIT_DIFF_QA_REVIEW}`,
      modified: ["src/a.ts", "QA_REVIEW.md"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 1, "QA_REVIEW.md must not be reviewed");
    assert.match(prompts[0], /FILE UNDER REVIEW: src\/a\.ts \(file 1 of 1\)/);
    assert.doesNotMatch(prompts[0], /FILE UNDER REVIEW: QA_REVIEW\.md/);
    assert.match(prompts[0], /harness bookkeeping, not application code/, "the reviewer must be told why it's absent");
    assert.match(prompts[0], /QA_REVIEW\.md/);
    assert.doesNotMatch(
      prompts[0],
      /Visual advisory auto-accepted/,
      "QA_REVIEW.md's own diff content must never reach the reviewer"
    );
  });

  test("a change set touching ONLY QA_REVIEW.md makes no review call and never marks a defect", async () => {
    let called = false;
    const change: ChangeSet = {
      diff: GIT_DIFF_QA_REVIEW,
      modified: ["QA_REVIEW.md"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    const review = await staticQaReview(
      "Add a footer",
      change,
      {
        ask: async () => {
          called = true;
          return emptyReview("ok");
        },
      },
      "context"
    );
    assert.equal(called, false, "a QA_REVIEW.md-only change set must never cost a model call");
    assert.equal(review.defectFound, false);
  });

  test("a touched lock file is named in FILES TOUCHED as a bare fact, never with its own diff content", async () => {
    const change: ChangeSet = {
      diff: GIT_DIFF_A,
      modified: ["src/a.ts"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
      lockFiles: ["package-lock.json"],
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add express as a dependency",
      change,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.match(prompts[0], /package-lock\.json/);
    assert.match(prompts[0], /confirming a dependency install actually ran/);
    assert.match(prompts[0], /diff omitted/);
  });
});

describe("truncateLongDiffLines", () => {
  test("leaves ordinary short lines untouched", () => {
    const diff = "diff --git a/x.kt b/x.kt\n-val a = 1\n+val a = 2\n";
    assert.equal(truncateLongDiffLines(diff), diff);
  });

  test("truncates a single pathological line (e.g. a vector drawable's pathData) without touching the others", () => {
    const hugeLine = "+" + "M25.5,3.5C".repeat(500); // 5001 chars, well past the cap
    const diff = ["diff --git a/ic.xml b/ic.xml", "-short old line", hugeLine, "+short new line"].join("\n");
    const out = truncateLongDiffLines(diff);
    const lines = out.split("\n");
    assert.equal(lines[1], "-short old line");
    assert.equal(lines[3], "+short new line");
    assert.ok(lines[2].length < hugeLine.length, "the huge line must be shortened");
    assert.match(lines[2], /^\+M25\.5,3\.5C/, "the kept prefix must be the real start of the line");
    assert.match(lines[2], /more chars on this line omitted — looks like generated or binary-like data/);
  });
});

describe("staticQaReview (generated/binary-like content)", () => {
  test("a huge single line (e.g. vector drawable pathData) is truncated before it ever reaches the model", async () => {
    const hugeLine = "+" + "M25.5,3.5C".repeat(10_000); // 100,001 chars — bigger than DIFF_CHAR_CAP on its own
    const diff = [
      "diff --git a/res/drawable/ic_launcher_foreground.xml b/res/drawable/ic_launcher_foreground.xml",
      "--- a/res/drawable/ic_launcher_foreground.xml",
      "+++ b/res/drawable/ic_launcher_foreground.xml",
      "@@ -1 +1 @@",
      "-old pathData",
      hugeLine,
    ].join("\n");
    const change: ChangeSet = {
      diff,
      modified: ["res/drawable/ic_launcher_foreground.xml"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Center the launcher mark",
      change,
      { ask: async (_system, user) => { prompts.push(user); return emptyReview("ok"); } },
      "context"
    );
    assert.equal(prompts.length, 1);
    // The whole point: a single generated line must not be allowed to consume
    // the entire per-file budget on its own — the prompt actually sent must be
    // dramatically smaller than the raw 100k-character line would have been.
    assert.ok(prompts[0].length < 10_000, `prompt should be small once the huge line is truncated, was ${prompts[0].length} chars`);
    assert.match(prompts[0], /more chars on this line omitted — looks like generated or binary-like data/);
  });
});

// --------------------------------------------------------------- Fixtures

const GIT_DIFF_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

const GIT_DIFF_B = [
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-const b = 1;",
  "+const b = 2;",
].join("\n");

/** A QA_REVIEW.md append — its append-only nature means this only ever grows across a project's lifetime. */
const GIT_DIFF_QA_REVIEW = [
  "diff --git a/QA_REVIEW.md b/QA_REVIEW.md",
  "index 5555555..6666666 100644",
  "--- a/QA_REVIEW.md",
  "+++ b/QA_REVIEW.md",
  "@@ -1,2 +1,5 @@",
  " # QA Review Log",
  "",
  "+## 2026-09-21 — Phase 4",
  "+",
  "+- Visual advisory auto-accepted: button color looks slightly off",
].join("\n");

/** What `collectChangeSet` emits for an untracked new file. */
const SYNTHETIC_NEW_FILE_BLOCK =
  "\n--- /dev/null\n+++ b/src/new.ts\n@@ new file @@\n+export const n = 1;\n";

const MULTI_FILE_CHANGE: ChangeSet = {
  diff: `${GIT_DIFF_A}\n${GIT_DIFF_B}`,
  modified: ["src/a.ts", "src/b.ts"],
  added: [],
  deleted: [],
  renamed: [],
  isEmpty: false,
};

/** A hand-built fixture with no `diff --git` headers — no file attribution is
 *  derivable from it, so it must never be split. */
const UNSTRUCTURED_CHANGE: ChangeSet = {
  diff: "+const a = 1;\n-const b = 2;\n",
  modified: ["src/a.ts", "src/b.ts"],
  added: [],
  deleted: [],
  renamed: [],
  isEmpty: false,
};

function emptyReview(summary: string): string {
  return JSON.stringify({ requirements: [], concerns: [], summary });
}

describe("splitDiffByFile", () => {
  test("splits a git diff into one attributed segment per file", () => {
    const segments = splitDiffByFile(MULTI_FILE_CHANGE.diff);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].file, "src/a.ts");
    assert.equal(segments[1].file, "src/b.ts");
    assert.match(segments[0].diff, /\+const a = 2;/);
    assert.doesNotMatch(segments[0].diff, /const b = 2;/, "one file's changes must never bleed into another's segment");
    assert.match(segments[1].diff, /\+const b = 2;/);
    assert.doesNotMatch(segments[1].diff, /const a = 2;/);
  });

  test("attributes a synthesized untracked-file block via its +++ b/<path> header", () => {
    const segments = splitDiffByFile(SYNTHETIC_NEW_FILE_BLOCK);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].file, "src/new.ts");
    assert.match(segments[0].diff, /export const n = 1;/);
  });

  test("splits a change set that mixes git headers with synthesized new-file blocks", () => {
    const segments = splitDiffByFile(`${GIT_DIFF_A}${SYNTHETIC_NEW_FILE_BLOCK}`);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].file, "src/a.ts");
    assert.equal(segments[1].file, "src/new.ts");
  });

  // A newly ADDED tracked file also contains `--- /dev/null`, but as an interior
  // header of its own `diff --git` segment. Treating that as a boundary would
  // split one file into two segments and mis-attribute the hunk.
  test("does not split a new tracked file's interior `--- /dev/null` into a second segment", () => {
    const added = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+export const x = 1;",
    ].join("\n");
    const segments = splitDiffByFile(added);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].file, "new.ts");
  });

  test("falls back to a single unattributed segment when the diff has no file boundaries", () => {
    const segments = splitDiffByFile(UNSTRUCTURED_CHANGE.diff);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].file, undefined);
    assert.equal(segments[0].diff, UNSTRUCTURED_CHANGE.diff);
  });

  test("an empty diff yields a single empty segment rather than throwing", () => {
    const segments = splitDiffByFile("");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].diff, "");
  });
});

describe("mergeRequirementFindings", () => {
  const finding = (status: "satisfied" | "missing" | "uncertain", evidence: string) => ({
    requirement: "Add a footer",
    status,
    evidence,
  });

  test("missing beats satisfied beats uncertain, regardless of the order files were reviewed", () => {
    const merged = mergeRequirementFindings([
      [finding("uncertain", "cannot tell")],
      [finding("satisfied", "footer present in b.ts")],
      [finding("missing", "a.ts still has no <footer>")],
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, "missing");
    assert.equal(merged[0].evidence, "a.ts still has no <footer>");
  });

  test("satisfied from a later file outranks an earlier uncertain verdict", () => {
    const merged = mergeRequirementFindings([
      [finding("uncertain", "cannot tell")],
      [finding("satisfied", "footer present in b.ts")],
    ]);
    assert.equal(merged[0].status, "satisfied");
  });

  test("equal-status findings merge their evidence so no file's reasoning is lost", () => {
    const merged = mergeRequirementFindings([
      [finding("satisfied", "`a.ts` adds the element")],
      [finding("satisfied", "`b.ts` styles it")],
    ]);
    assert.equal(merged[0].evidence, "`a.ts` adds the element `b.ts` styles it");
  });

  test("normalizes case, backticks and spacing so one requirement yields one verdict", () => {
    const merged = mergeRequirementFindings([
      [{ requirement: "Add `footer`", status: "uncertain", evidence: "e1" }],
      [{ requirement: "add   FOOTER", status: "satisfied", evidence: "e2" }],
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, "satisfied");
  });

  test("preserves first-seen requirement order and drops blank requirement names", () => {
    const merged = mergeRequirementFindings([
      [
        { requirement: "Second", status: "uncertain", evidence: "e" },
        { requirement: "   ", status: "missing", evidence: "e" },
      ],
      [{ requirement: "First", status: "satisfied", evidence: "e" }],
    ]);
    assert.deepEqual(merged.map((f) => f.requirement), ["Second", "First"]);
  });
});

// A small multi-file diff is triage-eligible (see staticQaReview): the first
// call combines every file and can short-circuit the per-file fan-out these
// tests are actually about. Escalating on that first call (no "FILE UNDER
// REVIEW" marker — triage always reviews the whole change set at once) is
// what makes the per-file calls these tests assert on actually happen.
const ESCALATE_TRIAGE = JSON.stringify({ requirements: [], concerns: [], summary: "triage", needsPerFileReview: true });
const isTriageCall = (user: string) => !/FILE UNDER REVIEW/.test(user);

describe("staticQaReview (multi-file change sets)", () => {
  test("issues a separate deps.ask call per file, each scoped to that file with the full FILES TOUCHED list", async () => {
    const prompts: string[] = [];
    const review = await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          return emptyReview("ok");
        },
      },
      "context"
    );

    const perFilePrompts = prompts.filter((p) => !isTriageCall(p));
    assert.equal(prompts.length, 3, "one triage call plus one call per file");
    assert.equal(perFilePrompts.length, 2, "each file in a multi-file change set must get its own review call");

    assert.match(perFilePrompts[0], /FILE UNDER REVIEW: src\/a\.ts \(file 1 of 2\)/);
    assert.match(perFilePrompts[1], /FILE UNDER REVIEW: src\/b\.ts \(file 2 of 2\)/);

    for (const prompt of perFilePrompts) {
      assert.match(prompt, /FILES TOUCHED:/);
      assert.match(prompt, /modified: src\/a\.ts, src\/b\.ts/, "every call needs the whole touched-file list to judge cross-file requirements");
    }

    // Each prompt's CHANGE SET body must contain only its own file's diff.
    assert.match(perFilePrompts[0], /\+const a = 2;/);
    assert.doesNotMatch(perFilePrompts[0], /\+const b = 2;/);
    assert.match(perFilePrompts[1], /\+const b = 2;/);
    assert.doesNotMatch(perFilePrompts[1], /\+const a = 2;/);

    assert.match(review.summary, /src\/a\.ts: ok/);
    assert.match(review.summary, /src\/b\.ts: ok/);
  });

  test("a 'missing' verdict in one file is not softened by 'satisfied' for the same requirement in another", async () => {
    const review = await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          const isA = /FILE UNDER REVIEW: src\/a\.ts/.test(user);
          return JSON.stringify({
            requirements: [{
              requirement: "Add a footer",
              status: isA ? "missing" : "satisfied",
              evidence: isA ? "`src/a.ts` still has no <footer> element" : "`src/b.ts` renders the footer",
            }],
            concerns: [],
            summary: isA ? "a reviewed" : "b reviewed",
          });
        },
      },
      "context"
    );
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0].status, "missing");
    assert.equal(review.defectFound, true, "one file's confirmed defect must not be hidden by another file's 'satisfied'");
  });

  test("'satisfied' in one file outranks 'uncertain' for the same requirement in another", async () => {
    const review = await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          const isA = /FILE UNDER REVIEW: src\/a\.ts/.test(user);
          return JSON.stringify({
            requirements: [{
              requirement: "Add a footer",
              status: isA ? "uncertain" : "satisfied",
              evidence: isA ? "cannot tell from source alone" : "`src/b.ts` renders the footer",
            }],
            concerns: [],
            summary: isA ? "a reviewed" : "b reviewed",
          });
        },
      },
      "context"
    );
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0].status, "satisfied");
    assert.equal(review.defectFound, false);
  });

  test("one file's review failing still returns the other file's findings, and reports the failure", async () => {
    const review = await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          if (/FILE UNDER REVIEW: src\/a\.ts/.test(user)) throw new Error("model unreachable");
          return JSON.stringify({
            requirements: [{ requirement: "Add a footer", status: "satisfied", evidence: "`src/b.ts` renders the footer" }],
            concerns: [],
            summary: "b reviewed",
          });
        },
      },
      "context"
    );
    assert.equal(review.defectFound, false, "a failing file review must fail open");
    assert.match(review.reviewUnavailable ?? "", /src\/a\.ts: model unreachable/);
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0].status, "satisfied");
  });

  // Fallback path: a change set with no `diff --git` headers (a hand-built
  // fixture, a plain unified diff) can't be attributed to a file with any
  // certainty, so it must be reviewed as ONE unit — guessing would let one
  // file's changes be blamed on another.
  test("an unstructured diff lacking git headers is reviewed as a single unit, not split per touched file", async () => {
    const prompts: string[] = [];
    const review = await staticQaReview(
      "Add a footer",
      UNSTRUCTURED_CHANGE,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("whole change set reviewed");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 1, "an unattributable diff must produce exactly one review call");
    assert.doesNotMatch(prompts[0], /FILE UNDER REVIEW/, "no file may be named when attribution is impossible");
    assert.match(prompts[0], /modified: src\/a\.ts, src\/b\.ts/);
    assert.match(prompts[0], /\+const a = 1;/);
    assert.match(prompts[0], /-const b = 2;/);
    assert.equal(review.summary, "whole change set reviewed");
  });

  test("a change set mixing git headers and a synthesized new-file block is split into one call per file", async () => {
    const mixed: ChangeSet = {
      diff: `${GIT_DIFF_A}${SYNTHETIC_NEW_FILE_BLOCK}`,
      modified: ["src/a.ts"],
      added: ["src/new.ts"],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      mixed,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          return emptyReview("ok");
        },
      },
      "context"
    );

    const perFilePrompts = prompts.filter((p) => !isTriageCall(p));
    assert.equal(perFilePrompts.length, 2);
    assert.match(perFilePrompts[0], /FILE UNDER REVIEW: src\/a\.ts \(file 1 of 2\)/);
    assert.match(perFilePrompts[1], /FILE UNDER REVIEW: src\/new\.ts \(file 2 of 2\)/);
    assert.match(perFilePrompts[1], /export const n = 1;/);
  });
});

describe("staticQaReview (triage fast path)", () => {
  test("a confident triage call reviews every file in one pass, skipping the per-file fan-out", async () => {
    const prompts: string[] = [];
    const review = await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return JSON.stringify({
            requirements: [{ requirement: "Add a footer", status: "satisfied", evidence: "both files render it" }],
            concerns: [],
            summary: "reviewed together",
            needsPerFileReview: false,
          });
        },
      },
      "context"
    );

    assert.equal(prompts.length, 1, "a confident triage call must be the only call made");
    assert.doesNotMatch(prompts[0], /FILE UNDER REVIEW/, "triage reviews every file combined, not scoped to one");
    assert.match(prompts[0], /\+const a = 2;/);
    assert.match(prompts[0], /\+const b = 2;/);
    assert.equal(review.findings[0].status, "satisfied");
    assert.equal(review.summary, "reviewed together");
  });

  test("triage asking for a closer look falls back to one call per file", async () => {
    const prompts: string[] = [];
    await staticQaReview(
      "Add a footer",
      MULTI_FILE_CHANGE,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          if (isTriageCall(user)) return ESCALATE_TRIAGE;
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 3, "one triage call, then one call per file");
    assert.equal(prompts.filter((p) => !isTriageCall(p)).length, 2);
  });

  test("a diff touching more than MAX_TRIAGE_FILES files skips triage entirely and goes straight to per-file review", async () => {
    // 7 tiny single-line files — over the file-count cap, so triage must never
    // be attempted even though the combined diff is well under the size cap.
    const files = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
    const diff = files
      .map((f, i) =>
        [
          `diff --git a/${f} b/${f}`,
          `index 100000${i}..200000${i} 100644`,
          `--- a/${f}`,
          `+++ b/${f}`,
          "@@ -1 +1 @@",
          `-const f${i} = 1;`,
          `+const f${i} = 2;`,
        ].join("\n")
      )
      .join("\n");
    const manyFiles: ChangeSet = { diff, modified: files, added: [], deleted: [], renamed: [], isEmpty: false };

    const prompts: string[] = [];
    await staticQaReview(
      "Bump every constant",
      manyFiles,
      {
        ask: async (_system, user) => {
          prompts.push(user);
          return emptyReview("ok");
        },
      },
      "context"
    );

    assert.equal(prompts.length, 7, "no triage call should be attempted above the file-count cap");
    assert.equal(prompts.filter((p) => !isTriageCall(p)).length, 7);
  });
});
