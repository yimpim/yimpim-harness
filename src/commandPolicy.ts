/**
 * Generic command policy for model-chosen commands.
 *
 * The harness used to need a table row for every ecosystem it could run
 * something for, so each new stack or layout meant a patch. This module
 * separates the two things that table conflated:
 *
 *   - KNOWLEDGE ("what do I run for this project?") belongs to the model.
 *   - POLICY ("is this allowed to run?") belongs here, and has nothing to
 *     say about any particular ecosystem.
 *
 * What it enforces, for every command from `run_project_command`:
 *   1. The command is parsed into argv and never reaches a shell: chaining,
 *      pipes, redirects, substitution and newlines are refused, not
 *      interpreted.
 *   2. The working directory, and every path-looking argument, stays inside
 *      the repo.
 *   3. Privilege escalation, interpreters-as-shells, system configuration
 *      and remote-access tools are refused outright; file deletion has its
 *      own staged, confirmed path and is refused here.
 *   4. Everything else needs the user's approval ONCE per exact
 *      (argv, directory) for this repo; approving remembers it. A command
 *      that downloads-and-executes, runs inline code, fetches from the
 *      network, or launches a native program (one outside the repo, or a
 *      compiled .exe inside it, which no script fingerprint can vouch for)
 *      is "elevated": it is asked about every time and never remembered.
 *
 * Approvals live in the user's home directory, keyed by repo path, and NEVER
 * inside the repo: a repo-local approvals file would let a cloned repository
 * arrive pre-approved.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ambientFamilyFor, type AmbientFamily } from "./ambientHooks.js";

export type CommandRisk = "normal" | "elevated";

export type CommandDecision =
  | { verdict: "deny"; reason: string }
  | {
      /** "allow" = this exact command was approved before for this repo. */
      verdict: "allow" | "ask";
      argv: string[];
      /** Absolute working directory (inside the repo). */
      cwd: string;
      /** Working directory relative to the repo root ("" = the root). */
      cwdRel: string;
      risk: CommandRisk;
      /** Why it is elevated, when it is. */
      elevatedBecause?: string;
      /** Launches a native program by path (see nativeProgramReason). */
      nativeProgram?: boolean;
      /**
       * Hash of the project files this command would execute (package.json
       * scripts, build files, a repo-local script). Part of the approval, so
       * editing what an approved command runs invalidates the approval.
       */
      fingerprint: string;
      /** Approved before, but files the command runs have changed since. */
      changedSinceApproval?: boolean;
      /** Packages this command adds (cleared by request_dependency first). */
      addsPackages?: string[];
    };

// --------------------------------------------------------------- tokenizing

/**
 * Splits a command line into argv WITHOUT a shell. Quotes group words and
 * everything inside them is literal. An unquoted shell metacharacter is an
 * error rather than something to interpret: the model is told to issue
 * separate calls instead of chaining.
 */
export function tokenizeCommand(command: string): { argv: string[] } | { error: string } {
  const src = String(command ?? "").trim();
  if (!src) return { error: "the command is empty" };
  if (/[\r\n]/.test(src)) return { error: "multi-line commands are not allowed; issue one command per call" };

  const argv: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        argv.push(cur);
        cur = "";
        inToken = false;
      }
      continue;
    }
    if ("|&;<>`".includes(ch)) {
      return {
        error: `"${ch}" is a shell operator and commands are not run through a shell; issue one plain command per call`,
      };
    }
    if (ch === "$" && (src[i + 1] === "(" || src[i + 1] === "{")) {
      return { error: "command substitution is not supported; issue one plain command per call" };
    }
    cur += ch;
    inToken = true;
  }
  if (quote) return { error: "unterminated quote" };
  if (inToken) argv.push(cur);
  if (argv.length === 0) return { error: "the command is empty" };
  return { argv };
}

// ------------------------------------------------------------ classification

/** Executable basename, lower-cased, without a Windows executable extension. */
export function executableName(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? argv0;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

const DENIED: Record<string, string> = {};
function deny(names: string[], why: string): void {
  for (const n of names) DENIED[n] = why;
}
deny(
  ["sudo", "su", "doas", "runas", "pkexec", "gsudo"],
  "privilege escalation is never allowed; if something needs administrator rights, tell the user to run it themselves"
);
deny(
  ["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh", "wsl", "conhost"],
  "a shell would bypass this policy; run the real tool directly (for example `npm install`, not `bash -c ...`)"
);
deny(
  ["rm", "del", "erase", "rmdir", "rd", "unlink", "shred", "trash"],
  "deleting files from a command is not allowed; use stage_file_for_deletion, which the user confirms"
);
deny(
  ["mkfs", "dd", "format", "diskpart", "fdisk", "shutdown", "reboot", "halt", "poweroff", "init"],
  "this changes the machine itself and is never allowed"
);
deny(
  [
    "reg", "regedit", "sc", "schtasks", "crontab", "launchctl", "systemctl", "service",
    "setx", "net", "netsh", "icacls", "takeown", "chown", "chgrp", "chmod", "attrib",
    "kill", "killall", "pkill", "taskkill", "mount", "umount", "iptables", "ufw",
  ],
  "this changes system configuration or other processes and is never allowed"
);
deny(
  ["ssh", "scp", "sftp", "ftp", "telnet", "nc", "ncat", "netcat", "rsync"],
  "remote access and transfer tools are not allowed"
);

/** Fetches over the network: allowed, but asked about every time. */
const NETWORK_TOOLS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "aria2c"]);

/** Interpreters whose inline-code flag runs text the model made up. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  py: ["-c"],
  pythonw: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  nodejs: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e"],
};

/** Runners that download a package and execute it in one step. */
const REMOTE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "dlx"]);
const REMOTE_RUNNER_SUBCOMMANDS: Array<[string, string]> = [
  ["npm", "exec"],
  ["pnpm", "dlx"],
  ["pnpm", "exec"],
  ["yarn", "dlx"],
  ["pipx", "run"],
  ["bun", "x"],
  ["uv", "tool"],
];

