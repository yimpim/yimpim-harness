/**
 * The repo map stays true to the code, whatever happened to the code: a symbol
 * moved, renamed or deleted; a file renamed, split, merged or deleted; a new
 * file; an edit made by hand. One rule covers them all, so each case below is a
 * way the code can change, not a special case.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  fileState,
  fingerprintOf,
  loadRepoMap,
  mergeComponentEntry,
  promptView,
  recordConfirmedFindings,
  saveRepoMap,
  RepoMapEntry,
} from "../src/repoMap.js";
import { describeSync, extractDeclaredSymbols, syncRepoMap } from "../src/repoMapSync.js";
import { renderShortlist, shortlistFromMap } from "../src/mapShortlist.js";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });

/** A git repo holding these files, and a repo map that registered each of them. */
function project(files: Record<string, string>, register: Record<string, string[]> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rms-"));
  for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const map: Record<string, RepoMapEntry> = {};
  for (const [rel, symbols] of Object.entries(register)) {
    const name = rel.replace(/\W+/g, "_");
    map[name] = { ...mergeComponentEntry(undefined, { path: rel, summary: `${rel} summary`, exports: symbols.slice(0, 4) }, fingerprintOf(dir, rel)), symbols };
  }
  saveRepoMap(dir, map);
  return dir;
}

function put(dir: string, rel: string, body: string) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  // A distinct modified time, so a same-size edit is still seen as an edit.
  const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1e6));
  fs.utimesSync(full, t, t);
}

const entryAt = (dir: string, rel: string) => Object.values(loadRepoMap(dir)).find((e) => e.path === rel);

const A = `export function alpha() { return 1; }\nexport function beta() { return 2; }\n`;
const B = `export function gamma() { return 3; }\n`;

describe("extractDeclaredSymbols", () => {
  test("reads declarations in the languages it knows", () => {
    assert.deepEqual(
      extractDeclaredSymbols(
        `export function aa() {}\nexport const bb = () => 1;\nconst cc = async (x) => x;\nclass Dd {\n  run() {\n    return 1;\n  }\n}\nexport { cc as exportedC };\n`,
        "x.ts"
      )!.sort(),
      ["Dd", "aa", "bb", "cc", "exportedC", "run"].sort()
    );
    assert.deepEqual(extractDeclaredSymbols("def one():\n  pass\nclass Two:\n  def three(self):\n    pass\n", "m.py")!.sort(), ["Two", "one", "three"]);
    assert.deepEqual(extractDeclaredSymbols("fun topLevel() {}\nclass Klass {\n    fun inner() {}\n}\nobject Obj\n", "A.kt")!.sort(), ["Klass", "Obj", "inner", "topLevel"]);
    assert.deepEqual(extractDeclaredSymbols("func Run() {}\nfunc (s *Srv) Stop() {}\ntype Srv struct {}\n", "a.go")!.sort(), ["Run", "Srv", "Stop"]);
    assert.deepEqual(extractDeclaredSymbols("pub fn go_now() {}\nstruct Pt;\nenum Ek {}\n", "a.rs")!.sort(), ["Ek", "Pt", "go_now"]);
  });

  test("a language it does not read gives undefined, so symbols are never emptied by mistake", () => {
    assert.equal(extractDeclaredSymbols("int main() {}", "a.cpp"), undefined);
    assert.equal(extractDeclaredSymbols("{}", "a.json"), undefined);
  });
});

describe("a symbol moved", () => {
  test("to a file already in the map", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    put(d, "src/b.ts", B + `export function beta() { return 2; }\n`);
    const r = syncRepoMap(d, { touched: ["src/a.ts", "src/b.ts"] });
    assert.deepEqual(r.moved, [{ symbol: "beta", from: "src/a.ts", to: "src/b.ts" }]);
    assert.deepEqual(entryAt(d, "src/a.ts")!.symbols, ["alpha"]);
    assert.ok(entryAt(d, "src/b.ts")!.symbols!.includes("beta"));
  });

  test("to a brand-new file nobody had mapped", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    put(d, "src/extracted.ts", `export function beta() { return 2; }\n`);
    syncRepoMap(d, { touched: ["src/a.ts", "src/extracted.ts"] });
    const e = entryAt(d, "src/extracted.ts")!;
    assert.deepEqual(e.symbols, ["beta"]);
    assert.match(e.summary!, /Declares beta \(moved from src\/a\.ts\)/);
  });

  test("by hand, with nobody saying which files changed", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    put(d, "src/elsewhere/new.ts", `export function beta() { return 2; }\n`);
    const r = syncRepoMap(d);
    assert.deepEqual(r.moved.map((m) => [m.symbol, m.to]), [["beta", "src/elsewhere/new.ts"]]);
  });
});

