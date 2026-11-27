/**
 * Which tests a change can affect, worked out from the code itself: each test's import graph (what it pulls in,
 * directly or through other files) against the files that changed. Changing a button's text in the settings screen
 * selects the tests that reach that screen; a test for creating an account never imports it, so it is not run.
 *
 * Anything this cannot be sure about is RUN, never skipped: a test whose imports cannot all be resolved, and any change
 * to project-wide config (package.json, jest/babel/tsconfig/metro config, test setup files).
 *
 * `failsBefore` answers the other half: when a selected test fails, did it already fail before this phase? It runs
 * just those files against the last commit in a throwaway worktree, so only the changed area ever gets a baseline.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { listTestFiles } from "./focusTests.js";
import { runSuite, failingTestFiles, type SuiteRun } from "./testRun.js";

const execFileAsync = promisify(execFile);

const posix = (p: string) => p.replace(/\\/g, "/");
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py"];
export const GLOBAL_CONFIG = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|jest\.config\.[\w.]+|jest\.setup\.[\w.]+|jest-setup\.[\w.]+|setupTests?\.[\w.]+|babel\.config\.[\w.]+|\.babelrc|tsconfig[\w.-]*\.json|metro\.config\.[\w.]+|vitest\.config\.[\w.]+|pytest\.ini|conftest\.py|pyproject\.toml|setup\.cfg)$/;

export interface TestSelection {
  selected: string[];
  skipped: string[];
  /** Selected only because the graph could not be sure (a subset of `selected`). */
  uncertain: string[];
  /** Selected because every test is: project-wide config changed. */
  everything: boolean;
}

interface Alias {
  prefix: string;
  targets: string[];
}

function loadAliases(repoRoot: string): Alias[] {
  const out: Alias[] = [];
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const raw = fs.readFileSync(path.join(repoRoot, f), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const co = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"))?.compilerOptions ?? {};
      const base = posix(String(co.baseUrl ?? "."));
      for (const [key, vals] of Object.entries<any>(co.paths ?? {})) {
        out.push({
          prefix: key.replace(/\*$/, ""),
          targets: (Array.isArray(vals) ? vals : []).map((v) => posix(path.posix.normalize(path.posix.join(base, String(v).replace(/\*$/, ""))))),
        });
      }
      if (co.baseUrl && base !== ".") out.push({ prefix: "", targets: [base + "/"] });
    } catch {}
  }
  // Conventional aliases that need no config to be understood.
  if (!out.some((a) => a.prefix === "@/")) out.push({ prefix: "@/", targets: ["src/", ""] });
  if (!out.some((a) => a.prefix === "~/")) out.push({ prefix: "~/", targets: ["src/", ""] });
  return out;
}

const SPEC = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*|\b(?:jest|vi)\.(?:mock|requireActual|doMock|unmock)\(\s*|\bjest\.requireMock\(\s*)['"]([^'"\n]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;

function specsOf(rel: string, content: string): string[] {
  const out: string[] = [];
  if (/\.py$/.test(rel)) {
    let m: RegExpExecArray | null;
    PY_IMPORT.lastIndex = 0;
    while ((m = PY_IMPORT.exec(content))) out.push(m[1] ?? m[2]);
    return out;
  }
  let m: RegExpExecArray | null;
  SPEC.lastIndex = 0;
  while ((m = SPEC.exec(content))) out.push(m[1]);
  return out;
}

class Graph {
  private deps = new Map<string, { files: string[]; unresolved: boolean }>();
  private aliases: Alias[];
  constructor(private repoRoot: string) {
    this.aliases = loadAliases(repoRoot);
  }

  private exists(rel: string): boolean {
    try {
      return fs.statSync(path.join(this.repoRoot, rel)).isFile();
    } catch {
      return false;
    }
  }

  private probe(base: string): string | undefined {
    for (const ext of EXTS) if (this.exists(base + ext)) return base + ext;
    return undefined;
  }

  /** undefined = a package or the standard library (not ours); "?" = ours, but not found. */
  private resolve(fromRel: string, spec: string): string | undefined {
    if (/\.py$/.test(fromRel)) {
      const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
      const parts = spec.replace(/^\.+/, "").split(".").filter(Boolean);
      const dir = dots > 0 ? path.posix.join(path.posix.dirname(fromRel), ...Array(Math.max(dots - 1, 0)).fill("..")) : "";
      const base = path.posix.join(dir, ...parts);
      return this.probe(base) ?? (dots > 0 ? "?" : undefined);
    }
    if (spec.startsWith(".")) return this.probe(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))) ?? "?";
    for (const a of this.aliases) {
      if (a.prefix && spec.startsWith(a.prefix)) {
        for (const t of a.targets) {
          const hit = this.probe(path.posix.normalize(t + spec.slice(a.prefix.length)));
          if (hit) return hit;
        }
        return "?";
      }
    }
    return undefined;
  }

  depsOf(rel: string): { files: string[]; unresolved: boolean } {
    const cached = this.deps.get(rel);
    if (cached) return cached;
    const entry = { files: [] as string[], unresolved: false };
    this.deps.set(rel, entry);
    let content = "";
    try {
      content = fs.readFileSync(path.join(this.repoRoot, rel), "utf-8");
    } catch {
      entry.unresolved = true;
      return entry;
    }
    for (const spec of specsOf(rel, content)) {
      const r = this.resolve(rel, spec);
      if (r === "?") entry.unresolved = true;
      else if (r) entry.files.push(r);
    }
    return entry;
  }

  /** Every file a test reaches, and whether any import along the way could not be resolved. */
  reach(testRel: string): { files: Set<string>; unresolved: boolean } {
    const files = new Set<string>([testRel]);
    let unresolved = false;
    const stack = [testRel];
    while (stack.length) {
      const cur = stack.pop()!;
      const d = this.depsOf(cur);
      if (d.unresolved) unresolved = true;
      for (const f of d.files) {
        if (files.has(f)) continue;
        files.add(f);
        stack.push(f);
      }
    }
    return { files, unresolved };
  }
}

