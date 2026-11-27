#!/usr/bin/env node
import path from "path";
import fs from "fs";
import process from "process";
import readline from "readline/promises";
import { emitKeypressEvents } from "node:readline";
import { execFile } from "child_process";
import { escapesProject, describeStagedDeletions } from "./deletionEvidence.js";
import { promisify } from "util";
import { AgentConfig } from "./config.js";
import { OpenRouterClient } from "./openrouter.js";
import { createRepoTools, RepoTools } from "./repoTools.js";
import { runToolAgent, runLabeledCompletion, resolveDeferredQuestions, appendQaReviewLog, extractHowToVerify } from "./agentLoop.js";
import { promptOnce as sharedPromptOnce } from "./terminalPrompt.js";
import {
  AssertionDelta,
  ASSERTION_DELTAS_MARKER,
  extractAssertionDeltas,
  renderDeltasForGoal,
} from "./assertionAudit.js";
import {
  TESTS_NOT_NEEDED_MARKER,
  clearFocusFiles,
  extractTestsNotNeeded,
  finalizeFocusTests,
  registerFocusFiles,
  renderFocusOutcomes,
  renderTestGuidance,
  renderTestsNotNeededForGoal,
  runFocusedTests,
  isTestPath,
  isFocusPath,
} from "./focusTests.js";
import { winSafeCommand } from "./capabilities.js";
import { neutralizeLegacyQuarantine } from "./quarantine.js";
import { YES_NO, YES_NO_ENTER_NO, YES_NO_ENTER_YES, parseYesNo } from "./promptStyle.js";
import { renderTestabilityRequest, triageUnreachableStates } from "./testability.js";
import { attributeTestFailure, renderTestDebtSection } from "./failureAttribution.js";
import { answerFromProject, verifyQuestionsFromCode } from "./questionVerify.js";
import { mergeUnique, renderUserDocuments, resolveReferenceDir, userNamedFiles } from "./userFiles.js";
import { runDesign } from "./designer.js";
import { openRenderer } from "./svgRender.js";
import { ensureDesignSystem } from "./uiDesign.js";
import { stageDesignImage } from "./designDelivery.js";
import { parseLenient } from "./jsonRepair.js";
import { splitJobs, unplannedJobs } from "./jobsList.js";
import { healTests, renderHealReport, failingTestFiles, failureText, fixItemsFor, importedSources } from "./testHeal.js";
import { failureOutOfReach, describeOutOfReach, type OutOfReach } from "./outOfReach.js";
import { HEAL_REPLY_STRUCTURED } from "./healSchema.js";
import { sandboxFor, securityReviewCall } from "./healSandbox.js";
import { renderLog, runSuiteLogged } from "./testLog.js";
import { fixTaskFor, isFixTask, savePendingFixes, loadPendingFixes, settlePendingFixes } from "./testSettle.js";
import { directFixFor, setMustPass } from "./directFix.js";
import { taskQuestionMode, isNewProject } from "./questionScope.js";
import { parseCodeRefs, resolveOnDisk, type CodeRef } from "./codeContext.js";
import { WorkerLedger, announces, workerLine, totalsLine, breakdownLines, phaseWorkersLine } from "./workerLedger.js";
import { checkExistence, existencePlannerSection, renderExistence, JUDGE_SYSTEM, JUDGE_WHOLE_SYSTEM, JUDGE_COMBINE_SYSTEM } from "./existence.js";
import { roadmapCompleteAnswer, cacheKey, readCache, writeCache, newTally, countCall, renderTally } from "./existenceSupport.js";
import { type Intent, parseIntentReply, routeFacts } from "./routeIntent.js";
import { ensureThreatModel, securityModels } from "./securityPlan.js";
import { makeCommandReviewer } from "./commandReview.js";
import { makePanel, pickJudges } from "./commandPanel.js";
import { EditorSweep, healerFor } from "./editorSweep.js";
import { confidenceSummary, pipelineVerdict, type PhaseConfidence } from "./phaseConfidence.js";
import { makePackageNotes } from "./conventionPackages.js";
import { addDesignFollowUps } from "./designFollowUps.js";
import { panelReviewerFor } from "./securityPanel.js";
import { isScratchPath } from "./scratch.js";
import { runSecurityAudit } from "./securityAudit.js";
import { existingDirOnly, existingFilesOnly, projectLayout, renderLayout } from "./projectLayout.js";
import { compactRepoMapView, loadRepoMap, recordConfirmedFindings } from "./repoMap.js";
import { describeSync, syncRepoMap } from "./repoMapSync.js";
import { buildPhaseProgress, renderProgressNote, PhaseProgress } from "./progressNote.js";
import { archiveFinishedRoadmap, attachTaskToUnit, builtByUnits, loadRoadmap, nextUnits, onRoadmapChanged, progress as roadmapProgress, renderRoadmap, roadmapWire, saveRoadmap } from "./roadmap.js";
import {
  FlowDeps,
  MAX_UNIT_ATTEMPTS,
  ROADMAP_HELP,
  absorbOverflow,
  recordFollowUp,
  absorbUncovered,
  changeRoadmap,
  checkDrift,
  createRoadmap,
  describeDrift,
  failUnit,
  finishUnit,
  manualUpdate,
  parseRoadmapCommand,
  commandFromIntent,
  RoadmapCommand,
  resetRoadmap,
  startNext,
} from "./roadmapFlow.js";

// What Discovery found for the task now running. It is written to the feature
// index only once the whole task passes (see finish(true)), never before.
let pendingFeatureRecord: { task: string; output: string } | undefined;
// Every file the task's phases changed, so the repo map can be re-derived from them.
const taskTouchedFiles = new Set<string>();
// What each finished phase of this task changed, for the next phase's brief.
let taskProgress: PhaseProgress[] = [];
// The roadmap unit the running task is, if it is one: marked done when the task passes.
let activeUnitId: string | undefined;
// How many verification runs the last phase took (1 = it passed first time, N = N-1 repair attempts). Set by runPhaseWithHealing; read for phase.end.
let lastPhaseRuns = 1;
// The QA confidence of the last phase that passed (verified, partial or static-only); undefined for a phase with no verdict. Set by runPhaseWithHealing; read for phase.end.
let lastPhaseConfidence: string | undefined;
let currentTaskBaseSha: string | undefined;
// The folder a "program" request named as the app or code to rebuild from, if any.
let programReferenceHint: string | null = null;
// What the classifier decided about the roadmap, when the message was about it.
let roadmapIntent: { action: unknown; request: unknown } | null = null;
// Documents the classifier judged the request refers to ("the brief", "my spec"),
// checked to be real files. They reach the Planner as if they had been named.
let turnDocuments: string[] = [];
// What the code already has for this request (set when the request is classified, used once by the Planner).
let existenceSection = "";
// The line-numbered places existence verified (file and lines): put into Discovery's prompt, never re-read.
let existenceRefs: CodeRef[] = [];

/** Prints what a repo-map re-derivation changed; silent when nothing did. */
function logMapSync(result: ReturnType<typeof syncRepoMap>, heading: string): void {
  const lines = describeSync(result);
  if (lines.length === 0) return;
  console.log(`[MEMORY] 🧭 ${heading}`);
  for (const l of lines) console.log(`   • ${l}`);
}
import { renderShortlist, shortlistFromMap, withImportedNeighbors } from "./mapShortlist.js";
import { buildStallDirectivePrompt, candidateTargets, namedTargets, renderPlannerDirective } from "./targetPick.js";
import { reconcileMemoryWithDisk } from "./memoryHealth.js";
import {
  AutonomousVerifier,
  VerificationResult,
  HOW_TO_VERIFY_GOAL_MARKER,
  isUiUnreachableNote,
  isToolingFailure,
  describeToolingFailure,
  reportsNoTestsFound,
  extractReferencedFilePaths,
  looksLikeMissingDependency,
  dependencyManifestHint,
  dependencyManifestCandidatePaths,
  buildFailureSnippet,
  QA_USAGE_SUBROLES,
} from "./verifierTools.js";
import {
  failureSignature, isVisualOnlyFailure, evaluateRepairProgress, failuresUnrelatedToChange, buildWidenedScopeSection, computeRepairPlannerMaxRounds,
  extractPitfallSummary, shouldSkipRepairPlannerOnFirstAttempt,
} from "./repairPolicy.js";
import { AgentTools, plannerReadBudget, READ_ONLY_TOOLS_SCHEMA, PLANNER_TOOLS_SCHEMA, REPAIR_PLANNER_WIDENED_TOOLS_SCHEMA, DISCOVERY_TOOLS_SCHEMA, TOOLS_SCHEMA, REPAIR_RUN_TEST_TOOL, ManualStep } from "./agentTools.js";
import { testTierContext } from "./repairTestContext.js";
import { repairRunTestFor, REPAIR_RUN_TEST_NOTE } from "./repairRunTest.js";
import { extractTaskFindings, extractDiscoveryTargetFiles, parseDiscoveryJson, recoverDiscoveryOutput } from "./discoveryParsing.js";
import { DISCOVERY_FILE_BUDGET, DISCOVERY_ROUND_BUDGET } from "./agentLoop.js";
import { mergeLiveRules, mergeArchitectureRules, mergeTechStack } from "./memoryRules.js";
import { DISCOVERY_SYSTEM, INTENT_SYSTEM, SETUP_SYSTEM, buildConsolidationPrompt } from "./prompts.js";
import { CommandApprovals, describeCommand } from "./commandPolicy.js";
import { prepareSetupContext, loadProjectContext, CONTEXT_FILE } from "./projectContext.js";
import { detectProject, describeProfile } from "./projectProfile.js";
import { runSetupPhase, parseSetupDiagnosis, buildSetupDiagnosisPrompt, manifestEditsForbidden } from "./setupPhase.js";
import {
  parseArgs, printHelp, cmdConfigList, cmdConfigGet, cmdConfigSet,
  cmdInit, cmdDoctor, promptOrDefault, isInteractive, needsSetup,
} from "./cli.js";
import { resolveConfig, locateConfigFile, writeSetting, clearSetting } from "./settings.js";
import { globalConfigPath } from "./globalConfig.js";
import { type SpecialistCommand, type SpecialistChoice, unsetRoles, shouldAsk, hasBeenAsked, markAsked, promptLines, specialistChoices, fallbackHint } from "./specialistPrompt.js";
import { PERSONAS, Persona, unsetLabel, candidatesFor, chainProblem, fetchCatalog, formatModel, roleInfoWire, type CatalogModel } from "./models.js";
import { p as wizard, answered, canRunWizard, withExclusiveStdin, WizardCancelled, ESC_HINT } from "./wizard/prompts.js";
import { checkKey, describeKey, looksLikeOpenRouterKey, maskKey, sanitize, spendLimitWarning } from "./wizard/keyCheck.js";
import { pickChain, roleRow, roleColumnWidth } from "./wizard/modelPicker.js";
import { storeApiKey } from "./secrets.js";
import { RunLock, describeHeldLock } from "./runLock.js";
import { events, formatTokens, UsageReport } from "./events.js";
import { usageLedger, toUsageWire, renderLedger } from "./usageLedger.js";
import { diffStore } from "./diffStore.js";
import { RemoteSession, SessionLimitError } from "./remote/client.js";
import { buildSessionHello } from "./remote/hello.js";
import { PendingQuestion, RemoteStatus } from "./remote/protocol.js";
import { translateForRemote } from "./remoteEventTranslator.js";
import { PlannerStage } from "./plannerStage.js";
import { logLocal, isLocalOnly } from "./localLog.js";
import {
  readHistoryBacklogForReplay,
  readHistoryBacklogSince,
  readHistoryBacklogSinceEventId,
  readTaskEvents,
  listTasks,
  reconcileInterruptedTask,
} from "./remote/historyLog.js";
import { buildRemovalCommand } from "./cleanupCommand.js";
import { runControl, AbortedError, askAnywhere, askChoice, setQuestionExplainer, setAnswerDeadline, setAssumptionRoot, setTimeoutResolver } from "./remote/control.js";
import { makeTimeoutResolver } from "./questionResolver.js";
import { plainWordsFor } from "./plainWords.js";
import { commitOnly } from "./gitCommit.js";
import { mergeRedTestPhases, describeRedTestMerge } from "./redTestMerge.js";
import { terminalView, isVerbose, setVerbose, setStatusAvailable, wrapForTerminal } from "./consoleView.js";
import { composeStatus, enterStep, liveCallCount, resetStep, stepActive } from "./liveCalls.js";
import { installPersistentInput, registerLiveCommands, printAbove, writeRawAbove, pauseInput, resumeInput, setStatusLine, setModelStrip, hasPinnedInput, openPanel, refreshPanel } from "./terminalInput.js";
import { ModelQueue } from "./modelQueue.js";
import { ModelPanel } from "./modelPanel.js";
import { provisionRelay, RelayUnavailable, ProvisionedRelay } from "./remote/autoRelay.js";
import { executeLinkFlow, getValidProToken, remotePromptBlocker } from "./remote/auth.js";
import { loadApiKey, describeBackend, detectStaleEnvKey } from "./secrets.js";
import {
  Attachment, AttachmentError, loadAttachments, describeAttachments,
  buildUserContent, hasImages,
} from "./attachments.js";
import {
  Plan, PlannedPhase, PlanResult, parsePlan, renderProgress, validatePlan,
  phaseInstructions, phaseVerificationGoal, MAX_PLAN_PHASES,
  questionsToAsk, lintAssumptions, mentionsSpec, ASSUMPTION_CONFIRM_OPTION, lintTargetFiles, missingTargetAssumptions,
  looksEssential, decideWithoutAsking, describeDecision, defaultAnswerFor, QuestionDecision, QuestionMode,
} from "./planner.js";
import {
  lintPlanVerification, applyVerificationQuality, VerificationIssue,
} from "./verificationBullets.js";
import { readNavMap } from "./navGraph.js";
import {
  runEditorWithHandoff,
  handleDependencyInstallGate,
  handlePostPhaseDependencies,
  runInstallCommand,
  runInstallCommandCaptured,
  detectChangedManifests,
  resolveAbsoluteInstallPlan,
  LOCK_FILE_NAMES,
  runDependencyInstallCheck,
  verifyAndFixNpmVersions,
  buildMandatoryTargetConstraint,
  buildPlannerReformulationPrompt,
  decideEditorFailureAction,
  formatEscalationSummary,
  ESCALATE_TO_USER,
  buildApprovalPromptLine,
  parseApprovalAnswer,
} from "./orchestrator.js";
import {
  ResumeState, saveResumeState, loadResumeState, loadPhaseRepairContext, savePhaseRepairContext,
} from "./resumeState.js";
import { saveTaskQueue, loadTaskQueue } from "./taskQueue.js";
import { saveLastFailure, loadLastFailure, clearLastFailure } from "./lastFailure.js";
import { detectCommandTypo } from "./commandTypo.js";
import { toAnsi, stripAnsi, colorizeRoleTag } from "./richText.js";
import { linkifyFilePaths } from "./terminalLinks.js";
import { parseContinueAnswer } from "./continueAnswer.js";
import { rollUpAgentUsage, phaseUsageWire, type PhaseUsageWire } from "./usageWire.js";
import { collectChangeSet } from "./staticQa.js";
import { readPushPreference, writePushPreference, detectOrigin, verifyOriginAccess, parsePushDenial, describePushDenial, PushPreference } from "./gitRemote.js";
import { sanitizeBranchName, currentBranch, listBranches, switchToBranch, detectDefaultBranch, mergeBranch, resolveMergeTarget, resolveMergeSource } from "./gitBranch.js";

const execFileAsync = promisify(execFile);

/** A task not completing — a phase exhausting its repair budget, empty
 *  instructions, a bad attachment, an unusable model/attachment combo — is an
 *  expected outcome, not a crash. Thrown instead of calling process.exit()
 *  directly so it unwinds through the same per-task catch that already
 *  handles AbortedError, and gets the same "return to the prompt instead of
 *  ending the whole session" treatment in an interactive run (see
 *  loopsBackToPrompt below). */
class TaskFailedError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "TaskFailedError";
  }
}

interface TaskPhase {
  name: string;
  instructions: string;
  allowedPaths?: string[];
  /** The plan's own file list — the paths this phase is expected to touch, so
   *  the post-phase dependency gate can ask the working tree whether any of
   *  them is a dependency manifest whose diff really changed the dependency
   *  set. Optional because a degraded single-phase plan carries no file list. */
  files?: string[];
  /** What the verifier should confirm; defaults to the instructions. */
  verificationGoal?: string;
  /** The plan's own phase id — lets repair history survive a --resume across
   *  process restarts (see PhaseRepairContext below). Omitted only by
   *  degraded single-phase plans, which have nothing to resume into anyway. */
  id?: string;
  /** The phases after this one and their files: a failure whose fix belongs to one of them is out of this phase's reach (outOfReach.ts). */
  laterPhases?: { name: string; files: string[] }[];
}

interface CodebaseMemory {
  shortDescription: string;
  techStack: string[];
  architectureRules: string[];
  liveRules: string[];
  historicalPitfalls: string[];
  totalRuns: number;
  lastRunDate: string;
  /**
   * Manual steps flagged in past runs (apply a migration, set a cloud
   * secret, etc.) that nothing has since confirmed as done. Surfaced to
   * Discovery each run so it can check whether the user's own message says
   * one is now resolved — see DISCOVERY_SYSTEM and resolvedManualSteps.
   */
  pendingManualSteps: ManualStep[];
}

function readPlannerMetadata(repoRoot: string, blockedDirs?: string[], maxPromptEntries?: number): string {
  const metadata: Record<string, unknown> = {};

  // 1. repo_map: ONE clean, alphabetically sorted, compact copy with volatile fields stripped.
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".agent", "repo_map.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const compact = compactRepoMapView(parsed, maxPromptEntries);
      if (Object.keys(compact).length > 0) metadata.repo_map = compact;
    }
  } catch {
    // Metadata is advisory. A missing or malformed cache must not block planning.
  }

  // 2. nav_map: alphabetically sorted, volatile timestamps stripped.
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".agent", "nav_map.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sortedNav: Record<string, unknown> = {};
      for (const key of Object.keys(parsed).sort((a, b) => a.localeCompare(b))) {
        const entry = parsed[key];
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const { lastUpdated: _lu, observedAt: _oa, ...rest } = entry as Record<string, unknown>;
          sortedNav[key] = rest;
        } else {
          sortedNav[key] = entry;
        }
      }
      if (Object.keys(sortedNav).length > 0) metadata.nav_map = sortedNav;
    }
  } catch {
    // Advisory.
  }

  // 3. codebase-memory: reconciled with disk, omitting liveRules (rendered separately in plannerPrompt)
  //    and volatile per-run counters.
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".agent", "codebase-memory.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      reconcileMemoryWithDisk(parsed, repoRoot, blockedDirs);
      const { liveRules: _lr, lastRunDate: _lrd, totalRuns: _tr, ...rest } = parsed as Record<string, unknown>;
      metadata["codebase-memory"] = rest;
    }
  } catch {
    // Advisory.
  }

  return JSON.stringify(metadata, null, 2);
}

// extractTaskFindings / extractDiscoveryTargetFiles now live in
// discoveryParsing.ts (see that file's own doc comment for why) — imported
// alongside this file's other imports.

/**
 * Ask exactly one question on the terminal, then close the interface.
 *
 * Now that a session loops back to the prompt after a successful run instead
 * of exiting, two readline.Interface lifecycles can run back-to-back within
 * the same process for the first time ever — e.g. the "press Enter to accept
 * visual state" prompt immediately followed by the next "yimpim > " prompt.
 * That sequence has produced a terminal that stops accepting any keystroke
 * at all (not even Ctrl+C) until forced. Forcing stdin back to a known-good,
 * flowing, non-raw state before handing it to a fresh Interface is the
 * defensive fix, whatever Node/Windows-console interaction actually causes
 * the previous Interface's close() to leave it looking paused.
 *
 * Delegates to terminalPrompt.ts's implementation, which also folds a
 * multi-line paste into one answer instead of splitting it on every embedded
 * newline — see that file for why that matters for exactly this back-to-back
 * scenario (a paste's unread tail is what was leaking into the NEXT prompt).
 */
const promptOnce = sharedPromptOnce;

/** Wraps detectCommandTypo with the console.log side effect index.ts's
 *  dispatch chain wants — see commandTypo.ts for why this is caught before
 *  task classification at all. Returns true when it handled the input. */
function handleLikelyCommandTypo(trimmed: string): boolean {
  const result = detectCommandTypo(trimmed);
  if (!result) return false;
  console.log(result.message);
  return true;
}

function printHelpMenu(): void {
  console.log(`
Press Tab after typing a command's start (e.g. "/mo") to complete it.

  /remote-control   Pair your phone — sets up everything and shows a QR code
  /link             Link this machine to YIMPIM Pro (cloud-tunnel lease)
  /model            Change the model for any role (Planner, Editor, Verifier, Designer, Security, ...)
  /model-sort       How OpenRouter picks a backend per call (default/throughput/price/latency)
  /api-key          Rotate your OpenRouter key (desktop only)
  /ask              Ask a question, read-only — nothing gets changed
  /status           Models, settings and readiness for this repo
  /usage [n]        Lifetime tokens and cost on this machine — by worker and
                    model, plus your last n tasks (default 5) by phase
  /approvals        Commands you approved for this project, with /approvals
                    revoke <n|all> to forget them
  /plan             The current plan
  /tests log        When each test last ran green or red, and which are unchanged since (what /tests heal skips)
  /tests heal       Bring a red test suite back to green: one worker per failing test file, all at once. Out-of-date tests are updated;
                    one that cannot be is rewritten or removed (with its snapshot and every reference); a real code defect is sent
                    to the normal pipeline to fix (a test file is removed afterwards only if nothing in it passes; one that fails in part is kept)
  /pentest          Security audit of this project: code, git history and packages (read-only; nothing is attacked)
  /design <what>    Make a logo, favicon and app icons: several models propose
                    and draw concepts, the best are shown, you pick one
                    (or just say "I need a logo"); also critiques or refreshes
                    a logo you already have
  /design critique ui [references…] [--screens images…]
                    Look at this app's screens (and any references you like:
                    image paths, URLs, product names) and write
                    design-system/CRITIQUE.md. Changes no code.
  /design polish ui [all | 1,3,5] [--include-conflicts]
                    Make the critique's changes as a normal task, then compare
                    the screens before and after (critique/POLISH.md)
  /roadmap          A big job split into units, tracked until it is done:
                    /roadmap new <idea>, /roadmap port <folder> <goal>,
                    /roadmap run, /roadmap add <more>, /roadmap drop|reopen|done
                    <id>, /roadmap open <id> <note>, /roadmap sync, and
                    /roadmap reset (keeps a copy of what was finished)
                    (or just say "continue the roadmap")
  /push-repo       Connect this project to a GitHub remote (asking for a repo
                    URL if none is set yet) and push to it now — also how you
                    turn auto-push back ON after /push-local turned it off
  /push-local       Commit anything pending and turn auto-push OFF — future
                    phases commit locally only, even if a remote is configured
  /branch <name>    Create (or switch to) a branch for trying something risky
                    separately — commits pending work to the current branch
                    first, then branches off from that clean state. You can
                    also just say it in plain language, e.g. "on a new branch
                    called api-delays, try the GO API instead of email"
  /branches         List branches in this repo, current one marked
  /merge [branch]   Merge a source branch (default: the current one) into the
                    default branch. You can also use the default branch name
                    or "default" to explicitly merge the current branch into
                    it. Never resolves conflicts automatically.
  /memory           What YIMPIM has learned about this repo
  /stop             Stop safely at the next boundary — works at any time,
                    including while a task is running (same as Esc, or the
                    phone's Stop button)
  /continue         Resume the last plan a Stop (phone, /stop, or Esc)
                    interrupted. Skips Discovery/
                    Planning for phases already done; only the interrupted
                    phase re-runs.
  /help             This list
  /exit             Quit

Or just type what you want done, e.g.
  add a logout button to the settings screen
`);
}

function printStatus(repoRoot: string, config: AgentConfig, memory: CodebaseMemory): void {
  // Visual QA (screenshot navigation + the visual audit) runs on its own chain
  // when verifierVision is set — see AutonomousVerifier's getVisualVerifierModels.
  // Printing the base verifier alone would hide which models actually ever see a
  // screenshot, so the line only appears when a separate chain is configured.
  const verifierVision = config.models.verifierVision;
  const verifierVisionLine =
    verifierVision && verifierVision.length > 0
      ? `\nVerifier Vision Models: ${verifierVision.join(", ")}`
      : "";
  console.log(`
--- 📊 Current YIMPIM Status ---
Target Repo: ${repoRoot}
Planner Models: ${config.models.planner.join(", ")}
Editor Models: ${config.models.editor.join(", ")}
Verifier Models: ${config.models.verifier.join(", ")}${verifierVisionLine}
Provider Sort: ${config.provider.sort}
Total Runs: ${memory.totalRuns}
Active Rules: ${memory.liveRules.length} recorded
Pitfalls Tracked:${memory.historicalPitfalls.length} recorded
------------------------------
`);
}

/**
 * A summary, not a dump. codebase-memory.json accumulates across every run
 * against a repo — `console.log(JSON.stringify(memory))` used to print the
 * whole thing verbatim, which meant a repo with a long history could flood
 * the terminal (and any paired phone watching the same output) with
 * thousands of lines for what's meant to be a quick "what does YIMPIM know
 * about this repo" check. Shows the parts someone actually reads at a
 * glance, and points at the file itself for anyone who genuinely wants the
 * complete JSON.
 */
function printMemory(memory: CodebaseMemory, memoryFile: string): void {
  console.log(`\n--- 🧠 Codebase Memory ---`);
  console.log(`Total runs: ${memory.totalRuns}${memory.lastRunDate ? ` (last: ${memory.lastRunDate})` : ""}`);
  if (memory.shortDescription) console.log(`Overview: ${memory.shortDescription}`);
  if (memory.techStack.length > 0) console.log(`Tech stack: ${memory.techStack.join(", ")}`);

  if (memory.architectureRules.length > 0) {
    console.log(`\nArchitecture rules (${memory.architectureRules.length}):`);
    for (const r of memory.architectureRules) console.log(` - ${r}`);
  }
  if (memory.liveRules.length > 0) {
    console.log(`\nActive live rules (${memory.liveRules.length}):`);
    for (const r of memory.liveRules) console.log(` - ${r}`);
  }
  if (memory.pendingManualSteps.length > 0) {
    console.log(`\nPending manual steps (${memory.pendingManualSteps.length}):`);
    for (const s of memory.pendingManualSteps) console.log(` - ${s.step}`);
  }
  // Pitfalls are kept for the model's own context, not really for a human to
  // skim — a count is enough here, the file has the full text if wanted.
  console.log(`\nHistorical pitfalls tracked: ${memory.historicalPitfalls.length}`);

  console.log(`\nFull JSON: ${memoryFile}`);
  console.log(`--------------------------\n`);
}

/** The current [primary, backup?] chain for every configured role, in the shape
 *  `model.config` sends over the wire — shared by the initial push and the
 *  confirmation push after a `set_model` that was actually accepted. */
function currentModelConfig(config: AgentConfig): { role: Persona; chain: string[] }[] {
  return PERSONAS.map((p) => ({ role: p.key, chain: config.models[p.key] ?? [] }));
}

/**
 * `list_models` — the remote equivalent of `/model`'s own catalog fetch +
 * filter step. Can be slow (a live OpenRouter call); the caller doesn't
 * await this, it fires and the phone gets `model.catalog` (or
 * `model.catalog_unavailable`) whenever it resolves.
 */
async function listModelsForRemote(
  role: Persona,
  exclude: string[] | undefined,
  session: RemoteSession
): Promise<void> {
  const persona = PERSONAS.find((p) => p.key === role);
  if (!persona) {
    session.pushModelCatalogUnavailable(role, `Unknown role "${role}".`);
    return;
  }
  const { key: apiKey } = loadApiKey();
  if (!apiKey) {
    session.pushModelCatalogUnavailable(role, "No API key configured on this desktop — run `yimpim setup` first.");
    return;
  }
  try {
    const catalog = await fetchCatalog(apiKey);
    let options = candidatesFor(catalog, persona);
    if (exclude && exclude.length > 0) {
      const excluded = new Set(exclude);
      options = options.filter((m) => !excluded.has(m.id));
    }
    session.pushModelCatalog(
      role,
      options.map((m) => ({
        id: m.id,
        pricing:
          m.promptCost === null || m.completionCost === null
            ? null
            : { promptPerM: m.promptCost, completionPerM: m.completionCost },
        isFree: m.promptCost === 0 && m.completionCost === 0,
        isVariablePrice: m.promptCost === null || m.completionCost === null,
        contextLength: m.contextLength,
        supportsVision: m.supportsVision,
        supportsTools: m.supportsTools,
      }))
    );
  } catch (err: any) {
    session.pushModelCatalogUnavailable(role, `Could not reach OpenRouter: ${err.message}`);
  }
}

/**
 * `set_model` — the remote equivalent of `/model`'s persistence step. Refuses
 * (via `command.refused`, never a silent no-op) rather than applying the
 * change when: the role is unrecognized, a task is actively RUNNING (safe
 * while idle or genuinely paused on a pending question), or the chain is
 * empty for one of the four roles that can never be left unset. An empty
 * chain for an optional vision role instead clears it back to unset —
 * writeSetting alone can't represent that (the schema's "unset" is the key
 * being ABSENT, not `[]`), hence clearSetting.
 */
function setModelFromRemote(
  role: Persona,
  chain: string[],
  config: AgentConfig,
  repoRoot: string,
  session: RemoteSession
): void {
  const refuse = (reason: string) => session.push("command.refused", { verb: "set_model", reason });

  const persona = PERSONAS.find((p) => p.key === role);
  if (!persona) {
    refuse(`Unknown role "${role}".`);
    return;
  }
  if (session.runState === "running") {
    refuse("Can't change models while a task is running — wait for it to finish or stop it.");
    return;
  }
  if (chain.length === 0 && !persona.optional) {
    refuse(`${persona.label} can't be left unset — pick at least a primary model.`);
    return;
  }
  const problem = chainProblem(persona, chain);
  if (problem) {
    refuse(problem);
    return;
  }

  const target = locateConfigFile(repoRoot) ?? globalConfigPath();
  try {
    if (chain.length === 0) {
      clearSetting(target, `models.${role}`);
      (config.models as Record<Persona, string[] | undefined>)[role] = undefined;
    } else {
      writeSetting(target, `models.${role}`, chain);
      config.models[role] = chain;
    }
  } catch (err: any) {
    refuse(err.message);
    return;
  }

  console.log(`[REMOTE] 📱 ✓ ${persona.label}: ${chain.join("  →  ") || "unset"} (written to ${target})`);
  session.pushModelConfig(currentModelConfig(config), locateConfigFile(repoRoot) ? "project" : "global", roleInfoWire());
}

/**
 * /model — change one persona's model chain without re-running the whole
 * setup wizard. Reuses setup's own picker (same search, same cost display,
 * same current-marked entry) so this behaves exactly like first-run setup
 * would for that one role.
 */
/**
 * /api-key — rotate the OpenRouter key without redoing the whole setup
 * wizard. Desktop-only: this is deliberately never reachable from a paired
 * phone, since a lost or compromised phone silently redirecting the key
 * used for billing is a real risk in a way that watching logs is not.
 *
 * The new key is verified against OpenRouter before anything is persisted,
 * the same "test then commit" order setup itself uses, so a typo never
 * overwrites a working key with a broken one.
 */
/**
 * The moment free-text `instructions` is set, execution used to fall straight
 * into discovery/plan/edit with no way to just answer something. This gates
 * that: a cheap classification, and if it really is just a question, a
 * read-only pass that answers it and returns — never touching discovery,
 * the planner, or a single file. Returns true when it handled `text` as a
 * question (the caller must NOT treat it as task instructions), false when
 * it is a task and the caller should proceed exactly as before.
 */
/** One line telling the classifier whether a roadmap exists and how far along it is. */
function roadmapStateLine(repoRoot: string): string {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return "Roadmap: none.";
  const pr = roadmapProgress(rm);
  return `Roadmap: exists ("${rm.goal.slice(0, 120)}"), ${pr.done} of ${pr.total} units done.`;
}

// The last report-only audit: so "lets work on what existence found" on the next prompt knows what was found.
let lastAudit: { request: string; report: string } | null = null;
// Set by the router for the request being handled: it carries on from the audit report just given.
let intentFollowsAudit = false;

// The request last checked and how many of the things it asks for are not built yet (null: not known).
let existenceChecked: { text: string; remaining: number | null } | null = null;

/**
 * Before anything is planned: what does this request ask for that the code already has? Sets existenceSection for the
 * Planner (only the partial and missing work is planned) and returns "handled" when everything is already built.
 */
async function checkWhatExists(text: string, client: OpenRouterClient, config: AgentConfig, repoRoot: string, reportOnly = false): Promise<"handled" | "task"> {
  if (!config.existence.enabled) return "task";
  // Already checked this very request (the program question asks first): the Planner section is still set, do not pay twice.
  if (existenceChecked?.text === text) return "task";
  existenceChecked = { text, remaining: null };
  try {
    const docs = renderUserDocuments(mergeUnique(userNamedFiles(text, repoRoot), turnDocuments), repoRoot);
    let shortlist: string[] = [];
    try {
      shortlist = shortlistFromMap(text, loadRepoMap(repoRoot), 8, repoRoot).map((s) => s.path);
    } catch {
      shortlist = [];
    }
    // An audit with no document named falls back to the active roadmap's own brief: "are we done with the roadmap?"
    const roadmapBrief = reportOnly && !docs ? loadRoadmap(repoRoot)?.brief : undefined;
    // A finished roadmap whose code has not changed since its last unit answers "what is left?" from its own record: no model is asked.
    if (reportOnly && !docs) {
      const quick = roadmapCompleteAnswer(repoRoot);
      if (quick) {
        console.log("\n✅ [EXISTS] " + quick.text);
        lastAudit = { request: text.slice(0, 3000), report: quick.text };
        return "handled";
      }
    }
    // The same question about the same code as an earlier check: its result, with no model call.
    const cKey = cacheKey(repoRoot, text, docs || roadmapBrief);
    const cached = readCache(repoRoot, cKey);
    const tally = newTally();
    // The first look at each requirement is made by a cheaper model; the planner's model settles what that does not, and checks a sample.
    const cheapModels = config.existence.tiered === false ? [] : (config.models.existence ?? config.models.discovery);
    const useCheap = cheapModels.length > 0 && cheapModels.join("|") !== config.models.planner.join("|");
    const counted = (tier: "cheap" | "strong", models: string[]) => async (messages: any[]): Promise<string> => {
      const out = await runLabeledCompletion({ client, models, messages: messages as any, agentName: "EXISTENCE", jsonMode: true, reason: reportOnly ? "Checking the work against the document" : "Checking what already exists" });
      const sys = String(messages[0]?.content ?? "");
      const label = sys === JUDGE_WHOLE_SYSTEM ? "whole-file" : sys === JUDGE_COMBINE_SYSTEM ? "combine" : sys === JUDGE_SYSTEM ? "judge" : "extract";
      countCall(tally, label, tier, messages.map((m) => String(m?.content ?? "")).join(""), out);
      return out;
    };
    if (cached) console.log("[EXISTS] Same question, same code as the last check: showing that result (no model was asked).");
    const found = cached ?? await checkExistence({
      call: counted("strong", config.models.planner),
      ...(useCheap ? { cheapCall: counted("cheap", cheapModels) } : {}),
      repoRoot,
      request: text,
      docs: docs || (roadmapBrief ? `The roadmap's brief:\n${roadmapBrief}` : docs),
      audit: reportOnly,
      onRequirements: (n) => console.log(`[EXISTS] Found ${n} requirement${n === 1 ? "" : "s"} in the document. Checking all of them against the code at once…`),
      shortlist,
      maxRequirements: config.existence.maxRequirements,
      built: builtByUnits(repoRoot),
      exclude: [loadRoadmap(repoRoot)?.reference?.dir ?? ""],
    });
    if (!cached) {
      writeCache(repoRoot, cKey, found);
      const tallied = renderTally(tally);
      if (tallied) console.log(tallied);
    }
    if (found.applies) {
      console.log("\n🔎 [EXISTS] Checked what this asks for against the code (each quote below was verified in the file):\n" + renderExistence(found));
      if (reportOnly && !found.allBuilt) {
        const manual = found.items.filter((i) => i.verdict === "manual").length;
        const checkable = found.items.length - manual;
        const left = found.items.filter((i) => i.verdict !== "built" && i.verdict !== "manual").length;
        console.log(
          `\n📋 [EXISTS] ${checkable - left} of ${checkable} checkable requirements are already in the code; ${left} still need work or a closer look.${manual ? ` ${manual} more are manual steps for a person, which the code cannot show.` : ""} Nothing was planned or changed, as you asked. ` +
            'To build them, ask again without "before we work": for example "finish what is left in <the brief>". The check runs again and only those are planned.'
        );
        existenceSection = existencePlannerSection(found);
        existenceRefs = found.excerpts ?? [];
        existenceChecked = { text, remaining: left };
        lastAudit = { request: text.slice(0, 3000), report: renderExistence(found).slice(0, 8000) };
        return "handled";
      }
      if (found.allBuilt) {
        console.log('\n✅ [EXISTS] Everything asked for is already in the code, so nothing was built. Say "verify it" to run the checks on it, or tell me what differs from what you expected.');
        return "handled";
      }
      existenceSection = existencePlannerSection(found);
      existenceRefs = found.excerpts ?? [];
      existenceChecked = { text, remaining: found.items.filter((i) => i.verdict !== "built" && i.verdict !== "manual").length };
    } else if (found.note) {
      console.log("[EXISTS] " + found.note);
    } else if (reportOnly) {
      console.log("[EXISTS] I could not turn that request into things to check against the code, so nothing was compared. Name the document (for example reference/timeline-port/EXPO_PORT_BRIEF.md) and ask again.");
      return "handled";
    }
  } catch (err: any) {
    console.log("[EXISTS] Skipped the check of what already exists: " + String(err?.message ?? err).slice(0, 100));
  }
  return "task";
}

async function answerIfQuestion(
  text: string,
  client: OpenRouterClient,
  config: AgentConfig,
  repo: RepoTools,
  repoRoot: string,
  agentTools: AgentTools,
  memory: CodebaseMemory,
  memoryFile: string,
  forced = false,
  pendingAttachments: string[] = [],
  advisorMemory: { last?: { question: string; answer: string } } = {}
): Promise<"handled" | "task" | "verify" | "program" | "roadmap" | "design" | "pentest" | "tests" | "audit"> {
  let intent: Intent = forced ? "question" : "task";
  intentFollowsAudit = false;
  let branchName: string | null = null;
  turnDocuments = [];
  roadmapIntent = null;
  programReferenceHint = null;

  if (!forced) {
    try {
      // Pending manual steps ride along on every classification call, not
      // just Discovery's — a message that never reaches Discovery at all
      // (a plain question, git_review, a branch/merge command) would
      // otherwise never get the chance to confirm one is resolved. Cheap:
      // this list is normally empty or a handful of short lines.
      const pendingStepsBlock =
        memory.pendingManualSteps.length > 0
          ? `Pending manual steps:\n${memory.pendingManualSteps.map((s) => `- ${s.step}`).join("\n")}\n\n`
          : "";

      const response = await client.complete(
        config.models.discovery,
        [
          { role: "system", content: INTENT_SYSTEM },
          {
            role: "user",
            content:
              `Context about the project (not part of the request):\n${roadmapStateLine(repoRoot)}\n\n` +
              `${routeFacts({ numberedJobs: splitJobs(text).jobs.length, lastAuditRequest: lastAudit?.request })}` +
              `${renderLayout(projectLayout(repoRoot))}${pendingStepsBlock}The request:\n${text}`,
          },
        ],
        // Labeled "DISCOVERY" (its own model chain already, reused here),
        // not a separate "intent" bucket — this call always runs BEFORE
        // currentTaskUsageStart is reset for the new task (if any), so it
        // never counts toward any task's own usage either way; this only
        // changes which row the lifetime/session summary folds its tiny
        // cost into, from an orphan "intent" row into DISCOVERY's.
        { jsonMode: true, agent: "DISCOVERY" }
      );
      const content =
        typeof response === "string"
          ? response
          : response?.content ?? response?.choices?.[0]?.message?.content ?? "{}";
      // The router's own answer is the route. An unusable reply is a plain task (the fail-open default used everywhere here).
      const parsed = parseIntentReply(content);
      intent = parsed.intent;
      intentFollowsAudit = parsed.followsLastAudit && lastAudit !== null;
      // The model picked these from what it was shown; only what is really on
      // disk is kept, so a made-up path is dropped and never used.
      turnDocuments = existingFilesOnly(repoRoot, parsed?.documents, 4);
      roadmapIntent = intent === "roadmap" ? { action: parsed?.roadmapAction, request: parsed?.roadmapRequest } : null;
      programReferenceHint =
        intent === "program"
          ? existingDirOnly(repoRoot, parsed?.reference) ??
            (typeof parsed?.reference === "string" && parsed.reference.trim() ? parsed.reference.trim().slice(0, 200) : null)
          : null;
      if (reconcileResolvedManualSteps(memory, parsed?.resolvedManualSteps)) {
        saveCodebaseMemory(memoryFile, memory);
      }
      if (typeof parsed?.branch === "string" && parsed.branch.trim()) {
        branchName = parsed.branch.trim();
      }
    } catch (err: any) {
      console.log(`[ROUTER] Could not work out what that asks for (${String(err?.message ?? err).slice(0, 80)}), so it is treated as a task.`);
    }
  }

  // "Review/commit/clean up what's already uncommitted" has no business going
  // through Discovery/Planner/Editor at all — none of them have a git tool,
  // so a request like this used to get reinterpreted as some vague code-edit
  // task and could touch files that were never part of what's actually
  // sitting uncommitted. Route it at the exact same classification point a
  // pure question already gets routed at, straight to the real thing.
  // A message that only informs (a status report, text pasted from elsewhere)
  // asked for nothing: running the build pipeline on it would invent a task,
  // and routing it to Advisor would answer a question nobody asked. Say so in
  // one line and stop. The line names the way out, because a misread is the
  // only way this goes wrong and it must never be silent.
  if (intent === "note") {
    console.log(
      `\n📝 [NOTED] This reads as information, not a request, so I did nothing with it. ` +
        `If you wanted me to act on it, say what to do (for example "implement that" or "check that").`
    );
    return "handled";
  }

  if (intent === "git_review") {
    await reviewAndResolvePendingChanges(repo, repoRoot, client, config);
    return "handled";
  }

  // Same reasoning for "create/switch to a branch, nothing else" — no editor
  // tool can do this either, so let through it would just waste a full
  // discovery/plan/edit pass on an instruction none of those stages can act on.
  if (intent === "branch_only") {
    if (branchName) {
      await handleBranchSwitch(repo, repoRoot, client, config, branchName);
    } else {
      console.log(`[GIT] Couldn't tell which branch you meant — try: /branch <name>`);
    }
    return "handled";
  }

  // Same reasoning again — a branch merge is a git operation with no editor
  // tool behind it, so route it straight to the real thing rather than
  // wasting a full discovery/plan/edit pass on an instruction none of those
  // stages can act on. branchName here means "merge FROM" (null = whichever
  // branch is currently checked out, same default /merge itself uses).
  if (intent === "merge_only") {
    await handleMerge(repo, repoRoot, client, config, branchName ?? undefined);
    return "handled";
  }

  // A task (or a verify) that also names a branch happens THERE instead of
  // whatever's currently checked out — switch before discovery/planner/
  // editor ever see it, so every commit this turn produces lands on the
  // right branch, not on whatever was checked out when the session started.
  if ((intent === "task" || intent === "verify") && branchName) {
    const switched = await handleBranchSwitch(repo, repoRoot, client, config, branchName);
    if (!switched) return "handled"; // bad name or failed switch — stop here rather than run on the wrong branch
  }

  if (intent === "verify") return "verify";
  // Too big for one task: the caller offers a roadmap. Or it is about the roadmap itself.
  if (intent === "program") {
    existenceChecked = null;
    existenceSection = "";
    existenceRefs = [];
    return "program";
  }
  if (intent === "roadmap") return "roadmap";
  if (intent === "design") return "design";
  if (intent === "pentest") return "pentest";
  if (intent === "tests") return "tests";
  // An audit reports what is done and what is left and builds nothing. The caller runs it as a job of its own, so its cost is counted.
  if (intent === "audit") return "audit";
  if (intent !== "question") {
    existenceSection = "";
    existenceRefs = [];
    existenceChecked = null;
    // Before anything is planned: what does this ask for that the code already has? Only the rest is built.
    if (intent === "task" && (await checkWhatExists(text, client, config, repoRoot)) === "handled") return "handled";
    return "task";
  }

  // A screenshot attached alongside "what do you think of this screen?" used
  // to be completely invisible to ADVISOR — only the planner ever received
  // attachments (buildUserContent, elsewhere), so a question asked about an
  // attached image got answered from source code alone, never the picture.
  // Best-effort: any failure here just falls back to the text-only prompt
  // that already worked, since a question deserves an answer even if the
  // attachment can't be used for it.
  let prompt: string | any[] = text;
  if (pendingAttachments.length > 0) {
    try {
      const loaded = await loadAttachments(pendingAttachments, repoRoot);
      const images = loaded.filter((a) => a.kind === "image");
      if (images.length > 0 && (await modelSupportsVision(config.models.discovery[0]))) {
        prompt = buildUserContent(text, images);
      }
    } catch (err: any) {
      console.warn(`[ADVISOR] ⚠️ Could not attach reference image(s): ${err.message}`);
    }
  }

  console.log(`\n💬 [ADVISOR] Answering — read-only, nothing will be changed…`);
  // Links this exchange's advisor.start/advisor.answer and its ADVISOR
  // worker.start/end pair (see AgentRunOptions.exchangeId) — minted here,
  // before either end of the exchange has been emitted.
  const exchangeId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Emitted before the agent runs, so a client can open an "Advisor" card
  // immediately instead of only learning about the exchange once the
  // answer is already in hand.
  events.emit({ type: "advisor.start", exchangeId, question: text });
  const answer = await runToolAgent({
    prompt,
    repo,
    repoRoot,
    client,
    config,
    agentTools,
    models: config.models.discovery,
    agentName: "ADVISOR",
    tools: READ_ONLY_TOOLS_SCHEMA,
    exchangeId,
  });
  console.log(`\n${answer}\n`);
  // A paired phone otherwise only ever sees this as an untagged `log` line,
  // indistinguishable from the advisor's own tool-call activity above it —
  // its own event gives a client the exact text instead of guessing which
  // line was the actual answer. Emitted after runToolAgent resolves, so it
  // arrives on the wire after the advisor's own agent.end/"worker.end".
  events.emit({
    type: "advisor.answer",
    question: text,
    answer: typeof answer === "string" ? answer : String(answer),
    exchangeId,
  });
  // Available for the NEXT turn to splice into a task's instructions if that
  // turn turns out to be one ("let's do your suggestions") rather than
  // another question — see the call site.
  advisorMemory.last = { question: text, answer: typeof answer === "string" ? answer : String(answer) };
  return "handled";
}

/**
 * /api-key: replace the OpenRouter key. Typed masked, checked live, and only then saved; a rejected or cancelled key leaves the
 * working one exactly as it was. The wizard screen writes to the terminal directly, so nothing here reaches a paired phone.
 */
async function changeApiKey(client: OpenRouterClient): Promise<void> {
  if (!canRunWizard()) {
    console.log("Changing the key needs an interactive terminal. Run `yimpim setup` on one, or set OPENROUTER_API_KEY.");
    return;
  }
  try {
    await withExclusiveStdin(async () => {
      const entered = answered(
        await wizard.password({
          message: `New OpenRouter API key  ${ESC_HINT}`,
          mask: "•",
          validate: (v) => (v && v.trim() ? undefined : "Paste your key, or press Esc to cancel."),
        })
      ).trim();
      if (!looksLikeOpenRouterKey(entered)) {
        const useIt = answered(await wizard.confirm({ message: "That doesn't look like an OpenRouter key (they start with sk-or-). Use it anyway?", initialValue: false }));
        if (!useIt) {
          wizard.log.info("Nothing changed. Your previous key is still active.");
          return;
        }
      }
      const s = wizard.spinner();
      s.start("Checking the new key with OpenRouter");
      const result = await checkKey(entered);
      if (!result.ok) {
        s.error(result.reason);
        wizard.log.info("Nothing changed. Your previous key is still active.");
        return;
      }
      s.stop(`Key works: ${describeKey(result.info)}`);
      const warn = spendLimitWarning(result.info);
      if (warn) wizard.log.warn(warn);

      const backend = storeApiKey(entered);
      client.setApiKey(entered);
      wizard.log.success(`Key ${maskKey(entered)} saved to ${describeBackend(backend)} and applied: the next model call uses it.`);

      // loadApiKey() reads the environment before the credential store, so a stale value left in the shell would keep winning.
      if (process.env.OPENROUTER_API_KEY) {
        wizard.log.warn(
          [
            "OPENROUTER_API_KEY is also set in this shell, and it takes priority over the key just saved.",
            "Future runs from this shell keep using the OLD value until it is cleared:",
            "  Windows (PowerShell): Remove-Item Env:OPENROUTER_API_KEY",
            "  macOS/Linux:          unset OPENROUTER_API_KEY",
          ].join("\n")
        );
      }
    });
  } catch (err: any) {
    if (err instanceof WizardCancelled) console.log("Cancelled. Nothing changed.");
    else console.log(`Cancelled. Nothing changed. (${sanitize(err?.message ?? String(err))})`);
  }
}

/**
 * /model: change the model for one role, or with `preselect` go straight to that role (the specialist-model question uses it).
 * Picked from the whole catalog the role can use, written to the same file `yimpim config set` would write, and applied to the
 * rest of this session at once.
 */
async function changeModel(config: AgentConfig, repoRoot: string, preselect?: Persona): Promise<void> {
  if (!canRunWizard()) {
    console.log("Changing models needs an interactive terminal. Use `yimpim config set models.<role> <model-id>` instead.");
    return;
  }
  try {
    await withExclusiveStdin(async () => {
      const role: Persona =
        preselect ??
        answered(
          await wizard.select<Persona>({
            message: `Which role?  ${ESC_HINT}`,
            maxItems: 14,
            options: PERSONAS.map((p) => ({
              value: p.key,
              // One column width for every role, and long chains wrap at a "→" under their own first model, not at the left margin.
              label: roleRow(p.label, config.models[p.key], unsetLabel(p, (k) => PERSONAS.find((x) => x.key === k)?.label ?? k), {
                columns: process.stdout.columns || 80,
                labelWidth: roleColumnWidth(PERSONAS.map((x) => x.label)),
                reserve: p.optional ? " (optional)".length : 0,
              }),
              hint: p.optional ? "optional" : undefined,
            })),
          })
        );
      const persona = PERSONAS.find((p) => p.key === role)!;

      const { key: apiKey } = loadApiKey();
      if (!apiKey) {
        wizard.log.error("No API key available. Run `yimpim setup` first.");
        return;
      }
      const s = wizard.spinner();
      s.start("Loading the models your key can reach");
      let catalog: CatalogModel[];
      try {
        catalog = await fetchCatalog(apiKey);
      } catch (err: any) {
        s.error(`Could not load the model list: ${sanitize(err?.message ?? String(err), apiKey)}`);
        return;
      }
      const options = candidatesFor(catalog, persona);
      s.stop(`${options.length} models can serve ${persona.label}`);
      if (options.length === 0) {
        wizard.log.warn(`No model your key can reach can serve ${persona.label}.`);
        return;
      }

      wizard.log.message(persona.blurb + (persona.volume === "high" ? "  High volume: this choice drives your bill." : ""));
      const existingChain = config.models[persona.key] ?? [];
      const chain = await pickChain(persona, options, existingChain);
      if (!chain) {
        if (existingChain.length === 0) {
          wizard.log.info(`${persona.label} left unset. Nothing changed.`);
          return;
        }
        // An optional role cleared on purpose ("Leave unset (clear it)").
        const target = locateConfigFile(repoRoot) ?? globalConfigPath();
        clearSetting(target, `models.${persona.key}`);
        (config.models as Record<Persona, string[] | undefined>)[persona.key] = undefined;
        wizard.log.success(`${persona.label} cleared; it uses its fallback again. Written to ${target}.`);
        return;
      }

      // Same file precedence as `yimpim config set`: a project's own config wins over the global one.
      const target = locateConfigFile(repoRoot) ?? globalConfigPath();
      writeSetting(target, `models.${persona.key}`, chain);
      config.models[persona.key] = chain;
      wizard.log.success(`${persona.label}: ${chain.join("  →  ")}\nWritten to ${target}. The next task in this session uses it.`);
    });
  } catch (err: any) {
    if (err instanceof WizardCancelled) console.log("Cancelled. Nothing changed.");
    else console.log(`Cancelled. Nothing changed. (${sanitize(err?.message ?? String(err))})`);
  }
}

/**
 * The first time /pentest or /design runs with its specialist role unset: say what will be used instead and offer to pick now. Never
 * forced: the first choice carries on with the fallback, and the answer is remembered so it is asked once per command. Where nobody
 * can answer (no terminal), it only says what is being used. Returns false when the person cancelled.
 */
async function ensureSpecialistModel(command: SpecialistCommand, config: AgentConfig, repoRoot: string): Promise<boolean> {
  if (unsetRoles(command, config.models).length === 0) return true;
  if (!shouldAsk(command, config.models, { interactive: canRunWizard() })) {
    if (!canRunWizard() && !hasBeenAsked(command)) console.log(`[${command.toUpperCase()}] ${fallbackHint(command, config.models)}`);
    return true;
  }

  let choice: SpecialistChoice;
  try {
    choice = await withExclusiveStdin(async () => {
      wizard.log.message(promptLines(command, config.models).join("\n"));
      return answered(await wizard.select<SpecialistChoice>({ message: `What now?  ${ESC_HINT}`, options: specialistChoices() }));
    });
  } catch (err) {
    if (!(err instanceof WizardCancelled)) throw err;
    choice = "cancel";
  }
  if (choice === "cancel") {
    console.log("Cancelled. Nothing was run.");
    return false;
  }
  markAsked(command);
  if (choice === "pick") {
    // One bracket around every role, so the session input line is not brought back between pickers.
    await withExclusiveStdin(async () => {
      for (const role of unsetRoles(command, config.models)) await changeModel(config, repoRoot, role);
    });
  }
  return true;
}

const PROVIDER_SORT_CHOICES = [
  { value: "default" as const, blurb: "OpenRouter's own default, price first" },
  { value: "throughput" as const, blurb: "The fastest backend; avoids ones that are slow right now" },
  { value: "price" as const, blurb: "Always the cheapest backend, whatever its speed" },
  { value: "latency" as const, blurb: "The backend that starts answering soonest" },
];

/**
 * /model-sort: how OpenRouter picks a backend provider per call. "default" is price first and can hang on a degraded provider for a
 * full request timeout before falling back; "throughput" avoids that without a maintained list of which providers are bad this week.
 */
async function changeProviderSort(config: AgentConfig, repoRoot: string): Promise<void> {
  if (!canRunWizard()) {
    console.log("Use `yimpim config set provider.sort <default|throughput|price|latency>` instead.");
    return;
  }
  try {
    await withExclusiveStdin(async () => {
      const picked = answered(
        await wizard.select({
          message: `How should OpenRouter pick a provider? (now: ${config.provider.sort})  ${ESC_HINT}`,
          initialValue: config.provider.sort,
          options: PROVIDER_SORT_CHOICES.map((c) => ({ value: c.value, label: c.value, hint: c.blurb })),
        })
      );
      const target = locateConfigFile(repoRoot) ?? globalConfigPath();
      writeSetting(target, "provider.sort", picked);
      config.provider.sort = picked;
      wizard.log.success(`Provider sort: ${picked}. Written to ${target}. The next model call uses it.`);
    });
  } catch (err: any) {
    if (err instanceof WizardCancelled) console.log("Cancelled. Nothing changed.");
    else console.log(`Cancelled. Nothing changed. (${sanitize(err?.message ?? String(err))})`);
  }
}

function printPlan(repoRoot: string): void {
  const progressPath = path.join(repoRoot, "PROGRESS.md");
  if (fs.existsSync(progressPath)) {
    console.log(`\n--- 📋 Active Plan (PROGRESS.md) ---\n${fs.readFileSync(progressPath, "utf-8")}\n------------------------------------\n`);
  } else {
    console.log(`\n[YIMPIM] ⚠️ No PROGRESS.md found in ${repoRoot}.\n`);
  }
}

/** Paths that were already dirty before the agent touched anything. */
async function snapshotDirtyPaths(repo: RepoTools): Promise<Set<string>> {
  try {
    const out = await repo.git(["status", "--porcelain=v1", "--untracked-files=all"]);
    return new Set(
      out
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    );
  } catch {
    return new Set();
  }
}

// Deliberately NOT the same list staticQa.ts's isHarnessArtifactPath uses for
// semantic-review exemption: this one decides what gets auto-committed each
// phase, and QA_REVIEW.md SHOULD be committed (it's a real artifact worth
// keeping) even though it should never be semantically reviewed — those are
// different questions, and conflating them would silently stop QA_REVIEW.md
// from ever being committed at all.
/** The task is over: the one-off reports and helper scripts its agents made are removed, so none is left to be committed. */
function removeScratch(tools: AgentTools): void {
  try {
    const gone = tools.cleanScratchFiles();
    if (gone.length > 0) console.log(`[CLEANUP] Removed ${gone.length} scratch file(s) the agents made: ${gone.slice(0, 6).join(", ")}${gone.length > 6 ? ", …" : ""}`);
  } catch {
    /* cleanup is a courtesy, never a reason to fail */
  }
}

function isHarnessArtifact(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  // Scratch files (a test report an agent parsed, a one-off summary script) are not project work and are never committed (scratch.ts).
  return p === "PROGRESS.md" || p === ".agent" || p.startsWith(".agent/") || isScratchPath(p);
}

/**
 * Reviews whatever is sitting uncommitted in the working tree and offers to
 * give it its own honest commit instead of leaving it to pile up silently.
 * This is how pre-existing dirty state normally accumulates: a phase that
 * fails or crashes before reaching the normal commit-or-revert path (or
 * edits made by hand between runs) leaves files stranded, and every run
 * after that just preserves-and-ignores them forever with no way offered to
 * actually deal with them.
 */
/**
 * Reviews whatever is sitting uncommitted in the working tree and resolves
 * it — no prompt, no y/N. Asking someone to judge a diff they never wrote
 * and often can't read is the wrong bottleneck: a model is far better
 * positioned to assess it than a human staring at a confirmation they have
 * no real way to answer. So this always commits — nothing is ever
 * destructively discarded, since a commit costs nothing and stays
 * recoverable forever, unlike a deleted uncommitted edit — and uses the
 * model's judgment only to decide HOW to label it: coherent, finished-
 * looking work gets a plain commit message; anything that reads as
 * abandoned or broken gets committed too, but clearly flagged, so nothing
 * later gets silently built on top of it. Either way the tree is clean
 * afterward. Called automatically before every new task starts, not just
 * on request — that is the actual fix for work piling up unnoticed for
 * days between anyone thinking to ask about it.
 */
async function reviewAndResolvePendingChanges(
  repo: RepoTools,
  repoRoot: string,
  client: OpenRouterClient,
  config: AgentConfig
): Promise<void> {
  const dirty = [...(await snapshotDirtyPaths(repo))].filter((p) => !isHarnessArtifact(p));
  if (dirty.length === 0) return;

  console.log(`\n[GIT] Found ${dirty.length} uncommitted change(s) already sitting in the repo:`);
  dirty.slice(0, 25).forEach((f) => console.log(`   ${f}`));
  if (dirty.length > 25) console.log(`   ... and ${dirty.length - 25} more`);

  let verdict: "complete" | "incomplete" = "incomplete";
  let reason = "could not be auto-reviewed";
  try {
    const change = await collectChangeSet(repoRoot);
    if (!change.isEmpty) {
      const response = await client.complete(
        config.models.discovery,
        [
          {
            role: "system",
            content:
              "You are reviewing changes left UNCOMMITTED in a repository, with no record of what task " +
              "produced them or whether it finished successfully. Assess whether this reads as coherent, " +
              "finished work worth keeping as a normal commit, or as broken, half-finished, or abandoned " +
              'scratch work.\n\nRespond ONLY with this JSON: {"verdict": "complete" | "incomplete", ' +
              '"reason": "one plain-language sentence, written for someone who does not read code"}',
          },
          { role: "user", content: change.diff.slice(0, 60000) },
        ],
        // Labeled "DISCOVERY", not a separate "git-review" bucket — same
        // reasoning as the intent classifier above: it already runs on
        // config.models.discovery, and this call always happens before any
        // task's own currentTaskUsageStart reset, so it never counted
        // toward a task's usage either way. Folding it in just means its
        // cost shows up under DISCOVERY's row in the lifetime/session
        // summary instead of its own orphan row — it was always counted in
        // the whole-session total regardless of label.
        { jsonMode: true, agent: "DISCOVERY" }
      );
      const content =
        typeof response === "string"
          ? response
          : response?.content ?? response?.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content || "{}");
      if (parsed?.verdict === "complete" || parsed?.verdict === "incomplete") verdict = parsed.verdict;
      if (typeof parsed?.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim();
    }
  } catch (err: any) {
    console.warn(`[GIT] ⚠️ Auto-review could not run (${err.message}) — committing as-is without a verdict.`);
  }

  console.log(
    `[GIT] Review: ${verdict === "complete" ? "looks like finished work" : "looks incomplete or abandoned"} — ${reason}`
  );

  // A path that no longer matches anything (deleted since it was listed, or
  // a status-parsing edge case) must never crash the whole process over one
  // bad `git add` — with a phone possibly the only way back into a session,
  // an unhandled failure here would lock the user out entirely rather than
  // just failing this one step.
  try {
    const existing = dirty.filter((p) => fs.existsSync(path.join(repoRoot, p)));
    const missing = dirty.filter((p) => !existing.includes(p));
    if (missing.length > 0) {
      console.warn(`[GIT] ⚠️ Skipping ${missing.length} path(s) no longer present: ${missing.join(", ")}`);
    }
    if (existing.length === 0) {
      console.log(`[GIT] Nothing left to commit.`);
      return;
    }
    const label = verdict === "complete" ? "reviewed as complete work" : `flagged as likely incomplete — ${reason}`;
    // Each path on its own: one that cannot be staged (an ignored log file, say) is skipped, where `git add` of them all at once
    // failed the whole commit.
    const done = await commitOnly(repo.git, existing, `${config.git.commitPrefix}: carry over ${existing.length} pre-existing uncommitted change(s) (${label})`, (l) => console.warn(l));
    console.log(done.length > 0 ? `[GIT] ✔ Committed ${done.length} file(s).` : `[GIT] Nothing could be committed — your files are exactly as they were.`);
  } catch (err: any) {
    console.error(`[GIT] ✗ Could not commit: ${err.message}`);
    console.error(`[GIT] Nothing was changed — your files are exactly as they were.`);
  }
}

/**
 * Phone-aware replacements for orchestrator.ts's own default prompters
 * (`promptUserApproval`, `promptDependencyChoice`) — those are a raw local
 * `readline` question with no remote path at all, so a session driven from a
 * paired phone (nobody watching the actual terminal) deadlocks on them
 * forever, indistinguishable from a genuine hang. Routed through askAnywhere
 * instead, the same terminal-vs-phone race every other blocking question in
 * this file already uses (see reportPushFailure below, or ask_user's wiring
 * further down) — a human still at the terminal sees and answers exactly the
 * same prompt as before, but the phone can now also answer it.
 *
 * Callers only pass these in when `isInteractive() || remote?.connected` —
 * the same "is anyone actually able to answer" check every other askAnywhere
 * call site in this file uses. orchestrator.ts's own gates already skip
 * cleanly with no prompt at all when there is no injected prompter, which is
 * the right behavior for a genuinely unattended run (no terminal, no phone,
 * nobody who could ever answer); passing an askAnywhere-backed prompter
 * unconditionally would trade that clean, immediate skip for a call that can
 * wait on the remote side forever if nothing is paired.
 */
async function askDependencyInstallApproval(message: string, questionId: string): Promise<boolean> {
  const answer = await askAnywhere(
    {
      id: questionId,
      kind: "blocking",
      prompt: message,
      fallback: "n",
      askedAt: new Date().toISOString(),
    },
    buildApprovalPromptLine(message)
  );
  return parseApprovalAnswer(answer);
}

async function askPostPhaseDependencyChoice(message: string, questionId: string): Promise<string> {
  return askAnywhere(
    {
      id: questionId,
      kind: "blocking",
      prompt: message,
      choices: ["install", "skip", "abort"],
      fallback: "skip",
      askedAt: new Date().toISOString(),
    },
    `${message}\n  [1] install    [2] skip    [3] abort\nChoice [2]: `
  );
}

/**
 * Turns a raw push failure into a specific, actionable diagnostic when it
 * matches GitHub's "wrong account" wording (git's own credential cache is
 * entirely separate from a browser session, so this is by far the most
 * common cause of a push 403 — not an actual missing-collaborator problem),
 * and offers to fix it on the spot. Falls back to the plain error message
 * for anything else.
 *
 * `offerFix` gates whether it actually asks — true only from /push-repo,
 * an explicit user action where someone is definitely there to answer. The
 * automatic post-phase push (which may run fully unattended) just logs the
 * diagnostic and leaves it for a later `/push-repo` retry to offer the fix.
 */
async function reportPushFailure(err: any, repo: RepoTools, offerFix: boolean, runId?: string): Promise<void> {
  const denial = parsePushDenial(err?.message ?? String(err));
  if (!denial) {
    console.warn(`[GIT WARNING] Push failed: ${err?.message ?? err}`);
    return;
  }

  for (const line of describePushDenial(denial)) console.warn(line);
  if (!offerFix) return;

  const answer = await askAnywhere(
    {
      id: `pushfix_${runId ?? "auto"}_${Date.now()}`,
      kind: "blocking",
      prompt: `Clear the cached "${denial.deniedAccount}" account now so the next push prompts a fresh login?`,
      fallback: "n",
      askedAt: new Date().toISOString(),
    },
    `Clear "${denial.deniedAccount}" now? ${YES_NO_ENTER_NO}: `
  );
  if (!answer.trim().toLowerCase().startsWith("y")) return;

  try {
    await execFileAsync("git", ["credential-manager", "github", "logout", denial.deniedAccount]);
    console.log(`[GIT] ✓ Cleared. Run /push-repo again — this time it'll prompt a fresh login.`);
  } catch (e: any) {
    console.warn(`[GIT] ⚠️ Could not clear it automatically: ${e.message}`);
    console.warn(`[GIT] Clear it yourself:  git credential-manager github logout ${denial.deniedAccount}`);
  }
}

/**
 * /push-repo — connect this project to a GitHub remote (asking for a URL if
 * none is configured yet) and push now. This is also how a project gets
 * flipped from local-only back to pushing after /push-local turned it off.
 */
async function enablePushToRepo(
  repo: RepoTools,
  repoRoot: string,
  client: OpenRouterClient,
  config: AgentConfig,
  runId: string
): Promise<void> {
  // Flush anything sitting uncommitted first — pushing should never leave
  // finished-looking work behind just because it hadn't been committed yet.
  await reviewAndResolvePendingChanges(repo, repoRoot, client, config);

  let remoteUrl = await detectOrigin(repo);

  if (!remoteUrl) {
    const answer = await askAnywhere(
      {
        id: `pushrepo_${runId}_${Date.now()}`,
        kind: "blocking",
        prompt: "No GitHub remote is configured for this project yet. Paste a repo URL to push to:",
        fallback: "",
        askedAt: new Date().toISOString(),
      },
      "Repo URL: "
    );
    const url = answer.trim();
    if (!url) {
      console.log(`[GIT] No URL given — still local-only.`);
      return;
    }
    try {
      await repo.git(["remote", "add", "origin", url]);
      remoteUrl = url;
    } catch (err: any) {
      console.error(`[GIT] ✗ Could not add ${url} as origin: ${err.message}`);
      return;
    }
  }

  console.log(`[GIT] Checking access to ${remoteUrl}…`);
  const access = await verifyOriginAccess(repo);
  if (!access.ok) {
    console.error(`[GIT] ✗ Could not reach ${remoteUrl}: ${access.error}`);
    console.error(
      `[GIT] Push not enabled. Sort out git's access to this remote (try \`git ls-remote origin\` by hand), ` +
        `then run /push-repo again.`
    );
    return;
  }

  config.git.autoPush = true;
  writePushPreference(repoRoot, config.recovery.stateDirectory, { autoPush: true, remoteUrl });
  console.log(`[GIT] ✓ Push enabled — future verified phases push to ${remoteUrl} automatically.`);

  try {
    const branch = (await repo.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    console.log(`[GIT] ⬆️ Pushing ${branch} to origin…`);
    await repo.git(["push", "-u", "origin", branch]);
    console.log(`[GIT] ✓ Pushed.`);
  } catch (err: any) {
    await reportPushFailure(err, repo, true, runId);
  }
}

/**
 * /push-local — the reverse of /push-repo. Commits whatever's pending (the
 * same review /commit-pending used to do) and turns autoPush off, so future
 * phases stay local even though a remote may still be configured.
 */
async function disablePushToLocal(
  repo: RepoTools,
  repoRoot: string,
  client: OpenRouterClient,
  config: AgentConfig
): Promise<void> {
  await reviewAndResolvePendingChanges(repo, repoRoot, client, config);

  const existing = readPushPreference(repoRoot, config.recovery.stateDirectory);
  config.git.autoPush = false;
  writePushPreference(repoRoot, config.recovery.stateDirectory, { autoPush: false, remoteUrl: existing?.remoteUrl });
  console.log(`[GIT] Auto-push is now OFF — future phases commit locally only.`);
  if (existing?.remoteUrl) {
    console.log(`[GIT] (${existing.remoteUrl} stays configured — run /push-repo to resume pushing there.)`);
  }
}

/**
 * /branch <name> — create-or-switch to a branch, for trying something risky
 * or experimental without touching whatever's currently checked out.
 * Commits anything pending to the CURRENT branch first (a real checkpoint
 * there, not carried onto the new one silently), then branches off from that
 * clean state. Reused by the NLU path (INTENT_SYSTEM's "branch" field) so
 * "on a new branch called X, do Y" and typing /branch X do exactly the same
 * thing before the rest of the request proceeds.
 */
async function handleBranchSwitch(
  repo: RepoTools,
  repoRoot: string,
  client: OpenRouterClient,
  config: AgentConfig,
  rawName: string
): Promise<boolean> {
  const name = sanitizeBranchName(rawName);
  if (!name) {
    console.log(`[GIT] No usable branch name in "${rawName}" — nothing switched.`);
    return false;
  }

  const from = await currentBranch(repo);
  if (name === from) {
    console.log(`[GIT] Already on "${name}".`);
    return true;
  }

  await reviewAndResolvePendingChanges(repo, repoRoot, client, config);

  try {
    const { created } = await switchToBranch(repo, name);
    console.log(
      created
        ? `[GIT] ✓ Created and switched to "${name}" (branched from "${from}"). "${from}" is untouched.`
        : `[GIT] ✓ Switched to existing branch "${name}" (was on "${from}").`
    );
    return true;
  } catch (err: any) {
    console.error(`[GIT] ✗ Could not switch to "${name}": ${err.message}`);
    return false;
  }
}

async function printBranches(repo: RepoTools): Promise<void> {
  try {
    const branches = await listBranches(repo);
    console.log(`\n[GIT] Branches:`);
    for (const b of branches) console.log(`   ${b.current ? "*" : " "} ${b.name}`);
  } catch (err: any) {
    console.error(`[GIT] Could not list branches: ${err.message}`);
  }
}

/**
 * /merge [branch] — merge a branch (default: whichever one is currently
 * checked out) into the repo's default branch, for bringing isolated work
 * back once it's proven out. Never attempts to resolve a conflict itself —
 * see mergeBranch's own comment — it either merges cleanly or aborts
 * cleanly and hands you the exact commands to finish it by hand.
 */
async function handleMerge(
  repo: RepoTools,
  repoRoot: string,
  client: OpenRouterClient,
  config: AgentConfig,
  rawFrom: string | undefined
): Promise<void> {
  const current = await currentBranch(repo);

  // detectDefaultBranch alone used to fall back to a hardcoded "main" with no
  // warning — silently wrong on a master/trunk repo, or one with an unrelated
  // stray "main" branch. resolveMergeTarget guesses the same way, but only
  // after confirming the guess actually exists, and says so either way.
  const resolution = await resolveMergeTarget(repo);
  if (!resolution) {
    console.error(`[GIT] Could not determine this repo's default branch — origin/HEAD isn't set, and neither "main" nor "master" exists locally.`);
    console.error(`[GIT] Fetch it (git remote set-head origin -a) or check out your trunk branch, then merge from there.`);
    return;
  }
  if (resolution.guessed) {
    console.warn(`[GIT] ⚠️ Could not detect this repo's real default branch (origin/HEAD not set yet) — guessing "${resolution.branch}" because it exists locally.`);
    console.warn(`[GIT]    If that's wrong: git remote set-head origin -a`);
  }
  const into = resolution.branch;
  const from = resolveMergeSource(rawFrom, current, into);

  if (!from) {
    console.log(`[GIT] No usable branch name in "${rawFrom}" — nothing merged.`);
    return;
  }
  if (from === into) {
    console.log(`[GIT] "${from}" IS "${into}" — nothing to merge.`);
    return;
  }

  // Commit anything pending on whichever branch is currently checked out
  // first, so nothing gets lost or silently swept into the merge with it.
  await reviewAndResolvePendingChanges(repo, repoRoot, client, config);

  // Costs nothing and turns "undo this merge" into one git command instead
  // of manual archaeology, if the merge itself looked clean but was wrong.
  const checkpoint = await repo.createCheckpoint(`pre-merge-${from}-into-${into}`);

  console.log(`[GIT] Merging "${from}" into "${into}"…`);
  const result = await mergeBranch(repo, from, into);

  if (result.status === "up-to-date") {
    console.log(`[GIT] "${into}" already has everything from "${from}" — nothing to merge.`);
    return;
  }

  if (result.status === "conflict") {
    console.error(`[GIT] ✗ Merge conflict — aborted cleanly, nothing was changed on either branch.`);
    console.error(`[GIT] Resolve it by hand:`);
    console.error(`[GIT]   git checkout ${into} && git merge ${from}`);
    console.error(`[GIT]   (fix the conflicting files, then: git add -A && git commit)`);
    return;
  }

  console.log(
    `[GIT] ✓ Merged "${from}" into "${into}".` +
      (checkpoint ? ` (checkpoint "${checkpoint}" if you need to undo: git reset --hard ${checkpoint})` : "")
  );

  if (config.git.autoPush) {
    try {
      console.log(`[GIT] ⬆️ Pushing ${into} to origin…`);
      await repo.git(["push", "-u", "origin", into]);
      console.log(`[GIT] ✓ Pushed.`);
    } catch (err: any) {
      await reportPushFailure(err, repo, false);
    }
  }
}

/** Paths the agent itself changed = current dirty set minus the pre-existing set. */
async function agentTouchedPaths(repo: RepoTools, preExisting: Set<string>): Promise<string[]> {
  const now = await snapshotDirtyPaths(repo);
  return [...now].filter((p) => !preExisting.has(p) && !isHarnessArtifact(p));
}

/** Test files the agent created in this phase: touched by it, and not in HEAD. */
async function createdTestFiles(repo: RepoTools, preExisting: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await agentTouchedPaths(repo, preExisting)) {
    if (!isTestPath(rel)) continue;
    try {
      await repo.git(["cat-file", "-e", `HEAD:${rel.replace(/\\/g, "/")}`]);
    } catch {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Revert ONLY what the agent changed. Pre-existing user edits and untracked
 * user files are never touched; agent-created files are quarantined rather
 * than deleted so nothing is destroyed irrecoverably.
 */
async function revertAgentChanges(
  repoRoot: string,
  repo: RepoTools,
  preExisting: Set<string>
): Promise<void> {
  const touched = await agentTouchedPaths(repo, preExisting);
  if (touched.length === 0) {
    console.log(`[REVERT] Nothing to revert — the agent left no changes of its own.`);
    return;
  }

  const quarantine = path.join(repoRoot, ".agent", "rejected", String(Date.now()));
  let restored = 0;
  let quarantined = 0;

  for (const rel of touched) {
    const abs = path.join(repoRoot, rel);
    try {
      // Tracked file the agent modified -> restore from HEAD.
      await repo.git(["cat-file", "-e", `HEAD:${rel.replace(/\\/g, "/")}`]);
      await repo.git(["checkout", "HEAD", "--", rel]);
      restored++;
    } catch {
      // Untracked file the agent created -> move aside, never delete.
      try {
        if (!fs.existsSync(abs)) continue;
        // ".rejected" on the end keeps the moved copy out of every glob a test
        // runner, compiler or linter uses to find source (a quarantined
        // foo.test.ts used to be collected and run by jest, failing the whole
        // gate). Rename it back to restore.
        const dest = path.join(quarantine, `${rel}.rejected`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(abs, dest);
        quarantined++;
      } catch (e: any) {
        console.warn(`[REVERT WARNING] Could not quarantine ${rel}: ${e.message}`);
      }
    }
  }

  console.log(`[REVERT] Restored ${restored} modified file(s); quarantined ${quarantined} new file(s).`);
  if (quarantined > 0) console.log(`[REVERT] Agent-created files moved to: ${quarantine}`);
  if (preExisting.size > 0) {
    console.log(`[REVERT] Left ${preExisting.size} pre-existing uncommitted change(s) untouched.`);
  }
}

/**
 * Render the pairing QR in the terminal. The session key lives in the URL
 * fragment, so it travels desktop-screen -> phone-camera and never touches the
 * broker. The code is single-use and expires in about two minutes.
 */
async function printPairingQr(
  pairingUrl: string,
  source: "cloud" = "cloud",
  /** connectRemote's provisionRelay progress log — see its own comment for why this must survive the clear() below. */
  provisioningLog: string[] = [],
  /** Mid-run: leave the screen alone so the run's output above stays in the scrollback. */
  keepScreen = false
): Promise<void> {
  // The QR is ~25 lines — on a terminal window shorter than that plus this
  // banner, it lands partway up the scrollback instead of fully on screen,
  // and hunting for the exact scroll position to see the whole code at once
  // is fiddly on a trackpad/wheel with sensitive scroll steps. Clearing first
  // means it always starts at the very top of the current view with nothing
  // above it to scroll past. Skipped when not a real TTY (piped output, CI)
  // so the escape code never lands in a log file instead of a terminal.
  if (isInteractive() && !keepScreen) console.clear();

  console.log(`\n${"=".repeat(58)}`);
  console.log(`📱 REMOTE CONTROL — scan to pair ONE device`);
  console.log(`${"=".repeat(58)}\n`);

  try {
    const qr: any = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      (qr.default ?? qr).generate(pairingUrl, { small: true }, (code: string) => {
        console.log(code);
        resolve();
      });
    });
  } catch {
    console.log(`(QR renderer unavailable — open this URL on your phone instead)`);
  }

  console.log(`If you cannot scan, open:\n  ${pairingUrl}\n`);
  if (provisioningLog.length > 0) {
    console.log(`How this connection was set up:`);
    for (const line of provisioningLog) console.log(`  ${line}`);
    console.log();
  }
  // "Relay ready: <detail>" above already said how this is served; this adds what the broker itself can and can't see.
  if (source === "cloud") console.log(`The relay only ever sees encrypted data.`);
  console.log(`This code is single-use and expires in ~2 minutes.`);
  console.log(`Permitted from the phone: watch, answer questions, STOP the run.`);
  console.log(`${"=".repeat(58)}\n`);
}

// Tracks the currently-published relay across calls to connectRemote, purely
// so a re-pairing (calling /remote-control again in the same process) can
// tear the PREVIOUS one down first — see connectRemote's own comment for why
// leaving it running was a real bug, not just a cosmetic leak.
let activeRelay: ProvisionedRelay | undefined;

// The specific onQuestion/onQuestionResolved closures registered for the
// CURRENT session, so a re-pairing can unregister exactly those before
// wiring up the new session's. runControl.onQuestion only ever appends —
// without this, every past pairing's closure kept firing forever, each one
// calling askQuestion/resolveQuestion on a session that (by then) silently
// no-ops because it's already stopped, but still very much still running.
let activeQuestionListener: ((q: PendingQuestion) => void) | undefined;
let activeResolvedListener: ((id: string) => void) | undefined;
let activeAnsweredListener: ((q: PendingQuestion, answer: string, by: import("./remote/control.js").AnswerSource) => void) | undefined;
let activeShutdownUnregister: (() => void) | undefined;
let activeRunLock: RunLock | undefined;
/** Who is asking right now, for question.ask (set by the main loop: the running phase and the innermost shown worker). */
let questionContext: () => { taskId?: string; phaseId?: string; worker?: string; workerId?: string } = () => ({});

/**
 * Pair a phone to this session. Used by both `--remote` and `/remote-control`.
 * Returns undefined (with an explanation) rather than throwing, so a failed
 * pairing never stops the local run.
 *
 * `previous`, when given, is a session from an EARLIER call in this same process. It is stopped (unregistered from the
 * broker) first, so there is only ever one session live at a time and a stale one never confuses which is reachable.
 */
async function connectRemote(
  config: AgentConfig,
  repoRoot: string,
  runId: string,
  previous: RemoteSession | undefined,
  onAttach: (filePath: string) => void,
  /** Paired while a task is running: do not clear the screen. */
  keepScreen = false
): Promise<RemoteSession | undefined> {
  // printPairingQr clears the screen right before drawing the QR (see its own
  // comment — deliberate, so a short terminal window doesn't leave the code
  // scrolled half out of view). That wipe used to take provisionRelay's own
  // progress log with it, including exactly the line that explains WHY the
  // cloud tunnel wasn't used when a Pro lease exists but something about it
  // failed (an expired lease, a broker error, ...). Captured here and handed to printPairingQr to reprint after the
  // clear, so the explanation survives.
  const provisioningLog: string[] = [];
  const log = (m: string) => {
    provisioningLog.push(m);
    console.log(`[REMOTE] ${m}`);
  };

  if (previous || activeRelay) {
    log(`Tearing down the previous session before starting a new one…`);
    try {
      await previous?.stop("re-pairing");
    } catch {}
    try {
      await activeRelay?.stop();
    } catch {}
    activeRelay = undefined;
    if (activeQuestionListener) runControl.offQuestion(activeQuestionListener);
    if (activeResolvedListener) runControl.offQuestionResolved(activeResolvedListener);
    if (activeAnsweredListener) runControl.offQuestionAnswered(activeAnsweredListener);
    activeShutdownUnregister?.();
    activeShutdownUnregister = undefined;
    activeQuestionListener = undefined;
    activeResolvedListener = undefined;
    activeAnsweredListener = undefined;
  }

  let relay: ProvisionedRelay;
  try {
    relay = await provisionRelay({
      log,
      // Only ever asked when this machine has no usable Pro lease. Raced through askAnywhere so a paired phone can answer it
      // too, and defaulted to "no" so an unattended run goes straight to the guidance instead of waiting on nobody.
      confirmLinkFlow: async () => {
        const answer = await askAnywhere(
          {
            id: `link_${runId}_${Date.now()}`,
            kind: "blocking",
            prompt:
              "Remote control runs through YIMPIM Pro, and this machine is not linked yet.\n" +
              "Link this machine to YIMPIM Pro now?\n" +
              "(you'll get a code to scan with your phone)",
            fallback: "n",
            askedAt: new Date().toISOString(),
          },
          `Link this machine to YIMPIM Pro now? ${YES_NO_ENTER_NO}: `
        );
        return answer.trim().toLowerCase().startsWith("y");
      },
    });
  } catch (err: any) {
    console.log();
    console.log(err instanceof RelayUnavailable ? `  ${err.message}` : `  ${err.message}`);
    if (err instanceof RelayUnavailable) {
      console.log();
      for (const g of err.guidance) console.log(`  ${g}`);
    }
    console.log();
    return undefined;
  }

  log(`Relay ready: ${relay.detail}`);
  activeRelay = relay;

  const session = new RemoteSession({
    brokerUrl: relay.url,
    allowAnswer: true,
    redactLogs: config.remote.redactLogs,
    // Binds this session to the Pro account on the hosted broker.
    leaseToken: getValidProToken() ?? undefined,
    // Without this, `this.uploads` (UploadCollector) is never constructed —
    // every "attach" chunk from the phone silently no-ops through
    // `this.uploads?.accept(p)`, `done` is always undefined, `onAttach` never
    // fires, and the image never reaches `pendingAttachments`. The phone
    // still shows "sent" (that just reflects the chunk POST to the broker
    // succeeding), so this failed completely invisibly.
    repoRoot,
  });

  try {
    // "attach" and "answer" are separate protocol messages with no explicit
    // link between them, so an image sent alongside a phone answer is
    // otherwise invisible downstream — it gets silently staged as reference
    // material while the answer text carries no sign it was ever there.
    // Tracking what's arrived since the last answer and appending a note to
    // the answer text is what actually reaches the model (and anything that
    // later logs or echoes that text), not just a desktop console line.
    let attachedSinceLastAnswer: string[] = [];
    const withAttachmentNote = (text: string): string => {
      if (attachedSinceLastAnswer.length === 0) return text;
      const noted = `${text}\n\n[Note: ${attachedSinceLastAnswer.length} image(s) were also attached from the phone with this message: ${attachedSinceLastAnswer.join(", ")}]`;
      attachedSinceLastAnswer = [];
      return noted;
    };

    // Checked against the lease on disk at the moment a phone prompt arrives — not against what this session was built with: /link
    // may have run since (so an "unlinked" state read at startup is stale), and a lease can expire mid-session. A prompt that cannot
    // be served is refused to the phone with the reason, so it is never left hanging with no answer. Nothing is consumed on refusal.
    const refuseUnlinkedPrompt = (verb: "answer" | "message"): boolean => {
      const reason = remotePromptBlocker();
      if (reason === null) return false;
      logLocal(`[REMOTE] ⚠️ ${verb} refused: ${reason}`);
      session.push("command.refused", { verb, reason });
      return true;
    };

    const pairingUrl = await session.start(runId, path.basename(repoRoot), {
      onAbort: (reason) => runControl.requestAbort(reason || "phone"),
      onAnswer: (questionId, answer) => {
        if (refuseUnlinkedPrompt("answer")) return;
        const noted = withAttachmentNote(answer);
        if (!runControl.answer(questionId, noted, "phone")) {
          logLocal(`[REMOTE] (answer for ${questionId} arrived too late — already resolved)`);
          // Structured, not just the log line above — lets the phone that
          // sent this specific answer detect it was never actually used (the
          // question resolved from elsewhere first — the terminal, or a
          // fallback) and recover the typed text instead of it just
          // vanishing with no visible explanation.
          session.push("answer.rejected", { questionId, reason: "that question was already resolved" });
        }
      },
      onMessage: (text) => {
        if (refuseUnlinkedPrompt("message")) return;
        const noted = withAttachmentNote(text);
        const usedImmediately = runControl.provideForNextQuestion(noted);
        logLocal(
          usedImmediately
            ? `[REMOTE] 📱 message answered the current question.`
            : `[REMOTE] 📱 message queued — will be used as soon as I ask anything next.`
        );
      },
      onAttach: (filePath, name) => {
        // Staged on disk and queued as reference material. It only feeds a plan
        // built after this point; it never alters a run already in flight.
        onAttach(filePath);
        attachedSinceLastAnswer.push(name);
        console.log(`[REMOTE] 📎 ${name} queued as reference for the next plan.`);
      },
      onFetchDiff: (changeId) => {
        const stored = diffStore.get(changeId);
        if (stored) {
          session.pushDiff(changeId, stored.path, stored.diffText);
        } else {
          session.pushDiffUnavailable(
            changeId,
            "That change is no longer available (older than this session's diff cache, or the process restarted)."
          );
        }
      },
      onFetchHistory: (cursor) => {
        // Same cap as the broker's own MAX_QUEUE (broker.ts) -- no reason to
        // ever hand back more than it would have held live anyway, and it
        // keeps one recovery batch comfortably under the broker's 1MB
        // per-request body cap.
        if (cursor.taskId !== undefined) {
          // Opening one task from the History list — scoped to that task's
          // own file only, never the repo-wide merged cursor below.
          const { entries, truncated, missing } = readTaskEvents(repoRoot, cursor.taskId, cursor.afterEventId ?? 0, 500);
          session.replayHistory(entries);
          const lastEventId = entries.length > 0 ? entries[entries.length - 1].eventId : undefined;
          session.pushHistoryFetched(String(cursor.afterEventId ?? 0), lastEventId, entries.length, truncated, cursor.taskId, missing);
          return;
        }
        // afterEventId preferred (no tied-timestamp page-boundary risk — see
        // readHistoryBacklogSinceEventId's own comment); `after` is the
        // legacy fallback for a phone build that predates eventId.
        const { entries, truncated } =
          cursor.afterEventId !== undefined
            ? readHistoryBacklogSinceEventId(repoRoot, cursor.afterEventId, 500)
            : readHistoryBacklogSince(repoRoot, cursor.after ?? "", 500);
        session.replayHistory(entries);
        const lastEventId = entries.length > 0 ? entries[entries.length - 1].eventId : undefined;
        const requestedAfter = cursor.after ?? (cursor.afterEventId !== undefined ? String(cursor.afterEventId) : "");
        session.pushHistoryFetched(requestedAfter, lastEventId, entries.length, truncated);
      },
      onHistoryList: (limit, beforeTaskId) => {
        const { entries, hasMore } = listTasks(repoRoot, limit, beforeTaskId);
        session.pushHistoryIndex(entries, hasMore);
      },
      onFetchScreenshot: (requestedPath) => {
        // Reduced to its own basename and rejoined under the repo's OWN
        // screenshot directory, never the client-supplied path structure --
        // this makes a path-traversal attempt (../../anything, an absolute
        // path elsewhere) impossible by construction rather than by
        // validation: whatever the phone sends, only a file actually inside
        // .agent/screenshots/ for THIS repo can ever be read.
        const screenshotDir = path.resolve(repoRoot, ".agent", "screenshots");
        const absolute = path.join(screenshotDir, path.basename(requestedPath));
        const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        if (!session.pushScreenshot(id, path.basename(absolute), absolute)) {
          session.pushScreenshotUnavailable(requestedPath, "That screenshot no longer exists on disk.");
        }
      },
      onGetModelConfig: () => {
        session.pushModelConfig(currentModelConfig(config), locateConfigFile(repoRoot) ? "project" : "global", roleInfoWire());
      },
      onGetRoadmap: () => {
        session.pushRoadmapState(roadmapWire(loadRoadmap(repoRoot)));
      },
      onGetUsage: () => {
        session.pushUsageTotals(toUsageWire(usageLedger().snapshot()));
      },
      onListModels: (role, exclude) => {
        void listModelsForRemote(role, exclude, session);
      },
      onSetModel: (role, chain) => {
        setModelFromRemote(role, chain, config, repoRoot, session);
      },
    }, buildSessionHello({ repoRoot, shareHostname: config.remote.shareHostname }));

    await printPairingQr(pairingUrl, relay.source, provisioningLog, keepScreen);
    // Who asked each question, remembered from when it was asked, for its answer.
    const askedBy = new Map<string, ReturnType<typeof questionContext>>();
    activeQuestionListener = (q: PendingQuestion) => {
      session.askQuestion(q);
      // The idle "what should I do next" prompt is not a question in a Q&A: its answer is the next task's prompt (task.start).
      if (!q.idle) {
        const who = questionContext();
        askedBy.set(q.id, who);
        const firstLine = q.prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
        session.push("question.ask", {
          questionId: q.id,
          question: q.prompt.trim() || firstLine || (q.kind === "approval" ? "Approve this?" : "Your answer is needed."),
          options: q.choices ?? [],
          questionKind: q.kind,
          ...(q.allowCustom ? { allowCustom: true } : {}),
          ...who,
          askedAt: q.askedAt,
        });
      }
      // The idle "what should I do next" prompt is not a push-worthy event —
      // it fires every time the loop simply has nothing to do, not because
      // the agent needs an answer to keep working. See PendingQuestion.idle.
      if (!q.idle) session.notify("question");
    };
    activeResolvedListener = (id: string) => session.resolveQuestion(id);
    runControl.onQuestion(activeQuestionListener);
    runControl.onQuestionResolved(activeResolvedListener);
    activeAnsweredListener = (q, answer, by) => {
      if (q.idle) return;
      const who = askedBy.get(q.id) ?? questionContext();
      askedBy.delete(q.id);
      session.push("question.answered", { questionId: q.id, question: q.prompt.trim(), answer, by, ...who });
    };
    runControl.onQuestionAnswered(activeAnsweredListener);

    // onQuestion above only ever fires for questions asked AFTER this listener
    // is registered — a question already outstanding when this phone (re)pairs
    // (e.g. Discovery or the Planner asked something while it was disconnected,
    // or before /remote-control was even run) was never pushed to THIS
    // session and so never appears in its event stream at all, regardless of
    // how correctly the phone replays past events. Catch it up immediately.
    for (const q of runControl.pending()) session.askQuestion(q);

    // connectRemote always represents a BRAND-NEW session — previous is torn
    // down unconditionally above — so its event stream starts empty on the
    // broker even though this repo may have a long history behind it.
    // replayHistory (not push() — see its own doc comment) seeds the outbox
    // with the durable backlog, original timestamps intact, before any live
    // events — the phone needs no special handling, these just arrive as the
    // first events of the new session, in order.
    session.replayHistory(readHistoryBacklogForReplay(repoRoot));
    // The lifetime totals are this DESKTOP's, not this session's, so a phone
    // that was just installed (or re-paired) sees the real number straight away.
    session.pushUsageTotals(toUsageWire(usageLedger().snapshot()));
    // The roadmap card: the current roadmap now, then again on every change.
    session.pushRoadmapState(roadmapWire(loadRoadmap(repoRoot)));
    const stopRoadmapFeed = onRoadmapChanged((root) => {
      if (root === repoRoot) session.pushRoadmapState(roadmapWire(loadRoadmap(repoRoot)));
    });

    // Tear the published endpoint down cleanly on SIGINT/SIGTERM/SIGHUP/SIGBREAK
    // BEFORE RunLock releases and calls process.exit(), and unregister on re-pair
    // so process listeners never leak across sessions.
    const teardown = () => { stopRoadmapFeed(); return Promise.allSettled([session.stop("process exit"), relay.stop()]).then(() => {}); };
    if (activeRunLock) {
      activeShutdownUnregister = activeRunLock.registerShutdownHook(teardown);
    } else {
      const syncTeardown = () => { void teardown(); };
      process.once("exit", syncTeardown);
      process.once("SIGINT", syncTeardown);
      process.once("SIGTERM", syncTeardown);
      activeShutdownUnregister = () => {
        process.off("exit", syncTeardown);
        process.off("SIGINT", syncTeardown);
        process.off("SIGTERM", syncTeardown);
      };
    }

    return session;
  } catch (err: any) {
    console.error(err instanceof SessionLimitError ? `
[REMOTE] ${err.message}
` : `
[REMOTE] Could not start the session: ${err.message}
`);
    await relay.stop();
    activeRelay = undefined;
    return undefined;
  }
}

function loadCodebaseMemory(memoryFile: string): CodebaseMemory {
  if (fs.existsSync(memoryFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(memoryFile, "utf-8"));
      return {
        shortDescription: data.shortDescription || "Generic codebase",
        techStack: data.techStack || [],
        architectureRules: data.architectureRules || [],
        liveRules: data.liveRules || [],
        historicalPitfalls: data.historicalPitfalls || [],
        totalRuns: (data.totalRuns || 0) + 1,
        lastRunDate: new Date().toISOString(),
        pendingManualSteps: data.pendingManualSteps || [],
      };
    } catch {}
  }

  return {
    shortDescription: "Newly initialized project",
    techStack: [],
    architectureRules: [],
    liveRules: [],
    historicalPitfalls: [],
    totalRuns: 1,
    lastRunDate: new Date().toISOString(),
    pendingManualSteps: [],
  };
}

/**
 * New manual steps flagged this run, folded into persistent memory so they
 * survive across runs — otherwise they were printed once and forgotten, with
 * nothing to stop a later run re-flagging the exact same one. Deduped by
 * exact step text; a step this run didn't touch stays exactly as it was.
 */
function mergeManualSteps(memory: CodebaseMemory, agentTools: AgentTools): void {
  const known = new Set(memory.pendingManualSteps.map((s) => s.step));
  for (const step of agentTools.getManualSteps()) {
    if (!known.has(step.step)) {
      memory.pendingManualSteps.push(step);
      known.add(step.step);
    }
  }
}

/**
 * Drops steps the user has just confirmed are done (matched by a model
 * against their own words, never inferred) out of pendingManualSteps, and
 * records the fact as a live rule so it survives even if pendingManualSteps
 * itself is ever cleared some other way. Called from both the classifier
 * (covers question/Advisor, which never reaches Discovery) and Discovery
 * itself (richer codebase context, may catch what the lighter classifier
 * missed) — safe to run from both, since one resolving a step just leaves
 * nothing for the other to find. Returns whether anything actually changed.
 */
function appendLiveRules(memory: CodebaseMemory, newRules: string[]): void {
  memory.liveRules = mergeLiveRules(memory.liveRules, newRules);
}

function reconcileResolvedManualSteps(memory: CodebaseMemory, resolvedManualSteps: unknown): boolean {
  if (!Array.isArray(resolvedManualSteps) || resolvedManualSteps.length === 0) return false;
  const resolved = new Set(resolvedManualSteps);
  const stillPending = memory.pendingManualSteps.filter((s) => !resolved.has(s.step));
  if (stillPending.length === memory.pendingManualSteps.length) return false;

  for (const step of memory.pendingManualSteps) {
    if (resolved.has(step.step)) console.log(`[MEMORY] ✓ Marking resolved, won't be re-flagged: ${step.step}`);
  }
  memory.pendingManualSteps = stillPending;
  appendLiveRules(
    memory,
    (resolvedManualSteps as string[]).map((s) => `${s} — already done, confirmed by the user. Do not re-flag.`)
  );
  return true;
}

function saveCodebaseMemory(memoryFile: string, memory: CodebaseMemory): void {
  try {
    const dir = path.dirname(memoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2), "utf-8");
    console.log(`[MEMORY] 💾 Updated persistent self-improving memory: ${memoryFile}`);
  } catch (err: any) {
    console.warn(`[MEMORY] ⚠️ Failed to persist codebase memory: ${err.message}`);
  }
}

/**
 * Called when the editor circuit-breaks having made zero edits: it searched
 * exhaustively (per agentLoop's breaker) but had nothing concrete to act on.
 * Rather than retry with the same brief that already failed, or fall through
 * to a QA + repair cycle that will hit the identical wall for the identical
 * reason, hand the planner what the editor actually found — real evidence
 * about what does and doesn't exist — so the retry gets narrowed,
 * evidence-backed instructions instead of a second blind guess.
 */
async function refinePhaseInstructions(
  originalInstructions: string,
  inspectedPaths: string[],
  client: OpenRouterClient,
  config: AgentConfig
): Promise<string | undefined> {
  const trail =
    inspectedPaths.length > 0
      ? inspectedPaths.map((p) => `  - ${p}`).join("\n")
      : "  (no files were inspected before the pass ended)";

  const prompt = `The Editor agent was given the phase instructions below and made ZERO file edits after exhaustively searching the codebase:

${originalInstructions}

--- What the Editor actually inspected before giving up ---
${trail}
--- end ---

This usually means one of two things: a target file needs to be CREATED (it does not exist yet — likely because this is a brand-new feature area) rather than found and edited, or the original instructions pointed at the wrong location.

Using the inspection trail above as evidence of what does and does not already exist, rewrite the phase instructions to be unambiguous. For every file the editor needs to touch:
- If it does not exist yet, say so explicitly ("CREATE <path> — this file does not exist yet") and sketch its contents in one short paragraph, referencing whichever inspected file is the closest existing analog (e.g. a sibling screen or model) as the pattern to follow.
- If it exists, name it exactly and describe the specific change to make.

Do not expand the phase's scope beyond its original goal. Output ONLY the revised instructions as plain text, ready to hand directly to the Editor — no preamble, no markdown fences.`;

  try {
    const text = await runLabeledCompletion({
      client,
      models: config.models.planner,
      messages: [
        { role: "system", content: config.prompts.systemPersona },
        { role: "user", content: prompt },
      ],
      agentName: "REPLAN",
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err: any) {
    console.warn(`[REPLAN] ⚠️ Refinement call failed (${err.message}); falling through to normal verification/repair.`);
    return undefined;
  }
}

/**
 * The Planner half of the Editor A -> Editor B -> Planner fallback state
 * machine: called when Editor B failed its takeover on the phase's FIRST
 * failure (phase_replan_count === 0), where the phase is still worth one
 * automated retry.
 *
 * Distinct from refinePhaseInstructions above, which reacts to an editor that
 * concluded on its own without edits. Here the editors never even converged —
 * they timed out, hit a model API error, or exhausted their read budget — so
 * the failure reason itself is part of the evidence handed to the planner,
 * not just the inspection trail.
 *
 * Returns undefined on any failure (or an empty/blank completion) so the
 * caller can continue with the original instructions rather than losing the
 * phase to a second-order error.
 */
async function reformulatePhaseForFallback(
  phaseGoal: string,
  failureReason: string,
  inspectedPaths: string[],
  client: OpenRouterClient,
  config: AgentConfig
): Promise<string | undefined> {
  const prompt = buildPlannerReformulationPrompt(phaseGoal, failureReason, inspectedPaths);

  try {
    const text = await runLabeledCompletion({
      client,
      models: config.models.planner,
      messages: [
        { role: "system", content: config.prompts.systemPersona },
        { role: "user", content: prompt },
      ],
      agentName: "REPLAN",
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err: any) {
    console.warn(`[REPLAN] ⚠️ Reformulation call failed (${err.message}); continuing with the original instructions.`);
    return undefined;
  }
}

/**
 * Editor/repair models aren't guaranteed to support vision the way the
 * planner is checked for before it's handed an attachment (settings.ts
 * requires it only of `models.verifier[0]`) — so this fails closed: on any
 * doubt, callers get `false` and just keep using the plain-text prompt that
 * already works today, never risking an unsupported multimodal payload
 * breaking a call that used to succeed.
 */
async function modelSupportsVision(modelId: string): Promise<boolean> {
  try {
    const { key: probeKey } = loadApiKey();
    const { fetchCatalog } = await import("./models.js");
    const catalog = await fetchCatalog(probeKey!);
    const entry = catalog.find((m) => m.id === modelId);
    return Boolean(entry?.supportsVision);
  } catch {
    return false;
  }
}

/**
 * Wraps a screenshot file as an image content block alongside the text, so
 * REPAIR can look at the actual pixels QA saw instead of trusting QA's own
 * text description of them — a failure like "text overlaps the page edge"
 * is QA's paraphrase, not evidence REPAIR ever saw for itself. Returns the
 * plain text unchanged if the file can't be read (e.g. cleaned up already).
 */
function withScreenshot(text: string, screenshotPath: string | undefined, note: string): string | any[] {
  if (!screenshotPath) return text;
  try {
    const bytes = fs.readFileSync(screenshotPath);
    const ext = path.extname(screenshotPath).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext || "png";
    return [
      { type: "text", text: `${text}\n\n${note}` },
      { type: "image_url", image_url: { url: `data:image/${mime};base64,${bytes.toString("base64")}` } },
    ];
  } catch {
    return text;
  }
}

/**
 * The other half of stage_file_for_deletion: without this, a file the Editor
 * staged for removal (e.g. the empty husk left behind after renaming by
 * create-new-then-retire-old, specifically to avoid QA choking on a
 * mid-rename tree) just sits there forever — staged in memory, never asked
 * about, never removed, and never even reported once the process exits.
 *
 * Deliberately end-of-RUN, not end-of-phase: interrupting an otherwise
 * healthy multi-phase run to ask about one early phase's cleanup would stall
 * progress on every later phase for a question that's just as easy to answer
 * once, at the very end, covering everything staged across the whole run.
 *
 * Runs on both the success and the failure/abort path — completed phases
 * stay committed even when a later one fails, so an earlier phase's staged
 * deletion is real regardless of how the run as a whole ended.
 */
async function confirmStagedDeletions(
  agentTools: AgentTools,
  repoRoot: string,
  runId: string,
  remote: RemoteSession | undefined
): Promise<void> {
  const staged = agentTools.getStagedDeletions();
  if (staged.length === 0) return;

  console.log(`\n🗑️  [CLEANUP] ${staged.length} file(s) were staged for deletion this run:`);
  for (const f of staged) {
    const reason = agentTools.getDeletionReason(f);
    console.log(`   - ${f}${reason ? `  (${reason})` : ""}`);
  }

  const removalCommand = buildRemovalCommand(staged);
  const flagManual = (why: string) =>
    agentTools.flagManualStep({
      step: `Remove ${staged.length} file(s) staged for deletion:\n${removalCommand}`,
      reason: why,
    });

  const removeAll = async (): Promise<void> => {
    let removed = 0;
    for (const f of staged) {
      try {
        fs.unlinkSync(path.join(repoRoot, f));
        removed++;
      } catch (err: any) {
        console.warn(`[CLEANUP] ⚠️ Could not remove ${f}: ${err.message}`);
      }
    }
    console.log(`[CLEANUP] ✓ Removed ${removed}/${staged.length} file(s).`);
    if (removed < staged.length) {
      await flagManual(`${staged.length - removed} of these could not be removed automatically — see the warning above.`);
    }
  };

  // Before a person is asked: the security panel judges the deletion (commandPanel.ts), shown where each file came from and whether git can restore it.
  // All judges safe = it is done, even with nobody here. Otherwise the person is asked, and sees what the judges said.
  let panelNote = "";
  const outside = escapesProject(staged);
  if (!outside) {
    const evidence = describeStagedDeletions(repoRoot, staged, { createdThisRun: (f) => agentTools.createdThisRun(f), reasonOf: (f) => agentTools.getDeletionReason(f) });
    const review = await agentTools.reviewAction({
      kind: "file-deletion",
      label: `${staged.length} file(s) the agent staged for deletion`,
      purpose: "clean up files the agent marked for removal during this run",
      details: evidence.join("\n"),
      repoRoot,
    });
    if (review?.allow) {
      console.log(`[SECURITY] ✔ Deleting without asking: ${review.why}`);
      await removeAll();
      return;
    }
    if (review) {
      panelNote = review.why;
      console.log(`[SECURITY] ✋ Needs a person: ${review.why}`);
    }
  }

  // Same "is anyone actually here to ask" guard the git-push prompt above
  // uses — an unattended run must never stall waiting for a confirmation
  // nobody's there to give, and deleting nothing is always the safe default.
  const canAsk = isInteractive() || Boolean(remote?.connected);
  if (!canAsk) {
    console.log(`[CLEANUP] No one available to confirm right now — leaving these files in place.`);
    console.log(`[CLEANUP] Remove them yourself when ready:\n  ${removalCommand}`);
    await flagManual("Nobody was available to confirm deletion at the end of the run.");
    return;
  }

  const answer = await askAnywhere(
    {
      id: `cleanup_${runId}`,
      kind: "blocking",
      prompt:
        `${staged.length} file(s) were staged for deletion this run:\n${staged.map((f) => `- ${f}`).join("\n")}\n\n` +
        `${panelNote ? `Security review: ${panelNote}\n\n` : ""}Remove them now?`,
      fallback: "no",
      askedAt: new Date().toISOString(),
    },
    `Remove these ${staged.length} file(s)? ${YES_NO_ENTER_NO}: `
  );

  if (!answer.trim().toLowerCase().startsWith("y")) {
    console.log(`[CLEANUP] Leaving these files in place. Remove them yourself when ready:\n  ${removalCommand}`);
    await flagManual("You chose not to remove them automatically at the end of the run.");
    return;
  }

  await removeAll();
  // Left uncommitted deliberately: reviewAndResolvePendingChanges already
  // reviews and commits exactly this kind of leftover working-tree change at
  // the start of the next task, rather than this function needing its own
  // separate commit path for a run that's already otherwise finished.
}

/**
 * Runs one SETUP phase (planned.executor === "SETUP"): install/restore the
 * project's dependencies, analyze the result, and only call the SETUP persona
 * when the output has something to diagnose — see setupPhase.ts for the loop.
 * Not QA (no verifier, no model verdict) and not EDITOR (no implementation
 * pass); the only files it may ever touch are dependency manifests, and only
 * when the phase text does not forbid it.
 */
async function runSetupPhaseInPipeline(
  phase: TaskPhase,
  planned: PlannedPhase,
  repoRoot: string,
  repo: RepoTools,
  client: OpenRouterClient,
  config: AgentConfig,
  agentTools: AgentTools,
  remote: RemoteSession | undefined
): Promise<boolean> {
  const phaseName = phase.name;
  console.log(`\n[SETUP] 🧰 Starting environment setup for ${phaseName}...`);

  agentTools.beginPhase([], config.limits.maxFilesPerPhase, phaseName);
  agentTools.setActiveAgent("SETUP");
  const preExistingDirty = await snapshotDirtyPaths(repo);

  // Manifests that actually exist: root-level ones plus anything the plan named.
  const rootEntries = fs.existsSync(repoRoot) ? fs.readdirSync(repoRoot) : [];
  const named = (planned.files ?? []).filter((f) => fs.existsSync(path.join(repoRoot, f)));
  const matches = detectChangedManifests([...rootEntries, ...named]);
  const steps = resolveAbsoluteInstallPlan(matches, repoRoot);
  const manifestFiles = matches.map((m) => m.path);

  const phaseText = `${planned.goal}\n${(planned.changes ?? []).join("\n")}`;
  const editsAllowed = !manifestEditsForbidden(phaseText);
  const models = config.models.repair ?? config.models.editor;
  const maxRuns = (config.limits?.maxRepairAttemptsPerPhase ?? 10) + 1;

  const canAsk = isInteractive() || Boolean(remote?.connected);
  const isEditableManifest = (file: string): boolean => {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return false;
    if (LOCK_FILE_NAMES.includes(path.posix.basename(normalized))) return false;
    return detectChangedManifests([normalized]).length > 0;
  };

  const result = await runSetupPhase({
    steps,
    maxRuns,
    editsAllowed,
    log: (line) => console.log(line),
    approve: async (summary) => {
      if (canAsk) {
        return askDependencyInstallApproval(
          `Install dependencies now? This runs: ${summary}`,
          `setupinstall_${phase.id ?? phaseName}_${Date.now()}`
        );
      }
      if (config.interaction.autonomous) {
        console.log(`[SETUP] Autonomous mode, nobody to ask — proceeding with: ${summary}`);
        return true;
      }
      console.log(`[SETUP] No interactive terminal and not autonomous — not running: ${summary}`);
      return false;
    },
    runStep: (command, cwd) => runInstallCommandCaptured(command, cwd),
    isEditableManifest,
    applyEdit: async (edit) => {
      await agentTools.patchFile(edit.file, edit.search, edit.replace);
    },
    diagnose: async ({ attempt, output, analysis, history }) => {
      const manifests = editsAllowed
        ? manifestFiles
            .filter(isEditableManifest)
            .map((file) => {
              try {
                return { file, content: fs.readFileSync(path.join(repoRoot, file), "utf-8") };
              } catch {
                return undefined;
              }
            })
            .filter((m): m is { file: string; content: string } => Boolean(m))
        : [];
      const prompt = buildSetupDiagnosisPrompt({
        phaseGoal: planned.goal,
        steps,
        output,
        analysis,
        attempt,
        history,
        editsAllowed,
        manifests,
      });
      try {
        const text = await runLabeledCompletion({
          client,
          models,
          agentName: "SETUP",
          jsonMode: true,
          messages: [
            { role: "system", content: `${config.prompts.systemPersona}\n\n${SETUP_SYSTEM}` },
            { role: "user", content: prompt },
          ],
          ...(attempt > 0 ? { attempt: attempt + 1, reason: "install re-run after a manifest fix" } : {}),
        });
        return parseSetupDiagnosis(text);
      } catch (err: any) {
        console.warn(`[SETUP] ⚠️ Diagnosis call failed: ${err?.message ?? err}`);
        return undefined;
      }
    },
  });

  for (const m of result.manualSteps) {
    await agentTools.flagManualStep({ step: m.step, reason: m.reason || "Reported by SETUP." });
  }

  events.emit({
    type: "gate.result",
    tier: "setup",
    gate: "dependency-install",
    status: result.passed ? "pass" : "fail",
    blocking: true,
    detail: result.summary.slice(0, 500),
  });

  if (!result.passed) {
    console.error(`\n⛔ [SETUP] ${result.summary}`);
    const tail = result.lastOutput.split(/\r?\n/).slice(-40).join("\n");
    if (tail.trim()) console.error(`--- last install output ---\n${tail}\n---------------------------`);
    return false;
  }

  console.log(
    `\n✅ [SETUP COMPLETE] ${result.summary}` +
      (result.runs > 1 ? ` (${result.runs} install runs, edited: ${result.edited.join(", ") || "none"})` : "")
  );

  // Only a manifest fix leaves anything to commit; a clean install touches no tracked file.
  if (result.edited.length > 0 && config.git?.autoCommit) {
    const touched = await agentTouchedPaths(repo, preExistingDirty);
    if (touched.length > 0) {
      await commitOnly(repo.git, touched, `${config.git.commitPrefix}: completed phase - ${phaseName}\n\nSETUP: ${result.summary}`, (l) => console.warn(l));
    }
  }
  return true;
}

async function runPhaseWithHealing(
  phase: TaskPhase,
  repoRoot: string,
  repo: RepoTools,
  client: OpenRouterClient,
  config: AgentConfig,
  verifier: AutonomousVerifier,
  agentTools: AgentTools,
  memory: CodebaseMemory,
  memoryFile: string,
  imageAttachments: Attachment[],
  editorSupportsVision: boolean,
  // The chain actually used for the Editor/Repair calls below — either
  // config.models.editor (the normal chain) or config.models.editorVision
  // (this whole phase, when the task has an image), decided once per task,
  // never re-derived per call so Editor and Repair always agree on which
  // one they're using.
  effectiveEditorModels: string[],
  usingEditorVision: boolean,
  // Only used to decide whether the dependency gates below are even worth
  // asking (see canAskAboutDependencies) — matches the isInteractive() ||
  // remote?.connected check every other askAnywhere call site in this file
  // already uses, rather than the narrower isTTY-only check this phase loop
  // had before remote was threaded through.
  remote: RemoteSession | undefined,
  // Set when the task's intent classified as "verify" rather than "task" —
  // this phase is a checkable SCENARIO (from PLANNER_VERIFY_SYSTEM), not an
  // implementation diff. Skips Editor's initial A/B pass entirely and goes
  // straight to verification; a bug QA actually finds still gets the normal
  // REPAIR_PLANNER-triage -> REPAIR-fix -> re-verify loop below, untouched.
  verifyOnly = false
): Promise<boolean> {
  const phaseName = phase.name;
  // The phase loop's own banner (main(), just before this is called) already
  // announces the phase starting — this was a second, near-identical box
  // right underneath it for the same event. One line is enough to mark the
  // handoff from planning to actually implementing it.
  console.log(
    verifyOnly
      ? `\n[QA] 🔍 Starting verification for ${phaseName}...`
      : `\n[EDITOR] 🚀 Starting implementation for ${phaseName}...`
  );

  const checkpointTag = await repo.createCheckpoint(phaseName);
  if (checkpointTag) {
    console.log(`[CHECKPOINT] Created restore point: ${checkpointTag}`);
  }

  // Reset the per-phase write budget so one phase's wandering cannot accumulate
  // across phases, and tell the tools which files this phase expects to touch.
  agentTools.beginPhase(phase.allowedPaths ?? [], config.limits.maxFilesPerPhase, phaseName);

  // Record what the user already had uncommitted so we never revert or commit it.
  const preExistingDirty = await snapshotDirtyPaths(repo);
  if (preExistingDirty.size > 0) {
    console.log(
      `[GIT] ⚠️ Working tree already has ${preExistingDirty.size} uncommitted change(s). ` +
        `These will be preserved and excluded from the agent's commits. Review and commit them with /push-local.`
    );
  }

  console.log(
    `[EDITOR${usingEditorVision ? " - VISION" : ""}] Executing with editor models: ${effectiveEditorModels.join(", ")}`
  );
  if (imageAttachments.length > 0 && editorSupportsVision) {
    console.log(`[EDITOR] 🖼️ Attaching ${imageAttachments.length} reference image(s) to this phase's prompt.`);
  }

  // Editor B's model chain: the backup entries of the effective chain. With
  // no backup configured this is the same chain as Editor A's, so a handoff
  // still works — Editor B just runs the primary model.
  const backupEditorModels =
    effectiveEditorModels.length > 1 ? effectiveEditorModels.slice(1) : effectiveEditorModels;
  // The chain EVERY editor-bearing call for the rest of this phase uses.
  // Editor A starts on the primary chain; a successful A->B handoff switches
  // this to the backup chain and nothing resets it back, so the takeover turn
  // AND every later call that depends on editor models (visual adjustments,
  // the question resolver) keeps using Editor B's model. Repair attempts
  // below use their own, independent chain — see effectiveRepairModels.
  let currentEditorModels = effectiveEditorModels;

  // Repair reuses Editor's chain by default — repair IS editor work, just
  // triggered by a failed verification instead of a fresh phase. But
  // diagnosing someone else's failure from error text alone is a harder
  // task than executing an already-clear plan, so models.repair is a
  // deliberate, optional override to run Repair on a different (often
  // stronger) model while keeping Editor itself cheap. Unconfigured: falls
  // back to effectiveEditorModels exactly, so existing configs behave
  // identically to before this split existed.
  const effectiveRepairModels =
    (usingEditorVision ? config.models.repairVision : config.models.repair) ?? effectiveEditorModels;
  if (effectiveRepairModels !== effectiveEditorModels) {
    console.log(`[REPAIR] Configured with its own model chain: ${effectiveRepairModels.join(", ")}`);
  }
  // Repair's own backup entries, same pattern as backupEditorModels above
  // but tracked independently so an Editor A->B handoff and a Repair
  // primary->backup handoff never interfere with each other.
  const backupRepairModels =
    effectiveRepairModels.length > 1 ? effectiveRepairModels.slice(1) : effectiveRepairModels;
  // The chain every REPAIR (not Editor/Editor-B) call below uses — switches
  // to backupRepairModels once the primary repair model is stuck, mirroring
  // currentEditorModels's own handoff, just scoped to repair attempts only.
  let currentRepairModels = effectiveRepairModels;

  const runEditorPass = (
    instructions: string,
    trackToolCall?: (name: string, args: Record<string, unknown>) => void,
    variant?: "editorA" | "editorB"
  ) => {
    if (variant === "editorB") {
      currentEditorModels = backupEditorModels;
      console.log(`[EDITOR B] Switching to backup editor model(s): ${currentEditorModels.join(", ")}`);
    }
    // Read per pass, not once: an edit the user makes to YIMPIM.md mid-run
    // takes effect on the next pass.
    const projectNotes = loadProjectContext(repoRoot);
    const text = `You are executing implementation phase: ${phaseName}

Live Project Rules & Pitfalls to Avoid:
${memory.liveRules.map((r) => `- ${r}`).join("\n") || "No custom rules recorded yet."}
${projectNotes ? `\n${projectNotes}\n` : ""}
Instructions:
${instructions}`;
    // The planner already saw these images once and folded whatever it
    // noticed into the phase instructions above — but a one-shot paraphrase
    // loses pixel-level detail a real fix needs. Re-attaching the original
    // image here means Editor can look for itself instead of trusting that
    // paraphrase, same reasoning as REPAIR seeing QA's screenshot below.
    const prompt =
      imageAttachments.length > 0 && editorSupportsVision ? buildUserContent(text, imageAttachments) : text;
    return runToolAgent({
      prompt,
      phase,
      repo,
      repoRoot,
      client,
      config,
      agentTools,
      models: currentEditorModels,
      agentName: "EDITOR",
      visionMode: usingEditorVision,
      // When set, feeds the orchestrator's ReadTracker so the A->B handoff
      // can detect analysis paralysis round-by-round (see orchestrator.ts).
      onToolCall: trackToolCall,
    });
  };

  // Whatever the Editor (or a later REPAIR pass) says right after it's the
  // one that just wrote the behavior — the closest thing to acceptance
  // criteria this pipeline can produce, since the Planner's own verification
  // goal was necessarily written before any of this code existed. Folded
  // into the goal the Verifier actually checks against, below.
  let editorHowToVerify: string | undefined;
  let uiUnreachable = false;
  // What the Editor (or a later Repair) reported differing from a planned
  // assertion. In-memory only: a resumed phase re-derives them on its next pass.
  let editorDeltas: AssertionDelta[] = [];
  // The Editor's claim that the permanent tests need no change, with its reason.
  let editorTestsNotNeeded: string | undefined;
  const mergeDeltas = (a: AssertionDelta[], b: AssertionDelta[]): AssertionDelta[] => {
    const byId = new Map(a.map((d) => [d.id, d]));
    for (const d of b) byId.set(d.id, d);
    return [...byId.values()];
  };
  let editorNoOpClaim: string | undefined;

  // A phase resumed after exhausting its repair budget in an EARLIER process
  // (yimpim --resume) used to start this loop from zero every time — the exact
  // scenario repair history exists for (a fix that needs more than one
  // process's worth of tries) got no benefit from it at all across a restart.
  // Seeded here, before the fresh initial Editor pass runs below: `resumed`
  // being set means the LAST thing said before the restart hasn't yet been
  // reconciled against a fresh verification, so the loop's own
  // "close the loop on the previous attempt" logic finalizes that missing
  // history entry the moment this attempt's verification comes back —
  // exactly as if the process had never restarted at all.
  const resumed = phase.id ? loadPhaseRepairContext(repoRoot, phase.id) : undefined;
  // Focused tests left behind by an aborted earlier attempt are the harness's own
  // scratch files; a fresh (non-resumed) phase starts without them.
  const legacyQuarantined = neutralizeLegacyQuarantine(repoRoot);
  if (legacyQuarantined > 0) {
    console.log(`[REVERT] Renamed ${legacyQuarantined} old quarantined file(s) so test runners stop picking them up.`);
  }
  if (!resumed) {
    const stale = clearFocusFiles(repoRoot);
    if (stale > 0) console.log(`[TESTS] Removed ${stale} leftover focused test file(s) from an earlier attempt.`);
  }
  // What the Editor said last time (assertion differences, "tests need no change")
  // survives a restart, so a resumed Editor that finds its work already in place and
  // concludes "done" without repeating those claims does not lose them.
  if (resumed?.assertionDeltas?.length) editorDeltas = mergeDeltas(editorDeltas, resumed.assertionDeltas as AssertionDelta[]);
  if (resumed?.testsNotNeeded && !editorTestsNotNeeded) editorTestsNotNeeded = resumed.testsNotNeeded;
  if (resumed) {
    console.log(
      `[REPAIR] Resuming with ${resumed.repairHistory.length} prior attempt(s) already recorded for this phase.`
    );
  }

  if (!verifyOnly) {
  try {
    // The initial Editor pass runs under the analysis-paralysis loop: a
    // ReadTracker watches every tool call Editor A makes (2 rounds of 8
    // reads with zero edits = stalled), benches A on a stall, and hands the
    // same phase to Editor B with the takeover directive. Editor B runs
    // inside the interceptor, so model timeouts / OpenRouter 5xx / stall
    // errors come back as structured failure results ({ ok: false, failure })
    // rather than raw exceptions crashing the run.
    //
    // A failed takeover drives a two-step fallback state machine, budgeted by
    // phase_replan_count (per phase execution, reset to 0 here):
    //   0 -> the planner reformulates just this phase, then Editor A re-runs
    //        with the reformulated instructions (phase_replan_count becomes 1).
    //   1 -> the replan has been spent and B still failed: the Planner reads the
    //        code and gives Editor A the exact file, section and change (once).
    //        If it cannot, or the Editor still stalls, the phase fails cleanly.
    //        No human is asked: they cannot know what the Editor was doing.
    let phaseReplanCount = 0;
    // The Planner steps in at most once, so a phase that keeps stalling ends
    // instead of looping.
    let plannerDirected = false;
    let phaseGoal = phase.instructions;
    // Distinct inspected paths from the most recent handoff — the evidence
    // trail both the planner reformulation and the user-facing escalation
    // diagnostic are built from.
    let inspectedPaths: string[] = [];
    let editorResult = "";

    while (true) {
      const handoff = await runEditorWithHandoff({
        runEditor: (instructions: string, trackToolCall, variant) =>
          runEditorPass(instructions, trackToolCall, variant),
        hasWrittenFiles: () => agentTools.filesWrittenThisPhase().length > 0,
        initialInstructions: phaseGoal,
      });
      if (handoff.ok) {
        editorResult = handoff.result;
        inspectedPaths = handoff.inspectedPaths;
        break;
      }

      inspectedPaths = handoff.inspectedPaths;
      console.error(`\n⛔ [EDITOR B FAILURE] (${handoff.failure.kind}) ${handoff.failure.message.slice(0, 500)}`);
      console.error(
        `   Editor A stalled and Editor B could not take over (replans used: ${phaseReplanCount}/1).`
      );

      if (decideEditorFailureAction(phaseReplanCount) === "replan") {
        // First failure: one surgical reformulation, not a re-plan. The
        // planner gets the structured failure reason plus what the editors
        // actually inspected, so the rewrite is evidence-backed rather than a
        // second paraphrase of the same unactionable brief.
        phaseReplanCount = 1;
        console.log(
          `\n🧭 [REPLAN] Editor B failed on its first takeover — asking the planner to reformulate this phase...`
        );
        const reformulated = await reformulatePhaseForFallback(
          phaseGoal,
          handoff.failure.message,
          inspectedPaths,
          client,
          config
        );

        // Read trackers and the active editor are per-pass state owned by
        // runEditorWithHandoff/runToolAgent; what the ORCHESTRATOR has to
        // reset here is the tool-observed per-phase state, so the retry's
        // "did it write anything" and "what did it inspect" answers describe
        // the retry rather than being polluted by the two failed passes.
        agentTools.beginPhase(phase.allowedPaths ?? [], config.limits.maxFilesPerPhase, phaseName);

        // This branch deliberately goes BACK to Editor A with a reformulated
        // brief, so the takeover's backup chain must not leak into it — the
        // retry is a fresh Editor A pass and starts on the primary chain
        // again. (Any LATER handoff re-switches it, exactly as it did here.)
        currentEditorModels = effectiveEditorModels;

        if (!reformulated) {
          console.error(
            `[REPLAN] ⚠️ Planner returned no usable reformulation — continuing with the original instructions.`
          );
        } else {
          phaseGoal = reformulated;
          console.log(`[REPLAN] ✓ Phase reformulated — re-running Editor A with the narrowed instructions.`);
        }
        continue;
      }

      // phase_replan_count >= 1: the replan budget is spent and the phase is
      // still failing. No human is asked: they never saw what the Editor read
      // or why it froze, so they cannot say where the change goes. The Planner
      // can, because it can read the code, so it steps in with the exact file,
      // the exact section and the exact change, and the Editor is re-run on
      // that. If the Planner cannot name a file, or the Editor stalls even on
      // an exact directive, the phase fails cleanly with the reason.
      console.error(`\n🚨 [CIRCUIT BREAKER] The Editor stalled twice and the one re-plan is spent.`);
      console.error(formatEscalationSummary(phaseGoal, handoff.failure.message, inspectedPaths));

      if (plannerDirected) {
        console.error(
          `\n⛔ [CIRCUIT BREAKER] The Editor stalled again even with the Planner's exact directive. Failing this phase; its changes will be undone.`
        );
        return false;
      }
      plannerDirected = true;

      console.log(`\n🧭 [PLANNER] Reading the code to tell the Editor the exact file and section to change...`);
      let directive: string | undefined;
      try {
        const stallTargets = candidateTargets(inspectedPaths, repoRoot);
        agentTools.beginPlannerInspection(stallTargets, plannerReadBudget(stallTargets.length));
        directive = await runToolAgent({
          prompt: buildStallDirectivePrompt(phaseGoal, handoff.failure.message, stallTargets),
          phase,
          repo,
          repoRoot,
          client,
          config,
          agentTools,
          models: config.models.repairPlanner ?? config.models.planner,
          agentName: "REPAIR_PLANNER",
          tools: PLANNER_TOOLS_SCHEMA,
          maxRoundsOverride: 12,
          reason: "Stalled Editor: naming the exact file and section to change",
        });
      } catch (err: any) {
        console.warn(`[PLANNER] ⚠️ The directive pass failed (${err.message}).`);
      }
      const named = directive ? namedTargets(directive, repoRoot) : [];
      if (!directive || named.length === 0) {
        console.error(
          `\n⛔ [CIRCUIT BREAKER] The Planner could not name a file to change, so there is no safe way forward. Failing this phase cleanly; its changes will be undone.`
        );
        return false;
      }
      console.log(
        `\n🎯 [PLANNER DIRECTIVE] ${named.map((t) => (t.exists ? t.path : `${t.path} (new)`)).join(", ")}. Re-running the Editor on it.`
      );
      phaseGoal = `${renderPlannerDirective(directive, named)}\n\nInstructions:\n${phaseGoal}`;
      agentTools.beginPhase(phase.allowedPaths ?? [], config.limits.maxFilesPerPhase, phaseName);
      continue;
    }

    // The editor searched exhaustively but never wrote anything — usually the
    // phase's file list was too vague to act on (common for a brand-new
    // feature area where "add to an existing file" vs "create a new file"
    // isn't obvious from the goal alone). Ask the planner to narrow it once,
    // using what the editor actually found, instead of running a full QA +
    // repair cycle against an unchanged tree. Skipped when the fallback state
    // machine above already reformulated this phase (phaseReplanCount > 0) —
    // the planner has just been asked once, and asking it again here would
    // re-narrow an already-narrowed phase.
    if (
      phaseReplanCount === 0 &&
      editorResult.startsWith("CIRCUIT_BREAKER_STUCK") &&
      agentTools.filesWrittenThisPhase().length === 0
    ) {
      console.log(
        `\n🧭 [REPLAN] Editor made no edits after exhaustive search. Asking the planner to narrow the phase using what it found...`
      );
      const refined = await refinePhaseInstructions(phase.instructions, agentTools.inspectedThisPhase(), client, config);
      if (refined) {
        agentTools.beginPhase(phase.allowedPaths ?? [], config.limits.maxFilesPerPhase, phaseName);
        editorResult = await runEditorPass(refined);
      }
    }

    if (editorResult.includes("TASK_ALREADY_SATISFIED")) {
      console.log(`\n⚡ [NO-OP RECOGNIZED] Editor verified the requested behavior is already present.`);
      // Handed to QA below. Without it, the change-set gate sees an empty diff
      // and blocks the phase as "no file changes produced" — failing a phase
      // that may be legitimately complete, and doing so before any gate has
      // checked whether the behavior is actually there.
      editorNoOpClaim = editorResult.replace(/^.*TASK_ALREADY_SATISFIED:\s*/s, "").trim() || "already implemented";
    }

    editorHowToVerify = extractHowToVerify(editorResult);
    uiUnreachable = isUiUnreachableNote(editorHowToVerify) || isUiUnreachableNote(editorResult);
    editorDeltas = mergeDeltas(editorDeltas, extractAssertionDeltas(editorResult));
    editorTestsNotNeeded = extractTestsNotNeeded(editorResult) ?? editorTestsNotNeeded;
  } catch (err: any) {
    if (err.message.startsWith("ESCALATION_NEEDED")) {
      console.error(`\n⚠️ [EDITOR ESCALATION] ${err.message}`);
      return false;
    }
    throw err;
  }
  } else {
    // Verify-only: no Editor pass at all — editorResult/inspectedPaths and
    // editorNoOpClaim stay at their initial empty/undefined values. An
    // expected-empty diff here is NOT treated as a blocking failure — the
    // verifyOnly flag passed to verifier.runVerification below handles that
    // directly (see changeSetGate's own comment), so there's no synthetic
    // claim to seed here. Only covers the FIRST verification attempt: the
    // moment a real defect sends this phase into REPAIR, a still-empty diff
    // AFTER a repair attempt correctly blocks again, same as a normal task.
    console.log(`[QA] No implementation pass for this scenario — verifying current behavior directly.`);
  }

  // Human-in-the-loop dependency gate, immediately after the editor finished
  // and BEFORE the verifier loop starts. A phase that edited a dependency
  // manifest has changed the project's dependency set, and nothing else in
  // this pipeline installs it — the verifier would compile/test against a
  // stale tree, report a build failure that looks like a code defect, and burn
  // the entire repair budget on something no code change can fix. Asking first
  // (rather than installing automatically) keeps arbitrary package-manager
  // scripts from running against the user's machine without consent. The gate
  // is best-effort and never fatal: no manifest touched, a declined prompt, or
  // a failed install all return normally and verification proceeds as usual.
  // Same "is anyone actually able to answer" check every other askAnywhere
  // call site in this file uses — narrower than that (isTTY alone) would miss
  // a headless/backgrounded terminal with only a phone connected; broader than
  // that (always ask) would wait forever on the remote race when truly nobody
  // is there, in a genuinely unattended run.
  const canAskAboutDependencies = isInteractive() || Boolean(remote?.connected);
  const preVerificationDeps = await handleDependencyInstallGate({
    writtenFiles: agentTools.filesWrittenThisPhase(),
    cwd: repoRoot,
    prompter: canAskAboutDependencies
      ? (message) => askDependencyInstallApproval(message, `depinstall_${phase.id ?? phaseName}_${Date.now()}`)
      : undefined,
    npmVersionVerifier: verifyAndFixNpmVersions,
  });

  // Post-phase interactive gate: the same problem seen from the other side.
  // `handleDependencyInstallGate` above is driven by the editor's own write log
  // (and therefore only ever sees manifests the editor reported writing);
  // this one is driven by the PHASE's own file list plus each file's real git
  // diff, so a manifest the plan named but the write log did not surface still
  // gets its dependency change caught before QA. The user is offered three
  // explicit answers — install now, skip and let QA run, or abort the phase —
  // and each file is anchored to its own containing directory, rejected
  // outright if that resolves outside the repo. Best-effort and non-fatal
  // except for the one case where continuing is worse than stopping: an
  // APPROVED install that then failed, where QA would report the missing
  // dependency as a code defect and burn the whole repair budget on it.
  let postPhaseDeps = await handlePostPhaseDependencies(
    phase.files || [],
    repoRoot,
    {
      prompter: canAskAboutDependencies
        ? (message) => askPostPhaseDependencyChoice(message, `depchoice_${phase.id ?? phaseName}_${Date.now()}`)
        : undefined,
      npmVersionVerifier: verifyAndFixNpmVersions,
    },
    // Don't ask twice for the same underlying change: this gate's own diff-
    // based detection commonly rediscovers the exact manifest the write-log-
    // driven gate above already asked about and installed.
    preVerificationDeps.executed ? preVerificationDeps.plan ?? [] : []
  );

  // An install failure (as opposed to the user explicitly declining) is very
  // often a one-line, mechanically diagnosable mistake — most commonly a
  // manifest naming a dependency version that was never published (a
  // hallucinated version number). That's worth one automatic Editor pass
  // before burning the whole phase and handing it back to the user to fix by
  // hand: unlike a real build/QA failure, there is nothing here for the
  // repair loop below to verify against yet, since the tree never finished
  // installing in the first place. Re-runs the exact already-resolved
  // command(s) directly afterward — NOT through handlePostPhaseDependencies
  // again — so this doesn't re-ask the user for an install they already said
  // yes to once this phase.
  if (postPhaseDeps.aborted && postPhaseDeps.reason === "install_failed" && postPhaseDeps.plan) {
    console.log(
      `\n[DEPENDENCIES] Install failed — likely a wrong/nonexistent package version rather than a real ` +
        `code defect. Attempting one automatic repair before giving up on this phase.`
    );
    try {
      await runToolAgent({
        prompt:
          `Installing this phase's dependencies just failed with this error:\n\n` +
          `${(postPhaseDeps.errorDetail ?? "").slice(-4000)}\n\n` +
          `This is almost always a manifest (e.g. package.json) declaring a dependency at a version that was ` +
          `never published, not a real code defect. Find the offending dependency/version in the manifest(s) ` +
          `this phase touched and correct it to a real, currently-published, compatible version. Do not change ` +
          `anything else.`,
        phase,
        repo,
        repoRoot,
        client,
        config,
        agentTools,
        models: currentEditorModels,
        agentName: "EDITOR",
        visionMode: usingEditorVision,
      });

      console.log(`[DEPENDENCIES] Retrying the install after the repair attempt...`);
      for (const step of postPhaseDeps.plan) {
        console.log(`[DEPENDENCIES] ⚙️ Running: ${step.command}  (in ${step.cwd})`);
        await runInstallCommand(step.command, step.cwd);
      }
      console.log(`[DEPENDENCIES] ✓ Dependencies installed after repair.`);
      postPhaseDeps = { ...postPhaseDeps, aborted: false, executed: true };
    } catch (err: any) {
      console.error(`[DEPENDENCIES] ⛔ Still failing after the automatic repair attempt: ${err?.message ?? err}`);
    }
  }

  if (postPhaseDeps.aborted) {
    console.error(
      `\n⛔ [DEPENDENCIES] Phase "${phaseName}" aborted at the dependency gate — ` +
        `not verifying against a tree whose dependencies are known to be missing.`
    );
    return false;
  }

  const maxRepairs = config.limits?.maxRepairAttemptsPerPhase ?? 10;
  let attempt = 0;
  // Cost visibility: printed after every attempt so a run that's spinning
  // through repairs is visible AS IT HAPPENS, not just in the final summary.
  const phaseUsageStart = events.usageReport().totals;
  // "Same failure reported twice in a row" means the last repair attempt
  // didn't move the needle — retrying further just burns the rest of the
  // budget on a fix that isn't landing, so this stops the loop early instead.
  let previousFailureSignature: string | undefined;
  // A vision model is the least reliable evidence in this pipeline, so a
  // visual-only failure gets its own (separately trackable) counter — but a
  // vision call is cheap, and a real, well-diagnosed rendering defect (as
  // opposed to a hallucinated one) routinely needs more than one attempt to
  // actually land, the same as any other failure kind. Matches maxRepairs
  // itself: raising this further than that has no additional effect, since
  // the outer loop below is already bounded at maxRepairs attempts.
  let visualOnlyRepairs = 0;
  const maxVisualOnlyRepairs = config.limits?.maxVisualOnlyRepairAttempts ?? 3;
  let stopReason: "no_progress" | "visual_cap" | "environmental" | "declined" | "out_of_reach" | undefined;
  // Whether the last repair attempt wrote anything (undefined until one has run), and what was out of its reach when it stopped for that.
  let lastRepairEdited: boolean | undefined;
  let outOfReach: OutOfReach | undefined;
  // The "these failures look unrelated to your change" question is asked once per phase.
  // Set when the failing tests were already red before this phase (see above).
  let testDebtNote = "";
  // The testability pass (see testability.ts) runs at most once per phase.
  let testabilityTried = false;
  // True once a no-progress trip (below) or the attempt-count halfway mark
  // has switched this phase's repair attempts onto the backup editor
  // model(s) — see evaluateRepairProgress's own comment for why this exists:
  // without it, a primary model stuck repeating its own failure reliably
  // trips no-progress within its first couple of attempts, long before the
  // attempt-count-based halfway switch ever got a turn, making the backup
  // chain effectively unreachable in practice.
  let repairUsingBackup = false;
  // A prior repair attempt's own explanation of what it changed, paired with
  // what QA found wrong afterward — threaded into the NEXT repair prompt so
  // Editor sees the actual attempt/outcome history, not just the latest
  // failure in isolation. Without this, a fix that only half-addresses a
  // complaint (e.g. keeping the exact mechanism the requirement forbids)
  // looks, to the next repair call, identical to a totally fresh defect.
  const repairHistory: string[] = resumed ? [...resumed.repairHistory] : [];
  let lastRepairExplanation: string | undefined = resumed?.editorHowToVerify;
  if (resumed?.uiUnreachable) uiUnreachable = true;

  // Saved before the first verification, so a crash or Ctrl-C during it still
  // resumes with what the Editor claimed. editorHowToVerify is left out on
  // purpose: on resume it seeds "what the last repair said it did", which a
  // how-to-verify note is not.
  if (phase.id && (editorDeltas.length > 0 || editorTestsNotNeeded)) {
    savePhaseRepairContext(repoRoot, phase.id, {
      repairHistory: [...repairHistory],
      assertionDeltas: editorDeltas,
      testsNotNeeded: editorTestsNotNeeded,
    });
  }

  lastPhaseRuns = 1;
  lastPhaseConfidence = undefined;
  const seenFailureSignatures = new Set<string>();
  while (attempt <= maxRepairs) {
    lastPhaseRuns = attempt + 1;
    console.log(`\n[VERIFIER] 🛡️ Running verification for ${phaseName} (Attempt ${attempt + 1}/${maxRepairs + 1})...`);

    // Verify against the phase's own acceptance criteria, not the editor
    // brief — enriched with the Editor's own how-to-verify notes when it left
    // any, since those describe the mechanics of what was actually built
    // rather than what the Planner predicted would be built.
    const baseGoal = phase.verificationGoal ?? phase.instructions;
    const verificationGoal =
      (editorHowToVerify ? `${baseGoal}${HOW_TO_VERIFY_GOAL_MARKER}${editorHowToVerify}` : baseGoal) +
      renderDeltasForGoal(editorDeltas) +
      renderTestsNotNeededForGoal(editorTestsNotNeeded);
    // Focused tests the agents wrote are tracked so QA can run exactly them and
    // the harness can fold in or delete them afterwards.
    registerFocusFiles(repoRoot, agentTools.filesWrittenThisPhase());
    const result: VerificationResult = await verifier.runVerification(
      verificationGoal,
      editorNoOpClaim,
      agentTools.getStagedDeletions(),
      preExistingDirty,
      verifyOnly,
      { uiUnreachable, taskBaseSha: currentTaskBaseSha }
    );

    // Close the loop on the PREVIOUS repair attempt, if there was one: pair
    // what it said it did with what QA found wrong afterward, before that
    // context is lost to the next attempt's fresh-looking failure text.
    if (lastRepairExplanation && !result.passed) {
      repairHistory.push(
        `Attempt ${attempt}: you said — "${lastRepairExplanation}"\n` +
          `QA then found: ${(result.errorOutput || "the same class of failure").slice(0, 600)}`
      );
    }
    lastRepairExplanation = undefined;

    // Persisted after every closed-loop update (not only on final failure) so
    // a crash or Ctrl-C mid-loop still resumes with whatever was learned up
    // to this point — see savePhaseRepairContext's own comment.
    if (phase.id && !result.passed) {
      savePhaseRepairContext(repoRoot, phase.id, { editorHowToVerify, uiUnreachable, repairHistory, assertionDeltas: editorDeltas, testsNotNeeded: editorTestsNotNeeded });
    }

    const usageSoFar = events.usageReport().totals;
    const phaseCalls = usageSoFar.calls - phaseUsageStart.calls;
    const phaseTokens = usageSoFar.total - phaseUsageStart.total;
    console.log(`[COST] "${phaseName}": ${formatTokens(phaseTokens)} tokens across ${phaseCalls} model calls so far.`);

    // A red test run whose failing tests load nothing this phase changed was
    // already red: a test that drifted from the code before this phase began.
    // That is never a reason to skip it, to abort, or to ask a person (they
    // cannot know what drifted). It is stale-test debt, and the repair below is
    // told so: bring the test and the code back in line, updating the existing
    // test in place. See failureAttribution.ts for how "already red" is decided.
    testDebtNote = "";
    if (!result.passed) {
      const changed = (await agentTouchedPaths(repo, preExistingDirty)).filter((p) => !/(^|\/)_focus\//.test(p.replace(/\\/g, "/")));
      if (failuresUnrelatedToChange(result.blockingFailures, changed).unrelated) {
        const failureText = (result.blockingFailures ?? []).map((f) => f.detail ?? "").join("\n") || result.errorOutput || "";
        const attribution = attributeTestFailure({ failureText, changedFiles: changed, repoRoot });
        if (attribution.verdict === "unrelated") {
          testDebtNote = `${attribution.why}.\nFailing test file(s): ${attribution.tests.join(", ")}`;
          console.log(
            `\n🧪 [QA] ${attribution.why}. It was already failing, so it is stale-test debt, not a mistake in this change. ` +
              `Repair will bring the test and the code back in line (updating the test in place, not skipping it).`
          );
          appendQaReviewLog(repoRoot, phaseName, "Stale test found", [testDebtNote]);
        }
      }
    }

    // QA passed but could not reach some state the requirement needs. The
    // cause decides: the Planner either has the Editor add a small dev-only way
    // to reach it (handled as a repair-style retry, then QA looks again) or
    // accepts the gap, records it, and moves on. Once per phase.
    // A verify-only task changes nothing: a state QA could not reach is reported as unverified, never built a hook for.
    if (result.passed && verifyOnly && !testabilityTried && result.unreachableStates && result.unreachableStates.length > 0) {
      testabilityTried = true;
      const note = `Could not verify (a verify-only task adds no code to reach it): ${result.unreachableStates.join("; ")}.`;
      console.log(`\n🧪 [QA] ${note}`);
      appendQaReviewLog(repoRoot, phaseName, "Could not verify (verify-only)", [note]);
      result.visualAdvisories = [...(result.visualAdvisories ?? []), note];
    }
    if (result.passed && !verifyOnly && !testabilityTried && result.unreachableStates && result.unreachableStates.length > 0) {
      testabilityTried = true;
      const states = result.unreachableStates;
      console.log(`\n🧪 [QA] Could not reach ${states.length} state(s) the requirement needs:`);
      states.forEach((s) => console.log(` - ${s}`));
      const changedNow = (await agentTouchedPaths(repo, preExistingDirty)).filter((p) => !/(^|\/)_focus\//.test(p.replace(/\\/g, "/")));
      const decision = await triageUnreachableStates({
        goal: verificationGoal,
        states,
        changedFiles: changedNow,
        // Its own Planner card on the phone, like any other Planner pass.
        complete: (messages) =>
          runLabeledCompletion({
            client,
            models: config.models.planner,
            messages: messages as any,
            agentName: "TESTABILITY_PLANNER",
            jsonMode: true,
            reason: "Testability: can anything be built so QA can reach the missing state?",
          }),
      });
      events.emit({ type: "log", level: "info", message: `Testability triage: ${decision.action} — ${decision.why}` });
      if (decision.action === "build") {
        console.log(`[PLANNER] 🔧 ${decision.why}`);
        console.log(`[PLANNER] Asking the Editor to add a dev-only way to reach it: ${decision.brief}`);
        // Its own Editor card, not a REPAIR retry: this is new work the plan
        // did not have, not a fix to something that failed. QA then runs
        // again from the top of the loop against the new hook.
        console.log(`[EDITOR] 🧪 Adding a dev-only way for QA to reach the missing state...`);
        const hookResult = await runToolAgent({
          prompt: renderTestabilityRequest(states, decision),
          phase,
          repo,
          repoRoot,
          client,
          config,
          agentTools,
          models: currentEditorModels,
          agentName: "EDITOR",
          visionMode: usingEditorVision,
          reason: "Testability: adding a dev-only way for QA to reach the missing state",
        });
        // QA has to be told how to use what was just built, or its agent would
        // have to rediscover the hook by guessing.
        const hookHowTo = extractHowToVerify(hookResult);
        if (hookHowTo) editorHowToVerify = editorHowToVerify ? `${editorHowToVerify}

Test hook just added: ${hookHowTo}` : hookHowTo;
        if (phase.id) savePhaseRepairContext(repoRoot, phase.id, { editorHowToVerify, uiUnreachable, repairHistory, assertionDeltas: editorDeltas, testsNotNeeded: editorTestsNotNeeded });
        continue;
      } else {
        const note = `Could not verify: ${states.join("; ")}. ${decision.why}`;
        console.log(`[PLANNER] ➡️ Nothing to build for this: ${decision.why}`);
        appendQaReviewLog(repoRoot, phaseName, "Could not verify (accepted)", [note]);
        result.visualAdvisories = [...(result.visualAdvisories ?? []), note];
      }
    }

    if (result.passed) {
      // A run stopped while it was being verified did not finish verifying: every reviewer call failed with "Run aborted", which
      // the verdict reads as "reviewer unavailable" and still passes. That is not a pass and must not be committed. The edits stay
      // in the working tree, and "/continue" picks the phase up again.
      if (runControl.isAborted) throw new AbortedError(runControl.reason);
      // Nothing left to remember once the phase actually passes.
      if (phase.id) savePhaseRepairContext(repoRoot, phase.id, undefined);

      const confidence = result.confidence ?? "static-only";
      lastPhaseConfidence = confidence;
      const confidenceNote =
        confidence === "verified"
          ? "the app was launched and observed running"
          : confidence === "partial"
            ? "the project compiled, but was not observed running"
            : "nothing could be executed here — this verdict rests on source review alone";
      // "Passed" and "passed with nothing to actually look at" are different
      // claims — collapsing them into one 🎉 banner is exactly the kind of
      // false confidence that made QA output hard to trust at a glance.
      if (confidence === "verified") {
        console.log(`\n🎉 [VERIFICATION PASSED] Confidence: ${confidence} — ${confidenceNote}.`);
      } else {
        console.log(`\n⚠️ [CONDITIONAL PASS] Confidence: ${confidence} — ${confidenceNote}.`);
        console.log(
          `[QA] ℹ️ No positive evidence of a defect was found, and ${confidenceNote}. ` +
            `This is a pass, not a guarantee — review the evidence below before relying on it.`
        );
      }

      // 1. Surface QA Visual Advisories directly to user (without triggering repair loops)
      if (result.visualAdvisories && result.visualAdvisories.length > 0) {
        console.log(`\n--------------------------------------------------`);
        console.log(`👁️ [QA VISUAL ADVISORIES FOR HUMAN SIGN-OFF]:`);
        result.visualAdvisories.forEach((adv) => console.log(` - ${adv}`));
        if (result.screenshots && result.screenshots.length > 0) {
          console.log(` 📸 Screenshot: ${result.screenshots[result.screenshots.length - 1]}`);
        }
        console.log(`--------------------------------------------------`);

        if (config.interaction.autonomous) {
          console.log(`[QA] ℹ️ Autonomous mode: accepting visual state and committing. Logged to QA_REVIEW.md.`);
          appendQaReviewLog(
            repoRoot,
            phaseName,
            "Visual advisories (auto-accepted)",
            result.screenshots && result.screenshots.length > 0
              ? [...result.visualAdvisories, `Screenshot: ${result.screenshots[result.screenshots.length - 1]}`]
              : result.visualAdvisories
          );
        } else {
          // Through the funnel (the answer deadline, the phone): nobody answering accepts the visual state.
          const adjustPrompt = await askAnywhere(
            { id: `visual_${Date.now()}`, kind: "blocking", prompt: "Accept the visual state and commit, or type what to adjust (Enter = accept)", fallback: "", askedAt: new Date().toISOString() },
            "\nPress [Enter] to accept visual state & commit, or enter prompt to adjust: "
          );

          if (adjustPrompt.trim().length > 0) {
            console.log(`[EDITOR] 🎨 Applying user visual adjustments...`);
            await runToolAgent({
              prompt: `User requested visual/styling adjustment:\n${adjustPrompt.trim()}\n\nMake the surgical adjustment.`,
              phase,
              repo,
              repoRoot,
              client,
              config,
              agentTools,
              models: currentEditorModels,
              agentName: "EDITOR",
              visionMode: usingEditorVision,
            });
          }
        }
      }

      // 2. Resolution Gate: Resolve non-blocking questions before committing
      await resolveDeferredQuestions(repoRoot, phaseName, config.interaction.autonomous, async (userFixInstructions) => {
        console.log(`[RESOLVER] Applying user design choices...`);
        await runToolAgent({
          prompt: `User provided preferences for deferred styling/design questions:\n${userFixInstructions}\n\nApply these targeted updates cleanly.`,
          phase,
          repo,
          repoRoot,
          client,
          config,
          agentTools,
          models: currentEditorModels,
          agentName: "EDITOR",
          visionMode: usingEditorVision,
        });

        // Fast syntax re-check
        await verifier.runVerification(
          "Fast syntax and compile check after user adjustments.",
          undefined,
          agentTools.getStagedDeletions(),
          preExistingDirty
        );
      });

      // 2b. Focused tests were scaffolding for this phase. A model reviews each
      // one: by default it is thrown away (a small change proves itself and
      // leaves nothing behind); only if it describes lasting, user-facing
      // behavior does it change the PERMANENT suite — by updating the existing
      // tests (E2E included) that already cover that behavior, or adding one new
      // test when nothing does. Everything under the focus folder is then deleted,
      // so the next full run sees only the main suite. Nothing here asks the
      // user; the outcome is logged.
      try {
        const focusOutcomes = await finalizeFocusTests({
          repoRoot,
          run: (files) =>
            runFocusedTests(
              repoRoot,
              files,
              { isTooling: isToolingFailure, noTests: reportsNoTestsFound, describe: describeToolingFailure },
              winSafeCommand
            ),
          // QA decides whether it belongs in the permanent suite at all.
          decide: (req) => verifier.judgeFocusTest(phase.verificationGoal ?? phase.instructions, req),
          // The Editor then folds it into what is already there — strictly restricted to permanent test paths.
          review: async ({ focusRel, candidates, suggestedNew, reason }) => {
            agentTools.beginPhase([...candidates, suggestedNew], 6, `review focused test ${focusRel}`);
            agentTools.setWritePathFilter((p) => isTestPath(p) && !isFocusPath(p));
            try {
              await runToolAgent({
                prompt:
                  `A temporary focused test was written to prove one change in this phase: \`${focusRel}\`. ` +
                  `It passed and will be deleted. QA judged that it describes lasting behavior worth keeping in the PERMANENT ` +
                  `test suite: "${reason}". Your job is to fold that into the existing suite correctly.\n\n` +
                  `If the permanent tests already cover it, make no edit and call conclude_task with status ALREADY_COMPLETED.\n\n` +
                  (candidates.length > 0
                    ? `Permanent tests that already touch this code (read them before deciding):\n${candidates.map((c) => `  - ${c}`).join("\n")}\n\n`
                    : `No existing permanent test covers this code.\n\n`) +
                  `To fold it in:\n` +
                  `1. Read the candidate tests above and find where this behavior is already tested, even partly.\n` +
                  `2. UPDATE that test in place: change, tighten or replace the existing case so the file reflects how the app ` +
                  `behaves NOW. Do not append a near-duplicate beside it, and do not leave an older case that the new behavior ` +
                  `makes wrong — fix or remove that case.\n` +
                  `3. Only if nothing covers it at all, add ONE new permanent test at \`${suggestedNew}\` (use real imports from ` +
                  `that location; match the project's existing test style and avoid new mocks).\n` +
                  `4. Edit only test files. Never edit source code, never delete a test file, never touch \`${focusRel}\`.\n` +
                  `5. Never add a test that pins call order, snapshots, or this one edit's implementation.`,
                phase: { name: `review focused test ${focusRel}`, instructions: `Review ${focusRel} against the permanent tests.` },
                repo,
                repoRoot,
                client,
                config,
                agentTools,
                models: currentEditorModels,
                agentName: "EDITOR",
                visionMode: false,
              });
            } finally {
              agentTools.setWritePathFilter(undefined);
            }
          },
        });
        if (focusOutcomes.length > 0) {
          const lines = renderFocusOutcomes(focusOutcomes);
          console.log(`[TESTS] Focused tests resolved:\n${lines.map((l) => `  - ${l}`).join("\n")}`);
          appendQaReviewLog(repoRoot, phaseName, "Focused tests", lines);
        }
      } catch (err: any) {
        console.warn(`[TESTS] ⚠️ Could not resolve focused tests (${err.message}); removing them.`);
        clearFocusFiles(repoRoot);
      }

      // The phase passed. Whatever it changed (a function moved, a file renamed
      // or split, a new file), the repo map is re-derived from the real code now,
      // so nothing downstream reads where things used to be.
      try {
        const changedByPhase = await agentTouchedPaths(repo, preExistingDirty);
        changedByPhase.forEach((f) => taskTouchedFiles.add(f.replace(/\\/g, "/")));
        const synced = syncRepoMap(repoRoot, { touched: changedByPhase, viaTask: true, maxEntries: config.memory.maxEntries });
        logMapSync(synced, "Updated the repo map for what this phase changed:");
        // And remember it for the next phase's brief (no model involved).
        taskProgress.push(
          buildPhaseProgress({
            phaseId: phase.id ?? phaseName,
            name: phaseName,
            files: changedByPhase.filter((f) => !/(^|\/)_focus\//.test(f.replace(/\\/g, "/"))),
            sync: synced,
            deltas: editorDeltas.map((d) => ({ id: d.id, action: d.action, reason: d.reason })),
            unverified: result.unreachableStates ?? [],
            alreadyDone: editorNoOpClaim,
          })
        );
      } catch {
        // the map is a lead, never a reason to fail a phase that passed
      }

      // 3. Post-Verification Commit — scoped to the agent's own changes only.
      if (config.git?.autoCommit) {
        const touched = await agentTouchedPaths(repo, preExistingDirty);
        if (touched.length === 0) {
          console.log(`[GIT] Nothing new to commit for this phase.`);
        } else {
          console.log(`[GIT] 📦 Committing ${touched.length} agent-modified file(s)...`);
          // Only this phase's own files: anything else already staged is left staged, not swept into this commit.
          await commitOnly(
            repo.git,
            touched,
            `${config.git.commitPrefix}: completed phase - ${phaseName}\n\nQA confidence: ${confidence}`,
            (l) => console.warn(l),
          );

          if (config.git.autoPush) {
            try {
              const branch = (await repo.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
              console.log(`[GIT] ⬆️ Pushing ${branch} to origin…`);
              // -u on every push (not just the first) is harmless and keeps
              // tracking set even if the branch itself only just got created.
              await repo.git(["push", "-u", "origin", branch]);
              console.log(`[GIT] ✓ Pushed.`);
            } catch (err: any) {
              console.warn(`[GIT WARNING] Push failed — commit is safe locally, continuing without it.`);
              await reportPushFailure(err, repo, false);
            }
          }
        }
      }
      return true;
    }

    // A repair that wrote nothing, against failures only in tests this phase wrote, whose fix is in a later phase's file: no further attempt
    // can do better (repair may not touch that file), so stop after this one instead of spending the rest of the budget on it.
    const repairJustEdited = lastRepairEdited;
    lastRepairEdited = undefined;
    if (repairJustEdited === false) {
      const reach = failureOutOfReach({
        failures: result.blockingFailures ?? [],
        createdTestFiles: await createdTestFiles(repo, preExistingDirty),
        allowedPaths: phase.allowedPaths ?? [],
        laterPhases: phase.laterPhases ?? [],
        importsOf: (t) => {
          try {
            return importedSources(repoRoot, t, fs.readFileSync(path.join(repoRoot, t), "utf8"));
          } catch {
            return [];
          }
        },
        repairEdited: false,
      });
      if (reach) {
        stopReason = "out_of_reach";
        outOfReach = reach;
        console.error("");
        for (const line of describeOutOfReach(reach, maxRepairs - attempt)) console.error(line);
        break;
      }
    }

    // Signature of THIS failure, independent of wording noise, so two
    // consecutive identical failures are detectable even though the editor
    // genuinely tried something in between.
    const currentFailureSignature = failureSignature(result.blockingFailures);
    const hasRealBackupChain = backupRepairModels !== effectiveRepairModels;

    const progress = evaluateRepairProgress(
      attempt,
      currentFailureSignature,
      previousFailureSignature,
      repairUsingBackup,
      hasRealBackupChain,
      seenFailureSignatures
    );
    if (progress.kind === "switch_to_backup") {
      // The model just got the EXACT same failure back after a real
      // attempt — that is the signal to hand this off to the backup model,
      // not to give up on the whole phase. Stopping unconditionally here
      // (the old behavior) is why the primary/backup split above was
      // effectively dead code in practice: a model stuck on one blind spot
      // reliably reproduces an identical failure within its first couple of
      // attempts, long before attempt-count alone would have switched
      // models on its own.
      repairUsingBackup = true;
      console.warn(`\n⚠️ [NO PROGRESS] The exact same failure was reported again:`);
      console.warn(`   ${currentFailureSignature.slice(0, 500)}`);
      console.warn(
        `\n   The primary editor model is stuck on this — switching to the backup model for the ` +
          `remaining repair attempts instead of giving up.\n`
      );
      // A fresh baseline for the backup model's OWN attempts: comparing its
      // first try against the primary's already-stuck failure would risk
      // tripping no-progress again before the backup ever got a real turn.
      previousFailureSignature = undefined;
      seenFailureSignatures.clear();
    } else if (progress.kind === "stop") {
      stopReason = "no_progress";
      console.error(`\n⛔ [NO PROGRESS] The repair attempt did not change the outcome — the exact same`);
      console.error(
        `   failure was reported again${repairUsingBackup ? ", now on the backup model too" : ""}:\n`
      );
      console.error(`   ${currentFailureSignature.slice(0, 500)}`);
      console.error(
        `\n   Retrying would just repeat this. Stopping instead of spending the remaining ` +
          `${maxRepairs - attempt} repair attempt(s) on a fix that isn't landing.\n`
      );
      break;
    } else {
      previousFailureSignature = currentFailureSignature;
      if (currentFailureSignature) seenFailureSignatures.add(currentFailureSignature);
    }

    const visualOnlyFailure = isVisualOnlyFailure(result.blockingFailures);

    if (visualOnlyFailure && visualOnlyRepairs >= maxVisualOnlyRepairs) {
      stopReason = "visual_cap";
      console.error(`\n⛔ [VISUAL REPAIR CAP] A visual-only defect triggered a repair already this phase, and`);
      console.error(`   the screen still reads as a defect. Visual judgment is the least reliable evidence in`);
      console.error(`   this pipeline, so it's capped at ${maxVisualOnlyRepairs} repair attempt per phase rather`);
      console.error(`   than risking a hallucinated "looks wrong" burning the whole budget. Review the`);
      console.error(`   screenshot yourself before deciding whether this needs a manual fix.\n`);
      break;
    }

    attempt++;
    if (attempt <= maxRepairs) {
      console.log(`\n⚠️ [HARD VERIFICATION FAILURE]`);
      console.log(`[REPAIR LOOP] Triggering repair attempt ${attempt} of ${maxRepairs}...`);
      if (visualOnlyFailure) visualOnlyRepairs++;

      // Switch to the backup editor model(s) once EITHER signal says the
      // primary is stuck: the no-progress handling above already set
      // repairUsingBackup the moment the primary repeated an identical
      // failure, or — for a primary that keeps producing DIFFERENT-looking
      // failures attempt after attempt without ever converging, so
      // no-progress never actually trips — simply having burned half the
      // attempt budget without landing a fix. Whichever comes first.
      // Scoped to just this phase: the next phase's own repair loop starts
      // this same decision over from attempt 1, since currentRepairModels
      // and this whole function run fresh per phase. Once switched (by
      // either path), every later attempt in this phase keeps using the
      // backup chain — nothing switches it back.
      const repairHalfPoint = Math.ceil(maxRepairs / 2);
      if (repairUsingBackup || attempt > repairHalfPoint) {
        repairUsingBackup = true;
        if (currentRepairModels !== backupRepairModels) {
          currentRepairModels = backupRepairModels;
          console.log(`[REPAIR] Switching to the backup repair model(s) for the remaining repair attempts: ${currentRepairModels.join(", ")}`);
        }
      } else {
        currentRepairModels = effectiveRepairModels;
      }

      // buildFailureSnippet (verifierTools.ts) gives every BLOCKING gate its
      // own fair, explicitly-truncated share of the budget — a plain
      // character slice on the already-joined errorOutput string would
      // silently drop an earlier gate's errors entirely whenever two or
      // more gates fail in the same pass (each gate's own detail is already
      // curated down to a sane size individually, so a single-gate failure
      // never actually hits this cap; a multi-gate one could lose a whole
      // gate's worth of errors to it with no notice at all). See
      // buildFailureSnippet's own comment for the exact failure this fixes.
      const failureSnippet = buildFailureSnippet(result.blockingFailures, result.errorOutput || "", 8000);
      const pitfallSummary = extractPitfallSummary(failureSnippet);
      if (!memory.historicalPitfalls.includes(pitfallSummary)) {
        memory.historicalPitfalls.push(pitfallSummary);
        if (memory.historicalPitfalls.length > 15) memory.historicalPitfalls.shift();
        saveCodebaseMemory(memoryFile, memory);
      }

      // "The editor made zero changes" and "the editor's changes are broken"
      // are different problems and need different instructions. The generic
      // "inspect the bug and patch it" prompt makes no sense when there is no
      // bug to find — the phase's goal was simply never attempted — and a
      // model told to "fix an issue" with nothing concrete to point at tends
      // to repeat the same no-op, which is exactly the repair loop this was
      // built to prevent: identical failure, identical non-response, retried
      // until the attempt budget or circuit breaker ends the phase anyway.
      const madeNoChanges = result.blockingFailures?.some((f) => f.gate === "change set") ?? false;
      // A failing TEST: its code and the code the failure points at go in front of the Planner and the Editor (the heal found that finding them is where
      // an agent's first rounds go), and REPAIR may run the failing test itself after a change. Any other failure (a build error, a screenshot) has none of this.
      const testTier = madeNoChanges ? undefined : testTierContext(failureSnippet, repoRoot);
      const testTierSection = testTier ? `

${testTier.text}` : "";
      // Advice specific to a stack this project does not have is exactly the
      // kind of noise that made the environment report confusing — the same
      // fix applies here: only mention gradle when there is an Android stack.
      const gradleCaveat = result.stacks?.includes("android")
        ? "\n5. Do not modify gradle wrapper binaries or runner configurations."
        : "";

      // Empty until a repair attempt has actually run once and failed again —
      // nothing to report on attempt 1. From attempt 2 on, this is what lets
      // Editor recognize "I already tried a version of this and it wasn't
      // enough" instead of re-deriving a similar-looking half-fix from
      // scratch each time.
      const testDebtSection = renderTestDebtSection(testDebtNote);
      const historySection =
        (repairHistory.length > 0
          ? `\n\nPrevious attempt(s) on this exact phase, and what QA found after each one — do NOT repeat an approach that already failed to satisfy the complaint below:\n${repairHistory.join("\n\n")}`
          : "") + testDebtSection;

      // A build-tier failure (a real compiler/toolchain error, not a semantic
      // QA judgment call) sometimes names a file OUTSIDE this phase's own
      // scope — the classic case: this phase renamed/removed a symbol other
      // files still reference. EDITOR_SYSTEM forbids touching files outside
      // "files:", so without this, REPAIR is stuck re-patching the one file
      // that was never actually broken, exhausts its attempts, and the whole
      // run aborts even though the real fix is one line in a sibling file.
      // Deliberately narrow: only files the compiler ITSELF named, and only
      // when a build gate (not a semantic one) actually failed — beginPhase's
      // own doc comment already establishes "files:" is advisory not a hard
      // allowlist in code, so this is lifting a prompt-level restriction, not
      // bypassing an enforced one.
      const buildFailed = result.blockingFailures?.some((f) => f.tier === "build") ?? false;
      const inScope = (p: string) =>
        (phase.allowedPaths ?? []).some(
          (f) => f.toLowerCase().endsWith(p.toLowerCase()) || p.toLowerCase().endsWith(f.toLowerCase())
        );
      const externalPaths = buildFailed
        ? Array.from(new Set(extractReferencedFilePaths(failureSnippet))).filter((p) => !inScope(p))
        : [];
      // Grants a widened search permission whenever externalPaths came back
      // empty despite a real failure: either it's runtime/visual-tier (no
      // compiler to name a file at all), or it's a build-tier failure about
      // a symbol MISUSED here but DEFINED somewhere extractReferencedFilePaths
      // can't find, since a compiler error never names a symbol's own
      // definition site. See buildWidenedScopeSection's own comment for two
      // real failures this was built from (one of each kind).
      const runtimeOrVisualFailed =
        result.blockingFailures?.some((f) => f.tier === "runtime" || f.tier === "visual") ?? false;
      const needsWidenedSearch = (buildFailed && externalPaths.length === 0) || runtimeOrVisualFailed;
      const widenedScopeSection = buildWidenedScopeSection(externalPaths, needsWidenedSearch);

      // An "unresolved reference/symbol/module" error names the CALL SITE,
      // never the missing dependency that would explain it — the compiler has
      // no way to know a plugin or package was never declared. Without this
      // hint, REPAIR has no path to that diagnosis except reading arbitrary
      // files hoping to stumble onto it, which is exactly the "8 consecutive
      // inspections with no edit" pattern that trips the circuit breaker on
      // this specific failure class.
      const manifestHint = buildFailed && looksLikeMissingDependency(failureSnippet)
        ? dependencyManifestHint(result.stacks)
        : undefined;
      const missingDependencySection = manifestHint
        ? `\n\nPOSSIBLE MISSING DEPENDENCY: The error above ("unresolved reference" or similar) can mean the
symbol's call site is fine but the dependency or plugin that provides it was
never declared — the compiler cannot tell you this directly, it can only
report the symbol as unresolved. Check ${manifestHint} for whether the
required dependency/plugin is present, and add it if not. Editing a manifest
file for this reason is a legitimate code fix, not an "environmental" issue —
only genuinely unavailable infrastructure (no emulator, no display, no
installed toolchain) counts as environmental.`
        : "";

      // REPAIR used to get raw error text plus the Editor's full, uncapped
      // tool set (search_code, list_files, unbounded read_file) and had to
      // diagnose AND fix in one pass — exactly the "witch hunt" that burns
      // 8+ read/search rounds before ever calling patch_file, the same
      // failure Discovery/Planner already solved for a FRESH phase by
      // splitting bounded diagnosis from execution. This is that same split,
      // applied to repair: a capped, read-only pass (Planner's own tool
      // schema and file budget) diagnoses the failure and names the exact
      // fix, then REPAIR below just executes it. Skipped for madeNoChanges —
      // that prompt already has a direct, unambiguous instruction ("write the
      // file"), so there is nothing to diagnose.
      let repairPlan: string | undefined;
      const skipRepairPlanner = shouldSkipRepairPlannerOnFirstAttempt({
        attempt,
        madeNoChanges,
        blockingFailures: result.blockingFailures,
        externalPathsCount: externalPaths.length,
        runtimeOrVisualFailed,
        hasManifestHint: Boolean(manifestHint),
      });
      if (!skipRepairPlanner) {
        const manifestCandidates = manifestHint ? dependencyManifestCandidatePaths(repoRoot, result.stacks) : [];
        const triageCandidateFiles = Array.from(
          new Set([...(phase.allowedPaths ?? []), ...externalPaths, ...manifestCandidates])
        );
        agentTools.beginPlannerInspection(triageCandidateFiles, plannerReadBudget(triageCandidateFiles.length));
        const triagePrompt = `A build/verification failure needs to be diagnosed — NOT fixed. You have read-only
tools; there is no patch_file or write_file here. Do NOT call run_dependency_install or
run_project_command either — they actually run things and would mutate the project mid-diagnosis; if the failure looks
dependency-related, name the exact manifest change needed in your answer and let the next pass
(which can act on it) decide whether to verify with it. Your job is to name the exact
root cause and the exact fix, precisely enough that another pass can apply it
without re-diagnosing from scratch.

Phase goal:
${phase.instructions}

Hard Bug Report / Failure Output:
${failureSnippet}${testTierSection}
${historySection}

Files you may inspect: ${triageCandidateFiles.length > 0 ? triageCandidateFiles.join(", ") : "(none identified — reason from the error text and Live Rules alone)"}
${widenedScopeSection}${missingDependencySection}

Instructions:
1. Any line starting "[REPEATED Nx — LIKELY ONE SHARED ROOT CAUSE...]" means the SAME compiler
   complaint fired at N different locations — diagnose it as ONE mistake, not N.
2. Inspect only what you need from the files listed above to confirm the root cause.
   Paths under ".agent/" (for example ".agent/rejected/...") are the harness's own scratch space, never
   project code. If a failure's stack points into ".agent/", the cause is a stray harness file being picked
   up by the test runner: say exactly that, name the path, and do NOT ask the user for more output.
3. You cannot ask the user anything and there is nobody to paste more output: the failure text above is all
   that was captured. If part of it is missing (for example a test diff), say exactly what is missing and
   which command would show it, then give your best-supported diagnosis from the code you can read. Never
   answer with a question.
4. Answer with: (a) the root cause in one or two sentences, (b) for each file that needs a
   change, its exact path and precisely what must change (the specific line, symbol, or
   declaration, and what it must become), (c) if this is a missing dependency, the exact
   line to add and to which manifest file. Be concrete enough that no further investigation
   is needed to apply the fix.`;

        // See computeRepairPlannerMaxRounds's own comment: scaled off how
        // many distinct errors are actually described in the failure text,
        // not how many gates failed (a single failed build command is
        // always exactly one blockingFailure entry no matter how many
        // compiler errors it bundles into that one entry's detail string).
        const repairPlannerMaxRounds = computeRepairPlannerMaxRounds(
          result.blockingFailures,
          config.limits?.maxToolRounds ?? 40
        );

        try {
          repairPlan = await runToolAgent({
            prompt: triagePrompt,
            phase,
            repo,
            repoRoot,
            client,
            config,
            agentTools,
            models: config.models.repairPlanner ?? config.models.planner,
            agentName: "REPAIR_PLANNER",
            tools: needsWidenedSearch ? REPAIR_PLANNER_WIDENED_TOOLS_SCHEMA : PLANNER_TOOLS_SCHEMA,
            maxRoundsOverride: repairPlannerMaxRounds,
          });
        } catch (err: any) {
          console.warn(`[REPAIR_PLANNER] ⚠️ Triage pass failed (${err.message}) — REPAIR will diagnose directly instead.`);
        }
      }

      const repairPlanSection = repairPlan
        ? `\n\nREPAIR PLAN (from a bounded diagnosis pass — apply this directly, do not re-diagnose from scratch unless it is clearly wrong):\n${repairPlan}`
        : "";

      const repairPrompt = madeNoChanges
        ? `Verification failed after phase "${phaseName}" because NO file was created or modified —
the previous attempt made zero changes of any kind. This is not a bug to fix;
the phase's goal was never actually implemented.

Phase goal:
${phase.instructions}

Live Rules:
${memory.liveRules.join("\n") || "None recorded."}
${historySection}

Instructions:
1. Implement the phase goal above by actually calling write_file or patch_file.
   Reasoning, exploration, or a plan alone do not satisfy this phase — a
   real file change is the only thing verification will accept.
2. If the goal is already satisfied by existing code, use read_file to
   confirm that precisely, then state exactly which file(s) already
   implement it — do not simply repeat the previous no-op.`
        : `The project failed autonomous verification after executing phase "${phaseName}".

Hard Bug Report / Failure Output:
${failureSnippet}${testTierSection}

Live Rules:
${memory.liveRules.join("\n")}
${historySection}

Instructions:
${repairPlan
  ? `1. A REPAIR PLAN is included below, from a bounded diagnosis pass that already inspected the
   relevant files and identified the root cause. Apply it directly with patch_file — do not
   re-read files to re-diagnose from scratch. Only fall back to your own investigation if the
   plan is clearly wrong once you look at the named file(s).
2. Do not repeat a change that verification already rejected — if a previous attempt already
   tried something close to this, explain concretely why THIS attempt is different.`
  : `1. Examine the error details above${repairHistory.length > 0 ? " and the previous attempt(s) above" : ""}.
   Any line starting "[REPEATED Nx — LIKELY ONE SHARED ROOT CAUSE...]" means the SAME compiler
   complaint fired at N different locations — this is one mistake, not N. Read just the first
   occurrence, find the single shared cause (e.g. a base class/interface declaration every
   listed subclass or call site now disagrees with), and apply ONE consistent fix across ALL
   of that cluster's locations in this same attempt. Do not diagnose each location separately.
2. Inspect affected source files using read_file.
3. Surgically fix the issue using patch_file — if a previous attempt already tried something
   close to this, explain concretely why THIS attempt is different and will actually resolve it.
4. Do not repeat a change that verification already rejected — read the
   failure detail carefully and address the SPECIFIC defect it reports.`
}${gradleCaveat}${widenedScopeSection}${missingDependencySection}${repairPlanSection}${testTier ? REPAIR_RUN_TEST_NOTE : ""}`;

      // REPAIR otherwise only ever sees QA's TEXT description of a visual
      // defect ("text overlaps the page edge") — never the actual screenshot
      // QA looked at to write that description. Attaching the real image
      // means REPAIR is looking at the same evidence QA had, not a paraphrase
      // of it, which is exactly where a repair loop tends to guess wrong.
      const latestScreenshot = result.screenshots?.[result.screenshots.length - 1];
      // The screenshot goes to whichever repair model can SEE it. The check used to be on the Editor's model, but this call runs on
      // the repair chain, which can be a different (text-only) set of models: the image then came back as a 404 from the provider.
      // A repair model that cannot see images is swapped for the first vision chain configured for this kind of work; with none
      // available the screenshot is left out (and said so), never sent to a model that will refuse it.
      let repairModelsForCall = currentRepairModels;
      let attachScreenshot = false;
      if (latestScreenshot) {
        if (await modelSupportsVision(currentRepairModels[0])) {
          attachScreenshot = true;
        } else {
          const visionChain = [config.models.repairVision, config.models.editorVision, config.models.verifierVision].find(
            (c): c is string[] => Array.isArray(c) && c.length > 0
          );
          if (visionChain && (await modelSupportsVision(visionChain[0]))) {
            attachScreenshot = true;
            repairModelsForCall = visionChain;
            console.log(`[REPAIR] This failure has a screenshot, and ${currentRepairModels[0]} cannot see images, so this attempt uses a vision model: ${visionChain.join(", ")}.`);
          } else {
            console.log(
              `[REPAIR] This failure has a screenshot, but ${currentRepairModels[0]} cannot see images and no vision model is set for repair (models.repairVision). Repairing from QA's text description instead.`
            );
          }
        }
      }
      const repairPayload =
        attachScreenshot && latestScreenshot
          ? withScreenshot(
              repairPrompt,
              latestScreenshot,
              "Attached: the screenshot QA captured when it found this failure."
            )
          : repairPrompt;

      // The initial Editor pass has a matching catch around it (below) — this
      // one was missing, so REPAIR calling conclude_task(CANNOT_LOCATE), a
      // path it is explicitly instructed to use for exactly this situation
      // (a failure report that doesn't point at any real code defect), threw
      // ESCALATION_NEEDED straight out of the whole run and crashed the
      // process instead of just failing this phase cleanly.
      // run_test is bound for this one call and unbound after it, so nothing else can reach it (an unbound run_test answers "only available in a heal sandbox").
      if (testTier) agentTools.bindSandboxRunTest(repairRunTestFor({ client, config, repoRoot }));
      const writesBeforeRepair = agentTools.writesSoFar();
      try {
        const repairResult = await runToolAgent({
          prompt: repairPayload,
          phase,
          repo,
          repoRoot,
          client,
          config,
          agentTools,
          models: repairModelsForCall,
          agentName: "REPAIR",
          visionMode: usingEditorVision,
          ...(testTier ? { tools: [...TOOLS_SCHEMA, REPAIR_RUN_TEST_TOOL] } : {}),
        });
        // A fix can change the very mechanic QA needs to exercise (e.g. the
        // repair changes a control from a single tap to a hold-and-release) —
        // superseding, not appending to, whatever the initial pass said.
        const repaired = extractHowToVerify(repairResult);
        if (repaired) editorHowToVerify = repaired;
        // Preserve uiUnreachable across REPAIR -> QA cycles so a repair pass fixing a build/test error
        // does not accidentally re-enable browser screenshot verification on an unmounted component.
        uiUnreachable = uiUnreachable || isUiUnreachableNote(repaired) || isUiUnreachableNote(repairResult);
        editorDeltas = mergeDeltas(editorDeltas, extractAssertionDeltas(repairResult));
        editorTestsNotNeeded = extractTestsNotNeeded(repairResult) ?? editorTestsNotNeeded;
        lastRepairEdited = agentTools.writesSoFar() !== writesBeforeRepair;

        // The initial Editor's "already implemented" claim only ever excused
        // the FIRST empty diff. QA has since found a real failure, so from
        // here on an empty tree means repair produced nothing — which must
        // block, not inherit the earlier pass's excuse.
        editorNoOpClaim = undefined;

        // Stripped down to just what Repair says it did, for the history
        // section above — the raw sentinel prefix and howToVerify tail are
        // plumbing, not something worth re-quoting back at the next attempt.
        lastRepairExplanation =
          repairResult
            .split("\n\n[HOW TO VERIFY]\n")[0]
            .split(ASSERTION_DELTAS_MARKER)[0]
            .split(TESTS_NOT_NEEDED_MARKER)[0]
            .replace(/^TASK_(CONCLUDED|ALREADY_SATISFIED):\s*/, "")
            .trim() || undefined;

        // Captures the freshly updated editorHowToVerify immediately, rather
        // than waiting for the next loop iteration's save — narrows the
        // window where a crash between this repair finishing and the next
        // verification running would lose more than just the not-yet-closed
        // history entry for this one attempt.
        if (phase.id) savePhaseRepairContext(repoRoot, phase.id, { editorHowToVerify, uiUnreachable, repairHistory, assertionDeltas: editorDeltas, testsNotNeeded: editorTestsNotNeeded });
      } catch (err: any) {
        if (err.message?.startsWith("ESCALATION_NEEDED")) {
          stopReason = "environmental";
          console.error(`\n⛔ [REPAIR ESCALATION] ${err.message}`);
          console.error(`   Repair concluded this isn't a code defect it can fix. Stopping instead of burning`);
          console.error(`   the remaining repair attempt(s) re-inspecting the same evidence.\n`);
          break;
        }
        throw err;
      } finally {
        agentTools.bindSandboxRunTest(undefined);
      }
    }
  }

  const failureReason =
    stopReason === "no_progress"
      ? `a repair attempt made no measurable progress on: ${phaseName}${
          repairUsingBackup ? " (both the primary and backup editor models were tried)" : ""
        }`
      : stopReason === "visual_cap"
        ? `the visual repair cap was reached for: ${phaseName}`
        : stopReason === "declined"
          ? `you chose to stop after QA found test failures unrelated to this change in: ${phaseName}`
          : stopReason === "environmental"
          ? `repair could not attribute the failure to any code defect in: ${phaseName} — see the escalation above`
          : stopReason === "out_of_reach" && outOfReach
          ? `the failing test written in ${phaseName} needs a change to ${outOfReach.target}, which the plan gives to "${outOfReach.owner}"`
          : `all ${maxRepairs} repair attempts were exhausted for: ${phaseName}`;
  console.error(`\n❌ [PHASE FAILED] ${failureReason}`);

  // Scoped, non-destructive cleanup: only the agent's own edits are undone.
  clearFocusFiles(repoRoot);
  console.log(`[REVERT] Undoing the agent's changes (pre-existing work is preserved)...`);
  try {
    await revertAgentChanges(repoRoot, repo, preExistingDirty);
  } catch (e: any) {
    console.warn(`[REVERT WARNING] Scoped revert failed: ${e.message}`);
    console.warn(`[REVERT WARNING] Leaving the working tree as-is. Inspect with: git status`);
    if (checkpointTag) {
      console.warn(`[REVERT WARNING] A checkpoint tag exists if you want to reset manually: ${checkpointTag}`);
    }
  }

  return false;
}

/**
 * A plan proposing more than MAX_PLAN_PHASES phases is capped by parsePlan —
 * the capped slice is what would execute, so phases 13+ would be lost. Rather
 * than accept that silently, hand the COMPLETE proposal back to the planner
 * (`parsed.allPhases`, never the truncated slice) with buildConsolidationPrompt
 * and adopt the result only when it actually fits the limit.
 *
 * Best-effort by design: a model error, unparseable output, or a second
 * over-limit proposal leaves the caller with exactly the capped plan it
 * already had, so this can never make a run worse than not asking at all.
 * Retried once, because an over-limit response is a real possibility here
 * rather than an exceptional one.
 */
async function consolidateOverflowPlan(
  parsed: PlanResult,
  goal: string,
  client: OpenRouterClient,
  config: AgentConfig,
  verifyOnly = false,
  maxAttempts = 2
): Promise<PlanResult | undefined> {
  const proposedCount = parsed.allPhases.length;
  console.log(
    `\n[PLANNER] ⚠️ Proposed ${proposedCount} phases — that exceeds the ${MAX_PLAN_PHASES}-phase limit.`
  );
  console.log(`[PLANNER] 🧭 Asking the planner to consolidate (keeping every file and objective)…`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw = "";
    try {
      raw = await runLabeledCompletion({
        client,
        models: config.models.planner,
        messages: [
          {
            role: "system",
            content: `${config.prompts.systemPersona}\n\n${buildConsolidationPrompt(
              JSON.stringify(parsed.allPhases, null, 2),
              goal,
              verifyOnly
            )}`,
          },
          {
            role: "user",
            content:
              "Consolidate the proposed phases above into a single plan of 12 phases or fewer, " +
              "keeping every file path, change and verification criterion. Respond ONLY with the JSON plan object.",
          },
        ],
        agentName: "PLANNER",
        jsonMode: true,
      });
    } catch (err: any) {
      console.warn(`[PLANNER] ⚠️ Consolidation call failed (${err?.message ?? err}).`);
      continue;
    }

    const consolidated = parsePlan(raw, goal);
    if (!consolidated.degraded && consolidated.allPhases.length <= MAX_PLAN_PHASES) {
      console.log(
        `[PLANNER] ✓ Consolidated ${proposedCount} phases into ${consolidated.allPhases.length} — every proposed phase accounted for.`
      );
      return consolidated;
    }
    console.warn(
      `[PLANNER] ⚠️ Consolidation attempt ${attempt}/${maxAttempts} ${
        consolidated.degraded
          ? "did not return a parseable plan"
          : `still proposed ${consolidated.allPhases.length} phases`
      }.`
    );
  }

  console.warn(
    `[PLANNER] ⚠️ Could not consolidate below the limit — continuing with the first ${MAX_PLAN_PHASES} of ${proposedCount} phases.`
  );
  return undefined;
}

/**
 * Every corrective/re-plan pass (surgical-scope rejection, clarifying-answer
 * re-plan) starts a brand-new model conversation with no memory of what the
 * PRIOR pass already read — so left alone, a model that spent its whole
 * bounded-inspection budget walking one large reference file re-pays that
 * exact cost again on the retry, even though nothing in the repo changed in
 * between. `inspectedFiles`/`inspectedRanges` are whatever the just-finished
 * pass actually did (AgentTools.plannerInspectedThisPass() /
 * plannerInspectedRangesThisPass(), read BEFORE the caller resets the
 * inspection window for the new pass).
 *
 * A file the prior pass had to walk in chunks (too large for one whole-file
 * read) is replayed the SAME way here — the exact (startLine, endLine) calls
 * it already made, in order — rather than one single whole-file read, which
 * would just truncate again at exactly the same cap and lose the rest of
 * what the chunked walk had actually gathered. A file touched only via
 * get_symbol_definition (never readFileBounded, so no recorded range) falls
 * back to one plain whole-file read, same as a file that fit in one call to
 * begin with. Either way this reads straight from disk, not any cache — a
 * planning pass never writes files, so "fresh" and "what the last pass saw"
 * are the same content. Returns "" when nothing was inspected, so the
 * prompt gains no section at all for the common case.
 */
async function buildAlreadyInspectedSection(
  agentTools: AgentTools,
  inspectedFiles: string[],
  inspectedRanges: Map<string, Array<{ start?: number; end?: number }>>
): Promise<string> {
  if (inspectedFiles.length === 0) return "";
  const sections = await Promise.all(
    inspectedFiles.map(async (f) => {
      const ranges = inspectedRanges.get(f) ?? [];
      if (ranges.length === 0) return `--- ${f} ---\n${await agentTools.readFile(f)}`;
      // Dedupe exact-repeat calls (the model re-requesting the same range
      // twice) — cheap to drop, no reason to pay for or show it twice.
      const seen = new Set<string>();
      const unique = ranges.filter((r) => {
        const key = `${r.start ?? ""}-${r.end ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const chunks = await Promise.all(unique.map((r) => agentTools.readFile(f, r.start, r.end)));
      return `--- ${f} ---\n${chunks.join("\n")}`;
    })
  );
  return (
    `Files you already inspected on your previous attempt (current contents below, read the same way you ` +
    `read them last time — nothing in the repo has changed since then, so do NOT call read_file on these ` +
    `again; only open a file not shown here if you genuinely need one):\n\n${sections.join("\n\n")}\n\n`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Must happen before any output: this rebinds console.* to stderr so stdout
  // carries nothing but NDJSON events.
  if (args.json) events.enable();

  // ---- Non-run subcommands dispatch and exit -------------------------------
  if (args.command === "help") { printHelp(); return; }
  if (args.command === "version") {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    console.log(`yimpim ${pkg.version}`);
    return;
  }
  if (args.command === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(true);
    return;
  }
  if (args.command === "link") {
    // The non-interactive twin of the `/link` slash command: same pairing
    // flow, usable from a script or on a machine where the agent is being
    // set up but never actually run interactively.
    try {
      const lease = await executeLinkFlow();
      console.log(
        lease
          ? `[PRO] ✓ Pro subscription claimed successfully! You can now enter /remote-control to connect via the Yimpim Remote app.`
          : `[PRO] Link not completed — no lease saved. Run \`yimpim link\` to try again.`
      );
      process.exitCode = lease ? 0 : 1;
    } catch (err: any) {
      console.error(`[PRO] Could not link this device: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.command === "init") { process.exitCode = cmdInit(args.repoRoot, args.yes); return; }
  // setup-env installs software and may use sudo: it is started only by a person, from here. It is not a tool, a slash command or a roadmap step (envSetup/setup.ts).
  if (args.command === "setup-env") {
    const { runSetupEnv } = await import("./envSetup/setup.js");
    process.exitCode = await runSetupEnv(process.argv.slice(3));
    return;
  }

  // First run: nobody should have to read docs to get started.
  if (args.command === "run" && needsSetup() && !args.yes && !args.json) {
    if (!isInteractive()) {
      console.error(`\nYIMPIM is not set up yet. Run \`yimpim setup\` on a terminal first.\n`);
      process.exit(1);
    }
    console.log(`\nWelcome to YIMPIM. Let's get you set up — this only happens once.\n`);
    const { runSetup } = await import("./setup.js");
    const code = await runSetup(false);
    if (code !== 0) process.exit(code);
    console.log(`\nContinuing…\n`);
  }
  if (args.command === "doctor") {
    process.exitCode = await cmdDoctor(args.repoRoot, args.configPath, args.overrides);
    return;
  }
  if (args.command === "config") {
    const [a, b] = args.positionals;
    if (args.sub === "list") process.exitCode = cmdConfigList(args.repoRoot, args.configPath, args.positionals.includes("--common"));
    else if (args.sub === "get" && a) process.exitCode = cmdConfigGet(args.repoRoot, a, args.configPath);
    else if (args.sub === "set" && a && b !== undefined) process.exitCode = cmdConfigSet(args.repoRoot, a, b, args.configPath);
    else { console.error("Usage: yimpim config list | get <key> | set <key> <value>"); process.exitCode = 1; }
    return;
  }

  const { repoRoot, taskPrompt, taskFile, isResume } = args;

  console.log(`[INIT] Target Repository: ${repoRoot}`);

  // Change detection, checkpoints, revert and auto-commit are all built on
  // git. Without a repo here, "did the editor change anything" can never be
  // answered — collectChangeSet's `git status` throws, gets caught, and
  // reports "no changes" identically to a real no-op, so every phase fails
  // the same way regardless of what the editor actually did, and its work
  // is left permanently uncommitted with no way to revert it either. Rather
  // than make the user do this by hand, do it for them: a project that was
  // never going to use yimpim's git-dependent features loses nothing, and one
  // that just never got around to `git init` is unblocked automatically.
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    console.log(`\n[GIT] "${repoRoot}" is not a git repository yet — initializing one automatically`);
    console.log(`[GIT] (verification, checkpoints and auto-commit all depend on it).`);
    try {
      const run = (gitArgs: string[]) => execFileAsync("git", gitArgs, { cwd: repoRoot });

      // Vendor/build directories in a project's very first commit would
      // permanently bloat every future diff yimpim takes against it — and a
      // stray secret file would be baked into git history forever the
      // moment `git add -A` runs. Same sensitive-file patterns as
      // safety.blockedFilePatterns in config.ts (not yet loaded at this
      // point in startup, so duplicated rather than restructuring config
      // resolution to run earlier just for this).
      const gitignorePath = path.join(repoRoot, ".gitignore");
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(
          gitignorePath,
          [
            "node_modules/", "dist/", "build/", ".venv/", "venv/", "__pycache__/", ".agent/", ".DS_Store",
            ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks",
            "id_rsa", "id_ed25519",
          ].join("\n") + "\n",
          "utf-8"
        );
        console.log(`[GIT] Wrote a starter .gitignore (node_modules, build output, .agent/, secrets, etc.)`);
      }

      await run(["init"]);
      await run(["add", "-A"]);
      try {
        await run(["commit", "-m", "Initial commit (auto-created by yimpim)"]);
      } catch {
        // A fresh machine may have no git identity configured at all yet —
        // scope a throwaway one to just this commit rather than failing.
        await run([
          "-c", "user.name=yimpim",
          "-c", "user.email=yimpim@localhost",
          "commit", "-m", "Initial commit (auto-created by yimpim)",
        ]);
      }
      console.log(`[GIT] ✓ Initialized and committed the current state as a baseline.\n`);
    } catch (err: any) {
      console.error(`\n[ERROR] Could not initialize a git repository in "${repoRoot}": ${err.message}\n`);
      console.error(`Verification depends on git to tell whether anything changed. Install git, ensure`);
      console.error(`it's on PATH, then either re-run yimpim or initialize it yourself:`);
      console.error(`  cd "${repoRoot}"`);
      console.error(`  git init && git add -A && git commit -m "initial"\n`);
      process.exit(1);
    }
  }

  let config: AgentConfig;
  try {
    const resolved = resolveConfig({
      repoRoot,
      configPath: args.configPath,
      overrides: args.overrides,
    });
    config = resolved.config;
    if (resolved.sourcePath) console.log(`[CONFIG] ${resolved.sourcePath}`);
    else console.log(`[CONFIG] built-in defaults (no config file; run \`yimpim init\` to create one)`);
    for (const note of resolved.applied) console.log(`[CONFIG] override: ${note}`);
  } catch (err: any) {
    console.error(`
[CONFIG ERROR] ${err.message}
`);
    console.error(`Run \`yimpim config list\` to see valid settings.`);
    process.exit(1);
  }

  const { key: apiKey, backend: keyBackend } = loadApiKey();

  if (!apiKey) {
    console.error("\n[ERROR] No OpenRouter API key found.\n");
    console.error("Run:  yimpim setup\n");
    process.exit(1);
  }
  // Announce the source unconditionally — silently saying nothing for "env"
  // was hiding exactly the case worth knowing about: an env var overriding
  // whatever was actually saved via setup/`/api-key`.
  console.log(`[AUTH] Key loaded from ${describeBackend(keyBackend)}`);

  const staleEnvKey = detectStaleEnvKey();
  if (staleEnvKey) {
    console.log(`\n⚠ [AUTH] OPENROUTER_API_KEY is set in this shell's environment (${staleEnvKey.envPreview})`);
    console.log(`  and differs from the key saved via setup/\`/api-key\` (${staleEnvKey.storedPreview}, in`);
    console.log(`  ${describeBackend(staleEnvKey.storedBackend)}). The environment variable always wins, so`);
    console.log(`  THAT is the key every call actually uses — if it's stale or revoked, rotating your saved`);
    console.log(`  key will NOT fix it. This is the #1 cause of "I just fixed my key and it's still broken".`);
    console.log(`  Clear it for this terminal:`);
    console.log(`    PowerShell:  Remove-Item Env:OPENROUTER_API_KEY`);
    console.log(`    bash:        unset OPENROUTER_API_KEY`);
    console.log(`  If it reappears in every new terminal, it's also set at the User or Machine level —`);
    console.log(`  check with [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY","User"|"Machine"),`);
    console.log(`  clear whichever scope returns a value, then open a FRESH terminal — Windows does not`);
    console.log(`  retroactively clear an already-running session's inherited environment.\n`);
  }

  // Only one run may edit a repository at a time. The lock self-heals: a dead
  // owner or a stale heartbeat is reclaimed automatically, so a crashed or
  // Ctrl-C'd run never locks the user out.
  const runId = `run-${Date.now()}-${process.pid}`;
  const lock = new RunLock(repoRoot, config.recovery.stateDirectory);
  activeRunLock = lock;
  const lockResult = lock.acquire(runId, `yimpim ${args.command}`, args.forceUnlock);

  if (!lockResult.acquired && lockResult.heldBy) {
    console.error(describeHeldLock(lockResult.heldBy, lock.path));
    process.exit(1);
  }
  if (lockResult.note) console.log(`[LOCK] ${lockResult.note}`);

  // Repairs the durable remote-history log, independent of whether --remote
  // is even used this run: a task.start left over from a process that never
  // got to write its own task.end (crash, kill, /stop racing process exit)
  // would otherwise look, to a client paging through fetch_history/replay,
  // like a task that's still running forever.
  reconcileInterruptedTask(repoRoot);

  events.emit({
    type: "run.start",
    runId,
    repoRoot,
    command: args.command,
    task: taskPrompt ?? undefined,
  });

  // ---- Remote control (outbound only; this process never listens) ----------
  let remote: RemoteSession | undefined;
  // Declared here (outside the per-task loop below) because a phone paired
  // via --remote connects once for the whole session, and its upload
  // callback must keep pushing into whichever task is currently running —
  // a binding scoped inside the loop would go stale the moment a second
  // task starts. Cleared after each task completes so a leftover, already-
  // processed attachment path never bleeds into the next one.
  /** Paths from --attach, plus anything uploaded from a paired phone. */
  const pendingAttachments: string[] = [...args.attach];

  // Read by the events.onEmit translator below to enrich a "worker.start"
  // wire event with phase context — agent.start itself doesn't carry a phase,
  // so this is populated at the top of each phase-loop iteration instead.
  let currentPhaseForEvents: PlannedPhase | undefined;

  // Identifies which TASK (not which desktop process) every translated wire
  // event belongs to — see translateForRemote's own comment for why this
  // exists: `runId` is fixed for the whole process, but one interactive
  // session can run many unrelated tasks back to back without restarting,
  // and a client reconciling on runId alone merges all of them into one.
  // Freshly regenerated at the top of every taskLoop iteration below.
  let currentTaskId = "";
  // Distinct from currentTaskId being non-empty: currentTaskId deliberately
  // keeps the JUST-FINISHED task's id after task.end (status pushes during
  // the idle wait are specified to keep showing it — see RemoteStatus.taskId's
  // doc comment), so it alone can't answer "is a task running right now".
  // This is what gates whether an advisor.start/advisor.answer fired from an
  // /ask asked while idle gets a taskId at all — attaching the stale
  // just-finished task's id there would be exactly the kind of mislabeling
  // this whole event contract exists to eliminate.
  let taskRunning = false;

  // Fresh id minted the moment an agent.start fires, held while that worker
  // is active, cleared on its agent.end — so translateForRemote (and the
  // console.log mirror below, for worker-time log lines) can tag everything
  // a worker produces with the same id, without this scattered state needing
  // to track "which gate.result/verdict/file.write belongs to which worker"
  // itself (see remoteEventTranslator.ts's own comment).
  let currentWorkerId: string | undefined;
  // The workers running now, innermost last. currentWorkerId is the innermost one a phone is shown (a background check is not
  // shown); each worker.end carries its own id, even when another worker ended inside it.
  const workerFrames: { id: string; agent: string; background: boolean }[] = [];
  const shownWorker = () => [...workerFrames].reverse().find((w) => !w.background);
  // The Planner, as a phone sees it: ONE worker for the whole planning stage — its first pass, the question check and every
  // re-plan share one card (see plannerStage.ts). Opened by the first PLANNER pass after beginPlanning(), closed once by closePlanning().
  const plannerStage = new PlannerStage(() => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const beginPlanning = (): void => {
    // A stage left open by a path that never reached its close (an early exit) is closed first, so its card is not left hanging.
    closePlanning("interrupted");
    plannerStage.begin();
  };
  const closePlanning = (outcome: string): void => {
    const end = plannerStage.close();
    if (!end) return;
    const i = workerFrames.findIndex((w) => w.id === end.workerId);
    if (i >= 0) workerFrames.splice(i, 1);
    currentWorkerId = shownWorker()?.id;
    if (remote?.connected) {
      const translated = translateForRemote(
        { type: "agent.end", agent: "PLANNER", rounds: end.passes, outcome, tokensUsed: end.tokensUsed, costUsd: end.costUsd, elapsedMs: end.elapsedMs },
        currentPhaseForEvents,
        currentTaskId,
        end.workerId,
        taskRunning
      );
      if (translated) remote.push(translated.kind, translated.payload);
      remote.updateStatus(buildUsageStatusPatch());
    }
  };
  // Who is asking, for question.ask / question.answered: the task, the running phase, and the innermost worker a phone is shown.
  questionContext = () => {
    const w = shownWorker();
    return {
      ...(taskRunning && currentTaskId ? { taskId: currentTaskId } : {}),
      ...(currentPhaseForEvents?.id ? { phaseId: currentPhaseForEvents.id } : {}),
      ...(w ? { worker: w.agent, workerId: w.id } : {}),
    };
  };
  // Unlike currentWorkerId, NOT cleared on agent.end — callers that need to
  // build a `retryOf` for the NEXT invocation of the same step (the
  // corrective Planner pass, the post-clarifying-questions re-plan) read this
  // right after `await runToolAgent(...)` returns, by which point agent.end
  // has already cleared currentWorkerId.
  let lastWorkerId: string | undefined;

  // ADVISOR's answer otherwise vanishes the moment it's printed — nothing
  // connects "here's how to improve X" to a follow-up "let's do your
  // suggestions", so Discovery/Planner would get that literal sentence with
  // zero idea what "your suggestions" actually were. Holding the last
  // exchange here lets the next turn splice it into the task instructions if
  // that turn isn't itself another question — consumed once used, so a THIRD
  // unrelated request later doesn't inherit stale advice.
  const advisorMemory: { last?: { question: string; answer: string } } = {};

  // Whatever appears on the desktop terminal should also appear in the phone's
  // activity feed once a phone is paired, rather than needing a second,
  // separately-maintained narration path. Installed once, unconditionally —
  // it always calls the underlying console method first, so terminal output
  // is completely unchanged, and only pushes onward once `remote` above is
  // actually assigned and connected. Progress "ticks" (the dots after
  // "[API] Calling model...") go through process.stdout.write directly, not
  // console.log, so they are never captured here — the phone gets clean
  // lines, not a stream of dots.
  //
  // A few console.log calls still carry raw terminal control codes meant to
  // overwrite the previous line on a real TTY — "\r\x1b[K" before the final
  // "[API] model ✔ (2.1s)" line, ANSI color codes around a diff stat. Those
  // are meaningless outside a terminal: the phone's activity feed isn't one,
  // so the invisible ESC byte gets dropped in transit and the literal
  // characters "[K" (or "[32m") are left behind, looking like a typo instead
  // of the harmless formatting code it actually is. Strip them here, at the
  // boundary where the text leaves the terminal, rather than touching the
  // formatting itself — the desktop terminal still gets the real thing.

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...consoleArgs: unknown[]) => {
      // What the TERMINAL shows is decided here (see consoleView.ts); the phone below still gets every line as written.
      const shown = terminalView(level, consoleArgs);
      // printAbove clears the pinned input line, lets the real write happen
      // (real terminal scrollback, not a fake viewport), then redraws the
      // prompt + whatever the user has half-typed — a no-op passthrough when
      // the persistent input isn't installed (non-TTY/piped), so this works
      // unchanged either way.
      if (shown) printAbove(() => {
        // Markdown-lite (`` `code` `` / **bold**, see richText.ts) becomes real
        // ANSI for whoever's actually watching a terminal here — the phone
        // branch below still forwards the RAW consoleArgs, markdown markers
        // intact, so its own renderer can turn the same convention into HTML
        // instead of losing it to this step. colorizeRoleTag runs after — it
        // only ever touches a leading "[ROLE]" tag, never the markdown-derived
        // content that follows it.
        original(
          ...shown.map((a) =>
            typeof a === "string"
              ? // Wrapped at word boundaries, continued under the text, before file paths become links (a link is long and invisible).
                linkifyFilePaths(wrapForTerminal(colorizeRoleTag(toAnsi(a)), process.stdout.isTTY ? process.stdout.columns || 0 : 0), [repoRoot, process.cwd()])
              : a,
          ),
        );
      });
      if (remote?.connected && !isLocalOnly()) {
        const message = stripAnsi(
          consoleArgs
            .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
            .join(" ")
        ).trim();
        if (message) {
          // Gated on taskRunning, not just currentTaskId being non-empty:
          // currentTaskId deliberately stays set to the just-finished task's
          // id through the idle wait (see its own declaration comment), and
          // ADVISOR is the one agent that can log during that gap (an /ask
          // asked while idle) — without this, its log lines would carry a
          // stale, already-finished task's id. `log.taskId` is a brand-new
          // field (nothing shipped before this depends on it being present),
          // so omitting it here carries no back-compat cost, unlike
          // worker.start/end's own taskId (see remoteEventTranslator.ts).
          remote.push("log", {
            level,
            message,
            ...(taskRunning && currentTaskId ? { taskId: currentTaskId } : {}),
            ...(currentWorkerId ? { workerId: currentWorkerId } : {}),
          });
        }
      }
    };
  }

  // Mirrors the loop-local `taskUsageStart` declared per-iteration inside
  // `while (true)` below — that one exists to snapshot usage AT THE START OF
  // EACH TASK, but the onEmit listener just below is registered ONCE, outside
  // the loop (see its own comment), so it cannot close over a `const` that
  // gets freshly declared on every iteration. This outer copy is kept in
  // sync by the loop reassigning it instead of shadowing it with its own
  // local declaration — see the loop body.
  let currentTaskUsageStart: UsageReport = events.usageReport();
  // Same idea, scoped one level narrower: reset at the start of EACH PHASE
  // (alongside currentPhaseForEvents, in the phase loop below) so
  // "phaseTokensUsed"/"phaseCostUsd" reflect just the phase currently
  // running — every agent that touches it (Editor, Repair, QA, ...), not
  // the whole task's running total.
  let currentPhaseUsageStart: UsageReport = events.usageReport();
  // The desktop's view of what each persona cost (time, tokens, money): a line when a worker finishes, a line per phase, a breakdown per task.
  const workerLedger = new WorkerLedger();
  let currentTaskStartedAt = Date.now();
  let currentPhaseStartedAt = Date.now();
  /** The phase currently being measured, and the finished phases' totals for this task (see RemoteStatus.phaseUsage). */
  let currentPhaseUsageId: string | undefined;
  let phaseUsageLog: Record<string, PhaseUsageWire> = {};
  /** Close the phase being measured into the log; call before starting another and at a new task. */
  function closePhaseUsage(): void {
    if (currentPhaseUsageId) phaseUsageLog[currentPhaseUsageId] = phaseUsageWire(events.usageDelta(currentPhaseUsageStart));
    currentPhaseUsageId = undefined;
  }

  /**
   * The three usage views a paired phone gets, computed together so every
   * updateStatus call shows them in sync rather than each site hand-rolling
   * its own subset: the whole-task total (tokensUsed/costUsd), the current
   * phase's own total (phaseTokensUsed/phaseCostUsd, every agent that has
   * touched THIS phase), and a per-agent-role breakdown for the task so far
   * (agentUsage — "DISCOVERY spent $0.02, EDITOR spent $0.11, ..."). Closes
   * over currentTaskUsageStart/currentPhaseUsageStart by reference, so it
   * always reads whichever task/phase is current at call time.
   */
  function buildUsageStatusPatch(): Pick<
    RemoteStatus,
    "tokensUsed" | "costUsd" | "phaseTokensUsed" | "phaseCostUsd" | "agentUsage" | "phaseAgentUsage" | "phaseUsage"
  > {
    const taskDelta = events.usageDelta(currentTaskUsageStart);
    const phaseTotals = events.usageDelta(currentPhaseUsageStart).totals;
    const agentUsage = rollUpAgentUsage(taskDelta.byAgent);
    // Every phase of this task, finished ones included, so a phone can read what the Editor cost in phase 5 after phase 6 has
    // started. Additive: the current-phase fields above are unchanged.
    const phaseUsage: Record<string, PhaseUsageWire> = { ...phaseUsageLog };
    if (currentPhaseUsageId) {
      phaseUsage[currentPhaseUsageId] = phaseUsageWire(events.usageDelta(currentPhaseUsageStart));
    }
    return {
      tokensUsed: taskDelta.totals.total,
      ...(taskDelta.totals.costKnown ? { costUsd: taskDelta.totals.cost } : {}),
      phaseTokensUsed: phaseTotals.total,
      ...(phaseTotals.costKnown ? { phaseCostUsd: phaseTotals.cost } : {}),
      agentUsage,
      phaseAgentUsage: rollUpAgentUsage(events.usageDelta(currentPhaseUsageStart).byAgent),
      ...(Object.keys(phaseUsage).length ? { phaseUsage } : {}),
    };
  }

  // Translates the same structured internal events every other agent role
  // already emits (agentLoop.ts's agent.start/agent.end, evidence.ts's
  // gate.result, verifierTools.ts's verdict + its own QA agent.start/end) into
  // typed wire events for a paired device, instead of leaving a native client
  // to regex-scrape the free-text `log` mirror above for the same data.
  // events.emit() itself is a no-op for the NDJSON stdout write unless
  // `--json` enabled it, but onEmit's subscriber callback fires regardless —
  // registered once, here, not inside the per-task loop below, so re-pairing
  // (connectRemote called again from /remote-control) can never accumulate a
  // second listener the way activeQuestionListener once did.
  // Lifetime usage ledger: every recorded model call, attributed to the task
  // and phase that were current at that moment (neither while idle, e.g. /ask).
  // Registered once, here, for the same reason as the onEmit listener below.
  // The persona's own line when a worker finishes: how long, how many tokens, what it cost, and which model answered when it was not the first one configured.
  events.onEmit((event) => {
    if (event.type === "agent.start") workerLedger.start(event.agent, event.models ?? []);
    else if (event.type === "agent.end") {
      const run = workerLedger.end(event.agent, event.elapsedMs ?? 0, event.tokensUsed ?? 0, event.costUsd, currentPhaseUsageId);
      if (announces(run)) console.log(workerLine(run));
    }
  });
  events.onUsage((agent, model, usage) => {
    workerLedger.noteModel(model);
    const role = (QA_USAGE_SUBROLES.includes(agent) ? "QA" : agent).toUpperCase();
    const phase = taskRunning && currentPhaseForEvents
      ? { id: currentPhaseForEvents.id, name: currentPhaseForEvents.name, executor: currentPhaseForEvents.executor }
      : undefined;
    usageLedger().recordCall({
      role,
      model,
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      cost: usage.cost,
      cached: usage.cached,
      ...(taskRunning ? { taskId: currentTaskId, repo: path.basename(repoRoot) } : {}),
      ...(phase ? { phase } : {}),
    });
  });

  const runningAgentLabels: string[] = [];
  // The one live line under the stream: what the run is on, and what model calls are being waited on right now, with moving dots.
  // The wait is shown here and not as a line per call every 20 seconds, which, with several workers at once, was a wall of text.
  let statusBase: string | undefined;
  const refreshStatus = () => {
    const base = runningAgentLabels[runningAgentLabels.length - 1];
    // A different persona (or none) is a different step: its totals of time and tokens start again. Within a step they only go up, across
    // every call and every file, which is what a person watching wants; a per-call timer reset with each call.
    // Totals are kept for the whole TASK per persona: a different persona takes over the line, and this one's time and tokens wait for it,
    // so the next repair attempt continues the count instead of starting from zero. Only the end of the task clears them (below).
    if (base !== statusBase || (!base && liveCallCount() === 0)) {
      statusBase = base;
      enterStep(base);
    }
    setStatusLine(composeStatus(base, Date.now(), (process.stdout.columns || 80) - 4));
  };
  setStatusAvailable(hasPinnedInput);
  // Redrawn while a call is in flight and while a step is under way (between its calls the total keeps counting), then it stops.
  setInterval(() => {
    if (liveCallCount() > 0 || stepActive()) refreshStatus();
  }, 500).unref();
    events.onEmit((event) => {
    if (event.type === "phase.end" && taskRunning && currentTaskId) {
      usageLedger().endPhase(
        currentTaskId,
        { id: event.phaseId, name: event.name, executor: currentPhaseForEvents?.executor },
        event.passed
      );
    }
    // The terminal's own live status line — "what's running right now" —
    // has nothing to do with whether a phone is paired, unlike everything
    // else in this listener, so it runs unconditionally rather than behind
    // the remote?.connected guard below.
    // The id this event's own worker carries: a new one for its start, its own for its end, the innermost shown one otherwise.
    let eventWorkerId = currentWorkerId;
    let endingFrame = -1;
    // A PLANNER pass during planning is part of the stage's one worker (see plannerStage.ts): it runs under that id and sends no
    // worker.start/worker.end of its own. Its usage still counts, and console output is unchanged.
    const plannerPass = (event.type === "agent.start" || event.type === "agent.end") && event.agent === "PLANNER" && !event.background && plannerStage.active;
    let foldedPlannerPass = false;
    if (event.type === "agent.start") {
      // Opaque and unique for this process's lifetime — no need to survive
      // a restart (a worker never outlives one), unlike eventId.
      let id: string;
      if (plannerPass) {
        const pass = plannerStage.startPass();
        id = pass.workerId;
        foldedPlannerPass = pass.fold;
      } else {
        id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      }
      if (!foldedPlannerPass) workerFrames.push({ id, agent: event.agent, background: Boolean(event.background) });
      eventWorkerId = id;
      if (!event.background) {
        currentWorkerId = id;
        lastWorkerId = id;
      }
      const phase = currentPhaseForEvents ? `${currentPhaseForEvents.name} · ` : "";
      runningAgentLabels.push(`${phase}${event.agent}`);
      refreshStatus();
    }
    if (plannerPass && event.type === "agent.end") {
      plannerStage.endPass(event.tokensUsed, event.costUsd);
      foldedPlannerPass = true;
      eventWorkerId = plannerStage.id;
    }
    // The line says what is running NOW. When an agent ends it goes, or shows the one still running; it used to stay until the
    // whole task finished, so "DISCOVERY running…" sat there through the planner, the editor and the idle prompt.
    if (event.type === "agent.end") {
      for (let i = workerFrames.length - 1; i >= 0 && !foldedPlannerPass; i--) {
        if (workerFrames[i].agent === event.agent) {
          endingFrame = i;
          break;
        }
      }
      if (endingFrame >= 0) eventWorkerId = workerFrames[endingFrame].id;
      const ended = runningAgentLabels.findIndex((l) => l.endsWith(`${event.agent}`));
      if (ended >= 0) runningAgentLabels.splice(ended, 1);
      refreshStatus();
    }

    if (remote?.connected) {
      // Durable persistence lives inside RemoteSession.push() itself (see
      // historyLog.ts's doc comment for why — in short, it must also capture
      // `status` pushes, which never flow through translateForRemote at all),
      // so nothing extra is needed here beyond the push itself.
      // currentTaskId is passed UNCONDITIONALLY here, even though it's stale
      // (the just-finished task's id) during the idle wait — every kind that
      // predates this task carries taskId as a plain, always-present string
      // on the wire, and an old phone's deserializer may assume exactly that.
      // taskRunning is passed separately so ONLY the brand-new advisor.start/
      // advisor.answer kinds (which never shipped before, so have no such
      // back-compat constraint) can correctly omit taskId while idle — see
      // translateForRemote's own comment.
      const translated = foldedPlannerPass ? undefined : translateForRemote(event, currentPhaseForEvents, currentTaskId, eventWorkerId, taskRunning);
      if (translated) remote.push(translated.kind, translated.payload);
      // Usage refreshed after every agent — not just at the handful of
      // phase/task boundaries that already call updateStatus. The RAW event
      // here is "agent.end" (remoteEventTranslator.ts only renames it to
      // "worker.end" for the wire payload above); checking for "worker.end"
      // directly on this pre-translation event would never match.
      if (event.type === "agent.end") {
        remote.updateStatus(buildUsageStatusPatch());
      }
    }

    // Cleared after translation above (which still needed the worker's own
    // id for its worker.end payload) so nothing printed between this worker
    // finishing and the next one starting is mistagged as worker-time.
    if (event.type === "agent.end") {
      if (endingFrame >= 0) workerFrames.splice(endingFrame, 1);
      currentWorkerId = shownWorker()?.id;
    }
  });

  if (args.remote) {
    remote = await connectRemote(config, repoRoot, runId, remote, (p: string) => { pendingAttachments.push(p); });
  }

  const memoryFile = path.join(repoRoot, config.recovery.stateDirectory, "codebase-memory.json");
  const memory = loadCodebaseMemory(memoryFile);
  {
    const health = reconcileMemoryWithDisk(memory, repoRoot, config.safety?.blockedDirectories);
    if (health.staleMarked + health.rewrittenMissing + health.droppedContradicted > 0) {
      console.log(
        `[MEMORY] 🧹 Checked memory against the repo: ${health.staleMarked} entr${health.staleMarked === 1 ? "y" : "ies"} marked stale (files gone), ` +
          `${health.rewrittenMissing} "blocked" claim(s) corrected to missing, ${health.droppedContradicted} contradicted claim(s) dropped.`
      );
    }
  }

  console.log(`[MEMORY] 🧠 Session Run #${memory.totalRuns}`);
  if (memory.shortDescription) {
    console.log(`[MEMORY] Overview: ${memory.shortDescription}`);
  }
  if (memory.liveRules.length > 0) {
    console.log(`[MEMORY] Active Live Rules (${memory.liveRules.length}):\n - ${memory.liveRules.join("\n - ")}`);
  }

  const client = new OpenRouterClient(apiKey, config);
  const repo = createRepoTools(repoRoot, config);

  // ---- One-time git push decision, per project -------------------------
  // Runs here, in the synchronous startup sequence, before any phase can
  // possibly execute — the only place this question can be asked that can
  // NEVER land mid-run and interrupt someone who's already walked away.
  // The answer is cached in .agent/push.json (see gitRemote.ts) so it's only
  // ever asked once per (repo, machine); config.git.autoPush is then just a
  // runtime mirror of that file for the rest of this process to read.
  {
    let pushPref: Omit<PushPreference, "decidedAt"> | null = readPushPreference(repoRoot, config.recovery.stateDirectory);

    if (!pushPref) {
      // Nobody to ask right now (no live terminal, no paired phone): stay
      // local and don't cache the answer, so the question is asked for real
      // the next time someone's actually there to answer it — matching
      // config.interaction.autonomous's own reasoning that an unattended run
      // must never stall on a judgment call nobody's there to make.
      const canAsk = isInteractive() || Boolean(remote?.connected);

      if (!canAsk) {
        console.log(`[GIT] No one to ask about pushing right now — staying local for this run.`);
      } else {
        const remoteUrl = await detectOrigin(repo);

        if (remoteUrl) {
          const answer = await askAnywhere(
            {
              id: `gitpush_${runId}`,
              kind: "blocking",
              prompt:
                `Found a GitHub remote for this project: ${remoteUrl}\n` +
                `Push commits there after each verified phase, or stay local-only?\n` +
                `(this is asked once and remembered for this project on this machine — flip it later with /push-repo or /push-local)`,
              fallback: "local",
              askedAt: new Date().toISOString(),
            },
            `Push to ${remoteUrl}? [y = push / N = local only]: `
          );

          if (answer.trim().toLowerCase().startsWith("y")) {
            console.log(`[GIT] Checking access to ${remoteUrl}…`);
            const access = await verifyOriginAccess(repo);
            if (access.ok) {
              pushPref = { autoPush: true, remoteUrl };
              console.log(`[GIT] ✓ Push enabled — verified phases will be pushed to origin.`);
            } else {
              console.warn(`[GIT] ⚠️ Could not reach ${remoteUrl}: ${access.error}`);
              console.warn(`[GIT] Staying local for now. This usually means git needs to authenticate`);
              console.warn(`      against this remote — try \`git ls-remote origin\` by hand once, then`);
              console.warn(`      run /push-repo to try again.`);
              pushPref = { autoPush: false, remoteUrl };
            }
          } else {
            pushPref = { autoPush: false, remoteUrl };
          }
        } else {
          const answer = await askAnywhere(
            {
              id: `gitpush_${runId}`,
              kind: "blocking",
              prompt:
                "No GitHub remote is configured for this project yet.\n" +
                "Paste a repo URL to push to, or leave blank to stay local-only:",
              fallback: "",
              askedAt: new Date().toISOString(),
            },
            "Repo URL (blank = local only): "
          );

          const url = answer.trim();
          if (!url) {
            pushPref = { autoPush: false };
          } else {
            console.log(`[GIT] Checking access to ${url}…`);
            try {
              await repo.git(["remote", "add", "origin", url]);
              const access = await verifyOriginAccess(repo);
              if (!access.ok) throw new Error(access.error);
              pushPref = { autoPush: true, remoteUrl: url };
              console.log(`[GIT] ✓ origin set to ${url} — verified phases will be pushed there.`);
            } catch (err: any) {
              console.warn(`[GIT] ⚠️ Could not add/reach ${url}: ${err.message}`);
              console.warn(`[GIT] Staying local for now. Run /push-repo to try again.`);
              try { await repo.git(["remote", "remove", "origin"]); } catch {}
              pushPref = { autoPush: false };
            }
          }
        }

        if (pushPref) writePushPreference(repoRoot, config.recovery.stateDirectory, pushPref);
      }
    }

    config.git.autoPush = pushPref?.autoPush ?? false;
    if (config.git.autoPush) {
      console.log(`[GIT] Auto-push is ON for this project (${pushPref?.remoteUrl ?? "origin"}).`);
    }
  }

  // A closure over `remote`, not the value itself: `remote` can still be
  // undefined right now and get assigned later (pairing via /remote-control
  // after this verifier already exists), so capturing it by reference is the
  // only way a screenshot taken after that later pairing still reaches the
  // phone.
  const verifier = new AutonomousVerifier(repoRoot, client, repo, config, apiKey, (file, label) => {
    if (remote?.connected) remote.pushScreenshot(`shot_${Date.now()}_${Math.random().toString(36).slice(2)}`, label, file);
  });
  // Routes ask_user (discovery/editor asking mid-task) through the same
  // terminal+phone race as every other question in this app, rather than a
  // second, phone-blind prompt path that only the terminal would ever see.
  const agentTools = new AgentTools(repoRoot, config, (question, fallback, kind) =>
    askAnywhere(
      {
        id: `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        // An approval (a command, an install, a package, a deletion) is marked as one: when nobody answers it is refused, whatever its fallback says.
        kind: kind === "approval" ? "approval" : "blocking",
        prompt: question,
        fallback,
        askedAt: new Date().toISOString(),
      },
      "Your answer: "
    )
  );
  // A security model clears what is plainly harmless before a person is asked about a command; everything else still asks (commandReview.ts).
  if (config.security.commandReview) {
    // Several different models judge, and it runs only when all say safe (commandPanel.ts); they are taken from the configured security, planner and repair
    // models, so whichever models the user chose are the ones that judge. With fewer than two distinct models there is no panel, and the single reviewer stays.
    const panelCfg = config.security.panel;
    const judgeModels = panelCfg?.enabled === false ? [] : pickJudges(config.models, { size: panelCfg?.size, models: panelCfg?.models });
    if (judgeModels.length >= 2) {
      const panel = makePanel(
        judgeModels.map((model) => ({
          model,
          call: (messages) =>
            runLabeledCompletion({ client, models: [model], messages: messages as any, agentName: "SECURITY", jsonMode: true, reasoning: panelCfg?.reasoning ?? "medium", reason: `Security panel: ${model}`, background: true }),
        }))
      );
      agentTools.setCommandReviewer((req) => panel.reviewCommand(req), { coversElevated: true });
      agentTools.setActionReviewer((a) => panel.reviewAction(a));
      console.log(`[SECURITY] Commands and installs are judged by ${judgeModels.length} models (${judgeModels.join(", ")}); a person is asked only if any of them says not safe.`);
    } else {
      agentTools.setCommandReviewer(
        makeCommandReviewer((messages) =>
          runLabeledCompletion({ client, models: securityModels(config.models), messages: messages as any, agentName: "SECURITY", jsonMode: true, reason: "Security: reviewing a command", background: true })
        )
      );
    }
  }
  verifier.setWriteEpochProvider(() => agentTools.writesSoFar());
  // The Editor keeps its tests current: before it may conclude, the tests its change can reach are run, what the change made stale is sent back to it to fix, and what
  // it still cannot fix goes to the heal before QA. The code it changed is screened by the same panel as every other test run.
  if (config.heal?.editorSweep !== false) {
    const editorSweep = new EditorSweep({
      repoRoot,
      written: () => agentTools.filesWrittenThisPhase(),
      review: panelReviewerFor(client, config) ?? makeCommandReviewer(securityReviewCall(client, config, "Security: reviewing code before the Editor's test run")),
      heal: healerFor(client, config, repoRoot, (l) => console.log(`[TESTS] ${l}`)),
      log: (l) => console.log(`[TESTS] ${l}`),
    });
    editorSweep.setWriteEpochProvider(() => agentTools.writesSoFar());
    agentTools.setAffectedTests(editorSweep);
    verifier.setCleanSweepProvider(() => editorSweep.lastCleanSweep());
  }
  // Backs the run_build_check tool: lets EDITOR/REPAIR confirm a patch
  // actually compiles before handing back to QA, reusing the SAME
  // build/typecheck command resolution the real QA build gate uses — see
  // AutonomousVerifier.runBuildCheckOnly's own comment for why this exists.
  agentTools.setBuildCheckRunner((agentLabel) => verifier.runBuildCheckOnly(agentLabel));
  // QA's investigating agent gets the SAME file and command tools the Editor
  // has, so it is held to the same rules: sensitive files and blocked
  // directories are refused, and a command is denied, asked about first, or
  // allowed exactly as it would be for the Editor (qaProjectBackend.ts).
  verifier.setProjectTools({
    repoRoot,
    readFile: (p, a, b) => agentTools.readFile(p, a, b),
    searchCode: (pattern, sub) => agentTools.searchCode(pattern, sub),
    listFiles: (dir) => agentTools.listFiles(dir),
    runCommand: async (args) => {
      agentTools.setActiveAgent("QA");
      return agentTools.runProjectCommand(args);
    },
  });
  // Backs the run_dependency_install tool: lets EDITOR/REPAIR run the SAME
  // install the post-phase gate would eventually run, but mid-turn, so they
  // can see the real result and iterate — see runDependencyInstallCheck's
  // own comment (orchestrator.ts) for why this exists.
  agentTools.setDependencyInstallRunner((writtenFiles, approve, memo) =>
    runDependencyInstallCheck(writtenFiles, repoRoot, approve, undefined, memo)
  );

  // A successful run used to always end the process here — correct for a
  // one-shot `--task`/`--task-file`/`--resume` invocation (a script expects
  // that to exit), but jarring in a genuinely interactive session: you'd
  // have to re-run `yimpim` from the shell for every single task. Loop back
  // to the prompt instead, whenever this task's instructions actually came
  // from typing at it rather than from a flag.
  const loopsBackToPrompt = isInteractive() && !taskPrompt && !taskFile && !isResume;

  // Set by the interactive prompt's own /continue (or /resume) command — see
  // its handler below — and consumed once at the top of the very next loop
  // iteration, the same way the CLI's own `--resume` flag is: this just gives
  // "resume the last incomplete plan" a second way to trigger, from inside a
  // live session instead of only a fresh process launch. Reset immediately
  // after being read so it never causes a LATER, unrelated task to also try
  // to resume.
  let continueRequested = false;

  // Set right after a clean task finish when the user accepted the
  // "N more queued tasks — auto-continue?" offer (see the endTask("done", ...)
  // site below) — consumed once at the top of the very next loop iteration,
  // same handoff shape as continueRequested above.
  let queuedInstructions: string | undefined;
  // A /design polish ui task waiting to finish: once that exact task passes, the same screens are captured again and compared
  // (uiPolish.ts). Cleared by any other task's finish, so it never fires for unrelated work.
  let pendingPolish: { task: string; chosen: any[]; left: { n: number; why: string }[]; last: any } | undefined;

  // True once the user has said "yes" to auto-continuing THIS backlog — a
  // single "yes" must run through every remaining queued task without
  // asking again each time, per the original spec ("if they click yes the
  // agents will run through all N tasks"). Without this, every clean task
  // finish re-asked the same question from scratch, even for a backlog the
  // user had already confirmed — a real, observed bug, not the intended
  // "ask once per backlog" behavior. Reset to false whenever a FRESH
  // instruction (not a queue-drained one) saves a brand-new backlog, so an
  // unrelated later multi-screen ask gets its own confirmation rather than
  // silently inheriting a "yes" given to a completely different backlog.
  let autoContinueConfirmed = false;
  /** "yes to all" given to a roadmap. Its own flag: the task queue resets autoContinueConfirmed whenever a unit's plan adds follow-ups, which made the roadmap ask again after every unit. Cleared only by a "no", a failed unit, or a new roadmap. */
  let roadmapAutoContinue = false;

  // What the roadmap needs from here: the planner model, and a way to ask you.
  const roadmapDeps = (): FlowDeps => ({
    repoRoot,
    // A completely new build gets the full questionnaire; otherwise the person's own setting.
    questionMode: taskQuestionMode(config.planning.questions, { newProject: isNewProject(repoRoot), inRoadmapUnit: false }),
    // The libraries the plan names are looked up in the real registry before the roadmap is saved.
    packageNotes: makePackageNotes(),
    complete: (messages) =>
      runLabeledCompletion({ client, models: config.models.planner, messages: messages as any, agentName: "ROADMAP_PLANNER", jsonMode: true, reason: "Planning the roadmap" }),
    ask:
      isInteractive() || remote?.connected
        ? async (q) =>
            askChoice({
              id: `roadmap_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              kind: "blocking",
              // A question can say why it matters, and carries the answer most people want: that is what is taken when nobody answers in time.
              prompt: q.why ? `${q.question}\n(${q.why})` : q.question,
              choices: q.options.length > 0 ? q.options : undefined,
              allowCustom: true,
              fallback: q.recommended ?? "",
              ...(q.context ? { context: q.context } : {}),
              askedAt: new Date().toISOString(),
            })
        : undefined,
  });

  // Offers the roadmap's next unit, the way a queued task is offered. "no" leaves
  // the roadmap exactly as it is; "yes to all" runs through the rest unasked.
  const ROADMAP_SPEND_NOTICE =
    "A roadmap runs many model calls on its own and can cost real money. YimPim does not limit spend. Set a spending limit on your OpenRouter key before you continue.";
  /**
   * Asked once per roadmap: a roadmap spends money on its own, and nothing here limits it. Unattended, it is said and the run goes on.
   * Normally it never appears as its own question: the notice rides on the first "yes next / yes to all" (see offerNextUnit), and
   * answering yes there is the acknowledgment. This stands alone only for "/roadmap run" and similar, where no such question is asked.
   */
  const confirmRoadmapSpend = async (): Promise<boolean> => {
    const rm = loadRoadmap(repoRoot);
    if (!rm || rm.costNoticeAckedAt) return true;
    const notice = ROADMAP_SPEND_NOTICE;
    if (!(isInteractive() || remote?.connected)) {
      console.log("[ROADMAP] " + notice);
      return true;
    }
    const YES = "I understand, start";
    const answer = await askAnywhere(
      {
        id: `roadmap_cost_${runId}_${Date.now()}`,
        kind: "blocking",
        prompt: notice,
        choices: [YES, "Cancel"],
        fallback: "Cancel",
        askedAt: new Date().toISOString(),
      },
      // The phone keeps its exact two buttons; at the terminal it is a plain yes/no.
      notice + " Start the roadmap? [yes / no] "
    );
    if (!/^(y|yes|yep|yeah|ok|okay|sure|go|start|i understand\b.*)$/i.test(answer.trim())) return false;
    rm.costNoticeAckedAt = new Date().toISOString();
    saveRoadmap(repoRoot, rm);
    return true;
  };

  const offerNextUnit = async (): Promise<void> => {
    const rm = loadRoadmap(repoRoot);
    const nxt = rm ? nextUnits(rm, 1)[0] : undefined;
    if (!rm || !nxt) return;
    const pr = roadmapProgress(rm);
    // A roadmap goes on from one unit to the next by itself: the user can stop it at any time, and a unit that fails stops it (the failure path
    // clears roadmapAutoContinue and never reaches here). interaction.confirmContinue brings the "Continue?" question back.
    const asking = config.interaction.confirmContinue;
    let go = roadmapAutoContinue || !asking;
    // Not acknowledged yet: when asking, the spending notice is part of THIS question, so one answer settles both.
    const noticeHere = !rm.costNoticeAckedAt;
    if (go && !asking && noticeHere) {
      // Said once, not asked: the run goes on, as it already does when nobody is there to answer.
      console.log("[ROADMAP] " + ROADMAP_SPEND_NOTICE + " The roadmap continues on its own; stop it at any time.");
      const fresh = loadRoadmap(repoRoot);
      if (fresh && !fresh.costNoticeAckedAt) {
        fresh.costNoticeAckedAt = new Date().toISOString();
        saveRoadmap(repoRoot, fresh);
      }
    }
    if (!go) {
      const answer = (
        await askAnywhere(
          {
            id: `roadmap_${runId}_${Date.now()}`,
            kind: "blocking",
            prompt: `Roadmap: ${pr.done}/${pr.total} done. Next is ${nxt.id} "${nxt.title}". Continue?${noticeHere ? `\n\n${ROADMAP_SPEND_NOTICE}` : ""}`,
            choices: ["yes next", "yes to all", "no"],
            fallback: "no",
            askedAt: new Date().toISOString(),
          },
          `Roadmap ${pr.done}/${pr.total} done — next: ${nxt.id} "${nxt.title}".${noticeHere ? `\n${ROADMAP_SPEND_NOTICE}\n` : " "}[yes next / yes to all / no] `
        )
      );
      const understood = parseContinueAnswer(answer);
      if (understood !== "no") {
        roadmapAutoContinue = understood === "all";
        go = true;
        if (noticeHere) {
          // Saying yes to a question that carried the spending notice IS the acknowledgment; it is not asked again.
          const fresh = loadRoadmap(repoRoot);
          if (fresh && !fresh.costNoticeAckedAt) {
            fresh.costNoticeAckedAt = new Date().toISOString();
            saveRoadmap(repoRoot, fresh);
          }
        }
        console.log(understood === "all" ? "[ROADMAP] Understood: yes to all. I will not ask again for this roadmap; a failed unit or a \"no\" stops it." : "[ROADMAP] Understood: yes, just the next one.");
      } else {
        roadmapAutoContinue = false;
      }
    }
    if (go && !(await confirmRoadmapSpend())) go = false;
    if (go) {
      const next = startNext(repoRoot);
      if (next.started) {
        console.log(`\n🗺️ [ROADMAP] Starting ${next.started.unit.id}: ${next.started.unit.title}`);
        queuedInstructions = next.started.prompt;
        activeUnitId = next.started.unit.id;
      }
    }
  };

  // A request the classifier judged too big for one task (a whole product, a
  // rebuild or port, many features at once). It is offered a roadmap rather than
  // forced into a 12-phase plan with the rest cut off. Declining, or nobody
  // being there to ask, runs it as one task exactly as before.
  const handleProgram = async (text: string, hint: string | null, offer = true): Promise<"started" | "handled" | "single"> => {
    const canAsk = isInteractive() || !!remote?.connected;
    const planRoadmap = async (spendAcknowledged = false): Promise<"started" | "handled"> => {
      const referenceDir = hint ? resolveReferenceDir(repoRoot, hint) : undefined;
      if (hint && !referenceDir) console.log(`[ROADMAP] I could not find a folder matching "${hint}", so I am planning from your description alone.`);
      console.log(`[ROADMAP] Planning the whole job${referenceDir ? ` from "${referenceDir}"` : ""}. This can take a minute...`);
      const docs = renderUserDocuments(mergeUnique(userNamedFiles(text, repoRoot), turnDocuments), repoRoot);
      const made = await createRoadmap(roadmapDeps(), { goal: text, referenceDir, docs });
      console.log(made.text);
      if (!made.ok) return "handled";
      // Choosing "Plan a roadmap" in the question that carried the spending notice IS the confirmation: it is not asked again.
      if (spendAcknowledged) {
        const rm = loadRoadmap(repoRoot);
        if (rm && !rm.costNoticeAckedAt) {
          rm.costNoticeAckedAt = new Date().toISOString();
          saveRoadmap(repoRoot, rm);
        }
      }
      if (!offer || !canAsk) {
        console.log(`\nThe roadmap is saved. Start it with "/roadmap run".`);
        return "handled";
      }
      await offerNextUnit();
      return queuedInstructions !== undefined ? "started" : "handled";
    };
    // Clearly too big for one task: say so and plan the roadmap, rather than asking or cutting the work off at 12 phases.
    // How big is measured from what is still missing in the code; unattended, with nothing to measure, a roadmap is the safe side.
    if (config.roadmap.autoRoute) {
      if ((await checkWhatExists(text, client, config, repoRoot)) === "handled") return "handled";
      const left = existenceChecked?.text === text ? existenceChecked.remaining : null;
      const roadmapExists = !!loadRoadmap(repoRoot);
      const min = config.roadmap.autoMinRequirements;
      const clearlyBig = left === null ? !canAsk : left >= min;
      if (clearlyBig && !roadmapExists) {
        console.log(`[ROADMAP] ${left === null ? "This is too big for one task and nobody is here to ask" : `${left} things it asks for are not built yet, more than one task holds (12 phases)`}, so I am planning it as a roadmap. (Turn off with roadmap.autoRoute: false in the config.)`);
        return await planRoadmap();
      }
      if (clearlyBig && roadmapExists && !canAsk) {
        console.log("[ROADMAP] A roadmap already exists and nobody is here to ask, so this is added to it.");
        console.log(await changeRoadmap(roadmapDeps(), text));
        return "handled";
      }
    }
    if (!canAsk) return "single";
    const ask = (prompt: string, choices: string[]) =>
      askChoice({
        id: `program_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "blocking",
        prompt,
        choices,
        allowCustom: false,
        fallback: choices[choices.length - 1],
        askedAt: new Date().toISOString(),
      });
    const SINGLE = "Run it as a single task";
    archiveFinishedRoadmap(repoRoot);
    const existing = loadRoadmap(repoRoot);
    if (existing) {
      const pr = roadmapProgress(existing);
      const pick = await ask(
        `This looks bigger than one task, and a roadmap already exists (${pr.done}/${pr.total} done). What should I do with it?`,
        ["Add it to the roadmap", SINGLE]
      );
      if (!pick.startsWith("Add")) return "single";
      console.log(await changeRoadmap(roadmapDeps(), text));
      return "handled";
    }
    const pick = await ask(
      "This looks bigger than one task. Plan the whole thing as a roadmap (units, tracked until it is all done), or run it as a single task? " +
        "A roadmap runs many model calls on its own and can cost real money. YimPim does not limit spend, so set a spending limit on your OpenRouter key first.",
      ["Plan a roadmap (many model calls, may cost money)", SINGLE]
    );
    if (!pick.startsWith("Plan")) return "single";
    return await planRoadmap(true);
  };

  // The roadmap's commands, for both "/roadmap ..." typed and a request the
  // classifier understood as one. "started" means a unit is queued to run.
  const runRoadmapCommand = async (cmd: RoadmapCommand): Promise<"started" | "done"> => {
    if (cmd.kind === "help") {
      console.log(ROADMAP_HELP);
    } else if (cmd.kind === "show") {
      const rm = loadRoadmap(repoRoot);
      if (!rm) {
        console.log(`There is no roadmap yet.\n${ROADMAP_HELP}`);
      } else {
        console.log(renderRoadmap(rm));
        const drift = checkDrift(repoRoot);
        const notes = drift ? describeDrift(drift) : [];
        if (notes.length > 0) console.log(`\nNeeds attention:\n${notes.map((n) => `  - ${n}`).join("\n")}`);
      }
    } else if (cmd.kind === "new" || cmd.kind === "port") {
      roadmapAutoContinue = false;
      console.log(`[ROADMAP] Planning the whole job from ${cmd.kind === "port" ? "the reference folder" : "your request"}. This can take a minute...`);
      // A brief or notes the request names, or that the classifier judged it means, are given in full.
      const docs = renderUserDocuments(mergeUnique(userNamedFiles(cmd.goal, repoRoot), turnDocuments), repoRoot);
      const made = await createRoadmap(roadmapDeps(), { goal: cmd.goal, referenceDir: cmd.kind === "port" ? cmd.dir : undefined, docs });
      console.log(made.text);
      if (made.ok) console.log(`\nStart with "/roadmap run", or just say to continue.`);
    } else if (cmd.kind === "run") {
      const { started, reason } = (await confirmRoadmapSpend()) ? startNext(repoRoot) : { started: undefined, reason: "Not started: you chose Cancel at the spending notice." };
      if (!started) {
        console.log(`[ROADMAP] ${reason}`);
      } else {
        console.log(`\n🗺️ [ROADMAP] Starting ${started.unit.id}: ${started.unit.title}`);
        queuedInstructions = started.prompt;
        activeUnitId = started.unit.id;
        autoContinueConfirmed = false;
        return "started";
      }
    } else if (cmd.kind === "add") {
      console.log(await changeRoadmap(roadmapDeps(), cmd.request));
    } else if (cmd.kind === "sync") {
      const drift = checkDrift(repoRoot);
      const n = drift ? absorbUncovered(repoRoot, drift.uncovered) : 0;
      console.log(n > 0 ? `Added ${n} unit(s) for reference files that appeared since the roadmap was made.` : "Nothing new to add: every reference file already belongs to a unit.");
    } else if (cmd.kind === "reset") {
      roadmapAutoContinue = false;
      const sure = await askChoice({
        id: `roadmap_reset_${Date.now()}`,
        kind: "blocking",
        prompt: "Throw the whole roadmap away? What is done and what is left will be forgotten.",
        choices: ["yes, reset it", "no"],
        allowCustom: false,
        fallback: "no",
        askedAt: new Date().toISOString(),
      });
      console.log(sure.startsWith("yes") && resetRoadmap(repoRoot) ? "Roadmap reset." : "Left as it was.");
    } else {
      console.log(manualUpdate(repoRoot, cmd));
    }
    return "done";
  };

  // Makes a logo and the icon files around it. Several different models propose
  // and draw, a vision model looks at the renders, the person picks one concept.
  // /pentest, stage 1: a read-only audit of this project (code, git history, packages). Nothing is attacked and no
  // running app is contacted; live testing is a separate stage that is not enabled.
  /**
   * /design and /pentest are not build tasks, but their model calls cost real money, so a paired phone gets the same frame it
   * gets for a build: task.start, a worker card per model call (runLabeledCompletion emits those), and task.end carrying the
   * exact tokens and cost. The lifetime ledger attributes the calls to this task too. Inside a running task it adds nothing.
   */
  let closeOwnTask: ((state: "done" | "failed") => Promise<void>) | undefined;
  // Where the usage counters stood when the request being handled was typed, BEFORE the router (and the existence check) spent anything.
  // A job's cost is measured from here, so those calls are part of what the request cost, not lost between tasks.
  let requestUsageStart: UsageReport | null = null;
  // Set when a job already printed its cost, so the same request is not summed twice on the console.
  let costShownForRequest = false;
  const printRequestCost = (label: string): void => {
    if (requestUsageStart && !costShownForRequest) {
      const spent = events.renderUsage(events.usageDelta(requestUsageStart), label);
      if (spent) console.log(spent);
    }
    requestUsageStart = null;
  };
  const asOwnTask = async (prompt: string, work: () => Promise<boolean>): Promise<void> => {
    if (taskRunning) {
      await work();
      return;
    }
    currentTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      currentTaskBaseSha = (await repo.git(["rev-parse", "HEAD"])).trim() || undefined;
    } catch {
      currentTaskBaseSha = undefined;
    }
    currentPhaseForEvents = undefined;
    currentTaskUsageStart = requestUsageStart ?? events.usageReport();
    workerLedger.resetTask();
    currentTaskStartedAt = Date.now();
    currentPhaseUsageStart = events.usageReport();
    currentPhaseUsageId = undefined;
    phaseUsageLog = {};
    remote?.push("task.start", { taskId: currentTaskId, runId, prompt, attachments: [] });
    taskRunning = true;
    usageLedger().beginTask(currentTaskId, { repo: path.basename(repoRoot), title: prompt });
    let state: "done" | "failed" = "failed";
    try {
      state = (await work()) ? "done" : "failed";
    } finally {
      // What this job cost, on the console as well as on a paired phone (task.end carries the same numbers).
      const spent = events.renderUsage(events.usageDelta(currentTaskUsageStart), "Cost of this job");
      if (spent) console.log(spent);
      costShownForRequest = true;
      requestUsageStart = null;
      await closeOwnTask?.(state);
    }
  };

  const runPentestJob = async (request: string): Promise<void> => {
    if (!(await ensureSpecialistModel("pentest", config, repoRoot))) return;
    await runPentestJobNow(request);
  };
  const runPentestJobNow = (request: string): Promise<void> => asOwnTask(("/pentest " + request).trim(), async () => {
    const secModels = securityModels(config.models);
    console.log(`🛡️ [PENTEST] Starting a read-only security audit of this project with ${secModels.join(", ")} (models.security). This takes a few minutes and uses a handful of model calls.`);
    try {
      const result = await runSecurityAudit({
        repoRoot,
        call: (messages, label, json) => runLabeledCompletion({ client, models: secModels, messages: messages as any, agentName: "SECURITY", jsonMode: json, reason: "Pentest: " + label }),
        dependencyLookup: config.security.dependencyLookup,
        log: (line) => console.log(line),
      });
      console.log("\n" + (result.ok ? "🛡️" : "⚠️") + " [PENTEST] " + result.text);
      return result.ok;
    } catch (err: any) {
      console.error("[PENTEST] That did not complete: " + err.message);
      return false;
    }
  });

  // The code-fix task that /tests heal hands to the normal pipeline when tests turn out to be right and the code wrong.
  let pendingTestFixTask: string | undefined;
  // After that fix attempt (success or failure, never a Stop): tests that still fail are removed with everything pointing at them.
  const settleTestFixes = async (finishedTask: string | undefined): Promise<void> => {
    if (!isFixTask(finishedTask)) return;
    try {
      const lines = await settlePendingFixes(repoRoot);
      for (const l of lines) console.log("🧪 [TESTS] " + l);
    } catch {
      // never blocks what comes next
    }
  };

  // /tests heal: brings a red test suite back to green, one worker per failing test file, all at once.
  const runTestHealJob = (all = false): Promise<void> => asOwnTask(all ? "/tests heal all" : "/tests heal", async () => {
    const healModels = config.models.repair ?? config.models.editor;
    console.log(`🧪 [TESTS] Healing the test suite with ${healModels.join(", ")}. Every failing test file gets its own worker, started together.`);
    // What the first model parks goes to a sandbox (a disposable copy of the project) when heal.sandbox is on and there is a stronger model; else to the JSON pass below.
    const sandbox = sandboxFor({ client, config, repairModels: healModels, log: (line) => console.log("🧪 [TESTS] " + line) });
    try {
      const report = await healTests({
        repoRoot,
        all,
        sandbox,
        call: (messages, label, json) => runLabeledCompletion({ client, models: healModels, messages: messages as any, agentName: "REPAIR", jsonMode: json, reason: label }),
        // What the first model cannot settle (it parks those causes) goes to the stronger one: every model after the first in the repair chain. With a
        // single model there is nobody to hand it to, and parked causes are reported as they are.
        escalate:
          !sandbox && healModels.length > 1
            ? (messages, label, json) => runLabeledCompletion({ client, models: healModels.slice(1), messages: messages as any, agentName: "REPAIR", jsonMode: json, ...(json ? { structured: HEAL_REPLY_STRUCTURED } : {}), reason: `${label} (stronger model)` })
            : undefined,
        log: (line) => console.log("🧪 [TESTS] " + line),
      });
      console.log("\n🧪 [TESTS] " + renderHealReport(report));
      const bugs = report.results.filter((r) => r.status === "code-bug");
      if (bugs.length > 0) {
        // What the fix task is told. The diagnosis as the worker wrote it (without the bookkeeping note that says it was reused, which
        // used to land in the middle of its last sentence), and the failure as a digest: the distinct causes with how often each
        // happens, the first line of the project's own code each points at and the code around it, and the names of the tests that fail.
        // Not the tail of the raw output, which is whichever test happened to fail last and is usually not the cause that was diagnosed.
        // (built by fixItemsFor: the same function the benchmark uses to show what would be sent, and it drops the report's cost lines)
        const items = fixItemsFor(report.results, repoRoot);
        savePendingFixes(repoRoot, items);
        pendingTestFixTask = fixTaskFor(items);
        console.log(`🧪 [TESTS] Sending ${bugs.length} code defect(s) to the normal pipeline to fix. A test file is removed afterwards only if nothing in it passes; one that still fails in part is kept.`);
      }
      return report.after ? report.after.ok : report.before.ok;
    } catch (err: any) {
      console.error("[TESTS] That did not complete: " + err.message);
      return false;
    }
  });

  // An audit (compare the work to a document, report, build nothing) is a job of its own: its model calls are attributed to it, a paired
  // phone sees it as a task with its exact cost, and the console says what it cost. Resolves false when the comparison could not be made.
  const runAuditJob = async (request: string): Promise<boolean> => {
    let handled = false;
    await asOwnTask(("Audit: " + request).slice(0, 200), async () => {
      existenceSection = "";
      existenceRefs = [];
    existenceRefs = [];
      existenceChecked = null;
      handled = (await checkWhatExists(request, client, config, repoRoot, true)) === "handled";
      return true;
    });
    return handled;
  };

  const runDesignJob = async (request: string): Promise<void> => {
    if (!(await ensureSpecialistModel("design", config, repoRoot))) return;
    await runDesignJobNow(request);
  };
  // `/design critique ui [references…] [--screens images…]`: see uiCritique.ts. Writes design-system/CRITIQUE.md, changes no app code.
  const runUiCritiqueCommand = async (request: string): Promise<void> => {
    if (!(await ensureSpecialistModel("design", config, repoRoot))) return;
    const { isUiCritiqueRequest, parseCritiqueArgs, runUiCritique } = await import("./uiCritique.js");
    const args = parseCritiqueArgs(isUiCritiqueRequest(request)?.rest ?? "");
    const visionModels = config.models.designerVision ?? config.models.verifierVision ?? config.models.editorVision ?? config.models.verifier;
    await asOwnTask(("/design " + request).trim(), async () => {
      try {
        const result = await runUiCritique(args, {
          repoRoot,
          visionModels,
          call: (ms, messages, label, json) =>
            runLabeledCompletion({ client, models: ms, messages: messages as any, agentName: "DESIGNER", jsonMode: json, reason: `UI critique: ${label}` }),
          log: (line) => console.log(line),
        });
        console.log(`\n${result.ok ? "🎨" : "⚠️"} [CRITIQUE] ${result.text}`);
        return result.ok;
      } catch (err: any) {
        console.error(`[CRITIQUE] That did not complete: ${err.message}`);
        return false;
      }
    });
  };
  const runDesignJobNow = (request: string): Promise<void> => asOwnTask(("/design " + request).trim(), async () => {
    const models = config.models.designer ?? config.models.planner;
    const visionModels = config.models.designerVision ?? config.models.verifierVision ?? config.models.editorVision ?? config.models.verifier;
    console.log("🎨 [DESIGN] Starting. This takes a few minutes and uses a number of model calls (capped by designer.maxCalls).");
    const renderer = await openRenderer();
    try {
      const docs = renderUserDocuments(mergeUnique(userNamedFiles(request, repoRoot), turnDocuments), repoRoot);
      const result = await runDesign(
        {
          repoRoot,
          models,
          visionModels,
          call: (ms, messages, label, json) =>
            runLabeledCompletion({ client, models: ms, messages: messages as any, agentName: "DESIGNER", jsonMode: json, reason: `Design: ${label}` }),
          renderer,
          ask:
            isInteractive() || remote?.connected
              ? async (prompt, choices, fallback) =>
                  askChoice({
                    id: `design_${Date.now()}`,
                    kind: "blocking",
                    prompt,
                    choices,
                    allowCustom: false,
                    fallback,
                    askedAt: new Date().toISOString(),
                  })
              : undefined,
          log: (line) => console.log(line),
          // A paired phone gets the picture itself (the same image channel QA screenshots use), so a
          // choice between concepts can be made from the phone; the desktop gets the full path.
          show: (label, file) => {
            console.log(`   🖼️  ${label}: ${file}`);
            // A copy goes into .agent/screenshots/ first: that is the folder the phone can re-request pictures from.
            if (remote?.connected) remote.pushScreenshot(`design_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, label, stageDesignImage(repoRoot, file));
          },
          limits: config.designer,
          docs: docs || undefined,
        },
        request
      );
      console.log(`
${result.ok ? "🎨" : "⚠️"} [DESIGN] ${result.text}`);
      return result.ok;
    } catch (err: any) {
      console.error(`[DESIGN] That did not complete: ${err.message}`);
      return false;
    } finally {
      await renderer?.close();
    }
  });

  taskLoop: while (true) {
  let instructions = "";
  // The user's own words for this turn, when `instructions` had context appended for the model (see the classification branch
  // below). task.start and the History title show THESE, never the appended text. Unset means `instructions` is already the user's text.
  let userPrompt: string | undefined;
  // An agent's question in the middle of a task is answered from the specs, the task's own definition and the code first;
  // only what they do not settle (a real product decision) reaches the user.
  // Every question put to a person keeps its technical wording and gets a plain-words explanation under it, so someone who
  // has never programmed can still answer. Asked as written if the model is slow or fails.
  setAnswerDeadline(Math.round((config.interaction.answerTimeoutMinutes ?? 0) * 60_000));
  setAssumptionRoot(repoRoot);
  // When nobody answers in time, a model reads the question and answers it (the question's own default stays the safety net). Never for an approval.
  if (config.interaction.modelAnswersOnTimeout !== false) setTimeoutResolver(makeTimeoutResolver({ client, config, repoRoot }));
  setQuestionExplainer((q) =>
    plainWordsFor(q, (messages) =>
      runLabeledCompletion({ client, models: config.models.planner, messages: messages as any, agentName: "PLANNER", jsonMode: true, reason: "Explaining a question in plain words" })
    )
  );
  agentTools.setQuestionResolver(async (question) => {
    const named = mergeUnique(userNamedFiles(instructions, repoRoot), turnDocuments);
    let shortlist: string[] = [];
    try {
      shortlist = shortlistFromMap(question, loadRepoMap(repoRoot), 6, repoRoot).map((s) => s.path);
    } catch {
      shortlist = [];
    }
    const got = await answerFromProject({
      question,
      task: instructions,
      named,
      shortlist,
      repoRoot,
      complete: (messages) => runLabeledCompletion({ client, models: config.models.planner, messages: messages as any, agentName: "PLANNER", jsonMode: true, reason: "Checking an agent's question against the specs and code before asking you" }),
    });
    if (!got) return null;
    let logged = "";
    if (got.followUp) {
      const unit = recordFollowUp(repoRoot, got.followUp, instructions.trim().split("\n")[0].slice(0, 300));
      if (unit) {
        logged = ` The work left out is on the roadmap as ${unit} for later.`;
        console.log(`[ROADMAP] Left out of this task and added as ${unit}: ${got.followUp}`);
      }
    }
    return `${got.answer} (settled by ${got.file}: "${got.quote}").${logged} This was answered from the project, so no one needs to be asked; carry on.`;
  });
  // Set when answerIfQuestion's intent classifier resolved this turn's text
  // to "verify" (check existing behavior) rather than "task" (build/change
  // something) — read once Planner runs, to swap in PLANNER_VERIFY_SYSTEM
  // and skip Editor's initial pass per phase. Reset every taskLoop iteration
  // same as instructions, since it describes THIS turn's classification only.
  let verifyOnly = false;
  let planOutput = "";
  // True for exactly this iteration when `instructions` above came from the
  // auto-continue backlog rather than a freshly typed/one-shot request — read
  // once planning finishes to decide whether this plan's own followUpTasks
  // REPLACE the saved backlog (fresh request) or are APPENDED after whatever
  // of it remains (draining an existing one; replacing here would silently
  // drop the rest of the backlog this very instruction was popped from).
  let fromQueue = false;
  if (queuedInstructions !== undefined) {
    instructions = queuedInstructions;
    queuedInstructions = undefined;
    fromQueue = true;
    turnDocuments = [];
  }
  let activePlan: Plan | undefined;
  let attachments: Attachment[] = [];
  // Derived from `attachments` as soon as it's loaded below, and read both
  // by Discovery (right after) and much later by Editor/Repair/QA — declared
  // at this outer scope for the same reason `attachments` itself is.
  let imageAttachments: Attachment[] = [];
  const completedPhaseIds: string[] = [];

  // Everything through the end of this task (instructions, discovery,
  // planning, and phase execution) is wrapped so a Stop (phone or Esc) —
  // which throws AbortedError from wherever runControl.throwIfAborted()
  // next runs, Discovery included, not just mid-phase — is caught here
  // rather than propagating out of main() entirely. It used to reach the
  // top-level catch at the bottom of this file, which always process.exit'd,
  // ending the whole session (and with it, a paired phone's connection) even
  // in an interactive run with a live prompt right here to return to. See
  // the catch at the bottom of this try.
  //
  // The persistent input line has to span this whole try, not just the phase
  // loop — installed right before the phase loop, /stop (or Esc) during
  // Discovery or Planning (both of which call the model, same as any phase)
  // would silently do nothing; only a paired phone's remote Stop could reach
  // runControl during those stages.
  console.log(`[YIMPIM] Type /stop to stop safely at the next boundary (Ctrl-C force-quits immediately).`);
  const stopPersistentInput = installPersistentInput();
  // /remote-control works at any moment, including mid-run: it pairs without touching the run or clearing the screen.
  const stopLiveCommands = registerLiveCommands(["/remote-control", "/rc"], async () => {
    if (taskRunning && remote?.connected) {
      console.log(`[REMOTE] A phone is already paired. Re-pair after this task finishes (a new code would drop it mid-run).`);
      return;
    }
    remote = await connectRemote(config, repoRoot, runId, remote, (p: string) => { pendingAttachments.push(p); }, taskRunning);
  });
  // The terminal hides routine bookkeeping (successful model calls, files read, gates that passed); the phone still gets every line.
  const stopVerboseCommand = registerLiveCommands(["/verbose"], () => {
    setVerbose(!isVerbose());
    console.log(isVerbose() ? "[DISPLAY] Showing every line. Type /verbose again to hide routine detail." : "[DISPLAY] Routine detail hidden. Type /verbose to show every line.");
  });
  // Models can be changed while a task runs: the change waits until that role next starts (see modelQueue.ts), the models in
  // use stay on a pinned row, and /model opens a small picker in the pinned area while the stream keeps scrolling above it.
  const modelQueue = new ModelQueue(config.models as Record<string, any>, PERSONAS.map((p) => p.key));
  // The models row under the prompt is gone: every call already says which persona and model it used, and /model lists them all.
  // Switching while a task runs still works; only the permanent row is cleared.
  const refreshModelStrip = () => setModelStrip(undefined);
  const roleLabel = (role: string) => PERSONAS.find((p) => p.key === role)?.label ?? role;
  modelQueue.onChange((c) => {
    refreshModelStrip();
    const to = c.chain?.join("  →  ") ?? "unset";
    console.log(
      c.when === "queued"
        ? `[MODELS] ${roleLabel(c.role)} → ${to} is queued: it applies when the ${roleLabel(c.role)} next starts, so the one working now finishes on its current model.`
        : `[MODELS] ${roleLabel(c.role)} now uses ${to}.`
    );
  });
  events.onEmit((event) => {
    if (event.type === "agent.start") modelQueue.agentStarted(event.agent);
    else if (event.type === "agent.end") modelQueue.agentEnded(event.agent);
  });
  refreshModelStrip();
  let modelCatalog: CatalogModel[] | undefined;
  const queueModelFromPanel = (role: string, chain: string[] | undefined) => {
    const persona = PERSONAS.find((p) => p.key === role);
    if (!persona) return;
    if (chain && chain.length) {
      const problem = chainProblem(persona, chain);
      if (problem) {
        console.log(`[MODELS] Not changed: ${problem}`);
        return;
      }
    } else if (!persona.optional) {
      console.log(`[MODELS] ${persona.label} can't be left unset.`);
      return;
    }
    const target = locateConfigFile(repoRoot) ?? globalConfigPath();
    try {
      if (chain && chain.length) writeSetting(target, `models.${role}`, chain);
      else clearSetting(target, `models.${role}`);
    } catch (err: any) {
      console.log(`[MODELS] Not changed: ${err.message}`);
      return;
    }
    modelQueue.queue(role, chain && chain.length ? chain : undefined);
  };
  const stopModelCommand = registerLiveCommands(
    ["/model", "/models"],
    () => {
      let close: () => void = () => {};
      const panel = new ModelPanel({
        personas: PERSONAS,
        current: (role) => modelQueue.current(role),
        pending: (role) => modelQueue.pendingFor(role),
        candidates: async (persona) => {
          const { key: apiKey } = loadApiKey();
          if (!apiKey) throw new Error("no API key available (run yimpim setup)");
          modelCatalog ??= await fetchCatalog(apiKey);
          return candidatesFor(modelCatalog, persona);
        },
        format: formatModel,
        choose: queueModelFromPanel,
        onUpdate: () => refreshPanel(),
        maxRows: Math.max(3, Math.min(8, (process.stdout.rows || 24) - 12)),
      });
      close = openPanel({
        rows: () => panel.rows(),
        key: (str, key) => panel.key(str, key),
      });
      void close;
    },
    () => taskRunning
  );
  const stopInputListener = () => {
    stopModelCommand();
    stopVerboseCommand();
    stopLiveCommands();
    stopPersistentInput();
  };

  // Pushes task.end and resets task-scoped state (taskRunning, currentPhaseForEvents)
  // — called ONLY after every bit of this task's own closing narration has
  // already been printed/pushed (the usage summary, manual steps, and — for
  // a clean finish — the "ALL PHASES SUCCEEDED" banner that follows finish()).
  // appendHistoryEntry/push() route purely on which segment is CURRENTLY open
  // at call time, and task.end is exactly what flips that open segment over
  // from this task's own file to a between-segment — so calling it any
  // earlier would leave the task's own closing lines spilling into the NEXT
  // between-segment instead of staying in this task's file. Declared here
  // (above the try below, not inside it) so both the success path and the
  // catch block beside that try can reach it.
  let lastEndedTaskId = "";
  const endTask = async (state: "done" | "failed" | "aborted", taskUsage: UsageReport): Promise<void> => {
    if (currentTaskId && lastEndedTaskId === currentTaskId) return;
    if (currentTaskId) lastEndedTaskId = currentTaskId;
    // A task that failed or was stopped mid-planning still closes its Planner card, so no worker is left open on the phone.
    closePlanning(state === "done" ? "completed" : state);
    const totalPhases = activePlan?.phases.length ?? 0;
    const phasesCompleted = completedPhaseIds.length;
    const cost = taskUsage.totals.costKnown ? taskUsage.totals.cost : undefined;
    const status: "completed" | "failed" | "stopped" =
      state === "done" ? "completed" : state === "aborted" ? "stopped" : "failed";
    remote?.push("task.end", {
      type: "task_end",
      status,
      taskId: currentTaskId,
      state,
      phasesCompleted,
      totalPhases,
      tokens: taskUsage.totals.total,
      tokensUsed: taskUsage.totals.total,
      ...(cost !== undefined ? { cost, costUsd: cost } : {}),
    });
    taskRunning = false;
    // Closes the task's ledger record, then tells a paired phone the new
    // lifetime total — after task.end, so the phone sees it as the last word.
    usageLedger().endTask(currentTaskId, state);
    remote?.pushUsageTotals(toUsageWire(usageLedger().snapshot()));
    // Reconcile status heartbeat so even a dropped packet converges on the next poll.
    remote?.updateStatus({
      state,
      taskRunning: false,
      taskStatus: state === "done" ? "completed" : "failed",
      ...buildUsageStatusPatch(),
    });
    // Otherwise an /ask asked during the idle gap before the NEXT task starts
    // (ADVISOR's own agent.start, kept for old-phone compat) inherits this
    // just-finished task's phase context on its worker.start — the exact same
    // kind of stale-leftover leak currentTaskId's own mint-time reset already
    // guards against, just caught one task-boundary later.
    currentPhaseForEvents = undefined;
    await remote?.flush();
    remote?.notify("done");
  };
  closeOwnTask = (state) => endTask(state, events.usageDelta(currentTaskUsageStart));

  try {

  // Check for --resume state (or an in-session /continue — see above)
  if (isResume || continueRequested) {
    continueRequested = false;
    const cachedState = loadResumeState(repoRoot);
    if (cachedState && cachedState.planOutput) {
      console.log(`\n[YIMPIM] 🔁 Resuming from cached plan generated at ${cachedState.timestamp}...`);
      instructions = cachedState.instructions;
      planOutput = cachedState.planOutput;

      if (cachedState.plan) {
        const resumed = mergeRedTestPhases(cachedState.plan.phases, new Set(cachedState.completedPhaseIds ?? []));
        activePlan = { ...cachedState.plan, phases: resumed.phases };
        for (const m of resumed.merges) console.log(describeRedTestMerge(m));
        completedPhaseIds.push(...(cachedState.completedPhaseIds ?? []));
        taskProgress = Array.isArray(cachedState.progress) ? cachedState.progress : [];
        const remaining = activePlan.phases.length - completedPhaseIds.length;
        console.log(
          `[YIMPIM] ${completedPhaseIds.length}/${activePlan.phases.length} phase(s) already complete; ${remaining} remaining.`
        );
      } else {
        // Older resume state predates structured phases.
        activePlan = parsePlan(planOutput, instructions).plan;
      }
    } else {
      console.warn(`[YIMPIM] ⚠️ No cached plan found in .agent/last-plan.json. Falling back to input flow.`);
    }
  }

  if (!planOutput) {
    if (taskFile && fs.existsSync(taskFile)) {
      instructions = fs.readFileSync(taskFile, "utf-8");
    } else if (taskPrompt) {
      instructions = taskPrompt;
    }

    // One-shot invocation (--task / --task-file) has no prompt loop to return
    // to, so a question here gets its answer and the process exits cleanly —
    // the CLI equivalent of the interactive loop returning to "yimpim > ".
    // The interactive loop below classifies its own input as it is typed,
    // so this only applies when instructions arrived from one of these flags.
    // A roadmap unit is a build task by definition; classifying its text could
    // misread it as a question and answer it instead of building it. A fix task queued from a failing test is the same: its text is about
    // tests, so the router read it as another request to heal them, ran the heal again, and spent a call on it.
    if (instructions.trim() && !args.yes && !(fromQueue && activeUnitId) && !isFixTask(instructions)) {
      requestUsageStart = events.usageReport();
      costShownForRequest = false;
      const outcome = await answerIfQuestion(instructions.trim(), client, config, repo, repoRoot, agentTools, memory, memoryFile, false, pendingAttachments, advisorMemory);
      if (outcome === "handled") {
        printRequestCost("Cost of that request");
        return;
      }
      if (outcome === "audit") {
        if (!(await runAuditJob(instructions.trim()))) {
          costShownForRequest = false;
          await answerIfQuestion(instructions.trim(), client, config, repo, repoRoot, agentTools, memory, memoryFile, true, pendingAttachments, advisorMemory);
          printRequestCost("Cost of that request");
        }
        return;
      }
      if (outcome === "design") {
        await runDesignJob(instructions.trim());
        return;
      }
      if (outcome === "pentest") {
        await runPentestJob(instructions.trim());
        return;
      }
      if (outcome === "tests") {
        await runTestHealJob();
        if (!pendingTestFixTask) return;
        instructions = pendingTestFixTask;
        pendingTestFixTask = undefined;
      }
      // A big request run unattended: a roadmap when it is clearly too big for one task, else one task; either way it is
      // checked against the code first.
      if (outcome === "program") {
        const said = await handleProgram(instructions.trim(), programReferenceHint, false);
        if (said !== "single") return;
        if ((await checkWhatExists(instructions.trim(), client, config, repoRoot)) === "handled") return;
      }
      verifyOnly = outcome === "verify";
    }

    if (!instructions.trim()) {
      while (!instructions.trim()) {
        console.log(
          `\n💬 What should I do in ${path.basename(repoRoot)}?` +
            `  (or /remote-control, /link, /model, /status, /plan, /memory, /continue, /stop, /help, /exit)`
        );

        // Always a real, trackable question — not just when remote?.connected
        // happens to already be true at the moment THIS iteration starts.
        // askAnywhere degrades to local-only cleanly when nobody's paired
        // (the remote half of its race just never resolves), so there's no
        // downside to always using it — but the OLD conditional here meant a
        // phone that paired mid-prompt (the exact "type /remote-control,
        // walk away" flow) was invisible to whichever prompt was already
        // outstanding when it connected: that prompt was a bare promptOnce,
        // never registered with runControl at all, so there was nothing for
        // askAnywhere's remote race OR the reconnect catch-up loop to find —
        // the phone would sit idle until a LATER iteration's prompt (which
        // finally started AFTER remote?.connected had flipped true) came
        // around and used askAnywhere for the first time.
        const rawInput = await askAnywhere(
          {
            id: `task_${runId}_${Date.now()}`,
            kind: "blocking",
            prompt: `What would you like me to do in ${path.basename(repoRoot)}?`,
            fallback: "",
            askedAt: new Date().toISOString(),
            idle: true,
          },
          "yimpim > "
        );

        // A Stop from the phone resolves this exact question with its
        // fallback ("") — indistinguishable from a genuine empty Enter by
        // rawInput alone. Left unchecked, the loop below silently re-prompts
        // using the same aborted runControl state, which resolves EVERY
        // future question instantly too (see RunControl.ask's early return) —
        // spinning forever with no real wait, reprinting the prompt as fast
        // as the event loop cycles. Nothing was actually running yet, so
        // reset and give back a normal, working prompt instead.
        if (runControl.isAborted) {
          // A stop that arrived while nothing was running, said as it was made: from the phone, or typed here.
          const who = runControl.reason === "phone" || /phone/i.test(runControl.reason) ? "from the phone" : `(${runControl.reason || "requested"})`;
          console.log(`\n[CONTROL] 🛑 Stopped ${who}. Nothing was running yet — back to a fresh prompt.`);
          runControl.reset();
          continue;
        }

        const trimmed = rawInput.trim();

        // Nothing typed at this prompt — a slash command, a stray git error,
        // a bad model response, anything — should ever be able to take the
        // whole process down. Before this, an uncaught error anywhere in the
        // dispatch below propagated straight past the interactive loop and
        // crashed the entire session, relay included — with a phone possibly
        // the only way back in, that meant being locked out entirely until
        // someone could get back to the laptop. Catch here, report clearly on
        // both terminal and phone (console.log is already mirrored to both),
        // and just re-prompt instead. A real, unrecoverable failure during an
        // actual phase run is a different matter — that still propagates, and
        // still should.
        try {

        if (trimmed === "/help") {
          printHelpMenu();
        } else if (trimmed === "/status") {
          printStatus(repoRoot, config, memory);
        } else if (trimmed === "/remote-control" || trimmed === "/rc") {
          // Pair now, before a task exists, so the phone is watching from the
          // very start of the run rather than joining midway.
          remote = await connectRemote(config, repoRoot, runId, remote, (p: string) => { pendingAttachments.push(p); });
        } else if (trimmed === "/link") {
          // Link THIS machine to YIMPIM Pro — the cloud-tunnel lease flow in
          // remote/auth.ts: request a short pairing code from the broker,
          // show its claim URL (QR is a bonus, plain text always printed),
          // then poll until a phone claims it and the lease is saved to
          // ~/.yimpim/auth.json. Never throws — failures print and return
          // to the prompt, same as every other slash command here.
          // The flow only polls the broker and never reads stdin, so close the
          // persistent input line while it waits: nothing typed meanwhile can
          // end up submitted as a prompt once it finishes.
          pauseInput();
          try {
            const { executeLinkFlow } = await import("./remote/auth.js");
            const lease = await executeLinkFlow();
            console.log(
              lease
                ? `[PRO] ✓ Pro subscription claimed successfully! You can now enter /remote-control to connect via the Yimpim Remote app.`
                : `[PRO] Link not completed — no lease saved. Run /link to try again.`
            );
          } catch (err: any) {
            console.error(`[PRO] Could not link this device: ${err.message}`);
          } finally {
            resumeInput();
          }
        } else if (trimmed === "/model" || trimmed === "/models") {
          // These three menus do their own raw-mode-aware ESC handling and
          // own wizard screens (src/wizard/prompts.ts) —
          // pausing the persistent input line first hands them truly
          // exclusive stdin instead of two things reacting to the same
          // keystroke, and resumeInput() puts the pinned prompt right back
          // once they return, cancelled or not.
          pauseInput();
          try {
            await changeModel(config, repoRoot);
          } finally {
            resumeInput();
          }
        } else if (trimmed === "/model-sort") {
          pauseInput();
          try {
            await changeProviderSort(config, repoRoot);
          } finally {
            resumeInput();
          }
        } else if (trimmed === "/api-key") {
          pauseInput();
          try {
            await changeApiKey(client);
          } finally {
            resumeInput();
          }
        } else if (trimmed === "/usage" || trimmed.startsWith("/usage ")) {
          // Lifetime totals for this desktop (survive restarts), by worker and
          // model, with the most recent tasks broken down by phase. An
          // optional number sets how many recent tasks to list.
          const n = Number.parseInt(trimmed.slice("/usage".length).trim(), 10);
          console.log(renderLedger(usageLedger().snapshot(), Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 5));
        } else if (trimmed === "/approvals" || trimmed.startsWith("/approvals ")) {
          // Commands you approved for this project (run_project_command). They
          // are stored under your home directory, never in the repo.
          const approvals = new CommandApprovals();
          const arg = trimmed.slice("/approvals".length).trim();
          const revoke = /^revoke\s+(all|\d+)$/i.exec(arg);
          if (arg && !revoke) {
            console.log(`Usage: /approvals            list remembered commands\n       /approvals revoke <n|all>`);
          } else if (revoke) {
            const which = revoke[1].toLowerCase() === "all" ? "all" : Number.parseInt(revoke[1], 10);
            const removed = approvals.revoke(repoRoot, which);
            console.log(removed > 0 ? `Forgot ${removed} approved command(s).` : `Nothing matched "${revoke[1]}".`);
          } else {
            const list = approvals.list(repoRoot);
            if (list.length === 0) {
              console.log(`No remembered commands for this project.`);
            } else {
              console.log(`Remembered commands for this project (run without asking):`);
              list.forEach((e, i) => console.log(`  ${i + 1}. ${describeCommand(e.argv, e.cwdRel)}   (approved ${e.approvedAt.slice(0, 10)})`));
              console.log(`Forget one with /approvals revoke <n>, or all with /approvals revoke all.`);
            }
          }
        } else if (trimmed === "/plan") {
          printPlan(repoRoot);
        } else if (trimmed === "/push-repo") {
          await enablePushToRepo(repo, repoRoot, client, config, runId);
        } else if (trimmed === "/push-local") {
          await disablePushToLocal(repo, repoRoot, client, config);
        } else if (trimmed === "/branch" || trimmed.startsWith("/branch ")) {
          const name = trimmed.slice("/branch".length).trim();
          if (!name) {
            console.log(`Usage: /branch <name>`);
          } else {
            await handleBranchSwitch(repo, repoRoot, client, config, name);
          }
        } else if (trimmed === "/branches") {
          await printBranches(repo);
        } else if (trimmed === "/merge" || trimmed.startsWith("/merge ")) {
          const name = trimmed.slice("/merge".length).trim();
          await handleMerge(repo, repoRoot, client, config, name || undefined);
        } else if (trimmed === "/memory") {
          printMemory(memory, memoryFile);
        } else if (trimmed === "/continue" || trimmed === "/resume") {
          // Same cached plan `--resume` reads (.agent/last-plan.json) — this is
          // just the "sorry, mistake — keep going" path for a session that's
          // already open, so a Stop (phone or Esc) doesn't force restarting
          // Discovery/Planning from zero for phases that already passed.
          const cachedState = loadResumeState(repoRoot);
          if (!cachedState || !cachedState.planOutput || !cachedState.plan) {
            console.log(`[YIMPIM] Nothing to continue — no cached plan found for this repo.`);
          } else if ((cachedState.completedPhaseIds ?? []).length >= cachedState.plan.phases.length) {
            console.log(`[YIMPIM] The last plan already finished — nothing left to continue.`);
          } else {
            continueRequested = true;
            continue taskLoop;
          }
        } else if (trimmed === "/tests" || trimmed.startsWith("/tests ")) {
          const sub = trimmed.slice("/tests".length).trim();
          if (sub === "log") {
            console.log("\n" + renderLog(repoRoot) + "\n");
          } else if (sub === "" || sub === "heal" || sub === "heal all") {
            await runTestHealJob(sub === "heal all");
            if (pendingTestFixTask) {
              queuedInstructions = pendingTestFixTask;
              pendingTestFixTask = undefined;
              continue taskLoop;
            }
          } else console.log("[TESTS] Use /tests heal (or /tests heal all), or /tests log.");
        } else if (trimmed === "/pentest" || trimmed.startsWith("/pentest ")) {
          await runPentestJob(trimmed.slice("/pentest".length).trim());
        } else if (trimmed === "/design" || trimmed.startsWith("/design ")) {
          const what = trimmed.slice("/design".length).trim();
          // The UI critique is its own explicit command: it starts the app's dev server, a browser and vision calls, so it is loaded
          // only here, when a person typed it, and never by a routine run.
          const uiCritique = /^\s*(?:critique|review|audit)\s+(?:my\s+|the\s+)?(?:ui|app|screens?|interface)\b/i.test(what);
          const uiPolish = /^\s*polish\s+(?:my\s+|the\s+)?(?:ui|app|screens?|interface)\b/i.test(what);
          if (!what) console.log('Say what to design, for example: /design a logo for my budgeting app (or just say "I need a logo").');
          else if (uiCritique) await runUiCritiqueCommand(what);
          else if (uiPolish) {
            // The critique's changes become an ordinary task (planned, built and checked like any other); when it passes, the
            // screens are compared before and after (see the success path below). Loaded only here, when a person typed it.
            if (await ensureSpecialistModel("design", config, repoRoot)) {
              const { isUiPolishRequest, parsePolishArgs, loadLastCritique, chooseChanges, polishTask } = await import("./uiPolish.js");
              const last = loadLastCritique(repoRoot);
              if (!last) console.log("[POLISH] There is no critique to act on yet. Run /design critique ui first.");
              else {
                const { chosen, left } = chooseChanges(last.critique, parsePolishArgs(isUiPolishRequest(what)?.rest ?? ""));
                for (const l of left) console.log(`[POLISH] Leaving out change ${l.n}: ${l.why}.`);
                if (chosen.length === 0) console.log("[POLISH] No change was chosen, so there is nothing to do.");
                else {
                  const task = polishTask(last.critique, chosen);
                  console.log(`🎨 [POLISH] Making ${chosen.length} change(s) from design-system/CRITIQUE.md as a normal task; the screens are compared when it passes.`);
                  pendingPolish = { task, chosen, left, last };
                  queuedInstructions = task;
                  continue taskLoop;
                }
              }
            }
          } else await runDesignJob(what);
        } else if (trimmed === "/roadmap" || trimmed.startsWith("/roadmap ")) {
          if ((await runRoadmapCommand(parseRoadmapCommand(trimmed.slice("/roadmap".length)))) === "started") continue taskLoop;
        } else if (trimmed === "/exit") {
          // Without this, a paired phone just sees polling go silent forever
          // (it has no live socket to notice a disconnect) until the broker's
          // 12h TTL sweep quietly deletes the session — stop() pushes
          // "session.end" (which lands in durable history) and unregisters
          // from the broker immediately instead. Safe to await here: unlike
          // a signal handler, nothing forces this process to die before the
          // await resolves.
          if (remote?.connected) await remote.stop("desktop exited");
          // Close the pinned input first: it erases its own rows, so the shell prompt that follows is not left sitting on the
          // models row. The goodbye line is then an ordinary line.
          stopPersistentInput();
          console.log("[YIMPIM] 👋 Session terminated.");
          process.exit(0);
        } else if (trimmed === "/ask" || trimmed.startsWith("/ask ")) {
          // Guaranteed manual override — always Advisor mode, no classification,
          // for whenever you want to be certain nothing gets touched.
          const question = trimmed.slice(4).trim();
          if (!question) {
            console.log(`Usage: /ask <question>`);
          } else {
            await answerIfQuestion(question, client, config, repo, repoRoot, agentTools, memory, memoryFile, true, pendingAttachments, advisorMemory);
          }
        } else if (!trimmed) {
          // Enter with nothing typed (and no slash command) is not a task —
          // don't spend a classification call finding that out. This is also
          // the fix for the sharper edge: with an unresponsive prompt, a
          // leftover/garbled Enter used to silently resolve to an empty
          // string and still kick off a real model call.
        } else if (handleLikelyCommandTypo(trimmed)) {
          // Handled and reported above — a mistyped or slash-less command,
          // not a task. Falling through to classification here used to kick
          // off a full Discovery pass on things like "/hrlp" or
          // "remote-control" typed without its slash.
        } else {
          // One cheap classification call per typed instruction, biased toward
          // "task" on anything uncertain — see answerIfQuestion's own comment
          // for why that bias is the right default.
          requestUsageStart = events.usageReport();
          costShownForRequest = false;
          let outcome = await answerIfQuestion(trimmed, client, config, repo, repoRoot, agentTools, memory, memoryFile, false, pendingAttachments, advisorMemory);
          if (outcome === "design") {
            await runDesignJob(trimmed);
            outcome = "handled";
          }
          if (outcome === "pentest") {
            await runPentestJob(trimmed);
            outcome = "handled";
          }
          if (outcome === "tests") {
            await runTestHealJob();
            if (pendingTestFixTask) {
              queuedInstructions = pendingTestFixTask;
              pendingTestFixTask = undefined;
              continue taskLoop;
            }
            outcome = "handled";
          }
          if (outcome === "audit") {
            // The comparison could not be made (the check is off, or nothing could be read out of the request): answer it from the code.
            if (!(await runAuditJob(trimmed))) {
              costShownForRequest = false;
              await answerIfQuestion(trimmed, client, config, repo, repoRoot, agentTools, memory, memoryFile, true, pendingAttachments, advisorMemory);
            }
            outcome = "handled";
          }
          if (outcome === "roadmap") {
            const said = roadmapIntent as { action: unknown; request: unknown } | null;
            if ((await runRoadmapCommand(commandFromIntent(said?.action, said?.request))) === "started") continue taskLoop;
            outcome = "handled";
          }
          if (outcome === "program") {
            const programResult = await handleProgram(trimmed, programReferenceHint);
            if (programResult === "started") continue taskLoop;
            // Chosen "single task": what the spec asks for is still checked against the code first.
            outcome = programResult === "single" ? ((await checkWhatExists(trimmed, client, config, repoRoot)) === "handled" ? "handled" : "task") : "handled";
          }
          // A request that ended here without becoming a task (an answer, a note, a git action) still cost something: say what.
          if (outcome === "handled") printRequestCost("Cost of that request");
          if (outcome !== "handled") {
            verifyOnly = outcome === "verify";
            // This turn wasn't itself a question — if the previous turn WAS
            // (advisorMemory.last), fold that answer into the instructions so
            // "let's do your suggestions" actually carries what the
            // suggestions were, instead of Discovery/Planner receiving that
            // literal sentence with no idea what it refers to. Consumed
            // either way: a THIRD, unrelated request later should not
            // silently inherit advice from two turns ago.
            const advice = advisorMemory.last;
            advisorMemory.last = undefined;
            // The same for an audit that only reported: "lets work on what existence found" carries the request and the findings.
            const audit = !advice && lastAudit && intentFollowsAudit ? lastAudit : null;
            if (audit) lastAudit = null;
            // The model reads the context-enriched text below; the record of the task keeps what the user actually typed.
            userPrompt = trimmed;
            instructions = advice
              ? `${trimmed}\n\n[Context: you previously answered "${advice.question}" with the following — use it if this request refers to it:\n${advice.answer}]`
              : audit
                ? `${trimmed}\n\n[Context: this request was already checked against the code, and nothing was changed. The original request was:\n${audit.request}\n\nThe check found:\n${audit.report}\n\nDo only what it found missing or not determined (read the code to decide those); do not rebuild what it found built. Evidence for "already built" comes from the project's own source, never from reference folders.]`
                : trimmed;
          }
        }
        } catch (err: any) {
          instructions = "";
          // What the failed request cost is not carried into whatever task comes next.
          printRequestCost("Cost of that request");
          console.error(`\n[ERROR] That didn't complete: ${err.message}`);
          console.error(`[ERROR] Nothing was changed by it — back to a fresh prompt.\n`);
        }
      }

      if (!instructions.trim()) {
        throw new TaskFailedError("Task instructions cannot be empty.");
      }
    }

    // Before a single new file gets touched for this task: resolve anything
    // already sitting uncommitted from before it, automatically. This is the
    // actual fix for work piling up unnoticed between sessions — checking
    // only when someone remembers to ask isn't checking at all. A no-op
    // (single git status call) when the tree is already clean, which is the
    // common case.
    await reviewAndResolvePendingChanges(repo, repoRoot, client, config);

    // 0. Reference material, if the user supplied any. Loaded before any model
    // call so a bad path or a missing vision model fails in a second, not after
    // discovery has already been paid for.
    //
    // Assigns the OUTER `attachments` (declared once per task, above the
    // isResume branch) — this used to be `let attachments: Attachment[] = []`
    // again right here, which shadowed the outer one instead of populating
    // it. Every read of `attachments`/`imageAttachments` OUTSIDE this inner
    // block — the entire Editor/Repair image-attachment path, and QA's
    // reference-image comparison — was silently reading the outer variable,
    // which this shadow never touched, so it was permanently empty
    // regardless of what was actually attached. Not something introduced
    // today; this predates it.
    if (pendingAttachments.length > 0) {
      try {
        attachments = await loadAttachments(pendingAttachments, repoRoot);
      } catch (err: any) {
        if (err instanceof AttachmentError) {
          throw new TaskFailedError(`[ATTACH] ${err.message}`, err.hint ? `[ATTACH] ${err.hint}` : undefined);
        }
        throw err;
      }

      for (const l of describeAttachments(attachments)) console.log(`[ATTACH] ${l}`);

      // A text-only planner silently ignores image blocks, which would produce a
      // plan that quietly disregards the mockup. Refuse instead.
      if (hasImages(attachments)) {
        const plannerModel = config.models.planner[0];
        const { key: probeKey } = loadApiKey();
        let visionOk = true;
        try {
          const { fetchCatalog } = await import("./models.js");
          const catalog = await fetchCatalog(probeKey!);
          const entry = catalog.find((m) => m.id === plannerModel);
          if (entry && !entry.supportsVision) visionOk = false;
        } catch {
          // Catalog unreachable: proceed rather than block on a network blip.
        }
        if (!visionOk) {
          throw new TaskFailedError(
            `[ATTACH] Your planner model (${plannerModel}) cannot read images. The attached image would be ignored without warning.`,
            `[ATTACH] Pick a vision-capable planner (yimpim setup), or attach the spec as text/PDF instead.`
          );
        }
      }
      console.log("");
    }

    // Computed early (before Discovery, not just before Editor) — Discovery's
    // own task prompt below needs to know NOW whether to attach the image,
    // not several stages later.
    imageAttachments = attachments.filter((a) => a.kind === "image");

    // Discovery had NO image-attachment path at all until this — its prompt
    // was always plain text, regardless of what was attached, so it could
    // never independently confirm or refute what an image actually shows. It
    // was reporting from memory and source text alone, which is exactly how
    // a deleted screen's old elements (a power button nowhere in a new
    // mockup) came back: nothing ever checked the picture against them.
    let usingDiscoveryVision = false;
    if (imageAttachments.length > 0 && config.models.discoveryVision && config.models.discoveryVision.length > 0) {
      usingDiscoveryVision = true;
    } else if (imageAttachments.length > 0) {
      console.warn(
        `\n[DISCOVERY] ⚠️ This task has an attached image, but models.discoveryVision is not configured — ` +
          `Discovery will report from memory and source text only, never checking either against the image ` +
          `itself. Run /model to set a Discovery (Vision) chain if that matters for this task.\n`
      );
    }

    // A fresh id for THIS task, minted now — right as it actually begins —
    // not at the top of the loop (while still idly waiting for this prompt)
    // and not reused from the process-level runId (see currentTaskId's own
    // declaration comment). Minting it any earlier mislabels exactly the
    // wrong things: a still-outstanding "awaiting-input" status for the OLD
    // task would pick up the NEW id before the new task has anything to show
    // for it, and the previous task's own final "done" status risks the same
    // if anything executes between it and here before this line moves.
    currentTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      currentTaskBaseSha = (await repo.git(["rev-parse", "HEAD"])).trim() || undefined;
    } catch {
      currentTaskBaseSha = undefined;
    }
    // Discovery/Planner run before any phase exists — if a leftover phase
    // object from the PREVIOUS task's own phase loop survives here, their
    // worker.start events wrongly carry that old phase's id/name (translateForRemote
    // reads this for every agent.start, live, whatever it currently holds).
    currentPhaseForEvents = undefined;
    // A loop-back session shares one cumulative usage tracker across every
    // task it runs — without this snapshot, this task's "done" summary would
    // silently fold in the previous task's spend too.
    currentTaskUsageStart = requestUsageStart ?? events.usageReport();
    workerLedger.resetTask();
    currentTaskStartedAt = Date.now();
    requestUsageStart = null;
    // Also reset here, not just at each phase's own start below: Discovery
    // and Planner both run BEFORE any phase begins, and their own agent.end
    // pushes would otherwise report phaseTokensUsed/phaseCostUsd left over
    // from the PREVIOUS task's last phase instead of something meaningful
    // for a task that hasn't reached a phase yet.
    currentPhaseUsageStart = events.usageReport();
    currentPhaseUsageId = undefined;
    phaseUsageLog = {};
    // The explicit task-boundary event — emitted exactly once, right here,
    // where currentTaskId is minted. `instructions` is the exact prompt that
    // started this task (already trimmed/validated non-empty above).
    remote?.push("task.start", {
      taskId: currentTaskId,
      runId,
      prompt: (userPrompt ?? instructions).trim(),
      attachments: attachments.map((a) => a.label),
      ...(activeUnitId ? { roadmapUnitId: activeUnitId, roadmapId: loadRoadmap(repoRoot)?.createdAt } : {}),
    });
    if (activeUnitId) attachTaskToUnit(repoRoot, activeUnitId, currentTaskId);
    taskRunning = true;
    // Counted (and titled) at the start, so a task that ends without a single
    // model call still shows up in the lifetime task count.
    usageLedger().beginTask(currentTaskId, { repo: path.basename(repoRoot), title: userPrompt ?? instructions });
    // Pushed immediately, as ONE consolidated snapshot, so a paired phone's
    // very next status already carries the new taskId AND a genuinely clean
    // slate — not just a new id stapled onto the PREVIOUS task's leftover
    // state. updateStatus only shallow-merges; patching taskId alone here
    // would leave `phases`/`goal`/`currentPhase` holding the just-finished
    // task's final values (its completed phase list) until this task's own
    // Discovery/Planning eventually overwrites them — a real window where
    // the snapshot claims a new task while still displaying the old one's
    // cards, not just a client-side rendering gap.
    remote?.updateStatus({
      taskId: currentTaskId,
      state: "planning",
      goal: undefined,
      phases: [],
      currentPhase: undefined,
      ...buildUsageStatusPatch(),
    });

    // A fix for a DIAGNOSED defect (a test failing because the code is wrong) goes straight to the Editor: the diagnosis already names the
    // code and the line, so Discovery and the Planner would only rediscover it with larger models, and write a plan for a small fix.
    // Which tests the fix is for is also told to the verifier, which must not excuse them as "already failing". Set for every task, so
    // a stale set never leaks into the next one.
    const direct = !verifyOnly && isFixTask(instructions) ? directFixFor(instructions, repoRoot) : undefined;
    // The names of the failing tests (saved with the fix task) say which assertions are locked: only theirs. An ordinary task sets an empty list: no lock at all.
    const failingByFile: Record<string, string[]> = {};
    if (direct) for (const p of loadPendingFixes(repoRoot)) failingByFile[p.file] = p.tests ?? [];
    setMustPass(direct ? direct.tests : [], repoRoot, { failing: failingByFile });

    // 1. Discovery Phase (Inspect Memory & Bounded Repo Map)
    if (direct) {
      console.log(`\n[FIX] The diagnosis already names the code (${direct.files.join(", ")}), so Discovery and the Planner are skipped: the Editor starts from it, and ${direct.tests.join(", ")} must pass afterwards.`);
    } else {
      console.log(`\n==================================================`);
      console.log(
        `🔍 **[STAGE 1: DISCOVERY${usingDiscoveryVision ? " - VISION" : ""}]** Models: ` +
          `${(usingDiscoveryVision ? config.models.discoveryVision! : config.models.discovery).join(", ")}`
      );
      console.log(`==================================================`);
    }

    // The repo map is already loaded; rank it against the task so Discovery
    // starts from the likely files and confirms them instead of searching.
    pendingFeatureRecord = undefined;
    taskTouchedFiles.clear();
    taskProgress = [];
    let discoveryShortlist = "";
    try {
      // Files may have been edited by hand, moved, renamed, split or deleted since
      // the map was written. Re-derive it from the code first, so what Discovery
      // is handed says where things are NOW, not where they used to be.
      logMapSync(syncRepoMap(repoRoot, { maxEntries: config.memory.maxEntries }), "Brought the repo map up to date with the code:");
      const repoMap = loadRepoMap(repoRoot);
      discoveryShortlist = renderShortlist(withImportedNeighbors(shortlistFromMap(instructions, repoMap, 8, repoRoot), repoMap, repoRoot));
    } catch {
      // No map yet (a new project) or an unreadable one: Discovery explores as before.
    }

    // Files the request itself names are where its author says the work is (a fix task from a failing test names the code and the line).
    // They are the first leads, ahead of a shortlist guessed from the repo map, which on this kind of task picked unrelated files.
    const citedByUser: CodeRef[] = (() => {
      try {
        return resolveOnDisk(repoRoot, parseCodeRefs(instructions));
      } catch {
        return [];
      }
    })();
    const namedLeads = (() => {
      try {
        const named = userNamedFiles(instructions, repoRoot);
        // A file the request cites with lines keeps them ("app/x.tsx:120-160"): the author's pointer is part of the lead.
        const label = (f: string) => {
          const c = citedByUser.filter((r) => r.file === f && r.from !== undefined);
          return c.length > 0 ? `${f}:${c.map((r) => (r.to === r.from ? `${r.from}` : `${r.from}-${r.to}`)).join(",")}` : f;
        };
        return named.length > 0 ? `\n\nThe request names these files, so start with them (read the part it points at, not necessarily all of it): ${named.map(label).join(", ")}` : "";
      } catch {
        return "";
      }
    })();
    // Discovery starts with nothing shown. What it is told up front (the lines the request cites, the places existence verified) is written into its prompt, from the files as they are now,
    // and ONLY those ranges are recorded as shown to it: a read of anything else is sent in full, a read of these returns only what is not already here.
    const discoveryLedger = agentTools.readLedger;
    discoveryLedger.begin("DISCOVERY");
    const preRead = direct ? { text: "", included: [] } : discoveryLedger.inject("DISCOVERY", [...citedByUser.filter((r) => r.from !== undefined), ...existenceRefs], 8000);
    const preReadSection = preRead.text
      ? `\n\nLINES ALREADY READ FOR YOU (real line numbers of the current files: the request cites some, the check of what already exists verified the rest; do not read these ranges again, read only other lines):\n${preRead.text}`
      : "";

    // DISCOVERY_SYSTEM is already injected into the system prompt by buildContextualSystemPrompt("DISCOVERY", ...).
    const discoveryText = `Target Task:
${instructions.trim()}

Existing Codebase Memory:
\`\`\`json
${JSON.stringify(memory, null, 2)}
\`\`\`

Instructions:
Evaluate if the Existing Codebase Memory and known components provide sufficient context.
- If YES: Conclude immediately.
- If NO: Use search_code, get_file_outline, or read_file to find missing targets. Call register_component for any key screens/models you locate.${namedLeads}${preReadSection}${discoveryShortlist}

You have a small budget: after about ${DISCOVERY_FILE_BUDGET} files read or ${DISCOVERY_ROUND_BUDGET} turns your tools are removed and you must write your findings from what you have. Write taskFindings from what you have confirmed, and put what you could not confirm in uncertainties.`;
    const discoveryPrompt = usingDiscoveryVision ? buildUserContent(discoveryText, imageAttachments) : discoveryText;

    // What was already read before this pass, so only what Discovery reads now is credited to it.
    const readBeforeDiscovery = new Set(agentTools.inspectedThisPhase());
    const discoveryRaw = direct ? direct.discovery : await runToolAgent({
      prompt: discoveryPrompt,
      repo,
      repoRoot,
      client,
      config,
      agentTools,
      models: usingDiscoveryVision ? config.models.discoveryVision! : config.models.discovery,
      agentName: "DISCOVERY",
      visionMode: usingDiscoveryVision,
      tools: DISCOVERY_TOOLS_SCHEMA,
      readStage: "DISCOVERY",
    });
    // If Discovery ran out of turns and wrote nothing usable, the Planner still
    // gets the files it read (marked unconfirmed) instead of an empty allowlist.
    const discoveryOutput = recoverDiscoveryOutput(
      discoveryRaw,
      candidateTargets(agentTools.inspectedThisPhase().filter((f) => !readBeforeDiscovery.has(f)), repoRoot, 15)
    );
    if (discoveryOutput !== discoveryRaw) {
      console.log(`[DISCOVERY] ↩️ Discovery did not finish; passing the Planner the files it read as unconfirmed leads.`);
    }
    pendingFeatureRecord = { task: instructions, output: discoveryOutput };

    const jsonBlocks = Array.from(discoveryOutput.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)).map((m) => m[1]);
    if (jsonBlocks.length === 0) {
      const fallback = discoveryOutput.match(/(\{[\s\S]*\})/);
      if (fallback) jsonBlocks.push(fallback[1]);
    }
    for (const jsonBlock of jsonBlocks) {
      try {
        const lenient = parseLenient(jsonBlock);
        if (!lenient) throw new Error(`not JSON, and not repairable (${jsonBlock.length} characters)`);
        const parsed = lenient.value;
        if (lenient.repaired) console.log("[MEMORY] 🔧 Discovery's notes had a small JSON slip; repaired and kept them.");
        if (parsed.shortDescription) memory.shortDescription = parsed.shortDescription;
        if (Array.isArray(parsed.techStack)) {
          memory.techStack = mergeTechStack(memory.techStack, parsed.techStack);
        }
        if (Array.isArray(parsed.architectureRules)) {
          memory.architectureRules = mergeArchitectureRules(memory.architectureRules, parsed.architectureRules);
        }
        if (Array.isArray(parsed.learningsAndPitfalls)) {
          appendLiveRules(memory, parsed.learningsAndPitfalls);
        }
        reconcileResolvedManualSteps(memory, parsed.resolvedManualSteps);
      } catch (e: any) {
        console.warn(`[MEMORY] ⚠️ Could not parse JSON block from Discovery: ${e.message}`);
      }
    }

    saveCodebaseMemory(memoryFile, memory);

    // 2. Planning Phase (Pure Synthesis: 0 Tool Calls)
    if (!direct) {
      console.log(`\n==================================================`);
      console.log(
        `🧠 **[STAGE 2: PLANNER${verifyOnly ? " - VERIFY ONLY" : ""}]** Models: ${config.models.planner.join(", ")}`
      );
      if (verifyOnly) {
        console.log(`[PLANNER] 🔍 Verify-only task — planning checkable scenarios, no code changes planned.`);
      }
      console.log(`==================================================`);
    }

    // A request that builds or restyles user-facing UI gets a design system first (once, into design-system/),
    // so the Planner and every Editor build from the same decisions instead of improvising a look per screen.
    if (config.uiDesign.enabled && !verifyOnly) {
      try {
        const made = await ensureDesignSystem({
          call: (ms, messages, label, json) =>
            runLabeledCompletion({
              client,
              models: ms,
              messages: messages as any,
              agentName: "DESIGNER",
              jsonMode: json,
              reason: "Design: " + label,
              // The yes/no "does this need a design system" call: no visible result, so no top-level "Run" card on a phone.
              ...(label === "design decision" ? { background: true } : {}),
            }),
          models: config.models.designer ?? config.models.planner,
          repoRoot,
          request: instructions.trim(),
          log: (line) => console.log(line),
          // A new app or site: one question about the look (only then; see uiDirections.ts).
          visual: {
            ask:
              isInteractive() || remote?.connected
                ? (prompt, choices, fallback) =>
                    askChoice({ id: `design_look_${Date.now()}`, kind: "blocking", prompt, choices, allowCustom: true, fallback, askedAt: new Date().toISOString() })
                : undefined,
            show: (label, file) => {
              console.log(`   🖼️  ${label}: ${file}`);
              if (remote?.connected) remote.pushScreenshot(`design_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, label, stageDesignImage(repoRoot, file));
            },
            visionModels: config.models.designerVision ?? config.models.verifierVision ?? config.models.editorVision ?? config.models.verifier,
            autonomous: config.planning.questions === "autonomous",
            newProject: isNewProject(repoRoot),
            openRenderer,
          },
        });
        if (made) console.log("🎨 [DESIGN] " + made.summary);
        // Inside a roadmap, what the design system leaves to do (icons, empty states, the app icon and logo) becomes units in the "Design" area.
        if (made?.created) {
          const added = addDesignFollowUps(repoRoot, made);
          if (added > 0) console.log(`🎨 [DESIGN] ${added} follow-up unit(s) added to the roadmap (area "Design").`);
        }
      } catch (err: any) {
        console.log("[DESIGN] Skipped the design system: " + String(err?.message ?? err).slice(0, 120));
      }
    }

    // Files the request itself names (a brief, a spec) go to the Planner whatever
    // Discovery chose to list: always readable, and a document is in its prompt.
    const userFiles = mergeUnique(userNamedFiles(instructions, repoRoot), turnDocuments);
    if (userFiles.length > 0 && !direct) {
      console.log(`[PLANNER] 📎 Giving the Planner the file(s) your request names: ${userFiles.join(", ")}`);
    }
    const userDocsSection = renderUserDocuments(userFiles, repoRoot);

    // Security before building: the project's posture, and a threat model for a task that touches identity, money, files,
    // personal data, webhooks, email or infrastructure. Its requirements go to the Planner, which puts them into the plan.
    let securitySection = "";
    if (config.security.enabled && !verifyOnly && !direct) {
      try {
        const sec = await ensureThreatModel({
          // stage: this runs before the Planner, as part of planning, so the phone folds it into the Discover & Plan card.
          call: (ms, messages, label, json) => runLabeledCompletion({ client, models: ms, messages: messages as any, agentName: "SECURITY", jsonMode: json, reason: "Security: " + label, stage: "planning" }),
          // The security model writes the threat model, but only when the planner's models say the task is sensitive.
          models: securityModels(config.models),
          triageModels: config.models.planner,
          repoRoot,
          request: instructions.trim(),
          documents: userDocsSection,
          log: (line) => console.log(line),
        });
        securitySection = sec.plannerSection;
      } catch (err: any) {
        console.log("[SECURITY] Skipped the threat model: " + String(err?.message ?? err).slice(0, 120));
      }
    }

    // Ephemeral note from a PRIOR task's genuine failure (a real
    // TaskFailedError, not a user-initiated Stop) — see lastFailure.ts's own
    // comment for why this exists and when it clears. Only reached on a
    // fresh plan (this whole block is skipped on --resume, which already has
    // its own, much richer failure context via phaseRepairContext) — without
    // it, a vague follow-up like "fix the bugs that aborted last time, then
    // continue progress.md" had no actual record of what failed to act on,
    // so the planner tended to just act on whichever part of the request was
    // concrete ("continue") and silently drop the vague part.
    const lastFailure = loadLastFailure(repoRoot);
    const lastFailureSection = lastFailure
      ? `\n\nNote — the previous task in this repo ended in failure:\n${lastFailure.reason}\nThis is surfaced once, automatically, and is not necessarily what the user is asking about now — only plan around it if the User Request above doesn't already cover it.`
      : "";


    // The Planner starts with nothing shown. The lines Discovery read (the files it chose first) are written into its prompt, up to a cap, from the files as they are now, and only what is
    // written is recorded as shown to it. Each pass of the Planner is a new conversation: it begins again from exactly this (the prompt every pass includes).
    const plannerForward = direct
      ? { text: "", included: [] as { file: string; from: number; to: number }[] }
      : agentTools.readLedger.forward("DISCOVERY", "PLANNER", 8000, mergeUnique(extractDiscoveryTargetFiles(discoveryOutput), userFiles));
    const plannerReadSection = plannerForward.text
      ? `\n\nLINES DISCOVERY ALREADY READ (real line numbers of the current files; do not read these ranges again):\n${plannerForward.text}`
      : "";
    const startPlannerConversation = () => {
      agentTools.readLedger.begin("PLANNER");
      for (const r of plannerForward.included) agentTools.readLedger.record("PLANNER", r.file, r.from, r.to);
    };
    const parsedDiscovery = parseDiscoveryJson(discoveryOutput);
    const taskFindingsFallback = parsedDiscovery?.taskFindings
      ? ""
      : `\n\nTask-Specific Discovery Evidence:\n${extractTaskFindings(discoveryOutput)}`;
    const plannerPrompt = `User Request:
${instructions.trim()}${userDocsSection}${lastFailureSection}${securitySection}${existenceSection}${plannerReadSection}

Discovery Findings:
${discoveryOutput}${taskFindingsFallback}

Read-only Architecture Metadata:
${readPlannerMetadata(repoRoot, config.safety?.blockedDirectories, config.memory?.maxPromptEntries)}

Active Live Rules:
${memory.liveRules.map((r) => `- ${r}`).join("\n") || "None"}`;

    // References go to the planner and nowhere else. It is a bounded pass, so the
    // cost is paid once — and whatever the planner learns from them is written
    // into the plan text, which every phase already receives.
    //
    // Bounded inspection window: opened fresh for this pass, restricted to the
    // exact files Discovery already identified — see beginPlannerInspection's
    // own comment for why an unconfigured window refuses every read outright
    // rather than falling back to unbounded access.
    {
      const planTargets = mergeUnique(extractDiscoveryTargetFiles(discoveryOutput), userFiles);
      agentTools.beginPlannerInspection(planTargets, plannerReadBudget(planTargets.length));
    }
    // Tracks how many times THIS task has asked the Planner to redo its job
    // (corrective pass, post-clarifying-questions re-plan) — fed into the
    // next retry's `attempt`, and reset per task since it's declared inside
    // the per-task loop body.
    let plannerAttempt = 1;
    // Planning is one phone card (see plannerStage.ts): every Planner pass from here to the close below folds into it.
    beginPlanning();
    planOutput = direct ? direct.plan : await runToolAgent({
      prompt: buildUserContent(plannerPrompt, attachments) as any,
      repo,
      repoRoot,
      client,
      config,
      agentTools,
      models: config.models.planner,
      agentName: "PLANNER",
      readStage: "PLANNER",
      onConversationStart: startPlannerConversation,
      tools: PLANNER_TOOLS_SCHEMA,
      verifyOnly,
    });
    // Captured immediately — by the time control returns here, agent.end has
    // already fired and cleared currentWorkerId, so lastWorkerId (which
    // survives that clear) is the only way to recover which worker this was.
    const firstPlannerWorkerId = lastWorkerId;

    // Persist PROGRESS.md and resume checkpoint
    const progressPath = path.join(repoRoot, "PROGRESS.md");
    let parsed = parsePlan(planOutput, instructions.trim());
    // More phases than the ceiling allows: parsePlan already capped the
    // executable list, but phases beyond MAX_PLAN_PHASES (and every file and
    // objective they carried) would otherwise be dropped without a word. Send
    // the complete proposal back to the planner instead, and only fall back to
    // the capped list if consolidation fails.
    if (parsed.allPhases.length > MAX_PLAN_PHASES) {
      const consolidated = await consolidateOverflowPlan(parsed, instructions.trim(), client, config, verifyOnly);
      if (consolidated) parsed = consolidated;
    }

    activePlan = parsed.plan;
    let planErrors = parsed.degraded
      ? [`Planner did not return a valid structured plan (${parsed.degradedReason ?? "unreadable"})`]
      : validatePlan(activePlan, verifyOnly);
    // Soft findings about verification bullets (vague, or quoting UI text with
    // no source). They ride along on the one corrective pass the plan may get
    // anyway, and never fail a plan on their own: if still present afterwards,
    // the bullet is kept and tagged instead (see applyVerificationQuality).
    const verificationLintContext = {
      knownText: `${JSON.stringify(readNavMap(repoRoot))}
${instructions}
${discoveryOutput ?? ""}`,
    };
    const lintVerification = (): VerificationIssue[] =>
      parsed.degraded ? [] : lintPlanVerification(parsed.plan, verificationLintContext);
    let verificationIssues = lintVerification();
    const targetExists = (rel: string) => fs.existsSync(path.join(repoRoot, rel));
    // Kept so a corrective pass that comes back unparseable can fall back to this
    // plan when the ONLY reason for retrying was soft verification wording.
    const firstPassParsed = parsed;
    const firstPassWasHardValid = planErrors.length === 0;
    planErrors = [
      ...planErrors,
      ...verificationIssues.map((i) => i.message),
      ...(parsed.degraded ? [] : lintAssumptions(parsed.plan.assumptions)),
      ...(parsed.degraded ? [] : lintTargetFiles(parsed.plan, targetExists)),
    ];
    // One more planner pass with extra instructions appended. Every pass gets a
    // fresh read window (and what earlier passes already read, so nothing is
    // paid for twice).
    const runPlannerPass = async (extra: string, reason: string, retryOfId?: string): Promise<string> => {
      const inspected = await buildAlreadyInspectedSection(
        agentTools,
        agentTools.plannerInspectedThisPass(),
        agentTools.plannerInspectedRangesThisPass()
      );
      const planTargets = mergeUnique(extractDiscoveryTargetFiles(discoveryOutput), userFiles);
      agentTools.beginPlannerInspection(planTargets, plannerReadBudget(planTargets.length));
      plannerAttempt++;
      return runToolAgent({
        prompt: buildUserContent(`${plannerPrompt}\n\n${extra}\n\n${inspected}`, attachments) as any,
        repo,
        repoRoot,
        client,
        config,
        agentTools,
        models: config.models.planner,
        agentName: "PLANNER",
        readStage: "PLANNER",
        onConversationStart: startPlannerConversation,
        tools: PLANNER_TOOLS_SCHEMA,
        retryOf: retryOfId ?? lastWorkerId,
        attempt: plannerAttempt,
        reason,
        verifyOnly,
      });
    };
    // A rewrite that comes back as prose or broken JSON gets one more chance
    // with its own words handed back and a plain instruction to reformat.
    const reaskJsonOnly = (previous: string): Promise<string> =>
      runPlannerPass(
        `Your previous reply could not be read as the required plan. Here it is:\n\n${String(previous).slice(0, 8000)}\n\n` +
          `Reply with ONLY the single JSON plan object described in your instructions. No text before or after it, no ` +
          `commentary, no tool calls. Keep the plan's content; only fix its form.`,
        "Previous reply was not a parseable plan"
      );
    // An unreadable plan is usually a good plan in the wrong form: prose around it, or JSON cut off before its end. Asking for the same plan
    // again as JSON only is one cheap call; the corrective pass below is a full re-plan with tools, many calls. So the cheap one comes first,
    // and what the Planner actually returned is kept in .agent/planner-raw.txt, so a failure can be looked at and not guessed at.
    if (parsed.degraded) {
      const said = String(planOutput).replace(/\s+/g, " ");
      console.warn(
        `[PLANNER] ⚠️ The reply was not a readable plan: ${parsed.degradedReason ?? "unreadable"}. It was ${said.length} characters and began "${said.slice(0, 160)}${said.length > 160 ? "…" : ""}". ` +
          `Asking once for the same plan as JSON only.`
      );
      try {
        fs.mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, ".agent", "planner-raw.txt"), `${new Date().toISOString()}\nwhy: ${parsed.degradedReason ?? "unreadable"}\n\n${planOutput}`);
      } catch {
        // a note for the person; never a reason to fail
      }
      planOutput = await reaskJsonOnly(planOutput);
      parsed = parsePlan(planOutput, instructions.trim());
      if (!parsed.degraded) {
        console.log(`[PLANNER] ✓ That one was readable.`);
        activePlan = parsed.plan;
        verificationIssues = lintVerification();
        planErrors = [
          ...validatePlan(activePlan, verifyOnly),
          ...verificationIssues.map((i) => i.message),
          ...lintAssumptions(parsed.plan.assumptions),
          ...lintTargetFiles(parsed.plan, targetExists),
        ];
      } else {
        planErrors = [`Planner did not return a valid structured plan (${parsed.degradedReason ?? "unreadable"})`];
      }
    }
    if (planErrors.length > 0) {
      // Says WHY, which it never did: "lacks surgical scope" with no reason is something nobody can act on or learn from.
      const shown = planErrors.slice(0, 3).map((e) => e.replace(/\s+/g, " ").slice(0, 170));
      console.warn(`[PLANNER] ⚠️ The first plan was not specific enough, so the Planner is asked once more. Why: ${shown.join(" | ")}${planErrors.length > 3 ? ` (and ${planErrors.length - 3} more)` : ""}`);
      // Capture what the first pass actually read BEFORE resetting the
      // window below — see buildAlreadyInspectedSection's own comment for why
      // handing that content straight to the retry avoids re-paying for the
      // exact same read_file round trips against an unchanged repo.
      const alreadyInspected = await buildAlreadyInspectedSection(
        agentTools,
        agentTools.plannerInspectedThisPass(),
        agentTools.plannerInspectedRangesThisPass()
      );
      // A fresh inspection window for this pass — the corrective rewrite may
      // legitimately want to check different files than the first attempt did,
      // and re-opening one already seen this run is free (see
      // assertPlannerFileAllowed), so resetting here costs nothing.
      {
      const planTargets = mergeUnique(extractDiscoveryTargetFiles(discoveryOutput), userFiles);
      agentTools.beginPlannerInspection(planTargets, plannerReadBudget(planTargets.length));
    }
      plannerAttempt++;
      planOutput = await runToolAgent({
        prompt: buildUserContent(
          `${plannerPrompt}\n\nYour first plan was rejected because:\n${planErrors.map((e) => `- ${e}`).join("\n")}\n\n` +
            alreadyInspected +
            `Rewrite the plan. Every implementation phase must name exact existing or new file paths, exact symbols or file purpose, concrete edits, and phase-specific verification. Do not return a vague fallback.`,
          attachments
        ) as any,
        repo,
        repoRoot,
        client,
        config,
        agentTools,
        models: config.models.planner,
        agentName: "PLANNER",
        readStage: "PLANNER",
        onConversationStart: startPlannerConversation,
        tools: PLANNER_TOOLS_SCHEMA,
        retryOf: firstPlannerWorkerId,
        attempt: plannerAttempt,
        reason: "Plan lacks surgical scope",
        verifyOnly,
      });
      parsed = parsePlan(planOutput, instructions.trim());
      if (parsed.degraded && !firstPassWasHardValid) {
        console.warn(`[PLANNER] ⚠️ The rewrite was not a readable plan — asking once more for the JSON only.`);
        planOutput = await reaskJsonOnly(planOutput);
        parsed = parsePlan(planOutput, instructions.trim());
      }
      if (parsed.degraded && firstPassWasHardValid) {
        // The first plan was structurally fine; only its verification wording
        // was soft-flagged. A retry that returns junk must not throw that plan
        // away — keep it and mark the flagged bullets instead.
        console.warn(
          `[PLANNER] ⚠️ Corrective pass returned no usable plan (${String(planOutput).slice(0, 160).replace(/\s+/g, " ")}…); ` +
            `keeping the first plan, whose only issues were verification wording.`
        );
        parsed = firstPassParsed;
        verificationIssues = lintVerification();
        activePlan = parsed.plan;
        planErrors = [];
      } else {
        activePlan = parsed.plan;
        planErrors = parsed.degraded
          ? [`Corrective Planner pass did not return a valid structured plan (${parsed.degradedReason ?? "unreadable"})`]
          : validatePlan(activePlan, verifyOnly);
        // Second and last look: hard errors still fail as before, but a bullet
        // that is STILL vague or unsourced is accepted with a tag, not retried.
        verificationIssues = lintVerification();
      }
      if (planErrors.length > 0) {
        throw new TaskFailedError(
          `[PLANNER] Unable to produce an executable surgical plan: ${planErrors.join("; ")}`,
          "Narrow the request or specify the target feature area and try again."
        );
      }
      // Whatever is still vague or unsourced after the one retry is kept but
      // tagged, so QA and the report can say so instead of loops burning tokens.
      if (verificationIssues.length > 0) {
        applyVerificationQuality(activePlan, verificationIssues);
        console.warn(
          `[PLANNER] ⚠️ ${verificationIssues.length} verification bullet(s) stayed vague or quote unsourced UI text after the corrective pass; kept, marked weak/label_unverified.`
        );
      }
    }
    if (parsed.degraded) {
      console.warn(`[PLANNER] ⚠️ Structured plan unavailable; running the whole task as a single phase.`);
      console.warn(
        `[PLANNER] ⚠️ Clarifying questions and branch-isolation suggestions are also skipped this time — ` +
          `both depend on the same structured plan. If you wanted a specific branch, say /branch <name> now ` +
          `(Esc to stop first if this has already started implementing).`
      );
    } else {
      // No Planner ran for a diagnosed fix: the plan was built from the diagnosis, and the line must not say otherwise.
      console.log(direct ? `[FIX] The fix is ${activePlan.phases.length} phase(s), built from the diagnosis.` : `[PLANNER] Produced ${activePlan.phases.length} phase(s).`);
      for (const m of parsed.redTestMerges ?? []) console.log(describeRedTestMerge(m));
      if (parsed.truncatedFromPhaseCount) {
        console.warn(
          `[PLANNER] ⚠️ The model actually proposed ${parsed.truncatedFromPhaseCount} phases — capped at 12; ` +
            `the rest were silently dropped. Consider narrowing the request into smaller tasks.`
        );
      }
    }

    // The harness does not proceed on a guess. Every assumption the Planner wrote
    // is put to the user as a question (questionsToAsk), and that overrides --yes
    // whenever someone can answer; only an empty room falls through to the visible
    // "proceeding under assumptions" record further down. Up to two rounds: after
    // a re-plan, anything it STILL assumes is asked once more (a plain "yes" to an
    // assumed point is remembered and not asked again). After the second re-plan
    // the plan is final, so a model that keeps finding new ambiguity cannot turn
    // this into a back-and-forth.
    // That is the "all" mode. By default (planning.questions: autonomous) nothing waits for a person: each open point is
    // decided from the request and the code, recorded in the plan, and only what is hard to undo is flagged for review.
    // Questions belong at the start of a completely new build (and in a roadmap's own questionnaire). Any other task is worked on what the worker knows: see questionScope.ts.
    const questionMode: QuestionMode = taskQuestionMode(config.planning.questions, { newProject: isNewProject(repoRoot), inRoadmapUnit: Boolean(activeUnitId) });
    const MAX_CLARIFY_ROUNDS = questionMode === "all" ? 2 : 1;
    const alreadyConfirmed = new Set<string>();
    const autoDecisions: QuestionDecision[] = [];
    for (let round = 0; round < MAX_CLARIFY_ROUNDS && !parsed.degraded; round++) {
      // A step that rests on a file that is not there is a guess about the repo; ask about it.
      for (const a of missingTargetAssumptions(activePlan, targetExists)) {
        if (!activePlan.assumptions.includes(a)) activePlan.assumptions.push(a);
      }
      // No "follow the brief" option: a question is only put to the person when the brief, the code and the request did not
      // answer it, so there would be nothing to follow. (A question the documents do answer is settled below, not asked.)
      const askListAll = questionsToAsk(activePlan, { hasSpec: false, limit: questionMode === "all" ? 5 : Infinity }).filter(
        (q) => !alreadyConfirmed.has(q.question)
      );
      const mustAsk = activePlan.vagueness === "high" || activePlan.assumptions.length > 0;
      const someoneHere = isInteractive() || !!remote?.connected;
      if (questionMode === "all") {
        if (!(askListAll.length > 0 && (!args.yes || mustAsk) && someoneHere)) break;
      } else if (askListAll.length === 0) {
        break;
      }

      // A question about what is in the code is not the user's to answer: they
      // cannot know it. Settle those from the files first (an answer counts only
      // if it quotes a line that is really there), and ask only what is left,
      // which is about what they want.
      const verified = await verifyQuestionsFromCode({
        questions: askListAll.map((q) => q.question),
        planFiles: activePlan.phases.flatMap((ph: any) => (Array.isArray(ph.files) ? ph.files : [])),
        discoveryFiles: mergeUnique(extractDiscoveryTargetFiles(discoveryOutput), userFiles),
        repoRoot,
        complete: (messages) =>
          runLabeledCompletion({
            client,
            models: config.models.discovery ?? config.models.editor ?? config.models.planner,
            messages: messages as any,
            agentName: "PLANNER",
            jsonMode: true,
            reason: "Checking the plan's questions against the code before asking you",
          }),
      });
      const settled = new Set<number>();
      const answers: string[] = [];
      for (const v of verified) {
        settled.add(v.index);
        const q = askListAll[v.index];
        if (v.confirms && q.question.startsWith("The plan assumes:")) {
          // The code shows the assumption is true: no re-plan needed, and not asked again.
          alreadyConfirmed.add(q.question);
        } else {
          answers.push(`${q.question}\n${v.answer} (checked in the code: ${v.file}: "${v.quote}")`);
        }
      }
      if (verified.length > 0) {
        console.log(
          `\n🔍 [PLANNER] Checked ${askListAll.length} question(s) against the code: answered ${verified.length} itself` +
            (questionMode === "all" && askListAll.length - verified.length > 0 ? `, ${askListAll.length - verified.length} are yours to answer.` : ".")
        );
        for (const v of verified) console.log(`   • ${askListAll[v.index].question.split("\n")[0].slice(0, 110)} → ${v.answer}`);
      }
      let askList = askListAll.filter((_, i) => !settled.has(i));

      // Decide what is not worth a person's time. With "essential", the few hard-to-undo points are still asked (when
      // someone is here); in the default mode nothing is, and those points are flagged in the plan instead.
      if (questionMode !== "all") {
        const toAsk: typeof askList = [];
        for (const cq of askList) {
          // The fourth case, a visible change the specs do not settle, is what the Planner marks "high" vagueness.
          const essential = looksEssential(cq) || (activePlan.vagueness === "high" && !cq.question.startsWith("The plan assumes:"));
          if (questionMode === "essential" && essential && someoneHere && !args.yes) {
            toAsk.push(cq);
            continue;
          }
          // Reaching here means the code check found nothing in the files that settles it.
          const d = { ...decideWithoutAsking(cq, essential), grounded: false };
          autoDecisions.push(d);
          if (d.needsReplan) answers.push(`${cq.question}
The user wants you to decide, not ask: ${d.choice}`);
        }
        const decidedNow = askList.length - toAsk.length;
        if (decidedNow > 0 || toAsk.length > 0) {
          console.log(
            `🧭 [PLANNER] ${decidedNow} open point(s) decided from the request and the code, ` +
              (toAsk.length > 0 ? `${toAsk.length} need${toAsk.length === 1 ? "s" : ""} you (they touch something hard to undo).` : `none need you.`)
          );
        }
        askList = toAsk;
      }

      if (askList.length > 0) {
        console.log(
          `\n❓ [PLANNER] ${askList.length} question(s) before committing to a plan${round > 0 ? " (the re-plan still assumed these)" : ""}:`
        );
        if (mustAsk && args.yes) {
          console.log(`   ⚠️ Asking despite --yes — the plan rests on assumptions or a high-ambiguity request, and guessing could build the wrong thing.`);
        }
        if (remote?.connected) console.log(`   (also asking your phone — answer on either)`);
      }

      for (const [i, cq] of askList.entries()) {
        const pending = {
          id: `plan_q${round}_${i}_${runId}`,
          kind: "blocking" as const,
          prompt: cq.question,
          choices: cq.options.length > 0 ? cq.options : undefined,
          allowCustom: true,
          // When nobody answers in time: the planner's own default, the one an unasked point is decided with.
          fallback: defaultAnswerFor(cq),
          askedAt: new Date().toISOString(),
        };
        const rawAnswer =
          cq.options.length > 0 ? await askChoice(pending) : await askAnywhere(pending, `  ${cq.question}\n  > `);
        const answer = rawAnswer.trim();
        // A plain "yes, that's right" to an assumed point changes nothing, so it
        // doesn't buy a re-plan (and is not asked again); anything else (a
        // correction, or any answer to a real clarifying question) does.
        if (answer === ASSUMPTION_CONFIRM_OPTION) alreadyConfirmed.add(cq.question);
        else if (answer) answers.push(`${cq.question}\n${answer}`);
      }
      if (answers.length === 0) break;

      console.log(`[PLANNER] Re-planning with your answers…`);
      const answersBlock =
        `Your questions were answered (by the user, or checked against the code):\n${answers.join("\n\n")}\n\n` +
        `Produce the final plan now. Follow the answers exactly and do not carry forward any assumption they ` +
        `corrected. Do not ask questions; if something still rests on a guess, list it in "assumptions".`;
      planOutput = await runPlannerPass(answersBlock, "Re-planning with the user's clarifying-question answers");
      parsed = parsePlan(planOutput, instructions.trim());
      if (parsed.degraded) {
        console.warn(`[PLANNER] ⚠️ The re-plan was not a readable plan — asking once more for the JSON only.`);
        planOutput = await reaskJsonOnly(planOutput);
        parsed = parsePlan(planOutput, instructions.trim());
      }

      // One consolidation pass if the re-plan exceeds the phase ceiling.
      if (parsed.allPhases.length > MAX_PLAN_PHASES) {
        const consolidated = await consolidateOverflowPlan(parsed, instructions.trim(), client, config, verifyOnly);
        if (consolidated) parsed = consolidated;
      }

      // The re-plan gets the same checks the first plan did. Before this, a
      // re-plan that was unreadable silently became a one-phase fallback, and
      // one with structural problems or vague bullets went straight through.
      let replanErrors = parsed.degraded
        ? ["The re-plan did not return a valid structured plan"]
        : validatePlan(parsed.plan, verifyOnly);
      if (replanErrors.length > 0) {
        console.warn(`[PLANNER] ⚠️ The re-plan was rejected (${replanErrors.join("; ")}); requesting one correction.`);
        planOutput = await runPlannerPass(
          `${answersBlock}\n\nYour re-plan was rejected because:\n${replanErrors.map((e) => `- ${e}`).join("\n")}\n\n` +
            `Rewrite it so every implementation phase names exact file paths, concrete edits and phase-specific verification.`,
          "Re-plan lacks surgical scope"
        );
        parsed = parsePlan(planOutput, instructions.trim());
        if (parsed.degraded) {
          planOutput = await reaskJsonOnly(planOutput);
          parsed = parsePlan(planOutput, instructions.trim());
        }
        replanErrors = parsed.degraded
          ? ["The corrected re-plan did not return a valid structured plan"]
          : validatePlan(parsed.plan, verifyOnly);
        if (replanErrors.length > 0) {
          throw new TaskFailedError(
            `[PLANNER] Unable to produce an executable plan from your answers: ${replanErrors.join("; ")}`,
            "Rephrase the request or answer more specifically and try again."
          );
        }
      }
      activePlan = parsed.plan;
      if (questionMode !== "all") activePlan.clarifyingQuestions = [];
      const replanVerification = lintPlanVerification(activePlan, verificationLintContext);
      if (replanVerification.length > 0) {
        applyVerificationQuality(activePlan, replanVerification);
        console.warn(
          `[PLANNER] ⚠️ ${replanVerification.length} verification bullet(s) in the re-plan are vague or quote unsourced UI text; kept, marked weak/label_unverified.`
        );
      }
      console.log(`[PLANNER] Produced ${activePlan.phases.length} phase(s) after clarification.`);
      for (const m of parsed.redTestMerges ?? []) console.log(describeRedTestMerge(m));
      if (parsed.truncatedFromPhaseCount) {
        console.warn(
          `[PLANNER] ⚠️ The model actually proposed ${parsed.truncatedFromPhaseCount} phases — capped at 12; ` +
            `the rest were silently dropped. Consider narrowing the request into smaller tasks.`
        );
      }
    }

    // Planning is over: the one Planner card closes with the stage's cumulative tokens and cost.
    closePlanning("completed");

    // Whatever was decided without asking goes into the plan, so it is listed with the other assumptions and can be
    // corrected in one go. The Planner's questions are settled either way and are not shown as unanswered.
    if (questionMode !== "all" && autoDecisions.length > 0 && !parsed.degraded) {
      activePlan.clarifyingQuestions = [];
      const lines = autoDecisions.map(describeDecision);
      for (const l of lines) if (!activePlan.assumptions.includes(l)) activePlan.assumptions.push(l);
      const flagged = autoDecisions.filter((d) => d.essential).length;
      console.log(
        `
🧭 [PLANNER] Decided ${autoDecisions.length} open point(s) from the request and the code instead of asking` +
          (flagged > 0 ? ` (${flagged} flagged ⚠️ for your review: they touch something hard to undo).` : ".")
      );
    }

    // The planner's predicted libraries/toolchain are checked against the real
    // registries and this machine, and the generated block of YIMPIM.md is
    // refreshed (the user's own notes in that file are never touched). Report
    // only: nothing is installed here, and a failure never stops the run.
    if (!parsed.degraded) {
      let stack: string | undefined;
      try {
        stack = describeProfile(await detectProject(repoRoot));
      } catch {
        /* the profile is a convenience */
      }
      const ctx = await prepareSetupContext({
        repoRoot,
        dependencies: activePlan.dependencies ?? [],
        toolchain: activePlan.toolchain ?? [],
        stack,
        ranSuccessfully: new CommandApprovals()
          .listSucceeded(repoRoot, 20)
          .map((e) => describeCommand(e.argv, e.cwdRel)),
        fetchFn: (url, init) => fetch(url, init),
      });
      if (ctx.reportText) console.log(`\n[SETUP CHECK]\n${ctx.reportText}\n`);
      if (ctx.keptEdits) {
        console.log(`[SETUP CHECK] Your edits to the generated part of ${CONTEXT_FILE} were kept under "Your notes".`);
      } else if (ctx.fileWritten && ctx.changes.length > 0) {
        console.log(`[SETUP CHECK] Updated ${CONTEXT_FILE}:\n${ctx.changes.slice(0, 12).map((c) => `  ${c}`).join("\n")}`);
      }
    }

    fs.writeFileSync(progressPath, renderProgress(activePlan, {}, parsed.degraded ? parsed.raw : undefined), "utf-8");
    saveResumeState(repoRoot, {
      instructions: instructions.trim(),
      planOutput: planOutput.trim(),
      plan: activePlan,
      completedPhaseIds: [],
      timestamp: new Date().toISOString(),
    });

    // This plan's own deferred chunks (see Plan.followUpTasks): a fresh
    // request's followUpTasks REPLACE whatever backlog happened to be saved
    // (a leftover from an unrelated earlier ask has no business resurfacing
    // under this one), while draining an existing backlog APPENDS instead,
    // since replacing here would silently drop whatever of it this very
    // instruction hadn't gotten to yet.
    // A request that lists numbered jobs must not shrink to the first one: any job the plan does not cover is queued, whatever
    // the Planner wrote in its assumptions.
    // Not for a roadmap unit: its prompt carries the WHOLE goal (every job) for context, so every other job would read as "dropped from
    // this plan" and be queued again as a duplicate unit, and the unit's own prompt as one more. A unit is one job by definition.
    try {
      const dropped = activeUnitId ? [] : unplannedJobs(instructions, activePlan);
      if (dropped.length > 0) {
        activePlan.followUpTasks = [...(activePlan.followUpTasks ?? []), ...dropped];
        console.log(`[PLANNER] The request listed several jobs and this plan covers only part of them. ${dropped.length} job(s) were queued after it so they are not lost.`);
      }
    } catch {
      // a safety net; it never blocks a plan
    }
    const freshFollowUps = activePlan.followUpTasks ?? [];
    if (freshFollowUps.length > 0) {
      // They go on the roadmap, where they are remembered, ordered and resumable,
      // instead of into a queue that answering "no" used to delete.
      const absorbed = absorbOverflow(repoRoot, {
        goal: instructions.trim().split("\n")[0].slice(0, 300),
        planGoal: activePlan.goal,
        followUps: freshFollowUps,
        currentUnitId: activeUnitId,
      });
      if (absorbed.currentUnitId) activeUnitId = absorbed.currentUnitId;
      console.log(`[ROADMAP] This is bigger than one task: ${absorbed.added} more unit(s) are on the roadmap for after it. See them with /roadmap.`);
      saveTaskQueue(repoRoot, fromQueue ? loadTaskQueue(repoRoot) : []);
    } else {
      saveTaskQueue(repoRoot, fromQueue ? [...loadTaskQueue(repoRoot), ...freshFollowUps] : freshFollowUps);
    }
    // A brand-new backlog needs its own fresh confirmation — see
    // autoContinueConfirmed's own comment for why this must not silently
    // inherit a "yes" given to a previous, unrelated backlog.
    if (!fromQueue) autoContinueConfirmed = false;
  }

  if (!activePlan) {
    console.error("[FATAL ERROR] No plan is available to execute.");
    process.exit(1);
  }

  const plan = activePlan;
  const statuses: Record<string, "pending" | "running" | "passed" | "failed"> = {};
  // What each phase that passed in this run was verified by, for the end-of-task summary.
  const phaseConfidences: PhaseConfidence[] = [];
  const done = new Set(completedPhaseIds);
  for (const id of done) statuses[id] = "passed";

  console.log(`\n==================================================`);
  console.log(`📋 [PLAN] ${plan.goal}`);
  console.log(`==================================================`);
  plan.phases.forEach((ph, i) => {
    console.log(`  ${i + 1}. ${ph.name}${done.has(ph.id) ? "   ✓ already completed" : ""}`);
    console.log(`     ${ph.goal}`);
  });
  if (plan.assumptions.length > 0) {
    console.log(`\n  Assumptions:`);
    plan.assumptions.forEach((a) => console.log(`   - ${a}`));
  }
  // Reaching here with questions still attached means nobody was available to
  // answer them (non-interactive, no phone) — surfaced so they are visible
  // rather than silently dropped, same treatment as assumptions above. A
  // "high" vagueness plan still proceeds here (there is genuinely no one to
  // force an answer out of), but gets louder, distinct wording — this is
  // the one case where the Planner itself flagged a real risk of building
  // the wrong thing, not just a routine judgment call.
  if (plan.clarifyingQuestions.length > 0) {
    console.log(
      plan.vagueness === "high"
        ? `\n  ⚠️ UNANSWERED, HIGH AMBIGUITY — nobody was available to clarify; proceeding under the assumptions anyway:`
        : `\n  ❓ Unanswered — the plan above proceeds under the assumptions instead:`
    );
    plan.clarifyingQuestions.forEach((cq) => console.log(`   - ${cq.question}`));
  }
  console.log(`==================================================\n`);

  // Planner-suggested branch isolation. This is the true last checkpoint —
  // Discovery and Planner (including its one clarifying-question round) are
  // both finished, and nothing below this point runs before the Editor
  // starts touching files. Skipped when the user already looks to have
  // handled isolation themselves (already off the default branch), so a
  // manual /branch or an explicit "on a new branch called X" instruction
  // the planner already saw never gets double-prompted. Also skipped on
  // --resume: that plan (and this same decision point) already ran once in
  // the original invocation, so asking again mid-resume would just be
  // re-litigating something the run already settled.
  if (plan.suggestedBranch && !isResume) {
    const current = await currentBranch(repo);
    // The repo's actual default branch when known (covers "release",
    // "stable", or anything else a team happens to call it) — the hardcoded
    // list is only a fallback for a repo with no remote to ask, where it's
    // also what yimpim's own auto-`git init` would have created.
    const defaultBranch = await detectDefaultBranch(repo);
    const onDefaultBranch = defaultBranch
      ? current === defaultBranch
      : ["main", "master", "trunk", "develop"].includes(current);
    const proposed = sanitizeBranchName(plan.suggestedBranch);

    if (onDefaultBranch && proposed && proposed !== current) {
      // Unlike the push decision, this is purely local and fully reversible
      // (worst case: you end up on a branch you didn't strictly need), so an
      // unattended run defaults to taking the safer option rather than
      // skipping it — the opposite default from push, which has real
      // external/shared consequences and so defaults to staying put.
      const canAsk = isInteractive() || Boolean(remote?.connected);

      if (!canAsk) {
        console.log(
          `[GIT] Planner flagged this as a substantial change — auto-isolating on branch "${proposed}" ` +
            `(nobody to confirm with right now). "${current}" stays untouched; switch back anytime.`
        );
        await handleBranchSwitch(repo, repoRoot, client, config, proposed);
      } else {
        const answer = await askAnywhere(
          {
            id: `planbranch_${runId}`,
            kind: "blocking",
            prompt:
              `This looks like a substantial change — the planner suggests keeping it separate on its ` +
              `own branch: "${proposed}" (currently on "${current}"). Switch to it?`,
            fallback: "y",
            askedAt: new Date().toISOString(),
          },
          `Switch to "${proposed}"? ${YES_NO_ENTER_YES}: `
        );
        if (parseYesNo(answer, "yes")) {
          await handleBranchSwitch(repo, repoRoot, client, config, proposed);
        } else {
          console.log(`[GIT] Staying on "${current}".`);
        }
      }
    }
  }

  const progressFile = path.join(repoRoot, "PROGRESS.md");
  const writeProgress = (notes?: string) =>
    fs.writeFileSync(progressFile, renderProgress(plan, statuses, notes, agentTools.getManualSteps()), "utf-8");
  writeProgress();

  events.emit({
    type: "plan.ready",
    runId,
    goal: plan.goal,
    degraded: plan.phases.length === 1 && plan.phases[0].id === "phase-1" && plan.phases[0].changes.length === 0,
    phases: plan.phases.map((p) => ({ id: p.id, name: p.name, goal: p.goal, executor: p.executor })),
  });

  const finish = (ok: boolean) => {
    setStatusLine(undefined);
    runningAgentLabels.length = 0;
    // The task is over: the time and tokens counted for its personas end with it.
    statusBase = undefined;
    resetStep();
    removeScratch(agentTools);
    // Scoped to just this task, not this whole (possibly multi-task, thanks
    // to looping back to the prompt) process — see currentTaskUsageStart above.
    const taskUsage = events.usageDelta(currentTaskUsageStart);
    events.emit({
      type: "run.end",
      ok,
      phasesCompleted: completedPhaseIds.length,
      phasesTotal: plan.phases.length,
      durationMs: events.elapsedMs(),
      usage: taskUsage,
    });
    // The per-phase pushes above only ever fire from inside the phase loop —
    // this is the one place that runs once the whole task is actually over,
    // so it's the only spot that can tell the phone the true final state and
    // token count rather than whatever the last phase happened to leave behind.
    remote?.updateStatus({
      state: ok ? "done" : "failed",
      phases: plan.phases.map((p) => ({ id: p.id, name: p.name, status: statuses[p.id] ?? "pending" })),
      ...buildUsageStatusPatch(),
    });
    const usage = events.renderUsage(taskUsage, "Token usage for this task");
    if (usage) console.log(usage);

    // Printed regardless of ok/failure — a phase that completed before a
    // later failure may still have flagged something the user needs to do.
    const manualSteps = agentTools.getManualSteps();
    if (manualSteps.length > 0) {
      console.log(`\n📋 Before this is actually live, you need to:`);
      manualSteps.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.step}${m.phase ? `  (from: ${m.phase})` : ""}`);
        console.log(`     why: ${m.reason}`);
      });
      console.log("");
      // Own event, not just the console.log above — see advisor.answer's
      // identical reasoning: an untagged `log` block can't be told apart
      // from everything else streamed around it.
      events.emit({ type: "manual.steps", steps: manualSteps });
    }
    // endTask (task.end + the segment flip it causes) is deliberately NOT
    // called here — the caller still has more of THIS task's own closing
    // narration to print (see its own call site).
  };

  // imageAttachments was already computed above, before Discovery ran.

  // config.models.editor is the user's NORMAL, cost-optimized chain — it is
  // never mutated. When this task has an image, a genuinely SEPARATE,
  // explicitly-configured models.editorVision chain is used for the WHOLE
  // Editor/Repair phase instead (every round of that phase reuses it, so
  // this is a deliberate opt-in swap, not a silent cost surprise). Recomputed
  // fresh every task iteration, never carried over from a prior one.
  let usingEditorVision = false;
  if (imageAttachments.length > 0 && config.models.editorVision && config.models.editorVision.length > 0) {
    usingEditorVision = true;
  } else if (imageAttachments.length > 0) {
    console.warn(
      `\n[EDITOR] ⚠️ This task has an attached image, but models.editorVision is not configured — the ` +
        `Editor will not be able to see it directly. The image can still inform the Planner's written ` +
        `instructions, but for precise visual fidelity, run /model to set an Editor (Vision) chain.\n`
    );
  }
  const effectiveEditorModels = usingEditorVision ? config.models.editorVision! : config.models.editor;
  const editorSupportsVision = usingEditorVision || (await modelSupportsVision(config.models.editor[0]));
  // Refreshed every task (see setReferenceImages's own comment) so QA's
  // visual audit can compare the built result directly against whatever
  // mockup THIS task attached, not just judge it against text.
  verifier.setReferenceImages(imageAttachments);

  // 3. Implement and verify each phase in order, committing after each pass.
  {
    for (const [index, planned] of plan.phases.entries()) {
      const label = `${index + 1}/${plan.phases.length}`;
      currentPhaseForEvents = planned;

      if (done.has(planned.id)) {
        console.log(`\n⏭️  [PHASE ${label}] ${planned.name} — already completed, skipping.`);
        continue;
      }

      // Safe boundary: a remote stop takes effect between phases, so completed
      // phases stay committed and nothing is left half-written.
      runControl.throwIfAborted();

      statuses[planned.id] = "running";
      // Reset here, not just declared once at the top — this is the one
      // place a NEW phase actually starts, so phaseTokensUsed/phaseCostUsd
      // from this point on reflect only this phase, not whatever the
      // previous one spent.
      closePhaseUsage();
      currentPhaseUsageStart = events.usageReport();
      currentPhaseUsageId = planned.id;
      currentPhaseStartedAt = Date.now();
      writeProgress();
      remote?.updateStatus({
        state: "running",
        goal: plan.goal,
        currentPhase: planned.name,
        phases: plan.phases.map((p) => ({ id: p.id, name: p.name, status: statuses[p.id] ?? "pending" })),
        ...buildUsageStatusPatch(),
      });
      events.emit({
        type: "phase.start",
        phaseId: planned.id,
        name: planned.name,
        goal: planned.goal,
        index,
        total: plan.phases.length,
        executor: planned.executor,
      });

      console.log(`\n##################################################`);
      console.log(`### PHASE ${label}: **${planned.name}**`);
      console.log(`##################################################`);

      const phase: TaskPhase = {
        id: planned.id,
        name: `${label} ${planned.name}`,
        instructions:
          phaseInstructions(plan, planned, index) +
          renderProgressNote(taskProgress) +
          (planned.executor === "EDITOR" ? renderTestGuidance(repoRoot, planned.files) : ""),
        allowedPaths: planned.files,
        files: planned.files,
        laterPhases: plan.phases.slice(index + 1).map((p) => ({ name: p.name, files: p.files })),
        verificationGoal: phaseVerificationGoal(plan, planned),
      };

      // The Planner assigns each phase its worker (planned.executor); the
      // route is read mechanically from it. QA phases skip the Editor pass
      // (the same path a whole-task "verify" intent takes), SETUP phases
      // install/restore and diagnose without an Editor or a QA verdict.
      lastPhaseRuns = 1;
      lastPhaseConfidence = undefined;
      const passed =
        planned.executor === "SETUP"
          ? await runSetupPhaseInPipeline(phase, planned, repoRoot, repo, client, config, agentTools, remote)
          : await runPhaseWithHealing(
              phase, repoRoot, repo, client, config, verifier, agentTools, memory, memoryFile,
              imageAttachments, editorSupportsVision, effectiveEditorModels, usingEditorVision, remote,
              verifyOnly || planned.executor === "QA"
            );

      if (!passed) {
        statuses[planned.id] = "failed";
        writeProgress(
          `Phase ${index + 1} ("${planned.name}") failed verification. Earlier phases remain committed. ` +
            `Re-run with --resume to retry from this phase.`
        );
        events.emit({
          type: "phase.end",
          phaseId: planned.id,
          name: planned.name,
          passed: false,
          attempts: lastPhaseRuns,
        });
        mergeManualSteps(memory, agentTools);
        saveCodebaseMemory(memoryFile, memory);
        throw new TaskFailedError(
          `Phase ${label} failed: ${planned.name}` +
            (completedPhaseIds.length > 0
              ? ` — ${completedPhaseIds.length} earlier phase(s) remain committed and are preserved.`
              : ""),
          `Retry from this phase:  yimpim --repo "${repoRoot}" --resume`
        );
      }

      statuses[planned.id] = "passed";
      completedPhaseIds.push(planned.id);
      writeProgress();
      // Without this, a phone only ever saw a phase's status update at the
      // START of the NEXT phase (the updateStatus call above) — so the LAST
      // phase's checkmark and the final token count never reached it at all:
      // nothing runs after the last phase to trigger that "next phase
      // starting" push. Every phase now updates immediately on its own
      // completion, not just implicitly via whichever phase happens to follow it.
      remote?.updateStatus({
        phases: plan.phases.map((p) => ({ id: p.id, name: p.name, status: statuses[p.id] ?? "pending" })),
        ...buildUsageStatusPatch(),
      });
      events.emit({
        type: "phase.end",
        phaseId: planned.id,
        name: planned.name,
        passed: true,
        confidence: lastPhaseConfidence,
        attempts: lastPhaseRuns,
      });
      phaseConfidences.push({ label, name: planned.name, confidence: lastPhaseConfidence });

      // Persist after every phase so a crash or Ctrl-C resumes in the right place.
      saveResumeState(repoRoot, {
        instructions: instructions.trim(),
        planOutput: planOutput.trim(),
        plan,
        completedPhaseIds,
        progress: taskProgress,
        timestamp: new Date().toISOString(),
      });

      const phaseTotals = events.usageDelta(currentPhaseUsageStart).totals;
      console.log(`\n✅ [PHASE ${label} COMPLETE] ${planned.name} — ${totalsLine(Date.now() - currentPhaseStartedAt, phaseTotals.total, phaseTotals.costKnown ? phaseTotals.cost : undefined)}`);
      const phaseRows = workerLedger.phaseRows(planned.id);
      if (phaseRows.length > 0) console.log(`   ${phaseWorkersLine(phaseRows)}`);
    }
  }

  mergeManualSteps(memory, agentTools);
  saveCodebaseMemory(memoryFile, memory);

  // The task passed, so what Discovery worked out held up: remember it.
  if (pendingFeatureRecord) {
    try {
      const saved = recordConfirmedFindings(repoRoot, pendingFeatureRecord.task, pendingFeatureRecord.output, config.memory.maxEntries);
      if (saved) console.log(`[MEMORY] 🧠 Remembered how "${saved.feature}" fits together (${saved.files} file(s)) for next time.`);
    } catch {
      // remembering is a bonus; it never fails a task that passed
    }
    pendingFeatureRecord = undefined;
  }
  // What Discovery recorded described the code BEFORE this task changed it, so
  // re-derive every file the task touched from the final code, last.
  try {
    logMapSync(
      syncRepoMap(repoRoot, {
        touched: [...taskTouchedFiles],
        viaTask: true,
        maxEntries: config.memory.maxEntries,
        addNew: `Added by: ${instructions.trim().split("\n")[0].slice(0, 80)}`,
      }),
      "Repo map matches the finished code:"
    );
  } catch {
    // best effort
  }

  console.log(`\n==================================================`);
  finish(true);
  console.log(`✅ [ALL PHASES SUCCEEDED] ${pipelineVerdict(phaseConfidences)}`);
  for (const line of confidenceSummary(phaseConfidences)) console.log(line);
  {
    const t = events.usageDelta(currentTaskUsageStart).totals;
    const rows = workerLedger.taskRows();
    if (rows.length > 0) {
      console.log(`\n📊 [TASK TOTAL] ${totalsLine(Date.now() - currentTaskStartedAt, t.total, t.costKnown ? t.cost : undefined)}`);
      console.log(breakdownLines(rows).join("\n"));
    }
  }
  console.log(`🧠 Repo map and live rules persisted for next run.`);
  console.log(`==================================================`);
  // A clean finish is the signal that whatever an earlier task's failure
  // note (lastFailure.ts) was warning about is no longer blocking things —
  // clear it so it stops being surfaced to future planning.
  clearLastFailure(repoRoot);
  // Only now, after every one of this task's own closing lines above has
  // been printed — see endTask's own comment for why task.end has to come last.
  await endTask("done", events.usageDelta(currentTaskUsageStart));

  await confirmStagedDeletions(agentTools, repoRoot, runId, remote);

  // A polish task that just passed: look at the same screens again and compare (uiPolish.ts). Any other task clears it.
  if (pendingPolish) {
    const p = pendingPolish;
    pendingPolish = undefined;
    if (instructions.trim() === p.task.trim()) {
      const renderer = await openRenderer();
      try {
        const { polishAfter } = await import("./uiPolish.js");
        const result = await polishAfter(p.last, p.chosen, p.left, {
          repoRoot,
          visionModels: config.models.designerVision ?? config.models.verifierVision ?? config.models.editorVision ?? config.models.verifier,
          call: (ms, messages, label, json) =>
            runLabeledCompletion({ client, models: ms, messages: messages as any, agentName: "DESIGNER", jsonMode: json, reason: `UI polish: ${label}` }),
          log: (line) => console.log(line),
          renderer,
        });
        console.log(`\n🎨 [POLISH] ${result.text}`);
      } catch (err: any) {
        console.error(`[POLISH] The before/after comparison did not complete: ${err.message}`);
      } finally {
        await renderer?.close();
      }
    }
  }

    if (loopsBackToPrompt) {
      // Consumed by this task already (or never populated) — starting the
      // next one with a leftover path from this one would be a silent bug.
      pendingAttachments.length = 0;

      // Multi-task backlog (see Plan.followUpTasks / taskQueue.ts): offer to
      // auto-run the rest of a large ask that got split across tasks, rather
      // than leaving the user to manually re-prompt for every remaining
      // chunk. Only offered after a CLEAN finish — this is reached only on
      // that path, never from the failure/abort catch below, since
      // auto-continuing into more work right after the current chunk failed
      // would compound the problem, not help.
      // A roadmap unit that just passed is recorded with what it produced, so the
      // units after it build on it and the roadmap knows what is done.
      if (activeUnitId) {
        try {
          let commit: string | undefined;
          try {
            commit = (await repo.git(["rev-parse", "HEAD"])).trim();
          } catch {
            // no commit to point at
          }
          // What the unit produced: the files in the commit it made, when that commit is new (not one an earlier unit already
          // recorded). Otherwise what this task touched. Logs, review notes and tool caches are left out either way.
          let files = [...taskTouchedFiles];
          const usedBefore = new Set((loadRoadmap(repoRoot)?.units ?? []).map((u) => u.done?.commit).filter(Boolean));
          if (commit && !usedBefore.has(commit.slice(0, 40))) {
            try {
              const names = (await repo.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit])).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
              if (names.length > 0) files = names;
            } catch {
              // keep what the task touched
            }
          }
          finishUnit(repoRoot, activeUnitId, { commit, files, summary: activePlan?.goal });
          const rm = loadRoadmap(repoRoot);
          if (rm) {
            const pr = roadmapProgress(rm);
            console.log(`\n🗺️ [ROADMAP] ${activeUnitId} done: ${pr.done}/${pr.total} (${pr.percent}%).`);
            // Phases only run the tests their change can reach. When the whole roadmap is done, the whole suite runs once, so
            // anything that selection could not see still comes to light.
            if (pr.total > 0 && pr.done === pr.total) {
              console.log("🧪 [TESTS] The roadmap is complete. Running the full test suite once…");
              const full = await runSuiteLogged(repoRoot, []);
              if (full.ok) console.log("🧪 [TESTS] Full suite: green.");
              else {
                const red = failingTestFiles(full.output);
                console.log(`🧪 [TESTS] Full suite: ${red.length} test file(s) red${red.length ? ": " + red.slice(0, 12).join(", ") + (red.length > 12 ? ", …" : "") : ""}. Run /tests heal to bring them back to green.`);
              }
            }
          }
        } catch {
          // the roadmap is a record; it never fails a task that passed
        }
        activeUnitId = undefined;
      }

      await settleTestFixes(instructions);

      const queued = loadTaskQueue(repoRoot);
      if (queued.length > 0) {
        const next = queued[0];
        if (autoContinueConfirmed || !config.interaction.confirmContinue) {
          // (Also when the user has not asked to be asked: interaction.confirmContinue is off by default, and they can stop at any time.)
          // Already said yes to this backlog — run the next one straight
          // through, no re-ask. See autoContinueConfirmed's own comment:
          // asking again here on every single clean finish (the original
          // bug) silently turned a one-time "yes, run all N" into "yes,
          // run just this one," over and over.
          console.log(`\n[YIMPIM] ▶ Auto-continuing (${queued.length} task(s) left) — next: "${next}"`);
          queuedInstructions = next;
          saveTaskQueue(repoRoot, queued.slice(1));
        } else if (queued.length === 1) {
          // "next" vs "all" is a meaningless distinction with exactly one
          // item left — plain yes/no, same as before.
          const answer = await askAnywhere(
            {
              id: `queue_${runId}_${Date.now()}`,
              kind: "blocking",
              prompt: `1 more queued task remains: "${next}". Continue?`,
              choices: ["yes", "no"],
              fallback: "no",
              askedAt: new Date().toISOString(),
            },
            `1 task queued — next: "${next}". Continue? ${YES_NO}: `
          );
          if (parseYesNo(answer, "none")) {
            queuedInstructions = next;
            saveTaskQueue(repoRoot, queued.slice(1));
          } else {
            saveTaskQueue(repoRoot, []);
          }
        } else {
          // Three-way choice: run just the next one and ask again next time
          // ("yes next"), run the whole remaining backlog without asking
          // again ("yes to all" — sets autoContinueConfirmed, same as a
          // plain "yes" used to mean before this choice existed), or stop
          // and leave it fully manual from here ("no"). A straight yes/no
          // forced a single answer to cover two genuinely different
          // intents — "let me review each one" and "just run them all" —
          // this gives each its own button instead of conflating them.
          const answer = await askAnywhere(
            {
              id: `queue_${runId}_${Date.now()}`,
              kind: "blocking",
              prompt: `${queued.length} more queued tasks remain (next: "${next}"). Continue?`,
              choices: ["yes next", "yes to all", "no"],
              fallback: "no",
              askedAt: new Date().toISOString(),
            },
            `${queued.length} more task(s) queued — next: "${next}". [yes next / yes to all / no] `
          );
          const choice = parseContinueAnswer(answer);
          if (choice !== "no") {
            autoContinueConfirmed = choice === "all";
            queuedInstructions = next;
            saveTaskQueue(repoRoot, queued.slice(1));
          } else {
            // Declining turns auto-continue off for this backlog, not just
            // this one offer — the user can still drive it manually (e.g.
            // "work on next screen"), same as before this feature existed.
            saveTaskQueue(repoRoot, []);
          }
        }
      }

      // The roadmap's next unit, offered the same way. Answering "no" leaves the
      // roadmap exactly as it is: "/roadmap run" picks it up whenever you like.
      if (queuedInstructions === undefined) await offerNextUnit();

      continue;
    }
    await remote?.stop("process exit");
    await activeRelay?.stop();
    return;

    } catch (err: any) {
      if (!(err instanceof AbortedError) && !(err instanceof TaskFailedError)) {
        if (taskRunning) {
          await endTask("failed", events.usageDelta(currentTaskUsageStart));
        }
        throw err;
      }
      setStatusLine(undefined);
      runningAgentLabels.length = 0;
      statusBase = undefined;
      resetStep();
      removeScratch(agentTools);

      // Both a Stop and a task not completing (phase exhausted its repair
      // budget, empty instructions, a bad attachment, ...) are expected
      // outcomes, not crashes — completed phases stay committed, the
      // in-flight phase is unwound by the normal scoped revert. This used to
      // be handled only by the top-level catch at the bottom of this file
      // (or, for these specific cases, a process.exit() called directly at
      // the failure site), which always ended the whole session, phone
      // connection included, even when there was a live prompt right here to
      // return to instead — so a paired phone or a "please fix the QA
      // issues" follow-up typed at the prompt had no session left to reach.
      if (err instanceof TaskFailedError) {
        console.error(`\n🛑 [ABORT] ${err.message}`);
        if (err.hint) console.error(`   ${err.hint}`);
        await settleTestFixes(instructions);
        // Ephemeral note for the NEXT fresh task's planning — see
        // lastFailure.ts's own comment. Only a genuine TaskFailedError
        // counts: a user-initiated Stop (the `else` branch below) is a
        // deliberate interruption, not evidence of a bug to flag later.
        saveLastFailure(repoRoot, {
          taskId: currentTaskId,
          reason: err.message,
          at: new Date().toISOString(),
        });
      } else {
        console.log(`\n🛑 Stopped — ${err.reason}`);
        console.log(
          `Completed phases remain committed. Resume with: ${loopsBackToPrompt ? "/continue" : "yimpim --resume"}`
        );
        // The stop is reported and over. Leaving the flag set made the idle prompt find it and announce a second stop that never came
        // (and always blame the phone), after every stop, whoever made it.
        runControl.reset();
      }
      if (activeUnitId) {
        // The unit is not lost: it stays on the roadmap, and "/roadmap run" tries it again.
        try {
          const failedUnit = activeUnitId;
          const failure = err instanceof TaskFailedError ? failUnit(repoRoot, failedUnit, err.message) : { parked: false };
          console.error(
            failure.parked
              ? `🗺️ [ROADMAP] ${failedUnit} failed ${MAX_UNIT_ATTEMPTS} times and is parked as blocked. Sort out why, then "/roadmap reopen ${failedUnit}".`
              : `🗺️ [ROADMAP] ${failedUnit} is still in progress. "/roadmap run" tries it again.`
          );
        } catch {
          // best effort
        }
        activeUnitId = undefined;
        autoContinueConfirmed = false;
        roadmapAutoContinue = false;
      }
      const taskUsage = events.usageDelta(currentTaskUsageStart);
      events.emit({
        type: "run.end",
        ok: false,
        phasesCompleted: completedPhaseIds.length,
        phasesTotal: activePlan?.phases.length ?? 0,
        durationMs: events.elapsedMs(),
        usage: taskUsage,
      });
      // Same reasoning as finish()'s own final push: without this, a phone
      // that watched a run get stopped or fail mid-phase was left showing
      // whatever phase happened to be running when it died, forever — this is
      // the one place that knows the run is actually over. `statuses` itself
      // isn't in scope here (block-scoped inside the try above it), but
      // completedPhaseIds is enough to mark what actually finished.
      //
      // A phase that genuinely exhausted its repair budget (TaskFailedError)
      // must be reported as "failed", not silently lumped in with phases
      // that were simply never reached — otherwise a client rendering this
      // snapshot (a paired phone, or the desktop's own bundled web UI) shows
      // the failed phase as merely "pending" forever, indistinguishable from
      // one that never started, even though `state` alone already says the
      // run is over. currentPhaseForEvents still points at whichever phase
      // was active when the error was thrown — it's only ever reassigned at
      // the top of the NEXT phase's own loop iteration, which this run never
      // reached. An abort (a Stop) instead reverts the in-flight phase's own
      // changes via the normal scoped revert, so "pending" (as if it had
      // never run) is the accurate status for that case, not "failed".
      const failedPhaseId = err instanceof TaskFailedError ? currentPhaseForEvents?.id : undefined;
      if (activePlan) {
        remote?.updateStatus({
          state: err instanceof AbortedError ? "aborted" : "failed",
          phases: activePlan.phases.map((p) => ({
            id: p.id,
            name: p.name,
            status: completedPhaseIds.includes(p.id) ? "passed" : p.id === failedPhaseId ? "failed" : "pending",
          })),
          ...buildUsageStatusPatch(),
        });
      }
      const usage = events.renderUsage(taskUsage, "Token usage for this task");
      if (usage) console.log(usage);

      // A phase completed before this one failed (or a Stop landed) may
      // still have flagged something the user needs to do by hand — the same
      // summary a clean run prints via finish(), which isn't reachable here
      // (it's a closure declared inside the try this catch sits beside).
      const manualSteps = agentTools.getManualSteps();
      if (manualSteps.length > 0) {
        console.log(`\n📋 Before this is actually live, you need to:`);
        manualSteps.forEach((m, i) => {
          console.log(`  ${i + 1}. ${m.step}${m.phase ? `  (from: ${m.phase})` : ""}`);
          console.log(`     why: ${m.reason}`);
        });
        console.log("");
        events.emit({ type: "manual.steps", steps: manualSteps });
      }

      // Unlike the updateStatus call above, this doesn't need activePlan —
      // the task ended either way, and PUSH_BROKER_SPEC.md's own contract
      // covers done/failed/aborted alike, once, not just the success path
      // finish()/endTask handle (finish() is in fact only ever called with
      // `true` in this file; every failure/abort outcome comes through here
      // instead). Pushed only now, after the usage summary and manual steps
      // above — see endTask's own comment for why task.end has to come last,
      // not right after updateStatus.
      await endTask(err instanceof AbortedError ? "aborted" : "failed", taskUsage);

      await confirmStagedDeletions(agentTools, repoRoot, runId, remote);

      if (loopsBackToPrompt) {
        pendingAttachments.length = 0;
        continue;
      }
      // No prompt to return to (one-shot --task/--task-file/--resume) — this
      // really is the end of the process, same exit code as before.
      await remote?.stop(err instanceof AbortedError ? "aborted" : "failed");
      await activeRelay?.stop();
      process.exit(err instanceof TaskFailedError ? 1 : 130);
    } finally {
      stopInputListener();
    }
  }
}

main().catch(async (err) => {
  // A remote stop is an expected outcome, not a crash. Completed phases stay
  // committed; the in-flight phase is unwound by the normal scoped revert.
  if (err instanceof AbortedError) {
    console.log(`\n🛑 Stopped — ${err.reason}`);
    console.log(`Completed phases remain committed. Resume with: yimpim --resume`);
    const usage = events.renderUsage();
    if (usage) console.log(usage);
    try { await activeRelay?.stop(); } catch {}
    process.exit(130);
  }
  console.error(`[FATAL] Unhandled execution error:`, err);
  try { await activeRelay?.stop(); } catch {}
  process.exit(1);
});
