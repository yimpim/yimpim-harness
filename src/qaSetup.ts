/**
 * Per-repo QA setup: what the web probe must arrange BEFORE QA looks at the app,
 * so it can reach screens that sit behind state (a paired session, a signed-in
 * user, onboarding already done) and exercise browser-side stand-ins for native
 * features (camera, file picker).
 *
 * Stored in .agent/qa-setup.json, written by the Editor/Discovery through the
 * register_qa_setup tool, because they are the ones who can see how the app
 * decides it is "logged in" or "paired". Nothing here is specific to one app:
 * it is plain browser state (a start path, localStorage entries) plus two
 * pointers to files in the repo (an image for the fake camera, files for a file
 * chooser). QA never invents any of it.
 */

import fsSync from "fs";
import path from "path";

export interface QaSetup {
  /** Path (+query/hash) opened instead of the site root, e.g. "/home?demo=1". */
  launchPath?: string;
  /** Entries written to localStorage before any app code runs. */
  localStorage?: Record<string, string>;
  /** Repo-relative image the fake camera shows (e.g. a QR code to scan). */
  cameraImage?: string;
  /** Repo-relative files handed to any file chooser the app opens. */
  uploadFiles?: string[];
  /** Free text: what this setup represents, for humans and the QA model. */
  notes?: string;
  /** Screens QA can open directly (a custom scheme the app handles, a universal link, or a route starting with "/"). Opened by the Android and iOS probes' open_link. */
  deepLinks?: { name: string; url: string }[];
  /** Variables the app is started with for QA (only the kinds an app reads at build time and that are never secret). */
  env?: Record<string, string>;
  /** What is mocked or toggled for QA, and where it is switched on. Listed in the QA evidence so a person can see it. */
  mockNotes?: string;
  updatedAt?: string;
}

const MAX_STORAGE_KEYS = 50;
const MAX_KEY_LEN = 200;
const MAX_VALUE_LEN = 20_000;
const MAX_UPLOAD_FILES = 5;
const MAX_DEEP_LINKS = 10;
const MAX_ENV = 20;
const MAX_ENV_VALUE = 200;
/** Only variables an app reads to pick its mode, named so that nothing secret-shaped can be set. */
const QA_ENV_NAME = /^(EXPO_PUBLIC_|VITE_|NEXT_PUBLIC_|REACT_APP_|QA_|MOCK_)[A-Z0-9_]*$/;
/** A scheme that opens something in the app. Never one that runs code or reads a file. */
const BAD_SCHEME = /^(javascript|data|file|vbscript|blob|about):/i;

// Files that could hold secrets are never offered to a page as an upload or
// shown to a camera, whatever the model asked for.
const SENSITIVE_FILE = /(^|[\\/])(\.env(\..*)?|id_rsa.*|.*\.pem|.*\.key|.*\.p12|\.npmrc|\.git[\\/].*)$/i;

function setupPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "qa-setup.json");
}

export function loadQaSetup(repoRoot: string): QaSetup {
  try {
    return sanitizeQaSetup(JSON.parse(fsSync.readFileSync(setupPath(repoRoot), "utf-8")));
  } catch {
    return {};
  }
}

