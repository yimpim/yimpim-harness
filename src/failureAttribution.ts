/**
 * Was this test failure caused by the change, or was it already there?
 *
 * QA used to stop and ask the person ("keep, repair, or stop?"). They cannot
 * know: they did not see which test failed or what it loads. The harness can,
 * because it is a fact about the code. A test can only be affected by files it
 * loads, directly or through what it imports. So:
 *
 *   - find the failing test files in the report;
 *   - walk their imports (JS/TS and Python) through the project's own files;
 *   - if no changed file is anywhere in that set, the change cannot have caused
 *     the failure: it was already there;
 *   - if one is, the change feeds that test: repair it.
 *
 * It is one-sided on purpose. Anything it cannot establish (a config file that
 * could change every test, an import it cannot resolve, a language it does not
 * follow, no test file named) is "unknown" and goes to repair, never to "this
 * is fine".
 */
import fs from "fs";
import path from "path";
import { isSourceCodePath, isTestPath } from "./focusTests.js";

export interface Attribution {
  verdict: "unrelated" | "related" | "unknown";
  why: string;
  tests: string[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** Files that can change the behavior of EVERY test, not only the ones that import them. */
const GLOBAL_CONFIG =
  /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig[^/]*\.json|jest\.config\.[a-z]+|jest\.setup\.[a-z]+|setupTests\.[a-z]+|vitest\.config\.[a-z]+|babel\.config\.[a-z]+|\.babelrc|metro\.config\.[a-z]+|pytest\.ini|pyproject\.toml|conftest\.py|setup\.cfg|tox\.ini|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|\.env(\.[^/]*)?)$/;
/** A template that nothing loads. */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/;

/** Existing test files named in a failure report. */
export function failingTestFiles(text: string, repoRoot: string): string[] {
  const root = path.resolve(repoRoot);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/[\w@./\\-]+\.[A-Za-z0-9]{1,6}/g)) {
    const rel = norm(m[0]).replace(/[.,;:)]+$/, "");
    if (seen.has(rel) || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
    seen.add(rel);
    if (!isTestPath(rel)) continue;
    try {
      const full = path.resolve(root, rel);
      if (full.startsWith(root) && fs.statSync(full).isFile()) out.push(rel);
    } catch {
      // not a real file
    }
  }
  return out;
}

function isPackage(spec: string, repoRoot: string): boolean {
  const first = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  return fs.existsSync(path.join(repoRoot, "node_modules", first));
}

function firstExisting(repoRoot: string, bases: string[], exts: string[]): string | undefined {
  for (const base of bases) {
    for (const cand of [base, ...exts.map((e) => base + e), ...exts.map((e) => `${base}/index${e}`)]) {
      try {
        if (fs.statSync(path.join(repoRoot, cand)).isFile()) return norm(cand);
      } catch {
        // try the next
      }
    }
  }
  return undefined;
}

type Resolved = { kind: "file"; rel: string } | { kind: "external" } | { kind: "unresolved" };

function resolveJsSpec(spec: string, fromRel: string, repoRoot: string): Resolved {
  let bases: string[];
  if (spec.startsWith(".")) bases = [path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))];
  else if (spec.startsWith("@/") || spec.startsWith("~/")) bases = [`src/${spec.slice(2)}`, spec.slice(2)];
  else if (isPackage(spec, repoRoot)) return { kind: "external" };
  else bases = [spec, `src/${spec}`]; // a root-relative or mapped path
  const hit = firstExisting(repoRoot, bases, JS_EXT);
  if (hit) return { kind: "file", rel: hit };
  // A bare word that is neither a package nor a project path is a Node built-in.
  if (!spec.startsWith(".") && !spec.includes("/") && !spec.startsWith("@")) return { kind: "external" };
  return { kind: "unresolved" };
}

function resolvePySpec(mod: string, fromRel: string, repoRoot: string): Resolved {
  let base: string;
  if (mod.startsWith(".")) {
    const dots = mod.length - mod.replace(/^\.+/, "").length;
    let dir = path.posix.dirname(fromRel);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    base = path.posix.join(dir, mod.replace(/^\.+/, "").replace(/\./g, "/"));
  } else base = mod.replace(/\./g, "/");
  const hit = firstExisting(repoRoot, [base], [".py"]) ?? firstExisting(repoRoot, [`${base}/__init__`], [".py"]);
  if (hit) return { kind: "file", rel: hit };
  return mod.startsWith(".") ? { kind: "unresolved" } : { kind: "external" };
}

