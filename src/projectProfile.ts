/**
 * Project detection. Nothing here is hardcoded to a single app:
 * package names, gradle modules, APK paths, dev ports and entrypoints are all
 * derived from the repository being verified.
 */

import fsSync from "fs";
import fs from "fs/promises";
import path from "path";

export type StackKind =
  | "android"
  | "ios"
  | "react-native"
  | "flutter"
  | "dotnet"
  | "go"
  | "rust"
  | "web"
  | "python-web"
  | "python-desktop"
  | "desktop"
  | "firmware"
  | "cli";

export interface AndroidProfile {
  /** Gradle module dir relative to repo root, e.g. "app". */
  moduleDir: string;
  /** Gradle task path, e.g. ":app:assembleDebug". */
  assembleTask: string;
  applicationId?: string;
  /** Where APKs land for this module. */
  apkOutputDir: string;
}

export interface IOSProfile {
  /** Path to the .xcworkspace or .xcodeproj, relative to repo root. */
  projectPath: string;
  isWorkspace: boolean;
  bundleId?: string;
  /** xcodebuild writes here explicitly, so the built .app is always findable
   *  rather than hunting through Xcode's default (unpredictable) DerivedData. */
  derivedDataPath: string;
}

export interface ReactNativeProfile {
  hasIOS: boolean;
  hasAndroid: boolean;
  isExpo: boolean;
  /** Only populated when isExpo — same lockfile-based detection as WebProfile's. */
  packageManager?: "npm" | "pnpm" | "yarn";
  /**
   * Best-guess URLs for Expo's web dev server (`expo start --web`), same
   * role as WebProfile's own candidateUrls — startServer tries to detect the
   * real URL from the process's own stdout first and only falls back to
   * these. Expo's web target has moved ports across SDK versions (older
   * webpack-based web on 19006, newer Metro-web typically on 8081, `expo
   * start` itself sometimes on 19000), so all three are listed rather than
   * guessing one. Empty when not Expo — nothing needs it.
   */
  candidateUrls: string[];
}

export interface FirmwareProfile {
  framework: "platformio" | "arduino" | "esp-idf";
  /** Directory of the project relative to the repo root ("." for the root). */
  dir: string;
  board?: string;
  environments: string[];
  /** Arguments for the framework's tool (pio, arduino-cli, idf.py). COMPILE
   *  ONLY: never an upload or flash. Absent when it cannot be compiled yet. */
  buildCommand?: string[];
  /** Why there is no buildCommand. */
  buildNote?: string;
  /** Host-side tests (a PlatformIO "native" env): run on this machine, never on a board. */
  hostTestCommand?: string[];
}

export interface FlutterProfile {
  hasIOS: boolean;
  hasAndroid: boolean;
}

export interface DotnetProfile {
  /** .sln if present, else a .csproj, relative to repo root. */
  projectFile: string;
  isWeb: boolean;
  candidateUrls: string[];
}

export interface WebProfile {
  /** Absent for a bare static page with no package.json at all. */
  packageManager?: "npm" | "pnpm" | "yarn";
  /** Script name to launch a dev server, if any. */
  devScript?: string;
  /** Script name that performs a production build / typecheck, if any. */
  buildScript?: string;
  /** Best-guess URLs to try if the server never prints one. */
  candidateUrls: string[];
  /** For a plain HTML/CSS/JS page with no build step: opened directly via file://. */
  entryFile?: string;
}

export interface PythonProfile {
  kind: "web" | "desktop";
  framework: string;
  /** argv (after the python binary) to launch the app. */
  launchArgs: string[];
  entryFile: string;
  candidateUrls: string[];
}

export interface ProjectProfile {
  stacks: StackKind[];
  primary: StackKind;
  android?: AndroidProfile;
  ios?: IOSProfile;
  reactNative?: ReactNativeProfile;
  flutter?: FlutterProfile;
  dotnet?: DotnetProfile;
  web?: WebProfile;
  python?: PythonProfile;
  firmware?: FirmwareProfile;
  /** Discovered, ordered verification commands as [bin, ...args]. */
  testCommands: string[][];
  notes: string[];
}

