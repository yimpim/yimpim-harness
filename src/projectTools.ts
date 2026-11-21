/**
 * What the project already has, so an agent uses it before reaching for something new. An Editor that is not told which test runner the project uses guesses a
 * popular one (vitest in a Jest project), and `npx` for a program that is not installed means downloading and running code nobody has seen. Reading this costs
 * nothing: package.json and the names in node_modules/.bin.
 */
import fs from "fs";
import path from "path";

const MAX_BINS = 30;
const MAX_SCRIPTS = 12;

export interface ProjectTools {
  scripts: Record<string, string>;
  bins: string[];
  /** The command the project's own `test` script runs, when there is one. */
  testScript?: string;
}

export function projectTools(repoRoot: string): ProjectTools {
  const out: ProjectTools = { scripts: {}, bins: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    for (const [k, v] of Object.entries(pkg?.scripts ?? {})) if (typeof v === "string" && Object.keys(out.scripts).length < MAX_SCRIPTS) out.scripts[k] = v.slice(0, 90);
    if (typeof pkg?.scripts?.test === "string") out.testScript = pkg.scripts.test;
  } catch {
    // no package.json: not a Node project
  }
  try {
    const seen = new Set<string>();
    for (const f of fs.readdirSync(path.join(repoRoot, "node_modules", ".bin"))) {
      const name = f.replace(/\.(cmd|ps1)$/i, "");
      if (!seen.has(name)) seen.add(name);
    }
    out.bins = [...seen].sort();
  } catch {
    // nothing installed
  }
  return out;
}

/** The programs the project has that are worth naming first: test runners, type-checkers, linters, formatters. */
const KNOWN = ["jest", "vitest", "mocha", "ava", "playwright", "cypress", "tsc", "eslint", "prettier", "tsx", "ts-node", "expo", "next", "vite", "webpack", "metro"];

/** A short block for an agent's instructions; empty when the project has no package.json. */
export function toolsHint(repoRoot: string): string {
  const t = projectTools(repoRoot);
  const scripts = Object.entries(t.scripts);
  if (scripts.length === 0 && t.bins.length === 0) return "";
  const have = KNOWN.filter((k) => t.bins.includes(k));
  const lines = ["[WHAT THIS PROJECT ALREADY HAS: use these before reaching for anything else; never run a program that is not installed (npx would download and run it unseen)]"];
  if (t.testScript) lines.push(`- Tests: \`npm test\` runs \`${t.testScript.slice(0, 90)}\`${have.includes("jest") ? ". Run one file with `npx jest <file>`." : have.includes("vitest") ? ". Run one file with `npx vitest run <file>`." : "."}`);
  if (have.length > 0) lines.push(`- Installed programs: ${have.join(", ")}.`);
  if (scripts.length > 0) lines.push(`- package.json scripts: ${scripts.map(([k]) => k).join(", ")}.`);
  return lines.join("\n");
}

/**
 * For `npx tool`, `pnpm dlx tool`, `yarn dlx tool`, `bunx tool`: the tool's name when it is NOT installed in this project (so running it would download it),
 * else undefined. Not a Node project, or any other program, is undefined: nothing is claimed about them.
 */
export function missingTool(argv: string[], repoRoot: string): string | undefined {
  const exe = path.basename(argv[0] ?? "").toLowerCase().replace(/\.(cmd|exe)$/, "");
  let rest: string[];
  if (exe === "npx" || exe === "bunx") rest = argv.slice(1);
  else if ((exe === "pnpm" || exe === "yarn" || exe === "bun") && argv[1] === "dlx") rest = argv.slice(2);
  else return undefined;
  const tool = rest.find((a) => !a.startsWith("-"));
  if (!tool || /[\\/]/.test(tool) && !tool.startsWith("@")) return undefined; // a path or URL is not a package name
  const bare = tool.replace(/@[^/@]+$/, "").split("/").pop() ?? tool;
  const bins = projectTools(repoRoot).bins;
  return bins.includes(bare) ? undefined : bare;
}

/** What an agent is told when it asked to run a program the project does not have. */
export function missingToolMessage(tool: string, repoRoot: string): string {
  const t = projectTools(repoRoot);
  const have = KNOWN.filter((k) => t.bins.includes(k));
  const parts = [`Not run — \`${tool}\` is not installed in this project, so \`npx\` would download it and run code nobody has seen.`];
  if (t.testScript) parts.push(`This project's tests run with \`npm test\` (\`${t.testScript.slice(0, 90)}\`)${have.includes("jest") ? "; run one file with `npx jest <file>`" : ""}.`);
  if (have.length > 0) parts.push(`Already installed: ${have.join(", ")}.`);
  parts.push("Use one of those instead, or report it as a manual step. Do not ask for this program again.");
  return parts.join(" ");
}
