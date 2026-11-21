/**
 * `yimpim setup-env`: one command that installs the toolchains a new machine needs to build across code bases and platforms. A person runs it; nothing else may.
 *
 * What it does, and the rules it keeps:
 *  - OS packages come only from the OS's signed package manager (apt-get, dnf, brew), through `sudo`, and the EXACT sudo commands are printed and confirmed first (unless --yes).
 *  - Everything else (fnm, uv, the Android SDK, Flutter, Playwright's browsers) is installed as the current user under $HOME, never as root, from the vendor's own host, and only
 *    extracted after its checksum matches the one the vendor published (see download.ts).
 *  - No shell: every program is started with an argument array (exec.ts). No version and no checksum is written into this file; each comes from the vendor's published data.
 *  - Environment exports go in ~/.config/yimpim/env.sh (0600), sourced from the shell's startup file by a marked block that is replaced, not repeated.
 */
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { type Cmd, type Runner, display, ok, realRunner } from "./exec.js";
import { YES_NO_ENTER_NO } from "../promptStyle.js";
import { type MachineInfo, type MachineRecord, androidAbi, emulatorUsable, detectMachine, localBin, sdksDir } from "./machine.js";
import { ALLOWED_HOSTS, type Fetcher, downloadTo, extractVerified, fetchJson, fetchText, parseSha256Sum } from "./download.js";
import { chooseSdkPackages, flutterReleasesUrl, flutterStableHash, flutterStableVersion, parseAndroidRepository, pickFlutterRelease, pickFnmAsset, pickUvAssets, type FlutterReleases, type GithubRelease } from "./vendor.js";
import { AAPT2_PATH, applyGradleOverride, applyShellEnv, gradleOverrideFor, writeMachineRecord } from "./shellEnv.js";

export const COMPONENTS = ["system", "node", "python", "playwright", "android", "flutter", "security", "shell"] as const;
export type Component = (typeof COMPONENTS)[number];

export interface SetupOptions {
  yes: boolean;
  dryRun: boolean;
  only?: Component[];
  skip?: Component[];
}

export interface Ctx {
  machine: MachineInfo;
  run: Runner;
  fetcher?: Fetcher;
  log: (line: string) => void;
  /** A scratch folder for downloads, removed at the end. */
  tmp: string;
  /** What has been verified and installed so far (written to the machine record). */
  record: { artifacts: MachineRecord["artifacts"]; installed: Record<string, string> };
}

export interface PlanStep {
  id: Component;
  title: string;
  /** Commands run through sudo: printed and confirmed before anything runs. */
  sudo: Cmd[];
  /** Things that will ask for sudo by themselves (Playwright's OS libraries): shown with the rest. */
  sudoNotes: string[];
  /** Plain lines on what runs as the user. */
  userLines: string[];
  /** Files that a sudo command installs, shown with their exact contents (the plan prints what will be written, not a placeholder). */
  showFiles?: { dest: string; content: string }[];
  run?: (ctx: Ctx) => Promise<void>;
}

const sep = process.platform === "win32" ? ";" : ":";

/** The environment a downloaded tool's installer runs with: what it needs, and nothing secret (no API keys, tokens or credentials from the person's shell). */
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.HOME = home;
  env.PATH = `${localBin(home)}${sep}${process.env.PATH ?? ""}`;
  return { ...env, ...extra };
}

const fnmDir = (home: string) => path.join(home, ".local", "share", "fnm");
const androidRoot = (home: string) => path.join(sdksDir(home), "android");
const flutterDir = (home: string) => path.join(sdksDir(home), "flutter");

/** A directory this program is about to replace must be inside the person's own home sdks or .local: never anything else. */
function assertOwnDir(home: string, dir: string): void {
  const r = path.resolve(dir);
  const allowed = [path.resolve(sdksDir(home)), path.resolve(home, ".local")];
  if (!allowed.some((a) => r === a || r.startsWith(a + path.sep)) || r === path.resolve(home)) throw new Error(`refusing to replace ${r}: it is outside ${allowed.join(" and ")}`);
}

function replaceDir(home: string, from: string, to: string): void {
  assertOwnDir(home, to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const old = `${to}.old-${Date.now()}`;
  if (fs.existsSync(to)) fs.renameSync(to, old);
  fs.renameSync(from, to);
  fs.rmSync(old, { recursive: true, force: true });
}

function installBinary(from: string, destDir: string, name: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destDir, `.${name}.${process.pid}.tmp`);
  fs.copyFileSync(from, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, path.join(destDir, name));
}

