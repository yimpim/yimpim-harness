/**
 * Phase planning.
 *
 * The planner emits a structured, ordered list of phases. Each phase is then
 * implemented and verified independently, so a failure is isolated to one small
 * unit of work instead of invalidating an entire feature.
 *
 * Structured output can fail (a model ignores JSON mode, returns prose, or the
 * shape is wrong). That must never block a run, so parsing degrades to a single
 * phase containing the whole plan — exactly the previous behaviour.
 */

import { z } from "zod";
import { normalizeVerificationIds, parseVerificationBullet } from "./verificationBullets.js";
import { ManualStep } from "./agentTools.js";
import { ProposedDependencySchema, ProposedToolSchema } from "./setupProposal.js";

const stringListSchema = z
  .union([z.array(z.string()), z.string().transform((s) => [s])])
  .nullish()
  .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : []));

export const ContractSpecificationsSchema = z.union([
  z.object({
    signatures: stringListSchema,
    types: stringListSchema,
    constraints: stringListSchema,
  }),
  z.array(z.string()).transform((arr) => ({
    signatures: arr,
    types: [] as string[],
    constraints: [] as string[],
  })),
]);

export type ContractSpecifications = z.infer<typeof ContractSpecificationsSchema>;

/**
 * Which worker a phase is routed to — assigned by the Planner, read
 * mechanically by the orchestrator (never inferred from the phase text).
 *  - EDITOR: creates or changes files (Editor -> QA -> Repair).
 *  - QA:     runs checks (typecheck, tests, build/export) and fixes only what
 *            they reveal — no Editor pass, no diff requirement.
 *  - SETUP:  environment work (install/restore dependencies) — runs the
 *            install, analyzes the output, and only calls a model when the
 *            output has something to diagnose.
 * Defaults to EDITOR so plans/resume files written before this field existed
 * keep their exact old routing.
 */
export const PHASE_EXECUTORS = ["EDITOR", "QA", "SETUP"] as const;
export type PhaseExecutor = (typeof PHASE_EXECUTORS)[number];

export const PhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  executor: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
      z.enum(PHASE_EXECUTORS).catch("EDITOR")
    )
    .default("EDITOR"),
  files: z.array(z.string()).default([]),
  /**
   * Subset of `files` the planner believes do NOT exist yet and must be
   * created rather than located and edited. Without this, a phase that is
   * mostly new work (e.g. a brand-new feature area) gives the editor no way
   * to tell "search for it" from "just create it" apart from trial and error.
   */
  newFiles: z.array(z.string()).default([]),
  changes: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  /**
   * Optional contract specifications (signatures, types, constraints)
   * established for target files to prevent API hallucinations and drift.
   */
  contracts: ContractSpecificationsSchema.optional(),
  contractSpecifications: ContractSpecificationsSchema.optional(),
  signatures: stringListSchema.optional(),
  types: stringListSchema.optional(),
  constraints: stringListSchema.optional(),
});

/**
 * One clarifying question with up to 3 concrete, grounded suggested answers
 * — asked as buttons (plus an always-available "type your own" option), not
 * blind free text. "options" is a hint, never the only way to answer: a
 * question with zero options (a genuine open-ended one) is still valid, it
 * just asks with no suggested buttons.
 */
export const ClarifyingQuestionSchema = z.object({
  question: z.string(),
  // .max() would REJECT the whole plan over a model giving 4 options
  // instead of 3 — disproportionate for a cosmetic overflow. Truncating
  // instead matches every other cap in this schema (MAX_PLAN_PHASES,
  // clarifyingQuestions itself below): keep what fits, never nuke the plan.
  options: z.array(z.string()).default([]).transform((arr) => arr.slice(0, 3)),
});

export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;

/** The option that confirms an assumed-then-asked item; anything else is a correction. */
export const ASSUMPTION_CONFIRM_OPTION = "Yes, that's right";

/**
 * The harness never lets a plan quietly rest on a guess. Every entry the
 * Planner puts in "assumptions" is turned into a question for the user, after
 * the Planner's own clarifying questions, capped at 5 in total. Answers other
 * than a plain confirmation go back to the Planner for the one re-plan.
 */
