/**
 * What QA's agent can do on ANY project, with no screen involved: read the
 * code, search it, list files, and run a command to see what the code does
 * (a CLI, a script, an API call against a local server, the project's tests).
 *
 * It is deliberately thin. Every tool is a hook into AgentTools, which already
 * owns the safety rules, so QA is held to exactly what the Editor is held to:
 *   - files: sensitive files (.env, keys) and blocked directories are refused;
 *   - commands: denied programs, paths outside the project, the home
 *     directory, native binaries and dependency adds are refused or asked
 *     about first, with a timeout and no re-running an unchanged failure.
 * On top of that, whatever a tool returns is scrubbed for obvious secrets
 * before the model sees it, because output can contain what files cannot.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { QaBackend, ToolSpec } from "./qaBrowserAgent.js";
import type { SerialHooks } from "./qaFirmware.js";

export interface ProjectToolHooks {
  repoRoot?: string;
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
  searchCode(pattern: string, subPath?: string): Promise<string>;
  listFiles(dir?: string): Promise<string>;
  runCommand(args: { command: string; cwd?: string; purpose?: string }): Promise<string>;
  /** Only on a firmware project with a serial-capable tool installed. Read-only. */
  serial?: SerialHooks;
}

const BROWSER_PACKAGES = ["playwright", "playwright-core", "puppeteer", "puppeteer-core", "cypress"] as const;

/**
 * Native, zero-shell browser-automation package check for QA. Replaces inline
 * `node -e "const a=['playwright','puppeteer',...]" ...` probes that previously
 * tripped the security panel and stalled waiting for human approval.
 */
export function detectInstalledBrowsers(repoRoot: string): {
  installed: string[];
  missing: string[];
  summary: string;
} {
  const installed: string[] = [];
  const missing: string[] = [];
  const req = createRequire(path.join(path.resolve(repoRoot), "package.json"));
  for (const pkg of BROWSER_PACKAGES) {
    let found = false;
    try {
      req.resolve(pkg);
      found = true;
    } catch {
      const direct = path.join(repoRoot, "node_modules", pkg, "package.json");
      if (fs.existsSync(direct)) found = true;
    }
    if (found) installed.push(pkg);
    else missing.push(pkg);
  }
  const summary =
    installed.length > 0
      ? `Installed browser automation package(s): ${installed.join(", ")}. Not installed: ${missing.join(", ") || "none"}.`
      : `No browser automation packages installed in this project (checked: ${BROWSER_PACKAGES.join(", ")}).`;
  return { installed, missing, summary };
}

/**
 * Detects read-only inline `node -e` / `node --eval` browser-availability probes
 * (e.g. checking whether playwright/puppeteer can be required) so projectBackend
 * can answer them natively without invoking the shell or security panel.
 */
export function isInlineBrowserProbeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!/^node(?:\.exe)?\s+(?:-e|--eval)\s+/i.test(trimmed)) return false;
  if (!/\b(playwright|puppeteer|cypress)\b/i.test(trimmed)) return false;
  // Reject anything that writes, spawns, networks, or chains shell commands.
  if (/\b(exec|spawn|fork|writeFile|unlink|rmSync|fetch|http|https|net|child_process)\b/i.test(trimmed)) return false;
  return /\b(require|resolve|import|playwright|puppeteer)\b/i.test(trimmed);
}

