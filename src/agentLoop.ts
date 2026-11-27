import fsSync from "node:fs";
import path from "node:path";
import { OpenRouterClient, FunctionTool, ChatMessage } from "./openrouter.js";
import { RepoTools } from "./repoTools.js";
import { AgentConfig } from "./config.js";
import { AgentTools, TOOLS_SCHEMA, PLANNER_TOOLS_SCHEMA, PendingQuestion } from "./agentTools.js";
import { EDITOR_SYSTEM, DISCOVERY_SYSTEM, ADVISOR_SYSTEM, PLANNER_SYSTEM, PLANNER_VERIFY_SYSTEM } from "./prompts.js";
import { events } from "./events.js";
import { runControl, AbortedError, askAnywhere } from "./remote/control.js";
import { sanitizeAssertionDeltas, encodeAssertionDeltas } from "./assertionAudit.js";
import { encodeTestsNotNeeded } from "./focusTests.js";
import { anyMustPass } from "./directFix.js";
import { promptView } from "./repoMap.js";
import { designSystemForPrompt, detectUiStack } from "./uiDesign.js";
import { coreRulesBlock } from "./uiKnowledge.js";
import { securityForPrompt } from "./securityPlan.js";
import { toolsHint } from "./projectTools.js";

/**
 * A short "→ N result(s)" suffix for a read-only tool's log line, built from
 * the plain string every one of these tools already returns — no extra API
 * call, just surfacing data that was already computed and then discarded.
 * Deliberately approximate (line-counting, skipping an obvious truncation
 * notice) rather than re-parsing each tool's exact return format.
 */
function summarizeReadOnlyResult(output: string, unit: string, plural: string, emptySentinels: string[]): string {
  const trimmed = output.trim();
  if (emptySentinels.some((s) => trimmed.startsWith(s))) return `no ${plural}`;
  const count = trimmed
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith("...") && !l.trim().startsWith("=== ")).length;
  return `${count} ${count === 1 ? unit : plural}`;
}

/** Separates a conclude_task explanation from its optional howToVerify in the
 *  plain string runToolAgent returns — see the conclude_task handling below
 *  for why this rides inside the string rather than a richer return type. */
const HOW_TO_VERIFY_MARKER = "\n\n[HOW TO VERIFY]\n";

/** Pulls the Editor's own how-to-verify notes (if it left any) back out of
 *  runToolAgent's return value — the closest thing to acceptance criteria
 *  this pipeline can produce, since it describes the mechanics of what was
 *  actually built rather than what the Planner predicted would be built. */
export function extractHowToVerify(editorResult: string): string | undefined {
  const idx = editorResult.indexOf(HOW_TO_VERIFY_MARKER);
  return idx === -1 ? undefined : editorResult.slice(idx + HOW_TO_VERIFY_MARKER.length).trim() || undefined;
}

/**
 * Discovery's budget. It used to have none, so a model that ignored "conclude
 * immediately" read for all 40 turns, found the files the map had already
 * listed, and ran out of turns before writing anything. After this many files
 * read, or this many rounds, its tools are removed and it must answer from what
 * it has, while its context is still small enough to do that.
 */
export const DISCOVERY_FILE_BUDGET = 30;
// At least the file budget (one read per round is the worst case), and below the
// 40-round ceiling so the write-up always has rounds left.
export const DISCOVERY_ROUND_BUDGET = 32;

export interface AgentRunOptions {
  /**
   * Checked at the top of every round. A string ends the run: the loop returns `STOPPED: <reason>` (it does not throw). For a caller that judges
   * progress by STATE (a dollar budget, a run that keeps giving the same result) instead of a number of rounds.
   */
  stopWhen?: () => string | undefined;
  /** Plain text, or content blocks (e.g. from buildUserContent) to include an image. */
  prompt: string | any[];
  repo: RepoTools;
  repoRoot?: string;
  client: OpenRouterClient;
  config: AgentConfig;
  agentTools: AgentTools;
  models: string[];
  agentName: string;
  phase?: { name: string; instructions: string };
  /**
   * Restricts what the model may call this run. Defaults to the full set.
   * Typed against the general `FunctionTool` shape rather than
   * `typeof TOOLS_SCHEMA` — a narrower persona-specific schema (e.g.
   * PLANNER_TOOLS_SCHEMA) has its own distinct per-tool parameter shapes,
   * which don't structurally match TOOLS_SCHEMA's exact literal tuple type
   * even though every entry is a perfectly valid tool definition.
   */
  tools?: FunctionTool[];
  /** True when `models` is a dedicated *Vision chain (editorVision,
   *  discoveryVision, ...), not the caller's normal one — purely so console
   *  output can say so plainly. The whole point is "no surprises that a
   *  pricier model got used"; a label costs nothing and removes the guessing. */
  visionMode?: boolean;
  /**
   * Fired for every tool call, after its args are parsed and before it
   * executes. Lets the phase orchestrator (src/orchestrator.ts) feed its
   * ReadTracker — inspection tools advance its read round, mutation tools
   * reset the streak — from a single observation point without this loop
   * knowing anything about that analysis-paralysis policy. Optional: the
   * callers that don't hand off (DISCOVERY, REPAIR, ADVISOR, ...) simply
   * omit it.
   */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /**
   * The stage this conversation is, for the task's read ledger (agentTools.readLedger): its reads are recorded under this name, so lines it has already been shown are not sent again.
   * Unset (the editor, repair): reads are exactly what they were.
   */
  readStage?: string;
  /** Called when this conversation starts, before anything is read: the place to begin the stage's ledger and put into its context what the stage is told up front. */
  onConversationStart?: () => void;
  /**
   * Marks this run as a corrective/retry pass of an earlier worker doing the
   * same step (e.g. the Planner re-run after its first plan failed
   * validation, or after clarifying-question answers) — not REPAIR, which is
   * its own distinct step, never a "retry" of anything. `retryOf` is the
   * earlier worker's `workerId` (see index.ts's `lastWorkerId`); `attempt` is
   * 1-based pass count; `reason` is a short human-readable cause.
   */
  retryOf?: string;
  attempt?: number;
  reason?: string;
  /** Set only when agentName === "ADVISOR" — links this run's worker.start/
   *  end to the same /ask exchange's advisor.start/advisor.answer events. */
  exchangeId?: string;
  /**
   * Overrides the agentName-based default round budget below. Exists for
   * REPAIR_PLANNER: its default cap (shared with the main Planner's own
   * bounded-inspection budget) is sized for the common case of triaging one
   * or two errors, and is too tight for a failure with many distinct root
   * causes spread across several files — a real one hit this exact wall
   * (11 reported TypeScript errors, 5-6 distinct root causes) and returned
   * with "turn_limit reached" and no diagnosis at all, handing REPAIR the
   * entire investigation from a cold start instead of a head start. The
   * caller (index.ts) computes this from how many blocking failures it's
   * actually asking REPAIR_PLANNER to triage, rather than this file
   * guessing at an unrelated agent's own evidence.
   */
  maxRoundsOverride?: number;
  /** Only meaningful for agentName "PLANNER"/"planner": swaps in
   *  PLANNER_VERIFY_SYSTEM instead of PLANNER_SYSTEM — set when the task's
   *  intent classified as "verify" (check existing behavior) rather than
   *  "task" (build/change something). See buildContextualSystemPrompt. */
  verifyOnly?: boolean;
}

/** Agents whose entire purpose is to produce edits, so ending a turn with no
 *  tool call and nothing written means they failed, not that they finished. */
const EDITING_AGENTS = new Set(["EDITOR", "REPAIR"]);
const MAX_EMPTY_TURN_NUDGES = 2;
const MAX_LEAKED_TOOL_CALL_NUDGES = 2;

