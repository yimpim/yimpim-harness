/**
 * A stalled Editor is not handed to the user. The Planner reads the code and
 * names the exact file, section and change; its answer is accepted only if it
 * names a real place to put the change.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStallDirectivePrompt, candidateTargets, namedTargets, renderPlannerDirective } from "../src/targetPick.js";

const repo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  const put = (rel: string, body = "x") => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put("app/dashboard.tsx");
  put("app/login.tsx");
  put("src/services/eventLog.ts");
  put("src/models/timeline.ts");
  put("reference/SPEC.md");
  put("__tests__/other.test.ts");
  return dir;
};

// Shaped like the list a stalled Editor reports: source files, a folder, a doc, a test.
const inspected = [
  "app/dashboard.tsx",
  "src/services/eventLog.ts",
  "__tests__",
  "src/wire/events.ts",
  "src/models/timeline.ts",
  "reference/SPEC.md",
  "app/login.tsx",
  'search:"timeline" in src',
  "app/dashboard.tsx",
  "__tests__/other.test.ts",
];

describe("candidateTargets", () => {
  test("keeps real source files only, once each, in the order they were read", () => {
    assert.deepEqual(candidateTargets(inspected, repo()), ["app/dashboard.tsx", "src/services/eventLog.ts", "src/models/timeline.ts", "app/login.tsx"]);
  });
  test("drops a folder, a doc, a test, a search entry and a file that does not exist", () => {
    const out = candidateTargets(inspected, repo());
    for (const dropped of ["__tests__", "reference/SPEC.md", "__tests__/other.test.ts", "src/wire/events.ts"]) assert.ok(!out.includes(dropped), dropped);
    assert.ok(!out.some((p) => p.startsWith("search:")));
  });
  test("a path that escapes the project is dropped", () => {
    assert.deepEqual(candidateTargets(["../../etc/passwd.ts"], repo()), []);
  });
});

describe("the prompt to the Planner", () => {
  const p = buildStallDirectivePrompt("Keep the dashboard clear on a fresh session", "stalled after 16 pure reads", ["app/dashboard.tsx"]);
  test("it forbids asking anyone and demands the file, the section and the change", () => {
    assert.match(p, /Do NOT ask the user anything/);
    assert.match(p, /FILE: the exact path/);
    assert.match(p, /SECTION: the exact place/);
    assert.match(p, /CHANGE: precisely what to change/);
    assert.match(p, /Never name a section you have not read/);
  });
  test("it carries the task, the reason it stalled, and the files already read", () => {
    assert.match(p, /Keep the dashboard clear/);
    assert.match(p, /16 pure reads/);
    assert.match(p, /- app\/dashboard\.tsx/);
  });
});

describe("namedTargets", () => {
  const answer = `FILE: app/dashboard.tsx
SECTION: the useEffect that subscribes to the stream (lines 88-131)
CHANGE: record the last event id when the session becomes active and drop earlier ones.
Also create src/models/boundary.ts for the helper.`;

  test("finds the existing file and a new file in a folder that exists", () => {
    const t = namedTargets(answer, repo());
    assert.deepEqual(t, [
      { path: "app/dashboard.tsx", exists: true },
      { path: "src/models/boundary.ts", exists: false },
    ]);
  });

  test("a made-up folder, a path outside the project, and prose that only looks like a filename are ignored", () => {
    const t = namedTargets("Edit nope/missing/file.ts, also ../../outside.ts and see e.g. the v1.2 notes. Version 3.14 applies.", repo());
    assert.deepEqual(t, []);
  });

  test("an answer that names nothing real yields no target, so the phase fails cleanly", () => {
    assert.deepEqual(namedTargets("I am not sure which file is right; please clarify.", repo()), []);
  });

  test("a trailing full stop or a ./ prefix does not hide a real file", () => {
    const t = namedTargets("Change ./app/login.tsx.", repo());
    assert.deepEqual(t, [{ path: "app/login.tsx", exists: true }]);
  });
});

describe("the directive the Editor is re-run with", () => {
  test("it names the targets, marks a new file, and says an edit is required", () => {
    const text = renderPlannerDirective("FILE: app/dashboard.tsx ...", [
      { path: "app/dashboard.tsx", exists: true },
      { path: "src/new.ts", exists: false },
    ]);
    assert.match(text, /Target file\(s\): app\/dashboard\.tsx, src\/new\.ts \(new file\)/);
    assert.match(text, /do not return without an edit/);
    assert.match(text, /FILE: app\/dashboard\.tsx/);
  });
  test("it does not claim a human chose anything", () => {
    assert.doesNotMatch(renderPlannerDirective("x", [{ path: "a.ts", exists: true }]), /user has/i);
  });
});
