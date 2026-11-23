/**
 * Every model role is a role everywhere: in the schema, in /model, in setup, in `config list` / `config set`, and on the phone. Existence and
 * Repair Planner were the two that were not: Existence was read by the code but offered nowhere, and the repair planner had no role at all (it
 * always ran on the Planner's models). Both are optional and follow another role when unset, so nothing changes until someone sets them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "../src/config.js";
import { PERSONAS, roleInfoWire, unsetLabel, candidatesFor, type CatalogModel } from "../src/models.js";
import { SETTINGS, findSetting, resolveConfig, writeSetting, clearSetting } from "../src/settings.js";
import { cmdConfigList } from "../src/cli.js";
import { chainsForOneModel, emptyChains } from "../src/setup.js";
import { ModelQueue } from "../src/modelQueue.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const roleKeys = PERSONAS.map((p) => p.key as string);
const labelOf = (k: string) => PERSONAS.find((p) => p.key === k)?.label ?? k;

/** resolveConfig with no personal global file underneath. */
function resolveClean(opts: { configPath?: string; overrides?: string[]; env?: Record<string, string> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-roles-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-roles-repo-"));
  const saved: Record<string, string | undefined> = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  for (const k of Object.keys(opts.env ?? {})) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  Object.assign(process.env, opts.env ?? {});
  try {
    return resolveConfig({ repoRoot: repo, configPath: opts.configPath, overrides: opts.overrides ?? [] }).config;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("one list of roles, everywhere", () => {
  test("every models.* key in the schema is a role, and every role is a models.* key", () => {
    const block = src("src/config.ts").split("\n  models: z")[1].split("\n  designer: z")[0];
    const schemaKeys = [...block.matchAll(/^ {6}(\w+): z\.array\(z\.string\(\)\)/gm)].map((m) => m[1]);
    assert.deepEqual([...schemaKeys].sort(), [...roleKeys].sort());
    assert.ok(schemaKeys.includes("existence") && schemaKeys.includes("repairPlanner"));
  });

  test("every role is registered as models.<role>, so `config list` shows it and `config set models.<role>` works", () => {
    for (const key of roleKeys) {
      const def = findSetting(`models.${key}`);
      assert.ok(def, `models.${key} is in the settings list`);
      assert.equal(def!.type, "string[]");
      assert.equal(def!.group, "Models");
    }
    assert.equal(SETTINGS.filter((s: { key: string }) => s.key.startsWith("models.")).length, PERSONAS.length, "and nothing else under models.*");
  });

  test("`config list` prints every role", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-roles-list-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      cmdConfigList(home);
    } finally {
      console.log = log;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
    const out = lines.join("\n");
    for (const key of roleKeys) assert.ok(out.includes(`models.${key}\n`) || out.includes(`models.${key} `) || out.includes(`models.${key}\r`), `models.${key} is listed`);
  });

  test("every role saves to a config file and reads back, and an optional one can be cleared again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-roles-file-"));
    const file = path.join(dir, "agent.config.yaml");
    try {
      for (const key of roleKeys) writeSetting(file, `models.${key}`, ["vendor/one", "other/two"]);
      const config = resolveClean({ configPath: file });
      for (const key of roleKeys) assert.deepEqual((config.models as any)[key], ["vendor/one", "other/two"], key);
      for (const p of PERSONAS) if (p.optional) clearSetting(file, `models.${p.key}`);
      const cleared = resolveClean({ configPath: file }).models as any;
      for (const p of PERSONAS) assert.equal(p.optional ? cleared[p.key] : cleared[p.key]?.length > 0, p.optional ? undefined : true, p.key);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--set and a YIMPIM_ variable work for both new roles", () => {
    const viaSet = resolveClean({ overrides: ["models.existence=a/b,c/d", "models.repairPlanner=e/f"] }).models as any;
    assert.deepEqual(viaSet.existence, ["a/b", "c/d"]);
    assert.deepEqual(viaSet.repairPlanner, ["e/f"]);
    const viaEnv = resolveClean({ env: { YIMPIM_MODELS_EXISTENCE: "g/h", YIMPIM_MODELS_REPAIRPLANNER: "i/j" } }).models as any;
    assert.deepEqual(viaEnv.existence, ["g/h"]);
    assert.deepEqual(viaEnv.repairPlanner, ["i/j"]);
  });
});

