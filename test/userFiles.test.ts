/**
 * A file the user names in their request always reaches the Planner, whatever
 * Discovery chose to list.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeUnique, renderUserDocuments, userNamedFiles } from "../src/userFiles.js";

const repo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const FILES = {
  "reference/timeline-port/EXPO_PORT_BRIEF.md": "# Brief\nA fresh session shows no cards until a task starts.\n",
  "src/models/timeline.ts": "export const x = 1;\n",
  "node_modules/pkg/EXPO_PORT_BRIEF.md": "not this one",
  "app/dashboard.tsx": "export default 1;\n",
};

describe("userNamedFiles", () => {
  test("a file named by its path is found", () => {
    assert.deepEqual(userNamedFiles("follow reference/timeline-port/EXPO_PORT_BRIEF.md closely", repo(FILES)), ["reference/timeline-port/EXPO_PORT_BRIEF.md"]);
  });

  test("a bare file name is found wherever it lives, never inside node_modules", () => {
    assert.deepEqual(userNamedFiles("Read EXPO_PORT_BRIEF.md and build what it says", repo(FILES)), ["reference/timeline-port/EXPO_PORT_BRIEF.md"]);
  });

  test("several files, a trailing full stop, and one that does not exist", () => {
    const out = userNamedFiles("Look at app/dashboard.tsx, src/models/timeline.ts and missing/nope.ts.", repo(FILES));
    assert.deepEqual(out, ["app/dashboard.tsx", "src/models/timeline.ts"]);
  });

  test("a path that escapes the project is never returned", () => {
    assert.deepEqual(userNamedFiles("read ../../etc/passwd.txt", repo(FILES)), []);
  });

  test("a request that names nothing gives nothing", () => {
    assert.deepEqual(userNamedFiles("make the dashboard blank on a new session", repo(FILES)), []);
  });
});

describe("mergeUnique", () => {
  test("adds the user's files after Discovery's, once each", () => {
    assert.deepEqual(mergeUnique(["a.ts", "b.ts"], ["b.ts", "./c.md"]), ["a.ts", "b.ts", "./c.md"]);
    assert.deepEqual(mergeUnique(["a.ts"], ["./a.ts"]), ["a.ts"]);
  });
});

describe("renderUserDocuments", () => {
  test("a brief the user pointed at is put in the Planner's prompt in full, with the instruction to follow it", () => {
    const r = repo(FILES);
    const text = renderUserDocuments(["reference/timeline-port/EXPO_PORT_BRIEF.md", "app/dashboard.tsx"], r);
    assert.match(text, /DOCUMENTS THE USER POINTED YOU TO/);
    assert.match(text, /follow it and do not ask them anything it already answers/);
    assert.match(text, /A fresh session shows no cards until a task starts\./);
  });

  test("source files are not pasted in; the Planner reads those with its own tools", () => {
    assert.doesNotMatch(renderUserDocuments(["app/dashboard.tsx"], repo(FILES)), /export default/);
    assert.equal(renderUserDocuments(["app/dashboard.tsx"], repo(FILES)), "");
  });

  test("a long document is cut with a note saying how to read the rest", () => {
    const r = repo({ "SPEC.md": "x".repeat(30000) });
    const text = renderUserDocuments(["SPEC.md"], r, 1000, 5000);
    assert.match(text, /cut: 29000 more character\(s\); open SPEC\.md with read_file/);
  });

  test("when documents fill the space, later ones are named, not silently dropped", () => {
    const r = repo({ "A.md": "a".repeat(900), "B.md": "b".repeat(900) });
    const text = renderUserDocuments(["A.md", "B.md"], r, 900, 900);
    assert.match(text, /B\.md was not included/);
  });
});

import { resolveReferenceDir } from "../src/userFiles.js";

describe("finding the folder a person means", () => {
  const tree = () =>
    repo({
      "android-reference/app/Main.kt": "class Main",
      "docs/notes.md": "x",
      "node_modules/android-reference/x.js": "x",
      "src/Reference Notes/a.txt": "x",
    });

  test("a path that is a folder is used as it is", () => {
    assert.equal(resolveReferenceDir(tree(), "android-reference"), "android-reference");
    assert.equal(resolveReferenceDir(tree(), "./android-reference/"), "android-reference");
  });

  test("the name a person would say finds it, ignoring case, spaces, dashes and the word folder", () => {
    for (const say of ["android reference", "Android Reference folder", "the android_reference directory", "ANDROID-REFERENCE"]) {
      assert.equal(resolveReferenceDir(tree(), say.replace(/^the /, "")), "android-reference", say);
    }
  });

  test("it never reaches into node_modules, and a name that matches nothing is not guessed", () => {
    assert.equal(resolveReferenceDir(tree(), "totally different thing"), undefined);
    assert.equal(resolveReferenceDir(tree(), "x"), undefined);
    assert.notEqual(resolveReferenceDir(tree(), "android reference"), "node_modules/android-reference");
  });

  test("a path that leaves the project is refused", () => {
    assert.equal(resolveReferenceDir(tree(), "../outside"), undefined);
  });
});
