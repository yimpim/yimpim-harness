/**
 * Verification contracts, steps 2-4: Editor assertionDeltas, per-assertion QA
 * verdicts that are checked rather than trusted, and the planner's limited
 * requires:device / requires:credentials tags.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ASSERTION_DELTAS_GOAL_MARKER,
  ASSERTION_DELTAS_MARKER,
  buildAssertionPrompt,
  encodeAssertionDeltas,
  evidenceAppears,
  extractAssertionDeltas,
  parseGoalAssertions,
  parseGoalDeltas,
  reconcileVerdicts,
  renderDeltasForGoal,
  sanitizeAssertionDeltas,
} from "../src/assertionAudit.js";
import { normalizeVerificationIds } from "../src/verificationBullets.js";
import { phaseInstructions, phaseVerificationGoal } from "../src/planner.js";
import { AutonomousVerifier, HOW_TO_VERIFY_GOAL_MARKER, stableGoalKey } from "../src/verifierTools.js";
import { EvidenceLedger } from "../src/evidence.js";

const IDS = ["A1", "A2", "A3"];

describe("sanitizeAssertionDeltas", () => {
  test("keeps valid deltas and drops unknown ids, bad actions and reasonless ones", () => {
    const out = sanitizeAssertionDeltas(
      [
        { id: "A1", action: "modified", reason: "chip shows size too", replacement: "The filename and size are visible in the composer" },
        { id: "A9", action: "dropped", reason: "no such assertion" },
        { id: "A2", action: "vanish", reason: "x" },
        { id: "A3", action: "dropped", reason: "" },
        "junk",
      ],
      IDS
    );
    assert.deepEqual(out.map((d) => d.id), ["A1"]);
    assert.equal(out[0].replacement, "The filename and size are visible in the composer");
  });

  test("a vague replacement is discarded but the delta is kept", () => {
    const [d] = sanitizeAssertionDeltas([{ id: "a1", action: "modified", reason: "changed", replacement: "It works correctly" }], IDS);
    assert.equal(d.id, "A1");
    assert.equal(d.replacement, undefined);
  });

  test("a second delta for the same id is ignored; non-arrays give nothing", () => {
    const out = sanitizeAssertionDeltas(
      [
        { id: "A1", action: "dropped", reason: "first" },
        { id: "A1", action: "needs_device", reason: "second" },
      ],
      IDS
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].action, "dropped");
    assert.deepEqual(sanitizeAssertionDeltas(undefined, IDS), []);
  });
});

describe("delta transport", () => {
  test("round-trips through the conclude_task string, ahead of how-to-verify", () => {
    const deltas = [{ id: "A2", action: "needs_device" as const, reason: "uses the OS picker" }];
    const wire = `TASK_CONCLUDED: done${encodeAssertionDeltas(deltas)}\n\n[HOW TO VERIFY]\n1. tap x`;
    assert.deepEqual(extractAssertionDeltas(wire), deltas);
    assert.deepEqual(extractAssertionDeltas("TASK_CONCLUDED: done"), []);
    assert.ok(wire.includes(ASSERTION_DELTAS_MARKER));
  });

  test("round-trips through the QA goal text", () => {
    const deltas = [
      { id: "A1", action: "modified" as const, reason: "renamed", replacement: "The new title is visible" },
      { id: "A3", action: "dropped" as const, reason: "no longer applies" },
    ];
    assert.deepEqual(parseGoalDeltas(`goal${renderDeltasForGoal(deltas)}`), deltas);
    assert.equal(renderDeltasForGoal([]), "");
  });

  test("the stable goal key ignores the deltas section", () => {
    const base = "goal text";
    assert.equal(stableGoalKey(`${base}${HOW_TO_VERIFY_GOAL_MARKER}hint${ASSERTION_DELTAS_GOAL_MARKER}  - [A1] DROPPED: x`), base);
    assert.equal(stableGoalKey(`${base}${ASSERTION_DELTAS_GOAL_MARKER}  - [A1] DROPPED: x`), base);
  });
});

const mkPhase = (verification: string[]) => ({
  id: "phase-1",
  name: "n",
  goal: "g",
  executor: "EDITOR" as const,
  files: [] as string[],
  newFiles: [] as string[],
  changes: [] as string[],
  verification,
});

describe("goal parsing and the Editor prompt", () => {
  test("phaseVerificationGoal -> parseGoalAssertions keeps id, text, notes and requires", () => {
    const plan: any = { goal: "obj", phases: [] };
    const goal = phaseVerificationGoal(
      plan,
      mkPhase([
        "[A1] The row is visible",
        "[A2][requires:device] The system file picker opens",
        '[A3][weak] It works correctly',
        "[A4][label_unverified][requires:credentials] Tap \"Zorp\" shows the account page",
      ]) as any
    );
    const parsed = parseGoalAssertions(goal);
    assert.deepEqual(parsed.map((a) => a.id), ["A1", "A2", "A3", "A4"]);
    assert.equal(parsed[0].text, "The row is visible");
    assert.equal(parsed[1].text, "The system file picker opens");
    assert.equal(parsed[1].requires, "device");
    assert.ok(parsed[2].note);
    assert.equal(parsed[3].requires, "credentials");
    assert.ok(parsed[3].note);
    assert.equal(parsed[3].text, 'Tap "Zorp" shows the account page');
  });

  test("bullets after the how-to-verify hint are not criteria", () => {
    const goal = `Specifically confirm:\n  - [A1] a thing is visible${HOW_TO_VERIFY_GOAL_MARKER}1. step\n  - [A7] injected by the hint`;
    assert.deepEqual(parseGoalAssertions(goal).map((a) => a.id), ["A1"]);
  });

  test("the Editor is shown the criteria with ids and told how to report differences", () => {
    const plan: any = { goal: "obj", phases: [mkPhase(["[A1] The row is visible", "[A2] The count is 3"])] };
    const text = phaseInstructions(plan, plan.phases[0], 0);
    assert.match(text, /\[A1\] The row is visible/);
    assert.match(text, /\[A2\] The count is 3/);
    assert.match(text, /assertionDeltas/);
  });

  test("a plan without verification adds no criteria block", () => {
    const plan: any = { goal: "obj", phases: [mkPhase([])] };
    assert.doesNotMatch(phaseInstructions(plan, plan.phases[0], 0), /Acceptance criteria/);
  });
});

describe("requires tags", () => {
  test("only device and credentials survive normalisation", () => {
    const plan = {
      phases: [
        {
          name: "p",
          goal: "g",
          changes: [],
          newFiles: [],
          verification: ["[A1][requires:device] a", "[A2][requires:slow_network] b", "[A3][requires:credentials] c"],
        },
      ],
    };
    normalizeVerificationIds(plan);
    assert.deepEqual(plan.phases[0].verification, ["[A1][requires:device] a", "[A2] b", "[A3][requires:credentials] c"]);
  });
});

describe("reconcileVerdicts", () => {
  const assertions = [
    { id: "A1", text: "The row is visible" },
    { id: "A2", text: "The picker opens" },
    { id: "A3", text: "The count is 3" },
  ];
  const evidence = "[visual/observed/pass] web browser visual QA: the table shows a row labelled Alpha\nDIFF:\n+ count = 3";
  const answer = (verdicts: any[]) => ({ verdicts });

  test("a PASS with a real quote is accepted; one with an invented quote is not", () => {
    const out = reconcileVerdicts(
      assertions,
      [],
      answer([
        { id: "A1", verdict: "PASS", evidence: "a row labelled Alpha", reason: "shown" },
        { id: "A3", verdict: "PASS", evidence: "total equals three exactly", reason: "made up" },
      ]),
      evidence,
      false
    );
    assert.equal(out[0].verdict, "PASS");
    assert.equal(out[0].evidenceVerified, true);
    assert.equal(out[2].verdict, "INCONCLUSIVE");
    assert.match(out[2].reason, /not found/);
  });

  test("a FAIL with an unverifiable quote cannot block", () => {
    const [v] = reconcileVerdicts([assertions[0]], [], answer([{ id: "A1", verdict: "FAIL", evidence: "nothing like this exists", reason: "x" }]), evidence, false);
    assert.equal(v.verdict, "INCONCLUSIVE");
  });

  test("a FAIL with a real quote stands", () => {
    const [v] = reconcileVerdicts([assertions[2]], [], answer([{ id: "A3", verdict: "FAIL", evidence: "count = 3", reason: "wrong" }]), evidence, false);
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.evidenceVerified, true);
  });

  test("an id the model skipped is INCONCLUSIVE, an invented id is ignored", () => {
    const out = reconcileVerdicts(assertions, [], answer([{ id: "A9", verdict: "PASS", evidence: "a row labelled Alpha", reason: "" }]), evidence, false);
    assert.deepEqual(out.map((v) => v.verdict), ["INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"]);
    assert.match(out[0].reason, /no verdict/);
  });

  test("dropped is never a pass, whatever the model says", () => {
    const [v] = reconcileVerdicts(
      [assertions[0]],
      [{ id: "A1", action: "dropped", reason: "gone" }],
      answer([{ id: "A1", verdict: "PASS", evidence: "a row labelled Alpha", reason: "" }]),
      evidence,
      false
    );
    assert.equal(v.verdict, "DROPPED");
  });

  test("needs_device is honoured on a browser surface only", () => {
    const deltas = [{ id: "A2", action: "needs_device" as const, reason: "OS picker" }];
    const [onBrowser] = reconcileVerdicts([assertions[1]], deltas, answer([]), evidence, true);
    assert.equal(onBrowser.verdict, "NEEDS_DEVICE");
    const [onDevice] = reconcileVerdicts([assertions[1]], deltas, answer([]), evidence, false);
    assert.equal(onDevice.verdict, "INCONCLUSIVE", "judged like any other, and the model said nothing");
  });

  test("a model NEEDS_DEVICE on a device surface is not accepted", () => {
    const [v] = reconcileVerdicts([assertions[1]], [], answer([{ id: "A2", verdict: "NEEDS_DEVICE", evidence: "", reason: "camera" }]), evidence, false);
    assert.equal(v.verdict, "INCONCLUSIVE");
  });

  test("a requires:device assertion settles to NEEDS_DEVICE on a browser, and is judged on a device", () => {
    const a = [{ id: "A2", text: "The picker opens", requires: "device" as const }];
    assert.equal(reconcileVerdicts(a, [], answer([]), evidence, true)[0].verdict, "NEEDS_DEVICE");
    const judged = reconcileVerdicts(a, [], answer([{ id: "A2", verdict: "PASS", evidence: "a row labelled Alpha", reason: "ok" }]), evidence, false);
    assert.equal(judged[0].verdict, "PASS");
  });

  test("modifiedByEditor comes from the deltas, not the model", () => {
    const [v] = reconcileVerdicts(
      [assertions[0]],
      [{ id: "A1", action: "modified", reason: "changed" }],
      answer([{ id: "A1", verdict: "PASS", evidence: "a row labelled Alpha", reason: "ok", modifiedByEditor: false }]),
      evidence,
      false
    );
    assert.equal(v.modifiedByEditor, true);
  });

  test("evidenceAppears ignores case and punctuation but needs real length", () => {
    assert.ok(evidenceAppears("A ROW labelled alpha", evidence));
    assert.ok(!evidenceAppears("ok", "ok ok ok"));
  });

  test("the QA prompt carries the criteria, the claims and the hint separately", () => {
    const p = buildAssertionPrompt(
      [{ id: "A1", text: "The row is visible" }],
      [{ id: "A1", action: "modified", reason: "r" }],
      "tap the thing",
      "EVID"
    );
    assert.match(p, /ASSERTIONS:\n\[A1\] The row is visible/);
    assert.match(p, /REPORTED DIFFERENCES/);
    assert.match(p, /HOW-TO-VERIFY HINT \(non-binding\):\ntap the thing/);
    assert.match(p, /EVIDENCE:\nEVID/);
  });
});

describe("AutonomousVerifier.assertionGate", () => {
  const goal = (extra = "") =>
    `Phase under test: p\n\nSpecifically confirm:\n  - [A1] The row is visible\n  - [A2] The count is 3  (planner: requires a real device — x)${extra}`;

  const run = async (g: string, modelAnswer: unknown, withBrowser = true) => {
    const calls: any[] = [];
    const client: any = {
      complete: async (_m: string[], messages: any[]) => {
        calls.push(messages);
        return { content: JSON.stringify(modelAnswer) };
      },
    };
    const verifier = new AutonomousVerifier(process.cwd(), client, {} as any, { models: { verifier: ["m"] } } as any);
    const ledger = new EvidenceLedger();
    if (withBrowser) {
      ledger.add({ tier: "visual", gate: "web browser visual QA", method: "observed", status: "pass", blocking: false, detail: "the table shows a row labelled Alpha" });
    }
    await (verifier as any).assertionGate(g, undefined, ledger);
    return { ledger, calls };
  };

  test("a goal with no assertion ids does nothing and makes no model call", async () => {
    const { ledger, calls } = await run("just prose, no bullets", {});
    assert.equal(calls.length, 0);
    assert.equal(ledger.all().length, 1);
  });

  test("records per-assertion results: pass, and a device-tagged one as a skipped gap", async () => {
    const { ledger } = await run(goal(), { verdicts: [{ id: "A1", verdict: "PASS", evidence: "a row labelled Alpha", reason: "seen" }] });
    const a1 = ledger.all().find((e) => e.gate === "assertion A1")!;
    const a2 = ledger.all().find((e) => e.gate === "assertion A2")!;
    assert.equal(a1.status, "pass");
    assert.equal(a2.status, "skipped");
    assert.match(a2.degradedTo ?? "", /native device/);
    assert.equal(ledger.hasBlockingFailure(), false);
  });

  test("a verified FAIL blocks; the same FAIL on an Editor-modified criterion only advises", async () => {
    const fail = { verdicts: [{ id: "A1", verdict: "FAIL", evidence: "a row labelled Alpha", reason: "wrong row" }] };
    const blocked = await run(goal(), fail);
    assert.equal(blocked.ledger.hasBlockingFailure(), true);

    const modified = await run(
      goal(renderDeltasForGoalFor("A1")),
      fail
    );
    const e = modified.ledger.all().find((x) => x.gate === "assertion A1")!;
    assert.equal(e.status, "fail");
    assert.equal(e.blocking, false);
    assert.equal(modified.ledger.hasBlockingFailure(), false);
  });

  test("a dropped criterion is surfaced as inconclusive and never passes", async () => {
    const dropped = renderDeltasForGoal([{ id: "A1", action: "dropped", reason: "gone" }]);
    const { ledger } = await run(goal(dropped), { verdicts: [] });
    const a1 = ledger.all().find((e) => e.gate === "assertion A1")!;
    assert.equal(a1.status, "inconclusive");
    assert.match(a1.detail, /DROPPED/);
  });

  test("a model that errors leaves the other gates in charge", async () => {
    const client: any = { complete: async () => { throw new Error("boom"); } };
    const verifier = new AutonomousVerifier(process.cwd(), client, {} as any, { models: { verifier: ["m"] } } as any);
    const ledger = new EvidenceLedger();
    await (verifier as any).assertionGate(goal(), undefined, ledger);
    const e = ledger.all().find((x) => x.gate === "assertion verdicts")!;
    assert.equal(e.status, "error");
    assert.equal(ledger.hasBlockingFailure(), false);
  });
});

function renderDeltasForGoalFor(id: string): string {
  return renderDeltasForGoal([{ id, action: "modified", reason: "built it differently" }]);
}
