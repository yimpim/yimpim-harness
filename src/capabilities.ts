/**
 * Environment capability probing.
 *
 * Every probe answers "can I actually do this here?" without throwing.
 * The verifier consults this before attempting any gate, so a missing tool
 * becomes a recorded degradation rather than a verification failure.
 */

import { execFileSync } from "child_process";
import fsSync from "fs";
import path from "path";
import process from "process";
import type { ProjectProfile } from "./projectProfile.js";

export interface Capability {
  available: boolean;
  /** Absolute path / invocable name when available. */
  bin?: string;
  detail: string;
}

/**
 * Shared selection logic for probeAndroidDevice/probeIOSSimulator: pick a
 * specific candidate by id when one's configured, otherwise the first in
 * whatever order the OS reported them, flagging when that pick was actually
 * ambiguous (more than one candidate existed). Pulled out as pure, id-based
 * logic — independent of adb/xcrun — specifically so it's unit-testable
 * without a real attached device or simulator.
 */
export function chooseDevice<T extends { id: string }>(
  candidates: T[],
  preferredId?: string
): { chosen: T; ambiguous: boolean } | "not_found" | undefined {
  if (candidates.length === 0) return undefined;
  if (preferredId) {
    const match = candidates.find((c) => c.id === preferredId);
    return match ? { chosen: match, ambiguous: false } : "not_found";
  }
  return { chosen: candidates[0], ambiguous: candidates.length > 1 };
}

const UNAVAILABLE = (detail: string): Capability => ({ available: false, detail });

export interface Capabilities {
  git: Capability;
  java: Capability;
  gradleWrapper: Capability;
  adb: Capability;
  androidDevice: Capability;
  xcodebuild: Capability;
  iosSimulator: Capability;
  flutter: Capability;
  dotnet: Capability;
  go: Capability;
  cargo: Capability;
  pio: Capability;
  arduinoCli: Capability;
  idf: Capability;
  node: Capability;
  npm: Capability;
  python: Capability;
  playwright: Capability;
  browser: Capability;
  display: Capability;
  screenCapture: Capability;
}

/** Cross-platform `which`, quiet on failure. */
export function which(bin: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, [bin], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/** Try several binary names, return the first that resolves. */
function whichAny(names: string[]): { name: string; bin: string } | null {
  for (const name of names) {
    const bin = which(name);
    if (bin) return { name, bin };
  }
  return null;
}

function probeSimple(names: string[], label: string): Capability {
  const hit = whichAny(names);
  if (hit) return { available: true, bin: hit.bin, detail: `${label} found at ${hit.bin}` };
  return UNAVAILABLE(`${label} not on PATH (tried: ${names.join(", ")})`);
}

/**
 * Resolve a binary that must actually RUN, not merely exist on PATH.
 * Windows ships a `python3.exe` App Execution Alias that is present, resolves
 * via `where`, and then exits 9009 with "Python was not found". Treating that
 * as a working interpreter turns a missing tool into a phantom build failure.
 */
function probeRunnable(names: string[], versionArgs: string[], label: string): Capability {
  const tried: string[] = [];
  for (const name of names) {
    const bin = which(name);
    if (!bin) continue;
    tried.push(bin);
    try {
      const out = execFileSync(bin, versionArgs, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      const version = (out || "").trim().split(/\r?\n/)[0] || "unknown version";
      return { available: true, bin, detail: `${label} at ${bin} (${version})` };
    } catch {
      // Present but non-functional (store alias, broken shim, wrong arch).
    }
  }
  if (tried.length > 0) {
    return UNAVAILABLE(`${label} resolved to ${tried.join(", ")} but none could execute (likely a stub or broken shim)`);
  }
  return UNAVAILABLE(`${label} not on PATH (tried: ${names.join(", ")})`);
}

/** Resolve adb from PATH, then from the standard Android SDK env vars. */
function probeAdb(): Capability {
  const onPath = which("adb");
  if (onPath) return { available: true, bin: onPath, detail: `adb found at ${onPath}` };

  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    process.env.HOME ? path.join(process.env.HOME, "Android", "Sdk") : undefined,
    process.env.HOME ? path.join(process.env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const root of sdkRoots) {
    const candidate = path.join(root, "platform-tools", exe);
    if (fsSync.existsSync(candidate)) {
      return { available: true, bin: candidate, detail: `adb found in Android SDK at ${candidate}` };
    }
  }
  return UNAVAILABLE("adb not on PATH and no Android SDK found via ANDROID_HOME/ANDROID_SDK_ROOT");
}

/** A device counts only if it is present AND fully booted. When more than
 *  one is attached (a physical device plus an emulator is common), the OS
 *  order they're listed in is otherwise arbitrary — `preferredSerial` (from
 *  config.verification.androidDeviceSerial) lets a project pin exactly
 *  which one gets verified instead of silently taking whichever is first. */
export function probeAndroidDevice(adb: Capability, preferredSerial?: string): Capability {
  if (!adb.available || !adb.bin) return UNAVAILABLE("adb unavailable, cannot enumerate devices");
  try {
    const out = execFileSync(adb.bin, ["devices"], { encoding: "utf-8", timeout: 15000 });
    const ready = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /\bdevice$/.test(l));

    const candidates = ready.map((line) => ({ id: line.split(/\s+/)[0], line }));
    const pick = chooseDevice(candidates, preferredSerial);
    if (pick === undefined) {
      return UNAVAILABLE("no booted Android device or emulator is attached");
    }
    if (pick === "not_found") {
      return UNAVAILABLE(
        `configured device "${preferredSerial}" is not among the attached, booted devices (${candidates.length} other one(s) attached)`
      );
    }
    const ambiguityNote = pick.ambiguous
      ? ` (${candidates.length} devices attached — picked arbitrarily; set verification.androidDeviceSerial to pin one)`
      : "";
    const serial = pick.chosen.id;

    try {
      const booted = execFileSync(adb.bin, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        encoding: "utf-8",
        timeout: 15000,
      }).trim();
      if (booted !== "1") {
        return UNAVAILABLE(`device ${serial} is attached but still booting`);
      }
    } catch {
      return UNAVAILABLE(`device ${serial} is attached but not responding to shell`);
    }

    return { available: true, bin: serial, detail: `device ${serial} attached and booted${ambiguityNote}` };
  } catch (err: any) {
    return UNAVAILABLE(`adb devices failed: ${err.message}`);
  }
}

