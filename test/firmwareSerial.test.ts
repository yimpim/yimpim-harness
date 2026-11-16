/**
 * QA's agent can listen to a board, read-only, when a serial-capable tool is
 * installed. It has no way to write to a port or flash anything.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSerialHooks } from "../src/qaFirmware.js";
import { projectBackend } from "../src/qaProjectBackend.js";

const base = {
  readFile: async () => "",
  searchCode: async () => "",
  listFiles: async () => "",
  runCommand: async () => "",
};

describe("createSerialHooks", () => {
  test("with no serial-capable tool there are no serial hooks", () => {
    assert.equal(createSerialHooks({}), undefined);
  });

  test("it listens with arduino-cli's monitor, bounded in time, and keeps what was printed", async () => {
    const seen: { bin: string; args: string[]; timeoutMs: number; killAfterMs?: boolean }[] = [];
    const hooks = createSerialHooks({ arduinoCli: "arduino-cli" }, async (bin, args, opts) => {
      seen.push({ bin, args, ...opts });
      return "ets Jun  8 2016\nboot: ok\nWiFi connected";
    })!;
    const out = await hooks.read({ port: "COM3", baud: 115200, seconds: 5 });
    assert.match(out, /WiFi connected/);
    assert.deepEqual(seen[0].args, ["monitor", "-p", "COM3", "--config", "baudrate=115200"]);
    assert.equal(seen[0].timeoutMs, 5000);
    assert.equal(seen[0].killAfterMs, true);
  });

  test("it falls back to PlatformIO's monitor", async () => {
    let args: string[] = [];
    const hooks = createSerialHooks({ pio: "pio" }, async (_b, a) => ((args = a), "x"))!;
    await hooks.read({ port: "/dev/ttyUSB0" });
    assert.deepEqual(args.slice(0, 2), ["device", "monitor"]);
    assert.ok(args.includes("--raw"));
  });

  test("a port that is not a port, or a silly baud, is refused before anything runs", async () => {
    let ran = false;
    const hooks = createSerialHooks({ arduinoCli: "a" }, async () => ((ran = true), ""))!;
    await assert.rejects(hooks.read({ port: "COM3; rm -rf /" }), /port must look like/);
    await assert.rejects(hooks.read({ port: "COM3", baud: 5 }), /baud must be/);
    assert.equal(ran, false);
  });

  test("the time is clamped, and a silent board is reported, not treated as an error", async () => {
    let timeout = 0;
    const hooks = createSerialHooks({ arduinoCli: "a" }, async (_b, _a, o) => ((timeout = o.timeoutMs), ""))!;
    const out = await hooks.read({ port: "COM3", seconds: 9999 });
    assert.equal(timeout, 30000);
    assert.match(out, /nothing was printed/);
  });

  test("listing ports asks the tool for JSON", async () => {
    let args: string[] = [];
    const hooks = createSerialHooks({ arduinoCli: "a" }, async (_b, a) => ((args = a), "[]"))!;
    await hooks.listPorts();
    assert.deepEqual(args, ["board", "list", "--format", "json"]);
  });
});

describe("the project backend with serial", () => {
  test("serial tools exist only when serial hooks are given", () => {
    assert.ok(!projectBackend(base).tools.some((t) => t.name === "read_serial"));
    const serial = { listPorts: async () => "[]", read: async () => "boot ok" };
    const names = projectBackend({ ...base, serial }).tools.map((t) => t.name);
    assert.ok(names.includes("list_serial_ports"));
    assert.ok(names.includes("read_serial"));
  });

  test("there is no tool that writes to a port or flashes", () => {
    const serial = { listPorts: async () => "[]", read: async () => "" };
    const all = projectBackend({ ...base, serial }).tools.map((t) => t.name).join(" ");
    assert.doesNotMatch(all, /write|flash|upload|erase|send/i);
  });

  test("what the board prints is evidence, with secrets masked", async () => {
    const serial = { listPorts: async () => "[]", read: async () => "wifi password=hunter2hunter2\nready" };
    const out = await projectBackend({ ...base, serial }).run("read_serial", { port: "COM3" });
    assert.ok(out.evidence);
    assert.doesNotMatch(out.text!, /hunter2hunter2/);
    assert.match(out.text!, /ready/);
  });
});
