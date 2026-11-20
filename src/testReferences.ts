/**
 * When a change removes or rewrites something a person can see or call (a button's label, a message, a route, an exported component), the tests
 * that mention it go stale at that moment. The Editor knows exactly what it just changed; by the time QA, the verifier and REPAIR see a failing
 * assertion that knowledge is gone and has to be reverse-engineered from the failure.
 *
 * This finds those references from the DIFF, not from anyone's memory: the quoted texts, test ids, routes and exported names on the lines the
 * change removed, minus anything the project's code still contains, searched for across the whole test suite in one pass. The result is a list
 * of `file:line` to update, in the same phase, while the change is fresh.
 *
 * It finds literal text. A test that builds a label from a variable, or checks behaviour through a shared helper, is not found; the QA gate and
 * heal still catch those later. Nothing here knows a language or framework: it reads `git diff` and greps.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { listTestFiles, isTestPath } from "./focusTests.js";
import { isScratchPath } from "./scratch.js";

export interface TestHit {
  file: string;
  line: number;
  text: string;
}

export interface Reference {
  /** What was removed or changed. */
  term: string;
  kind: "text" | "route" | "name";
  /** The source file whose change it came from. */
  from: string;
  hits: TestHit[];
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Lines the change took out of a file (working tree against the last commit), without their `-` marker. */
export function removedLines(repoRoot: string, rel: string, deleted: boolean): string[] {
  if (deleted) {
    const old = git(repoRoot, ["show", `HEAD:${rel}`]);
    return old ? old.split(/\r?\n/) : [];
  }
  const diff = git(repoRoot, ["diff", "HEAD", "-U0", "--no-color", "--", rel]);
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1));
}

const IMPORT_LINE = /^\s*(import\b|export\s+\*|export\s+\{[^}]*\}\s+from|.*\brequire\s*\()/;

