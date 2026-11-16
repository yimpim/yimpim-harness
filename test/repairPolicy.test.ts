import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  failureSignature,
  isVisualOnlyFailure,
  isNoProgress,
  evaluateRepairProgress,
  buildWidenedScopeSection,
  countDistinctErrors,
  computeRepairPlannerMaxRounds,
  extractPitfallSummary,
} from "../src/repairPolicy.js";

describe("failureSignature", () => {
  test("empty for no failures", () => {
    assert.equal(failureSignature([]), "");
    assert.equal(failureSignature(undefined), "");
  });

  test("identical failures produce identical signatures regardless of array order", () => {
    const a = [
      { tier: "build", gate: "compile", detail: "syntax error" },
      { tier: "semantic", gate: "requirement coverage", detail: "UNMET: x" },
    ];
    const b = [
      { tier: "semantic", gate: "requirement coverage", detail: "UNMET: x" },
      { tier: "build", gate: "compile", detail: "syntax error" },
    ];
    assert.equal(failureSignature(a), failureSignature(b));
  });

  test("a different detail produces a different signature", () => {
    const a = [{ tier: "build", gate: "compile", detail: "syntax error on line 4" }];
    const b = [{ tier: "build", gate: "compile", detail: "syntax error on line 9" }];
    assert.notEqual(failureSignature(a), failureSignature(b));
  });
});

describe("isVisualOnlyFailure", () => {
  test("false when there are no failures", () => {
    assert.equal(isVisualOnlyFailure([]), false);
    assert.equal(isVisualOnlyFailure(undefined), false);
  });

  test("true when every blocking failure is tier 'visual'", () => {
    assert.equal(isVisualOnlyFailure([{ tier: "visual", gate: "a", detail: "x" }]), true);
  });

  test("false when a non-visual failure is mixed in", () => {
    assert.equal(
      isVisualOnlyFailure([
        { tier: "visual", gate: "a", detail: "x" },
        { tier: "build", gate: "compile", detail: "y" },
      ]),
      false
    );
  });

  test("false for a purely non-visual failure", () => {
    assert.equal(isVisualOnlyFailure([{ tier: "semantic", gate: "a", detail: "x" }]), false);
  });
});

describe("isNoProgress", () => {
  test("the very first failure (attempt 0) never counts as no-progress", () => {
    assert.equal(isNoProgress(0, "gate:detail", undefined), false);
    assert.equal(isNoProgress(0, "gate:detail", "gate:detail"), false, "attempt 0 has nothing to compare against yet");
  });

  test("an identical signature on a later attempt is no-progress", () => {
    assert.equal(isNoProgress(1, "gate:detail", "gate:detail"), true);
  });

  test("a changed signature on a later attempt is progress, not stagnation", () => {
    assert.equal(isNoProgress(1, "gate:new-detail", "gate:old-detail"), false);
  });

  test("an empty current signature never counts as no-progress (nothing to compare)", () => {
    assert.equal(isNoProgress(1, "", ""), false);
  });
});

