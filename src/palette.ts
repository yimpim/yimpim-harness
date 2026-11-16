/**
 * The colour system behind a logo. The logo's own colours are LOCKED brand colours (never edited to
 * pass a check). A model chooses what judgement should choose (an accent if the logo has none, the
 * light ground, the neutral's tint, names); code builds the ladders, derives the light and dark
 * roles, measures every pair (WCAG, no rounding), checks colour-vision confusion and competitor
 * closeness, and writes tokens. Failures that cannot be fixed by moving along a scale are reported
 * as gates, never hidden.
 */
import {
  STEPS, bestTextOn, contrast, deltaE2000, hexToOklch, hueGap, neutralScale, oklchToHex, scaleOf, simulateCvd, tooClose, type Cvd,
} from "./colorlib.js";
import { normalizeColor } from "./svgSafety.js";
import { colourDefaultHit } from "./designDefaults.js";

export interface Swatch {
  hex: string;
  name: string;
  usage: string;
  /** locked: the logo's own colour, exactly as designed */
  locked: boolean;
}

export const ROLE_KEYS = [
  "background", "surface", "surfaceAlt", "border", "text", "textMuted", "primary", "onPrimary",
  "accent", "onAccent", "link", "focus", "success", "warning", "danger", "info",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type Roles = Record<RoleKey, string>;

export interface Check {
  id: string;
  /** gate: measured, can fail. warning: heuristic. judgement: opinion. */
  kind: "gate" | "warning" | "judgement";
  status: "pass" | "fail" | "not-checked";
  detail: string;
}

export interface PaletteSystem {
  brand: Swatch[];
  scales: Record<string, { step: number; hex: string }[]>;
  light: Roles;
  dark: Roles;
  ground: "white" | "warm" | "cool";
  checks: Check[];
  notes: string[];
}

export interface PaletteChoice {
  names: Record<string, string>;
  accent: string | null;
  ground: "white" | "warm" | "cool";
  neutralHue: number | null;
  usage: Record<string, string>;
  why: string;
}

export interface Rival {
  name: string;
  hex: string;
  /** measured: read from their page; recalled: from a model's memory, unverified */
  source: "measured" | "recalled";
}

const near = (a: string, b: string, lim = 20) => deltaE2000(a, b) < lim;

/** Walk a ladder from a starting step in a direction until the pair passes, returning the first passing step. */
function walk(scale: { step: number; hex: string }[], from: string, dir: 1 | -1, ok: (hex: string) => boolean): string | null {
  let i = scale.findIndex((s) => s.hex.toLowerCase() === from.toLowerCase());
  if (i < 0) i = 5;
  for (let k = i; k >= 0 && k < scale.length; k += dir) if (ok(scale[k].hex)) return scale[k].hex;
  return null;
}

const mix = (a: string, b: string, t: number) => {
  const A = hexToOklch(a), B = hexToOklch(b);
  return oklchToHex(A.l + (B.l - A.l) * t, A.c + (B.c - A.c) * t, A.h);
};

/**
 * A focus ring has to be seen against the page AND against a filled control. Try the brand's own ladder
 * (nearest step first); if no step does both, use the text colour or white or black, whichever does.
 */
function focusColour(scale: { step: number; hex: string }[], from: string, bg: string, fillHex: string, text: string): string {
  const both = (h: string) => contrast(h, bg) >= 3 && contrast(h, fillHex) >= 3;
  const onPage = (h: string) => contrast(h, bg) >= 3;
  const i0 = Math.max(0, scale.findIndex((s) => s.hex.toLowerCase() === from.toLowerCase()));
  const order = [...scale].sort((a, b) => Math.abs(scale.indexOf(a) - i0) - Math.abs(scale.indexOf(b) - i0));
  // A ring that clears both the page and a filled control if one exists; otherwise one that clears the page
  // (the ring is drawn with an offset gap, so it is seen against the page, not against the fill).
  return order.find((s) => both(s.hex))?.hex ?? [text, "#ffffff", "#0b0b0f"].find(both) ?? order.find((s) => onPage(s.hex))?.hex ?? text;
}

/**
 * Parses the model's choice. It may only choose; anything not a valid colour or a known ground is dropped.
 */
export function parsePaletteChoice(j: any, lockedHexes: string[]): PaletteChoice {
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(j?.names && typeof j.names === "object" ? j.names : {})) {
    const hex = normalizeColor(String(k));
    if (hex && typeof v === "string" && v.trim()) names[hex] = v.trim().slice(0, 30);
  }
  const usage: Record<string, string> = {};
  for (const [k, v] of Object.entries(j?.usage && typeof j.usage === "object" ? j.usage : {})) {
    const hex = normalizeColor(String(k));
    if (hex && typeof v === "string" && v.trim()) usage[hex] = v.trim().slice(0, 100);
  }
  let accent = typeof j?.accent === "string" ? normalizeColor(j.accent) : null;
  // An accent that is the same colour as the logo's gives nothing; it must also be chromatic.
  if (accent && (lockedHexes.some((h) => near(h, accent as string, 15)) || hexToOklch(accent).c < 0.05)) accent = null;
  const ground = j?.ground === "warm" || j?.ground === "cool" ? j.ground : "white";
  const nh = Number(j?.neutralHue);
  return {
    names, accent, ground, usage,
    neutralHue: Number.isFinite(nh) ? ((nh % 360) + 360) % 360 : null,
    why: typeof j?.why === "string" ? j.why.slice(0, 300) : "",
  };
}

