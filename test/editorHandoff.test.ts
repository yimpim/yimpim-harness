/**
 * Regression tests for the Editor A -> Editor B handoff (orchestrator.ts):
 * analysis-paralysis detection via a ReadTracker fed by the editor's tool
 * calls, the takeover directive injection into Editor B's context prompt, and
 * the error interceptor that turns Editor B's model timeouts / OpenRouter
 * 5xx / stall errors into structured failure results instead of raw
 * exceptions. Phase 2 of the analysis-paralysis loop work.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import {
  EDITOR_B_TAKEOVER_DIRECTIVE,
  PLANNER_REFORMULATION_DIRECTIVE,
  ESCALATE_TO_USER,
  buildEditorBContextPrompt,
  buildMandatoryTargetConstraint,
  buildPlannerReformulationPrompt,
  decideEditorFailureAction,
  formatEscalationSummary,
  classifyEditorError,
  normalizeEditorFailureMessage,
  runEditorWithHandoff,
  detectChangedManifests,
  resolveInstallCommands,
  resolveInstallPlan,
  matchesManifestPattern,
  handleDependencyInstallGate,
  inspectFileForNewDependencies,
  handlePostPhaseDependencies,
  normalizePostPhaseDependencyChoice,
  buildApprovalPromptLine,
  parseApprovalAnswer,
  MANIFEST_REGISTRY,
  verifyAndFixNpmVersions,
  resolveAbsoluteInstallPlan,
  runDependencyInstallCheck,
} from "../src/orchestrator.js";
import type { TrackToolCall } from "../src/orchestrator.js";

// Matches orchestrator.ts's own GRADLE_INSTALL_COMMAND: cmd.exe (Windows)
// doesn't resolve a leading "./" the way POSIX shells do, but does
// implicitly search the current directory for a bare command name, so the
// wrapper is invoked without the prefix there.
const GRADLE_WRAPPER = process.platform === "win32" ? "gradlew.bat" : "gradlew";
const GRADLE_CMD = process.platform === "win32" ? "gradlew.bat build --refresh-dependencies" : "./gradlew build --refresh-dependencies";

/**
 * Simulates an editor pass stuck in analysis paralysis: two full rounds of
 * `READS_PER_ROUND` inspections with no edit in between — exactly what trips
 * the ReadTracker's stall threshold.
 */
function stallEditorWithReads(sink: TrackToolCall, prefix: string): void {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 8; i++) {
      sink("read_file", { path: `${prefix}-${round}-${i}.ts` });
    }
  }
}

describe("EDITOR_B_TAKEOVER_DIRECTIVE", () => {
  test("is exactly the phase-mandated takeover sentence, verbatim", () => {
    assert.equal(
      EDITOR_B_TAKEOVER_DIRECTIVE,
      "You are taking over this task because Editor A stalled in analysis paralysis without making changes. " +
        "The relevant context has already been gathered. Review the task and emit the necessary edit commands. " +
        "You are allowed up to 2 rounds of 8 reads, but you MUST produce concrete file edits."
    );
  });
});

describe("buildEditorBContextPrompt — takeover directive injection", () => {
  test("prepends the directive to the task and names the inspected files", () => {
    const prompt = buildEditorBContextPrompt("Implement the settings screen.", ["Settings.kt", "App.kt"]);

    assert.ok(prompt.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE), "directive must be the FIRST block of Editor B's prompt");
    assert.ok(prompt.includes("Implement the settings screen."), "original task instructions survive the injection");
    assert.ok(prompt.includes("Settings.kt"));
    assert.ok(prompt.includes("App.kt"));
  });

  test("degrades gracefully when Editor A reported no inspected files", () => {
    const prompt = buildEditorBContextPrompt("Task text here.", []);
    assert.ok(prompt.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE));
    assert.ok(prompt.includes("Task text here."));
  });
});

