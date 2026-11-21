/**
 * Settings registry and layered resolution.
 *
 * One declarative registry drives everything: `yimpim config list`, validation,
 * `--set` overrides, the generated starter config, and (later) a settings menu.
 * Adding a setting here makes it visible and editable everywhere at once.
 *
 * Precedence, lowest to highest:
 *   schema defaults  ->  config file  ->  YIMPIM_* env vars  ->  CLI --set flags
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { Config, ConfigSchema } from "./config.js";
import { globalConfigPath, hasGlobalConfig, mergeConfig, readGlobalConfig } from "./globalConfig.js";

export type SettingType = "string" | "number" | "boolean" | "string[]" | "enum";

export interface SettingDef {
  /** Dotted path into the config object, e.g. "models.editor". */
  key: string;
  type: SettingType;
  /** One-line explanation shown in `yimpim config list` and the future menu. */
  description: string;
  /** Valid values for enums. */
  choices?: string[];
  /** Grouping label for display. */
  group: string;
  /** Marks settings most users will want to change. */
  common?: boolean;
}

export const SETTINGS: SettingDef[] = [
  // ---- Models: the settings that actually matter to most users -------------
  {
    key: "models.discovery",
    type: "string[]",
    group: "Models",
    common: true,
    description: "Model chain for repo exploration. Needs tool-calling support.",
  },
  {
    key: "models.discoveryVision",
    type: "string[]",
    group: "Models",
    description:
      "Optional. Used instead of models.discovery for the WHOLE exploration pass, only on a task with an " +
      "attached image. Unset: Discovery just never looks at the image, no warning (its use of images is " +
      "opportunistic, not load-bearing).",
  },
  {
    key: "models.planner",
    type: "string[]",
    group: "Models",
    common: true,
    description:
      "Model chain for writing the implementation plan. No tools used, one call per task — pick a " +
      "vision-capable model here (Vision) if you plan to attach reference images; a single call staying on " +
      "vision pricing is a much smaller cost than a whole Editor/Discovery pass, so this has no separate role.",
  },
  {
    key: "models.editor",
    type: "string[]",
    group: "Models",
    common: true,
    description: "Model chain that writes code. Needs tool-calling. Usually your fastest capable model.",
  },
  {
    key: "models.editorVision",
    type: "string[]",
    group: "Models",
    common: true,
    description:
      "Used instead of models.editor for the WHOLE Editor/Repair phase, only on a task with an attached " +
      "image (every round of that phase reuses it, so this is a separate, opt-in, usually pricier chain, " +
      "never silently mixed into your normal one). Unset: the image only reaches the Planner, and you're " +
      "warned in the console rather than silently paying for or missing vision.",
  },
  {
    key: "models.repair",
    type: "string[]",
    group: "Models",
    description:
      "Optional. Model chain for fixing defects QA found after Editor's diff. Diagnosing a failure from " +
      "error text alone is harder than executing an already-clear plan, so this is worth a stronger model " +
      "than Editor even while Editor itself stays cheap. Unset: reuses models.editor exactly, no warning.",
  },
  {
    key: "models.repairVision",
    type: "string[]",
    group: "Models",
    description:
      "Optional. Used instead of models.repair for the WHOLE phase, only on a task with an attached image. " +
      "Unset: reuses models.editorVision (or models.repair/models.editor) exactly, no warning.",
  },
  {
    key: "models.verifier",
    type: "string[]",
    group: "Models",
    common: true,
    description: "Model chain for QA's text-only checks (semantic diff review, etc). No image input needed here.",
  },
  {
    key: "models.verifierVision",
    type: "string[]",
    group: "Models",
    common: true,
    description:
      "Model chain for QA's screenshot-driven checks (navigation, visual audit) — used on essentially every " +
      "UI project's normal QA pass, not just when you attach a reference image. Unset: falls back to " +
      "models.verifier, which must then support vision itself, or these checks silently degrade.",
  },
  {
    key: "models.designer",
    type: "string[]",
    group: "Models",
    description:
      "Optional. The logo designer (/design). Unlike the other roles this is a SET to rotate through, not a fallback chain: " +
      "different models propose and draw different concepts, because one model alone settles into one style. Several models " +
      "from different providers works best. Unset: reuses models.planner.",
  },
  {
    key: "models.designerVision",
    type: "string[]",
    group: "Models",
    description:
      "Optional. Looks at the renders the designer makes and judges them. Unset: falls back to models.verifierVision, then " +
      "models.editorVision.",
  },
  {
    key: "models.security",
    type: "string[]",
    group: "Models",
    description:
      "Optional. Security work: the threat model for a sensitive task, the attacker-style review of risky changes, and " +
      "/pentest. It runs rarely, so a frontier model is worth its cost here. A [primary, backup] chain like the other roles. " +
      "Unset: falls back to models.verifier, then models.planner.",
  },
  {
    key: "provider.sort",
    type: "enum",
    choices: ["default", "throughput", "price", "latency"],
    group: "Models",
    common: true,
    description:
      "How OpenRouter picks a backend per call. 'throughput' avoids providers that are currently slow " +
      "or stalled instead of just picking the cheapest one.",
  },
  {
    key: "deepseek.sort",
    type: "enum",
    choices: ["default", "throughput", "price", "latency"],
    group: "Models",
    description:
      "DeepSeek models only. DeepSeek is served by several providers at different speeds, so calls go to the fastest one " +
      "(throughput) that is still under the price caps below. Overrides provider.sort for DeepSeek.",
  },
  {
    key: "deepseek.maxPromptPrice",
    type: "number",
    group: "Models",
    description: "DeepSeek models only. The most you will pay per million prompt tokens, in dollars. A provider above it is not used. 0 = no ceiling.",
  },
  {
    key: "deepseek.maxCompletionPrice",
    type: "number",
    group: "Models",
    description:
      "DeepSeek models only. The most you will pay per million completion tokens, in dollars. If no provider is under both caps the call " +
      "fails with a message saying so (and moves to the backup model). 0 = no ceiling.",
  },
  {
    key: "deepseek.reasoningOff",
    type: "string[]",
    group: "Models",
    description:
      "DeepSeek models only. Agents (by name) that do not think before answering. Thinking is billed as output tokens. Default: " +
      "DISCOVERY and EDITOR. Add REPAIR to turn it off there too; empty leaves the model's own default everywhere.",
  },

  // ---- Cost and loop control ----------------------------------------------
  {
    key: "heal.sandbox.enabled",
    type: "boolean",
    group: "Limits",
    description:
      "When tests fail and the cheap model cannot fix some of them, a stronger model (the next one in your repair list) tries in a throwaway copy of your project, " +
      "where it can add logging, change a wait and run one test, like a person at a terminal. Only the test file ever comes back, and only if more tests pass and none break. " +
      "Off = it gets the same text conversation the cheap model had.",
  },
  {
    key: "heal.sandbox.budgetUsd",
    type: "number",
    group: "Limits",
    common: true,
    description:
      "The most to spend on the stronger model for ONE stubborn group of failing tests, in dollars. When it is reached, that group is reported for a person and the run goes on. 0 = no dollar limit.",
  },
  {
    key: "heal.sandbox.stagnation",
    type: "number",
    group: "Limits",
    description:
      "How patient the stronger model is before it is stopped for going nowhere: this many test runs in a row with the same result and nothing changed, this many rounds of edits without " +
      "running a test, or twice this many rounds of only reading. A new result is progress and starts the count again.",
  },
  {
    key: "heal.sandbox.deviationTestCap",
    type: "number",
    group: "Limits",
    description:
      "When the app works but differs from its written spec in a small visible way (a label, its capital letters, wording, order), the test is changed to match the app so work is not " +
      "blocked, and a follow-up ticket records the gap. This is the most tests one such change may touch. Anything bigger is refused and reported for a person.",
  },
  {
    key: "limits.maxToolRounds",
    type: "number",
    group: "Limits",
    common: true,
    description: "Max tool calls per agent pass. Lower = cheaper and safer; higher = handles bigger tasks.",
  },
  {
    key: "limits.maxRepairAttemptsPerPhase",
    type: "number",
    group: "Limits",
    common: true,
    description: "Retries after a failed verification. Each retry costs a full editor pass.",
  },
  {
    key: "limits.maxVisualOnlyRepairAttempts",
    type: "number",
    group: "Limits",
    description: "Retries specifically for a visual-only defect. Raising past maxRepairAttemptsPerPhase has no extra effect.",
  },
  {
    key: "limits.maxFilesPerPhase",
    type: "number",
    group: "Limits",
    common: true,
    description: "Max distinct files one phase may modify; a write past it is refused. 0 = no limit (the default).",
  },
  {
    key: "limits.maxFileBytes",
    type: "number",
    group: "Limits",
    description: "Truncate a single read_file call past this size, to protect the context window — the agent can still read the rest via a line range (startLine/endLine).",
  },
  {
    key: "limits.maxSearchResults",
    type: "number",
    group: "Limits",
    description: "Max search hits returned to the model.",
  },

  // ---- Git behaviour -------------------------------------------------------
  {
    key: "git.autoCommit",
    type: "boolean",
    group: "Git",
    common: true,
    description: "Commit automatically after a phase passes verification.",
  },
  {
    key: "git.commitPrefix",
    type: "string",
    group: "Git",
    description: "Prefix for commit messages the agent creates.",
  },

  // ---- Verification --------------------------------------------------------
  {
    key: "verification.androidApplicationId",
    type: "string",
    group: "Verification",
    description: "Override the auto-detected Android applicationId.",
  },
  {
    key: "verification.androidModule",
    type: "string",
    group: "Verification",
    description: "Override the auto-detected Android gradle module directory.",
  },
  {
    key: "verification.devServerUrl",
    type: "string",
    group: "Verification",
    description: "Override the dev server URL instead of detecting it from output.",
  },
  {
    key: "verification.androidDeviceSerial",
    type: "string",
    group: "Verification",
    description: "Pin which attached device gets verified when more than one is connected (see: adb devices).",
  },
  {
    key: "verification.iosSimulatorUdid",
    type: "string",
    group: "Verification",
    description: "Pin which booted simulator gets verified when more than one is running (see: xcrun simctl list devices booted).",
  },
  {
    key: "verification.skipProbes",
    type: "string[]",
    group: "Verification",
    description: "Visual probes to skip, e.g. [android, desktop]. Skipped probes degrade to static review.",
  },

  // ---- Remote control ------------------------------------------------------
  {
    key: "remote.brokerUrl",
    type: "string",
    group: "Remote",
    common: true,
    description: "Relay URL for phone control. Run your own; it only ever sees ciphertext.",
  },
  {
    key: "remote.redactLogs",
    type: "boolean",
    group: "Remote",
    common: true,
    description:
      "Hide terminal output from the phone's activity feed. Off by default, so a " +
      "paired phone sees the same narration the terminal does. Turn on if that output " +
      "might quote source you would not want visible on the phone's screen.",
  },
  // ---- Safety --------------------------------------------------------------
  {
    key: "safety.blockedDirectories",
    type: "string[]",
    group: "Safety",
    description: "Directories the editor may never read or write.",
  },
  {
    key: "safety.blockedFilePatterns",
    type: "string[]",
    group: "Safety",
    description: "Filename globs the editor may never touch (keys, certs, .env).",
  },

  // ---- Interaction -----------------------------------------------------------
  {
    key: "interaction.autonomous",
    type: "boolean",
    group: "Interaction",
    common: true,
    description:
      "Auto-accept QA sign-off points (visual advisories, deferred design decisions) instead of pausing " +
      "for input — logged to QA_REVIEW.md for later review. Set false to restore interactive prompts.",
  },

  // ---- Recovery ------------------------------------------------------------
  {
    key: "recovery.stateDirectory",
    type: "string",
    group: "Recovery",
    description: "Where run state, screenshots and memory are stored inside the target repo.",
  },
  {
    key: "recovery.dirtyTreePolicy",
    type: "enum",
    choices: ["inspect", "refuse", "fail"],
    group: "Recovery",
    description: "What to do when the target repo already has uncommitted changes.",
  },
];

