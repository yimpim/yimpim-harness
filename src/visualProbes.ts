/**
 * Visual probes: capture runtime screenshots from whatever UI surface a project
 * happens to have — Android emulator, browser, or a native desktop window.
 *
 * Every probe returns a ProbeResult. None of them throw, and "unavailable" is a
 * normal, expected outcome that the verifier compensates for with static review.
 */

import { execFileSync, spawn, ChildProcess } from "child_process";
import { browserBackend } from "./qaBrowserAgent.js";
import { iosBackend } from "./qaIosBackend.js";
import type { BrowserQaResult, QaBackend, QaJudgeContext, ToolSpec } from "./qaBrowserAgent.js";
import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import http from "http";
import https from "https";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import { Capabilities, Capability, winSafeCommand } from "./capabilities.js";
import { DEFAULT_SAMPLE_PNG_BASE64, loadQaSetup, qaEnvFor, resolveRepoFile, writeFakeCameraFeed } from "./qaSetup.js";
import { AndroidProfile, IOSProfile, PythonProfile, ReactNativeProfile, WebProfile, findNewestApk, findNewestIOSApp } from "./projectProfile.js";

export interface VisualCapture {
  file: string;
  label: string;
}

export interface ProbeResult {
  status: "captured" | "unavailable" | "error";
  captures: VisualCapture[];
  /** Positive evidence of a runtime defect (crash trace, page error). */
  runtimeDefects: string[];
  detail: string;
  /** Set when the probe had to clear device storage before it could proceed
   *  (see freeEmulatorSpace) — surfaced so the report is honest about an
   *  environment intervention instead of silently masking it. */
  recoveryNote?: string;
  /** Set by browser surfaces when QA ran as an agent (see qaBrowserAgent.ts):
   *  a verdict per app state, which replaces the one-shot screenshot audit. */
  visualVerdict?: BrowserQaResult;
}

const unavailable = (detail: string): ProbeResult => ({
  status: "unavailable",
  captures: [],
  runtimeDefects: [],
  detail,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- Android

/** Width/height read straight from the PNG's own IHDR chunk — always matches
 *  the exact image a caller has in hand, no separate `wm size` call (and no
 *  risk of it disagreeing with the actual capture) needed. */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** One tappable-looking element found in a UI hierarchy dump, as a percentage
 *  of screen size so it is resolution-independent. */
export interface NavHint {
  label: string;
  xPercent: number;
  yPercent: number;
}

/** Pulls labeled elements (text or content-description) with their center
 *  point out of a `uiautomator dump` XML tree. This only ever sees whatever
 *  the platform's accessibility tree actually exposes — a custom-drawn
 *  Canvas UI with no semantics set on it will show up as nothing here, which
 *  is expected and fine: the caller falls back to reading the screenshot
 *  directly in that case, this is a precision aid when it's available, not
 *  a requirement. */
function summarizeUiHierarchy(xml: string, screenW: number, screenH: number, maxItems = 40): NavHint[] {
  const hints: NavHint[] = [];
  const nodeRe = /<node\b[^>]*\/>/g;
  const boundsRe = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;
  const textRe = /\btext="([^"]*)"/;
  const descRe = /\bcontent-desc="([^"]*)"/;
  const clickableRe = /\bclickable="true"/;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) && hints.length < maxItems) {
    const node = m[0];
    if (!clickableRe.test(node)) continue;
    const label = (textRe.exec(node)?.[1] || descRe.exec(node)?.[1] || "").trim();
    const b = boundsRe.exec(node);
    if (!label || !b) continue;
    const [x1, y1, x2, y2] = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
    if (screenW <= 0 || screenH <= 0) continue;
    hints.push({
      label,
      xPercent: (((x1 + x2) / 2) / screenW) * 100,
      yPercent: (((y1 + y2) / 2) / screenH) * 100,
    });
  }
  return hints;
}

/** What the caller (which owns the LLM call) decides after looking at one
 *  screenshot: this is the screen to verify, it's still mid-transition and
 *  needs more real time before it can be judged, or here's where to tap next. */
export interface NavStepDecision {
  arrived: boolean;
  /** True when the screen looks like it's still loading, animating, or
   *  otherwise mid-transition (a spinner, a progress bar, a "simulating…"
   *  screen) rather than settled — distinct from `arrived`/tap so the caller
   *  waits and looks again instead of judging or tapping a moving target.
   *  Ignored if `arrived` is also true. */
  waiting?: boolean;
  /** 0-100, present when arrived and waiting are both false. */
  tapXPercent?: number;
  tapYPercent?: number;
  reason: string;
}

export interface AndroidNavOptions {
  /** Called after the launch screenshot, and again after every tap. Return
   *  arrived:true to stop, or tap coordinates (0-100 each) to keep going. */
  decideNext: (args: { screenshotFile: string; stepIndex: number; hints: NavHint[] }) => Promise<NavStepDecision>;
  /** Hard cap regardless of what decideNext keeps asking for — a model that
   *  never says "arrived" must not wander the app forever. */
  maxSteps?: number;
  /** Run QA as an agent against the live screen once it is reached. Called
   *  only when this is set; the caller decides to start the agent only after a
   *  first check FAILED (see verifierTools judgeVisual). */
  judge?: (ctx: QaJudgeContext) => Promise<BrowserQaResult>;
}

/** Same shape as AndroidNavOptions — web reuses NavHint/NavStepDecision as-is
 *  (a click target is still "a labeled element at roughly this position"),
 *  so one nav-capable caller (verifierTools.ts) works unmodified for both. */
export type WebNavOptions = AndroidNavOptions;

function adbArgs(device: Capability, rest: string[]): string[] {
  return device.bin ? ["-s", device.bin, ...rest] : rest;
}

/** True when adb's own message says the device is out of room — distinct from
 *  every other install failure (a bad APK, an ABI mismatch, a genuine crash on
 *  install) so cleanup-and-retry only ever fires for the one case it actually
 *  fixes. INSTALL_FAILED_INSUFFICIENT_STORAGE is the documented Android error;
 *  the emulator sometimes instead surfaces the vague MEDIA_UNAVAILABLE or a
 *  bare ENOSPC from adb's own transfer, so all three are treated the same. */