export const PALETTE_SYSTEM =
  "You choose the colour system around a logo. The logo's colours are LOCKED: never change or replace them. " +
  "Choose ONLY: names for each colour, a short usage for each, ONE accent colour if the logo has no second chromatic colour (or null), " +
  'the light ground ("white" clinical, "warm" cream, "cool" pale blue-grey), and the hue (0-360) the neutrals lean toward. ' +
  "Rules: two or three hues in total, one signature colour, an accent that differs in HUE and stays small; the loudest colour takes the least area. " +
  "Choose against the category and the competitors listed unless the brief gives a reason. Colour associations are weak and contextual: do not claim a colour builds trust or converts. " +
  "Exactly one part of the identity is loud (the mark, the type or the colour): the mark is already chosen, so keep the colour as loud as the mark, not louder. " +
  'Respond ONLY with JSON: {"names": {"#hex": "Name"}, "usage": {"#hex": "where it is used"}, "accent": "#hex"|null, "ground": "white"|"warm"|"cool", "neutralHue": number, "why": "one sentence"}';

// ---------------------------------------------------------------------------

/** Build the system. `logoColours` come from the chosen mark, the main one first. */
export function buildPalette(logoColours: string[], choice: PaletteChoice, rivals: Rival[] = []): PaletteSystem {
  const checks: Check[] = [];
  const notes: string[] = [];
  const locked = [...new Set(logoColours.map((c) => normalizeColor(c)).filter((c): c is string => !!c))];
  const chromatic = locked.filter((c) => hexToOklch(c).c >= 0.04);
  const primary = chromatic[0] ?? locked[0] ?? "#2563eb";
  const second = chromatic.find((c) => c !== primary && hueGap(hexToOklch(c).h, hexToOklch(primary).h) > 25);
  const accent = second ?? choice.accent ?? null;

  const brand: Swatch[] = [];
  const nameOf = (hex: string, fallback: string) => choice.names[hex] ?? fallback;
  for (const c of locked) {
    const role = c === primary ? "Signature" : c === second ? "Accent" : "Logo colour";
    brand.push({ hex: c, name: nameOf(c, role), usage: choice.usage[c] ?? (c === primary ? "logo, primary actions, key moments" : "logo detail"), locked: true });
  }
  if (accent && !locked.includes(accent)) brand.push({ hex: accent, name: nameOf(accent, "Accent"), usage: choice.usage[accent] ?? "small highlights", locked: false });

  const pOk = hexToOklch(primary);
  const neutralHue = choice.neutralHue ?? (pOk.c >= 0.04 ? pOk.h : 260);
  const nChroma = choice.ground === "white" ? 0.012 : 0.03;
  const neutral = neutralScale(neutralHue, nChroma);
  const scales: PaletteSystem["scales"] = { primary: scaleOf(primary), neutral };
  if (accent) scales.accent = scaleOf(accent);

  // ---- light mode
  const lightBg = choice.ground === "white" ? "#ffffff" : choice.ground === "warm" ? oklchToHex(0.975, 0.016, 80) : oklchToHex(0.975, 0.012, 250);
  const lightSurface = "#ffffff";
  const darkBg = oklchToHex(0.17, 0.02, neutralHue);
  const darkSurface = oklchToHex(0.21, 0.022, neutralHue);

  const fill = (hex: string, scale: { step: number; hex: string }[], dir: 1 | -1) => {
    // The brand colour itself when text can sit on it at 4.5:1, else the nearest step along the scale that can.
    if (bestTextOn(hex).ratio >= 4.5) return hex;
    return walk(scale, hex, dir, (h) => bestTextOn(h).ratio >= 4.5) ?? hex;
  };
  const light: Roles = {
    background: lightBg,
    surface: lightSurface,
    surfaceAlt: mix(lightBg, neutral[2].hex, 0.6),
    border: neutral[3].hex,
    text: neutral[10].hex,
    textMuted: walk(neutral, neutral[6].hex, 1, (h) => contrast(h, lightBg) >= 4.5 && contrast(h, lightSurface) >= 4.5) ?? neutral[8].hex,
    primary: "",
    onPrimary: "",
    accent: "",
    onAccent: "",
    link: "",
    focus: "",
    success: "", warning: "", danger: "", info: "",
  };
  light.primary = fill(primary, scales.primary, 1);
  light.onPrimary = bestTextOn(light.primary).color;
  const accentBase = accent ?? primary;
  const accentScale = scales.accent ?? scales.primary;
  light.accent = fill(accentBase, accentScale, 1);
  light.onAccent = bestTextOn(light.accent).color;
  light.link = walk(scales.primary, primary, 1, (h) => contrast(h, lightBg) >= 4.5 && contrast(h, lightSurface) >= 4.5) ?? scales.primary[9].hex;
  light.focus = focusColour(scales.primary, primary, lightBg, light.primary, light.text);

  // ---- dark mode: tinted near-black ground, brand fills lightened along their scale
  const dark: Roles = {
    background: darkBg,
    surface: darkSurface,
    surfaceAlt: oklchToHex(0.25, 0.024, neutralHue),
    border: oklchToHex(0.34, 0.024, neutralHue),
    // never pure white on near-black: long text glares
    text: neutral[0].hex,
    textMuted: walk(neutral, neutral[3].hex, -1, (h) => contrast(h, darkBg) >= 4.5 && contrast(h, darkSurface) >= 4.5) ?? neutral[2].hex,
    primary: "", onPrimary: "", accent: "", onAccent: "", link: "", focus: "",
    success: "", warning: "", danger: "", info: "",
  };
  const darkFill = (hex: string, scale: { step: number; hex: string }[]) => {
    const okFill = (h: string) => bestTextOn(h).ratio >= 4.5 && contrast(h, darkBg) >= 3;
    if (okFill(hex)) return hex;
    return walk(scale, hex, -1, okFill) ?? walk(scale, hex, 1, okFill) ?? hex;
  };
  dark.primary = darkFill(primary, scales.primary);
  dark.onPrimary = bestTextOn(dark.primary).color;
  dark.accent = darkFill(accentBase, accentScale);
  dark.onAccent = bestTextOn(dark.accent).color;
  dark.link = walk(scales.primary, primary, -1, (h) => contrast(h, darkBg) >= 4.5 && contrast(h, darkSurface) >= 4.5) ?? scales.primary[2].hex;
  dark.focus = focusColour(scales.primary, primary, darkBg, dark.primary, dark.text);

  // ---- status colours: fixed hues, moved if they would be mistaken for the brand
  const sem: Record<"success" | "warning" | "danger" | "info", number> = { success: 145, warning: 80, danger: 27, info: 245 };
  for (const k of Object.keys(sem) as (keyof typeof sem)[]) {
    let h = sem[k];
    const lightHex = (hue: number) => oklchToHex(0.48, 0.16, hue);
    if (near(lightHex(h), primary, 14) && hueGap(h, pOk.h) < 25) {
      h = (h + 28) % 360;
      notes.push(`The ${k} colour was moved ${28} degrees in hue so it is not mistaken for the signature colour.`);
    }
    // as text on the light ground it must reach 4.5; as text on the dark ground too
    // Different starting lightness per status, so success and danger differ in lightness (greyscale and red-green viewers rely on that).
    let l = { success: 0.4, warning: 0.5, danger: 0.56, info: 0.45 }[k];
    let hexL = oklchToHex(l, 0.16, h);
    for (let i = 0; i < 12 && contrast(hexL, lightBg) < 4.5; i++) hexL = oklchToHex((l -= 0.03), 0.16, h);
    let ld = { success: 0.82, warning: 0.78, danger: 0.68, info: 0.72 }[k];
    let hexD = oklchToHex(ld, 0.15, h);
    for (let i = 0; i < 12 && contrast(hexD, darkBg) < 4.5; i++) hexD = oklchToHex((ld += 0.03), 0.15, h);
    light[k] = hexL;
    dark[k] = hexD;
  }

  // ---- gates: every pair, both modes, no rounding
  const pairs = (modeName: "light" | "dark", r: Roles): [string, string, string, number][] => [
    ["text on background", r.text, r.background, 4.5],
    ["text on surface", r.text, r.surface, 4.5],
    ["text on surfaceAlt", r.text, r.surfaceAlt, 4.5],
    ["textMuted on background", r.textMuted, r.background, 4.5],
    ["textMuted on surface", r.textMuted, r.surface, 4.5],
    ["onPrimary on primary", r.onPrimary, r.primary, 4.5],
    ["onAccent on accent", r.onAccent, r.accent, 4.5],
    ["link on background", r.link, r.background, 4.5],
    ["link on surface", r.link, r.surface, 4.5],
    ["focus on background", r.focus, r.background, 3],
    ["success text on background", r.success, r.background, 4.5],
    ["warning text on background", r.warning, r.background, 4.5],
    ["danger text on background", r.danger, r.background, 4.5],
    ["info text on background", r.info, r.background, 4.5],
  ].map(([n, a, b, t]) => [`${modeName}: ${n}`, a as string, b as string, t as number]);
  const failed: string[] = [];
  let tested = 0;
  for (const [modeName, r] of [["light", light], ["dark", dark]] as const) {
    for (const [n, a, b, t] of pairs(modeName, r)) {
      tested++;
      const ratio = contrast(a, b);
      if (ratio < t) failed.push(`${n} ${ratio.toFixed(2)}:1 (needs ${t}:1)`);
    }
  }
  // The signature colour as a plain fill on the ground needs 3:1 only in the role it is used as fill; a pale brand is reported, never edited.
  checks.push({
    id: "contrast",
    kind: "gate",
    status: failed.length === 0 ? "pass" : "fail",
    detail: failed.length === 0 ? `${tested} text and control pairs measured in light and dark, none under its threshold (no rounding).` : `${failed.length} of ${tested} pairs fail: ${failed.slice(0, 5).join("; ")}.`,
  });
  const lockedMoved = brand.filter((b) => b.locked).length > 0 && (light.primary !== primary || dark.primary !== primary);
  if (lockedMoved) notes.push(`The signature colour ${primary} is kept exactly for the logo and large areas; the UI roles use the nearest step along its scale where text could not sit on it at 4.5:1.`);

  // pure white text on near-black is a classic glare
  checks.push({ id: "dark-text-not-pure-white", kind: "warning", status: dark.text.toLowerCase() === "#ffffff" ? "fail" : "pass", detail: "Body text on the dark ground is a soft white, not #ffffff." });

  // neutrals read as neutrals
  const nMax = Math.max(...neutral.map((n) => hexToOklch(n.hex).c));
  checks.push({ id: "neutral-chroma", kind: "warning", status: nMax <= 0.05 ? "pass" : "fail", detail: `Neutrals peak at chroma ${nMax.toFixed(3)} (a tinted neutral stays at or under 0.045).` });

  // colour-vision confusion between colours meant to be told apart
  const parts = brand.map((b) => b.hex);
  if (parts.length >= 2) {
    const bad: string[] = [];
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) {
        for (const kind of ["protan", "deutan", "tritan"] as Cvd[]) {
          const d = deltaE2000(simulateCvd(parts[i], kind), simulateCvd(parts[j], kind));
          if (d < 6) bad.push(`${parts[i]} vs ${parts[j]} merge for ${kind} (ΔE ${d.toFixed(1)})`);
        }
        const dl = Math.abs(hexToOklch(parts[i]).l - hexToOklch(parts[j]).l) * 100;
        if (dl < 12 && hexToOklch(parts[i]).c > 0.08 && hexToOklch(parts[j]).c > 0.08) bad.push(`${parts[i]} and ${parts[j]} have nearly the same lightness (greyscale and colour-blind viewers lose the difference)`);
      }
    checks.push({
      id: "colour-vision",
      kind: "warning",
      status: bad.length ? "fail" : "pass",
      detail: bad.length ? `${bad.join("; ")}. Separate them by lightness, not hue.` : "Brand colours stay distinct under protan, deutan and tritan simulation (Machado 2009 model; a screen, not a diagnosis).",
    });
  }
  // status colours must not merge with each other for red-green deficiency
  const dL = (r: Roles) => Math.abs(hexToOklch(r.success).l - hexToOklch(r.danger).l) * 100;
  const sd = Math.min(dL(light), dL(dark));
  checks.push({ id: "status-not-by-colour-alone", kind: "warning", status: sd >= 8 ? "pass" : "fail", detail: `Success and danger differ in lightness by ${sd.toFixed(0)} points (at least 8 keeps them apart in greyscale and for red-green colour blindness); still pair them with an icon or a word: meaning is never by colour alone.` });

  // competitors
  if (rivals.length === 0) {
    checks.push({ id: "competitor-colours", kind: "gate", status: "not-checked", detail: "No competitor colours were available (none named, or their sites could not be read)." });
  } else {
    const clash = rivals.filter((r) => tooClose(primary, r.hex));
    checks.push({
      id: "competitor-colours",
      kind: "gate",
      status: clash.length ? "fail" : "pass",
      detail:
        (clash.length ? `The signature colour is close to ${clash.map((c) => `${c.name} ${c.hex} (${c.source})`).join(", ")}.` : `The signature colour is not close to ${rivals.map((r) => r.name).join(", ")} (ΔE2000 at least 10 and a different hue sector or lightness).`) +
        (rivals.every((r) => r.source === "recalled") ? " Their colours are from model memory, unverified." : ""),
    });
  }
  const reflex = colourDefaultHit(primary, accent, choice.ground);
  checks.push({
    id: "ai-default-colours",
    kind: "warning",
    status: reflex ? "fail" : "pass",
    detail: reflex ? `This palette is a common model default (${reflex}); keep it only if the brief justifies it.` : "The palette is not one of the common model default clusters (cream with terracotta and gold; navy with gold).",
  });
  checks.push({ id: "choice", kind: "judgement", status: "pass", detail: choice.why || "Ground, neutral tint and names were chosen by a model; the numbers above were measured." });

  return { brand, scales, light, dark, ground: choice.ground, checks, notes };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

