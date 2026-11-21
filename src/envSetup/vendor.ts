/**
 * Reading what each vendor publishes, so no version and no checksum is written into this program. Each function takes the vendor's own data and the host's platform and
 * architecture and picks the right build; none of them touches the network or the disk.
 */
import type { MachineInfo } from "./machine.js";

// ------------------------------------------------------------------------------------------------------------------------ fnm (GitHub release, with GitHub's own sha256 digest per asset)

export interface GithubRelease {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string; digest?: string }[];
}
export interface PickedAsset {
  name: string;
  url: string;
  /** The vendor's published SHA-256 (hex). */
  sha256: string;
}

/** fnm ships fnm-linux.zip (x64), fnm-arm64.zip (Linux arm64) and fnm-macos.zip. */
export function pickFnmAsset(release: GithubRelease, m: Pick<MachineInfo, "platform" | "arch">): PickedAsset | undefined {
  const name = m.platform === "darwin" ? "fnm-macos.zip" : m.platform === "linux" ? (m.arch === "arm64" ? "fnm-arm64.zip" : m.arch === "x64" ? "fnm-linux.zip" : "") : "";
  const a = release.assets?.find((x) => x.name === name);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(a?.digest ?? "")?.[1];
  return a && digest ? { name: a.name, url: a.browser_download_url, sha256: digest.toLowerCase() } : undefined;
}

// ------------------------------------------------------------------------------------------------------------------------ uv (tar.gz + a .sha256 file next to each)

export function uvTarget(m: Pick<MachineInfo, "platform" | "arch">): string | undefined {
  const arch = m.arch === "arm64" ? "aarch64" : m.arch === "x64" ? "x86_64" : undefined;
  const os = m.platform === "darwin" ? "apple-darwin" : m.platform === "linux" ? "unknown-linux-gnu" : undefined;
  return arch && os ? `uv-${arch}-${os}.tar.gz` : undefined;
}

export function pickUvAssets(release: GithubRelease, m: Pick<MachineInfo, "platform" | "arch">): { archive: { name: string; url: string }; checksum: { name: string; url: string } } | undefined {
  const name = uvTarget(m);
  if (!name) return undefined;
  const archive = release.assets?.find((a) => a.name === name);
  const checksum = release.assets?.find((a) => a.name === `${name}.sha256`);
  return archive && checksum ? { archive: { name: archive.name, url: archive.browser_download_url }, checksum: { name: checksum.name, url: checksum.browser_download_url } } : undefined;
}

// ------------------------------------------------------------------------------------------------------------------------ Android command-line tools (Google's repository XML)

export interface AndroidArchive {
  url: string;
  checksum: string;
  /** The build number in the file name: the highest is the newest. */
  build: number;
}

/**
 * The newest "cmdline-tools;latest" archive for this host in Google's repository XML. Google publishes a SHA-1 checksum here (not SHA-256), which verifyChecksum accepts in the
 * algorithm it was published in.
 */
export function parseAndroidRepository(xml: string, m: Pick<MachineInfo, "platform">): AndroidArchive | undefined {
  const hostOs = m.platform === "darwin" ? "macosx" : m.platform === "linux" ? "linux" : undefined;
  if (!hostOs) return undefined;
  const pkg = /<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/.exec(xml)?.[1];
  if (!pkg) return undefined;
  let best: AndroidArchive | undefined;
  for (const a of pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const body = a[1];
    if (new RegExp(`<host-os>${hostOs}</host-os>`).exec(body) === null) continue;
    const url = /<url>\s*([^<\s]+)\s*<\/url>/.exec(body)?.[1];
    const checksum = /<checksum[^>]*>\s*([0-9a-fA-F]+)\s*<\/checksum>/.exec(body)?.[1];
    const build = Number(/commandlinetools-[a-z0-9_]+-(\d+)_latest\.zip$/.exec(url ?? "")?.[1]);
    if (!url || !checksum || !Number.isFinite(build)) continue;
    if (!best || build > best.build) best = { url, checksum: checksum.toLowerCase(), build };
  }
  return best;
}

const versionParts = (v: string) => v.split(".").map((n) => Number(n));
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface SdkChoice {
  platform?: string;
  buildTools?: string;
  systemImage?: string;
}

