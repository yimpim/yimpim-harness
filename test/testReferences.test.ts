/**
 * What a change leaves behind in the tests is found from the change's own diff, across the whole suite, while the Editor still knows what it
 * did: the texts, routes and names it removed, minus anything the code still contains.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { staleTestReferences, renderReferences, termsOf, referencesKey } from "../src/testReferences.js";
import { AgentTools, TOOLS_SCHEMA } from "../src/agentTools.js";

let dir = "";
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8" });
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), s);
};
const commit = (m: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", m);
};

const CARD_BEFORE = [
  "export function PendingCard() {",
  "  return (",
  "    <View>",
  "      <Button accessibilityLabel=\"Dismiss\" title=\"Dismiss this question\" />",
  "      <Button testID=\"approve-btn\" title=\"Approve\" />",
  "      <Text>{'Pending question: continue?'}</Text>",
  "      <Link href=\"/settings\" />",
  "      <Text style={{ justifyContent: 'space-between' }}>Keep me</Text>",
  "    </View>",
  "  );",
  "}",
  "export function OldBanner() { return null; }",
  "",
].join("\n");
const CARD_AFTER = [
  "export function PendingCard() {",
  "  return (",
  "    <View>",
  "      <Button testID=\"approve-btn\" title=\"Approve\" />",
  "      <Text style={{ justifyContent: 'space-between' }}>Keep me</Text>",
  "    </View>",
  "  );",
  "}",
  "",
].join("\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "testrefs-"));
  git("init", "-q");
  write("src/Card.tsx", CARD_BEFORE);
  write(
    "__tests__/card.test.tsx",
    [
      "it('shows a way to dismiss', () => {",
      "  expect(labeled(r, 'Dismiss')).toHaveLength(1);",
      "  expect(text(r)).toContain('Pending question: continue?');",
      "  expect(labeled(r, 'Approve')).toHaveLength(1);",
      "  expect(byTestId(r, 'approve-btn')).toBeDefined();",
      "  expect(go).toHaveBeenCalledWith('/settings');",
      "  expect(OldBanner).toBeDefined();",
      "  expect(style).toBe('space-between');",
      "});",
      "",
    ].join("\n")
  );
  write("__tests__/other.test.tsx", "it('b', () => { expect(labeled(r, 'Dismiss')).toBeNull(); });\n");
  commit("base");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what a removed line names", () => {
  test("texts, test ids and routes and exported names are taken; style values and imports are not", () => {
    const t = termsOf(CARD_BEFORE.split("\n").concat(["import x from './Other';", "const a = require('left-pad-lib');"]));
    const names = t.map((x) => x.term).sort();
    assert.ok(names.includes("Dismiss this question"));
    assert.ok(names.includes("Pending question: continue?"));
    assert.ok(names.includes("/settings"));
    assert.ok(names.includes("PendingCard") && names.includes("OldBanner"));
    assert.ok(names.includes("Dismiss"), "an accessibilityLabel is a text a test looks for");
    assert.ok(!names.includes("space-between"), "a style value is not");
    assert.ok(!names.includes("./Other") && !names.includes("left-pad-lib"));
  });
  test("a label written as a JSX child is taken; a comparison or an arrow function is not", () => {
    const names = termsOf(["<Text>▾</Text>", "<Button>Dismiss</Button>", "<Text style={s}>Pending question</Text>", "if (a > 1 && b < 2) go();", "const f = (x) => x < 3;", "<View>{label}</View>"]).map((x) => x.term);
    assert.ok(names.includes("▾") && names.includes("Dismiss") && names.includes("Pending question"));
    assert.equal(names.filter((n) => /&&|=>|label/.test(n)).length, 0);
  });
  test("a one-character symbol used as a label is taken (a test looks for exactly it), a one-letter string is not", () => {
    const names = termsOf(["<Text>{open ? '▴' : '▾'}</Text>", "const a = 'x'; const b = 'ab';", "label: '✓ Done'"]).map((x) => x.term);
    assert.ok(names.includes("▴") && names.includes("▾") && names.includes("✓ Done"));
    assert.ok(!names.includes("x") && !names.includes("ab"));
  });
});

describe("what the tests still name after a change", () => {
  test("a removed button, message, route and component are found in every test that names them, with file and line", () => {
    write("src/Card.tsx", CARD_AFTER);
    const refs = staleTestReferences(dir, ["src/Card.tsx"]);
    const by = Object.fromEntries(refs.map((r) => [r.term, r]));
    assert.deepEqual(by["Dismiss"].hits.map((h) => `${h.file}:${h.line}`).sort(), ["__tests__/card.test.tsx:2", "__tests__/other.test.tsx:1"]);
    assert.equal(by["Pending question: continue?"].hits[0].line, 3);
    assert.equal(by["/settings"].kind, "route");
    assert.equal(by["OldBanner"].kind, "name");
    assert.equal(by["OldBanner"].hits[0].line, 7);
  });
  test("what the code still contains was moved or kept, not removed, so it is not listed", () => {
    write("src/Card.tsx", CARD_AFTER);
    const terms = staleTestReferences(dir, ["src/Card.tsx"]).map((r) => r.term);
    assert.ok(!terms.includes("Approve"), "Approve is still in the code");
    assert.ok(!terms.includes("approve-btn"));
    assert.ok(!terms.includes("PendingCard"), "still exported");
    assert.ok(!terms.includes("space-between"));
  });
  test("a text that moved to another file is not reported as removed", () => {
    write("src/Card.tsx", CARD_AFTER);
    write("src/Moved.tsx", "export const m = 'Pending question: continue?';\n");
    assert.ok(!staleTestReferences(dir, ["src/Card.tsx", "src/Moved.tsx"]).some((r) => r.term === "Pending question: continue?"));
  });
  test("a term no test names is not listed", () => {
    write("src/Card.tsx", CARD_AFTER);
    assert.ok(!staleTestReferences(dir, ["src/Card.tsx"]).some((r) => r.term === "Dismiss this question"));
  });
  test("a file that is deleted names everything it held", () => {
    fs.rmSync(path.join(dir, "src/Card.tsx"));
    const refs = staleTestReferences(dir, [], ["src/Card.tsx"]);
    assert.ok(refs.some((r) => r.term === "OldBanner") && refs.some((r) => r.term === "/settings"));
  });
  test("an edit to a test file, or a change nobody tests, lists nothing", () => {
    write("__tests__/card.test.tsx", "it('x', () => {});\n");
    assert.deepEqual(staleTestReferences(dir, ["__tests__/card.test.tsx"]), []);
    write("src/Card.tsx", CARD_BEFORE + "// a comment\n");
    assert.deepEqual(staleTestReferences(dir, ["src/Card.tsx"]), []);
  });
  test("the list reads as file:line with the line, and says how many more there are", () => {
    write("src/Card.tsx", CARD_AFTER);
    const text = renderReferences(staleTestReferences(dir, ["src/Card.tsx"]), 1);
    assert.match(text, /text "Dismiss" \(from src\/Card\.tsx\) — 2 place\(s\):/);
    assert.match(text, /__tests__\/card\.test\.tsx:2 {2}expect\(labeled\(r, 'Dismiss'\)\)\.toHaveLength\(1\);/);
    assert.match(text, /… and 1 more/);
    assert.equal(renderReferences([]), "");
  });
});

describe("the Editor's tool", () => {
  const tools = () => new AgentTools(dir, { safety: { blockedDirectories: [".git", "node_modules", ".agent"] }, limits: {} } as any, async () => "no");
  test("it is offered to the agents that edit", () => {
    assert.ok(TOOLS_SCHEMA.some((t) => t.function.name === "find_test_references"));
  });
  test("after an edit it lists what the tests still name, from the edits made in this phase", async () => {
    const t = tools();
    t.beginPhase(["src/Card.tsx"], 10, "p");
    await t.writeFile("src/Card.tsx", CARD_AFTER);
    const out = t.findTestReferences();
    assert.match(out, /text "Dismiss"/);
    assert.match(out, /never weaken or delete an assertion|Do not weaken or delete an assertion/);
    assert.match(out, /SPEC for a fix/);
  });
  test("with nothing left behind it says so", async () => {
    const t = tools();
    t.beginPhase(["src/Card.tsx"], 10, "p");
    await t.writeFile("src/Card.tsx", CARD_BEFORE + "// c\n");
    assert.match(t.findTestReferences(), /^No test names anything your edits removed or changed/);
  });
  test("at the point of finishing, a list not yet seen is handed back once, and the same list is never handed back twice", async () => {
    const t = tools();
    t.beginPhase(["src/Card.tsx"], 10, "p");
    await t.writeFile("src/Card.tsx", CARD_AFTER);
    const first = t.unseenTestReferences();
    assert.ok(first && /Update the lines that refer to what you changed, then conclude again/.test(first));
    assert.equal(t.unseenTestReferences(), undefined, "no loop: it is not sent twice");
  });
  test("a list the agent already asked for is not handed back again at the end", async () => {
    const t = tools();
    t.beginPhase(["src/Card.tsx"], 10, "p");
    await t.writeFile("src/Card.tsx", CARD_AFTER);
    t.findTestReferences();
    assert.equal(t.unseenTestReferences(), undefined);
  });
  test("a new phase starts fresh, and a changed list is a new list", async () => {
    const t = tools();
    t.beginPhase(["src/Card.tsx"], 10, "p");
    await t.writeFile("src/Card.tsx", CARD_AFTER);
    t.unseenTestReferences();
    t.beginPhase(["src/Card.tsx"], 10, "q");
    await t.writeFile("src/Card.tsx", CARD_AFTER + "\n");
    assert.ok(t.unseenTestReferences());
    assert.notEqual(referencesKey(staleTestReferences(dir, ["src/Card.tsx"])), "");
  });
});

describe("the wiring", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf-8").replace(/\r\n/g, "\n");
  test("the Editor is sent back once with the list before it concludes, except when the tests are the spec for a fix", () => {
    const loop = read("../src/agentLoop.ts");
    assert.ok(loop.includes('EDITING_AGENTS.has(agentName) && args.status === "FINISHED_PATCHING" && !anyMustPass()'));
    assert.ok(loop.includes("agentTools.unseenTestReferences()"));
    assert.ok(loop.includes('name === "find_test_references"'));
  });
  test("the Editor is told to use it, and not to weaken what should stay", () => {
    const p = read("../src/prompts.ts");
    assert.ok(p.includes("10a. TESTS THAT NAME WHAT YOU CHANGED"));
    assert.ok(p.includes("never weaken or delete an assertion about behaviour that should stay the same"));
  });
});
