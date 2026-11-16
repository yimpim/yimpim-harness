/**
 * Regression tests for the non-destructive deletion staging added to
 * AgentTools: `stage_file_for_deletion` records intent only, accumulates
 * across phases (never reset by beginPhase), and normalizes paths so the
 * same file staged twice appears once in the end-of-run confirmation prompt.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentTools,
  TOOLS_SCHEMA,
  READ_ONLY_TOOLS_SCHEMA,
  PLANNER_TOOLS_SCHEMA,
  PLANNER_MAX_INSPECTED_FILES,
} from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-deletion-staging-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTempFile(dir: string, rel: string, content = "export const x = 1;\n"): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("stage_file_for_deletion tool schema", () => {
  test("is offered to the model with path required and reason optional", () => {
    const tool = TOOLS_SCHEMA.find((t) => t.function.name === "stage_file_for_deletion");
    assert.ok(tool, "stage_file_for_deletion must be present in TOOLS_SCHEMA");

    const params = tool!.function.parameters as any;
    assert.deepEqual(Object.keys(params.properties).sort(), ["path", "reason"]);
    assert.deepEqual(params.required, ["path"]);
    assert.match(tool!.function.description, /does NOT delete/i);
  });

  test("is not offered to the read-only advisor pass", () => {
    assert.ok(
      !READ_ONLY_TOOLS_SCHEMA.some((t) => t.function.name === "stage_file_for_deletion"),
      "staging a deletion is a mutation and must not appear in the advisor's tool list"
    );
  });
});

describe("PLANNER_TOOLS_SCHEMA and the bounded Planner inspection window", () => {
  test("offers exactly read_file and get_symbol_definition — no broad search or directory walk", () => {
    assert.deepEqual(
      PLANNER_TOOLS_SCHEMA.map((t) => t.function.name).sort(),
      ["get_symbol_definition", "read_file"]
    );
  });

  test("read_file is single-path only — the batched `paths` form is not offered to the Planner", () => {
    const readFile = PLANNER_TOOLS_SCHEMA.find((t) => t.function.name === "read_file")!;
    const params = readFile.function.parameters as any;
    // startLine/endLine are offered (re-reading the same already-inspected
    // file in a range costs no extra budget slot — see readFileBounded's
    // own tests) -- `paths` (the batched multi-file form) specifically must
    // still be absent, which is the actual thing this test guards.
    assert.deepEqual(Object.keys(params.properties).sort(), ["endLine", "path", "startLine"]);
    assert.ok(!("paths" in params.properties), "the batched paths form must never be offered to the Planner");
    assert.deepEqual(params.required, ["path"]);
  });

  test("get_symbol_definition requires both path and symbol", () => {
    const symbolTool = PLANNER_TOOLS_SCHEMA.find((t) => t.function.name === "get_symbol_definition")!;
    const params = symbolTool.function.parameters as any;
    assert.deepEqual(Object.keys(params.properties).sort(), ["path", "symbol"]);
    assert.deepEqual(params.required, ["path", "symbol"]);
  });

  test("readFileBounded reads a discovery target file and records it as inspected", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/target.ts", "export const TARGET = 1;\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/target.ts"]);

    const content = await tools.readFileBounded("src/target.ts");

    assert.match(content, /export const TARGET = 1;/);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/target.ts"]);
    assert.equal(tools.plannerInspectionBudgetLeft(), PLANNER_MAX_INSPECTED_FILES - 1);
  });

  test("opens a project file Discovery did not list, and counts it against the budget", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/target.ts");
    await writeTempFile(dir, "src/other.ts", "export const OTHER = 2;\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/target.ts"]);

    const content = await tools.readFileBounded("src/other.ts");

    assert.match(content, /OTHER = 2/);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/other.ts"]);
    assert.equal(tools.plannerInspectionBudgetLeft(), PLANNER_MAX_INSPECTED_FILES - 1);
  });

  test("still refuses a file that does not exist, a secret, and anything outside the project", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/target.ts");
    await writeTempFile(dir, ".env", "SECRET=1\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/target.ts"]);

    await assert.rejects(() => tools.readFileBounded("src/missing.ts"), /PLANNER SCOPE/);
    await assert.rejects(() => tools.readFileBounded(".env"), /PLANNER SCOPE/);
    await assert.rejects(() => tools.readFileBounded("../outside.ts"), /PLANNER SCOPE/);
    assert.deepEqual(tools.plannerInspectedThisPass(), []);
  });

  test("with no discovery target files it can still open project files, within the budget", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/target.ts", "export const TARGET = 1;\n");
    const tools = new AgentTools(dir, {} as AgentConfig);

    assert.match(await tools.readFileBounded("src/target.ts"), /TARGET = 1/);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/target.ts"]);
  });

  test("enforces the file budget across distinct files but lets a file be re-read for free", async () => {
    const dir = await makeTempDir();
    // One more file than the budget allows, so there's always a genuine
    // (n+1)th distinct file left to prove gets rejected once the budget's spent.
    const targets = Array.from({ length: PLANNER_MAX_INSPECTED_FILES + 1 }, (_, i) => `src/${String.fromCharCode(97 + i)}.ts`);
    for (const t of targets) await writeTempFile(dir, t, `export const v = "${t}";\n`);
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(targets);

    const withinBudget = targets.slice(0, PLANNER_MAX_INSPECTED_FILES);
    for (const t of withinBudget) await tools.readFileBounded(t);
    // Re-reading an already-inspected file is not exploration, so it stays allowed.
    await tools.readFileBounded(withinBudget[0]);

    assert.equal(tools.plannerInspectionBudgetLeft(), 0);
    await assert.rejects(() => tools.readFileBounded(targets[targets.length - 1]), /PLANNER INSPECTION BUDGET/);
    assert.deepEqual(tools.plannerInspectedThisPass(), withinBudget);
  });

  test("normalizes ./ prefixes and backslashes so one file cannot spend the budget twice", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/a.ts", "export const A = 1;\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["./src/a.ts"]);

    await tools.readFileBounded("./src/a.ts");
    await tools.readFileBounded("src\\a.ts");

    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/a.ts"]);
    assert.equal(tools.plannerInspectionBudgetLeft(), PLANNER_MAX_INSPECTED_FILES - 1);
  });

  test("getSymbolDefinition returns just the named declaration, not the whole file", async () => {
    const dir = await makeTempDir();
    await writeTempFile(
      dir,
      "src/tools.ts",
      [
        "export const UNRELATED = 1;",
        "",
        "export async function patchFile(path: string, search: string) {",
        "  return `${path}:${search}`;",
        "}",
        "",
        "export const AFTER = 2;",
        "",
      ].join("\n")
    );
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/tools.ts"]);

    const definition = await tools.getSymbolDefinition("src/tools.ts", "patchFile");

    assert.match(definition, /patchFile/);
    assert.match(definition, /export async function patchFile/);
    assert.doesNotMatch(definition, /UNRELATED/);
    assert.doesNotMatch(definition, /AFTER/);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/tools.ts"]);
  });

  test("getSymbolDefinition on an unknown symbol falls back to the file's declaration outline", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/tools.ts", "export function realName() {\n  return 1;\n}\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/tools.ts"]);

    const result = await tools.getSymbolDefinition("src/tools.ts", "hallucinatedName");

    assert.match(result, /No declaration for "hallucinatedName"/);
    assert.match(result, /export function realName/);
  });

  test("getSymbolDefinition follows the same rules as read_file and requires a symbol name", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/target.ts", "export function f() {}\n");
    await writeTempFile(dir, "src/other.ts", "export function g() {}\n");
    const tools = new AgentTools(dir, {} as AgentConfig);
    tools.beginPlannerInspection(["src/target.ts"]);

    // A project file Discovery did not list can be looked into; a missing one cannot.
    assert.match(await tools.getSymbolDefinition("src/other.ts", "g"), /function g/);
    await assert.rejects(() => tools.getSymbolDefinition("src/missing.ts", "g"), /PLANNER SCOPE/);
    await assert.rejects(() => tools.getSymbolDefinition("src/target.ts", "  "), /non-empty 'symbol'/);
    assert.deepEqual(tools.plannerInspectedThisPass(), ["src/other.ts"]);
  });

  test("beginPlannerInspection resets the budget for each new planning pass", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/a.ts", "export const A = 1;\n");
    await writeTempFile(dir, "src/b.ts", "export const B = 1;\n");
    const tools = new AgentTools(dir, {} as AgentConfig);

    tools.beginPlannerInspection(["src/a.ts", "src/b.ts"]);
    await tools.readFileBounded("src/a.ts");
    tools.beginPlannerInspection(["src/a.ts", "src/b.ts"]);

    assert.deepEqual(tools.plannerInspectedThisPass(), []);
    assert.equal(tools.plannerInspectionBudgetLeft(), PLANNER_MAX_INSPECTED_FILES);
  });
});

describe("AgentTools.stageFileForDeletion", () => {
  test("stages an existing file without touching it on disk", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/dead.ts");
    const tools = new AgentTools(dir, {} as AgentConfig);

    const result = await tools.stageFileForDeletion("src/dead.ts", "superseded by src/live.ts");

    assert.match(result, /Staged "src\/dead\.ts"/);
    assert.match(result, /superseded by src\/live\.ts/);
    assert.deepEqual(tools.getStagedDeletions(), ["src/dead.ts"]);
    assert.equal(fsSync.existsSync(path.join(dir, "src", "dead.ts")), true, "staging must never unlink");
  });

  test("normalizes ./ prefixes, backslashes and trailing slashes to one entry", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/dead.ts");
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.stageFileForDeletion("./src/dead.ts");
    await tools.stageFileForDeletion("src\\dead.ts");
    await tools.stageFileForDeletion("src/dead.ts/");

    assert.deepEqual(tools.getStagedDeletions(), ["src/dead.ts"]);
  });

  test("a repeat staging is idempotent and reports the earlier request still stands", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/dead.ts");
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.stageFileForDeletion("src/dead.ts", "first reason");
    const again = await tools.stageFileForDeletion("src/dead.ts", "second reason");

    assert.match(again, /already staged/i);
    assert.equal(tools.getStagedDeletions().length, 1);
    assert.equal(tools.getDeletionReason("src/dead.ts"), "first reason");
  });

  test("staging a path that does not exist reports nothing to stage", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const result = await tools.stageFileForDeletion("src/never-existed.ts");

    assert.match(result, /does not exist/i);
    assert.deepEqual(tools.getStagedDeletions(), []);
  });

  test("staged deletions survive beginPhase — they accumulate across the whole run", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/phase-one.ts");
    await writeTempFile(dir, "src/phase-two.ts");
    const tools = new AgentTools(dir, {} as AgentConfig);

    tools.beginPhase(["src/phase-one.ts"], 20, "phase 1");
    await tools.stageFileForDeletion("src/phase-one.ts");
    tools.beginPhase(["src/phase-two.ts"], 20, "phase 2");
    await tools.stageFileForDeletion("src/phase-two.ts");

    assert.deepEqual(tools.getStagedDeletions(), ["src/phase-one.ts", "src/phase-two.ts"]);
  });

  test("rejects an empty path and a path escaping the repo root", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    await assert.rejects(() => tools.stageFileForDeletion("   "), /non-empty/);
    await assert.rejects(() => tools.stageFileForDeletion("../outside.ts"), /ACCESS DENIED/);
    assert.deepEqual(tools.getStagedDeletions(), []);
  });

  test("refuses to stage a sensitive file", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, ".env");
    const tools = new AgentTools(dir, {} as AgentConfig);

    await assert.rejects(() => tools.stageFileForDeletion(".env"), /sensitive/i);
    assert.deepEqual(tools.getStagedDeletions(), []);
  });

  test("clearStagedDeletions empties the list and the recorded reasons", async () => {
    const dir = await makeTempDir();
    await writeTempFile(dir, "src/dead.ts");
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.stageFileForDeletion("src/dead.ts", "obsolete");
    tools.clearStagedDeletions();

    assert.deepEqual(tools.getStagedDeletions(), []);
    assert.equal(tools.getDeletionReason("src/dead.ts"), undefined);
  });
});
