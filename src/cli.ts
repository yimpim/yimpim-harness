/**
 * Command surface for the `yimpim` binary.
 *
 * Subcommands are parsed here and dispatched; `run` is the default so the
 * historical `yimpim --repo X "task"` invocation keeps working.
 */

import fs from "fs";
import path from "path";
import process from "process";
import {
  SETTINGS,
  findSetting,
  formatValue,
  generateStarterConfig,
  getByPath,
  coerce,
  locateConfigFile,
  resolveConfig,
  writeSetting,
} from "./settings.js";
import { runDoctor } from "./doctor.js";
import { globalConfigPath, hasGlobalConfig } from "./globalConfig.js";
import { apiKeyStatus } from "./secrets.js";

export interface ParsedArgs {
  command: "run" | "doctor" | "config" | "init" | "help" | "version" | "setup" | "setup-env" | "link";
  sub?: string;
  positionals: string[];
  repoRoot: string;
  taskPrompt?: string;
  taskFile?: string;
  isResume: boolean;
  forceUnlock: boolean;
  json: boolean;
  remote: boolean;
  overrides: string[];
  configPath?: string;
  yes: boolean;
  /** Reference files the user supplied; never agent-selected. */
  attach: string[];
}

const COMMANDS = ["run", "doctor", "config", "init", "help", "version", "setup", "setup-env", "link"];

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let command: ParsedArgs["command"] = "run";
  let sub: string | undefined;

  if (args.length > 0 && COMMANDS.includes(args[0])) {
    command = args.shift() as ParsedArgs["command"];
    if (command === "config" && args.length > 0 && !args[0].startsWith("-")) {
      sub = args.shift();
    }
  }

  let repoRoot = "";
  let taskPrompt: string | undefined;
  let taskFile: string | undefined;
  let configPath: string | undefined;
  let isResume = false;
  let yes = false;
  let forceUnlock = false;
  let json = false;
  let remote = false;
  const overrides: string[] = [];
  const attach: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--repo" || a === "-r") && args[i + 1]) repoRoot = path.resolve(args[++i]);
    else if (a === "--task" && args[i + 1]) taskPrompt = args[++i];
    else if (a === "--task-file" && args[i + 1]) taskFile = path.resolve(args[++i]);
    else if (a === "--config" && args[i + 1]) configPath = path.resolve(args[++i]);
    else if (a === "--set" && args[i + 1]) overrides.push(args[++i]);
    else if ((a === "--attach" || a === "-a") && args[i + 1]) attach.push(args[++i]);
    else if (a === "--resume") isResume = true;
    else if (a === "--force-unlock") forceUnlock = true;
    else if (a === "--json") json = true;
    else if (a === "--remote") remote = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--help" || a === "-h") command = "help";
    else if (a === "--version" || a === "-v") command = "version";
    else if (!a.startsWith("-")) positionals.push(a);
  }

  // `yimpim run --repo X "do the thing"` — trailing positional is the task.
  if (command === "run" && !taskPrompt && positionals.length > 0) {
    taskPrompt = positionals.join(" ");
  }

  if (!repoRoot) repoRoot = process.cwd();

  return { command, sub, positionals, repoRoot, taskPrompt, taskFile, isResume, forceUnlock, json, remote, overrides, configPath, yes, attach };
}

export function printHelp(): void {
  console.log(`
yimpim — an autonomous coding agent with capability-graded QA

GETTING STARTED
  yimpim setup              Choose your API key and models (once, for all projects)
  cd my-project && yimpim   Start working in the current repo

IN A SESSION
  Type what you want done, or just ask a question — "what's the best stack
  for this?" gets an answer, not a plan. Or use a slash command:
    /remote-control   Show a QR code to pair your phone (YIMPIM Pro)
    /link             Link this machine to YIMPIM Pro (cloud-tunnel lease)
    /model            Change the model for one role
    /api-key          Rotate your OpenRouter key
    /ask              Ask a question, read-only — nothing gets changed
    /status           Models, settings and readiness
    /plan             The current plan
    /memory           What YIMPIM has learned about this repo
    /help             Every command (also /design, /roadmap, /tests, /pentest, ...)
    /exit             Quit

OTHER COMMANDS
  yimpim doctor             What works here, what a run will cost, and the state of this machine's toolchains
  yimpim setup-env          Install the toolchains a new machine needs (Node, Python, Java, Android, Flutter, Playwright); --dry-run shows it first
  yimpim config list        Every setting and its current value
  yimpim config set <k> <v> Change a setting
  yimpim link               Link this machine to YIMPIM Pro (cloud-tunnel lease)
  yimpim help | version

FLAGS (optional — sensible defaults otherwise)
  --repo <dir>          Work on another repo instead of the current directory
  --resume              Continue where the last run stopped
  --attach <file>       Reference material for the plan (repeatable)
                        Images, PDFs and text. Or send one from your phone.
  --set <key=value>     Override one setting for this run
  --json                Machine-readable NDJSON output
  --yes                 Accept defaults; never prompt

SETTINGS
  Your choices live in ~/.yimpim/config.yaml and apply everywhere.
  A project may override them with its own agent.config.yaml.
`);
}

