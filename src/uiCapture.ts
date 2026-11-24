/**
 * The screens a UI critique looks at: found from the project itself, captured from the running app, plus any screenshots the person hands
 * over. Generic across stacks: file-based routers (Expo Router, Next.js app and pages, Nuxt, SvelteKit, Astro, Remix/React Router, Gatsby),
 * route tables in code, plain HTML files, QA's navigation map (.agent/nav_map.json) and the QA setup's own launch path and deep links.
 *
 * Only ever run when a person asks for a critique: it starts the app's dev server and a browser, which routine runs must never pay for.
 *
 *   discover  — every screen the project declares, with why a screen cannot be opened directly (a route needing a value, a debug page)
 *   pick      — at most MAX_SCREENS, the ones QA was told how to reach first, then the root, then the shallowest
 *   capture   — each one at a phone and/or desktop size; a screen that redirects elsewhere, refuses (401/403), or shows exactly what
 *               an earlier one showed is reported as needing sign-in or app state, not saved as if it were that screen
 *   provided  — screenshots the person gives (any path, through the same attachment rules as everywhere else)
 *
 * Nothing here judges a screen; a later step does.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { lazyIgnore, NATIVE_TREES } from "./projectPaths.js";
import { loadQaSetup, qaEnvFor, isSafeLaunchPath } from "./qaSetup.js";
import { loadAttachment } from "./attachments.js";
import { detectProject } from "./projectProfile.js";
import { startServer, stopServer } from "./visualProbes.js";

export const MAX_SCREENS = 6;
export const CRITIQUE_DIR = path.join("design-system", "critique");

export interface Viewport {
  name: "phone" | "desktop";
  width: number;
  height: number;
}
export const PHONE: Viewport = { name: "phone", width: 390, height: 844 };
export const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900 };

export interface ScreenCandidate {
  /** Path from the app's root ("/", "/settings?tab=a"), or a file name for a plain HTML site. */
  route: string;
  name: string;
  /** Where it was found: the file, "nav map", "QA setup". */
  from: string;
  /** Set when it cannot be opened directly, with why. */
  skip?: string;
  /** Someone told QA how to reach it (QA setup): taken first. */
  priority?: boolean;
}

export interface Discovery {
  candidates: ScreenCandidate[];
  /** The routing convention found, or null. */
  router: string | null;
  /** Screens known only by name (a native app's nav map): there is no URL to open, so they need screenshots. */
  nameOnly: string[];
  /** For a static site: the folder (repo-relative, "." for the top) its pages are served from. */
  staticRoot?: string;
}

// ----------------------------------------------------------------------------------------------- discovery

const SKIP_DIRS = lazyIgnore(NATIVE_TREES);
const PAGE_EXT = /\.(tsx|jsx|ts|js|mdx?|vue|svelte|astro|html?)$/i;
/** Whole path segments that are never a product screen. */
const NOT_A_SCREEN = new Set(["debug", "storybook", "playground", "sandbox", "404", "500", "not-found", "error", "_error", "api", "robots", "sitemap"]);

