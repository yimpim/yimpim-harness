import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import process from "process";
import { promisify } from "util";
import { AgentConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface RepoTools {
  listFiles(subDir?: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  patchFile(filePath: string, find: string, replace: string): Promise<string>;
  searchCode(pattern: string): Promise<string>;
  getFileOutline(filePath: string): Promise<string>;
  git(args: string[]): Promise<string>;
  isDirty(): Promise<boolean>;
  createCheckpoint(phaseName: string): Promise<string | null>;
  rollbackToCheckpoint(tag: string): Promise<void>;
}

export function createRepoTools(repoRoot: string, config: AgentConfig): RepoTools {
  const root = path.resolve(repoRoot);
  const runnerDir = path.resolve(process.cwd()).replace(/\\/g, "/").toLowerCase();

  const resolvePath = (targetPath: string): string => {
    const resolved = path.resolve(root, targetPath);

    const normRoot = root.replace(/\\/g, "/").toLowerCase();
    const normResolved = resolved.replace(/\\/g, "/").toLowerCase();

    // Critical Safety: Never allow writing or reading the agent runner itself
    if (normResolved.startsWith(runnerDir) && runnerDir !== normRoot) {
      throw new Error(`[CRITICAL SECURITY] Access denied. Path targets agent runner directory: "${targetPath}"`);
    }

    // Strict Boundary Sandbox: Must reside within target repo root
    const isInside =
      normResolved === normRoot ||
      normResolved.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`);

    if (!isInside) {
      throw new Error(`[SANDBOX VIOLATION] Attempted access outside target repo: "${targetPath}" resolved to "${resolved}"`);
    }

    return resolved;
  };

  const git = async (args: string[]): Promise<string> => {
    try {
      // Use execFileAsync so array arguments with spaces (like commit messages) don't get broken by cmd.exe
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (err: any) {
      throw new Error(`Git error (${args[0]}): ${err.stderr || err.message}`);
    }
  };

  return {
    async listFiles(subDir = "."): Promise<string[]> {
      const targetDir = resolvePath(subDir);
      const entries = await fs.readdir(targetDir, { recursive: true, withFileTypes: true });

      const ignored = [
        "node_modules",
        ".git",
        "build",
        ".gradle",
        ".agent",
        "dist",
        ".idea",
      ];

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const fullPath = path.join(entry.parentPath || targetDir, entry.name);
          return path.relative(root, fullPath).replace(/\\/g, "/");
        })
        .filter((relPath) => !ignored.some((dir) => relPath.startsWith(dir) || relPath.includes(`/${dir}/`)));
    },

    async readFile(filePath: string): Promise<string> {
      const fullPath = resolvePath(filePath);
      return await fs.readFile(fullPath, "utf-8");
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      const fullPath = resolvePath(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
    },

    async patchFile(filePath: string, find: string, replace: string): Promise<string> {
      const fullPath = resolvePath(filePath);
      const original = await fs.readFile(fullPath, "utf-8");

      const normOriginal = original.replace(/\r\n/g, "\n");
      const normFind = find.replace(/\r\n/g, "\n");
      const normReplace = replace.replace(/\r\n/g, "\n");

      if (!normOriginal.includes(normFind)) {
        throw new Error(
          `Patch target not found in ${filePath}. Verify indentation, line endings, and surrounding lines.`
        );
      }

      const matchCount = normOriginal.split(normFind).length - 1;
      if (matchCount > 1) {
        throw new Error(
          `Ambiguous patch target: found ${matchCount} matches in ${filePath}. Add more surrounding context.`
        );
      }

      const patched = normOriginal.replace(normFind, normReplace);
      await fs.writeFile(fullPath, patched, "utf-8");
      return `Successfully patched ${filePath}`;
    },

    async searchCode(pattern: string): Promise<string> {
      try {
        const { stdout } = await execFileAsync("git", ["grep", "-E", "-n", "-i", pattern], {
          cwd: root,
          maxBuffer: 5 * 1024 * 1024,
        });
        return stdout.trim();
      } catch (err: any) {
        if (err.code === 1) {
          return "No matches found.";
        }
        return `Search error: ${err.stderr || err.message}`;
      }
    },

    async getFileOutline(filePath: string): Promise<string> {
      const fullPath = resolvePath(filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);

      const outline: string[] = [];
      const declarationRegex = /^\s*(@\w+(\(.*\))?\s*)*(public|private|protected|internal|sealed|open|abstract|override)?\s*(data\s+|enum\s+)?(class|interface|object|fun)\s+([A-Za-z0-9_]+)/;

      lines.forEach((line, index) => {
        if (declarationRegex.test(line)) {
          outline.push(`L${index + 1}: ${line.trim()}`);
        }
      });

      return outline.length > 0 ? outline.join("\n") : "No top-level or class declarations detected.";
    },

    async git(args: string[]): Promise<string> {
      return await git(args);
    },

    async isDirty(): Promise<boolean> {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
        return stdout.trim().length > 0;
      } catch {
        return false;
      }
    },

    async createCheckpoint(phaseName: string): Promise<string | null> {
      try {
        const cleanName = phaseName.toLowerCase().replace(/[^a-z0-9]/g, "-");
        const tag = `agent-checkpoint-${cleanName}-${Date.now()}`;
        await git(["tag", tag]);
        return tag;
      } catch {
        return null;
      }
    },

    async rollbackToCheckpoint(tag: string): Promise<void> {
      await git(["reset", "--hard", tag]);
      await git(["clean", "-fd"]);
    },
  };
}
