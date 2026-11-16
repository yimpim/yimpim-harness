/**
 * Real type, turned into shapes.
 *
 * A model cannot draw a whole alphabet well, but it can CHOOSE well: which font
 * suits the brand, in what case, how tight, and which round letter could hold
 * the mark. This module carries those choices out exactly. Text is set in a
 * bundled open-licence font (SIL OFL 1.1, which allows use in a logo) and converted
 * to outlined paths, so the result is shapes only and depends on no font being
 * installed where it is shown.
 *
 * Nothing here freehands a letter. The only "customisation" is what a designer
 * does with a real face: case, weight, tracking, and replacing one letter with the
 * mark.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype, { type Font, type Path } from "opentype.js";
import { auditSvg, innerSvg } from "./svgSafety.js";

export interface FontEntry {
  id: string;
  family: string;
  voice: string;
  feel: string;
  body?: boolean;
  mono?: boolean;
  /** A capitals-only face: lowercase is set as capitals. */
  caps?: boolean;
  files: { regular?: string; bold?: string };
}

export type CaseMode = "as-is" | "lower" | "upper" | "title";
export type Weight = "regular" | "bold";

const FONT_DIR = fileURLToPath(new URL("../assets/fonts/", import.meta.url));

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

let catalogCache: FontEntry[] | null = null;

/** The bundled fonts. Entries whose files are missing are dropped, so a broken install cannot crash a design. */
export function loadCatalog(dir: string = FONT_DIR): FontEntry[] {
  if (dir === FONT_DIR && catalogCache) return catalogCache;
  let list: FontEntry[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
    list = (Array.isArray(raw?.fonts) ? raw.fonts : []).filter(
      (f: any) =>
        f && typeof f.id === "string" && typeof f.family === "string" && f.files && typeof f.files === "object" && Object.values(f.files).some((n) => typeof n === "string" && fs.existsSync(path.join(dir, f.id, n as string)))
    );
  } catch {
    list = [];
  }
  if (dir === FONT_DIR) catalogCache = list;
  return list;
}

export function findFont(id: unknown, catalog: FontEntry[] = loadCatalog()): FontEntry | undefined {
  return catalog.find((f) => f.id === id);
}

/** The file for a weight; a bold that does not exist falls back to the regular. */
export function fontFile(entry: FontEntry, weight: Weight, dir: string = FONT_DIR): { file: string; weight: Weight } | null {
  const want = weight === "bold" ? entry.files.bold : entry.files.regular;
  const name = want ?? entry.files.regular ?? entry.files.bold;
  if (!name) return null;
  const file = path.join(dir, entry.id, name);
  if (!fs.existsSync(file)) return null;
  return { file, weight: want ? weight : entry.files.regular ? "regular" : "bold" };
}

export function licenceFile(entry: FontEntry, dir: string = FONT_DIR): string | null {
  const f = path.join(dir, entry.id, "OFL.txt");
  return fs.existsSync(f) ? f : null;
}

const fontCache = new Map<string, Font>();
function loadFont(file: string): Font {
  let f = fontCache.get(file);
  if (!f) {
    const b = fs.readFileSync(file);
    f = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    fontCache.set(file, f);
  }
  return f;
}

// ---------------------------------------------------------------------------
// setting the word
// ---------------------------------------------------------------------------

export interface WordmarkSpec {
  fontId: string;
  weight: Weight;
  text: string;
  caseMode: CaseMode;
  /** In em; negative tightens. Bounded to a sensible range. */
  tracking: number;
  /** Index among the LETTERS (spaces not counted) of the one to replace with the mark. */
  replaceLetter?: number | null;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Wordmark {
  /** Outlined letters as path data; y grows downward, the baseline is y = 0. */
  d: string;
  box: Box;
  capHeight: number;
  xHeight: number;
  /** The text as set (after case). */
  text: string;
  font: { id: string; family: string; weight: Weight };
  /** Where the mark goes when it replaces a letter: a square, top-left and side. */
  slot?: { x: number; y: number; size: number };
}

export const MAX_NAME_CHARS = 40;
/**
 * A mark's viewBox has margin around the drawing (the drawing rules ask for about 8 units of a 100 box), so a
 * mark fitted to the letter's height would look small beside its neighbours. Fitting a slightly larger square
 * makes the DRAWING about as tall as the letter it replaces.
 */
export const MARK_FIT = 1.18;
export const TRACKING_RANGE: [number, number] = [-0.06, 0.3];

export function applyCase(text: string, mode: CaseMode, capsOnly = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (capsOnly || mode === "upper") return t.toUpperCase();
  if (mode === "lower") return t.toLowerCase();
  if (mode === "title") return t.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase());
  return t;
}