export function questionsToAsk(
  plan: { assumptions: string[]; clarifyingQuestions: ClarifyingQuestion[] },
  opts: { hasSpec?: boolean; limit?: number } = {}
): ClarifyingQuestion[] {
  const out: ClarifyingQuestion[] = [...plan.clarifyingQuestions];
  const seen = new Set(out.map((q) => q.question.trim().toLowerCase()));
  for (const a of plan.assumptions) {
    const text = a.trim();
    if (!text) continue;
    const question = `The plan assumes: ${text}\nIs that right?`;
    if (seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    // "Follow the spec" is only an answer when there is a spec; otherwise the
    // request was silent on this point (that is why it was an assumption), so
    // the honest alternative is for the user to say what they want.
    out.push({
      question,
      options: [
        ASSUMPTION_CONFIRM_OPTION,
        opts.hasSpec ? "No — don't assume; follow the brief/spec exactly" : "No — that's wrong; I'll say what to do",
      ],
    });
  }
  return out.slice(0, opts.limit ?? 5);
}

/**
 * How the Planner's open points are handled:
 *   essential (default) - only the few things worth a person's time are asked, however many there are (one round); every
 *                         other point is decided from the request and the code, written down, and shown in the plan.
 *                         With nobody there to answer, those are decided too and flagged for review.
 *   autonomous          - nothing is ever asked; the same few are decided and flagged for review.
 *   all                 - every assumption and question is asked, up to two rounds.
 */
export type QuestionMode = "autonomous" | "essential" | "all";

/**
 * The only things worth a person's time: adding a dependency or paying for something, deleting or overwriting data or
 * files, a security or privacy trade-off. (A user-visible change the specs do not settle is the fourth; the Planner's own
 * "high" vagueness covers it, since a word list cannot tell it from routine UI work.)
 */
const DATA_NOUN = String.raw`(files?|folders?|director(y|ies)|data|database|tables?|columns?|records?|rows?|repo(sitory)?|history|backups?|accounts?|photos?|messages?|documents?|storage|disk|the user'?s)`;
/**
 * Deleting or overwriting counts only when it is aimed at something a person keeps; "wipe the session" or "clear the
 * cache" is the program tidying its own state, which is not worth a question. The same goes for security: only a
 * trade-off or a handling of secrets counts, not a mention of "security requirements".
 */
const ESSENTIAL_RE = new RegExp(
  [
    String.raw`\bnew dependenc\w*`,
    String.raw`\badd(ing)? (a |an )?(new )?(npm |pip )?(package|library|dependency|sdk)\b`,
    String.raw`\b(npm|pip) install\b`,
    String.raw`\bsubscription\b`,
    String.raw`\bpaid (plan|tier|service)\b`,
    String.raw`\bbilling\b`,
    String.raw`\b(delet\w*|wip\w*|overwrit\w*|eras\w*|purg\w*|drop(s|ped|ping)?)\b[^.\n]{0,40}\b${DATA_NOUN}\b`,
    String.raw`\bdrop (the )?(table|database|column)\b`,
    String.raw`\birreversib\w*|\bdestructive\b`,
    String.raw`\b(security|privacy) (trade-?off|risk|concern)\b`,
    String.raw`\b(store|log|send|share|expose|transmit)\w*\b[^.\n]{0,40}\b(passwords?|secrets?|credentials?|api[- ]?keys?|personal (data|information)|pii)\b`,
    String.raw`\b(passwords?|secrets?|credentials?|api[- ]?keys?|personal (data|information)|pii)\b[^.\n]{0,40}\b(in (plain ?text|the clear|logs?)|unencrypted|to (a|the) (server|third)|leave)\b`,
    String.raw`\bgdpr\b`,
  ].join("|"),
  "i"
);

export function looksEssential(q: ClarifyingQuestion): boolean {
  return ESSENTIAL_RE.test(`${q.question}\n${q.options.join("\n")}`);
}

export interface QuestionDecision {
  question: string;
  choice: string;
  /** Touches something hard to undo: shown with a review flag. */
  essential: boolean;
  /** The choice differs from what the plan already does, so the Planner is told it. */
  needsReplan: boolean;
  /** False when no existing code settled it, so the choice rests on the Planner's own judgment. */
  grounded?: boolean;
}

/**
 * What to do with a point nobody will be asked about. An assumption stays as the plan wrote it. A question with options
 * takes its first option, which the Planner is told to make its recommendation. One with no options is left to the
 * Planner's judgment from the request and the code.
 */
export function decideWithoutAsking(q: ClarifyingQuestion, essential: boolean): QuestionDecision {
  if (q.question.startsWith("The plan assumes:")) {
    const text = q.question.replace(/^The plan assumes:\s*/, "").replace(/\s*Is that right\?\s*$/, "").trim();
    return { question: q.question, choice: `keep as planned: ${text}`, essential, needsReplan: false };
  }
  if (q.options.length > 0) return { question: q.question, choice: q.options[0], essential, needsReplan: true };
  return { question: q.question, choice: "decide it yourself from the request and the code, and say what you chose", essential, needsReplan: true };
}

/** One line for the plan's record of what was decided without asking. */
export function describeDecision(d: QuestionDecision): string {
  const q = d.question.split("\n")[0].replace(/^The plan assumes:\s*/, "").trim();
  return `${d.essential ? "⚠️ REVIEW — " : ""}Decided without asking: ${q} → ${d.choice}${d.grounded === false ? " (no existing code settled this)" : ""}`;
}

/**
 * True when the request points at a brief/spec document (a file like
 * EXPORT_BRIEF.md, spec.md, requirements.txt) or says "the brief"/"the spec".
 * Used only to decide which wording an assumption question offers.
 */
export function mentionsSpec(request: string): boolean {
  return (
    /[\w./\\-]*(brief|spec|specification|requirements?|prd)[\w./\\-]*\.(md|txt|pdf|docx?|rst)\b/i.test(request) ||
    /\b(the|this|attached|my)\s+(brief|spec|specification|requirements)\b/i.test(request)
  );
}

/** An "assumption" that only defers a checkable fact to later is a plan that did not do its reading. */
const DEFERRED_FACT_RE =
  /\b(confirm|verify|check|validate|determine|decide)\b[^.\n]{0,80}\b(during|at|in|when|while)\s+(the\s+)?(implementation|implementing|editing|coding)\b|\bto be (confirmed|verified|determined)\b|\bassum(e|ing) (that )?(the )?(code|parser|file|function|api|component)\b/i;

/** Messages for assumptions the Planner should have settled by reading, not deferred. */
export function lintAssumptions(assumptions: string[]): string[] {
  return assumptions
    .filter((a) => DEFERRED_FACT_RE.test(a))
    .map(
      (a) =>
        `assumption "${a.slice(0, 120)}" defers a checkable fact to implementation — read the file or spec that settles it now ` +
        `and state what you found; only if nothing available can answer it, keep it as an assumption (it will be put to the user as a question)`
    );
}

/**
 * One thing the user reported seeing. Users describe symptoms, not causes, so
 * the Planner must map EACH one to code it will change (or say why none is
 * needed): a plan that only "verifies" a reported failure leaves it unfixed.
 */
export const SymptomSchema = z.object({
  symptom: z.string(),
  /** The most likely cause, even when only suspected. */
  likelyCause: z.string().default(""),
  confidence: z.enum(["confirmed", "suspected", "unknown"]).default("unknown"),
  /** 1-based numbers of the phases that address it. */
  phases: z.array(z.number()).default([]),
  /** Set only when no code change is the right response. */
  noCodeChangeBecause: z.string().optional(),
  /** Where it goes wrong, as file:line or file/symbol, if known. */
  codePath: z.string().optional(),
  /** 1-based number of ANOTHER symptom this one is a consequence of. */
  causedBy: z.number().optional(),
});
export type Symptom = z.infer<typeof SymptomSchema>;

export const PlanSchema = z.object({
  /** The causal story across the reported symptoms, written before the goal. */
  causalAnalysis: z.string().default(""),
  goal: z.string(),
  assumptions: z.array(z.string()).default([]),
  /**
   * Populated only when the request is ambiguous enough that a wrong guess
   * would mean building the wrong thing, not just a minor judgment call.
   * The plan below is still usable on its own (built under the stated
   * assumptions) — these are asked live when someone is available, and
   * otherwise left as a visible record of what was uncertain. Capped at 5
   * by the Planner's own instructions (PLANNER_SYSTEM) — an intake-form-
   * length interview defeats the point of asking at all. Truncated here,
   * not rejected, for the same reason "options" above truncates: a model
   * overshooting the suggested cap is a quality issue, not a reason to
   * throw away the whole plan.
   */
  clarifyingQuestions: z
    .array(ClarifyingQuestionSchema)
    .default([])
    .transform((arr) => arr.slice(0, 5)),
  /**
   * The Planner's own judgment of how likely a wrong guess is to build the
   * WRONG thing, not just a differently-styled one. "high" is what makes
   * the clarifying round above NOT skippable even in an unattended/--yes
   * run (see its use at the call site) — everything below "high" stays the
   * existing skippable, assumptions-are-fine-too behavior. Defaults to
   * "low" so a degraded (unparseable) plan never blocks a run that already
   * has no structured output to act on anyway.
   */
  vagueness: z.enum(["low", "medium", "high"]).default("low"),
  /**
   * Set only when the request represents a substantial or exploratory change
   * relative to something already working, where isolating it makes sense —
   * the same "would a wrong guess mean building the wrong thing" judgment as
   * clarifyingQuestions, just resolved with a proposal instead of a question.
   * null for the common case (most requests should just build in place).
   */
  suggestedBranch: z.string().nullable().default(null),
  /**
   * Short, self-contained one-line instructions for additional chunks of the
   * original ask that were deliberately deferred rather than planned now —
   * used when the request naturally decomposes into more independent work
   * than MAX_PLAN_PHASES phases can hold (e.g. "redesign every screen" across
   * many screens). Each entry must stand alone: it is handed back to a
   * planner with no memory of this plan, exactly as if the user had typed it
   * fresh. Empty for the common case where everything fit in this plan.
   */
  followUpTasks: z.array(z.string()).default([]),
  /**
   * Libraries and tools the planner PREDICTS the work will need. Predictions,
   * not facts: setupProposal.ts verifies each against the real registries and
   * the local machine before anything is relied on. Optional so plans written
   * before this field existed parse unchanged; malformed entries are dropped
   * rather than failing the whole plan.
   */
  dependencies: z
    .array(z.unknown())
    .optional()
    .transform((arr) =>
      (arr ?? []).flatMap((v) => {
        const r = ProposedDependencySchema.safeParse(v);
        return r.success ? [r.data] : [];
      })
    ),
  toolchain: z
    .array(z.unknown())
    .optional()
    .transform((arr) =>
      (arr ?? []).flatMap((v) => {
        const r = ProposedToolSchema.safeParse(typeof v === "string" ? { tool: v } : v);
        return r.success ? [r.data] : [];
      })
    ),
  /** Every distinct problem the user reported, each mapped to the phases that fix it. */
  symptoms: z
    .array(z.unknown())
    .optional()
    .transform((arr) =>
      (arr ?? []).flatMap((v) => {
        const r = SymptomSchema.safeParse(v);
        return r.success ? [r.data] : [];
      })
    ),
  phases: z.array(PhaseSchema).min(1),
});

export type PlannedPhase = z.infer<typeof PhaseSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Hard ceiling on how many phases a single plan may be executed with. A plan
 * proposing more than this is not silently cut down to fit — the full proposal
 * is preserved on PlanResult.allPhases so the orchestrator can hand it back to
 * the planner for consolidation (see buildConsolidationPrompt).
 */
export const MAX_PLAN_PHASES = 12;

export interface PlanResult {
  plan: Plan;
  /** True when structured parsing failed and we fell back to one phase. */
  degraded: boolean;
  /** The planner's raw text, preserved for PROGRESS.md and the editor prompt. */
  raw: string;
  /** How many phases the model actually proposed, when that was more than
   *  the MAX_PLAN_PHASES cap and some were dropped from `plan.phases` —
   *  undefined otherwise. */
  truncatedFromPhaseCount?: number;
  /**
   * EVERY phase the model proposed, before any cap was applied, with ids
   * normalized the same way `plan.phases` is. `plan.phases` stays the capped
   * list actually executed; this is the complete proposal the consolidation
   * pass needs, so no proposed phase (and therefore no file or objective) is
   * lost just because the plan overflowed the limit.
   */
  allPhases: PlannedPhase[];
}

export interface DiscoveryTaskFindings {
  existingFiles: Array<{
    path: string;
    symbols: string[];
    relevantCode: string;
    whyRelevant: string;
  }>;
  existingFlow: string[];
  newFilesNeeded: string[];
  uncertainties: string[];
}

export const EMPTY_DISCOVERY_TASK_FINDINGS: DiscoveryTaskFindings = {
  existingFiles: [],
  existingFlow: [],
  newFilesNeeded: [],
  uncertainties: [],
};

/**
 * Return actionable defects that would leave the Editor hunting for targets.
 *
 * `verifyOnly` relaxes this for a plan from PLANNER_VERIFY_SYSTEM: that
 * planner's phases are checkable SCENARIOS, not file-level diffs, so Editor
 * never runs for them at all (runPhaseWithHealing skips straight to
 * verification) — "no target files" and "no concrete changes" describe a
 * defect in a BUILD plan, not a verify one, where an empty "files"/"changes"
 * is often simply correct (a broad regression scenario with no single file,
 * nothing being changed). "verification" staying required either way is the
 * point: that's QA's actual goal text, and an empty one is a real defect in
 * both kinds of plan.
 */
export function validatePlan(plan: Plan, verifyOnly = false): string[] {
  const errors: string[] = [];
  if (!verifyOnly) {
    for (const sym of plan.symptoms ?? []) {
      const idx = plan.symptoms.indexOf(sym) + 1;
      if (sym.causedBy !== undefined && (sym.causedBy === idx || sym.causedBy < 1 || sym.causedBy > plan.symptoms.length)) {
        // A cross-reference hint, not a requirement: a model that points a symptom at itself or at a
        // missing number (1- vs 0-based) must not abort an otherwise good plan. Drop the link.
        delete sym.causedBy;
      }
      if (sym.noCodeChangeBecause && sym.noCodeChangeBecause.trim()) {
        // "Already handled in the code" is not an answer to a failure the user saw in a real build.
        if (/already\s+(implemented|handled|exists?|present|in place|there|polyfill)|code (already|looks)|looks (correct|fine|implemented)/i.test(sym.noCodeChangeBecause)) {
          errors.push(
            `reported symptom "${sym.symptom.slice(0, 80)}" cannot be dismissed because the code already looks ` +
              `right: the user saw it fail in a real build, so find why the target runtime differs from the source ` +
              `(import order, bundling/stripping, platform API missing) and plan the edit`
          );
        }
        continue;
      }
      const fixing = sym.phases.filter((n) => {
        const p = plan.phases[n - 1];
        return p && (p.executor ?? "EDITOR") === "EDITOR" && p.files.length > 0;
      });
      if (fixing.length === 0) {
        errors.push(
          `reported symptom "${sym.symptom.slice(0, 80)}" is not addressed by any EDITOR phase that changes code — ` +
            `map it to a phase that fixes the most likely cause or makes the real failure visible (a guard, a ` +
            `surfaced error), or set noCodeChangeBecause with a reason`
        );
      }
    }
  }
  for (const [index, phase] of plan.phases.entries()) {
    const label = `phase ${index + 1} (${phase.name || phase.id})`;
    const noOp = /already\s+(implemented|complete|satisfied)|no\s+change\s+(required|needed)|does\s+not\s+exist/i.test(
      `${phase.goal} ${phase.name}`
    );
    if (noOp) continue;
    // QA/SETUP phases never run the Editor, so "no target files" and "no
    // concrete changes" describe a defect only in an EDITOR phase.
    if (!verifyOnly && (phase.executor ?? "EDITOR") === "EDITOR") {
      if (phase.files.length === 0) errors.push(`${label} has no target files`);
      const contracts = phase.contracts ?? phase.contractSpecifications;
      const hasContracts = Boolean(
        contracts &&
          ((contracts.signatures && contracts.signatures.length > 0) ||
           (contracts.types && contracts.types.length > 0) ||
           (contracts.constraints && contracts.constraints.length > 0))
      );
      if (phase.changes.length === 0 && !hasContracts) {
        errors.push(`${label} has no concrete changes`);
      }
    }
    if (phase.verification.length === 0) errors.push(`${label} has no phase-specific verification`);
    for (const file of phase.files) {
      if (!file.includes("/") && !file.includes("\\") && !/\.[A-Za-z0-9]+$/.test(file)) {
        errors.push(`${label} target is not an exact file path: ${file}`);
      }
    }
  }
  return errors;
}

/** Strip code fences and pull the outermost JSON object from model text. */
function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("{");
  if (start === -1) return undefined;

  // Walk to the matching brace rather than greedily taking the last one, so
  // trailing prose after the JSON does not corrupt the parse.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Parse planner output into phases, degrading to a single phase on any failure.
 * `fallbackGoal` is the user's original request.
 */
export function parsePlan(raw: string, fallbackGoal: string): PlanResult {
  const singlePhase = (reason: string): PlanResult => {
    const fallbackPhase: PlannedPhase = {
      id: "phase-1",
      name: "Implementation & Verification",
      goal: fallbackGoal,
      executor: "EDITOR",
      files: [],
      newFiles: [],
      changes: [],
      verification: [],
    };
    return {
      plan: {
        causalAnalysis: "",
        goal: fallbackGoal,
        assumptions: [],
        clarifyingQuestions: [],
        vagueness: "low",
        suggestedBranch: null,
        followUpTasks: [],
        dependencies: [],
        toolchain: [],
        symptoms: [],
        phases: [fallbackPhase],
      },
      degraded: true,
      raw,
      // The degraded plan IS its own full proposal — there was never a larger
      // proposal to consolidate, so this stays consistent with plan.phases.
      allPhases: [fallbackPhase],
    };
  };

  const json = extractJson(raw);
  if (!json) return singlePhase("no JSON object found");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return singlePhase("JSON did not parse");
  }

  const result = PlanSchema.safeParse(parsedJson);
  if (!result.success) return singlePhase("JSON did not match the plan shape");

  // Guard against a model that returns an absurd number of phases. The capped
  // slice is what actually executes, but the COMPLETE proposal is kept on
  // allPhases so the orchestrator can send the overflow back to the planner
  // for consolidation instead of quietly losing phases 13+.
  const proposedCount = result.data.phases.length;
  const allPhases = result.data.phases.map((p, i) => {
    let contracts = p.contracts ?? p.contractSpecifications;
    if (!contracts && (p.signatures?.length || p.types?.length || p.constraints?.length)) {
      contracts = {
        signatures: p.signatures ?? [],
        types: p.types ?? [],
        constraints: p.constraints ?? [],
      };
    }
    return {
      ...p,
      id: p.id || `phase-${i + 1}`,
      ...(contracts ? { contracts } : {}),
    };
  });
  // Every verification bullet gets a stable ID (A1, A2, ...) so later steps can
  // refer to one assertion exactly. Done on allPhases: phases is a slice of the
  // same objects, and IDs stay unique across the whole proposal.
  normalizeVerificationIds({ phases: allPhases });
  const phases = allPhases.slice(0, MAX_PLAN_PHASES);

  return {
    plan: { ...result.data, phases },
    degraded: false,
    raw,
    truncatedFromPhaseCount: proposedCount > MAX_PLAN_PHASES ? proposedCount : undefined,
    allPhases,
  };
}

