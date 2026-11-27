/**
 * The Editor keeps its tests current. Before an Editor (or Repair) is allowed to conclude a ticket, the tests its change can reach are run; a test its change
 * made stale is sent back to it to fix (in the test, if the ticket is what changed the behaviour, or in its code), once for each distinct set of failures; what it
 * still cannot fix goes to the heal before QA; and it may never "fix" a test by deleting, skipping or thinning it.
 *
 * Why here: the verifier runs the same tests at QA time, after the Editor is done, and one test rotting per ticket is how a pile of 28 builds up.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { OpenRouterClient } from "./openrouter.js";
import type { AgentConfig } from "./config.js";
import { isTestPath } from "./focusTests.js";
import { isEvidenceNoise } from "./roadmap.js";
import { failingNames } from "./healAuthority.js";
import { failingTestFiles } from "./testRun.js";
import { failureText, candidateProblem, healTests, type HealCall, type HealResult } from "./testHeal.js";
import { HEAL_REPLY_STRUCTURED } from "./healSchema.js";
import { failsBefore } from "./testGraph.js";
import { selectForChange } from "./testSelection.js";
import { createRunTestSession, type RunTestSession } from "./sandboxRunTest.js";
import { runSuiteLogged } from "./testLog.js";
import type { SuiteRun } from "./testRun.js";
import { sandboxFor } from "./healSandbox.js";
import type { ReviewRequest, ReviewOutcome } from "./commandReview.js";

export type SweepOutcome = { kind: "clean"; note?: string } | { kind: "bounce"; message: string } | { kind: "handed"; note: string };

export interface SweepDeps {
  repoRoot: string;
  /** The files this phase has written so far. */
  written: () => string[];
  /** Screens the code the agent changed before a test run (the panel); without one, anything the screen flags is refused. */
  review?: (req: ReviewRequest) => Promise<ReviewOutcome>;
  /** What the heal does with the test files the Editor could not fix (the same construction the verifier uses). Unset: they go to QA as they are. */
  heal?: (files: string[]) => Promise<{ results: HealResult[] }>;
  /** Replaces the project's whole-file runner (tests). */
  run?: (root: string, files: string[]) => Promise<SuiteRun>;
  /** Replaces running one test file through the gate (tests). */
  runFile?: (file: string) => Promise<{ refused: boolean; text: string; output: string }>;
  select?: (root: string, touched: string[]) => { selected: string[] };
  failsBefore?: (root: string, files: string[]) => Promise<Set<string> | undefined>;
  log?: (line: string) => void;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A test run's output says something failed (Jest, Vitest and the runners that print the same). */
export function outputFailed(output: string): boolean {
  const text = output.replace(ANSI, "");
  return failingNames(text).length > 0 || /^\s*Tests:.*\bfailed\b/m.test(text) || /^\s*Test Suites:.*\bfailed\b/m.test(text) || /^\s*FAIL\s/m.test(text);
}

/** The file as it was at the last commit, or undefined when it is new. */
function committed(repoRoot: string, rel: string): string | undefined {
  try {
    return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return undefined;
  }
}

export class EditorSweep {
  private session?: RunTestSession;
  private baseline = new Map<string, boolean>();
  private bounced = new Set<string>();
  private healed = false;

  constructor(private deps: SweepDeps) {}

  /** A new phase: nothing from the last one carries over. The tree as it is now counts as already run (the Editor has not written to it yet), so only what it WRITES is screened. */
  reset(): void {
    this.baseline.clear();
    this.bounced.clear();
    this.healed = false;
    this.session = undefined;
    if (this.deps.runFile) return;
    try {
      this.session = createRunTestSession({
        root: this.deps.repoRoot,
        gate: { review: this.deps.review },
        fallbackRun: this.deps.run ?? runSuiteLogged,
        preapproveCurrent: true,
        purpose: "editor: run the tests its change reaches",
      });
    } catch {
      this.session = undefined;
    }
  }

  private async runOne(file: string): Promise<{ refused: boolean; text: string; output: string }> {
    if (this.deps.runFile) return this.deps.runFile(file);
    if (!this.session) return { refused: true, text: "the tests could not be started here", output: "" };
    return this.session.run({ file });
  }

  /** The tests this phase's change can reach, or [] when it wrote no source file (a phase that changed only tests, or nothing, has no sweep). */
  private selected(): string[] {
    const written = this.deps.written().map(norm).filter((p) => !isEvidenceNoise(p));
    if (!written.some((p) => !isTestPath(p))) return [];
    try {
      return (this.deps.select ?? ((r, t) => selectForChange(r, t).sel))(this.deps.repoRoot, written).selected;
    } catch {
      return [];
    }
  }

