import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/evidence.js";
import { events, YimpimEvent } from "../src/events.js";

describe("EvidenceLedger", () => {
  test("passes with no entries at all", () => {
    const ledger = new EvidenceLedger();
    const verdict = ledger.verdict();
    assert.equal(verdict.passed, true);
    assert.equal(verdict.confidence, "static-only");
  });

  test("hasBlockingFailure is false until a blocking fail is added", () => {
    const ledger = new EvidenceLedger();
    assert.equal(ledger.hasBlockingFailure(), false);

    ledger.add({ tier: "static", gate: "change set", method: "inspected", status: "fail", blocking: false, detail: "advisory only" });
    assert.equal(ledger.hasBlockingFailure(), false, "a non-blocking fail must not count");

    ledger.add({ tier: "static", gate: "change set", method: "inspected", status: "fail", blocking: true, detail: "real defect" });
    assert.equal(ledger.hasBlockingFailure(), true);
  });

  test("a blocking fail flips the verdict to FAIL; everything else stays PASS", () => {
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "build", gate: "compile", method: "executed", status: "pass", blocking: true, detail: "ok" });
    assert.equal(ledger.verdict().passed, true);

    ledger.add({ tier: "semantic", gate: "requirement coverage", method: "inspected", status: "fail", blocking: true, detail: "UNMET: x" });
    assert.equal(ledger.verdict().passed, false);
  });

  test("confidence reflects how much was actually executed/observed, not pass/fail", () => {
    const staticOnly = new EvidenceLedger();
    staticOnly.add({ tier: "semantic", gate: "requirement coverage", method: "inspected", status: "pass", blocking: false, detail: "ok" });
    assert.equal(staticOnly.verdict().confidence, "static-only");

    const partial = new EvidenceLedger();
    partial.add({ tier: "build", gate: "compile", method: "executed", status: "pass", blocking: true, detail: "ok" });
    assert.equal(partial.verdict().confidence, "partial");

    const verified = new EvidenceLedger();
    verified.add({ tier: "runtime", gate: "web browser launch", method: "observed", status: "pass", blocking: true, detail: "ok" });
    assert.equal(verified.verdict().confidence, "verified");

    // A build entry alone is "partial"; observed runtime/visual evidence always wins to "verified".
    const both = new EvidenceLedger();
    both.add({ tier: "build", gate: "compile", method: "executed", status: "pass", blocking: true, detail: "ok" });
    both.add({ tier: "visual", gate: "web browser visual QA", method: "observed", status: "pass", blocking: false, detail: "ok" });
    assert.equal(both.verdict().confidence, "verified");
  });

  test("a fail is only 'verified'-eligible via pass OR fail status, not skipped/inconclusive", () => {
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "runtime", gate: "web browser launch", method: "unavailable", status: "skipped", blocking: false, detail: "no browser" });
    assert.equal(ledger.verdict().confidence, "static-only", "a skipped runtime gate must not count as observed");
  });

  test("unavailable() records a non-blocking skip with the degradedTo path", () => {
    const ledger = new EvidenceLedger();
    const entry = ledger.unavailable("visual", "visual QA", "no UI surface", "static source review");
    assert.equal(entry.status, "skipped");
    assert.equal(entry.blocking, false);
    assert.equal(entry.degradedTo, "static source review");

    const verdict = ledger.verdict();
    assert.equal(verdict.degradations.length, 1);
    assert.equal(verdict.degradations[0].gate, "visual QA");
  });

  test("advisories capture non-blocking fail/inconclusive/error, and exclude pass/skipped", () => {
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "visual", gate: "a", method: "observed", status: "pass", blocking: false, detail: "fine" });
    ledger.add({ tier: "visual", gate: "b", method: "observed", status: "inconclusive", blocking: false, detail: "unclear" });
    ledger.add({ tier: "static", gate: "c", method: "inspected", status: "error", blocking: false, detail: "reviewer down" });
    ledger.unavailable("build", "d", "no toolchain", "static review"); // skipped -> degradation, not advisory

    const verdict = ledger.verdict();
    const advisoryGates = verdict.advisories.map((a) => a.gate).sort();
    assert.deepEqual(advisoryGates, ["b", "c"]);
  });

  test("artifacts() flattens across every entry", () => {
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "visual", gate: "a", method: "observed", status: "pass", blocking: false, detail: "x", artifacts: ["shot1.png"] });
    ledger.add({ tier: "visual", gate: "b", method: "observed", status: "fail", blocking: true, detail: "y", artifacts: ["shot2.png", "shot3.png"] });
    assert.deepEqual(ledger.artifacts(), ["shot1.png", "shot2.png", "shot3.png"]);
  });

  // Regression test for a latent bug: an entry that's both blocking:true and
  // status:"error" matched neither blockingFailures (requires status:"fail")
  // nor the old advisories filter (required !blocking) — it vanished from
  // the report entirely. No current gate constructs this combination, but
  // nothing stopped a future one from doing so silently.
  test("a blocking gate that errored (rather than cleanly failing) surfaces as an advisory, not a silent pass", () => {
    const ledger = new EvidenceLedger();
    ledger.add({ tier: "build", gate: "compile", method: "executed", status: "error", blocking: true, detail: "compiler crashed" });

    const verdict = ledger.verdict();
    // "error" is never itself defect evidence — it must not fail the run.
    assert.equal(verdict.passed, true);
    // But it must not vanish either — it has to show up somewhere.
    assert.equal(verdict.advisories.length, 1);
    assert.equal(verdict.advisories[0].gate, "compile");
  });

  test("add() emits a gate.result event carrying the entry's artifacts, for the remote wire translator to forward", () => {
    const seen: Extract<YimpimEvent, { type: "gate.result" }>[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "gate.result") seen.push(e);
    });
    try {
      const ledger = new EvidenceLedger();
      ledger.add({
        tier: "visual",
        gate: "Race screen visual QA",
        method: "observed",
        status: "fail",
        blocking: true,
        detail: "throw button missing",
        artifacts: ["shot1.png"],
      });
    } finally {
      unsubscribe();
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].artifacts, ["shot1.png"]);
  });

  test("add() emits a gate.result event with artifacts undefined when the entry has none", () => {
    const seen: Extract<YimpimEvent, { type: "gate.result" }>[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "gate.result") seen.push(e);
    });
    try {
      const ledger = new EvidenceLedger();
      ledger.add({ tier: "build", gate: "compile/build", method: "executed", status: "pass", blocking: false, detail: "ok" });
    } finally {
      unsubscribe();
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].artifacts, undefined);
  });
});