export function tokensCss(p: PaletteSystem, prefix = "bi"): string {
  const lines: string[] = ["/* Generated. Change the palette source and re-export; do not edit by hand. */", ":root {"];
  for (const [name, scale] of Object.entries(p.scales)) for (const s of scale) lines.push(`  --${prefix}-${name}-${s.step}: ${s.hex};`);
  p.brand.forEach((b, i) => lines.push(`  --${prefix}-brand-${i + 1}: ${b.hex}; /* ${b.name} */`));
  const roles = (r: Roles) => ROLE_KEYS.map((k) => `  --${prefix}-${kebab(k)}: ${r[k]};`);
  lines.push(...roles(p.light), "  color-scheme: light;", "}", '[data-theme="dark"] {', ...roles(p.dark), "  color-scheme: dark;", "}", "@media (prefers-color-scheme: dark) {", '  :root:not([data-theme="light"]) {', ...roles(p.dark).map((l) => "  " + l), "    color-scheme: dark;", "  }", "}");
  return lines.join("\n") + "\n";
}

export function tokensDtcg(p: PaletteSystem): string {
  const tok = (v: string, extra: object = {}) => ({ $type: "color", $value: v, ...extra });
  const out: any = { brand: {}, scale: {}, light: {}, dark: {} };
  p.brand.forEach((b, i) => (out.brand[`brand-${i + 1}`] = tok(b.hex, { $description: `${b.name}: ${b.usage}` })));
  for (const [n, sc] of Object.entries(p.scales)) {
    out.scale[n] = {};
    for (const s of sc) out.scale[n][String(s.step)] = tok(s.hex);
  }
  for (const k of ROLE_KEYS) {
    out.light[k] = tok(p.light[k]);
    out.dark[k] = tok(p.dark[k]);
  }
  return JSON.stringify(out, null, 2) + "\n";
}

