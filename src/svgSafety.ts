/**
 * SVG that a model wrote is untrusted input that will be written into a project
 * and opened in a browser. This rebuilds it from an allowlist: only plain
 * drawing elements and attributes survive, so there is no script, no external
 * reference, no embedded HTML, and no live text (a logo has to be shapes: text
 * depends on a font the viewer may not have).
 *
 * It also measures what a mark is made of (colours, shapes, size), and recolours
 * it, which is how the one-colour, white and app-icon versions are made without
 * asking a model to redraw anything.
 */

const ELEMENTS = new Map(
  ["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath"].map((e) => [e.toLowerCase(), e])
);
const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);

const ATTRS = new Set(
  [
    "viewBox", "xmlns", "width", "height", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points",
    "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "fill-rule", "clip-rule",
    "fill-opacity", "stroke-opacity", "opacity", "transform", "id", "offset", "stop-color", "stop-opacity",
    "gradientUnits", "gradientTransform", "clip-path", "fx", "fy", "preserveAspectRatio",
  ].map((a) => a.toLowerCase())
);
const ATTR_CANON = new Map(
  ["viewBox", "gradientUnits", "gradientTransform", "preserveAspectRatio"].map((a) => [a.toLowerCase(), a])
);

const TAG_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Pulls the <svg>...</svg> out of whatever a model said around it (prose, a code fence). */
export function extractSvg(text: string): string | null {
  const m = /<svg[\s>][\s\S]*<\/svg\s*>/i.exec(text ?? "");
  return m ? m[0] : null;
}

function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) out.set(m[1], m[2] ?? m[3] ?? "");
  return out;
}