/** True when the user has never completed setup. */
export function needsSetup(): boolean {
  return !hasGlobalConfig() || !apiKeyStatus().present;
}

// ------------------------------------------------------------------ config

export function cmdConfigList(repoRoot: string, configPath?: string, commonOnly = false): number {
  const { config, sourcePath } = resolveConfig({ repoRoot, configPath });

  console.log(`\nConfiguration source: ${sourcePath ?? "built-in defaults (no config file)"}\n`);

  const defs = commonOnly ? SETTINGS.filter((s) => s.common) : SETTINGS;
  const groups = [...new Set(defs.map((s) => s.group))];

  for (const group of groups) {
    console.log(`${group}`);
    for (const def of defs.filter((s) => s.group === group)) {
      const value = getByPath(config, def.key);
      const star = def.common ? "*" : " ";
      console.log(` ${star} ${def.key}`);
      console.log(`     ${formatValue(value)}`);
      console.log(`     ${def.description}`);
      if (def.choices) console.log(`     choices: ${def.choices.join(" | ")}`);
    }
    console.log("");
  }
  if (!commonOnly) console.log("* = commonly changed.  Narrow with: yimpim config list --common\n");
  return 0;
}

export function cmdConfigGet(repoRoot: string, key: string, configPath?: string): number {
  const def = findSetting(key);
  if (!def) {
    console.error(`Unknown setting "${key}". Run \`yimpim config list\` to see valid keys.`);
    return 1;
  }
  const { config } = resolveConfig({ repoRoot, configPath });
  console.log(formatValue(getByPath(config, key)));
  return 0;
}

export function cmdConfigSet(repoRoot: string, key: string, rawValue: string, configPath?: string): number {
  const def = findSetting(key);
  if (!def) {
    console.error(`Unknown setting "${key}". Run \`yimpim config list\` to see valid keys.`);
    const near = SETTINGS.filter((s) => s.key.includes(key.split(".").pop() ?? "")).slice(0, 3);
    if (near.length) console.error(`Did you mean: ${near.map((n) => n.key).join(", ")}?`);
    return 1;
  }

  // Settings belong to the user by default. Only write into the project when it
  // already keeps its own config, or the caller pointed at one explicitly.
  const projectConfig = locateConfigFile(repoRoot);
  const target = configPath ?? projectConfig ?? globalConfigPath();

  try {
    const value = coerce(def, rawValue);
    writeSetting(target, key, value);
    console.log(`${key} = ${formatValue(value)}`);
    console.log(`written to ${target}`);
    return 0;
  } catch (err: any) {
    console.error(`Could not set ${key}: ${err.message}`);
    return 1;
  }
}

// -------------------------------------------------------------------- init

export function cmdInit(repoRoot: string, force: boolean): number {
  const target = path.join(repoRoot, "agent.config.yaml");
  if (fs.existsSync(target) && !force) {
    console.error(`${target} already exists. Use --yes to overwrite.`);
    return 1;
  }
  fs.writeFileSync(target, generateStarterConfig(), "utf-8");
  console.log(`Wrote ${target}`);
  console.log(`\nEvery setting in it is optional — delete what you do not need.`);
  console.log(`Next: yimpim doctor --repo ${repoRoot}`);
  return 0;
}

// ------------------------------------------------------------------ doctor

export async function cmdDoctor(repoRoot: string, configPath?: string, overrides: string[] = []): Promise<number> {
  let resolved;
  try {
    resolved = resolveConfig({ repoRoot, configPath, overrides });
  } catch (err: any) {
    console.error(`\nConfiguration error:\n${err.message}\n`);
    return 1;
  }
  const report = await runDoctor(repoRoot, resolved.config, resolved.sourcePath);
  console.log(report.lines.join("\n"));
  return report.canRun ? 0 : 1;
}

// --------------------------------------------------------- interactive I/O

/**
 * Prompts must never hang a non-interactive session. When stdin is not a TTY
 * (piped, CI, backgrounded) the caller's fallback is used and the question is
 * echoed so the transcript still shows what was asked.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptOrDefault(question: string, fallback: string, assumeYes: boolean): Promise<string> {
  if (assumeYes || !isInteractive()) {
    const reason = assumeYes ? "--yes" : "non-interactive stdin";
    console.log(`${question}`);
    console.log(`  [auto-answered via ${reason}: ${fallback || "(accept default)"}]`);
    return fallback;
  }
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