export function isInsufficientStorageError(err: any): boolean {
  const text = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`;
  return /INSTALL_FAILED_INSUFFICIENT_STORAGE|INSTALL_FAILED_MEDIA_UNAVAILABLE|no space left on device|ENOSPC/i.test(
    text
  );
}

/**
 * Best-effort, non-destructive space recovery for an emulator/device that just
 * refused an install for lack of room. Every step here only ever removes
 * cache data or a stale copy of the exact app under test — never another
 * app's user data — so it is safe to run unconditionally whenever storage is
 * the actual blocker rather than a real defect to report.
 *
 * Uninstalling the package under test BEFORE reinstalling (instead of letting
 * `install -r` keep the old copy resident while it writes the new one) is the
 * single biggest win: a long QA session that reinstalls the same app dozens
 * of times over is the most common way an emulator's data partition actually
 * fills up, and `-r` needs roughly double the app's install size for the
 * brief window both copies coexist.
 *
 * Returns the human-readable list of what was actually attempted, so the
 * caller can report the recovery as evidence instead of silently masking it.
 */
function freeEmulatorSpace(adb: string, device: Capability, pkg: string): string[] {
  const attempted: string[] = [];
  const tryRun = (args: string[], label: string): void => {
    try {
      execFileSync(adb, adbArgs(device, args), {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      attempted.push(label);
    } catch {
      // Best-effort — a step that fails just means less space got freed,
      // never an error worth surfacing on its own.
    }
  };
  tryRun(["uninstall", pkg], `uninstalled the previous build of ${pkg}`);
  tryRun(["shell", "pm", "trim-caches", "1000000000"], "trimmed cached app data");
  tryRun(["shell", "rm", "-rf", "/data/local/tmp/*"], "cleared /data/local/tmp");
  return attempted;
}

export async function probeAndroid(
  profile: AndroidProfile,
  caps: Capabilities,
  screenshotDir: string,
  maxPolls = 3,
  nav?: AndroidNavOptions,
  /** Fired the instant each screenshot lands (launch polls and every
   *  navigation step alike), so a caller can stream them onward — e.g. to a
   *  paired phone — as navigation happens rather than only once this whole
   *  probe returns. */
  onCapture?: (file: string, label: string) => void
): Promise<ProbeResult> {
  if (!caps.adb.available || !caps.adb.bin) return unavailable(caps.adb.detail);
  if (!caps.androidDevice.available) return unavailable(caps.androidDevice.detail);
  if (!profile.applicationId) {
    return unavailable("could not resolve applicationId from the gradle module, cannot launch the app");
  }

  const adb = caps.adb.bin;
  const device = caps.androidDevice;
  const pkg = profile.applicationId;
  const captures: VisualCapture[] = [];

  const apk = findNewestApk(profile.apkOutputDir);
  if (!apk) return unavailable(`no APK found under ${profile.apkOutputDir}`);

  const run = (args: string[], timeout = 60000): string => {
    return execFileSync(adb, adbArgs(device, args), {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  };

  /** True when a FATAL EXCEPTION attributed to this package is now in the crash buffer. */
  const checkedForCrash = (): boolean => {
    try {
      const crash = run(["logcat", "-d", "-b", "crash"], 20000);
      if (crash.includes("FATAL EXCEPTION") && crash.includes(pkg)) {
        runtimeDefects.push(crash.trim().slice(-2000));
        return true;
      }
    } catch {}
    return false;
  };

  /** One screenshot to disk, falling back to the sdcard round-trip if
   *  exec-out fails. Does NOT add it to `captures` or notify `onCapture` —
   *  used for internal polling (e.g. waitForStableScreen below) where most
   *  frames taken are just "still settling" noise, not evidence worth
   *  keeping. Returns the path, or undefined on failure. */
  const captureRaw = async (): Promise<string | undefined> => {
    const file = path.join(screenshotDir, `android-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
    try {
      // exec-out avoids the /sdcard round-trip and scoped-storage restrictions.
      const png = execFileSync(adb, adbArgs(device, ["exec-out", "screencap", "-p"]), {
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      });
      await fs.writeFile(file, png);
      return file;
    } catch {
      try {
        run(["shell", "screencap", "-p", "/sdcard/yimpim-verify.png"], 30000);
        run(["pull", "/sdcard/yimpim-verify.png", file], 30000);
        return file;
      } catch {
        return undefined;
      }
    }
  };

  /** Promotes an already-captured file to real evidence: recorded in
   *  `captures` and streamed onward via `onCapture` (e.g. to a paired phone). */
  const recordCapture = (file: string, label: string): void => {
    captures.push({ file, label });
    onCapture?.(file, label);
  };

  /** One screenshot, recorded immediately as evidence. */
  const captureScreenshot = async (label: string): Promise<string | undefined> => {
    const file = await captureRaw();
    if (file) recordCapture(file, label);
    return file;
  };

  /**
   * Polls raw screenshots until two consecutive captures are byte-identical
   * — nothing observable is still moving, animating, or loading — or until
   * maxWaitMs elapses. Two screencaps of an unchanged framebuffer are
   * byte-identical (same encoder, same pixels), so this needs no image
   * decoding at all, and it needs zero knowledge of what this specific app
   * or game is doing: a race simulation, a level-load spinner, and a menu
   * transition all look the same from here — "still changing" or "settled".
   * Returns the last frame captured either way, plus whether it actually
   * settled, so a caller can tell "still changing when time ran out" apart
   * from a clean settle instead of silently judging a possibly mid-transition
   * frame.
   */
  const waitForStableScreen = async (
    pollMs = 700,
    maxWaitMs = 8000
  ): Promise<{ file: string | undefined; settled: boolean }> => {
    let prev = await captureRaw();
    if (!prev) return { file: undefined, settled: false };
    let prevBytes = await fs.readFile(prev);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await sleep(pollMs);
      const next = await captureRaw();
      if (!next) return { file: prev, settled: false };
      const nextBytes = await fs.readFile(next);
      if (nextBytes.equals(prevBytes)) return { file: next, settled: true };
      prev = next;
      prevBytes = nextBytes;
    }
    return { file: prev, settled: false };
  };

  /** Best-effort — a custom-drawn Canvas UI with no accessibility semantics
   *  will legitimately produce nothing here, and that is fine: the caller
   *  falls back to reading the screenshot directly. */
  const dumpHints = (screenshotFile: string): NavHint[] => {
    try {
      run(["shell", "uiautomator", "dump", "/sdcard/yimpim-ui-dump.xml"], 15000);
      const xml = run(["exec-out", "cat", "/sdcard/yimpim-ui-dump.xml"], 15000);
      const { width, height } = pngDimensions(fsSync.readFileSync(screenshotFile));
      return summarizeUiHierarchy(xml, width, height);
    } catch {
      return [];
    }
  };

  let recoveryNote: string | undefined;

  try {
    // Clear BOTH the main and crash buffers so stale traces cannot be mistaken
    // for a defect introduced by this change.
    try {
      run(["logcat", "-c"]);
      run(["logcat", "-b", "crash", "-c"]);
    } catch {}

    try {
      run(["install", "-r", "-t", apk], 120000);
    } catch (installErr: any) {
      // Insufficient storage is an environment problem the verifier can
      // actually fix, not evidence of a defect in this change — worth one
      // cleanup-and-retry before giving up on the whole probe over it.
      if (!isInsufficientStorageError(installErr)) throw installErr;
      const freed = freeEmulatorSpace(adb, device, pkg);
      recoveryNote =
        freed.length > 0
          ? `device reported insufficient storage during install; freed space (${freed.join(", ")}) and retried`
          : `device reported insufficient storage during install; cleanup found nothing safe to free`;
      console.log(`[QA] ${recoveryNote}`);
      // No -r this time: the previous build was just uninstalled above (or
      // never existed), so this is a plain fresh install, not a replace.
      run(["install", "-t", apk], 120000);
    }
    try {
      run(["shell", "am", "force-stop", pkg], 20000);
    } catch {}
    run(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], 30000);
  } catch (err: any) {
    // Storage that is STILL insufficient after cleanup is a device/emulator
    // capacity limit, not a defect this change introduced — reported as
    // unavailable (degrades to static review) rather than as a runtime error.
    if (isInsufficientStorageError(err)) {
      return unavailable(
        `emulator is out of storage even after clearing caches and uninstalling the previous build ` +
          `(the emulator's data partition may be undersized — check \`adb shell df /data\`): ${err.message}`
      );
    }
    return {
      status: "error",
      captures,
      runtimeDefects: [],
      detail: `install/launch could not complete: ${err.message}`,
      recoveryNote,
    };
  }

  const runtimeDefects: string[] = [];

  for (let poll = 1; poll <= maxPolls; poll++) {
    await sleep(poll === 1 ? 4000 : 2500);
    if (checkedForCrash()) break;
    const file = await captureScreenshot(`android launch poll ${poll}`);
    if (!file && captures.length === 0) {
      return {
        status: "error",
        captures,
        runtimeDefects,
        detail: `screenshot capture failed`,
      };
    }
  }

  // Navigate toward whatever screen the caller actually needs to verify,
  // instead of only ever judging whatever the app happens to land on at
  // cold launch. Bounded and best-effort: a model that can't find its way
  // (or a crash mid-navigation) just stops here, leaving every screenshot
  // taken along the way as evidence — including, honestly, that navigation
  // didn't reach the target.
  if (nav && runtimeDefects.length === 0 && captures.length > 0) {
    const maxSteps = nav.maxSteps ?? 5;
    // A model reporting "still loading" gets real extra look-again cycles
    // before this step gives up on it, so one slow-to-settle screen (a boss
    // intro cutscene, a long "simulating race" screen) doesn't just eat the
    // whole navigation budget waiting — but it IS still bounded, so a model
    // that never stops saying "waiting" can't stall forever either.
    const maxWaitCyclesPerStep = 3;

    for (let step = 0; step < maxSteps; step++) {
      let latest = captures[captures.length - 1].file;
      let decision: NavStepDecision | undefined;

      for (let waitCycle = 0; waitCycle <= maxWaitCyclesPerStep; waitCycle++) {
        const hints = dumpHints(latest);
        try {
          decision = await nav.decideNext({ screenshotFile: latest, stepIndex: step, hints });
        } catch {
          decision = undefined; // Decision-making itself failed — stop navigating, keep what we have.
          break;
        }
        if (!decision.waiting || decision.arrived || waitCycle === maxWaitCyclesPerStep) break;

        const { file, settled } = await waitForStableScreen();
        if (checkedForCrash()) { decision = undefined; break; }
        if (!file) { decision = undefined; break; }
        recordCapture(
          file,
          `waiting on step ${step + 1}: ${decision.reason}${settled ? "" : " (still changing when the wait budget ran out)"}`
        );
        latest = file;
      }

      if (!decision) break;
      if (decision.arrived || decision.tapXPercent == null || decision.tapYPercent == null) break;

      try {
        const { width, height } = pngDimensions(fsSync.readFileSync(latest));
        const x = Math.round((decision.tapXPercent / 100) * width);
        const y = Math.round((decision.tapYPercent / 100) * height);
        run(["shell", "input", "tap", String(x), String(y)], 15000);
      } catch {
        break;
      }

      // Wait for the tap's actual effect to settle — an animation, a
      // simulated race, a level load — instead of a fixed sleep with no idea
      // how long that takes for THIS app. Comparing consecutive screenshots
      // needs no per-app knowledge at all, which is what fixed this: a race
      // that hadn't finished simulating was previously judged the instant a
      // flat 1.3s elapsed, regardless of whether the race was actually over.
      // The wait loop itself takes real time, which is also exactly when a
      // navigation-triggered crash would show up in logcat — so check for
      // one only after waiting, not before.
      const { file, settled } = await waitForStableScreen();
      if (checkedForCrash()) break; // a navigation tap can crash the app just as validly as launch can
      if (!file) break;
      recordCapture(
        file,
        `navigation step ${step + 1}: ${decision.reason}${settled ? "" : " (still changing when the wait budget ran out)"}`
      );
    }
  }

  // ---- QA as an agent (only after a first check FAILED; see qaBrowserAgent.ts).
  // The tools below are all it gets on the device. Night mode is the one
  // setting it changes, and it is put back when the agent finishes.
  const androidBackend = (): QaBackend => {
    let scheme: "light" | "dark" = "light";
    let originalNight: string | undefined;
    let changedNight = false;
    // Everything the agent changes besides night mode is listed here and undone in restore().
    const conditions = new Set<string>();
    const undo: (() => void)[] = [];
    let rotationSaved = false;
    let networkSaved = false;
    const permissionOriginal = new Map<string, boolean>();
    const hasPermission = (perm: string): boolean => {
      const out = run(["shell", "dumpsys", "package", pkg], 20000);
      const i = out.indexOf(perm + ": granted=");
      return i >= 0 && out.slice(i + perm.length + 10, i + perm.length + 14) === "true";
    };
    try {
      const out = run(["shell", "cmd", "uimode", "night"], 15000).toLowerCase();
      originalNight = out.includes("yes") ? "yes" : out.includes("auto") ? "auto" : out.includes("no") ? "no" : undefined;
      if (originalNight === "yes") scheme = "dark";
    } catch {}
    let viewport = "unknown";
    try {
      const m = /(\d+)x(\d+)/.exec(run(["shell", "wm", "size"], 15000));
      if (m) viewport = m[1] + "x" + m[2];
    } catch {}
    const dumpXml = (): string => {
      run(["shell", "uiautomator", "dump", "/sdcard/yimpim-ui-dump.xml"], 15000);
      return run(["exec-out", "cat", "/sdcard/yimpim-ui-dump.xml"], 15000);
    };
    const tools: ToolSpec[] = [
      { name: "set_night_mode", args: '{"value":"light"|"dark"}', does: "Set the device's night mode (system dark theme). An app that follows its own saved theme setting may not respond; a screenshot will show whether it did. Put back when you finish." },
      { name: "tap_text", args: '{"text":string}', does: "Tap the on-screen control whose visible text or content description contains this. Only sees what the accessibility tree exposes. For moving around the app." },
      { name: "back", args: "{}", does: "Press the Back button." },
      { name: "relaunch", args: "{}", does: "Force-stop the app and start it again from its launcher icon." },
      { name: "read_text", args: "{}", does: "Read the text and content descriptions currently on screen (accessibility tree)." },
      { name: "read_logcat", args: "{}", does: "Read recent errors for this app from logcat, including the crash buffer." },
      { name: "open_link", args: '{"uri":string}', does: "Open a deep link or URL inside this app (a VIEW intent addressed to it). For reaching a screen or state a link leads to." },
      { name: "rotate", args: '{"orientation":"portrait"|"landscape"}', does: "Rotate the device. Put back when you finish." },
      { name: "set_network", args: '{"value":"on"|"off"}', does: "Turn Wi-Fi and mobile data off or on, to see offline or error behavior. Put back when you finish." },
      { name: "set_permission", args: '{"permission":string,"value":"granted"|"revoked"}', does: "Grant or revoke one runtime permission for this app (for example android.permission.CAMERA). Relaunch for the app to notice. Put back when you finish." },
    ];
    return {
      kind: "android",
      tools,
      state: () => ({ scheme, viewport, conditions: [...conditions] }),
      shoot: async () => {
        const { file } = await waitForStableScreen();
        if (!file) throw new Error("screenshot failed");
        return fsSync.readFileSync(file);
      },
      async run(tool, args) {
        if (tool === "set_night_mode") {
          if (args.value !== "light" && args.value !== "dark") throw new Error('value must be "light" or "dark"');
          run(["shell", "cmd", "uimode", "night", args.value === "dark" ? "yes" : "no"], 15000);
          scheme = args.value;
          changedNight = true;
          await sleep(1500);
          return { retake: "after setting the device night mode to " + scheme };
        }
        if (tool === "tap_text") {
          const text = String(args.text ?? "").slice(0, 120);
          if (!text) throw new Error("text is required");
          const f = await captureRaw();
          if (!f) throw new Error("could not capture the screen to find the control");
          const hint = dumpHints(f).find((h) => h.label.toLowerCase().includes(text.toLowerCase()));
          if (!hint) throw new Error('no tappable control with the text "' + text + '" is on screen');
          const { width, height } = pngDimensions(fsSync.readFileSync(f));
          run(["shell", "input", "tap", String(Math.round((hint.xPercent / 100) * width)), String(Math.round((hint.yPercent / 100) * height))], 15000);
          await waitForStableScreen();
          return { retake: 'after tapping "' + text + '"' };
        }
        if (tool === "back") {
          run(["shell", "input", "keyevent", "KEYCODE_BACK"], 15000);
          await sleep(800);
          return { retake: "after pressing Back" };
        }
        if (tool === "relaunch") {
          try {
            run(["shell", "am", "force-stop", pkg], 20000);
          } catch {}
          run(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], 30000);
          await sleep(3000);
          return { retake: "after relaunching the app" };
        }
        if (tool === "read_text") {
          const xml = dumpXml();
          const out: string[] = [];
          for (const re of [/\btext="([^"]+)"/g, /\bcontent-desc="([^"]+)"/g]) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml)) && out.length < 80) out.push(m[1].trim());
          }
          return { text: JSON.stringify([...new Set(out)].join(" | ").slice(0, 1500)) };
        }
        if (tool === "read_logcat") {
          let crash = "";
          try {
            crash = run(["logcat", "-d", "-b", "crash"], 20000);
          } catch {}
          let errs = "";
          try {
            errs = run(["logcat", "-d", "-t", "300", "*:E"], 20000)
              .split("\n")
              .filter((l) => l.includes(pkg))
              .slice(-15)
              .join("\n");
          } catch {}
          const text = (crash.includes(pkg) ? crash.slice(-800) : "") + errs;
          return { text: text.trim() ? JSON.stringify(text.slice(-1500)) : "no errors for this app in logcat" };
        }
        if (tool === "open_link") {
          const uri = String(args.uri ?? "").slice(0, 500);
          if (!uri) throw new Error("uri is required");
          run(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri, pkg], 20000);
          await sleep(2500);
          return { retake: "after opening " + uri };
        }
        if (tool === "rotate") {
          if (args.orientation !== "portrait" && args.orientation !== "landscape") throw new Error('orientation must be "portrait" or "landscape"');
          if (!rotationSaved) {
            rotationSaved = true;
            const auto = run(["shell", "settings", "get", "system", "accelerometer_rotation"], 15000).trim();
            const rot = run(["shell", "settings", "get", "system", "user_rotation"], 15000).trim();
            undo.push(() => {
              run(["shell", "settings", "put", "system", "user_rotation", rot === "null" ? "0" : rot], 15000);
              run(["shell", "settings", "put", "system", "accelerometer_rotation", auto === "null" ? "1" : auto], 15000);
            });
          }
          run(["shell", "settings", "put", "system", "accelerometer_rotation", "0"], 15000);
          run(["shell", "settings", "put", "system", "user_rotation", args.orientation === "landscape" ? "1" : "0"], 15000);
          conditions.delete("landscape");
          conditions.delete("portrait");
          conditions.add(args.orientation);
          await sleep(1500);
          return { retake: "after rotating to " + args.orientation };
        }
        if (tool === "set_network") {
          if (args.value !== "on" && args.value !== "off") throw new Error('value must be "on" or "off"');
          if (!networkSaved) {
            networkSaved = true;
            undo.push(() => {
              run(["shell", "svc", "wifi", "enable"], 15000);
              run(["shell", "svc", "data", "enable"], 15000);
            });
          }
          const verb = args.value === "off" ? "disable" : "enable";
          run(["shell", "svc", "wifi", verb], 15000);
          run(["shell", "svc", "data", verb], 15000);
          if (args.value === "off") conditions.add("offline");
          else conditions.delete("offline");
          await sleep(2000);
          return { retake: "after turning the network " + args.value };
        }
        if (tool === "set_permission") {
          const perm = String(args.permission ?? "");
          if (!/^[A-Za-z0-9_.]{3,120}$/.test(perm)) throw new Error("permission must look like android.permission.CAMERA");
          if (args.value !== "granted" && args.value !== "revoked") throw new Error('value must be "granted" or "revoked"');
          if (!permissionOriginal.has(perm)) {
            const was = hasPermission(perm);
            permissionOriginal.set(perm, was);
            undo.push(() => run(["shell", "pm", was ? "grant" : "revoke", pkg, perm], 15000));
          }
          run(["shell", "pm", args.value === "granted" ? "grant" : "revoke", pkg, perm], 15000);
          conditions.add(perm + " " + args.value);
          return { retake: "after " + (args.value === "granted" ? "granting " : "revoking ") + perm };
        }
        throw new Error("unknown tool");
      },
      async restore() {
        for (const fn of undo.reverse()) {
          try {
            fn();
          } catch {}
        }
        if (changedNight && originalNight) run(["shell", "cmd", "uimode", "night", originalNight], 15000);
      },
    };
  };

  let visualVerdict: BrowserQaResult | undefined;
  if (nav?.judge && runtimeDefects.length === 0 && captures.length > 0) {
    try {
      visualVerdict = await nav.judge({
        backend: androidBackend(),
        screenshotDir,
        label: "android",
        latestScreenshot: captures[captures.length - 1].file,
      });
      for (const c of visualVerdict.captures) recordCapture(c.file, c.label);
    } catch {}
    // An agent tapping around can crash the app just as navigation can.
    checkedForCrash();
  }

  if (runtimeDefects.length > 0) {
    return {
      status: "captured",
      captures,
      runtimeDefects,
      detail: `fatal exception attributed to ${pkg} found in the crash buffer`,
      recoveryNote,
    };
  }

  return {
    status: captures.length > 0 ? "captured" : "error",
    captures,
    runtimeDefects,
    recoveryNote,
    visualVerdict,
    detail: `captured ${captures.length} screenshot(s) of ${pkg}`,
  };
}

