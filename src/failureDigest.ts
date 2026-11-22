/**
 * Boils a failing run's raw output down to what a person sees at a glance: how many things failed, how many DISTINCT causes there are,
 * what each cause says, and the first line of the project's own code it points at, with the code around it.
 *
 * Eighty tests that all die on the same missing function print the same stack trace eighty times; sent as they are, the cause is buried
 * and the tail of the output is mostly repetition. Sent as a digest, the worker sees one cause, how often it happens, and where.
 *
 * Nothing here knows a language or a framework: it reads error headers ("...Error: message", "panic:", "AssertionError", "Expected ...")
 * and stack frames written as `path:line`, `path:line:col`, `File "path", line N` or `(File.kt:123)`, which nearly every runner prints.
 */

import fs from "fs";
import { lazyIgnore } from "./projectPaths.js";
import path from "path";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** An error header: the line that says WHAT went wrong. */
const ERROR_HEAD =
  /^\s*(?:E\s+)?(?:(?:[A-Za-z_][\w.$]*)?(?:Error|Exception|Failure)\b|panic\b|thread '.+' panicked|AssertionError|Expected\b|expected\b|Cannot\b|Unable to\b|FATAL\b|Fatal error)/;

/** A stack frame: a path (with an extension), a line number, and optionally a column. */
const FRAME = /((?:[A-Za-z]:)?[\w./\\@$~+-]+\.[A-Za-z0-9]{1,6}):(\d+)(?::\d+)?/g;
const PY_FRAME = /File "([^"]+)", line (\d+)/;

/** Code that is not the project's own, wherever the stack was printed from: dependencies and runtime internals. */
const NOISE = /(^|[\\/])(node_modules|site-packages|dist-packages|\.gradle|\.pub-cache|\.git)([\\/]|$)|^node:|^internal[\\/]|[\\/]usr[\\/](lib|local)[\\/]|<anonymous>/;
/** Generated output INSIDE the project: judged on the path within the repository, since a CI machine may well build under /build/. */
const GENERATED = /(^|\/)(dist|build|vendor|\.expo|\.next|target)\//;
const SKIP_DIRS = lazyIgnore();

const posix = (p: string) => p.replace(/\\/g, "/");

export interface Frame {
  file: string;
  line: number;
}

export interface Cluster {
  /** The error line, with the details that differ between occurrences taken out. */
  signature: string;
  /** The error line as first printed. */
  message: string;
  /** The lines that follow it (Jest prints "Expected" and "Received" there), so what the failure compared can be read. */
  detail?: string;
  count: number;
  /** The first line of the project's own code the stack points at, when it can be found. */
  frame?: Frame;
  /** The first frame inside the test file being healed, when that is known and different. */
  testFrame?: Frame;
}

export interface Digest {
  /** Failing tests, as the runner counts them (or distinct causes' total when it does not say). */
  total: number;
  clusters: Cluster[];
  /** What to hand a model. Empty when nothing error-like could be read, so the caller falls back to the raw output. */
  text: string;
}

export const signatureOf = (line: string): string =>
  line
    .trim()
    .replace(/\d+/g, "#")
    .replace(/(['"`])[^'"`]{40,}\1/g, "$1…$1")
    .slice(0, 160);

/** Finds a file named by a stack frame inside the repository: as given, relative to it, or by its bare name when that is unique. */
function resolveInRepo(repoRoot: string, raw: string, basenameIndex: () => Map<string, string[]>): string | undefined {
  const p = posix(raw);
  if (NOISE.test(p)) return undefined;
  const root = posix(path.resolve(repoRoot)).toLowerCase();
  let rel = p;
  if (p.toLowerCase().startsWith(root + "/")) rel = p.slice(root.length + 1);
  else if (/^([A-Za-z]:)?\//.test(p)) rel = "";
  if (rel && !rel.startsWith("..")) {
    try {
      if (fs.statSync(path.join(repoRoot, rel)).isFile()) return GENERATED.test(rel) ? undefined : rel;
    } catch {
      // not there as written
    }
  }
  const base = p.split("/").pop() ?? "";
  const hits = basenameIndex().get(base);
  return hits && hits.length === 1 && !GENERATED.test(hits[0]) ? hits[0] : undefined;
}

function indexByBasename(repoRoot: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 40_000) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = posix(path.relative(repoRoot, path.join(dir, e.name)));
        const list = map.get(e.name);
        if (list) list.push(rel);
        else map.set(e.name, [rel]);
      }
    }
  };
  walk(repoRoot);
  return map;
}

