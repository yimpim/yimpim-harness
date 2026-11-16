import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSecurityCache, ensureThreatModel, loadTaskSecurity, securityModels, writeTaskSecurity, parseTriage } from "../src/securityPlan.js";
import { AutonomousVerifier } from "../src/verifierTools.js";
import type { ChangeSet } from "../src/staticQa.js";

const repo = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  clearSecurityCache();
  return dir;
};
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "x", dependencies: deps });

describe("the security model is its own configurable role", () => {
  test("the chain is the security model, else the verifier's, else the planner's", () => {
    assert.deepEqual(securityModels({ security: ["s/frontier"], verifier: ["v/x"], planner: ["p/x"] }), ["s/frontier"]);
    assert.deepEqual(securityModels({ verifier: ["v/x"], planner: ["p/x"] }), ["v/x"]);
    assert.deepEqual(securityModels({ planner: ["p/x"] }), ["p/x"]);
    assert.deepEqual(securityModels({ security: [], verifier: [], planner: ["p/x"] }), ["p/x"]);
  });
  test("models.security is optional in the config and the per-task cap has a default and bounds", () => {
    const cfg = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf-8");
    assert.match(cfg, /security: z\.array\(z\.string\(\)\)\.min\(1\)\.optional\(\)/);
    assert.match(cfg, /reviewsPerTask: z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)\.default\(3\)/);
  });
  test("triage answers are read strictly", () => {
    assert.equal(parseTriage('{"sensitive": true, "surfaces": ["payments"]}'), true);
    assert.equal(parseTriage('prose {"sensitive": false} prose'), false);
    assert.equal(parseTriage("not json"), null);
    assert.equal(parseTriage('{"sensitive": "maybe"}'), null);
  });
});

describe("the expensive model is used only when it is needed", () => {
  const sensitiveModel = JSON.stringify({ sensitive: true, surfaces: ["payments"], assets: ["orders"], actors: ["user"], entryPoints: ["POST /pay"], abuseCases: [{ attack: "replay", impact: "x", mitigation: "idempotency" }], requirements: ["verify the signature"] });
  const run = async (triageAnswer: string | Error, withTriage = true) => {
    const dir = repo({ "package.json": pkg({ stripe: "14" }) });
    const calls: { label: string; models: string[] }[] = [];
    const r = await ensureThreatModel({
      call: async (models, _m, label) => {
        calls.push({ label, models });
        if (label === "threat triage") {
          if (triageAnswer instanceof Error) throw triageAnswer;
          return triageAnswer;
        }
        return sensitiveModel;
      },
      models: ["s/frontier"],
      triageModels: withTriage ? ["p/cheap"] : undefined,
      repoRoot: dir,
      request: "add checkout",
      log: () => {},
    });
    return { calls, r, dir };
  };
  test("a task that is not sensitive costs one cheap call and never reaches the security model", async () => {
    const { calls, r, dir } = await run(JSON.stringify({ sensitive: false }));
    assert.deepEqual(calls, [{ label: "threat triage", models: ["p/cheap"] }]);
    assert.equal(r.task.risky, false);
    assert.equal(loadTaskSecurity(dir)!.risky, false);
  });
  test("a sensitive task is triaged cheaply and the threat model is written by the security model", async () => {
    const { calls, r } = await run(JSON.stringify({ sensitive: true, surfaces: ["payments"] }));
    assert.deepEqual(calls.map((c) => [c.label, c.models[0]]), [["threat triage", "p/cheap"], ["threat model", "s/frontier"]]);
    assert.equal(r.task.risky, true);
  });
  test("an unusable or failed triage falls through to the security model rather than skipping the task", async () => {
    for (const triage of ["not json", new Error("down")]) {
      const { calls, r } = await run(triage);
      assert.deepEqual(calls.map((c) => c.label), ["threat triage", "threat model"]);
      assert.equal(r.task.risky, true);
    }
  });
  test("with no separate triage model there is a single call", async () => {
    const { calls } = await run("", false);
    assert.deepEqual(calls.map((c) => c.label), ["threat model"]);
  });
  test("the index gives the planner's models the triage and the security chain the threat model and /pentest", () => {
    const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    assert.match(idx, /models: securityModels\(config\.models\),\s*triageModels: config\.models\.planner/);
    assert.match(idx, /const secModels = securityModels\(config\.models\)/);
    assert.match(idx, /runLabeledCompletion\(\{ client, models: secModels/);
  });
});

const diffOf = (file: string, lines: string[]) => `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n${lines.map((l) => "+" + l).join("\n")}`;
const change = (file: string, lines: string[]): ChangeSet => ({ diff: diffOf(file, lines), modified: [], added: [file], deleted: [], renamed: [], isEmpty: false });

describe("the attacker-style review runs on the security model, with a per-task cap", () => {
  const ch = change("src/auth/login.ts", ["if (user.role = 'admin') grant();"]);
  const task = { risky: true, surfaces: ["authorisation"], assets: [], actors: [], entryPoints: [], abuseCases: [], requirements: ["x"], createdAt: "t" } as any;
  const make = (d: string, models: any, cap = 2) => {
    const asked: { models: string[]; agent: string }[] = [];
    const entries: any[] = [];
    const self: any = {
      config: { security: { enabled: true, review: true, reviewsPerTask: cap }, models },
      repoRoot: d,
      askJson: async (_s: string, _u: string, ms: string[], agent: string) => (asked.push({ models: ms, agent }), JSON.stringify({ findings: [] })),
    };
    const gate = () => (AutonomousVerifier.prototype as any).securityGate.call(self, "g", ch, { defectFound: false, findings: [], concerns: [], summary: "" }, { add: (e: any) => entries.push(e) });
    return { asked, entries, gate };
  };
  const project = () => repo({ "package.json": pkg({ express: "4" }), "src/auth/login.ts": "x\nx\nx\nx\nx" });

  test("it asks the security models as the SECURITY agent, not the verifier's", async () => {
    const d = project();
    writeTaskSecurity(d, task);
    const { asked, gate } = make(d, { security: ["s/frontier"], verifier: ["v/x"], planner: ["p/x"] });
    await gate();
    assert.ok(asked.length >= 1);
    assert.ok(asked.every((a) => a.models[0] === "s/frontier" && a.agent === "SECURITY"));
  });
  test("each review is counted in the task record; at the cap it is skipped with a clear note and no model call", async () => {
    const d = project();
    writeTaskSecurity(d, task);
    const { asked, entries, gate } = make(d, { security: ["s/frontier"], planner: ["p/x"] }, 2);
    await gate();
    assert.equal(loadTaskSecurity(d)!.reviews, 1);
    await gate();
    assert.equal(loadTaskSecurity(d)!.reviews, 2);
    const before = asked.length;
    await gate();
    assert.equal(asked.length, before, "no model call at the cap");
    const last = entries.at(-1);
    assert.equal(last.status, "inconclusive");
    assert.equal(last.blocking, false);
    assert.match(last.detail, /skipped: this task already had 2 attacker-style review\(s\) on the security model \(security\.reviewsPerTask is 2\)\. The pattern checks still ran/);
    assert.equal(loadTaskSecurity(d)!.reviews, 2, "a skipped review is not counted");
  });
  test("with no security model set it falls back to the verifier's", async () => {
    const d = project();
    writeTaskSecurity(d, task);
    const { asked, gate } = make(d, { verifier: ["v/x"], planner: ["p/x"] });
    await gate();
    assert.equal(asked[0].models[0], "v/x");
  });
});