describe("runEditorWithHandoff", () => {
  test("Editor B is NOT invoked when Editor A produced edits instead of stalling", async () => {
    const calls: string[] = [];
    const variants: Array<"editorA" | "editorB" | undefined> = [];
    const result = await runEditorWithHandoff({
      initialInstructions: "Fix the login flow.",
      runEditor: async (instructions, track, variant) => {
        calls.push(instructions);
        variants.push(variant);
        // Reads, then a real edit resets the read streak, then more reads.
        for (let i = 0; i < 8; i++) track("read_file", { path: `login-a-${i}.ts` });
        track("patch_file", { path: "Login.kt", search: "x", replace: "y" });
        for (let i = 0; i < 8; i++) track("read_file", { path: `login-b-${i}.ts` });
        return "TASK_CONCLUDED: patched Login.kt";
      },
      hasWrittenFiles: () => true,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.usedEditorB, false);
    assert.equal(result.editorAStalled, false);
    assert.equal(calls.length, 1, "only Editor A ran");
    assert.equal(calls[0], "Fix the login flow.");
    assert.deepEqual(variants, ["editorA"], "the first and only pass receives the 'editorA' variant");
  });

  test("benches Editor A and invokes Editor B with the takeover directive when A stalls", async () => {
    let editorBInstructions: string | undefined;
    const variants: Array<"editorA" | "editorB" | undefined> = [];
    const result = await runEditorWithHandoff({
      initialInstructions: "Add error handling to the settings screen.",
      runEditor: async (instructions, track, variant) => {
        variants.push(variant);
        // Editor A pass: pure reads, no edits → tripped the stall threshold.
        if (instructions === "Add error handling to the settings screen.") {
          stallEditorWithReads(track, "a");
          return "TASK_CONCLUDED: nothing to change";
        }
        // Editor B pass: record the takeover prompt it actually received.
        editorBInstructions = instructions;
        track("read_file", { path: "SettingsB.kt" });
        track("patch_file", { path: "Settings.kt", search: "a", replace: "b" });
        return "TASK_CONCLUDED: patched Settings.kt";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.usedEditorB, true, "Editor B must take over after Editor A stalls");
    assert.equal(result.editorAStalled, true);
    assert.deepEqual(
      variants,
      ["editorA", "editorB"],
      "Editor A's pass receives 'editorA'; the takeover pass receives 'editorB' (drives the backup model chain)"
    );
    assert.ok(editorBInstructions, "Editor B was invoked exactly once with a takeover prompt");
    assert.ok(
      editorBInstructions!.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE),
      "the takeover directive is prepended into Editor B's context prompt"
    );
    assert.ok(
      editorBInstructions!.includes("Add error handling to the settings screen."),
      "the original task is embedded for Editor B"
    );
    assert.ok(
      editorBInstructions!.includes("a-0-0.ts"),
      "context Editor A already gathered travels with the takeover prompt"
    );
    // The success payload aggregates the distinct trails of BOTH passes.
    assert.ok(result.inspectedPaths.includes("a-0-0.ts"), "Editor A's inspected paths are aggregated");
    assert.ok(result.inspectedPaths.includes("SettingsB.kt"), "Editor B's inspected paths are aggregated");
  });

  test("benches Editor A and invokes Editor B when A returns CIRCUIT_BREAKER_STUCK without any edits", async () => {
    const variants: Array<"editorA" | "editorB" | undefined> = [];
    let editorBCalled = false;
    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track, variant) => {
        variants.push(variant);
        // Editor A: the ReadTracker never saw a full 2x8 read round (the loop
        // tripped its own breaker, not the tracker), so this pass only stalls
        // via the CIRCUIT_BREAKER_STUCK sentinel.
        if (variant === "editorA") {
          track("read_file", { path: "a-single-read.ts" });
          return "CIRCUIT_BREAKER_STUCK: EDITOR stopped after 2 unproductive search cycles.";
        }
        editorBCalled = true;
        track("patch_file", { path: "Feature.kt", search: "a", replace: "b" });
        return "TASK_CONCLUDED: patched Feature.kt";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.usedEditorB, true, "the CIRCUIT_BREAKER_STUCK sentinel benches Editor A even without a tracker stall");
    assert.equal(result.editorAStalled, true);
    assert.equal(editorBCalled, true, "Editor B takes over after Editor A's circuit-breaker sentinel");
    assert.deepEqual(variants, ["editorA", "editorB"]);
  });

  test("a successful handoff switches Editor B to the backup model chain (`models.slice(1)`)", async () => {
    // Mirrors runPhaseWithHandoff's model routing in src/index.ts: the variant
    // selects which chain the pass runs on, and 'editorB' resolves to
    // effectiveEditorModels.slice(1) so the backup model is called first.
    const effectiveEditorModels = ["primary-editor", "backup-editor"];
    const backupEditorModels =
      effectiveEditorModels.length > 1 ? effectiveEditorModels.slice(1) : effectiveEditorModels;
    assert.deepEqual(backupEditorModels, ["backup-editor"], "the backup chain drops the primary model");

    const modelsByVariant: Record<"editorA" | "editorB", string[]> = {
      editorA: effectiveEditorModels,
      editorB: backupEditorModels,
    };
    const calls: Array<{ variant: "editorA" | "editorB" | undefined; models: string[] }> = [];

    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track, variant) => {
        const active = variant ?? "editorA";
        calls.push({ variant, models: modelsByVariant[active] });
        if (active === "editorB") {
          track("patch_file", { path: "Feature.kt", search: "a", replace: "b" });
          return "TASK_CONCLUDED: patched Feature.kt";
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: no edits";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.usedEditorB, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { variant: "editorA", models: ["primary-editor", "backup-editor"] });
    assert.deepEqual(
      calls[1],
      { variant: "editorB", models: ["backup-editor"] },
      "Editor B's takeover pass runs the backup model chain, not the primary"
    );
  });

  test("Editor B's own stall (circuit-breaker with no edits) becomes a structured stall failure", async () => {
    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track) => {
        if (instructions.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE)) {
          stallEditorWithReads(track, "b");
          return "CIRCUIT_BREAKER_STUCK: EDITOR stopped after 2 unproductive search cycles without locating an actionable change.";
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: no edits";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.editorAStalled, true);
    assert.equal(result.failure.kind, "stall");
    // The interceptor normalizes the raw sentinel into the canonical stall reason.
    assert.equal(result.failure.message, "Editor B stalled after 16 pure reads");
    assert.match(String(result.failure.cause), /CIRCUIT_BREAKER_STUCK/);
    assert.ok(result.inspectedPaths.includes("b-0-0.ts"));
  });

  test("Editor B read-loop exhaustion (2x8 reads, no edits, no sentinel) is a structured stall failure with aggregated inspected paths", async () => {
    const result = await runEditorWithHandoff({
      initialInstructions: "Add error handling to the settings screen.",
      runEditor: async (instructions, track) => {
        if (instructions.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE)) {
          // Editor B burns its ENTIRE 2x8 read budget without a single edit —
          // and, unlike the sentinel test, returns a normal TASK_CONCLUDED.
          stallEditorWithReads(track, "b");
          return "TASK_CONCLUDED: no edits";
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: nothing to change";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, false, "a read-loop-exhausted Editor B must fail, not pass as a normal conclusion");
    if (result.ok) return;
    assert.equal(result.editorAStalled, true);
    assert.equal(result.failure.kind, "stall");
    assert.equal(result.failure.message, "Editor B stalled after 16 pure reads");
    // Distinct paths from BOTH editor passes are aggregated into the failure payload.
    assert.ok(result.inspectedPaths.includes("a-0-0.ts"), "Editor A's inspection trail is aggregated");
    assert.ok(result.inspectedPaths.includes("b-1-7.ts"), "Editor B's inspection trail is aggregated");
    assert.equal(
      new Set(result.inspectedPaths).size,
      result.inspectedPaths.length,
      "inspectedPaths are distinct across both passes"
    );
  });

  test("an Editor B that DID edit is not a stall even if it later trips the breaker", async () => {
    const written = { value: false };
    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track) => {
        if (instructions.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE)) {
          // Editor B makes a real edit, then circles back into read-only mode.
          track("write_file", { path: "Feature.kt", content: "code" });
          written.value = true;
          stallEditorWithReads(track, "b");
          return "CIRCUIT_BREAKER_STUCK: EDITOR stopped after 2 unproductive search cycles.";
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: no edits";
      },
      hasWrittenFiles: () => written.value,
    });

    assert.equal(result.ok, true, "a producing Editor B must flow through to verification, not be failed");
    if (!result.ok) return;
    assert.equal(result.editorAStalled, true);
    assert.equal(result.usedEditorB, true);
    assert.match(result.result, /CIRCUIT_BREAKER_STUCK/);
  });

  test("a model timeout thrown by Editor B becomes a structured model_timeout failure", async () => {
    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track) => {
        if (instructions.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE)) {
          const err: any = new Error("socket timed out");
          err.name = "TimeoutError";
          throw err;
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: no edits";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "model_timeout");
    assert.equal(result.failure.message, "Editor B timed out");
    assert.equal(result.editorAStalled, true);
    assert.ok(result.inspectedPaths.includes("a-0-0.ts"));
  });

  test("an OpenRouter HTTP 500 error thrown by Editor B becomes a structured openrouter_error failure", async () => {
    const result = await runEditorWithHandoff({
      initialInstructions: "Implement the feature.",
      runEditor: async (instructions, track) => {
        if (instructions.startsWith(EDITOR_B_TAKEOVER_DIRECTIVE)) {
          throw new Error("HTTP 500: upstream provider error");
        }
        stallEditorWithReads(track, "a");
        return "TASK_CONCLUDED: no edits";
      },
      hasWrittenFiles: () => false,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "openrouter_error");
    assert.equal(result.failure.message, "Editor B model API error (HTTP 500)");
    assert.equal(result.editorAStalled, true);
    assert.ok(result.inspectedPaths.includes("a-0-0.ts"));
  });

  test("Editor A's own errors propagate to the caller unchanged (ESCALATION_NEEDED contract)", async () => {
    await assert.rejects(
      runEditorWithHandoff({
        initialInstructions: "Implement the feature.",
        runEditor: async () => {
          throw new Error("ESCALATION_NEEDED: the referenced code does not exist anywhere");
        },
        hasWrittenFiles: () => false,
      }),
      /ESCALATION_NEEDED/
    );
  });
});

describe("classifyEditorError", () => {
  test("a DOMException named TimeoutError is a model_timeout", () => {
    const err: any = new Error("call exceeded the 120s budget");
    err.name = "TimeoutError";
    assert.equal(classifyEditorError(err).kind, "model_timeout");
  });

  test("HTTP 5xx messages and post-retry exhaustion are openrouter_error", () => {
    assert.equal(classifyEditorError(new Error("HTTP 500: Internal Server Error")).kind, "openrouter_error");
    assert.equal(classifyEditorError(new Error("HTTP 503: Service Unavailable")).kind, "openrouter_error");
    assert.equal(classifyEditorError(new Error("Failed all configured model attempts.")).kind, "openrouter_error");
  });

  test("analysis-paralysis wording is a stall", () => {
    assert.equal(
      classifyEditorError(new Error("CIRCUIT_BREAKER_STUCK: EDITOR stopped after 2 unproductive search cycles")).kind,
      "stall"
    );
  });

  test("anything unrecognized is a structured 'other' failure, never a raw throw", () => {
    const failure = classifyEditorError(new Error("disk full"));
    assert.equal(failure.kind, "other");
    assert.equal(failure.message, "disk full");
  });

  test("non-Error throws are still classified without crashing", () => {
    const failure = classifyEditorError("string throw");
    assert.equal(failure.kind, "other");
    assert.ok(failure.message.length > 0);
  });
});

describe("normalizeEditorFailureMessage", () => {
  test("maps each failure kind to its canonical reason string", () => {
    assert.equal(normalizeEditorFailureMessage("model_timeout", "call exceeded the 120s budget"), "Editor B timed out");
    assert.equal(
      normalizeEditorFailureMessage("openrouter_error", "HTTP 500: Internal Server Error"),
      "Editor B model API error (HTTP 500)"
    );
    assert.equal(
      normalizeEditorFailureMessage("openrouter_error", "HTTP 503: Service Unavailable"),
      "Editor B model API error (HTTP 503)"
    );
    assert.equal(
      normalizeEditorFailureMessage("openrouter_error", "Failed all configured model attempts."),
      "Editor B model API error (HTTP 5xx)"
    );
    assert.equal(
      normalizeEditorFailureMessage("stall", "CIRCUIT_BREAKER_STUCK: no actionable change"),
      "Editor B stalled after 16 pure reads"
    );
    assert.equal(
      normalizeEditorFailureMessage("other", "disk full"),
      "Editor B failed with unexpected error: disk full"
    );
  });
});

/**
 * Phase: Planner fallback and user-escalation circuit breaker.
 *
 * The state machine itself lives in index.ts's phase loop; these cover the
 * pure pieces it is built from — the budget decision, the planner prompt that
 * carries the failure reason, the escalation diagnostic, and the mandatory
 * target constraint injected from the interactive CLI answer.
 */
describe("decideEditorFailureAction — replan budget boundary", () => {
  test("a phase that has not yet replanned asks the planner to reformulate", () => {
    assert.equal(decideEditorFailureAction(0), "replan");
  });

  test("a phase that has already spent its one replan escalates to the user", () => {
    assert.equal(decideEditorFailureAction(1), "escalate");
    assert.equal(decideEditorFailureAction(2), "escalate");
  });

  test("exactly one replan is allowed before escalation", () => {
    // Walk the budget the way index.ts's loop does: replan on the first
    // failure (0 -> 1), escalate on every failure after that.
    let phaseReplanCount = 0;
    const actions = [decideEditorFailureAction(phaseReplanCount)];
    phaseReplanCount = 1;
    actions.push(decideEditorFailureAction(phaseReplanCount));
    phaseReplanCount = 1;
    actions.push(decideEditorFailureAction(phaseReplanCount));

    assert.deepEqual(actions, ["replan", "escalate", "escalate"]);
  });
});

describe("buildPlannerReformulationPrompt — Editor B failure fallback", () => {
  test("prepends the reformulation directive and injects the failure reason", () => {
    const prompt = buildPlannerReformulationPrompt(
      "Implement the settings screen.",
      "Editor B timed out",
      ["Settings.kt", "App.kt"]
    );

    assert.ok(
      prompt.startsWith(PLANNER_REFORMULATION_DIRECTIVE),
      "the reformulation directive must be the FIRST block of the planner prompt"
    );
    assert.ok(prompt.includes("Implement the settings screen."), "the phase goal is carried into the prompt");
    // The failure reason is injected via the mandated placeholder.
    assert.ok(prompt.includes("{{failure_reason}} = Editor B timed out"));
    assert.ok(prompt.includes("Settings.kt"));
    assert.ok(prompt.includes("App.kt"));
  });

  test("degrades gracefully when no files were inspected before the failure", () => {
    const prompt = buildPlannerReformulationPrompt("Phase goal.", "Editor B stalled after 16 pure reads", []);
    assert.ok(prompt.startsWith(PLANNER_REFORMULATION_DIRECTIVE));
    assert.ok(prompt.includes("{{failure_reason}} = Editor B stalled after 16 pure reads"));
    assert.ok(prompt.includes("no files were inspected"));
  });
});

describe("formatEscalationSummary — circuit breaker diagnostic", () => {
  test("reports the ESCALATE_TO_USER trip, the phase goal, the failure reason and the inspected paths", () => {
    const summary = formatEscalationSummary("Implement the settings screen.", "Editor B timed out", [
      "Settings.kt",
      "App.kt",
    ]);

    assert.ok(summary.includes(ESCALATE_TO_USER), "the breaker marker is part of the diagnostic");
    assert.equal(ESCALATE_TO_USER, "ESCALATE_TO_USER");
    assert.ok(summary.includes("Implement the settings screen."), "the target phase goal is shown");
    assert.ok(summary.includes("Editor B timed out"), "the failure reason is shown");
    assert.ok(summary.includes("Settings.kt"), "the distinct inspected paths are shown");
    assert.ok(summary.includes("App.kt"));
  });

  test("says so explicitly when nothing was inspected", () => {
    const summary = formatEscalationSummary("Phase goal.", "Editor B failed with unexpected error: disk full", []);
    assert.ok(summary.includes(ESCALATE_TO_USER));
    assert.ok(summary.includes("no files were inspected"));
  });
});

describe("interactive CLI target path — mandatory constraint for Editor A", () => {
  test("injects the user-supplied path as a mandatory target constraint", () => {
    // What the escalation prompt's answer becomes before Editor A re-runs.
    const answer = "  src/screens/Settings.kt  ";
    const constraint = buildMandatoryTargetConstraint(answer);

    assert.ok(constraint.includes("MANDATORY TARGET FILE"));
    assert.ok(constraint.includes("src/screens/Settings.kt"), "the trimmed user path is the mandated target");
    assert.ok(
      !constraint.includes("  src/screens/Settings.kt"),
      "the path is trimmed before it is injected"
    );
    assert.ok(/MUST apply your change to this file/.test(constraint));
  });

  test("the constraint is prepended to the phase instructions Editor A receives", () => {
    const phaseGoal = "Implement the settings screen.";
    const prompt = `${buildMandatoryTargetConstraint("src/screens/Settings.kt")}\n\nInstructions:\n${phaseGoal}`;

    assert.ok(prompt.startsWith("MANDATORY TARGET FILE"));
    assert.ok(prompt.includes("src/screens/Settings.kt"));
    assert.ok(prompt.includes(phaseGoal), "the original phase instructions still reach Editor A");
  });

  test("a blank answer produces no constraint, so the caller can fail the phase instead", () => {
    assert.equal(buildMandatoryTargetConstraint(""), "");
    assert.equal(buildMandatoryTargetConstraint("   "), "");
  });
});

/**
 * Phase: Dependency Installation Approval Gate.
 *
 * A phase that edits a dependency manifest changes the project's dependency
 * set, and nothing else in the pipeline installs it — the verifier would then
 * report a build failure that looks like a code defect. These cover the gate's
 * three decisions: is this even a manifest change, which command does it
 * resolve to, and does a human's answer actually decide whether it runs.
 */
/**
 * Every ecosystem's representative manifest, in registry order, paired with
 * the id it must resolve to. One row per ecosystem, and every row must match
 * EXACTLY ONE family — a manifest matching two rules would run two installs.
 */
const MANIFEST_CASES: Array<[string, string]> = [
  ["package.json", "npm"],
  ["requirements.txt", "pip-requirements"],
  ["pyproject.toml", "pyproject"],
  ["Pipfile", "pipenv"],
  ["build.gradle.kts", "gradle-kts"],
  ["build.gradle", "gradle-groovy"],
  ["gradle/libs.versions.toml", "gradle-version-catalog"],
  ["pom.xml", "maven"],
  ["pubspec.yaml", "pub"],
  ["Cargo.toml", "cargo"],
  ["go.mod", "go"],
  ["ios/Podfile", "cocoapods"],
  ["Package.swift", "spm"],
  ["composer.json", "composer"],
  ["Gemfile", "bundler"],
  ["src/App/App.csproj", "dotnet"],
  ["vcpkg.json", "vcpkg"],
  ["conanfile.txt", "conan"],
  ["mix.exs", "mix"],
];

describe("MANIFEST_REGISTRY — the 19 supported ecosystems", () => {
  test("declares exactly nineteen manifest families with unique ids", () => {
    assert.equal(MANIFEST_REGISTRY.length, 19, "all nineteen ecosystems must be registered");
    const ids = MANIFEST_REGISTRY.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "every ecosystem id is unique");
  });

  test("every rule declares the fields the gate depends on", () => {
    for (const rule of MANIFEST_REGISTRY) {
      assert.ok(rule.id.length > 0, "a rule needs a stable id");
      assert.ok(rule.label.length > 0, `${rule.id} needs a human-readable label`);
      assert.ok(rule.filePatterns.length > 0, `${rule.id} needs at least one filePattern`);
      assert.ok(rule.command.length > 0, `${rule.id} needs an install command`);
      assert.ok(
        rule.action === "install" || rule.action === "restore",
        `${rule.id} must declare whether its command installs or restores`
      );
      assert.ok(Array.isArray(rule.diffTriggers), `${rule.id} must declare diffTriggers (possibly empty)`);
    }
  });

  test("every registered ecosystem is reachable through its own filePatterns", () => {
    // Registry coverage is only real if the filePatterns actually match the
    // manifest filename each ecosystem is known by.
    for (const [written, expectedId] of MANIFEST_CASES) {
      const basename = written.split("/").pop()!;
      const matched = MANIFEST_REGISTRY.filter((rule) =>
        rule.filePatterns.some((pattern) => matchesManifestPattern(basename, pattern))
      );
      assert.deepEqual(
        matched.map((r) => r.id),
        [expectedId],
        `${written} must match exactly the ${expectedId} family`
      );
    }
  });
});

describe("matchesManifestPattern — basename matching", () => {
  test("exact patterns match case-insensitively", () => {
    assert.equal(matchesManifestPattern("Podfile", "Podfile"), true);
    assert.equal(matchesManifestPattern("podfile", "Podfile"), true, "macOS/Windows checkouts differ in case");
    assert.equal(matchesManifestPattern("Cargo.toml", "Cargo.toml"), true);
    assert.equal(matchesManifestPattern("cargo.toml", "Cargo.toml"), true);
    assert.equal(matchesManifestPattern("Package.swift", "Package.swift"), true);
    assert.equal(matchesManifestPattern("Podfile.lock", "Podfile"), false, "a lockfile is not the manifest");
  });

  test("a single '*' wildcard matches a filename prefix, not an extension suffix", () => {
    assert.equal(matchesManifestPattern("App.csproj", "*.csproj"), true);
    assert.equal(matchesManifestPattern("My.Lib.fsproj", "*.fsproj"), true);
    assert.equal(matchesManifestPattern("App.csproj.bak", "*.csproj"), false);
    assert.equal(matchesManifestPattern("App.vbproj", "*.csproj"), false);
    assert.equal(matchesManifestPattern("requirements-dev.txt", "requirements*.txt"), true);
    assert.equal(matchesManifestPattern("requirements.txt", "requirements*.txt"), true);
  });

  test("empty inputs never match", () => {
    assert.equal(matchesManifestPattern("", "Podfile"), false);
    assert.equal(matchesManifestPattern("Podfile", ""), false);
  });
});

describe("detectChangedManifests — manifest matching", () => {
  test("non-manifest file changes are not manifests", () => {
    const changed = detectChangedManifests([
      "src/index.ts",
      "src/screens/Settings.kt",
      "README.md",
      "test/editorHandoff.test.ts",
    ]);
    assert.deepEqual(changed, [], "ordinary source edits must not be treated as dependency changes");
  });

  test("an empty write list has nothing to install for", () => {
    assert.deepEqual(detectChangedManifests([]), []);
    assert.deepEqual(resolveInstallCommands([]), []);
  });

  test("matches each of the 19 ecosystems by basename, including nested paths", () => {
    for (const [written, expectedId] of MANIFEST_CASES) {
      const changed = detectChangedManifests([written]);
      assert.equal(changed.length, 1, `${written} should match exactly one manifest family`);
      assert.equal(changed[0].id, expectedId, `${written} should map to the ${expectedId} family`);
    }
  });

  test("a match reports the manifest path, the command and the subproject directory", () => {
    const [match] = detectChangedManifests(["web/package.json"]);
    assert.equal(match.id, "npm");
    assert.equal(match.command, "npm install --ignore-scripts");
    assert.equal(match.action, "install");
    assert.equal(match.path, "web/package.json", "the written path is reported back, normalized");
    assert.equal(match.cwd, "web", "a nested manifest installs in its own subproject directory");
    assert.equal(match.rule.id, "npm", "the full declaration travels with the match");
  });

  test("Windows-style separators are normalized, not treated as literal names", () => {
    const changed = detectChangedManifests(["gradle\\libs.versions.toml"]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "gradle-version-catalog");
    assert.equal(changed[0].cwd, "", "the version catalog's Gradle build root is the parent of gradle/");
  });

  test("manifests vendored inside node_modules/vendor/build/Pods/target are ignored", () => {
    assert.deepEqual(detectChangedManifests(["node_modules/foo/package.json"]), []);
    assert.deepEqual(detectChangedManifests(["vendor/github.com/x/go.mod"]), []);
    assert.deepEqual(detectChangedManifests(["build/package.json"]), []);
    assert.deepEqual(detectChangedManifests(["ios/Pods/SomeDep/Package.swift"]), []);
    assert.deepEqual(detectChangedManifests(["rust/target/Cargo.toml"]), []);
  });

  test("duplicate writes of the same manifest are reported once", () => {
    const changed = detectChangedManifests(["package.json", "./package.json"]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "npm");
  });

  test("the same manifest in two different subprojects is two distinct changes", () => {
    // A monorepo's web/package.json and packages/ui/package.json are two
    // genuinely different dependency sets — collapsing them to one entry
    // would install only one of them.
    const changed = detectChangedManifests(["web/package.json", "packages/ui/package.json"]);
    assert.equal(changed.length, 2);
    assert.deepEqual(changed.map((m) => m.cwd), ["web", "packages/ui"]);
  });

  test("a manifest's own file stays matched even when written alongside ignored directories", () => {
    // The ignored-directory rule filters the PATH, not the whole change set —
    // a real root manifest in the same write set must still be detected.
    const changed = detectChangedManifests(["node_modules/foo/package.json", "package.json"]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "npm");
  });
});

/**
 * Diff triggers: the basename says a manifest was WRITTEN, but only the diff
 * says whether what changed was actually the dependency set. Without this, an
 * edit to a `package.json`'s `"scripts"` block (or a Gradle script's
 * `android {}` block) would interrupt the user with an install nobody needed.
 */
describe("detectChangedManifests — diffTriggers", () => {
  test("a package.json edit that touches dependencies counts", () => {
    const changed = detectChangedManifests(["package.json"], [
      {
        path: "package.json",
        text: 'diff --git a/package.json b/package.json\n+    "lodash": "^4.17.21",\n   "dependencies": {',
      },
    ]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "npm");
  });

  test("a package.json edit that touches only scripts does NOT count", () => {
    const changed = detectChangedManifests(["package.json"], [
      { path: "package.json", text: 'diff --git a/package.json b/package.json\n+    "test": "node scripts/test.mjs",' },
    ]);
    assert.deepEqual(changed, [], "editing scripts is not a dependency change");
  });

  test("a Gradle script edit that touches only the android block does NOT count", () => {
    const changed = detectChangedManifests(["app/build.gradle.kts"], [
      { path: "app/build.gradle.kts", text: '+    compileSdk = 35\n+    minSdk = 26' },
    ]);
    assert.deepEqual(changed, [], "compileSdk is not a dependency declaration");
  });

  test("a Gradle script edit in a module still resolves to the project root, where gradlew actually lives", () => {
    const changed = detectChangedManifests(["app/build.gradle.kts"], [
      { path: "app/build.gradle.kts", text: '+    implementation("androidx.core:core-ktx:1.13.1")' },
    ]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "gradle-kts");
    assert.equal(
      changed[0].cwd,
      "",
      "gradlew/gradlew.bat live at the Gradle build root, never inside a module's own subdirectory " +
        "— running from app/ produced \"'gradlew.bat' is not recognized...\" since no wrapper exists there"
    );
  });

  test("a manifest with no diffTriggers counts on any edit (requirements.txt, go.mod, Podfile)", () => {
    for (const written of ["requirements.txt", "go.mod", "Podfile", "Gemfile"]) {
      const changed = detectChangedManifests([written], [{ path: written, text: "-old\n+new" }]);
      assert.equal(changed.length, 1, `${written} has no section markers, so any edit counts`);
    }
  });

  test("a diff supplied for a DIFFERENT file does not suppress the manifest match", () => {
    // Fail-open: no diff for package.json means the basename alone decides.
    const changed = detectChangedManifests(["package.json"], [{ path: "src/index.ts", text: "+console.log(1)" }]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, "npm");
  });

  test("a nested manifest's diff is matched by its full relative path", () => {
    const changed = detectChangedManifests(["web/package.json"], [
      { path: "web/package.json", text: '+    "axios": "^1.7.0",\n   "dependencies": {' },
    ]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].cwd, "web");

    const suppressed = detectChangedManifests(["web/package.json"], [
      { path: "web/package.json", text: '+    "lint": "eslint ."' },
    ]);
    assert.deepEqual(suppressed, []);
  });
});

describe("resolveInstallCommands — package manager selection", () => {
  test("selects the correct install command for every one of the 19 ecosystems", () => {
    const expectations: Array<[string, string]> = [
      ["package.json", "npm install --ignore-scripts"],
      ["requirements.txt", "pip install -r requirements.txt"],
      ["pyproject.toml", "pip install ."],
      ["Pipfile", "pipenv install"],
      ["build.gradle.kts", GRADLE_CMD],
      ["build.gradle", GRADLE_CMD],
      ["gradle/libs.versions.toml", GRADLE_CMD],
      ["pom.xml", "mvn -B -DskipTests dependency:resolve"],
      ["pubspec.yaml", "flutter pub get"],
      ["Cargo.toml", "cargo check"],
      ["go.mod", "go mod tidy"],
      ["Podfile", "pod install"],
      ["Package.swift", "swift package resolve"],
      ["composer.json", "composer install"],
      ["Gemfile", "bundle install"],
      ["src/App/App.csproj", "dotnet restore"],
      ["vcpkg.json", "vcpkg install"],
      ["conanfile.txt", "conan install ."],
      ["mix.exs", "mix deps.get"],
    ];

    for (const [written, expected] of expectations) {
      assert.deepEqual(resolveInstallCommands([written]), [expected], `${written} should resolve to ${expected}`);
    }
  });

  test("multiple manifests of the same family collapse to one command", () => {
    const commands = resolveInstallCommands(["build.gradle.kts", "settings.gradle", "gradle/libs.versions.toml"]);
    assert.deepEqual(commands, [GRADLE_CMD]);
  });

  test("distinct manifest families each contribute their own command, in a stable order", () => {
    const commands = resolveInstallCommands(["go.mod", "package.json"]);
    assert.deepEqual(commands, ["npm install --ignore-scripts", "go mod tidy"]);
  });

  test("the same command in two subprojects is still two plan entries, at two directories", () => {
    // The command strings collapse (both are `npm install --ignore-scripts`)
    // but the PLAN must not: each subproject's dependencies are installed
    // where its own manifest lives.
    const plan = resolveInstallPlan(["web/package.json", "packages/ui/package.json"]);
    assert.equal(plan.length, 2, "two subprojects are two installs, not one");
    assert.deepEqual(plan.map((step) => step.cwd), ["web", "packages/ui"]);
    assert.deepEqual(resolveInstallCommands(["web/package.json", "packages/ui/package.json"]), [
      "npm install --ignore-scripts",
    ]);
  });

  test("resolveInstallPlan de-duplicates identical (command, directory) pairs", () => {
    const plan = resolveInstallPlan(["build.gradle.kts", "settings.gradle.kts", "gradle/libs.versions.toml"]);
    assert.equal(plan.length, 1, "three Gradle triggers at the build root are one install");
    assert.equal(plan[0].command, GRADLE_CMD);
    assert.equal(plan[0].cwd, "");
  });

  test("a Gradle version catalog under gradle/ resolves to the build root, not gradle/", () => {
    const plan = resolveInstallPlan(["gradle/libs.versions.toml"]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].cwd, "", "gradlew lives in the parent of gradle/, not in gradle/ itself");
  });

  test("a nested version catalog resolves to its own Gradle build root", () => {
    const plan = resolveInstallPlan(["android/gradle/libs.versions.toml"]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].cwd, "android", "the Android subproject's own gradlew directory");
  });

  test("a non-manifest change resolves to no command at all", () => {
    assert.deepEqual(resolveInstallCommands(["src/index.ts"]), []);
    assert.deepEqual(resolveInstallPlan(["src/index.ts"]), []);
  });
});

