/**
 * QA's agent on a project with no screen: it reads, searches and runs under
 * the Editor's own policy, cites what it gathered, and only investigates when
 * an assertion failed or could not be verified.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { qaAgentSystemPrompt, qaCatalog, runQaAgent } from "../src/qaBrowserAgent.js";
import { projectBackend, redactSecrets } from "../src/qaProjectBackend.js";
import { AutonomousVerifier } from "../src/verifierTools.js";
import { EvidenceLedger } from "../src/evidence.js";

describe("redactSecrets", () => {
  test("masks credentials and tokens, leaves ordinary text alone", () => {
    const out = redactSecrets(
      "API_KEY=abcd1234efgh5678\nAuthorization: Bearer abcdefghijklmnop12345\nsk-abcdefghijklmnopqrstuvwx\nusing port 3000 and 12 rows"
    );
    assert.doesNotMatch(out, /abcd1234efgh5678/);
    assert.doesNotMatch(out, /abcdefghijklmnop12345/);
    assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuvwx/);
    assert.match(out, /using port 3000 and 12 rows/);
  });
  test("masks a private key block", () => {
    assert.match(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----"), /\[redacted private key\]/);
  });
});

describe("the project backend", () => {
  const hooks = () => {
    const calls: string[] = [];
    return {
      calls,
      hooks: {
        readFile: async (p: string) => (calls.push("read:" + p), "token=supersecretvalue123 ok"),
        searchCode: async (p: string) => (calls.push("search:" + p), "a.ts:1: x"),
        listFiles: async () => (calls.push("list"), "a.ts"),
        runCommand: async (a: any) => (calls.push("run:" + a.command), "[PASS] mytool export\n3 rows"),
      },
    };
  };

  test("it has no screenshot tool and says what it cannot do", () => {
    const { hooks: h } = hooks();
    const b = projectBackend(h);
    const names = qaCatalog(b).map((t) => t.name);
    assert.deepEqual(names, ["read_file", "search_code", "list_files", "run_command", "finish"]);
    const p = qaAgentSystemPrompt("the project", qaCatalog(b), "project", undefined);
    assert.match(p, /run anything except through run_command/);
    assert.match(p, /cite the evidence id/);
  });

  test("tool output is masked before the model sees it, and is registered as evidence", async () => {
    const { hooks: h } = hooks();
    const out = await projectBackend(h).run("read_file", { path: "config.txt" });
    assert.ok(out.evidence);
    assert.doesNotMatch(out.text!, /supersecretvalue123/);
  });

  test("run_command is passed through to the policy-checked hook", async () => {
    const { hooks: h, calls } = hooks();
    const out = await projectBackend(h).run("run_command", { command: "mytool export", purpose: "check" });
    assert.deepEqual(calls, ["run:mytool export"]);
    assert.match(out.text!, /3 rows/);
  });
});

describe("the agent on a project", () => {
  const run = (script: any[]) => {
    const calls: string[] = [];
    const b = projectBackend({
      readFile: async (p) => (calls.push("read:" + p), "export reads rows"),
      searchCode: async () => "none",
      listFiles: async () => "a",
      runCommand: async (a) => (calls.push("run:" + a.command), "[PASS] ok\n3 rows written"),
    });
    let i = 0;
    return runQaAgent({
      backend: b,
      goal: "export writes rows",
      surface: "the project",
      screenshotDir: ".",
      label: "t",
      failure: "A1 INCONCLUSIVE: export writes rows",
      complete: async () => JSON.stringify(script[Math.min(i++, script.length - 1)]),
    } as any).then((r) => ({ r, calls }));
  };

  test("it runs the thing and clears the assertion by citing the output", async () => {
    const { r, calls } = await run([
      { tool: "run_command", args: { command: "mytool export", purpose: "see it work" } },
      { tool: "finish", args: { states: [{ state: "A1", verdict: "PASS", evidence: "e1", reason: "3 rows written" }], unverified: [], reason: "r" } },
    ]);
    assert.deepEqual(calls, ["run:mytool export"]);
    assert.equal(r.status, "PASS");
    assert.equal(r.finished, true);
  });

  test("a PASS that cites nothing it gathered is not a pass", async () => {
    const { r } = await run([{ tool: "finish", args: { states: [{ state: "A1", verdict: "PASS", evidence: "e9", reason: "looks right" }], unverified: [], reason: "r" } }]);
    assert.equal(r.status, "INCONCLUSIVE");
    assert.match(r.reason, /without citing evidence that was gathered/);
  });

  test("a screenshot tool does not exist here", async () => {
    const { r, calls } = await run([{ tool: "screenshot", args: {} }, { tool: "screenshot", args: {} }, { tool: "screenshot", args: {} }]);
    assert.equal(r.finished, false);
    assert.deepEqual(calls, []);
  });
});

describe("assertions: investigate only on failure, clear only with evidence", () => {
  const make = (answer: any, agentScript: any[], withHooks = true) => {
    const v: any = Object.create((AutonomousVerifier as any).prototype);
    v.unreachableStates = [];
    v.askJson = async () => JSON.stringify(answer);
    let i = 0;
    v.config = { models: { verifier: ["m"] } };
    v.client = { complete: async () => ({ content: JSON.stringify(agentScript[Math.min(i++, agentScript.length - 1)]) }) };
    if (withHooks) {
      v.setProjectTools({
        readFile: async () => "src",
        searchCode: async () => "none",
        listFiles: async () => "a",
        runCommand: async () => "[PASS] export\n3 rows written",
      });
    }
    return v;
  };
  const goal = "Add export\n- [A1] export writes the rows to a CSV";
  const inconclusive = { verdicts: [{ id: "A1", verdict: "INCONCLUSIVE", evidence: "", reason: "nothing ran the command" }] };

  test("an inconclusive assertion is cleared when the agent runs it and cites the output", async () => {
    const v = make(inconclusive, [
      { tool: "run_command", args: { command: "mytool export", purpose: "p" } },
      { tool: "finish", args: { states: [{ state: "A1", verdict: "PASS", evidence: "e1", reason: "3 rows written" }], unverified: [], reason: "r" } },
    ]);
    const ledger = new EvidenceLedger();
    await v["assertionGate"](goal, undefined, ledger);
    const entry = ledger.all().find((e) => e.gate === "assertion A1")!;
    assert.equal(entry.status, "pass");
    assert.equal(v.unreachableStates.length, 0);
  });

  test("what the agent could not reach is reported with its cause, not the generic line", async () => {
    const v = make(inconclusive, [
      { tool: "finish", args: { states: [{ state: "A1", verdict: "INCONCLUSIVE", reason: "no database" }], unverified: ["A1: needs a running Postgres on :5432"], reason: "r" } },
    ]);
    await v["assertionGate"](goal, undefined, new EvidenceLedger());
    assert.deepEqual(v.unreachableStates, ["QA could not verify: A1: needs a running Postgres on :5432"]);
  });

  test("an agent that gives up leaves the verdict exactly as it was", async () => {
    const v = make(inconclusive, ["not json"]);
    const ledger = new EvidenceLedger();
    await v["assertionGate"](goal, undefined, ledger);
    assert.equal(ledger.all().find((e) => e.gate === "assertion A1")!.status, "inconclusive");
    assert.equal(v.unreachableStates.length, 1);
  });

  test("it does not run when everything already passed, or when no hooks are set", async () => {
    let called = 0;
    const passed = { verdicts: [{ id: "A1", verdict: "PASS", evidence: "3 rows written to out.csv", reason: "ok" }] };
    const v = make(passed, [{ tool: "finish", args: {} }]);
    v.client.complete = async () => (called++, { content: "{}" });
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "runtime", gate: "run", method: "observed", status: "pass", blocking: false, detail: "3 rows written to out.csv" });
    await v["assertionGate"](goal, undefined, ledger);
    assert.equal(called, 0);

    const none = make(inconclusive, [{ tool: "finish", args: {} }], false);
    none.client.complete = async () => (called++, { content: "{}" });
    await none["assertionGate"](goal, undefined, new EvidenceLedger());
    assert.equal(called, 0);
  });
});