/** The test file plus every project file it loads, directly or not. `complete` is false if an import could not be followed. */
export function importClosure(entry: string, repoRoot: string, limit = 800): { files: Set<string>; complete: boolean } {
  const files = new Set<string>([norm(entry)]);
  const queue = [norm(entry)];
  let complete = true;
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let src = "";
    try {
      src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    } catch {
      complete = false;
      continue;
    }
    const isPy = rel.endsWith(".py");
    const isJs = /\.(?:[cm]?[jt]sx?)$/.test(rel);
    if (!isPy && !isJs) continue; // json, md, ...: a leaf
    const specs: Resolved[] = [];
    if (isJs) {
      for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*|jest\.mock\(\s*)['"]([^'"]+)['"]/g)) specs.push(resolveJsSpec(m[1], rel, repoRoot));
    } else {
      for (const m of src.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([\w, *()]+)/gm)) {
        const r = resolvePySpec(m[1], rel, repoRoot);
        specs.push(r);
        // "from pkg import mod" can name a submodule file.
        for (const name of m[2].split(",").map((s) => s.trim().replace(/[()]/g, "")).filter((s) => /^\w+$/.test(s))) {
          const sub = resolvePySpec(`${m[1].replace(/\.$/, "")}.${name}`.replace(/^\.\./, ".."), rel, repoRoot);
          if (sub.kind === "file") specs.push(sub);
        }
      }
      for (const m of src.matchAll(/^\s*import\s+([.\w]+)/gm)) specs.push(resolvePySpec(m[1], rel, repoRoot));
    }
    for (const r of specs) {
      if (r.kind === "unresolved") complete = false;
      if (r.kind === "file" && !files.has(r.rel)) {
        files.add(r.rel);
        queue.push(r.rel);
        if (files.size > limit) return { files, complete: false };
      }
    }
  }
  return { files, complete };
}

export function attributeTestFailure(args: { failureText: string; changedFiles: string[]; repoRoot: string }): Attribution {
  const unknown = (why: string, tests: string[] = []): Attribution => ({ verdict: "unknown", why, tests });
  const changed = [...new Set(args.changedFiles.map(norm))].filter((p) => p && !/(^|\/)_focus\//.test(p));
  if (changed.length === 0) return unknown("no changed files were recorded for this phase");

  const risky = changed.find((p) => GLOBAL_CONFIG.test(p) && !ENV_TEMPLATE.test(p));
  if (risky) return unknown(`${risky} is a config or setup file that can change every test`);

  const tests = failingTestFiles(args.failureText, args.repoRoot);
  if (tests.length === 0) return unknown("the failure report does not name a test file I can open");

  const changedSet = new Set(changed);
  for (const t of tests) {
    const { files, complete } = importClosure(t, args.repoRoot);
    const hit = [...files].find((f) => changedSet.has(f));
    if (hit) return { verdict: "related", why: `${t} loads ${hit}, which this phase changed`, tests };
    if (!complete) return unknown(`could not follow every import of ${t}`, tests);
    // A changed file that is not source (a doc, a template) cannot be loaded by code.
    if (!files.size) return unknown(`could not read ${t}`, tests);
  }
  const shown = changed.slice(0, 3).join(", ") + (changed.length > 3 ? `, +${changed.length - 3} more` : "");
  return {
    verdict: "unrelated",
    why: `${tests.join(", ")} and everything it loads do not include ${shown}, so this change cannot have caused it`,
    tests,
  };
}

// Re-exported so callers do not need a second import for the same decision.
export { isSourceCodePath };

/**
 * What repair is told when the failing test was already red before this phase.
 * The rule it states is the project's: a test is never skipped or left red, and
 * it is updated in place, not appended to.
 */
export function renderTestDebtSection(note: string): string {
  if (!note) return "";
  return (
    `\n\nSTALE TEST — NOT CAUSED BY YOUR DIFF: ${note}\n` +
    `The test and the code drifted apart before this phase began, so your change is not the cause and reverting it will not help. ` +
    `Decide which side is right from the phase goal, the spec or reference files in the project, and the code's current intended behavior, then fix THAT side:\n` +
    `- Code is right, test is out of date: UPDATE THE EXISTING TEST IN PLACE so its expectations (and any golden/fixture data it loads) describe what the code now does. ` +
    `Do not add a second test beside it, do not skip or comment it out, and delete it only if the behavior it covered no longer exists at all (say that you did).\n` +
    `- Code regressed against its spec: fix the code, minimally.\n` +
    `Do not leave the test red, and do not touch other tests.`
  );
}
