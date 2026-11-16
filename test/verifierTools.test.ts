/**
 * Regression tests for the QA pipeline's priority order (change set -> semantic
 * -> build -> visual, each gated on the previous not already failing) and for
 * visual defects being blocking. These formalize the exact scenarios manually
 * verified against dist/ during that redesign, so a future change can't quietly
 * undo it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AutonomousVerifier,
  extractBuildFailureDetail,
  buildFailureSnippet,
  extractReferencedFilePaths,
  looksLikeMissingDependency,
  dependencyManifestHint,
  dependencyManifestCandidatePaths,
  stableGoalKey,
  loadNavMapText,
  HOW_TO_VERIFY_GOAL_MARKER,
  changeTouchesUiSurface,
  looksLikeTestRunner,
} from "../src/verifierTools.js";
import { ConfigSchema, type AgentConfig } from "../src/config.js";
import { events, YimpimEvent } from "../src/events.js";
import { EvidenceLedger } from "../src/evidence.js";
import { NavFlowReplayer } from "../src/uiFlows.js";
import type { ChangeSet } from "../src/staticQa.js";
import type { ProjectProfile } from "../src/projectProfile.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-verifier-test-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "test"]);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Fake OpenRouterClient. `onComplete` decides the response per call. */
function fakeClient(onComplete: (agent: string | undefined) => any) {
  const calls: string[] = [];
  // Which model chain each call was routed to, in call order — the whole
  // point of the verifierVision suite below, since an agent label alone
  // cannot tell verifierVision from verifier.
  const models: string[][] = [];
  return {
    client: {
      complete: async (modelList: any, _messages: any, opts?: { agent?: string }) => {
        calls.push(opts?.agent ?? "unknown");
        models.push(Array.isArray(modelList) ? [...modelList] : [modelList]);
        return onComplete(opts?.agent);
      },
    } as any,
    calls,
    models,
  };
}

const config = ConfigSchema.parse({});

describe("AutonomousVerifier priority order", () => {
  test("an empty change set fails immediately with zero model calls, and skips build/visual", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client, calls } = fakeClient(() => {
      throw new Error("must not be called for an empty change set");
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Add a header");
    assert.equal(result.passed, false);
    assert.equal(calls.length, 0);
    assert.ok(result.blockingFailures?.some((f) => f.gate === "change set"));
  });

  test("verifyOnly: an empty change set does NOT block on tier 0 — build/runtime still run against current code", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>hi</body></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    // Nothing changes after the commit — this is the whole point of
    // verifyOnly: check EXISTING behavior, not a diff. The non-verifyOnly
    // test above proves the OLD behavior (instant block, zero calls) for
    // the exact same empty-diff shape; this proves the gate no longer
    // short-circuits before build/runtime get a chance to run.
    const { client } = fakeClient((agent) => {
      // The semantic gate reviews a DIFF's intent and has no "agent" label
      // of its own (recorded as falsy here) — there is no diff in this
      // test, so it must never be reached, verifyOnly or not.
      if (!agent) throw new Error("semantic review needs a diff — must not run with nothing changed");
      return { content: JSON.stringify({ arrived: true, confident: true, waiting: false, reason: "n/a" }) };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("The page renders a greeting", undefined, [], undefined, true);
    assert.ok(
      !result.blockingFailures?.some((f) => f.gate === "change set"),
      "verifyOnly must not block on an empty change set — there is deeper evidence to gather first"
    );
  });

  test("a semantic mismatch fails with concrete evidence and never reaches build/visual", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>old</body></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>new, but no header</body></html>\n");

    const { client, calls } = fakeClient((agent) => {
      if (agent === "verifier-visual") throw new Error("must not reach the visual gate");
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Add a header", status: "missing", evidence: "no <header> present" }],
          concerns: [],
          summary: "not implemented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Add a header");
    assert.equal(result.passed, false);
    assert.equal(calls.length, 1, "only the semantic reviewer should have been called");
    assert.ok(result.blockingFailures?.[0].detail.includes("Add a header"));
    assert.ok(result.blockingFailures?.[0].detail.includes("no <header> present"));
  });

  test("a visual DEFECT is blocking: fails the run and does not surface as a human-sign-off advisory", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>old</body></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "index.html"), "<html><body><h1>new</h1></body></html>\n");

    const { client } = fakeClient((agent) => {
      if (agent === "verifier-visual") {
        return { content: JSON.stringify({ status: "DEFECT", reason: "text overlaps the page edge" }) };
      }
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Add a header", status: "satisfied", evidence: "index.html has <h1>" }],
          concerns: [],
          summary: "implemented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Add a header");
    assert.equal(result.passed, false);
    assert.ok(
      result.blockingFailures?.some((f) => f.tier === "visual"),
      "a visual DEFECT must be a blocking failure, not an advisory"
    );
    assert.ok(
      !(result.visualAdvisories ?? []).some((a) => a.includes("overlaps")),
      "a blocking visual defect must not also appear in visualAdvisories (the human-sign-off path)"
    );
  });

  test("no build/UI surface plus a clean semantic review is a conditional pass (static-only confidence)", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "script.py"), "print('hi')\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "script.py"), "print('hello world')\n");

    const { client } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "Print hello world", status: "satisfied", evidence: "script.py updated" }],
        concerns: [],
        summary: "implemented",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Print hello world instead of hi");
    assert.equal(result.passed, true);
    assert.equal(result.confidence, "static-only");
  });

  // Previously this advisory only ever printed a COUNT ("2 modified, 0
  // added..."), which made "why is QA reviewing more files than the Editor
  // reported touching" undiagnosable from the console alone — exactly the
  // shape of a real report where a leaked pre-existing file (or an Editor
  // that quietly touched something extra) could only be found by going to
  // read the working tree by hand.
  test("the change-set advisory names the actual files touched, not just a count", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "a.py"), "print('a')\n");
    await fs.writeFile(path.join(repo, "b.py"), "print('b')\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "a.py"), "print('a2')\n");
    await fs.writeFile(path.join(repo, "b.py"), "print('b2')\n");

    const { client } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "n/a", status: "satisfied", evidence: "n/a" }],
        concerns: [],
        summary: "n/a",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("some change");
    assert.match(result.report ?? "", /a\.py/);
    assert.match(result.report ?? "", /b\.py/);
  });

  test("a build failure is blocking and skips the visual gate", async () => {
    // Uses Python + tkinter (a GUI framework detectPython actually matches,
    // unlike a plain script) rather than go/npm/etc., since python is the one
    // toolchain reliably present without depending on this machine's PATH.
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "app.py"), "import tkinter\n\ndef main():\n    pass\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    // Break the build: syntax error (unclosed paren).
    await fs.writeFile(path.join(repo, "app.py"), "import tkinter\n\ndef main(\n    pass\n");

    const { client, calls } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "n/a", status: "satisfied", evidence: "n/a" }],
        concerns: [],
        summary: "n/a",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("some change");

    if (!result.report?.includes("python compileall")) {
      // No python on PATH in this environment: the build gate degraded to
      // unavailable, which is a different, already-covered path.
      return;
    }
    assert.equal(result.passed, false);
    assert.ok(result.blockingFailures?.some((f) => f.tier === "build"));
    assert.ok(
      !calls.includes("verifier-visual"),
      "a hard build failure must short-circuit before the visual gate ever runs"
    );
  });

  test("a documentation-only change skips the build gate entirely, even on a real buildable project", async () => {
    // Same tkinter marker as the build-failure test above, so a python
    // project profile IS detected here (the build gate would normally run
    // `python -m compileall` for it) — the point of this test is that it
    // never gets the chance to, because only NOTES.md changed.
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "app.py"), "import tkinter\n\ndef main():\n    pass\n");
    await fs.writeFile(path.join(repo, "NOTES.md"), "# Notes\n\nOriginal line.\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "NOTES.md"), "# Notes\n\nOriginal line.\n\nDocumented the new design.\n");

    const { client, calls } = fakeClient((agent) => {
      if (agent === "verifier-visual") throw new Error("must not reach the visual gate");
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Document the design", status: "satisfied", evidence: "NOTES.md updated" }],
          concerns: [],
          summary: "documented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Document the design in NOTES.md");
    assert.equal(result.passed, true);
    assert.equal(calls.length, 1, "only the semantic reviewer should run — build/visual must be skipped, not just fast");
    assert.ok(!result.report?.includes("python compileall"), "the build gate must never have been invoked");
    assert.ok(result.report?.includes("documentation"), "the report should explain why build/runtime were skipped");
  });

  test("a change touching documentation AND a real source file still gets the full build gate", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "app.py"), "import tkinter\n\ndef main():\n    pass\n");
    await fs.writeFile(path.join(repo, "NOTES.md"), "# Notes\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "NOTES.md"), "# Notes\n\nUpdated.\n");
    // Break the build too, so a wrongly-skipped build gate would be caught
    // by this test still reporting a pass.
    await fs.writeFile(path.join(repo, "app.py"), "import tkinter\n\ndef main(\n    pass\n");

    const { client } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "n/a", status: "satisfied", evidence: "n/a" }],
        concerns: [],
        summary: "n/a",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("some change");
    if (!result.report?.includes("python compileall")) {
      // No python on PATH in this environment — already covered elsewhere.
      return;
    }
    assert.equal(result.passed, false, "touching even one non-documentation file must not skip the build gate");
  });
});

