/**
 * The planner's up-front setup proposal: which libraries and which toolchain
 * the work will need. The planner PREDICTS; code VERIFIES.
 *
 *  - Every proposed library is looked up in its real registry (dependencyFacts)
 *    and gets a verdict: verified (with the version policy's pick), refused
 *    (does not exist / no usable release), needs-confirmation (warnings), or
 *    unverified (registry unreachable — never reported as "does not exist").
 *  - Every proposed toolchain item is probed on this machine without starting
 *    anything (resolveExecutable), so a missing Python/JDK/etc. is reported
 *    BEFORE the first phase rather than as a confusing failure in the last.
 *
 * Nothing here installs anything or writes anywhere; it only produces a
 * report. Side effects stay in the existing gated paths.
 */

import { z } from "zod";
import {
  ECOSYSTEMS,
  type Ecosystem,
  type FetchFn,
  assessPackage,
  chooseVersionWithDates,
  lookupPackage,
  lookupVulnerabilities,
} from "./dependencyFacts.js";
import { resolveExecutable } from "./commandPolicy.js";

export const ProposedDependencySchema = z.object({
  ecosystem: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(["npm", "pypi", "crates", "maven", "nuget", "go"])),
  name: z.string().min(1),
  reason: z.string().default(""),
  version: z.string().optional(),
});
export type ProposedDependency = z.infer<typeof ProposedDependencySchema>;

export const ProposedToolSchema = z.object({
  tool: z.string().min(1),
  reason: z.string().default(""),
});
export type ProposedTool = z.infer<typeof ProposedToolSchema>;

/** Caps a model can't talk its way past: a proposal is a short list, not a bill of materials. */
export const MAX_PROPOSED_DEPENDENCIES = 25;
export const MAX_PROPOSED_TOOLS = 10;

export type DependencyVerdict = "verified" | "refused" | "confirm" | "unverified";

export interface VerifiedDependency {
  ecosystem: Ecosystem;
  name: string;
  reason: string;
  verdict: DependencyVerdict;
  /** The version the policy picked (verified / confirm only). */
  version?: string;
  versionReason?: string;
  warnings: string[];
}

