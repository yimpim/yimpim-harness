/**
 * `run_test`: the sandbox agent runs one test file (optionally only the tests whose name matches) and reads the WHOLE result, the way a
 * person types `npx jest file -t "name"`.
 *
 * Why it is not simply the project's own test command: that command runs through a shell on Windows (`cmd.exe`), which joins the arguments
 * with spaces and does not quote them, so a test-name pattern like `x & del /s /q C:\` would be run as a command. The runner here is started
 * directly with `node` and an argument array: the pattern is ONE argument, whatever characters it holds.
 *
 * What runs is code the agent may have just written (a test is code), so every run is gated: what changed since the last approved run is
 * screened, and anything that could run a program, delete files outside the project, or send data out goes to the security reviewer first.
 * No secret-looking environment variable reaches the test process.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { isTestPath } from "./focusTests.js";
import { SAFE, type RunTests } from "./healEdits.js";
import { injectionIn, type ReviewRequest, type ReviewOutcome } from "./commandReview.js";
import { auditText } from "./securityLint.js";

const execFileAsync = promisify(execFile);
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const posix = (p: string) => p.replace(/\\/g, "/");

// ------------------------------------------------------------------------------------------------------------------------ the runner

export interface DirectRunner {
  bin: string;
  /** The runner's own arguments, before the file and the name pattern. */
  args: string[];
  kind: "jest" | "vitest";
  /** Builds the full argument list for one run. */
  build(file: string, namePattern?: string): string[];
}

/** `package.json` of a dependency found under the project's own node_modules (the sandbox links it), and the script its `bin` names. */
function binOf(root: string, pkgName: string): string | undefined {
  try {
    const dir = path.join(root, "node_modules", pkgName);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[pkgName] ?? Object.values(pkg.bin ?? {})[0];
    if (typeof bin !== "string") return undefined;
    const abs = path.join(dir, bin);
    return fs.existsSync(abs) ? abs : undefined;
  } catch {
    return undefined;
  }
}

