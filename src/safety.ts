import path from "node:path";
import { Config } from "./config.js";

export function safePath(repoRoot: string, requested: string, config: Config): string {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repository: ${requested}`);
  }

  const rel = path.relative(root, candidate);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.some(p => config.safety.blockedDirectories.includes(p))) {
    throw new Error(`Blocked directory: ${requested}`);
  }

  const base = path.basename(candidate);
  for (const pattern of config.safety.blockedFilePatterns) {
    if (pattern.startsWith("*") && base.endsWith(pattern.slice(1))) {
      throw new Error(`Blocked file type: ${requested}`);
    }
    if (pattern === base) {
      throw new Error(`Blocked file: ${requested}`);
    }
  }
  return candidate;
}

export function safeCommand(command: string, config: Config): void {
  const first = command.trim().split(/\s+/)[0];
  if (!config.execution.allowedCommands.includes(first)) {
    throw new Error(`Command not allowed: ${first}`);
  }
}
