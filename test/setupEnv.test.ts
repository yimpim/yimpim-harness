/**
 * `yimpim setup-env` installs software and may use sudo, so it is built to be run only by a person, to trust only what a vendor published, and never to touch a shell.
 * The five guarantees asked for are tested first; the plan, the confirmation, the vendor parsers and the file writes follow.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { realRunner, display, assertSafeArg, type Cmd, type Runner } from "../src/envSetup/exec.js";
import { verifyChecksum, extractVerified, assertSafeEntries, assertAllowedUrl, fetchText, parseSha256Sum, digestAlgorithm, ChecksumError, UnsafeArchiveError } from "../src/envSetup/download.js";
import { applyGradleOverride, gradleOverrideFor, ensureProperty, upsertRcBlock, renderEnvSh, applyShellEnv, writeFileAtomic, GRADLE_KEY, AAPT2_PATH, RC_BEGIN } from "../src/envSetup/shellEnv.js";
import { buildPlan, executePlan, formatPlan, cleanEnv, assertHumanInvocation, parseSetupArgs, securityCommands, systemPackages, systemCommands, UNATTENDED_CONF, TIMER_DROPIN, COMPONENTS, runSetupEnv } from "../src/envSetup/setup.js";
import { detectMachine, parseOsRelease, familyOf, readMachineRecord, emulatorUsable, type MachineInfo } from "../src/envSetup/machine.js";
import { pickFnmAsset, pickUvAssets, parseAndroidRepository, chooseSdkPackages, pickFlutterRelease, flutterReleasesUrl, compareVersions } from "../src/envSetup/vendor.js";
import { evaluateCommand } from "../src/commandPolicy.js";
import { scrubbedEnv } from "../src/sandboxRunTest.js";
import { javaAwareEnv } from "../src/capabilities.js";

const posix = process.platform !== "win32";
const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
let home = "";
let tmp = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "se-home-"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-tmp-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const machine = (over: Partial<MachineInfo> = {}): MachineInfo => ({
  platform: "linux",
  arch: "x64",
  family: "debian",
  distro: { id: "ubuntu", idLike: ["debian"], versionId: "24.04", name: "Ubuntu 24.04" },
  kvm: { present: true, accessible: true },
  isRoot: false,
  home,
  ...over,
});
/** A runner that records every command and answers from a table (default: success with no output). */
const recorder = (answer: (c: Cmd) => { status: number; stdout?: string; stderr?: string } = () => ({ status: 0 })) => {
  const calls: { cmd: Cmd; sudo?: boolean }[] = [];
  const run: Runner = (cmd, opts) => {
    calls.push({ cmd, sudo: opts?.sudo });
    const a = answer(cmd);
    return { status: a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
};
const file = (name: string, content: string | Buffer) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const sha1 = (b: Buffer | string) => crypto.createHash("sha1").update(b).digest("hex");

// ======================================================================================================== 1. never an agent's tool

describe("1. setup-env and doctor are never offered to an agent, and an agent cannot start them", () => {
  test("no tool in any registry an agent can be given is named for them, and none of their descriptions offers them", async () => {
    const mods = [await import("../src/agentTools.js"), await import("../src/healSandbox.js")] as Record<string, any>[];
    const tools: any[] = [];
    for (const m of mods) for (const [name, v] of Object.entries(m)) if ((/TOOLS_SCHEMA$/.test(name) || /_TOOL$/.test(name)) && v) tools.push(...(Array.isArray(v) ? v : [v]));
    assert.ok(tools.length > 20, `registries found: ${tools.length}`);
    for (const t of tools) {
      const name = String(t?.function?.name ?? "");
      assert.ok(!/setup[-_]?env|^doctor$|environment[-_]?setup/i.test(name), `tool ${name}`);
      assert.ok(!/setup-env|yimpim doctor/i.test(String(t?.function?.description ?? "")), `description of ${name}`);
    }
  });

  test("no agent module imports them: only the CLI entry starts setup-env, and only doctor.ts reads the doctor checks", () => {
    const dir = "src";
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const importing = (needle: RegExp) => all.filter((f) => needle.test(src(path.join(dir, f))));
    assert.deepEqual(importing(/envSetup\/setup\.js/), ["index.ts"], "only the entry point");
    assert.deepEqual(importing(/envSetup\/doctorChecks\.js/), ["doctor.ts"]);
    for (const agent of ["agentTools.ts", "agentLoop.ts", "verifierTools.ts", "testHeal.ts", "healSandbox.ts", "editorSweep.ts", "repairRunTest.ts", "roadmapFlow.ts", "planner.ts", "qaBrowserAgent.ts"]) {
      assert.ok(!/setup-env|envSetup/.test(src(path.join(dir, agent))), agent);
    }
  });

  test("it is a command-line command only: not a slash command in a session, not a roadmap or planner step, and the entry dispatches it before anything that needs a key", () => {
    // a slash command would be a string literal starting with "/setup-env": the only one is the policy's own deny of a path ending in it
    const slash = fs.readdirSync("src").filter((f) => f.endsWith(".ts") && /["'`]\/setup-env/.test(src(path.join("src", f))));
    assert.deepEqual(slash, ["commandPolicy.ts"], "no live command or menu entry is named /setup-env");
    const idx = src("src/index.ts");
    assert.ok(idx.includes('if (args.command === "setup-env") {\n    const { runSetupEnv } = await import("./envSetup/setup.js");\n    process.exitCode = await runSetupEnv(process.argv.slice(3));'));
    assert.ok(idx.indexOf('args.command === "setup-env"') < idx.indexOf('args.command === "run" && needsSetup()'), "before the first-run API-key gate");
  });

  test("an agent that tries to run it, however it spells the command, is denied by the command policy", () => {
    const opts = { repoRoot: home, approvals: undefined as any, clearedPackages: undefined as any, agentCreated: { files: [], dirs: [], trusted: [] } } as any;
    for (const c of ["yimpim setup-env", "yp setup-env --yes", "node dist/index.js setup-env --yes", "npx yimpim setup-env", "npm run setup-env", "./dist/setup-env", "yimpim setup-env --dry-run"]) {
      const d: any = evaluateCommand(c, opts);
      assert.equal(d.verdict, "deny", c);
      assert.match(d.reason, /is for a person to run themselves, never an agent/);
    }
  });

  test("the commands an agent starts carry a marker, and setup-env refuses to run with it, from a non-entry argv, without a terminal, or as root", () => {
    assert.equal(scrubbedEnv({ PATH: "/bin" }).YIMPIM_AGENT_CONTEXT, "1");
    assert.equal(javaAwareEnv({ available: false } as any, { PATH: "/bin" }).YIMPIM_AGENT_CONTEXT, "1");
    const ok = { yes: false, tty: true, isRoot: false };
    assert.doesNotThrow(() => assertHumanInvocation(["node", "yimpim", "setup-env"], {}, ok));
    assert.throws(() => assertHumanInvocation(["node", "yimpim", "setup-env"], { YIMPIM_AGENT_CONTEXT: "1" }, ok), /cannot be started from an agent/);
    assert.throws(() => assertHumanInvocation(["node", "yimpim", "run"], {}, ok), /only be started from the command line/);
    assert.throws(() => assertHumanInvocation(["node", "yimpim", "setup-env"], {}, { ...ok, tty: false }), /needs a terminal to ask for confirmation/);
    assert.doesNotThrow(() => assertHumanInvocation(["node", "yimpim", "setup-env"], {}, { ...ok, tty: false, yes: true }), "--yes is for a person at a command line (a provisioning script)");
    assert.throws(() => assertHumanInvocation(["node", "yimpim", "setup-env"], {}, { ...ok, isRoot: true }), /not root/);
  });

  test("runSetupEnv itself refuses under an agent, before it plans or runs anything", async () => {
    const { run, calls } = recorder();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      const code = await runSetupEnv(["--yes"], { argv: ["node", "yimpim", "setup-env"], env: { YIMPIM_AGENT_CONTEXT: "1" }, tty: true, machine: machine(), run });
      assert.equal(code, 1);
    } finally {
      console.error = orig;
    }
    assert.equal(calls.length, 0);
    assert.match(errs.join("\n"), /cannot be started from an agent/);
  });
});

// ======================================================================================================== 2. checksums before extraction

describe("2. a tampered archive is rejected before anything is extracted", () => {
  const good = Buffer.from("the real archive bytes");
  const entries = "tool/bin/tool\ntool/README\n";
  const archiveRunner = () => recorder((c) => (c.args.some((a) => /^-(tzf|tJf|Z1)$/.test(a)) || c.args.includes("-Z1") ? { status: 0, stdout: entries } : { status: 0 }));

  test("SHA-256: the right file passes; a changed byte is refused, nothing is listed or extracted, and the destination is never created", () => {
    const f = file("tool.tar.gz", good);
    const dest = path.join(tmp, "out");
    const r1 = archiveRunner();
    const v = extractVerified(r1.run, f, sha256(good), dest, "tar.gz");
    assert.deepEqual([v.algorithm, v.digest, v.sha256], ["sha256", sha256(good), sha256(good)]);
    assert.equal(r1.calls.length, 2, "list, then extract");
    assert.deepEqual(r1.calls.map((c) => c.cmd.args[0]), ["-tzf", "-xzf"]);

    const tampered = file("evil.tar.gz", Buffer.concat([good, Buffer.from("!")]));
    const r2 = archiveRunner();
    const dest2 = path.join(tmp, "out2");
    assert.throws(() => extractVerified(r2.run, tampered, sha256(good), dest2, "tar.gz"), (e: any) => e instanceof ChecksumError && /does not match the checksum its vendor published \(sha256\)[\s\S]*It was not extracted/.test(e.message));
    assert.equal(r2.calls.length, 0, "not even listed");
    assert.equal(fs.existsSync(dest2), false);
  });

  test("SHA-1 (what Google publishes for the Android tools) is verified the same way; a wrong one is refused; anything that is neither is refused", () => {
    const f = file("cmd.zip", good);
    assert.equal(extractVerified(archiveRunner().run, f, sha1(good), path.join(tmp, "a"), "zip").algorithm, "sha1");
    const r = archiveRunner();
    assert.throws(() => extractVerified(r.run, f, sha1("something else"), path.join(tmp, "b"), "zip"), ChecksumError);
    assert.equal(r.calls.length, 0);
    for (const bad of ["", "abc123", "z".repeat(64), sha256(good) + "0", "sha256:" + sha256(good)]) assert.throws(() => verifyChecksum(f, bad), ChecksumError, bad.slice(0, 12));
    assert.equal(digestAlgorithm(sha256(good)), "sha256");
    assert.equal(digestAlgorithm(sha1(good)), "sha1");
    assert.equal(digestAlgorithm("0".repeat(63)), undefined);
  });

  test("the checksum is compared case-insensitively, and the SHA-256 of what was downloaded is always recorded", () => {
    const v = verifyChecksum(file("x.zip", good), sha1(good).toUpperCase());
    assert.equal(v.sha256, sha256(good));
  });

  test("an archive whose file list would write outside the destination is refused after the checksum passes, and nothing is extracted", () => {
    const f = file("slip.tar.gz", good);
    for (const bad of ["../../etc/cron.d/x", "/etc/passwd", "ok/../../up", "C:\\Windows\\x", "a/../../b"]) {
      const r = recorder((c) => (c.args[0] === "-tzf" ? { status: 0, stdout: `fine/file\n${bad}\n` } : { status: 0 }));
      assert.throws(() => extractVerified(r.run, f, sha256(good), path.join(tmp, "z"), "tar.gz"), UnsafeArchiveError, bad);
      assert.equal(r.calls.length, 1, "only the listing ran");
    }
    assert.doesNotThrow(() => assertSafeEntries(["a/b", "a/b/c.txt", "flutter/bin/flutter"]));
  });

  test("downloads only come from the vendors' hosts over HTTPS, and a redirect to anywhere else is refused", async () => {
    assert.doesNotThrow(() => assertAllowedUrl("https://dl.google.com/android/repository/repository2-1.xml"));
    for (const u of ["http://dl.google.com/x", "https://evil.example/x", "https://github.com.evil.example/x", "ftp://github.com/x", "file:///etc/passwd"]) assert.throws(() => assertAllowedUrl(u), u);
    const redirected = (async () => ({ ok: true, status: 200, url: "https://evil.example/payload", text: async () => "x" })) as any;
    await assert.rejects(() => fetchText("https://github.com/a/b", redirected), /not one of the vendors' hosts/);
    const fine = (async () => ({ ok: true, status: 200, url: "https://objects.githubusercontent.com/x", text: async () => "hello" })) as any;
    assert.equal(await fetchText("https://github.com/a/b", fine), "hello");
  });

  test("a sha256sum file is read for the right file name", () => {
    const h = "a".repeat(64);
    assert.equal(parseSha256Sum(`${h}  uv-x86_64-unknown-linux-gnu.tar.gz\n`, "uv-x86_64-unknown-linux-gnu.tar.gz"), h);
    assert.equal(parseSha256Sum(`${h}  other.tar.gz\n`, "uv-x86_64-unknown-linux-gnu.tar.gz"), undefined);
    assert.equal(parseSha256Sum("not a checksum line"), undefined);
  });

  test("every installer verifies before it extracts: there is no other way an archive is opened", () => {
    const setup = src("src/envSetup/setup.ts");
    assert.equal((setup.match(/extractVerified\(/g) ?? []).length, 4, "fnm, uv, the Android tools, Flutter");
    assert.ok(!/["']-x[zJ]f["']|bin:\s*["']unzip["']|bin:\s*["']tar["']/.test(setup), "no extraction command is built outside download.ts");
    const dl = src("src/envSetup/download.ts");
    assert.ok(dl.indexOf("verifyChecksum(archive, expectedHex)") < dl.indexOf("run(listCmd(kind, archive))"));
    assert.ok(dl.indexOf("run(listCmd(kind, archive))") < dl.indexOf("run(extractCmd(kind, archive, dest))"));
  });
});

// ======================================================================================================== 3. arm64 aapt2

describe("3. ARM64 writes the aapt2 override, x64 does not", () => {
  const propsFile = () => path.join(home, ".gradle", "gradle.properties");
  test("arm64 Linux: the override is written; x64 Linux and macOS (either architecture): nothing", () => {
    assert.deepEqual(gradleOverrideFor({ platform: "linux", arch: "arm64" }), { key: "android.aapt2FromMavenOverride", value: "/usr/bin/aapt2" });
    assert.equal(gradleOverrideFor({ platform: "linux", arch: "x64" }), undefined);
    assert.equal(gradleOverrideFor({ platform: "darwin", arch: "arm64" }), undefined);
    assert.equal(applyGradleOverride(home, { platform: "linux", arch: "arm64" }), "written");
    assert.equal(fs.readFileSync(propsFile(), "utf8"), "android.aapt2FromMavenOverride=/usr/bin/aapt2\n");
    fs.rmSync(path.join(home, ".gradle"), { recursive: true });
    assert.equal(applyGradleOverride(home, { platform: "linux", arch: "x64" }), "not needed");
    assert.equal(fs.existsSync(propsFile()), false, "x64 leaves no file at all");
    assert.equal(applyGradleOverride(home, { platform: "darwin", arch: "arm64" }), "not needed");
  });
  test("idempotent: running it again changes nothing, an existing wrong value is corrected in place, and the person's other settings are kept", () => {
    fs.mkdirSync(path.join(home, ".gradle"));
    fs.writeFileSync(propsFile(), "org.gradle.jvmargs=-Xmx4g\nandroid.aapt2FromMavenOverride=/opt/old/aapt2\nandroid.useAndroidX=true\n");
    applyGradleOverride(home, { platform: "linux", arch: "arm64" });
    applyGradleOverride(home, { platform: "linux", arch: "arm64" });
    const text = fs.readFileSync(propsFile(), "utf8");
    assert.equal(text, "org.gradle.jvmargs=-Xmx4g\nandroid.aapt2FromMavenOverride=/usr/bin/aapt2\nandroid.useAndroidX=true\n");
    assert.equal((text.match(/aapt2FromMavenOverride/g) ?? []).length, 1);
    assert.equal(ensureProperty("a=1", "b", "2"), "a=1\nb=2\n");
  });
  test("the plan installs the OS aapt package on arm64 only, and the system step names it", () => {
    assert.ok(systemPackages(machine({ arch: "arm64" }), "openjdk-21-jdk").includes("aapt"));
    assert.ok(!systemPackages(machine({ arch: "x64" }), "openjdk-21-jdk").includes("aapt"));
    assert.ok(!systemPackages(machine({ arch: "arm64", platform: "darwin", family: "macos" }), "openjdk@21").includes("aapt"));
    const arm = buildPlan(machine({ arch: "arm64" }), { yes: true, dryRun: true }, recorder().run);
    assert.match(arm.find((s) => s.id === "shell")!.title, /the ARM64 aapt2 Gradle override/);
    assert.ok(arm.find((s) => s.id === "system")!.sudo.some((c) => c.args.includes("aapt")));
    const x64 = buildPlan(machine({ arch: "x64" }), { yes: true, dryRun: true }, recorder().run);
    assert.ok(!/aapt2/.test(x64.find((s) => s.id === "shell")!.title));
    assert.equal(AAPT2_PATH, "/usr/bin/aapt2");
    assert.equal(GRADLE_KEY, "android.aapt2FromMavenOverride");
  });
});

// ======================================================================================================== 4. no /dev/kvm

describe("4. a missing /dev/kvm sets headlessWebQaOnly cleanly", () => {
  const runShell = async (m: MachineInfo) => {
    const lines: string[] = [];
    const steps = buildPlan(m, { yes: true, dryRun: false, only: ["shell"] }, recorder().run);
    const res = await executePlan(m, steps, { yes: true, dryRun: false, only: ["shell"] }, { run: recorder().run, log: (l) => lines.push(l), tmp });
    return { res, lines };
  };
  test("no /dev/kvm: machine.json says headlessWebQaOnly true, with no emulator planned, and nothing hangs or fails", async () => {
    const m = machine({ kvm: { present: false, accessible: false } });
    const { res, lines } = await runShell(m);
    assert.equal(res.ok, true, lines.join("\n"));
    const rec = readMachineRecord(home)!;
    assert.equal(rec.headlessWebQaOnly, true);
    assert.deepEqual(rec.kvm, { present: false, accessible: false });
    assert.equal(rec.platform, "linux");
    assert.equal(rec.schema, 1);
    assert.ok(lines.some((l) => /headlessWebQaOnly = true \(no emulator here; QA uses Expo web and unit tests\)/.test(l)));
    const android = buildPlan(m, { yes: true, dryRun: true }, recorder().run).find((s) => s.id === "android")!;
    assert.match(android.title, /NO emulator \(no usable \/dev\/kvm\)/);
    assert.ok(!android.userLines.join(" ").includes("emulator <"));
  });
  test("a /dev/kvm that exists but this user cannot use is the same as none", async () => {
    await runShell(machine({ kvm: { present: true, accessible: false } }));
    assert.equal(readMachineRecord(home)!.headlessWebQaOnly, true);
  });
  test("a usable /dev/kvm: headlessWebQaOnly false, and the emulator and the host's own system image are planned (x86_64 on x64, arm64-v8a on arm64)", async () => {
    await runShell(machine());
    assert.equal(readMachineRecord(home)!.headlessWebQaOnly, false);
    const plan = (arch: string) => buildPlan(machine({ arch }), { yes: true, dryRun: true }, recorder().run).find((s) => s.id === "android")!.userLines.join(" ");
    assert.match(plan("x64"), /emulator <x86_64 system image>/);
    assert.match(plan("arm64"), /emulator <arm64-v8a system image>/);
    assert.equal(emulatorUsable(machine({ platform: "darwin", family: "macos", kvm: { present: false, accessible: false } })), true, "macOS has its own acceleration");
  });
  test("the files it writes are private (0600), written atomically, and leave no temporary file behind", async () => {
    await runShell(machine());
    const cfg = path.join(home, ".config", "yimpim");
    if (posix) {
      assert.equal(fs.statSync(path.join(cfg, "machine.json")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(cfg, "env.sh")).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(cfg).sort(), ["env.sh", "machine.json"]);
    assert.ok(fs.readFileSync(path.join(home, ".bashrc"), "utf8").includes(RC_BEGIN));
  });
});

// ======================================================================================================== 5. no shell

describe("5. no subprocess ever uses a shell or an interpolated command string", () => {
  const modules = () => fs.readdirSync("src/envSetup").filter((f) => f.endsWith(".ts")).map((f) => [f, src(path.join("src/envSetup", f))] as const);

  test("the code: no shell option, no exec/execSync/execFile, no /bin/sh, sh -c, bash -c or cmd /c, and spawnSync appears once, with shell: false", () => {
    for (const [name, text] of modules()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
      assert.ok(!/shell:\s*true/.test(code), `${name}: shell: true`);
      assert.ok(!/\bexecSync\b|\bexecFileSync\b|\bexecFile\b|\bchild_process\.exec\b|[^a-zA-Z.]exec\(/.test(code.replace(/ctx\.run|\.exec\(/g, "")), `${name}: exec*`);
      assert.ok(!/\/bin\/(ba)?sh|\bsh -c\b|\bbash -c\b|cmd(\.exe)?\s*\/c|powershell/i.test(code), `${name}: a shell`);
    }
    const all = modules().map(([, t]) => t).join("\n");
    assert.equal((all.match(/spawnSync\(/g) ?? []).length, 1);
    assert.ok(src("src/envSetup/exec.ts").includes("shell: false,"));
    assert.ok(!/\beval\b|new Function/.test(modules().map(([, t]) => t.replace(/'command -v fnm[^']*'/g, "")).join("\n").replace(/eval "\$\(fnm env[^\n]*/g, "")), "no eval in the program (the one line in env.sh is fnm's own documented init)");
  });

  test("the behaviour: a hostile argument reaches the program as plain text, never as a command", () => {
    // only `echo`: even if a shell ever did run this, it would change nothing on disk
    const hostile = "x; echo INJECTED $(whoami) && echo INJECTED-TOO `id`";
    const r = realRunner({ bin: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", hostile] });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, hostile);
  });

  test("an argument with a line break or a NUL, or one that is not a string, is refused before anything starts", () => {
    for (const bad of ["a\nb", "a\rb", "a\0b"]) assert.throws(() => realRunner({ bin: process.execPath, args: ["-e", "1", bad] }), /line break or NUL/);
    assert.throws(() => assertSafeArg(42), /must be a string/);
    assert.throws(() => realRunner({ bin: "echo\n", args: [] }), /line break/);
  });

  test("sudo is applied to a program and its argument array, never to a string: `sudo -- program args…`", () => {
    let seen: { bin?: string; args?: string[] } = {};
    const exec = src("src/envSetup/exec.ts");
    assert.ok(exec.includes('const bin = opts.sudo ? "sudo" : cmd.bin;'));
    assert.ok(exec.includes('const args = opts.sudo ? ["--", cmd.bin, ...cmd.args] : cmd.args;'));
    assert.equal(display({ bin: "apt-get", args: ["install", "-y", "git", "a b"] }, true), "sudo apt-get install -y git 'a b'");
    assert.equal(display({ bin: "echo", args: ["it's"] }), "echo 'it'\\''s'");
    void seen;
  });

  test("the environment a downloaded tool runs with has no secret in it", () => {
    const keep = process.env;
    process.env = { ...keep, OPENROUTER_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_x", AWS_SECRET_ACCESS_KEY: "s", NPM_TOKEN: "n", PATH: keep.PATH };
    try {
      const env = cleanEnv(home, { FNM_DIR: "/x" });
      assert.deepEqual(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)), []);
      assert.equal(env.FNM_DIR, "/x");
      assert.equal(env.HOME, home);
      assert.ok(env.PATH!.startsWith(path.join(home, ".local", "bin")));
    } finally {
      process.env = keep;
    }
  });
});

// ======================================================================================================== the plan and the confirmation

describe("the plan, and what is confirmed before anything runs", () => {
  test("Debian: the exact apt-get commands, through sudo; RHEL: dnf; macOS: brew, as the user, no sudo", () => {
    const deb = systemCommands(machine(), systemPackages(machine(), "openjdk-21-jdk"));
    assert.deepEqual(deb.sudo.map((c) => display(c, true)), ["sudo apt-get update", "sudo apt-get install -y --no-install-recommends ca-certificates git unzip xz-utils build-essential openjdk-21-jdk"]);
    const rhel = machine({ family: "rhel", distro: { id: "fedora", idLike: [] } });
    assert.deepEqual(systemCommands(rhel, systemPackages(rhel, "java-21-openjdk-devel")).sudo.map((c) => display(c, true)), ["sudo dnf install -y ca-certificates git unzip xz gcc gcc-c++ make java-21-openjdk-devel"]);
    const mac = machine({ platform: "darwin", family: "macos", distro: undefined });
    const m = systemCommands(mac, systemPackages(mac, "openjdk@21"));
    assert.deepEqual([m.sudo.length, m.user.map((c) => display(c))], [0, ["brew install git xz openjdk@21"]]);
  });

  test("the Java package is whichever the package manager has (21, else 17)", () => {
    const has = (names: string[]) => recorder((c) => ({ status: names.some((n) => c.args.includes(n)) ? 0 : 1 })).run;
    const plan = (names: string[]) => buildPlan(machine(), { yes: true, dryRun: true, only: ["system"] }, has(names))[0].sudo[1].args.join(" ");
    assert.match(plan(["openjdk-21-jdk", "openjdk-17-jdk"]), /openjdk-21-jdk/);
    assert.match(plan(["openjdk-17-jdk"]), /openjdk-17-jdk/);
    assert.ok(!/openjdk/.test(plan([])));
  });

  test("the printed plan lists every sudo command exactly, and what runs as the user", () => {
    const text = formatPlan(buildPlan(machine(), { yes: true, dryRun: true }, recorder().run)).join("\n");
    assert.match(text, /^ {4}sudo apt-get update$/m);
    assert.match(text, /^ {4}sudo apt-get install -y unattended-upgrades$/m);
    assert.match(text, /^ {4}sudo systemctl restart apt-daily-upgrade\.timer$/m);
    assert.match(text, /Playwright asks for sudo itself to install the browser's OS libraries/);
    assert.match(text, /\(as you\) download the fnm release for linux\/x64 from GitHub, verify its SHA-256/);
  });

  test("a person who says no: nothing runs. --yes skips the question. A dry run runs nothing and asks nothing", async () => {
    const m = machine();
    const asked: string[] = [];
    const lines: string[] = [];
    const rec = recorder();
    const steps = buildPlan(m, { yes: false, dryRun: false }, rec.run);
    const before = rec.calls.length; // the Java probe only
    const declined = await executePlan(m, steps, { yes: false, dryRun: false }, { run: rec.run, log: (l) => lines.push(l), confirm: async (q) => (asked.push(q), false), tmp });
    assert.deepEqual([declined.declined, declined.ok, rec.calls.length - before], [true, false, 0]);
    assert.deepEqual(asked, ["Run these commands, including the sudo ones?"]);
    assert.ok(lines.some((l) => /Nothing was changed\./.test(l)));

    const dry = recorder();
    const dryRes = await executePlan(m, buildPlan(m, { yes: false, dryRun: true }, dry.run), { yes: false, dryRun: true }, { run: dry.run, log: () => {}, confirm: async () => (asked.push("dry"), true), tmp });
    assert.equal(dryRes.ok, true);
    assert.ok(!asked.includes("dry"), "a dry run does not ask");
  });

  test("the sudo steps run with sudo and the rest never do (the runner is told which)", () => {
    const sudoCmds = buildPlan(machine(), { yes: true, dryRun: true }, recorder().run).flatMap((s) => s.sudo.map((c) => display(c)));
    assert.ok(sudoCmds.every((c) => /^(apt-get|install|systemctl|dnf)\b/.test(c)), sudoCmds.join("\n"));
    const setup = src("src/envSetup/setup.ts");
    assert.ok(!/sudo:\s*true/.test(setup), "sudo is only ever a printed list; nothing user-space asks for it");
  });

  test("--only and --skip choose components; bad names and unknown options are refused with the list", () => {
    const ids = (o: any) => buildPlan(machine(), { yes: true, dryRun: true, ...o }, recorder().run).map((s) => s.id);
    assert.deepEqual(ids({ only: ["node", "python"] }), ["node", "python"]);
    assert.ok(!ids({ skip: ["android", "flutter"] }).some((i) => i === "android" || i === "flutter"));
    assert.deepEqual(parseSetupArgs(["--only", "node,python", "--yes", "--dry-run"]), { opts: { yes: true, dryRun: true, only: ["node", "python"] }, help: false });
    assert.deepEqual(parseSetupArgs(["--skip=flutter"]).opts.skip, ["flutter"]);
    assert.match(parseSetupArgs(["--only", "node,rm"]).error!, /comma-separated list of: system, node, python, playwright, android, flutter, security, shell/);
    assert.match(parseSetupArgs(["--wat"]).error!, /unknown option/);
    assert.equal(parseSetupArgs(["-h"]).help, true);
    assert.equal(COMPONENTS.length, 8);
  });

  test("a component that fails does not stop the others, and the summary says which", async () => {
    const m = machine();
    const lines: string[] = [];
    const steps = buildPlan(m, { yes: true, dryRun: false, only: ["node", "shell"] }, recorder().run);
    const failing = (async () => {
      throw new Error("no network");
    }) as any;
    const res = await executePlan(m, steps, { yes: true, dryRun: false }, { run: recorder().run, fetcher: failing, log: (l) => lines.push(l), tmp });
    assert.deepEqual([res.ok, res.failed], [false, ["node"]]);
    assert.ok(fs.existsSync(path.join(home, ".config", "yimpim", "machine.json")), "the shell step still ran");
    assert.ok(lines.some((l) => /1 component\(s\) did not finish: node\. .*safe to repeat/.test(l)));
  });

  test("the unattended-upgrades files: no automatic reboot, the timer at 04:00, installed root-owned through sudo", () => {
    assert.match(UNATTENDED_CONF, /Unattended-Upgrade::Automatic-Reboot "false";/);
    assert.equal(TIMER_DROPIN, "[Timer]\nOnCalendar=\nOnCalendar=*-*-* 04:00\nRandomizedDelaySec=0\n");
    const cmds = securityCommands("/tmp/a", "/tmp/b").map((c) => display(c, true));
    assert.deepEqual(cmds, [
      "sudo install -m 0644 -o root -g root /tmp/a /etc/apt/apt.conf.d/52yimpim-unattended",
      "sudo install -d -m 0755 /etc/systemd/system/apt-daily-upgrade.timer.d",
      "sudo install -m 0644 -o root -g root /tmp/b /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf",
      "sudo systemctl daemon-reload",
      "sudo systemctl restart apt-daily-upgrade.timer",
    ]);
  });

  test("only Debian and Ubuntu get unattended-upgrades; RHEL is told what to use; macOS gets nothing; Windows and others are refused", async () => {
    const sec = (m: MachineInfo) => buildPlan(m, { yes: true, dryRun: true, only: ["security"] }, recorder().run);
    assert.equal(sec(machine())[0].sudo.length, 6);
    assert.match(sec(machine({ family: "rhel" }))[0].title, /dnf-automatic/);
    assert.deepEqual(sec(machine({ platform: "darwin", family: "macos" })), []);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      assert.equal(await runSetupEnv(["--yes"], { argv: ["node", "y", "setup-env"], env: {}, tty: true, machine: machine({ platform: "win32", family: "windows" }), run: recorder().run }), 1);
    } finally {
      console.error = orig;
    }
    assert.match(errs.join("\n"), /On Windows use WSL2/);
  });
});

// ======================================================================================================== the vendors' data

describe("reading what each vendor publishes (no version or checksum is written into the program)", () => {
  const H = (c: string) => c.repeat(64);
  const fnmRelease = { tag_name: "v1", assets: [{ name: "fnm-linux.zip", browser_download_url: "https://github.com/x/fnm-linux.zip", digest: `sha256:${H("a")}` }, { name: "fnm-arm64.zip", browser_download_url: "https://github.com/x/fnm-arm64.zip", digest: `sha256:${H("b")}` }, { name: "fnm-macos.zip", browser_download_url: "https://github.com/x/fnm-macos.zip", digest: `sha256:${H("c")}` }, { name: "fnm-windows.zip", browser_download_url: "u" }] };

  test("fnm: the build for this platform and architecture, with GitHub's published SHA-256; none without a digest", () => {
    assert.deepEqual(pickFnmAsset(fnmRelease, { platform: "linux", arch: "x64" }), { name: "fnm-linux.zip", url: "https://github.com/x/fnm-linux.zip", sha256: H("a") });
    assert.equal(pickFnmAsset(fnmRelease, { platform: "linux", arch: "arm64" })!.name, "fnm-arm64.zip");
    assert.equal(pickFnmAsset(fnmRelease, { platform: "darwin", arch: "arm64" })!.name, "fnm-macos.zip");
    assert.equal(pickFnmAsset(fnmRelease, { platform: "win32", arch: "x64" }), undefined);
    assert.equal(pickFnmAsset({ assets: [{ name: "fnm-linux.zip", browser_download_url: "u" }] }, { platform: "linux", arch: "x64" }), undefined, "no published checksum: fail closed");
    assert.equal(pickFnmAsset(fnmRelease, { platform: "linux", arch: "ia32" }), undefined);
  });

  test("uv: the archive and its .sha256 file for this host", () => {
    const rel = { assets: ["uv-x86_64-unknown-linux-gnu.tar.gz", "uv-x86_64-unknown-linux-gnu.tar.gz.sha256", "uv-aarch64-apple-darwin.tar.gz", "uv-aarch64-apple-darwin.tar.gz.sha256"].map((n) => ({ name: n, browser_download_url: `https://github.com/u/${n}` })) };
    assert.equal(pickUvAssets(rel, { platform: "linux", arch: "x64" })!.checksum.name, "uv-x86_64-unknown-linux-gnu.tar.gz.sha256");
    assert.equal(pickUvAssets(rel, { platform: "darwin", arch: "arm64" })!.archive.name, "uv-aarch64-apple-darwin.tar.gz");
    assert.equal(pickUvAssets(rel, { platform: "linux", arch: "arm64" }), undefined);
    assert.equal(pickUvAssets({ assets: rel.assets.filter((a) => !a.name.endsWith(".sha256")) }, { platform: "linux", arch: "x64" }), undefined, "no checksum file: nothing");
  });

  const xml = `<?xml version="1.0"?><repo>
    <remotePackage path="cmdline-tools;1.0"><archives><archive><complete><checksum>${"1".repeat(40)}</checksum><url>commandlinetools-linux-9999_latest.zip</url></complete><host-os>linux</host-os></archive></archives></remotePackage>
    <remotePackage path="cmdline-tools;latest"><archives>
      <archive><complete><size>1</size><checksum>${"a".repeat(40)}</checksum><url>commandlinetools-linux-11076708_latest.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>1</size><checksum>${"B".repeat(40)}</checksum><url>commandlinetools-linux-16111833_latest.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>1</size><checksum>${"c".repeat(40)}</checksum><url>commandlinetools-mac_x86_64-16111833_latest.zip</url></complete><host-os>macosx</host-os><host-bits>64</host-bits></archive>
      <archive><complete><size>1</size><checksum>${"d".repeat(40)}</checksum><url>commandlinetools-win-16111833_latest.zip</url></complete><host-os>windows</host-os></archive>
    </archives></remotePackage></repo>`;
  test("Android: the newest cmdline-tools archive for this host, from the 'latest' package only, with the checksum Google publishes (SHA-1)", () => {
    assert.deepEqual(parseAndroidRepository(xml, { platform: "linux" }), { url: "commandlinetools-linux-16111833_latest.zip", checksum: "b".repeat(40), build: 16111833 });
    assert.equal(parseAndroidRepository(xml, { platform: "darwin" })!.url, "commandlinetools-mac_x86_64-16111833_latest.zip");
    assert.equal(parseAndroidRepository(xml, { platform: "win32" }), undefined);
    assert.equal(parseAndroidRepository("<repo/>", { platform: "linux" }), undefined);
    assert.equal(digestAlgorithm(parseAndroidRepository(xml, { platform: "linux" })!.checksum), "sha1");
  });

  const list = `Available Packages:
  Path                                  | Version | Description
  -------                               | ------- | -------
  build-tools;35.0.0                    | 35.0.0  | Android SDK Build-Tools 35
  build-tools;36.0.0                    | 36.0.0  | Android SDK Build-Tools 36
  build-tools;36.0.0-rc1                | 36.0.0  | preview
  build-tools;36.1.0                    | 36.1.0  | Android SDK Build-Tools 36.1
  build-tools;37.0.0                    | 37.0.0  | Android SDK Build-Tools 37
  platforms;android-35                  | 2       | Android SDK Platform 35
  platforms;android-36                  | 2       | Android SDK Platform 36
  platforms;android-36-ext18            | 1       | extension
  platforms;android-Baklava             | 1       | preview
  platforms;android-37.0                | 1       | preview
  system-images;android-36;google_apis;x86_64          | 1 | Google APIs Intel x86_64
  system-images;android-36;google_apis;arm64-v8a       | 1 | Google APIs ARM 64
  system-images;android-35;google_apis_playstore;x86_64 | 1 | Play`;
  test("Android: the highest stable platform (never an -ext or preview), the build-tools of the same major, and the host's own system image", () => {
    assert.deepEqual(chooseSdkPackages(list), { platform: "platforms;android-36", buildTools: "build-tools;36.1.0" });
    assert.deepEqual(chooseSdkPackages(list, "x86_64"), { platform: "platforms;android-36", buildTools: "build-tools;36.1.0", systemImage: "system-images;android-36;google_apis;x86_64" });
    assert.equal(chooseSdkPackages(list, "arm64-v8a").systemImage, "system-images;android-36;google_apis;arm64-v8a");
    assert.deepEqual(chooseSdkPackages("nothing useful here"), {});
    assert.ok(compareVersions("36.1.0", "36.0.0") > 0 && compareVersions("9.0.0", "10.0.0") < 0);
  });

  const flutter = { base_url: "https://storage.googleapis.com/flutter_infra_release/releases", current_release: { stable: "h1" }, releases: [
    { hash: "h1", channel: "stable", version: "9.9.9", dart_sdk_arch: "x64", archive: "stable/linux/flutter_linux_9.9.9-stable.tar.xz", sha256: H("e") },
    { hash: "h1", channel: "stable", version: "9.9.9", dart_sdk_arch: "arm64", archive: "stable/linux/flutter_linux_arm64_9.9.9-stable.tar.xz", sha256: H("f") },
    { hash: "h0", channel: "stable", version: "9.9.8", dart_sdk_arch: "x64", archive: "stable/linux/old.tar.xz", sha256: H("0") },
    { hash: "h1", channel: "beta", version: "x", dart_sdk_arch: "x64", archive: "beta/x.tar.xz", sha256: H("9") },
  ] };
  test("Flutter: the current stable release for this architecture, with its SHA-256; none without one", () => {
    assert.deepEqual(pickFlutterRelease(flutter, { arch: "x64" }), { version: "9.9.9", url: "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_9.9.9-stable.tar.xz", sha256: H("e"), kind: "tar.xz" });
    assert.equal(pickFlutterRelease(flutter, { arch: "arm64" })!.sha256, H("f"));
    assert.equal(pickFlutterRelease({ ...flutter, releases: [{ ...flutter.releases[0], sha256: "short" }] }, { arch: "x64" }), undefined);
    assert.equal(pickFlutterRelease({ ...flutter, current_release: {} }, { arch: "x64" }), undefined);
    assert.match(flutterReleasesUrl({ platform: "linux" })!, /releases_linux\.json$/);
    assert.match(flutterReleasesUrl({ platform: "darwin" })!, /releases_macos\.json$/);
    assert.equal(flutterReleasesUrl({ platform: "win32" }), undefined);
  });
});

// ======================================================================================================== machine, files

describe("detecting the machine, and writing files safely", () => {
  test("os-release, the family, the architecture and /dev/kvm are read at run time", () => {
    const u = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"');
    assert.deepEqual([u.id, u.idLike, u.versionId, u.name], ["ubuntu", ["debian"], "24.04", "Ubuntu 24.04 LTS"]);
    assert.equal(familyOf("linux", u), "debian");
    assert.equal(familyOf("linux", parseOsRelease("ID=fedora")), "rhel");
    assert.equal(familyOf("linux", parseOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"')), "rhel");
    assert.equal(familyOf("linux", parseOsRelease("ID=alpine")), "other");
    assert.equal(familyOf("darwin"), "macos");
    const m = detectMachine({ platform: "linux", arch: "arm64", osReleaseText: "ID=debian", kvm: { present: false, accessible: false }, uid: 1000, home: "/home/u" });
    assert.deepEqual([m.arch, m.family, m.kvm.present, m.isRoot, m.home], ["arm64", "debian", false, false, "/home/u"]);
    assert.equal(detectMachine({ platform: "linux", osReleaseText: "ID=ubuntu", kvm: { present: true, accessible: true }, uid: 0 }).isRoot, true);
  });

  test("the marked block is in the startup file exactly once however often it runs, the file's other content is untouched, and a new file is created only when there is none", () => {
    const once = upsertRcBlock("export A=1\n");
    assert.equal(upsertRcBlock(once), once);
    assert.equal((upsertRcBlock(upsertRcBlock(once)).match(/yimpim setup-env >>>/g) ?? []).length, 1);
    assert.ok(once.startsWith("export A=1\n"));
    fs.writeFileSync(path.join(home, ".zshrc"), "alias x=y");
    const touched = applyShellEnv(home, { node: true });
    assert.deepEqual(touched.map((t) => path.basename(t)), [".zshrc"], "only a startup file that exists");
    assert.equal(fs.existsSync(path.join(home, ".bashrc")), false);
    applyShellEnv(home, { node: true });
    assert.equal((fs.readFileSync(path.join(home, ".zshrc"), "utf8").match(/yimpim setup-env >>>/g) ?? []).length, 1);
    assert.ok(fs.readFileSync(path.join(home, ".zshrc"), "utf8").startsWith("alias x=y\n"));
  });

  test("env.sh has lines only for what is installed, and never a value from the network", () => {
    const none = renderEnvSh({});
    assert.ok(!/fnm|ANDROID|flutter|JAVA_HOME/.test(none.replace(/\n# Managed.*\n/, "")));
    const all = renderEnvSh({ node: true, uv: true, android: true, flutter: true, javaHome: "/usr/lib/jvm/java-21-openjdk-amd64" });
    assert.match(all, /export JAVA_HOME="\/usr\/lib\/jvm\/java-21-openjdk-amd64"/);
    assert.match(all, /export ANDROID_HOME="\$HOME\/sdks\/android"/);
    assert.match(all, /export PATH="\$HOME\/sdks\/flutter\/bin:\$PATH"/);
  });

  test("an atomic write: the mode is exact, a failed rename leaves no temporary file, and the old content survives a failed write", () => {
    const f = path.join(tmp, "a", "env.sh");
    writeFileAtomic(f, "one\n", 0o600);
    writeFileAtomic(f, "two\n", 0o600);
    assert.equal(fs.readFileSync(f, "utf8"), "two\n");
    if (posix) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ["env.sh"]);
    const dirTarget = path.join(tmp, "isdir");
    fs.mkdirSync(dirTarget);
    assert.throws(() => writeFileAtomic(dirTarget, "x", 0o600));
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp")), []);
  });
});

// ======================================================================================================== Flutter on ARM64 Linux (no official archive exists)

describe("Flutter on ARM64 Linux: no arm64 archive is published, so the stable commit Flutter publishes is fetched and verified", () => {
  const HASH = "ae9b586f34a8443573f82ef57c3bf914a908cbf7";
  // The real releases JSON has x64 entries only (177) and some with no architecture field: nothing for arm64.
  const releases = { base_url: "https://storage.googleapis.com/flutter_infra_release/releases", current_release: { stable: HASH }, releases: [{ hash: HASH, channel: "stable", version: "3.50.1", dart_sdk_arch: "x64", archive: "stable/linux/flutter_linux_3.50.1-stable.tar.xz", sha256: "e".repeat(64) }] };
  const fetcher = (async (url: string) => ({ ok: true, status: 200, url, text: async () => JSON.stringify(releases) })) as any;

  test("the published data has no arm64 archive, but names the stable commit and its version", async () => {
    const { pickFlutterRelease, flutterStableHash, flutterStableVersion } = await import("../src/envSetup/vendor.js");
    assert.equal(pickFlutterRelease(releases, { arch: "arm64" }), undefined);
    assert.equal(flutterStableHash(releases), HASH);
    assert.equal(flutterStableVersion(releases), "3.50.1");
    assert.equal(flutterStableHash({ current_release: { stable: "not-a-hash" } }), undefined);
    assert.equal(flutterStableVersion({ current_release: { stable: HASH }, releases: [{ ...releases.releases[0], version: "1.0; rm -rf /" }] }), undefined, "a version that is not a plain tag name is refused");
  });

  const runFlutter = async (rev: string) => {
    const m = machine({ arch: "arm64" });
    const lines: string[] = [];
    const rec = recorder((c) => (c.args.includes("rev-parse") ? { status: 0, stdout: `${rev}\n` } : { status: 0 }));
    const steps = buildPlan(m, { yes: true, dryRun: false, only: ["flutter"] }, rec.run);
    const before = rec.calls.length; // the plan's own package probe is not part of the run
    const res = await executePlan(m, steps, { yes: true, dryRun: false }, { run: rec.run, fetcher, log: (l) => lines.push(l), tmp });
    return { res, lines, calls: rec.calls.slice(before).map((c) => [c.cmd.bin === "git" ? c.cmd.bin : c.cmd.bin, ...(c.cmd.bin === "git" ? c.cmd.args.slice(2) : c.cmd.args)].join(" ")) };
  };

  test("the right commit: fetched from Flutter's own repository by the stable tag, verified, and moved into ~/sdks/flutter", async () => {
    const { res, lines, calls } = await runFlutter(HASH);
    assert.equal(res.ok, true, lines.join("\n"));
    assert.deepEqual(calls.slice(0, 5), ["git init -q", "git remote add origin https://github.com/flutter/flutter.git", "git fetch --depth 1 origin tag 3.50.1", "git checkout -q 3.50.1", "git rev-parse HEAD"]);
    assert.ok(fs.existsSync(path.join(home, "sdks", "flutter")));
    assert.ok(lines.some((l) => /commit ae9b586f34a8 matches the stable commit Flutter publishes \(no arm64 archive exists\)/.test(l)));
    assert.ok(calls.some((c) => /flutter config --no-analytics$/.test(c)) && calls.some((c) => /flutter precache --web --android$/.test(c)));
  });

  test("a different commit than the one published: refused, nothing is installed, and any earlier SDK is left alone", async () => {
    fs.mkdirSync(path.join(home, "sdks", "flutter"), { recursive: true });
    fs.writeFileSync(path.join(home, "sdks", "flutter", "keep.txt"), "the earlier SDK");
    const { res, lines } = await runFlutter("0".repeat(40));
    assert.deepEqual([res.ok, res.failed], [false, ["flutter"]]);
    assert.ok(lines.some((l) => /returned commit 000000000000, not the stable commit ae9b586f34a8 its releases list publishes\. It was not installed\./.test(l)));
    assert.equal(fs.readFileSync(path.join(home, "sdks", "flutter", "keep.txt"), "utf8"), "the earlier SDK");
  });

  test("the repository is a fixed URL in the program; nothing from the network can change where it is fetched from, and x64 still uses the verified archive", () => {
    const setup = src("src/envSetup/setup.ts");
    assert.ok(setup.includes('export const FLUTTER_REPO = "https://github.com/flutter/flutter.git";'));
    assert.equal((setup.match(/FLUTTER_REPO/g) ?? []).length, 4, "declared, shown in the plan, used to add the remote, and recorded");
    assert.ok(setup.includes('m.platform === "linux" && m.arch === "arm64" ? flutterStableHash(releases) : undefined'), "only on ARM64 Linux");
    assert.ok(setup.includes("if (picked) {"), "a build with a published checksum always takes the archive route");
  });
});