export function tokensTailwind(p: PaletteSystem): string {
  const body = ROLE_KEYS.map((k) => `      "${kebab(k)}": "var(--bi-${kebab(k)})",`).join("\n");
  return `// Tailwind v3. Colours are CSS variables, so light/dark follow tokens.css. For v4 map them in @theme inline.\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n${body}\n      },\n    },\n  },\n};\n`;
}

export function paletteGpl(p: PaletteSystem): string {
  const lines = ["GIMP Palette", "Name: Brand", "Columns: 4", "#"];
  const add = (hex: string, name: string) => {
    const n = parseInt(hex.slice(1), 16);
    lines.push(`${String((n >> 16) & 255).padStart(3)} ${String((n >> 8) & 255).padStart(3)} ${String(n & 255).padStart(3)} ${name}`);
  };
  for (const b of p.brand) add(b.hex, b.name);
  return lines.join("\n") + "\n";
}

export function paletteMarkdown(p: PaletteSystem): string {
  const row = (k: RoleKey) => `| ${k} | ${p.light[k]} | ${p.dark[k]} |`;
  return (
    `## Colour system\n\n` +
    `| Colour | Hex | Use |\n|---|---|---|\n${p.brand.map((b) => `| ${b.name}${b.locked ? " (from the logo)" : ""} | ${b.hex} | ${b.usage} |`).join("\n")}\n\n` +
    `Roles (use these in code; not the raw scale steps, which break in dark mode):\n\n| Role | Light | Dark |\n|---|---|---|\n${ROLE_KEYS.map(row).join("\n")}\n\n` +
    `Checks (a gate is measured and can fail; a warning is a heuristic; a judgement is an opinion):\n${p.checks.map((c) => `- ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "NOT CHECKED"} [${c.kind}] ${c.id}: ${c.detail}`).join("\n")}\n\n` +
    (p.notes.length ? `Notes:\n${p.notes.map((n) => `- ${n}`).join("\n")}\n\n` : "") +
    `Print: CMYK and Pantone are not given. Screen colours are sRGB; ask the printer to match from the hex with their own profile and approve a physical proof.\n\n`
  );
}