describe("evaluateRepairProgress — the fix for the primary/backup split being unreachable", () => {
  test("progress (a changed failure signature) always continues, regardless of backup state", () => {
    assert.deepEqual(
      evaluateRepairProgress(2, "gate:new-detail", "gate:old-detail", false, true),
      { kind: "continue" }
    );
  });

  test("no progress, but a real backup chain exists and hasn't been tried yet: hand off instead of stopping", () => {
    assert.deepEqual(
      evaluateRepairProgress(1, "gate:detail", "gate:detail", /* repairUsingBackup */ false, /* hasRealBackupChain */ true),
      { kind: "switch_to_backup" }
    );
  });

  test("no progress with no real backup chain configured (single model): stop, nothing to hand off to", () => {
    assert.deepEqual(
      evaluateRepairProgress(1, "gate:detail", "gate:detail", false, /* hasRealBackupChain */ false),
      { kind: "stop" }
    );
  });

  test("no progress while ALREADY on the backup model: stop — both models had a fair turn", () => {
    assert.deepEqual(
      evaluateRepairProgress(7, "gate:detail", "gate:detail", /* repairUsingBackup */ true, true),
      { kind: "stop" }
    );
  });

  test("attempt 0 never trips no-progress, so it always continues even with an identical-looking signature", () => {
    assert.deepEqual(evaluateRepairProgress(0, "gate:detail", "gate:detail", false, true), { kind: "continue" });
  });

  // Reproduces the real failure this was built for (task-1791132395183-oellkaxvv4h):
  // attempt 1 fixed the original TS error but exposed a new React duplicate-key
  // runtime warning; attempt 2 tried to fix THAT and reproduced it byte-identical.
  // The old behavior stopped the whole phase right there, attempt 2 of a 10-attempt
  // budget, never reaching the backup model (scheduled for attempt 6+).
  test("regression: a primary model stuck on attempt 2 of 10 hands off to backup instead of killing the phase", () => {
    const tsErrorSignature = "build:TS2322: Type '(reason: string) => void' is not assignable to type '() => void'.";
    const duplicateKeySignature = "runtime:Encountered two children with the same key, `dev-preview-b`.";

    // Attempt 1's verification: different from the pre-repair failure — real progress.
    assert.deepEqual(
      evaluateRepairProgress(1, duplicateKeySignature, tsErrorSignature, false, true),
      { kind: "continue" }
    );
    // Attempt 2's verification: identical to attempt 1's — the primary is stuck.
    // With a real backup chain configured and not yet tried, this must hand off,
    // not stop the phase outright.
    assert.deepEqual(
      evaluateRepairProgress(2, duplicateKeySignature, duplicateKeySignature, false, true),
      { kind: "switch_to_backup" }
    );
  });
});