describe("handleDependencyInstallGate", () => {
  test("non-manifest file changes skip installation without prompting", async () => {
    let prompted = false;
    let executed = false;

    const result = await handleDependencyInstallGate({
      writtenFiles: ["src/index.ts", "test/editorHandoff.test.ts"],
      cwd: process.cwd(),
      prompter: async () => {
        prompted = true;
        return true;
      },
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.executed, false);
    assert.equal(result.command, undefined);
    assert.equal(prompted, false, "the user must never be interrupted for a non-dependency change");
    assert.equal(executed, false);
  });

  test("a manifest change prompts and runs the resolved command when approved", async () => {
    const prompts: string[] = [];
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["src/app.ts", "package.json"],
      cwd: "/tmp/example-repo",
      prompter: async (message) => {
        prompts.push(message);
        return true;
      },
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.command, "npm install --ignore-scripts");
    assert.equal(prompts.length, 1, "a manifest change must ask exactly once");
    assert.ok(prompts[0].includes("npm install --ignore-scripts"), "the prompt shows the command it is about to run");
    assert.deepEqual(runs, [{ command: "npm install --ignore-scripts", cwd: "/tmp/example-repo" }]);
  });

  test("every distinct resolved command is executed, in order, once approved", async () => {
    const runs: string[] = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["package.json", "go.mod"],
      cwd: "/tmp/example-repo",
      prompter: async () => true,
      executor: async (command) => {
        runs.push(command);
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.command, "npm install --ignore-scripts && go mod tidy");
    assert.deepEqual(runs, ["npm install --ignore-scripts", "go mod tidy"]);
  });

  test("a nested manifest runs its command in its own subproject directory", async () => {
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["web/package.json"],
      cwd: "/tmp/monorepo",
      prompter: async () => true,
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.command, "npm install --ignore-scripts");
    assert.deepEqual(
      runs,
      [{ command: "npm install --ignore-scripts", cwd: path.join("/tmp/monorepo", "web") }],
      "a nested manifest must install in the subproject it belongs to, not at the repo root"
    );
    assert.deepEqual(result.plan, [
      { command: "npm install --ignore-scripts", cwd: path.join("/tmp/monorepo", "web") },
    ]);
  });

  test("two subprojects' manifests each install in their own directory", async () => {
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["web/package.json", "api/go.mod"],
      cwd: "/tmp/monorepo",
      prompter: async () => true,
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.deepEqual(runs, [
      { command: "npm install --ignore-scripts", cwd: path.join("/tmp/monorepo", "web") },
      { command: "go mod tidy", cwd: path.join("/tmp/monorepo", "api") },
    ]);
  });

  test("a manifest edit whose diff touches no dependency markers is skipped without prompting", async () => {
    let prompted = false;
    let executed = false;

    const result = await handleDependencyInstallGate({
      writtenFiles: ["package.json"],
      cwd: process.cwd(),
      diffs: [{ path: "package.json", text: '+    "lint": "eslint ."' }],
      prompter: async () => {
        prompted = true;
        return true;
      },
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.executed, false);
    assert.equal(result.command, undefined, "a scripts-only edit resolves to no command at all");
    assert.equal(prompted, false, "the user must never be interrupted for a non-dependency edit");
    assert.equal(executed, false);
  });

  test("a manifest edit whose diff DOES touch dependencies is prompted and run", async () => {
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["Cargo.toml"],
      cwd: "/tmp/rust-project",
      diffs: [{ path: "Cargo.toml", text: "+[dependencies]\n+serde = { version = \"1\", features = [\"derive\"] }" }],
      prompter: async () => true,
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.command, "cargo check");
    assert.deepEqual(runs, [{ command: "cargo check", cwd: "/tmp/rust-project" }]);
  });

  test("rejecting the prompt skips installation gracefully", async () => {
    let executed = false;

    const result = await handleDependencyInstallGate({
      writtenFiles: ["requirements.txt"],
      cwd: process.cwd(),
      prompter: async () => false,
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.executed, false, "a declined prompt must not run the install");
    assert.equal(result.command, "pip install -r requirements.txt", "the skipped command is still reported");
    assert.equal(executed, false);
  });

  test("a failed install is non-fatal and reports executed: false", async () => {
    const result = await handleDependencyInstallGate({
      writtenFiles: ["Cargo.toml"],
      cwd: process.cwd(),
      prompter: async () => true,
      executor: async () => {
        throw new Error("cargo: command not found");
      },
    });

    assert.equal(result.executed, false, "a failed install must never take down the phase");
    assert.equal(result.command, "cargo check");
  });

  test("a rejecting prompter is treated as a decline, never as a crash", async () => {
    const result = await handleDependencyInstallGate({
      writtenFiles: ["pubspec.yaml"],
      cwd: process.cwd(),
      prompter: async () => {
        throw new Error("stdin closed");
      },
      executor: async () => {
        throw new Error("must not run");
      },
    });

    assert.equal(result.executed, false);
    assert.equal(result.command, "flutter pub get");
  });

  test("an install that fails on the SECOND command still reports the combined command without throwing", async () => {
    const runs: string[] = [];

    const result = await handleDependencyInstallGate({
      writtenFiles: ["package.json", "go.mod"],
      cwd: process.cwd(),
      prompter: async () => true,
      executor: async (command) => {
        runs.push(command);
        if (command.startsWith("go ")) throw new Error("go: not installed");
      },
    });

    assert.equal(result.executed, false, "a partially failed install is not a successful one");
    assert.equal(result.command, "npm install --ignore-scripts && go mod tidy");
    assert.deepEqual(runs, ["npm install --ignore-scripts", "go mod tidy"]);
  });

  test("every one of the 19 ecosystems resolves to its own command through the gate", async () => {
    const expectations: Array<[string, string]> = [
      ["package.json", "npm install --ignore-scripts"],
      ["requirements.txt", "pip install -r requirements.txt"],
      ["pyproject.toml", "pip install ."],
      ["Pipfile", "pipenv install"],
      ["build.gradle.kts", GRADLE_CMD],
      ["build.gradle", GRADLE_CMD],
      ["gradle/libs.versions.toml", GRADLE_CMD],
      ["pom.xml", "mvn -B -DskipTests dependency:resolve"],
      ["pubspec.yaml", "flutter pub get"],
      ["Cargo.toml", "cargo check"],
      ["go.mod", "go mod tidy"],
      ["Podfile", "pod install"],
      ["Package.swift", "swift package resolve"],
      ["composer.json", "composer install"],
      ["Gemfile", "bundle install"],
      ["src/App/App.csproj", "dotnet restore"],
      ["vcpkg.json", "vcpkg install"],
      ["conanfile.txt", "conan install ."],
      ["mix.exs", "mix deps.get"],
    ];

    // A directory with a Gradle wrapper in it, so the gradle rows are runnable.
    const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-wrapper-"));
    tempRepos.push(wrapperDir);
    fs.writeFileSync(path.join(wrapperDir, GRADLE_WRAPPER), "");

    for (const [written, expected] of expectations) {
      const runs: string[] = [];
      const result = await handleDependencyInstallGate({
        writtenFiles: [written],
        cwd: wrapperDir,
        prompter: async () => true,
        executor: async (command) => {
          runs.push(command);
        },
      });
      assert.equal(result.command, expected, `${written} should resolve to ${expected}`);
      assert.deepEqual(runs, [expected], `${written} should run exactly its resolved command`);
    }
  });
});

