/**
 * What this terminal says about itself in its sealed `session.hello` event, so a phone with several terminals paired can tell them
 * apart. Everything here is encrypted before it leaves the machine: the relay never learns a project or host name.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionHello } from "./client.js";

/** The checked-out branch, or undefined for a detached HEAD, a repository with no commits, or no git at all. Never throws. */
export function readBranch(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function cliVersion(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function buildSessionHello(opts: { repoRoot: string; shareHostname: boolean }): Partial<SessionHello> {
  const branch = readBranch(opts.repoRoot);
  const version = cliVersion();
  return {
    repoName: path.basename(opts.repoRoot).slice(0, 120),
    ...(branch ? { branch } : {}),
    ...(opts.shareHostname ? { hostname: os.hostname().slice(0, 120) } : {}),
    platform: process.platform,
    ...(version ? { cliVersion: version } : {}),
  };
}
