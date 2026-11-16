/**
 * Firmware projects (PlatformIO, Arduino, ESP-IDF) get a real compile gate.
 * Nothing the harness builds for them ever flashes a board.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProject } from "../src/projectProfile.js";
import { AutonomousVerifier } from "../src/verifierTools.js";
import { EvidenceLedger } from "../src/evidence.js";

const repoWith = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
};

const PIO = `[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino

[env:native]
platform = native
`;

describe("detecting firmware", () => {
  test("PlatformIO: the board env is built and the native env is the host test run", async () => {
    const p = await detectProject(repoWith({ "platformio.ini": PIO, "src/main.cpp": "int main(){}" }));
    assert.ok(p.stacks.includes("firmware"));
    assert.equal(p.firmware?.framework, "platformio");
    assert.equal(p.firmware?.board, "esp32dev");
    assert.deepEqual(p.firmware?.buildCommand, ["run", "-e", "esp32dev"]);
    assert.deepEqual(p.firmware?.hostTestCommand, ["test", "-e", "native"]);
  });

  test("PlatformIO in a subdirectory points the tool at it", async () => {
    const p = await detectProject(repoWith({ "firmware/platformio.ini": PIO }));
    assert.deepEqual(p.firmware?.buildCommand, ["run", "-e", "esp32dev", "-d", "firmware"]);
  });

  test("Arduino: a sketch with a board in sketch.yaml compiles for that board", async () => {
    const p = await detectProject(
      repoWith({ "blink/blink.ino": "void setup(){}", "blink/sketch.yaml": "default_fqbn: esp32:esp32:esp32\n" })
    );
    assert.equal(p.firmware?.framework, "arduino");
    assert.deepEqual(p.firmware?.buildCommand, ["compile", "--fqbn", "esp32:esp32:esp32", "blink"]);
  });

  test("Arduino with no board set says what is missing instead of guessing one", async () => {
    const p = await detectProject(repoWith({ "blink.ino": "void setup(){}" }));
    assert.equal(p.firmware?.buildCommand, undefined);
    assert.match(p.firmware!.buildNote!, /default_fqbn/);
  });

  test("ESP-IDF is recognised from its CMake project", async () => {
    const p = await detectProject(
      repoWith({ "CMakeLists.txt": "include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(app)\n", "sdkconfig": "", "main/main.c": "" })
    );
    assert.equal(p.firmware?.framework, "esp-idf");
    assert.deepEqual(p.firmware?.buildCommand, ["-C", ".", "build"]);
  });

  test("a project that is not firmware is not detected as one", async () => {
    const p = await detectProject(repoWith({ "package.json": "{}", "index.js": "" }));
    assert.equal(p.firmware, undefined);
    assert.ok(!p.stacks.includes("firmware"));
  });

  test("no command the harness builds can upload, flash or erase", async () => {
    const found = [
      await detectProject(repoWith({ "platformio.ini": PIO })),
      await detectProject(repoWith({ "a/a.ino": "", "a/sketch.yaml": "default_fqbn: x:y:z\n" })),
      await detectProject(repoWith({ "CMakeLists.txt": "include(project.cmake)", sdkconfig: "" })),
    ];
    for (const p of found) {
      const all = [...(p.firmware?.buildCommand ?? []), ...(p.firmware?.hostTestCommand ?? [])].join(" ");
      assert.doesNotMatch(all, /upload|flash|erase|burn|monitor/i);
    }
  });
});

describe("the build gate", () => {
  const gate = (profile: any, caps: any) => {
    const v: any = Object.create((AutonomousVerifier as any).prototype);
    v.repoRoot = ".";
    const ledger = new EvidenceLedger();
    const cmds = v["resolveBuildCommands"]({ ...profile, testCommands: [], stacks: ["firmware"] }, caps, ledger);
    return { cmds, ledger };
  };
  const have = { available: true, bin: "/usr/bin/pio", detail: "" };
  const lack = { available: false, bin: undefined, detail: "not on PATH" };

  test("it compiles with the framework's tool, and runs the host tests", async () => {
    const p = await detectProject(repoWith({ "platformio.ini": PIO }));
    const { cmds } = gate(p, { pio: have, arduinoCli: lack, idf: lack });
    assert.deepEqual(
      cmds.map((c: any) => c.label),
      ["firmware build (platformio, esp32dev)", "firmware host tests (PlatformIO native)"]
    );
    assert.deepEqual(cmds[0].args, ["run", "-e", "esp32dev"]);
  });

  test("a missing tool is reported as unavailable, never as a failed build", async () => {
    const p = await detectProject(repoWith({ "platformio.ini": PIO }));
    const { cmds, ledger } = gate(p, { pio: lack, arduinoCli: lack, idf: lack });
    assert.equal(cmds.length, 0);
    assert.ok(ledger.all().some((e: any) => /PlatformIO is not installed/.test(e.detail)));
  });

  test("an Arduino sketch with no board is reported with what to add", async () => {
    const p = await detectProject(repoWith({ "blink.ino": "" }));
    const { cmds, ledger } = gate(p, { pio: lack, arduinoCli: have, idf: lack });
    assert.equal(cmds.length, 0);
    assert.ok(ledger.all().some((e: any) => /default_fqbn/.test(e.detail)));
  });
});
