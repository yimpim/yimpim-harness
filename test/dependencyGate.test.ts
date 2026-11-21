/**
 * Every new package is checked against its real registry, and a model can never clear the risky ones: a name one or two keystrokes from a very popular package, and a package with
 * a known advisory, always go to a person. The libraries a plan names are looked up before the roadmap is saved.
 */
import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editDistance, lookAlikeOf } from "../src/packageNames.js";
import { packagesNamedIn, makePackageNotes } from "../src/conventionPackages.js";
import { AgentTools } from "../src/agentTools.js";
import { createRoadmap } from "../src/roadmapFlow.js";
import { loadRoadmap } from "../src/roadmap.js";
import type { FetchFn } from "../src/dependencyFacts.js";

/** A registry: for a URL prefix, the status and JSON it answers. Anything else is a 404. */
const fakeFetch = (routes: Record<string, { status?: number; body: unknown }>): FetchFn => async (url) => {
  const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
  return new Response(JSON.stringify(hit?.[1].body ?? {}), { status: hit ? (hit[1].status ?? 200) : 404 });
};
const npm = (name: string, over: { versions?: Record<string, unknown>; latest?: string; downloads?: number; status?: number } = {}) => ({
  [`https://registry.npmjs.org/${name}`]: { status: over.status, body: { "dist-tags": { latest: over.latest ?? "2.0.0" }, versions: over.versions ?? { "1.0.0": {}, "2.0.0": {} } } },
  [`https://api.npmjs.org/downloads/point/last-week/${name}`]: { body: { downloads: over.downloads ?? 900_000 } },
});
const OSV_NONE = { "https://api.osv.dev/": { body: {} } };

describe("look-alike names", () => {
  test("edit distance, stopping early", () => {
    assert.equal(editDistance("express", "express"), 0);
    assert.equal(editDistance("expresss", "express"), 1);
    assert.equal(editDistance("reqeusts", "requests"), 2);
    assert.equal(editDistance("abc", "abcdefgh"), 3, "too different to matter: reported as past the limit");
    assert.ok(editDistance("react", "angular") > 2);
  });
  test("one or two keystrokes from a popular name is a look-alike; the popular name itself, a different package, a short name and an unlisted ecosystem are not", () => {
    assert.equal(lookAlikeOf("npm", "expresss"), "express");
    assert.equal(lookAlikeOf("npm", "lodahs"), "lodash");
    assert.equal(lookAlikeOf("npm", "axois"), "axios");
    assert.equal(lookAlikeOf("pypi", "reqeusts"), "requests");
    assert.equal(lookAlikeOf("pypi", "nunpy"), "numpy");
  });
  test("the real name, a longer different package, a short name, another ecosystem", () => {
    assert.equal(lookAlikeOf("npm", "express"), undefined);
    assert.equal(lookAlikeOf("npm", "React"), undefined, "case does not matter");
    assert.equal(lookAlikeOf("npm", "react-native-camera"), undefined);
    assert.equal(lookAlikeOf("npm", "zxcvb"), undefined);
    assert.equal(lookAlikeOf("npm", "vue2"), undefined, "shorter than 5 characters is never called a look-alike");
    assert.equal(lookAlikeOf("crates", "serdee"), undefined);
    assert.equal(lookAlikeOf("npm", "@acme/expresss"), "express", "a scope is ignored");
  });
});