describe("AutonomousVerifier visual gate (UI relevance)", () => {
  test("a diff touching no UI file skips the nav hunt and visual audit, but the launch/crash probe still runs", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>hi</body></html>\n");
    await fs.writeFile(path.join(repo, "script.js"), "console.log('v1');\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    // Only a non-UI file changes this phase — index.html (what makes this a
    // real profile.web project) is untouched.
    await fs.writeFile(path.join(repo, "script.js"), "console.log('logging an event');\n");

    const { client, calls } = fakeClient((agent) => {
      if (agent === "verifier-visual") throw new Error("must not run the visual audit for a non-UI change");
      if (agent === "verifier-nav") throw new Error("must not hunt for a screen for a non-UI change");
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Log an event", status: "satisfied", evidence: "script.js logs it" }],
          concerns: [],
          summary: "implemented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Log an event to the console");
    if (result.confidence === "static-only") {
      // No real browser available in this environment — the runtime/visual
      // gate degraded to unavailable before ever reaching the nav/audit
      // calls this test is about; already covered by other tests.
      return;
    }
    assert.equal(result.passed, true);
    assert.equal(result.confidence, "verified", "the launch/crash probe must still have run for real");
    assert.ok(!calls.includes("verifier-visual"));
    assert.ok(!calls.includes("verifier-nav"));
    assert.ok(
      (result.visualAdvisories ?? []).some((a) => a.includes("no UI-relevant file was touched")),
      "the report should explain why the visual audit was skipped"
    );
  });

  test("a diff touching a UI file still gets the full nav hunt and visual audit", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html><body>old</body></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "index.html"), "<html><body><h1>new</h1></body></html>\n");

    const { client, calls } = fakeClient((agent) => {
      if (agent === "verifier-visual") return { content: JSON.stringify({ status: "PASS", reason: "renders fine" }) };
      if (agent === "verifier-nav") return { content: JSON.stringify({ arrived: true, confident: true, reason: "already there" }) };
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Add a header", status: "satisfied", evidence: "index.html has <h1>" }],
          concerns: [],
          summary: "implemented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Add a header");
    if (result.confidence === "static-only") {
      // No real browser available in this environment — already covered.
      return;
    }
    assert.ok(calls.includes("verifier-visual"), "a UI-touching change must still run the visual audit");
  });
});

describe("AutonomousVerifier runVerification threads stagedDeletions through to the semantic gate", () => {
  // staticQa.ts's own bypassedMissingDetectionPaths/staticQaReview logic is
  // already covered directly in test/staticQa.test.ts — what's new here is
  // the plumbing this session added: runVerification's 3rd argument has to
  // actually reach the ChangeSet the semantic reviewer's prompt is built
  // from, or the whole feature is just as dead as it was before this fix.
  test("a file staged for deletion is described to the reviewer as intentionally retired, not a dropped requirement", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "old.ts"), "export const OLD = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    // Simulates exactly the scenario that motivated this: Editor renamed by
    // creating a new file (the real, reviewable change) and emptying the old
    // one rather than editing it in place, then staged the empty husk for
    // deletion. new.ts must be part of THIS change (not already committed
    // identically before), or there is nothing left for the reviewer once
    // old.ts is correctly excluded — which is a hole in the test, not a bug.
    await fs.writeFile(path.join(repo, "new.ts"), "export const OLD = 1;\n");
    await fs.writeFile(path.join(repo, "old.ts"), "");

    const capturedPrompts: string[] = [];
    const client: any = {
      complete: async (_models: any, messages: any, _opts?: { agent?: string }) => {
        const last = messages[messages.length - 1];
        capturedPrompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
        return {
          content: JSON.stringify({
            requirements: [{ requirement: "Rename OLD to new.ts", status: "satisfied", evidence: "new.ts exists" }],
            concerns: [],
            summary: "implemented",
          }),
        };
      },
    };
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    await verifier.runVerification("Rename OLD to new.ts", undefined, ["old.ts"]);

    const combined = capturedPrompts.join("\n");
    assert.match(
      combined,
      /intentionally retired.*do NOT flag as a missing\/unimplemented requirement.*old\.ts/,
      "the semantic reviewer's prompt must describe the staged file as intentionally retired"
    );
  });
});