/**
 * Xcode only exists on macOS — full stop, no PATH trick or install fixes
 * that on Windows or Linux. Saying so directly beats a generic "not found",
 * which reads as fixable when it is a hardware/OS constraint instead.
 */
function probeXcodebuild(): Capability {
  if (process.platform !== "darwin") {
    return UNAVAILABLE("iOS builds require macOS — Xcode is not available on this platform");
  }
  const onPath = which("xcodebuild");
  if (!onPath) return UNAVAILABLE("xcodebuild not found — install Xcode from the App Store");
  return { available: true, bin: onPath, detail: `xcodebuild found at ${onPath}` };
}

/** A simulator counts only if one is actually booted, mirroring the Android
 *  device check — this never boots one itself, since that is slow and the
 *  operator's choice, same reasoning as not auto-starting an emulator.
 *  `preferredUdid` (from config.verification.iosSimulatorUdid) pins which
 *  one gets verified when more than one happens to be booted at once. */
function probeIOSSimulator(xcodebuild: Capability, preferredUdid?: string): Capability {
  if (!xcodebuild.available) return UNAVAILABLE("xcodebuild unavailable, cannot query simulators");
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    const parsed = JSON.parse(out);
    const booted: { udid: string; name: string }[] = Object.values(parsed.devices ?? {})
      .flat()
      .filter((d: any) => d.state === "Booted") as any;
    if (booted.length === 0) {
      return UNAVAILABLE("no booted iOS Simulator — open Simulator.app or run: xcrun simctl boot <name>");
    }

    const candidates = booted.map((d) => ({ id: d.udid, name: d.name }));
    const pick = chooseDevice(candidates, preferredUdid);
    if (pick === "not_found") {
      return UNAVAILABLE(
        `configured simulator "${preferredUdid}" is not among the booted simulators (${candidates.length} other one(s) booted)`
      );
    }
    // pick can't be undefined here — booted.length === 0 already returned above.
    const { chosen, ambiguous } = pick as { chosen: { id: string; name: string }; ambiguous: boolean };
    const ambiguityNote = ambiguous
      ? ` (${candidates.length} simulators booted — picked arbitrarily; set verification.iosSimulatorUdid to pin one)`
      : "";

    return { available: true, bin: chosen.id, detail: `simulator "${chosen.name}" booted${ambiguityNote}` };
  } catch (err: any) {
    return UNAVAILABLE(`xcrun simctl failed: ${err.message}`);
  }
}

