/**
 * Colour arithmetic for the palette: OKLCH, CIELAB, colour difference (CIEDE2000), WCAG contrast
 * without rounding, colour-vision-deficiency simulation, and lightness ladders.
 *
 * Everything here is arithmetic, so a script (not a model) decides the measurable things.
 */

export type Rgb = [number, number, number];
export type Lch = { l: number; c: number; h: number };

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (rgb: Rgb): string =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

const toLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

const linear = (hex: string): [number, number, number] | null => {
  const rgb = hexToRgb(hex);
  return rgb ? [toLin(rgb[0]), toLin(rgb[1]), toLin(rgb[2])] : null;
};

/** WCAG relative luminance and contrast ratio, never rounded: 4.49 fails 4.5. */
export function relLum(hex: string): number {
  const l = linear(hex);
  return l ? 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] : 0;
}
export function contrast(a: string, b: string): number {
  const x = relLum(a);
  const y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ---- OKLab / OKLCH --------------------------------------------------------

export function hexToOklch(hex: string): Lch {
  const lin = linear(hex) ?? [0, 0, 0];
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (v: number[]) => v.every((x) => x >= -0.0005 && x <= 1.0005);

/** An OKLCH colour as hex; chroma is reduced (not clipped) until it fits the screen's range. */
export function oklchToHex(l: number, c: number, h: number): string {
  const L = Math.max(0, Math.min(1, l));
  let C = Math.max(0, c);
  let lin = oklchToLinear(L, C, h);
  for (let i = 0; i < 40 && !inGamut(lin); i++) {
    C *= 0.93;
    lin = oklchToLinear(L, C, h);
  }
  return rgbToHex([fromLin(Math.max(0, Math.min(1, lin[0]))), fromLin(Math.max(0, Math.min(1, lin[1]))), fromLin(Math.max(0, Math.min(1, lin[2])))]);
}

// ---- CIELAB and CIEDE2000 --------------------------------------------------

export function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = linear(hex) ?? [0, 0, 0];
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function deltaE2000(hexA: string, hexB: string): number {
  const [L1, a1, b1] = hexToLab(hexA);
  const [L2, a2, b2] = hexToLab(hexB);
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = C2p === 0 ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
  );
}

// ---- colour vision deficiency (Machado et al. 2009, severity 1.0, linear RGB) -----------------

export type Cvd = "protan" | "deutan" | "tritan";
const CVD: Record<Cvd, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

export function simulateCvd(hex: string, kind: Cvd): string {
  const lin = linear(hex);
  if (!lin) return hex;
  const m = CVD[kind];
  const out = m.map((row) => Math.max(0, Math.min(1, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
  return rgbToHex([fromLin(out[0]), fromLin(out[1]), fromLin(out[2])]);
}

// ---- ladders ---------------------------------------------------------------------------------

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const LADDER_L = [0.975, 0.945, 0.9, 0.83, 0.74, 0.65, 0.56, 0.47, 0.38, 0.29, 0.21];

/**
 * An 11-step ladder of one hue. The step nearest the anchor's lightness holds the anchor EXACTLY
 * (a brand colour is never re-derived); the others follow the anchor's hue and chroma.
 */
export function scaleOf(anchorHex: string): { step: number; hex: string }[] {
  const a = hexToOklch(anchorHex);
  let nearest = 0;
  for (let i = 1; i < LADDER_L.length; i++) if (Math.abs(LADDER_L[i] - a.l) < Math.abs(LADDER_L[nearest] - a.l)) nearest = i;
  return LADDER_L.map((l, i) => {
    if (i === nearest) return { step: STEPS[i], hex: rgbToHex(hexToRgb(anchorHex) ?? [0, 0, 0]) };
    // Very light and very dark ends carry less chroma, as real ladders do.
    const edge = 1 - Math.min(1, Math.abs(l - 0.6) / 0.45);
    return { step: STEPS[i], hex: oklchToHex(l, a.c * (0.35 + 0.65 * edge), a.h) };
  });
}

/** A neutral ladder tinted toward a hue. Chroma stays at or below 0.045 so it reads as a neutral. */
export function neutralScale(hue: number, chroma: number): { step: number; hex: string }[] {
  const c = Math.min(0.045, Math.max(0, chroma));
  return LADDER_L.map((l, i) => ({ step: STEPS[i], hex: oklchToHex(l, c * (0.5 + 0.5 * Math.min(1, Math.abs(l - 0.5) * 2)), hue) }));
}

/** White or near-black text, whichever reads better on this fill. */
export function bestTextOn(fill: string): { color: string; ratio: number } {
  const w = contrast("#ffffff", fill);
  const k = contrast("#0b0b0f", fill);
  return w >= k ? { color: "#ffffff", ratio: w } : { color: "#0b0b0f", ratio: k };
}

/** Hue distance in degrees (0-180). */
export const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Do two colours risk being taken for each other? Direct competitors: a ΔE2000 under 10, or the
 * same hue sector (within 20 degrees) and nearly the same lightness (within 0.08) while both are
 * chromatic. These are working thresholds, not standards.
 */
export function tooClose(a: string, b: string): boolean {
  if (deltaE2000(a, b) < 10) return true;
  const x = hexToOklch(a);
  const y = hexToOklch(b);
  return x.c > 0.04 && y.c > 0.04 && hueGap(x.h, y.h) <= 20 && Math.abs(x.l - y.l) <= 0.08;
}