/** A value is allowed if it points nowhere outside this drawing. */
function safeValue(name: string, value: string): boolean {
  const v = value.trim();
  if (/javascript:|data:|https?:|file:|\/\/|<|>|&#|expression\(/i.test(v)) return false;
  const urls = v.match(/url\(([^)]*)\)/gi) ?? [];
  for (const u of urls) if (!/^url\(\s*['"]?#[\w.-]+['"]?\s*\)$/i.test(u)) return false;
  if (name === "d" && !/^[MmLlHhVvCcSsQqTtAaZz0-9eE\s,.+-]*$/.test(v)) return false;
  return true;
}

export interface Sanitized {
  /** The rebuilt SVG, or null when nothing usable could be made. */
  svg: string | null;
  /** What was wrong or removed, in words a model can act on. */
  problems: string[];
}

export function sanitizeSvg(raw: string): Sanitized {
  const found = extractSvg(raw);
  if (!found) return { svg: null, problems: ["There is no <svg>...</svg> in the reply."] };
  if (found.length > 60_000) return { svg: null, problems: ["The SVG is far too large for a logo (over 60 KB); draw it with fewer, simpler shapes."] };

  const problems: string[] = [];
  const removed = new Set<string>();
  const stack: string[] = [];
  let out = "";
  let hadRoot = false;
  let hadText = false;
  let viewBox: string | null = null;
  let width: string | null = null;
  let height: string | null = null;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let skipDepth = 0; // inside a removed element: everything in it goes too
  while ((m = TAG_RE.exec(found))) {
    if (m[2] === undefined) continue; // comment, CDATA, PI, doctype
    const closing = m[1] === "/";
    const nameRaw = m[2];
    const selfClose = m[4] === "/";
    const canon = ELEMENTS.get(nameRaw.toLowerCase());

    if (skipDepth > 0) {
      if (closing) skipDepth--;
      else if (!selfClose) skipDepth++;
      continue;
    }
    if (!canon && /^(title|desc|metadata)$/i.test(nameRaw)) {
      // Harmless labels a model likes to add: dropped quietly, not a reason to ask for a redraw.
      if (!closing && !selfClose) skipDepth = 1;
      continue;
    }
    if (!canon) {
      if (/^text$|^tspan$/i.test(nameRaw)) hadText = true;
      else removed.add(nameRaw.toLowerCase());
      if (!closing && !selfClose) skipDepth = 1;
      continue;
    }

    if (closing) {
      if (stack[stack.length - 1] !== canon) {
        problems.push("Some tags are not closed in the right order.");
        continue;
      }
      stack.pop();
      out += `</${canon}>`;
      if (canon === "svg") break;
      continue;
    }

    if (canon === "svg") {
      if (hadRoot) {
        removed.add("nested svg");
        if (!selfClose) skipDepth = 1;
        continue;
      }
      hadRoot = true;
    } else if (!hadRoot) {
      continue;
    }

    const attrs = parseAttrs(m[3] ?? "");
    let kept = "";
    for (const [k, v] of attrs) {
      const lk = k.toLowerCase();
      // The namespace is re-added on the root, and its value is a URL by definition, so it is not judged as one.
      if (lk === "xmlns") continue;
      if (lk.startsWith("on") || !ATTRS.has(lk)) {
        if (!/^(xmlns:\w+|xml:\w+|version|data-[\w-]+|aria-[\w-]+|role|focusable)$/i.test(k)) removed.add(`attribute ${k}`);
        continue;
      }
      if (!safeValue(lk, v)) {
        removed.add(`unsafe value in ${k}`);
        continue;
      }
      if (canon === "svg") {
        if (lk === "viewbox") viewBox = v;
        if (lk === "width") width = v;
        if (lk === "height") height = v;
        if (lk === "width" || lk === "height" || lk === "xmlns") continue;
      }
      kept += ` ${ATTR_CANON.get(lk) ?? lk}="${v.replace(/"/g, "&quot;")}"`;
    }
    if (canon === "svg") {
      kept = ` xmlns="http://www.w3.org/2000/svg"${kept}`;
    }
    if (selfClose) out += `<${canon}${kept}/>`;
    else {
      stack.push(canon);
      out += `<${canon}${kept}>`;
    }
  }

  if (hadText) problems.push("It uses <text>. A logo must be shapes only (a font may not exist where it is shown): turn any letters into <path> outlines or simple shapes.");
  if (removed.size > 0) problems.push(`These were not allowed and were removed: ${[...removed].slice(0, 8).join(", ")}. Use only path, circle, ellipse, rect, line, polyline, polygon, g, defs, gradients and clipPath.`);
  if (stack.length > 0) problems.push("The SVG was cut off or has unclosed tags.");
  if (!hadRoot || stack.length > 0) return { svg: null, problems };

  if (!viewBox) {
    const w = parseFloat(width ?? "");
    const h = parseFloat(height ?? "");
    if (w > 0 && h > 0) out = out.replace("<svg ", `<svg viewBox="0 0 ${w} ${h}" `);
    else problems.push('The <svg> has no viewBox; it must have viewBox="0 0 100 100".');
  }
  if (!/viewBox=/.test(out)) return { svg: null, problems };
  return { svg: out, problems };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", navy: "#000080", teal: "#008080",
  pink: "#ffc0cb", cyan: "#00ffff", magenta: "#ff00ff", brown: "#a52a2a", gold: "#ffd700", silver: "#c0c0c0",
};

/** "#abc", "rgb(1,2,3)", "red" → "#aabbcc". null for none/transparent/url()/unknown. */
export function normalizeColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "transparent" || v.startsWith("url(") || v === "currentcolor" || v === "inherit") return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) return "#" + (hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1]);
  const rgb = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/.exec(v);
  if (rgb) return "#" + [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return NAMED[v] ?? null;
}

export interface SvgAudit {
  shapes: number;
  paths: number;
  colors: string[];
  pathChars: number;
  bytes: number;
  viewBox: { x: number; y: number; w: number; h: number };
  /** Things worth fixing, in words a model can act on. Empty when the mark is sound. */
  issues: string[];
}