function packageDeps(repoRoot: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

/** Files under `dir` (repo-relative, forward slashes), skipping the shared ignore list and dot-folders. */
function filesUnder(repoRoot: string, dir: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth || out.length > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(r, depth + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, 0);
  return out;
}

const firstDir = (repoRoot: string, dirs: string[]) => dirs.find((d) => fs.existsSync(path.join(repoRoot, d)) && fs.statSync(path.join(repoRoot, d)).isDirectory());

/** "(group)" folders never appear in the URL. */
const dropGroups = (segs: string[]) => segs.filter((s) => !/^\(.*\)$/.test(s));
const join = (segs: string[]) => "/" + segs.filter(Boolean).join("/");
const dynamicSeg = (s: string) => /^\[.*\]$|^:|^\$/.test(s);

/** One way of turning a page file into a route: null when the file is not a page. */
interface Router {
  id: string;
  dirs: string[];
  toRoute(relInDir: string): string | null;
}

const stripExt = (f: string) => f.replace(PAGE_EXT, "");

const ROUTERS: { when: (deps: Set<string>) => boolean; router: Router }[] = [
  {
    when: (d) => d.has("expo-router"),
    router: {
      id: "Expo Router",
      dirs: ["app", "src/app"],
      toRoute(rel) {
        if (!/\.(tsx|jsx|ts|js)$/.test(rel)) return null;
        const segs = stripExt(rel).split("/");
        if (segs.some((s) => s.startsWith("_") || s.startsWith("+"))) return null; // layouts, +not-found, +html, +api
        const last = segs[segs.length - 1];
        return join(dropGroups(last === "index" ? segs.slice(0, -1) : segs));
      },
    },
  },
  {
    when: (d) => d.has("next"),
    router: {
      id: "Next.js (app router)",
      dirs: ["app", "src/app"],
      toRoute(rel) {
        const m = rel.match(/^(.*?)(?:^|\/)page\.(tsx|jsx|ts|js|mdx)$/);
        if (!m) return null;
        const segs = m[1] ? m[1].split("/") : [];
        if (segs.some((s) => s.startsWith("_") || s.startsWith("@"))) return null; // private folders, parallel slots
        return join(dropGroups(segs));
      },
    },
  },
  {
    when: (d) => d.has("next") || d.has("gatsby") || d.has("nuxt") || d.has("nuxt3"),
    router: {
      id: "pages directory",
      dirs: ["pages", "src/pages"],
      toRoute(rel) {
        if (!/\.(tsx|jsx|ts|js|vue|mdx?)$/.test(rel)) return null;
        const segs = stripExt(rel).split("/");
        if (segs[0] === "api" || segs.some((s) => s.startsWith("_"))) return null; // _app, _document, API routes
        return join(segs[segs.length - 1] === "index" ? segs.slice(0, -1) : segs);
      },
    },
  },
  {
    when: (d) => d.has("@sveltejs/kit"),
    router: {
      id: "SvelteKit",
      dirs: ["src/routes"],
      toRoute(rel) {
        const m = rel.match(/^(.*?)(?:^|\/)\+page\.svelte$/);
        return m ? join(dropGroups(m[1] ? m[1].split("/") : [])) : null;
      },
    },
  },
  {
    when: (d) => d.has("astro"),
    router: {
      id: "Astro",
      dirs: ["src/pages"],
      toRoute(rel) {
        if (!/\.(astro|mdx?|html)$/.test(rel)) return null;
        const segs = stripExt(rel).split("/");
        if (segs.some((s) => s.startsWith("_"))) return null;
        return join(segs[segs.length - 1] === "index" ? segs.slice(0, -1) : segs);
      },
    },
  },
  {
    when: (d) => [...d].some((x) => x.startsWith("@remix-run/") || x === "@react-router/dev"),
    router: {
      id: "Remix / React Router (file routes)",
      dirs: ["app/routes"],
      toRoute(rel) {
        if (!/\.(tsx|jsx|ts|js)$/.test(rel)) return null;
        // Flat routes: "settings.profile.tsx" is /settings/profile; "_index" is the index; a "_segment" is a pathless layout.
        const name = stripExt(rel).replace(/\/route$/, "").replace(/\//g, ".");
        const segs = name.split(".").filter((s) => s !== "_index" && !/^_/.test(s));
        if (name.startsWith("api.") || name.startsWith("resources.")) return null;
        return join(segs.map((s) => s.replace(/_$/, "")));
      },
    },
  },
];

/** Paths declared in a route table in code (React Router, Vue Router, Angular): `path: "/x"`, `<Route path="/x"`. */
function routeTablePaths(repoRoot: string): string[] {
  const found = new Set<string>();
  for (const rel of filesUnder(repoRoot, "src", 6).filter((f) => /\.(tsx|jsx|ts|js|vue)$/.test(f)).slice(0, 400)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (!/Route|router|Routes|routes/.test(text)) continue;
    for (const m of text.matchAll(/\bpath\s*[:=]\s*\{?\s*["'`](\/[^"'`\s]*)["'`]/g)) found.add(m[1]);
  }
  return [...found];
}

/** Folders a static site's built pages land in, in the order they are looked for. */
const BUILD_OUTPUT = ["dist", "build", "out", "_site", "public"];
/** A file with template placeholders is a template a build fills in, not a page. */
const TEMPLATE = /\{\{\s*[\w.]+\s*\}\}|\{%|<%/;

/**
 * A static site: its pages as served paths, and the folder served. Built output (with an index.html) is preferred, since a site with a
 * build step only has real pages there; otherwise the full HTML documents at the top, in public/ or in src/, leaving out templates.
 */
export function staticSite(repoRoot: string): { root: string; routes: string[] } | null {
  const toRoute = (rel: string) => "/" + rel.replace(/(^|\/)index\.html?$/i, "").replace(/\.html?$/i, "");
  for (const dir of BUILD_OUTPUT) {
    if (!fs.existsSync(path.join(repoRoot, dir, "index.html"))) continue;
    const pages = filesUnder(repoRoot, dir, 4).filter((f) => /\.html?$/i.test(f)).map((f) => toRoute(f.slice(dir.length + 1)));
    return { root: dir, routes: pages };
  }
  for (const dir of ["", "public", "src"]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(repoRoot, dir)).filter((f) => /\.html?$/i.test(f));
    } catch {
      continue;
    }
    const pages = names.filter((n) => {
      const text = fs.readFileSync(path.join(repoRoot, dir, n), "utf8");
      return /<html[\s>]/i.test(text) && !TEMPLATE.test(text);
    });
    if (pages.length > 0) return { root: dir || ".", routes: pages.map(toRoute) };
  }
  return null;
}

/** The screen's name for a person: the last meaningful part of its route. */
export function screenName(route: string): string {
  const clean = route.split(/[?#]/)[0].replace(/\.html?$/i, "").replace(/(^|\/)index$/i, "");
  const last = clean.split("/").filter(Boolean).pop();
  return last ? last.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "Home";
}

function whyNotDirect(route: string): string | undefined {
  const segs = route.split(/[?#]/)[0].split("/").filter(Boolean);
  const dyn = segs.find(dynamicSeg);
  if (dyn) return `needs a value for ${dyn} (send a screenshot, or add it as a deep link in the QA setup)`;
  const odd = segs.find((s) => NOT_A_SCREEN.has(s.toLowerCase()));
  if (odd) return `a ${odd} page, not a product screen`;
  return undefined;
}

export function discoverScreens(repoRoot: string): Discovery {
  const deps = packageDeps(repoRoot);
  const byRoute = new Map<string, ScreenCandidate>();
  const pathOf = (r: string) => r.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() || "/";
  const add = (c: ScreenCandidate) => {
    const key = c.route.toLowerCase();
    if (!c.priority && [...byRoute.values()].some((x) => x.priority && pathOf(x.route) === pathOf(c.route))) return;
    const had = byRoute.get(key);
    if (had) {
      if (c.priority) had.priority = true;
      return;
    }
    byRoute.set(key, { ...c, ...(c.skip ? {} : whyNotDirect(c.route) ? { skip: whyNotDirect(c.route) } : {}) });
  };

  // What QA was told about reaching the app comes first: it is how a person said to get past sign-in or into a state.
  const setup = loadQaSetup(repoRoot);
  if (setup.launchPath && isSafeLaunchPath(setup.launchPath)) add({ route: setup.launchPath, name: screenName(setup.launchPath), from: "QA setup (launch path)", priority: true });
  for (const link of setup.deepLinks ?? []) if (link.url.startsWith("/")) add({ route: link.url, name: link.name, from: "QA setup (deep link)", priority: true });

  let router: Router | null = null;
  let routerFiles = new Map<string, string>(); // repo-relative page file -> route
  for (const r of ROUTERS) {
    if (!r.when(deps)) continue;
    const dir = firstDir(repoRoot, r.router.dirs);
    if (!dir) continue;
    const files = filesUnder(repoRoot, dir).filter((f) => PAGE_EXT.test(f));
    const mapped = new Map<string, string>();
    for (const f of files) {
      const route = r.router.toRoute(f.slice(dir.length + 1));
      if (route !== null) mapped.set(f, route);
    }
    if (mapped.size === 0) continue;
    router = r.router;
    routerFiles = mapped;
    break;
  }

  // QA's navigation map: its order is how QA met the screens. A screen whose file the router maps gets that route; one it does not
  // (a native screen) is known only by name.
  const nameOnly: string[] = [];
  try {
    const nav = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agent", "nav_map.json"), "utf8"));
    for (const [name, entry] of Object.entries<any>(nav ?? {})) {
      const file = typeof entry?.file === "string" ? entry.file.replace(/\\/g, "/") : undefined;
      const route = file ? routerFiles.get(file) : undefined;
      if (route !== undefined) add({ route, name, from: "nav map" });
      else if (!router && file && !/_layout|layout\./i.test(file)) nameOnly.push(name);
    }
  } catch {
    // no map yet
  }

  for (const [file, route] of routerFiles) add({ route, name: screenName(route), from: file });
  if (!router) {
    const table = routeTablePaths(repoRoot);
    for (const route of table) add({ route, name: screenName(route), from: "route table" });
    if (table.length > 0) router = { id: "route table in code", dirs: [], toRoute: () => null };
  }
  let staticRoot: string | undefined;
  if (!router) {
    const site = staticSite(repoRoot);
    if (site) {
      for (const r of site.routes) add({ route: r, name: screenName(r), from: site.root === "." ? "HTML file" : `${site.root}/` });
      staticRoot = site.root;
      router = { id: site.root === "." || site.root === "src" ? "HTML files" : `built static site (${site.root}/)`, dirs: [], toRoute: () => null };
    }
  }
  return { candidates: [...byRoute.values()], router: router?.id ?? null, nameOnly, ...(staticRoot ? { staticRoot } : {}) };
}

// ----------------------------------------------------------------------------------------------- picking

export interface Skipped {
  route: string;
  name: string;
  reason: string;
}

const depth = (route: string) => route.split(/[?#]/)[0].split("/").filter(Boolean).length;
const isRoot = (route: string) => /^\/?(index\.html?)?$/i.test(route.split(/[?#]/)[0]);

/** At most `cap` screens: QA-setup ones, then the root, then the rest by depth (discovery order breaks ties, so the nav map's order holds). */
/**
 * The first `cap` screens in order, and the rest as spares: a chosen screen that turns out to need sign-in or app state leaves its slot to
 * the next spare, so gated screens never crowd out ones that open. `skipped` holds only what can never be opened directly.
 */
export function pickScreens(candidates: ScreenCandidate[], cap = MAX_SCREENS): { chosen: ScreenCandidate[]; spares: ScreenCandidate[]; skipped: Skipped[] } {
  const skipped: Skipped[] = candidates.filter((c) => c.skip).map((c) => ({ route: c.route, name: c.name, reason: c.skip! }));
  const open = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.skip)
    .sort((a, b) => Number(!!b.c.priority) - Number(!!a.c.priority) || Number(isRoot(b.c.route)) - Number(isRoot(a.c.route)) || depth(a.c.route) - depth(b.c.route) || a.i - b.i)
    .map(({ c }) => c);
  return { chosen: open.slice(0, cap), spares: open.slice(cap), skipped };
}

// ----------------------------------------------------------------------------------------------- capture

export interface PageShot {
  /** Where the browser ended up. */
  finalUrl: string;
  status: number | null;
  png: Buffer;
  /** Uncaught errors the page threw while loading: a crashed screen shows an error overlay, not its design. */
  errors?: string[];
}
/** Opens one URL at one size and screenshots it. Injected, so discovery and the gating rules are tested without a browser. */
export type OpenPage = (url: string, viewport: Viewport) => Promise<PageShot>;

export interface CapturedScreen {
  name: string;
  route: string;
  viewport: Viewport["name"] | "provided";
  /** Repo-relative path of the saved PNG (or the provided image). */
  file: string;
  from: string;
}

export interface CaptureReport {
  baseUrl?: string;
  router: string | null;
  screens: CapturedScreen[];
  skipped: Skipped[];
  /** Why no screen could be captured from the app at all, when that happened. */
  unavailable?: string;
  /** Screens known only by name (no URL), listed so the person can send screenshots of them. */
  nameOnly: string[];
  /**
   * What the QA setup says it seeds or mocks to reach these screens (its notes), so whoever judges them knows which parts are test
   * scaffolding (fixture buttons, simulated connections) and not the product.
   */
  setupNotes?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "home";

/** The URL for a route on a server (or, for a plain HTML site, a file URL base). */
export function routeUrl(baseUrl: string, route: string): string {
  if (/^file:/i.test(baseUrl)) return new URL(route.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").href;
  return new URL(route, baseUrl).href;
}

/** Path plus query, for comparing where a screen was asked for with where the browser ended up. */
const where = (u: string) => {
  try {
    const x = new URL(u);
    return (x.protocol === "file:" ? x.pathname : x.pathname.replace(/\/+$/, "") || "/") + x.search;
  } catch {
    return u;
  }
};

export async function captureScreens(o: {
  repoRoot: string;
  baseUrl: string;
  screens: ScreenCandidate[];
  viewports: Viewport[];
  outDir: string;
  open: OpenPage;
  /** Stop once this many screens were captured; the ones not reached are reported as over the limit. */
  cap?: number;
}): Promise<{ screens: CapturedScreen[]; skipped: Skipped[] }> {
  const screens: CapturedScreen[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, string>(); // image hash -> the screen that showed it
  const cap = o.cap ?? Infinity;
  const taken = () => new Set(screens.map((s) => s.route)).size;
  fs.mkdirSync(o.outDir, { recursive: true });
  for (const [i, s] of o.screens.entries()) {
    if (taken() >= cap) {
      for (const rest of o.screens.slice(i)) skipped.push({ route: rest.route, name: rest.name, reason: `over the ${cap}-screen limit` });
      break;
    }
    const url = routeUrl(o.baseUrl, s.route);
    for (const vp of o.viewports) {
      let shot: PageShot;
      try {
        shot = await o.open(url, vp);
      } catch (err: any) {
        skipped.push({ route: s.route, name: s.name, reason: `could not be opened (${String(err?.message ?? err).split("\n")[0].slice(0, 160)})` });
        break;
      }
      if (shot.status === 401 || shot.status === 403) {
        skipped.push({ route: s.route, name: s.name, reason: `refused with ${shot.status}: needs sign-in (send a screenshot, or set it up in the QA setup)` });
        break;
      }
      if (shot.status !== null && shot.status >= 400) {
        skipped.push({ route: s.route, name: s.name, reason: `answered ${shot.status}` });
        break;
      }
      if (shot.errors?.length) {
        skipped.push({ route: s.route, name: s.name, reason: `it crashed while loading (${shot.errors[0]}): fix that before judging its design` });
        break;
      }
      if (where(shot.finalUrl) !== where(url)) {
        skipped.push({ route: s.route, name: s.name, reason: `redirected to ${where(shot.finalUrl)}: needs sign-in or app state (send a screenshot, or set it up in the QA setup)` });
        break;
      }
      const hash = crypto.createHash("sha256").update(shot.png).digest("hex");
      const same = seen.get(`${vp.name}:${hash}`);
      if (same) {
        skipped.push({ route: s.route, name: s.name, reason: `showed exactly what ${same} showed: likely needs sign-in or app state (send a screenshot)` });
        break;
      }
      seen.set(`${vp.name}:${hash}`, s.name);
      const file = path.join(o.outDir, `${slug(s.name)}-${vp.name}.png`);
      fs.writeFileSync(file, shot.png);
      screens.push({ name: s.name, route: s.route, viewport: vp.name, file: path.relative(o.repoRoot, file).replace(/\\/g, "/"), from: s.from });
    }
  }
  return { screens, skipped };
}

/** Screenshots the person gave: loaded through the attachment rules (outside-the-repo confirmation, secret refusal), images only. */
export async function providedScreens(paths: string[], repoRoot: string, outDir: string): Promise<{ screens: CapturedScreen[]; refused: string[] }> {
  const screens: CapturedScreen[] = [];
  const refused: string[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of paths) {
    try {
      const a = await loadAttachment(p, repoRoot);
      if (a.kind !== "image") {
        refused.push(`${p}: not an image`);
        continue;
      }
      const m = a.content.match(/^data:image\/([a-z0-9.+-]+);base64,(.*)$/i);
      if (!m) {
        refused.push(`${p}: could not be read as an image`);
        continue;
      }
      const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase().replace(/[^a-z0-9]/g, "");
      const name = path.basename(p).replace(/\.[^.]+$/, "");
      const file = path.join(outDir, `provided-${slug(name)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2], "base64"));
      screens.push({ name, route: "", viewport: "provided", file: path.relative(repoRoot, file).replace(/\\/g, "/"), from: "provided" });
    } catch (err: any) {
      refused.push(`${p}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }
  return { screens, refused };
}

/** The record of a capture, beside the images: what was taken, what was skipped and why. */
export function writeCaptureManifest(outDir: string, report: CaptureReport): string {
  const file = path.join(outDir, "capture.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2));
  return file;
}

/** What to tell the person after a capture: what was taken, and every screen that was not, with why. */
export function describeCapture(r: CaptureReport): string[] {
  const lines: string[] = [];
  const taken = new Map<string, string[]>();
  for (const s of r.screens) taken.set(s.name, [...(taken.get(s.name) ?? []), s.viewport]);
  lines.push(
    taken.size > 0
      ? `[CRITIQUE] Captured ${taken.size} screen(s): ${[...taken].map(([n, v]) => `${n} (${v.join(", ")})`).join("; ")}.`
      : `[CRITIQUE] No screen was captured${r.unavailable ? `: ${r.unavailable}` : "."}`
  );
  for (const s of r.skipped) lines.push(`   skipped ${s.name} (${s.route}): ${s.reason}`);
  if (r.nameOnly.length > 0) lines.push(`   known only by name, with no URL to open: ${r.nameOnly.join(", ")}. Send screenshots of the ones that matter.`);
  return lines;
}

// ----------------------------------------------------------------------------------------------- the whole step

/** Starts and stops the app for a capture. Injected; the real one runs the project's own dev server. */
export interface AppServer {
  start(repoRoot: string): Promise<{ baseUrl: string; stop: () => void; viewports: Viewport[] } | { unavailable: string }>;
}

/**
 * Discover, pick, start the app, capture, add the person's screenshots, write the manifest. Only called when a person asked for a
 * critique (see the module comment). `open` and `server` are injected; `playwrightOpener` and `devServer` are the real ones.
 */
export async function captureAppScreens(o: {
  repoRoot: string;
  provided?: string[];
  cap?: number;
  server: AppServer;
  open: OpenPage | null;
  /** "before" for a critique; "after" for the same screens once a polish has run. */
  stage?: "before" | "after";
  /** Capture exactly these screens (the ones a critique looked at) instead of discovering them again. */
  routes?: ScreenCandidate[];
}): Promise<CaptureReport> {
  const outDir = path.join(o.repoRoot, CRITIQUE_DIR, o.stage ?? "before");
  const found = discoverScreens(o.repoRoot);
  const cap = o.cap ?? MAX_SCREENS;
  const { chosen, spares, skipped } = o.routes ? { chosen: o.routes, spares: [], skipped: [] } : pickScreens(found.candidates, cap);
  const setup = loadQaSetup(o.repoRoot);
  const setupNotes = [setup.notes, setup.mockNotes].filter(Boolean).join("\n").slice(0, 2000);
  const report: CaptureReport = { router: found.router, screens: [], skipped, nameOnly: found.nameOnly, ...(setupNotes ? { setupNotes } : {}) };

  if (chosen.length === 0) report.unavailable = found.router ? "no screen could be opened directly" : "no screens were found in the project";
  else if (!o.open) report.unavailable = "no browser is available (Playwright)";
  else {
    const started = await o.server.start(o.repoRoot);
    if ("unavailable" in started) report.unavailable = started.unavailable;
    else {
      report.baseUrl = started.baseUrl;
      try {
        const got = await captureScreens({ repoRoot: o.repoRoot, baseUrl: started.baseUrl, screens: [...chosen, ...spares], cap, viewports: started.viewports, outDir, open: o.open });
        report.screens.push(...got.screens);
        report.skipped.push(...got.skipped);
      } finally {
        started.stop();
      }
    }
  }

  if (o.provided?.length) {
    const given = await providedScreens(o.provided, o.repoRoot, outDir);
    report.screens.push(...given.screens);
    for (const r of given.refused) report.skipped.push({ route: "", name: "provided screenshot", reason: r });
  }
  writeCaptureManifest(outDir, report);
  return report;
}

// ----------------------------------------------------------------------------------------------- the real server and browser

/**
 * The project's own dev server, started the way QA starts it (with the QA setup's variables), or a file URL for a plain HTML site.
 * A phone-first app (React Native / Expo) is captured at a phone size only; a web app at a phone size and a desktop size.
 */
export const devServer: AppServer = {
  async start(repoRoot) {
    const profile = await detectProject(repoRoot);
    const both = [PHONE, DESKTOP];
    if (profile.reactNative?.isExpo) {
      const bin = process.platform === "win32" ? "npx.cmd" : "npx";
      const h = await startServer(bin, ["expo", "start", "--web"], repoRoot, profile.reactNative.candidateUrls ?? [], 60000, qaEnvFor(repoRoot));
      if (!h.url) {
        stopServer(h);
        return { unavailable: `the Expo web server never became reachable (${h.log.slice(-200).trim() || "no output"})` };
      }
      return { baseUrl: h.url, stop: () => stopServer(h), viewports: [PHONE] };
    }
    const web = profile.web;
    if (web?.devScript) {
      const pm = web.packageManager ?? "npm";
      const h = await startServer(process.platform === "win32" ? `${pm}.cmd` : pm, ["run", web.devScript], repoRoot, web.candidateUrls, 45000, qaEnvFor(repoRoot));
      if (!h.url) {
        stopServer(h);
        return { unavailable: `the dev server ("${web.devScript}") never became reachable (${h.log.slice(-200).trim() || "no output"})` };
      }
      return { baseUrl: h.url, stop: () => stopServer(h), viewports: both };
    }
    const site = staticSite(repoRoot);
    if (site) {
      const served = await serveStatic(path.join(repoRoot, site.root));
      return { baseUrl: served.url, stop: served.stop, viewports: both };
    }
    return { unavailable: "this project has no web build to open (a native app, or no dev script): send screenshots of its screens instead" };
  },
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain",
};

/** Which file a request path names inside `root`: the file, its .html, or its index.html. Never anything outside `root`. */
export function staticFileFor(root: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const base = path.resolve(root);
  const target = path.resolve(base, "." + path.posix.normalize("/" + p));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  for (const f of [target, target + ".html", path.join(target, "index.html")]) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** A static folder served on loopback only, on a free port, for as long as the capture takes. */
export async function serveStatic(root: string): Promise<{ url: string; stop: () => void }> {
  const server = http.createServer((req, res) => {
    const file = req.method === "GET" || req.method === "HEAD" ? staticFileFor(root, req.url ?? "/") : null;
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/** Longest a capture waits for a screen to settle (loading screens, client-side redirects). */
const SETTLE_MS = 6000;

/** Longest screenshot taken of one page, in viewport heights: enough to judge rhythm below the fold without paying for an endless page. */
const MAX_PAGE_HEIGHTS = 3;

/**
 * A headless browser that opens pages for a capture, with JavaScript on and the QA setup's localStorage written before any app code
 * runs (the same way QA reaches signed-in or seeded states). null when Playwright is not installed. Close it when done.
 */
export async function browserOpener(repoRoot: string): Promise<{ open: OpenPage; close: () => Promise<void> } | null> {
  let browser: any;
  try {
    const mod: any = await import("playwright");
    browser = await mod.chromium.launch({ headless: true });
  } catch {
    return null;
  }
  const storage = loadQaSetup(repoRoot).localStorage ?? {};
  const open: OpenPage = async (url, vp) => {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.name === "phone", hasTouch: vp.name === "phone" });
    try {
      if (Object.keys(storage).length > 0) {
        await context.addInitScript((entries: Record<string, string>) => {
          try {
            for (const [k, v] of Object.entries(entries)) (globalThis as any).localStorage.setItem(k, v);
          } catch {
            // storage blocked (a file URL): the page still opens
          }
        }, storage);
      }
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e?.message ?? e).split("\n")[0].slice(0, 160)));
      let status: number | null = null;
      try {
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
        status = res?.status() ?? null;
      } catch {
        // a page that never goes quiet (polling, a socket) is still worth looking at once it has loaded
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
      }
      // Client-side redirects and loading screens: wait until the screen stops changing (a spinner never does, so this is capped), then
      // judge where the browser ended up, not where it started.
      let prev: Buffer | null = null;
      for (let waited = 0; waited < SETTLE_MS; waited += 700) {
        await page.waitForTimeout(700);
        const now: Buffer = await page.screenshot({ type: "png" });
        if (prev && now.equals(prev)) break;
        prev = now;
      }
      // A page with no mobile viewport tag is laid out wider than a phone and zoomed out to fit, as a real phone shows it: take
      // that view, never a phone-wide strip cut from the wide layout.
      const layout = Number(await page.evaluate(() => (globalThis as any).document.documentElement.clientWidth).catch(() => vp.width)) || vp.width;
      const full = await page.evaluate(() => (globalThis as any).document.documentElement.scrollHeight).catch(() => vp.height);
      const height = Math.min(Math.max(vp.height, Number(full) || vp.height), vp.height * MAX_PAGE_HEIGHTS);
      const png: Buffer =
        layout > vp.width + 1
          ? await page.screenshot({ type: "png" })
          : await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: vp.width, height } });
      return { finalUrl: page.url(), status, png, ...(errors.length ? { errors } : {}) };
    } finally {
      await context.close();
    }
  };
  return {
    open,
    async close() {
      try {
        await browser.close();
      } catch {
        // already gone
      }
    },
  };
}
