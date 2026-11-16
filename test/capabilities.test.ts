/**
 * Regression tests for chooseDevice: probeAndroidDevice/probeIOSSimulator
 * used to always take the first attached device/simulator with no way to
 * target a specific one, so a common dev setup (a physical device plus an
 * emulator both attached) could silently verify against the wrong one.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseDevice, javaAwareEnv } from "../src/capabilities.js";

describe("chooseDevice", () => {
  test("returns undefined when there are no candidates at all", () => {
    assert.equal(chooseDevice([]), undefined);
  });

  test("picks the only candidate, not flagged as ambiguous", () => {
    const result = chooseDevice([{ id: "emulator-5554" }]);
    assert.deepEqual(result, { chosen: { id: "emulator-5554" }, ambiguous: false });
  });

  test("with no preference and multiple candidates, picks the first and flags it ambiguous", () => {
    const candidates = [{ id: "device-A" }, { id: "device-B" }];
    const result = chooseDevice(candidates);
    assert.deepEqual(result, { chosen: { id: "device-A" }, ambiguous: true });
  });

  test("a configured preference is honored even among several candidates, never ambiguous", () => {
    const candidates = [{ id: "device-A" }, { id: "device-B" }, { id: "device-C" }];
    const result = chooseDevice(candidates, "device-B");
    assert.deepEqual(result, { chosen: { id: "device-B" }, ambiguous: false });
  });

  test("a configured preference that matches nothing reports not_found, never silently falls back", () => {
    const candidates = [{ id: "device-A" }, { id: "device-B" }];
    assert.equal(chooseDevice(candidates, "device-Z"), "not_found");
  });
});

// The bug this covers: a command spawned via plain child_process.exec only
// ever sees process.env verbatim, which does NOT include a JDK that's only
// reachable via probeJava's own JAVA_HOME/PATH/Android-Studio-JBR fallback
// chain — the default for anyone who only ever installed Java bundled with
// Android Studio. gradlew failed with "JAVA_HOME is not set and no 'java'
// command could be found in your PATH" until the spawned env was actually
// built from the RESOLVED capability, not inherited as-is.
describe("javaAwareEnv", () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeJdkHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-jdk-test-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    return dir;
  }

  test("injects JAVA_HOME and prepends its bin/ to PATH when the JDK home looks real", () => {
    const jdkHome = makeJdkHome();
    const env = javaAwareEnv({ available: true, bin: jdkHome, detail: "test" }, { PATH: "/usr/bin", EXISTING: "kept" });

    assert.equal(env.JAVA_HOME, jdkHome);
    assert.ok(env.PATH?.startsWith(path.join(jdkHome, "bin")), "the JDK's own bin/ must be searched first");
    assert.ok(env.PATH?.includes("/usr/bin"), "the original PATH must still be present, not replaced");
    assert.equal(env.EXISTING, "kept", "unrelated env vars must survive untouched");
  });

  test("is a no-op when bin has no bin/ subdirectory — not a real JDK home", () => {
    const notAJdk = fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-notjdk-test-"));
    tempDirs.push(notAJdk);
    const env = javaAwareEnv({ available: true, bin: notAJdk, detail: "test" }, { PATH: "/usr/bin" });

    assert.equal(env.JAVA_HOME, undefined);
    assert.equal(env.PATH, "/usr/bin");
  });

  test("is a no-op when the capability has no bin at all (java unavailable)", () => {
    const env = javaAwareEnv({ available: false, detail: "not found" }, { PATH: "/usr/bin" });
    assert.equal(env.JAVA_HOME, undefined);
    assert.equal(env.PATH, "/usr/bin");
  });

  test("safe to call for a non-Java command — never throws, never required", () => {
    // Exactly how orchestrator.ts's runInstallCommand now calls this
    // unconditionally for every install command, npm/pip/cargo included.
    assert.doesNotThrow(() => javaAwareEnv({ available: false, detail: "no JDK found" }));
  });
});