/**
 * True when a no-tool-call response's own content looks like a tool-call
 * attempt serialized as text rather than genuine prose — see
 * leakedToolCallNudges' own comment for the real example this was built
 * from. Conservative on purpose (both markers required): a real answer
 * mentioning "invoke" or "parameter" in passing must never trip this.
 */
function looksLikeLeakedToolCall(content: unknown): boolean {
  return (
    typeof content === "string" &&
    /invoke\s+name\s*=\s*"/i.test(content) &&
    /parameter\s+name\s*=\s*"/i.test(content)
  );
}

// Injects .agent/repo_map.json, .agent/nav_map.json, and AGENT.md context
// into the system prompt. Exported purely for unit testing.
export function buildContextualSystemPrompt(
  agentName: string,
  config: AgentConfig,
  repoRoot: string,
  verifyOnly = false
): string {
  let persona = config.prompts.systemPersona;
  if (agentName === "EDITOR") persona = `${persona}\n\n${EDITOR_SYSTEM}`;
  if (agentName === "DISCOVERY") persona = `${persona}\n\n${DISCOVERY_SYSTEM}`;
  if (agentName === "ADVISOR") persona = `${persona}\n\n${ADVISOR_SYSTEM}`;
  // The Planner persona is the one that now runs through this loop too (the
  // other planner call sites in index.ts still call client.complete directly).
  // Injected here so a tool-enabled planning pass gets the exact same bounded-
  // inspection / contracts-not-code rules a plain planning call does, rather
  // than silently reverting to the generic persona. Both casings accepted:
  // callers historically pass uppercase persona names, the requirement is
  // phrased lowercase. verifyOnly swaps in PLANNER_VERIFY_SYSTEM instead —
  // see its own comment for why a "verify" intent needs a different planner
  // persona (scenarios to check, not files to change) rather than reusing
  // PLANNER_SYSTEM's implementation-decomposition rules unchanged.
  if (agentName === "PLANNER" || agentName === "planner") {
    persona = `${persona}\n\n${verifyOnly ? PLANNER_VERIFY_SYSTEM : PLANNER_SYSTEM}`;
  }

  // The tools the project already has (its test runner, its scripts), so an editing agent uses them and does not guess one that is not installed.
  if (agentName === "EDITOR" || agentName === "REPAIR") {
    const hint = toolsHint(repoRoot);
    if (hint) persona += `\n\n${hint}`;
  }

  // 1. Inject AGENT.md if present
  const agentMdPath = path.join(repoRoot, "AGENT.md");
  if (fsSync.existsSync(agentMdPath)) {
    try {
      const content = fsSync.readFileSync(agentMdPath, "utf-8");
      persona += `\n\n[PROJECT RULES & STACK CONVENTIONS (AGENT.md)]:\n${content}`;
    } catch {}
  }

  // 1b. UI work: the project's design system (when it has one) and the short craft rules. These are what keep
  // generated screens from looking generated: real icons not emoji, tokens not hard-coded colours, designed states.
  if (/^(EDITOR|REPAIR|REPAIR_PLANNER|PLANNER)$/i.test(agentName) && !verifyOnly) {
    try {
      const ds = designSystemForPrompt(repoRoot);
      if (ds) {
        persona +=
          "\n\n[DESIGN SYSTEM (design-system/MASTER.md) — binding for all user-facing UI. Build every screen, page and component from these tokens and rules. " +
          "If the app does not yet load design-system/tokens.css or tokens.ts (a global stylesheet, theme module or provider), the first UI phase wires them in before any screen uses them.]:\n" +
          ds;
      }
      if (/^(EDITOR|REPAIR)$/i.test(agentName)) {
        const stack = detectUiStack(repoRoot);
        if (stack.hasUi || ds) persona += "\n\n" + coreRulesBlock(stack.platform === "both" || stack.platform === "unknown" ? "unknown" : stack.platform);
      }
    } catch {
      // never block an agent on this
    }
  }

  // 1c. Security first: the rules for this project's languages and vendors go to whoever writes or fixes code.
  if (/^(EDITOR|REPAIR)$/i.test(agentName) && !verifyOnly && config.security?.enabled !== false) {
    const sec = securityForPrompt(repoRoot);
    if (sec) persona += "\n\n" + sec;
  }

  // 2. Inject .agent/repo_map.json to eliminate blind exploration
  // Planner receives ONE clean, alphabetically sorted, compact copy of repo_map and nav_map
  // in its initial user context (via readPlannerMetadata), so skip injecting them into
  // Planner's system prompt to avoid duplicate dumps and system-prompt cache busting.
  const isPlannerRole = agentName === "PLANNER" || agentName === "planner";
  const repoMapPath = path.join(repoRoot, ".agent", "repo_map.json");
  if (!isPlannerRole && fsSync.existsSync(repoMapPath)) {
    try {
      const raw = fsSync.readFileSync(repoMapPath, "utf-8");
      const map = JSON.parse(raw);

      // Deterministic zero-token cleanup: purge missing files
      let modified = false;
      for (const [key, val] of Object.entries<any>(map)) {
        if (!fsSync.existsSync(path.resolve(repoRoot, val.path))) {
          delete map[key];
          modified = true;
        }
      }
      if (modified) {
        fsSync.writeFileSync(repoMapPath, JSON.stringify(map, null, 2), "utf-8");
      }

      // Lean on purpose (the whole map is in every agent's prompt), with a flag
      // on an entry whose file changed since it was written: that entry may be
      // out of date, so read the file before relying on it.
      const shown = promptView(map, repoRoot, config.memory?.maxPromptEntries);
      const total = Object.keys(map).length;
      const more =
        total > Object.keys(shown).length
          ? `; showing the ${Object.keys(shown).length} most recently updated of ${total} — the rest are remembered and found by search or read tools`
          : "";
      persona += `\n\n[KNOWN ARCHITECTURE REPO MAP (an entry marked "stale": true was written before its file changed — read the file before relying on it${more})]:\n${JSON.stringify(shown, null, 2)}`;
    } catch {}
  }

  // 3. Inject .agent/nav_map.json — screen-to-screen navigation facts built
  // incrementally by register_screen_nav (Discovery, primarily) from actual
  // navigation code. Lets the Editor write an honest, concrete howToVerify
  // path even for a change that only touched one file and never explored
  // navigation itself, and gives QA's live screenshot-driven walk a head
  // start instead of guessing blind — it still confirms every step visually,
  // this only narrows what it tries first.
  const navMapPath = path.join(repoRoot, ".agent", "nav_map.json");
  if (!isPlannerRole && fsSync.existsSync(navMapPath)) {
    try {
      const raw = fsSync.readFileSync(navMapPath, "utf-8");
      const map = JSON.parse(raw);

      let modified = false;
      for (const [key, val] of Object.entries<any>(map)) {
        // Screens QA only ever saw at runtime have no source file to check.
        if (val?.source !== "observed" && !fsSync.existsSync(path.resolve(repoRoot, val.file))) {
          delete map[key];
          modified = true;
        }
      }
      if (modified) {
        fsSync.writeFileSync(navMapPath, JSON.stringify(map, null, 2), "utf-8");
      }

      if (Object.keys(map).length > 0) {
        persona +=
          `\n\n[KNOWN SCREEN NAVIGATION MAP]: built incrementally from actual navigation code, may be ` +
          `INCOMPLETE (a screen missing here just hasn't been recorded yet) — never treat an absence as ` +
          `proof a path doesn't exist, and never contradict what you can see yourself in code or on screen:\n` +
          `${JSON.stringify(map, null, 2)}`;
      }
    } catch {}
  }

  return persona;
}