export async function verifyDependencyProposal(
  proposed: ProposedDependency[],
  fetchFn: FetchFn
): Promise<VerifiedDependency[]> {
  const seen = new Set<string>();
  const out: VerifiedDependency[] = [];
  for (const dep of proposed.slice(0, MAX_PROPOSED_DEPENDENCIES)) {
    if (!ECOSYSTEMS.includes(dep.ecosystem)) continue;
    const key = `${dep.ecosystem}:${dep.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const base = { ecosystem: dep.ecosystem, name: dep.name, reason: dep.reason.slice(0, 200) };
    let facts;
    try {
      facts = await lookupPackage(dep.ecosystem, dep.name, fetchFn);
    } catch (err: any) {
      out.push({ ...base, verdict: "unverified", warnings: [`lookup failed: ${err?.message ?? err}`] });
      continue;
    }
    const choice = await chooseVersionWithDates(facts, fetchFn, { requested: dep.version });
    const chosen = facts.versions.find((v) => v.version === choice.version);
    const vulns =
      choice.version && facts.exists && !facts.lookupError
        ? await lookupVulnerabilities(dep.ecosystem, dep.name, choice.version, fetchFn).catch(() => undefined)
        : undefined;
    const assessment = assessPackage(facts, chosen, vulns);
    const warnings = assessment.warnings.map((w) => w.text);

    if (dep.ecosystem === "maven" && assessment.level !== "block" && !facts.lookupError) {
      // A Maven artifact lands in a Gradle build, i.e. native code. A safe
      // package can still be the wrong architectural choice, so a person
      // decides every time.
      out.push({
        ...base,
        verdict: "confirm",
        version: choice.version,
        versionReason: choice.reason,
        warnings: ["adds a native Android (Gradle) dependency", ...warnings],
      });
    } else if (assessment.level === "block") {
      out.push({ ...base, verdict: "refused", warnings });
    } else if (facts.lookupError) {
      out.push({ ...base, verdict: "unverified", warnings });
    } else if (assessment.level === "confirm") {
      out.push({ ...base, verdict: "confirm", version: choice.version, versionReason: choice.reason, warnings });
    } else {
      out.push({ ...base, verdict: "verified", version: choice.version, versionReason: choice.reason, warnings });
    }
  }
  return out;
}

// ---------------------------------------------------------------- toolchain

/** Executable names that satisfy a tool the planner may name. Anything not listed is looked up by its own name. */
const TOOL_EXECUTABLES: Record<string, string[]> = {
  python: ["python", "python3", "py"],
  python3: ["python", "python3", "py"],
  pip: ["pip", "pip3"],
  node: ["node"],
  nodejs: ["node"],
  npm: ["npm"],
  pnpm: ["pnpm"],
  yarn: ["yarn"],
  java: ["java"],
  jdk: ["javac", "java"],
  javac: ["javac"],
  gradle: ["gradle", "gradlew"],
  maven: ["mvn", "mvnw"],
  mvn: ["mvn", "mvnw"],
  adb: ["adb"],
  "android-sdk": ["adb", "sdkmanager"],
  cargo: ["cargo"],
  rust: ["cargo", "rustc"],
  go: ["go"],
  dotnet: ["dotnet"],
  git: ["git"],
  docker: ["docker"],
};

export interface ToolchainStatus {
  tool: string;
  reason: string;
  found: boolean;
  /** Where it was found, when it was. */
  path?: string;
}

export function probeToolchain(
  tools: ProposedTool[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ToolchainStatus[] {
  const out: ToolchainStatus[] = [];
  const seen = new Set<string>();
  for (const t of tools.slice(0, MAX_PROPOSED_TOOLS)) {
    const key = t.tool.trim().toLowerCase();
    // Only plain tool names: a model-supplied value never becomes a path.
    if (!/^[a-z0-9][a-z0-9._+-]{0,40}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    let found: string | undefined;
    for (const exe of TOOL_EXECUTABLES[key] ?? [key]) {
      found = resolveExecutable(exe, cwd, env, platform);
      if (found) break;
    }
    out.push({ tool: key, reason: t.reason.slice(0, 200), found: Boolean(found), path: found });
  }
  return out;
}

// ------------------------------------------------------------------ report

export interface SetupReport {
  dependencies: VerifiedDependency[];
  toolchain: ToolchainStatus[];
}

export function missingTools(report: SetupReport): ToolchainStatus[] {
  return report.toolchain.filter((t) => !t.found);
}

/** True when there is anything worth showing the user. */
export function reportHasContent(report: SetupReport): boolean {
  return report.dependencies.length > 0 || report.toolchain.length > 0;
}

export function renderSetupReport(report: SetupReport, opts: { omitReasons?: boolean } = {}): string {
  const lines: string[] = [];
  if (report.toolchain.length > 0) {
    lines.push("Toolchain (predicted by the planner, checked on this machine):");
    for (const t of report.toolchain) {
      lines.push(`  ${t.found ? "✓" : "✗"} ${t.tool}${t.found ? "" : " — not found"}${t.reason && !opts.omitReasons ? `  (${t.reason})` : ""}`);
    }
  }
  if (report.dependencies.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Libraries (predicted by the planner, checked against the registries):");
    for (const d of report.dependencies) {
      const id = `${d.ecosystem}:${d.name}`;
      switch (d.verdict) {
        case "verified":
          lines.push(`  ✓ ${id} ${d.version ?? ""}`.trimEnd() + (d.reason ? `  (${d.reason})` : ""));
          break;
        case "confirm":
          lines.push(`  ⚠ ${id} ${d.version ?? ""} — needs your confirmation: ${d.warnings.join("; ")}`);
          break;
        case "refused":
          lines.push(`  ✗ ${id} — will NOT be added: ${d.warnings.join("; ") || "no usable release"}`);
          break;
        case "unverified":
          lines.push(`  ? ${id} — could not be verified (${d.warnings.join("; ") || "registry unreachable"}); no version will be assumed`);
          break;
      }
    }
  }
  return lines.join("\n");
}

/**
 * What the Editor is told. Facts, not instructions: it tells the Editor which
 * version to use for what was verified and what not to add, and that anything
 * else still goes through request_dependency. It grants no permission.
 */
export function renderDependencyGuidance(report: SetupReport): string {
  const lines: string[] = [];
  const ok = report.dependencies.filter((d) => d.verdict === "verified");
  const refused = report.dependencies.filter((d) => d.verdict === "refused");
  const unsure = report.dependencies.filter((d) => d.verdict === "unverified" || d.verdict === "confirm");
  if (ok.length > 0) {
    lines.push("Pre-verified libraries (use exactly these versions):");
    for (const d of ok) lines.push(`- ${d.ecosystem}:${d.name} ${d.version}`);
  }
  if (unsure.length > 0) {
    lines.push("Not yet cleared — call request_dependency before adding any of these:");
    for (const d of unsure) lines.push(`- ${d.ecosystem}:${d.name}`);
  }
  if (refused.length > 0) {
    lines.push("Do NOT add (not in the registry or no usable release):");
    for (const d of refused) lines.push(`- ${d.ecosystem}:${d.name}`);
  }
  const missing = missingTools(report);
  if (missing.length > 0) {
    lines.push(
      `Tools missing on this machine: ${missing.map((m) => m.tool).join(", ")}. Code can be written, but anything that needs them cannot be run here yet — say so rather than claiming it was verified.`
    );
  }
  return lines.join("\n");
}