/** Render the full plan, with per-phase status, for PROGRESS.md. */
export function renderProgress(
  plan: Plan,
  statuses: Record<string, "pending" | "running" | "passed" | "failed">,
  extraNotes?: string,
  manualSteps?: ManualStep[]
): string {
  const lines: string[] = ["# Active Plan", "", `**Goal:** ${plan.goal}`, ""];

  if (plan.assumptions.length > 0) {
    lines.push("## Assumptions", "");
    for (const a of plan.assumptions) lines.push(`- ${a}`);
    lines.push("");
  }

  lines.push("## Phases", "");
  for (const [i, phase] of plan.phases.entries()) {
    const status = statuses[phase.id] ?? "pending";
    const mark = status === "passed" ? "x" : " ";
    const tag =
      status === "running" ? " _(in progress)_"
      : status === "failed" ? " _(failed)_"
      : status === "passed" ? ""
      : "";
    lines.push(`- [${mark}] **${i + 1}. ${phase.name}**${tag}`);
    lines.push(`      ${phase.goal}`);
    if (phase.files.length > 0) {
      const labeled = phase.files.map((f) => (phase.newFiles.includes(f) ? `${f} (new)` : f));
      lines.push(`      files: ${labeled.join(", ")}`);
    }
    if (phase.verification.length > 0) {
      for (const v of phase.verification) lines.push(`      verify: ${v}`);
    }
    lines.push("");
  }

  if (manualSteps && manualSteps.length > 0) {
    lines.push("## Before this is live", "");
    lines.push("Steps you need to do outside this repo — credentials or console access this agent does not have:", "");
    for (const [i, m] of manualSteps.entries()) {
      lines.push(`${i + 1}. **${m.step}**${m.phase ? `  _(from: ${m.phase})_` : ""}`);
      lines.push(`   why: ${m.reason}`);
    }
    lines.push("");
  }

  if (extraNotes) lines.push("", "## Notes", "", extraNotes);
  return lines.join("\n");
}

