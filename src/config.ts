import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { z } from "zod";
import { DEFAULT_BLOCKED_FILE_PATTERNS } from "./sensitivePaths.js";
import { DEFAULT_BLOCKED_DIRECTORIES, setBlockedDirectories } from "./projectPaths.js";

/**
 * Every section has defaults so the harness runs against an arbitrary repo with
 * no agent.config.yaml at all. Only the model chains are worth overriding for
 * most projects; everything else exists to be tightened, not to be required.
 */

const DEFAULT_MODELS = ["google/gemini-3.8-flash"];

export const ConfigSchema = z.object({
  models: z
    .object({
      discovery: z.array(z.string()).min(1).default(DEFAULT_MODELS),
      // Optional: the cheaper models for the first look of the "what already exists" check. Unset = the discovery models.
      existence: z.array(z.string()).min(1).optional(),
      planner: z.array(z.string()).min(1).default(DEFAULT_MODELS),
      editor: z.array(z.string()).min(1).default(DEFAULT_MODELS),
      verifier: z.array(z.string()).min(1).default(DEFAULT_MODELS),
      // Dedicated vision-capable chains, used ONLY for the specific calls
      // that actually carry an image — discoveryVision when Discovery's own
      // exploration attaches a user image, editorVision for the WHOLE Editor/
      // Repair phase whenever the task has one (every round of that phase
      // reuses whichever chain is picked, so this deliberately stays a
      // separate opt-in list rather than silently promoting an entry out of
      // the normal, cost-optimized chain). verifierVision covers the
      // screenshot-driven navigation/audit calls; plain "verifier" still
      // covers its text-only checks. Undefined (not configured) means: warn
      // and fall back to the normal chain rather than silently guessing.
      discoveryVision: z.array(z.string()).min(1).optional(),
      editorVision: z.array(z.string()).min(1).optional(),
      verifierVision: z.array(z.string()).min(1).optional(),
      // Repair fixes defects QA found after Editor's own diff — real work,
      // but a different difficulty profile than Editor's (diagnosing someone
      // else's failure from error text alone vs. executing an already-clear
      // plan), so it's worth letting it run a different, often stronger,
      // model while Editor itself stays cheap. Undefined (not configured)
      // means: reuse models.editor/editorVision exactly, so existing configs
      // behave identically to before this role existed.
      repair: z.array(z.string()).min(1).optional(),
      repairVision: z.array(z.string()).min(1).optional(),
      // The Designer (logos, icons, brand marks). Unlike the other roles this
      // is a SET to rotate through, not a fallback chain: different models
      // propose and draw different concepts, because one model alone settles
      // into one style. Several models from different providers works best.
      // Unset: the planner's models are used. designerVision looks at the
      // renders; unset falls back to verifierVision, then editorVision.
      designer: z.array(z.string()).min(1).optional(),
      designerVision: z.array(z.string()).min(1).optional(),
      // Security work: the threat model for a sensitive task, the attacker-style review of risky changes, and /pentest.
      // It runs rarely, so a frontier model is worth its cost here: unset it falls back to the verifier's models, then
      // the planner's. A [primary, backup] chain like the other roles.
      security: z.array(z.string()).min(1).optional(),
    })
    .prefault({}),
  designer: z
    .object({
      candidates: z.number().int().min(2).max(12).default(6),
      rounds: z.number().int().min(0).max(4).default(2),
      maxCalls: z.number().int().min(8).max(200).default(60),
      outputDir: z.string().default("brand"),
      // Also set the name beside the symbol in a real font (wordmark and lockups).
      typography: z.boolean().default(true),
      // Read the competitors' public home pages (colours and fonts) before drawing, so the mark can stand apart.
      competitors: z.boolean().default(true),
      // Write the brand guidelines document (PDF) with the kit.
      guidelines: z.boolean().default(true),
    })
    .prefault({}),
  existence: z
    .object({
      // Before planning a feature request or a spec, check what the code already has (quotes verified against the files)
      // and plan only what is partial or missing; if everything is there, build nothing.
      enabled: z.boolean().default(true),
      maxRequirements: z.number().int().min(1).max(30).default(12),
      // The first look at each requirement is made by a cheaper model (models.existence, else models.discovery) and only what it does not settle, plus a sample of what it
      // does, goes to the planner's model. Off = the planner's model does everything.
      tiered: z.boolean().default(true),
    })
    .prefault({}),
  roadmap: z
    .object({
      // A request too big for one task (a task holds at most 12 phases) is planned as a roadmap without asking when it is
      // clearly big: at least autoMinRequirements things it asks for are still partial or missing. Unattended runs, which
      // have nobody to ask, use a roadmap rather than cutting the work off. Off = always ask, and run one task when unattended.
      autoRoute: z.boolean().default(true),
      autoMinRequirements: z.number().int().min(2).max(30).default(6),
    })
    .prefault({}),
  security: z
    .object({
      // Threat-model risky tasks before planning, give agents the security rules, and check what they write.
      enabled: z.boolean().default(true),
      // The attacker-style review of risky changes (an extra model pass for them only).
      review: z.boolean().default(true),
      // /pentest looks up installed package versions in the public OSV vulnerability database (names and versions only are sent).
      dependencyLookup: z.boolean().default(true),
      // The attacker-style review runs on the (expensive) security model; this caps how many times one task may use it.
      reviewsPerTask: z.number().int().min(1).max(20).default(3),
      // A security model reads a command (and any script it runs, in full) before a person is asked, and clears what is plainly harmless.
      // Destructive, network, secret-reading, port-opening or injection-looking commands always go to the person. Off = always ask.
      commandReview: z.boolean().default(true),
      // With commandReview on: several different models judge each action a person would otherwise be asked about, and it runs only when ALL of them say
      // safe (commandPanel.ts). Judges are taken from the models configured for the security, planner and repair roles unless `models` names them.
      panel: z
        .object({
          enabled: z.boolean().default(true),
          size: z.number().int().min(2).max(5).default(3),
          models: z.array(z.string()).optional(),
          // How hard each judge thinks before answering. Always on: a judge that answers without reasoning is the weak link, whatever the model's default
          // or deepseek.reasoningOff says. Reasoning tokens are billed as output, so this is the cost knob.
          reasoning: z.enum(["low", "medium", "high"]).default("medium"),
        })
        .prefault({}),
    })
    .prefault({}),
  uiDesign: z
    .object({
      // Write a design system (design-system/) before building a new or restyled UI, and check UI code against it.
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  prompts: z
    .object({
      systemPersona: z
        .string()
        .default(
          "You are an elite, pragmatic principal software engineer working inside a codebase. " +
            "Adapt automatically to whatever tech stack, language, frameworks and conventions exist in this repository. " +
            "Inspect the existing project structure, configuration and code style before making changes. " +
            "Write clean, idiomatic, production-ready code with robust error handling and minimal diffs."
        ),
    })
    .prefault({}),
  limits: z
    .object({
      maxToolRounds: z.number().int().min(1).default(40),
      // A real, well-diagnosed defect routinely needs more than 3 tries,
      // especially once a phase bundles several unrelated bugs — a phase
      // that aborts at attempt 4 over a genuine fix still in progress reads
      // to the user as the whole task mysteriously giving up, not as a
      // considered stop. 10 repair attempts, split 5/5 between the primary
      // and backup editor model (see the repair loop's own comment in
      // index.ts), gives a second model a real shot before the phase gives
      // up — without raising this, a model stuck on the same blind spot
      // would just get nudged the same way 10 times instead of 3.
      maxRepairAttemptsPerPhase: z.number().int().min(0).default(10),
      /** Separately trackable since vision is this pipeline's least reliable
       *  evidence tier — deliberately NOT raised alongside
       *  maxRepairAttemptsPerPhase above: a hallucinated "looks wrong" is a
       *  different risk than a real compile/semantic defect, and burning 10
       *  attempts chasing one is exactly the failure mode this cap exists
       *  to prevent. Still can't exceed maxRepairAttemptsPerPhase in
       *  practice, since the overall repair loop is bounded by that too. */
      maxVisualOnlyRepairAttempts: z.number().int().min(0).default(3),
      // No fixed cap is ever truly "enough" — some file will always be
      // bigger than whatever number is picked here (real files well past
      // this have shown up in practice). The actual fix is read_file's
      // startLine/endLine range, which lets a model walk a file of ANY
      // size across a few calls instead of only ever seeing a truncated
      // first chunk; this cap is just the per-call ceiling under that —
      // raised from 120k since 187k real files were landing well past the
      // old default on a single whole-file read.
      maxFileBytes: z.number().int().min(1).default(60_000),
      maxSearchResults: z.number().int().min(1).default(100),
      // The most distinct files one phase may modify; a write past it is refused. 0 (the default) = no limit: a phase that touches many files is a sign the plan was broad,
      // which is worth knowing, but refusing an edit half-way leaves the work half-done, and none of the safety rules depends on a count.
      maxFilesPerPhase: z.number().min(0).default(0),
      // Tries per model for one call (the first plus retries) before the next model in the chain is used.
      apiMaxAttempts: z.number().int().min(1).max(10).default(3),
      // Scales every backoff wait (rate limit, provider error, timeout, disconnect): 1000 keeps the built-in waits, 500 halves them. A Retry-After from the server is never scaled.
      apiBaseDelayMs: z.number().int().min(0).default(1000),
    })
    .prefault({}),
  git: z
    .object({
      autoCommit: z.boolean().default(true),
      commitPrefix: z.string().default("yimpim"),
      /**
       * Resolved at runtime from .agent/push.json, NOT from this YAML file —
       * deliberately absent from any starter config so it never round-trips
       * through `yimpim init`/`yimpim config set`. agent.config.yaml is typically
       * committed and shared with a whole team; whether THIS machine pushes
       * to GitHub is a personal, per-checkout choice, not a team default. See
       * gitRemote.ts.
       */
      autoPush: z.boolean().default(false),
    })
    .prefault({}),
  planning: z
    .object({
      /** essential: ask only the few things worth a person's time, however many; autonomous: never wait; all: ask everything. */
      questions: z.enum(["autonomous", "essential", "all"]).default("essential"),
    })
    .prefault({}),
  execution: z
    .object({
      allowedCommands: z
        .array(z.string())
        .default(["git", "npm", "pnpm", "yarn", "npx", "node", "python", "pytest", "cargo", "go", "make"]),
    })
    .prefault({}),
  safety: z
    .object({
      allowedPaths: z.array(z.string()).default([]),
      blockedDirectories: z
        .array(z.string())
        .default(DEFAULT_BLOCKED_DIRECTORIES),
      blockedFilePatterns: z
        .array(z.string())
        .default(DEFAULT_BLOCKED_FILE_PATTERNS),
    })
    .prefault({}),
  recovery: z
    .object({
      // Where per-project state lives is FIXED at .agent (about a hundred places read it by name); this key only moves .agent/push.json (gitRemote.ts) and is kept so a config that sets it still loads.
      stateDirectory: z.string().default(".agent"),
      keepBackups: z.boolean().default(true),
      dirtyTreePolicy: z.enum(["inspect", "refuse", "fail"]).default("inspect"),
    })
    .prefault({}),
  interaction: z
    .object({
      /**
       * Ask "Continue? [yes next / yes to all / no]" between the units of a roadmap and between queued tasks. Off by default: the work goes on by itself, the
       * user can stop it at any time, and a unit that fails stops it. On brings the question back, for someone who wants to approve each step.
       */
      confirmContinue: z.boolean().default(false),
      /**
       * How long YIMPIM waits for an answer before it takes the question's own default and carries on (written to .agent/assumptions.md for review). Approvals of
       * commands, installs and deletions are refused, never allowed, when nobody answers. 0 = wait forever.
       */
      answerTimeoutMinutes: z.number().min(0).default(30),
      /** When nobody answers in time, a model (the planner's) reads the question and answers it, instead of taking the question's blind default. Approvals are never answered this way. */
      modelAnswersOnTimeout: z.boolean().default(true),
      /**
       * When true, sign-off points that would otherwise pause for a human at
       * the keyboard (a QA visual advisory on an otherwise-passing phase, a
       * deferred styling/copy decision) instead auto-accept the agent's own
       * fallback and log it to QA_REVIEW.md for later review. Defaults to
       * true because a harness built to run unattended shouldn't stall on a
       * judgment call nobody's there to make — set to false to get the old
       * interactive sign-off prompts back.
       */
      autonomous: z.boolean().default(true),
    })
    .prefault({}),
  remote: z
    .object({
      redactLogs: z.boolean().default(false),
      /** Include this computer's name in the sealed session.hello event, so a phone with several terminals can tell them apart. */
      shareHostname: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Optional per-project overrides for verification. Everything here is
   * auto-detected when omitted; these exist for the cases detection gets wrong.
   */
  verification: z
    .object({
      /** Pins which device/simulator gets verified when more than one is
       *  attached (e.g. a physical device plus an emulator) — otherwise
       *  whichever the OS happens to list first is used, silently, which may
       *  not be the one you meant. `adb devices` / `xcrun simctl list
       *  devices booted` shows the exact id to use. */
      androidDeviceSerial: z.string().optional(),
      iosSimulatorUdid: z.string().optional(),
      /** Skip probes by name: android, ios, web, desktop (capabilities.ts PROBE_GROUPS). */
      skipProbes: z.array(z.string()).default([]),
    })
    .prefault({}),
  memory: z
    .object({
      // How many components the repo map REMEMBERS (it is a file on disk, so this scales
      // with the project). What is put in front of a model is limited separately below.
      maxEntries: z.number().int().min(10).max(5000).default(1000),
      // How many of them are pasted into every agent's prompt, most recently updated first.
      // Every model call pays for these, so this stays small however large the project is.
      maxPromptEntries: z.number().int().min(10).max(200).default(50),
      // How many screens the navigation map remembers (.agent/nav_map.json), oldest evicted first.
      maxNavEntries: z.number().int().min(10).max(5000).default(200),
      // The longest summary a repo-map entry keeps, in words (longer is cut with "..."); every agent's prompt pays for these.
      summaryWordLimit: z.number().int().min(3).max(100).default(15),
    })
    .prefault({}),
  provider: z
    .object({
      /**
       * How OpenRouter picks a backend for each call. "default" is price-first
       * and can land on a stalled/degraded provider for a full request timeout
       * before falling back — "throughput" reorders candidates by measured
       * speed instead, which naturally deprioritizes whoever is currently slow.
       */
      sort: z.enum(["default", "throughput", "price", "latency"]).default("default"),
    })
    .prefault({}),
  /**
   * Settings for DeepSeek models only (see requestTuning.ts): they are served by several providers at different speeds and prices, so
   * calls go to the fastest one under a price cap. Prices are dollars per million tokens; 0 means no ceiling.
   */
  deepseek: z
    .object({
      sort: z.enum(["default", "throughput", "price", "latency"]).default("throughput"),
      maxPromptPrice: z.number().min(0).default(0.3),
      maxCompletionPrice: z.number().min(0).default(0.75),
      // Agents (name prefix) that do not need the model to think first. Reasoning tokens are billed as output.
      reasoningOff: z.array(z.string()).default(["DISCOVERY", "EDITOR"]),
    })
    .prefault({}),
  /**
   * Healing a red test suite. What the first (cheap) model parks goes, when there is a stronger model after it in the repair chain, to a SANDBOX: a
   * disposable copy of the project where that model can run experiments the way a person does (see healSandbox.ts).
   */
  heal: z
    .object({
      // Before an Editor or Repair may conclude, the tests its change can reach are run and what the change made stale is fixed (editorSweep.ts).
      editorSweep: z.boolean().default(true),
      sandbox: z
        .object({
          // Off = the stronger model gets the same JSON conversation the first one had.
          enabled: z.boolean().default(true),
          // The most to spend on the stronger model for ONE stubborn group of failing tests, in dollars. 0 = no dollar stop (the no-progress rules still apply).
          budgetUsd: z.number().min(0).default(1.75),
          // How many times in a row the same result, edits without a test run, or (twice this many) reads without an experiment end a run that is going nowhere.
          stagnation: z.number().int().min(1).default(3),
          // The most tests ONE deviation verdict may change. A deviation is a test changed to follow the working app where it differs from the spec in a cosmetic way.
          deviationTestCap: z.number().int().min(1).default(12),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = Config;

export function loadConfig(targetRepoRoot?: string, customConfigPath?: string): Config {
  const possiblePaths = [
    customConfigPath,
    targetRepoRoot ? path.join(targetRepoRoot, "agent.config.yaml") : undefined,
    targetRepoRoot ? path.join(targetRepoRoot, ".agent", "config.yaml") : undefined,
    path.resolve(process.cwd(), "agent.config.yaml"),
  ].filter(Boolean) as string[];

  for (const p of possiblePaths) {
    if (!fs.existsSync(p)) continue;
    const raw = yaml.parse(fs.readFileSync(p, "utf-8")) ?? {};
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid config at ${p}:\n` +
          parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
      );
    }
    console.log(`[CONFIG] Loaded ${p}`);
    // What every file walker skips follows the user's blocked directories (projectPaths.ts).
    setBlockedDirectories(parsed.data.safety.blockedDirectories);
    return parsed.data;
  }

  // No config anywhere: run on defaults rather than refusing to start.
  console.log(`[CONFIG] No agent.config.yaml found; using built-in defaults.`);
  setBlockedDirectories(undefined);
  return ConfigSchema.parse({});
}