export function auditSvg(svg: string): SvgAudit {
  let shapes = 0;
  let paths = 0;
  let pathChars = 0;
  const colors = new Map<string, number>();
  let usesDefaultBlack = false;
  let rootFill: string | null = null;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let vb = { x: 0, y: 0, w: 100, h: 100 };
  while ((m = TAG_RE.exec(svg))) {
    if (m[2] === undefined || m[1] === "/") continue;
    const name = m[2];
    const attrs = parseAttrs(m[3] ?? "");
    if (name === "svg") {
      const p = (attrs.get("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p.every((n) => Number.isFinite(n)) && p[2] > 0 && p[3] > 0) vb = { x: p[0], y: p[1], w: p[2], h: p[3] };
      rootFill = attrs.get("fill") ?? null;
    }
    if (SHAPES.has(name)) {
      shapes++;
      if (name === "path") {
        paths++;
        pathChars += (attrs.get("d") ?? "").length;
      }
      const fill = attrs.get("fill");
      const stroke = attrs.get("stroke");
      const f = fill !== undefined ? normalizeColor(fill) : rootFill !== null ? normalizeColor(rootFill) : null;
      if (fill === undefined && rootFill === null && !(stroke && !fill)) usesDefaultBlack = true;
      if (f) colors.set(f, (colors.get(f) ?? 0) + 1);
      if (stroke) {
        const s = normalizeColor(stroke);
        if (s) colors.set(s, (colors.get(s) ?? 0) + 1);
      }
    }
    if (name === "stop") {
      const c = normalizeColor(attrs.get("stop-color") ?? "");
      if (c) colors.set(c, (colors.get(c) ?? 0) + 1);
    }
  }
  if (usesDefaultBlack) colors.set("#000000", (colors.get("#000000") ?? 0) + 1);

  const ordered = [...colors.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const issues: string[] = [];
  if (shapes === 0) issues.push("It draws nothing: there are no shapes.");
  if (ordered.length > 3) issues.push(`It uses ${ordered.length} colours; a logo should use at most 3.`);
  if (shapes > 40) issues.push(`It is made of ${shapes} shapes; a mark that must read at 16 px should be far simpler.`);
  if (pathChars > 6000) issues.push("The path data is very long; the mark is too detailed to stay clear when small.");
  if (Math.abs(vb.w - vb.h) > 0.001) issues.push("The viewBox is not square; use viewBox=\"0 0 100 100\" so it fits icons.");
  return { shapes, paths, colors: ordered, pathChars, bytes: svg.length, viewBox: vb, issues };
}

// ---------------------------------------------------------------------------
// Recolouring and placing (the harness makes the variants; no model redraws)
// ---------------------------------------------------------------------------

/**
 * Every painted fill and stroke becomes one colour; holes (evenodd) are kept.
 *
 * A mark with a light part AND a dark part (a blue disc with a white check) must
 * not lose the light part into the rest, or it becomes a blob. With `lightAs`,
 * the near-white parts become that colour instead (the knockout colour: white on
 * a light page, near-black on a dark one) while the rest take `color`.
 */
export function recolorSvg(svg: string, color: string, background?: string, lightAs?: string): string {
  const c = normalizeColor(color) ?? color;
  const hasDark = auditSvg(svg).colors.some((x) => luminance(x) < 0.85);
  const paint = (v: string): string => {
    const n = normalizeColor(v);
    return lightAs && hasDark && n && luminance(n) >= 0.85 ? lightAs : c;
  };
  let out = "";
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let insertedBg = false;
  while ((m = TAG_RE.exec(svg))) {
    if (m[2] === undefined) continue;
    out += svg.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1] === "/") {
      out += m[0];
      continue;
    }
    const name = m[2];
    const attrs = parseAttrs(m[3] ?? "");
    const rebuilt: string[] = [];
    for (const [k, v] of attrs) {
      const lk = k.toLowerCase();
      if ((lk === "fill" || lk === "stroke" || lk === "stop-color") && v.trim().toLowerCase() !== "none") rebuilt.push(`${k}="${paint(v)}"`);
      else rebuilt.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
    }
    // A shape that relied on the default (black) fill must take the colour too.
    if (SHAPES.has(name) && !attrs.has("fill") && !(attrs.has("stroke") && attrs.get("stroke")!.toLowerCase() !== "none")) rebuilt.push(`fill="${c}"`);
    if (name === "svg" && !attrs.has("fill")) rebuilt.push(`fill="${c}"`);
    out += `<${name}${rebuilt.length ? " " + rebuilt.join(" ") : ""}${m[4] ? "/" : ""}>`;
    if (name === "svg" && background && !insertedBg) {
      const a = auditSvg(svg).viewBox;
      out += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${background}"/>`;
      insertedBg = true;
    }
  }
  return out + svg.slice(last);
}

/** The drawing inside the outer <svg>, without the wrapper. */
export function innerSvg(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg);
  const end = svg.toLowerCase().lastIndexOf("</svg>");
  return open && end > open.index ? svg.slice(open.index + open[0].length, end) : "";
}

