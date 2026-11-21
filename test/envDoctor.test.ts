/**
 * `yimpim doctor` now also reports the machine: which toolchains are installed, whether the host is safe to leave running (SSH passwords, exposed ports, unattended upgrades), and
 * the permissions of what setup-env writes. It reads and asks for versions; it never installs, writes or changes anything, and every problem says what to run.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolchainChecks, sshEffective, publicPorts, type EnvCheck } from "../src/envSetup/doctorChecks.js";
import type { MachineInfo } from "../src/envSetup/machine.js";
import type { Cmd, Runner } from "../src/envSetup/exec.js";

const posix = process.platform !== "win32";
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
let home = "";
let root = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ed-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ed-root-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

const machine = (over: Partial<MachineInfo> = {}): MachineInfo => ({ platform: "linux", arch: "x64", family: "debian", distro: { id: "ubuntu", idLike: ["debian"] }, kvm: { present: true, accessible: true }, isRoot: false, home, ...over });
const w = (rel: string, text: string, base = root) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};
/** A runner that answers from a table by "bin arg0": a missing entry is a program that is not installed. */
const runner = (table: Record<string, { stdout?: string; stderr?: string }>): { run: Runner; calls: Cmd[] } => {
  const calls: Cmd[] = [];
  return {
    calls,
    run: (cmd) => {
      calls.push(cmd);
      const hit = table[`${path.basename(cmd.bin)} ${cmd.args[0] ?? ""}`.trim()] ?? table[path.basename(cmd.bin)];
      return hit ? { status: 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" } : { status: null, stdout: "", stderr: "", error: "ENOENT" };
    },
  };
};
const by = (checks: EnvCheck[], label: string) => checks.find((c) => c.label === label)!;
const ALL_TOOLS = { "node --version": { stdout: "v22.1.0\n" }, "fnm --version": { stdout: "fnm 1.39.0\n" }, "uv --version": { stdout: "uv 0.13.9\n" }, "uv python": { stdout: "/home/u/.local/share/uv/python/cpython-3.14/bin/python3\n" }, "java -version": { stderr: 'openjdk version "21.0.5"\n' }, ss: { stdout: "" } };

describe("the toolchains", () => {
  test("everything present: a pass for each, with the version it found", () => {
    w(".local/bin/fnm", "");
    w("sdks/android/cmdline-tools/latest/bin/sdkmanager", "", home);
    w("sdks/flutter/bin/flutter", "", home);
    w("sdks/flutter/version", "3.50.1\n", home);
    w(".cache/ms-playwright/chromium-1234/chrome", "", home);
    const c = toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root });
    assert.deepEqual([by(c, "node").status, by(c, "node").detail], ["pass", "v22.1.0"]);
    assert.equal(by(c, "fnm").detail, "fnm 1.39.0");
    assert.equal(by(c, "uv").detail, "uv 0.13.9");
    assert.match(by(c, "python").detail, /python3/);
    assert.equal(by(c, "java").detail, 'openjdk version "21.0.5"', "java -version prints to stderr");
    assert.equal(by(c, "sdkmanager (Android SDK)").status, "pass");
    assert.equal(by(c, "flutter").detail, "3.50.1");
    assert.equal(by(c, "playwright Chromium").detail, "chromium-1234");
  });

  test("a bare machine: node is a failure, the rest are warnings, and each says exactly what to run", () => {
    const c = toolchainChecks({ machine: machine(), run: runner({}).run, sysRoot: root });
    assert.equal(by(c, "node").status, "fail");
    assert.equal(by(c, "node").fix, "yimpim setup-env --only node");
    for (const [label, only] of [["fnm", "node"], ["uv", "python"], ["python", "python"], ["java", "system"], ["sdkmanager (Android SDK)", "android"], ["flutter", "flutter"], ["playwright Chromium", "playwright"]] as const) {
      assert.equal(by(c, label).status, "warn", label);
      assert.equal(by(c, label).fix, `yimpim setup-env --only ${only}`, label);
    }
  });

  test("ARM64 Linux: the aapt2 override is checked and its absence is a failure; x64 has no such check", () => {
    const arm = machine({ arch: "arm64" });
    const missing = by(toolchainChecks({ machine: arm, run: runner(ALL_TOOLS).run, sysRoot: root }), "aapt2 override (ARM64)");
    assert.equal(missing.status, "fail");
    assert.match(missing.detail, /\/usr\/bin\/aapt2 is missing/);
    w("usr/bin/aapt2", "");
    const noKey = by(toolchainChecks({ machine: arm, run: runner(ALL_TOOLS).run, sysRoot: root }), "aapt2 override (ARM64)");
    assert.match(noKey.detail, /android\.aapt2FromMavenOverride is not set in ~\/\.gradle\/gradle\.properties/);
    assert.match(noKey.fix!, /sudo apt-get install -y aapt && yimpim setup-env --only shell/);
    w(".gradle/gradle.properties", "android.aapt2FromMavenOverride=/usr/bin/aapt2\n", home);
    assert.equal(by(toolchainChecks({ machine: arm, run: runner(ALL_TOOLS).run, sysRoot: root }), "aapt2 override (ARM64)").status, "pass");
    assert.equal(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }).some((c) => /aapt2/.test(c.label)), false);
  });

  test("/dev/kvm: usable, present but not usable, absent (headless QA only); and a stale machine.json is flagged", () => {
    assert.equal(by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "/dev/kvm").status, "pass");
    const noAccess = by(toolchainChecks({ machine: machine({ kvm: { present: true, accessible: false } }), run: runner(ALL_TOOLS).run, sysRoot: root }), "/dev/kvm");
    assert.equal(noAccess.status, "warn");
    assert.match(noAccess.fix!, /usermod -aG kvm/);
    const absent = by(toolchainChecks({ machine: machine({ kvm: { present: false, accessible: false } }), run: runner(ALL_TOOLS).run, sysRoot: root }), "/dev/kvm");
    assert.match(absent.detail, /no Android emulator; QA uses Expo web and unit tests/);
    w(".config/yimpim/machine.json", JSON.stringify({ schema: 1, headlessWebQaOnly: true }), home);
    const stale = by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "machine.json");
    assert.match(stale.detail, /headlessWebQaOnly is true but \/dev\/kvm is usable now/);
  });

  test("macOS skips the Linux-only checks (kvm, unattended upgrades, SSH, ports)", () => {
    const c = toolchainChecks({ machine: machine({ platform: "darwin", family: "macos", distro: undefined }), run: runner(ALL_TOOLS).run, sysRoot: root });
    for (const label of ["/dev/kvm", "unattended-upgrades", "SSH password login", "Exposed ports"]) assert.equal(c.some((x) => x.label === label), false, label);
  });
});