/**
 * From `sdkmanager --list`: the highest stable platform (`platforms;android-36`, never an -ext, preview or letter-named one), the highest stable build-tools whose major matches it
 * (else the highest stable), and, when asked, the newest Google APIs system image for the host's ABI.
 */
export function chooseSdkPackages(list: string, abi?: string): SdkChoice {
  const ids = new Set<string>();
  for (const line of list.split(/\r?\n/)) {
    const id = /^\s*([a-z0-9_;.\-]+)\s*\|/i.exec(line)?.[1];
    if (id) ids.add(id);
  }
  const platforms = [...ids].map((i) => /^platforms;android-(\d+)$/.exec(i)?.[1]).filter((x): x is string => Boolean(x)).map(Number).sort((a, b) => b - a);
  const tools = [...ids].map((i) => /^build-tools;(\d+\.\d+\.\d+)$/.exec(i)?.[1]).filter((x): x is string => Boolean(x)).sort((a, b) => compareVersions(b, a));
  const out: SdkChoice = {};
  if (platforms.length > 0) {
    out.platform = `platforms;android-${platforms[0]}`;
    out.buildTools = tools.find((t) => Number(t.split(".")[0]) === platforms[0]) ?? tools[0];
  } else if (tools.length > 0) {
    out.buildTools = tools[0];
  }
  if (out.buildTools) out.buildTools = `build-tools;${out.buildTools}`;
  if (abi) {
    for (const p of platforms) {
      const img = ["google_apis", "google_apis_playstore"].map((v) => `system-images;android-${p};${v};${abi}`).find((i) => ids.has(i));
      if (img) {
        out.systemImage = img;
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ Flutter (the official releases JSON, with a sha256 per archive)

export interface FlutterRelease {
  hash: string;
  channel: string;
  version: string;
  dart_sdk_arch?: string;
  archive: string;
  sha256: string;
}
export interface FlutterReleases {
  base_url?: string;
  current_release?: { stable?: string };
  releases?: FlutterRelease[];
}

/**
 * The git commit Flutter publishes as the current stable release. Flutter publishes NO Linux arm64 archive (its releases JSON has x64 builds only), so on ARM64 Linux the SDK is fetched
 * from Flutter's own repository at exactly this commit and refused unless the commit it received is this one.
 */
export function flutterStableHash(json: FlutterReleases): string | undefined {
  const h = json.current_release?.stable;
  return h && /^[0-9a-f]{40}$/i.test(h) ? h.toLowerCase() : undefined;
}

/** The version (and so the git tag) of that stable release, from the same releases JSON. */
export function flutterStableVersion(json: FlutterReleases): string | undefined {
  const h = json.current_release?.stable;
  const v = json.releases?.find((r) => r.hash === h && r.channel === "stable")?.version;
  return v && /^[0-9][0-9A-Za-z.+_-]*$/.test(v) ? v : undefined;
}

export function flutterReleasesUrl(m: Pick<MachineInfo, "platform">): string | undefined {
  return m.platform === "linux" ? "https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json" : m.platform === "darwin" ? "https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json" : undefined;
}

/** The current stable release for this host's architecture. A release with no `dart_sdk_arch` is the x64 build (older entries do not say). */
export function pickFlutterRelease(json: FlutterReleases, m: Pick<MachineInfo, "arch">): { version: string; url: string; sha256: string; kind: "tar.xz" | "zip" } | undefined {
  const hash = json.current_release?.stable;
  if (!hash || !json.base_url) return undefined;
  const arch = m.arch === "arm64" ? "arm64" : "x64";
  const r = json.releases?.find((x) => x.hash === hash && x.channel === "stable" && (x.dart_sdk_arch ?? "x64") === arch);
  if (!r || !/^[0-9a-f]{64}$/i.test(r.sha256)) return undefined;
  const kind = r.archive.endsWith(".tar.xz") ? "tar.xz" : r.archive.endsWith(".zip") ? "zip" : undefined;
  return kind ? { version: r.version, url: `${json.base_url.replace(/\/$/, "")}/${r.archive}`, sha256: r.sha256.toLowerCase(), kind } : undefined;
}
