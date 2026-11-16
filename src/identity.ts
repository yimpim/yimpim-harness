/**
 * One identity, two makers. The logo designer and the UI designer must never end up with unrelated colours
 * or type, so they share one source of truth in the project, and whichever runs second honours the first:
 *
 *   brand kit first  (brand/<name>/brand.json): the UI design system reuses its measured palette, its type and
 *                    its logo files; nothing about the identity is chosen again.
 *   UI theme first   (design-system/design.json): the logo's main colour must be the UI's signature colour, the
 *                    brand palette uses the same ground and neutral tint, and the wordmark is nudged toward the
 *                    UI's heading face.
 *
 * If both exist, the brand kit wins: it is the approved identity.
 */
import fs from "node:fs";
import path from "node:path";
import { deltaE2000, hexToOklch } from "./colorlib.js";
import { ROLE_KEYS, type PaletteSystem } from "./palette.js";
import { normalizeColor, themeReport } from "./svgSafety.js";

export const DESIGN_DIR = "design-system";
export const THEME_FILE = "design.json";

// ---------------------------------------------------------------------------
// brand kit -> UI
// ---------------------------------------------------------------------------

export interface BrandFacts {
  signature: string;
  accent: string | null;
  display?: string;
  body?: string;
  name?: string;
  /** The kit's measured palette, when it is complete and well formed. */
  palette?: PaletteSystem;
  /** Project-relative folder of the kit, with forward slashes. */
  dir: string;
  personality: string[];
  idea?: string;
  /** Files in the kit that a UI should use (logos, lockups, favicon, app icons). */
  files: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A palette read back from brand.json, accepted only when every part a UI needs is present and valid. */
export function readPalette(raw: any): PaletteSystem | null {
  if (!raw || typeof raw !== "object") return null;
  const roles = (r: any) => !!r && typeof r === "object" && ROLE_KEYS.every((k) => HEX.test(String(r[k] ?? "")));
  if (!roles(raw.light) || !roles(raw.dark)) return null;
  if (!Array.isArray(raw.brand) || raw.brand.length === 0 || !raw.brand.every((b: any) => HEX.test(String(b?.hex ?? "")))) return null;
  const sc = raw.scales;
  const ladder = (l: any) => Array.isArray(l) && l.length === 11 && l.every((s: any) => HEX.test(String(s?.hex ?? "")) && Number.isFinite(Number(s?.step)));
  if (!sc || !ladder(sc.primary) || !ladder(sc.neutral)) return null;
  return {
    brand: raw.brand.map((b: any) => ({ hex: String(b.hex), name: String(b.name ?? "Colour").slice(0, 40), usage: String(b.usage ?? "").slice(0, 120), locked: b.locked !== false })),
    scales: Object.fromEntries(Object.entries(sc).filter(([, v]) => ladder(v)).map(([k, v]: [string, any]) => [k, v.map((s: any) => ({ step: Number(s.step), hex: String(s.hex) }))])),
    light: Object.fromEntries(ROLE_KEYS.map((k) => [k, String(raw.light[k])])) as any,
    dark: Object.fromEntries(ROLE_KEYS.map((k) => [k, String(raw.dark[k])])) as any,
    ground: raw.ground === "warm" || raw.ground === "cool" ? raw.ground : "white",
    checks: Array.isArray(raw.checks) ? raw.checks.filter((c: any) => c && typeof c.id === "string" && typeof c.detail === "string").map((c: any) => ({ id: c.id, kind: c.kind === "gate" || c.kind === "judgement" ? c.kind : "warning", status: c.status === "pass" || c.status === "fail" ? c.status : "not-checked", detail: String(c.detail).slice(0, 300) })) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.map((n: any) => String(n).slice(0, 200)) : [],
  };
}

const KIT_FILES = ["logo-on-light.svg", "logo-on-dark.svg", "logo.svg", "logo-black.svg", "logo-white.svg", "lockup-horizontal.svg", "lockup-horizontal-on-dark.svg", "lockup-stacked.svg", "lockup-stacked-on-dark.svg", "wordmark.svg", "wordmark-on-dark.svg", "favicon.svg", "favicon.ico", "app-icon.svg", "app-icon-dark.svg", "apple-touch-icon.png", "maskable-icon.svg", "guidelines.pdf"];

/** The newest brand kit in the project (brand/<name>/brand.json), or null. */
export function findBrandKit(repoRoot: string, outputDir = "brand"): BrandFacts | null {
  const base = path.join(repoRoot, outputDir);
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  let best: { facts: BrandFacts; at: number } | null = null;
  for (const d of dirs) {
    try {
      const file = path.join(base, d, "brand.json");
      const j = JSON.parse(fs.readFileSync(file, "utf-8"));
      const swatches: { hex?: string }[] = Array.isArray(j?.paletteSystem?.brand) ? j.paletteSystem.brand : [];
      const hexes = swatches.map((s) => normalizeColor(String(s.hex ?? ""))).filter((h): h is string => !!h);
      const chromatic = hexes.filter((h) => hexToOklch(h).c >= 0.06);
      if (chromatic.length === 0) continue;
      const at = fs.statSync(file).mtimeMs;
      if (best && at <= best.at) continue;
      const pairing = j?.typography?.pairing;
      const dir = `${outputDir}/${d}`;
      best = {
        at,
        facts: {
          signature: chromatic[0],
          accent: chromatic[1] ?? null,
          display: pairing?.display ?? j?.typography?.wordmark?.family,
          body: pairing?.body,
          name: typeof j?.name === "string" ? j.name : undefined,
          palette: readPalette(j?.paletteSystem) ?? undefined,
          dir,
          personality: Array.isArray(j?.brief?.personality) ? j.brief.personality.map((p: any) => String(p).slice(0, 30)).slice(0, 5) : [],
          idea: typeof j?.mechanism === "string" ? j.mechanism.slice(0, 200) : typeof j?.concept?.idea === "string" ? j.concept.idea.slice(0, 200) : undefined,
          files: KIT_FILES.filter((f) => fs.existsSync(path.join(base, d, f))),
        },
      };
    } catch {
      // not a brand kit
    }
  }
  return best?.facts ?? null;
}

// ---------------------------------------------------------------------------
// UI theme -> logo
// ---------------------------------------------------------------------------

export interface UiTheme {
  name: string;
  signature: string;
  accent: string | null;
  ground: "white" | "warm" | "cool";
  neutralHue: number | null;
  heading: string;
  body: string;
  style: string;
  personality: string[];
  memorableMove: string;
  /** "brand" when the UI took its identity from a brand kit, "ui" when the UI chose it. */
  source: "brand" | "ui";
  brandDir?: string;
}

export function writeUiTheme(dir: string, theme: UiTheme): void {
  fs.writeFileSync(path.join(dir, THEME_FILE), JSON.stringify({ ...theme, createdAt: new Date().toISOString() }, null, 2) + "\n");
}

export function readUiTheme(repoRoot: string): UiTheme | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repoRoot, DESIGN_DIR, THEME_FILE), "utf-8"));
    const signature = normalizeColor(String(j?.signature ?? ""));
    if (!signature) return null;
    const accent = j?.accent ? normalizeColor(String(j.accent)) : null;
    const nh = Number(j?.neutralHue);
    return {
      name: String(j?.name ?? "").slice(0, 60),
      signature,
      accent,
      ground: j?.ground === "warm" || j?.ground === "cool" ? j.ground : "white",
      neutralHue: Number.isFinite(nh) ? nh : null,
      heading: String(j?.heading ?? "").slice(0, 60),
      body: String(j?.body ?? "").slice(0, 60),
      style: String(j?.style ?? "").slice(0, 40),
      personality: Array.isArray(j?.personality) ? j.personality.map((p: any) => String(p).slice(0, 30)).slice(0, 5) : [],
      memorableMove: String(j?.memorableMove ?? "").slice(0, 240),
      source: j?.source === "brand" ? "brand" : "ui",
      brandDir: typeof j?.brandDir === "string" ? j.brandDir : undefined,
    };
  } catch {
    return null;
  }
}