describe("AutonomousVerifier runVerification excludes pre-existing dirty files", () => {
  // The bug this fixes: QA's diff was the WHOLE working tree's uncommitted
  // state, with zero knowledge of what the user already had dirty before the
  // phase even started — so a stray unrelated edit sitting in the repo got
  // reviewed (and re-reviewed, every phase) as if it were part of the task.
  test("a file that was already dirty before the phase started never reaches the semantic reviewer's diff", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "notes.txt"), "old notes\n");
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    // The user's own unrelated, pre-existing edit — present BEFORE this
    // phase's verification runs, exactly like snapshotDirtyPaths would have
    // captured it in index.ts before the Editor ever touched anything.
    await fs.writeFile(path.join(repo, "notes.txt"), "the user was already editing this\n");
    // This phase's real work.
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 2;\n");

    const capturedPrompts: string[] = [];
    const { client } = fakeClient((agent) => {
      capturedPrompts.push(agent ?? "unknown");
      return {
        content: JSON.stringify({
          requirements: [{ requirement: "Update a", status: "satisfied", evidence: "app.ts updated" }],
          concerns: [],
          summary: "implemented",
        }),
      };
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Update a", undefined, [], new Set(["notes.txt"]));
    assert.equal(result.passed, true);
    assert.ok(!result.report?.includes("notes.txt"), "the pre-existing dirty file must never appear in the QA report at all");
  });

  test("with no preExistingDirty given, behavior is unchanged — everything uncommitted is still reviewed", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 2;\n");

    const { client } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "Update a", status: "satisfied", evidence: "app.ts updated" }],
        concerns: [],
        summary: "implemented",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runVerification("Update a");
    assert.equal(result.passed, true);
  });
});

describe("AutonomousVerifier build gate sets CI=true for discovered test/lint commands", () => {
  // The bug this fixes: a project's own "test": "vitest" (or any script that
  // defaults to an interactive watch mode when run plainly) hung for the
  // FULL build-gate timeout on every single QA pass, every repair attempt --
  // a bigger, silent contributor to "verifier takes 30 minutes" than
  // anything users actually watch happen (model calls) ever was for a
  // project shaped like a real Vite/React app.
  test("a discovered test script that would hang forever without CI=true completes instead of timing out", async () => {
    const repo = await makeTempRepo();
    // Exits immediately when CI is set (as the build gate must now set it),
    // hangs indefinitely otherwise -- proving the fix, not just that "some
    // test command ran".
    await fs.writeFile(
      path.join(repo, "would-hang-without-ci.js"),
      "if (!process.env.CI) { setInterval(() => {}, 1000); } else { process.exit(0); }\n"
    );
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: "node would-hang-without-ci.js" } }, null, 2)
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(
      { name: "t", version: "1.0.0", scripts: { test: "node would-hang-without-ci.js" }, description: "bump" },
      null,
      2
    ));

    const { client } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "n/a", status: "satisfied", evidence: "n/a" }],
        concerns: [],
        summary: "n/a",
      }),
    }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const start = Date.now();
    const result = await verifier.runVerification("some change");
    const elapsedMs = Date.now() - start;

    if (!result.report?.includes("would-hang-without-ci") && !result.report?.includes("node ")) {
      // No node discoverable as a distinct build-gate command in this
      // environment's resolution path — already covered by other tests'
      // "skip if the toolchain path differs" pattern.
      return;
    }
    assert.ok(
      elapsedMs < 60_000,
      `must complete quickly once CI=true is respected, not hang toward the 300s default timeout (took ${elapsedMs}ms)`
    );
  });
});

// Regression target: a real run on a React Native/Expo project (no separate
// `web` profile, so `npm run typecheck` is discovered EXCLUSIVELY through
// the same generic test-command scan that also finds `npm run test`) had
// its self-check silently reduced to just "expo export" -- an earlier
// filter excluded everything discovered by THAT scan, including the one
// real typecheck command. EDITOR concluded with a clean self-check PASS
// that never actually typechecked anything; QA's real build gate then
// found real errors the self-check never had a chance to see.
describe("looksLikeTestRunner — distinguishes an actual test suite from check/typecheck/lint", () => {
  test("npm run test is a test runner", () => {
    assert.equal(looksLikeTestRunner("npm", ["run", "test"]), true);
  });

  test("npm run typecheck is NOT a test runner -- the exact command the real regression silently dropped", () => {
    assert.equal(looksLikeTestRunner("npm", ["run", "typecheck"]), false);
  });

  test("npm run check and npm run lint are NOT test runners", () => {
    assert.equal(looksLikeTestRunner("npm", ["run", "check"]), false);
    assert.equal(looksLikeTestRunner("npm", ["run", "lint"]), false);
  });

  test("pytest, cargo test, and go test are all test runners", () => {
    assert.equal(looksLikeTestRunner("python", ["-m", "pytest", "-q"]), true);
    assert.equal(looksLikeTestRunner("cargo", ["test"]), true);
    assert.equal(looksLikeTestRunner("go", ["test", "./..."]), true);
  });

  test("cargo build and go build are NOT test runners", () => {
    assert.equal(looksLikeTestRunner("cargo", ["build"]), false);
    assert.equal(looksLikeTestRunner("go", ["build", "./..."]), false);
  });

  test("a non-npm-script command with no args is never mistaken for a test runner", () => {
    assert.equal(looksLikeTestRunner("tsc", ["--noEmit"]), false);
  });

  test("the .cmd/.exe suffix Windows launches npm/cargo/go through doesn't defeat detection", () => {
    assert.equal(looksLikeTestRunner("npm.cmd", ["run", "test"]), true);
    assert.equal(looksLikeTestRunner("cargo.exe", ["test"]), true);
  });
});