/**
 * A new 100x100 SVG with this mark centred in it at `scale` (1 = edge to edge),
 * on an optional background shape. Used for app icons and the maskable icon.
 */
export function placeOnTile(
  svg: string,
  opts: { scale: number; background?: string; rounded?: number; mark?: string }
): string {
  const vb = auditSvg(svg).viewBox;
  const s = (100 * opts.scale) / Math.max(vb.w, vb.h);
  const tx = (100 - vb.w * s) / 2 - vb.x * s;
  const ty = (100 - vb.h * s) / 2 - vb.y * s;
  const inner = opts.mark ? innerSvg(recolorSvg(svg, opts.mark)) : innerSvg(svg);
  const bg = opts.background ? `<rect width="100" height="100" rx="${opts.rounded ?? 0}" fill="${opts.background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bg}<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">${inner}</g></svg>`;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = normalizeColor(hex);
  if (!c) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** An ICO file holding PNG images (every modern browser and OS reads these). */
export function buildIco(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const o = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  return Buffer.concat([head, dir, ...images.map((i) => i.data)]);
}

// ---------------------------------------------------------------------------
// Light and dark surfaces
// ---------------------------------------------------------------------------

/** The two surfaces a logo has to live on: a white page and a near-black one. */
export const LIGHT_SURFACE = "#ffffff";
export const DARK_SURFACE = "#0f0f14";
/** WCAG's floor for graphical objects. Below this a mark fades into the page. */
export const MIN_CONTRAST = 3;

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hexToHsl(hex: string): [number, number, number] {
  const c = normalizeColor(hex) ?? "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

/** The colour that touches the page: the first shape drawn (later shapes sit on top of it). */
export function baseColor(svg: string): string | null {
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let rootFill: string | null = null;
  while ((m = TAG_RE.exec(svg))) {
    if (m[2] === undefined || m[1] === "/") continue;
    const attrs = parseAttrs(m[3] ?? "");
    if (m[2] === "svg") rootFill = attrs.get("fill") ?? null;
    if (!SHAPES.has(m[2])) continue;
    const fill = attrs.get("fill") ?? rootFill;
    if (fill === null || fill === undefined) return attrs.get("stroke") && normalizeColor(attrs.get("stroke")!) ? normalizeColor(attrs.get("stroke")!) : "#000000";
    const f = normalizeColor(fill);
    if (f) return f;
    const s = attrs.get("stroke");
    return s ? normalizeColor(s) : null;
  }
  return null;
}

export interface ThemeReport {
  base: string | null;
  onLight: number;
  onDark: number;
  /** Which surfaces the mark, as drawn, fades into. */
  fadesOn: ("light" | "dark")[];
}

export function themeReport(svg: string): ThemeReport {
  const base = baseColor(svg);
  if (!base) return { base, onLight: 21, onDark: 21, fadesOn: [] };
  const onLight = contrastRatio(base, LIGHT_SURFACE);
  const onDark = contrastRatio(base, DARK_SURFACE);
  const fadesOn: ("light" | "dark")[] = [];
  if (onLight < MIN_CONTRAST) fadesOn.push("light");
  if (onDark < MIN_CONTRAST) fadesOn.push("dark");
  return { base, onLight: Math.round(onLight * 10) / 10, onDark: Math.round(onDark * 10) / 10, fadesOn };
}

/** The same hue with its lightness moved until it holds against `surface`, or null if it already does. */
export function adaptColor(color: string, surface: string): string | null {
  if (contrastRatio(color, surface) >= MIN_CONTRAST) return null;
  const [h, s, l0] = hexToHsl(color);
  const lighter = luminance(surface) < 0.5;
  // What a designer does: a dark or neutral mark does not get a muddy mid-grey on the other theme,
  // it FLIPS to near-white (or near-black), keeping only a trace of its hue. Only a real colour
  // (a saturated mid-tone) is nudged lighter or darker.
  if (lighter && (l0 < 0.3 || (s < 0.2 && l0 < 0.45))) return hslToHex(h, Math.min(s, 0.12), 0.95);
  if (!lighter && (l0 > 0.75 || (s < 0.2 && l0 > 0.55))) return hslToHex(h, Math.min(s, 0.2), 0.1);
  let l = l0;
  for (let i = 0; i < 60; i++) {
    l = lighter ? Math.min(1, l + 0.02) : Math.max(0, l - 0.02);
    const c = hslToHex(h, s, l);
    if (contrastRatio(c, surface) >= MIN_CONTRAST + 0.2) return c;
    if (l <= 0 || l >= 1) break;
  }
  return lighter ? "#ffffff" : "#000000";
}

/** Applies fn to every painted colour; a shape relying on the default black gets it written out. */
function mapColors(svg: string, fn: (hex: string) => string | null): string {
  let out = "";
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let rootFill: string | null = null;
  while ((m = TAG_RE.exec(svg))) {
    if (m[2] === undefined) continue;
    out += svg.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1] === "/") {
      out += m[0];
      continue;
    }
    const name = m[2];
    const attrs = parseAttrs(m[3] ?? "");
    if (name === "svg") rootFill = attrs.get("fill") ?? null;
    const parts: string[] = [];
    for (const [k, v] of attrs) {
      const lk = k.toLowerCase();
      let value = v;
      if (lk === "fill" || lk === "stroke" || lk === "stop-color") {
        const n = normalizeColor(v);
        const to = n ? fn(n) : null;
        if (to) value = to;
      }
      parts.push(`${k}="${value.replace(/"/g, "&quot;")}"`);
    }
    if (SHAPES.has(name) && !attrs.has("fill") && rootFill === null && !(attrs.has("stroke") && attrs.get("stroke")!.toLowerCase() !== "none")) {
      parts.push(`fill="${fn("#000000") ?? "#000000"}"`);
    }
    out += `<${name}${parts.length ? " " + parts.join(" ") : ""}${m[4] ? "/" : ""}>`;
  }
  return out + svg.slice(last);
}