function note(ctx: Ctx, name: string, url: string, v: { algorithm: string; digest: string; sha256: string }): void {
  ctx.record.artifacts.push({ name, url, algorithm: v.algorithm, digest: v.digest, sha256: v.sha256 });
  ctx.log(`  ✓ ${name}: ${v.algorithm.toUpperCase()} matches the vendor's published checksum`);
}

function must(ctx: Ctx, cmd: Cmd, opts: { env?: NodeJS.ProcessEnv; input?: string; inherit?: boolean } = {}): string {
  const r = ctx.run(cmd, { ...opts, timeoutMs: 1_800_000 });
  if (!ok(r)) throw new Error(`${display(cmd)} failed${r.stderr ? `: ${r.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300)}` : r.error ? `: ${r.error}` : ""}`);
  return r.stdout;
}

// ------------------------------------------------------------------------------------------------------------------------ the plan

/** The OS package for the Java LTS to install, found by asking the package manager which exists. */
export function javaPackage(m: MachineInfo, run: Runner): string | undefined {
  const tries = m.family === "debian" ? ["openjdk-21-jdk", "openjdk-17-jdk"] : m.family === "rhel" ? ["java-21-openjdk-devel", "java-17-openjdk-devel"] : m.family === "macos" ? ["openjdk@21", "openjdk@17"] : [];
  for (const p of tries) {
    const probe = m.family === "debian" ? { bin: "apt-cache", args: ["show", p] } : m.family === "rhel" ? { bin: "dnf", args: ["-q", "list", "--available", p] } : { bin: "brew", args: ["info", "--json=v2", p] };
    if (ok(run(probe))) return p;
  }
  return undefined;
}

export function systemPackages(m: MachineInfo, java: string | undefined): string[] {
  if (m.family === "debian") return ["ca-certificates", "git", "unzip", "xz-utils", "build-essential", ...(java ? [java] : []), ...(gradleOverrideFor(m) ? ["aapt"] : [])];
  if (m.family === "rhel") return ["ca-certificates", "git", "unzip", "xz", "gcc", "gcc-c++", "make", ...(java ? [java] : [])];
  if (m.family === "macos") return ["git", "xz", ...(java ? [java] : [])];
  return [];
}

export function systemCommands(m: MachineInfo, pkgs: string[]): { sudo: Cmd[]; user: Cmd[] } {
  if (pkgs.length === 0) return { sudo: [], user: [] };
  if (m.family === "debian") return { sudo: [{ bin: "apt-get", args: ["update"] }, { bin: "apt-get", args: ["install", "-y", "--no-install-recommends", ...pkgs] }], user: [] };
  if (m.family === "rhel") return { sudo: [{ bin: "dnf", args: ["install", "-y", ...pkgs] }], user: [] };
  if (m.family === "macos") return { sudo: [], user: [{ bin: "brew", args: ["install", ...pkgs] }] };
  return { sudo: [], user: [] };
}

/** The unattended-upgrades setup for Debian and Ubuntu: no automatic reboot (an overnight build is never killed) and the upgrade timer at 04:00. */
export const UNATTENDED_CONF = ['Unattended-Upgrade::Automatic-Reboot "false";', 'APT::Periodic::Update-Package-Lists "1";', 'APT::Periodic::Unattended-Upgrade "1";', ""].join("\n");
export const TIMER_DROPIN = ["[Timer]", "OnCalendar=", "OnCalendar=*-*-* 04:00", "RandomizedDelaySec=0", ""].join("\n");
export const UNATTENDED_CONF_PATH = "/etc/apt/apt.conf.d/52yimpim-unattended";
export const TIMER_DIR = "/etc/systemd/system/apt-daily-upgrade.timer.d";
export const TIMER_DROPIN_PATH = `${TIMER_DIR}/override.conf`;

export function securityCommands(tmpConf: string, tmpTimer: string): Cmd[] {
  return [
    { bin: "install", args: ["-m", "0644", "-o", "root", "-g", "root", tmpConf, UNATTENDED_CONF_PATH] },
    { bin: "install", args: ["-d", "-m", "0755", TIMER_DIR] },
    { bin: "install", args: ["-m", "0644", "-o", "root", "-g", "root", tmpTimer, TIMER_DROPIN_PATH] },
    { bin: "systemctl", args: ["daemon-reload"] },
    { bin: "systemctl", args: ["restart", "apt-daily-upgrade.timer"] },
  ];
}

