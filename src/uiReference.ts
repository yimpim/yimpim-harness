/**
 * Reference intake: what a person points at when they say "like this". Shared by the UI critique (Part A) and the new-app design step
 * (Part B), and only ever run because a person gave references: it can start a browser, which routine runs must never pay for.
 *
 *   an image path   -> loaded through the attachment rules (secrets refused, images only), saved beside the others
 *   a URL           -> checked as a public web address, then opened in a headless browser with every request guarded (anything that
 *                      resolves to a private or local address is blocked, so a redirect or a rebinding trick cannot reach this machine's
 *                      network), captured at a desktop and a phone size, and its colours, fonts, sizes and corner radius read from the
 *                      rendered page (computed styles, weighted by how much of the screen they cover), not guessed from its HTML
 *   anything else   -> a named benchmark ("Linear", "Stripe's dashboard"): kept as the person's words and marked recalled, so nothing
 *                      later presents a model's memory of it as measured
 *
 * A page that cannot be captured (unreachable, behind sign-in, a bot wall, an error) is not guessed at: the person is asked for a
 * screenshot instead. Nothing here judges a reference; a later step reads it.
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { safeToFetch } from "./competitors.js";
import { loadAttachment } from "./attachments.js";
import { hexToOklch } from "./colorlib.js";

export const MAX_REFERENCES = 4;
/** Longest screenshot kept of one page, in viewport heights. */
const MAX_PAGE_HEIGHTS = 2;
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 4000;

export const REF_DESKTOP = { width: 1440, height: 900 };
export const REF_PHONE = { width: 390, height: 844 };

// ----------------------------------------------------------------------------------------------- what was given

export type ReferenceKind = "image" | "url" | "named";

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/** What one reference is: a file on disk, a web address, or a product named in words. */
export function classifyReference(input: string, cwd: string): { kind: ReferenceKind; value: string } {
  const v = input.trim();
  if (/^https?:\/\//i.test(v)) return { kind: "url", value: v };
  const onDisk = path.resolve(cwd, v);
  // A file that exists, or a name ending in an image extension (a missing one is then reported as missing, not looked up on the web).
  if (fs.existsSync(onDisk) || IMAGE_FILE.test(v)) return { kind: "image", value: onDisk };
  if (BARE_DOMAIN.test(v)) return { kind: "url", value: `https://${v}` };
  return { kind: "named", value: v };
}

// ----------------------------------------------------------------------------------------------- the request guard

const privateIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || /^::ffff:(127|10|192\.168|169\.254)\./.test(v);
};

/**
 * What the browser may load, decided without the network: data/blob always; other schemes, credentials, localhost-style names and
 * private address literals never; any other web host only once its DNS answer is checked ("check").
 */
export function requestVerdict(raw: string): "allow" | "block" | "check" {
  if (/^(data|blob):/i.test(raw)) return "allow";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "block";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "block";
  if (u.username || u.password) return "block";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "block";
  if (net.isIP(host)) return privateIp(host) ? "block" : "allow";
  return "check";
}

/** A host's DNS answer is checked once per capture: every address it gives must be public. */
export function hostChecker(lookup: (host: string) => Promise<{ address: string }[]> = (h) => dns.lookup(h, { all: true })) {
  const cache = new Map<string, Promise<boolean>>();
  return (host: string): Promise<boolean> => {
    let p = cache.get(host);
    if (!p) {
      p = lookup(host).then((a) => a.length > 0 && !a.some((x) => privateIp(x.address)), () => false);
      cache.set(host, p);
    }
    return p;
  };
}

// ----------------------------------------------------------------------------------------------- what the page looks like

/** One visible element as the browser computed it. Collected in the page; turned into cues here, where it can be tested. */
export interface StyleSample {
  tag: string;
  role: "heading" | "button" | "link" | "text" | "surface";
  bg: string | null;
  color: string;
  font: string;
  size: number;
  weight: number;
  radius: number;
  /** On-screen area in px², for weighting. */
  area: number;
  /** Height in px: a corner as round as half of it is a pill, and only panel-sized surfaces count for corner radius. */
  h: number;
  /** Characters of text directly in it, for weighting text colour. */
  text: number;
}

