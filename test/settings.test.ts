/**
 * Regression tests for clearSetting (src/settings.ts) — the "unset a model
 * role entirely" primitive added for the remote set_model wire verb (a
 * chain: [] means "clear this back to unset" for the optional vision
 * roles). writeSetting itself predates this and has no test file of its
 * own; scope here is just the new function.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { clearSetting, writeSetting } from "../src/settings.js";

const tempDirs: string[] = [];

function makeTempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-settings-test-"));
  tempDirs.push(dir);
  return path.join(dir, "agent.config.yaml");
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("clearSetting", () => {
  test("removes a previously-written optional key entirely", () => {
    const configPath = makeTempConfigPath();
    writeSetting(configPath, "models.editorVision", ["openai/gpt-4o"]);
    assert.deepEqual(yaml.parse(fs.readFileSync(configPath, "utf-8")).models.editorVision, ["openai/gpt-4o"]);

    clearSetting(configPath, "models.editorVision");

    const parsed = yaml.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(parsed.models?.editorVision, undefined, "the key must be gone, not set to null/[]");
  });

  test("clearing a key in a file that doesn't exist yet is a harmless no-op", () => {
    const configPath = makeTempConfigPath();
    assert.doesNotThrow(() => clearSetting(configPath, "models.editorVision"));
    assert.equal(fs.existsSync(configPath), false, "must not create a file just to clear nothing");
  });

  test("leaves every OTHER key in the file untouched", () => {
    const configPath = makeTempConfigPath();
    writeSetting(configPath, "models.editor", ["anthropic/claude-3.5-sonnet"]);
    writeSetting(configPath, "models.editorVision", ["openai/gpt-4o"]);

    clearSetting(configPath, "models.editorVision");

    const parsed = yaml.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepEqual(parsed.models.editor, ["anthropic/claude-3.5-sonnet"]);
    assert.equal(parsed.models.editorVision, undefined);
  });

  test("rejects an unknown setting key", () => {
    const configPath = makeTempConfigPath();
    assert.throws(() => clearSetting(configPath, "models.notARealRole"), /Unknown setting/);
  });

  test("clearing a REQUIRED role's key does not throw — it falls back to the schema default", () => {
    // clearSetting is a generic registry primitive with no per-key business
    // rules of its own; the four required model roles carry a schema
    // default, so deleting the key is valid on its own (falls back to the
    // default chain) rather than invalid. The actual "don't let a phone
    // clear a required role" rule lives at the set_model call site in
    // index.ts, not here — this test locks in that clearSetting itself
    // stays permissive, so a future change doesn't quietly start throwing
    // for a case the caller is already responsible for rejecting.
    const configPath = makeTempConfigPath();
    writeSetting(configPath, "models.editor", ["anthropic/claude-3.5-sonnet"]);
    assert.doesNotThrow(() => clearSetting(configPath, "models.editor"));
  });
});

import { PERSONAS } from "../src/models.js";
import { findSetting } from "../src/settings.js";

describe("every model role can be saved", () => {
  test("each role the /model picker offers has a settings key to write to", () => {
    for (const p of PERSONAS) assert.ok(findSetting(`models.${p.key}`), `models.${p.key} is offered by /model but is not a known setting`);
  });
});