export function buildPlan(machine: MachineInfo, opts: SetupOptions, run: Runner): PlanStep[] {
  const wanted = (c: Component) => (opts.only ? opts.only.includes(c) : true) && !(opts.skip ?? []).includes(c);
  const steps: PlanStep[] = [];
  const home = machine.home;
  const javaPkg = javaPackage(machine, run);

  if (wanted("system")) {
    const pkgs = systemPackages(machine, javaPkg);
    const cmds = systemCommands(machine, pkgs);
    steps.push({
      id: "system",
      title: `OS packages (${machine.family}): ${pkgs.join(", ") || "none for this system"}`,
      sudo: cmds.sudo,
      sudoNotes: [],
      userLines: cmds.user.map((c) => display(c)),
      run: async (ctx) => {
        if (machine.family === "other" || pkgs.length === 0) throw new Error(`this system's package manager is not supported: install ${["git", "unzip", "xz", "a JDK 17 or 21"].join(", ")} yourself`);
        for (const c of cmds.sudo) must(ctx, c, { inherit: true });
        for (const c of cmds.user) must(ctx, c, { inherit: true });
        if (!javaPkg) ctx.log("  ~ no OpenJDK 21 or 17 package was found: install a JDK before building for Android");
      },
    });
  }

  if (wanted("node")) {
    steps.push({
      id: "node",
      title: "Node.js: fnm (checksum-verified release binary), the current LTS Node, Corepack (pnpm, yarn) and eas-cli, in your home",
      sudo: [],
      sudoNotes: [],
      userLines: [`download the fnm release for ${machine.platform}/${machine.arch} from GitHub, verify its SHA-256, install to ${path.join(localBin(home), "fnm")}`, "fnm install --lts; fnm default lts-latest; corepack enable; npm install -g eas-cli"],
      run: async (ctx) => installNode(ctx),
    });
  }

  if (wanted("python")) {
    steps.push({
      id: "python",
      title: "Python: uv (checksum-verified release archive) and its latest managed Python, in your home",
      sudo: [],
      sudoNotes: [],
      userLines: [`download uv for ${machine.platform}/${machine.arch} from GitHub, verify its published SHA-256, install to ${localBin(home)}`, "uv python install"],
      run: async (ctx) => installUv(ctx),
    });
  }

  if (wanted("playwright")) {
    steps.push({
      id: "playwright",
      title: "Playwright: Chromium for headless web and Expo web QA",
      sudo: [],
      sudoNotes: machine.platform === "linux" ? ["npx playwright install --with-deps chromium   (Playwright asks for sudo itself to install the browser's OS libraries)"] : [],
      userLines: ["npx --yes playwright install " + (machine.platform === "linux" ? "--with-deps " : "") + "chromium"],
      run: async (ctx) => installPlaywright(ctx),
    });
  }

  if (wanted("android")) {
    const emulator = emulatorUsable(machine);
    steps.push({
      id: "android",
      title: `Android SDK: command-line tools from Google (verified), newest platform-tools, platform and build-tools${emulator ? ", the emulator and a system image" : "; NO emulator (no usable /dev/kvm): QA will use Expo web and unit tests"}`,
      sudo: [],
      sudoNotes: [],
      userLines: [`resolve the newest cmdline-tools from dl.google.com's repository XML, verify its checksum, install to ${path.join(androidRoot(home), "cmdline-tools", "latest")}`, "sdkmanager --licenses; sdkmanager platform-tools <newest platform> <matching build-tools>" + (emulator ? ` emulator <${androidAbi(machine)} system image>` : "")],
      run: async (ctx) => installAndroid(ctx, emulator, javaPkg !== undefined),
    });
  }

  if (wanted("flutter")) {
    steps.push({
      id: "flutter",
      title:
        machine.platform === "linux" && machine.arch === "arm64"
          ? "Flutter: the current stable SDK, fetched from Flutter's repository at the exact commit Flutter publishes as stable (Flutter publishes no Linux arm64 archive), web and Android support precached"
          : "Flutter: the current stable SDK from Google's releases (SHA-256 verified), web and Android support precached",
      sudo: [],
      sudoNotes: [],
      userLines: [
        machine.platform === "linux" && machine.arch === "arm64"
          ? `fetch the stable tag from ${FLUTTER_REPO}, refuse unless its commit equals the one Flutter's releases list publishes as stable, then install to ${flutterDir(home)}`
          : `resolve the stable release for ${machine.arch} from Flutter's releases JSON, verify its SHA-256, extract to ${flutterDir(home)}`,
        "flutter config --no-analytics; flutter precache --web --android; flutter doctor --android-licenses",
      ],
      run: async (ctx) => installFlutter(ctx),
    });
  }

  if (wanted("security") && machine.family === "debian") {
    steps.push({
      id: "security",
      title: "Unattended upgrades: no automatic reboot, upgrade timer at 04:00",
      sudo: [{ bin: "apt-get", args: ["install", "-y", "unattended-upgrades"] }, ...securityCommands("<the text shown below>", "<the text shown below>")],
      sudoNotes: [],
      userLines: [],
      showFiles: [
        { dest: UNATTENDED_CONF_PATH, content: UNATTENDED_CONF },
        { dest: TIMER_DROPIN_PATH, content: TIMER_DROPIN },
      ],
      run: async (ctx) => {
        must(ctx, { bin: "apt-get", args: ["install", "-y", "unattended-upgrades"] }, { inherit: true });
        const conf = path.join(ctx.tmp, "52yimpim-unattended");
        const timer = path.join(ctx.tmp, "override.conf");
        fs.writeFileSync(conf, UNATTENDED_CONF, { mode: 0o644 });
        fs.writeFileSync(timer, TIMER_DROPIN, { mode: 0o644 });
        for (const c of securityCommands(conf, timer)) must(ctx, c);
      },
    });
  } else if (wanted("security") && machine.platform === "linux") {
    steps.push({ id: "security", title: "Unattended upgrades: not set up (only Debian and Ubuntu are handled; use dnf-automatic on RHEL and Fedora)", sudo: [], sudoNotes: [], userLines: [] });
  }

  if (wanted("shell")) {
    steps.push({
      id: "shell",
      title: `Environment: ~/.config/yimpim/env.sh (0600), a marked block in your shell startup file${gradleOverrideFor(machine) ? ", and the ARM64 aapt2 Gradle override" : ""}, and ~/.config/yimpim/machine.json`,
      sudo: [],
      sudoNotes: [],
      userLines: [],
      run: async (ctx) => finishEnvironment(ctx, emulatorUsable(machine)),
    });
  }
  return steps;
}