export interface PageCues {
  theme: "light" | "dark";
  background: string | null;
  text: string | null;
  accent: string | null;
  /** The most-covering colours, most first. */
  palette: string[];
  fonts: { heading: string | null; body: string | null };
  sizes: { body: number | null; h1: number | null };
  headingWeight: number | null;
  /** Typical corner radius of buttons ("pill" when fully rounded), and of panel-sized surfaces, in px. */
  radius: { button: number | "pill" | null; surface: number | null };
  /** The main button's fill (its largest one), even when it is neutral: "dark pill buttons" is a look of its own. */
  button: string | null;
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> "#010203"; fully or mostly transparent -> null. */
export function cssColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(v.trim());
  if (!m) return /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (a < 0.5) return null;
  return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);
/** The first family in a font stack that names a real typeface; a system stack reads as "system UI". */
export function primaryFont(stack: string): string | null {
  const names = stack.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  const real = names.find((n) => !GENERIC.has(n.toLowerCase()) && !/^var\(/i.test(n));
  if (real && !/^(segoe ui|roboto|helvetica neue|arial|helvetica)$/i.test(real)) return real;
  if (names.some((n) => /^(system-ui|-apple-system|ui-sans-serif|blinkmacsystemfont)$/i.test(n))) return "system UI";
  return real ?? null;
}

/** Colours this close in OKLCH read as one: lightness, chroma and hue (scaled by chroma) within small steps. */
function close(a: string, b: string): boolean {
  const x = hexToOklch(a);
  const y = hexToOklch(b);
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return Math.abs(x.l - y.l) < 0.04 && Math.abs(x.c - y.c) < 0.03 && (Math.max(x.c, y.c) < 0.04 || dh < 12);
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Most of a weighted tally, merging colours that read as one. */
function topColours(entries: [string, number][]): [string, number][] {
  const merged: [string, number][] = [];
  for (const [hex, w] of entries.sort((a, b) => b[1] - a[1])) {
    const near = merged.find(([h]) => close(h, hex));
    if (near) near[1] += w;
    else merged.push([hex, w]);
  }
  return merged.sort((a, b) => b[1] - a[1]);
}

export function cuesFromSamples(samples: StyleSample[]): PageCues {
  const bgWeights: [string, number][] = [];
  const textWeights: [string, number][] = [];
  const accentWeights: [string, number][] = [];
  for (const s of samples) {
    const bg = cssColor(s.bg);
    const fg = cssColor(s.color);
    if (bg) bgWeights.push([bg, s.area]);
    if (fg && s.text > 0) textWeights.push([fg, s.text * s.size]);
    const chromatic = (h: string | null) => (h && hexToOklch(h).c >= 0.06 ? h : null);
    if (s.role === "button" && chromatic(bg)) accentWeights.push([bg!, s.area + 20000]);
    if ((s.role === "link" || s.role === "button") && chromatic(fg)) accentWeights.push([fg!, s.text * 40]);
  }
  const bgs = topColours(bgWeights);
  const texts = topColours(textWeights);
  const background = bgs[0]?.[0] ?? null;
  const text = texts[0]?.[0] ?? null;
  // No coloured button or link: the accent is the most-used coloured text (an eyebrow, a highlighted word), if any.
  const colouredText = textWeights.filter(([h]) => hexToOklch(h).c >= 0.06);
  const accent = topColours(accentWeights)[0]?.[0] ?? topColours(colouredText)[0]?.[0] ?? null;
  const palette = topColours([...bgWeights, ...textWeights.map(([h, w]) => [h, w * 4] as [string, number]), ...accentWeights])
    .slice(0, 6)
    .map(([h]) => h);
  const headings = samples.filter((s) => s.role === "heading");
  // Body text is paragraphs and list items; navigation, labels and footers would drag the size down.
  const prose = samples.filter((s) => /^(p|li|dd|td|blockquote)$/.test(s.tag) && s.text > 0);
  const body = prose.length > 0 ? prose : samples.filter((s) => s.role === "text" && s.text > 0);
  const h1 = samples.filter((s) => s.tag === "h1");
  const fontOf = (list: StyleSample[]) => {
    const tally = new Map<string, number>();
    for (const s of list) {
      const f = primaryFont(s.font);
      if (f) tally.set(f, (tally.get(f) ?? 0) + Math.max(1, s.text));
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const bodySizes = body.flatMap((s) => Array(Math.min(20, Math.max(1, Math.round(s.text / 20)))).fill(s.size));
  return {
    theme: background && hexToOklch(background).l < 0.5 ? "dark" : "light",
    background,
    text,
    accent,
    palette,
    fonts: { heading: fontOf(headings), body: fontOf(body) },
    sizes: { body: median(bodySizes), h1: median(h1.map((s) => s.size)) },
    headingWeight: median(headings.map((s) => s.weight)),
    radius: {
      button: buttonRadius(samples.filter((s) => s.role === "button")),
      surface: median(samples.filter((s) => (s.role === "surface" || s.role === "text") && s.radius > 0 && s.h >= 60 && s.area >= 120 * 60 && s.radius < s.h / 2).map((s) => s.radius)),
    },
    button: cssColor([...samples].filter((s) => s.role === "button" && cssColor(s.bg)).sort((a, b) => b.area - a.area)[0]?.bg ?? null),
  };
}

function buttonRadius(buttons: StyleSample[]): number | "pill" | null {
  const r = median(buttons.map((s) => s.radius));
  const h = median(buttons.map((s) => s.h));
  if (r === null) return null;
  return h !== null && r >= h / 2 - 1 ? "pill" : r;
}

/** One line per cue, for a person and for the model that reads the reference. */
export function describeCues(c: PageCues): string {
  const px = (n: number | "pill" | null) => (n === null ? "?" : n === "pill" ? "pill" : `${Math.round(n)}px`);
  return [
    `${c.theme} theme`,
    c.background && `background ${c.background}`,
    c.text && `text ${c.text}`,
    c.accent && `accent ${c.accent}`,
    c.button && `main button ${c.button}`,
    `fonts: ${c.fonts.heading ?? "?"} for headings, ${c.fonts.body ?? "?"} for text`,
    `body ${px(c.sizes.body)}, h1 ${px(c.sizes.h1)}${c.headingWeight ? `, headings weight ${c.headingWeight}` : ""}`,
    `corners: buttons ${px(c.radius.button)}, surfaces ${px(c.radius.surface)}`,
  ]
    .filter(Boolean)
    .join("; ");
}

// ----------------------------------------------------------------------------------------------- what stops a capture

export interface PageVisit {
  finalUrl: string;
  status: number | null;
  title: string;
  /** A visible password field: a sign-in page, whatever its address says. */
  passwordField: boolean;
  desktop: Buffer;
  phone: Buffer | null;
  samples: StyleSample[];
}

const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|signin|auth|sso|session\/new|account\/login)(\/|$|\?)/i;
const BOT_WALL = /just a moment|attention required|access denied|are you a (robot|human)|verify you are human|captcha|enable javascript and cookies/i;

/** Why a visited page is not the page the person meant, or null when it is. */
export function whyNotCaptured(v: Pick<PageVisit, "finalUrl" | "status" | "title" | "passwordField">): string | null {
  if (v.status === 401 || v.status === 403) {
    return BOT_WALL.test(v.title) ? "the site blocks automated browsers" : `it answered ${v.status}: it needs sign-in`;
  }
  if (BOT_WALL.test(v.title)) return "the site blocks automated browsers";
  if (v.status !== null && v.status >= 400) return `it answered ${v.status}`;
  let p = "";
  try {
    p = new URL(v.finalUrl).pathname + new URL(v.finalUrl).search;
  } catch {
    // keep empty
  }
  if (SIGN_IN_PATH.test(p) || v.passwordField) return "it is behind a sign-in page";
  return null;
}

// ----------------------------------------------------------------------------------------------- the whole step

export interface Reference {
  /** What the person gave. */
  input: string;
  kind: ReferenceKind;
  label: string;
  /** ok: captured or loaded; needs-screenshot: could not be captured, ask for one; refused: not usable; recalled: named only. */
  status: "ok" | "needs-screenshot" | "refused" | "recalled";
  /** Repo-relative images, desktop first. */
  images: string[];
  cues?: PageCues;
  note?: string;
}

/** Opens public pages for references. Injected, so the rules are tested without a browser or the network. */
export interface ReferenceBrowser {
  visit(url: string): Promise<PageVisit>;
  close(): Promise<void>;
}

const slug = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "reference";

export async function gatherReferences(
  inputs: string[],
  o: {
    repoRoot: string;
    outDir: string;
    /** null when no browser is available; URLs are then asked for as screenshots. */
    browser: ReferenceBrowser | null;
    cwd?: string;
    max?: number;
    /** Is this a public web address? Defaults to the competitor reader's guard. */
    isPublic?: (url: string) => Promise<URL | null>;
  }
): Promise<Reference[]> {
  const max = o.max ?? MAX_REFERENCES;
  const isPublic = o.isPublic ?? safeToFetch;
  const rel = (abs: string) => path.relative(o.repoRoot, abs).replace(/\\/g, "/");
  const out: Reference[] = [];
  fs.mkdirSync(o.outDir, { recursive: true });

  for (const [i, raw] of inputs.map((s) => s.trim()).filter(Boolean).entries()) {
    const { kind, value } = classifyReference(raw, o.cwd ?? o.repoRoot);
    if (i >= max) {
      out.push({ input: raw, kind, label: raw, status: "refused", images: [], note: `over the ${max}-reference limit` });
      continue;
    }
    if (kind === "named") {
      out.push({ input: raw, kind, label: raw, status: "recalled", images: [], note: "not looked at: only what a model already knows about it, never presented as measured" });
      continue;
    }
    if (kind === "image") {
      try {
        const a = await loadAttachment(value, o.repoRoot);
        const m = a.kind === "image" ? a.content.match(/^data:image\/([a-z0-9.+-]+);base64,(.*)$/i) : null;
        if (!m) throw new Error("not an image");
        const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase().replace(/[^a-z0-9]/g, "");
        const file = path.join(o.outDir, `ref-${i + 1}-${slug(path.basename(value, path.extname(value)))}.${ext}`);
        fs.writeFileSync(file, Buffer.from(m[2], "base64"));
        out.push({ input: raw, kind, label: path.basename(value), status: "ok", images: [rel(file)] });
      } catch (err: any) {
        out.push({ input: raw, kind, label: path.basename(value), status: "refused", images: [], note: String(err?.message ?? err).split("\n")[0] });
      }
      continue;
    }
    // A URL.
    const label = value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (!(await isPublic(value))) {
      out.push({ input: raw, kind, label, status: "refused", images: [], note: "not a public web address (local, private, or not http/https): send a screenshot instead" });
      continue;
    }
    if (!o.browser) {
      out.push({ input: raw, kind, label, status: "needs-screenshot", images: [], note: "no browser is available to open it (Playwright): send a screenshot instead" });
      continue;
    }
    let visit: PageVisit;
    try {
      visit = await o.browser.visit(value);
    } catch (err: any) {
      out.push({ input: raw, kind, label, status: "needs-screenshot", images: [], note: `it could not be opened (${String(err?.message ?? err).split("\n")[0].slice(0, 140)}): send a screenshot instead` });
      continue;
    }
    const why = whyNotCaptured(visit);
    if (why) {
      out.push({ input: raw, kind, label, status: "needs-screenshot", images: [], note: `${why}: send a screenshot instead` });
      continue;
    }
    const base = path.join(o.outDir, `ref-${i + 1}-${slug(label)}`);
    fs.writeFileSync(`${base}-desktop.png`, visit.desktop);
    const images = [rel(`${base}-desktop.png`)];
    if (visit.phone) {
      fs.writeFileSync(`${base}-phone.png`, visit.phone);
      images.push(rel(`${base}-phone.png`));
    }
    out.push({ input: raw, kind, label, status: "ok", images, cues: cuesFromSamples(visit.samples) });
  }

  fs.writeFileSync(path.join(o.outDir, "references.json"), JSON.stringify({ references: out, at: new Date().toISOString() }, null, 2));
  return out;
}

export function describeReferences(refs: Reference[]): string[] {
  return refs.map((r) => {
    if (r.status === "ok") return `[REFERENCE] ${r.label}: ${r.kind === "url" ? `captured${r.cues ? ` (${describeCues(r.cues)})` : ""}` : "loaded"}.`;
    if (r.status === "recalled") return `[REFERENCE] ${r.label}: ${r.note}.`;
    return `[REFERENCE] ${r.label}: skipped, ${r.note}.`;
  });
}

// ----------------------------------------------------------------------------------------------- the real browser

/** Runs in the page: every visible element's computed look, capped, largest first. Kept as a string so no DOM types are needed here. */
const SAMPLE_SCRIPT = `(() => {
  const out = [];
  const vh = innerHeight * ${MAX_PAGE_HEIGHTS};
  for (const el of document.querySelectorAll("body, body *")) {
    if (out.length > 1500) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.top > vh || r.bottom < 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
    const tag = el.tagName.toLowerCase();
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").length;
    const role = /^h[1-3]$/.test(tag) ? "heading"
      : (tag === "button" || el.getAttribute("role") === "button" || (tag === "a" && parseFloat(cs.paddingLeft) >= 8 && cs.backgroundColor !== "rgba(0, 0, 0, 0)")) ? "button"
      : tag === "a" ? "link"
      : own > 0 ? "text" : "surface";
    out.push({ tag, role, bg: cs.backgroundColor, color: cs.color, font: cs.fontFamily, size: parseFloat(cs.fontSize) || 0, weight: Number(cs.fontWeight) || 400,
      radius: parseFloat(cs.borderTopLeftRadius) || 0, h: Math.round(r.height), area: Math.round(Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) * r.width), text: own });
  }
  return { samples: out, title: document.title, password: !!document.querySelector('input[type="password"]:not([hidden])') };
})()`;

/** A headless browser for references, every request guarded (see requestVerdict). null when Playwright is not installed. */
export async function referenceBrowser(): Promise<ReferenceBrowser | null> {
  let browser: any;
  try {
    const mod: any = await import("playwright");
    browser = await mod.chromium.launch({ headless: true });
  } catch {
    return null;
  }
  const hostOk = hostChecker();
  const guard = async (route: any) => {
    const url: string = route.request().url();
    const v = requestVerdict(url);
    if (v === "allow") return route.continue();
    if (v === "block") return route.abort();
    return (await hostOk(new URL(url).hostname)) ? route.continue() : route.abort();
  };
  const open = async (url: string, vp: { width: number; height: number }, phone: boolean) => {
    const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, acceptDownloads: false, serviceWorkers: "block", permissions: [] });
    await context.route("**/*", guard);
    const page = await context.newPage();
    let status: number | null = null;
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      status = res?.status() ?? null;
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
      await page.waitForTimeout(500);
    } catch (err) {
      await context.close();
      throw err;
    }
    return { context, page, status };
  };
  const shot = async (page: any, vp: { width: number; height: number }) => {
    // No mobile viewport tag: the page is laid out wide and zoomed out on a phone; take that view, not a strip of the wide layout.
    const layout = Number(await page.evaluate("document.documentElement.clientWidth").catch(() => vp.width)) || vp.width;
    if (layout > vp.width + 1) return (await page.screenshot({ type: "png" })) as Buffer;
    const full = Number(await page.evaluate("document.documentElement.scrollHeight").catch(() => vp.height)) || vp.height;
    const height = Math.min(Math.max(vp.height, full), vp.height * MAX_PAGE_HEIGHTS);
    return (await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: vp.width, height } })) as Buffer;
  };
  return {
    async visit(url) {
      const d = await open(url, REF_DESKTOP, false);
      try {
        const info = (await d.page.evaluate(SAMPLE_SCRIPT)) as { samples: StyleSample[]; title: string; password: boolean };
        const desktop = await shot(d.page, REF_DESKTOP);
        const finalUrl: string = d.page.url();
        let phone: Buffer | null = null;
        try {
          const m = await open(url, REF_PHONE, true);
          try {
            phone = await shot(m.page, REF_PHONE);
          } finally {
            await m.context.close();
          }
        } catch {
          // the desktop capture is enough to go on
        }
        return { finalUrl, status: d.status, title: info.title ?? "", passwordField: !!info.password, desktop, phone, samples: info.samples ?? [] };
      } finally {
        await d.context.close();
      }
    },
    async close() {
      try {
        await browser.close();
      } catch {
        // already gone
      }
    },
  };
}