describe("Existence follows Discovery, and the Repair Planner follows the Planner, until they are set", () => {
  test("no default is changed: the four required roles keep theirs, and the new two are unset", () => {
    const m = ConfigSchema.parse({}).models as any;
    assert.equal(m.existence, undefined);
    assert.equal(m.repairPlanner, undefined);
    assert.deepEqual(m.discovery, m.planner);
    assert.deepEqual(Object.keys(m).sort(), ["discovery", "editor", "planner", "verifier"]);
  });

  test("the code reads them with those fallbacks, and the repair planner is no longer hard-wired to the Planner", () => {
    const idx = src("src/index.ts");
    assert.match(idx, /config\.models\.existence \?\? config\.models\.discovery/);
    assert.match(idx, /models: config\.models\.repairPlanner \?\? config\.models\.planner,\n\s*agentName: "REPAIR_PLANNER"/);
    assert.doesNotMatch(idx, /models: config\.models\.planner,\n\s*agentName: "REPAIR_PLANNER"/);
  });

  test("/model says what an unset one uses, instead of a bare (unset)", () => {
    const existence = PERSONAS.find((p) => p.key === "existence")!;
    const repairPlanner = PERSONAS.find((p) => p.key === "repairPlanner")!;
    assert.equal(unsetLabel(existence, labelOf), "(unset: uses Discovery)");
    assert.equal(unsetLabel(repairPlanner, labelOf), "(unset: uses Planner)");
    assert.equal(unsetLabel(PERSONAS.find((p) => p.key === "security")!, labelOf), "(unset)");
    assert.match(src("src/index.ts"), /unsetLabel\(p, \(k\) => PERSONAS\.find/);
  });

  test("a change to the repair planner mid-run waits for it to finish, like the other roles", () => {
    const models: Record<string, any> = { planner: ["p/one"], repairPlanner: ["r/old"] };
    const queue = new ModelQueue(models, ["planner", "repairPlanner"]);
    queue.agentStarted("REPAIR_PLANNER");
    assert.equal(queue.queue("repairPlanner", ["r/new"]), "queued");
    assert.deepEqual(models.repairPlanner, ["r/old"], "still the old one while it is working");
    queue.agentEnded("REPAIR_PLANNER");
    assert.deepEqual(models.repairPlanner, ["r/new"]);
  });
});

describe("/model, setup and the phone offer every role", () => {
  test("/model lists every role there is (it is built from the one list)", () => {
    const idx = src("src/index.ts");
    const fn = idx.slice(idx.indexOf("async function changeModel("), idx.indexOf("\n}\n", idx.indexOf("async function changeModel(")));
    assert.match(fn, /options: PERSONAS\.map\(/);
    assert.ok(PERSONAS.length >= 14);
  });

  test("setup asks for them: both are optional and not left to the specialist step, so the per-role pass offers them (skippable)", () => {
    for (const key of ["existence", "repairPlanner"]) {
      const p = PERSONAS.find((x) => x.key === key)!;
      assert.equal(p.optional, true, `${key} is skippable`);
      assert.equal(Boolean(p.advanced), false, `${key} is not hidden in the specialist step`);
    }
    const setup = src("src/setup.ts");
    assert.match(setup, /for \(const persona of PERSONAS\) \{\s*if \(persona\.advanced\) continue; \/\/ specialist roles: asked below/);
    assert.deepEqual(Object.keys(emptyChains()).sort(), [...roleKeys].sort(), "setup has a slot for every role");
  });

  test("'one model for every role' leaves them unset, so they use Discovery's and the Planner's, which is that model", () => {
    const model = { id: "a/main", name: "Main", contextLength: 1, promptCost: 1, completionCost: 1, supportsTools: true, supportsVision: false } as CatalogModel;
    const chains = chainsForOneModel(model);
    assert.deepEqual(chains.existence, []);
    assert.deepEqual(chains.repairPlanner, []);
    assert.deepEqual(chains.discovery, ["a/main"]);
    assert.deepEqual(chains.planner, ["a/main"]);
  });

  test("setup offers each only models that can serve it", () => {
    const catalog: CatalogModel[] = [
      { id: "a/text", name: "a", contextLength: 1, promptCost: 1, completionCost: 1, supportsTools: false, supportsVision: false },
      { id: "b/tools", name: "b", contextLength: 1, promptCost: 2, completionCost: 2, supportsTools: true, supportsVision: false },
    ];
    assert.deepEqual(candidatesFor(catalog, PERSONAS.find((p) => p.key === "existence")!).map((m) => m.id), ["a/text", "b/tools"], "a structured-output pass needs no tools");
    assert.deepEqual(candidatesFor(catalog, PERSONAS.find((p) => p.key === "repairPlanner")!).map((m) => m.id), ["b/tools"], "the triage pass uses tools");
  });

  test("the phone is told about both, after the nine it already knew, so its list does not reshuffle", () => {
    const info = roleInfoWire();
    assert.equal(info.length, PERSONAS.length);
    for (const role of ["existence", "repairPlanner"]) {
      const row = info.find((i) => i.role === role)!;
      assert.ok(row, role);
      assert.equal(row.optional, true);
      assert.ok(info.indexOf(row) >= 9, `${role} is not among the first nine`);
    }
    assert.deepEqual(roleInfoWire().slice(0, 9).map((i) => i.role), PERSONAS.slice(0, 9).map((p) => p.key));
    assert.equal(info.find((i) => i.role === "existence")!.label, "Existence");
    assert.equal(info.find((i) => i.role === "repairPlanner")!.label, "Repair Planner");
  });
});