export function findSetting(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

// ------------------------------------------------------------ path helpers

export function getByPath(obj: any, dotted: string): unknown {
  return dotted.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

export function setByPath(obj: any, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  const last = parts.pop()!;
  let cursor = obj;
  for (const part of parts) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[last] = value;
}

/** Parse a CLI/env string into the type the setting expects. */
export function coerce(def: SettingDef, raw: string): unknown {
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${def.key} expects a number, got "${raw}"`);
      return n;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      throw new Error(`${def.key} expects true/false, got "${raw}"`);
    }
    case "string[]":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    case "enum":
      if (def.choices && !def.choices.includes(raw)) {
        throw new Error(`${def.key} must be one of: ${def.choices.join(", ")} (got "${raw}")`);
      }
      return raw;
    default:
      return raw;
  }
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
  return String(value);
}

// ------------------------------------------------------- layered resolution

/** YIMPIM_MODELS_EDITOR=a,b  ->  models.editor */
function envKeyToSetting(envKey: string): SettingDef | undefined {
  const dotted = envKey.replace(/^YIMPIM_/, "").toLowerCase().split("_");
  return SETTINGS.find((s) => {
    const parts = s.key.toLowerCase().replace(/([a-z])([A-Z])/g, "$1$2").split(".");
    const flat = parts.join("").replace(/[^a-z]/g, "");
    return flat === dotted.join("").replace(/[^a-z]/g, "");
  });
}

export interface ResolveOptions {
  repoRoot?: string;
  configPath?: string;
  /** Raw "key=value" strings from --set flags. */
  overrides?: string[];
}

export interface ResolvedConfig {
  config: Config;
  /** Where the file layer came from, if any. */
  sourcePath?: string;
  /** Human-readable note per overridden key. */
  applied: string[];
}

export function locateConfigFile(repoRoot?: string, explicit?: string): string | undefined {
  const candidates: (string | undefined)[] = [explicit];

  if (repoRoot) {
    candidates.push(path.join(repoRoot, "agent.config.yaml"));
    candidates.push(path.join(repoRoot, ".agent", "config.yaml"));
  }

  // Only consider the working directory when it IS the target. Otherwise one
  // project's config would silently govern a run against a different repo.
  const cwd = process.cwd();
  if (!repoRoot || path.resolve(repoRoot) === path.resolve(cwd)) {
    candidates.push(path.join(cwd, "agent.config.yaml"));
  }

  return (candidates.filter(Boolean) as string[]).find((p) => fs.existsSync(p));
}

export function resolveConfig(opts: ResolveOptions = {}): ResolvedConfig {
  const applied: string[] = [];
  const sourcePath = locateConfigFile(opts.repoRoot, opts.configPath);

  // Layer 1: the user's global settings, which apply to every project.
  let raw: any = readGlobalConfig();
  if (hasGlobalConfig()) applied.push(`global settings from ${globalConfigPath()}`);

  // Layer 2: this project's config, which overrides the global one.
  if (sourcePath) {
    const projectRaw = yaml.parse(fs.readFileSync(sourcePath, "utf-8")) ?? {};
    raw = mergeConfig(raw, projectRaw);
  }

  // Layer 2: environment variables.
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith("YIMPIM_") || envVal === undefined) continue;
    const def = envKeyToSetting(envKey);
    if (!def) continue;
    try {
      setByPath(raw, def.key, coerce(def, envVal));
      applied.push(`${def.key} <- ${envKey}`);
    } catch (e: any) {
      throw new Error(`Invalid ${envKey}: ${e.message}`);
    }
  }

  // Layer 3: --set key=value flags.
  for (const override of opts.overrides ?? []) {
    const eq = override.indexOf("=");
    if (eq === -1) throw new Error(`--set expects key=value, got "${override}"`);
    const key = override.slice(0, eq).trim();
    const value = override.slice(eq + 1);
    const def = findSetting(key);
    if (!def) {
      throw new Error(`Unknown setting "${key}". Run \`yimpim config list\` to see valid keys.`);
    }
    setByPath(raw, key, coerce(def, value));
    applied.push(`${key} <- --set`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration${sourcePath ? ` (from ${sourcePath})` : ""}:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
    );
  }

  return { config: parsed.data, sourcePath, applied };
}

