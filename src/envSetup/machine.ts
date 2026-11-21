/**
 * What machine this is, found at run time: the platform, the CPU architecture (x64 or arm64), the Linux distribution, and whether /dev/kvm can be used. Nothing about versions
 * lives here; those come from the vendors' own published data when a tool is installed.
 */
import fs from "fs";
import os from "os";
import path from "path";

export type Family = "debian" | "rhel" | "macos" | "windows" | "other";

export interface MachineInfo {
  platform: NodeJS.Platform;
  arch: string;
  family: Family;
  distro?: { id: string; idLike: string[]; versionId?: string; name?: string };
  /** /dev/kvm: present at all, and usable by this user (nested virtualisation on a cloud VM is often absent). */
  kvm: { present: boolean; accessible: boolean };
  isRoot: boolean;
  home: string;
}

export function parseOsRelease(text: string): { id: string; idLike: string[]; versionId?: string; name?: string } {
  const get = (k: string) => {
    const m = new RegExp(`^${k}=(.*)$`, "m").exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { id: (get("ID") ?? "").toLowerCase(), idLike: (get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean), versionId: get("VERSION_ID"), name: get("PRETTY_NAME") ?? get("NAME") };
}

export function familyOf(platform: NodeJS.Platform, distro?: { id: string; idLike: string[] }): Family {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform !== "linux" || !distro) return "other";
  const ids = [distro.id, ...distro.idLike];
  if (ids.some((i) => i === "debian" || i === "ubuntu")) return "debian";
  if (ids.some((i) => i === "rhel" || i === "fedora" || i === "centos" || i === "rocky" || i === "almalinux" || i === "amzn")) return "rhel";
  return "other";
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  osReleaseText?: string;
  kvm?: { present: boolean; accessible: boolean };
  uid?: number;
  home?: string;
}

export function detectMachine(d: DetectDeps = {}): MachineInfo {
  const platform = d.platform ?? os.platform();
  let distro: MachineInfo["distro"];
  if (platform === "linux") {
    try {
      distro = parseOsRelease(d.osReleaseText ?? fs.readFileSync("/etc/os-release", "utf8"));
    } catch {
      distro = undefined;
    }
  }
  let kvm = d.kvm;
  if (!kvm) {
    const present = platform === "linux" && fs.existsSync("/dev/kvm");
    let accessible = false;
    if (present) {
      try {
        fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
        accessible = true;
      } catch {
        accessible = false;
      }
    }
    kvm = { present, accessible };
  }
  return {
    platform,
    arch: d.arch ?? os.arch(),
    family: familyOf(platform, distro),
    distro,
    kvm,
    isRoot: (d.uid ?? (typeof process.getuid === "function" ? process.getuid() : 1)) === 0,
    home: d.home ?? os.homedir(),
  };
}

export const yimpimConfigDir = (home: string) => path.join(home, ".config", "yimpim");
export const machineJsonPath = (home: string) => path.join(yimpimConfigDir(home), "machine.json");
export const envShPath = (home: string) => path.join(yimpimConfigDir(home), "env.sh");
export const sdksDir = (home: string) => path.join(home, "sdks");
export const localBin = (home: string) => path.join(home, ".local", "bin");

/** Whether an emulator is worth installing here: Linux needs a usable /dev/kvm; macOS has its own acceleration. Anything else has none. */
export function emulatorUsable(m: MachineInfo): boolean {
  if (m.platform === "darwin") return true;
  return m.platform === "linux" && m.kvm.present && m.kvm.accessible;
}

/** The ABI of an Android system image for this host: the one that runs natively. */
export const androidAbi = (m: MachineInfo) => (m.arch === "arm64" ? "arm64-v8a" : "x86_64");

export interface MachineRecord {
  schema: 1;
  platform: string;
  arch: string;
  distro?: string;
  kvm: { present: boolean; accessible: boolean };
  /** No usable emulator here: QA uses Expo Web and unit tests instead of waiting on a device that will never start. */
  headlessWebQaOnly: boolean;
  javaHome?: string;
  installed: Record<string, string>;
  /** Every download that was verified: what, where from, and the digest it matched. */
  artifacts: { name: string; url: string; algorithm: string; digest: string; sha256: string }[];
  updatedAt: string;
}

export function readMachineRecord(home: string): MachineRecord | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(machineJsonPath(home), "utf8"));
    return j && j.schema === 1 ? (j as MachineRecord) : undefined;
  } catch {
    return undefined;
  }
}