describe("a symbol renamed or deleted", () => {
  test("renamed inside its file: the old name goes, the new one is recorded", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    put(d, "src/a.ts", `export function alpha() { return 1; }\nexport function betaV2() { return 2; }\n`);
    const r = syncRepoMap(d, { touched: ["src/a.ts"] });
    assert.deepEqual(entryAt(d, "src/a.ts")!.symbols!.sort(), ["alpha", "betaV2"]);
    assert.deepEqual(r.dropped, [{ symbol: "beta", from: "src/a.ts" }]);
  });

  test("deleted: dropped from the entry, and not invented elsewhere", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    const r = syncRepoMap(d, { touched: ["src/a.ts"] });
    assert.deepEqual(r.moved, []);
    assert.deepEqual(entryAt(d, "src/b.ts")!.symbols, ["gamma"]);
  });
});

describe("a file renamed, split, merged or deleted", () => {
  test("renamed: the entry follows the file and keeps what was written about it", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    fs.rmSync(path.join(d, "src/a.ts"));
    put(d, "src/renamed.ts", A);
    const r = syncRepoMap(d, { touched: ["src/a.ts", "src/renamed.ts"] });
    assert.deepEqual(r.renamed, [{ from: "src/a.ts", to: "src/renamed.ts" }]);
    assert.equal(entryAt(d, "src/a.ts"), undefined);
    assert.equal(entryAt(d, "src/renamed.ts")!.summary, "src/a.ts summary");
  });

  test("split into several files: each new file is mapped with what it now holds", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    fs.rmSync(path.join(d, "src/a.ts"));
    put(d, "src/one.ts", `export function alpha() { return 1; }\n`);
    put(d, "src/two.ts", `export function beta() { return 2; }\n`);
    syncRepoMap(d, { touched: ["src/a.ts", "src/one.ts", "src/two.ts"] });
    assert.equal(entryAt(d, "src/a.ts"), undefined);
    assert.ok(entryAt(d, "src/one.ts")!.symbols!.includes("alpha"));
    assert.ok(entryAt(d, "src/two.ts")!.symbols!.includes("beta"));
  });

  test("merged into one file: both old entries go and the merged file holds all of it", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    fs.rmSync(path.join(d, "src/a.ts"));
    fs.rmSync(path.join(d, "src/b.ts"));
    put(d, "src/all.ts", A + B);
    syncRepoMap(d, { touched: ["src/a.ts", "src/b.ts", "src/all.ts"] });
    assert.equal(entryAt(d, "src/a.ts"), undefined);
    assert.equal(entryAt(d, "src/b.ts"), undefined);
    assert.deepEqual(entryAt(d, "src/all.ts")!.symbols!.sort(), ["alpha", "beta", "gamma"]);
  });

  test("deleted outright: the entry is removed", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    fs.rmSync(path.join(d, "src/b.ts"));
    const r = syncRepoMap(d);
    assert.deepEqual(r.removed, ["src/b.ts"]);
    assert.equal(entryAt(d, "src/b.ts"), undefined);
  });
});