describe("AutonomousVerifier.runBuildCheckOnly — backs the run_build_check tool", () => {
  // Built for the real failure that prompted it: REPAIR submitted a patch it
  // could not verify ("no shell tool, node_modules blocked"), and the fix
  // turned out not to resolve what QA had actually reported. This is the
  // standalone, on-demand version of the same build/typecheck check QA's
  // own build gate runs, so REPAIR/EDITOR can confirm a patch compiles
  // BEFORE handing back to QA instead of submitting an unverified guess.

  test("reports PASS with no EvidenceLedger/gate.result side effects when the project's typecheck script succeeds", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { typecheck: "node -e \"process.exit(0)\"" } }, null, 2)
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const gateResults: YimpimEvent[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "gate.result") gateResults.push(e);
    });
    try {
      const result = await verifier.runBuildCheckOnly();
      if (!result.includes("typecheck")) return; // npm not discoverable in this environment — same skip pattern as the CI=true test above.
      assert.match(result, /\[PASS\]/);
      // Standalone means standalone: no gate.result event, unlike a real QA
      // build-gate run — a client expecting those only inside a QA pass
      // must never see one from this self-check.
      assert.equal(gateResults.length, 0, "runBuildCheckOnly must not emit gate.result events");
    } finally {
      unsubscribe();
    }
  });

  // Regression target: every console line this emits was hardcoded to
  // "[REPAIR]" regardless of which agent actually called it -- a real run
  // showed "[EDITOR] Running a build/typecheck self-check..." immediately
  // followed by "[REPAIR] Running build check: ..." for the SAME call,
  // misattributing EDITOR's own self-check to an agent that wasn't running.
  test("attributes its console output to whichever agent actually called it, not hardcoded to REPAIR", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { typecheck: "node -e \"process.exit(0)\"" } }, null, 2)
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const result = await verifier.runBuildCheckOnly("EDITOR");
      if (!result.includes("typecheck")) return; // npm not discoverable — see the test above.
      assert.ok(lines.some((l) => l.startsWith("[EDITOR]")), "must log under the caller's own agent label");
      assert.ok(!lines.some((l) => l.startsWith("[REPAIR]")), "must not default to REPAIR when a real caller was given");
    } finally {
      console.log = originalLog;
    }
  });

  test("defaults to REPAIR's own label when called with no argument (REPAIR's own call site)", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { typecheck: "node -e \"process.exit(0)\"" } }, null, 2)
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const result = await verifier.runBuildCheckOnly();
      if (!result.includes("typecheck")) return;
      assert.ok(lines.some((l) => l.startsWith("[REPAIR]")));
    } finally {
      console.log = originalLog;
    }
  });

  test("reports FAIL with the real compiler output when the project's typecheck script fails", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify(
        { name: "t", version: "1.0.0", scripts: { typecheck: "node -e \"console.error('TS2322: bad type'); process.exit(1)\"" } },
        null,
        2
      )
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runBuildCheckOnly();
    if (!result.includes("typecheck")) return; // npm not discoverable — see above.
    assert.match(result, /\[FAIL\]/);
    assert.match(result, /TS2322/);
  });

  test("reports unavailability, not a crash, when no build/typecheck command applies to this project", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "README.md"), "just docs, no manifest at all\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const result = await verifier.runBuildCheckOnly();
    assert.match(result, /No build/i);
  });

  // Regression for a real run: resolveBuildCommands also appends every
  // discovered test/lint command as "an extra build-tier signal" for QA's
  // OWN real build gate (correct there) -- but this tool's name and
  // description promise build/typecheck ONLY. Without filtering those back
  // out, a slow (or, as happened in practice, apparently-hanging) "npm run
  // test" silently ran FIRST and could eat this call's entire timeout
  // before the actual typecheck command ever got a turn, with no console
  // output explaining why REPAIR appeared to sit idle for minutes on a call
  // named "build check".
  test("runs ONLY the typecheck/build command, never a discovered test script, even when one would hang forever", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "would-hang-if-run.js"),
      "setInterval(() => {}, 1000);\n" // never exits -- proves this never actually ran, not just that it ran fast
    );
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify(
        {
          name: "t",
          version: "1.0.0",
          scripts: {
            typecheck: "node -e \"process.exit(0)\"",
            test: "node would-hang-if-run.js",
          },
        },
        null,
        2
      )
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => ({ content: "{}" }));
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const start = Date.now();
    const result = await verifier.runBuildCheckOnly();
    const elapsedMs = Date.now() - start;

    if (!result.includes("typecheck")) return; // npm not discoverable — see the tests above.
    assert.match(result, /\[PASS\] npm run typecheck/);
    assert.doesNotMatch(result, /test/, "the discovered test script must never appear in the result at all");
    assert.ok(elapsedMs < 30_000, `must complete in seconds, not hang on the test script (took ${elapsedMs}ms)`);
  });
});

describe("AutonomousVerifier QA worker boundary events", () => {
  // runVerification never goes through agentLoop.ts's runToolAgent (it's a
  // separate gate-driven flow), so it never fires the agent.start/agent.end
  // pair every other role gets automatically — these are its own dedicated
  // emit sites, added so a "QA" worker card can open/close on the remote
  // wire (see src/remoteEventTranslator.ts) the same way EDITOR/REPAIR do.
  test("emits agent.start then agent.end for 'QA', even on the fast empty-change-set path", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(path.join(repo, "index.html"), "<html></html>\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "initial"]);

    const { client } = fakeClient(() => {
      throw new Error("must not be called for an empty change set");
    });
    const verifier = new AutonomousVerifier(repo, client, {} as any, config);

    const seen: YimpimEvent[] = [];
    const unsubscribe = events.onEmit((e) => {
      if (e.type === "agent.start" || e.type === "agent.end") seen.push(e);
    });
    try {
      await verifier.runVerification("Add a header");
    } finally {
      unsubscribe();
    }

    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((e) => e.type),
      ["agent.start", "agent.end"]
    );
    assert.equal((seen[0] as any).agent, "QA");
    assert.equal((seen[1] as any).agent, "QA");
    // The change-set gate fails this run, so the QA pass itself "failed" —
    // distinct from the individual gate's own blocking/status fields.
    assert.equal((seen[1] as any).outcome, "failed");
  });
});