/** A quoted string that looks like something a person reads or a test looks for, not a style value or an identifier. */
function looksLikeText(s: string, line: string): "text" | "route" | undefined {
  const t = s.trim();
  // A symbol or emoji used as a label (an arrow, a check mark) is short, but a test that looks for it looks for exactly that, and it is
  // almost never anything else in code, so it is searched for even when it is one character.
  if (t.length >= 1 && t.length <= 12 && /[^\x00-\x7F]/.test(t) && !/[A-Za-z]{2,}/.test(t)) return "text";
  if (t.length < 4 || t.length > 90) return undefined;
  if (!/[A-Za-z]/.test(t) || /\$\{/.test(t)) return undefined;
  if (/\.(tsx?|jsx?|json|cjs|mjs|png|jpe?g|svg|gif|ttf|otf|css)$/i.test(t) || /^(\.{1,2}\/|@|#|https?:)/.test(t)) return undefined;
  if (/^\/[a-z][\w\-/[\]()]*$/i.test(t)) return "route";
  const testIdContext = /(testID|accessibilityLabel|accessibilityHint|nativeID|data-testid|aria-label|placeholder)\s*[=:]/.test(line);
  if (/\s/.test(t) || /^[A-Z]/.test(t) || /[.!?:…]$/.test(t) || testIdContext) return "text";
  return undefined;
}

/** The things a removed line named: its texts and routes, and the names it exported. */
export function termsOf(lines: string[]): { term: string; kind: Reference["kind"] }[] {
  const out = new Map<string, Reference["kind"]>();
  for (const line of lines) {
    if (!line.trim() || IMPORT_LINE.test(line)) continue;
    for (const m of line.matchAll(/(['"`])((?:(?!\1)[^\\\n]){1,90})\1/g)) {
      const kind = looksLikeText(m[2], line);
      if (kind && !out.has(m[2].trim())) out.set(m[2].trim(), kind);
    }
    // A label written as a JSX child: <Text>Dismiss</Text>, <Button>▾</Button>. Not code: no operators, brackets or semicolons inside.
    for (const m of line.matchAll(/>\s*([^<>{}\n]{1,60}?)\s*</g)) {
      const t = m[1].trim();
      if (!t || /[=&|;(){}\\]/.test(t) || /^[\d\s.,:+\-*/%]+$/.test(t)) continue;
      const kind = looksLikeText(t, line);
      if (kind && !out.has(t)) out.set(t, kind);
    }
    const ex = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (ex && ex[1].length >= 4 && !out.has(ex[1])) out.set(ex[1], "name");
  }
  return [...out].map(([term, kind]) => ({ term, kind }));
}

/** True while the project's own (non-test) code still contains the term: then it was moved or kept, not removed. */
function stillInProject(repoRoot: string, term: string, kind: Reference["kind"], tests: Set<string>): boolean {
  const out = git(repoRoot, [
    "grep",
    // A file the change just created is untracked: a text that moved into it is not gone.
    "--untracked",
    "-lI",
    kind === "name" ? "-w" : "-F",
    ...(kind === "name" ? ["-e", term] : ["-e", term]),
    "--",
    ".",
    ":(exclude)node_modules",
    ":(exclude).agent",
    ":(exclude)docs",
    ":(exclude)*.md",
  ]);
  return out.split(/\r?\n/).filter(Boolean).some((f) => !tests.has(f) && !isTestPath(f) && !isScratchPath(f));
}

/**
 * What the change left behind in the tests. `changed` are files the change edited, `deleted` files it removed. Returns only the
 * terms that are gone from the project's code AND still named by a test.
 */
export function staleTestReferences(repoRoot: string, changed: string[], deleted: string[] = []): Reference[] {
  const tests = listTestFiles(repoRoot);
  const testSet = new Set(tests);
  const sources = [...changed.map((f) => ({ f, d: false })), ...deleted.map((f) => ({ f, d: true }))].filter(({ f }) => !isTestPath(f) && !isScratchPath(f) && /\.[A-Za-z0-9]+$/.test(f));
  if (sources.length === 0 || tests.length === 0) return [];

  const contents = new Map<string, string[]>();
  const linesOf = (t: string) => {
    let l = contents.get(t);
    if (!l) {
      try {
        l = fs.readFileSync(path.join(repoRoot, t), "utf8").split(/\r?\n/);
      } catch {
        l = [];
      }
      contents.set(t, l);
    }
    return l;
  };

  const found = new Map<string, Reference>();
  for (const { f, d } of sources) {
    for (const { term, kind } of termsOf(removedLines(repoRoot, f, d))) {
      if (found.has(term)) continue;
      const hits: TestHit[] = [];
      for (const t of tests) {
        const lines = linesOf(t);
        for (let i = 0; i < lines.length; i++) {
          if (kind === "name" ? new RegExp(`\\b${term.replace(/[$]/g, "\\$")}\\b`).test(lines[i]) : lines[i].includes(term)) hits.push({ file: t, line: i + 1, text: lines[i].trim().slice(0, 140) });
        }
      }
      if (hits.length === 0) continue;
      if (stillInProject(repoRoot, term, kind, testSet)) continue;
      found.set(term, { term, kind, from: f, hits });
    }
  }
  return [...found.values()];
}

/** The list as a person (or the Editor) reads it. `perTerm` limits only how many hits are printed for one term, never what is searched. */
export function renderReferences(refs: Reference[], perTerm = 8): string {
  if (refs.length === 0) return "";
  const lines = [
    `${refs.length} thing(s) your change removed or changed are still named by tests. Each is listed with where, so you can update them now while the change is fresh:`,
  ];
  for (const r of refs) {
    const label = r.kind === "route" ? "route" : r.kind === "name" ? "name" : "text";
    lines.push("", `${label} "${r.term}" (from ${r.from}) — ${r.hits.length} place(s):`);
    for (const h of r.hits.slice(0, perTerm)) lines.push(`  ${h.file}:${h.line}  ${h.text}`);
    if (r.hits.length > perTerm) lines.push(`  … and ${r.hits.length - perTerm} more (search the test folder for it)`);
  }
  return lines.join("\n");
}

/** A short key for a list, so the same list is not handed back twice. */
export function referencesKey(refs: Reference[]): string {
  return refs.map((r) => `${r.term}:${r.hits.length}`).sort().join("|");
}