/** What a logo designer is told when the product already has a UI theme. */
export function themeConstraints(t: UiTheme): string[] {
  return [
    `The product's UI already uses ${t.signature} as its signature colour${t.accent ? ` and ${t.accent} as its accent` : ""}. The logo's main colour must be exactly ${t.signature}${t.accent ? `; a second colour, if there is one, must be ${t.accent}` : ""}. Do not introduce a different brand colour.`,
    ...(t.heading ? [`The UI sets headings in ${t.heading}${t.body && t.body !== t.heading ? ` and text in ${t.body}` : ""}: the wordmark should sit comfortably with that voice${t.style ? ` (the UI's style is ${t.style})` : ""}.`] : []),
    ...(t.personality.length ? [`The UI's personality is ${t.personality.join(", ")}: the mark should feel the same.`] : []),
  ];
}

/**
 * Defects a drawn mark has against the product's UI theme (empty when it fits or there is no theme). A mark whose
 * main colour is far from the UI's signature would give the product two unrelated identities.
 */
export function identityDefects(svg: string, theme: Pick<UiTheme, "signature"> | undefined): string[] {
  if (!theme) return [];
  const base = themeReport(svg).base;
  if (!base) return [];
  if (deltaE2000(base, theme.signature) < 12) return [];
  return [`The mark's main colour ${base} does not match the product UI's signature colour ${theme.signature}. Use ${theme.signature} for the main shape, so the logo and the UI are one identity.`];
}

export const IDENTITY_PENALTY = 1.5;