export const clampTracking = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(TRACKING_RANGE[1], Math.max(TRACKING_RANGE[0], v)) : 0;
};

/**
 * Path data written from the outline's own commands. The library's toPathData() turns some
 * ordinary floating-point values into "NaN" (an x of 276.40000000000003 does it), so it is not used.
 * Returns null if any number is not finite.
 */
export function pathToD(path: Path): string | null {
  const num = (v: number | undefined): string | null => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };
  const out: string[] = [];
  for (const c of path.commands) {
    const pick = (...ks: ("x1" | "y1" | "x2" | "y2" | "x" | "y")[]) => ks.map((k) => num(c[k]));
    let v: (string | null)[];
    if (c.type === "Z") {
      out.push("Z");
      continue;
    }
    if (c.type === "M" || c.type === "L") v = pick("x", "y");
    else if (c.type === "Q") v = pick("x1", "y1", "x", "y");
    else if (c.type === "C") v = pick("x1", "y1", "x2", "y2", "x", "y");
    else return null;
    if (v.some((x) => x === null)) return null;
    out.push(`${c.type}${v.join(" ")}`);
  }
  return out.join(" ");
}

const union = (a: Box | null, b: Box): Box => (a ? { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) } : b);

export function layoutWordmark(spec: WordmarkSpec, opts: { size?: number; dir?: string } = {}): { wordmark: Wordmark } | { error: string } {
  const size = opts.size ?? 100;
  const dir = opts.dir ?? FONT_DIR;
  const catalog = loadCatalog(dir);
  const entry = findFont(spec.fontId, catalog);
  if (!entry) return { error: `There is no font "${spec.fontId}" in the catalogue.` };
  const chosen = fontFile(entry, spec.weight, dir);
  if (!chosen) return { error: `The font files for ${entry.family} are missing.` };

  const raw = String(spec.text ?? "");
  if (raw.replace(/\s/g, "").length === 0) return { error: "There is no name to set." };
  if (raw.length > MAX_NAME_CHARS) return { error: `The name is over ${MAX_NAME_CHARS} characters, too long for a wordmark.` };
  const text = applyCase(raw, spec.caseMode, entry.caps);

  let font: Font;
  try {
    font = loadFont(chosen.file);
  } catch {
    return { error: `The font file for ${entry.family} could not be read.` };
  }
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (font.charToGlyph(ch).index === 0) return { error: `${entry.family} has no letter for "${ch}".` };
  }

  // Plain character-to-glyph placement with the font's own kerning. The library's text shaper would also
  // swap in alternate glyphs (ligatures, contextual forms), and some of those have damaged outlines.
  const glyphs: { glyph: ReturnType<Font["charToGlyph"]>; x: number; isSpace: boolean }[] = [];
  const unit = size / font.unitsPerEm;
  let cursor = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (prev) cursor += (font.getKerningValue(prev, glyph) || 0) * unit;
    glyphs.push({ glyph, x: cursor, isSpace: /\s/.test(ch) });
    cursor += (glyph.advanceWidth ?? 0) * unit;
    prev = glyph;
  }
  if (glyphs.length === 0) return { error: "Nothing could be set." };

  const tracking = clampTracking(spec.tracking) * size;

  // Which glyph is the letter to replace (letters only: spaces are not counted).
  let replaceAt = -1;
  if (spec.replaceLetter !== undefined && spec.replaceLetter !== null) {
    let letter = -1;
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i].isSpace) continue;
      letter++;
      if (letter === spec.replaceLetter) replaceAt = i;
    }
    if (replaceAt < 0) return { error: `There is no letter number ${spec.replaceLetter} to replace.` };
  }

  let slot: Wordmark["slot"];
  let shift = 0;
  if (replaceAt >= 0) {
    const g = glyphs[replaceAt];
    const bb = g.glyph.getPath(g.x + replaceAt * tracking, 0, size).getBoundingBox();
    const w = bb.x2 - bb.x1;
    const h = bb.y2 - bb.y1;
    if (!(h > 0) || w < h * 0.6) return { error: "That letter is too narrow to hold the mark; a round letter such as o or O works." };
    const side = h * MARK_FIT;
    // The mark's drawing is about h wide, centred where the letter's ink began; what follows moves to suit.
    // A letter has side-bearing the mark's drawing does not, so it gets a little air on each side.
    const air = size * 0.035;
    slot = { x: bb.x1 + air + h / 2 - side / 2, y: (bb.y1 + bb.y2) / 2 - side / 2, size: side };
    shift = h - w + 2 * air;
  }

  let box: Box | null = null;
  const parts: string[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.isSpace || i === replaceAt) continue;
    const x = g.x + i * tracking + (replaceAt >= 0 && i > replaceAt ? shift : 0);
    const p = g.glyph.getPath(x, 0, size);
    const d = pathToD(p);
    if (d === null) return { error: `${entry.family} has a damaged outline for "${text[i] ?? "?"}".` };
    if (!d) continue;
    parts.push(d);
    box = union(box, p.getBoundingBox());
  }
  if (slot) box = union(box, { x1: slot.x, y1: slot.y, x2: slot.x + slot.size, y2: slot.y + slot.size });
  if (!box || parts.length === 0) return { error: "Nothing could be set." };

  const os2 = font.tables.os2 ?? {};
  const capHeight = ((os2.sCapHeight ?? font.unitsPerEm * 0.7) / font.unitsPerEm) * size;
  const xHeight = ((os2.sxHeight ?? font.unitsPerEm * 0.5) / font.unitsPerEm) * size;
  return { wordmark: { d: parts.join(" "), box, capHeight, xHeight, text, font: { id: entry.id, family: entry.family, weight: chosen.weight }, slot } };
}

