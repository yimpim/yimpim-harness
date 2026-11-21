/**
 * The toolchain and host-security checks `yimpim doctor` adds. Strictly non-destructive: it asks programs for their version, reads files, and lists listening ports. It never
 * installs, writes or changes anything; every result that is not a pass says exactly what to run to fix it.
 */
import fs from "fs";
import path from "path";
import { type Runner, ok, realRunner } from "./exec.js";
import { type MachineInfo, detectMachine, emulatorUsable, localBin, readMachineRecord, sdksDir, yimpimConfigDir, envShPath, machineJsonPath } from "./machine.js";
import { AAPT2_PATH, GRADLE_KEY, gradleOverrideFor } from "./shellEnv.js";

export type Status = "pass" | "warn" | "fail";
export interface EnvCheck {
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  machine?: MachineInfo;
  run?: Runner;
  /** Where "/etc" and "/dev" are read from (tests point it at a fake root). Default: the real filesystem. */
  sysRoot?: string;
  env?: NodeJS.ProcessEnv;
}

const SETUP = "yimpim setup-env";

export function toolchainChecks(deps: DoctorDeps = {}): EnvCheck[] {
  const m = deps.machine ?? detectMachine();
  const run = deps.run ?? realRunner;
  const env = deps.env ?? process.env;
  const sys = (p: string) => (deps.sysRoot ? path.join(deps.sysRoot, p) : p);
  const read = (p: string): string | undefined => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  };
  const exists = (p: string) => fs.existsSync(p);
  const home = m.home;
  const out: EnvCheck[] = [];
  const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";
  const version = (bin: string, args: string[]): string | undefined => {
    const r = run({ bin, args }, { timeoutMs: 20_000 });
    return ok(r) ? firstLine(r.stdout || r.stderr) : undefined;
  };
  const tool = (label: string, bin: string, args: string[], fix: string, level: Status = "warn") => {
    const v = version(bin, args);
    out.push(v ? { label, status: "pass", detail: v } : { label, status: level, detail: "not found", fix });
  };

  tool("node", "node", ["--version"], `${SETUP} --only node`, "fail");
  const fnm = exists(path.join(localBin(home), "fnm")) ? path.join(localBin(home), "fnm") : "fnm";
  tool("fnm", fnm, ["--version"], `${SETUP} --only node`);
  const uv = exists(path.join(localBin(home), "uv")) ? path.join(localBin(home), "uv") : "uv";
  tool("uv", uv, ["--version"], `${SETUP} --only python`);
  const py = version(uv, ["python", "find"]) ?? version("python3", ["--version"]);
  out.push(py ? { label: "python", status: "pass", detail: py } : { label: "python", status: "warn", detail: "no Python found", fix: `${SETUP} --only python` });
  // `java -version` prints to stderr; run() captures both and uses whichever has text.
  tool("java", "java", ["-version"], `${SETUP} --only system`);

  const androidRoot = env.ANDROID_HOME || path.join(sdksDir(home), "android");
  const sdkmanager = path.join(androidRoot, "cmdline-tools", "latest", "bin", "sdkmanager");
  out.push(
    exists(sdkmanager)
      ? { label: "sdkmanager (Android SDK)", status: "pass", detail: sdkmanager }
      : { label: "sdkmanager (Android SDK)", status: "warn", detail: "not found", fix: `${SETUP} --only android` }
  );

  if (gradleOverrideFor(m)) {
    const props = read(path.join(home, ".gradle", "gradle.properties")) ?? "";
    const hasKey = new RegExp(`^\\s*${GRADLE_KEY.replace(/\./g, "\\.")}\\s*=\\s*${AAPT2_PATH.replace(/\//g, "\\/")}\\s*$`, "m").test(props);
    const aapt2 = exists(sys(AAPT2_PATH));
    out.push(
      hasKey && aapt2
        ? { label: "aapt2 override (ARM64)", status: "pass", detail: `${GRADLE_KEY}=${AAPT2_PATH}` }
        : { label: "aapt2 override (ARM64)", status: "fail", detail: !aapt2 ? `${AAPT2_PATH} is missing` : `${GRADLE_KEY} is not set in ~/.gradle/gradle.properties`, fix: `sudo apt-get install -y aapt && ${SETUP} --only shell` }
    );
  }

  const flutterDir = path.join(sdksDir(home), "flutter");
  const flutterVersion = read(path.join(flutterDir, "version"));
  out.push(
    exists(path.join(flutterDir, "bin", "flutter"))
      ? { label: "flutter", status: "pass", detail: flutterVersion ? flutterVersion.trim() : flutterDir }
      : { label: "flutter", status: "warn", detail: "not found", fix: `${SETUP} --only flutter` }
  );

  const pwDir = m.platform === "darwin" ? path.join(home, "Library", "Caches", "ms-playwright") : path.join(home, ".cache", "ms-playwright");
  let chromium: string | undefined;
  try {
    chromium = fs.readdirSync(pwDir).find((d) => d.startsWith("chromium"));
  } catch {
    chromium = undefined;
  }
  out.push(chromium ? { label: "playwright Chromium", status: "pass", detail: chromium } : { label: "playwright Chromium", status: "warn", detail: "no Chromium browser installed", fix: `${SETUP} --only playwright` });

  if (m.platform === "linux") {
    const record = readMachineRecord(home);
    if (!m.kvm.present) out.push({ label: "/dev/kvm", status: "warn", detail: "absent (a cloud VM without nested virtualisation): no Android emulator; QA uses Expo web and unit tests", fix: "use a VM type with nested virtualisation if you need an emulator" });
    else if (!m.kvm.accessible) out.push({ label: "/dev/kvm", status: "warn", detail: "present but this user cannot use it", fix: "sudo usermod -aG kvm $USER, then log in again" });
    else out.push({ label: "/dev/kvm", status: "pass", detail: "usable: the Android emulator can run" });
    if (record && record.headlessWebQaOnly === emulatorUsable(m)) {
      out.push({ label: "machine.json", status: "warn", detail: `headlessWebQaOnly is ${record.headlessWebQaOnly} but /dev/kvm is ${emulatorUsable(m) ? "usable" : "not usable"} now`, fix: SETUP });
    }
  }

  if (m.family === "debian") {
    const dropin = read(sys("/etc/systemd/system/apt-daily-upgrade.timer.d/override.conf"));
    const confDir = sys("/etc/apt/apt.conf.d");
    let rebootOn = false;
    let rebootOff = false;
    try {
      for (const f of fs.readdirSync(confDir)) {
        const t = read(path.join(confDir, f)) ?? "";
        if (/Unattended-Upgrade::Automatic-Reboot\s+"true"/.test(t)) rebootOn = true;
        if (/Unattended-Upgrade::Automatic-Reboot\s+"false"/.test(t)) rebootOff = true;
      }
    } catch {
      // no apt configuration to read
    }
    const at4 = dropin !== undefined && /^OnCalendar=\*-\*-\* 04:00\s*$/m.test(dropin);
    if (rebootOn) out.push({ label: "unattended-upgrades", status: "fail", detail: 'Automatic-Reboot is "true": an overnight build can be killed by a reboot', fix: `${SETUP} --only security` });
    else if (at4 && rebootOff) out.push({ label: "unattended-upgrades", status: "pass", detail: "timer at 04:00, no automatic reboot" });
    else out.push({ label: "unattended-upgrades", status: "warn", detail: !at4 ? "the upgrade timer is not pinned to 04:00" : 'Automatic-Reboot is not set to "false"', fix: `${SETUP} --only security` });
  }

  // ~/.config/yimpim: nothing in it may be readable by others.
  const cfgDir = yimpimConfigDir(home);
  if (exists(cfgDir)) {
    const loose: string[] = [];
    for (const f of [envShPath(home), machineJsonPath(home)]) {
      try {
        if ((fs.statSync(f).mode & 0o077) !== 0) loose.push(path.basename(f));
      } catch {
        // not there
      }
    }
    try {
      if ((fs.statSync(cfgDir).mode & 0o022) !== 0) loose.push("the folder itself (writable by others)");
    } catch {
      // not there
    }
    out.push(loose.length > 0 ? { label: "~/.config/yimpim permissions", status: "fail", detail: `too open: ${loose.join(", ")}`, fix: "chmod 600 ~/.config/yimpim/env.sh ~/.config/yimpim/machine.json && chmod 700 ~/.config/yimpim" } : { label: "~/.config/yimpim permissions", status: "pass", detail: "private to this user" });
  }

  if (m.platform === "linux") out.push(...hostSecurityChecks(m, run, sys, read));
  return out;
}