/** The prompt text handed to the editor for one phase. */
/**
 * The effective contract specifications for a phase, resolving every shape
 * the schema accepts (nested "contracts", the "contractSpecifications"
 * alias, or flat top-level signatures/types/constraints) into one shape.
 * Shared by phaseInstructions (Editor's prompt) and phaseVerificationGoal
 * (QA's prompt) so both read the exact same resolved contract — never two
 * independent implementations that could quietly drift apart.
 */
function resolvePhaseContracts(phase: PlannedPhase): ContractSpecifications | undefined {
  return (
    phase.contracts ??
    phase.contractSpecifications ??
    (phase.signatures?.length || phase.types?.length || phase.constraints?.length
      ? {
          signatures: phase.signatures ?? [],
          types: phase.types ?? [],
          constraints: phase.constraints ?? [],
        }
      : undefined)
  );
}

/** Renders a resolved contract into the same "Signatures:"/"Types:"/"Constraints:" lines both prompts use. */
function renderContractLines(contracts: ContractSpecifications): string[] {
  const lines: string[] = [];
  if (contracts.signatures && contracts.signatures.length > 0) {
    lines.push(`  Signatures:`);
    for (const sig of contracts.signatures) lines.push(`    - ${sig}`);
  }
  if (contracts.types && contracts.types.length > 0) {
    lines.push(`  Types:`);
    for (const t of contracts.types) lines.push(`    - ${t}`);
  }
  if (contracts.constraints && contracts.constraints.length > 0) {
    lines.push(`  Constraints:`);
    for (const c of contracts.constraints) lines.push(`    - ${c}`);
  }
  return lines;
}