describe("unattended upgrades", () => {
  const status = () => by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "unattended-upgrades");
  test("pinned to 04:00 with no automatic reboot: a pass", () => {
    w("etc/systemd/system/apt-daily-upgrade.timer.d/override.conf", "[Timer]\nOnCalendar=\nOnCalendar=*-*-* 04:00\nRandomizedDelaySec=0\n");
    w("etc/apt/apt.conf.d/52yimpim-unattended", 'Unattended-Upgrade::Automatic-Reboot "false";\n');
    assert.deepEqual([status().status, status().detail], ["pass", "timer at 04:00, no automatic reboot"]);
  });
  test("automatic reboot on anywhere in apt's configuration: a failure, because an overnight build would be killed", () => {
    w("etc/systemd/system/apt-daily-upgrade.timer.d/override.conf", "OnCalendar=*-*-* 04:00\n");
    w("etc/apt/apt.conf.d/50unattended-upgrades", 'Unattended-Upgrade::Automatic-Reboot "true";\n');
    assert.equal(status().status, "fail");
    assert.match(status().detail, /overnight build can be killed by a reboot/);
    assert.equal(status().fix, "yimpim setup-env --only security");
  });
  test("nothing configured, or the timer at another time: a warning with the fix", () => {
    assert.equal(status().status, "warn");
    assert.match(status().detail, /not pinned to 04:00/);
    w("etc/systemd/system/apt-daily-upgrade.timer.d/override.conf", "OnCalendar=*-*-* 06:00\n");
    assert.match(status().detail, /not pinned to 04:00/);
  });
});