/**
 * `npx jest`, `npm exec tsc`, `pnpm exec vitest`: when the program named is already installed in the project
 * (node_modules/.bin), the runner just starts it, the same as `npm test` does, and downloads nothing. Only that case is
 * recognised; a version (`jest@29`), a scoped or path name, `--package` / `--call`, or a program that is not installed
 * is still a download.
 */
export function runsInstalledBinary(argv: string[], cwd: string, repoRoot: string): boolean {
  return installedBinaryName(argv, cwd, repoRoot) !== undefined;
}

/** The program `npx X` / `npm exec X` would start, when it is already installed in the project; otherwise undefined. */
export function installedBinaryName(argv: string[], cwd: string, repoRoot: string): string | undefined {
  const exe = executableName(argv[0]);
  const sub = argv[1]?.toLowerCase();
  const viaExec = (exe === "npm" || exe === "pnpm") && sub === "exec";
  if (exe !== "npx" && !viaExec) return undefined;
  const rest = argv.slice(viaExec ? 2 : 1);
  let bin: string | undefined;
  for (const a of rest) {
    if (a === "--") continue;
    if (/^(-p|--package|-c|--call)(=|$)/.test(a)) return undefined;
    if (a.startsWith("-")) continue;
    bin = a;
    break;
  }
  if (!bin || !/^[A-Za-z0-9._-]+$/.test(bin)) return undefined;
  const root = path.resolve(repoRoot);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (dir !== root && !dir.startsWith(root + path.sep)) return undefined;
    for (const name of [bin, `${bin}.cmd`]) {
      try {
        if (fs.statSync(path.join(dir, "node_modules", ".bin", name)).isFile()) return bin;
      } catch {
        // not here
      }
    }
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
  return undefined;
}

function elevatedReason(argv: string[], cwd: string, repoRoot: string): string | undefined {
  const exe = executableName(argv[0]);
  if (runsInstalledBinary(argv, cwd, repoRoot)) return undefined;
  if (NETWORK_TOOLS.has(exe)) return "it fetches data over the network";
  const flags = INLINE_CODE_FLAGS[exe];
  if (flags && argv.slice(1).some((a) => flags.includes(a))) {
    return "it runs inline code written by the model, not a file in your project";
  }
  if (REMOTE_RUNNERS.has(exe)) return "it downloads a package and runs it in one step";
  const sub = argv[1]?.toLowerCase();
  if (sub && REMOTE_RUNNER_SUBCOMMANDS.some(([e, s]) => e === exe && s === sub)) {
    return "it downloads a package and runs it in one step";
  }
  return undefined;
}

/** Compiled programs: their bytes change on every build and no text fingerprint covers them. */
const NATIVE_BINARY = /\.(exe|com|scr|msi)$/i;

/**
 * Launching a program by path that the project's own files do not define:
 * an absolute path outside the repo (a tool somebody installed, possibly
 * tampered with), or a compiled binary inside it (built by something, possibly
 * infected). Bare names resolved through PATH are not covered here.
 */
function nativeProgramReason(argv: string[], cwd: string, repoRoot: string): string | undefined {
  const arg0 = argv[0];
  if (!/[\\/]/.test(arg0)) return undefined;
  const absolute = path.isAbsolute(arg0) || /^[A-Za-z]:[\\/]/.test(arg0);
  if (absolute && !isInsideRoot(repoRoot, path.resolve(cwd, arg0))) {
    return "it runs a program from outside the project, whose contents nothing here can verify";
  }
  if (NATIVE_BINARY.test(arg0)) {
    return "it runs a compiled program from the project, whose contents nothing here can verify";
  }
  return undefined;
}

/**
 * Facts a person can check before approving a native program: its SHA-256
 * (look it up, or compare with the vendor's published value) and, on Windows,
 * whether it carries a valid Authenticode signature. Never throws. A hash proves
 * which file this is, not that it is safe; an unsigned build output is normal.
 */
export async function describeBinary(
  file: string,
  opts: { platform?: NodeJS.Platform; signature?: (file: string) => Promise<string | undefined> } = {}
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  let hash: string;
  try {
    const h = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
    hash = h.digest("hex");
  } catch (err: any) {
    return `  Could not read ${file} to hash it: ${err?.code ?? err?.message ?? err}`;
  }
  const lines = [`  File: ${file}`, `  SHA-256: ${hash}`];
  if (platform === "win32") {
    const sig = await (opts.signature ?? authenticodeStatus)(file).catch(() => undefined);
    lines.push(`  Signature: ${sig ?? "could not be checked"}`);
  }
  return lines.join("\n");
}

async function authenticodeStatus(file: string): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:YIMPIM_BIN; " +
    "if ($s.SignerCertificate) { $s.Status.ToString() + ' (' + $s.SignerCertificate.Subject + ')' } else { $s.Status.ToString() }";
  // A PSModulePath inherited from PowerShell 7 stops Windows PowerShell from loading its security module.
  const { PSModulePath: _inherited, ...env } = process.env;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000, windowsHide: true, env: { ...env, YIMPIM_BIN: file } },
      (err, stdout) => resolve(err ? undefined : String(stdout).trim().replace(/^NotSigned$/, "NotSigned (unsigned)") || undefined)
    );
  });
}