describe("what it will not guess", () => {
  test("a name declared in many places is not relocated, because it cannot be said which", () => {
    const files: Record<string, string> = { "src/a.ts": `export function render() {}\nexport function keep() {}\n` };
    for (let i = 0; i < 5; i++) files[`src/c${i}.ts`] = `export function render() {}\n`;
    const d = project(files, { "src/a.ts": ["render", "keep"] });
    put(d, "src/a.ts", `export function keep() {}\n`);
    const r = syncRepoMap(d, { touched: ["src/a.ts"] });
    assert.deepEqual(r.moved, []);
    assert.deepEqual(r.dropped, [{ symbol: "render", from: "src/a.ts" }]);
  });

  test("a language it does not read is only re-stamped; its symbols are left alone", () => {
    const d = project({ "src/native.cpp": "int main() { return 0; }\n" }, { "src/native.cpp": ["main"] });
    put(d, "src/native.cpp", "int main() { return 1; }\n// edited\n");
    syncRepoMap(d, { touched: ["src/native.cpp"] });
    const e = entryAt(d, "src/native.cpp")!;
    assert.deepEqual(e.symbols, ["main"]);
    assert.equal(fileState(e, d), "fresh");
  });

  test("an entry whose file did not change is left exactly as it was", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha", "beta"], "src/b.ts": ["gamma"] });
    const before = JSON.stringify(entryAt(d, "src/b.ts"));
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    syncRepoMap(d, { touched: ["src/a.ts"] });
    assert.equal(JSON.stringify(entryAt(d, "src/b.ts")), before);
  });
});

describe("confirmation survives only what QA passed", () => {
  const confirmed = (d: string) => {
    const map = loadRepoMap(d);
    for (const e of Object.values(map)) Object.assign(e, { confirmedAt: "2026-01-01T00:00:00.000Z", feature: "Show worker reasons", flow: ["a", "b"] });
    saveRepoMap(d, map);
  };

  test("a file a task changed and QA passed keeps its confirmation, but not the flow written about the old code", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    confirmed(d);
    put(d, "src/a.ts", A + `export function extra() {}\n`);
    syncRepoMap(d, { touched: ["src/a.ts"], viaTask: true });
    const e = entryAt(d, "src/a.ts")!;
    assert.ok(e.confirmedAt);
    assert.equal(e.flow, undefined);
    assert.ok(e.symbols!.includes("extra"));
  });

  test("a file edited by hand confirms nothing: confirmation, feature and flow all go", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    confirmed(d);
    put(d, "src/a.ts", A + `export function extra() {}\n`);
    syncRepoMap(d);
    const e = entryAt(d, "src/a.ts")!;
    assert.equal(e.confirmedAt, undefined);
    assert.equal(e.feature, undefined);
    assert.equal(e.flow, undefined);
  });

  test("re-registering a component keeps a confirmation only if the file is exactly the same", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha"] });
    confirmed(d);
    const prev = entryAt(d, "src/a.ts")!;
    const same = mergeComponentEntry(prev, { path: "src/a.ts", summary: "s", exports: [] }, fingerprintOf(d, "src/a.ts"));
    assert.ok(same.confirmedAt && same.flow);
    put(d, "src/a.ts", A + "// changed\n");
    const changed = mergeComponentEntry(prev, { path: "src/a.ts", summary: "s", exports: [] }, fingerprintOf(d, "src/a.ts"));
    assert.equal(changed.confirmedAt, undefined);
    assert.equal(changed.flow, undefined);
  });
});

describe("a file a task adds", () => {
  test("is mapped, and confirmed because QA passed", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha", "beta"] });
    put(d, "src/fresh.ts", `export function brandNew() {}\n`);
    syncRepoMap(d, { touched: ["src/fresh.ts"], viaTask: true, addNew: "Added by: show worker reasons" });
    const e = entryAt(d, "src/fresh.ts")!;
    assert.deepEqual(e.symbols, ["brandNew"]);
    assert.ok(e.confirmedAt);
  });
});

