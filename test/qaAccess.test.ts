/**
 * Every ticket that adds something QA cannot reach from a fresh start also adds the way in. The QA setup gains deep links, variables the app is started with, and a note
 * about what is mocked; all are validated so that nothing dangerous or secret-shaped gets through, and what was arranged is visible in the QA evidence.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeQaSetup, saveQaSetup, loadQaSetup, qaEnvFor, describeQaAccess, isSafeDeepLink, isSafeQaEnvName } from "../src/qaSetup.js";
import { AgentTools, TOOLS_SCHEMA } from "../src/agentTools.js";
import { EDITOR_SYSTEM } from "../src/prompts.js";
import { AutonomousVerifier } from "../src/verifierTools.js";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qaaccess-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

describe("deep links", () => {
  test("a URL with the app's own scheme, a universal link, or a route starting with one slash", () => {
    for (const u of ["myapp://pairing?demo=1", "https://app.example.com/pair?demo=1", "exp://127.0.0.1:8081/--/home", "/route?state=demo", "/"]) assert.equal(isSafeDeepLink(u), true, u);
  });
  test("code-running or file-reading schemes, a host-relative '//', no scheme, whitespace, backslashes, empty, too long", () => {
    for (const u of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "vbscript:x", "//evil.example/x", "no-scheme", "myapp://a b", "myapp://a\nb", "/a\\b", "", "x".repeat(501), "myapp:"]) {
      assert.equal(isSafeDeepLink(u), false, JSON.stringify(u).slice(0, 40));
    }
  });
  test("kept by name; a bad link, a nameless one and a repeated name are dropped; at most ten", () => {
    const s = sanitizeQaSetup({ deepLinks: [{ name: "pairing", url: "myapp://pairing?demo=1" }, { name: "evil", url: "javascript:x" }, { name: "", url: "/a" }, { name: "pairing", url: "/other" }, { url: "/b" }, "junk"] });
    assert.deepEqual(s.deepLinks, [{ name: "pairing", url: "myapp://pairing?demo=1" }]);
    const many = sanitizeQaSetup({ deepLinks: Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, url: `/r${i}` })) });
    assert.equal(many.deepLinks!.length, 10);
  });
});

describe("variables the app is started with", () => {
  test("only the names an app reads to pick its mode; nothing secret-shaped can be set", () => {
    for (const n of ["EXPO_PUBLIC_QA_MOCK", "VITE_MOCK_API", "NEXT_PUBLIC_DEMO", "REACT_APP_QA", "QA_MODE", "MOCK_BACKEND"]) assert.equal(isSafeQaEnvName(n), true, n);
    for (const n of ["OPENROUTER_API_KEY", "SECRET_TOKEN", "PATH", "NODE_OPTIONS", "EXPO_PUBLIC_lowercase", "QA", "MOCK", "AWS_SECRET_ACCESS_KEY", "QA_X; rm -rf /", ""]) assert.equal(isSafeQaEnvName(n), false, n);
  });
  test("both forms are accepted; a bad name, a long or multi-line or non-string value is dropped; at most twenty", () => {
    const s = sanitizeQaSetup({ env: [{ name: "QA_MODE", value: "demo" }, { name: "SECRET_TOKEN", value: "x" }, { name: "MOCK_A", value: "x".repeat(201) }, { name: "MOCK_B", value: "a\nb" }, { name: "MOCK_C", value: 1 }] });
    assert.deepEqual(s.env, { QA_MODE: "demo" });
    assert.deepEqual(sanitizeQaSetup({ env: { VITE_MOCK: "1", PATH: "/x" } }).env, { VITE_MOCK: "1" });
    const many = sanitizeQaSetup({ env: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`QA_V${i}`, "1"])) });
    assert.equal(Object.keys(many.env!).length, 20);
  });
  test("mockNotes is kept, trimmed and cut to 500 characters", () => {
    assert.equal(sanitizeQaSetup({ mockNotes: "  a fake pairing service, on when EXPO_PUBLIC_QA_MOCK=1  " }).mockNotes, "a fake pairing service, on when EXPO_PUBLIC_QA_MOCK=1");
    assert.equal(sanitizeQaSetup({ mockNotes: "x".repeat(900) }).mockNotes!.length, 500);
    assert.equal(sanitizeQaSetup({ mockNotes: "   " }).mockNotes, undefined);
  });
});

describe("what is stored", () => {
  test("links and variables accumulate by name across tickets (a later value for the same name wins); everything else is kept", () => {
    saveQaSetup(root, { launchPath: "/home", deepLinks: [{ name: "a", url: "/one" }, { name: "b", url: "/two" }], env: { QA_A: "1" }, mockNotes: "first" });
    saveQaSetup(root, { deepLinks: [{ name: "b", url: "/two-new" }, { name: "c", url: "/three" }], env: { QA_B: "2", QA_A: "9" }, mockNotes: "second" });
    const s = loadQaSetup(root);
    assert.deepEqual(s.deepLinks, [{ name: "a", url: "/one" }, { name: "b", url: "/two-new" }, { name: "c", url: "/three" }]);
    assert.deepEqual(s.env, { QA_A: "9", QA_B: "2" });
    assert.equal(s.launchPath, "/home");
    assert.equal(s.mockNotes, "second", "a note is replaced");
  });
  test("an old file with none of the new fields still loads", () => {
    fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "qa-setup.json"), JSON.stringify({ launchPath: "/x", localStorage: { k: "v" } }));
    assert.deepEqual(qaEnvFor(root), {});
    assert.equal(loadQaSetup(root).launchPath, "/x");
  });
  test("a hand-edited file cannot smuggle a bad name or link in: it is sanitised on load too", () => {
    fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "qa-setup.json"), JSON.stringify({ env: { QA_OK: "1", OPENROUTER_API_KEY: "sk-x" }, deepLinks: [{ name: "x", url: "javascript:1" }] }));
    assert.deepEqual(qaEnvFor(root), { QA_OK: "1" });
    assert.equal(loadQaSetup(root).deepLinks, undefined);
  });
  test("describeQaAccess: the readable line for the evidence, empty when nothing is arranged", () => {
    assert.equal(describeQaAccess({}), "");
    assert.equal(
      describeQaAccess({ mockNotes: "fake pairing on QA_MOCK", env: { QA_MOCK: "1" }, deepLinks: [{ name: "pair", url: "myapp://pair" }] }),
      "mocked or toggled for QA: fake pairing on QA_MOCK; started with: QA_MOCK=1; deep links: pair → myapp://pair"
    );
  });
});

describe("the tool the Editor uses", () => {
  const props = () => (TOOLS_SCHEMA.find((t: any) => t.function.name === "register_qa_setup") as any).function.parameters.properties;
  test("it takes deepLinks, env and mockNotes, and says which names are allowed and that a mock must be off unless its flag is set", () => {
    const p = props();
    assert.ok(p.deepLinks && p.env && p.mockNotes);
    assert.match(p.env.description, /EXPO_PUBLIC_, VITE_, NEXT_PUBLIC_, REACT_APP_, QA_ or MOCK_/);
    assert.match(p.mockNotes.description, /A mock must be off unless that flag is set/);
    assert.match(p.deepLinks.description, /open_link/);
  });
  test("the answer says what was recorded; a patch of only invalid values records nothing", async () => {
    const t = new AgentTools(root, { safety: {}, limits: {} } as any);
    const ok = await t.registerQaSetup({ deepLinks: [{ name: "pair", url: "myapp://pair" }], env: [{ name: "QA_MOCK", value: "1" }], mockNotes: "fake service" });
    assert.match(ok, /^QA setup saved: 1 deep link\(s\), 1 variable\(s\) QA starts the app with, what is mocked\./);
    assert.deepEqual(loadQaSetup(root).env, { QA_MOCK: "1" });
    const bad = await t.registerQaSetup({ deepLinks: [{ name: "x", url: "javascript:1" }], env: [{ name: "SECRET_TOKEN", value: "x" }] });
    assert.match(bad, /^Nothing valid to record/);
    assert.deepEqual(loadQaSetup(root).env, { QA_MOCK: "1" }, "the earlier value is untouched");
  });
});

describe("the contract and the dev server", () => {
  test("the Editor's instructions say to add the way in in the same ticket, the cheapest honest one, never on in production, and to say which", () => {
    assert.match(EDITOR_SYSTEM, /12d\. QA ACCESS:/);
    assert.match(EDITOR_SYSTEM, /the SAME ticket adds the way in, using the cheapest honest one, and you say which in howToVerify/);
    assert.match(EDITOR_SYSTEM, /web state: register_qa_setup launchPath/);
    assert.match(EDITOR_SYSTEM, /mock data or a mock endpoint[\s\S]*never enabled in production/);
    assert.match(EDITOR_SYSTEM, /a dev toggle:/);
    assert.match(EDITOR_SYSTEM, /a deep link:[\s\S]*register it with register_qa_setup deepLinks/);
    assert.match(EDITOR_SYSTEM, /A mock or toggle must be OFF unless the dev flag or QA env is set/);
    assert.match(EDITOR_SYSTEM, /If the only way in is real credentials or a live backend, do not fake it/);
  });
  test("every dev server QA starts gets the variables, and they cannot override the settings that keep it non-interactive", () => {
    const v = src("src/visualProbes.ts");
    assert.equal((v.match(/qaEnvFor\(repoRoot\)/g) ?? []).length, 3, "the npm run, the Expo web and the Python web starts");
    assert.ok(v.includes('env: { ...process.env, ...qaEnv, BROWSER: "none", CI: "1", FORCE_COLOR: "0" },'));
  });
});

describe("it is visible in the QA evidence, and never blocks", () => {
  const note = (setup: unknown) => {
    saveQaSetup(root, setup);
    const items: any[] = [];
    const v = Object.create(AutonomousVerifier.prototype) as any;
    v.repoRoot = root;
    v.qaAccessNote({ add: (x: any) => items.push(x) });
    return items;
  };
  test("what was arranged is listed as one informational item", () => {
    const items = note({ mockNotes: "fake pairing, on when QA_MOCK=1", env: { QA_MOCK: "1" }, deepLinks: [{ name: "pair", url: "myapp://pair" }] });
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].gate, items[0].status, items[0].blocking], ["QA access registered for this project", "pass", false]);
    assert.match(items[0].detail, /mocked or toggled for QA: fake pairing, on when QA_MOCK=1; started with: QA_MOCK=1; deep links: pair → myapp:\/\/pair/);
  });
  test("nothing arranged: nothing is added", () => {
    assert.deepEqual(note({ launchPath: "/home" }), []);
  });
  test("it is part of the verification, for a phase that changed something", () => {
    assert.ok(src("src/verifierTools.ts").includes("if (hasRealChange) this.qaAccessNote(ledger);"));
  });
});
