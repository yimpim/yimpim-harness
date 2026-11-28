import fs from "node:fs";
import path from "node:path";

/**
 * Default allowlist of trusted native/binary npm packages permitted to run a
 * targeted `npm rebuild <pkg> --ignore-scripts=false` after passing registry
 * verification, release-age checks, and security approval during
 * `npm install --ignore-scripts`.
 */
export const DEFAULT_NATIVE_REBUILD_ALLOWLIST = [
  "esbuild",
  "sharp",
  "better-sqlite3",
  "sqlite3",
  "canvas",
  "puppeteer",
  "playwright",
  "@swc/core",
  "lightningcss",
] as const;

export const LIFECYCLE_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;

const VALID_NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function isValidNpmPackageName(pkgName: string): boolean {
  return VALID_NPM_PACKAGE_NAME.test(pkgName.trim());
}

/** True when `pkgName` exactly matches an entry in the configured allowlist. */
export function isAllowlistedNativePackage(
  pkgName: string,
  allowlist: readonly string[] = DEFAULT_NATIVE_REBUILD_ALLOWLIST
): boolean {
  const normalized = pkgName.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.some((entry) => entry.trim().toLowerCase() === normalized);
}

/**
 * Inspect `node_modules/<pkgName>/package.json` across candidate project dirs
 * and return any `preinstall`, `install`, or `postinstall` script definitions.
 */
export function readInstalledLifecycleScripts(
  pkgName: string,
  dirs: readonly string[]
): Record<string, string> | undefined {
  const clean = pkgName.trim();
  if (!isValidNpmPackageName(clean)) return undefined;
  for (const dir of dirs) {
    try {
      const pkgJsonPath = path.join(dir, "node_modules", ...clean.split("/"), "package.json");
      const raw = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const scripts = raw?.scripts;
      if (!scripts || typeof scripts !== "object") return undefined;
      const found: Record<string, string> = {};
      for (const hook of LIFECYCLE_SCRIPT_NAMES) {
        if (typeof scripts[hook] === "string" && scripts[hook].trim().length > 0) {
          found[hook] = scripts[hook].trim();
        }
      }
      return Object.keys(found).length > 0 ? found : undefined;
    } catch {
      // Try next candidate directory
    }
  }
  return undefined;
}

/**
 * Build the argv and strictly-scoped env for a single-package
 * `npm rebuild <exact-pkg> --ignore-scripts=false` invocation.
 */
export function buildTargetedRebuildInvocation(
  pkgName: string,
  baseEnv: NodeJS.ProcessEnv
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const clean = pkgName.trim();
  if (!isValidNpmPackageName(clean)) {
    throw new Error(`Refusing targeted npm rebuild for invalid package name: "${pkgName}"`);
  }
  return {
    argv: ["rebuild", clean, "--ignore-scripts=false"],
    env: {
      ...baseEnv,
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      npm_config_ignore_scripts: "false",
    },
  };
}

export interface PostInstallRebuildPlan {
  action: "none" | "auto_rebuild" | "escalate_human";
  reason: string;
  scripts?: Record<string, string>;
}

/**
 * Decide post-install lifecycle script handling for one newly installed npm
 * package:
 * - No lifecycle scripts -> `"none"`.
 * - Allowlisted native package that passed verification -> `"auto_rebuild"`.
 * - Non-allowlisted package with lifecycle scripts (or allowlisted package
 *   with verification warnings) -> `"escalate_human"`.
 */
export function planPostInstallRebuild(args: {
  pkgName: string;
  lifecycleScripts?: Record<string, string>;
  passedVerification: boolean;
  allowlist?: readonly string[];
}): PostInstallRebuildPlan {
  const scripts = args.lifecycleScripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    return { action: "none", reason: "package defines no install lifecycle scripts" };
  }
  const allowlist = args.allowlist ?? DEFAULT_NATIVE_REBUILD_ALLOWLIST;
  if (isAllowlistedNativePackage(args.pkgName, allowlist)) {
    if (args.passedVerification) {
      return {
        action: "auto_rebuild",
        reason: "allowlisted native package passed registry verification and security checks",
        scripts,
      };
    }
    return {
      action: "escalate_human",
      reason: "allowlisted package has post-install verification warnings",
      scripts,
    };
  }
  return {
    action: "escalate_human",
    reason: "non-allowlisted package defines install lifecycle scripts",
    scripts,
  };
}

/** Format a package's lifecycle scripts for human 1-tap approval review. */
export function formatRebuildEscalationQuestion(
  agent: string,
  pkgName: string,
  scripts: Record<string, string>
): string {
  const scriptLines = Object.entries(scripts)
    .map(([hook, cmd]) => `  - ${hook}: ${cmd.slice(0, 200)}`)
    .join("\n");
  return (
    `${agent} installed "${pkgName}" with --ignore-scripts, and it defines install lifecycle script(s):\n` +
    `${scriptLines}\n` +
    `Run targeted \`npm rebuild ${pkgName} --ignore-scripts=false\`? (yes/no)`
  );
}