describe("extractBuildFailureDetail", () => {
  // Regression for a real incident: a build failure buried under enough
  // gradle task-execution noise that a fixed-size slice (from either end)
  // cut the actual compile errors out entirely, leaving REPAIR with nothing
  // to act on even though the real error was right there in the raw output.
  test("finds the actual compiler errors even behind a wall of preceding noise", () => {
    const noise = Array.from({ length: 300 }, (_, i) => `> Task :app:someNoisyTask${i} UP-TO-DATE`).join("\n");
    const raw = `${noise}
> Task :app:compileDebugKotlin FAILED
29 actionable tasks: 1 executed, 28 up-to-date

e: file:///repo/app/src/main/java/com/example/BreedingScreen.kt:220:17 Smart cast to 'Chicken' is impossible, because 'parentA' is a property that has an open or custom getter.
e: file:///repo/app/src/main/java/com/example/BreedingScreen.kt:220:37 Smart cast to 'Chicken' is impossible, because 'parentB' is a property that has an open or custom getter.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details

BUILD FAILED in 1s`;

    const detail = extractBuildFailureDetail(raw);
    assert.ok(detail.includes("parentA"), "the first compile error must survive");
    assert.ok(detail.includes("parentB"), "the second compile error must survive");
    assert.ok(detail.includes("FAILURE: Build failed"), "the failure summary must survive");
    assert.ok(!detail.includes("someNoisyTask"), "unrelated UP-TO-DATE task noise should not crowd out the errors");
  });

  test("keeps every error line intact whether there are 2 or 60 of them", () => {
    const errors = Array.from(
      { length: 60 },
      (_, i) => `e: file:///repo/Thing${i}.kt:${i}:1 Type mismatch: inferred type is String but Int was expected.`
    );
    const raw = `> Task :app:compileDebugKotlin FAILED\n${errors.join("\n")}\n\nFAILURE: Build failed with an exception.`;

    const detail = extractBuildFailureDetail(raw, 100000); // cap far above what 60 lines need
    for (const line of errors) {
      assert.ok(detail.includes(line), `error line for Thing${errors.indexOf(line)} must survive intact`);
    }
  });

  test("says so explicitly, rather than silently dropping lines, when even the curated errors exceed the cap", () => {
    const errors = Array.from(
      { length: 60 },
      (_, i) => `e: file:///repo/Thing${i}.kt:${i}:1 Type mismatch: inferred type is String but Int was expected.`
    );
    const raw = errors.join("\n");

    const detail = extractBuildFailureDetail(raw, 500); // deliberately too small for all 60
    assert.match(detail, /\d+ more error line\(s\) omitted for length/);
    // Whatever did survive must be whole lines from the input, never a
    // mid-line cut that hands REPAIR a truncated, malformed error.
    const kept = detail.split("\n").filter((l) => l.startsWith("e: "));
    for (const line of kept) assert.ok(errors.includes(line), `kept line must be a complete, unmodified error line`);
  });

  // Regression for a real incident: a base class's constructor call was
  // missing from ~20 subclass declarations in one file, and REPAIR saw 20
  // separately-numbered "This type has a constructor..." lines with no signal
  // they were the same mistake — it ground through 8 read/search rounds
  // trying to diagnose each one before the circuit breaker ended the pass.
  test("clusters the same message repeated 3+ times in the same file into one summary", () => {
    const lines = [259, 262, 276, 279, 282].map(
      (n) => `e: file:///repo/YimpimModels.kt:${n}:5 This type has a constructor, so it must be initialized here.`
    );
    const raw = lines.join("\n");

    const detail = extractBuildFailureDetail(raw);
    assert.match(detail, /REPEATED 5x/);
    assert.match(detail, /LIKELY ONE SHARED ROOT CAUSE/);
    assert.ok(detail.includes(lines[0]), "the first example occurrence must be shown in full");
    assert.ok(detail.includes(lines[1]), "the second example occurrence must be shown in full");
    // All 5 line numbers must still be discoverable, even though not every
    // full line survives verbatim — losing a location entirely would mean
    // REPAIR never even knows that subclass needs fixing.
    for (const n of [259, 262, 276, 279, 282]) assert.ok(detail.includes(String(n)), `line ${n} must be listed`);
  });

  test("does not cluster the same message when it comes from different files", () => {
    const lines = [
      `e: file:///repo/A.kt:10:5 This type has a constructor, so it must be initialized here.`,
      `e: file:///repo/B.kt:20:5 This type has a constructor, so it must be initialized here.`,
      `e: file:///repo/C.kt:30:5 This type has a constructor, so it must be initialized here.`,
    ];
    const detail = extractBuildFailureDetail(lines.join("\n"));
    assert.doesNotMatch(detail, /REPEATED/, "different files failing the same way are separate defects, not one cluster");
    for (const line of lines) assert.ok(detail.includes(line), `${line} must survive intact`);
  });

  test("leaves fewer than 3 repeats alone, uncollapsed", () => {
    const lines = [
      `e: file:///repo/YimpimModels.kt:10:5 This type has a constructor, so it must be initialized here.`,
      `e: file:///repo/YimpimModels.kt:20:5 This type has a constructor, so it must be initialized here.`,
    ];
    const detail = extractBuildFailureDetail(lines.join("\n"));
    assert.doesNotMatch(detail, /REPEATED/);
    for (const line of lines) assert.ok(detail.includes(line));
  });

  test("falls back to the raw tail when nothing recognizable as an error is found", () => {
    const raw = "just some generic tool output\nwith no error markers at all\nnothing to see here";
    assert.equal(extractBuildFailureDetail(raw, 1000), raw);
  });

  // Regression for a real incident: a Node crash's summary line (already
  // matched by the generic `error:` pattern) survived, but every stack frame
  // under it was silently dropped — REPAIR saw "TypeError: ..." with no idea
  // which file or line actually threw it.
  test("keeps stack trace frames, not just the exception summary line", () => {
    const raw = `> some-script
TypeError: Cannot read properties of undefined (reading 'foo')
    at Object.<anonymous> (/repo/src/index.js:42:15)
    at Module._compile (node:internal/modules/cjs/loader:1105:14)
    at Module._extensions..js (node:internal/modules/cjs/loader:1159:10)
npm error code 1`;

    const detail = extractBuildFailureDetail(raw);
    assert.ok(detail.includes("TypeError: Cannot read properties"), "the exception summary must survive");
    assert.ok(detail.includes("/repo/src/index.js:42:15"), "the actual throw site must survive, not just the message");
  });

  // Regression for a real incident: this project's own `npm test` runs
  // Node's built-in test runner, which reports a failure via TAP's
  // "not ok" line plus a "location:" field — neither matched anything
  // before, so a failing test in THIS codebase extracted to nothing useful.
  test("recognizes Node's own test runner (node:test) TAP failure format", () => {
    const raw = `# Subtest: some suite
    # Subtest: a thing that should work
    not ok 1 - a thing that should work
      ---
      duration_ms: 1.234
      location: '/repo/test/foo.test.js:15:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal
      code: 'ERR_ASSERTION'
      stack: |-
        at TestContext.<anonymous> (/repo/test/foo.test.js:16:10)
      ---
    1..1
# fail 1`;

    const detail = extractBuildFailureDetail(raw);
    assert.ok(detail.includes("not ok 1 - a thing that should work"), "the failing test's name must survive");
    assert.ok(detail.includes("/repo/test/foo.test.js:15:3"), "the test's file/line location must survive");
    assert.ok(detail.includes("/repo/test/foo.test.js:16:10"), "the assertion's own stack frame must survive");
  });
});

// Regression for a real incident: a phase whose QA pass had TWO gates
// blocking at once (build/typecheck plus a separate gate) looked, to the
// repair loop, like it only ever saw part of the story -- a plain
// `errorOutput.slice(-maxChars)` on the gates' JOINED text can silently
// drop an earlier gate's errors entirely once the combined length crosses
// the cap, with none of extractBuildFailureDetail's own "N more omitted"
// honesty, since that join+slice happens one layer above it.
describe("buildFailureSnippet", () => {
  test("a single blocking gate under the cap is passed through untouched, just prefixed with its gate name", () => {
    const out = buildFailureSnippet([{ gate: "compile/build", detail: "e: Thing.kt:10:1 Type mismatch." }], "unused", 8000);
    assert.equal(out, "compile/build: e: Thing.kt:10:1 Type mismatch.");
  });

  test("two gates failing together both survive in full when they jointly fit the budget", () => {
    const out = buildFailureSnippet(
      [
        { gate: "compile/build", detail: "e: Thing.kt:10:1 Type mismatch." },
        { gate: "requirement coverage", detail: "UNMET: the toggle must persist across restart." },
      ],
      "unused",
      8000
    );
    assert.ok(out.includes("compile/build: e: Thing.kt:10:1 Type mismatch."), "the first gate's full detail must survive");
    assert.ok(out.includes("requirement coverage: UNMET: the toggle must persist across restart."), "the second gate's full detail must survive");
  });

  test("the bug this fixes: a plain tail-slice on the joined text would drop the FIRST gate almost entirely once two gates' combined length exceeds the cap -- this must not", () => {
    const firstGateDetail = "A".repeat(3000); // fits comfortably inside its own fair half of an 8000 budget
    const secondGateDetail = "B".repeat(6000); // alone exceeds its fair half -- this one must get truncated, not the first
    const out = buildFailureSnippet(
      [
        { gate: "compile/build", detail: firstGateDetail },
        { gate: "requirement coverage", detail: secondGateDetail },
      ],
      "unused",
      8000
    );
    assert.ok(
      out.includes(`compile/build: ${firstGateDetail}`),
      "the first gate fits its own fair share and must survive in full -- a blind tail-slice on the joined ~9000-char string would have cut most or all of it instead"
    );
    assert.ok(out.includes("requirement coverage:"), "the second gate must still be represented too");
    assert.match(out, /more character\(s\) omitted for length/, "the second gate's own overflow must be noted explicitly, not silently cut");
  });

  test("truncates a gate that alone exceeds its fair share, with an explicit omission notice -- never a silent cut", () => {
    const hugeDetail = "X".repeat(20000);
    const out = buildFailureSnippet([{ gate: "compile/build", detail: hugeDetail }], "unused", 8000);
    assert.match(out, /more character\(s\) omitted for length/);
    assert.ok(out.length < hugeDetail.length, "must actually be shorter than the untruncated detail");
  });

  test("every gate still gets SOME space even with many gates failing at once", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({ gate: `gate-${i}`, detail: "Y".repeat(2000) }));
    const out = buildFailureSnippet(failures, "unused", 8000);
    for (let i = 0; i < 10; i++) {
      assert.ok(out.includes(`gate-${i}:`), `gate-${i} must be represented, not crowded out entirely by the others`);
    }
  });

  test("falls back to the legacy tail-slice of errorOutput when there are no structured blockingFailures at all", () => {
    const out = buildFailureSnippet(undefined, "Z".repeat(10000), 8000);
    assert.equal(out.length, 8000);
    assert.ok(out.endsWith("Z"));
  });

  test("falls back to a plain message when there is neither blockingFailures nor errorOutput", () => {
    assert.equal(buildFailureSnippet(undefined, "", 8000), "Unknown verification failure");
  });
});