export interface LabeledCompletionOptions {
  client: OpenRouterClient;
  models: string[];
  messages: ChatMessage[];
  agentName: string;
  jsonMode?: boolean;
  /** Hold the JSON reply to a schema where the model supports it (see CompleteOptions.structured); implies JSON mode elsewhere. */
  structured?: { name: string; schema: unknown };
  /** Make the model think first, at this effort (see CompleteOptions.reasoning). */
  reasoning?: "low" | "medium" | "high";
  /** Same meaning as AgentRunOptions' own retryOf/attempt/reason — set when
   *  this call is a corrective/retry pass of an earlier worker. */
  retryOf?: string;
  attempt?: number;
  reason?: string;
  /** A background check with no visible result: its worker is not shown on a phone (see events.ts's background). */
  background?: boolean;
  /** Part of planning, before the Planner runs (see events.ts's agent.start stage). */
  stage?: "planning";
}

/**
 * A bare, non-tool-calling model call (REPLAN, the Planner's overflow-
 * consolidation pass) wrapped with the same agent.start/agent.end lifecycle
 * runToolAgent gives every tool-calling persona below. Without this, these
 * calls are real planner-model work — genuine latency and cost — that a
 * paired phone never sees a worker card for at all, since nothing outside
 * runToolAgent emits that pair. Mirrors verifierTools.ts's QA, the other
 * non-tool-loop caller that already does this lifecycle by hand for the
 * same reason. Returns the extracted text content, centralizing the
 * "response shape varies by provider/route" narrowing every one of these
 * callers otherwise duplicated individually.
 */
