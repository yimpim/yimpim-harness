/**
 * The phone's event stream, pinned from the parts that decide what it shows:
 *   - the Planner is ONE worker for a planning stage (its first pass, the question check and every re-plan share one card),
 *   - the pre-Planner threat triage folds into the Discover & Plan card,
 *   - a phone prompt is refused with the reason only when no valid lease is on disk, and checks disk every time.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlannerStage } from "../src/plannerStage.js";
import { translateForRemote, DISCOVER_AND_PLAN_PHASE_ID } from "../src/remoteEventTranslator.js";
import { remotePromptBlocker } from "../src/remote/auth.js";

const tempDirs: string[] = [];
const originalAuthFile = process.env.YIMPIM_AUTH_FILE;
let authFile = "";

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-stream-test-"));
  tempDirs.push(dir);
  authFile = path.join(dir, "auth.json");
  process.env.YIMPIM_AUTH_FILE = authFile;
});

after(async () => {
  if (originalAuthFile === undefined) delete process.env.YIMPIM_AUTH_FILE;
  else process.env.YIMPIM_AUTH_FILE = originalAuthFile;
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A signature is never checked offline, so a fake one is fine for expiry tests. */
function jwtWithExp(expSecs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1", exp: expSecs })}.fake-signature`;
}

function ids(): () => string {
  let n = 0;
  return () => `w-test-${++n}`;
}

describe("PlannerStage — one Planner worker per planning stage", () => {
  test("the first pass opens the worker; later passes fold into the same id and do not mint a new one", () => {
    const stage = new PlannerStage(ids(), () => 0);
    stage.begin();
    const first = stage.startPass();
    assert.equal(first.fold, false, "the first pass is the one that opens the worker");
    stage.endPass(100, 0.01);
    const check = stage.startPass();
    assert.equal(check.fold, true, "the question check folds into the open worker");
    assert.equal(check.workerId, first.workerId, "same workerId as the first pass");
    stage.endPass(40, 0.004);
    const replan = stage.startPass();
    assert.equal(replan.workerId, first.workerId, "the re-plan keeps the same workerId");
    assert.equal(replan.fold, true);
  });

  test("close() returns one worker's cumulative tokens, cost and pass count", () => {
    let t = 1_000;
    const stage = new PlannerStage(ids(), () => t);
    stage.begin();
    const { workerId } = stage.startPass();
    stage.endPass(100, 0.01);
    stage.startPass();
    stage.endPass(40, 0.004);
    t = 4_500;
    const end = stage.close();
    assert.deepEqual(end, { workerId, passes: 2, tokensUsed: 140, costUsd: 0.014, elapsedMs: 3_500 });
    assert.equal(stage.active, false, "the stage is closed");
  });

  test("cost is omitted when no pass reported one, rather than reported as zero", () => {
    const stage = new PlannerStage(ids(), () => 0);
    stage.begin();
    stage.startPass();
    stage.endPass(10, undefined);
    const end = stage.close();
    assert.equal(end?.tokensUsed, 10);
    assert.equal("costUsd" in (end ?? {}), false);
  });

  test("a stage with no pass closes to nothing: no worker.end for planning that never ran a Planner", () => {
    const stage = new PlannerStage(ids(), () => 0);
    stage.begin();
    assert.equal(stage.close(), undefined);
  });

  test("a new stage starts clean and mints its own id", () => {
    const stage = new PlannerStage(ids(), () => 0);
    stage.begin();
    const a = stage.startPass().workerId;
    stage.close();
    stage.begin();
    const b = stage.startPass();
    assert.notEqual(b.workerId, a);
    assert.equal(b.fold, false);
  });
});

describe("pre-Planner threat triage — folded into Discover & Plan", () => {
  test("a SECURITY pass with stage 'planning' carries parentPhaseId 'discover-and-plan'", () => {
    const out = translateForRemote(
      { type: "agent.start", agent: "SECURITY", models: ["m"], stage: "planning" },
      undefined,
      "task-1",
      "w-sec",
      true
    );
    assert.equal(out?.kind, "worker.start");
    assert.equal((out?.payload as any).parentPhaseId, DISCOVER_AND_PLAN_PHASE_ID);
    assert.equal(DISCOVER_AND_PLAN_PHASE_ID, "discover-and-plan");
    assert.equal((out?.payload as any).stage, "planning");
  });

  test("a SECURITY pass with no stage keeps no parent (no phase is running, so none is invented)", () => {
    const out = translateForRemote({ type: "agent.start", agent: "SECURITY", models: ["m"] }, undefined, "task-1", "w-sec", true);
    assert.equal((out?.payload as any).parentPhaseId, undefined);
    assert.equal((out?.payload as any).stage, undefined);
  });
});

describe("remotePromptBlocker — read from disk on every prompt", () => {
  test("no lease on disk: the prompt is refused, with the reason", () => {
    const reason = remotePromptBlocker();
    assert.ok(reason && /not linked to YIMPIM Pro/.test(reason));
  });

  test("a valid lease saved after the session started is seen at once, so the prompt is served", async () => {
    // Session started with nothing on disk (refused), then /link saves a lease: the very next check must pass.
    assert.notEqual(remotePromptBlocker(), null);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await fs.writeFile(authFile, JSON.stringify({ token: jwtWithExp(exp), savedAt: new Date().toISOString() }));
    assert.equal(remotePromptBlocker(), null, "a freshly linked machine is never told it is not linked");
  });

  test("an expired lease is refused again", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    await fs.writeFile(authFile, JSON.stringify({ token: jwtWithExp(exp), savedAt: new Date().toISOString() }));
    assert.notEqual(remotePromptBlocker(), null);
  });
});