// ---------------------------------------------------------------------------
// lockups
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The mark, centred on (cx, cy), fitted into a square of the given side. */
export function placeSymbol(symbolSvg: string, cx: number, cy: number, side: number): string {
  const vb = auditSvg(symbolSvg).viewBox;
  const s = side / Math.max(vb.w, vb.h);
  const tx = cx - (vb.x + vb.w / 2) * s;
  const ty = cy - (vb.y + vb.h / 2) * s;
  return `<g transform="translate(${r2(tx)} ${r2(ty)}) scale(${Math.round(s * 100000) / 100000})">${innerSvg(symbolSvg)}</g>`;
}

const svgOf = (box: Box, margin: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(box.x1 - margin)} ${r2(box.y1 - margin)} ${r2(box.x2 - box.x1 + 2 * margin)} ${r2(box.y2 - box.y1 + 2 * margin)}">${body}</svg>`;

/** The word on its own, in one ink colour. When it has a slot, the mark sits in it (an "o" that is the logo). */
export function buildWordmarkSvg(word: Wordmark, ink: string, symbolSvg?: string): string {
  const mark = word.slot && symbolSvg ? placeSymbol(symbolSvg, word.slot.x + word.slot.size / 2, word.slot.y + word.slot.size / 2, word.slot.size) : "";
  return svgOf(word.box, word.capHeight * 0.4, `${mark}<path d="${word.d}" fill="${ink}"/>`);
}

/**
 * The mark beside or above the word. Sizes follow the type, not a fixed number: the
 * symbol is about twice the cap height beside the word, three times above it, and
 * the gap is a fraction of the symbol, so the pair keeps its proportions at any size.
 */
export function buildLockupSvg(symbolSvg: string, word: Wordmark, layout: "horizontal" | "stacked", ink: string): string {
  const cap = word.capHeight;
  const wordW = word.box.x2 - word.box.x1;
  if (layout === "horizontal") {
    const side = cap * 2.0;
    const gap = side * 0.3;
    const midY = -cap / 2;
    const dx = side + gap - word.box.x1;
    const sym = placeSymbol(symbolSvg, side / 2, midY, side);
    const box: Box = {
      x1: 0,
      y1: Math.min(midY - side / 2, word.box.y1),
      x2: side + gap + wordW,
      y2: Math.max(midY + side / 2, word.box.y2),
    };
    return svgOf(box, cap * 0.4, `${sym}<path transform="translate(${r2(dx)} 0)" d="${word.d}" fill="${ink}"/>`);
  }
  const side = cap * 3.0;
  const gap = cap * 0.7;
  const totalW = Math.max(side, wordW);
  const baseline = side + gap + cap;
  const dx = (totalW - wordW) / 2 - word.box.x1;
  const sym = placeSymbol(symbolSvg, totalW / 2, side / 2, side);
  const box: Box = { x1: 0, y1: 0, x2: totalW, y2: baseline + word.box.y2 };
  return svgOf(box, cap * 0.4, `${sym}<path transform="translate(${r2(dx)} ${r2(baseline)})" d="${word.d}" fill="${ink}"/>`);
}

/** Near-black on a light page, near-white on a dark one. */
export const INK = { light: "#18181b", dark: "#fafafa" } as const;
