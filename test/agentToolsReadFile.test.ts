/**
 * Regression tests for AgentTools.readFile's startLine/endLine range — the
 * real fix for "a file too large to read whole": no fixed byte cap is ever
 * truly enough (some file will always be bigger), so instead of only ever
 * handing back a truncated first chunk with no way to reach what comes
 * after, a line range lets the model walk a huge file end to end across a
 * few calls. The returned slice must stay byte-for-byte the file's own
 * content (no inline line-number prefixes) so a patch_file search string
 * copied straight out of a ranged read still matches the real file.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-readfile-test-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function configWithCap(maxFileBytes: number): AgentConfig {
  return { limits: { maxFileBytes } } as AgentConfig;
}

describe("AgentTools.readFile — whole file (no range)", () => {
  test("returns the file untouched when it's under the cap", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "small.ts"), "line1\nline2\nline3\n");
    const tools = new AgentTools(dir, configWithCap(1000));
    const out = await tools.readFile("small.ts");
    assert.equal(out, "line1\nline2\nline3\n");
  });

  test("truncates with an explicit notice, mentioning the line-range escape hatch, when over the cap", async () => {
    const dir = await makeTempDir();
    const content = "x".repeat(1000);
    await fs.writeFile(path.join(dir, "big.ts"), content);
    const tools = new AgentTools(dir, configWithCap(100));
    const out = await tools.readFile("big.ts");
    assert.ok(out.startsWith("x".repeat(100)));
    assert.match(out, /truncated: big\.ts is 1000 bytes, showing first 100/);
    assert.match(out, /startLine\/endLine/, "the hint must point at the range escape hatch, not just get_file_outline/search_code");
  });
});

describe("AgentTools.readFile — startLine/endLine range", () => {
  test("returns exactly the requested range, with a bracketed header noting the range and total", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "file.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 5, 8);
    assert.match(out, /^\[file\.ts: showing lines 5-8 of 20 total\]\n/);
    assert.ok(out.includes("line5\nline6\nline7\nline8"), "must contain exactly lines 5-8, nothing more");
    assert.ok(!out.includes("line4"), "must not include the line just before the range");
    assert.ok(!out.includes("line9"), "must not include the line just after the range");
  });

  test("the returned slice content is byte-for-byte the file's own text -- no inline line-number prefixes", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "file.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 2, 2);
    // Strip the bracketed header line this function adds, then the rest
    // must be an EXACT match for the real line -- a patch_file search
    // string copied from here must still match the real file verbatim.
    const body = out.split("\n").slice(1).join("\n");
    assert.equal(body, "const y = 2;");
  });

  test("startLine alone reads from there to the end of the file", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "file.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 8);
    assert.match(out, /showing lines 8-10 of 10 total/);
    assert.ok(out.includes("line8\nline9\nline10"));
  });

  test("endLine alone reads from the start of the file up to there", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "file.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", undefined, 3);
    assert.match(out, /showing lines 1-3 of 10 total/);
    assert.ok(out.includes("line1\nline2\nline3"));
  });

  test("clamps an endLine past the real end of the file rather than erroring", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "file.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 3, 9999);
    assert.match(out, /showing lines 3-5 of 5 total/);
  });

  test("a startLine past the end of the file returns a clear message, not an empty/confusing result", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "file.ts"), "line1\nline2\nline3");
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 50);
    assert.match(out, /has only 3 line\(s\) total/);
  });

  test("startLine after endLine is reported as an invalid range, not silently swapped or ignored", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "file.ts"), "line1\nline2\nline3\nline4\nline5");
    const tools = new AgentTools(dir, configWithCap(100_000));

    const out = await tools.readFile("file.ts", 4, 2);
    assert.match(out, /Invalid range.*startLine \(4\) is after endLine \(2\)/);
  });

  test("a requested range that is itself too large for the cap is truncated with an explicit notice, not silently cut", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}: ${"x".repeat(20)}`);
    await fs.writeFile(path.join(dir, "file.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(50)); // far smaller than the requested range's own size

    const out = await tools.readFile("file.ts", 1, 100);
    assert.match(out, /showing the first 50\. Request a narrower line range to see the rest\./);
  });

  test("a huge file that's unreachable whole is fully reachable by walking it in two ranged calls", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "huge.ts"), lines.join("\n"));
    // A cap small enough that the whole file would truncate, but each half
    // (via range) fits comfortably -- proving the file is fully reachable
    // across two calls even though no single whole-file read could do it.
    const tools = new AgentTools(dir, configWithCap(200));

    const wholeFile = await tools.readFile("huge.ts");
    assert.match(wholeFile, /truncated/, "sanity check: the whole file genuinely doesn't fit in one read at this cap");

    const firstHalf = await tools.readFile("huge.ts", 1, 20);
    const secondHalf = await tools.readFile("huge.ts", 21, 40);
    assert.doesNotMatch(firstHalf, /truncated/);
    assert.doesNotMatch(secondHalf, /truncated/);
    for (let i = 1; i <= 20; i++) assert.ok(firstHalf.includes(`line${i}`), `line${i} must be in the first half`);
    for (let i = 21; i <= 40; i++) assert.ok(secondHalf.includes(`line${i}`), `line${i} must be in the second half`);
  });
});

describe("AgentTools.readFileBounded (Planner) — same range support, re-reading costs no extra budget slot", () => {
  test("a second, ranged read of the SAME already-inspected file does not consume another budget slot", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(dir, "a.ts"), lines.join("\n"));
    await fs.writeFile(path.join(dir, "b.ts"), "irrelevant");
    const tools = new AgentTools(dir, configWithCap(100_000));
    tools.beginPlannerInspection(["a.ts", "b.ts"], 1); // budget of exactly one file

    const first = await tools.readFileBounded("a.ts", 1, 10);
    assert.match(first, /showing lines 1-10 of 30 total/);

    // A second range on the SAME file must succeed even though the budget is 1.
    const second = await tools.readFileBounded("a.ts", 11, 20);
    assert.match(second, /showing lines 11-20 of 30 total/);

    // But a DIFFERENT file must still be refused -- the budget itself still works.
    await assert.rejects(() => tools.readFileBounded("b.ts"), /PLANNER INSPECTION BUDGET/);
  });
});

describe("AgentTools.plannerInspectedRangesThisPass — replaying a large file's chunked reads on a corrective retry", () => {
  test("records each readFileBounded call's exact (startLine, endLine), in order, per file", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "a.ts"), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));
    tools.beginPlannerInspection(["a.ts"]);

    await tools.readFileBounded("a.ts", 1, 10);
    await tools.readFileBounded("a.ts", 11, 20);

    assert.deepEqual(tools.plannerInspectedRangesThisPass().get("a.ts"), [
      { start: 1, end: 10 },
      { start: 11, end: 20 },
    ]);
  });

  test("a whole-file (no range) call is recorded as undefined/undefined, not omitted", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "a.ts"), "x".repeat(50));
    const tools = new AgentTools(dir, configWithCap(100_000));
    tools.beginPlannerInspection(["a.ts"]);

    await tools.readFileBounded("a.ts");

    assert.deepEqual(tools.plannerInspectedRangesThisPass().get("a.ts"), [{ start: undefined, end: undefined }]);
  });

  test("a file touched only via getSymbolDefinition has no entry — nothing to replay", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "a.ts"), "export function foo(): void {}\n");
    const tools = new AgentTools(dir, configWithCap(100_000));
    tools.beginPlannerInspection(["a.ts"]);

    await tools.getSymbolDefinition("a.ts", "foo");

    assert.equal(tools.plannerInspectedRangesThisPass().has("a.ts"), false);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["a.ts"]);
  });

  test("beginPlannerInspection clears ranges from the prior pass, same as it clears inspected files", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "a.ts"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const tools = new AgentTools(dir, configWithCap(100_000));
    tools.beginPlannerInspection(["a.ts"]);
    await tools.readFileBounded("a.ts", 1, 5);

    tools.beginPlannerInspection(["a.ts"]);

    assert.equal(tools.plannerInspectedRangesThisPass().has("a.ts"), false);
  });

  test("replaying the exact recorded chunks reconstructs a file too large for one whole-file read without truncation", async () => {
    const dir = await makeTempDir();
    // Each line is ~20 bytes; a cap of 150 bytes fits roughly 1-2 lines of a
    // whole-file read but comfortably fits each of the 3 chunks below.
    const lines = Array.from({ length: 90 }, (_, i) => `line${i + 1}: ${"x".repeat(10)}`);
    await fs.writeFile(path.join(dir, "big.ts"), lines.join("\n"));
    const tools = new AgentTools(dir, configWithCap(600));
    tools.beginPlannerInspection(["big.ts"]);

    // Simulate the first pass's own chunked walk of the file.
    await tools.readFileBounded("big.ts", 1, 30);
    await tools.readFileBounded("big.ts", 31, 60);
    await tools.readFileBounded("big.ts", 61, 90);

    const wholeFile = await tools.readFile("big.ts");
    assert.match(wholeFile, /truncated/, "sanity check: one whole-file read genuinely cannot fit this file at this cap");

    // Replaying the exact recorded ranges (what buildAlreadyInspectedSection does)
    // must reconstruct the full file, with no chunk truncated.
    const ranges = tools.plannerInspectedRangesThisPass().get("big.ts")!;
    const chunks = await Promise.all(ranges.map((r) => tools.readFile("big.ts", r.start, r.end)));
    for (const chunk of chunks) assert.doesNotMatch(chunk, /truncated/);
    for (let i = 1; i <= 90; i++) {
      assert.ok(chunks.some((c) => c.includes(`line${i}:`)), `line${i} must appear in some replayed chunk`);
    }
  });
});