function probeFlutter(): Capability {
  return probeRunnable(["flutter"], ["--version"], "flutter");
}

function probeDotnet(): Capability {
  return probeRunnable(["dotnet"], ["--version"], "dotnet");
}

function probeGo(): Capability {
  return probeRunnable(["go"], ["version"], "go");
}

function probeCargo(): Capability {
  return probeRunnable(["cargo"], ["--version"], "cargo");
}

function probePio(): Capability {
  return probeRunnable(["pio", "platformio"], ["--version"], "PlatformIO");
}

function probeArduinoCli(): Capability {
  return probeRunnable(["arduino-cli"], ["version"], "arduino-cli");
}

function probeIdf(): Capability {
  return probeRunnable(["idf.py"], ["--version"], "ESP-IDF (idf.py)");
}

function probeGradleWrapper(repoRoot: string): Capability {
  const name = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapper = path.join(repoRoot, name);
  if (fsSync.existsSync(wrapper)) {
    return { available: true, bin: wrapper, detail: `gradle wrapper present (${name})` };
  }
  const gradle = which("gradle");
  if (gradle) return { available: true, bin: gradle, detail: `no wrapper, using system gradle at ${gradle}` };
  return UNAVAILABLE("no gradlew wrapper in repo and no gradle on PATH");
}

export function probeJava(): Capability {
  if (process.env.JAVA_HOME) {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const candidate = path.join(process.env.JAVA_HOME, "bin", exe);
    if (fsSync.existsSync(candidate)) {
      return { available: true, bin: process.env.JAVA_HOME, detail: `JAVA_HOME resolved to ${process.env.JAVA_HOME}` };
    }
  }
  const onPath = which("java");
  if (onPath) return { available: true, bin: onPath, detail: `java found at ${onPath}` };

  // Android Studio ships a JBR; look for it without hardcoding a user directory.
  const studioJbrs: string[] = [];
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    studioJbrs.push(path.join(pf, "Android", "Android Studio", "jbr"));
  } else if (process.platform === "darwin") {
    studioJbrs.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
  } else {
    studioJbrs.push("/opt/android-studio/jbr", "/usr/local/android-studio/jbr");
  }
  for (const jbr of studioJbrs) {
    if (fsSync.existsSync(jbr)) {
      return { available: true, bin: jbr, detail: `Android Studio JBR found at ${jbr}` };
    }
  }
  return UNAVAILABLE("no JDK found via JAVA_HOME, PATH, or an Android Studio install");
}

/**
 * Merges JAVA_HOME/PATH for a resolved Java capability into an env, so a
 * spawned command can find `java` even when it's only reachable via
 * probeJava's own JAVA_HOME/PATH/Android-Studio-JBR fallback chain — most
 * commonly a bundled JBR that was never added to the user's own PATH or
 * JAVA_HOME, which is the default for anyone who installed Java only
 * through Android Studio. `process.env` alone is not enough in that case;
 * this is what makes `gradlew` actually findable in the SPAWNED process.
 *
 * A no-op (returns a plain copy of `env`) when `java.bin` isn't set or
 * doesn't look like a JDK home — safe to call unconditionally for any
 * command, Java-dependent or not.
 */
export function javaAwareEnv(java: Capability, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  if (java.bin && fsSync.existsSync(path.join(java.bin, "bin"))) {
    merged.JAVA_HOME = java.bin;
    const sep = process.platform === "win32" ? ";" : ":";
    merged.PATH = `${path.join(java.bin, "bin")}${sep}${env.PATH ?? ""}`;
  }
  return merged;
}

/** Playwright is effectively optional here: absence must degrade, not crash. */
async function probePlaywright(): Promise<{ playwright: Capability; browser: Capability }> {
  let mod: any;
  try {
    mod = await import("playwright");
  } catch {
    return {
      playwright: UNAVAILABLE("playwright package is not installed"),
      browser: UNAVAILABLE("no playwright, so no managed browser"),
    };
  }

  const playwright: Capability = { available: true, detail: "playwright module loaded" };

  try {
    const exe: string = mod.chromium.executablePath();
    if (exe && fsSync.existsSync(exe)) {
      return { playwright, browser: { available: true, bin: exe, detail: `chromium binary at ${exe}` } };
    }
    return {
      playwright,
      browser: UNAVAILABLE("chromium browser not downloaded (run: npx playwright install chromium)"),
    };
  } catch (err: any) {
    return { playwright, browser: UNAVAILABLE(`chromium not resolvable: ${err.message}`) };
  }
}

