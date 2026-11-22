/**
 * The config schema says only what the harness reads: the retry settings and skipProbes now control their runtime paths, maxNavEntries is a real key, the dead keys are gone, and a config that
 * still carries a dead key (or stateDirectory) loads exactly as before.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ConfigSchema } from "../src/config.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { probeCapabilities, skippedKeys, PROBE_GROUPS } from "../src/capabilities.js";
import { SETTINGS } from "../src/settings.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse(over);

describe("the schema", () => {
  test("the dead keys are gone, and a config that still sets them loads with them dropped", () => {
    const parsed = ConfigSchema.parse({
      limits: { maxDiscoveryQuestions: 6, checkpointEveryToolCall: true },
      git: { createPhaseCheckpoint: true },
      recovery: { maxBackups: 10, autoResume: true },
      prompts: { verifierPersona: "x" },
      verification: { extraCommands: [["a"]], androidModule: "app", devServerUrl: "http://x", androidApplicationId: "a.b" },
    }) as any;
    assert.equal("maxDiscoveryQuestions" in parsed.limits, false);
    assert.equal("checkpointEveryToolCall" in parsed.limits, false);
    assert.equal("createPhaseCheckpoint" in parsed.git, false);
    assert.equal("maxBackups" in parsed.recovery || "autoResume" in parsed.recovery, false);
    assert.equal("verifierPersona" in parsed.prompts, false);
    for (const k of ["extraCommands", "androidModule", "devServerUrl", "androidApplicationId"]) assert.equal(k in parsed.verification, false, k);
  });
  test("stateDirectory stays (and loads), and the live keys are untouched", () => {
    const c = cfg({ recovery: { stateDirectory: ".agent" }, verification: { androidDeviceSerial: "emu-1", skipProbes: ["web"] } });
    assert.equal(c.recovery.stateDirectory, ".agent");
    assert.equal(c.recovery.keepBackups, true);
    assert.equal(c.verification.androidDeviceSerial, "emu-1");
    assert.deepEqual(c.verification.skipProbes, ["web"]);
  });
  test("maxNavEntries is a key with a bound and the old default of 200", () => {
    assert.equal(cfg().memory.maxNavEntries, 200);
    assert.equal(cfg({ memory: { maxNavEntries: 400 } }).memory.maxNavEntries, 400);
    assert.equal(ConfigSchema.safeParse({ memory: { maxNavEntries: 3 } }).success, false);
    assert.match(src("src/agentTools.ts"), /this\.config\.memory\?\.maxNavEntries \?\? 200/);
  });
  test("the settings list offers no key the schema no longer has", () => {
    const keys = SETTINGS.map((s: { key: string }) => s.key);
    for (const gone of ["verification.androidApplicationId", "verification.androidModule", "verification.devServerUrl"]) assert.equal(keys.includes(gone), false, gone);
  });
  test("the repo's own agent.config.yaml carries no dead key", () => {
    const y = fs.readFileSync("agent.config.yaml", "utf8");
    for (const k of ["verifierPersona", "maxDiscoveryQuestions", "checkpointEveryToolCall", "createPhaseCheckpoint", "maxBackups", "autoResume"]) assert.equal(y.includes(k), false, k);
  });
});

describe("limits.apiMaxAttempts and limits.apiBaseDelayMs control the retry path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });
  async function failing(config?: ReturnType<typeof cfg>) {
    const waits: number[] = [];
    let fetches = 0;
    (globalThis as any).fetch = async () => (fetches++, new Response("boom", { status: 503 }));
    const client = new OpenRouterClient("k", config);
    (client as any).delay = async (ms: number) => void waits.push(ms);
    const log = console.log;
    console.log = () => {};
    try {
      await client.complete(["some/model"], [{ role: "user", content: "hi" }], { agent: "EDITOR" }).catch(() => {});
    } finally {
      console.log = log;
    }
    return { fetches, waits };
  }
  test("with no config, three tries per model and the built-in waits (1.5s x 2^n)", async () => {
    const r = await failing();
    assert.equal(r.fetches, 3);
    assert.deepEqual(r.waits.slice(0, 2), [3000, 6000]);
  });
  test("apiMaxAttempts sets the tries, and apiBaseDelayMs scales the waits", async () => {
    const r = await failing(cfg({ limits: { apiMaxAttempts: 2, apiBaseDelayMs: 500 } }));
    assert.equal(r.fetches, 2);
    assert.deepEqual(r.waits.slice(0, 2), [1500, 3000]);
  });
  test("apiBaseDelayMs 0 means no waiting between tries, and the bounds hold", async () => {
    const r = await failing(cfg({ limits: { apiBaseDelayMs: 0 } }));
    assert.equal(r.fetches, 3);
    assert.deepEqual(r.waits, [0, 0, 0]);
    assert.equal(ConfigSchema.safeParse({ limits: { apiMaxAttempts: 0 } }).success, false);
    assert.equal(ConfigSchema.safeParse({ limits: { apiMaxAttempts: 11 } }).success, false);
    assert.equal(ConfigSchema.safeParse({ limits: { apiBaseDelayMs: -1 } }).success, false);
  });
});

describe("verification.skipProbes controls which probes run", () => {
  test("each name switches off its own capabilities, case-insensitively; unknown names are ignored", () => {
    assert.deepEqual(skippedKeys(["Android"]).sort(), ["adb", "androidDevice"]);
    assert.deepEqual(skippedKeys(["web", "desktop", "nonsense"]).sort(), ["browser", "display", "playwright", "screenCapture"]);
    assert.deepEqual(skippedKeys(undefined), []);
    assert.deepEqual(Object.keys(PROBE_GROUPS).sort(), ["android", "desktop", "ios", "web"]);
  });
  test("a skipped probe is not run and reads as unavailable, with the reason; the others still run", async () => {
    const caps = await probeCapabilities(process.cwd(), undefined, { skipProbes: ["android", "ios", "web", "desktop"] });
    for (const k of ["adb", "androidDevice", "xcodebuild", "iosSimulator", "playwright", "browser", "display", "screenCapture"] as const) {
      assert.equal(caps[k].available, false, k);
      assert.match(caps[k].detail, /skipped by verification\.skipProbes/, k);
    }
    assert.equal(caps.node.available, true);
  });
  test("the verifier hands the setting to the probe", () => {
    assert.match(src("src/verifierTools.ts"), /skipProbes: this\.config\.verification\?\.skipProbes/);
  });
});