describe("extractReferencedFilePaths", () => {
  test("pulls the Kotlin/gradle 'e: file:///abs/path.kt:LINE:COL' path", () => {
    const detail = "e: file:///repo/app/src/main/java/com/example/BreedingScreen.kt:220:17 Smart cast to 'Chicken' is impossible.";
    const paths = extractReferencedFilePaths(detail);
    assert.ok(
      paths.some((p) => p.endsWith("app/src/main/java/com/example/BreedingScreen.kt")),
      `expected a BreedingScreen.kt path, got ${JSON.stringify(paths)}`
    );
  });

  test("pulls a tsc 'path.ts:LINE:COL' path", () => {
    const detail = "src/remoteEventTranslator.ts:34:5 - error TS2304: Cannot find name 'YimpimEvent'.";
    const paths = extractReferencedFilePaths(detail);
    assert.ok(paths.includes("src/remoteEventTranslator.ts"), `expected src/remoteEventTranslator.ts, got ${JSON.stringify(paths)}`);
  });

  test("pulls a tsc 'path.ts(LINE,COL):' path", () => {
    const detail = "src/agentTools.ts(1163,5): error TS2554: Expected 5 arguments, but got 4.";
    const paths = extractReferencedFilePaths(detail);
    assert.ok(paths.includes("src/agentTools.ts"), `expected src/agentTools.ts, got ${JSON.stringify(paths)}`);
  });

  test("pulls a Python 'File \"path\", line N' path", () => {
    const detail = 'Traceback (most recent call last):\n  File "app/services/auth.py", line 42, in login\n    raise ValueError("bad token")';
    const paths = extractReferencedFilePaths(detail);
    assert.ok(paths.includes("app/services/auth.py"), `expected app/services/auth.py, got ${JSON.stringify(paths)}`);
  });

  test("returns an empty array for a detail string with no recognizable path", () => {
    assert.deepEqual(extractReferencedFilePaths("BUILD FAILED in 1s"), []);
  });

  test("deduplicates the same path referenced on multiple error lines", () => {
    const detail = [
      "src/foo.ts:10:1 - error TS2304: Cannot find name 'Bar'.",
      "src/foo.ts:20:1 - error TS2304: Cannot find name 'Bar'.",
    ].join("\n");
    assert.deepEqual(extractReferencedFilePaths(detail), ["src/foo.ts"]);
  });
});

describe("looksLikeMissingDependency", () => {
  test("flags a Kotlin 'unresolved reference' error", () => {
    assert.ok(looksLikeMissingDependency("e: file:///repo/YimpimModels.kt:12:5: error: unresolved reference: Serializable"));
  });

  test("flags a Java/Kotlin 'cannot find symbol' error", () => {
    assert.ok(looksLikeMissingDependency("error: cannot find symbol\n  symbol: class JsonContentPolymorphicSerializer"));
  });

  test("flags a Node 'cannot find module' error", () => {
    assert.ok(looksLikeMissingDependency("Error: Cannot find module 'kotlinx-serialization'"));
  });

  test("flags a Python 'No module named' error", () => {
    assert.ok(looksLikeMissingDependency("ModuleNotFoundError: No module named 'requests'"));
  });

  test("flags a TypeScript 'has no exported member' error", () => {
    assert.ok(looksLikeMissingDependency("src/index.ts:3:10 - error TS2305: Module '\"./protocol.js\"' has no exported member 'generateSessionKey'."));
  });

  test("does not flag an ordinary type-mismatch build failure", () => {
    assert.equal(looksLikeMissingDependency("error TS2322: Type 'string' is not assignable to type 'number'."), false);
  });
});

describe("dependencyManifestHint", () => {
  test("points at gradle files for an android stack", () => {
    const hint = dependencyManifestHint(["android"]);
    assert.ok(hint?.includes("build.gradle"));
    assert.ok(hint?.includes("libs.versions.toml"));
  });

  test("points at package.json for a web stack", () => {
    assert.equal(dependencyManifestHint(["web"]), "package.json");
  });

  test("returns undefined for a stack with no known manifest file", () => {
    assert.equal(dependencyManifestHint(["cli"]), undefined);
  });

  test("returns undefined when no stacks are given", () => {
    assert.equal(dependencyManifestHint(undefined), undefined);
  });
});

describe("dependencyManifestCandidatePaths", () => {
  // Regression target: this feeds a bounded, read-only diagnosis pass
  // (REPAIR_PLANNER) an explicit allowlist — a path that doesn't actually
  // exist on disk must never end up on that list, since the pass has no
  // search tool to fall back on if it guesses wrong.
  test("only returns manifest paths that actually exist on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-manifest-candidates-"));
    try {
      await fs.writeFile(path.join(dir, "build.gradle.kts"), "// root gradle file");
      // app/build.gradle (not .kts) deliberately absent, to prove it's not assumed.

      const found = dependencyManifestCandidatePaths(dir, ["android"]);
      assert.deepEqual(found, ["build.gradle.kts"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns an empty array when none of the stack's candidate files exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-manifest-candidates-"));
    try {
      assert.deepEqual(dependencyManifestCandidatePaths(dir, ["android"]), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("checks multiple candidate files for a stack and returns every match", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-manifest-candidates-"));
    try {
      await fs.writeFile(path.join(dir, "requirements.txt"), "requests==2.31.0");
      await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = 'x'");

      const found = dependencyManifestCandidatePaths(dir, ["python-web"]);
      assert.deepEqual(new Set(found), new Set(["requirements.txt", "pyproject.toml"]));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns an empty array for a stack with no known candidates or no stacks at all", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-manifest-candidates-"));
    try {
      assert.deepEqual(dependencyManifestCandidatePaths(dir, ["cli"]), []);
      assert.deepEqual(dependencyManifestCandidatePaths(dir, undefined), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stableGoalKey", () => {
  // Regression test for a real bug: NavFlowReplayer keys its learned-path
  // cache by goal text, but index.ts enriches that goal with the Editor's
  // own howToVerify notes before verification runs — and that text can
  // differ between the initial pass and a later repair pass for the exact
  // same phase, which silently broke the flow cache's exact-match lookup.
  const base = "Overall objective: add a garage screen\n\nPhase under test: 1/1 Garage screen\nAdd it";

  test("returns the goal unchanged when it was never enriched", () => {
    assert.equal(stableGoalKey(base), base);
  });

  test("strips the howToVerify section regardless of what it says", () => {
    const enrichedAttempt1 = `${base}${HOW_TO_VERIFY_GOAL_MARKER}Tap Garage on the main menu.`;
    const enrichedAttempt2 = `${base}${HOW_TO_VERIFY_GOAL_MARKER}Open the menu, then tap the Garage icon.`;

    // Different howToVerify wording must still resolve to the SAME key —
    // that's the entire point of stripping it.
    assert.equal(stableGoalKey(enrichedAttempt1), base);
    assert.equal(stableGoalKey(enrichedAttempt2), base);
    assert.equal(stableGoalKey(enrichedAttempt1), stableGoalKey(enrichedAttempt2));
  });
});

describe("loadNavMapText", () => {
  const tempDirs: string[] = [];
  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });
  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-navmaptext-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns undefined when .agent/nav_map.json does not exist", async () => {
    const dir = await makeTempDir();
    assert.equal(loadNavMapText(dir), undefined);
  });

  test("returns undefined for an empty map ({}) rather than an empty-looking string", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), "{}");
    assert.equal(loadNavMapText(dir), undefined);
  });

  test("returns undefined for malformed JSON instead of throwing", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".agent"));
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), "{ not valid json");
    assert.doesNotThrow(() => loadNavMapText(dir));
    assert.equal(loadNavMapText(dir), undefined);
  });

  test("returns the raw text when the map has at least one screen", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".agent"));
    const content = JSON.stringify({ RaceScreen: { file: "Race.kt", controls: [] } });
    await fs.writeFile(path.join(dir, ".agent", "nav_map.json"), content);
    assert.equal(loadNavMapText(dir), content);
  });
});

