import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fallbackChain, unsetRoles, shouldAsk, hasBeenAsked, markAsked, specialistChoices, promptLines, fallbackHint, COMMAND_ROLES,
} from "../src/specialistPrompt.js";

const dirs: string[] = [];
const originalHome = { home: process.env.HOME, profile: process.env.USERPROFILE, yimpim: process.env.YIMPIM_HOME };

beforeEach(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-spec-"));
  dirs.push(d);
  process.env.HOME = d;
  process.env.USERPROFILE = d;
  delete process.env.YIMPIM_HOME;
});
after(() => {
  for (const [k, v] of [["HOME", originalHome.home], ["USERPROFILE", originalHome.profile], ["YIMPIM_HOME", originalHome.yimpim]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const base = { planner: ["p/x"], verifier: ["v/x"], verifierVision: ["vv/x"] };

describe("specialist model fallbacks match what the runtime uses", () => {
  test("security: its own, else verifier, else planner", () => {
    assert.deepEqual(fallbackChain("security", { ...base, security: ["s/x"] }), ["s/x"]);
    assert.deepEqual(fallbackChain("security", base), ["v/x"]);
    assert.deepEqual(fallbackChain("security", { planner: ["p/x"] }), ["p/x"]);
  });
  test("designer: its own, else planner. Judge: its own, else verifier vision, else editor vision, else verifier", () => {
    assert.deepEqual(fallbackChain("designer", base), ["p/x"]);
    assert.deepEqual(fallbackChain("designerVision", base), ["vv/x"]);
    assert.deepEqual(fallbackChain("designerVision", { verifier: ["v/x"] }), ["v/x"]);
    assert.deepEqual(fallbackChain("designerVision", { ...base, designerVision: ["j/x"] }), ["j/x"]);
  });
});

describe("which roles a command still needs", () => {
  test("an empty chain counts as unset", () => {
    assert.deepEqual(unsetRoles("pentest", { security: [] }), ["security"]);
    assert.deepEqual(unsetRoles("pentest", { security: ["s/x"] }), []);
    assert.deepEqual(unsetRoles("design", { designer: ["d/x"] }), ["designerVision"]);
    assert.deepEqual(COMMAND_ROLES.design, ["designer", "designerVision"]);
  });
});

describe("asked once, never forced", () => {
  test("asks when something is unset, someone can answer and it was never asked", () => {
    assert.equal(shouldAsk("pentest", base, { interactive: true }), true);
  });
  test("does not ask when nobody can answer", () => {
    assert.equal(shouldAsk("pentest", base, { interactive: false }), false);
  });
  test("does not ask when the role is already set", () => {
    assert.equal(shouldAsk("pentest", { ...base, security: ["s/x"] }, { interactive: true }), false);
  });
  test("does not ask again once answered, and each command is remembered separately", () => {
    assert.equal(hasBeenAsked("pentest"), false);
    markAsked("pentest");
    assert.equal(hasBeenAsked("pentest"), true);
    assert.equal(hasBeenAsked("design"), false);
    assert.equal(shouldAsk("pentest", base, { interactive: true }), false);
    assert.equal(shouldAsk("design", base, { interactive: true }), true);
  });
});

describe("the choices", () => {
  test("the first choice, the one Enter takes, carries on with the fallback; pick and cancel follow", () => {
    assert.deepEqual(specialistChoices().map((c) => c.value), ["use", "pick", "cancel"]);
  });
});

describe("the wording", () => {
  test("pentest names the model it will use and says why a strong one is worth it", () => {
    const text = promptLines("pentest", base).join("\n");
    assert.match(text, /Security model/);
    assert.match(text, /v\/x/);
    assert.match(text, /false comfort/);
  });
  test("design names the planner and the judge fallback", () => {
    const text = promptLines("design", base).join("\n");
    assert.match(text, /p\/x/);
    assert.match(text, /vv\/x/);
  });
  test("the no-terminal hint says what is being used and how to change it", () => {
    assert.match(fallbackHint("pentest", base), /using v\/x.*\/model/);
  });
});
