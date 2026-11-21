/**
 * When the planner may put questions to a person. The questionnaire belongs at the start of a completely new build, or a major piece of functionality (a roadmap's
 * own questionnaire, asked once when it is made). Every other task is worked on what the worker already knows: its open points are decided from the request and the
 * code, written into the plan, and never wait for anyone. A person who set `planning.questions: all` asked to be asked everything, and still is.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { QuestionMode } from "./planner.js";

/** A project with this many source files or fewer is a new build, not something to be changed. */
export const NEW_PROJECT_MAX_SOURCE_FILES = 10;
/** A starter template has more files than that (a scaffold is 14 or more), but is still untouched while it has few commits. */
const STARTER_MAX_SOURCE_FILES = 80;
const STARTER_MAX_COMMITS = 3;

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|py|kt|java|swift|go|rs|rb|php|cs|vue|svelte|dart|c|cc|cpp|h)$/i;
const NOT_THE_PROJECT = /(^|\/)(node_modules|dist|build|\.agent|\.git|reference|references|__tests__|tests?|docs?)\//i;

/** How many source files the project has: git's list when it is a repository, else a bounded walk. Tests, docs, reference material and dependencies do not count. */
export function sourceFileCount(repoRoot: string): number {
  const counts = (rels: string[]) => rels.filter((r) => SOURCE.test(r) && !NOT_THE_PROJECT.test(r.replace(/\\/g, "/")) && !/\.(test|spec)\./.test(r)).length;
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return counts(out.split(/\r?\n/).filter(Boolean));
  } catch {
    // not a repository: walk it, but not forever
  }
  let n = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || n > 200) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.relative(repoRoot, path.join(dir, e.name)).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (!NOT_THE_PROJECT.test(rel + "/")) walk(path.join(dir, e.name), depth + 1);
      } else if (counts([rel]) === 1) n++;
    }
  };
  walk(repoRoot, 0);
  return n;
}

/** Files that only a fresh scaffold (create-expo-app, Vite, create-react-app, create-next-app) has. */
const STARTER_FILES = [
  "scripts/reset-project.js", "app-example", "app/(tabs)/explore.tsx", "app/(tabs)/two.tsx",
  "src/assets/react.svg", "public/vite.svg", "src/logo.svg", "src/reportWebVitals.js", "src/reportWebVitals.ts", "public/next.svg",
];
/** Text that only a scaffold's own screen contains. */
const STARTER_TEXT: { file: string; text: RegExp }[] = [
  { file: "App.js", text: /Open up App\.js to start working on your app/ },
  { file: "App.tsx", text: /Open up App\.tsx to start working on your app/ },
  { file: "src/App.css", text: /logo-spin/ },
  { file: "src/App.js", text: /Edit <code>src\/App\.js<\/code> and save to reload/ },
  { file: "app/page.tsx", text: /Get started by editing/ },
];

function commitCount(repoRoot: string): number {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim()) || 0;
  } catch {
    return 0; // not a repository, or no commit yet: nothing has been built on it
  }
}

/** A scaffold nobody has built on yet: its own marker files or text are there, and the project has hardly any history. */
export function looksLikeStarter(repoRoot: string): boolean {
  let marker = STARTER_FILES.some((f) => fs.existsSync(path.join(repoRoot, f)));
  if (!marker) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      marker = typeof pkg?.scripts?.["reset-project"] === "string";
    } catch {
      // no package.json
    }
  }
  if (!marker) marker = STARTER_TEXT.some((s) => { try { return s.text.test(fs.readFileSync(path.join(repoRoot, s.file), "utf8")); } catch { return false; } });
  return marker && commitCount(repoRoot) <= STARTER_MAX_COMMITS;
}

/** A new build: almost no source, or a fresh starter template that nobody has built on yet (so a scaffold's 14 template files are not mistaken for an existing app). */
export function isNewProject(repoRoot: string): boolean {
  const n = sourceFileCount(repoRoot);
  return n <= NEW_PROJECT_MAX_SOURCE_FILES || (n <= STARTER_MAX_SOURCE_FILES && looksLikeStarter(repoRoot));
}

/**
 * The question mode for ONE task's planner. "all" and "autonomous" are the person's own choice and stand. "essential" (the default) is a question here and there, only
 * when the planner really needs it (something hard to undo, or too vague to plan), for an ordinary task; for a completely new build the questionnaire matters most, so
 * it is asked in full ("all"). Inside a roadmap's own unit it stays "essential": the roadmap's questionnaire already settled what the units follow.
 * Whatever is asked has the answer deadline, after which a model reads the question and answers it (control.ts, setTimeoutResolver).
 */
export function taskQuestionMode(configured: QuestionMode, ctx: { newProject: boolean; inRoadmapUnit: boolean }): QuestionMode {
  if (configured !== "essential") return configured;
  return ctx.newProject && !ctx.inRoadmapUnit ? "all" : "essential";
}