export async function runLabeledCompletion(options: LabeledCompletionOptions): Promise<string> {
  const { client, models, messages, agentName } = options;
  const background = options.background ? { background: true } : {};
  const stage = options.stage ? { stage: options.stage } : {};
  events.emit({
    type: "agent.start",
    agent: agentName,
    models,
    ...background,
    ...stage,
    ...(options.retryOf ? { retryOf: options.retryOf, attempt: options.attempt, reason: options.reason } : options.reason ? { reason: options.reason } : {}),
  });
  try {
    const response = await client.complete(models, messages, {
      agent: agentName,
      ...(options.jsonMode ? { jsonMode: true } : {}),
      ...(options.structured ? { structured: options.structured } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    });
    const text =
      typeof response === "string"
        ? response
        : response?.content ?? response?.choices?.[0]?.message?.content ?? response?.message?.content ?? "";
    events.emit({ type: "agent.end", agent: agentName, rounds: 1, outcome: "completed", ...background });
    return typeof text === "string" ? text : "";
  } catch (err: any) {
    events.emit({ type: "agent.end", agent: agentName, rounds: 1, outcome: "error", ...background });
    throw err;
  }
}

export async function runToolAgent(options: AgentRunOptions): Promise<string> {
  if (!options.readStage) return runToolAgentConversation(options);
  options.onConversationStart?.();
  return options.agentTools.withReadStage(options.readStage, () => runToolAgentConversation(options));
}

async function runToolAgentConversation(options: AgentRunOptions): Promise<string> {
  const { prompt, client, config, agentTools, models, agentName, repo } = options;
  // REPAIR_PLANNER is a bounded, read-only diagnosis role: default to PLANNER_TOOLS_SCHEMA
  // when the caller omits `tools` rather than handing it the full 17-tool write/exec TOOLS_SCHEMA.
  let availableTools = options.tools ?? (agentName === "REPAIR_PLANNER" ? PLANNER_TOOLS_SCHEMA : TOOLS_SCHEMA);
  // The repair Planner diagnoses a failure from the evidence it is given and
  // can read the code. It must never hand the question to a person, who cannot
  // know what the harness saw. So it has no way to ask (see the refusal below).
  if (agentName === "REPAIR_PLANNER") {
    availableTools = availableTools.filter((t: any) => t?.function?.name !== "ask_user");
  }
  const repoRoot = options.repoRoot || (repo as any).repoRoot || process.cwd();

  const systemPersona = buildContextualSystemPrompt(agentName, config, repoRoot, options.verifyOnly ?? false);

  // The Planner is the newest (and only read-only-by-construction) persona to
  // run through this loop: it gets a two-tool schema and a hard 3-file
  // inspection budget enforced by AgentTools (see PLANNER_TOOLS_SCHEMA and
  // beginPlannerInspection), never the Editor's full tool set. `isPlanner`
  // gates every Planner-specific branch below so no other agent's behavior
  // changes. Both casings are accepted because callers historically pass
  // uppercase persona names ("EDITOR", "DISCOVERY") while the requirement is
  // phrased in lowercase ("planner").
  //
  // REPAIR_PLANNER shares every one of these branches: it is the same
  // bounded, read-only diagnosis role, just triaging a build/QA failure
  // instead of a fresh phase — same reason to exist (REPAIR otherwise gets
  // the Editor's full tool set including search_code/list_files with NO
  // inspection cap, and free-ranges through the repo trying to guess the
  // fix, which is what actually burns 8+ unproductive rounds before the
  // circuit breaker or attempt budget ends the pass). Diagnosis and fixing
  // are split into two passes the same way Discovery/Planner and Editor
  // already are for a fresh phase.
  const isPlanner = agentName === "PLANNER" || agentName === "planner" || agentName === "REPAIR_PLANNER";
  const isRepairPlanner = agentName === "REPAIR_PLANNER";

  const messages: any[] = [
    { role: "system", content: systemPersona },
    { role: "user", content: prompt },
  ];

  events.emit({
    type: "agent.start",
    agent: agentName,
    models,
    ...(options.retryOf ? { retryOf: options.retryOf, attempt: options.attempt, reason: options.reason } : options.reason ? { reason: options.reason } : {}),
    ...(options.exchangeId ? { exchangeId: options.exchangeId } : {}),
  });

  // agent.end used to only fire from a handful of specific exit points below
  // (the no-tool-call "completed" case, the circuit breaker, the two
  // turn-limit cases) -- every OTHER way out (conclude_task's
  // ALREADY_COMPLETED/TASK_CONCLUDED/CANNOT_LOCATE branches, an aborted run,
  // a model-call exception) never emitted one at all. A remote client keyed
  // on worker.start/worker.end pairing a client (correctly) cannot leave a
  // "worker" card open forever, so it falls back to closing it on
  // phase.end instead -- which works, but means an interrupted/escalated
  // pass never gets its own real completion signal. emitAgentEnd is the
  // single choke point every exit path below now goes through, and
  // endEmitted lets the try/finally safety net below know whether one of
  // them already fired, so an unanticipated path (another model exception,
  // anything added later) still can't leave agent.start unmatched.
  let endEmitted = false;
  const emitAgentEnd = (roundsSoFar: number, outcome: string) => {
    endEmitted = true;
    events.emit({
      type: "agent.end",
      agent: agentName,
      rounds: roundsSoFar,
      outcome,
      ...(options.exchangeId ? { exchangeId: options.exchangeId } : {}),
    });
  };

  // Console-only — every event.emit and usage-tracking call below keeps using
  // the plain agentName, so the token-usage-by-agent table stays grouped by
  // role regardless of which chain served a given phase. This is purely "no
  // surprises that a pricier model got used," visible right where the work
  // is actually happening.
  const displayName = options.visionMode ? `${agentName} - VISION` : agentName;

  // So a write/patch is logged under whoever is actually running — the same
  // AgentTools instance is reused across the EDITOR pass and every REPAIR pass.
  agentTools.setActiveAgent(displayName);

  // Surface the Planner's inspection budget up front, so "why did it stop
  // reading?" is answerable from the terminal rather than inferred from a
  // refusal a few rounds later. AgentTools is the enforcement point; this is
  // purely the human-visible half of the same policy.
  if (isPlanner) {
    const allowed = agentTools.plannerAllowedPaths();
    const budget = agentTools.plannerInspectionBudgetLeft();
    if (allowed.length === 0) {
      console.warn(
        `[${displayName}] ⚠️ No discovery target files were supplied — the Planner may still open any project ` +
          `file it can name, up to ${budget} file(s), but has nothing to start from.`
      );
    } else {
      console.log(
        `[${displayName}] 🔎 Bounded inspection: up to ${budget} file(s) of ${allowed.length} discovery target(s) — ` +
          `${allowed.join(", ")}`
      );
    }
  }

  let readOrSearchStreak = 0;
  let breakerTrips = 0;
  let emptyTurnNudges = 0;
  // Some providers occasionally fail to translate a model's own native
  // tool-call template into the structured tool_calls field, leaking the
  // raw, model-specific serialization into `content` as if it were a prose
  // answer instead — observed from deepseek-v4.1-flash via OpenRouter,
  // verbatim malformed tags like `<|DSML|invoke name="...">` where a real
  // tool call was clearly intended, shown directly to a user as ADVISOR's
  // "answer" with nothing to catch it (unlike EDITOR/REPAIR, which already
  // get an empty-turn nudge below — but only because they wrote no files,
  // not because anything recognized the content itself as malformed; every
  // OTHER agent, including ADVISOR, had no such safety net at all). See
  // looksLikeLeakedToolCall below for the detection and its own retry cap.
  let leakedToolCallNudges = 0;
  let advisorInspectionCalls = 0;
  let advisorBudgetMessageSent = false;
  let plannerBudgetMessageSent = false;
  let discoveryBudgetMessageSent = false;
  // Reads already sent to the model in this conversation, so the same file is not
  // sent in full again and again. Keyed by how many files have been written, so a
  // re-read after an edit (to check it) is allowed.
  const readMemo = new Set<string>();
  // Only what Discovery reads in THIS pass counts against its budget.
  const readBeforeThisPass = new Set(agentName === "DISCOVERY" ? agentTools.inspectedThisPhase() : []);
  const MAX_BREAKER_TRIPS = 2;
  // Raised from 8: a real multi-symbol wrong-API failure (several distinct
  // shared types/exports all guessed wrong at once — see buildWidenedScopeSection's
  // own comment for a real example) legitimately needs more than 8 reads to
  // diagnose, and the old threshold tripped the breaker mid-diagnosis on
  // exactly that class of failure, before a single edit was ever attempted.
  const CONSECUTIVE_INSPECTION_LIMIT = 14;
  let rounds = 0;
  // The Planner's whole job is bounded inspection then one JSON plan — an
  // unbounded round budget would let a confused pass turn planning into a
  // second discovery sweep. Capped well below the Editor's default. The FILE budget
  // (AgentTools.plannerMaxInspectedFiles, up to 10) is the real bound on how much it
  // may read; this only has to leave room for those reads plus the final plan.
  //
  // maxRoundsOverride (see its own doc comment) takes priority over all of
  // this when the caller supplied one — currently only REPAIR_PLANNER,
  // scaled by index.ts from how many blocking failures it's triaging.
  const maxRounds = options.maxRoundsOverride ??
    (agentName === "ADVISOR"
      ? Math.min(config.limits?.maxToolRounds ?? 40, 16)
      : isPlanner
        ? // Room for every file it may read (a round can read several) plus the plan.
          Math.min(config.limits?.maxToolRounds ?? 40, Math.max(12, agentTools.plannerInspectionBudgetLeft() + 4))
        : config.limits?.maxToolRounds ?? 40);
  const MAX_ADVISOR_INSPECTIONS = 12;

  // Wrapped from here (not reindented, to keep this diff reviewable — every
  // line below is unchanged in content and indentation) so the finally below
  // can guarantee emitAgentEnd fires exactly once no matter which of the
  // many return/throw paths inside actually gets taken.
  try {
  while (rounds < maxRounds) {
    rounds++;

    // Safe boundary: stop between rounds, never mid-write.
    runControl.throwIfAborted();

    const stopReason = options.stopWhen?.();
    if (stopReason) {
      console.log(`[${displayName}] ⏹ Stopped: ${stopReason}`);
      emitAgentEnd(rounds, "stopped");
      return `STOPPED: ${stopReason}`;
    }

    const response = await client.complete(models, messages, {
      tools: availableTools,
      toolChoice: "auto",
      agent: agentName,
    });

    const choice = response?.choices?.[0];
    const message = choice?.message || response?.message || response;
    messages.push(message);

    const toolCalls = message?.tool_calls || [];

    if (!toolCalls || toolCalls.length === 0) {
      // An editing agent that answers in prose with no tool call has not
      // finished — it has described work instead of doing it. Returning here
      // used to read as a clean "completed": the Editor would narrate a plan,
      // write nothing, and QA would then fail the phase for an empty tree
      // while Repair (same models, same tools) went on to patch the very same
      // files — proving the change was needed and simply never made.
      // Discovery/Advisor legitimately end in prose, so this is scoped to the
      // agents whose entire job is to produce edits, and bounded so a model
      // that truly has nothing to do can still get out.
      // Checked for EVERY agent, before the editing-only nudge below — a
      // leaked tool-call attempt is garbage regardless of whether this
      // agent's job is to edit files. Left unguarded, ADVISOR had nothing
      // else that would ever catch this: its final `return` a few lines
      // down hands the raw malformed text straight back as if it were a
      // real, read-for-the-user answer.
      if (looksLikeLeakedToolCall(message?.content) && leakedToolCallNudges < MAX_LEAKED_TOOL_CALL_NUDGES) {
        leakedToolCallNudges++;
        console.warn(
          `[${displayName}] ⚠️ Model emitted what looks like a tool-call attempt as plain text instead of ` +
            `a real tool call — asking it to retry properly (${leakedToolCallNudges}/${MAX_LEAKED_TOOL_CALL_NUDGES}).`
        );
        messages.push({
          role: "system",
          content:
            "[INTERVENTION] Your last response was not a valid tool call — it read as a tool-call attempt " +
            "written out as plain text instead of an actual function call. Use the real function-calling " +
            "mechanism to invoke the tool directly; do not describe or write out the call as text.",
        });
        continue;
      }

      const edits = EDITING_AGENTS.has(agentName) && agentTools.filesWrittenThisPhase().length === 0;
      if (edits && emptyTurnNudges < MAX_EMPTY_TURN_NUDGES) {
        emptyTurnNudges++;
        console.warn(
          `[${displayName}] ⚠️ Replied without calling a tool and has written nothing — ` +
            `prompting it to act (${emptyTurnNudges}/${MAX_EMPTY_TURN_NUDGES}).`
        );
        messages.push({
          role: "system",
          content:
            "[INTERVENTION] You produced no tool call and have not changed any file. Describing a change " +
            "is not making one. Call patch_file (or write_file for a genuinely new file) NOW to apply the " +
            "edit you just described. If the requirement is already fully satisfied by existing code, call " +
            "conclude_task(status='ALREADY_COMPLETED') and quote the exact existing lines that satisfy it. " +
            "If the referenced code does not exist anywhere, call conclude_task(status='CANNOT_LOCATE').",
        });
        continue;
      }

      emitAgentEnd(rounds, "completed");
      return message?.content || "";
    }

    for (const call of toolCalls) {
      const { name } = call.function;
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}

      // Orchestrator-level read tracking: the phase orchestrator's
      // ReadTracker observes every tool call through this hook — inspection
      // tools advance its read rounds, mutation tools reset them. This loop
      // keeps its own smaller in-loop breaker below; the hook is for the
      // A->B handoff policy, which must see the same calls the loop does.
      options.onToolCall?.(name, args);

      // The heal sandbox agent may call ONLY what it was offered. The dispatch below is by name alone, so a model that names a tool it was not
      // given (a command runner, a dependency install, a question to a person) would otherwise be run.
      if (agentName === "HEAL_SANDBOX" && !(options.tools ?? []).some((t: any) => t?.function?.name === name)) {
        messages.push({ role: "tool", tool_call_id: call.id, name, content: `Tool not available in this sandbox: ${name}. Use only the tools you were given.` });
        continue;
      }

      // Once Discovery's budget is spent its tools were removed, but a model
      // (or provider) can still send a call. Refuse it with the reason instead
      // of reading more, so the budget is real.
      if (agentName === "DISCOVERY" && discoveryBudgetMessageSent && name !== "conclude_task") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content:
            "Discovery's reading budget is spent. Nothing was read. Write your taskFindings and memory JSON now " +
            "from what you already have, and list what you could not confirm under uncertainties.",
        });
        continue;
      }

      if (
        agentName === "ADVISOR" &&
        ["read_file", "search_code", "list_files", "get_file_outline"].includes(name)
      ) {
        advisorInspectionCalls++;
        if (advisorInspectionCalls > MAX_ADVISOR_INSPECTIONS) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content:
              "Advisor read budget reached. Do not inspect more files; answer the user's question now " +
              "using the evidence already collected, and clearly label any remaining uncertainty.",
          });
          continue;
        }
      }

      // Early Exit Valve
      if (name === "conclude_task") {
        // The console gets the headline: the full note goes on to the verifier and the repair loop untouched, and the files it names
        // were already listed as they were patched, so a paragraph here only repeats them.
        const note = String(args.explanation ?? "").trim();
        const headline = note.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
        const clipped = headline.length > 160 ? `${headline.slice(0, 157)}…` : headline;
        // Said under the persona that is finishing, like every other line it prints, so it takes that persona's colour.
        const outcome =
          args.status === "FINISHED_PATCHING" ? "✔ Finished patching" : args.status === "ALREADY_COMPLETED" ? "✔ Already satisfied" : "⚠ Could not locate the change";
        console.log(`\n[${displayName}] ${outcome}${clipped ? ` — ${clipped}` : ""}\n`);

        if (args.status === "ALREADY_COMPLETED") {
          emitAgentEnd(rounds, "completed");
          return `TASK_ALREADY_SATISFIED: ${args.explanation}`;
        }
        if (args.status === "CANNOT_LOCATE") {
          emitAgentEnd(rounds, "escalated");
          throw new Error(`ESCALATION_NEEDED: ${args.explanation}`);
        }
        // "I finished patching" from an agent that has not written a single
        // file is a false claim, and the most expensive one in the pipeline:
        // it reads as a clean success, so the phase goes to QA with an
        // untouched tree, fails on "no file changes", and burns a whole
        // repair cycle doing the work the Editor was supposed to do. Refused
        // here and handed straight back, since the fix is simply to make the
        // edit it just said it made.
        if (
          EDITING_AGENTS.has(agentName) &&
          agentTools.filesWrittenThisPhase().length === 0 &&
          emptyTurnNudges < MAX_EMPTY_TURN_NUDGES
        ) {
          emptyTurnNudges++;
          console.warn(
            `[${displayName}] ⚠️ Claimed FINISHED_PATCHING without writing any file — ` +
              `sending it back to actually apply the change (${emptyTurnNudges}/${MAX_EMPTY_TURN_NUDGES}).`
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content:
              "REJECTED: you reported FINISHED_PATCHING but have not written to any file in this phase. " +
              "No change was applied, so nothing has been accomplished. Call patch_file now (or write_file " +
              "for a genuinely new file) to apply the edit described in the phase plan. If the requirement " +
              "is genuinely already satisfied by existing code, call conclude_task(status='ALREADY_COMPLETED') " +
              "and quote the exact existing lines that satisfy it.",
          });
          // continue, not break: any sibling tool call in this same turn still
          // needs its own tool response, or the next request is malformed.
          continue;
        }

        let sweepNote = "";
        // What the change left behind in the tests, found from its own diff. The Editor knows what it just removed; later stages only see a failing
        // assertion. Handed back once per distinct list (never in a loop), and not for a fix whose tests are the spec: there the test is right.
        if (EDITING_AGENTS.has(agentName) && args.status === "FINISHED_PATCHING" && !anyMustPass()) {
          const pending = agentTools.unseenTestReferences();
          if (pending) {
            console.log(`[${displayName}] 🔎 The change left tests naming what it removed or changed: sending it back to update them.`);
            messages.push({ role: "tool", tool_call_id: call.id, name, content: `NOT YET: ${pending}` });
            continue;
          }
        }

        // The tests its change can reach are run before it may conclude. One that the change made stale is sent back once for each distinct set of failures; what it
        // still cannot fix goes to the heal before QA (editorSweep.ts). Not for a fix whose tests are the spec, and never in a loop.
        if (EDITING_AGENTS.has(agentName) && args.status === "FINISHED_PATCHING" && !anyMustPass()) {
          const swept = await agentTools.affectedTestsCheck();
          if (swept?.kind === "bounce") {
            console.log(`[${displayName}] 🧪 The change breaks tests that passed before it: sending it back to bring them up to date.`);
            messages.push({ role: "tool", tool_call_id: call.id, name, content: `NOT YET: ${swept.message}` });
            continue;
          }
          if (swept?.kind === "clean" && swept.note) {
            sweepNote = swept.note;
            console.log(`[${displayName}] ✓ ${swept.note}`);
          } else if (swept?.kind === "handed") {
            sweepNote = swept.note;
            console.log(`[${displayName}] ⚠️ ${swept.note}`);
          }
        }

        // The Editor is the only agent that ever knows this for certain — it
        // just wrote the behavior. Folded into the marker section (parsed
        // back out by extractHowToVerify) rather than a separate return
        // value, since every other caller of runToolAgent still expects a
        // plain string back.
        const howToVerify = typeof args.howToVerify === "string" ? args.howToVerify.trim() : "";
        if (howToVerify) console.log(`[AGENT EXIT] How to verify: ${howToVerify}\n`);
        // Only IDs this agent was actually shown can be reported on; anything
        // else (a guessed or stale ID) is discarded by the sanitizer.
        const shownIds = [...String(options.phase?.instructions ?? "").matchAll(/\[(A\d{1,3})\]/gi)].map((m) => m[1]);
        const deltas = sanitizeAssertionDeltas(args.assertionDeltas, shownIds);
        for (const d of deltas) console.log(`[AGENT EXIT] Assertion ${d.id} ${d.action.toUpperCase()}: ${d.reason}`);
        emitAgentEnd(rounds, "completed");
        return (
          `TASK_CONCLUDED: ${args.explanation}${sweepNote ? ` (${sweepNote})` : ""}` +
          encodeAssertionDeltas(deltas) +
          encodeTestsNotNeeded(args.testsNotNeeded) +
          (howToVerify ? `${HOW_TO_VERIFY_MARKER}${howToVerify}` : "")
        );
      }

      events.emit({
        type: "tool.call",
        agent: agentName,
        tool: name,
        target: args?.path ?? args?.pattern ?? undefined,
      });

      let toolOutput = "";

      // --- Planner bounded inspection -------------------------------------
      // The Planner is offered PLANNER_TOOLS_SCHEMA (read_file, and
      // get_symbol_definition) rather than the full set. Both go through
      // AgentTools' own guards (assertPlannerFileAllowed), which reject any
      // path outside the discovery target list and any read past the 3-file
      // budget — enforced there rather than here, because that is also where
      // the allowed set is configured (beginPlannerInspection). Routed BEFORE
      // the generic branches below so a Planner read_file can never fall
      // through to the unbounded readFiles variant.
      try {
        if (isPlanner && name === "read_file") {
          const relPath = typeof args.path === "string" ? args.path : "";
          const startLine = typeof args.startLine === "number" ? args.startLine : undefined;
          const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
          const rangeNote = startLine !== undefined || endLine !== undefined ? ` (lines ${startLine ?? 1}-${endLine ?? "end"})` : "";
          console.log(`[${displayName}] 🔎 Reading discovery target: ${relPath || "(no path)"}${rangeNote}...`);
          toolOutput = await agentTools.readFileBounded(relPath, startLine, endLine);
        } else if (isPlanner && name === "get_symbol_definition") {
          const relPath = typeof args.path === "string" ? args.path : "";
          const symbol = typeof args.symbol === "string" ? args.symbol : "";
          console.log(`[${displayName}] 🔎 Locating symbol "${symbol}" in ${relPath || "(no path)"}...`);
          toolOutput = await agentTools.getSymbolDefinition(relPath, symbol);
        } else if (name === "ask_user" && agentName === "REPAIR_PLANNER") {
          toolOutput =
            "You cannot ask the user anything: they do not know what the harness saw. Diagnose from the failure text and the code you can read. " +
            "If something you need is missing from the failure text, say exactly what is missing and which command would show it, then give your best-supported diagnosis.";
        } else if (name === "ask_user") {
          toolOutput = await agentTools.askUser(args.question, typeof args.default === "string" ? args.default : undefined);
        } else if (name === "defer_question") {
          toolOutput = await agentTools.deferQuestion(args);
        } else if (name === "flag_manual_step") {
          toolOutput = await agentTools.flagManualStep(args);
        } else if (name === "register_component") {
          toolOutput = await agentTools.registerComponent(args);
        } else if (name === "register_qa_setup") {
          console.log(`[${displayName}] 🧪 Recording QA setup...`);
          toolOutput = await agentTools.registerQaSetup(args);
        } else if (name === "register_screen_nav") {
          console.log(`[${displayName}] 🗺️ Recording navigation for ${args.screen}...`);
          toolOutput = await agentTools.registerScreenNav(args);
        } else if (name === "read_file") {
          readOrSearchStreak++;
          const epoch = agentTools.writesSoFar();
          const keyOf = (p: string, a?: number, b?: number) => `${epoch}|${String(p).replace(/\\/g, "/")}|${a ?? ""}-${b ?? ""}`;
          const again = (list: string[]) =>
            `You already read ${list.join(", ")} in full earlier in this conversation (same range) and nothing has been edited since, so it is in your context above and is not sent again. ` +
            `If it was cut off, call read_file with that ONE path and startLine/endLine for the part you still need; otherwise move on.`;
          let paths: string[] | undefined = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : undefined;
          // The batch form has no range, so a one-file batch that names one IS a ranged read.
          if (paths && paths.length === 1 && (typeof args.startLine === "number" || typeof args.endLine === "number")) {
            args.path = paths[0];
            paths = undefined;
          }
          if (paths) {
            const fresh = paths.filter((p) => !readMemo.has(keyOf(p)));
            const repeated = paths.filter((p) => readMemo.has(keyOf(p)));
            if (fresh.length === 0) {
              toolOutput = again(repeated);
              console.log(`[${displayName}] ↩️ Already read, not sent again: ${repeated.join(", ")}`);
            } else {
              toolOutput = await agentTools.readFiles(fresh);
              fresh.forEach((p) => readMemo.add(keyOf(p)));
              if (repeated.length > 0) toolOutput += `\n\n[Not sent again: ${repeated.join(", ")} (already read earlier in this conversation).]`;
              const lines = toolOutput.split("\n").length;
              console.log(`[${displayName}] Read ${fresh.length} file(s): ${fresh.join(", ")} → ${lines} lines`);
            }
          } else {
            const startLine = typeof args.startLine === "number" ? args.startLine : undefined;
            const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
            const key = keyOf(args.path, startLine, endLine);
            if (readMemo.has(key)) {
              toolOutput = again([String(args.path)]);
              console.log(`[${displayName}] ↩️ Already read, not sent again: ${args.path}`);
            } else {
              toolOutput = await agentTools.readFile(args.path, startLine, endLine);
              readMemo.add(key);
              const lines = toolOutput.split("\n").length;
              const rangeNote = startLine !== undefined || endLine !== undefined ? ` (lines ${startLine ?? 1}-${endLine ?? "end"})` : "";
              console.log(`[${displayName}] Read file: ${args.path}${rangeNote} → ${lines} lines`);
            }
          }
        } else if (name === "search_code") {
          readOrSearchStreak++;
          // Forwarded straight through to grep's -i flag handling. Omitted
          // means the default (case-insensitive) — searchCode only treats
          // `true` as an explicit request for exact-case matching, and the
          // PCRE flag group in the pattern itself ((?i) / (?-i)) can still
          // override this in normalizeSearchPattern.
          const caseSensitive = args.caseSensitive === true;
          if (Array.isArray(args.patterns) && args.patterns.length > 0) {
            toolOutput = await agentTools.searchCodeMulti(args.patterns, args.path, caseSensitive);
            const summary = summarizeReadOnlyResult(toolOutput, "match", "matches", ["No matches found."]);
            // Kept as the exact same "Searched code with pattern" prefix the
            // single-pattern branch below uses — the phone UI groups consecutive
            // lookup lines into a collapsed summary row by matching that
            // literal text, and there's no reason a batched search shouldn't
            // fold into the same group.
            console.log(`[${displayName}] Searched code with pattern: ${args.patterns.map((p: string) => `"${p}"`).join(", ")} → ${summary}`);
          } else {
            toolOutput = await agentTools.searchCode(args.pattern, args.path, caseSensitive);
            const summary = summarizeReadOnlyResult(toolOutput, "match", "matches", ["No matches found."]);
            console.log(`[${displayName}] Searched code with pattern: "${args.pattern}" → ${summary}`);
          }
        } else if (name === "list_files") {
          readOrSearchStreak++;
          toolOutput = await agentTools.listFiles(args.path, args.recursive);
          const dirSummary = summarizeReadOnlyResult(toolOutput, "entry", "entries", ["No files found."]);
          console.log(`[${displayName}] Scanned directory: ${args.path || "."}${args.recursive ? " (recursive)" : ""} → ${dirSummary}`);
        } else if (name === "get_file_outline") {
          readOrSearchStreak++;
          if (Array.isArray(args.paths) && args.paths.length > 0) {
            toolOutput = await agentTools.getFileOutlines(args.paths);
            const summary = summarizeReadOnlyResult(toolOutput, "declaration", "declarations", ["No structural declarations identified."]);
            console.log(`[${displayName}] Outlined ${args.paths.length} file(s): ${args.paths.join(", ")} → ${summary}`);
          } else {
            toolOutput = await agentTools.getFileOutline(args.path);
            const summary = summarizeReadOnlyResult(toolOutput, "declaration", "declarations", ["No structural declarations identified."]);
            console.log(`[${displayName}] Outlined declarations in: ${args.path} → ${summary}`);
          }
        } else if (name === "patch_file") {
          readOrSearchStreak = 0;
          console.log(`[${displayName}] ✏️ Patching file: ${args.path}...`);
          toolOutput = await agentTools.patchFile(args.path, args.search, args.replace);
        } else if (name === "write_file") {
          readOrSearchStreak = 0;
          console.log(`[${displayName}] 📝 Writing file: ${args.path}...`);
          toolOutput = await agentTools.writeFile(args.path, args.content);
        } else if (name === "run_build_check") {
          // Deliberately does not touch readOrSearchStreak either way: this
          // is neither an inspection (so it must not silently paper over a
          // genuine stuck-reading streak by resetting it) nor a code edit
          // (so it must not get free credit as if progress was made) — a
          // call here simply leaves the streak exactly where it already was.
          console.log(`[${displayName}] 🔎 Running a build/typecheck self-check before concluding...`);
          toolOutput = await agentTools.runBuildCheck();
        } else if (name === "find_test_references") {
          // Read-only: neither an inspection nor an edit, so the read streak is left where it is.
          console.log(`[${displayName}] 🔎 Searching the tests for what this change removed or changed...`);
          toolOutput = agentTools.findTestReferences();
        } else if (name === "run_dependency_install") {
          // Same reasoning as run_build_check above: neither an inspection
          // nor an edit, so readOrSearchStreak is deliberately left untouched.
          console.log(`[${displayName}] 📦 Running a dependency install to verify this change...`);
          toolOutput = await agentTools.runDependencyInstall();
        } else if (name === "request_dependency") {
          // A read-only registry lookup; like run_build_check it is neither an
          // inspection nor an edit, so the read streak is left alone.
          console.log(
            `[${displayName}] 🔎 Verifying dependency: ${String(args.ecosystem ?? "?")}:${String(args.name ?? "?")}`
          );
          toolOutput = await agentTools.requestDependency(args);
        } else if (name === "run_project_command") {
          // Like run_build_check: neither an inspection nor an edit, so the
          // read streak is deliberately left where it is.
          console.log(`[${displayName}] ⚙️ Command requested: ${String(args.command ?? "").slice(0, 120)}`);
          toolOutput = await agentTools.runProjectCommand(args);
        } else if (name === "run_affected_tests" && EDITING_AGENTS.has(agentName)) {
          // A measurement, like run_test: neither an inspection nor an edit.
          console.log(`[${displayName}] 🧪 run_affected_tests`);
          toolOutput = await agentTools.runAffectedTests();
        } else if (name === "run_test") {
          // A measurement: neither an inspection nor an edit (ReadTracker classifies an unknown tool as "other"), so the read streak is left alone.
          console.log(`[${displayName}] 🧪 run_test ${String(args.file ?? "")}${args.namePattern ? ` -t "${String(args.namePattern).slice(0, 60)}"` : ""}`);
          toolOutput = await agentTools.runTest(args);
        } else if (name === "record_deviation") {
          console.log(`[${displayName}] 📝 record_deviation ${String(args.app ?? "").slice(0, 80)} vs ${String(args.spec ?? "").slice(0, 80)}`);
          toolOutput = await agentTools.recordDeviation(args);
        } else if (name === "stage_file_for_deletion") {
          // Staging is a mutation in every sense that matters here: the editor
          // has reached a terminal decision about the file (it should go)
          // rather than continuing to inspect it, so this ends the read streak
          // exactly like patch_file/write_file — matching ReadTracker's own
          // MUTATION_TOOLS classification. Nothing is unlinked: this only
          // records intent, and the user confirms every staged path in one
          // prompt at the end of the run.
          readOrSearchStreak = 0;
          console.log(`[${displayName}] 🗑️ Staging file for deletion: ${args.path}...`);
          toolOutput = await agentTools.stageFileForDeletion(args.path, args.reason);
        } else {
          toolOutput = `Unknown tool: ${name}`;
        }
      } catch (err: any) {
        // Mutation failures are the ones a developer watching the terminal
        // actually needs to see: a patch whose search block did not match
        // used to be reported only to the model as a tool result, so the run
        // looked like it was making progress while nothing changed on disk.
        if (name === "patch_file") {
          console.warn(`[${displayName}] ⚠️ Patch failed: ${err.message}`);
        }
        toolOutput = `Tool error on ${name}: ${err.message}`;
      }

      events.emit({
        type: "tool.result",
        agent: agentName,
        tool: name,
        ok: !toolOutput.startsWith("Tool error"),
        bytes: toolOutput.length,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: toolOutput,
      });

      if (
        agentName === "ADVISOR" &&
        advisorInspectionCalls >= MAX_ADVISOR_INSPECTIONS &&
        !advisorBudgetMessageSent
      ) {
        advisorBudgetMessageSent = true;
        availableTools = [];
        messages.push({
          role: "system",
          content:
            "[ADVISOR INTERVENTION] You have gathered enough repository evidence. Further lookup is disabled. " +
            "Answer the user's original question directly in the next response, distinguishing confirmed facts " +
            "from reasonable inferences and unknowns. Do not describe a future search.",
        });
      }

      // Discovery budget: enough reading, or enough rounds, and it must write
      // up what it has. Tools are removed so another search cannot even be
      // asked for, and the message restates the shape of the answer.
      if (agentName === "DISCOVERY" && !discoveryBudgetMessageSent) {
        const read = agentTools
          .inspectedThisPhase()
          .filter((f) => {
            if (readBeforeThisPass.has(f) || f.startsWith("search:")) return false;
            // Only real files count: a directory listing is not a file read.
            try {
              return fsSync.statSync(path.join(repoRoot, f)).isFile();
            } catch {
              return false;
            }
          }).length;
        if (read >= DISCOVERY_FILE_BUDGET || rounds >= DISCOVERY_ROUND_BUDGET) {
          discoveryBudgetMessageSent = true;
          availableTools = [];
          console.log(
            `[${displayName}] 🔒 Budget reached (${read} file(s) read, ${rounds} turn(s)) — writing up what was found.`
          );
          messages.push({
            role: "system",
            content:
              "[DISCOVERY INTERVENTION] Your reading budget is spent. No more tools. Write your final answer NOW from " +
              "what you have already read: the taskFindings JSON block (every existingFiles entry a file you actually " +
              "read, with the exact symbols and why it owns part of the change), then the memory JSON block. Anything " +
              "you could not confirm goes in taskFindings.uncertainties; do not guess and do not ask for more reading.",
          });
        }
      }

      // Planner budget surface: once the 3-file cap is spent, tell the Planner
      // in-band (and drop its tools entirely, so a further attempt cannot even
      // be expressed) that it must now emit the plan. AgentTools already
      // refuses a fourth path; this is what stops the Planner from wasting
      // rounds discovering that one refusal at a time.
      if (isPlanner && !plannerBudgetMessageSent && agentTools.plannerInspectionBudgetLeft() === 0) {
        plannerBudgetMessageSent = true;
        availableTools = [];
        console.log(
          `[${displayName}] 🔒 Inspection budget exhausted (${agentTools.plannerInspectedThisPass().length} file(s)) — ` +
            `planning from what has been seen.`
        );
        messages.push({
          role: "system",
          content: isRepairPlanner
            ? "[PLANNER INTERVENTION] Your file inspection budget is fully spent. No further read_file or " +
              "get_symbol_definition calls will be accepted. State your diagnosis and exact fix instructions now " +
              "from the evidence already in this conversation, and say plainly what you could not verify instead " +
              "of attempting another inspection."
            : "[PLANNER INTERVENTION] Your file inspection budget is fully spent. No further read_file or " +
              "get_symbol_definition calls will be accepted. Emit the complete JSON plan now from the evidence " +
              "already in this conversation, and record anything you could not verify in the plan's " +
              "\"assumptions\" array instead of attempting another inspection.",
        });
      }

      // Circuit breaker for repetitive inspection without modification.
      // This applies to every code-editing agent. REPAIR needs it MORE than
      // EDITOR, not less: a repair pass triggered by an environmental problem
      // has nothing to fix, so it will hunt through unrelated files forever.
      const isEditingAgent = agentName === "EDITOR" || agentName === "REPAIR";
      if (isEditingAgent && readOrSearchStreak >= CONSECUTIVE_INSPECTION_LIMIT) {
        breakerTrips++;
        console.warn(
          `[CIRCUIT BREAKER] ⚠️ ${displayName}: ${readOrSearchStreak} consecutive inspections without an edit ` +
            `(trip ${breakerTrips}/${MAX_BREAKER_TRIPS}).`
        );

        if (breakerTrips >= MAX_BREAKER_TRIPS) {
          console.warn(`[CIRCUIT BREAKER] 🛑 ${displayName} is not converging. Ending this pass.`);
          emitAgentEnd(rounds, "circuit_breaker");
          // Distinct from TASK_CONCLUDED: the caller (runPhaseWithHealing) uses this
          // prefix, combined with zero files written, to trigger a replan instead of
          // running a full QA + repair cycle against a tree nothing was ever written to.
          return `CIRCUIT_BREAKER_STUCK: ${displayName} stopped after ${breakerTrips} unproductive search cycles without locating an actionable change.`;
        }

        messages.push({
          role: "system",
          content:
            agentName === "REPAIR"
              ? "[INTERVENTION] You have inspected many files without making an edit. " +
                "Consider that the reported failure may be ENVIRONMENTAL rather than a code defect — " +
                "a missing emulator, an absent toolchain, or an unavailable display is NOT something you can fix by editing source. " +
                "An 'unresolved reference/symbol/module' error is NOT automatically environmental, even though it " +
                "is not attributable to a specific code defect you can point to yet: it commonly means a dependency " +
                "or plugin was never declared in the project's manifest file (build.gradle.kts, package.json, " +
                "requirements.txt, Cargo.toml, etc.) — editing that manifest to add the missing declaration IS a " +
                "legitimate code fix and IS related to the reported error, even though the compiler never names the " +
                "manifest file directly. Check it before concluding CANNOT_LOCATE. " +
                "If, after that check, the failure still is not attributable to a specific code defect, call " +
                "conclude_task(status='CANNOT_LOCATE', explanation='<why this looks environmental>'). " +
                "Do NOT edit files that are unrelated to the reported error."
              : "[INTERVENTION] You have inspected the files multiple times without making an edit. " +
                "Stop searching and APPLY THE CHANGE now — call patch_file (or write_file for a genuinely new file) " +
                "on the best candidate you have already read. A Planner decided this phase needs edits, so " +
                "concluding without one is a failed pass. " +
                "Only if the target file already contains code that FULLY satisfies the requirement, call " +
                "conclude_task(status='ALREADY_COMPLETED') and quote those exact existing lines in the explanation. " +
                "Only if the referenced code does not exist anywhere, call conclude_task(status='CANNOT_LOCATE').",
        });
        readOrSearchStreak = 0;
      }
    }
  }

  // Round budget exhausted without a clean conclusion. Giving up here with a
  // placeholder — what this used to do unconditionally — throws away every
  // finding, edit, or piece of reasoning the model produced across the whole
  // budget, no matter how close it was to a real answer. Advisor's own
  // inspection-budget nudge and Planner's own file-budget nudge already
  // solve exactly this by clearing `availableTools` and asking for a final
  // answer — but only when THEIR OWN counter trips with at least one round
  // still left to use it. If the round cap is what actually ends the loop
  // (their nudge fired too late, or never fired at all), there was no
  // recovery. This is that recovery, applied universally: one guaranteed
  // final call with tools stripped entirely, so the model cannot do
  // anything but answer in plain text — the same shape `runToolAgent`
  // already returns for a no-tool-call response in every other case.
  runControl.throwIfAborted();
  messages.push({
    role: "system",
    content:
      "[TURN LIMIT] Your tool-call budget for this task is exhausted — no more tools are available. " +
      "Respond now, in plain text, with your best answer or summary based on everything you have already " +
      "gathered or changed. Clearly state anything you could not finish, verify, or find, rather than " +
      "guessing or claiming more than you actually confirmed.",
  });
  try {
    const finalResponse = await client.complete(models, messages, { tools: [], toolChoice: "auto", agent: agentName });
    const finalMessage = finalResponse?.choices?.[0]?.message || finalResponse?.message || finalResponse;
    const finalContent = typeof finalMessage?.content === "string" ? finalMessage.content.trim() : "";
    if (finalContent) {
      emitAgentEnd(rounds, "turn_limit_recovered");
      return finalContent;
    }
  } catch (err: any) {
    console.warn(`[${displayName}] ⚠️ Forced final answer after the turn limit also failed: ${err?.message ?? err}`);
  }

  emitAgentEnd(rounds, "turn_limit");
  return `Turn limit of ${maxRounds} reached without complete task conclusion.`;
  } catch (err: any) {
    // Covers every exception path above that doesn't already call
    // emitAgentEnd itself — an aborted run (AbortedError, from
    // runControl.throwIfAborted()), a model-call failure, anything
    // unanticipated. Re-thrown unchanged: this only ever adds the missing
    // completion signal, never changes how the error itself is handled by
    // the caller (runPhaseWithHealing's own AbortedError/failure handling).
    if (!endEmitted) emitAgentEnd(rounds, err instanceof AbortedError ? "aborted" : "interrupted");
    throw err;
  } finally {
    // Last-resort safety net: a RETURN path above that forgot to call
    // emitAgentEnd (present-day paths all do; this guards anything added
    // later). Keeps the guarantee absolute regardless.
    if (!endEmitted) emitAgentEnd(rounds, "interrupted");
  }
}