describe("remembering what a passed task found", () => {
  const out = (files: any[], flow: string[] = []) => "```json\n" + JSON.stringify({ taskFindings: { existingFiles: files, existingFlow: flow } }) + "\n```";

  test("updates the existing entry in place instead of adding a second one", () => {
    const d = project({ "src/a.ts": A }, { "src/a.ts": ["alpha"] });
    const before = Object.keys(loadRepoMap(d)).length;
    recordConfirmedFindings(d, "Show reasons", out([{ path: "src/a.ts", symbols: ["alpha", "beta"], whyRelevant: "Owns it." }], ["x", "y"]));
    const map = loadRepoMap(d);
    assert.equal(Object.keys(map).length, before);
    const e = entryAt(d, "src/a.ts")!;
    assert.equal(e.feature, "Show reasons");
    assert.deepEqual(e.flow, ["x", "y"]);
    assert.ok(e.confirmedAt);
  });

  test("a file with no entry gets one; the 'files it read' stub is never remembered", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha"] });
    recordConfirmedFindings(d, "T", out([{ path: "src/b.ts", symbols: ["gamma"], whyRelevant: "Has gamma." }]));
    assert.ok(entryAt(d, "src/b.ts"));
    const stub = project({ "src/a.ts": A }, {});
    assert.equal(recordConfirmedFindings(stub, "T", out([{ path: "src/a.ts", whyRelevant: "Unconfirmed: it was read." }])), undefined);
  });

  test("the map keeps to its size limit", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`src/f${i}.ts`] = `export const v${i} = () => ${i};\n`;
    const reg = Object.fromEntries(Object.keys(files).map((f) => [f, ["x"]]));
    const d = project(files, reg);
    recordConfirmedFindings(d, "T", out([{ path: "src/f0.ts", symbols: ["v0"], whyRelevant: "w" }]), 5);
    assert.ok(Object.keys(loadRepoMap(d)).length <= 5);
    assert.ok(entryAt(d, "src/f0.ts"), "the entry just confirmed is never the one evicted");
  });
});

describe("what the agents see", () => {
  test("every agent's map is lean, and flags an entry whose file changed since", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha"], "src/b.ts": ["gamma"] });
    put(d, "src/a.ts", A + "// edited\n");
    const view = promptView(loadRepoMap(d), d);
    const a = Object.values(view).find((v) => v.path === "src/a.ts")!;
    const b = Object.values(view).find((v) => v.path === "src/b.ts")!;
    assert.equal(a.stale, true);
    assert.equal(b.stale, undefined);
    assert.deepEqual(Object.keys(b).sort(), ["exports", "path", "summary"]);
  });

  test("Discovery's shortlist says what to trust and what to re-read", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, { "src/a.ts": ["alpha"], "src/b.ts": ["gamma"] });
    const map = loadRepoMap(d);
    for (const e of Object.values(map)) Object.assign(e, { confirmedAt: "2026-01-01", feature: "alpha gamma work", flow: ["alpha calls gamma"], symbols: e.exports });
    saveRepoMap(d, map);
    put(d, "src/a.ts", A + "// edited\n");
    const text = renderShortlist(shortlistFromMap("alpha and gamma", loadRepoMap(d), 8, d));
    assert.match(text, /src\/a\.ts .*\[CHANGED since it was recorded: re-read it\]/);
    assert.match(text, /src\/b\.ts .*\[confirmed by an earlier task that passed QA; unchanged since\]/);
    assert.match(text, /How these fit together, as earlier tasks found it:/);
    assert.match(text, /read only the exact parts this task needs; re-read anything marked CHANGED/);
  });

  test("the sync log says what happened in plain words", () => {
    const lines = describeSync({
      restamped: 1,
      removed: ["a.ts"],
      renamed: [{ from: "b.ts", to: "c.ts" }],
      moved: [{ symbol: "foo", from: "x.ts", to: "y.ts" }],
      added: ["z.ts"],
      dropped: [{ symbol: "q", from: "x.ts" }],
    });
    assert.deepEqual(lines, ["foo moved from x.ts to y.ts", "b.ts is now c.ts", "a.ts was deleted", "z.ts added to the map", "1 recorded name(s) no longer exist or are too ambiguous to follow"]);
  });
});

