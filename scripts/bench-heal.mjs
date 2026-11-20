#!/usr/bin/env node
/**
 * Heal benchmark: give the harness's test healer the same broken test file, with the same app, and score what comes back.
 *
 *   node scripts/bench-heal.mjs prepare --source <project>   build the fixtures (once)
 *   node scripts/bench-heal.mjs selftest                     prove the scoring works, with no model and no cost
 *   node scripts/bench-heal.mjs run --runs 3 --yes           run the real model N times, from an identical starting point each time
 *
 * Everything happens in an isolated clone under the bench folder (default ~/yimpim-bench). The project you work in is never touched, and the
 * fixtures hold private code, so they live OUTSIDE this (public) repository.
 *
 * Build first (`npm run build`): this runs the compiled harness in dist/, the same code the CLI runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.resolve(here, "..");
const dist = path.join(harness, "dist");
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const BENCH = path.resolve(flag("--bench-dir", path.join(os.homedir(), "yimpim-bench")));
const REPO = path.join(BENCH, "repo");
const MANIFEST = path.join(BENCH, "manifest.json");
const TEST_FILE = flag("--test-file", "__tests__/dashboard.test.ts");

const run = (file, a, cwd, opts = {}) => execFileSync(file, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
const git = (cwd, ...a) => run("git", a, cwd);
const imp = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const read = (p) => fs.readFileSync(p, "utf8");

function needDist() {
  const built = path.join(dist, "testHeal.js");
  if (!fs.existsSync(built)) throw new Error("dist/ is missing: run `npm run build` in the harness first.");
  const src = path.join(harness, "src", "testHeal.ts");
  if (fs.statSync(src).mtimeMs > fs.statSync(built).mtimeMs + 1000) {
    console.log("WARNING: src/testHeal.ts is newer than dist/testHeal.js. Run `npm run build` so the benchmark tests the code you think it does.\n");
  }
}

function manifest() {
  if (!fs.existsSync(MANIFEST)) throw new Error(`No fixtures at ${BENCH}. Run: node scripts/bench-heal.mjs prepare --source <your project>`);
  return JSON.parse(read(MANIFEST));
}

/** Runs the project's own jest on one file and returns its json totals. */
function jest(file) {
  const out = path.join(os.tmpdir(), `bench-jest-${process.pid}-${Date.now()}.json`);
  spawnSync(process.execPath, [path.join(REPO, "node_modules", "jest", "bin", "jest.js"), file, "--ci", "--silent", "--json", `--outputFile=${out}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const json = JSON.parse(read(out));
  fs.rmSync(out, { force: true });
  return json;
}

/** Back to the identical starting point: the committed state, the fixture's starting test file, nothing else. */
function reset(m) {
  git(REPO, "reset", "--hard", "-q", m.baselineCommit);
  // `clean` without -x: ignored files (node_modules, a junction to the real one) are never touched.
  git(REPO, "clean", "-fdq");
  if (spawnSync("git", ["check-ignore", "-q", "node_modules"], { cwd: REPO }).status !== 0) throw new Error("node_modules is not ignored in the bench clone; refusing to run (a clean could reach it).");
  // The harness keeps its own state in .agent/ (stored diagnoses, the test log). It is git-ignored, so `clean` leaves it: a second run would
  // REUSE the first run's verdict and make no model call at all. A fresh start means none of it.
  const agent = path.join(REPO, ".agent");
  if (agent.startsWith(BENCH + path.sep)) fs.rmSync(agent, { recursive: true, force: true });
  fs.copyFileSync(path.join(BENCH, "start", TEST_FILE), path.join(REPO, TEST_FILE));
}

// ---------------------------------------------------------------------------------------------------------------------------------- prepare
function prepare() {
  const source = path.resolve(flag("--source", ""));
  if (!flag("--source") || !fs.existsSync(path.join(source, ".git"))) throw new Error("--source must be the project's folder (a git repository).");
  if (fs.existsSync(REPO) && !has("--force")) throw new Error(`${REPO} already exists. Use --force to rebuild it.`);
  if (fs.existsSync(REPO)) fs.rmSync(REPO, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(BENCH, { recursive: true });
  console.log("Cloning the project (committed state)…");
  git(BENCH, "clone", "--local", "--no-hardlinks", "-q", source, REPO);
  const baselineCommit = git(REPO, "rev-parse", "HEAD").trim();
  const modules = path.join(source, "node_modules");
  if (!fs.existsSync(modules)) throw new Error("The project has no node_modules to link: install its dependencies first.");
  // A junction (no admin rights needed) so the clone runs the project's real jest without a second install.
  run("cmd", ["/c", "mklink", "/J", path.join(REPO, "node_modules"), modules], BENCH);
  fs.mkdirSync(path.join(BENCH, "start", path.dirname(TEST_FILE)), { recursive: true });
  fs.mkdirSync(path.join(BENCH, "key", path.dirname(TEST_FILE)), { recursive: true });
  fs.copyFileSync(path.join(REPO, TEST_FILE), path.join(BENCH, "start", TEST_FILE));
  const keyFrom = path.join(source, TEST_FILE);
  fs.copyFileSync(keyFrom, path.join(BENCH, "key", TEST_FILE));
  const startJson = jest(TEST_FILE);
  const m = {
    createdAt: new Date().toISOString(),
    source,
    testFile: TEST_FILE,
    baselineCommit,
    start: { failed: startJson.numFailedTests, passed: startJson.numPassedTests, total: startJson.numTotalTests },
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  fs.mkdirSync(path.join(BENCH, "results"), { recursive: true });
  console.log(`Fixtures ready in ${BENCH}\n  starting file: ${m.start.failed} failing of ${m.start.total}\n  answer key:    copied from ${keyFrom}\nNext: node scripts/bench-heal.mjs selftest`);
}

// ----------------------------------------------------------------------------------------------------------------------------------- scoring
async function score(m, startText) {
  const sc = await imp("benchScore.js");
  const after = jest(TEST_FILE);
  const porcelain = git(REPO, "status", "--porcelain").split(/\r?\n/).filter(Boolean);
  const afterText = read(path.join(REPO, TEST_FILE));
  const i = sc.integrity({
    start: sc.statsOf(startText),
    after: sc.statsOf(afterText),
    startJest: { total: m.start.total, passed: m.start.passed, failed: m.start.failed, pending: 0 },
    afterJest: sc.jestTotals(after),
    porcelainAfter: porcelain,
  });
  const t = sc.jestTotals(after);
  return { totals: t, integrity: i, verdict: sc.verdictLine(t.passed, t.total, i), stats: { start: sc.statsOf(startText), after: sc.statsOf(afterText) }, porcelain };
}

// ---------------------------------------------------------------------------------------------------------------------------------- selftest
async function selftest() {
  needDist();
  const m = manifest();
  const startText = read(path.join(BENCH, "start", TEST_FILE));
  const keyText = read(path.join(BENCH, "key", TEST_FILE));
  const rows = [];
  const check = (name, got, want) => {
    const ok = got === want;
    rows.push({ name, got, want, ok });
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${got}${ok ? "" : ` (wanted ${want})`}`);
  };

  reset(m);
  const base = jest(TEST_FILE);
  check("the starting file fails as recorded", `${base.numFailedTests} failing of ${base.numTotalTests}`, `${m.start.failed} failing of ${m.start.total}`);

  fs.writeFileSync(path.join(REPO, TEST_FILE), keyText);
  const key = await score(m, startText);
  check("the answer key scores PASS", key.verdict.endsWith("PASS"), true);

  // cheat 1: skip tests to look green
  fs.writeFileSync(path.join(REPO, TEST_FILE), keyText.replace(/\bit\(/, "it.skip(").replace(/\bit\(/, "it.skip(").replace(/\bit\(/, "it.skip("));
  const skip = await score(m, startText);
  check("skipping tests scores FAIL", skip.verdict.endsWith("FAIL"), true);

  // cheat 2: change product code
  fs.writeFileSync(path.join(REPO, TEST_FILE), keyText);
  const comp = path.join(REPO, "src", "components", "DashboardTimeline.tsx");
  const orig = fs.existsSync(comp) ? read(comp) : undefined;
  if (orig !== undefined) {
    fs.writeFileSync(comp, orig + "\n// touched\n");
    const touched = await score(m, startText);
    check("changing product code scores FAIL even though every test passes", touched.verdict.endsWith("FAIL"), true);
  }

  // cheat 3: throw assertions away
  fs.writeFileSync(path.join(REPO, TEST_FILE), keyText.replace(/^\s*expect\([^\n]*\n/gm, (x, off) => (off % 3 === 0 ? "" : x)));
  const noAsserts = await score(m, startText);
  check("throwing away assertions does not score PASS", noAsserts.verdict.endsWith("PASS"), false);

  reset(m);
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length === 0 ? "\nThe scoring behaves. Safe to run the model." : `\n${bad.length} self-check(s) failed: the benchmark cannot be trusted yet.`);
  process.exit(bad.length === 0 ? 0 : 1);
}

// --------------------------------------------------------------------------------------------------------------------------------------- run
async function runModel() {
  needDist();
  const m = manifest();
  const runs = Number(flag("--runs", "1"));
  if (has("--check")) {
    // Wiring only: config, key, model chain and cost accounting, with one trivial prompt that contains nothing from the project.
    const { resolveConfig } = await imp("settings.js");
    const { loadApiKey } = await imp("secrets.js");
    const { OpenRouterClient } = await imp("openrouter.js");
    const { runLabeledCompletion } = await imp("agentLoop.js");
    const { events } = await imp("events.js");
    process.chdir(REPO);
    // The SAME layered resolution the CLI uses (built-in defaults, ~/.yimpim/config.yaml, the project file, YIMPIM_* env), so the benchmark
    // runs on the models and settings your real runs use.
    const resolved = resolveConfig({ repoRoot: REPO });
    const config = resolved.config;
    console.log(`[CONFIG] ${resolved.sourcePath ?? "built-in defaults"}${resolved.applied.length ? " + " + resolved.applied.join("; ") : ""}`);
    const { key } = loadApiKey();
    if (!key) throw new Error("No OpenRouter key: run `yimpim setup`.");
    const models = config.models.repair ?? config.models.editor;
    const before = events.usageReport();
    const t = Date.now();
    const reply = await runLabeledCompletion({
      client: new OpenRouterClient(key, config),
      models,
      messages: [{ role: "user", content: 'Reply with exactly this JSON and nothing else: {"ok":true}' }],
      agentName: "REPAIR",
      jsonMode: true,
      reason: "benchmark wiring check",
    });
    const u = events.usageDelta(before).totals;
    console.log(`models: ${models.join(", ")}\nreply: ${String(reply).trim().slice(0, 80)}\n${Math.round((Date.now() - t) / 100) / 10}s, ${u.total} tokens${u.costKnown ? `, $${u.cost.toFixed(5)}` : ", cost not reported"}\nThe wiring works.`);
    return;
  }
  if (!has("--yes")) {
    console.log(`This will call your real model ${runs} time(s) to heal ${TEST_FILE} in ${REPO}.\nEarlier heal runs cost roughly $0.10-$0.50 and took 10-20 minutes each. Add --yes to go ahead.\n(Add --check first for a one-prompt wiring test that costs a fraction of a cent.)`);
    return;
  }
  const startText = read(path.join(BENCH, "start", TEST_FILE));
  const { resolveConfig } = await imp("settings.js");
  const { loadApiKey } = await imp("secrets.js");
  const { OpenRouterClient } = await imp("openrouter.js");
  const { runLabeledCompletion } = await imp("agentLoop.js");
  const { events } = await imp("events.js");
  const { healTests, renderHealReport } = await imp("testHeal.js");

  const harnessRev = (() => {
    try {
      const dirty = git(harness, "status", "--porcelain").split(/\r?\n/).filter(Boolean).length;
      return `${git(harness, "rev-parse", "--short", "HEAD").trim()}${dirty ? ` (+${dirty} uncommitted file(s))` : ""}`;
    } catch {
      return "unknown";
    }
  })();
  const results = [];
  for (let n = 1; n <= runs; n++) {
    console.log(`\n=== run ${n} of ${runs} ===`);
    reset(m);
    const base = jest(TEST_FILE);
    if (base.numFailedTests !== m.start.failed) throw new Error(`The starting point is not the recorded one (${base.numFailedTests} failing, expected ${m.start.failed}). Not running.`);

    process.chdir(REPO);
    // The SAME layered resolution the CLI uses (built-in defaults, ~/.yimpim/config.yaml, the project file, YIMPIM_* env), so the benchmark
    // runs on the models and settings your real runs use.
    const resolved = resolveConfig({ repoRoot: REPO });
    const config = resolved.config;
    console.log(`[CONFIG] ${resolved.sourcePath ?? "built-in defaults"}${resolved.applied.length ? " + " + resolved.applied.join("; ") : ""}`);
    const { key } = loadApiKey();
    if (!key) throw new Error("No OpenRouter key: run `yimpim setup`.");
    const client = new OpenRouterClient(key, config);
    const models = config.models.repair ?? config.models.editor;
    const trace = { calls: 0, refusedNoCite: 0, refusedBadCite: 0, madeWorse: 0, callMs: [], steps: [] };
    const log = [];
    const call = async (messages, label, json) => {
      const last = String(messages[messages.length - 1]?.content ?? "");
      if (/Not applied: every answer that changes the test/.test(last)) trace.refusedNoCite++;
      if (/could not be verified/.test(last)) trace.refusedBadCite++;
      if (/made it WORSE/.test(last)) trace.madeWorse++;
      const t = Date.now();
      const reply = await runLabeledCompletion({ client, models, messages, agentName: "REPAIR", jsonMode: json, reason: label });
      trace.calls++;
      trace.callMs.push(Date.now() - t);
      // What it was shown and what it answered, in short: enough to see whether it keeps asking, asks for the same thing, or never commits.
      let kind = "unparsed";
      let asked = "";
      try {
        const j = JSON.parse(String(reply).replace(/^```(?:json)?s*|s*```$/g, ""));
        kind = j.need ? "need" : String(j.verdict ?? "?");
        if (j.need) asked = JSON.stringify(j.need).slice(0, 220);
        else asked = `edits=${Array.isArray(j.edits) ? j.edits.length : 0} cites=${Array.isArray(j.cites) ? j.cites.length : 0}`;
      } catch {
        asked = String(reply).slice(0, 160);
      }
      trace.steps.push({ n: trace.calls, seconds: Math.round((Date.now() - t) / 100) / 10, shownChars: last.length, shownHead: last.slice(0, 140).replace(/s+/g, " "), answered: kind, asked });
      return reply;
    };

    const usageStart = events.usageReport();
    const t0 = Date.now();
    let report;
    let crashed;
    try {
      report = await healTests({ repoRoot: REPO, all: false, call, requireCites: true, log: (l) => { log.push(l); console.log("  " + l); } });
    } catch (err) {
      crashed = String(err?.message ?? err);
      console.log("  the heal crashed: " + crashed);
    }
    const seconds = Math.round((Date.now() - t0) / 1000);
    const usage = events.usageDelta(usageStart);
    const scored = await score(m, startText);

    const statuses = {};
    for (const r of report?.results ?? []) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    const diff = spawnSync("git", ["diff", "--numstat", "--", TEST_FILE], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    const result = {
      run: n,
      at: new Date().toISOString(),
      harness: harnessRev,
      models,
      ...scored,
      statuses,
      deviations: (report?.results ?? []).flatMap((r) => [...(r.status === "app-deviation" ? [r.note] : []), ...(r.deviations ?? [])]),
      crashed,
      seconds,
      modelCalls: trace.calls,
      refusedNoCite: trace.refusedNoCite,
      refusedBadCite: trace.refusedBadCite,
      madeWorse: trace.madeWorse,
      steps: trace.steps,
      slowestCallSeconds: Math.round(Math.max(0, ...trace.callMs) / 1000),
      tokens: usage.totals.total,
      cost: usage.totals.costKnown ? usage.totals.cost : null,
      testDiff: diff,
      report: report ? renderHealReport(report) : "",
    };
    results.push(result);
    fs.writeFileSync(path.join(BENCH, "results", `run-${stamp()}-${n}.json`), JSON.stringify(result, null, 2));
    console.log(`\n  ${result.verdict}\n  ${seconds}s, ${trace.calls} model calls, ${result.tokens} tokens${result.cost === null ? "" : `, $${result.cost.toFixed(3)}`}`);
    {
      const kinds = {};
      for (const st of trace.steps) kinds[st.answered] = (kinds[st.answered] ?? 0) + 1;
      console.log(`  what it answered, by kind: ${JSON.stringify(kinds)}`);
    }
    console.log(`  refused for no citation: ${trace.refusedNoCite}, bad citation: ${trace.refusedBadCite}, undone as worse: ${trace.madeWorse}, app-deviations: ${result.deviations.length}`);
    for (const p of scored.integrity.problems) console.log("  INTEGRITY: " + p);
    for (const w of scored.integrity.warnings) console.log("  warning: " + w);
  }
  reset(m);
  summary(results, harnessRev);
}

function summary(results, harnessRev) {
  const nums = (f) => results.map(f).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const span = (a) => (a.length ? `${a[0]} / ${a[Math.floor(a.length / 2)]} / ${a[a.length - 1]}` : "n/a");
  const pass = results.filter((r) => r.verdict.endsWith("PASS")).length;
  const lines = [
    `Benchmark: ${results.length} run(s) on harness ${harnessRev}`,
    `  PASS (all green and honest): ${pass} of ${results.length}`,
    `  tests passing, min / median / max: ${span(nums((r) => r.totals.passed))} of ${results[0]?.totals.total}`,
    `  seconds, min / median / max: ${span(nums((r) => r.seconds))}`,
    `  cost $, min / median / max: ${span(nums((r) => (r.cost === null ? undefined : Number(r.cost.toFixed(3)))))}`,
    `  integrity failures: ${results.filter((r) => !r.integrity.ok).length}`,
  ];
  console.log("\n" + lines.join("\n"));
  fs.writeFileSync(path.join(BENCH, "results", `summary-${stamp()}.txt`), lines.join("\n") + "\n");
}

try {
  if (cmd === "prepare") prepare();
  else if (cmd === "selftest") await selftest();
  else if (cmd === "run") await runModel();
  else console.log(read(fileURLToPath(import.meta.url)).split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
} catch (err) {
  console.error("\n" + String(err?.message ?? err));
  process.exit(1);
}