/** A start path must stay on the app's own origin: relative, not "//host". */
export function isSafeLaunchPath(p: string): boolean {
  if (!p || p.length > 500) return false;
  if (!/^[/?#]/.test(p)) return false;
  if (p.startsWith("//") || p.startsWith("/\\") || p.includes("\\")) return false;
  return !/[\r\n]/.test(p);
}

/** A repo-relative path that stays inside the repo and is not secret-looking. */
export function isSafeRepoRelativePath(p: string): boolean {
  if (!p || p.length > 300 || path.isAbsolute(p)) return false;
  const norm = path.normalize(p);
  if (norm.startsWith("..") || norm.split(path.sep).includes("..")) return false;
  return !SENSITIVE_FILE.test(norm);
}

/** A deep link is a URL with a scheme the app handles, or a route starting with a single "/". */
export function isSafeDeepLink(u: string): boolean {
  if (!u || u.length > 500 || /[\r\n\s]/.test(u)) return false;
  if (u.startsWith("/")) return !u.startsWith("//") && !u.includes("\\");
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/?\S+/.test(u) && !BAD_SCHEME.test(u);
}

export function isSafeQaEnvName(n: string): boolean {
  return QA_ENV_NAME.test(n);
}

export function sanitizeQaSetup(raw: any): QaSetup {
  const out: QaSetup = {};
  if (!raw || typeof raw !== "object") return out;

  if (typeof raw.launchPath === "string" && isSafeLaunchPath(raw.launchPath.trim())) {
    out.launchPath = raw.launchPath.trim();
  }

  // Accepts either {key: value} or the tool's [{key, value}] array form.
  const entries: [unknown, unknown][] = Array.isArray(raw.localStorage)
    ? raw.localStorage.map((e: any) => [e?.key, e?.value])
    : raw.localStorage && typeof raw.localStorage === "object"
      ? Object.entries(raw.localStorage)
      : [];
  const storage: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || !k || k.length > MAX_KEY_LEN) continue;
    const value = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    if (value.length > MAX_VALUE_LEN) continue;
    if (Object.keys(storage).length >= MAX_STORAGE_KEYS) break;
    storage[k] = value;
  }
  if (Object.keys(storage).length > 0) out.localStorage = storage;

  if (typeof raw.cameraImage === "string" && isSafeRepoRelativePath(raw.cameraImage.trim())) {
    out.cameraImage = raw.cameraImage.trim();
  }
  if (Array.isArray(raw.uploadFiles)) {
    const files = raw.uploadFiles
      .filter((f: unknown): f is string => typeof f === "string" && isSafeRepoRelativePath(f.trim()))
      .map((f: string) => f.trim())
      .slice(0, MAX_UPLOAD_FILES);
    if (files.length > 0) out.uploadFiles = files;
  }
  if (Array.isArray(raw.deepLinks)) {
    const links: { name: string; url: string }[] = [];
    for (const l of raw.deepLinks) {
      const url = typeof l?.url === "string" ? l.url.trim() : "";
      const name = typeof l?.name === "string" ? l.name.trim().slice(0, 60) : "";
      if (!name || !isSafeDeepLink(url) || links.some((x) => x.name === name)) continue;
      links.push({ name, url });
      if (links.length >= MAX_DEEP_LINKS) break;
    }
    if (links.length > 0) out.deepLinks = links;
  }
  // Accepts {NAME: value} or the tool's [{name, value}] array form. A name that is not one of the allowed kinds, or a value that is not a short string, is dropped.
  const envEntries: [unknown, unknown][] = Array.isArray(raw.env) ? raw.env.map((e: any) => [e?.name, e?.value]) : raw.env && typeof raw.env === "object" ? Object.entries(raw.env) : [];
  const env: Record<string, string> = {};
  for (const [k, v] of envEntries) {
    if (typeof k !== "string" || !isSafeQaEnvName(k) || typeof v !== "string" || v.length > MAX_ENV_VALUE || /[\r\n]/.test(v)) continue;
    if (Object.keys(env).length >= MAX_ENV) break;
    env[k] = v;
  }
  if (Object.keys(env).length > 0) out.env = env;
  if (typeof raw.mockNotes === "string" && raw.mockNotes.trim()) out.mockNotes = raw.mockNotes.trim().slice(0, 500);
  if (typeof raw.notes === "string" && raw.notes.trim()) out.notes = raw.notes.trim().slice(0, 1000);
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  return out;
}

/** Merge a patch into what is stored: storage keys accumulate (a later value
 *  for the same key wins); every other field is replaced when the patch gives
 *  one. Returns what was actually kept after validation. */
export function saveQaSetup(repoRoot: string, patch: unknown): QaSetup {
  const incoming = sanitizeQaSetup(patch);
  const current = loadQaSetup(repoRoot);
  const merged: QaSetup = {
    ...current,
    ...incoming,
    ...(current.localStorage || incoming.localStorage
      ? { localStorage: { ...current.localStorage, ...incoming.localStorage } }
      : {}),
    // Links accumulate by name (a later url for the same name wins) and variables accumulate by name, like the storage keys.
    ...(current.deepLinks || incoming.deepLinks
      ? { deepLinks: [...(current.deepLinks ?? []).filter((c) => !(incoming.deepLinks ?? []).some((i) => i.name === c.name)), ...(incoming.deepLinks ?? [])].slice(0, MAX_DEEP_LINKS) }
      : {}),
    ...(current.env || incoming.env ? { env: { ...current.env, ...incoming.env } } : {}),
    updatedAt: new Date().toISOString(),
  };
  try {
    fsSync.mkdirSync(path.dirname(setupPath(repoRoot)), { recursive: true });
    fsSync.writeFileSync(setupPath(repoRoot), JSON.stringify(merged, null, 2), "utf-8");
  } catch {}
  return merged;
}