/** Masks values that look like credentials. Best effort, not a guarantee. */
export function redactSecrets(text: string): string {
  return text
    // Authorization: Bearer abc...
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    // key = value pairs whose key names a secret
    .replace(/((?:api[_-]?key|secret|token|passwd|password|authorization|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi, "$1[redacted]")
    // well-known token shapes
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[redacted]")
    // PEM private keys
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
}

const MAX_OUT = 3000;

const PROJECT_TOOLS: ToolSpec[] = [
  { name: "read_file", args: '{"path":string,"startLine"?:number,"endLine"?:number}', does: "Read a file in the project. Sensitive files (.env, keys) are refused." },
  { name: "search_code", args: '{"pattern":string,"path"?:string}', does: "Search the project's code for a pattern." },
  { name: "list_files", args: '{"path"?:string}', does: "List files in a project directory." },
  {
    name: "run_command",
    args: '{"command":string,"cwd"?:string,"purpose":string}',
    does: "Run ONE command in the project to see what the code does: run the tool you are checking with sample input, run a script, run the project's tests, or call a local server. It runs under the same safety rules the engineer is held to: harmful or out-of-project commands are refused, anything that has not been approved asks the user first, and it times out. Do not try to get around a refusal. Output is shown to you with secrets masked.",
  },
];

const BROWSER_TOOLS: ToolSpec[] = [
  {
    name: "check_browser_tools",
    args: "{}",
    does: "Check natively (without running a shell command) which headless browser packages (playwright, puppeteer, cypress) are installed in this project.",
  },
];

const SERIAL_TOOLS: ToolSpec[] = [
  { name: "list_serial_ports", args: "{}", does: "List the serial ports and boards currently attached to this computer. An empty list means no board is plugged in." },
  {
    name: "read_serial",
    args: '{"port":string,"baud"?:number,"seconds"?:number}',
    does: "Listen to a board's serial output for a few seconds (1-30) and return what it printed. Read-only: nothing is sent to the board and nothing is flashed. Opening the port often reboots the board, so you will usually see its boot log first.",
  },
];

export function projectBackend(hooks: ProjectToolHooks): QaBackend {
  const out = (note: string, text: string) => ({ evidence: note, text: redactSecrets(String(text)).slice(0, MAX_OUT) });
  const tools = [
    ...PROJECT_TOOLS,
    ...(hooks.repoRoot ? BROWSER_TOOLS : []),
    ...(hooks.serial ? SERIAL_TOOLS : []),
  ];
  return {
    kind: "project",
    tools,
    state: () => ({ viewport: "", conditions: [] }),
    async run(tool, args) {
      if (tool === "read_file") {
        const p = String(args.path ?? "").slice(0, 300);
        if (!p) throw new Error("path is required");
        const start = Number.isFinite(args.startLine) ? Number(args.startLine) : undefined;
        const end = Number.isFinite(args.endLine) ? Number(args.endLine) : undefined;
        return out(`file ${p}`, await hooks.readFile(p, start, end));
      }
      if (tool === "search_code") {
        const pattern = String(args.pattern ?? "").slice(0, 200);
        if (!pattern) throw new Error("pattern is required");
        return out(`search "${pattern}"`, await hooks.searchCode(pattern, args.path ? String(args.path).slice(0, 300) : undefined));
      }
      if (tool === "list_files") {
        return out(`files ${args.path ? String(args.path).slice(0, 300) : "."}`, await hooks.listFiles(args.path ? String(args.path).slice(0, 300) : undefined));
      }
      if (tool === "check_browser_tools") {
        const result = detectInstalledBrowsers(hooks.repoRoot ?? process.cwd());
        return out("browser tools check", result.summary);
      }
      if (tool === "run_command") {
        const command = String(args.command ?? "").slice(0, 600);
        if (!command.trim()) throw new Error("command is required");
        if (isInlineBrowserProbeCommand(command)) {
          const result = detectInstalledBrowsers(hooks.repoRoot ?? process.cwd());
          return out("browser tools check (native)", result.summary);
        }
        return out(
          `command ${command.slice(0, 120)}`,
          await hooks.runCommand({
            command,
            cwd: args.cwd ? String(args.cwd).slice(0, 300) : undefined,
            purpose: String(args.purpose ?? "check the requirement").slice(0, 200),
          })
        );
      }
      if (tool === "list_serial_ports" && hooks.serial) {
        return out("serial ports", await hooks.serial.listPorts());
      }
      if (tool === "read_serial" && hooks.serial) {
        const port = String(args.port ?? "");
        return out(`serial ${port}`, await hooks.serial.read({ port, baud: Number(args.baud) || undefined, seconds: Number(args.seconds) || undefined }));
      }
      throw new Error("unknown tool");
    },
  };
}