describe("resolveAbsoluteInstallPlan", () => {
  test("resolves a plain package.json install to the repo root", () => {
    const matches = detectChangedManifests(["package.json"]);
    const plan = resolveAbsoluteInstallPlan(matches, "/tmp/example-repo");
    assert.deepEqual(plan, [{ command: "npm install --ignore-scripts", cwd: "/tmp/example-repo" }]);
  });

  test("resolves a nested manifest to its own subproject directory", () => {
    const matches = detectChangedManifests(["web/package.json"]);
    const plan = resolveAbsoluteInstallPlan(matches, "/tmp/monorepo");
    assert.deepEqual(plan, [{ command: "npm install --ignore-scripts", cwd: path.join("/tmp/monorepo", "web") }]);
  });

  test("de-duplicates identical (command, directory) pairs", () => {
    const matches = detectChangedManifests(["build.gradle.kts", "settings.gradle.kts", "gradle/libs.versions.toml"]);
    const plan = resolveAbsoluteInstallPlan(matches, "/tmp/android-repo");
    assert.equal(plan.length, 1, "all three gradle triggers resolve to the same single ./gradlew run");
  });

  test("empty for a change touching no manifest at all", () => {
    assert.deepEqual(resolveAbsoluteInstallPlan(detectChangedManifests(["src/index.ts"]), "/tmp/repo"), []);
  });
});

