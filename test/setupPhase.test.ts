import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInstallOutput,
  parseSetupDiagnosis,
  manifestEditsForbidden,
  runSetupPhase,
  type SetupPhaseDeps,
  type SetupDiagnosis,
} from "../src/setupPhase.js";
import { parsePlan, validatePlan } from "../src/planner.js";

const CLEAN = `
added 1534 packages, and audited 1535 packages in 41s

312 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
`;

const NOISY_BUT_FINE = `
npm warn deprecated inflight@1.0.6: This module is not supported
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
added 900 packages, and audited 901 packages in 20s
5 vulnerabilities (2 moderate, 3 high)
`;

const ERESOLVE = `
npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error While resolving: react-native@0.74.0
npm error Found: react@18.3.1
npm error Could not resolve dependency:
npm error peer react@"18.2.0" from react-native@0.74.0
`;

const PEER_WARN_BUT_OK = `
npm warn ERESOLVE overriding peer dependency
added 10 packages in 2s
`;

describe("analyzeInstallOutput", () => {
  test("a routine clean install is clean (no model call needed)", () => {
    const a = analyzeInstallOutput(true, CLEAN);
    assert.equal(a.verdict, "clean");
    assert.deepEqual(a.signals, []);
  });

  test("deprecation and audit chatter does not make an install noteworthy", () => {
    assert.equal(analyzeInstallOutput(true, NOISY_BUT_FINE).verdict, "clean");
  });

  test("a non-zero exit is failed, with the flagged lines", () => {
    const a = analyzeInstallOutput(false, ERESOLVE);
    assert.equal(a.verdict, "failed");
    assert.ok(a.signals.some((s) => /ERESOLVE/.test(s)));
  });

  test("exit 0 that still printed a peer conflict is noteworthy, not clean", () => {
    const a = analyzeInstallOutput(true, PEER_WARN_BUT_OK);
    assert.equal(a.verdict, "noteworthy");
    assert.ok(a.signals.length > 0);
  });

  test("a failed install with no recognizable line is still failed", () => {
    assert.equal(analyzeInstallOutput(false, "something odd").verdict, "failed");
  });
});

describe("parseSetupDiagnosis", () => {
  test("parses a fenced JSON verdict and fills defaults", () => {
    const d = parseSetupDiagnosis('```json\n{"assessment":"benign","summary":"just notices"}\n```');
    assert.equal(d?.assessment, "benign");
    assert.deepEqual(d?.edits, []);
    assert.deepEqual(d?.manualSteps, []);
  });

  test("rejects an unknown assessment and non-JSON", () => {
    assert.equal(parseSetupDiagnosis('{"assessment":"maybe"}'), undefined);
    assert.equal(parseSetupDiagnosis("I think it is fine."), undefined);
  });
});

describe("manifestEditsForbidden", () => {
  test("reads the constraint from the phase text", () => {
    assert.equal(
      manifestEditsForbidden(
        "run npm install to rehydrate node_modules using the existing lockfile; do not edit the manifest or lockfile to force installation."
      ),
      true
    );
    assert.equal(manifestEditsForbidden("Install dependencies and fix any version conflicts."), false);
  });
});

function deps(over: Partial<SetupPhaseDeps> & { runs: { ok: boolean; output: string }[] }): {
  d: SetupPhaseDeps;
  state: { ran: number; diagnosed: number; edits: string[]; approved: number };
} {
  const state = { ran: 0, diagnosed: 0, edits: [] as string[], approved: 0 };
  const { runs, ...rest } = over;
  const d: SetupPhaseDeps = {
    steps: [{ command: "npm install", cwd: "/repo" }],
    maxRuns: 3,
    editsAllowed: true,
    approve: async () => {
      state.approved++;
      return true;
    },
    runStep: async () => {
      const r = runs[Math.min(state.ran, runs.length - 1)];
      state.ran++;
      return r;
    },
    diagnose: async () => {
      state.diagnosed++;
      return undefined;
    },
    applyEdit: async (e) => {
      state.edits.push(e.file);
    },
    isEditableManifest: (f) => f === "package.json",
    ...rest,
  };
  return { d, state };
}

const diag = (over: Partial<SetupDiagnosis>): SetupDiagnosis => ({
  assessment: "blocked",
  summary: "",
  edits: [],
  manualSteps: [],
  ...over,
});