// ---------------------------------------------------------------- containment

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `target` is `root` or lives under it (symlinks resolved where the path exists). */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(realOrResolved(root), realOrResolved(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A token that names a filesystem location, as opposed to a flag, a
 * package spec (`@scope/pkg`, `pkg@1.2.3`), a URL, or a plain word.
 */
function pathLike(token: string, platform: NodeJS.Platform): boolean {
  if (!token || token.includes("://") || token.startsWith("@")) return false;
  if (token.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\")) return true;
  if (token.startsWith("/")) {
    // `cmd /c`-style switches are not paths.
    if (platform === "win32" && /^\/[A-Za-z?]$/.test(token)) return false;
    return true;
  }
  return token === ".." || /(^|[\\/])\.\.([\\/]|$)/.test(token);
}

/** Every argument's path-looking value, including the right side of `--flag=value`. */
function pathCandidates(arg: string, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  if (pathLike(arg, platform)) out.push(arg);
  const eq = arg.indexOf("=");
  if (arg.startsWith("-") && eq > 0) {
    const value = arg.slice(eq + 1);
    if (pathLike(value, platform)) out.push(value);
  }
  return out;
}

// ------------------------------------------------------------------ approvals

interface ApprovalEntry {
  key: string;
  argv: string[];
  cwdRel: string;
  approvedAt: string;
  lastUsedAt: string;
  /** Last time this exact command (and fingerprint) exited 0. */
  lastOkAt?: string;
}
interface ApprovalFile {
  version: 1;
  repos: Record<string, ApprovalEntry[]>;
}

const MAX_APPROVALS_PER_REPO = 200;

export function approvalsFilePath(): string {
  return process.env.YIMPIM_APPROVALS_FILE || path.join(os.homedir(), ".yimpim", "command-approvals.json");
}

function repoKey(repoRoot: string): string {
  const abs = realOrResolved(repoRoot);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function entryKey(argv: string[], cwdRel: string, fingerprint = ""): string {
  const base: unknown[] = [argv, cwdRel.replace(/\\/g, "/")];
  if (fingerprint) base.push(fingerprint);
  return JSON.stringify(base);
}

/**
 * Per-user, per-repo record of commands the user already approved. Matches
 * the exact argv and directory only: approving `npm install` does not
 * approve `npm install some-other-package`.
 */
export class CommandApprovals {
  private data: ApprovalFile | undefined;

  constructor(private readonly file: string = approvalsFilePath()) {}

  private load(): ApprovalFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.version === 1 && parsed.repos && typeof parsed.repos === "object") {
        this.data = parsed as ApprovalFile;
        return this.data;
      }
      throw new Error("bad shape");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        // Unreadable: keep it for inspection, start clean. Never throws.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* best effort */
        }
      }
      this.data = { version: 1, repos: {} };
      return this.data;
    }
  }

  private save(): void {
    if (!this.data) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err: any) {
      console.warn(`[POLICY] Could not save command approvals: ${err?.message ?? err}`);
    }
  }

  isApproved(repoRoot: string, argv: string[], cwdRel: string, fingerprint = ""): boolean {
    const list = this.load().repos[repoKey(repoRoot)] ?? [];
    const key = entryKey(argv, cwdRel, fingerprint);
    return list.some((e) => e.key === key);
  }

  remember(repoRoot: string, argv: string[], cwdRel: string, fingerprint = ""): void {
    const data = this.load();
    const rk = repoKey(repoRoot);
    const list = (data.repos[rk] ??= []);
    const key = entryKey(argv, cwdRel, fingerprint);
    const now = new Date().toISOString();
    const existing = list.find((e) => e.key === key);
    if (existing) {
      existing.lastUsedAt = now;
    } else {
      list.push({ key, argv, cwdRel: cwdRel.replace(/\\/g, "/"), approvedAt: now, lastUsedAt: now });
      if (list.length > MAX_APPROVALS_PER_REPO) {
        list.sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
        list.splice(0, list.length - MAX_APPROVALS_PER_REPO);
      }
    }
    this.save();
  }

  /** Records that an approved command exited 0 (never called for elevated commands). */
  markSucceeded(repoRoot: string, argv: string[], cwdRel: string, fingerprint = ""): void {
    const list = this.load().repos[repoKey(repoRoot)] ?? [];
    const hit = list.find((e) => e.key === entryKey(argv, cwdRel, fingerprint));
    if (!hit) return;
    hit.lastOkAt = new Date().toISOString();
    this.save();
  }

  /** Commands that have exited 0 in this repo, most recent first. */
  listSucceeded(repoRoot: string, limit = 20): Array<{ argv: string[]; cwdRel: string; lastOkAt: string }> {
    return (this.load().repos[repoKey(repoRoot)] ?? [])
      .filter((e) => e.lastOkAt)
      .sort((a, b) => String(b.lastOkAt).localeCompare(String(a.lastOkAt)))
      .slice(0, limit)
      .map((e) => ({ argv: e.argv, cwdRel: e.cwdRel, lastOkAt: String(e.lastOkAt) }));
  }

  /**
   * True when some command already approved in this directory, under this very
   * fingerprint, belongs to `family`. The fingerprint is the last element of the
   * stored key, so an approval made before the scripts changed never matches.
   */
  isFamilyApproved(repoRoot: string, cwdRel: string, fingerprint: string, family: (argv: string[]) => boolean): boolean {
    if (!fingerprint) return false;
    const rel = cwdRel.replace(/\\/g, "/");
    return (this.load().repos[repoKey(repoRoot)] ?? []).some((e) => {
      if (e.cwdRel !== rel || !family(e.argv)) return false;
      try {
        return JSON.parse(e.key)[2] === fingerprint;
      } catch {
        return false;
      }
    });
  }

  /** True when this argv/directory was approved before under a different fingerprint. */
  approvedBeforeWithDifferentFiles(repoRoot: string, argv: string[], cwdRel: string): boolean {
    const rel = cwdRel.replace(/\\/g, "/");
    const want = JSON.stringify(argv);
    return (this.load().repos[repoKey(repoRoot)] ?? []).some(
      (e) => JSON.stringify(e.argv) === want && e.cwdRel === rel
    );
  }

  /**
   * Forgets one approval (1-based position in `list()`) or all of them for a
   * repo. Returns how many were removed.
   */
  revoke(repoRoot: string, which: number | "all"): number {
    const data = this.load();
    const rk = repoKey(repoRoot);
    const list = data.repos[rk] ?? [];
    let removed = 0;
    if (which === "all") {
      removed = list.length;
      delete data.repos[rk];
    } else if (Number.isInteger(which) && which >= 1 && which <= list.length) {
      list.splice(which - 1, 1);
      removed = 1;
    }
    if (removed > 0) this.save();
    return removed;
  }

  /** Approved commands for a repo, for display. */
  list(repoRoot: string): Array<{ argv: string[]; cwdRel: string; approvedAt: string }> {
    return (this.load().repos[repoKey(repoRoot)] ?? []).map(({ argv, cwdRel, approvedAt }) => ({ argv, cwdRel, approvedAt }));
  }
}

