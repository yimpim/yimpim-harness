/**
 * Read-only access to a board's serial output, for QA's agent on a firmware
 * project. It can list ports and listen to one for a few seconds. That is all:
 * nothing is written to the port, and nothing is flashed, erased or reset on
 * purpose. (Opening a serial port makes many boards reboot, which is usually
 * what you want, because the boot log is the first thing to read.)
 *
 * It drives the project's own tools (arduino-cli, or PlatformIO) rather than a
 * serial library, so there is no native dependency to install. With neither
 * tool it says so and the state becomes "could not verify: needs a board".
 */
import { spawn } from "child_process";

export interface SerialHooks {
  listPorts(): Promise<string>;
  read(args: { port: string; baud?: number; seconds?: number }): Promise<string>;
}

export type SerialRunner = (bin: string, args: string[], opts: { timeoutMs: number; killAfterMs?: boolean }) => Promise<string>;

/** Runs a command and returns what it printed. With `killAfterMs` the timeout is the plan, not an error: stop it and keep the output. */
export const defaultSerialRunner: SerialRunner = (bin, args, { timeoutMs, killAfterMs }) =>
  new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      if (err && !out) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => finish(killAfterMs ? undefined : new Error("timed out")), timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => finish(e));
    child.on("close", () => finish());
  });

const PORT = /^[A-Za-z0-9_./:-]{3,100}$/;
const MAX_OUT = 4000;

export function createSerialHooks(tools: { arduinoCli?: string; pio?: string }, run: SerialRunner = defaultSerialRunner): SerialHooks | undefined {
  if (!tools.arduinoCli && !tools.pio) return undefined;
  return {
    async listPorts() {
      if (tools.arduinoCli) return (await run(tools.arduinoCli, ["board", "list", "--format", "json"], { timeoutMs: 20000 })).slice(0, MAX_OUT);
      return (await run(tools.pio!, ["device", "list", "--json-output"], { timeoutMs: 20000 })).slice(0, MAX_OUT);
    },
    async read({ port, baud, seconds }) {
      if (!PORT.test(port)) throw new Error("port must look like COM3, /dev/ttyUSB0 or /dev/cu.usbserial-0001");
      const b = Number.isFinite(baud) ? Math.round(Number(baud)) : 115200;
      if (b < 300 || b > 2_000_000) throw new Error("baud must be between 300 and 2000000");
      const secs = Math.min(30, Math.max(1, Number.isFinite(seconds) ? Math.round(Number(seconds)) : 8));
      const args = tools.arduinoCli
        ? ["monitor", "-p", port, "--config", `baudrate=${b}`]
        : ["device", "monitor", "--port", port, "--baud", String(b), "--raw"];
      const out = await run(tools.arduinoCli ?? tools.pio!, args, { timeoutMs: secs * 1000, killAfterMs: true });
      const text = out.trim();
      return text ? text.slice(-MAX_OUT) : `nothing was printed on ${port} at ${b} baud in ${secs}s (wrong port or baud, or the board is quiet)`;
    },
  };
}