export function phaseInstructions(plan: Plan, phase: PlannedPhase, index: number): string {
  const parts = [
    `Overall objective: ${plan.goal}`,
    ``,
    `You are implementing phase ${index + 1} of ${plan.phases.length}: ${phase.name}`,
    ``,
    `PHASE GOAL (implement ONLY this):`,
    phase.goal,
  ];

  if (phase.files.length > 0) {
    parts.push(
      ``,
      `Expected files for this phase:`,
      ...phase.files.map((f) =>
        phase.newFiles.includes(f) ? `  - ${f}  (NEW — this file does not exist yet; create it, don't search for it)` : `  - ${f}`
      )
    );
  }
  if (phase.changes.length > 0) {
    parts.push(``, `Specific changes:`, ...phase.changes.map((c) => `  - ${c}`));
  }
  const contracts = resolvePhaseContracts(phase);
  if (contracts) {
    const contractLines = renderContractLines(contracts);
    if (contractLines.length > 0) {
      parts.push(``, `Contract specifications:`, ...contractLines);
    }
  }
  const criteria = phase.verification
    .map(parseVerificationBullet)
    .filter((b) => b.id && b.text)
    .map((b) => `  - [${b.id}] ${b.text}`);
  if (criteria.length > 0) {
    parts.push(
      ``,
      `Acceptance criteria QA will check afterwards (each has an ID):`,
      ...criteria,
      `These were written BEFORE the code existed. Build to satisfy them. If what you actually built differs from one — you changed its wording or ` +
        `behavior, it turned out impossible, or it can only be confirmed on a real device — do NOT silently ignore it: list it in conclude_task's ` +
        `assertionDeltas with its ID and a reason. That never removes the check; it tells QA and the user what changed.`
    );
  }
  if (plan.phases.length > 1) {
    const later = plan.phases.slice(index + 1);
    if (later.length > 0) {
      parts.push(
        ``,
        `Do NOT implement these — they are later phases:`,
        ...later.map((p) => `  - ${p.name}: ${p.goal}`)
      );
    }
  }
  parts.push(
    ``,
    `Leave the project in a compilable, working state at the end of this phase.`
  );

  return parts.join("\n");
}