/** This mark, with the colour that touches the page adjusted so it holds on that theme's surface. */
export function adaptForTheme(svg: string, theme: "light" | "dark"): string {
  const base = baseColor(svg);
  if (!base) return svg;
  const to = adaptColor(base, theme === "dark" ? DARK_SURFACE : LIGHT_SURFACE);
  if (!to) return svg;
  return mapColors(svg, (c) => (c === base ? to : null));
}

/**
 * One SVG that follows the viewer's light/dark setting (a browser tab icon does),
 * with no script: a media query swaps the colour that touches the page. The mark
 * is returned unchanged when it already holds on both.
 */
export function adaptiveSvg(svg: string): string {
  const base = baseColor(svg);
  if (!base) return svg;
  const rules: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    const to = adaptColor(base, theme === "dark" ? DARK_SURFACE : LIGHT_SURFACE);
    if (to) rules.push(`@media (prefers-color-scheme:${theme}){[fill="${base}"]{fill:${to}}[stroke="${base}"]{stroke:${to}}}`);
  }
  if (rules.length === 0) return svg;
  const explicit = mapColors(svg, (c) => c);
  return explicit.replace(/(<svg\b[^>]*>)/i, `$1<style>${rules.join("")}</style>`);
}

// ---------------------------------------------------------------------------
// Checking a model's colourway: same drawing, different colours
// ---------------------------------------------------------------------------

