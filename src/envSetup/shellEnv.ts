/**
 * The files setup-env writes in the person's own home: the environment exports (one file, mode 0600, sourced from the shell's startup file by a marked block that is replaced, not
 * repeated), the Gradle property an ARM64 machine needs, and the machine record. Every write is atomic (a temporary file in the same folder, then a rename) and the permissions are
 * set before the content is written, so nothing is ever readable by others, even for a moment.
 */
import fs from "fs";
import path from "path";
import { envShPath, localBin, sdksDir, type MachineInfo, type MachineRecord, machineJsonPath, yimpimConfigDir } from "./machine.js";

export const RC_BEGIN = "# >>> yimpim setup-env >>>";
export const RC_END = "# <<< yimpim setup-env <<<";
export const GRADLE_KEY = "android.aapt2FromMavenOverride";
export const AAPT2_PATH = "/usr/bin/aapt2";

/** Writes `content` to `file` atomically with exactly `mode`. The mode is set on the temporary file first. */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode); // the process umask may have narrowed it; this makes it exact
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
    throw e;
  }
}

export interface EnvPieces {
  /** Which components were installed (decides which lines are written). */
  node?: boolean;
  uv?: boolean;
  android?: boolean;
  flutter?: boolean;
  javaHome?: string;
}

/** The exports file: only for what is installed, paths from $HOME (never a value typed by a person or read from the network). */
export function renderEnvSh(p: EnvPieces): string {
  const lines = ["# Managed by `yimpim setup-env`. It is safe to delete this file; run `yimpim setup-env` to write it again.", 'export PATH="$HOME/.local/bin:$PATH"'];
  if (p.node) lines.push('export FNM_DIR="$HOME/.local/share/fnm"', 'command -v fnm >/dev/null 2>&1 && eval "$(fnm env --use-on-cd)"');
  if (p.javaHome) lines.push(`export JAVA_HOME="${p.javaHome}"`);
  if (p.android) {
    lines.push('export ANDROID_HOME="$HOME/sdks/android"', 'export ANDROID_SDK_ROOT="$ANDROID_HOME"', 'export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"');
  }
  if (p.flutter) lines.push('export PATH="$HOME/sdks/flutter/bin:$PATH"');
  return lines.join("\n") + "\n";
}

/** The startup-file text with the marked block present exactly once (replaced if it was there, appended if not). Running it again changes nothing. */
export function upsertRcBlock(text: string): string {
  const block = [RC_BEGIN, '[ -f "$HOME/.config/yimpim/env.sh" ] && . "$HOME/.config/yimpim/env.sh"', RC_END].join("\n");
  const re = new RegExp(`${RC_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${RC_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (re.test(text)) return text.replace(re, block);
  return text + (text === "" || text.endsWith("\n") ? "" : "\n") + block + "\n";
}

/** The properties file with `key=value` present exactly once. */
export function ensureProperty(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return text + (text === "" || text.endsWith("\n") ? "" : "\n") + line + "\n";
}

/** ARM64 Linux needs Gradle to use the OS's aapt2 (Google's x86-only build cannot run there). On x64, and on macOS, nothing is written. */
export function gradleOverrideFor(m: Pick<MachineInfo, "platform" | "arch">): { key: string; value: string } | undefined {
  return m.platform === "linux" && m.arch === "arm64" ? { key: GRADLE_KEY, value: AAPT2_PATH } : undefined;
}

export function applyGradleOverride(home: string, m: Pick<MachineInfo, "platform" | "arch">): "written" | "not needed" {
  const o = gradleOverrideFor(m);
  if (!o) return "not needed";
  const file = path.join(home, ".gradle", "gradle.properties");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  const next = ensureProperty(text, o.key, o.value);
  if (next !== text) {
    let mode = 0o644;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // a new file
    }
    writeFileAtomic(file, next, mode);
  }
  return "written";
}

/** Writes the exports file (0600) and the marked block into the shell startup files that exist (or ~/.bashrc when there is none). */
export function applyShellEnv(home: string, p: EnvPieces): string[] {
  writeFileAtomic(envShPath(home), renderEnvSh(p), 0o600);
  const rcs = [".bashrc", ".zshrc"].map((f) => path.join(home, f));
  const existing = rcs.filter((f) => fs.existsSync(f));
  const targets = existing.length > 0 ? existing : [rcs[0]];
  for (const rc of targets) {
    let text = "";
    let mode = 0o644;
    try {
      text = fs.readFileSync(rc, "utf8");
      mode = fs.statSync(rc).mode & 0o777;
    } catch {
      // a new file
    }
    const next = upsertRcBlock(text);
    if (next !== text) writeFileAtomic(rc, next, mode);
  }
  return targets;
}

export function writeMachineRecord(home: string, rec: MachineRecord): void {
  fs.mkdirSync(yimpimConfigDir(home), { recursive: true, mode: 0o700 });
  writeFileAtomic(machineJsonPath(home), JSON.stringify(rec, null, 2) + "\n", 0o600);
}

export { localBin, sdksDir };
