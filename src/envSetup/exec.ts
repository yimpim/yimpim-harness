/**
 * The ONE way setup-env and doctor start a program: an argument array, never a shell. Nothing here builds a command string, interpolates a value into one, or hands anything to
 * /bin/sh. `display` formats a command for a person to read; it is never executed.
 */
import { spawnSync } from "child_process";

export interface Cmd {
  bin: string;
  args: string[];
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to the program's standard input (a licence prompt answered "y"). */
  input?: string;
  timeoutMs?: number;
  /** Run through sudo: only for the explicit list of OS-level commands that were printed and confirmed. */
  sudo?: boolean;
  /** Show the program's own output as it runs (a long install), instead of capturing it. */
  inherit?: boolean;
}
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}
export type Runner = (cmd: Cmd, opts?: RunOptions) => RunResult;

/** A value that would make an argument list mean something other than what was written: not a string, a NUL byte, or a line break. */
export function assertSafeArg(a: unknown): asserts a is string {
  if (typeof a !== "string") throw new Error("a command argument must be a string");
  if (a.includes("\0") || /[\r\n]/.test(a)) throw new Error(`a command argument may not contain a line break or NUL: ${JSON.stringify(a).slice(0, 80)}`);
}

export const realRunner: Runner = (cmd, opts = {}) => {
  assertSafeArg(cmd.bin);
  cmd.args.forEach(assertSafeArg);
  const bin = opts.sudo ? "sudo" : cmd.bin;
  const args = opts.sudo ? ["--", cmd.bin, ...cmd.args] : cmd.args;
  const r = spawnSync(bin, args, {
    shell: false,
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeoutMs ?? 600_000,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: opts.inherit ? ["inherit", "inherit", "inherit"] : [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: String(r.error.message ?? r.error) } : {}) };
};

/** One command as a person reads it (quoted where it has spaces). For printing only. */
export function display(cmd: Cmd, sudo = false): string {
  const q = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return `${sudo ? "sudo " : ""}${[cmd.bin, ...cmd.args].map(q).join(" ")}`;
}

export const ok = (r: RunResult) => r.status === 0 && !r.error;
