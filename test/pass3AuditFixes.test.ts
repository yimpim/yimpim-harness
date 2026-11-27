import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recordActiveSession,
  removeActiveSession,
  reapOrphanRemoteSessions,
} from "../src/remote/client.js";
import {
  failureSignature,
  evaluateRepairProgress,
  shouldSkipRepairPlannerOnFirstAttempt,
} from "../src/repairPolicy.js";
import { compactOldToolOutputs } from "../src/agentLoop.js";
import { AgentTools } from "../src/agentTools.js";
import { PhaseSchema, phaseInstructions } from "../src/planner.js";
import type { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-pass3-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseConfig = {
  prompts: { systemPersona: "You are YIMPIM." },
  limits: { maxToolRounds: 8, maxFileBytes: 50_000, maxFilesPerPhase: 10 },
  safety: { blockedDirectories: [], blockedFilePatterns: [] },
} as unknown as AgentConfig;

describe("Pass 3 audit improvements", () => {
  test("reapOrphanRemoteSessions unregisters dead-PID sessions and preserves live ones", async () => {
    const dir = await makeRepo();
    const regFile = path.join(dir, "active-sessions.json");
    recordActiveSession(
      { sessionId: "dead-sess", brokerUrl: "https://broker.yimpim.com", agentToken: "tok-dead", pid: 999991, startedAt: "2026-11-26T00:00:00Z" },
      regFile
    );
    recordActiveSession(
      { sessionId: "live-sess", brokerUrl: "https://broker.yimpim.com", agentToken: "tok-live", pid: 999992, startedAt: "2026-11-26T00:00:00Z" },
      regFile
    );

    const unregistered: string[] = [];
    const reaped = await reapOrphanRemoteSessions({
      filePath: regFile,
      isAlive: (pid) => pid === 999992,
      fetchFn: (async (_url: any, init?: any) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        unregistered.push(body.sessionId);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any,
    });

    assert.equal(reaped, 1);
    assert.deepEqual(unregistered, ["dead-sess"]);
    const remaining = JSON.parse(await fs.readFile(regFile, "utf-8"));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sessionId, "live-sess");

    removeActiveSession("live-sess", regFile);
    const afterRemove = JSON.parse(await fs.readFile(regFile, "utf-8"));
    assert.equal(afterRemove.length, 0);
  });

  test("failureSignature normalizes volatile timings/timestamps/temp paths while preserving line numbers", () => {
    const a = failureSignature([
      { tier: "build", gate: "jest", detail: "FAIL src/a.ts:12 at 2026-11-26T21:30:12.345Z in 145ms (yimpim-base-abc123, localhost:51234)" },
    ]);
    const b = failureSignature([
      { tier: "build", gate: "jest", detail: "FAIL src/a.ts:12 at 2026-11-26T21:31:59.999Z in 912ms (yimpim-base-xyz999, localhost:60001)" },
    ]);
    assert.equal(a, b);

    const c = failureSignature([
      { tier: "build", gate: "jest", detail: "FAIL src/a.ts:99 at 2026-11-26T21:31:59.999Z in 912ms" },
    ]);
    assert.notEqual(a, c);
  });

  test("evaluateRepairProgress catches A->B->A oscillation cycles via seenSignatures", () => {
    const seen = new Set<string>(["sig-A", "sig-B"]);
    // Attempt 2 produces sig-A again (oscillation: A -> B -> A), even though previous was sig-B
    const outcome = evaluateRepairProgress(2, "sig-A", "sig-B", false, true, seen);
    assert.deepEqual(outcome, { kind: "switch_to_backup" });
    const stopOutcome = evaluateRepairProgress(3, "sig-A", "sig-B", true, true, seen);
    assert.deepEqual(stopOutcome, { kind: "stop" });
  });

  test("shouldSkipRepairPlannerOnFirstAttempt gates Hydrogen on simple single-cause attempt 1 errors", () => {
    const simple = [{ tier: "build", gate: "tsc", detail: "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'." }];
    assert.equal(
      shouldSkipRepairPlannerOnFirstAttempt({
        attempt: 1,
        madeNoChanges: false,
        blockingFailures: simple,
        externalPathsCount: 0,
        runtimeOrVisualFailed: false,
        hasManifestHint: false,
      }),
      true
    );
    // Attempt 2 escalates to Hydrogen REPAIR_PLANNER
    assert.equal(
      shouldSkipRepairPlannerOnFirstAttempt({
        attempt: 2,
        madeNoChanges: false,
        blockingFailures: simple,
        externalPathsCount: 0,
        runtimeOrVisualFailed: false,
        hasManifestHint: false,
      }),
      false
    );
    // External path or runtime/visual failure still invokes Hydrogen on attempt 1
    assert.equal(
      shouldSkipRepairPlannerOnFirstAttempt({
        attempt: 1,
        madeNoChanges: false,
        blockingFailures: simple,
        externalPathsCount: 1,
        runtimeOrVisualFailed: false,
        hasManifestHint: false,
      }),
      false
    );
  });

  test("compactOldToolOutputs compacts only old oversized tool outputs above high-water mark", () => {
    const big = "X".repeat(10_000);
    const msgs: any[] = [
      { role: "system", content: "static sys" },
      { role: "user", content: "initial prompt" },
      { role: "assistant", content: "calling read" },
      { role: "tool", name: "read_file", content: big },
      { role: "assistant", content: "recent 1" },
      { role: "tool", name: "read_file", content: big },
    ];
    // Below high-water mark -> 0 compacted
    assert.equal(compactOldToolOutputs(msgs, 50_000, 2), 0);
    // Above high-water mark -> only the old tool output (index 3) is compacted; tail (index 5) untouched
    assert.equal(compactOldToolOutputs(msgs, 15_000, 2), 1);
    assert.match(msgs[3].content, /^\[compacted earlier read_file output: 10000 chars\]/);
    assert.equal(msgs[5].content.length, 10_000);
  });

  test("readFiles caps aggregate batch bytes and PhaseSchema renders optional anchors", async () => {
    const dir = await makeRepo();
    const chunk = "export const line = '012345678901234567890123456789';\n".repeat(800);
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(dir, `f${i}.ts`), chunk);
    }
    const tools = new AgentTools(dir, baseConfig);
    const out = await tools.readFiles(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"]);
    assert.match(out, /omitted to keep batch under 150000 bytes/);

    const parsed = PhaseSchema.parse({
      id: "p1",
      name: "Update handler",
      goal: "Update foo",
      files: ["src/foo.ts"],
      changes: ["Change return value"],
      anchors: ["src/foo.ts:L42 export function bar"],
      verification: ["[A1] bar returns 2"],
    });
    const text = phaseInstructions({ goal: "Test", phases: [parsed] } as any, parsed as any, 0);
    assert.match(text, /Edit anchors \(exact locations to inspect\/patch\):/);
    assert.match(text, /src\/foo\.ts:L42 export function bar/);
  });
});