// ------------------------------------------------------------------------------------------------------------------------ the components

async function installNode(ctx: Ctx): Promise<void> {
  const m = ctx.machine;
  const release = await fetchJson<GithubRelease>("https://api.github.com/repos/Schniz/fnm/releases/latest", ctx.fetcher);
  const asset = pickFnmAsset(release, m);
  if (!asset) throw new Error(`fnm publishes no checksum-verified build for ${m.platform}/${m.arch}; nothing was installed`);
  const archive = path.join(ctx.tmp, asset.name);
  await downloadTo(asset.url, archive, ctx.fetcher);
  const out = path.join(ctx.tmp, "fnm-x");
  const v = extractVerified(ctx.run, archive, asset.sha256, out, "zip");
  note(ctx, asset.name, asset.url, v);
  installBinary(path.join(out, "fnm"), localBin(m.home), "fnm");
  const env = cleanEnv(m.home, { FNM_DIR: fnmDir(m.home) });
  const fnm: string = path.join(localBin(m.home), "fnm");
  must(ctx, { bin: fnm, args: ["install", "--lts"] }, { env, inherit: true });
  must(ctx, { bin: fnm, args: ["default", "lts-latest"] }, { env });
  const inNode = (args: string[]) => must(ctx, { bin: fnm, args: ["exec", "--using=default", ...args] }, { env, inherit: true });
  if (!ok(ctx.run({ bin: fnm, args: ["exec", "--using=default", "corepack", "--version"] }, { env }))) inNode(["npm", "install", "-g", "corepack"]);
  inNode(["corepack", "enable"]);
  inNode(["npm", "install", "-g", "eas-cli"]);
  ctx.record.installed.node = must(ctx, { bin: fnm, args: ["exec", "--using=default", "node", "--version"] }, { env }).trim();
}

async function installUv(ctx: Ctx): Promise<void> {
  const m = ctx.machine;
  const release = await fetchJson<GithubRelease>("https://api.github.com/repos/astral-sh/uv/releases/latest", ctx.fetcher);
  const picked = pickUvAssets(release, m);
  if (!picked) throw new Error(`uv publishes no archive with a checksum file for ${m.platform}/${m.arch}; nothing was installed`);
  const expected = parseSha256Sum(await fetchText(picked.checksum.url, ctx.fetcher), picked.archive.name);
  if (!expected) throw new Error(`uv's checksum file does not list ${picked.archive.name}; nothing was installed`);
  const archive = path.join(ctx.tmp, picked.archive.name);
  await downloadTo(picked.archive.url, archive, ctx.fetcher);
  const out = path.join(ctx.tmp, "uv-x");
  const v = extractVerified(ctx.run, archive, expected, out, "tar.gz");
  note(ctx, picked.archive.name, picked.archive.url, v);
  const inner = fs.readdirSync(out).find((d) => d.startsWith("uv-")) ?? "";
  for (const b of ["uv", "uvx"]) installBinary(path.join(out, inner, b), localBin(m.home), b);
  const uv = path.join(localBin(m.home), "uv");
  const env = cleanEnv(m.home);
  must(ctx, { bin: uv, args: ["python", "install"] }, { env, inherit: true });
  ctx.record.installed.uv = must(ctx, { bin: uv, args: ["--version"] }, { env }).trim();
}