// ----------------------------------------------------------------- evaluation

export interface EvaluateOptions {
  repoRoot: string;
  /** Working directory, relative to the repo root. Defaults to the root. */
  cwd?: string;
  approvals?: CommandApprovals;
  platform?: NodeJS.Platform;
  /** Lower-cased package names request_dependency has cleared this session. */
  clearedPackages?: ReadonlySet<string>;
  /** Files and directories the agent created this session. */
  agentCreated?: AgentCreated;
}

/** Characters cmd.exe re-interprets in arguments passed to a .cmd/.bat file. */
const WINDOWS_BATCH_META = /[&|<>^%!]/;

export function evaluateCommand(command: string, opts: EvaluateOptions): CommandDecision {
  const platform = opts.platform ?? process.platform;
  const tokens = tokenizeCommand(command);
  if ("error" in tokens) return { verdict: "deny", reason: tokens.error };
  const { argv } = tokens;

  const exe = executableName(argv[0]);
  if (DENIED[exe]) return { verdict: "deny", reason: `\`${exe}\`: ${DENIED[exe]}` };
  const add = analyzePackageAdd(argv);
  if (add) {
    const uncleared = add.names.filter((n) => !opts.clearedPackages?.has(n.toLowerCase()));
    if (uncleared.length > 0) {
      return {
        verdict: "deny",
        reason:
          `\`${exe}\` would add "${uncleared[0]}", which has not been checked: call request_dependency for it ` +
          `first (name, reason) so its existence, age and advisories are verified, then run the add command`,
      };
    }
    if (add.missingFlag) {
      return {
        verdict: "deny",
        reason: `adding a package must not run its install scripts: add ${add.missingFlag} to the command`,
      };
    }
  }

  const repoRoot = path.resolve(opts.repoRoot);
  const cwd = opts.cwd ? path.resolve(repoRoot, opts.cwd) : repoRoot;
  if (!isInsideRoot(repoRoot, cwd)) {
    return { verdict: "deny", reason: `the working directory "${opts.cwd}" is outside the project` };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {
    /* handled below */
  }
  if (!isDir) return { verdict: "deny", reason: `the working directory "${opts.cwd ?? "."}" does not exist` };

  // A relative executable path (./gradlew, android/gradlew.bat) must be ours.
  if (/[\\/]/.test(argv[0]) && !path.isAbsolute(argv[0]) && !isInsideRoot(repoRoot, path.resolve(cwd, argv[0]))) {
    return { verdict: "deny", reason: `"${argv[0]}" points outside the project` };
  }

  for (const arg of argv.slice(1)) {
    if (platform === "win32" && WINDOWS_BATCH_META.test(arg)) {
      return {
        verdict: "deny",
        reason: `the argument "${arg}" contains a character Windows would re-interpret (& | < > ^ % !); remove it`,
      };
    }
    for (const candidate of pathCandidates(arg, platform)) {
      if (candidate.startsWith("~")) {
        return { verdict: "deny", reason: `"${candidate}" refers to the home directory; keep paths inside the project` };
      }
      if (!isInsideRoot(repoRoot, path.resolve(cwd, candidate))) {
        return { verdict: "deny", reason: `"${candidate}" is outside the project; keep paths inside it` };
      }
    }
  }

  const cwdRel = path.relative(repoRoot, cwd).replace(/\\/g, "/");
  if (add) {
    // Cleared by request_dependency, but still a change to the project's
    // dependencies: asked every time, never remembered.
    return {
      verdict: "ask",
      argv,
      cwd,
      cwdRel,
      risk: "elevated",
      elevatedBecause:
        (add.names.length > 0
          ? `it adds ${add.names.join(", ")} to the project (name checked by request_dependency; the version that lands is checked afterwards)`
          : "") +
        (add.sources.length > 0
          ? `${add.names.length > 0 ? "; and " : "it "}installs from ${add.sources.join(", ")}, which no registry vouches for — check the source yourself`
          : ""),
      fingerprint: "",
      addsPackages: add.names.length > 0 ? add.names : undefined,
    };
  }
  const nativeReason = nativeProgramReason(argv, cwd, repoRoot);
  const elevatedBecause = elevatedReason(argv, cwd, repoRoot) ?? nativeReason;
  if (elevatedBecause) {
    return {
      verdict: "ask",
      argv,
      cwd,
      cwdRel,
      risk: "elevated",
      elevatedBecause,
      fingerprint: "",
      ...(nativeReason ? { nativeProgram: true } : {}),
    };
  }
  const fingerprint = commandFingerprint(argv, cwd, repoRoot, opts.agentCreated);
  // The project's own test run is one approval, not one per flag or file list:
  // once any form of it has been approved, every other form is allowed for as
  // long as the files it runs (package.json scripts, test config) are unchanged.
  // Editing the script changes the fingerprint, so it asks again.
  const testFamilyApproved =
    isProjectTestRun(argv, cwd) &&
    (opts.approvals?.isFamilyApproved(repoRoot, cwdRel, fingerprint, (a) => isProjectTestRun(a, cwd)) ?? false);
  // A test or check that only runs the project's own code needs no approval, unless the agent created files this run would
  // load on its own (hidden files, setup hooks): those still bind the fingerprint and ask.
  const autoSafe =
    isAutoSafeRun(argv, cwd, repoRoot) &&
    fingerprint === commandFingerprint(argv, cwd, repoRoot, { files: [], dirs: [], trusted: opts.agentCreated?.trusted });
  const remembered = autoSafe || testFamilyApproved || (opts.approvals?.isApproved(repoRoot, argv, cwdRel, fingerprint) ?? false);
  const changedSinceApproval =
    !remembered && (opts.approvals?.approvedBeforeWithDifferentFiles(repoRoot, argv, cwdRel) ?? false);
  return {
    verdict: remembered ? "allow" : "ask",
    argv,
    cwd,
    cwdRel,
    risk: "normal",
    fingerprint,
    ...(changedSinceApproval ? { changedSinceApproval: true } : {}),
  };
}

// ------------------------------------------------- runs that need no approval

/** Installed programs that only test, type-check, lint or build the project they sit in. */
const SAFE_PROJECT_TOOLS = new Set(["jest", "vitest", "mocha", "ava", "jasmine", "tsc", "eslint", "tap"]);
/** node flags that only change how a file is read or reported; none loads other code (--import, --require, -e are not here). */
const SAFE_NODE_FLAGS = new Set(["--experimental-strip-types", "--experimental-transform-types", "--no-warnings", "--test", "--enable-source-maps"]);
const TEST_FILE = /(^|[\/])(__tests__|tests?)[\/].+.[cm]?[jt]sx?$|[.-_](test|spec).[cm]?[jt]sx?$/i;
const PY_TEST_FILE = /(^|[\/])(test_[^\/]*|[^\/]*_test).py$/i;
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "shortlog", "describe", "diff-tree", "cat-file"]);
/** Flags that make an otherwise read-only git command write a file, run a program, or open a pager/editor. */
const GIT_UNSAFE_FLAG = /^(--output|--exec|--ext-diff|--textconv|--open-files-in-pager|--upload-pack|--receive-pack|-O|-o|--git-dir|--work-tree|--no-index)(=|$)/;