describe("SSH and exposed ports", () => {
  const ssh = (r = runner(ALL_TOOLS)) => by(toolchainChecks({ machine: machine(), run: r.run, sysRoot: root }), "SSH password login");
  test("OpenSSH uses the FIRST value it reads: a drop-in included at the top overrides a later setting in the main file", () => {
    assert.equal(sshEffective(["PasswordAuthentication no\n", "PasswordAuthentication yes\n"], "PasswordAuthentication"), "no");
    assert.equal(sshEffective(["# PasswordAuthentication yes\n", "  PasswordAuthentication   No  \n"], "PasswordAuthentication"), "no", "comments are skipped, case does not matter");
    assert.equal(sshEffective(["Port 22\n"], "PasswordAuthentication"), undefined);
    w("etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication yes\n");
    w("etc/ssh/sshd_config.d/60-cloudimg-settings.conf", "PasswordAuthentication no\n");
    assert.equal(ssh().status, "pass");
  });
  test("password login enabled (explicitly, or by default): a failure that says loudly what to change", () => {
    w("etc/ssh/sshd_config", "Port 22\nPasswordAuthentication yes\n");
    const c = ssh();
    assert.equal(c.status, "fail");
    assert.match(c.detail, /PasswordAuthentication yes: anyone who can reach this machine can try passwords/);
    assert.match(c.fix!, /PasswordAuthentication no.*systemctl reload ssh.*Tailscale/);
    fs.writeFileSync(path.join(root, "etc/ssh/sshd_config"), "Port 22\n");
    assert.match(ssh().detail, /not set to no \(OpenSSH's default is yes\)/);
  });
  test("no SSH server configured: nothing to warn about", () => {
    const c = by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "SSH server");
    assert.equal(c.status, "pass");
    assert.match(c.detail, /no SSH server is configured here/);
    assert.equal(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }).some((x) => x.label === "SSH password login"), false);
  });

  test("ss output: loopback and SSH are ignored, anything reachable from outside is listed once, sorted", () => {
    const out = ["LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*", "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*", "LISTEN 0 128 [::]:22 [::]:*", "LISTEN 0 511 0.0.0.0:8081 0.0.0.0:*", "LISTEN 0 511 [::]:8081 [::]:*", "LISTEN 0 511 *:19000 *:*", "LISTEN 0 4096 [::1]:631 [::]:*", "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*", "LISTEN 0 511 192.168.1.5:3001 0.0.0.0:*"].join("\n");
    assert.deepEqual(publicPorts(out), [3001, 8081, 19000]);
    assert.deepEqual(publicPorts(""), []);
  });
  test("exposed dev-server ports are a warning that recommends Tailscale; nothing exposed is a pass; ufw's state is reported without root; a missing ss is said", () => {
    const exposed = runner({ ...ALL_TOOLS, ss: { stdout: "LISTEN 0 511 0.0.0.0:8081 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n" }, "ufw status": { stdout: "Status: inactive\n" } });
    const c = by(toolchainChecks({ machine: machine(), run: exposed.run, sysRoot: root }), "Exposed ports");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /listening on a public address: 8081 \(ufw is inactive\)/);
    assert.match(c.fix!, /Tailscale \(tailscale serve\) instead of opening ports/);
    const clean = by(toolchainChecks({ machine: machine(), run: runner({ ...ALL_TOOLS, ss: { stdout: "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n" } }).run, sysRoot: root }), "Exposed ports");
    assert.equal(clean.status, "pass");
    assert.match(clean.detail, /ufw status needs root: run `sudo ufw status`/);
    const noSs = by(toolchainChecks({ machine: machine(), run: runner({ "node --version": { stdout: "v22\n" } }).run, sysRoot: root }), "Exposed ports");
    assert.match(noSs.detail, /ss is not available/);
  });
});

