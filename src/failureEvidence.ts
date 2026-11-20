/**
 * The facts a person gathers before deciding whether a failing test or the code is wrong, collected the way they would: with grep and git,
 * no model involved.
 *
 * A failure message says WHAT broke. Whether the TEST is out of date or the CODE is wrong is decided by a handful of questions the
 * repository can answer: does the thing the code calls exist; which tests replace that module with a mock, and does the mock provide it;
 * when did the code start calling it, and did that change touch the test; when did the text the app now shows appear, and with what
 * commit message. A heal that is handed those answers does not have to rediscover them with a larger model, or guess.
 *
 * Everything here is read-only (git grep, git log) and best effort: a question that cannot be answered is left out, never invented.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { Cluster, Digest } from "./failureDigest.js";
import { isTestPath } from "./focusTests.js";

/** Files an agent or a tool leaves behind (test reports, scratch scripts, the harness's own state): they hold the app's text without being the app. */
const SCRATCH = [":(exclude).agent", ":(exclude).jest*", ":(exclude)*/.jest*", ":(exclude)jest-*", ":(exclude)*/jest-*", ":(exclude)*report*", ":(exclude)*summary*", ":(exclude)*failures*", ":(exclude)PROGRESS.md"];

const posix = (p: string) => p.replace(/\\/g, "/");

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** The name of the missing or undefined thing a failure message is about, when it says one. */
export function symbolFromMessage(message: string): string | undefined {
  const m = message.replace(/\u001b\[[0-9;]*m/g, "");
  const patterns: RegExp[] = [
    /\(0\s*,\s*[\w$]+\.([\w$]+)\)\s+is not a function/, // babel/jest: (0 , _mod.name) is not a function
    /[\w$]+\.([\w$]+) is not a function/, //                obj.name is not a function
    /(?:TypeError: )?([\w$]+) is not a function/,
    /([\w$]+) is not defined/, //                          ReferenceError
    /NameError: name '([\w$]+)' is not defined/,
    /ImportError: cannot import name '([\w$]+)'/,
    /has no attribute '([\w$]+)'/,
    /does not provide an export named '([\w$]+)'/,
  ];
  for (const re of patterns) {
    const hit = re.exec(m);
    if (hit?.[1] && !/^(undefined|null|this|object|function)$/i.test(hit[1])) return hit[1];
  }
  return undefined;
}

/** Where a name is exported or defined in the project's own code (not in tests): up to three `file:line`. */
export function whereDefined(repoRoot: string, name: string): { file: string; line: number }[] {
  const re = `(export\\s+(default\\s+)?(async\\s+)?(function\\*?|const|let|var|class|type|interface)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b|^\\s*def\\s+${name}\\s*\\(|^func\\s+${name}\\s*\\()`;
  const out = git(repoRoot, ["grep", "-nIE", re, "--", ":(exclude)node_modules", ":(exclude)dist", ":(exclude)build"]);
  const found: { file: string; line: number }[] = [];
  for (const row of out.split(/\r?\n/)) {
    const m = /^([^:]+):(\d+):/.exec(row);
    if (!m) continue;
    const file = posix(m[1]);
    if (isTestPath(file) || /(^|\/)(reference|docs?)\//.test(file)) continue;
    found.push({ file, line: Number(m[2]) });
    if (found.length >= 3) break;
  }
  return found;
}

export interface MockFactory {
  file: string;
  line: number;
  provides: boolean;
  keepsReal: boolean;
}

const mockCall = /\b(?:jest|vi)\.mock\(\s*(['"`])([^'"`]+)\1/g;

/**
 * Test files that replace the module a name is defined in with a mock, and whether each mock provides that name (or keeps the real
 * module underneath). The factory body is read up to its closing line, which is a good-enough boundary for the usual layouts.
 */
export function mockFactoriesFor(repoRoot: string, definingFile: string, name: string): MockFactory[] {
  const defNoExt = posix(definingFile).replace(/\.[cm]?[jt]sx?$/, "");
  const files = git(repoRoot, ["ls-files", "-z"]).split("\0").filter((f) => f && isTestPath(f) && /\.[cm]?[jt]sx?$/.test(f));
  const out: MockFactory[] = [];
  const wanted = new RegExp(`\\b${name}\\b`);
  for (const rel of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(".mock(")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      mockCall.lastIndex = 0;
      const hit = mockCall.exec(lines[i]);
      if (!hit) continue;
      const arg = hit[2];
      const resolved = arg.startsWith(".") ? posix(path.posix.normalize(path.posix.join(path.posix.dirname(posix(rel)), arg))) : arg.replace(/^@\//, "src/");
      const same = resolved === defNoExt || resolved.replace(/\/index$/, "") === defNoExt.replace(/\/index$/, "") || defNoExt.endsWith("/" + resolved.replace(/^\.?\/*/, ""));
      if (!same) continue;
      // A one-line mock closes on the line it opens; a factory spread over lines closes on a line that is just "}));" or "});".
      let end = i;
      if (!(/\)\)?;?\s*$/.test(lines[i]) && !/\(\{\s*$/.test(lines[i]))) {
        while (end < lines.length - 1 && end - i < 80 && !(end > i && /^\s*\}\)\)?;?\s*$/.test(lines[end]))) end++;
      }
      const body = lines.slice(i, end + 1).join("\n");
      out.push({ file: posix(rel), line: i + 1, provides: wanted.test(body), keepsReal: /requireActual|importActual|jest\.requireActual/.test(body) });
    }
  }
  return out;
}

/** The first commit that put a name into a file, with its subject, and whether that same commit changed the given test file. */
export function introducedBy(repoRoot: string, name: string, file: string, testFile: string): { hash: string; subject: string; touchedTest: boolean } | undefined {
  const log = git(repoRoot, ["log", `-S${name}`, "--format=%h%x09%s", "--reverse", "--", file]).split(/\r?\n/).find(Boolean);
  if (!log) return undefined;
  const [hash, ...rest] = log.split("\t");
  const changed = git(repoRoot, ["show", "--name-only", "--format=", hash]).split(/\r?\n/).map(posix);
  return { hash, subject: rest.join("\t"), touchedTest: changed.includes(posix(testFile)) };
}

/** The text a failing assertion expected and the text it got, when the message shows both as strings. */
export function expectedAndReceived(message: string): { expected: string; received: string } | undefined {
  const m = message.replace(/\u001b\[[0-9;]*m/g, "");
  const grab = (re: RegExp) => re.exec(m)?.[1];
  const expected = grab(/Expected substring:\s*"([^"\n]{3,120})"/) ?? grab(/Expected(?: value)?:\s*"([^"\n]{3,120})"/);
  const received = grab(/Received string:\s*"([^"\n]{3,200})"/) ?? grab(/Received(?: value)?:\s*"([^"\n]{3,200})"/);
  return expected && received ? { expected, received } : undefined;
}

const snippet = (s: string) => s.replace(/\s+/g, " ").slice(0, 40).trim();

/** When a piece of text first appeared in the project's own code, and the subject of the commit that put it there. */
function whenTextAppeared(repoRoot: string, text: string, notInTests = true): { hash: string; date: string; subject: string; file?: string } | undefined {
  const s = snippet(text);
  if (s.length < 4) return undefined;
  const log = git(repoRoot, ["log", `-S${s}`, "--format=%h%x09%ad%x09%s", "--date=short", "--reverse", "--", ".", ":(exclude)node_modules", ...(notInTests ? [":(exclude)*test*", ":(exclude)__tests__", ":(exclude)reference", ...SCRATCH] : [])]).split(/\r?\n/).find(Boolean);
  if (!log) return undefined;
  const [hash, date, ...rest] = log.split("\t");
  return { hash, date, subject: rest.join("\t") };
}

/** The quoted texts on one line of source that look like something a user reads (a label, a message), not a path or an identifier. */
export function textsOnLine(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/(['"`])((?:(?!\1)[^\\\n]){6,80})\1/g)) {
    const s = m[2].trim();
    if (!/[A-Za-z]/.test(s) || /^[./@#]/.test(s) || /\.(tsx?|jsx?|json|cjs|mjs|png|svg)$/i.test(s) || /\$\{/.test(s) || /^[a-z]+(-[a-z]+)+$/.test(s)) continue;
    if (!found.includes(s)) found.push(s);
  }
  return found.slice(0, 2);
}

/**
 * For a failure on a line of a TEST: does the app still contain the text the test looks for? A test that searches for a label or a message
 * the app no longer has is out of date, and the commit that last changed that text says why. Read from the line the failure points at.
 */
function textTheTestLooksFor(repoRoot: string, cluster: Cluster): string[] {
  const f = cluster.frame;
  if (!f || !isTestPath(f.file)) return [];
  let line = "";
  try {
    line = fs.readFileSync(path.join(repoRoot, f.file), "utf8").split(/\r?\n/)[f.line - 1] ?? "";
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const text of textsOnLine(line)) {
    const probe = snippet(text);
    // The app's own code, and separately the written spec: a text only the spec has is a text the CODE is missing.
    const inCode = git(repoRoot, ["grep", "-nIF", probe, "--", ":(exclude)node_modules", ":(exclude)*test*", ":(exclude)__tests__", ":(exclude)reference", ...SCRATCH, ":(exclude)docs", ":(exclude)*.md"]).split(/\r?\n/).find(Boolean);
    if (inCode) {
      out.push(`The test looks for "${probe}", which the app still has at ${inCode.split(":").slice(0, 2).join(":")}.`);
      continue;
    }
    const inSpec = git(repoRoot, ["grep", "-nIF", probe, "--", "docs", "*.md", ":(exclude)node_modules"]).split(/\r?\n/).find(Boolean);
    if (inSpec) {
      out.push(
        `The test looks for "${probe}". The app's own code does not contain it, but the written spec does (${inSpec.split(":").slice(0, 2).join(":")}): the CODE may be missing what the spec requires, so do not change the test to match.`
      );
      continue;
    }
    const last = git(repoRoot, ["log", `-S${probe}`, "--format=%h%x09%ad%x09%s", "--date=short", "-n", "1", "--", ".", ":(exclude)node_modules", ":(exclude)*test*", ":(exclude)__tests__", ":(exclude)reference", ...SCRATCH]).split(/\r?\n/).find(Boolean);
    const [hash, date, ...subject] = (last ?? "").split("\t");
    out.push(`The test looks for "${probe}" and nothing in the app's own code contains it any more${hash ? ` (last changed in ${hash} on ${date}: "${subject.join(" ").slice(0, 90)}")` : ""}.`);
  }
  return out;
}

/** The evidence for one cause, as lines a person (or a model) can read. Empty when nothing could be established. */
export function evidenceFor(repoRoot: string, testFile: string, cluster: Cluster): string[] {
  const lines: string[] = [];
  lines.push(...textTheTestLooksFor(repoRoot, cluster));
  const name = symbolFromMessage(cluster.message);
  if (name) {
    const defined = whereDefined(repoRoot, name);
    if (defined.length === 0) {
      lines.push(`\`${name}\` is not defined or exported anywhere in the project's own code, so it may not exist at all: check the code that calls it.`);
    } else {
      lines.push(`\`${name}\` is defined at ${defined.map((d) => `${d.file}:${d.line}`).join(", ")}.`);
      const mocks = mockFactoriesFor(repoRoot, defined[0].file, name);
      for (const mk of mocks) {
        lines.push(
          mk.provides
            ? `${mk.file}:${mk.line} mocks that module and provides \`${name}\`.`
            : mk.keepsReal
              ? `${mk.file}:${mk.line} mocks that module but keeps the real one underneath (\`${name}\` is available).`
              : `${mk.file}:${mk.line} mocks that module WITHOUT \`${name}\`: a call to it fails there. That mock is out of date.`
        );
      }
      if (cluster.frame) {
        const origin = introducedBy(repoRoot, name, cluster.frame.file, testFile);
        if (origin) {
          lines.push(
            `The code in ${cluster.frame.file} started using \`${name}\` in ${origin.hash} "${origin.subject.slice(0, 90)}", which ${origin.touchedTest ? "also changed" : "did NOT change"} ${testFile}.`
          );
        }
      }
    }
  }
  const er = expectedAndReceived(cluster.detail ?? cluster.message);
  if (er) {
    const appeared = whenTextAppeared(repoRoot, er.received);
    const expectedStill = git(repoRoot, ["grep", "-nIF", snippet(er.expected), "--", ":(exclude)node_modules", ":(exclude)*test*", ":(exclude)__tests__", ":(exclude)reference", ...SCRATCH]).split(/\r?\n/).find(Boolean);
    lines.push(`The test expects "${snippet(er.expected)}" and the app gives "${snippet(er.received)}".`);
    if (appeared) lines.push(`The app's "${snippet(er.received)}" first appeared in ${appeared.hash} on ${appeared.date}: "${appeared.subject.slice(0, 90)}".`);
    lines.push(expectedStill ? `The app still has "${snippet(er.expected)}" at ${expectedStill.split(":").slice(0, 2).join(":")}.` : `Nothing in the app's own code contains "${snippet(er.expected)}" any more: the app changed away from what the test expects.`);
  }
  return lines;
}

/** The evidence for the most common causes in a digest, as a block for a prompt. Empty when there is none. */
export function evidenceText(repoRoot: string, testFile: string, digest: Digest): string {
  const parts: string[] = [];
  for (const c of digest.clusters) {
    const lines = evidenceFor(repoRoot, testFile, c);
    if (lines.length > 0) parts.push(`For "${c.message.slice(0, 110)}" (${c.count}×):\n${lines.map((l) => `  - ${l}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