async function installPlaywright(ctx: Ctx): Promise<void> {
  const m = ctx.machine;
  const fnm = path.join(localBin(m.home), "fnm");
  if (!fs.existsSync(fnm)) throw new Error("Node.js is not installed yet (Playwright needs it): run the node component first");
  const env = cleanEnv(m.home, { FNM_DIR: fnmDir(m.home) });
  must(ctx, { bin: fnm, args: ["exec", "--using=default", "npx", "--yes", "playwright", "install", ...(m.platform === "linux" ? ["--with-deps"] : []), "chromium"] }, { env, inherit: true });
}

async function installAndroid(ctx: Ctx, emulator: boolean, haveJava: boolean): Promise<void> {
  const m = ctx.machine;
  if (!haveJava && !ok(ctx.run({ bin: "java", args: ["-version"] }))) throw new Error("no Java is installed: the Android SDK tools need it (run the system component, or install a JDK)");
  const xml = await fetchText("https://dl.google.com/android/repository/repository2-1.xml", ctx.fetcher);
  const found = parseAndroidRepository(xml, m);
  if (!found) throw new Error(`Google's repository lists no command-line tools for ${m.platform}; nothing was installed`);
  const url = `https://dl.google.com/android/repository/${found.url}`;
  const archive = path.join(ctx.tmp, found.url);
  await downloadTo(url, archive, ctx.fetcher);
  const out = path.join(ctx.tmp, "android-x");
  const v = extractVerified(ctx.run, archive, found.checksum, out, "zip");
  note(ctx, found.url, url, v);
  const root = androidRoot(m.home);
  replaceDir(m.home, path.join(out, "cmdline-tools"), path.join(root, "cmdline-tools", "latest"));
  const sdkmanager = path.join(root, "cmdline-tools", "latest", "bin", "sdkmanager");
  const env = cleanEnv(m.home, { ANDROID_HOME: root, ANDROID_SDK_ROOT: root });
  const base = [`--sdk_root=${root}`];
  must(ctx, { bin: sdkmanager, args: [...base, "--licenses"] }, { env, input: "y\n".repeat(80) });
  const listing = must(ctx, { bin: sdkmanager, args: [...base, "--list"] }, { env });
  const choice = chooseSdkPackages(listing, emulator ? androidAbi(m) : undefined);
  const pkgs = ["platform-tools", ...(choice.platform ? [choice.platform] : []), ...(choice.buildTools ? [choice.buildTools] : []), ...(emulator ? ["emulator", ...(choice.systemImage ? [choice.systemImage] : [])] : [])];
  must(ctx, { bin: sdkmanager, args: [...base, ...pkgs] }, { env, inherit: true });
  ctx.record.installed.android = pkgs.join(", ");
}

/**
 * ARM64 Linux: Flutter's repository, fetched at the one commit its releases JSON publishes as stable (git's commit id is a hash of the whole tree), into a scratch folder, and only moved
 * into place after `git rev-parse HEAD` equals that commit. The URL is Flutter's own, fixed in this program; nothing from the network decides where it is fetched from.
 */