/** A picture of the palette, to look at before it is used. */
export function paletteCardHtml(p: PaletteSystem, name: string): string {
  const sw = (hex: string, label: string, sub = "") => `<div class="sw" style="background:${hex};color:${bestTextOn(hex).color}"><b>${label}</b><span>${hex}${sub}</span></div>`;
  const mode = (r: Roles, label: string) =>
    `<div class="mode" style="background:${r.background};color:${r.text}"><h3>${label}</h3><div class="surf" style="background:${r.surface};border:1px solid ${r.border}"><p style="color:${r.textMuted}">Muted text on a surface</p><span class="btn" style="background:${r.primary};color:${r.onPrimary}">Primary</span><span class="btn" style="background:${r.accent};color:${r.onAccent}">Accent</span><a style="color:${r.link}">A link</a></div><div class="st"><i style="background:${r.success}"></i><i style="background:${r.warning}"></i><i style="background:${r.danger}"></i><i style="background:${r.info}"></i></div></div>`;
  const ladder = (n: string, sc: { step: number; hex: string }[]) => `<div class="lad"><small>${n}</small>${sc.map((s) => `<i style="background:${s.hex}" title="${s.step}"></i>`).join("")}</div>`;
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px system-ui,sans-serif;background:#fff;color:#111;padding:16px;width:860px}h2{margin:0 0 10px}.row{display:flex;gap:8px}.sw{flex:1;padding:14px 10px;border-radius:8px;display:flex;flex-direction:column;gap:2px;min-height:64px}.sw span{font-size:12px;opacity:.85}.modes{display:flex;gap:10px;margin-top:12px}.mode{flex:1;padding:12px;border-radius:10px;border:1px solid #8884}.mode h3{margin:0 0 8px;font-size:13px}.surf{padding:10px;border-radius:8px}.btn{display:inline-block;padding:6px 12px;border-radius:6px;margin-right:6px;font-weight:600}.st{margin-top:8px;display:flex;gap:6px}.st i{width:34px;height:14px;border-radius:3px}.lad{display:flex;align-items:center;margin-top:8px}.lad small{width:60px}.lad i{flex:1;height:22px}.f{margin-top:10px;font-size:12px;color:#555}</style><h2>${name} — colour system</h2><div class="row">${p.brand.map((b) => sw(b.hex, b.name, b.locked ? " · logo" : "")).join("")}</div><div class="modes">${mode(p.light, "Light")}${mode(p.dark, "Dark")}</div>${Object.entries(p.scales).map(([n, s]) => ladder(n, s)).join("")}<div class="f">${p.checks.map((c) => `${c.status === "pass" ? "✔" : c.status === "fail" ? "✖" : "–"} ${c.id}`).join("  ·  ")}</div>`;
}

