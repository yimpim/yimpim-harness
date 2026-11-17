/** Running the project's own test command, narrowed to specific files (or the whole suite when none are given). */

import { execFile } from "child_process";
import { promisify } from "util";
import { focusedTestCommand } from "./focusTests.js";

const execFileAsync = promisify(execFile);

export interface SuiteRun {
  ok: boolean;
  output: string;
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