/** The variables the app is started with for QA (already restricted to the allowed names). */
export function qaEnvFor(repoRoot: string): Record<string, string> {
  return loadQaSetup(repoRoot).env ?? {};
}

/** What has been arranged for QA beyond sign-in state, as one readable block for the QA evidence; empty when nothing has. */
export function describeQaAccess(setup: QaSetup): string {
  const lines: string[] = [];
  if (setup.mockNotes) lines.push(`mocked or toggled for QA: ${setup.mockNotes}`);
  if (setup.env && Object.keys(setup.env).length > 0) lines.push(`started with: ${Object.entries(setup.env).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (setup.deepLinks?.length) lines.push(`deep links: ${setup.deepLinks.map((l) => `${l.name} → ${l.url}`).join(", ")}`);
  return lines.join("; ");
}

/** Absolute path of a repo-relative file if it exists and stays in the repo. */
export function resolveRepoFile(repoRoot: string, rel: string): string | undefined {
  if (!isSafeRepoRelativePath(rel)) return undefined;
  const abs = path.resolve(repoRoot, rel);
  if (path.relative(repoRoot, abs).startsWith("..")) return undefined;
  try {
    return fsSync.statSync(abs).isFile() ? abs : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- fake camera

/** BT.601 full-range RGBA -> planar I420 frames in a YUV4MPEG2 stream, the
 *  format Chromium's --use-file-for-fake-video-capture reads (it loops it). */
export function rgbaToY4m(rgba: Uint8Array, width: number, height: number, frames = 5): Buffer {
  if (width % 2 || height % 2) throw new Error("y4m needs even dimensions");
  const y = Buffer.alloc(width * height);
  const u = Buffer.alloc((width / 2) * (height / 2));
  const v = Buffer.alloc((width / 2) * (height / 2));
  const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = (j * width + i) * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      y[j * width + i] = clamp(0.299 * r + 0.587 * g + 0.114 * b);
      if (j % 2 === 0 && i % 2 === 0) {
        const c = (j / 2) * (width / 2) + i / 2;
        u[c] = clamp(-0.169 * r - 0.331 * g + 0.5 * b + 128);
        v[c] = clamp(0.5 * r - 0.419 * g - 0.081 * b + 128);
      }
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, u, v]);
  return Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]);
}

const CAMERA_W = 640;
const CAMERA_H = 480;

/**
 * Renders an image (letterboxed on white, so a QR code keeps its quiet zone)
 * into a .y4m file for the fake camera. Uses a throwaway headless Chromium to
 * decode the image because this project has no image library; it has to be
 * done BEFORE the probe's own browser launches since the file path is a launch
 * flag. Returns undefined if anything goes wrong — the probe then falls back
 * to Chromium's built-in test pattern.
 */
export async function writeFakeCameraFeed(playwrightMod: any, imageFile: string, outFile: string): Promise<string | undefined> {
  let browser: any;
  try {
    const bytes = fsSync.readFileSync(imageFile);
    const ext = path.extname(imageFile).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
    const src = `data:${mime};base64,${bytes.toString("base64")}`;

    browser = await playwrightMod.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const b64: string = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const w = ${CAMERA_W}, h = ${CAMERA_H};
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      const s = Math.min(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      const d = g.getImageData(0, 0, w, h).data;
      let out = '';
      for (let i = 0; i < d.length; i += 8192) out += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
      return btoa(out);
    })()`);
    fsSync.writeFileSync(outFile, rgbaToY4m(Buffer.from(b64, "base64"), CAMERA_W, CAMERA_H));
    return outFile;
  } catch {
    return undefined;
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

// 1x1 transparent PNG + a short text file: what a file chooser gets when the
// app asks for a file and no uploadFiles were registered, so a picker never
// just hangs waiting.
export const DEFAULT_SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
