/**
 * The sandbox is a setting with one decision point: sandboxFor says whether a heal gets one. The CLI (/tests heal), the phase gate and the benchmark
 * all ask it, and use the JSON stronger-model pass only when it says no, so the three cannot disagree.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ConfigSchema } from "../src/config.js";
import { SETTINGS, findSetting, coerce } from "../src/settings.js";
import { sandboxFor } from "../src/healSandbox.js";

const config = (heal?: object, repair: string[] = ["cheap/model", "strong/model"]): any => ConfigSchema.parse({ ...(heal ? { heal } : {}), models: { repair } });
const fakeClient: any = { complete: async () => ({}) };
const src = (f: string) => fs.readFileSync(f, "utf8");

describe("configuration", () => {
  test("the defaults: on, $0.75 per cause, three rounds of patience, at most 12 tests per deviation", () => {
    const c = ConfigSchema.parse({});
    assert.deepEqual(c.heal.sandbox, { enabled: true, budgetUsd: 1.75, stagnation: 3, deviationTestCap: 12 });
  });
  test("each key can be set, and a nonsense value is refused", () => {
    assert.deepEqual(config({ sandbox: { enabled: false, budgetUsd: 0, stagnation: 5, deviationTestCap: 4 } }).heal.sandbox, { enabled: false, budgetUsd: 0, stagnation: 5, deviationTestCap: 4 });
    assert.throws(() => config({ sandbox: { budgetUsd: -1 } }));
    assert.throws(() => config({ sandbox: { stagnation: 0 } }));
    assert.throws(() => config({ sandbox: { stagnation: 2.5 } }));
    assert.throws(() => config({ sandbox: { deviationTestCap: 0 } }));
  });
  test("every key is a documented setting a person can change, in plain words, and parses from text", () => {
    for (const key of ["heal.sandbox.enabled", "heal.sandbox.budgetUsd", "heal.sandbox.stagnation", "heal.sandbox.deviationTestCap"]) {
      const def = findSetting(key);
      assert.ok(def, key);
      assert.ok(def!.description.length > 60, `${key} is described`);
      assert.ok(SETTINGS.filter((s) => s.key === key).length === 1, `${key} is listed once`);
    }
    assert.equal(coerce(findSetting("heal.sandbox.enabled")!, "false"), false);
    assert.equal(coerce(findSetting("heal.sandbox.budgetUsd")!, "1.5"), 1.5);
    assert.equal(coerce(findSetting("heal.sandbox.stagnation")!, "4"), 4);
    assert.equal(findSetting("heal.sandbox.budgetUsd")!.common, true, "the dollar limit is one of the settings shown by default");
  });
});

describe("sandboxFor: who gets a sandbox", () => {
  test("two or more repair models and the setting on: yes", () => {
    assert.equal(typeof sandboxFor({ client: fakeClient, config: config(), repairModels: ["a", "b"] }), "function");
    assert.equal(typeof sandboxFor({ client: fakeClient, config: config(), repairModels: ["a", "b", "c"] }), "function");
  });
  test("switched off: no, so the JSON stronger-model pass is used exactly as before", () => {
    assert.equal(sandboxFor({ client: fakeClient, config: config({ sandbox: { enabled: false } }), repairModels: ["a", "b"] }), undefined);
  });
  test("a single repair model: no (there is nobody stronger to hand a cause to)", () => {
    assert.equal(sandboxFor({ client: fakeClient, config: config(undefined, ["only/model"]), repairModels: ["only/model"] }), undefined);
    assert.equal(sandboxFor({ client: fakeClient, config: config(), repairModels: [] }), undefined);
  });
  test("a config with no heal section at all (an older one) behaves as the defaults: on", () => {
    const older = { ...config(), heal: undefined };
    assert.equal(typeof sandboxFor({ client: fakeClient, config: older, repairModels: ["a", "b"] }), "function");
  });
});

describe("the three places a heal is started all ask sandboxFor, and use the JSON pass only when it says no", () => {
  test("/tests heal (src/index.ts)", () => {
    const s = src("src/index.ts");
    assert.match(s, /const sandbox = sandboxFor\(\{ client, config, repairModels: healModels/);
    assert.match(s, /healTests\(\{\s*repoRoot,\s*all,\s*sandbox,/);
    assert.match(s, /escalate:\s*!sandbox && healModels\.length > 1/);
  });
  test("the phase gate (src/verifierTools.ts)", () => {
    const s = src("src/verifierTools.ts");
    assert.match(s, /const sandbox = sandboxFor\(\{ client: this\.client, config: this\.config, repairModels: models/);
    assert.match(s, /!sandbox && models\.length > 1/);
    assert.match(s, /healTests\(\{[^}]*\bescalate, sandbox,/);
  });
  test("the benchmark (scripts/bench-heal.mjs), with --no-sandbox and --no-escalate", () => {
    const s = src("scripts/bench-heal.mjs");
    assert.match(s, /sandboxFor\(\{ client, config, repairModels: models/);
    assert.match(s, /!has\("--no-escalate"\) && !has\("--no-sandbox"\)/);
    assert.match(s, /!sandbox && models\.length > 1 && !has\("--no-escalate"\)/);
    assert.match(s, /healTests\(\{[^}]*\bescalate, sandbox,/);
  });
  test("the stronger chain is every repair model after the first, and the budget and patience come from the setting", () => {
    const s = src("src/healSandbox.ts");
    assert.match(s, /models: deps\.repairModels\.slice\(1\)/);
    assert.match(s, /budgetUsd: cfg\?\.budgetUsd \?\? 1\.75/);
    assert.match(s, /stagnation: cfg\?\.stagnation \?\? 3/);
    assert.match(s, /deviationTestCap: cfg\?\.deviationTestCap \?\? DEFAULT_DEVIATION_TEST_CAP/);
  });
});
