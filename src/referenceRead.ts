/**
 * The reference read: what a vision model sees in each reference a person gave, as structured text the rest of the design work can use
 * (the critique compares against it; the new-app design step builds the direction from it). One call per reference, to the Designer
 * Judge (Vision) models; only ever run because a person gave references.
 *
 *   captured page or image -> the model looks at its screenshots, with the measured cues (colours, fonts, sizes, corners read from the
 *                             rendered page) given as facts it must not contradict
 *   named product          -> no image: the model says what it remembers, and the read is marked recalled, never seen
 *   could not be captured  -> no read; the person was already asked for a screenshot
 *
 * What it says is design, never content: hierarchy, density, surfaces, type, colour restraint, layout, what to borrow, and what NOT to
 * copy (the product's identity: its logo, name, illustrations, signature layout, wording). The measured cues are written into the read
 * by code, not by the model. Code bounds every field; a reply that is not a real read is dropped, not guessed at.
 */
import fs from "node:fs";
import path from "node:path";
import { parseLenient } from "./jsonRepair.js";
import { describeCues, type PageCues, type Reference } from "./uiReference.js";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | any[];
}
export type Call = (models: string[], messages: ChatMsg[], label: string, json: boolean) => Promise<string>;

export const DENSITIES = ["airy", "balanced", "dense"] as const;
export type Density = (typeof DENSITIES)[number];

export interface ReferenceRead {
  label: string;
  /** seen: from its screenshots; recalled: from what the model remembers of a named product. */
  source: "seen" | "recalled";
  /** One sentence: what makes this feel the way it does. */
  essence: string;
  hierarchy: string;
  density: Density;
  surfaces: string;
  type: string;
  colour: string;
  layout: string;
  /** Principles worth taking, each concrete enough to act on. */
  borrow: string[];
  /** What belongs to that product and must not be copied. */
  doNotCopy: string[];
  /** Measured from the rendered page (code, not the model), when it was a captured page. */
  measured?: PageCues;
  images: string[];
}

const MAX_IMAGE_BYTES = 4_000_000;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export const READ_METHOD =
  "Describe the DESIGN, never the content or the product. Be specific and visual: say what you see (sizes, weights, spacing, edges, " +
  "contrast), not adjectives alone. Hierarchy: what is seen first, second, third, and what makes it so. Density: how much fits on a " +
  "screen and how much space is around it. Surfaces: backgrounds, cards, borders, shadows, depth. Type: faces, weights, sizes, case, " +
  "how many levels. Colour: how much colour is used and where (restraint is a quality). Layout: grid, alignment, rhythm, what repeats. " +
  "Borrow: principles another product could take without looking like this one. Do not copy: what makes this product itself (its logo " +
  "and name, illustrations or photography, a signature layout, its wording); a new product must never look like a copy.";

function system(seen: boolean): string {
  return (
    `You are a senior product designer reading a reference someone pointed at ("make it feel like this"). ${READ_METHOD}\n` +
    (seen
      ? "You are given screenshots (a desktop size first, then a phone size when there is one). Measured values may be given: they " +
        "were read from the rendered page and are facts; never contradict them, and describe only what the images show.\n"
      : "You are given only a product's name: describe the design you remember of it, and say less rather than invent. If you do not " +
        "recognise it, return an empty essence.\n") +
    'Respond ONLY with JSON: {"essence": "one sentence", "hierarchy": string, "density": "airy"|"balanced"|"dense", "surfaces": string, ' +
    '"type": string, "colour": string, "layout": string, "borrow": [up to 5 concrete principles], "doNotCopy": [up to 4 things]}'
  );
}

/** At most `len` characters, ending at the last full sentence (or word) inside that, never mid-word. */
export function clip(v: unknown, len: number): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= len) return s;
  const cut = s.slice(0, len);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (sentence > len * 0.5) return cut.slice(0, sentence + 1).replace(/;$/, ".");
  return cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : len).replace(/[,;:—-]+$/, "") + "…";
}
const str = clip;
const strs = (v: unknown, max: number, len = 320): string[] =>
  (Array.isArray(v) ? v : []).map((x) => str(x, len)).filter(Boolean).slice(0, max);