/** Read-only git: looking at the repo's state or history, with no configuration override and no way to write or run anything. */
function isReadOnlyGit(rest: string[]): boolean {
  const [sub, ...args] = rest;
  if (!sub) return false;
  if (sub === "remote") return args.length === 0 || (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose"));
  if (sub === "branch") return args.every((a) => ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"].includes(a));
  if (!READ_ONLY_GIT.has(sub)) return false;
  return !args.some((a) => GIT_UNSAFE_FLAG.test(a));
}

/**
 * Commands that run only the project's own tests or checks, with nothing that fetches, installs or runs code written into
 * the command itself. The agent can already write a test file and run it, so asking about these protects nothing and costs
 * the person a decision they cannot judge. True for:
 *   - an installed test / type-check / lint tool (npx jest ..., npm exec tsc ..., pnpm exec vitest ...);
 *   - node on a test file in the project, with only harmless flags (node --experimental-strip-types a.test.ts, node --test);
 *   - python on a test file, or python -m unittest;
 *   - a bare program asked only for its version or help.
 * Everything else, including every other script, still follows the normal approval rules.
 */
export function isAutoSafeRun(argv: string[], cwd: string, repoRoot: string): boolean {
  const exe = executableName(argv[0]);
  const rest = argv.slice(1);
  const isFile = (a: string) => {
    try {
      return fs.statSync(path.resolve(cwd, a)).isFile();
    } catch {
      return false;
    }
  };
  const isDirectory = (a: string) => {
    try {
      return fs.statSync(path.resolve(cwd, a)).isDirectory();
    } catch {
      return false;
    }
  };

  const bin = installedBinaryName(argv, cwd, repoRoot);
  if (bin) return SAFE_PROJECT_TOOLS.has(bin.toLowerCase());

  if (rest.length === 1 && VERSION_FLAGS.has(rest[0]) && !/[\/]/.test(argv[0])) return true;

  if (exe === "git") return isReadOnlyGit(rest);

  if (exe === "node") {
    const files: string[] = [];
    for (const a of rest) {
      if (a === "--") continue;
      if (a.startsWith("-")) {
        if (!SAFE_NODE_FLAGS.has(a.split("=")[0]) || a.includes("=")) return false;
        continue;
      }
      files.push(a);
    }
    const wantsTests = rest.includes("--test");
    if (files.length === 0) return wantsTests;
    // The first name is the script (or, with --test, a file or folder of tests); anything after is its own arguments.
    const script = files[0];
    if (wantsTests && isDirectory(script)) return files.slice(1).every((a) => !a.startsWith("-"));
    return TEST_FILE.test(script) && isFile(script);
  }

  if (/^python3?(.d+)?$|^py$/.test(exe)) {
    const args = rest.filter((a) => a !== "-u" && a !== "-B");
    if (args[0] === "-m" && args[1] === "unittest") return args.slice(2).every((a) => /^[A-Za-z0-9_.\/-]+$/.test(a));
    return args.length >= 1 && !args[0].startsWith("-") && PY_TEST_FILE.test(args[0]) && isFile(args[0]);
  }
  return false;
}

// ----------------------------------------------------------- test runs

/**
 * True for the project's OWN test run, in the narrow forms that cannot do
 * anything else:
 *   - npm/pnpm/yarn/bun `test` or `run test` when package.json defines a `test`
 *     script, with nothing after it except an optional `--` and arguments for
 *     the test script (anything between the script name and `--` could be a
 *     package-manager option such as --script-shell, so it is refused);
 *   - pytest / python -m pytest when the project is configured for pytest;
 *   - cargo test and go test.
 * Anything else, including every other `npm run <script>`, still asks.
 */
export function isProjectTestRun(argv: string[], cwd: string): boolean {
  const exe = executableName(argv[0]);
  const rest = argv.slice(1);
  const has = (f: string) => fs.existsSync(path.join(cwd, f));

  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    let tail: string[];
    if (rest[0] === "test") tail = rest.slice(1);
    else if ((rest[0] === "run" || rest[0] === "run-script") && rest[1] === "test") tail = rest.slice(2);
    else return false;
    if (tail.length > 0 && tail[0] !== "--") return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      return typeof pkg?.scripts?.test === "string" && pkg.scripts.test.trim().length > 0;
    } catch {
      return false;
    }
  }
  const pytestConfigured = has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tox.ini") || has("conftest.py");
  if (exe === "pytest") return pytestConfigured;
  if (/^python3?(\.\d+)?$/.test(exe) && rest[0] === "-m" && rest[1] === "pytest") return pytestConfigured;
  if (exe === "cargo" && rest[0] === "test") return has("Cargo.toml");
  if (exe === "go" && rest[0] === "test") return has("go.mod");
  return false;
}