  /** Tracks the most recent clean sweep so QA's selectedTestGate can avoid re-running identical tests when zero edits occurred since. */
  private lastClean?: { files: string[]; output: string; epoch?: number };
  private writeEpochProvider?: () => number;

  public setWriteEpochProvider(fn: () => number): void {
    this.writeEpochProvider = fn;
  }

  public lastCleanSweep(): { files: string[]; output: string; epoch?: number } | undefined {
    return this.lastClean;
  }

  private async execute(files: string[]): Promise<{ failing: string[]; output: string; refused?: string }> {
    // Batch all affected test files into ONE test-runner invocation when running through RunTestSession.
    if (files.length > 1 && !this.deps.runFile && this.session?.runMany) {
      const r = await this.session.runMany(files);
      if (r.refused) return { failing: [], output: r.output, refused: r.text };
      if (!outputFailed(r.output)) return { failing: [], output: r.output };
      const parsed = failingTestFiles(r.output);
      const fileSet = new Set(files.map(norm));
      const matched = parsed.map(norm).filter((f) => fileSet.has(f));
      return { failing: matched.length > 0 ? matched : [...files], output: r.output };
    }

    let output = "";
    const failing: string[] = [];
    for (const f of files) {
      const r = await this.runOne(f);
      if (r.refused) return { failing, output, refused: r.text };
      output += `\n${r.output}`;
      if (outputFailed(r.output)) failing.push(f);
    }
    return { failing, output };
  }

  /** Of the failing files, the ones that were NOT already failing before this phase (computed once per file per phase). */
  private async causedBy(failing: string[]): Promise<string[]> {
    const unknown = failing.filter((f) => !this.baseline.has(f));
    if (unknown.length > 0) {
      const before = await (this.deps.failsBefore ?? ((root, files) => failsBefore({ repoRoot: root, files })))(this.deps.repoRoot, unknown);
      for (const f of unknown) this.baseline.set(f, before ? before.has(f) : false);
    }
    return failing.filter((f) => !this.baseline.get(f));
  }

  /** What the Editor did to the tests it changed: fewer tests, thinner assertions, new .skip or .only. */
  private integrityProblems(): string[] {
    const out: string[] = [];
    for (const rel of this.deps.written().map(norm).filter(isTestPath)) {
      const before = committed(this.deps.repoRoot, rel);
      if (before === undefined) continue;
      let after: string;
      try {
        after = fs.readFileSync(path.join(this.deps.repoRoot, rel), "utf8");
      } catch {
        out.push(`${rel}: the file is gone (a test file may be updated, never deleted)`);
        continue;
      }
      const problem = candidateProblem(before, after);
      if (problem) out.push(`${rel}: ${problem}`);
    }
    return out;
  }

  /** Called when the Editor says it is finished. */
  async check(): Promise<SweepOutcome> {
    const files = this.selected();
    if (files.length === 0) return { kind: "clean" };

    const problems = this.integrityProblems();
    if (problems.length > 0) {
      const key = `i:${problems.join("|")}`;
      if (!this.bounced.has(key)) {
        this.bounced.add(key);
        return {
          kind: "bounce",
          message:
            `a test file you changed is not acceptable: ${problems.join("; ")}. A test may be updated to match what the ticket changed (change the expected value or selector), ` +
            `never removed, skipped, narrowed with .only, or given weaker assertions. Fix that, then conclude again.`,
        };
      }
    }

    const ran = await this.execute(files);
    if (ran.refused) return { kind: "bounce", message: `the tests could not be run: ${ran.refused}` };
    if (ran.failing.length === 0) {
      this.lastClean = { files: files.map(norm), output: ran.output, epoch: this.writeEpochProvider?.() };
      return { kind: "clean", note: `${files.length} affected test file${files.length === 1 ? "" : "s"} pass` };
    }
    this.lastClean = undefined;

    const caused = await this.causedBy(ran.failing);
    if (caused.length === 0) return { kind: "clean", note: `${files.length} affected test file${files.length === 1 ? "" : "s"} run; the ones failing were already failing before this phase` };

    const names = failingNames(ran.output);
    const key = `f:${[...caused].sort().join("|")}:${[...names].sort().join("|")}`;
    if (!this.bounced.has(key)) {
      this.bounced.add(key);
      return { kind: "bounce", message: this.bounceText(caused, names, ran.output) };
    }

    // The same tests are still red after it tried: they do not go to QA red. The heal gets them first.
    if (this.deps.heal && !this.healed) {
      this.healed = true;
      this.deps.log?.(`the Editor could not bring ${caused.join(", ")} up to date: the heal is asked before QA`);
      try {
        const report = await this.deps.heal(caused);
        const left = report.results.filter((r) => r.status !== "healed" && r.status !== "already-green");
        if (left.length === 0) return { kind: "clean", note: `${caused.length} test file${caused.length === 1 ? " was" : "s were"} brought up to date by the heal` };
        return { kind: "handed", note: `${left.length} test file${left.length === 1 ? " is" : "s are"} still red after the heal and go to QA as they are: ${left.map((r) => `${r.file} (${r.status})`).join(", ")}` };
      } catch (e: any) {
        return { kind: "handed", note: `the heal could not run (${String(e?.message ?? e).slice(0, 80)}); ${caused.join(", ")} go to QA as they are` };
      }
    }
    return { kind: "handed", note: `${caused.join(", ")} still fail and go to QA as they are` };
  }

