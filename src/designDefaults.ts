/**
 * What AI models (and the category) reach for by reflex. A default is not banned; it needs a reason
 * that comes from the brief. Matching the plain-data list is code; judging whether a reason is
 * good is the judge model's job.
 *
 * The model-default findings are from a published measurement of how current models answer identity
 * briefs (they repeat the same display face on repeat runs and across models); they are a bias to
 * correct for, not a rule, and this tool has not measured them itself.
 */
import { hexToOklch, hueGap } from "./colorlib.js";

export interface Cliche {
  id: string;
  label: string;
  /** whole-word patterns, matched against a concept's title, idea and construction */
  words: RegExp[];
}

export const CLICHES: Cliche[] = [
  { id: "spark", label: "four-point spark or sparkle", words: [/\bspark(?:le|s)?\b/i, /\bfour[- ]point(?:ed)? star\b/i, /\bsparkle\b/i] },
  { id: "swirl", label: "radial swirl or spiral", words: [/\bswirl\b/i, /\bvortex\b/i, /\bspiral\b/i] },
  { id: "orb", label: "gradient orb", words: [/\borb\b/i, /\bgradient (?:sphere|ball|circle)\b/i] },
  { id: "tile-initial", label: "an initial inside a rounded square", words: [/\binitial (?:in|inside|within) a (?:rounded )?(?:square|tile|squircle)\b/i, /\b(?:letter|monogram) (?:in|inside|within) a (?:rounded )?(?:square|tile|squircle)\b/i] },
  { id: "hexagon", label: "hexagon, nodes or cube", words: [/\bhexagon(?:al)?\b/i, /\bnodes?\b/i, /\bcube\b/i, /\bisometric\b/i] },
  { id: "leaf", label: "leaf", words: [/\bleaf\b/i, /\bleaves\b/i, /\bsprout\b/i] },
  { id: "shield", label: "shield", words: [/\bshield\b/i] },
  { id: "roof", label: "house roof", words: [/\broof\b/i, /\bhouse (?:shape|outline|silhouette)\b/i] },
  { id: "arrow", label: "arrow", words: [/\barrow\b/i] },
  { id: "bulb", label: "lightbulb", words: [/\bbulb\b/i, /\blight ?bulb\b/i] },
  { id: "globe", label: "globe", words: [/\bglobe\b/i, /\bworld map\b/i] },
  { id: "bolt", label: "lightning bolt", words: [/\bbolt\b/i, /\blightning\b/i] },
  { id: "swoosh", label: "swoosh", words: [/\bswoosh\b/i] },
  { id: "hidden-letter", label: "the name's object with a hidden letter in negative space", words: [/\bhidden (?:letter|initial)\b/i] },
];

export function clicheHits(text: string): Cliche[] {
  return CLICHES.filter((c) => c.words.some((w) => w.test(text)));
}

/** Shown to every model that proposes or draws. */
export const DEFAULTS_NOTE =
  "Reflex test: before you commit to a mark idea, a colour or a typeface, ask 'would I propose this same one for another brand in this sector?'. If yes, change it, or say in the concept's \"why\" what in THIS brief justifies it (a named constraint, an empty space among the competitors, an existing asset); 'feels warm' or 'feels premium' is not a reason. " +
  "Category clichés to avoid unless justified: " + CLICHES.map((c) => c.label).join("; ") + ". " +
  "Model defaults measured in the wild, to correct for: the same soft high-contrast serif display face and the same neutral sans text face for everything; a cream ground with terracotta and a gold or brass accent; navy with gold for law, finance, property and the public sector; a mark built as the name's object plus a hidden letter plus negative space plus a circle. " +
  "Offer at least one concept that uses none of these.";

/**
 * The colour-cluster defaults, measured on the actual palette: cream/warm ground + terracotta + gold,
 * and navy + gold. Returns the cluster's name when the palette is one of them.
 */
export function colourDefaultHit(primary: string, accent: string | null, ground: string): string | null {
  const p = hexToOklch(primary);
  const a = accent ? hexToOklch(accent) : null;
  const isGold = (c: { l: number; c: number; h: number }) => c.c > 0.06 && c.h >= 70 && c.h <= 105 && c.l > 0.6;
  const isTerracotta = (c: { l: number; c: number; h: number }) => c.c > 0.07 && hueGap(c.h, 40) <= 20 && c.l > 0.4 && c.l < 0.75;
  const isNavy = (c: { l: number; c: number; h: number }) => c.l < 0.4 && hueGap(c.h, 262) <= 20 && c.c > 0.04;
  if (ground === "warm" && ((isTerracotta(p) && a && isGold(a)) || (isGold(p) && a && isTerracotta(a)))) return "cream ground with terracotta and gold";
  if (isNavy(p) && a && isGold(a)) return "navy with gold";
  return null;
}