// Built for the real failure that prompted run_dependency_install: an SDK
// upgrade patched a plausible-looking version, concluded without ever
// seeing whether it actually resolved, and QA found a real conflict (and
// then a SECOND, cascading one) several minutes later that EDITOR never had
// a chance to see or react to within its own turn.
describe("runDependencyInstallCheck — backs the run_dependency_install tool", () => {
  test("no dependency manifest changed yet: a plain notice, never a prompt or an install", async () => {
    let asked = false;
    const result = await runDependencyInstallCheck(
      ["src/index.ts"],
      "/tmp/repo",
      async () => {
        asked = true;
        return true;
      },
      async () => ({ ok: true, output: "should never run" })
    );
    assert.match(result, /No dependency manifest has been changed/i);
    assert.equal(asked, false, "must never interrupt the user for a non-dependency change");
  });

  test("declined approval: reports it plainly and never runs the install", async () => {
    const executed: string[] = [];
    const result = await runDependencyInstallCheck(
      ["package.json"],
      "/tmp/repo",
      async () => false,
      async (command) => {
        executed.push(command);
        return { ok: true, output: "unexpected" };
      }
    );
    assert.match(result, /Not run — declined/);
    assert.deepEqual(executed, []);
  });

  test("approved and successful: reports PASS with the real captured output", async () => {
    const result = await runDependencyInstallCheck(
      ["package.json"],
      "/tmp/repo",
      async () => true,
      async () => ({ ok: true, output: "added 42 packages in 3s" })
    );
    assert.match(result, /\[PASS\] npm install --ignore-scripts/);
    assert.match(result, /added 42 packages in 3s/);
  });

  test("approved and failed: reports FAIL with the real error output, the exact thing the self-check exists to surface", async () => {
    const result = await runDependencyInstallCheck(
      ["package.json"],
      "/tmp/repo",
      async () => true,
      async () => ({
        ok: false,
        output: "npm error ERESOLVE could not resolve\nnpm error Found: react@19.3.0\nnpm error Could not resolve dependency:\nnpm error peer react@19.2.3 from react-dom@19.2.3",
      })
    );
    assert.match(result, /\[FAIL\] npm install --ignore-scripts/);
    assert.match(result, /ERESOLVE could not resolve/);
    assert.match(result, /peer react@19\.2\.3/);
  });

  test("a failed step stops before running any later step — a failed install makes later results moot", async () => {
    const executed: string[] = [];
    const result = await runDependencyInstallCheck(
      ["package.json", "go.mod"],
      "/tmp/repo",
      async () => true,
      async (command) => {
        executed.push(command);
        return { ok: false, output: "boom" };
      }
    );
    assert.deepEqual(executed, ["npm install --ignore-scripts"], "go mod tidy must never run after npm install already failed");
    assert.match(result, /\[FAIL\]/);
    assert.doesNotMatch(result, /go mod tidy/);
  });

  test("an approve callback that throws is treated as a decline, never a crash", async () => {
    const result = await runDependencyInstallCheck(
      ["package.json"],
      "/tmp/repo",
      async () => {
        throw new Error("no terminal available");
      },
      async () => ({ ok: true, output: "unexpected" })
    );
    assert.match(result, /Not run — declined/);
  });
});