describe("the libraries a plan names", () => {
  test("backticked names, a hyphenated or scoped name after use/using/with/install, and nothing else", () => {
    assert.deepEqual(
      packagesNamedIn(["Use expo-sqlite for storage", "State: `zustand`", "install @tanstack/react-query", "Keep it simple", "Use TypeScript everywhere", "with react-native-svg for icons"]),
      ["expo-sqlite", "zustand", "@tanstack/react-query", "react-native-svg"]
    );
    assert.deepEqual(packagesNamedIn(["Use the camera", "Plain words only"]), []);
    assert.equal(packagesNamedIn(Array.from({ length: 20 }, (_, i) => `Use pkg-name-${i} here`)).length, 8, "bounded");
  });

  test("one that does not exist, one that looks like a popular package, one that is deprecated, one that cannot be checked: each is flagged to review; a healthy one gets its facts", async () => {
    const fetchFn = fakeFetch({
      ...npm("expo-sqlite", { latest: "15.0.0", versions: { "15.0.0": {} }, downloads: 123456 }),
      ...npm("expresss", {}),
      ...npm("old-lib", { latest: "1.0.0", versions: { "1.0.0": { deprecated: "use new-lib instead" } } }),
      "https://registry.npmjs.org/flaky-lib": { status: 500, body: {} },
      ...OSV_NONE,
    });
    const notes = await makePackageNotes({ fetchFn })(["Use expo-sqlite for storage", "use `expresss` for the server", "use old-lib for dates", "use invented-lib for magic", "use flaky-lib for sync"]);
    assert.equal(notes.length, 5);
    assert.match(notes[0], /^Checked in the registry: expo-sqlite 15\.0\.0, 123456 downloads last week$/);
    assert.match(notes[1], /^REVIEW: "expresss" looks like "express", a very popular package\. Make sure the right one is meant$/);
    assert.match(notes[2], /^REVIEW: "old-lib" 1\.0\.0 is deprecated \(use new-lib instead\)\. Choose another$/);
    assert.match(notes[3], /^REVIEW: "invented-lib" does not exist in the npm registry, so no ticket can install it\. Choose a package that does$/);
    assert.match(notes[4], /^Could not check "flaky-lib" in the registry \(npm registry answered HTTP 500\)/);
  });

  test("a roadmap's conventions carry the notes, and a failing check never stops the roadmap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-rm-"));
    try {
      const complete = async () => JSON.stringify({ units: [{ title: "Storage", area: "Data", summary: "Save items", acceptance: ["Items persist"] }], conventions: ["Use expo-sqlite for storage"], questions: [], assumptions: [] });
      const ok = await createRoadmap({ repoRoot: root, complete, packageNotes: async () => ["REVIEW: \"expo-sqlite\" does not exist in the npm registry, so no ticket can install it. Choose a package that does"] }, { goal: "an app", verifyExisting: false });
      assert.equal(ok.ok, true, ok.text);
      assert.ok(loadRoadmap(root)!.conventions.some((c) => c.startsWith('REVIEW: "expo-sqlite" does not exist')));
      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "gate-rm2-"));
      const bad = await createRoadmap({ repoRoot: root2, complete, packageNotes: async () => { throw new Error("registry down"); } }, { goal: "an app", verifyExisting: false });
      assert.equal(bad.ok, true, bad.text);
      fs.rmSync(root2, { recursive: true, force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a package the Editor asks to add", () => {
  const ttyIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const ttyOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  let dir = "";
  before(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  after(() => {
    if (ttyIn) Object.defineProperty(process.stdin, "isTTY", ttyIn);
    else delete (process.stdin as any).isTTY;
    if (ttyOut) Object.defineProperty(process.stdout, "isTTY", ttyOut);
    else delete (process.stdout as any).isTTY;
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pkg-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tools = (fetchFn: FetchFn, asked: string[], panelCalls: string[]) => {
    const t = new AgentTools(dir, { prompts: { systemPersona: "P" } } as any, async (q) => (asked.push(q), "no"));
    t.setFactsFetch(fetchFn);
    t.setActionReviewer(async (a) => (panelCalls.push(a.label), { allow: true, why: "all judges said safe" })); // a panel that would clear anything
    return t;
  };

  test("a healthy, well-known package: nobody is asked and the panel is not needed", async () => {
    const asked: string[] = [];
    const panel: string[] = [];
    const out = await tools(fakeFetch({ ...npm("zustand"), ...OSV_NONE }), asked, panel).requestDependency({ ecosystem: "npm", name: "zustand", reason: "state" });
    assert.match(out, /\[VERIFIED\] npm:zustand/);
    assert.deepEqual([asked.length, panel.length], [0, 0]);
  });

  test("a name one letter from a popular package goes to a PERSON, even though the panel would have cleared it, and the person is told why", async () => {
    const asked: string[] = [];
    const panel: string[] = [];
    const out = await tools(fakeFetch({ ...npm("expresss"), ...OSV_NONE }), asked, panel).requestDependency({ ecosystem: "npm", name: "expresss", reason: "a web server" });
    assert.equal(panel.length, 0, "no model is asked");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /the name looks like "express", a very popular package/);
    assert.match(out, /The user did NOT approve it/);
  });

  test("a package with a known advisory goes to a person too; the panel is not asked", async () => {
    const asked: string[] = [];
    const panel: string[] = [];
    const advisory = { "https://api.osv.dev/": { body: { vulns: [{ id: "GHSA-xxxx-yyyy-zzzz" }] } } };
    await tools(fakeFetch({ ...npm("somelib"), ...advisory }), asked, panel).requestDependency({ ecosystem: "npm", name: "somelib", reason: "x" });
    assert.equal(panel.length, 0);
    assert.equal(asked.length, 1);
  });

  test("a package the registry does not know is refused outright: nothing to ask", async () => {
    const asked: string[] = [];
    const out = await tools(fakeFetch({}), asked, []).requestDependency({ ecosystem: "npm", name: "totally-invented-lib", reason: "x" });
    assert.match(out, /\[REFUSED\]/);
    assert.equal(asked.length, 0);
  });

  test("a package with only soft warnings (very few downloads) still goes to the panel first, and is added without asking when all judges are satisfied", async () => {
    const asked: string[] = [];
    const panel: string[] = [];
    const out = await tools(fakeFetch({ ...npm("smallish-lib", { downloads: 50 }), ...OSV_NONE }), asked, panel).requestDependency({ ecosystem: "npm", name: "smallish-lib", reason: "x" });
    assert.equal(panel.length, 1);
    assert.equal(asked.length, 0);
    assert.match(out, /The security panel approved adding it despite the warnings/);
  });
});

describe("what the planner is told", () => {
  test("a ticket is a user story with checkable criteria and a way in for QA, and is split when it is too big", () => {
    const src = fs.readFileSync("src/roadmapPlan.ts", "utf8");
    assert.match(src, /A unit that would change more than about 10 files, or several screens, is split into smaller ones\./);
    assert.match(src, /written as a user story where it fits: "As a \.\.\., I want \.\.\., so that \.\.\."/);
    assert.match(src, /"acceptance": 2 to 6 criteria that a test or a person using the app can check/);
    assert.match(src, /one acceptance line says how QA gets in \(seeded sign-in state, a mock switched on by a dev flag, or a deep link\)/);
  });
  test("the real check is part of the roadmap's setup, and no model name is built in", () => {
    assert.ok(fs.readFileSync("src/index.ts", "utf8").includes("packageNotes: makePackageNotes(),"));
    for (const f of ["src/packageNames.ts", "src/conventionPackages.ts", "src/intake.ts"]) assert.ok(!/gemini|hydrogen|deepseek/i.test(fs.readFileSync(f, "utf8")), f);
  });
});