/** Is there a desktop session we could screenshot at all? */
function probeDisplay(): Capability {
  if (process.platform === "win32" || process.platform === "darwin") {
    return { available: true, detail: `${process.platform} desktop session assumed present` };
  }
  if (process.env.DISPLAY) return { available: true, detail: `X11 DISPLAY=${process.env.DISPLAY}` };
  if (process.env.WAYLAND_DISPLAY) {
    return { available: true, detail: `Wayland WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}` };
  }
  return UNAVAILABLE("headless environment: no DISPLAY or WAYLAND_DISPLAY set");
}

/** A tool that can capture the desktop, for native/Python GUI apps. */
function probeScreenCapture(display: Capability): Capability {
  if (!display.available) return UNAVAILABLE("no display to capture");

  if (process.platform === "darwin") {
    const bin = which("screencapture");
    return bin
      ? { available: true, bin, detail: "macOS screencapture available" }
      : UNAVAILABLE("screencapture not found");
  }
  if (process.platform === "win32") {
    const bin = which("powershell") || which("pwsh");
    return bin
      ? { available: true, bin, detail: "PowerShell available for GDI screen capture" }
      : UNAVAILABLE("no powershell/pwsh for screen capture");
  }
  const hit = whichAny(["gnome-screenshot", "spectacle", "scrot", "import"]);
  return hit
    ? { available: true, bin: hit.bin, detail: `${hit.name} available for screen capture` }
    : UNAVAILABLE("no screenshot tool (tried gnome-screenshot, spectacle, scrot, import)");
}

/**
 * Windows batch shims (npm.cmd, yarn.cmd, gradlew.bat) cannot be spawned
 * directly: since the CVE-2024-27980 fix, Node throws EINVAL for .cmd/.bat
 * unless they are run through the command interpreter. Route them via
 * `cmd.exe /d /s /c` with an argv array so nothing is string-interpolated.
 */
export function winSafeCommand(bin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) {
    return { bin, args };
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  return { bin: comspec, args: ["/d", "/s", "/c", bin, ...args] };
}

const NOT_APPLICABLE = (why: string): Capability => ({ available: false, detail: `not applicable — ${why}` });

/**
 * Which capability keys are worth checking (and later showing) for a given
 * project. Android tooling and visual/browser tooling both do real, non-free
 * work to probe (shelling out to adb, waiting on a Playwright/Chromium
 * check) and are meaningless for a project that exposes neither surface —
 * probing them wastes time, and reporting them is pure noise: an "Android
 * Studio JBR found" line on a CLI project reads as this tool having gone
 * looking through your machine for something unrelated to what you're
 * building, not as useful information.
 */
function relevantKeys(profile?: import("./projectProfile.js").ProjectProfile): Set<keyof Capabilities> {
  const always: (keyof Capabilities)[] = ["git", "node", "npm", "python"];
  if (!profile) {
    return new Set([
      ...always, "java", "gradleWrapper", "adb", "androidDevice",
      "xcodebuild", "iosSimulator", "flutter", "dotnet", "go", "cargo", "pio", "arduinoCli", "idf",
      "playwright", "browser", "display", "screenCapture",
    ]);
  }

  const keys = new Set<keyof Capabilities>(always);
  // Android and iOS are checked independently — a hybrid Flutter/React
  // Native project can have both native folders present at once.
  if (profile.stacks.includes("android")) {
    keys.add("java").add("gradleWrapper").add("adb").add("androidDevice");
  }
  if (profile.stacks.includes("ios")) {
    keys.add("xcodebuild").add("iosSimulator");
  }
  if (profile.stacks.includes("flutter")) {
    keys.add("flutter");
    if (profile.flutter?.hasAndroid) keys.add("java").add("gradleWrapper").add("adb").add("androidDevice");
    if (profile.flutter?.hasIOS) keys.add("xcodebuild").add("iosSimulator");
  }
  if (profile.stacks.includes("react-native")) {
    if (profile.reactNative?.hasAndroid) keys.add("java").add("adb").add("androidDevice");
    if (profile.reactNative?.hasIOS) keys.add("xcodebuild").add("iosSimulator");
  }
  if (profile.stacks.includes("dotnet")) keys.add("dotnet");
  if (profile.stacks.includes("go")) keys.add("go");
  if (profile.stacks.includes("rust")) keys.add("cargo");
  if (profile.firmware?.framework === "platformio") keys.add("pio");
  if (profile.firmware?.framework === "arduino") keys.add("arduinoCli");
  if (profile.firmware?.framework === "esp-idf") keys.add("idf");
  if (
    profile.stacks.some((s) => s === "web" || s === "desktop" || s === "python-web" || s === "python-desktop") ||
    profile.dotnet?.isWeb ||
    profile.reactNative?.isExpo
  ) {
    keys.add("playwright").add("browser").add("display").add("screenCapture");
  }
  return keys;
}

