/**
 * Regression tests for register_screen_nav / .agent/nav_map.json — the
 * screen navigation map Discovery builds incrementally from real navigation
 * code, later injected into the Editor's context (so it can write an honest
 * verification path without having explored navigation itself) and into
 * QA's live navigation loop (a head start on which element to try, never a
 * replacement for visually confirming each step).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTools } from "../src/agentTools.js";
import { AgentConfig } from "../src/config.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-navmap-tool-test-"));
  tempDirs.push(dir);
  return dir;
}

async function readNavMap(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, ".agent", "nav_map.json"), "utf-8"));
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("AgentTools.registerScreenNav", () => {
  test("creates .agent/nav_map.json with the recorded screen", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    const result = await tools.registerScreenNav({
      screen: "RaceScreen",
      file: "app/src/main/java/.../RaceScreen.kt",
      reachedFrom: 'BettingScreen, tap "LET\'S RACE"',
      controls: [
        { label: "Fast Forward", leadsTo: "cycles sim speed 1x/2x/4x/8x" },
        { label: "Throw", leadsTo: "throws the race (visible only when not spectating)" },
      ],
    });

    assert.match(result, /RaceScreen/);
    const map = await readNavMap(dir);
    assert.ok(map.RaceScreen);
    assert.equal(map.RaceScreen.controls.length, 2);
    assert.equal(map.RaceScreen.reachedFrom, 'BettingScreen, tap "LET\'S RACE"');
  });

  test("a second call for the same screen replaces its control list wholesale, not merges it", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.registerScreenNav({
      screen: "RaceScreen",
      file: "RaceScreen.kt",
      controls: [{ label: "Old Button", leadsTo: "no longer exists" }],
    });
    await tools.registerScreenNav({
      screen: "RaceScreen",
      file: "RaceScreen.kt",
      controls: [{ label: "New Button", leadsTo: "the current control" }],
    });

    const map = await readNavMap(dir);
    assert.equal(map.RaceScreen.controls.length, 1);
    assert.equal(map.RaceScreen.controls[0].label, "New Button");
  });

  test("preserves a prior reachedFrom when a later call omits it", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.registerScreenNav({
      screen: "RaceScreen",
      file: "RaceScreen.kt",
      reachedFrom: "BettingScreen",
      controls: [],
    });
    await tools.registerScreenNav({ screen: "RaceScreen", file: "RaceScreen.kt", controls: [{ label: "X", leadsTo: "Y" }] });

    const map = await readNavMap(dir);
    assert.equal(map.RaceScreen.reachedFrom, "BettingScreen");
  });

  test("recording a different screen leaves the first screen's entry untouched", async () => {
    const dir = await makeTempDir();
    const tools = new AgentTools(dir, {} as AgentConfig);

    await tools.registerScreenNav({ screen: "RaceScreen", file: "RaceScreen.kt", controls: [{ label: "A", leadsTo: "B" }] });
    await tools.registerScreenNav({ screen: "BettingScreen", file: "BettingScreen.kt", controls: [] });

    const map = await readNavMap(dir);
    assert.ok(map.RaceScreen);
    assert.ok(map.BettingScreen);
    assert.equal(map.RaceScreen.controls.length, 1);
  });
});