describe("buildWidenedScopeSection — the fix for a runtime/visual failure REPAIR can never attribute to its own files", () => {
  test("returns nothing for the common case: no external paths, not a runtime/visual failure", () => {
    assert.equal(buildWidenedScopeSection([], false), "");
  });

  test("a build-tier failure with named external paths takes priority and authorizes exactly those files", () => {
    const section = buildWidenedScopeSection(["src/shared/types.ts"], false);
    assert.match(section, /WIDENED SCOPE FOR THIS REPAIR ATTEMPT ONLY/);
    assert.match(section, /src\/shared\/types\.ts/);
    assert.doesNotMatch(section, /WIDENED SEARCH PERMITTED/);
  });

  test("a build-tier failure with named paths takes priority even when also flagged runtime/visual", () => {
    // Shouldn't happen in practice (build and runtime gates are mutually
    // exclusive in one QA pass), but the named, CONFIRMED paths are strictly
    // better evidence than a blind search permission, so they must win if
    // both were ever somehow true at once.
    const section = buildWidenedScopeSection(["src/shared/types.ts"], true);
    assert.match(section, /WIDENED SCOPE FOR THIS REPAIR ATTEMPT ONLY/);
    assert.doesNotMatch(section, /WIDENED SEARCH PERMITTED/);
  });

  // Reproduces the real failure this was built for: QA's runtime probe
  // reported a React "duplicate key" console warning with no file path in
  // it anywhere, caused by a pre-existing bug in a completely different,
  // unrelated screen — REPAIR_PLANNER, told it could only inspect the
  // current phase's own files, had no way to ever find it.
  test("no external paths but a runtime/visual (or symbol-undefinable build) failure grants search permission instead of naming a file", () => {
    const section = buildWidenedScopeSection([], true);
    assert.match(section, /WIDENED SEARCH PERMITTED FOR THIS REPAIR ATTEMPT/);
    assert.match(section, /doesn't clearly name which file is actually responsible/);
    assert.match(section, /search_code/);
    assert.match(section, /get_symbol_definition/);
    assert.match(section, /not limited to this\s+phase's own files/);
    assert.doesNotMatch(section, /WIDENED SCOPE FOR THIS REPAIR ATTEMPT ONLY/);
  });

  test("neither condition applies: a runtime/visual failure that IS fully explained by named paths never reaches the blind-search branch", () => {
    // externalPaths non-empty always wins regardless of runtimeOrVisualFailed's
    // value -- already covered above, restated here for the specific tier
    // combination a real run would produce if extraction ever did succeed.
    const section = buildWidenedScopeSection(["app/model-setup.tsx"], true);
    assert.match(section, /WIDENED SCOPE FOR THIS REPAIR ATTEMPT ONLY/);
  });
});

// The real SettingsScreen failure this and the next describe block were
// built from: 6 distinct wrong-API errors (a storage export, an argument
// type mismatch, a missing property, an enum used as a value at 4 call
// sites, and a missing theme token at 7 call sites), clustered by
// clusterRepeatedErrors (verifierTools.ts) the same way a real QA run would
// render them.
const SETTINGS_SCREEN_TYPECHECK_DETAIL = `exited 1
> yimpim-remote@1.0.0 typecheck
> node -e "if (require('fs').existsSync('tsconfig.json')) require('child_process').execSync('tsc --noEmit', {stdio: 'inherit'})"
app/settings.tsx(26,3): error TS2724: '"@/storage/secureStore"' has no exported member named 'getBrokerLeaseExpiry'. Did you mean 'getBrokerLease'?
app/settings.tsx(290,51): error TS2345: Argument of type 'StoredSession[]' is not assignable to parameter of type 'readonly { id: string; repoName?: string | undefined; }[]'.
app/settings.tsx(452,44): error TS2339: Property 'pairedAt' does not exist on type 'SessionSummary'.
[REPEATED 4x — LIKELY ONE SHARED ROOT CAUSE, do not fix each line separately] "app/settings.tsx: error TS2693: 'SessionActivity' only refers to a type, but is being used as a value here."
  First 2 occurrences:
    app/settings.tsx(456,22): error TS2693: 'SessionActivity' only refers to a type, but is being used as a value here.
    app/settings.tsx(458,22): error TS2693: 'SessionActivity' only refers to a type, but is being used as a value here.
  All 4 occurrences: (456,22), (458,22), (460,22), (462,22)
app/settings.tsx(459,43): error TS2339: Property 'YimpimAmber' does not exist on type 'YimpimNavyTokens'.
[REPEATED 7x — LIKELY ONE SHARED ROOT CAUSE, do not fix each line separately] "app/settings.tsx: error TS2339: Property 'YimpimRed' does not exist on type 'YimpimNavyTokens'."
  First 2 occurrences:
    app/settings.tsx(503,43): error TS2339: Property 'YimpimRed' does not exist on type 'YimpimNavyTokens'.
    app/settings.tsx(519,40): error TS2339: Property 'YimpimRed' does not exist on type 'YimpimNavyTokens'.
  All 7 occurrences: (503,43), (519,40), (520,36), (526,34), (527,59), (606,73), (659,73)
Error: Command failed: tsc --noEmit
at genericNodeError (node:internal/errors:983:15)`;

describe("countDistinctErrors — sizes REPAIR_PLANNER's round budget to what's actually there to diagnose", () => {
  test("a single simple error counts as one", () => {
    assert.equal(countDistinctErrors("app/foo.tsx(1,1): error TS2322: bad type."), 1);
  });

  test("the real SettingsScreen failure counts as 6 — not 11 raw occurrences, not 1 gate", () => {
    // 6 distinct complaints: getBrokerLeaseExpiry, the StoredSession[] argument,
    // pairedAt, the SessionActivity cluster (1, despite 4 call sites), YimpimAmber,
    // and the YimpimRed cluster (1, despite 7 call sites). The boilerplate
    // "Error: Command failed" line does not count as a 7th.
    assert.equal(countDistinctErrors(SETTINGS_SCREEN_TYPECHECK_DETAIL), 6);
  });

  test("a property name containing the word 'error' (errorContainer, onError) is never mistaken for an error line", () => {
    assert.equal(countDistinctErrors("app/foo.tsx(1,1): Property 'errorContainer' does not exist on type 'ColorScheme'."), 0);
    assert.equal(countDistinctErrors("const onError = () => {};"), 0);
  });

  test("zero for a clean detail with no error-bearing lines at all", () => {
    assert.equal(countDistinctErrors("completed with exit code 0"), 0);
  });
});

describe("computeRepairPlannerMaxRounds — the fix for REPAIR_PLANNER hitting turn_limit on a multi-error failure", () => {
  test("a single simple error barely moves off the 8-round floor", () => {
    const failures = [{ tier: "build", gate: "npm run typecheck", detail: "app/foo.tsx(1,1): error TS2322: bad type." }];
    assert.equal(computeRepairPlannerMaxRounds(failures, 40), 10);
  });

  test("the real SettingsScreen failure (6 distinct errors, ONE blockingFailure entry) gets real headroom", () => {
    const failures = [{ tier: "build", gate: "npm run typecheck", detail: SETTINGS_SCREEN_TYPECHECK_DETAIL }];
    // 8 + 6*2 = 20 -- the actual bug this fixes: the old formula scaled off
    // blockingFailures.length, which is 1 here (one failed command) no matter
    // how many compiler errors it bundles, so it would have computed 10, not 20.
    assert.equal(computeRepairPlannerMaxRounds(failures, 40), 20);
  });

  test("never exceeds the configured ceiling, even for a pathological error count", () => {
    const manyErrors = Array.from({ length: 50 }, (_, i) => `app/foo.tsx(${i},1): error TS2322: bad type.`).join("\n");
    const failures = [{ tier: "build", gate: "npm run typecheck", detail: manyErrors }];
    assert.equal(computeRepairPlannerMaxRounds(failures, 40), 40);
  });

  test("undefined/empty blockingFailures floors at 8, never throws", () => {
    assert.equal(computeRepairPlannerMaxRounds(undefined, 40), 8);
    assert.equal(computeRepairPlannerMaxRounds([], 40), 8);
  });
});

describe("extractPitfallSummary — the fix for historicalPitfalls storing boilerplate instead of the actual defect", () => {
  test("the real bug: a plain slice(0, 200) on an npm failure captures almost nothing but command-invocation noise", () => {
    // This is the bug being fixed, asserted directly so a future change to
    // the real command format can't silently make this test meaningless.
    const naive = SETTINGS_SCREEN_TYPECHECK_DETAIL.slice(0, 200);
    assert.doesNotMatch(naive, /getBrokerLeaseExpiry/, "sanity check: the naive slice genuinely does not reach the real error");
  });

  test("strips the exited-N summary line and npm preamble lines, keeping the real errors within the same budget", () => {
    const summary = extractPitfallSummary(SETTINGS_SCREEN_TYPECHECK_DETAIL, 200);
    assert.match(summary, /getBrokerLeaseExpiry/);
    assert.doesNotMatch(summary, /^exited \d/m);
    assert.doesNotMatch(summary, /^>\s/m);
  });

  test("a gate detail with no npm boilerplate at all (runtime/visual tier) passes through unchanged, just truncated", () => {
    const detail = "Console error: Encountered two children with the same key, `%s`. dev-preview-b";
    assert.equal(extractPitfallSummary(detail, 200), detail);
  });

  test("falls back to the raw text if stripping would leave nothing (e.g. the whole detail IS boilerplate)", () => {
    const allBoilerplate = "exited 1\n> pkg@1.0.0 test\n> jest";
    assert.equal(extractPitfallSummary(allBoilerplate, 200), allBoilerplate);
  });
});