  private bounceText(caused: string[], names: string[], output: string): string {
    const inFiles = names.slice(0, 10);
    const digest = failureText(output, this.deps.repoRoot, caused[0]).slice(0, 3000);
    return (
      `your change breaks ${caused.length} test file${caused.length === 1 ? "" : "s"} that passed before it: ${caused.join(", ")}` +
      `${inFiles.length > 0 ? ` (failing: ${inFiles.join(" | ")}${names.length > inFiles.length ? ` … and ${names.length - inFiles.length} more` : ""})` : ""}.\n${digest}\n` +
      `Fix what your change made out of date: if a test checks the old behaviour on purpose and your change is what the ticket asks for, update the test (change the expected value ` +
      `or selector; never delete or weaken an assertion); if the test is right, fix your code. Run run_affected_tests to check, then conclude again.`
    );
  }

  /** The run_affected_tests tool: the same selection, run now, with the digest. */
  async runNow(): Promise<string> {
    const files = this.selected();
    if (files.length === 0) return "No test reaches the files you have changed so far (or you have not changed any source file yet).";
    const ran = await this.execute(files);
    if (ran.refused) return `The tests were not run: ${ran.refused}`;
    if (ran.failing.length === 0) return `${files.length} affected test file${files.length === 1 ? "" : "s"} pass: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}`;
    const caused = await this.causedBy(ran.failing);
    const names = failingNames(ran.output);
    const already = ran.failing.filter((f) => !caused.includes(f));
    return (
      `${ran.failing.length} of ${files.length} affected test file${files.length === 1 ? "" : "s"} ${ran.failing.length === 1 ? "fails" : "fail"}${caused.length > 0 ? ` (${caused.length} because of your change)` : ""}` +
      `${already.length > 0 ? `; ${already.join(", ")} already failed before this phase and are not yours to fix` : ""}.\n` +
      `${names.length > 0 ? `Failing: ${names.slice(0, 10).join(" | ")}\n` : ""}${failureText(ran.output, this.deps.repoRoot, ran.failing[0]).slice(0, 3000)}`
    );
  }
}

/** The heal the sweep hands leftovers to: the same construction the verifier's test gate uses (the repair models, and the sandbox when there is a stronger one). */
export function healerFor(client: OpenRouterClient, config: AgentConfig, repoRoot: string, log?: (l: string) => void): (files: string[]) => Promise<{ results: HealResult[] }> {
  return async (files) => {
    const models = config.models.repair ?? config.models.editor;
    const call: HealCall = async (messages) => {
      const m: any = await client.complete(models, messages, { temperature: 0, agent: "REPAIR", jsonMode: true });
      return m?.content ?? m?.choices?.[0]?.message?.content ?? "";
    };
    const sandbox = sandboxFor({ client, config, repairModels: models, log });
    const escalate: HealCall | undefined =
      !sandbox && models.length > 1
        ? async (messages) => {
            const m: any = await client.complete(models.slice(1), messages, { temperature: 0, agent: "REPAIR", jsonMode: true, structured: HEAL_REPLY_STRUCTURED });
            return m?.content ?? m?.choices?.[0]?.message?.content ?? "";
          }
        : undefined;
    return healTests({ repoRoot, files, call, escalate, sandbox, log });
  };
}