// ---------------------------------------------------- installs and fingerprints

/** Verbs that add a NAMED package, by executable. Data, not logic. */
const ADD_VERBS: Record<string, string[]> = {
  npm: ["install", "i", "add"],
  pnpm: ["install", "i", "add"],
  bun: ["install", "i", "add"],
  yarn: ["add"],
  expo: ["install"],
  pip: ["install"],
  pip3: ["install"],
  uv: ["add"],
  poetry: ["add"],
  cargo: ["add"],
  go: ["get"],
  composer: ["require"],
  bundle: ["add"],
  gem: ["install"],
};
/** Flags whose next argument is a value, not a package. */
const VALUE_FLAGS = new Set([
  "-r", "--requirement", "-c", "--constraint", "--prefix", "--target", "--cwd", "-i", "--index-url",
  "--extra-index-url", "--registry", "--only-binary", "--no-binary", "--workspace", "-w", "-p", "--package",
]);

export interface PackageAdd {
  exe: string;
  names: string[];
  /** Non-registry sources (git URLs, local paths, archives): no registry can vouch for them. */
  sources: string[];
  /** A flag that must be present for the add to be allowed (script-skipping). */
  missingFlag?: string;
}

/**
 * A git URL, a local path, an archive/wheel/jar, or npm's `user/repo` and
 * `github:` shorthands: code no registry vouches for.
 */