/**
 * Persistent, append-only record of QA sign-offs a human never actually saw
 * live — because autonomous mode auto-accepted them instead of blocking.
 * Nothing here was silently dropped; it was deferred to whenever someone
 * next opens this file.
 */
export function appendQaReviewLog(repoRoot: string, phaseName: string, section: string, lines: string[]): void {
  if (lines.length === 0) return;
  const file = path.join(repoRoot, "QA_REVIEW.md");
  const isNew = !fsSync.existsSync(file);
  const header = isNew
    ? "# QA Review Log\n\nSign-offs auto-accepted during autonomous runs. Nothing here blocked the run — " +
      "review at your convenience and follow up on anything that looks wrong.\n"
    : "";
  const entry = `\n## ${new Date().toISOString()} — ${phaseName}\n\n### ${section}\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
  try {
    fsSync.appendFileSync(file, header + entry, "utf-8");
  } catch (err: any) {
    console.warn(`[QA REVIEW] ⚠️ Failed to write QA_REVIEW.md: ${err.message}`);
  }
}

// Resolution Gate: Called at the end of the pipeline before git commit
export async function resolveDeferredQuestions(
  repoRoot: string,
  phaseName: string,
  autonomous: boolean,
  onFixRequested?: (instructions: string) => Promise<void>
): Promise<void> {
  const qFile = path.join(repoRoot, ".agent", "pending_questions.json");
  if (!fsSync.existsSync(qFile)) return;

  let questions: PendingQuestion[] = [];
  try {
    questions = JSON.parse(fsSync.readFileSync(qFile, "utf-8"));
  } catch {
    return;
  }

  if (questions.length === 0) return;

  // Autonomous mode (or any non-interactive session, which has no choice
  // anyway) accepts every fallback rather than blocking — logged instead of
  // asked for live, so the decision is still visible, just not gating.
  if (autonomous || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\n[DECISIONS] ${questions.length} deferred decision(s); accepting fallbacks (autonomous).`);
    for (const q of questions) {
      console.log(`  - ${q.topic}: applied "${q.fallbackChosen}" in ${q.targetFile}`);
    }
    appendQaReviewLog(
      repoRoot,
      phaseName,
      "Deferred design decisions (fallback auto-applied)",
      questions.map((q) => `**${q.topic}** in \`${q.targetFile}\` — applied "${q.fallbackChosen}" (asked: ${q.question})`)
    );
    try { fsSync.unlinkSync(qFile); } catch {}
    return;
  }

  console.log(`\n[DECISIONS] ${questions.length} deferred decision(s) need your input:`);

  const overrides: string[] = [];

  for (const item of questions) {
    console.log(`\n${item.topic} — \`${item.targetFile}\` (fallback: "${item.fallbackChosen}")`);

    // Through the same funnel as every other question, so it has the answer deadline and the phone: nobody answering takes the fallback (an empty answer).
    const reply = await askAnywhere(
      { id: `deferred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind: "deferred", prompt: `Question: ${item.question}`, fallback: "", askedAt: new Date().toISOString() },
      `Question: ${item.question}\n(Press Enter to accept fallback, or type your preferred change): `
    );
    if (reply.trim().length > 0) {
      overrides.push(`In ${item.targetFile}: User decided: "${reply.trim()}" (replaces fallback: ${item.fallbackChosen})`);
    }
  }

  if (overrides.length > 0 && onFixRequested) {
    console.log("\nApplying final adjustments from your answers...");
    await onFixRequested(overrides.join("\n"));
  }

  // Clear pending questions after resolution
  try { fsSync.unlinkSync(qFile); } catch {}
}