// --------------------------------------------------------------- persistence

/**
 * Write a single setting back to the YAML file, preserving comments and
 * formatting via the yaml Document API rather than re-serialising a plain object.
 */
export function writeSetting(configPath: string, key: string, value: unknown): void {
  const def = findSetting(key);
  if (!def) throw new Error(`Unknown setting "${key}".`);

  let doc: yaml.Document;
  if (fs.existsSync(configPath)) {
    doc = yaml.parseDocument(fs.readFileSync(configPath, "utf-8"));
  } else {
    doc = new yaml.Document({});
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  doc.setIn(key.split("."), value);

  // Validate the whole file before committing the write.
  const check = ConfigSchema.safeParse(doc.toJS() ?? {});
  if (!check.success) {
    throw new Error(
      `Refusing to write — the result would be invalid:\n` +
        check.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
    );
  }

  fs.writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * Removes a setting entirely, rather than writing an empty/default value —
 * needed for the three optional vision model roles, where "unset" is
 * represented in the schema by the KEY BEING ABSENT (`.optional()`, no `[]`
 * case — see ConfigSchema), not by an empty array.
 *
 * This is a generic registry primitive, not model-config-specific — it does
 * NOT know that clearing one of the four REQUIRED model roles is a bad idea
 * for that particular key. Their schema entries carry a `.default(...)`, so
 * deleting the key is itself perfectly valid (the re-validation below just
 * falls back to the default) — it will NOT throw to stop you. Anything that
 * must not be clearable has to reject that case itself before ever calling
 * this — see set_model's handler in index.ts, which refuses an empty chain
 * for a required role before it gets anywhere near here.
 */
export function clearSetting(configPath: string, key: string): void {
  const def = findSetting(key);
  if (!def) throw new Error(`Unknown setting "${key}".`);
  if (!fs.existsSync(configPath)) return; // nothing written yet — already effectively unset

  const doc = yaml.parseDocument(fs.readFileSync(configPath, "utf-8"));
  doc.deleteIn(key.split("."));

  const check = ConfigSchema.safeParse(doc.toJS() ?? {});
  if (!check.success) {
    throw new Error(
      `Refusing to clear — the result would be invalid:\n` +
        check.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
    );
  }

  fs.writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * A commented starter config, generated from the registry.
 *
 * Built through the yaml Document API rather than string concatenation: values
 * like "*.keystore" must be emitted quoted, because a bare leading "*" is an
 * alias reference in YAML and would make the generated file unparseable.
 */
export function generateStarterConfig(): string {
  const defaults = ConfigSchema.parse({});
  const out: string[] = [
    "# YIMPIM configuration.",
    "#",
    "# Every setting below is OPTIONAL - delete anything you do not want to change",
    "# and the built-in default applies. Inspect current values with:",
    "#   yimpim config list",
    "# Change one with:",
    "#   yimpim config set models.editor <model-a>,<model-b>",
    "",
  ];

  // yaml.stringify handles quoting per value, so globs like "*.keystore" are
  // emitted quoted rather than as a YAML alias reference.
  const scalar = (v: unknown) => yaml.stringify(v, { lineWidth: 0 }).trim();

  const groups = [...new Set(SETTINGS.map((s) => s.group))];
  for (const group of groups) {
    const defs = SETTINGS.filter((s) => s.group === group);
    out.push(`# ---- ${group} ${"-".repeat(Math.max(3, 58 - group.length))}`);

    for (const section of [...new Set(defs.map((d) => d.key.split(".")[0]))]) {
      out.push(`${section}:`);
      for (const def of defs.filter((d) => d.key.startsWith(`${section}.`))) {
        const leaf = def.key.split(".").slice(1).join(".");
        const value = getByPath(defaults, def.key);

        out.push(`  # ${def.description}`);
        if (def.choices) out.push(`  # one of: ${def.choices.join(" | ")}`);

        if (value === undefined) {
          out.push(`  # ${leaf}:   # (unset - auto-detected)`);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            out.push(`  ${leaf}: []`);
          } else {
            out.push(`  ${leaf}:`);
            for (const item of value) out.push(`    - ${scalar(item)}`);
          }
        } else {
          out.push(`  ${leaf}: ${scalar(value)}`);
        }
        out.push("");
      }
    }
  }

  return out.join("\n");
}