// The real failure: an Expo / React Native project keeps gradlew in android/,
// so running it at the repo root failed ("not recognized"), the model retried,
// and the user was asked to approve the same doomed command four times.
describe("Gradle wrapper location and unrunnable installs", () => {
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-gradle-"));
    tempRepos.push(dir);
    return dir;
  }

  test("a wrapper in android/ is found and the install runs there", () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, "android", "app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "android", GRADLE_WRAPPER), "");
    const plan = resolveAbsoluteInstallPlan(detectChangedManifests(["android/app/build.gradle"]), repo);
    assert.deepEqual(plan, [{ command: GRADLE_CMD, cwd: path.join(repo, "android") }]);
  });

  test("a root wrapper still wins when it exists", () => {
    const repo = tempDir();
    fs.writeFileSync(path.join(repo, GRADLE_WRAPPER), "");
    const plan = resolveAbsoluteInstallPlan(detectChangedManifests(["app/build.gradle.kts"]), repo);
    assert.deepEqual(plan, [{ command: GRADLE_CMD, cwd: repo }]);
  });

  test("no wrapper anywhere: reported, never prompted, never executed", async () => {
    const repo = tempDir();
    let asked = false;
    let ran = false;
    const result = await runDependencyInstallCheck(
      ["app/build.gradle.kts"],
      repo,
      async () => {
        asked = true;
        return true;
      },
      async () => {
        ran = true;
        return { ok: true, output: "unexpected" };
      }
    );
    assert.match(result, /Not run/);
    assert.match(result, /do not call run_dependency_install again/i);
    assert.equal(asked, false);
    assert.equal(ran, false);
  });

  test("the post-phase gate skips an unrunnable gradle install instead of aborting the phase", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "app/build.gradle.kts", "dependencies {\n}\n");
    fs.writeFileSync(
      path.join(repo, "app", "build.gradle.kts"),
      'dependencies {\n    implementation("androidx.core:core-ktx:1.13.1")\n}\n',
      "utf-8"
    );
    let prompted = false;
    const result = await handlePostPhaseDependencies(["app/build.gradle.kts"], repo, {
      prompter: async () => {
        prompted = true;
        return "1";
      },
      executor: async () => {
        throw new Error("must not run");
      },
    });
    assert.equal(result.aborted, false, "a missing wrapper is not a user decision and not a broken phase");
    assert.equal(result.executed, false);
    assert.equal(prompted, false);
  });

  test("an identical retry returns the earlier result without prompting or re-running", async () => {
    const repo = tempDir();
    fs.writeFileSync(path.join(repo, "package.json"), '{"dependencies":{"left-pad":"1.3.0"}}');
    const memo = new Map<string, string>();
    let asked = 0;
    let ran = 0;
    const call = () =>
      runDependencyInstallCheck(
        ["package.json"],
        repo,
        async () => {
          asked++;
          return true;
        },
        async () => {
          ran++;
          return { ok: false, output: "npm error ERESOLVE" };
        },
        memo
      );
    const first = await call();
    const second = await call();
    assert.match(first, /\[FAIL\]/);
    assert.match(second, /Not re-run/);
    assert.match(second, /ERESOLVE/);
    assert.equal(asked, 1);
    assert.equal(ran, 1);

    // Editing the manifest is a different install: it runs (and asks) again.
    fs.writeFileSync(path.join(repo, "package.json"), '{"dependencies":{"left-pad":"1.3.1"}}');
    await call();
    assert.equal(ran, 2);
  });
});

/**
 * Phase: git-diff dependency inspection and the post-phase interactive gate.
 *
 * `handleDependencyInstallGate` above is driven by the editor's own write log.
 * These cover the other half: a manifest file's REAL git diff decides whether
 * its added lines actually touched the dependency set, and the human gets
 * three explicit answers — install, skip, or abort the phase — with every path
 * contained to the repository it was resolved against.
 */

/** Temp repos created by this suite, removed once the file's tests finish. */
const tempRepos: string[] = [];

after(() => {
  for (const dir of tempRepos) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must never fail the suite.
    }
  }
});

/** A throwaway git repository whose working tree the tests can edit freely. */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-deps-"));
  tempRepos.push(dir);
  // Deliberately a path that's never created, not os.devNull: on Windows,
  // devNull is the device path `\\.\nul`, and git tries to actually access
  // GIT_CONFIG_GLOBAL as a real file — `fatal: unable to access '\\.\nul':
  // Invalid argument` on every single git call. A plain nonexistent path
  // gets treated as "no global config" on every platform, which is the
  // actual isolation this needs (the user's own global config must not be
  // able to substitute a custom diff driver for `git diff` and change what
  // these tests parse), without depending on null-device semantics at all.
  const fakeGlobalConfig = path.join(dir, ".gitconfig-test-empty");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: fakeGlobalConfig },
    });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "baseline");
  return dir;
}

/** Writes `file` under `dir` and stages a baseline so its next edit has a diff. */
function commitBaseline(dir: string, file: string, contents: string): void {
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf-8");
  execFileSync("git", ["add", "--", file], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", `baseline ${file}`], { cwd: dir, stdio: "ignore" });
}

describe("inspectFileForNewDependencies — git diff evidence", () => {
  test("an added dependency line matches the manifest family", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "package.json", '{\n  "name": "app",\n  "dependencies": {}\n}\n');
    fs.writeFileSync(
      path.join(repo, "package.json"),
      '{\n  "name": "app",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n',
      "utf-8"
    );

    const rule = await inspectFileForNewDependencies("package.json", repo);
    assert.ok(rule, "an added dependency line must be recognized as a dependency change");
    assert.equal(rule!.id, "npm");
    assert.equal(rule!.getInstallCommand(), "npm install --ignore-scripts");
  });

  test("an edit that touches only scripts is NOT a dependency change", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "package.json", '{\n  "name": "app",\n  "scripts": {}\n}\n');
    fs.writeFileSync(
      path.join(repo, "package.json"),
      '{\n  "name": "app",\n  "scripts": {\n    "test": "node scripts/test.mjs"\n  }\n}\n',
      "utf-8"
    );

    assert.equal(
      await inspectFileForNewDependencies("package.json", repo),
      undefined,
      "editing scripts is not a dependency change, so the user is never interrupted"
    );
  });

  test("a non-manifest file is never a dependency change", async () => {
    const repo = makeGitRepo();
    assert.equal(await inspectFileForNewDependencies("src/index.ts", repo), undefined);
    assert.equal(await inspectFileForNewDependencies("README.md", repo), undefined);
  });

  test("a vendored manifest is ignored", async () => {
    const repo = makeGitRepo();
    assert.equal(
      await inspectFileForNewDependencies("node_modules/foo/package.json", repo),
      undefined,
      "a copy of a manifest inside node_modules is never the project's own declaration"
    );
  });

  test("a path escaping the repository is rejected, never inspected", async () => {
    const repo = makeGitRepo();
    assert.equal(await inspectFileForNewDependencies("../outside/package.json", repo), undefined);
    assert.equal(await inspectFileForNewDependencies(path.resolve(repo, "..", "escape", "go.mod"), repo), undefined);
  });

  test("a manifest with no diffTriggers counts on any diff, and an untracked manifest still matches", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "requirements.txt", "requests==2.0.0\n");
    fs.writeFileSync(path.join(repo, "requirements.txt"), "requests==2.0.0\nflask==3.0.0\n", "utf-8");
    assert.equal((await inspectFileForNewDependencies("requirements.txt", repo))?.id, "pip-requirements");

    // Untracked: no diff exists at all, so the basename match alone decides —
    // a brand-new manifest the editor just created must never be skipped.
    const untrackedRepo = makeGitRepo();
    fs.writeFileSync(path.join(untrackedRepo, "Cargo.toml"), '[package]\nname = "x"\n', "utf-8");
    assert.equal((await inspectFileForNewDependencies("Cargo.toml", untrackedRepo))?.id, "cargo");
  });

  test("a nested manifest is scoped by its own relative path", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "web/package.json", '{\n  "dependencies": {}\n}\n');
    fs.writeFileSync(
      path.join(repo, "web", "package.json"),
      '{\n  "dependencies": {\n    "axios": "^1.7.0"\n  }\n}\n',
      "utf-8"
    );

    const rule = await inspectFileForNewDependencies("web/package.json", repo);
    assert.equal(rule?.id, "npm");
  });
});