/** The model's reply as a read, or null when it is not one (no essence, or nothing to act on). */
export function parseRead(text: string): Omit<ReferenceRead, "label" | "source" | "measured" | "images"> | null {
  const j = parseLenient(text)?.value;
  if (!j || typeof j !== "object") return null;
  const essence = str(j.essence, 320);
  const borrow = strs(j.borrow, 5);
  if (!essence || borrow.length === 0) return null;
  const density = DENSITIES.includes(j.density) ? (j.density as Density) : "balanced";
  return {
    essence,
    hierarchy: str(j.hierarchy, 700),
    density,
    surfaces: str(j.surfaces, 700),
    type: str(j.type, 700),
    colour: str(j.colour ?? j.color, 700),
    layout: str(j.layout, 700),
    borrow,
    doNotCopy: strs(j.doNotCopy ?? j.dontCopy, 4),
  };
}

/** A saved image as a data URI a vision model can take, or null when it is missing or too large. */
export function imageData(repoRoot: string, rel: string): string | null {
  const abs = path.resolve(repoRoot, rel);
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Reads every usable reference: captured pages and images are looked at, named products recalled, the rest left out. One call each;
 * a failed or unusable reply leaves that reference out and says so through `log`, it never stops the others.
 */
export async function readReferences(
  refs: Reference[],
  o: { repoRoot: string; call: Call; models: string[]; log?: (line: string) => void }
): Promise<ReferenceRead[]> {
  const log = o.log ?? (() => {});
  const reads: ReferenceRead[] = [];
  for (const r of refs) {
    if (r.status !== "ok" && r.status !== "recalled") continue;
    const seen = r.status === "ok";
    const images = seen ? r.images.map((rel) => imageData(o.repoRoot, rel)).filter((u): u is string => !!u) : [];
    if (seen && images.length === 0) {
      log(`[REFERENCE] ${r.label}: its screenshot could not be read, so it was left out.`);
      continue;
    }
    const intro = seen
      ? `Reference: ${r.label}.` + (r.cues ? `\nMeasured from the rendered page (facts): ${describeCues(r.cues)}.` : "")
      : `Reference (named, no image): ${r.label}.`;
    let text: string;
    try {
      text = await o.call(
        o.models,
        [
          { role: "system", content: system(seen) },
          { role: "user", content: seen ? [{ type: "text", text: intro }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : intro },
        ],
        `reference read: ${r.label}`,
        true
      );
    } catch (err: any) {
      log(`[REFERENCE] ${r.label}: the model could not read it (${String(err?.message ?? err).split("\n")[0].slice(0, 120)}), so it was left out.`);
      continue;
    }
    const parsed = parseRead(text);
    if (!parsed) {
      log(`[REFERENCE] ${r.label}: ${seen ? "the reply was not a usable read" : "the model did not recognise it"}, so it was left out.`);
      continue;
    }
    reads.push({ label: r.label, source: seen ? "seen" : "recalled", ...parsed, ...(r.cues ? { measured: r.cues } : {}), images: r.images });
  }
  return reads;
}

/** The reads as the text a designer (or the next model) is handed: measured facts first, then what was seen, then borrow / do not copy. */
export function renderReads(reads: ReferenceRead[]): string {
  if (reads.length === 0) return "";
  return reads
    .map((r) =>
      [
        `## ${r.label} (${r.source === "seen" ? "seen in its screenshots" : "recalled from memory, not seen: weigh it lightly"})`,
        r.essence,
        r.measured ? `- Measured: ${describeCues(r.measured)}` : "",
        `- Hierarchy: ${r.hierarchy}`,
        `- Density: ${r.density}`,
        `- Surfaces: ${r.surfaces}`,
        `- Type: ${r.type}`,
        `- Colour: ${r.colour}`,
        `- Layout: ${r.layout}`,
        `- Borrow:\n${r.borrow.map((b) => `  - ${b}`).join("\n")}`,
        r.doNotCopy.length ? `- Do not copy:\n${r.doNotCopy.map((b) => `  - ${b}`).join("\n")}` : "",
      ]
        .filter((l) => l && !/: $/.test(l))
        .join("\n")
    )
    .join("\n\n");
}

/** Saved beside references.json: the reads as data (reads.json) and as text (READ.md). */
export function writeReads(outDir: string, reads: ReferenceRead[]): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "reads.json"), JSON.stringify({ reads, at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(outDir, "READ.md"), `# What the references look like\n\n${renderReads(reads) || "(no reference could be read)"}\n`);
}
