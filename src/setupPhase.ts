/**
 * SETUP phases: environment work (install / restore dependencies) that has no
 * diff to check and no Editor pass.
 *
 * Flow — the model is only involved when the install output has something
 * worth diagnosing:
 *
 *   run install  ->  analyze the output (deterministic)
 *     clean       -> pass, no model call
 *     noteworthy  -> one SETUP diagnosis call
 *     failed      -> one SETUP diagnosis call
 *   diagnosis:
 *     benign   -> pass (install succeeded, nothing to act on)
 *     fixable  -> apply the proposed manifest edit(s), re-run the install
 *     blocked  -> stop; surface the reason + manual steps
 *
 * Every side effect (running a command, calling a model, writing a file,
 * asking the user) is injected, so the whole loop is unit-testable without a
 * package manager or a network.
 */

import { z } from "zod";

export interface InstallStep {
  command: string;
  cwd: string;
}

export type InstallVerdict = "clean" | "noteworthy" | "failed";

export interface InstallAnalysis {
  verdict: InstallVerdict;
  /** The specific output lines that made this non-clean (capped). */
  signals: string[];
}

// Lines that look alarming but are routine package-manager chatter.
const NOISE_LINE =
  /deprecated|looking for funding|npm fund|run `npm|\bfunding\b|^added \d+|^removed \d+|^changed \d+|^audited \d+|up to date|found 0 vulnerabilities|\b0 errors?\b|npm warn config|npm notice/i;

const PROBLEM_LINE =
  /\bERESOLVE\b|npm ERR!|npm error|\bEBADENGINE\b|\bETARGET\b|\bE404\b|\bEACCES\b|\bENOENT\b|\bEINTEGRITY\b|\bpeer dep|unmet peer|conflicting peer|could not resolve|cannot find|no matching version|notarget|gyp ERR|\bconflict|\bincompatible|FAILURE:|Traceback|\bfatal\b|\berror\b|\bfailed\b|npm warn (?!deprecated)/i;

/**
 * Classify a finished install. `ok` is the process's own exit status; the
 * output is scanned line by line so a successful install that nevertheless
 * printed a peer-dependency conflict is "noteworthy", not "clean".
 */
export function analyzeInstallOutput(ok: boolean, output: string): InstallAnalysis {
  const signals: string[] = [];
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || NOISE_LINE.test(line)) continue;
    if (PROBLEM_LINE.test(line)) signals.push(line.slice(0, 300));
    if (signals.length >= 40) break;
  }
  if (!ok) return { verdict: "failed", signals };
  return { verdict: signals.length > 0 ? "noteworthy" : "clean", signals };
}

// --------------------------------------------------------------- diagnosis

export const SetupDiagnosisSchema = z.object({
  assessment: z.enum(["benign", "fixable", "blocked"]),
  summary: z.string().default(""),
  edits: z
    .array(z.object({ file: z.string(), search: z.string(), replace: z.string() }))
    .default([]),
  manualSteps: z
    .array(z.object({ step: z.string(), reason: z.string().default("") }))
    .default([]),
});
export type SetupDiagnosis = z.infer<typeof SetupDiagnosisSchema>;

/** Pull the first JSON object out of model text and validate it. */
export function parseSetupDiagnosis(text: string): SetupDiagnosis | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = SetupDiagnosisSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the phase's own text forbids touching the manifest or lockfile
 * ("do not edit the manifest or lockfile to force installation"). Decided
 * mechanically so a model can never talk itself past an explicit constraint.
 */
export function manifestEditsForbidden(phaseText: string): boolean {
  return /\b(do not|don't|never|must not|without)\b[^.]{0,60}\b(edit|modify|change|touch|alter|rewrite)\b[^.]{0,60}\b(manifest|package\.json|lock\s?file|dependencies)\b/i.test(
    phaseText
  );
}

export function buildSetupDiagnosisPrompt(args: {
  phaseGoal: string;
  steps: InstallStep[];
  output: string;
  analysis: InstallAnalysis;
  attempt: number;
  history: string[];
  editsAllowed: boolean;
  manifests: { file: string; content: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`PHASE GOAL:\n${args.phaseGoal}`);
  lines.push(`COMMAND(S) RUN:\n${args.steps.map((s) => `- ${s.command}  (in ${s.cwd})`).join("\n")}`);
  lines.push(
    `RESULT: ${args.analysis.verdict === "failed" ? "the install FAILED (non-zero exit)" : "the install exited 0 but printed output worth checking"}`
  );
  if (args.analysis.signals.length > 0) {
    lines.push(`FLAGGED LINES:\n${args.analysis.signals.map((s) => `- ${s}`).join("\n")}`);
  }
  lines.push(`OUTPUT (tail):\n${args.output.slice(-6000)}`);
  if (args.history.length > 0) {
    lines.push(`EARLIER ATTEMPTS THIS PHASE (do not repeat a fix that already failed):\n${args.history.join("\n")}`);
  }
  lines.push(
    args.editsAllowed
      ? `MANIFESTS YOU MAY EDIT (exact current content; "search" must match it exactly and occur once):\n` +
          (args.manifests.length > 0
            ? args.manifests.map((m) => `--- ${m.file} ---\n${m.content.slice(0, 8000)}`).join("\n\n")
            : "(none found)")
      : `EDITS ARE FORBIDDEN for this phase — the phase text says not to modify the manifest or lockfile. ` +
          `Leave "edits" empty; use "manualSteps" to tell the user what to do.`
  );
  lines.push(`This is attempt ${args.attempt + 1}.`);
  return lines.join("\n\n");
}

// --------------------------------------------------------------- the loop

export interface SetupPhaseDeps {
  steps: InstallStep[];
  /** Total install runs allowed (the first run + fix-and-retry runs). */
  maxRuns: number;
  /** Whether the diagnosis may propose manifest edits at all. */
  editsAllowed: boolean;
  approve: (summary: string) => Promise<boolean>;
  runStep: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
  diagnose: (ctx: {
    attempt: number;
    output: string;
    analysis: InstallAnalysis;
    history: string[];
  }) => Promise<SetupDiagnosis | undefined>;
  /** Apply one manifest edit; throws (or returns false) when it can't be applied. */
  applyEdit: (edit: { file: string; search: string; replace: string }) => Promise<void>;
  /** Hard allowlist: only dependency manifests, never lockfiles or source. */
  isEditableManifest: (file: string) => boolean;
  log?: (line: string) => void;
}

export interface SetupPhaseResult {
  passed: boolean;
  runs: number;
  summary: string;
  /** Manifest files this phase edited (so the caller can commit them). */
  edited: string[];
  manualSteps: { step: string; reason: string }[];
  /** Tail of the last install's output, for the phone/console. */
  lastOutput: string;
  declined?: boolean;
}

async function runAll(
  deps: SetupPhaseDeps
): Promise<{ ok: boolean; output: string }> {
  const parts: string[] = [];
  for (const step of deps.steps) {
    const res = await deps.runStep(step.command, step.cwd);
    parts.push(`$ ${step.command}  (in ${step.cwd})\n${res.output}`);
    if (!res.ok) return { ok: false, output: parts.join("\n\n") };
  }
  return { ok: true, output: parts.join("\n\n") };
}

export async function runSetupPhase(deps: SetupPhaseDeps): Promise<SetupPhaseResult> {
  const log = deps.log ?? (() => {});
  const summaryOfPlan = deps.steps
    .map((s) => `${s.command}${s.cwd ? `  (in ${s.cwd})` : ""}`)
    .join(" && ");

  const edited: string[] = [];
  const manualSteps: { step: string; reason: string }[] = [];
  const history: string[] = [];

  if (deps.steps.length === 0) {
    return {
      passed: false,
      runs: 0,
      summary: "No dependency manifest was found to install from.",
      edited,
      manualSteps: [{ step: "Install the project's dependencies manually.", reason: "No manifest detected." }],
      lastOutput: "",
    };
  }

  let approved = false;
  try {
    approved = await deps.approve(summaryOfPlan);
  } catch {
    // An unanswerable prompt is a decline, never a crash.
  }
  if (!approved) {
    return {
      passed: false,
      runs: 0,
      declined: true,
      summary: `Install not approved: ${summaryOfPlan}`,
      edited,
      manualSteps: [{ step: `Run: ${summaryOfPlan}`, reason: "Install was declined or could not be confirmed." }],
      lastOutput: "",
    };
  }

  let lastSignature: string | undefined;
  let last = { ok: false, output: "" };
  let runs = 0;

  while (runs < Math.max(1, deps.maxRuns)) {
    log(`[SETUP] ⚙️ Install run ${runs + 1}/${deps.maxRuns}: ${summaryOfPlan}`);
    last = await runAll(deps);
    runs++;

    const analysis = analyzeInstallOutput(last.ok, last.output);
    if (analysis.verdict === "clean") {
      log(`[SETUP] ✓ Install clean — nothing to analyze.`);
      return { passed: true, runs, summary: "Dependencies installed cleanly.", edited, manualSteps, lastOutput: last.output.slice(-4000) };
    }

    log(
      analysis.verdict === "failed"
        ? `[SETUP] ⛔ Install failed — asking SETUP to diagnose.`
        : `[SETUP] ⚠️ Install succeeded but printed ${analysis.signals.length} line(s) worth checking — asking SETUP to diagnose.`
    );

    // Same signals twice in a row after a "fix" = the fix did not land.
    const signature = `${analysis.verdict}|${analysis.signals.slice(0, 5).join("|")}`;
    if (signature === lastSignature) {
      const why = "The same install output was produced again after the attempted fix — stopping.";
      return finish(last.ok, runs, why);
    }
    lastSignature = signature;

    const diagnosis = await deps.diagnose({ attempt: runs - 1, output: last.output, analysis, history });
    if (!diagnosis) {
      return finish(
        last.ok,
        runs,
        last.ok
          ? "Install succeeded; its output could not be analyzed, so it is passed with the warnings shown above."
          : "Install failed and the diagnosis could not be parsed."
      );
    }
    manualSteps.push(...diagnosis.manualSteps.map((m) => ({ step: m.step, reason: m.reason })));

    if (diagnosis.assessment === "benign" && last.ok) {
      return finish(true, runs, diagnosis.summary || "Install succeeded; the output is informational only.");
    }

    if (diagnosis.assessment === "fixable" && deps.editsAllowed && diagnosis.edits.length > 0 && runs < deps.maxRuns) {
      let appliedAny = false;
      for (const edit of diagnosis.edits) {
        if (!deps.isEditableManifest(edit.file)) {
          history.push(`Attempt ${runs}: edit to "${edit.file}" refused — only dependency manifests may be edited.`);
          continue;
        }
        try {
          await deps.applyEdit(edit);
          appliedAny = true;
          if (!edited.includes(edit.file)) edited.push(edit.file);
          history.push(`Attempt ${runs}: edited ${edit.file} — ${diagnosis.summary}`);
          log(`[SETUP] 🔧 Edited ${edit.file}: ${diagnosis.summary}`);
        } catch (err: any) {
          history.push(`Attempt ${runs}: edit to ${edit.file} could not be applied (${err?.message ?? err}).`);
        }
      }
      if (appliedAny) continue; // re-run the install against the fixed manifest
    }

    // blocked, or fixable-but-not-applicable: nothing more this phase can do.
    return finish(
      last.ok,
      runs,
      diagnosis.summary || (last.ok ? "Install succeeded with unresolved warnings." : "Install failed and could not be fixed automatically.")
    );
  }

  return finish(last.ok, runs, last.ok ? "Install succeeded after fixes." : "Install still failing after the allowed fix attempts.");

  function finish(passed: boolean, runCount: number, summary: string): SetupPhaseResult {
    return { passed, runs: runCount, summary, edited, manualSteps, lastOutput: last.output.slice(-4000) };
  }
}