/** The first value OpenSSH would use for a keyword: it reads the files in order and the FIRST setting wins. */
export function sshEffective(files: string[], keyword: string): string | undefined {
  const re = new RegExp(`^\\s*${keyword}\\s+(\\S+)`, "i");
  for (const text of files) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const v = re.exec(line)?.[1];
      if (v) return v.toLowerCase();
    }
  }
  return undefined;
}

/** Listening TCP sockets that are reachable from outside (not loopback), other than SSH, from `ss -H -ltn`. */
export function publicPorts(ssOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of ssOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const m = /^(.*):(\d+)$/.exec(local);
    if (!m) continue;
    const host = m[1].replace(/^\[|\]$/g, "");
    if (host === "127.0.0.1" || host === "::1" || host.startsWith("127.") || host === "127.0.0.53%lo") continue;
    const port = Number(m[2]);
    if (port !== 22) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function hostSecurityChecks(m: MachineInfo, run: Runner, sys: (p: string) => string, read: (p: string) => string | undefined): EnvCheck[] {
  const out: EnvCheck[] = [];
  const main = read(sys("/etc/ssh/sshd_config"));
  if (main === undefined) {
    out.push({ label: "SSH server", status: "pass", detail: "no sshd_config: no SSH server is configured here" });
  } else {
    const dir = sys("/etc/ssh/sshd_config.d");
    let extra: string[] = [];
    try {
      extra = fs.readdirSync(dir).filter((f) => f.endsWith(".conf")).sort().map((f) => read(path.join(dir, f)) ?? "");
    } catch {
      extra = [];
    }
    // Modern sshd_config starts with `Include /etc/ssh/sshd_config.d/*.conf`, so those files are read first.
    const includeFirst = /^\s*Include\s+.*sshd_config\.d/m.test(main);
    const files = includeFirst ? [...extra, main] : [main, ...extra];
    const v = sshEffective(files, "PasswordAuthentication");
    if (v === "no") out.push({ label: "SSH password login", status: "pass", detail: "PasswordAuthentication no" });
    else out.push({ label: "SSH password login", status: "fail", detail: v ? `PasswordAuthentication ${v}: anyone who can reach this machine can try passwords` : "PasswordAuthentication is not set to no (OpenSSH's default is yes)", fix: "set `PasswordAuthentication no` in /etc/ssh/sshd_config.d/10-yimpim.conf, then: sudo systemctl reload ssh (keys only; consider Tailscale)" });
  }

  const ss = run({ bin: "ss", args: ["-H", "-ltn"] }, { timeoutMs: 10_000 });
  if (!ok(ss)) {
    out.push({ label: "Exposed ports", status: "warn", detail: "could not list listening ports (ss is not available)", fix: "install iproute2, or run: sudo ufw status" });
  } else {
    const ports = publicPorts(ss.stdout);
    const ufw = run({ bin: "ufw", args: ["status"] }, { timeoutMs: 10_000 });
    const ufwNote = ok(ufw) ? (/inactive/i.test(ufw.stdout) ? "ufw is inactive" : "ufw is active") : "ufw status needs root: run `sudo ufw status`";
    out.push(
      ports.length === 0
        ? { label: "Exposed ports", status: "pass", detail: `nothing listens on a public address except SSH (${ufwNote})` }
        : { label: "Exposed ports", status: "warn", detail: `listening on a public address: ${ports.slice(0, 8).join(", ")}${ports.length > 8 ? ", …" : ""} (${ufwNote})`, fix: "bind dev servers to 127.0.0.1 and reach them with Tailscale (tailscale serve) instead of opening ports" }
    );
  }
  return out;
}