describe("handlePostPhaseDependencies — the three-way interactive gate", () => {
  /**
   * A repo whose `package.json` diff really adds a dependency.
   */
  function repoWithDependencyChange(): string {
    const repo = makeGitRepo();
    commitBaseline(repo, "package.json", '{\n  "name": "app",\n  "dependencies": {}\n}\n');
    fs.writeFileSync(
      path.join(repo, "package.json"),
      '{\n  "name": "app",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n',
      "utf-8"
    );
    return repo;
  }

  test("an unrecognized answer (including a bare Enter) is the safe skip, never an install", async () => {
    const repo = repoWithDependencyChange();
    let executed = false;

    // The prompt's default answer is option 2, so a bare Enter must skip —
    // injecting it here also keeps the test independent of whether the suite
    // happens to be running on a real TTY.
    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => "",
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.aborted, false, "skipping must never fail the phase");
    assert.equal(result.executed, false);
    assert.equal(result.command, "npm install --ignore-scripts");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, "npm");
    assert.deepEqual(result.plan, [{ command: "npm install --ignore-scripts", cwd: repo }]);
    assert.equal(executed, false, "an unanswered prompt must never run an install");
  });

  test("option 1 with an injected prompter runs the command in the manifest's own directory", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "web/package.json", '{\n  "dependencies": {}\n}\n');
    fs.writeFileSync(
      path.join(repo, "web", "package.json"),
      '{\n  "dependencies": {\n    "axios": "^1.7.0"\n  }\n}\n',
      "utf-8"
    );

    const prompts: string[] = [];
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await handlePostPhaseDependencies(["web/package.json"], repo, {
      prompter: async (message) => {
        prompts.push(message);
        return "1";
      },
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.aborted, false);
    assert.equal(result.command, "npm install --ignore-scripts");
    assert.equal(prompts.length, 1, "the gate asks exactly once");
    assert.ok(prompts[0].includes("npm install --ignore-scripts"), "the prompt shows the command it will run");
    assert.deepEqual(
      runs,
      [{ command: "npm install --ignore-scripts", cwd: path.join(repo, "web") }],
      "a nested manifest installs in its own subproject directory, never at the repo root"
    );
  });

  // The bug this fixes: matches[].cwd correctly resolved through
  // rule.commandDir (gradlew always lives at the project root, never inside
  // a module), but plan[].cwd — what actually gets EXECUTED — used the raw
  // manifest directory and bypassed commandDir entirely. A module-level
  // Gradle change ran the install command from inside the module, where no
  // wrapper exists, even though the printed summary showed the correct root.
  test("a module-level Gradle manifest still executes at the project root, not inside the module", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "app/build.gradle.kts", 'dependencies {\n}\n');
    fs.writeFileSync(path.join(repo, GRADLE_WRAPPER), "");
    fs.writeFileSync(
      path.join(repo, "app", "build.gradle.kts"),
      'dependencies {\n    implementation("androidx.core:core-ktx:1.13.1")\n}\n',
      "utf-8"
    );

    const runs: Array<{ command: string; cwd: string }> = [];
    const result = await handlePostPhaseDependencies(["app/build.gradle.kts"], repo, {
      prompter: async () => "1",
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.matches[0].cwd, "", "the displayed summary resolves to the project root");
    assert.deepEqual(
      runs,
      [{ command: GRADLE_CMD, cwd: repo }],
      "the ACTUALLY EXECUTED command must run at the project root too, not inside app/ where no gradlew exists"
    );
  });

  // The bug this fixes: handleDependencyInstallGate (the editor-write-log
  // gate, run earlier in the phase) and this gate commonly detect the SAME
  // manifest change independently -- without threading the first gate's
  // result through, the user got asked twice in a row for the identical
  // underlying dependency change.
  test("alreadyExecuted covering the only detected change skips the prompt entirely", async () => {
    const repo = repoWithDependencyChange();
    let prompted = false;
    let executed = false;

    const result = await handlePostPhaseDependencies(
      ["package.json"],
      repo,
      {
        prompter: async () => {
          prompted = true;
          return "1";
        },
        executor: async () => {
          executed = true;
        },
      },
      [{ command: "npm install --ignore-scripts", cwd: repo }]
    );

    assert.equal(prompted, false, "must not ask again for a change the earlier gate already installed");
    assert.equal(executed, false, "must not re-run an install that already succeeded");
    assert.equal(result.executed, true, "the dependency change IS satisfied, just not by this gate");
    assert.equal(result.aborted, false);
    assert.equal(result.matches.length, 1, "the manifest is still reported, so the caller can see what was covered");
  });

  test("alreadyExecuted covering only SOME of the detected changes still asks about the rest", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "package.json", '{\n  "name": "app",\n  "dependencies": {}\n}\n');
    commitBaseline(repo, "go.mod", "module example.com/app\n\ngo 1.22\n");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      '{\n  "name": "app",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n',
      "utf-8"
    );
    fs.writeFileSync(
      path.join(repo, "go.mod"),
      "module example.com/app\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n",
      "utf-8"
    );

    const prompts: string[] = [];
    const runs: Array<{ command: string; cwd: string }> = [];
    const result = await handlePostPhaseDependencies(
      ["package.json", "go.mod"],
      repo,
      {
        prompter: async (message) => {
          prompts.push(message);
          return "1";
        },
        executor: async (command, cwd) => {
          runs.push({ command, cwd });
        },
      },
      [{ command: "npm install --ignore-scripts", cwd: repo }]
    );

    assert.equal(prompts.length, 1, "only asks once, about the one change not already covered");
    assert.ok(prompts[0].includes("go mod tidy"), "the prompt must be about the remaining command, not the covered one");
    assert.ok(!prompts[0].includes("npm install"), "the already-satisfied command must not be re-offered");
    assert.deepEqual(runs, [{ command: "go mod tidy", cwd: repo }]);
    assert.equal(result.executed, true);
  });

  test("with no alreadyExecuted given, behavior is unchanged — asks about everything detected", async () => {
    const repo = repoWithDependencyChange();
    let prompted = false;

    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => {
        prompted = true;
        return "2";
      },
    });

    assert.equal(prompted, true);
    assert.equal(result.command, "npm install --ignore-scripts");
  });

  test("option 2 skips: nothing runs and the phase continues to QA", async () => {
    const repo = repoWithDependencyChange();
    let executed = false;

    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => "2",
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.executed, false);
    assert.equal(result.aborted, false, "skipping must never fail the phase");
    assert.equal(result.command, "npm install --ignore-scripts", "the skipped command is still reported");
    assert.equal(executed, false);
  });

  test("option 3 aborts the phase and runs nothing", async () => {
    const repo = repoWithDependencyChange();
    let executed = false;

    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => "3",
      executor: async () => {
        executed = true;
      },
    });

    assert.equal(result.aborted, true, "abort must stop the phase before QA");
    assert.equal(result.executed, false);
    assert.equal(executed, false, "an aborted phase never runs the install");
    assert.equal(result.reason, "user_declined", "an explicit human decision must never be auto-repaired");
  });

  test("a manifest edit whose diff touches no dependency markers never prompts", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "package.json", '{\n  "scripts": {}\n}\n');
    fs.writeFileSync(path.join(repo, "package.json"), '{\n  "scripts": {\n    "lint": "eslint ."\n  }\n}\n', "utf-8");

    let prompted = false;
    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => {
        prompted = true;
        return "1";
      },
      executor: async () => {
        throw new Error("must not run");
      },
    });

    assert.equal(prompted, false, "the user is never interrupted for a non-dependency edit");
    assert.equal(result.matches.length, 0);
    assert.equal(result.command, undefined);
  });

  test("a phase with no manifest files resolves to nothing at all", async () => {
    const repo = makeGitRepo();
    const result = await handlePostPhaseDependencies(["src/index.ts", "README.md"], repo);
    assert.deepEqual(result, { aborted: false, executed: false, matches: [] });
  });

  test("an empty file list or target directory is a no-op, never a crash", async () => {
    assert.deepEqual(await handlePostPhaseDependencies([], process.cwd()), {
      aborted: false,
      executed: false,
      matches: [],
    });
    assert.deepEqual(await handlePostPhaseDependencies(["package.json"], ""), {
      aborted: false,
      executed: false,
      matches: [],
    });
  });

  test("a path that escapes the repository is rejected and never prompted for", async () => {
    const repo = repoWithDependencyChange();
    let prompted = false;

    const result = await handlePostPhaseDependencies(
      ["../outside/package.json", path.resolve(repo, "..", "escape", "go.mod")],
      repo,
      {
        prompter: async () => {
          prompted = true;
          return "1";
        },
        executor: async () => {
          throw new Error("must not run");
        },
      }
    );

    assert.equal(prompted, false, "an out-of-repo path must never reach the prompt");
    assert.deepEqual(result.matches, []);
    assert.equal(result.aborted, false);
  });

  test("an approved install that then fails aborts the phase instead of letting QA report it as a code defect", async () => {
    const repo = repoWithDependencyChange();

    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => "1",
      executor: async () => {
        throw new Error("npm: command not found");
      },
    });

    assert.equal(result.aborted, true, "a failed approved install must stop the phase");
    assert.equal(result.executed, false);
    assert.equal(result.command, "npm install --ignore-scripts");
    // Distinguishes a mechanical install failure (worth one automatic repair
    // attempt upstream) from the user explicitly choosing to abort (never
    // worth auto-repairing) -- see index.ts's use of `reason`.
    assert.equal(result.reason, "install_failed");
    assert.ok(result.errorDetail?.includes("npm: command not found"), "the raw failure text must survive for a repair prompt to use");
  });

  test("a rejecting prompter is treated as a skip, never as a crash", async () => {
    const repo = repoWithDependencyChange();

    const result = await handlePostPhaseDependencies(["package.json"], repo, {
      prompter: async () => {
        throw new Error("stdin closed");
      },
      executor: async () => {
        throw new Error("must not run");
      },
    });

    assert.equal(result.aborted, false);
    assert.equal(result.executed, false);
  });

  test("two manifests resolve to two commands, each in its own subproject", async () => {
    const repo = makeGitRepo();
    commitBaseline(repo, "web/package.json", '{\n  "dependencies": {}\n}\n');
    commitBaseline(repo, "api/go.mod", "module api\n");
    fs.writeFileSync(
      path.join(repo, "web", "package.json"),
      '{\n  "dependencies": {\n    "axios": "^1.7.0"\n  }\n}\n',
      "utf-8"
    );
    fs.writeFileSync(path.join(repo, "api", "go.mod"), "module api\n\nrequire github.com/x/y v1.0.0\n", "utf-8");

    const runs: Array<{ command: string; cwd: string }> = [];
    const result = await handlePostPhaseDependencies(["web/package.json", "api/go.mod"], repo, {
      prompter: async () => "1",
      executor: async (command, cwd) => {
        runs.push({ command, cwd });
      },
    });

    assert.equal(result.executed, true);
    assert.equal(result.command, "npm install --ignore-scripts && go mod tidy");
    assert.deepEqual(runs, [
      { command: "npm install --ignore-scripts", cwd: path.join(repo, "web") },
      { command: "go mod tidy", cwd: path.join(repo, "api") },
    ]);
  });
});

