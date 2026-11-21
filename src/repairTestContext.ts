/**
 * What REPAIR is shown when the failure is a failing TEST, besides the runner's output: the code of the failing tests themselves, and the code the failure
 * points at. The heal learned that an agent that has to go and find these spends its first rounds on it (and the stronger model's rounds are the expensive
 * ones), so they are put in front of it. Other kinds of failure (a build error, a screenshot) have no failing test and get nothing from here.
 */
import fs from "fs";
import path from "path";
import { failingNames } from "./healAuthority.js";
import { failingTestFiles } from "./failureAttribution.js";
import { extractFailingBlocks } from "./healSandbox.js";
import { lineOfTest } from "./testNames.js";
import { excerptAround } from "./failureDigest.js";
import { isTestPath } from "./focusTests.js";

export interface TestTierContext {
  /** The failing test files, repo-relative. */
  files: string[];
  /** The failing tests' full names as the runner printed them. */
  names: string[];
  /** The block for a prompt (never empty). */
  text: string;
}

const CODE_REF = /([\w@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|kt|java|swift|py|go|rs|rb|php|cs)):(\d+)(?::\d+)?/g;
const MAX_FILES = 3;
const MAX_REFS = 4;
const REF_CONTEXT = 10;

const posix = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** `file:line` references in a failure, in order, that are the project's own application code and exist; each place once, a place near an earlier one is not repeated. */
function referencedCode(failure: string, repoRoot: string, alreadyShown: { file: string; line: number }[]): { file: string; line: number }[] {
  const root = path.resolve(repoRoot);
  const out: { file: string; line: number }[] = [];
  const near = (a: { file: string; line: number }, b: { file: string; line: number }) => a.file === b.file && Math.abs(a.line - b.line) <= REF_CONTEXT;
  for (const m of failure.matchAll(CODE_REF)) {
    const file = posix(m[1]);
    const line = Number(m[2]);
    if (!Number.isFinite(line) || line < 1) continue;
    if (path.isAbsolute(file) || file.split("/").some((s) => s === ".." || s === "node_modules" || s === ".agent" || s === ".git")) continue;
    if (isTestPath(file)) continue; // the failing tests are shown whole, by name
    const ref = { file, line };
    if (out.some((o) => near(o, ref)) || alreadyShown.some((o) => near(o, ref))) continue;
    try {
      const full = path.resolve(root, file);
      if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(ref);
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

/**
 * The test-tier context for a failure text, or undefined when it is not a failing test (no test is named, or none of its files can be found).
 * `failure` is the failure as REPAIR is shown it (the digest, which already prints an excerpt for the main causes, is recognised and not repeated).
 */
export function testTierContext(failure: string, repoRoot: string): TestTierContext | undefined {
  const names = failingNames(failure);
  if (names.length === 0) return undefined;
  const files = failingTestFiles(failure, repoRoot).slice(0, MAX_FILES);
  if (files.length === 0) return undefined;

  const parts: string[] = [];
  const shownFiles: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const here = names.filter((n) => lineOfTest(lines, n) >= 0);
    if (here.length === 0) continue;
    const blocks = extractFailingBlocks(text, here, 5000);
    if (!blocks) continue;
    shownFiles.push(file);
    parts.push(`${file}:\n${blocks}`);
  }
  if (parts.length === 0) return undefined;

  const text: string[] = [`THE FAILING TESTS' CODE (already extracted from the test file${parts.length > 1 ? "s" : ""}: do not re-read these ranges)\n${parts.join("\n\n")}`];

  // The places the digest already printed an excerpt for ("first points at app/x.tsx:123") are not printed again.
  const shown = [...failure.matchAll(/points at ([^\s:]+):(\d+)/g)].map((m) => ({ file: posix(m[1]), line: Number(m[2]) }));
  const refs = referencedCode(failure, repoRoot, shown);
  if (refs.length > 0) {
    const blocks = refs.map((r) => `${r.file}:${r.line}\n${excerptAround(repoRoot, r, REF_CONTEXT, REF_CONTEXT)}`).filter((b) => b.includes("\n") && b.split("\n")[1]);
    if (blocks.length > 0) text.push(`CODE THE FAILURE POINTS AT (not shown above; the failing line is marked >)\n${blocks.join("\n\n")}`);
  }
  return { files: shownFiles, names, text: text.join("\n\n") };
}