/**
 * What the verifier is asked to confirm for this phase.
 *
 * Deliberately carries the same "Specific changes:" and "Contract
 * specifications:" sections Editor's own instructions get (via the shared
 * resolvePhaseContracts/renderContractLines helpers), not just the
 * "verification" bullets — two real gaps this closes:
 *  - Without "Specific changes:", QA had no way to tell a phase that was
 *    ALWAYS meant to be narrow (a config value, a single constant) from one
 *    that looks suspiciously small for its stated goal — both read identically
 *    from the goal sentence alone.
 *  - Without "Contract specifications:", QA was checking the diff against
 *    prose acceptance criteria only, never against the exact signature/type/
 *    constraint Planner already verified by inspection — a real divergence
 *    there could pass QA entirely if the vaguer verification bullets still
 *    looked satisfied. See STATIC_QA_SYSTEM's own HOW TO JUDGE section for
 *    where this is spent, not just carried along unused.
 */
/** One verification bullet as QA reads it: keeps the [A<n>] ID, drops the
 *  bookkeeping tags, and says in words what a quality flag means for judging. */
function renderVerificationForQa(raw: string): string {
  const b = parseVerificationBullet(raw);
  let head = `  - ${b.id ? `[${b.id}] ` : ""}${b.text}`;
  if (b.tags.includes("requires:device")) {
    head += `  (planner: requires a real device — a native capability a browser stand-in cannot show)`;
  }
  if (b.tags.includes("requires:credentials")) {
    head += `  (planner: requires credentials or an account — if the screen cannot be reached without one, that is INCONCLUSIVE, not a failure)`;
  }
  if (b.quality === "weak") {
    return `${head}  (vaguely worded by the Planner — judge only what is actually observable; do not pass or fail it on the wording alone)`;
  }
  if (b.quality === "label_unverified") {
    return `${head}  (a quoted label here was not found in the code or request — if it does not exist, judge the underlying outcome; never fail solely because that exact text is absent)`;
  }
  return head;
}