function isNonRegistrySource(exe: string, a: string): boolean {
  if (/^(\.{1,2}([\\/]|$)|[\\/]|~[\\/])/.test(a) || /^[A-Za-z]:[\\/]/.test(a) || a.includes("://")) return true;
  if (/^(git\+|git:|git@|ssh:|file:|link:|portal:|workspace:|patch:|github:|gitlab:|bitbucket:|gist:)/i.test(a)) return true;
  // `name@git+…`, `name @ https://…` (PEP 508), `name@github:user/repo`.
  if (/@\s*(git\+|git:|ssh:|file:|link:|github:|gitlab:|bitbucket:|https?:)/i.test(a)) return true;
  if (/\.(tgz|tar\.gz|tar|zip|whl|aar|jar|nupkg|crate|gem)(#|$)/i.test(a)) return true;
  // Node managers: a slash without a leading `@scope/` is a GitHub shorthand or a path.
  if (["npm", "pnpm", "bun", "yarn", "expo"].includes(exe) && !a.startsWith("@") && a.includes("/")) return true;
  return false;
}

function stripVersionSpec(exe: string, arg: string): string {
  if (arg.startsWith("@")) {
    const at = arg.indexOf("@", 1);
    return at > 0 ? arg.slice(0, at) : arg;
  }
  if (["pip", "pip3", "uv", "poetry"].includes(exe)) return arg.split(/[=<>!~\[;]/)[0];
  return arg.split("@")[0];
}

/**
 * Recognises "add this named package" in any of the common managers. Returns
 * undefined for everything else, including `npm install` with no names.
 */
export function analyzePackageAdd(argv: string[]): PackageAdd | undefined {
  let exe = executableName(argv[0]);
  let rest = argv.slice(1);
  if (/^python3?(\.\d+)?$/.test(exe) && rest[0] === "-m" && rest[1] === "pip") {
    exe = "pip";
    rest = rest.slice(2);
  }
  if (exe === "npx" && rest[0] === "expo") {
    exe = "expo";
    rest = rest.slice(1);
  }
  let verb: string | undefined;
  let after: string[];
  if (exe === "dotnet" && rest[0] === "add" && rest.includes("package")) {
    verb = "package";
    after = rest.slice(rest.indexOf("package") + 1);
  } else if ((exe === "flutter" || exe === "dart") && rest[0] === "pub" && rest[1] === "add") {
    verb = "add";
    after = rest.slice(2);
  } else {
    const verbs = ADD_VERBS[exe];
    if (!verbs) return undefined;
    const idx = rest.findIndex((a) => !a.startsWith("-"));
    if (idx === -1 || !verbs.includes(rest[idx])) return undefined;
    verb = rest[idx];
    after = rest.slice(idx + 1);
  }

  const names: string[] = [];
  const sources: string[] = [];
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    // Flags that point the install somewhere other than the default registry:
    // the value is a source no name check covers.
    const redirect = a.match(/^(--git|--path|--registry|--[\w@/.-]+:registry|--index-url|--extra-index-url|--find-links|--editable|--index|--tag|--branch|--rev)=(.*)$/);
    if (redirect) {
      sources.push(`${redirect[1]}=${redirect[2]}`);
      continue;
    }
    if (/^(--git|--path|--registry|--index-url|--extra-index-url|--find-links|-f|-i|-e|--editable|--index)$/.test(a)) {
      sources.push(`${a} ${after[i + 1] ?? ""}`.trim());
      i++;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (isNonRegistrySource(exe, a)) {
      sources.push(a);
      continue;
    }
    const bare = stripVersionSpec(exe, a);
    if (bare) names.push(bare);
  }
  if (names.length === 0 && sources.length === 0) return undefined;

  let missingFlag: string | undefined;
  if (["npm", "pnpm", "bun", "yarn", "expo"].includes(exe) && !argv.includes("--ignore-scripts")) {
    missingFlag = "--ignore-scripts";
  }
  if (["pip", "pip3"].includes(exe)) {
    const joined = ` ${argv.join(" ")} `;
    if (!/--only-binary(=| )[:]all[:]/.test(joined)) missingFlag = "--only-binary=:all:";
  }
  void verb;
  return { exe, names, sources, ...(missingFlag ? { missingFlag } : {}) };
}

function sha(parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

function readIf(file: string): string | undefined {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

const AMBIENT_SKIP_DIRS = new Set([
  "node_modules", ".git", ".gradle", ".idea", "build", "dist", "out", "target", ".venv", "venv", "env",
  "__pycache__", "Pods", ".next", ".expo", ".dart_tool",
]);
const AMBIENT_MAX_VISITED = 6000;
const AMBIENT_MAX_FILES = 300;
const AMBIENT_MAX_FILE_BYTES = 256 * 1024;

function hashFileInto(h: crypto.Hash, rel: string, abs: string): void {
  let data: Buffer | undefined;
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(AMBIENT_MAX_FILE_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      data = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  h.update(rel).update("\0").update(data).update("\0");
}

function matchesAmbient(family: AmbientFamily, rel: string, inDir: boolean): boolean {
  const base = rel.split("/").pop() ?? rel;
  if (inDir) return true;
  if (family.names.some((re) => re.test(base))) return true;
  return family.relPaths.some((r) => rel === r || rel.endsWith(`/${r}`));
}

/** Hash of the implicit-hook files for this family, found with a bounded walk of the repo. */
function ambientHash(h: crypto.Hash, family: AmbientFamily, repoRoot: string): boolean {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number, inHookDir: boolean) => {
    if (depth > 8 || visited > AMBIENT_MAX_VISITED || found.length >= AMBIENT_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > AMBIENT_MAX_VISITED || found.length >= AMBIENT_MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.isSymbolicLink() || AMBIENT_SKIP_DIRS.has(e.name)) continue;
        walk(abs, depth + 1, inHookDir || family.dirs.has(e.name));
      } else if (e.isFile()) {
        const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
        if (matchesAmbient(family, rel, inHookDir)) found.push(abs);
      }
    }
  };
  walk(repoRoot, 0, false);
  found.sort();
  for (const abs of found) hashFileInto(h, path.relative(repoRoot, abs).replace(/\\/g, "/"), abs);
  return found.length > 0;
}

/** What the agent created this session, repo-relative with forward slashes. */
export interface AgentCreated {
  files: string[];
  dirs: string[];
  /**
   * Repo-relative files the current phase was told to edit. Their contents are
   * left out of the fingerprint so the edit -> run -> fix loop does not re-ask
   * for the same command after every save. Anything else the command runs
   * (scripts, build files, implicit hooks) is still bound.
   */
  trusted?: string[];
}

/**
 * Fingerprint of the project files a command would run: package.json
 * scripts, build files and wrappers, files named in argv, the implicit-hook
 * files for the command's runtime family (ambientHooks.ts, extendable by the
 * user), and a tripwire for files the AGENT created this session:
 *  - dotfiles, and anything inside a directory the agent created;
 *  - names the command's family loads implicitly (conftest.py);
 *  - for a command whose runtime is unknown, new files in the repo root.
 * Ordinary new source files do not trip it, so a greenfield project does not
 * re-prompt after every new module. "" when there is nothing to bind to.
 * It cannot see code a build pulls in indirectly through paths nobody named.
 */
export function commandFingerprint(
  argv: string[],
  cwd: string,
  repoRoot: string,
  created: AgentCreated = { files: [], dirs: [] }
): string {
  const exe = executableName(argv[0]);
  const parts: string[] = [];

  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    // Nearest package.json from cwd up to the repo root.
    let dir = cwd;
    for (;;) {
      const text = readIf(path.join(dir, "package.json"));
      if (text !== undefined) {
        try {
          parts.push(`pkg:${path.relative(repoRoot, dir)}:${JSON.stringify(JSON.parse(text).scripts ?? {})}`);
        } catch {
          parts.push(`pkg:${path.relative(repoRoot, dir)}:unparseable:${text}`);
        }
        break;
      }
      if (path.resolve(dir) === path.resolve(repoRoot)) break;
      const up = path.dirname(dir);
      if (up === dir || !isInsideRoot(repoRoot, up)) break;
      dir = up;
    }
  }
  if (["gradle", "gradlew", "mvn", "mvnw"].includes(exe)) {
    for (const f of [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "pom.xml",
      path.join("gradle", "wrapper", "gradle-wrapper.properties"),
    ]) {
      const t = readIf(path.join(cwd, f));
      if (t !== undefined) parts.push(`${f}:${t}`);
    }
  }
  if (exe === "make" || exe === "gmake") {
    for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
      const t = readIf(path.join(cwd, f));
      if (t !== undefined) parts.push(`${f}:${t}`);
    }
  }
  // A repo-local executable or wrapper: its own contents are what runs.
  if (/[\\/]/.test(argv[0]) || /^(gradlew|mvnw)$/.test(exe)) {
    const base = path.resolve(cwd, argv[0]);
    const candidates = [base];
    if (process.platform === "win32") candidates.push(...[".bat", ".cmd", ".exe"].map((e) => base + e));
    for (const c of candidates) {
      const t = isInsideRoot(repoRoot, c) ? readIf(c) : undefined;
      if (t !== undefined) {
        parts.push(`self:${path.basename(c)}:${t}`);
        break;
      }
    }
  }

  // Files named in argv: `pytest tests/test_math.py` runs that file's top-level code.
  const argvFiles: string[] = [];
  for (const arg of argv.slice(1)) {
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
    const cands = arg.startsWith("-") ? (eq > 0 ? [arg.slice(eq + 1)] : []) : [arg];
    for (const cand of cands) {
      if (!cand || cand.includes("://")) continue;
      const abs = path.resolve(cwd, cand);
      if (!isInsideRoot(repoRoot, abs)) continue;
      try {
        if (fs.statSync(abs).isFile()) argvFiles.push(abs);
      } catch {
        /* not a file */
      }
    }
  }

  const trusted = (created.trusted ?? []).map((p) => p.replace(/\\/g, "/"));
  const isTrusted = (rel: string) => trusted.some((p) => rel === p || rel.endsWith(`/${p}`) || p.endsWith(`/${rel}`));
  for (let i = argvFiles.length - 1; i >= 0; i--) {
    if (isTrusted(path.relative(repoRoot, argvFiles[i]).replace(/\\/g, "/"))) argvFiles.splice(i, 1);
  }

  const family = ambientFamilyFor(exe);
  const createdDirs = created.dirs.map((d) => d.replace(/\\/g, "/").replace(/\/+$/, ""));
  const trip = created.files
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => {
      if (isTrusted(f)) return false;
      const base = f.split("/").pop() ?? f;
      if (base.startsWith(".")) return true;
      if (createdDirs.some((d) => f === d || f.startsWith(`${d}/`))) return true;
      if (family) return matchesAmbient(family, f, false);
      return !f.includes("/");
    })
    .sort()
    .slice(0, 50);

  if (argvFiles.length === 0 && !family && trip.length === 0) return parts.length > 0 ? sha(parts) : "";

  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  let any = parts.length > 0;
  for (const abs of [...new Set(argvFiles)].sort().slice(0, 20)) {
    hashFileInto(h, path.relative(repoRoot, abs).replace(/\\/g, "/"), abs);
    any = true;
  }
  if (family && ambientHash(h, family, repoRoot)) any = true;
  for (const rel of trip) {
    h.update(`created:${rel}`).update("\0");
    hashFileInto(h, rel, path.resolve(repoRoot, rel));
    any = true;
  }
  return any ? h.digest("hex").slice(0, 16) : "";
}