/** The `--config <x>` / `-c <x>` the project's own test script passes, so the same configuration is used. */
function configArgs(root: string): string[] {
  try {
    const script = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))?.scripts?.test ?? "");
    const m = /(?:^|\s)(?:--config|-c)(?:=|\s+)("[^"]+"|'[^']+'|[^\s"']+)/.exec(script);
    return m ? ["--config", m[1].replace(/^["']|["']$/g, "")] : [];
  } catch {
    return [];
  }
}

/** Jest or Vitest, started with `node` directly. Undefined when the project uses neither (the caller then runs the heal's own runner). */
export function resolveDirectRunner(root: string): DirectRunner | undefined {
  const jest = binOf(root, "jest");
  if (jest) {
    const cfg = configArgs(root);
    return {
      bin: process.execPath,
      args: [jest],
      kind: "jest",
      build: (file, namePattern) => [jest, "--ci", "--colors=false", ...cfg, file, ...(namePattern ? ["-t", namePattern] : [])],
    };
  }
  const vitest = binOf(root, "vitest");
  if (vitest) {
    return {
      bin: process.execPath,
      args: [vitest],
      kind: "vitest",
      build: (file, namePattern) => [vitest, "run", file, ...(namePattern ? ["-t", namePattern] : [])],
    };
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------------------------------ the environment

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
const SECRET_PREFIX = /^(OPENROUTER_|YIMPIM_|GITHUB_|NPM_TOKEN|AWS_|GOOGLE_|AZURE_)/i;
/** Names that look like secrets but are what a process needs to start (a Windows `SESSIONNAME` is not a credential). */
const KEEP = new Set(["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "NODE_OPTIONS", "SESSIONNAME", "PATHEXT"]);

/** The environment the test process gets: the machine's, without anything that could be a credential. */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (!KEEP.has(k.toUpperCase()) && (SECRET_NAME.test(k) || SECRET_PREFIX.test(k))) continue;
    out[k] = v;
  }
  out.CI = "true";
  out.FORCE_COLOR = "0";
  out.NO_COLOR = "1";
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ the safety gate

/** Things in code the agent ADDED that can run a program, remove files, or send data out. Each is a reason to ask the security reviewer. */
const SUSPICIOUS: { re: RegExp; why: string }[] = [
  { re: /\bchild_process\b/, why: "it uses child_process (runs programs)" },
  { re: /(?<![.\w$])(?:execSync|execFileSync|execFile|spawnSync|spawn|fork)\s*\(/, why: "it starts a program" },
  { re: /\bprocess\.kill\b/, why: "it kills a process" },
  { re: /\bfs\.(?:rm|rmdir|unlink)(?:Sync)?\s*\(|\b(?:rmSync|rimraf)\b|\bfs\.promises\.(?:rm|rmdir|unlink)\b/, why: "it deletes files" },
  { re: /\b(?:https?\.(?:request|get)|net\.(?:connect|createConnection)|dgram|tls\.connect)\b/, why: "it opens a network connection" },
  { re: /\bfetch\s*\(\s*['"`]https?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/i, why: "it requests a web address outside this machine" },
  { re: /\bnew\s+WebSocket\s*\(\s*['"`]wss?:\/\/(?!localhost\b|127\.0\.0\.1\b)/i, why: "it opens a web socket outside this machine" },
  { re: /JSON\.stringify\s*\(\s*process\.env|Object\.(?:keys|values|entries)\s*\(\s*process\.env|\.\.\.\s*process\.env|process\.env\.\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*/i, why: "it reads the whole environment or a secret-looking variable" },
  { re: /\beval\s*\(|\bnew\s+Function\s*\(/, why: "it runs text as code" },
  { re: /\brequire\s*\(\s*[^'"`\s)]|\bimport\s*\(\s*[^'"`\s)]/, why: "it loads a module chosen at run time" },
];

/**
 * Added text that is refused outright, without a reviewer: it can only mean to destroy or to hand the machine to someone. (`dangerIn` is not used here:
 * it also refuses `../` paths, `fetch(` and absolute paths in strings, which every ordinary test has, and would refuse every run.)
 */
const HARD_REFUSE: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\*|\$HOME|%USERPROFILE%)/i, why: "it deletes everything under a root or home folder" },
  { re: /\b(?:rmdir|rd)\s+\/s\b|\bdel\s+\/[fsq]\b|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i, why: "it runs a destructive shell command" },
  { re: /\bRemove-Item\b[^\n]*-Recurse/i, why: "it deletes a folder tree" },
  { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|powershell|pwsh)\b/i, why: "it downloads and runs a program" },
  { re: /\bgit\s+push\b|\bnpm\s+publish\b/i, why: "it publishes code" },
];

export interface RunGate {
  /** Asks the security model. Without one, anything the screen flags is refused (the gate fails closed). */
  review?: (req: ReviewRequest) => Promise<ReviewOutcome>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Files that differ from the sandbox's base commit (modified or new), repo-relative, never the shared dependency folders. */
export function changedFiles(root: string): string[] {
  let out = "";
  try {
    out = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  } catch {
    return [];
  }
  const files: string[] = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const rel = posix(parts[i].slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // a rename lists its old name next
    if (code.includes("D")) continue;
    if (SAFE(rel)) files.push(rel);
  }
  return files;
}

/** The lines the agent ADDED to a file (a new file: all of it). Judged on these, not the whole file: a big test full of old code is not suspect. */
function addedLines(root: string, rel: string, text: string): string[] {
  try {
    git(root, ["ls-files", "--error-unmatch", "--", rel]);
  } catch {
    return text.split(/\r?\n/); // untracked: it is all new
  }
  try {
    return git(root, ["diff", "--no-color", "-U0", "HEAD", "--", rel])
      .split(/\r?\n/)
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
  } catch {
    return text.split(/\r?\n/);
  }
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------------------------------------------------------------ the tool

export interface RunTestResult {
  /** What the model reads. */
  text: string;
  /** True when nothing was run (a refusal). */
  refused: boolean;
  /** The runner's raw output (empty when refused), for the caller's own bookkeeping. */
  output: string;
}

export interface RunTestSession {
  run(args: Record<string, unknown>): Promise<RunTestResult>;
}

export type ExecFn = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; shell: false; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (bin, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, opts);
    return { stdout, stderr };
  } catch (err: any) {
    // a failing test exits non-zero: that is the answer, not an error
    return { stdout: String(err?.stdout ?? ""), stderr: String(err?.stderr ?? err?.message ?? "") };
  }
};

const MAX_SHOWN = 24_000;

/** The output a model reads: all of it when short, else the start and the END (a test runner puts the failures and the summary last). */
export function shapeOutput(raw: string): string {
  const text = raw.replace(ANSI, "");
  if (text.length <= MAX_SHOWN) return text;
  const head = text.slice(0, 6_000);
  const tail = text.slice(-16_000);
  const cut = text.slice(6_000, -16_000).split(/\r?\n/).length;
  return `${head}\n… (${cut} lines cut) …\n${tail}`;
}

export function createRunTestSession(deps: {
  root: string;
  /** The commit the sandbox was made from (everything is judged against it). */
  base?: string;
  gate: RunGate;
  /** When the project uses neither Jest nor Vitest: the heal's own runner (whole file, no name filter). */
  fallbackRun?: RunTests;
  /**
   * For a session in the REAL project (REPAIR runs tests where it edits): the files as they are when the session starts count as already run, because the
   * QA gate has just run the project's tests as they stand. What the gate then screens is what the agent changes after that, which is what it exists for.
   * A sandbox does not need this: everything in it is judged against its base.
   */
  preapproveCurrent?: boolean;
  /** What the security reviewer is told the run is for. */
  purpose?: string;
  exec?: ExecFn;
  now?: () => number;
}): RunTestSession {
  const root = path.resolve(deps.root);
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  /** File → hash of the version already cleared to run. */
  const approved = new Map<string, string>();
  if (deps.preapproveCurrent) {
    for (const rel of changedFiles(root)) {
      try {
        const full = path.join(root, rel);
        if (fs.statSync(full).isFile() && fs.statSync(full).size <= 2 * 1024 * 1024) approved.set(rel, sha(fs.readFileSync(full, "utf8")));
      } catch {
        // a file that cannot be read now is screened when it is run
      }
    }
  }

  const refuse = (why: string): RunTestResult => ({ text: `run_test refused: ${why}`, refused: true, output: "" });

  return {
    async run(args) {
      // ---- validation: nothing outside the sandbox, nothing that is not a test file, a pattern that cannot be misread
      const file = posix(String(args.file ?? "")).replace(/^\.\//, "").trim();
      if (!file) return refuse("give the test file, e.g. __tests__/dashboard.test.ts.");
      if (!SAFE(file) || !isTestPath(file)) return refuse(`${file} is not a test file inside the project.`);
      const abs = path.resolve(root, file);
      if (!(abs + path.sep).startsWith(root + path.sep) || abs === root) return refuse(`${file} is outside the sandbox.`);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return refuse(`${file} does not exist in the sandbox.`);
      let namePattern: string | undefined;
      if (args.namePattern !== undefined && args.namePattern !== null && String(args.namePattern) !== "") {
        namePattern = String(args.namePattern);
        if (namePattern.length > 200) return refuse("namePattern is longer than 200 characters.");
        if (/[\0\r\n]/.test(namePattern)) return refuse("namePattern must be one line.");
      }

      const runner = resolveDirectRunner(root);
      const argv = runner ? runner.build(file, namePattern) : [];

      // ---- the gate: what changed since the last cleared run
      const toReview: { rel: string; hash: string; text: string; added: string[] }[] = [];
      for (const rel of changedFiles(root)) {
        let text: string;
        try {
          const full = path.join(root, rel);
          if (!fs.statSync(full).isFile() || fs.statSync(full).size > 2 * 1024 * 1024) continue;
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const hash = sha(text);
        if (approved.get(rel) === hash) continue;
        toReview.push({ rel, hash, text, added: addedLines(root, rel, text) });
      }

      const flagged: { rel: string; why: string }[] = [];
      for (const f of toReview) {
        const added = f.added.join("\n");
        const danger = injectionIn(added) ?? HARD_REFUSE.find((h) => h.re.test(added))?.why;
        if (danger) return refuse(`${f.rel} ${danger}. Remove that code; the sandbox does not run it.`);
        const why = new Set<string>();
        for (const line of f.added) for (const s of SUSPICIOUS) if (s.re.test(line)) why.add(s.why);
        if (auditText(f.rel, added).some((h) => h.severity === "defect")) why.add("it contains something that looks like a secret or an unsafe construct");
        if (why.size > 0) flagged.push({ rel: f.rel, why: [...why].join("; ") });
      }

      if (flagged.length > 0) {
        if (!deps.gate.review) return refuse(`${flagged.map((f) => `${f.rel}: ${f.why}`).join(" | ")}. A security review is needed and none is available, so it was not run.`);
        let outcome: ReviewOutcome;
        try {
          outcome = await deps.gate.review({
            argv: [runner?.bin ?? "test-runner", ...argv],
            label: `run_test ${file}${namePattern ? ` -t "${namePattern.slice(0, 60)}"` : ""}`,
            purpose: `${deps.purpose ?? "heal sandbox experiment: run the test file"} after the agent changed ${flagged.map((f) => f.rel).join(", ")}`,
            cwd: root,
            repoRoot: root,
            created: flagged.map((f) => f.rel),
            show: flagged.map((f) => f.rel),
          });
        } catch (e: any) {
          return refuse(`the security review could not be completed (${String(e?.message ?? e).slice(0, 120)}), so it was not run.`);
        }
        if (!outcome.allow) return refuse(`${outcome.why} Remove that code; the sandbox does not run it.`);
      }
      for (const f of toReview) approved.set(f.rel, f.hash);

      // ---- run
      const started = now();
      let output: string;
      let note = "";
      if (runner) {
        const r = await exec(runner.bin, argv, { cwd: root, env: scrubbedEnv(), shell: false, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
        output = `${r.stdout}\n${r.stderr}`;
      } else if (deps.fallbackRun) {
        const r = await deps.fallbackRun(root, [file]);
        output = r.output;
        note = "\n(this project's test runner could not be started directly, so the whole file was run)";
      } else {
        return refuse("this project has no test runner that can be started (Jest or Vitest) and no fallback was given.");
      }
      const seconds = Math.round((now() - started) / 100) / 10;
      const head = `--- run_test ${file}${namePattern ? ` -t "${namePattern}"` : ""} (${seconds}s)${note}`;
      return { text: `${head}\n${shapeOutput(output)}`, refused: false, output };
    },
  };
}
