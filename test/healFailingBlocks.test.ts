/**
 * The failing tests' own code goes into the sandbox prompt, so the agent starts from the test instead of spending rounds searching for it. It matched
 * NOTHING for a while: it split a test's name on " > " but Jest joins the describe blocks and the test with " › " (a different character), so the
 * string it searched for ("Suite › Group › test") is on no line of the test file. Replayed against 17 real names from benchmark traces: 0 found as
 * written, 17 of 17 with the real separator. Every name here is shaped the way Jest prints it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { testTitleOf, extractFailingBlocks, buildSandboxPrompt, type SandboxCause } from "../src/healSandbox.js";

const FILE = [
  "import { x } from '../src/x';",
  "",
  "describe('Dashboard Timeline Components', () => {",
  "  describe('PendingQuestionCard', () => {",
  "    it('renders yes/no fallback answers using numbered choice cards', () => {",
  "      const r = render(<Card fallback=\"yes\" />);",
  "      expect(labeled(r, 'Yes')).toHaveLength(1);",
  "      expect(onAnswer).toHaveBeenCalledWith('q1', 'yes');",
  "    });",
  "",
  "    it('keeps blocking choices enabled and the send action gated on a draft', async () => {",
  "      await act(async () => { press(r, 'Something else'); });",
  "      expect(sendButton(r).props.disabled).toBe(true);",
  "    });",
  "  });",
  "  describe('Dashboard poll-stream notices and recovery', () => {",
  "    it('derives Send/Stop from desktop activity and waits for desktop status after Stop', async () => {",
  "      await deliver(r, statusEvent('RUNNING'), 1);",
  "      expect(labeled(r, 'Stop task').length).toBeGreaterThan(0);",
  "    });",
  "    it('expects the count x > 0 when the log has entries', () => {",
  "      expect(count(r)).toBeGreaterThan(0);",
  "    });",
  "    test.skip('a skipped one that is still a block', () => {",
  "      expect(1).toBe(1);",
  "    });",
  "  });",
  "});",
  "",
].join("\n");

describe("testTitleOf: the test's own title, from the name Jest prints", () => {
  test("after the last ' › '", () => {
    assert.equal(testTitleOf("Dashboard Timeline Components › PendingQuestionCard › renders yes/no fallback answers using numbered choice cards"), "renders yes/no fallback answers using numbered choice cards");
    assert.equal(testTitleOf("Suite › test"), "test");
  });
  test("a name with no separator is the title as it stands", () => {
    assert.equal(testTitleOf("just a title"), "just a title");
    assert.equal(testTitleOf("  padded  "), "padded");
  });
  test("a title that CONTAINS '>' is kept whole (only the real separator splits)", () => {
    assert.equal(testTitleOf("Suite › expects the count x > 0 when the log has entries"), "expects the count x > 0 when the log has entries");
  });
  test("the ASCII '>' is NOT the separator Jest uses: splitting on it leaves the full name (the old bug)", () => {
    const name = "Suite › Group › a test";
    assert.equal(name.split(" > ").pop(), name, "what the old code searched for");
    assert.notEqual(testTitleOf(name), name);
  });
});

describe("extractFailingBlocks: Jest-shaped names find their code", () => {
  const names = [
    "Dashboard Timeline Components › PendingQuestionCard › renders yes/no fallback answers using numbered choice cards",
    "Dashboard Timeline Components › Dashboard poll-stream notices and recovery › derives Send/Stop from desktop activity and waits for desktop status after Stop",
  ];
  test("each failing test's code is found, with its name and its line range, ending at the test's own closing brace", () => {
    const out = extractFailingBlocks(FILE, names);
    assert.match(out, /^\/\/ Dashboard Timeline Components › PendingQuestionCard › renders yes\/no fallback answers using numbered choice cards \(lines 3-9\)\n/);
    assert.match(out, /expect\(onAnswer\)\.toHaveBeenCalledWith\('q1', 'yes'\);\n\s+\}\);/);
    assert.match(out, /\/\/ Dashboard Timeline Components › Dashboard poll-stream notices and recovery › derives Send\/Stop[^\n]* \(lines 15-20\)/);
    assert.match(out, /expect\(labeled\(r, 'Stop task'\)\.length\)\.toBeGreaterThan\(0\);/);
  });
  test("it stops at the end of THAT test, not the next one's", () => {
    const out = extractFailingBlocks(FILE, [names[0]]);
    assert.doesNotMatch(out, /keeps blocking choices enabled/);
  });
  test("a title that contains '>' is found", () => {
    const out = extractFailingBlocks(FILE, ["Dashboard Timeline Components › Dashboard poll-stream notices and recovery › expects the count x > 0 when the log has entries"]);
    assert.match(out, /expect\(count\(r\)\)\.toBeGreaterThan\(0\);/);
  });
  test("a name joined with ' > ' (the benchmark's own listing does this) is found too, as a second try", () => {
    const out = extractFailingBlocks(FILE, ["PendingQuestionCard > renders yes/no fallback answers using numbered choice cards"]);
    assert.match(out, /expect\(labeled\(r, 'Yes'\)\)\.toHaveLength\(1\);/);
  });
  test("test.skip and async tests are blocks too; a name that is not in the file is skipped, not an error", () => {
    const out = extractFailingBlocks(FILE, ["Suite › a skipped one that is still a block", "Suite › a test that is nowhere in the file"]);
    assert.match(out, /a skipped one that is still a block/);
    assert.equal(out.includes("nowhere"), false);
  });
  test("nothing found is an empty string", () => {
    assert.equal(extractFailingBlocks(FILE, ["Suite › not here"]), "");
    assert.equal(extractFailingBlocks(FILE, []), "");
  });
  test("at most 8 tests, and the total is bounded", () => {
    const many = Array.from({ length: 12 }, (_, i) => `it('case ${i}', () => {\n  expect(${i}).toBe(${i});\n});`).join("\n");
    const out = extractFailingBlocks(many, Array.from({ length: 12 }, (_, i) => `S › case ${i}`));
    assert.equal((out.match(/^\/\/ S › case /gm) ?? []).length, 8);
    const big = ["it('big one', () => {", ...Array.from({ length: 60 }, (_, i) => `  const line${i} = '${"x".repeat(100)}';`), "});"].join("\n");
    assert.ok(extractFailingBlocks(big, ["S › big one"], 6000).length <= 6000);
    assert.equal(extractFailingBlocks(big + "\n" + big.replace("big one", "second"), ["S › big one", "S › second"], 9000).split("// S › ").length - 1, 1, "the second would exceed the bound");
  });
  test("a block too big for the bound is skipped, and a smaller one after it still gets in", () => {
    const big = ["it('huge', () => {", ...Array.from({ length: 60 }, (_, i) => `  const line${i} = '${"x".repeat(100)}';`), "});"].join("\n");
    const small = "it('small', () => {\n  expect(1).toBe(1);\n});";
    const out = extractFailingBlocks(`${big}\n${small}`, ["S › huge", "S › small"], 3000);
    assert.equal(out.includes("// S › huge"), false);
    assert.match(out, /^\/\/ S › small \(lines \d+-\d+\)/);
  });
});

describe("the prompt carries the code, from round one", () => {
  const cause: SandboxCause = {
    message: "Expected: > 0",
    count: 2,
    tests: ["Dashboard Timeline Components › Dashboard poll-stream notices and recovery › derives Send/Stop from desktop activity and waits for desktop status after Stop", "Dashboard Timeline Components › PendingQuestionCard › keeps blocking choices enabled and the send action gated on a draft"],
    reason: "could not settle it",
    kind: "unsure",
  };
  const prompt = (testText?: string) => buildSandboxPrompt({ file: "__tests__/d.test.ts", lineCount: 26, testText, cause, ledger: [], firstModelNotes: "", failureDigest: "digest" });

  test("with the test text, the failing tests' code is in the prompt under its own heading", () => {
    const p = prompt(FILE);
    assert.match(p, /FAILING TEST CODE \(already extracted — do not re-read these ranges\):/);
    assert.match(p, /await deliver\(r, statusEvent\('RUNNING'\), 1\);/);
    assert.match(p, /expect\(sendButton\(r\)\.props\.disabled\)\.toBe\(true\);/);
  });
  test("without it, there is no such section", () => {
    assert.doesNotMatch(prompt(undefined), /FAILING TEST CODE/);
  });
  test("it stays bounded: the extracted code adds at most about 6,500 characters to a prompt that is itself bounded", () => {
    const huge = ["describe('G', () => {", ...Array.from({ length: 8 }, (_, t) => ["  it('t" + t + " big', () => {", ...Array.from({ length: 50 }, (_, i) => `    const v${i} = '${"y".repeat(80)}';`), "  });"].join("\n")), "});"].join("\n");
    const many: SandboxCause = { ...cause, tests: Array.from({ length: 8 }, (_, t) => `G › t${t} big`) };
    const p = buildSandboxPrompt({ file: "__tests__/d.test.ts", lineCount: 500, testText: huge, cause: many, ledger: [], firstModelNotes: "", failureDigest: "d".repeat(50_000) });
    assert.ok(p.length < 8500 + 6700, `prompt is ${p.length} characters`);
    assert.match(p, /FAILING TEST CODE/);
  });
});