export const FLUTTER_REPO = "https://github.com/flutter/flutter.git";
function fetchFlutterAtCommit(ctx: Ctx, hash: string, version: string): void {
  const dir = path.join(ctx.tmp, "flutter-git");
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => must(ctx, { bin: "git", args: ["-C", dir, ...args] }, { env: cleanEnv(ctx.machine.home), inherit: args[0] === "fetch" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", FLUTTER_REPO]);
  // The release's own tag is fetched (so Flutter knows its version), then the commit it points at is checked against the one the vendor publishes.
  git(["fetch", "--depth", "1", "origin", "tag", version]);
  git(["checkout", "-q", version]);
  const got = git(["rev-parse", "HEAD"]).trim().toLowerCase();
  if (got !== hash) throw new Error(`Flutter's repository returned commit ${got.slice(0, 12)}, not the stable commit ${hash.slice(0, 12)} its releases list publishes. It was not installed.`);
  ctx.log(`  ✓ flutter: commit ${hash.slice(0, 12)} matches the stable commit Flutter publishes (no arm64 archive exists)`);
  ctx.record.artifacts.push({ name: `flutter@${hash}`, url: FLUTTER_REPO, algorithm: "git commit", digest: hash, sha256: "" });
  replaceDir(ctx.machine.home, dir, flutterDir(ctx.machine.home));
}

async function installFlutter(ctx: Ctx): Promise<void> {
  const m = ctx.machine;
  const url = flutterReleasesUrl(m);
  if (!url) throw new Error(`Flutter publishes no release list for ${m.platform}`);
  const releases = await fetchJson<FlutterReleases>(url, ctx.fetcher);
  const picked = pickFlutterRelease(releases, m);
  let version: string;
  if (picked) {
    const archive = path.join(ctx.tmp, path.basename(picked.url));
    await downloadTo(picked.url, archive, ctx.fetcher);
    const out = path.join(ctx.tmp, "flutter-x");
    const v = extractVerified(ctx.run, archive, picked.sha256, out, picked.kind);
    note(ctx, path.basename(picked.url), picked.url, v);
    replaceDir(m.home, path.join(out, "flutter"), flutterDir(m.home));
    version = picked.version;
  } else {
    // Flutter publishes no Linux arm64 archive. Fetch its repository at the exact commit it publishes as stable, and refuse unless that is the commit received.
    const hash = m.platform === "linux" && m.arch === "arm64" ? flutterStableHash(releases) : undefined;
    const tag = flutterStableVersion(releases);
    if (!hash || !tag) throw new Error(`Flutter's stable release has no SHA-256-verified build for ${m.arch}; nothing was installed`);
    fetchFlutterAtCommit(ctx, hash, tag);
    version = `${tag} (commit ${hash.slice(0, 10)})`;
  }
  const flutter = path.join(flutterDir(m.home), "bin", "flutter");
  const env = cleanEnv(m.home, { ANDROID_HOME: androidRoot(m.home), ANDROID_SDK_ROOT: androidRoot(m.home) });
  must(ctx, { bin: flutter, args: ["config", "--no-analytics"] }, { env });
  must(ctx, { bin: flutter, args: ["precache", "--web", "--android"] }, { env, inherit: true });
  ctx.run({ bin: flutter, args: ["doctor", "--android-licenses"] }, { env, input: "y\n".repeat(80), timeoutMs: 600_000 });
  ctx.record.installed.flutter = version;
}


function findJavaHome(m: MachineInfo, run: Runner): string | undefined {
  if (m.platform === "darwin") {
    for (const p of ["openjdk@21", "openjdk@17"]) {
      const r = run({ bin: "brew", args: ["--prefix", p] });
      const home = ok(r) ? path.join(r.stdout.trim(), "libexec", "openjdk.jdk", "Contents", "Home") : "";
      if (home && fs.existsSync(home)) return home;
    }
    return undefined;
  }
  try {
    const dir = "/usr/lib/jvm";
    const names = fs.readdirSync(dir).filter((n) => /^(java-(21|17)-openjdk|temurin-(21|17))/.test(n)).sort().reverse();
    return names.length > 0 ? path.join(dir, names[0]) : undefined;
  } catch {
    return undefined;
  }
}

async function finishEnvironment(ctx: Ctx, emulator: boolean): Promise<void> {
  const m = ctx.machine;
  const javaHome = findJavaHome(m, ctx.run);
  if (gradleOverrideFor(m)) {
    if (fs.existsSync(AAPT2_PATH)) ctx.log(`  ✓ Gradle: ${applyGradleOverride(m.home, m)} (${AAPT2_PATH}) in ~/.gradle/gradle.properties`);
    else ctx.log(`  ~ ${AAPT2_PATH} is not installed, so the ARM64 Gradle override was not written: install the OS aapt package, then run this again`);
  }
  const touched = applyShellEnv(m.home, {
    node: fs.existsSync(path.join(localBin(m.home), "fnm")),
    uv: fs.existsSync(path.join(localBin(m.home), "uv")),
    android: fs.existsSync(path.join(androidRoot(m.home), "cmdline-tools", "latest", "bin", "sdkmanager")),
    flutter: fs.existsSync(path.join(flutterDir(m.home), "bin", "flutter")),
    javaHome,
  });
  ctx.log(`  ✓ ~/.config/yimpim/env.sh written (0600); sourced from ${touched.map((t) => path.basename(t)).join(", ")}`);
  const headless = !emulator;
  writeMachineRecord(m.home, {
    schema: 1,
    platform: m.platform,
    arch: m.arch,
    ...(m.distro?.name ? { distro: m.distro.name } : {}),
    kvm: m.kvm,
    headlessWebQaOnly: headless,
    ...(javaHome ? { javaHome } : {}),
    installed: ctx.record.installed,
    artifacts: ctx.record.artifacts,
    updatedAt: new Date().toISOString(),
  });
  ctx.log(`  ✓ ~/.config/yimpim/machine.json written (0600)${headless ? ": headlessWebQaOnly = true (no emulator here; QA uses Expo web and unit tests)" : ""}`);
}

// ------------------------------------------------------------------------------------------------------------------------ running it

export function formatPlan(steps: PlanStep[]): string[] {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(`• ${s.title}`);
    for (const c of s.sudo) lines.push(`    ${display(c, true)}`);
    for (const n of s.sudoNotes) lines.push(`    ${n}`);
    for (const u of s.userLines) lines.push(`    (as you) ${u}`);
    for (const f of s.showFiles ?? []) {
      lines.push(`    ${f.dest} will contain exactly:`);
      for (const l of f.content.replace(/\n$/, "").split("\n")) lines.push(`      | ${l}`);
    }
  }
  return lines;
}

export const confirmOnTerminal = (question: string): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // the shared yes/no suffix (promptStyle.ts): Enter means no, which is the safe answer here
    rl.question(`${question} ${YES_NO_ENTER_NO}: `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });

