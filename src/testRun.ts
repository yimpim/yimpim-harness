/** Running the project's own test command, narrowed to specific files (or the whole suite when none are given). */

import { execFile } from "child_process";
import { promisify } from "util";
import { focusedTestCommand } from "./focusTests.js";

const execFileAsync = promisify(execFile);

export interface SuiteRun {
  ok: boolean;
  output: string;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Test files named as failing in a runner's output (jest, vitest, pytest). */
export function failingTestFiles(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^FAIL\s+(?:[\w-]+\s+)?(\S+\.[a-z0-9]+)\b/i.exec(line);
    if (!m) m = /^FAILED\s+(\S+?\.py)(?:::|\s|$)/.exec(line);
    if (!m) m = /^ERROR\s+(\S+?\.py)(?:::|\s|$)/.exec(line);
    if (m) found.add(m[1].replace(/\\/g, "/"));
  }
  return [...found];
}

/** Test files a runner reported as passing (jest and vitest print one PASS line per file). */
export function passingTestFiles(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const m = /^PASS\s+(?:[\w-]+\s+)?(\S+\.[a-z0-9]+)\b/i.exec(raw.trim());
    if (m) found.add(m[1].replace(/\\/g, "/"));
  }
  return [...found];
}

export async function runSuite(repoRoot: string, files: string[]): Promise<SuiteRun> {
  const cmd = focusedTestCommand(repoRoot, files);
  if (!cmd) return { ok: false, output: "No test script (package.json `test`) or pytest config to run." };
  try {
    const { stdout, stderr } = await execFileAsync(cmd.bin, cmd.args, {
      cwd: repoRoot,
      timeout: 900_000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      shell: process.platform === "win32",
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err: any) {
    return { ok: false, output: `${err?.stdout ?? ""}\n${err?.stderr ?? ""}` };
  }
}
