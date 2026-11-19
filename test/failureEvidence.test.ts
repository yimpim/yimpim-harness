/**
 * The facts a person collects before deciding whether a failing test or the code is wrong, gathered with grep and git and no model.
 * Each test rebuilds, in a throwaway repository, a situation that really happened.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { symbolFromMessage, whereDefined, mockFactoriesFor, introducedBy, expectedAndReceived, evidenceFor, evidenceText } from "../src/failureEvidence.js";
import { digestFailure } from "../src/failureDigest.js";

let dir = "";
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const commit = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
  git("init", "-q");
  write("src/storage/secureStore.ts", "export async function getSession() {}\nexport async function getSupabaseRefreshToken() {}\n");
  write("app/dashboard.tsx", "import { getSession } from '../src/storage/secureStore';\nexport const Screen = () => getSession();\n");
  write(
    "__tests__/dashboard.test.ts",
    ["jest.mock('../src/storage/secureStore', () => ({", "  getSession: async () => 1,", "  listSessions: async () => [],", "}));", "it('mounts', () => {});"].join("\n")
  );
  write("__tests__/archive.test.ts", "jest.mock('../src/storage/secureStore', () => ({\n  getSupabaseRefreshToken: async () => 'x',\n}));\n");
  write("__tests__/gate.test.ts", "jest.mock('../src/storage/secureStore', () => ({\n  ...jest.requireActual('../src/storage/secureStore'),\n  getSession: jest.fn(),\n}));\n");
  write("__tests__/oneline.test.ts", "jest.mock('../src/storage/secureStore', () => ({ getSession: jest.fn() }));\n");
  commit("base");
  // The change that started it all: the app starts calling a function; no test is touched.
  write("app/dashboard.tsx", "import { getSession, getSupabaseRefreshToken } from '../src/storage/secureStore';\nexport const Screen = () => { getSupabaseRefreshToken(); return getSession(); };\n");
  commit("yimpim: completed phase - 4/6 Validate dashboard session context");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what name a failure is about", () => {
  test("a function a mock did not provide, as Jest prints it", () => {
    assert.equal(symbolFromMessage("TypeError: (0 , _secureStore.getSupabaseRefreshToken) is not a function"), "getSupabaseRefreshToken");
    assert.equal(symbolFromMessage("TypeError: (0 , _sessionSummary.deriveLiveSessionActivity) is not a function"), "deriveLiveSessionActivity");
  });
  test("other ways of saying a thing is missing", () => {
    assert.equal(symbolFromMessage("TypeError: svc.refresh is not a function"), "refresh");
    assert.equal(symbolFromMessage("TypeError: helper is not a function"), "helper");
    assert.equal(symbolFromMessage("ReferenceError: AppState is not defined"), "AppState");
    assert.equal(symbolFromMessage("NameError: name 'compute_total' is not defined"), "compute_total");
    assert.equal(symbolFromMessage("ImportError: cannot import name 'load_config'"), "load_config");
    assert.equal(symbolFromMessage("AttributeError: module 'util' has no attribute 'slugify'"), "slugify");
  });
  test("a failure that is not about a missing name says none", () => {
    assert.equal(symbolFromMessage("expect(received).toBe(expected) // Object.is equality"), undefined);
    assert.equal(symbolFromMessage("TypeError: undefined is not a function"), undefined);
  });
});

describe("where a name is defined", () => {
  test("in the project's own code, never in a test", () => {
    write("__tests__/helper.ts", "export function getSupabaseRefreshToken() {}\n");
    commit("a test helper with the same name");
    const found = whereDefined(dir, "getSupabaseRefreshToken");
    assert.deepEqual(found.map((f) => f.file), ["src/storage/secureStore.ts"]);
    assert.equal(found[0].line, 2);
  });
  test("a name that exists nowhere", () => {
    assert.deepEqual(whereDefined(dir, "neverWritten"), []);
  });
});

describe("which tests replace that module, and whether the mock provides the name", () => {
  const found = () => mockFactoriesFor(dir, "src/storage/secureStore.ts", "getSupabaseRefreshToken");
  test("a mock without it is the stale one", () => {
    const m = found().find((x) => x.file === "__tests__/dashboard.test.ts")!;
    assert.equal(m.provides, false);
    assert.equal(m.keepsReal, false);
    assert.equal(m.line, 1);
  });
  test("a mock that provides it, and one that keeps the real module underneath", () => {
    assert.equal(found().find((x) => x.file === "__tests__/archive.test.ts")!.provides, true);
    assert.equal(found().find((x) => x.file === "__tests__/gate.test.ts")!.keepsReal, true);
  });
  test("a one-line mock is read on its own line, not through to the next mock", () => {
    const m = found().find((x) => x.file === "__tests__/oneline.test.ts")!;
    assert.equal(m.provides, false);
  });
  test("a module no test mocks has no entries", () => {
    assert.deepEqual(mockFactoriesFor(dir, "src/other.ts", "x"), []);
  });
});

describe("when the call appeared, and whether that change touched the test", () => {
  test("the commit and its subject, and that it did not change the test", () => {
    const o = introducedBy(dir, "getSupabaseRefreshToken", "app/dashboard.tsx", "__tests__/dashboard.test.ts")!;
    assert.ok(o.hash.length >= 6);
    assert.match(o.subject, /phase - 4\/6 Validate dashboard session context/);
    assert.equal(o.touchedTest, false);
  });
  test("a commit that did change the test says so", () => {
    write("app/dashboard.tsx", "export const later = () => helperThing();\n");
    write("__tests__/dashboard.test.ts", "jest.mock('x');\n// helperThing\n");
    commit("adds helperThing with its test");
    assert.equal(introducedBy(dir, "helperThing", "app/dashboard.tsx", "__tests__/dashboard.test.ts")!.touchedTest, true);
  });
  test("a name never added to that file has no origin", () => {
    assert.equal(introducedBy(dir, "neverAdded", "app/dashboard.tsx", "__tests__/dashboard.test.ts"), undefined);
  });
});

describe("what a failed comparison compared", () => {
  const msg = 'expect(received).toContain(expected) // indexOf\n\nExpected substring: "Offline"\nReceived string:    "Reconnecting…QA-only local connection simulation"\n';
  test("both texts are read from the lines after the header", () => {
    assert.deepEqual(expectedAndReceived(msg), { expected: "Offline", received: "Reconnecting…QA-only local connection simulation" });
  });
  test("a failure that compares no strings says none", () => {
    assert.equal(expectedAndReceived("expect(received).toHaveLength(expected)\n\nExpected length: 1\nReceived length: 0"), undefined);
  });
});

describe("the evidence for one cause", () => {
  test("a stale mock: what is missing, where it is defined, which mock lacks it, and the change that added the call", () => {
    const out = [
      "FAIL __tests__/dashboard.test.ts",
      ...Array.from({ length: 12 }, (_, i) => `  ● case ${i}\n    TypeError: (0 , _secureStore.getSupabaseRefreshToken) is not a function\n      at app/dashboard.tsx:2:30`),
    ].join("\n");
    const d = digestFailure(out, dir, "__tests__/dashboard.test.ts");
    const lines = evidenceFor(dir, "__tests__/dashboard.test.ts", d.clusters[0]);
    const text = lines.join("\n");
    assert.match(text, /`getSupabaseRefreshToken` is defined at src\/storage\/secureStore\.ts:2/);
    assert.match(text, /__tests__\/dashboard\.test\.ts:1 mocks that module WITHOUT `getSupabaseRefreshToken`: a call to it fails there\. That mock is out of date\./);
    assert.match(text, /__tests__\/archive\.test\.ts:1 mocks that module and provides/);
    assert.match(text, /__tests__\/gate\.test\.ts:1 mocks that module but keeps the real one underneath/);
    assert.match(text, /started using `getSupabaseRefreshToken` in [0-9a-f]+ "yimpim: completed phase - 4\/6 Validate dashboard session context", which did NOT change __tests__\/dashboard\.test\.ts/);
  });
  test("changed copy: the app moved on, with the commit that did it", () => {
    write("src/Banner.tsx", "export const copy = 'Reconnecting…';\n");
    commit("Add the reconnect banner");
    const out = ["  ● banner", "    expect(received).toContain(expected) // indexOf", "", '    Expected substring: "Offline"', '    Received string:    "Reconnecting…"', "      at src/Banner.tsx:1:1"].join("\n");
    const d = digestFailure(out, dir, "__tests__/dashboard.test.ts");
    const text = evidenceFor(dir, "__tests__/dashboard.test.ts", d.clusters[0]).join("\n");
    assert.match(text, /The test expects "Offline" and the app gives "Reconnecting…"/);
    assert.match(text, /first appeared in [0-9a-f]+ on \d{4}-\d{2}-\d{2}: "Add the reconnect banner"/);
    assert.match(text, /Nothing in the app's own code contains "Offline" any more: the app changed away from what the test expects\./);
  });
  test("a failure with nothing to look up gives no evidence, and does not make any up", () => {
    const d = digestFailure("  ● x\n    Error: something went wrong\n", dir);
    assert.deepEqual(evidenceFor(dir, "__tests__/dashboard.test.ts", d.clusters[0]), []);
  });
  test("outside a git repository it quietly has nothing", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "noevidence-"));
    try {
      const d = digestFailure("  ● x\n    TypeError: (0 , _m.thing) is not a function\n", bare);
      assert.ok(Array.isArray(evidenceFor(bare, "a.test.ts", d.clusters[0])));
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("a text the test looks for", () => {
  const failOn = (line: string) => {
    write("__tests__/ui.test.ts", ["it('a', () => {", `  ${line}`, "});"].join("\n"));
    commit("a ui test");
    const out = ["FAIL __tests__/ui.test.ts", "  ● a", "    Error: Expected length: 1", "      at __tests__/ui.test.ts:2:5"].join("\n");
    return evidenceFor(dir, "__tests__/ui.test.ts", digestFailure(out, dir, "__tests__/ui.test.ts").clusters[0]).join("\n");
  };

  test("which texts on a line are worth looking for: labels and messages, not paths or identifiers", async () => {
    const { textsOnLine } = await import("../src/failureEvidence.js");
    assert.deepEqual(textsOnLine("expect(labeled(r, 'Pending question: Continue?')).toHaveLength(1);"), ["Pending question: Continue?"]);
    assert.deepEqual(textsOnLine("import x from '../src/storage/secureStore'; const k = 'my-key-name'; expect(t).toContain(\"Action needed\");"), ["Action needed"]);
    assert.deepEqual(textsOnLine("expect(a).toBe(1);"), []);
    assert.deepEqual(textsOnLine("it('renders the card with its pills', () => {"), ["renders the card with its pills"]);
  });
  test("the app no longer has it: the expectation is stale, and the commit that last changed it is named", () => {
    write("src/Card.tsx", "export const label = 'Question pending';\n");
    commit("Rename the pending-question label");
    write("src/Card.tsx", "export const label = 'Needs your answer';\n");
    commit("Reword the question card");
    const text = failOn("expect(labeled(r, 'Question pending')).toHaveLength(1);");
    assert.match(text, /The test looks for "Question pending" and nothing in the app's own code contains it any more \(last changed in [0-9a-f]+ on \d{4}-\d{2}-\d{2}: "Reword the question card"\)/);
  });
  test("the app still has it: the test may be looking the wrong way, and the line is named", () => {
    write("src/Card.tsx", "export const label = 'Idle starter';\n");
    commit("Add the idle card");
    assert.match(failOn("expect(labeled(r, 'Idle starter')).toHaveLength(1);"), /The test looks for "Idle starter", which the app still has at src\/Card\.tsx:1\./);
  });
  test("only the written spec has it: the CODE may be missing what the spec requires, so the test must not be bent", () => {
    write("docs/SPEC.md", "# Spec\n\n- The home card is labelled \"Idle starter\".\n");
    commit("Write the spec");
    const text = failOn("expect(labeled(r, 'Idle starter')).toHaveLength(1);");
    assert.match(text, /The app's own code does not contain it, but the written spec does \(docs\/SPEC\.md:3\): the CODE may be missing what the spec requires, so do not change the test to match\./);
  });
  test("a failure on a line of the app, not of a test, does not search for texts", () => {
    write("app/x.ts", "export const m = 'Some visible message';\n");
    commit("x");
    const out = ["  ● a", "    Error: boom", "      at app/x.ts:1:1"].join("\n");
    assert.deepEqual(evidenceFor(dir, "__tests__/ui.test.ts", digestFailure(out, dir, "__tests__/ui.test.ts").clusters[0]), []);
  });
});

describe("the block for a prompt", () => {
  test("names each cause and its count, and is empty when there is nothing", () => {
    const d = digestFailure("  ● a\n    TypeError: (0 , _m.getSupabaseRefreshToken) is not a function\n  ● b\n    TypeError: (0 , _m.getSupabaseRefreshToken) is not a function\n", dir, "__tests__/dashboard.test.ts");
    assert.match(evidenceText(dir, "__tests__/dashboard.test.ts", d), /^For "TypeError: \(0 , _m\.getSupabaseRefreshToken\) is not a function" \(2×\):\n {2}- /);
    const none = digestFailure("  ● a\n    expect(received).toBe(expected) // Object.is equality\n", dir);
    assert.equal(evidenceText(dir, "x.test.ts", none), "");
  });
});