/** Every file each of these tests reaches, and whether any import along the way could not be resolved. One graph is shared. */
export function reachMany(repoRoot: string, tests: string[]): Map<string, { files: Set<string>; unresolved: boolean }> {
  const g = new Graph(repoRoot);
  const out = new Map<string, { files: Set<string>; unresolved: boolean }>();
  for (const t of tests) out.set(posix(t), g.reach(posix(t)));
  return out;
}

/** Every file a test reaches (itself included), through imports and aliases. */
export function reachableFiles(repoRoot: string, testRel: string): string[] {
  return [...new Graph(repoRoot).reach(posix(testRel)).files];
}

/** The tests a change can affect. `changed` is every file the phase touched (modified, added, deleted, renamed). */
export function selectTests(repoRoot: string, changed: string[]): TestSelection {
  const tests = listTestFiles(repoRoot).map(posix);
  const ch = new Set(changed.map(posix));
  if ([...ch].some((f) => GLOBAL_CONFIG.test(f))) return { selected: tests, skipped: [], uncertain: [], everything: true };

  const graph = new Graph(repoRoot);
  const selected: string[] = [];
  const skipped: string[] = [];
  const uncertain: string[] = [];
  for (const t of tests) {
    const { files, unresolved } = graph.reach(t);
    if ([...files].some((f) => ch.has(f))) selected.push(t);
    else if (unresolved) {
      selected.push(t);
      uncertain.push(t);
    } else skipped.push(t);
  }
  return { selected, skipped, uncertain, everything: false };
}

export interface BaselineOptions {
  repoRoot: string;
  files: string[];
  run?: (root: string, files: string[]) => Promise<SuiteRun>;
}

/**
 * Of these test files, the ones that already failed on the last commit (before the phase's edits). Files that do not
 * exist there are new, so they cannot have been failing. `undefined` when the baseline could not be taken, which callers
 * treat as "assume the phase caused it".
 */
export async function failsBefore(opts: BaselineOptions): Promise<Set<string> | undefined> {
  const { repoRoot, files } = opts;
  const run = opts.run ?? runSuite;
  let tmp = "";
  let wt = "";
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-base-"));
    wt = path.join(tmp, "wt");
    await execFileAsync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: repoRoot });
    const nm = path.join(repoRoot, "node_modules");
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, "node_modules"))) fs.symlinkSync(nm, path.join(wt, "node_modules"), "junction");
    const there = files.filter((f) => fs.existsSync(path.join(wt, f)));
    if (there.length === 0) return new Set();
    // Run all baseline files in ONE batched invocation to avoid spawning N concurrent Jest/Vitest processes.
    const batched = await run(wt, there);
    if (batched.ok) return new Set();
    if (there.length === 1) return new Set(there);
    const parsed = failingTestFiles(batched.output);
    const thereSet = new Set(there.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")));
    const matched = parsed.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => thereSet.has(f));
    if (matched.length > 0) return new Set(matched);
    // Fallback when a custom runner didn't print per-file FAIL lines: run sequentially (never N-way parallel).
    const red = new Set<string>();
    for (const f of there) {
      const r = await run(wt, [f]);
      if (!r.ok) red.add(f);
    }
    return red;
  } catch {
    return undefined;
  } finally {
    try {
      if (wt) await execFileAsync("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
    } catch {}
    try {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}