/** One line a person can read: the command and where it runs. */
export function describeCommand(argv: string[], cwdRel: string): string {
  const text = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return cwdRel ? `${text}  (in ${cwdRel})` : text;
}

// ------------------------------------------------------------------ execution

/** The Windows Store's `python.exe` stub opens the Store instead of running Python. */
function isWindowsStoreStub(file: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(file) && /^python(3(\.\d+)?)?(w)?\.exe$/i.test(path.basename(file));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the file a command name would run, WITHOUT a shell and without
 * starting anything. Undefined means it is not installed (or is only the
 * Store stub), which is reported before the user is ever asked to approve.
 */
export function resolveExecutable(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
      : [""];
  const tryIn = (dir: string, base: string): string | undefined => {
    for (const ext of exts) {
      const candidate = path.join(dir, base + ext);
      if (!isFile(candidate)) continue;
      // A bare `npm` file (a POSIX shell script) is not runnable on Windows;
      // only an executable extension counts there.
      if (platform === "win32" && ext === "" && !/\.(exe|cmd|bat|com)$/i.test(base)) continue;
      if (platform === "win32" && isWindowsStoreStub(candidate)) continue;
      if (platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
    return undefined;
  };

  if (/[\\/]/.test(name)) {
    const abs = path.resolve(cwd, name);
    return tryIn(path.dirname(abs), path.basename(abs));
  }
  // The project's own directory first for wrappers (`gradlew.bat`, `mvnw`),
  // matching how `gradlew.bat build` already worked from the repo root.
  if (platform === "win32" || /^(gradlew|mvnw)$/.test(name)) {
    const local = tryIn(cwd, name);
    if (local) return local;
  }
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean)) {
    const hit = tryIn(dir, name);
    if (hit) return hit;
  }
  return undefined;
}

export interface CommandResult {
  ok: boolean;
  /** Process exit code, or undefined when it never started or was killed. */
  code?: number | string;
  output: string;
  timedOut: boolean;
}

const OUTPUT_HEAD_CHARS = 2000;
const OUTPUT_TAIL_CHARS = 4000;

/** Keeps the first `head` and last `tail` characters of a stream of any size. */
export class HeadTailCapture {
  private headText = "";
  private tailText = "";
  private total = 0;
  constructor(
    private readonly head: number,
    private readonly tail: number
  ) {}
  push(chunk: string): void {
    this.total += chunk.length;
    const room = this.head - this.headText.length;
    if (room > 0) {
      this.headText += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tailText = (this.tailText + chunk).slice(-this.tail);
  }
  render(): string {
    const omitted = this.total - this.headText.length - this.tailText.length;
    const text =
      omitted > 0
        ? `${this.headText}\n[... ${omitted} characters omitted ...]\n${this.tailText}`
        : this.headText + this.tailText;
    return text.trim();
  }
}
/** Long enough for a cold Gradle build, short enough that a dev server cannot hang a run. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Runs a resolved executable with an argv array (no shell) and captures its output tail. */
export async function runResolvedCommand(
  executable: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    /** Given the target and args, returns what to actually spawn (Windows .cmd handling). */
    wrap?: (bin: string, args: string[]) => { bin: string; args: string[] };
  }
): Promise<CommandResult> {
  const { spawn } = await import("node:child_process");
  const wrapped = opts.wrap ? opts.wrap(executable, args) : { bin: executable, args };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const win = (opts.platform ?? process.platform) === "win32";
  // Non-interactive by default: nobody can answer a prompt or a TUI menu here.
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    NONINTERACTIVE: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
    ...(opts.env ?? process.env),
  };
  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    // Output is never buffered whole: a runaway compiler trace keeps its first
    // lines (the invocation and first error) and its last (the summary), and
    // memory stays bounded however much the process prints.
    const capture = new HeadTailCapture(OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS);
    let settled = false;
    const finish = (code: number | string | undefined, errText?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const body = capture.render() || errText || "(no output)";
      const ok = code === 0 && !timedOut;
      resolve({
        ok,
        code,
        output: timedOut
          ? `[TIMED OUT AFTER ${Math.round(timeoutMs / 1000)}s — the command appears to be a long-running ` +
            `watcher/server or was waiting for input. Re-run it in a form that exits (e.g. --watch=false, ` +
            `\`adb logcat -d\`, --no-daemon, a one-shot build) or report it as a manual step. Output so far:]\n${body}`
          : body,
        timedOut,
      });
    };
    const child = spawn(wrapped.bin, wrapped.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be signalled.
      detached: !win,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8").on("data", (d: string) => capture.push(d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => capture.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => finish(e.code ?? "ERROR", String(e.message)));
    child.on("close", (code, signal) => finish(code ?? signal ?? "KILLED"));
    timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      try {
        if (!pid) child.kill("SIGKILL");
        else if (win) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
  });
}