export async function probeCapabilities(
  repoRoot: string,
  profile?: import("./projectProfile.js").ProjectProfile,
  /** Pins which attached device/simulator gets verified when more than one
   *  is available — from config.verification.androidDeviceSerial /
   *  iosSimulatorUdid. Omitted entirely by callers (e.g. `yimpim doctor`)
   *  that just want a general capability snapshot, not a specific target. */
  deviceOverrides?: { androidDeviceSerial?: string; iosSimulatorUdid?: string }
): Promise<Capabilities> {
  const want = relevantKeys(profile);

  const adb = want.has("adb") ? probeAdb() : NOT_APPLICABLE("no Android stack detected");
  const xcodebuild = want.has("xcodebuild") ? probeXcodebuild() : NOT_APPLICABLE("no iOS stack detected");
  const display = want.has("display")
    ? probeDisplay()
    : NOT_APPLICABLE("no visual UI stack detected");
  const { playwright, browser } = want.has("playwright")
    ? await probePlaywright()
    : { playwright: NOT_APPLICABLE("no visual UI stack detected"), browser: NOT_APPLICABLE("no visual UI stack detected") };

  return {
    git: probeRunnable(["git"], ["--version"], "git"),
    java: want.has("java") ? probeJava() : NOT_APPLICABLE("no Android stack detected"),
    gradleWrapper: want.has("gradleWrapper") ? probeGradleWrapper(repoRoot) : NOT_APPLICABLE("no Android stack detected"),
    adb,
    androidDevice: want.has("androidDevice")
      ? probeAndroidDevice(adb, deviceOverrides?.androidDeviceSerial)
      : NOT_APPLICABLE("no Android stack detected"),
    xcodebuild,
    iosSimulator: want.has("iosSimulator")
      ? probeIOSSimulator(xcodebuild, deviceOverrides?.iosSimulatorUdid)
      : NOT_APPLICABLE("no iOS stack detected"),
    flutter: want.has("flutter") ? probeFlutter() : NOT_APPLICABLE("no Flutter stack detected"),
    dotnet: want.has("dotnet") ? probeDotnet() : NOT_APPLICABLE("no .NET stack detected"),
    go: want.has("go") ? probeGo() : NOT_APPLICABLE("no Go stack detected"),
    cargo: want.has("cargo") ? probeCargo() : NOT_APPLICABLE("no Rust stack detected"),
    pio: want.has("pio") ? probePio() : NOT_APPLICABLE("no PlatformIO project detected"),
    arduinoCli: want.has("arduinoCli") ? probeArduinoCli() : NOT_APPLICABLE("no Arduino sketch detected"),
    idf: want.has("idf") ? probeIdf() : NOT_APPLICABLE("no ESP-IDF project detected"),
    node: probeRunnable(["node"], ["--version"], "node"),
    npm: probeSimple(["npm", "pnpm", "yarn"], "a node package manager"),
    python: probeRunnable(["python3", "python", "py"], ["--version"], "python"),
    playwright,
    browser,
    display,
    screenCapture: want.has("screenCapture") ? probeScreenCapture(display) : NOT_APPLICABLE("no visual UI stack detected"),
  };
}

/**
 * `profile` narrows what's shown to what's relevant to THIS project — a
 * capability the project has no use for is omitted rather than listed as a
 * confusing ✓/✗. Omit `profile` to see everything probed, unfiltered (used
 * by callers that check capabilities before a profile is known).
 */
export function describeCapabilities(caps: Capabilities, profile?: import("./projectProfile.js").ProjectProfile): string {
  const want = relevantKeys(profile);
  return Object.entries(caps)
    .filter(([k]) => want.has(k as keyof Capabilities))
    .map(([k, v]) => `  ${v.available ? "✓" : "✗"} ${k}: ${v.detail}`)
    .join("\n");
}