const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "fill-opacity", "stroke-opacity", "stop-opacity", "opacity"]);

/**
 * The drawing with every colour taken out: tags and their non-colour attributes, in order.
 * Two marks with the same key are the same shapes in the same places.
 */
export function geometryKey(svg: string): string {
  const out: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(svg))) {
    if (m[2] === undefined) continue;
    if (m[1] === "/") {
      out.push(`</${m[2]}>`);
      continue;
    }
    const attrs = [...parseAttrs(m[3] ?? "")]
      .filter(([k]) => !COLOR_ATTRS.has(k.toLowerCase()) && k.toLowerCase() !== "xmlns")
      .map(([k, v]) => `${k}=${v.replace(/\s+/g, " ").trim()}`)
      .sort();
    out.push(`<${m[2]} ${attrs.join(" ")}${m[4] ? "/" : ""}>`);
  }
  return out.join("");
}

export function sameGeometry(a: string, b: string): boolean {
  return geometryKey(a) === geometryKey(b);
}

/** Every painted colour, in document order (a shape on the default black counts as black). */
function paintSequence(svg: string): string[] {
  const seq: string[] = [];
  mapColors(svg, (c) => (seq.push(c), null));
  return seq;
}

/**
 * One SVG that follows the viewer's light/dark setting, built from a light mark and the dark
 * colourway of the SAME drawing: each colour that differs is swapped by a media query.
 * Falls back to the single-colour rule when the pairing is not clean.
 */
export function adaptiveFromPair(light: string, dark: string): string {
  if (!sameGeometry(light, dark)) return adaptiveSvg(light);
  const a = paintSequence(light);
  const b = paintSequence(dark);
  if (a.length !== b.length) return adaptiveSvg(light);
  const map = new Map<string, string>();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const prior = map.get(a[i]);
    if (prior !== undefined && prior !== b[i]) return adaptiveSvg(light);
    map.set(a[i], b[i]);
  }
  if (map.size === 0) return light;
  const rules = [...map].map(([from, to]) => `[fill="${from}"]{fill:${to}}[stroke="${from}"]{stroke:${to}}[stop-color="${from}"]{stop-color:${to}}`).join("");
  return mapColors(light, (c) => c).replace(/(<svg\b[^>]*>)/i, `$1<style>@media (prefers-color-scheme:dark){${rules}}</style>`);
}

/**
 * A colour as the values a brand sheet lists. CMYK here is the plain formula, so it is an
 * approximation: vivid screen colours (neon, electric blue, bright green) often print duller,
 * and a printer's proof is the real answer. Pantone cannot be computed and is not guessed.
 */
export function colorSpecs(color: string): { hex: string; rgb: [number, number, number]; cmyk: [number, number, number, number] } | null {
  const hex = normalizeColor(color);
  if (!hex) return null;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const [r, g, b] = rgb.map((v) => v / 255);
  const k = 1 - Math.max(r, g, b);
  const cmyk: [number, number, number, number] =
    k >= 1 ? [0, 0, 0, 100] : ([(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k].map((v) => Math.round(v * 100)) as [number, number, number, number]);
  return { hex, rgb, cmyk };
}
