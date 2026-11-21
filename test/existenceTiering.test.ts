/**
 * The "what is already built?" check no longer pays for the same answer twice or sends every requirement to the strongest model:
 * a finished roadmap answers from its record, a repeated question about the same code is remembered, the first look is made by a cheaper model (whose "built"
 * answers still need a real quote, with a sample re-checked by the stronger one), and a requirement about the reference folder is not reported as missing code.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkRequirements, JUDGE_SYSTEM, type Call, type Requirement, type ExistenceResult } from "../src/existence.js";
import { roadmapCompleteAnswer, cacheKey, readCache, writeCache, newTally, countCall, renderTally } from "../src/existenceSupport.js";
import { ConfigSchema } from "../src/config.js";

let root = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const w = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), s);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "exist-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const commit = (msg = "c") => {
  git("add", "-A");
  git("commit", "-q", "-m", msg, "--allow-empty");
  return git("rev-parse", "HEAD");
};
const unit = (id: string, status: string, sha?: string) => ({
  id, title: `Unit ${id}`, area: "a", summary: "s", deps: [], refs: [], acceptance: [], status, order: 1, attempts: 1, addedBy: "plan",
  ...(status === "done" ? { done: { commit: sha, files: ["src/a.ts"], summary: "built", at: "2026-01-01T00:00:00Z" } } : {}),
});
const roadmap = (units: any[]) => w(".agent/roadmap.json", JSON.stringify({ version: 1, goal: "g", brief: "the brief", kind: "idea", conventions: [], units, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));

describe("a finished roadmap answers from its record", () => {
  test("every unit done and no work changed since the last one's commit: the answer, with no model", () => {
    w("src/a.ts", "export const a = 1;\n");
    const sha = commit();
    roadmap([unit("U001", "done", sha), unit("U002", "done", sha)]);
    const a = roadmapCompleteAnswer(root)!;
    assert.ok(a);
    assert.match(a.text, /^The roadmap is complete: 2\/2 units are done/);
    assert.match(a.text, new RegExp(`nothing in the code has changed since the last one \\(${sha.slice(0, 7)}\\)\\. Nothing is left to do\\.`));
    assert.match(a.text, /✓ U001 Unit U001 \(commit [0-9a-f]{7}, 1 file\(s\)\)/);
    assert.match(a.text, /so no model was asked/);
  });
  test("prose and the harness's own state changing since does not matter; a source change does (committed or not)", () => {
    w("src/a.ts", "export const a = 1;\n");
    const sha = commit();
    roadmap([unit("U001", "done", sha)]);
    w("README.md", "notes\n");
    w(".agent/other.json", "{}");
    commit("docs");
    assert.ok(roadmapCompleteAnswer(root));
    w("src/a.ts", "export const a = 2;\n"); // uncommitted
    assert.equal(roadmapCompleteAnswer(root), undefined);
    commit("edit");
    assert.equal(roadmapCompleteAnswer(root), undefined, "committed too");
  });
  test("not finished, no commit recorded, a commit that is not in the repository, or no roadmap: no shortcut", () => {
    w("src/a.ts", "x\n");
    const sha = commit();
    assert.equal(roadmapCompleteAnswer(root), undefined);
    roadmap([unit("U001", "done", sha), unit("U002", "todo")]);
    assert.equal(roadmapCompleteAnswer(root), undefined);
    roadmap([unit("U001", "done", undefined)]);
    assert.equal(roadmapCompleteAnswer(root), undefined);
    roadmap([unit("U001", "done", "0123456789abcdef0123456789abcdef01234567")]);
    assert.equal(roadmapCompleteAnswer(root), undefined);
  });
});

describe("the same question about the same code is remembered", () => {
  const result = (n = 1): ExistenceResult => ({ applies: true, items: [], allBuilt: n === 1, note: "" });
  test("the key follows the question, the document, the commit, uncommitted edits and new files, and ignores the harness's state", () => {
    w("src/a.ts", "export const a = 1;\n");
    commit();
    const k = () => cacheKey(root, "what is left?", "doc");
    const base = k();
    assert.ok(base && base === k());
    assert.notEqual(cacheKey(root, "something else", "doc"), base);
    assert.notEqual(cacheKey(root, "what is left?", "other doc"), base);
    w(".agent/state.json", "{}");
    assert.equal(k(), base, ".agent is ignored");
    w("src/a.ts", "export const a = 2;\n");
    const edited = k();
    assert.notEqual(edited, base);
    w("src/a.ts", "export const a = 3;\n");
    assert.notEqual(k(), edited, "the content of an uncommitted change counts, not just its path");
    w("src/new.ts", "x\n");
    const withNew = k();
    assert.notEqual(withNew, edited);
    commit();
    assert.notEqual(k(), withNew);
  });
  test("write then read; only a result that applies is kept; five are kept", () => {
    w("src/a.ts", "x\n");
    commit();
    const key = cacheKey(root, "q", undefined);
    assert.equal(readCache(root, key), undefined);
    writeCache(root, key, { applies: false, items: [], allBuilt: false, note: "" });
    assert.equal(readCache(root, key), undefined);
    writeCache(root, key, result());
    assert.equal(readCache(root, key)?.allBuilt, true);
    for (let i = 0; i < 6; i++) writeCache(root, `k${i}`, result());
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".agent/existence-cache.json"), "utf8")).length, 5);
    assert.equal(readCache(root, undefined), undefined, "no repository, no key, no cache");
  });
});

describe("the calls are counted per pass", () => {
  test("by tier and pass, with approximate tokens", () => {
    const t = newTally();
    countCall(t, "judge", "cheap", "a".repeat(4000), "b".repeat(400));
    countCall(t, "judge", "cheap", "a".repeat(4000), "");
    countCall(t, "whole-file", "strong", "a".repeat(40000), "x");
    assert.equal(renderTally(t), "[EXISTS] Calls: cheap judge 2 (~2.1k tokens) · strong whole-file 1 (~10k tokens)");
    assert.equal(renderTally(newTally()), "");
  });
});

describe("the first look is made by the cheaper model", () => {
  const LONG = (n: number) => `export const feature${n}Handler = () => renderFeatureNumber${n}WithAllItsRequiredBehaviour(${n});`;
  const reqs: Requirement[] = Array.from({ length: 6 }, (_, i) => ({ id: `R${i + 1}`, text: `Feature ${i + 1} renders`, terms: [`feature${i + 1}Handler`] }));
  const setup = () => {
    for (let i = 1; i <= 6; i++) w(`src/feature${i}.ts`, `${LONG(i)}\n`);
  };
  /** A judge that answers every requirement in the prompt: built, with a real quote from its file. */
  const judge = (log: string[][], tag: string, verdictOf: (id: string) => string = () => "built"): Call => async (m) => {
    const ids = [...m[1].content.matchAll(/^### (R\d+):/gm)].map((x) => x[1]);
    log.push([tag, ...ids]);
    return JSON.stringify({ results: ids.map((id) => ({ id, verdict: verdictOf(id), evidence: [{ file: `src/feature${id.slice(1)}.ts`, quote: LONG(Number(id.slice(1))) }], missing: id === "R1" && verdictOf(id) === "partial" ? "the empty state" : "", note: "" })) });
  };

  test("without a cheaper model, one model does everything, as before", async () => {
    setup();
    const log: string[][] = [];
    const out = await checkRequirements({ call: judge(log, "strong"), repoRoot: root, requirements: reqs });
    assert.ok(log.every((l) => l[0] === "strong"));
    assert.deepEqual(out.map((c) => c.verdict), Array(6).fill("built"));
  });

  test("the cheaper model makes the first look at all of them; the stronger one is asked about a sample only (every fifth)", async () => {
    setup();
    const log: string[][] = [];
    const out = await checkRequirements({ call: judge(log, "strong"), cheapCall: judge(log, "cheap"), repoRoot: root, requirements: reqs });
    const cheap = log.filter((l) => l[0] === "cheap").flatMap((l) => l.slice(1));
    const strong = log.filter((l) => l[0] === "strong").flatMap((l) => l.slice(1));
    assert.deepEqual(cheap.sort(), ["R1", "R2", "R3", "R4", "R5", "R6"], "everything is looked at once, by the cheaper model");
    assert.deepEqual(strong.sort(), ["R1", "R6"], "the 1st and the 6th: every fifth");
    assert.deepEqual(out.map((c) => c.verdict), Array(6).fill("built"));
  });

  test("where the stronger model does not confirm 'built', its answer replaces the first one and says so", async () => {
    setup();
    const log: string[][] = [];
    const strong = judge(log, "strong", (id) => (id === "R6" ? "partial" : "built"));
    const out = await checkRequirements({ call: strong, cheapCall: judge(log, "cheap"), repoRoot: root, requirements: reqs });
    const r6 = out.find((c) => c.req.id === "R6")!;
    assert.notEqual(r6.verdict, "built");
    assert.equal(out.find((c) => c.req.id === "R1")!.verdict, "built");
  });

  test("a cheap 'built' with a quote that is NOT in any file is not counted (it cannot invent evidence), and goes on to the stronger model", async () => {
    setup();
    const log: string[][] = [];
    const liar: Call = async (m) => {
      const ids = [...m[1].content.matchAll(/^### (R\d+):/gm)].map((x) => x[1]);
      log.push(["cheap", ...ids]);
      return JSON.stringify({ results: ids.map((id) => ({ id, verdict: "built", evidence: [{ file: "src/feature1.ts", quote: "this line is nowhere in the file at all, invented" }], missing: "", note: "" })) });
    };
    const out = await checkRequirements({ call: judge(log, "strong"), cheapCall: liar, repoRoot: root, requirements: reqs.slice(0, 2) });
    assert.ok(log.some((l) => l[0] === "strong"), "the unproven ones were asked of the stronger model");
    assert.deepEqual(out.map((c) => c.verdict), ["built", "built"], "settled by the stronger model, with a real quote");
  });

  test("anything the cheaper model does not settle goes to the stronger one", async () => {
    setup();
    const log: string[][] = [];
    await checkRequirements({ call: judge(log, "strong"), cheapCall: judge(log, "cheap", (id) => (id === "R2" ? "partial" : "built")), repoRoot: root, requirements: reqs });
    assert.ok(log.some((l) => l[0] === "strong" && l.includes("R2")));
  });
});

describe("a requirement about the reference folder", () => {
  test("it names a file in the source being ported from, so it is not reported as missing code, and no model is asked about it", async () => {
    w("src/a.ts", "export const a = 1;\n");
    const asked: string[] = [];
    const call: Call = async (m) => {
      asked.push(m[1].content);
      return JSON.stringify({ results: [] });
    };
    const reqs: Requirement[] = [
      { id: "R1", text: "Port the reducer rules into reference/timeline-port/expo_reference/timeline.ts", terms: ["reducer"] },
      { id: "R2", text: "Show the label", terms: ["label"] },
    ];
    const out = await checkRequirements({ call, repoRoot: root, requirements: reqs, exclude: ["reference/timeline-port"] });
    const r1 = out.find((c) => c.req.id === "R1")!;
    assert.equal(r1.verdict, "manual");
    assert.match(r1.note, /names a file in the reference folder, which is the source being ported from/);
    assert.ok(!asked.some((a) => a.includes("R1:")));
  });
});

describe("the wiring and the settings", () => {
  const idx = fs.readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n");
  test("a finished roadmap is answered before the cache and before any model; the cache before the check; the tally after", () => {
    const a = idx.indexOf("roadmapCompleteAnswer(repoRoot)");
    const b = idx.indexOf("const cached = readCache(repoRoot, cKey);");
    const c = idx.indexOf("const found = cached ?? await checkExistence({");
    const d = idx.indexOf("writeCache(repoRoot, cKey, found);");
    assert.ok(a > 0 && a < b && b < c && c < d);
    assert.ok(idx.includes("if (reportOnly && !docs) {\n      const quick = roadmapCompleteAnswer(repoRoot);"), "only for the roadmap's own brief, not when a document is named");
    assert.ok(idx.includes("...(useCheap ? { cheapCall: counted(\"cheap\", cheapModels) } : {}),"));
    assert.ok(idx.includes("const cheapModels = config.existence.tiered === false ? [] : (config.models.existence ?? config.models.discovery);"));
    assert.ok(!/gemini|deepseek|hydrogen/i.test(fs.readFileSync("src/existenceSupport.ts", "utf8")), "no model name is built in");
  });
  test("settings: tiered on by default, models.existence optional and unset", () => {
    assert.equal((ConfigSchema.shape as any).existence.parse({}).tiered, true);
    assert.equal((ConfigSchema.shape as any).existence.parse({ tiered: false }).tiered, false);
    assert.equal((ConfigSchema.shape as any).models.parse({ planner: ["p"] }).existence, undefined);
    assert.deepEqual((ConfigSchema.shape as any).models.parse({ planner: ["p"], existence: ["cheap/one"] }).existence, ["cheap/one"]);
  });
  test("the first-pass system prompt is the one the tally calls 'judge'", () => {
    assert.ok(typeof JUDGE_SYSTEM === "string" && JUDGE_SYSTEM.length > 50);
  });
});