export { STEPS };

// ---------------------------------------------------------------------------
// the step: a model chooses, code builds and measures, the person sees it
// ---------------------------------------------------------------------------

export interface PaletteContext {
  call: (models: string[], messages: { role: "system" | "user" | "assistant"; content: string | any[] }[], label: string, json: boolean) => Promise<string>;
  models: string[];
  briefText: string;
  conceptNote: string;
  /** The logo's colours, the main one first. */
  logoColours: string[];
  /** Decided elsewhere (the product's UI theme): applied over the model's choice. */
  override?: { ground?: "white" | "warm" | "cool"; neutralHue?: number | null; accent?: string | null };
  typeNote: string;
  rivals: Rival[];
  renderer: { page(html: string, w: number, h: number): Promise<Buffer> } | null;
  name: string;
  dir: string;
  show?: (label: string, file: string) => void;
  log: (line: string) => void;
}

export interface PaletteKit {
  palette: PaletteSystem;
  files: { name: string; data: string | Buffer }[];
}

export async function designPalette(ctx: PaletteContext): Promise<PaletteKit | null> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const parse = (text: string): any => {
    try {
      return JSON.parse(text);
    } catch {
      const a = text.indexOf("{");
      const b = text.lastIndexOf("}");
      try {
        return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
      } catch {
        return null;
      }
    }
  };
  let choice = parsePaletteChoice({}, ctx.logoColours);
  try {
    const text = await ctx.call(
      ctx.models,
      [
        { role: "system", content: PALETTE_SYSTEM },
        {
          role: "user",
          content:
            `The brief:\n${ctx.briefText}\n\nThe mark (its colours are locked): ${ctx.conceptNote}\nLogo colours: ${ctx.logoColours.join(", ")}\nType: ${ctx.typeNote}\n` +
            (ctx.rivals.length ? `Competitor colours to stand apart from: ${ctx.rivals.map((r) => `${r.name} ${r.hex}`).join(", ")}\n` : ""),
        },
      ],
      "palette",
      true
    );
    choice = parsePaletteChoice(parse(text), ctx.logoColours);
  } catch {
    // the colour rules alone still build a system; the choice check says so
    choice = { ...choice, why: "No model choice was available, so the ground, accent and names are the defaults." };
  }
  if (ctx.override) {
    choice = {
      ...choice,
      ground: ctx.override.ground ?? choice.ground,
      neutralHue: ctx.override.neutralHue ?? choice.neutralHue,
      accent: ctx.override.accent && ctx.logoColours.length < 2 ? ctx.override.accent : choice.accent,
    };
  }
  const palette = buildPalette(ctx.logoColours, choice, ctx.rivals);
  const files: PaletteKit["files"] = [
    { name: "palette/tokens.css", data: tokensCss(palette) },
    { name: "palette/tokens.dtcg.json", data: tokensDtcg(palette) },
    { name: "palette/tailwind.palette.js", data: tokensTailwind(palette) },
    { name: "palette/palette.gpl", data: paletteGpl(palette) },
  ];
  if (ctx.renderer) {
    try {
      const png = await ctx.renderer.page(paletteCardHtml(palette, ctx.name), 892, 420);
      files.push({ name: "palette/palette.png", data: png });
      const f = path.join(ctx.dir, "palette", "palette.png");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, png);
      ctx.show?.(`${ctx.name} — colour system`, f);
    } catch {
      // the token files stand on their own
    }
  }
  ctx.log(`[DESIGN] Colour system: ${palette.brand.map((b) => `${b.name} ${b.hex}`).join(", ")};${gateSummary(palette.checks)}`);
  return { palette, files };
}

export function checksMarkdown(checks: Check[]): string {
  return (
    `## Checks\n\nA gate is measured and can fail. A warning is a heuristic. A judgement is an opinion. "Not checked" is never a pass.\n\n` +
    checks.map((c) => `- ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "NOT CHECKED"} [${c.kind}] ${c.id}: ${c.detail}`).join("\n") +
    `\n\nA clean report means nothing measurable is broken, not that the identity is good.\n\n`
  );
}

/** One sentence: which measured gates fail, and which heuristic warnings are raised. */
export function gateSummary(checks: Check[]): string {
  const g = checks.filter((c) => c.kind === "gate" && c.status === "fail").map((c) => c.id);
  const w = checks.filter((c) => c.kind === "warning" && c.status === "fail").map((c) => c.id);
  return (g.length ? " Gates failing: " + g.join(", ") + "." : " Every measured gate passes.") + (w.length ? " Warnings: " + w.join(", ") + "." : "");
}