/** The frames written in a stretch of lines, in order, that are the project's own and exist. */
function framesIn(repoRoot: string, lines: string[], index: () => Map<string, string[]>): Frame[] {
  const out: Frame[] = [];
  for (const l of lines) {
    const py = PY_FRAME.exec(l);
    const found: [string, number][] = py ? [[py[1], Number(py[2])]] : [];
    if (!py) {
      FRAME.lastIndex = 0;
      for (let m = FRAME.exec(l); m; m = FRAME.exec(l)) found.push([m[1], Number(m[2])]);
    }
    for (const [raw, line] of found) {
      const file = resolveInRepo(repoRoot, raw, index);
      if (file) out.push({ file, line });
    }
  }
  return out;
}

/** Lines `line-before .. line+after` of a file, numbered, with the failing line marked. */
export function excerptAround(repoRoot: string, f: Frame, before = 8, after = 8): string {
  try {
    const all = fs.readFileSync(path.join(repoRoot, f.file), "utf-8").split(/\r?\n/);
    const from = Math.max(1, f.line - before);
    const to = Math.min(all.length, f.line + after);
    const width = String(to).length;
    const rows: string[] = [];
    for (let n = from; n <= to; n++) rows.push(`${n === f.line ? ">" : " "} ${String(n).padStart(width)} | ${all[n - 1].slice(0, 200)}`);
    return rows.join("\n");
  } catch {
    return "";
  }
}

const TOP_CAUSES = 3;
const MAX_TEXT = 7000;

/**
 * @param testFile the test file being healed (repo-relative): a frame inside it is shown too, since that is where the cause is exercised.
 */
export function digestFailure(output: string, repoRoot: string, testFile?: string, top: number = TOP_CAUSES): Digest {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  let index: Map<string, string[]> | undefined;
  const byBase = () => (index ??= indexByBasename(repoRoot));

  const groups = new Map<string, { message: string; count: number; at: number }>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /^at\s/.test(t) || !ERROR_HEAD.test(lines[i])) continue;
    const sig = signatureOf(t);
    const g = groups.get(sig);
    if (g) g.count++;
    else groups.set(sig, { message: t.slice(0, 300), count: 1, at: i });
  }
  if (groups.size === 0) return { total: 0, clusters: [], text: "" };

  // How many tests failed, when the runner says so; else the number of error headers read.
  const named = new Set<string>();
  for (const l of lines) {
    const m = /^\s*●\s+(.+)$/.exec(l) ?? /^\s*(?:FAILED|FAIL:|---\s*FAIL:)\s+(\S.*)$/.exec(l);
    if (m) named.add(m[1].trim().slice(0, 140));
  }
  const errorHeads = [...groups.values()].reduce((n, g) => n + g.count, 0);
  const total = Math.max(named.size, errorHeads);

  const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[1].at - b[1].at);
  const clusters: Cluster[] = ranked.slice(0, top).map(([signature, g]) => {
    const block = lines.slice(g.at, g.at + 45);
    const frames = framesIn(repoRoot, block, byBase);
    const test = testFile ? posix(testFile) : undefined;
    const frame = frames.find((f) => f.file !== test) ?? frames[0];
    const testFrame = test ? frames.find((f) => f.file === test && f !== frame) : undefined;
    return { signature, message: g.message, detail: block.slice(0, 14).join("\n"), count: g.count, frame, testFrame };
  });

  const parts: string[] = [];
  const distinct = groups.size;
  parts.push(`${total} failure${total === 1 ? "" : "s"}, ${distinct} distinct cause${distinct === 1 ? "" : "s"}${distinct > clusters.length ? ` (the ${clusters.length} most common are shown)` : ""}.`);
  for (const c of clusters) {
    parts.push(`\n[${c.count}×] ${c.message}`);
    if (c.frame) {
      parts.push(`  first points at ${c.frame.file}:${c.frame.line}`);
      const ex = excerptAround(repoRoot, c.frame);
      if (ex) parts.push(ex);
    }
    if (c.testFrame) {
      parts.push(`  exercised from the test at ${c.testFrame.file}:${c.testFrame.line}`);
      const ex = excerptAround(repoRoot, c.testFrame, 6, 6);
      if (ex) parts.push(ex);
    }
  }
  if (named.size > 0) {
    const names = [...named].slice(0, 6);
    parts.push(`\nFailing: ${names.join(" | ")}${named.size > names.length ? ` … and ${named.size - names.length} more` : ""}`);
  }
  return { total, clusters, text: parts.join("\n").slice(0, MAX_TEXT) };
}