describe("what setup-env wrote is private", () => {
  test("env.sh and machine.json readable by others, or a folder others can write to: a failure with the chmod to run", { skip: !posix }, () => {
    const cfg = path.join(home, ".config", "yimpim");
    w(".config/yimpim/env.sh", "x", home);
    w(".config/yimpim/machine.json", "{}", home);
    fs.chmodSync(path.join(cfg, "env.sh"), 0o644);
    fs.chmodSync(path.join(cfg, "machine.json"), 0o600);
    const c = by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "~/.config/yimpim permissions");
    assert.equal(c.status, "fail");
    assert.match(c.detail, /too open: env\.sh/);
    assert.match(c.fix!, /chmod 600 ~\/\.config\/yimpim\/env\.sh ~\/\.config\/yimpim\/machine\.json && chmod 700 ~\/\.config\/yimpim/);
    fs.chmodSync(path.join(cfg, "env.sh"), 0o600);
    fs.chmodSync(cfg, 0o700);
    assert.equal(by(toolchainChecks({ machine: machine(), run: runner(ALL_TOOLS).run, sysRoot: root }), "~/.config/yimpim permissions").status, "pass");
  });
});

describe("doctor is read-only, and part of the report", () => {
  const snapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        out.push(`${path.relative(dir, p)}|${e.isDirectory() ? "d" : fs.statSync(p).size}|${fs.statSync(p).mtimeMs}`);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  };

  test("running every check changes nothing in the home folder or the system root, and starts only version, list and read commands", () => {
    w(".config/yimpim/machine.json", "{}", home);
    w("etc/ssh/sshd_config", "PasswordAuthentication yes\n");
    const before = [snapshot(home), snapshot(root)];
    const r = runner({ ...ALL_TOOLS, ss: { stdout: "LISTEN 0 511 0.0.0.0:8081 0.0.0.0:*\n" } });
    toolchainChecks({ machine: machine({ arch: "arm64" }), run: r.run, sysRoot: root });
    assert.deepEqual([snapshot(home), snapshot(root)], before);
    const programs = new Set(r.calls.map((c) => path.basename(c.bin)));
    assert.deepEqual([...programs].sort(), ["fnm", "java", "node", "python3", "ss", "ufw", "uv"].filter((p) => programs.has(p)).sort());
    for (const c of r.calls) assert.ok(c.args.every((a) => /^(--version|-version|python|find|status|-H|-ltn)$/.test(a)), `${c.bin} ${c.args.join(" ")}`);
    assert.ok(!r.calls.some((c) => /^(sudo|apt|apt-get|dnf|brew|npm|npx|curl|wget)$/.test(path.basename(c.bin))), "nothing is installed or downloaded");
  });

  test("the module never writes, installs or deletes: no write, mkdir, rm, rename, chmod or download in the doctor checks", () => {
    const code = src("src/envSetup/doctorChecks.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    assert.ok(!/writeFile|appendFile|mkdirSync|rmSync|unlinkSync|renameSync|chmodSync|copyFile|fetch\(|downloadTo/.test(code));
    // `sudo` appears only inside the advice a person reads (a fix hint); nothing is ever run through it
    assert.ok(!/sudo:\s*true|opts\.sudo|"sudo"/.test(code));
  });

  test("the report: the section is part of `yimpim doctor`, a serious problem is drawn as a failure without blocking a run, and a doctor failure in this part never stops the rest", () => {
    const d = src("src/doctor.ts");
    assert.ok(d.includes('"Developer toolchains and host security (yimpim setup-env installs the toolchains)"'));
    assert.ok(d.includes('const icon = c.ok ? OK : c.required || c.severity === "fail" ? BAD : WARN;'));
    assert.ok(d.includes('...(c.status === "fail" ? { severity: "fail" as const } : {})'));
    assert.ok(/blockers = core\.filter\(\(c\) => c\.required && !c\.ok\)/.test(d), "only core checks decide canRun");
    assert.ok(d.includes("the machine checks could not run"));
  });

  test("it is a command-line command with help text, and `yimpim doctor` was already one (nothing here added a second doctor)", () => {
    const cli = src("src/cli.ts");
    assert.ok(cli.includes('const COMMANDS = ["run", "doctor", "config", "init", "help", "version", "setup", "setup-env", "relay", "link"];'));
    assert.match(cli, /yimpim setup-env +Install the toolchains a new machine needs/);
    assert.equal((cli.match(/"doctor"/g) ?? []).length, 2, "the type and the table, once each");
  });
});