export interface ExecuteDeps {
  run?: Runner;
  fetcher?: Fetcher;
  log?: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  tmp?: string;
}

export async function executePlan(machine: MachineInfo, steps: PlanStep[], opts: SetupOptions, deps: ExecuteDeps = {}): Promise<{ ok: boolean; failed: string[]; declined: boolean }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const needsSudo = steps.some((s) => s.sudo.length > 0 || s.sudoNotes.length > 0);
  log("");
  log("This will set up the following on this machine:");
  for (const l of formatPlan(steps)) log(l);
  log("");
  if (needsSudo) log("The commands marked sudo above are the ONLY things that run with elevated rights. Everything else runs as you, inside your home folder.");
  if (opts.dryRun) {
    log("Dry run: nothing was changed.");
    return { ok: true, failed: [], declined: false };
  }
  if (needsSudo && !opts.yes) {
    const yes = await (deps.confirm ?? confirmOnTerminal)("Run these commands, including the sudo ones?");
    if (!yes) {
      log("Nothing was changed.");
      return { ok: false, failed: [], declined: true };
    }
  }
  const tmp = deps.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), "yimpim-setup-"));
  fs.chmodSync(tmp, 0o700);
  const ctx: Ctx = { machine, run: deps.run ?? realRunner, fetcher: deps.fetcher, log, tmp, record: { artifacts: [], installed: {} } };
  const failed: string[] = [];
  try {
    for (const s of steps) {
      if (!s.run) {
        log(`\n— ${s.title}`);
        continue;
      }
      if (s.id === "playwright" && failed.includes("node")) {
        log(`\n— ${s.title}\n  ✗ skipped: Node.js did not install`);
        failed.push(s.id);
        continue;
      }
      log(`\n— ${s.title}`);
      try {
        await s.run(ctx);
      } catch (e: any) {
        failed.push(s.id);
        log(`  ✗ ${String(e?.message ?? e).slice(0, 400)}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log("");
  log(failed.length === 0 ? "✓ Done. Open a new terminal (or run: . ~/.config/yimpim/env.sh) and then run: yimpim doctor" : `✗ ${failed.length} component(s) did not finish: ${failed.join(", ")}. Run yimpim doctor for what is missing, then run this again (it is safe to repeat).`);
  return { ok: failed.length === 0, failed, declined: false };
}

// ------------------------------------------------------------------------------------------------------------------------ who may run it

/**
 * setup-env installs software and may use sudo, so it runs only when a PERSON typed it: from the CLI entry point (`yimpim setup-env`), not under an agent, and with a terminal to confirm on
 * (or --yes, which only a person at a command line passes). Anything else is refused. It is not a tool, a slash command or a roadmap step, and agent commands run with
 * YIMPIM_AGENT_CONTEXT set.
 */
export function assertNotAgent(argv: string[], env: NodeJS.ProcessEnv): void {
  if (argv[2] !== "setup-env") throw new Error("setup-env can only be started from the command line: `yimpim setup-env`");
  if (env.YIMPIM_AGENT_CONTEXT) throw new Error("setup-env is for a person to run; it cannot be started from an agent");
}

export function assertInteractive(opts: { yes: boolean; tty: boolean; isRoot: boolean }): void {
  if (!opts.tty && !opts.yes) throw new Error("setup-env needs a terminal to ask for confirmation (or --yes, passed by the person running it)");
  if (opts.isRoot) throw new Error("run setup-env as your normal user, not root: it installs into your home folder and asks for sudo only for OS packages");
}

export function assertHumanInvocation(argv: string[], env: NodeJS.ProcessEnv, opts: { yes: boolean; tty: boolean; isRoot: boolean }): void {
  assertNotAgent(argv, env);
  assertInteractive(opts);
}

export function parseSetupArgs(args: string[]): { opts: SetupOptions; help: boolean; error?: string } {
  const opts: SetupOptions = { yes: false, dryRun: false };
  let help = false;
  const list = (v: string | undefined): Component[] | undefined => {
    const parts = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return parts.every((p) => (COMPONENTS as readonly string[]).includes(p)) ? (parts as Component[]) : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = (flag: string) => (a === flag ? args[++i] : a.slice(flag.length + 1));
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--only" || a.startsWith("--only=")) {
      const l = list(val("--only"));
      if (!l) return { opts, help, error: `--only takes a comma-separated list of: ${COMPONENTS.join(", ")}` };
      opts.only = l;
    } else if (a === "--skip" || a.startsWith("--skip=")) {
      const l = list(val("--skip"));
      if (!l) return { opts, help, error: `--skip takes a comma-separated list of: ${COMPONENTS.join(", ")}` };
      opts.skip = l;
    } else if (a !== "setup-env") return { opts, help, error: `unknown option: ${a}` };
  }
  return { opts, help };
}

export const SETUP_HELP = `
yimpim setup-env — install the toolchains a new machine needs, in one go

  yimpim setup-env [--dry-run] [--yes] [--only a,b] [--skip a,b]

Components: ${COMPONENTS.join(", ")}
  system      OS packages (git, unzip, a JDK, build tools; aapt on ARM64) via apt-get, dnf or brew
  node        fnm, the current LTS Node, Corepack (pnpm, yarn), eas-cli
  python      uv and its latest managed Python
  playwright  Chromium for headless web and Expo web QA
  android     Android SDK (command-line tools, platform-tools, newest platform and build-tools; emulator only with a usable /dev/kvm)
  flutter     the current stable Flutter SDK
  security    Debian/Ubuntu unattended upgrades: no automatic reboot, timer at 04:00
  shell       ~/.config/yimpim/env.sh, your shell startup file, machine.json

  --dry-run   show exactly what would run (including every sudo command) and change nothing
  --yes       do not ask for confirmation (you are running this yourself, from a command line)

Run it as your normal user. Downloads come only from the vendors' own hosts (${[...ALLOWED_HOSTS].join(", ")}) and are extracted only after their published checksum matches.
It is safe to run again. Check the result with: yimpim doctor
`;

export async function runSetupEnv(args: string[], deps: ExecuteDeps & { argv?: string[]; env?: NodeJS.ProcessEnv; tty?: boolean; machine?: MachineInfo } = {}): Promise<number> {
  const parsed = parseSetupArgs(args);
  if (parsed.help) {
    console.log(SETUP_HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`${parsed.error}\n${SETUP_HELP}`);
    return 2;
  }
  const machine = deps.machine ?? detectMachine();
  try {
    assertNotAgent(deps.argv ?? process.argv, deps.env ?? process.env); // first: nothing else is said to, or done for, an agent
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
  if (machine.family === "windows" || machine.family === "other") {
    console.error(`✗ setup-env supports Debian/Ubuntu, RHEL/Fedora and macOS. On ${machine.platform === "win32" ? "Windows use WSL2 (Ubuntu), then run it there" : "this system"}.`);
    return 1;
  }
  try {
    assertInteractive({ yes: parsed.opts.yes, tty: deps.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY), isRoot: machine.isRoot });
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
  console.log(`Machine: ${machine.distro?.name ?? machine.platform} (${machine.family}), ${machine.arch}, /dev/kvm: ${machine.kvm.present ? (machine.kvm.accessible ? "usable" : "present but not accessible") : "absent"}`);
  const steps = buildPlan(machine, parsed.opts, deps.run ?? realRunner);
  const res = await executePlan(machine, steps, parsed.opts, deps);
  return res.ok ? 0 : res.declined ? 1 : 1;
}