describe("AutonomousVerifier visual model routing (verifierVision)", () => {
  // The verifier has three distinct model call sites and they must NOT all
  // follow the same chain: the two that carry a screenshot (the navigation
  // decision and the visual audit) belong on models.verifierVision when the
  // user configured a vision-capable chain, while the text-only semantic
  // review of the diff has no image to reason about and must stay on the
  // cheaper models.verifier chain no matter what. An agent-label-only
  // assertion cannot tell those apart, so these tests assert the actual
  // model array handed to client.complete.

  const VERIFIER_CHAIN = ["base/verifier"];
  const VISION_CHAIN = ["vision/primary", "vision/backup"];

  // Enough bytes for the base64 inline-image path; the fake client never
  // decodes it.
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  async function makeScreenshot(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-verifier-visual-"));
    tempDirs.push(dir);
    const file = path.join(dir, "shot.png");
    await fs.writeFile(file, PNG);
    return file;
  }

  /** A real (not mocked) replayer over a repo with no learned flow — it just
   *  has nothing to replay, which is the state every fresh navigation starts
   *  in and is what lets the vision call actually happen. */
  function freshReplayer(screenshotFile: string): NavFlowReplayer {
    return new NavFlowReplayer(path.dirname(screenshotFile), "android", "Show the garage screen");
  }

  function decideNext(verifier: AutonomousVerifier, screenshotFile: string) {
    return (verifier as any).decideNextNavStep(
      { kind: "an Android app", elements: "tappable", action: "tap" },
      "Show the garage screen",
      screenshotFile,
      [],
      freshReplayer(screenshotFile),
      () => {}
    );
  }

  function audit(verifier: AutonomousVerifier, screenshotFile: string) {
    return (verifier as any).auditScreenshots("Show the garage screen", [screenshotFile], "Android emulator");
  }

  /** Drives the text-only semantic gate (staticQaReview -> askJson) with a
   *  non-empty change set so it actually reaches the model. */
  async function runSemanticGate(verifier: AutonomousVerifier): Promise<void> {
    const change = {
      diff: "--- a/app.kt\n+++ b/app.kt\n+val garageVisible = true\n",
      modified: ["app.kt"],
      added: [],
      deleted: [],
      renamed: [],
      isEmpty: false,
    };
    await (verifier as any).semanticGate("Show the garage screen", change, new EvidenceLedger());
  }

  const baseConfig = ConfigSchema.parse({ models: { verifier: VERIFIER_CHAIN, planner: ["base/planner"] } });

  test("navigation and visual audit use models.verifierVision when it is configured", async () => {
    const config: AgentConfig = ConfigSchema.parse({
      models: { verifier: VERIFIER_CHAIN, verifierVision: VISION_CHAIN },
    });
    const screenshot = await makeScreenshot();
    const { client, models } = fakeClient((agent) =>
      agent === "verifier-visual"
        ? { content: JSON.stringify({ status: "PASS", reason: "rendered as asked" }) }
        : { content: JSON.stringify({ arrived: false, confident: true, waiting: false, tapXPercent: 50, tapYPercent: 90, reason: "tap Garage" }) }
    );
    const verifier = new AutonomousVerifier(path.dirname(screenshot), client, {} as any, config);

    await decideNext(verifier, screenshot);
    await audit(verifier, screenshot);

    assert.equal(models.length, 2);
    assert.deepEqual(models[0], VISION_CHAIN, "the navigation decision must use the verifierVision chain");
    assert.deepEqual(models[1], VISION_CHAIN, "the visual audit must use the verifierVision chain");
  });

  test("navigation and visual audit fall back to models.verifier when verifierVision is omitted", async () => {
    const screenshot = await makeScreenshot();
    const { client, models } = fakeClient((agent) =>
      agent === "verifier-visual"
        ? { content: JSON.stringify({ status: "PASS", reason: "rendered as asked" }) }
        : { content: JSON.stringify({ arrived: false, confident: true, waiting: false, tapXPercent: 50, tapYPercent: 90, reason: "tap Garage" }) }
    );
    const verifier = new AutonomousVerifier(path.dirname(screenshot), client, {} as any, baseConfig);

    await decideNext(verifier, screenshot);
    await audit(verifier, screenshot);

    assert.equal(models.length, 2);
    assert.deepEqual(models[0], VERIFIER_CHAIN);
    assert.deepEqual(models[1], VERIFIER_CHAIN);
  });

  test("navigation and visual audit fall back to models.verifier when verifierVision is an empty list", async () => {
    // Built by hand rather than through ConfigSchema, which rejects an empty
    // array (min(1)) — a config file can still produce this shape via a
    // programmatic/migrated config, so the routing guard is what has to
    // handle it, not the schema.
    const config: AgentConfig = { ...baseConfig, models: { ...baseConfig.models, verifierVision: [] } };
    const screenshot = await makeScreenshot();
    const { client, models } = fakeClient((agent) =>
      agent === "verifier-visual"
        ? { content: JSON.stringify({ status: "INCONCLUSIVE", reason: "still loading" }) }
        : { content: JSON.stringify({ arrived: false, confident: true, waiting: false, tapXPercent: 10, tapYPercent: 10, reason: "tap" }) }
    );
    const verifier = new AutonomousVerifier(path.dirname(screenshot), client, {} as any, config);

    await decideNext(verifier, screenshot);
    await audit(verifier, screenshot);

    assert.equal(models.length, 2);
    assert.deepEqual(models[0], VERIFIER_CHAIN, "an empty verifierVision list must not be used as a model chain");
    assert.deepEqual(models[1], VERIFIER_CHAIN);
  });

  test("the semantic gate keeps using models.verifier regardless of verifierVision", async () => {
    const config: AgentConfig = ConfigSchema.parse({
      models: { verifier: VERIFIER_CHAIN, verifierVision: VISION_CHAIN },
    });
    const { client, models, calls } = fakeClient(() => ({
      content: JSON.stringify({
        requirements: [{ requirement: "Show the garage screen", status: "satisfied", evidence: "app.kt sets garageVisible" }],
        concerns: [],
        summary: "implemented",
      }),
    }));
    const verifier = new AutonomousVerifier(await makeScreenshot(), client, {} as any, config);

    await runSemanticGate(verifier);

    assert.equal(models.length, 1);
    assert.equal(calls[0], "VERIFIER", "the semantic review is a text-only call");
    assert.deepEqual(
      models[0],
      VERIFIER_CHAIN,
      "a text-only semantic review must never be routed to the (more expensive) verifierVision chain"
    );
  });
});