describe("runSetupPhase", () => {
  test("clean install passes with NO diagnosis call", async () => {
    const { d, state } = deps({ runs: [{ ok: true, output: CLEAN }] });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, true);
    assert.equal(state.diagnosed, 0);
    assert.equal(state.ran, 1);
  });

  test("a declined approval runs nothing and fails with a manual step", async () => {
    const { d, state } = deps({ runs: [{ ok: true, output: CLEAN }], approve: async () => false });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.equal(r.declined, true);
    assert.equal(state.ran, 0);
    assert.equal(r.manualSteps.length, 1);
  });

  test("failed install -> fixable diagnosis -> manifest edited -> re-run clean -> pass", async () => {
    const { d, state } = deps({
      runs: [
        { ok: false, output: ERESOLVE },
        { ok: true, output: CLEAN },
      ],
      diagnose: async () =>
        diag({
          assessment: "fixable",
          summary: "react pinned too low",
          edits: [{ file: "package.json", search: '"react": "18.2.0"', replace: '"react": "18.3.1"' }],
        }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, true);
    assert.equal(r.runs, 2);
    assert.deepEqual(state.edits, ["package.json"]);
    assert.deepEqual(r.edited, ["package.json"]);
  });

  test("edits are refused for a lockfile/non-manifest path, and the phase fails", async () => {
    const { d, state } = deps({
      runs: [{ ok: false, output: ERESOLVE }],
      diagnose: async () =>
        diag({
          assessment: "fixable",
          summary: "delete the lock",
          edits: [{ file: "package-lock.json", search: "a", replace: "b" }],
        }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.deepEqual(state.edits, []);
    assert.equal(state.ran, 1);
  });

  test("editsAllowed=false (phase forbids manifest edits): fixable becomes a stop, not an edit", async () => {
    const { d, state } = deps({
      runs: [{ ok: false, output: ERESOLVE }],
      editsAllowed: false,
      diagnose: async () =>
        diag({
          assessment: "fixable",
          summary: "bump react",
          edits: [{ file: "package.json", search: "a", replace: "b" }],
          manualSteps: [{ step: "Bump react to 18.3.1", reason: "peer conflict" }],
        }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.deepEqual(state.edits, []);
    assert.equal(r.manualSteps[0].step, "Bump react to 18.3.1");
  });

  test("benign diagnosis on a successful-but-noisy install passes", async () => {
    const { d, state } = deps({
      runs: [{ ok: true, output: PEER_WARN_BUT_OK }],
      diagnose: async () => diag({ assessment: "benign", summary: "optional peer, unused" }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, true);
    assert.equal(state.ran, 1);
  });

  test("benign can never excuse a FAILED install", async () => {
    const { d } = deps({
      runs: [{ ok: false, output: ERESOLVE }],
      diagnose: async () => diag({ assessment: "benign", summary: "fine" }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
  });

  test("blocked on a failed install fails and surfaces the manual steps", async () => {
    const { d } = deps({
      runs: [{ ok: false, output: "npm error code ENOTFOUND\nnpm error network request failed" }],
      diagnose: async () =>
        diag({
          assessment: "blocked",
          summary: "registry unreachable",
          manualSteps: [{ step: "Check your network / registry", reason: "ENOTFOUND" }],
        }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.equal(r.summary, "registry unreachable");
    assert.equal(r.manualSteps.length, 1);
  });

  test("the same failure again after a 'fix' stops instead of looping", async () => {
    const { d, state } = deps({
      runs: [{ ok: false, output: ERESOLVE }],
      maxRuns: 5,
      diagnose: async () =>
        diag({
          assessment: "fixable",
          summary: "try",
          edits: [{ file: "package.json", search: "a", replace: "b" }],
        }),
    });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.equal(state.ran, 2); // first run, one fix, identical failure -> stop
  });

  test("an unparseable diagnosis on an OK install passes with a warning; on a failed one it fails", async () => {
    const ok = await runSetupPhase(deps({ runs: [{ ok: true, output: PEER_WARN_BUT_OK }] }).d);
    assert.equal(ok.passed, true);
    const bad = await runSetupPhase(deps({ runs: [{ ok: false, output: ERESOLVE }] }).d);
    assert.equal(bad.passed, false);
  });

  test("no manifest found: fails with a manual step and runs nothing", async () => {
    const { d, state } = deps({ runs: [{ ok: true, output: CLEAN }], steps: [] });
    const r = await runSetupPhase(d);
    assert.equal(r.passed, false);
    assert.equal(state.ran, 0);
    assert.equal(state.approved, 0);
  });
});

describe("planner executor field", () => {
  const plan = (phases: unknown[]) =>
    "```json\n" + JSON.stringify({ goal: "g", phases }) + "\n```";

  test("defaults to EDITOR when the planner (or an old resume file) omits it", () => {
    const r = parsePlan(
      plan([{ id: "phase-1", name: "n", goal: "g", files: ["a.ts"], changes: ["c"], verification: ["v"] }]),
      "fallback"
    );
    assert.equal(r.plan.phases[0].executor, "EDITOR");
  });

  test("accepts QA and SETUP (case-insensitively) and falls back to EDITOR on garbage", () => {
    const r = parsePlan(
      plan([
        { id: "p1", name: "a", goal: "g", executor: "setup", verification: ["v"] },
        { id: "p2", name: "b", goal: "g", executor: "QA", verification: ["v"] },
        { id: "p3", name: "c", goal: "g", executor: "wizard", files: ["x.ts"], changes: ["c"], verification: ["v"] },
      ]),
      "fallback"
    );
    assert.deepEqual(
      r.plan.phases.map((p) => p.executor),
      ["SETUP", "QA", "EDITOR"]
    );
  });

  test("validatePlan: QA and SETUP phases need no files/changes, EDITOR phases still do", () => {
    const r = parsePlan(
      plan([
        { id: "p1", name: "install", goal: "run npm install", executor: "SETUP", verification: ["node_modules exists"] },
        { id: "p2", name: "typecheck", goal: "run tsc", executor: "QA", verification: ["tsc exits 0"] },
        { id: "p3", name: "edit", goal: "change x", executor: "EDITOR", verification: ["x changed"] },
      ]),
      "fallback"
    );
    const errors = validatePlan(r.plan);
    assert.equal(errors.some((e) => /phase 1/.test(e)), false);
    assert.equal(errors.some((e) => /phase 2/.test(e)), false);
    assert.equal(errors.some((e) => /phase 3 .*no target files/.test(e)), true);
  });
});