describe("normalizePostPhaseDependencyChoice — the 1/2/3 answer mapping", () => {
  test("accepts the numeric options and their words", () => {
    assert.equal(normalizePostPhaseDependencyChoice("1"), "install");
    assert.equal(normalizePostPhaseDependencyChoice("install"), "install");
    assert.equal(normalizePostPhaseDependencyChoice("2"), "skip");
    assert.equal(normalizePostPhaseDependencyChoice("skip"), "skip");
    assert.equal(normalizePostPhaseDependencyChoice("3"), "abort");
    assert.equal(normalizePostPhaseDependencyChoice("abort"), "abort");
  });

  test("anything unrecognized (including an empty answer) is the safe skip", () => {
    assert.equal(normalizePostPhaseDependencyChoice(""), "skip", "an empty answer must never install");
    assert.equal(normalizePostPhaseDependencyChoice("   "), "skip");
    assert.equal(normalizePostPhaseDependencyChoice("maybe"), "skip");
    assert.equal(normalizePostPhaseDependencyChoice("7"), "skip");
  });
});

/**
 * Phase: explicit [Y/N] approval formatting.
 *
 * `promptUserApproval` backs every human-in-the-loop gate, and a destructive
 * confirmation (the end-of-run file deletion prompt) must not be presented
 * with the install gate's `[y/N]` default. These cover the suffix rendering
 * and the answer parser without needing a terminal.
 */
describe("buildApprovalPromptLine — [Y/N] vs [y/N] suffixing", () => {
  test("defaults to the (yes/no, Enter = no) form", () => {
    assert.equal(buildApprovalPromptLine("Install dependencies now?"), "Install dependencies now? (yes/no, Enter = no): ");
    assert.equal(
      buildApprovalPromptLine("Install dependencies now?", "default"),
      "Install dependencies now? (yes/no, Enter = no): "
    );
  });

  test("the explicit style renders (yes/no) with no implied default", () => {
    assert.equal(buildApprovalPromptLine("Delete 3 staged files?", "explicit"), "Delete 3 staged files? (yes/no): ");
  });

  test("a question that already ends in an approval suffix is never given a second one", () => {
    assert.equal(buildApprovalPromptLine("Delete these files? [Y/N]"), "Delete these files? [Y/N]: ");
    assert.equal(buildApprovalPromptLine("Delete these files? [Y/N]", "explicit"), "Delete these files? [Y/N]: ");
    assert.equal(buildApprovalPromptLine("Keep going? [y/N]"), "Keep going? [y/N]: ");
    assert.equal(buildApprovalPromptLine("Keep going? [Y/n]", "explicit"), "Keep going? [Y/n]: ");
    assert.equal(buildApprovalPromptLine("Proceed? [Y/n]"), "Proceed? [Y/n]: ");
    // The new wording counts as a suffix too, so it is never stacked.
    assert.equal(buildApprovalPromptLine("Go? (yes/no, Enter = no)"), "Go? (yes/no, Enter = no): ");
    assert.equal(buildApprovalPromptLine("Go? (yes/no)", "default"), "Go? (yes/no): ");
    assert.equal(buildApprovalPromptLine("Go? [yes/no]"), "Go? [yes/no]: ");
  });

  test("the explicit suffix is not appended on top of an existing one", () => {
    const line = buildApprovalPromptLine("Delete staged files? [y/N]", "explicit");
    assert.equal(line, "Delete staged files? [y/N]: ", "the caller's own suffix wins verbatim");
    assert.equal(line.match(/\[[yYnN]\/[yYnN]\]/g)?.length, 1, "exactly one suffix appears in the prompt line");
  });

  test("trailing whitespace on the question does not produce a double space", () => {
    assert.equal(buildApprovalPromptLine("Continue?   "), "Continue? (yes/no, Enter = no): ");
  });
});

describe("parseApprovalAnswer — case-insensitive yes/no", () => {
  test("accepts every spelling of yes, case-insensitively", () => {
    for (const yes of ["y", "Y", "yes", "YES", "Yes", " y ", "\tY\n", "yep"]) {
      assert.equal(parseApprovalAnswer(yes), true, `"${yes}" must be an approval`);
    }
  });

  test("accepts every spelling of no, case-insensitively", () => {
    for (const no of ["n", "N", "no", "NO", "No", " n ", "nope"]) {
      assert.equal(parseApprovalAnswer(no), false, `"${no}" must be a rejection`);
    }
  });

  test("an empty or whitespace-only answer is NO — silence is never consent", () => {
    assert.equal(parseApprovalAnswer(""), false, "a bare Enter must not approve a side-effecting command");
    assert.equal(parseApprovalAnswer("   "), false);
    assert.equal(parseApprovalAnswer("\n\t "), false);
  });

  test("unrecognized input is NO", () => {
    assert.equal(parseApprovalAnswer("maybe"), false);
    assert.equal(parseApprovalAnswer("1"), false);
  });

  test("null/undefined answers are handled without throwing", () => {
    assert.equal(parseApprovalAnswer(undefined as unknown as string), false);
    assert.equal(parseApprovalAnswer(null as unknown as string), false);
  });
});

// A real, live check against the actual npm registry -- the whole point of
// verifyAndFixNpmVersions is that no amount of mocking can stand in for
// "does this version actually exist," since that's exactly the question an
// LLM cannot answer from its own training data alone (a hallucinated version
// looks no different to it than a real one). Needs network access; uses
// left-pad, a long-frozen, permanently-stable single-version package chosen
// specifically so this test never needs updating as the real registry changes.
describe("verifyAndFixNpmVersions (live npm registry)", () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(deps: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-npmverify-"));
    tempDirs.push(dir);
    const file = path.join(dir, "package.json");
    fs.writeFileSync(file, JSON.stringify({ name: "app", dependencies: deps }, null, 2), "utf-8");
    return file;
  }

  test("corrects a version that was never published to a real, currently-published one", async () => {
    const file = writeManifest({ "left-pad": "999.999.999" });
    const fixes = await verifyAndFixNpmVersions(file, path.dirname(file));

    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].pkg, "left-pad");
    assert.equal(fixes[0].from, "999.999.999");
    assert.ok(/^\^\d+\.\d+\.\d+$/.test(fixes[0].to), `expected a real semver range, got "${fixes[0].to}"`);

    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(written.dependencies["left-pad"], fixes[0].to, "the manifest on disk must reflect the fix");
  });

  test("leaves an already-valid, published version untouched", async () => {
    const file = writeManifest({ "left-pad": "^1.3.0" });
    const fixes = await verifyAndFixNpmVersions(file, path.dirname(file));

    assert.deepEqual(fixes, []);
    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(written.dependencies["left-pad"], "^1.3.0", "must not touch a range that already resolves");
  });

  test("skips non-registry ranges entirely (file:, git+, workspace:) rather than trying to verify them", async () => {
    const file = writeManifest({
      "local-thing": "file:../local-thing",
      "git-thing": "git+https://example.com/repo.git",
      "workspace-thing": "workspace:*",
    });
    const fixes = await verifyAndFixNpmVersions(file, path.dirname(file));
    assert.deepEqual(fixes, [], "a local/git/workspace reference is not a registry version to verify");
  });

  test("a missing or unparseable manifest is a no-op, never a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-npmverify-"));
    tempDirs.push(dir);
    assert.deepEqual(await verifyAndFixNpmVersions(path.join(dir, "package.json"), dir), []);

    const badFile = path.join(dir, "bad-package.json");
    fs.writeFileSync(badFile, "{ not valid json", "utf-8");
    assert.deepEqual(await verifyAndFixNpmVersions(badFile, dir), []);
  });
});