describe("entries written before fingerprints existed", () => {
  test("their own 'last updated' time says whether the file changed since", () => {
    const d = project({ "src/a.ts": A }, {});
    const written = Date.now() - 1000;
    fs.utimesSync(path.join(d, "src/a.ts"), new Date(written - 5000), new Date(written - 5000));
    const legacy: RepoMapEntry = { path: "src/a.ts", summary: "old", exports: ["alpha"], lastUpdated: written };
    assert.equal(fileState(legacy, d), "fresh");
    fs.utimesSync(path.join(d, "src/a.ts"), new Date(written + 60000), new Date(written + 60000));
    assert.equal(fileState(legacy, d), "changed");
    assert.equal(fileState({ path: "src/a.ts" }, d), "unverified");
  });

  test("so a legacy entry whose file moved on is re-derived the first time", () => {
    const d = project({ "src/a.ts": A, "src/b.ts": B }, {});
    const old = Date.now() - 100000;
    saveRepoMap(d, {
      A: { path: "src/a.ts", summary: "a", exports: ["alpha", "beta"], lastUpdated: old },
      B: { path: "src/b.ts", summary: "b", exports: ["gamma"], lastUpdated: old },
    });
    put(d, "src/a.ts", `export function alpha() { return 1; }\n`);
    put(d, "src/b.ts", B + `export function beta() { return 2; }\n`);
    // The files are newer than the entries, and nobody said which changed.
    const r = syncRepoMap(d);
    assert.deepEqual(r.moved.map((m) => [m.symbol, m.to]), [["beta", "src/b.ts"]]);
  });
});

describe("how many the map remembers, and how many a model is shown", () => {
  const big = (n: number): { dir: string; map: Record<string, RepoMapEntry> } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rmsbig-"));
    const map: Record<string, RepoMapEntry> = {};
    // Entries newer than their files, so none of them counts as changed.
    const base = Date.now() + 2_000_000;
    for (let i = 0; i < n; i++) {
      const rel = `src/mod${i}.ts`;
      put(dir, rel, `export const v${i} = ${i};\n`);
      map[`Mod${i}`] = { path: rel, summary: `module ${i}`, exports: [`v${i}`], lastUpdated: base + i };
    }
    saveRepoMap(dir, map);
    return { dir, map };
  };

  test("the defaults: remember a thousand, show a model fifty", async () => {
    const { DEFAULT_MAX_ENTRIES, DEFAULT_PROMPT_ENTRIES } = await import("../src/repoMap.js");
    assert.equal(DEFAULT_MAX_ENTRIES, 1000);
    assert.equal(DEFAULT_PROMPT_ENTRIES, 50);
  });

  test("a large map is not trimmed: 300 entries are all kept", () => {
    const { dir } = big(300);
    syncRepoMap(dir, { touched: ["src/mod0.ts"] });
    assert.equal(Object.keys(loadRepoMap(dir)).length, 300);
  });

  test("an explicit smaller limit still evicts the oldest", () => {
    const { dir } = big(40);
    put(dir, "src/mod0.ts", "export const v0 = 99;\nexport const extra = 1;\n");
    syncRepoMap(dir, { touched: ["src/mod0.ts"], maxEntries: 30 });
    const map = loadRepoMap(dir);
    assert.equal(Object.keys(map).length, 30);
    assert.ok(map["Mod0"], "the entry just worked on is never the one evicted");
  });

  test("a model is shown only the most recently updated entries, however many are remembered", () => {
    const { dir, map } = big(120);
    const view = promptView(map, dir);
    assert.equal(Object.keys(view).length, 50);
    assert.ok(view["Mod119"] && view["Mod70"]);
    assert.equal(view["Mod69"], undefined);
    assert.equal(Object.keys(promptView(map, dir, 10)).length, 10);
  });

  test("a changed file is still flagged inside the entries a model is shown", () => {
    const { dir, map } = big(60);
    put(dir, "src/mod59.ts", "export const v59 = 'edited';\n// changed\n");
    const later = new Date(Date.now() + 10_000_000); // after the entry was written
    fs.utimesSync(path.join(dir, "src/mod59.ts"), later, later);
    assert.equal(promptView(map, dir)["Mod59"].stale, true);
  });

  test("every agent's prompt says how many more there are, so nothing looks missing by accident", async () => {
    const { buildContextualSystemPrompt } = await import("../src/agentLoop.js");
    const { dir } = big(80);
    const cfg: any = { prompts: { systemPersona: "You are YIMPIM." }, memory: { maxPromptEntries: 50 } };
    const prompt = buildContextualSystemPrompt("EDITOR", cfg, dir);
    assert.match(prompt, /showing the 50 most recently updated of 80/);
    assert.equal((prompt.match(/"path": "src\/mod\d+\.ts"/g) ?? []).length, 50);
  });
});