const exists = (p: string) => fsSync.existsSync(p);

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/** Shallow directory walk with a depth cap, skipping heavy/vendor dirs. */
async function walk(root: string, maxDepth: number): Promise<string[]> {
  const skip = new Set([
    "node_modules", ".git", "build", "dist", ".gradle", ".agent", ".idea",
    "venv", ".venv", "__pycache__", ".next", ".nuxt", "target", "vendor", "site-packages",
  ]);
  const out: string[] = [];

  async function rec(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full, depth + 1);
      } else {
        out.push(full);
      }
    }
  }
  await rec(root, 0);
  return out;
}

/**
 * Resolves the version-catalog accessor for a plugin id, e.g. "com.android.application"
 * -> "android.application" for `alias(libs.plugins.android.application)`. Modern Android
 * Studio templates default to version catalogs and declare the plugin id only in
 * gradle/libs.versions.toml, applying it via `alias(...)` rather than the classic
 * `id("com.android.application")` — without resolving this, that literal string never
 * appears in the module's build script at all, and a plainly-Android project is invisible
 * to detection.
 */
async function resolveCatalogPluginAccessor(repoRoot: string, pluginId: string): Promise<string | undefined> {
  const content = await readIfExists(path.join(repoRoot, "gradle", "libs.versions.toml"));
  if (!content) return undefined;

  const pluginsBlock = content.match(/\[plugins\]([\s\S]*?)(?:\n\[|$)/);
  if (!pluginsBlock) return undefined;

  const idPattern = pluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Both the table form (`key = { id = "..." }`) and the inline shorthand (`key = "id:version"`).
  const entry = pluginsBlock[1].match(new RegExp(`^([A-Za-z0-9_-]+)\\s*=\\s*(?:\\{[^}]*id\\s*=\\s*"${idPattern}"|"${idPattern}:)`, "m"));
  if (!entry) return undefined;

  // Gradle turns "-" in the TOML key into "." path segments for the generated accessor.
  return entry[1].replace(/-/g, ".");
}

// ---------------------------------------------------------------- Android

async function detectAndroid(repoRoot: string): Promise<AndroidProfile | undefined> {
  const hasGradle =
    exists(path.join(repoRoot, "settings.gradle")) ||
    exists(path.join(repoRoot, "settings.gradle.kts")) ||
    exists(path.join(repoRoot, "build.gradle")) ||
    exists(path.join(repoRoot, "build.gradle.kts"));
  if (!hasGradle) return undefined;

  const catalogAccessor = await resolveCatalogPluginAccessor(repoRoot, "com.android.application");
  const catalogAliasRegex = catalogAccessor
    ? new RegExp(`alias\\(\\s*libs\\.plugins\\.${catalogAccessor.replace(/\./g, "\\.")}\\s*\\)`)
    : undefined;
  const isAndroidAppModule = (content: string) =>
    /com\.android\.application/.test(content) || (catalogAliasRegex?.test(content) ?? false);

  // Find the application module: a subdirectory whose build script applies the
  // Android application plugin. Falls back to "app" by convention.
  let moduleDir: string | undefined;
  let moduleBuildScript: string | null = null;

  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    for (const bs of ["build.gradle.kts", "build.gradle"]) {
      const p = path.join(repoRoot, e.name, bs);
      const content = await readIfExists(p);
      if (!content) continue;
      if (isAndroidAppModule(content)) {
        moduleDir = e.name;
        moduleBuildScript = content;
        break;
      }
    }
    if (moduleDir) break;
  }

  if (!moduleDir) {
    // Single-module project: the root build script may itself be the app.
    for (const bs of ["build.gradle.kts", "build.gradle"]) {
      const content = await readIfExists(path.join(repoRoot, bs));
      if (content && isAndroidAppModule(content)) {
        moduleDir = ".";
        moduleBuildScript = content;
        break;
      }
    }
  }

  if (!moduleDir) return undefined;

  // applicationId, else namespace, else the manifest package attribute.
  let applicationId: string | undefined;
  if (moduleBuildScript) {
    const appId =
      moduleBuildScript.match(/applicationId\s*=?\s*["']([A-Za-z0-9_.]+)["']/) ||
      moduleBuildScript.match(/namespace\s*=?\s*["']([A-Za-z0-9_.]+)["']/);
    if (appId) applicationId = appId[1];
  }
  if (!applicationId) {
    const manifest = await readIfExists(
      path.join(repoRoot, moduleDir, "src", "main", "AndroidManifest.xml")
    );
    const pkg = manifest?.match(/package\s*=\s*"([A-Za-z0-9_.]+)"/);
    if (pkg) applicationId = pkg[1];
  }

  const modulePath = moduleDir === "." ? repoRoot : path.join(repoRoot, moduleDir);
  const assembleTask = moduleDir === "." ? "assembleDebug" : `:${moduleDir}:assembleDebug`;

  return {
    moduleDir,
    assembleTask,
    applicationId,
    apkOutputDir: path.join(modulePath, "build", "outputs", "apk"),
  };
}

/** Newest .apk anywhere under the module output dir (flavor/variant agnostic). */
export function findNewestApk(apkOutputDir: string): string | null {
  if (!exists(apkOutputDir)) return null;
  const found: { p: string; mtime: number }[] = [];

  const rec = (dir: string) => {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.name.endsWith(".apk")) {
        try {
          found.push({ p: full, mtime: fsSync.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  rec(apkOutputDir);

  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.p ?? null;
}

// --------------------------------------------------------------------- iOS

/**
 * Scheme resolution needs a real `xcodebuild -list` call, which belongs at
 * build time (verifierTools already shells out there), not here — detection
 * stays pure file inspection, exactly like every other detector in this file,
 * so it costs nothing and never depends on Xcode being installed to even
 * recognise "this is an iOS project."
 */
async function detectIOS(repoRoot: string): Promise<IOSProfile | undefined> {
  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // A workspace usually means CocoaPods or SPM wired things together; building
  // the bare .xcodeproj instead would silently skip that and fail to link.
  const workspace = entries.find((e) => e.name.endsWith(".xcworkspace"));
  const xcodeproj = entries.find((e) => e.name.endsWith(".xcodeproj"));
  const found = workspace ?? xcodeproj;
  if (!found) return undefined;

  return {
    projectPath: found.name,
    isWorkspace: Boolean(workspace),
    bundleId: await findBundleId(repoRoot),
    derivedDataPath: path.join(repoRoot, ".agent", "ios-build"),
  };
}

async function findBundleId(repoRoot: string): Promise<string | undefined> {
  const plists = (await walk(repoRoot, 3)).filter((f) => path.basename(f) === "Info.plist");
  for (const p of plists.slice(0, 8)) {
    const content = await readIfExists(p);
    const m = content?.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    // An unresolved build-setting placeholder (e.g. $(PRODUCT_BUNDLE_IDENTIFIER))
    // is worse than no answer — it would look resolved but launch nothing.
    if (m && !m[1].includes("$(")) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------- React Native

/** Shared by detectWeb and detectReactNative -- same lockfile-based detection either way. */
function detectPackageManager(repoRoot: string): "npm" | "pnpm" | "yarn" {
  return exists(path.join(repoRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : exists(path.join(repoRoot, "yarn.lock"))
      ? "yarn"
      : "npm";
}

async function detectReactNative(repoRoot: string): Promise<ReactNativeProfile | undefined> {
  const raw = await readIfExists(path.join(repoRoot, "package.json"));
  if (!raw) return undefined;
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (!deps["react-native"] && !deps["expo"]) return undefined;

  const isExpo = Boolean(deps["expo"]);

  return {
    hasIOS: exists(path.join(repoRoot, "ios")),
    hasAndroid: exists(path.join(repoRoot, "android")),
    isExpo,
    packageManager: isExpo ? detectPackageManager(repoRoot) : undefined,
    candidateUrls: isExpo ? ["http://localhost:8081", "http://localhost:19006", "http://localhost:19000"] : [],
  };
}

// --------------------------------------------------------------- Flutter

async function detectFlutter(repoRoot: string): Promise<FlutterProfile | undefined> {
  const content = await readIfExists(path.join(repoRoot, "pubspec.yaml"));
  // A plain Dart package has a pubspec.yaml too; only a "flutter:" section
  // (SDK dependency, or the standard config block) means an actual app.
  if (!content || !/^\s*flutter:/m.test(content)) return undefined;

  return {
    hasIOS: exists(path.join(repoRoot, "ios")),
    hasAndroid: exists(path.join(repoRoot, "android")),
  };
}

// ---------------------------------------------------------------- .NET

async function detectDotnet(repoRoot: string): Promise<DotnetProfile | undefined> {
  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sln = entries.find((e) => e.name.endsWith(".sln"));
  const csproj = entries.find((e) => e.name.endsWith(".csproj"));
  const found = sln ?? csproj;
  if (!found) return undefined;

  const content = csproj ? await readIfExists(path.join(repoRoot, csproj.name)) : null;
  const isWeb = Boolean(content && /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/.test(content));

  return {
    projectFile: found.name,
    isWeb,
    candidateUrls: isWeb ? ["http://localhost:5000", "https://localhost:5001", "http://localhost:5173"] : [],
  };
}

/** Newest .app bundle anywhere under the derived data dir. A .app is a
 *  directory, not a file, and is never recursed into once matched. */
export function findNewestIOSApp(derivedDataPath: string): string | null {
  if (!exists(derivedDataPath)) return null;
  const found: { p: string; mtime: number }[] = [];

  const rec = (dir: string) => {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith(".app")) {
        try {
          found.push({ p: full, mtime: fsSync.statSync(full).mtimeMs });
        } catch {}
      } else {
        rec(full);
      }
    }
  };
  rec(derivedDataPath);

  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.p ?? null;
}

// -------------------------------------------------------------------- Web

/**
 * Marker files that unambiguously identify a project as a plugin/extension
 * hosted INSIDE another application — Power BI, VS Code, a browser, Office,
 * Figma — rather than a standalone page. These toolchains commonly wire up a
 * generic "start"/"dev" package.json script too (pbiviz, vsce, and web-ext
 * all do this), which on its own used to be enough for detectWeb to treat
 * one as an ordinary browsable web app. Pointing a headless browser at that
 * dev server shows a blank page or a cert warning, never the actual UI —
 * and QA then judges THAT as broken code, instead of recognizing there was
 * never anything real to look at. Deliberately conservative: only fires on
 * an exact, well-known marker file, never a guess — a project with none of
 * these markers (an ordinary React/Vue/Svelte app) is completely unaffected
 * regardless of what scripts or dependencies it has. Overrides even a real
 * UI framework dependency once it DOES fire, since a marker match means the
 * host is known — a VS Code webview or Figma plugin panel can be built with
 * React internally, but that doesn't change WHERE it renders: still only
 * inside that host, never at a plain localhost URL a browser can visit.
 */
async function detectPluginHost(repoRoot: string): Promise<string | undefined> {
  if (exists(path.join(repoRoot, "pbiviz.json"))) return "Power BI custom visual (pbiviz.json)";

  const pkgRaw = await readIfExists(path.join(repoRoot, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.engines?.vscode) return "VS Code extension (engines.vscode)";
    } catch {}
  }

  const manifestRaw = await readIfExists(path.join(repoRoot, "manifest.json"));
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(manifestRaw);
      if (
        typeof manifest.manifest_version === "number" &&
        (manifest.background || manifest.content_scripts || manifest.action || manifest.browser_action)
      ) {
        return "browser extension (manifest.json)";
      }
      if (Array.isArray(manifest.editorType) && typeof manifest.api === "string") {
        return "Figma/FigJam plugin (manifest.json)";
      }
    } catch {}
  }

  // Office/Excel/Word add-ins declare themselves via an XML manifest, not
  // JSON — the schema URL is the one string that's actually diagnostic.
  try {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.xml$/i.test(e.name)) continue;
      const content = await readIfExists(path.join(repoRoot, e.name));
      if (content && /schemas\.microsoft\.com\/office\/appforoffice/i.test(content)) {
        return `Office/Excel add-in (${e.name})`;
      }
    }
  } catch {}

  return undefined;
}

async function detectWeb(repoRoot: string, pluginHost?: string): Promise<WebProfile | undefined> {
  const raw = await readIfExists(path.join(repoRoot, "package.json"));
  if (!raw) return undefined;

  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const scripts: Record<string, string> = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // React Native / Expo components extend React, so `react` is a dependency
  // there too — without this check, Metro's dev server gets treated as a
  // browsable web app and a browser gets pointed at it, which is not what it
  // serves. detectReactNative handles this stack instead.
  if (deps["react-native"] || deps["expo"]) return undefined;

  const devScript = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
  // Prefer a cheap typecheck over a full production build when both exist.
  const buildScript = ["typecheck", "check", "build", "compile"].find((s) => scripts[s]);

  const packageManager = detectPackageManager(repoRoot);

  // Only treat it as a *visual* web project when a UI framework is present.
  const uiHint = Boolean(
    deps.next || deps.react || deps.vue || deps.svelte || deps.astro ||
    deps.vite || deps.nuxt || deps["@angular/core"] || deps.solid_js || deps["solid-js"]
  );

  const candidateUrls: string[] = [];
  if (deps.vite || deps.svelte || deps["solid-js"]) candidateUrls.push("http://localhost:5173");
  if (deps.next || deps.react) candidateUrls.push("http://localhost:3000");
  if (deps.nuxt) candidateUrls.push("http://localhost:3000");
  if (deps.astro) candidateUrls.push("http://localhost:4321");
  if (deps["@angular/core"]) candidateUrls.push("http://localhost:4200");
  if (exists(path.join(repoRoot, "wrangler.toml"))) candidateUrls.push("http://localhost:8787");
  candidateUrls.push("http://localhost:3000", "http://localhost:8080", "http://localhost:5000");

  if (!devScript && !buildScript && !uiHint) return undefined;

  // A recognized plugin-host marker overrides EVERY other signal here,
  // including uiHint: a VS Code webview or a Figma plugin panel can very
  // well be built with React internally, but that doesn't change WHERE it
  // renders — still only inside that host, never at a plain localhost URL a
  // browser can visit on its own. The framework dependency that trips uiHint
  // was never evidence this is independently browsable in the first place.
  if (pluginHost) return undefined;

  return {
    packageManager,
    devScript,
    buildScript,
    candidateUrls: Array.from(new Set(candidateUrls)),
  };
}

/**
 * A page with no package.json at all — no dev server, no framework, just
 * HTML/CSS/JS opened directly. detectWeb requires a package.json to even
 * look, so a project like this fell through to "cli" and never got a
 * browser probe. Root-level only: a bundled vendor .html three folders deep
 * is not "the app".
 */
async function detectStaticHtml(repoRoot: string): Promise<WebProfile | undefined> {
  if (exists(path.join(repoRoot, "package.json"))) return undefined;

  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const htmlFiles = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"));
  if (htmlFiles.length === 0) return undefined;

  const entry = htmlFiles.find((e) => e.name.toLowerCase() === "index.html") ?? htmlFiles[0];

  return { candidateUrls: [], entryFile: entry.name };
}

// ----------------------------------------------------------------- Python

const PY_WEB_FRAMEWORKS: { name: string; re: RegExp; url: string }[] = [
  { name: "streamlit", re: /\bimport\s+streamlit\b|\bfrom\s+streamlit\b/, url: "http://localhost:8501" },
  { name: "gradio", re: /\bimport\s+gradio\b|\bfrom\s+gradio\b/, url: "http://localhost:7860" },
  { name: "django", re: /\bfrom\s+django\b|\bimport\s+django\b/, url: "http://localhost:8000" },
  { name: "fastapi", re: /\bfrom\s+fastapi\b|\bimport\s+fastapi\b/, url: "http://localhost:8000" },
  { name: "flask", re: /\bfrom\s+flask\b|\bimport\s+flask\b/, url: "http://localhost:5000" },
  { name: "dash", re: /\bimport\s+dash\b|\bfrom\s+dash\b/, url: "http://localhost:8050" },
];

const PY_GUI_FRAMEWORKS: { name: string; re: RegExp }[] = [
  { name: "PySide6", re: /\bfrom\s+PySide6\b|\bimport\s+PySide6\b/ },
  { name: "PyQt6", re: /\bfrom\s+PyQt6\b|\bimport\s+PyQt6\b/ },
  { name: "PyQt5", re: /\bfrom\s+PyQt5\b|\bimport\s+PyQt5\b/ },
  { name: "PySide2", re: /\bfrom\s+PySide2\b|\bimport\s+PySide2\b/ },
  { name: "kivy", re: /\bfrom\s+kivy\b|\bimport\s+kivy\b/ },
  { name: "wxPython", re: /\bimport\s+wx\b/ },
  { name: "customtkinter", re: /\bimport\s+customtkinter\b/ },
  { name: "tkinter", re: /\bimport\s+tkinter\b|\bfrom\s+tkinter\b/ },
];

async function detectPython(repoRoot: string): Promise<PythonProfile | undefined> {
  const hasPythonMarkers =
    exists(path.join(repoRoot, "pyproject.toml")) ||
    exists(path.join(repoRoot, "requirements.txt")) ||
    exists(path.join(repoRoot, "setup.py")) ||
    exists(path.join(repoRoot, "manage.py"));

  const files = (await walk(repoRoot, 3)).filter((f) => f.endsWith(".py"));
  if (files.length === 0 && !hasPythonMarkers) return undefined;

  // Prefer conventional entrypoints when scoring candidates.
  const priority = (f: string) => {
    const base = path.basename(f).toLowerCase();
    if (base === "manage.py") return 0;
    if (["app.py", "main.py", "__main__.py", "gui.py", "ui.py", "run.py"].includes(base)) return 1;
    return 2;
  };
  const ordered = files.sort((a, b) => priority(a) - priority(b) || a.length - b.length).slice(0, 60);

  for (const file of ordered) {
    const content = await readIfExists(file);
    if (!content) continue;
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");

    for (const fw of PY_WEB_FRAMEWORKS) {
      if (!fw.re.test(content)) continue;

      let launchArgs: string[];
      if (fw.name === "streamlit") launchArgs = ["-m", "streamlit", "run", rel, "--server.headless", "true"];
      else if (fw.name === "django") launchArgs = [rel, "runserver", "--noreload"];
      else if (fw.name === "fastapi") {
        const mod = rel.replace(/\.py$/, "").replace(/[\\/]/g, ".");
        launchArgs = ["-m", "uvicorn", `${mod}:app`, "--port", "8000"];
      } else launchArgs = [rel];

      return { kind: "web", framework: fw.name, launchArgs, entryFile: rel, candidateUrls: [fw.url] };
    }

    for (const fw of PY_GUI_FRAMEWORKS) {
      if (!fw.re.test(content)) continue;
      return { kind: "desktop", framework: fw.name, launchArgs: [rel], entryFile: rel, candidateUrls: [] };
    }
  }

  return undefined;
}

// ------------------------------------------------------------ Test commands

async function detectTestCommands(repoRoot: string): Promise<string[][]> {
  const cmds: string[][] = [];

  const pkgRaw = await readIfExists(path.join(repoRoot, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const scripts: Record<string, string> = pkg.scripts || {};
      for (const s of ["test", "check", "typecheck", "lint"]) {
        if (scripts[s]) cmds.push(["npm", "run", s]);
      }
    } catch {}
  }

  if (exists(path.join(repoRoot, "pyproject.toml")) || exists(path.join(repoRoot, "pytest.ini"))) {
    cmds.push(["python", "-m", "pytest", "-q"]);
  }
  if (exists(path.join(repoRoot, "Cargo.toml"))) cmds.push(["cargo", "test"]);
  if (exists(path.join(repoRoot, "go.mod"))) cmds.push(["go", "test", "./..."]);

  return cmds;
}


// ------------------------------------------------------------------ firmware

/**
 * Microcontroller projects: PlatformIO, Arduino (sketches) and ESP-IDF. The
 * build command here only COMPILES. It never uploads or flashes, because a
 * board is real hardware and a flash cannot be taken back; anything that
 * touches a device goes through the command policy and the user.
 */
async function detectFirmware(repoRoot: string): Promise<FirmwareProfile | undefined> {
  const skip = new Set(["node_modules", ".git", ".pio", ".agent", "build", "managed_components", ".vscode"]);
  const dirs: string[] = [""];
  try {
    for (const e of await fs.readdir(repoRoot, { withFileTypes: true })) {
      if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith(".")) dirs.push(e.name);
    }
  } catch {}

  for (const rel of dirs) {
    const dir = path.join(repoRoot, rel);
    const at = (f: string) => path.join(dir, f);
    const relDir = rel || ".";

    // PlatformIO: platformio.ini with [env:...] sections.
    const ini = await readIfExists(at("platformio.ini"));
    if (ini) {
      const envs: { name: string; board?: string; native: boolean }[] = [];
      const section = /^\s*\[env:([^\]\s]+)\]\s*$/gm;
      const marks: { name: string; index: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = section.exec(ini))) marks.push({ name: m[1], index: m.index });
      marks.forEach((mk, i) => {
        const body = ini.slice(mk.index, i + 1 < marks.length ? marks[i + 1].index : ini.length);
        const board = /^\s*board\s*=\s*(\S+)/m.exec(body)?.[1];
        const platform = /^\s*platform\s*=\s*(\S+)/m.exec(body)?.[1];
        envs.push({ name: mk.name, board, native: platform === "native" || mk.name === "native" });
      });
      const target = envs.find((e) => !e.native) ?? envs[0];
      const native = envs.find((e) => e.native);
      const dArgs = rel ? ["-d", rel] : [];
      return {
        framework: "platformio",
        dir: relDir,
        board: target?.board,
        environments: envs.map((e) => e.name),
        buildCommand: ["run", ...(target ? ["-e", target.name] : []), ...dArgs],
        hostTestCommand: native ? ["test", "-e", native.name, ...dArgs] : undefined,
      };
    }

    // ESP-IDF: a CMake project that includes the IDF project.cmake.
    const cmake = await readIfExists(at("CMakeLists.txt"));
    if (cmake && /project\.cmake/.test(cmake) && (exists(at("sdkconfig")) || exists(at("sdkconfig.defaults")) || exists(at("main")))) {
      return {
        framework: "esp-idf",
        dir: relDir,
        buildCommand: ["-C", relDir, "build"],
        environments: [],
      };
    }

    // Arduino: a sketch (.ino) with, ideally, a sketch.yaml naming the board.
    let ino: string | undefined;
    try {
      ino = (await fs.readdir(dir)).find((f) => f.toLowerCase().endsWith(".ino"));
    } catch {}
    if (ino) {
      const sketchYaml = await readIfExists(at("sketch.yaml"));
      const fqbn = sketchYaml ? /^\s*default_fqbn:\s*(\S+)/m.exec(sketchYaml)?.[1] : undefined;
      return {
        framework: "arduino",
        dir: relDir,
        board: fqbn,
        environments: [],
        buildCommand: fqbn ? ["compile", "--fqbn", fqbn, relDir] : undefined,
        buildNote: fqbn
          ? undefined
          : "no board is set for this sketch: add default_fqbn to sketch.yaml (for example esp32:esp32:esp32) so it can be compiled",
      };
    }
  }
  return undefined;
}

// -------------------------------------------------------------- Entry point

export async function detectProject(repoRoot: string): Promise<ProjectProfile> {
  const notes: string[] = [];
  const stacks: StackKind[] = [];

  const android = await detectAndroid(repoRoot);
  if (android) {
    stacks.push("android");
    notes.push(
      `Android module "${android.moduleDir}"` +
        (android.applicationId ? ` (applicationId ${android.applicationId})` : " (applicationId not resolved)")
    );
  }

  const ios = await detectIOS(repoRoot);
  if (ios) {
    stacks.push("ios");
    notes.push(
      `iOS ${ios.isWorkspace ? "workspace" : "project"} "${ios.projectPath}"` +
        (ios.bundleId ? ` (bundle id ${ios.bundleId})` : " (bundle id not resolved)") +
        ` — building and running this requires macOS`
    );
  }

  const reactNative = await detectReactNative(repoRoot);
  if (reactNative) {
    stacks.push("react-native");
    notes.push(
      `React Native${reactNative.isExpo ? " (Expo)" : ""} project` +
        (reactNative.hasIOS ? ", ios/ present" : "") +
        (reactNative.hasAndroid ? ", android/ present" : "") +
        ` — no automated build/visual verification yet; static review only`
    );
  }

  const flutter = await detectFlutter(repoRoot);
  if (flutter) {
    stacks.push("flutter");
    notes.push(`Flutter project (pubspec.yaml)`);
  }

  const dotnet = await detectDotnet(repoRoot);
  if (dotnet) {
    stacks.push("dotnet");
    notes.push(`.NET project "${dotnet.projectFile}"${dotnet.isWeb ? " (ASP.NET Core web)" : ""}`);
  }

  if (exists(path.join(repoRoot, "go.mod"))) {
    stacks.push("go");
    notes.push("Go module (go.mod)");
  }

  if (exists(path.join(repoRoot, "Cargo.toml"))) {
    stacks.push("rust");
    notes.push("Rust crate (Cargo.toml)");
  }

  const pluginHost = await detectPluginHost(repoRoot);
  const web = (await detectWeb(repoRoot, pluginHost)) ?? (await detectStaticHtml(repoRoot));
  if (web) {
    stacks.push("web");
    notes.push(
      web.packageManager
        ? `Node project via ${web.packageManager}${web.devScript ? `, dev script "${web.devScript}"` : ""}`
        : `Static HTML page "${web.entryFile}" (no package.json/build step)`
    );
  } else if (pluginHost) {
    notes.push(
      `${pluginHost} — hosted inside another application, not a standalone page; ` +
        `visual QA is skipped rather than risk pointing a browser at the wrong thing`
    );
  }

  const python = await detectPython(repoRoot);
  if (python) {
    stacks.push(python.kind === "web" ? "python-web" : "python-desktop");
    notes.push(`Python ${python.framework} ${python.kind} app at ${python.entryFile}`);
  }

  const firmware = await detectFirmware(repoRoot);
  if (firmware) {
    stacks.push("firmware");
    notes.push(
      `Firmware (${firmware.framework}) in "${firmware.dir}"` +
        (firmware.board ? `, board ${firmware.board}` : "") +
        ` — compiled here, never flashed; anything that touches a board needs the user`
    );
  }

  if (stacks.length === 0) {
    stacks.push("cli");
    notes.push("No UI stack detected; treating as CLI/library");
  }

  const testCommands = await detectTestCommands(repoRoot);

  return {
    stacks,
    primary: stacks[0],
    android,
    ios,
    reactNative,
    flutter,
    dotnet,
    web,
    python,
    firmware,
    testCommands,
    notes,
  };
}

export function describeProfile(p: ProjectProfile): string {
  return [`  stacks: ${p.stacks.join(", ")}`, ...p.notes.map((n) => `  ${n}`)].join("\n");
}
