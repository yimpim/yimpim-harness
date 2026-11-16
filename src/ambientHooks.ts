/**
 * Which files a tool loads IMPLICITLY before running its target (conftest.py,
 * build.rs, Directory.Build.targets…). Pure data: adding an ecosystem is a
 * JSON edit, not code. The shipped table is a starting point; a user (or a
 * team) extends it with ~/.yimpim/ambient-hooks.json (override the path with
 * YIMPIM_AMBIENT_FILE), same shape:
 *
 *   { "families": { "dotnet": { "executables": ["dotnet"], "names": ["^Directory\\.Build\\.(props|targets)$"] } } }
 *
 * A family named in both is merged (lists are unioned). Names are regular
 * expressions matched against a file's base name; `dirs` are directory names
 * whose whole contents count; `relPaths` are exact repo-relative suffixes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AmbientFamilyData {
  executables?: string[];
  names?: string[];
  dirs?: string[];
  relPaths?: string[];
}

export const BUILTIN_AMBIENT_FAMILIES: Record<string, AmbientFamilyData> = {
  python: {
    executables: ["python", "python3", "py", "pytest", "pip", "pip3", "uv", "poetry", "tox", "ruff"],
    names: ["^(conftest\\.py|setup\\.py|setup\\.cfg|pyproject\\.toml|pytest\\.ini|tox\\.ini|sitecustomize\\.py|usercustomize\\.py)$"],
  },
  rust: {
    executables: ["cargo", "rustc"],
    names: ["^(build\\.rs|Cargo\\.toml|rust-toolchain(\\.toml)?)$"],
    relPaths: [".cargo/config.toml", ".cargo/config"],
  },
  jvm: {
    executables: ["gradle", "gradlew", "mvn", "mvnw", "java"],
    names: ["^(.+\\.gradle|.+\\.gradle\\.kts|gradle\\.properties|gradle-wrapper\\.properties|pom\\.xml)$"],
    dirs: ["buildSrc"],
  },
  node: {
    executables: ["node", "npm", "npx", "pnpm", "yarn", "bun", "jest", "vitest", "tsc", "eslint", "expo"],
    names: [
      "^(\\.npmrc|\\.yarnrc(\\.yml)?|package\\.json|\\.babelrc(\\..+)?)$",
      "^(jest|vitest)\\.setup\\..+$",
      "^(jest|vitest|babel|metro)\\.config\\..+$",
    ],
  },
  dotnet: {
    executables: ["dotnet", "msbuild", "nuget"],
    names: ["^(Directory\\.Build\\.(props|targets)|Directory\\.Packages\\.props|global\\.json|nuget\\.config|.+\\.(csproj|fsproj|vbproj|sln))$"],
  },
  cmake: {
    executables: ["cmake", "ctest", "ninja"],
    names: ["^(CMakeLists\\.txt|CMakePresets\\.json|.+\\.cmake)$"],
  },
  make: {
    executables: ["make", "gmake"],
    names: ["^(Makefile|makefile|GNUmakefile|.+\\.mk)$"],
  },
  go: {
    executables: ["go"],
    names: ["^(go\\.mod|go\\.work)$"],
  },
  bazel: {
    executables: ["bazel", "bazelisk"],
    names: ["^(WORKSPACE(\\.bazel)?|MODULE\\.bazel|BUILD(\\.bazel)?|\\.bazelrc|.+\\.bzl)$"],
  },
  terraform: {
    executables: ["terraform", "tofu", "terragrunt"],
    names: ["^(.+\\.tf|.+\\.tfvars|\\.terraformrc|terragrunt\\.hcl)$"],
  },
  php: {
    executables: ["php", "composer", "phpunit"],
    names: ["^(composer\\.json|phpunit\\.xml(\\.dist)?|\\.user\\.ini)$"],
  },
  elixir: {
    executables: ["mix", "elixir", "iex"],
    names: ["^(mix\\.exs|.+\\.exs)$"],
  },
  ruby: {
    executables: ["ruby", "bundle", "rake", "rspec"],
    names: ["^(Gemfile|Rakefile|\\.rspec|spec_helper\\.rb|.+\\.gemspec)$"],
  },
};

export interface AmbientFamily {
  name: string;
  names: RegExp[];
  dirs: Set<string>;
  relPaths: string[];
}

export interface AmbientTable {
  families: Map<string, AmbientFamily>;
  byExecutable: Map<string, string>;
}

function userFilePath(): string {
  return process.env.YIMPIM_AMBIENT_FILE || path.join(os.homedir(), ".yimpim", "ambient-hooks.json");
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200) : [];
}

/** Built-in table merged with the user's file. A bad user file is ignored, never fatal. */
export function buildAmbientTable(userData?: unknown): AmbientTable {
  const merged: Record<string, Required<AmbientFamilyData>> = {};
  const add = (src: Record<string, AmbientFamilyData>) => {
    for (const [fam, d] of Object.entries(src)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(fam)) continue;
      const m = (merged[fam] ??= { executables: [], names: [], dirs: [], relPaths: [] });
      m.executables.push(...strings(d?.executables).map((e) => e.toLowerCase()));
      m.names.push(...strings(d?.names));
      m.dirs.push(...strings(d?.dirs));
      m.relPaths.push(...strings(d?.relPaths).map((r) => r.replace(/\\/g, "/")));
    }
  };
  add(BUILTIN_AMBIENT_FAMILIES);
  const fams = (userData as any)?.families;
  if (fams && typeof fams === "object" && !Array.isArray(fams)) add(fams);

  const table: AmbientTable = { families: new Map(), byExecutable: new Map() };
  for (const [name, d] of Object.entries(merged)) {
    const regexes: RegExp[] = [];
    for (const src of d.names) {
      try {
        regexes.push(new RegExp(src));
      } catch {
        /* an invalid pattern is skipped */
      }
    }
    table.families.set(name, { name, names: regexes, dirs: new Set(d.dirs), relPaths: d.relPaths });
    for (const exe of d.executables) if (!table.byExecutable.has(exe)) table.byExecutable.set(exe, name);
  }
  return table;
}

let cached: AmbientTable | undefined;

export function getAmbientTable(): AmbientTable {
  if (cached) return cached;
  let user: unknown;
  try {
    user = JSON.parse(fs.readFileSync(userFilePath(), "utf8"));
  } catch {
    /* none or unreadable */
  }
  cached = buildAmbientTable(user);
  return cached;
}

/** For tests: drop the cache so a changed override file is re-read. */
export function resetAmbientTableForTests(): void {
  cached = undefined;
}

export function ambientFamilyFor(executable: string): AmbientFamily | undefined {
  const t = getAmbientTable();
  const fam = t.byExecutable.get(executable.toLowerCase());
  return fam ? t.families.get(fam) : undefined;
}