// Actually spinning up `npx expo start --web` / `npx expo export` needs
// network access to fetch Expo if it isn't already installed, so (like
// probeWeb's own dev-server path) it isn't exercised end-to-end here — this
// covers the part of the Expo route that's pure and fast to test: whether a
// changed file is correctly classified as UI-relevant, which is what decides
// whether the (expensive) visual probe runs at all for a given phase.
describe("changeTouchesUiSurface for Expo/React Native projects", () => {
  const emptyChange: ChangeSet = {
    diff: "",
    modified: [],
    added: [],
    deleted: [],
    renamed: [],
    isEmpty: false,
  };

  const expoProfile: ProjectProfile = {
    stacks: ["react-native"],
    primary: "react-native",
    reactNative: { hasIOS: false, hasAndroid: false, isExpo: true, packageManager: "npm", candidateUrls: [] },
    testCommands: [],
    notes: [],
  };

  test("a screen component change is UI-relevant", () => {
    const change: ChangeSet = { ...emptyChange, modified: ["app/(tabs)/index.tsx"] };
    assert.equal(changeTouchesUiSurface(change, expoProfile), true);
  });

  test("a components/ directory change is UI-relevant", () => {
    const change: ChangeSet = { ...emptyChange, added: ["components/Header.tsx"] };
    assert.equal(changeTouchesUiSurface(change, expoProfile), true);
  });

  test("a change confined to a data/backend file is not UI-relevant", () => {
    const change: ChangeSet = { ...emptyChange, modified: ["lib/api.ts", "hooks/useAuth.ts"] };
    assert.equal(changeTouchesUiSurface(change, expoProfile), false);
  });

  test("a plain react-native (non-Expo) project is not classified at all, so it defaults to UI-relevant", () => {
    const rnProfile: ProjectProfile = {
      ...expoProfile,
      reactNative: { hasIOS: false, hasAndroid: true, isExpo: false, candidateUrls: [] },
    };
    const change: ChangeSet = { ...emptyChange, modified: ["lib/api.ts"] };
    // Non-Expo react-native has no visual probe to gate at all (no browser to
    // point at a native app) -- this just documents today's behavior rather
    // than asserting a UI-relevance policy that doesn't apply to it.
    assert.equal(changeTouchesUiSurface(change, rnProfile), true);
  });

  // Regression for a real incident: a REPAIR pass that only fixed a missing
  // type import (TS2552: Cannot find name 'X') in a .tsx screen file still
  // triggered a full visual probe + vision audit, purely because the file's
  // PATH matched a UI extension/directory -- the diff inside it was a single
  // import line, which cannot possibly affect anything a screenshot shows.
  describe("import/type-only changes to a UI-flavored path are not UI-relevant", () => {
    test("a single added import line in app/dashboard.tsx is not UI-relevant", () => {
      const diff = `diff --git a/app/dashboard.tsx b/app/dashboard.tsx
index abc123..def456 100644
--- a/app/dashboard.tsx
+++ b/app/dashboard.tsx
@@ -1,4 +1,5 @@
 import React from "react";
+import { PhaseContainerStatus } from "../types/phase";
 import { View } from "react-native";
`;
      const change: ChangeSet = { ...emptyChange, diff, modified: ["app/dashboard.tsx"] };
      assert.equal(changeTouchesUiSurface(change, expoProfile), false);
    });

    test("a single-line type alias addition is not UI-relevant", () => {
      const diff = `diff --git a/app/dashboard.tsx b/app/dashboard.tsx
index abc123..def456 100644
--- a/app/dashboard.tsx
+++ b/app/dashboard.tsx
@@ -1,2 +1,3 @@
 import React from "react";
+export type PhaseContainerStatus = "idle" | "running" | "done";
 import { View } from "react-native";
`;
      const change: ChangeSet = { ...emptyChange, diff, modified: ["app/dashboard.tsx"] };
      assert.equal(changeTouchesUiSurface(change, expoProfile), false);
    });

    test("still UI-relevant when the SAME file's diff also has a real content change alongside the import", () => {
      const diff = `diff --git a/app/dashboard.tsx b/app/dashboard.tsx
index abc123..def456 100644
--- a/app/dashboard.tsx
+++ b/app/dashboard.tsx
@@ -1,4 +1,6 @@
 import React from "react";
+import { PhaseContainerStatus } from "../types/phase";
 import { View } from "react-native";
+
+export const Banner = () => <View style={{ backgroundColor: "red" }} />;
`;
      const change: ChangeSet = { ...emptyChange, diff, modified: ["app/dashboard.tsx"] };
      assert.equal(changeTouchesUiSurface(change, expoProfile), true);
    });

    test("still UI-relevant when a DIFFERENT UI-flavored file in the same change has a real content change", () => {
      const diff = `diff --git a/app/dashboard.tsx b/app/dashboard.tsx
index abc123..def456 100644
--- a/app/dashboard.tsx
+++ b/app/dashboard.tsx
@@ -1,2 +1,3 @@
 import React from "react";
+import { PhaseContainerStatus } from "../types/phase";
 import { View } from "react-native";
diff --git a/components/Header.tsx b/components/Header.tsx
index 111..222 100644
--- a/components/Header.tsx
+++ b/components/Header.tsx
@@ -1,2 +1,3 @@
 import React from "react";
+export const Title = () => <Text>Hi</Text>;
 import { View } from "react-native";
`;
      const change: ChangeSet = { ...emptyChange, diff, modified: ["app/dashboard.tsx", "components/Header.tsx"] };
      assert.equal(changeTouchesUiSurface(change, expoProfile), true);
    });

    test("falls back to UI-relevant (the safe direction) when the file's own diff segment can't be isolated at all", () => {
      // No diff content at all for this path -- changedLinesForFile can't
      // find a segment, so this must NOT be assumed import-only.
      const change: ChangeSet = { ...emptyChange, diff: "", modified: ["app/dashboard.tsx"] };
      assert.equal(changeTouchesUiSurface(change, expoProfile), true);
    });
  });
});