// ----------------------------------------------------------------- iOS

export async function probeIOS(
  profile: IOSProfile,
  caps: Capabilities,
  screenshotDir: string,
  maxPolls = 3,
  /** Run QA as an agent against the booted simulator, called only after a
   *  first check FAILED (see verifierTools judgeVisual). */
  judge?: (ctx: QaJudgeContext) => Promise<BrowserQaResult>
): Promise<ProbeResult> {
  if (!caps.xcodebuild.available) return unavailable(caps.xcodebuild.detail);
  if (!caps.iosSimulator.available) return unavailable(caps.iosSimulator.detail);
  if (!profile.bundleId) {
    return unavailable("could not resolve CFBundleIdentifier from Info.plist, cannot launch the app");
  }

  const app = findNewestIOSApp(profile.derivedDataPath);
  if (!app) return unavailable(`no .app bundle found under ${profile.derivedDataPath}`);

  const bundleId = profile.bundleId;
  const captures: VisualCapture[] = [];

  // DiagnosticReports is where the Simulator actually writes crash reports —
  // recorded before launch so only NEW reports (this run's, not a stale one
  // from a previous crash) count as evidence.
  const crashDir = process.env.HOME
    ? path.join(process.env.HOME, "Library", "Logs", "DiagnosticReports")
    : undefined;
  const knownCrashes = new Set<string>();
  if (crashDir && fsSync.existsSync(crashDir)) {
    try {
      for (const f of fsSync.readdirSync(crashDir)) knownCrashes.add(f);
    } catch {}
  }

  try {
    execFileSync("xcrun", ["simctl", "install", "booted", app], { timeout: 120000, stdio: "pipe" });
    try {
      execFileSync("xcrun", ["simctl", "terminate", "booted", bundleId], { timeout: 15000, stdio: "pipe" });
    } catch {} // fine if it was not already running
    execFileSync("xcrun", ["simctl", "launch", "booted", bundleId], { timeout: 30000, stdio: "pipe" });
  } catch (err: any) {
    return {
      status: "error",
      captures,
      runtimeDefects: [],
      detail: `install/launch could not complete: ${err.message}`,
    };
  }

  const runtimeDefects: string[] = [];

  for (let poll = 1; poll <= maxPolls; poll++) {
    await sleep(poll === 1 ? 3000 : 2000);

    // A crash report naming this bundle, that was not there before launch,
    // is positive evidence — the same standard Android's crash-buffer check
    // holds itself to.
    if (crashDir && fsSync.existsSync(crashDir)) {
      try {
        for (const f of fsSync.readdirSync(crashDir)) {
          if (knownCrashes.has(f)) continue;
          const full = path.join(crashDir, f);
          const content = fsSync.readFileSync(full, "utf-8").slice(0, 4000);
          if (content.includes(bundleId) || f.includes(bundleId)) {
            runtimeDefects.push(content.slice(-2000));
          }
          knownCrashes.add(f);
        }
      } catch {}
      if (runtimeDefects.length > 0) break;
    }

    const file = path.join(screenshotDir, `ios-${poll}-${Date.now()}.png`);
    try {
      execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", file], { timeout: 30000, stdio: "pipe" });
      captures.push({ file, label: `ios launch poll ${poll}` });
    } catch (err: any) {
      return {
        status: captures.length > 0 ? "captured" : "error",
        captures,
        runtimeDefects,
        detail: `screenshot capture failed: ${err.message}`,
      };
    }
  }

  let visualVerdict: BrowserQaResult | undefined;
  if (judge && runtimeDefects.length === 0 && captures.length > 0) {
    try {
      const simctl = (args: string[], timeout = 30000): string =>
        execFileSync("xcrun", ["simctl", ...args], { encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
      visualVerdict = await judge({
        backend: iosBackend({
          exec: simctl,
          bundleId,
          shoot: async () => {
            const f = path.join(screenshotDir, `ios-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
            execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", f], { timeout: 30000, stdio: "pipe" });
            const buf = await fs.readFile(f);
            await fs.rm(f, { force: true });
            return buf;
          },
        }),
        screenshotDir,
        label: "ios",
        latestScreenshot: captures[captures.length - 1].file,
      });
      for (const c of visualVerdict.captures) captures.push(c);
    } catch {}
  }

  if (runtimeDefects.length > 0) {
    return {
      status: "captured",
      captures,
      runtimeDefects,
      detail: `a crash report naming ${bundleId} appeared after launch`,
    };
  }

  return {
    status: captures.length > 0 ? "captured" : "error",
    captures,
    runtimeDefects,
    visualVerdict,
    detail: `captured ${captures.length} screenshot(s) of ${bundleId}`,
  };
}

// ------------------------------------------------------- Server-backed UIs

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i;

export interface ServerHandle {
  proc: ChildProcess | null;
  url: string | null;
  log: string;
}

/**
 * Start a dev server and learn its URL from its own output, which is far more
 * reliable across frameworks than guessing ports. Falls back to probing
 * candidate URLs when the server prints nothing useful.
 */
export async function startServer(
  bin: string,
  args: string[],
  cwd: string,
  candidateUrls: string[],
  timeoutMs: number,
  /** The variables the app is started with for QA (qaSetup.ts env: only the allowed names). */
  qaEnv: Record<string, string> = {}
): Promise<ServerHandle> {
  let log = "";
  let detected: string | null = null;

  const launch = winSafeCommand(bin, args);
  const proc = spawn(launch.bin, launch.args, {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...qaEnv, BROWSER: "none", CI: "1", FORCE_COLOR: "0" },
  });

  const onData = (buf: Buffer) => {
    const text = buf.toString();
    log += text;
    if (log.length > 40000) log = log.slice(-40000);
    if (!detected) {
      const m = text.match(URL_RE);
      if (m) detected = m[0].replace(/[),.]+$/, "").replace("0.0.0.0", "localhost");
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  const deadline = Date.now() + timeoutMs;

  // Phase 1: wait for the server to announce a URL, then confirm it responds.
  while (Date.now() < deadline) {
    if (detected && (await isReachable(detected))) return { proc, url: detected, log };
    if (proc.exitCode !== null) break;
    await sleep(500);
  }

  // Phase 2: the server never told us; try the framework's usual ports.
  for (const candidate of candidateUrls) {
    if (await isReachable(candidate)) return { proc, url: candidate, log };
  }

  return { proc, url: detected, log };
}

function isReachable(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return resolve(false);
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      {
        host: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname || "/",
        timeout: 2000,
        rejectUnauthorized: false,
      } as any,
      (res) => {
        res.resume();
        resolve(Boolean(res.statusCode && res.statusCode < 500));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function stopServer(handle: ServerHandle): void {
  const proc = handle.proc;
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
}

/** Pulls visible, interactive elements' accessible name and center point out
 *  of the live DOM — the web equivalent of Android's uiautomator dump. Runs
 *  inside the page itself so it sees real layout (post-JS, post-CSS), the
 *  same reason Android reads the accessibility tree instead of static markup. */
async function extractWebHints(page: any, maxItems = 40): Promise<NavHint[]> {
  try {
    // Cast to `any` throughout: this function body runs inside the browser
    // page, not Node, so document/window/getComputedStyle are real there —
    // but this project's tsconfig has no "dom" lib (it's Node-only), so
    // typing it against Node's globals would be actively wrong.
    return await page.evaluate(
      ({ max }: { max: number }) => {
        const doc: any = (globalThis as any).document;
        const win: any = (globalThis as any).window;
        const selector =
          'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary';
        const out: { label: string; xPercent: number; yPercent: number }[] = [];
        for (const el of Array.from(doc.querySelectorAll(selector)) as any[]) {
          if (out.length >= max) break;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const style = win.getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const label = (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80);
          if (!label) continue;
          out.push({
            label,
            xPercent: ((r.left + r.width / 2) / win.innerWidth) * 100,
            yPercent: ((r.top + r.height / 2) / win.innerHeight) * 100,
          });
        }
        return out;
      },
      { max: maxItems }
    );
  } catch {
    return []; // Best-effort, same as Android's dumpHints — the caller falls back to the screenshot alone.
  }
}

/**
 * Polls full-page screenshots until two consecutive captures are byte-
 * identical — nothing observably still rendering, mid-animation, or still
 * fetching data — or maxWaitMs elapses. Same philosophy as probeAndroid's
 * waitForStableScreen further below, adapted to Playwright: taken in memory
 * (no disk I/O during polling), so the cost of waiting a little longer is
 * just time, not extra file churn.
 *
 * This replaced a `page.waitForLoadState("networkidle")` wait, which turned
 * out to be unreliable for exactly the case that matters most here: a dev
 * server with a persistent HMR connection (Vite, webpack-dev-server) never
 * goes network-idle at all, so that wait always ran out its full timeout
 * regardless of whether the page had actually rendered anything — and a
 * fresh React/Vite app's initial HTML is just an empty mount point, with
 * real content only appearing once the JS bundle finishes parsing and
 * executing. The screenshot taken right after that timeout could land
 * before or after that happened, essentially by luck — this fixes a real
 * incident where it landed before, capturing an empty page with nothing
 * wrong ever reported.
 */
export async function waitForStableScreenshot(
  page: any,
  pollMs = 700,
  maxWaitMs = 10000
): Promise<{ buffer: Buffer; settled: boolean }> {
  let prev: Buffer = await page.screenshot({ fullPage: true });
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const next: Buffer = await page.screenshot({ fullPage: true });
    if (next.equals(prev)) return { buffer: next, settled: true };
    prev = next;
  }
  return { buffer: prev, settled: false };
}

/** Screenshot any reachable URL with Playwright, optionally clicking onward
 *  toward a target screen first. Shared by web + python-web. Exported only
 *  for direct testing of device-emulation (probeExpoWeb's iPhone viewport). */
export async function captureUrl(
  url: string,
  caps: Capabilities,
  screenshotDir: string,
  label: string,
  nav?: WebNavOptions,
  /** A key into Playwright's built-in `devices` registry (e.g. "iPhone 15")
   *  -- overrides the default desktop viewport with that device's viewport,
   *  mobile user-agent and touch emulation. Omitted by every caller except
   *  probeExpoWeb, which needs a phone-shaped surface to verify against, not
   *  a desktop browser window. */
  deviceName?: string,
  /** When given, .agent/qa-setup.json is applied (see qaSetup.ts): state
   *  seeded before the app runs, a start path, a fake camera image, files for
   *  file choosers. Omitted by callers with no repo (direct tests). */
  repoRoot?: string
): Promise<{ captures: VisualCapture[]; defects: string[]; detail: string; visualVerdict?: BrowserQaResult }> {
  const mod: any = await import("playwright");
  const setup = repoRoot ? loadQaSetup(repoRoot) : {};
  const applied: string[] = [];
  let scratchDir: string | undefined;

  // Browser-side stand-ins for native hardware: Chromium's fake media device
  // (and its auto-accepted permission prompt) so a camera screen gets a feed
  // instead of hanging on a prompt nobody can click; optionally fed a real
  // image (e.g. a QR code) so a scanner has something to scan.
  const launchArgs = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  if (repoRoot && setup.cameraImage) {
    const imageFile = resolveRepoFile(repoRoot, setup.cameraImage);
    if (imageFile) {
      scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-qa-"));
      const feed = await writeFakeCameraFeed(mod, imageFile, path.join(scratchDir, "camera.y4m"));
      if (feed) {
        launchArgs.push(`--use-file-for-fake-video-capture=${feed}`);
        applied.push(`camera shows ${setup.cameraImage}`);
      }
    }
  }

  const browser = await mod.chromium.launch({ headless: true, args: launchArgs });
  const defects: string[] = [];
  const captures: VisualCapture[] = [];

  try {
    const deviceProfile = deviceName ? mod.devices[deviceName] : undefined;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ["camera", "microphone", "geolocation", "clipboard-read", "clipboard-write"],
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
      ...deviceProfile,
    });

    // Seeded before any app code runs, once per tab: an app that signs out and
    // clears its own storage must not have it put straight back on reload.
    if (setup.localStorage && Object.keys(setup.localStorage).length > 0) {
      await context.addInitScript(
        `(() => { try {
          if (sessionStorage.getItem("__qaSeeded")) return;
          sessionStorage.setItem("__qaSeeded", "1");
          const entries = ${JSON.stringify(Object.entries(setup.localStorage))};
          for (const [k, v] of entries) localStorage.setItem(k, v);
        } catch (e) {} })();`
      );
      applied.push(`seeded ${Object.keys(setup.localStorage).length} storage value(s)`);
    }

    const page = await context.newPage();

    // A file input tapped by QA would otherwise open a chooser nothing can
    // answer. Hand it the registered files, or tiny samples if none were.
    page.on("filechooser", async (chooser: any) => {
      try {
        const registered = repoRoot ? (setup.uploadFiles ?? []).map((f) => resolveRepoFile(repoRoot, f)).filter(Boolean) as string[] : [];
        let files = registered;
        if (files.length === 0) {
          scratchDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "yimpim-qa-"));
          const png = path.join(scratchDir, "sample.png");
          const txt = path.join(scratchDir, "sample.txt");
          await fs.writeFile(png, Buffer.from(DEFAULT_SAMPLE_PNG_BASE64, "base64"));
          await fs.writeFile(txt, "sample file supplied by QA\n");
          files = [png, txt];
        }
        await chooser.setFiles(chooser.isMultiple() ? files : files.slice(0, 1));
        applied.push(registered.length > 0 ? "file chooser answered with registered files" : "file chooser answered with sample files");
      } catch {}
    });

    page.on("pageerror", (err: any) => defects.push(`Uncaught page error: ${err.message}`));
    page.on("console", (msg: any) => {
      if (msg.type() === "error") defects.push(`Console error: ${msg.text()}`);
    });

    // Only http(s): on a file:// page a root-relative path would leave the app.
    let target = url;
    if (setup.launchPath && /^https?:/i.test(url)) {
      try {
        target = new URL(setup.launchPath, url).href;
        applied.push(`opened ${setup.launchPath}`);
      } catch {}
    }
    const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response && response.status() >= 500) {
      defects.push(`Server returned HTTP ${response.status()} for ${url}`);
    }

    // See waitForStableScreenshot's own doc comment for why this isn't a
    // plain networkidle wait — that's unreliable for exactly the dev-server
    // case this exists for.
    const { buffer } = await waitForStableScreenshot(page);
    const file = path.join(screenshotDir, `${label}-${Date.now()}.png`);
    await fs.writeFile(file, buffer);
    captures.push({ file, label });

    // Click onward toward whatever screen the caller actually needs to
    // verify, same purpose (and same bounded, best-effort shape) as
    // probeAndroid's nav loop below — see its own comment for why this
    // doesn't need to be perfect to be worth doing.
    if (nav && defects.length === 0) {
      const maxSteps = nav.maxSteps ?? 5;
      for (let step = 0; step < maxSteps; step++) {
        const latest = captures[captures.length - 1].file;
        const hints = await extractWebHints(page);
        let decision: NavStepDecision;
        try {
          decision = await nav.decideNext({ screenshotFile: latest, stepIndex: step, hints });
        } catch {
          break; // Decision-making itself failed — stop navigating, keep what we have.
        }
        if (decision.arrived) break;

        if (decision.waiting) {
          // A short extra pause before the model looks again — the real
          // settle check now happens below via waitForStableScreenshot,
          // same mechanism Android's own probe uses.
          await sleep(1200);
        } else if (decision.tapXPercent != null && decision.tapYPercent != null) {
          // The vision call (and a replayed step) both express "what to act
          // on" as a percent-position, same as Android — resolve back to
          // the DOM element actually nearest that point and click IT by
          // locator, not by raw page coordinates, so a reflow between the
          // screenshot and the click can't land the click on the wrong node.
          let nearest: NavHint | undefined;
          let nearestDist = Infinity;
          for (const h of hints) {
            const d = Math.hypot(h.xPercent - decision.tapXPercent, h.yPercent - decision.tapYPercent);
            if (d < nearestDist) {
              nearestDist = d;
              nearest = h;
            }
          }
          if (!nearest) break;
          try {
            await page.getByText(nearest.label, { exact: false }).first().click({ timeout: 5000 });
          } catch {
            break; // The chosen label no longer resolves to a clickable element — stop rather than guess.
          }
        } else {
          break;
        }

        const { buffer: stepBuffer } = await waitForStableScreenshot(page);
        const stepFile = path.join(screenshotDir, `${label}-step${step + 1}-${Date.now()}.png`);
        await fs.writeFile(stepFile, stepBuffer);
        captures.push({
          file: stepFile,
          label: decision.waiting ? `waiting on step ${step + 1}: ${decision.reason}` : `navigation step ${step + 1}: ${decision.reason}`,
        });
      }
    }

    // The first check runs here, while the page is still live. Only when it
    // FAILS does QA run as an agent to work out why (qaBrowserAgent.ts).
    // A problem here never fails the capture.
    let visualVerdict: BrowserQaResult | undefined;
    if (nav?.judge && defects.length === 0) {
      try {
        visualVerdict = await nav.judge({
          backend: browserBackend(page, async () => (await waitForStableScreenshot(page)).buffer, () => defects.slice()),
          screenshotDir,
          label,
          latestScreenshot: captures[captures.length - 1]?.file,
        });
        for (const c of visualVerdict.captures) captures.push(c);
      } catch {}
    }

    return {
      visualVerdict,
      captures,
      defects,
      detail: `captured ${url}${applied.length > 0 ? ` (QA setup: ${[...new Set(applied)].join("; ")})` : ""}`,
    };
  } finally {
    try {
      await browser.close();
    } catch {}
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function probeWeb(
  profile: WebProfile,
  caps: Capabilities,
  repoRoot: string,
  screenshotDir: string,
  nav?: WebNavOptions
): Promise<ProbeResult> {
  if (!caps.browser.available) return unavailable(caps.browser.detail);

  // A bare static page has no server to start — open the file directly.
  if (profile.entryFile) {
    const fileUrl = pathToFileURL(path.join(repoRoot, profile.entryFile)).href;
    try {
      const { captures, defects, detail, visualVerdict } = await captureUrl(fileUrl, caps, screenshotDir, "web", nav);
      return { status: "captured", captures, runtimeDefects: defects, detail, visualVerdict };
    } catch (err: any) {
      return { status: "error", captures: [], runtimeDefects: [], detail: `web probe failed: ${err.message}` };
    }
  }

  if (!profile.devScript) return unavailable("package.json has no dev/start/serve script to launch");
  if (!caps.npm.available) return unavailable(caps.npm.detail);

  const pm = profile.packageManager ?? "npm";
  const bin = process.platform === "win32" ? `${pm}.cmd` : pm;
  const handle = await startServer(bin, ["run", profile.devScript], repoRoot, profile.candidateUrls, 45000, qaEnvFor(repoRoot));

  try {
    if (!handle.url) {
      return unavailable(
        `dev server "${profile.devScript}" never became reachable; last output: ${handle.log.slice(-400).trim() || "(silent)"}`
      );
    }
    const { captures, defects, detail, visualVerdict } = await captureUrl(handle.url, caps, screenshotDir, "web", nav, undefined, repoRoot);
    return { status: "captured", captures, runtimeDefects: defects, detail, visualVerdict };
  } catch (err: any) {
    return { status: "error", captures: [], runtimeDefects: [], detail: `web probe failed: ${err.message}` };
  } finally {
    stopServer(handle);
  }
}

export async function probeExpoWeb(
  profile: ReactNativeProfile,
  caps: Capabilities,
  repoRoot: string,
  screenshotDir: string,
  nav?: WebNavOptions
): Promise<ProbeResult> {
  if (!caps.browser.available) return unavailable(caps.browser.detail);
  if (!caps.npm.available) return unavailable(caps.npm.detail);

  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  // Metro's cold-start bundle-on-first-request can be slower than Vite's dev
  // server -- a longer startServer timeout than probeWeb's 45s.
  const handle = await startServer(bin, ["expo", "start", "--web"], repoRoot, profile.candidateUrls, 60000, qaEnvFor(repoRoot));

  try {
    if (!handle.url) {
      return unavailable(
        `Expo web dev server never became reachable; last output: ${handle.log.slice(-400).trim() || "(silent)"}`
      );
    }
    // Emulated as an iPhone viewport (dimensions, mobile UA, touch), not the
    // default desktop window -- the point of this route is answering "does
    // this look right on a phone screen" for someone with no Mac/iPhone to
    // check it on directly. Chosen over an Android device profile because
    // the narrower/taller iPhone viewport is the tighter layout constraint a
    // cross-platform screen has to satisfy; Android gets its own real native
    // check when a build system + emulator are available.
    const { captures, defects, detail, visualVerdict } = await captureUrl(handle.url, caps, screenshotDir, "expo-web", nav, "iPhone 15", repoRoot);
    return { status: "captured", captures, runtimeDefects: defects, detail, visualVerdict };
  } catch (err: any) {
    return { status: "error", captures: [], runtimeDefects: [], detail: `expo web probe failed: ${err.message}` };
  } finally {
    stopServer(handle);
  }
}

export async function probePythonWeb(
  profile: PythonProfile,
  caps: Capabilities,
  repoRoot: string,
  screenshotDir: string,
  nav?: WebNavOptions
): Promise<ProbeResult> {
  if (!caps.python.available || !caps.python.bin) return unavailable(caps.python.detail);
  if (!caps.browser.available) return unavailable(caps.browser.detail);

  const handle = await startServer(
    caps.python.bin,
    profile.launchArgs,
    repoRoot,
    profile.candidateUrls,
    45000,
    qaEnvFor(repoRoot)
  );

  try {
    if (!handle.url) {
      return unavailable(
        `${profile.framework} app never became reachable; last output: ${handle.log.slice(-400).trim() || "(silent)"}`
      );
    }
    const { captures, defects, detail, visualVerdict } = await captureUrl(
      handle.url,
      caps,
      screenshotDir,
      `python-${profile.framework}`,
      nav,
      undefined,
      repoRoot
    );
    return { status: "captured", captures, runtimeDefects: defects, detail, visualVerdict };
  } catch (err: any) {
    return { status: "error", captures: [], runtimeDefects: [], detail: `python web probe failed: ${err.message}` };
  } finally {
    stopServer(handle);
  }
}

// ------------------------------------------------------------ Desktop GUI

/** Capture the whole screen using whatever native tool exists. */
async function captureDesktop(caps: Capabilities, outFile: string): Promise<boolean> {
  const tool = caps.screenCapture;
  if (!tool.available || !tool.bin) return false;

  try {
    if (process.platform === "darwin") {
      execFileSync(tool.bin, ["-x", outFile], { timeout: 20000, stdio: "ignore" });
    } else if (process.platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
        `$bmp.Save('${outFile.replace(/\\/g, "\\\\").replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      ].join(" ");
      execFileSync(tool.bin, ["-NoProfile", "-NonInteractive", "-Command", ps], {
        timeout: 30000,
        stdio: "ignore",
      });
    } else {
      const name = path.basename(tool.bin);
      const args =
        name === "import" ? ["-window", "root", outFile]
        : name === "spectacle" ? ["-b", "-n", "-o", outFile]
        : name === "gnome-screenshot" ? ["-f", outFile]
        : ["-o", outFile]; // scrot
      execFileSync(tool.bin, args, { timeout: 20000, stdio: "ignore" });
    }
    return fsSync.existsSync(outFile);
  } catch {
    return false;
  }
}

export async function probeDesktopApp(
  profile: PythonProfile,
  caps: Capabilities,
  repoRoot: string,
  screenshotDir: string
): Promise<ProbeResult> {
  if (!caps.python.available || !caps.python.bin) return unavailable(caps.python.detail);
  if (!caps.display.available) return unavailable(caps.display.detail);
  if (!caps.screenCapture.available) return unavailable(caps.screenCapture.detail);

  let stderr = "";
  const proc = spawn(caps.python.bin, profile.launchArgs, {
    cwd: repoRoot,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  proc.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  const handle: ServerHandle = { proc, url: null, log: "" };

  try {
    // Give the toolkit time to construct and paint its main window.
    await sleep(6000);

    if (proc.exitCode !== null && proc.exitCode !== 0) {
      const trace = stderr.trim().slice(-2000);

      // A missing interpreter or an uninstalled GUI toolkit is absent tooling,
      // not a defect in the code under review.
      const lower = trace.toLowerCase();
      const toolingMiss =
        proc.exitCode === 9009 ||
        proc.exitCode === 127 ||
        lower.includes("python was not found") ||
        lower.includes("is not recognized as an internal or external command") ||
        /no module named ['"]?(pyside|pyqt|kivy|wx|tkinter|customtkinter)/i.test(trace) ||
        lower.includes("command not found");

      if (toolingMiss) {
        return unavailable(
          `${profile.framework} could not be launched — required runtime/toolkit is not installed: ${trace.slice(-300)}`
        );
      }

      return {
        status: "captured",
        captures: [],
        runtimeDefects: [`${profile.framework} app exited with code ${proc.exitCode}:\n${trace}`],
        detail: `GUI process died on startup`,
      };
    }

    const file = path.join(screenshotDir, `desktop-${profile.framework}-${Date.now()}.png`);
    const ok = await captureDesktop(caps, file);
    if (!ok) return unavailable("native screen capture produced no image");

    return {
      status: "captured",
      captures: [{ file, label: `${profile.framework} desktop window` }],
      runtimeDefects: [],
      detail: `captured desktop screenshot while ${profile.entryFile} was running`,
    };
  } catch (err: any) {
    return { status: "error", captures: [], runtimeDefects: [], detail: `desktop probe failed: ${err.message}` };
  } finally {
    stopServer(handle);
  }
}
