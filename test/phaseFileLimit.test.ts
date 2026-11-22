/**
 * The per-phase file limit is off by default (none of the safety rules depends on a count, and refusing an edit half-way leaves the work half-done), it still
 * works when a user sets one, and the focused tests the harness has the Editor write for every change are no longer reported as "outside the plan".
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import { ConfigSchema } from "../src/config.js";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "limit-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const tools = () => new AgentTools(root, { safety: {}, limits: {} } as any);
const warnings = async (fn: () => Promise<void>): Promise<string[]> => {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return seen;
};

describe("the limit", () => {
  test("none by default, and in the settings text", async () => {
    assert.equal((ConfigSchema.shape as any).limits.parse({}).maxFilesPerPhase, 0);
    assert.equal((ConfigSchema.shape as any).limits.parse({ maxFilesPerPhase: 7 }).maxFilesPerPhase, 7);
    assert.throws(() => (ConfigSchema.shape as any).limits.parse({ maxFilesPerPhase: -1 }));
    assert.match(fs.readFileSync("src/settings.ts", "utf8"), /0 = no limit \(the default\)/);
  });

  test("with no limit a phase may write as many files as it needs", async () => {
    const t = tools();
    t.beginPhase([], undefined as any, "big phase");
    for (let i = 0; i < 40; i++) await t.writeFile(`src/f${i}.ts`, `export const n = ${i};\n`);
    assert.equal(t.filesWrittenThisPhase().length, 40);
  });

  test("a limit that a user sets is still enforced, before anything is written, and names the file", async () => {
    const t = tools();
    t.beginPhase([], 3, "small phase");
    for (let i = 0; i < 3; i++) await t.writeFile(`src/f${i}.ts`, "x\n");
    await assert.rejects(() => t.writeFile("src/f3.ts", "x\n"), /\[WRITE BUDGET\] This phase has already modified 3 files \(limit 3\) and "src\/f3\.ts" would be another/);
    assert.equal(fs.existsSync(path.join(root, "src/f3.ts")), false, "refused up front");
    await t.writeFile("src/f1.ts", "again\n"); // a file already written is not another
  });

  test("the limit also comes from the settings when the phase does not pass one", async () => {
    const t = new AgentTools(root, { safety: {}, limits: { maxFilesPerPhase: 2 } } as any);
    t.beginPhase([], undefined as any, "p");
    await t.writeFile("a.ts", "x\n");
    await t.writeFile("b.ts", "x\n");
    await assert.rejects(() => t.writeFile("c.ts", "x\n"), /limit 2/);
  });
});

describe("the scope warning", () => {
  test("a real file outside the plan is still warned about; one in the plan is not", async () => {
    const t = tools();
    t.beginPhase(["src/planned.ts"], undefined as any, "p");
    const w = await warnings(async () => {
      await t.writeFile("src/planned.ts", "x\n");
      await t.writeFile("src/stray.ts", "x\n");
    });
    assert.equal(w.length, 1);
    assert.match(w[0], /^\[SCOPE\] ⚠️ "src\/stray\.ts" is outside this phase's planned files \(2 file\(s\) written this phase\)\.$/);
  });

  test("the focused tests the harness has the Editor write are never warned about", async () => {
    const t = tools();
    t.beginPhase(["src/planned.ts"], undefined as any, "p");
    const w = await warnings(async () => {
      await t.writeFile("__tests__/_focus/roadmapReducer.test.ts", "test('x', () => {});\n");
      await t.writeFile("packages/app/__tests__/_focus/other.test.ts", "test('y', () => {});\n");
      await t.writeFile("src/planned.ts", "x\n");
    });
    assert.deepEqual(w, []);
    assert.equal(t.filesWrittenThisPhase().length, 3, "they are still recorded as written (the change set depends on that)");
  });

  test("an ordinary test file outside the plan is exempt too (see scopeExemptTests.test.ts); a spec document is not", async () => {
    const t = tools();
    t.beginPhase(["src/planned.ts"], undefined as any, "p");
    const w = await warnings(async () => {
      await t.writeFile("__tests__/other.test.ts", "test('x', () => {});\n");
    });
    assert.equal(w.length, 1);
  });

  test("with a limit set, the warning shows how much of it is used", async () => {
    const t = tools();
    t.beginPhase(["src/planned.ts"], 5, "p");
    const w = await warnings(async () => {
      await t.writeFile("src/stray.ts", "x\n");
    });
    assert.match(w[0], /\(1\/5 used\)\.$/);
  });
});
