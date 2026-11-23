/**
 * The settings a person is meant to change are registered, so `config set`, `--set`, `YIMPIM_*` variables and `config list` all work for them.
 * planning.questions and interaction.confirmContinue are documented in the README and used by the run loop, so they are registered;
 * git.autoPush is deliberately NOT: it is a runtime mirror of .agent/push.json (see gitRemote.ts), so a value set in a config file would do nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTINGS, findSetting, resolveConfig, writeSetting } from "../src/settings.js";

const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

/** resolveConfig with no personal global file and no project file underneath. */
function resolveClean(overrides: string[] = [], env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-registry-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-registry-repo-"));
  const saved: Record<string, string | undefined> = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  Object.assign(process.env, env);
  try {
    return resolveConfig({ repoRoot: repo, overrides }).config;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("planning.questions", () => {
  test("is registered as a common enum of autonomous, essential and all", () => {
    const def = findSetting("planning.questions")!;
    assert.ok(def);
    assert.equal(def.type, "enum");
    assert.deepEqual(def.choices, ["autonomous", "essential", "all"]);
    assert.equal(def.common, true);
  });
  test("--set changes it, and a value that is not one of the three is refused with the choices", () => {
    assert.equal(resolveClean().planning.questions, "essential");
    assert.equal(resolveClean(["planning.questions=autonomous"]).planning.questions, "autonomous");
    assert.equal(resolveClean(["planning.questions=all"]).planning.questions, "all");
    assert.throws(() => resolveClean(["planning.questions=sometimes"]), /autonomous, essential, all/);
  });
  test("YIMPIM_PLANNING_QUESTIONS works too", () => {
    assert.equal(resolveClean([], { YIMPIM_PLANNING_QUESTIONS: "autonomous" }).planning.questions, "autonomous");
  });
  test("`config set` writes it to the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-registry-set-"));
    const file = path.join(dir, "agent.config.yaml");
    try {
      writeSetting(file, "planning.questions", "all");
      assert.match(fs.readFileSync(file, "utf8"), /questions: all/);
      assert.throws(() => writeSetting(file, "planning.questions", "never"), /invalid/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("interaction.confirmContinue", () => {
  test("is registered as a boolean that is off by default, and --set turns it on", () => {
    const def = findSetting("interaction.confirmContinue")!;
    assert.ok(def);
    assert.equal(def.type, "boolean");
    assert.equal(resolveClean().interaction.confirmContinue, false);
    assert.equal(resolveClean(["interaction.confirmContinue=true"]).interaction.confirmContinue, true);
    assert.throws(() => resolveClean(["interaction.confirmContinue=maybe"]), /true\/false/);
  });
});

describe("git.autoPush stays out of the registry", () => {
  test("it is not offered by `config set`, `--set` or `config list`, because the file .agent/push.json decides", () => {
    assert.equal(findSetting("git.autoPush"), undefined);
    assert.equal(SETTINGS.some((s) => s.key === "git.autoPush"), false);
    assert.throws(() => resolveClean(["git.autoPush=true"]), /Unknown setting/);
    assert.match(src("src/gitRemote.ts"), /Deliberately kept OUT of agent\.config\.yaml/);
    assert.match(src("src/config.ts"), /Resolved at runtime from \.agent\/push\.json, NOT from this YAML file/);
  });
});

describe("the README describes the registry as it is", () => {
  const readme = src("README.md");
  test("it no longer claims every setting is in one registry", () => {
    assert.doesNotMatch(readme, /Every setting lives in one registry/);
    assert.match(readme, /settings you are meant to change are registered in `src\/settings\.ts`/);
    assert.match(readme, /not in that list: they have sensible built-in values and can be set by editing a config file by hand/);
  });
  test("every setting it tells people to set is one `config set` accepts", () => {
    for (const key of ["planning.questions", "interaction.answerTimeoutMinutes", "interaction.confirmContinue", "limits.maxRepairAttemptsPerPhase", "remote.shareHostname", "remote.redactLogs"]) {
      assert.ok(findSetting(key), `${key} is documented in the README and must be settable`);
    }
    assert.match(readme, /yimpim config set planning\.questions autonomous/);
  });
  test("the ones in the README that are NOT registered are named as hand-edited", () => {
    assert.match(readme, /`designer\.\*`, `security\.\*` and `heal\.\*` tuning, retry timing, memory sizes/);
  });
});