export function phaseVerificationGoal(plan: Plan, phase: PlannedPhase): string {
  const parts = [`Overall objective: ${plan.goal}`, ``, `Phase under test: ${phase.name}`, phase.goal];
  if (phase.changes.length > 0) {
    parts.push(``, `Specific changes intended for this phase:`, ...phase.changes.map((c) => `  - ${c}`));
  }
  const contracts = resolvePhaseContracts(phase);
  if (contracts) {
    const contractLines = renderContractLines(contracts);
    if (contractLines.length > 0) {
      parts.push(``, `Contract specifications (already verified by Planner — check the diff matches exactly):`, ...contractLines);
    }
  }
  if (phase.verification.length > 0) {
    parts.push(``, `Specifically confirm:`, ...phase.verification.map(renderVerificationForQa));
  }
  return parts.join("\n");
}

export interface MissingTarget {
  /** 1-based phase number. */
  phase: number;
  file: string;
}

/**
 * Target files an EDITOR phase says it will change that are not in the repo,
 * are not declared as new by the phase, and are not created by an earlier phase.
 * A step like "update the existing assertions in X" against a file that is gone
 * otherwise runs all the way to the Editor and dies there ("could not locate").
 */
export function missingTargetFiles(plan: Plan, exists: (rel: string) => boolean): MissingTarget[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const created = new Set<string>();
  const out: MissingTarget[] = [];
  plan.phases.forEach((phase, i) => {
    const isEditor = (phase.executor ?? "EDITOR") === "EDITOR";
    const newFiles = new Set((phase.newFiles ?? []).map(norm));
    for (const f of newFiles) created.add(f);
    if (!isEditor) return;
    if (/already\s+(implemented|complete|satisfied)|no\s+change\s+(required|needed)|does\s+not\s+exist/i.test(`${phase.goal} ${phase.name}`)) return;
    for (const raw of phase.files ?? []) {
      const f = norm(raw);
      if (newFiles.has(f) || created.has(f) || exists(f)) continue;
      out.push({ phase: i + 1, file: f });
    }
  });
  return out;
}

/** Messages for the Planner's corrective pass. */
export function lintTargetFiles(plan: Plan, exists: (rel: string) => boolean): string[] {
  return missingTargetFiles(plan, exists).map(
    (m) =>
      `phase ${m.phase} lists "${m.file}" as an existing file to change, but it is not in the repo and no earlier phase creates it — ` +
      `if it is a new file, list it in newFiles; if the step depends on it already existing (for example "update the existing tests"), ` +
      `plan around the fact that it does not, rather than pointing the Editor at a file it cannot open`
  );
}

/** What is still unresolved after the corrective pass, worded as assumptions so the user is asked. */
export function missingTargetAssumptions(plan: Plan, exists: (rel: string) => boolean): string[] {
  return missingTargetFiles(plan, exists).map(
    (m) => `phase ${m.phase} will change "${m.file}", which is not in the repo — the plan treats it as something that already exists`
  );
}
