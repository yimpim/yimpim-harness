/**
 * Two more things a designer is asked: "what do you think of this logo?" and
 * "refresh the one we have". Both start from a logo that already exists, so
 * both start by LOOKING at it.
 *
 *   critique: a scorecard on ten dimensions (1-5), a first impression, what
 *   works, and the three changes that matter most. Nothing is redesigned.
 *
 *   redesign: the same diagnosis, then an equity audit (what the public
 *   already recognises and must survive, what is free to change, and whether
 *   this is a refresh or a rebuild), which becomes the constraints the normal
 *   concept-and-draw pipeline works within.
 *
 * Models do the judging; code only reads the file safely, bounds the answer,
 * and works out the total itself.
 */
import fs from "node:fs";
import path from "node:path";
import { existingFilesOnly } from "./projectLayout.js";
import { auditSvg, sanitizeSvg, themeReport } from "./svgSafety.js";
import type { Renderer } from "./svgRender.js";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | any[];
}
export type Call = (models: string[], messages: ChatMsg[], label: string, json: boolean) => Promise<string>;

export const DIMENSIONS = ["idea", "simplicity", "distinction", "memorability", "relevance", "craft", "versatility", "longevity", "colour", "typography"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Critique {
  firstImpression: string;
  works: string[];
  scores: Partial<Record<Dimension, number>>;
  /** One flaw serious enough to outweigh a good total, or null. */
  fatalFlaw: string | null;
  /** The changes that matter most, most important first. */
  changes: string[];
  /** Sum of the scored dimensions and what they could have been. Worked out here, never taken from the model. */
  total: number;
  outOf: number;
}

export interface Equity {
  strategy: "refresh" | "rebuild";
  /** What the public recognises and must survive. */
  keep: string[];
  /** What is free to change. */
  change: string[];
  why: string;
}

export interface ExistingLogo {
  /** Project-relative path. */
  file: string;
  kind: "svg" | "raster";
  /** The sanitised source, for an SVG that could be read. */
  svg?: string;
  /** What a vision model is shown: images as data URIs. */
  images: string[];
  /** A file a person can open to see what was looked at. */
  preview?: string;
}

const strs = (v: unknown, max: number, len = 220): string[] =>
  (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, len));

function parseJson(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // maybe wrapped in prose or a fence
  }
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// reading the existing logo, safely
// ---------------------------------------------------------------------------

const RASTER_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_RASTER_BYTES = 5 * 1024 * 1024;

/**
 * The logo the request is about. Only a real file inside the project, of a kind a model can look at.
 * An SVG is shown as it renders on a light and a dark page (it needs a browser to draw it); a raster
 * is shown as it is. Returns null when it cannot be looked at, and the reason.
 */
export async function loadExistingLogo(
  repoRoot: string,
  rel: unknown,
  renderer: Renderer | null,
  stage?: (name: string, data: Buffer) => string | undefined
): Promise<{ logo: ExistingLogo } | { error: string }> {
  const file = existingFilesOnly(repoRoot, [rel], 1)[0];
  if (!file) return { error: "that file is not in the project" };
  const ext = path.extname(file).toLowerCase();
  const full = path.resolve(repoRoot, file);
  if (ext === ".svg") {
    let raw = "";
    try {
      raw = fs.readFileSync(full, "utf-8").slice(0, 200_000);
    } catch {
      return { error: "the file could not be read" };
    }
    const s = sanitizeSvg(raw);
    if (!s.svg) return { error: "the SVG could not be read as a drawing" };
    if (!renderer) return { error: "an SVG needs a browser to draw it, and none is available" };
    const light = await renderer.png(s.svg, { size: 512, background: "#ffffff" });
    const dark = await renderer.png(s.svg, { size: 512, background: "#0f0f14" });
    return {
      logo: {
        file,
        kind: "svg",
        svg: s.svg,
        images: [light, dark].map((b) => `data:image/png;base64,${b.toString("base64")}`),
        preview: stage?.("current-logo.png", light),
      },
    };
  }
  const mime = RASTER_MIME[ext];
  if (!mime) return { error: "only SVG, PNG, JPG and WebP logos can be looked at" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(full);
  } catch {
    return { error: "the file could not be read" };
  }
  if (bytes.length > MAX_RASTER_BYTES) return { error: "the image is over 5 MB" };
  return { logo: { file, kind: "raster", images: [`data:${mime};base64,${bytes.toString("base64")}`], preview: full } };
}

// ---------------------------------------------------------------------------
// the critique
// ---------------------------------------------------------------------------

export const CRITIQUE_METHOD =
  "Method. First the context: who it is for and what the brand needs. Then the two-second first impression, said honestly. " +
  "Then a technical pass (does it read small, in one colour, on light and on dark; clean geometry and junctions; any accidental reading) and a principles pass " +
  "(one idea, simple, distinct, memorable, relevant not literal, timeless not trendy). Score each dimension 1 to 5 where 3 is acceptable, 4 good, and 5 rare. " +
  "A single fatal flaw can outweigh a high total, so name it. Then the changes that matter most, most important first, each concrete and doable. " +
  "Critique the work, never the person. Symptoms and their usual causes: mush when small = too much detail or tight gaps; generic = stock type or a category cliché; dated = effects, gradients or a fading trend; " +
  "busy = more than one idea; a pinched side on a rounded shape = the bone effect; a reversed version that looks heavier = irradiation.";

export function critiqueSystem(director: string): string {
  return (
    `${director}\n\nYou are critiquing a logo that already exists, from the image(s). ${CRITIQUE_METHOD}\n` +
    `Score only what you can judge from what you see: leave out a dimension you cannot judge (for typography, if the mark has no lettering). ` +
    `Respond ONLY with JSON: {"firstImpression": "two sentences", "works": [up to 3 strengths], ` +
    `"scores": {${DIMENSIONS.map((d) => `"${d}": 1-5`).join(", ")}}, "fatalFlaw": string|null, "changes": [up to 3, most important first]}`
  );
}

export function parseCritique(text: string): Critique | null {
  const j = parseJson(text);
  if (!j || typeof j !== "object") return null;
  const scores: Partial<Record<Dimension, number>> = {};
  for (const d of DIMENSIONS) {
    const n = Number(j.scores?.[d]);
    if (Number.isFinite(n) && n > 0) scores[d] = Math.min(5, Math.max(1, Math.round(n)));
  }
  const counted = Object.keys(scores).length;
  if (counted < 3) return null; // not a real scorecard
  const total = Object.values(scores).reduce((a, b) => a + (b ?? 0), 0);
  const fatal = typeof j.fatalFlaw === "string" && j.fatalFlaw.trim() && !/^(none|null|n\/a|no)\b/i.test(j.fatalFlaw.trim()) ? j.fatalFlaw.trim().slice(0, 300) : null;
  return {
    firstImpression: String(j.firstImpression ?? "").slice(0, 400),
    works: strs(j.works, 3),
    scores,
    fatalFlaw: fatal,
    changes: strs(j.changes, 3, 300),
    total,
    outOf: counted * 5,
  };
}

export function renderCritique(c: Critique, name: string): string {
  return (
    `# Critique of the ${name} logo\n\n` +
    `**First impression.** ${c.firstImpression || "(none given)"}\n\n` +
    (c.works.length > 0 ? `**What works**\n${c.works.map((w) => `- ${w}`).join("\n")}\n\n` : "") +
    `**Scorecard** (1 to 5; ${c.total} of ${c.outOf}, a rough guide: one fatal flaw outweighs a high total)\n\n| Dimension | Score |\n|---|---|\n` +
    DIMENSIONS.filter((d) => c.scores[d] !== undefined)
      .map((d) => `| ${d} | ${c.scores[d]} |`)
      .join("\n") +
    "\n\n" +
    (c.fatalFlaw ? `**Fatal flaw.** ${c.fatalFlaw}\n\n` : "") +
    (c.changes.length > 0 ? `**Changes that matter most**\n${c.changes.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n` : "")
  );
}

export async function critiqueLogo(
  call: Call,
  director: string,
  visionModels: string[],
  logo: ExistingLogo,
  briefText: string
): Promise<Critique | null> {
  const text = await call(
    visionModels,
    [
      { role: "system", content: critiqueSystem(director) },
      {
        role: "user",
        content: [
          { type: "text", text: `The brief:\n${briefText}\n\n${logo.kind === "svg" ? "Image 1 is the logo on a light page, image 2 on a dark page." : "The logo:"}` },
          ...logo.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
    "critique",
    true
  );
  return parseCritique(text);
}

// ---------------------------------------------------------------------------
// the equity audit (redesign)
// ---------------------------------------------------------------------------

export const EQUITY_METHOD =
  "Should it change at all? Good reasons: the business has changed, it fails in use (small sizes, one colour), its versions are inconsistent, it resembles a competitor, or it looks dated. " +
  "Weak reasons: someone's boredom or vanity, or chasing a trend. A radical change to a mark people know can backfire, and most successful updates EVOLVE. " +
  "Audit the equity: rank what the public actually recognises (usually shape and colour), decide what must survive, and what is free to change. " +
  "Refresh techniques: redraw curves cleanly, simplify, retune any lettering, soften or sharpen corners, adjust colour within its hue family, add a container, build the missing versions, keep a heritage accent. " +
  "Keep the colour unless there is a strong reason to drop it.";

export function equitySystem(director: string): string {
  return (
    `${director}\n\nYou are auditing an existing logo before it is redesigned. ${EQUITY_METHOD}\n` +
    `If the request gives only a weak reason and the logo is sound, say so in "why" and still plan the change that was asked for. ` +
    `Respond ONLY with JSON: {"strategy": "refresh"|"rebuild", "keep": [what must survive, most recognisable first, up to 4], "change": [what is free to change, up to 4], "why": "two sentences"}`
  );
}

export function parseEquity(text: string): Equity | null {
  const j = parseJson(text);
  if (!j || typeof j !== "object") return null;
  const keep = strs(j.keep, 4);
  const strategy = j.strategy === "rebuild" ? "rebuild" : "refresh";
  // A refresh that keeps nothing is not a refresh: with nothing to preserve it is a rebuild.
  return { strategy: keep.length === 0 ? "rebuild" : strategy, keep, change: strs(j.change, 4), why: String(j.why ?? "").slice(0, 400) };
}

export async function auditEquity(
  call: Call,
  director: string,
  models: string[],
  visionModels: string[],
  logo: ExistingLogo,
  critique: Critique | null,
  request: string,
  briefText: string
): Promise<Equity | null> {
  const text = await call(
    visionModels.length > 0 ? visionModels : models,
    [
      { role: "system", content: equitySystem(director) },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `The request:\n${request}\n\nThe brief:\n${briefText}\n\n` +
              (critique ? `The diagnosis:\n${renderCritique(critique, "existing")}\n` : "") +
              "The logo as it is:",
          },
          ...logo.images.slice(0, 1).map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
    "equity",
    true
  );
  return parseEquity(text);
}

/** The constraints the redesign works within: what must survive and what may change. */
export function equityConstraints(e: Equity): string[] {
  return [
    ...e.keep.map((k) => `Keep (it is what people recognise): ${k}`),
    ...(e.change.length > 0 ? [`Free to change: ${e.change.join("; ")}`] : []),
    e.strategy === "refresh" ? "This is a refresh: evolve the mark, do not replace the idea." : "This is a rebuild: a new idea is allowed.",
  ];
}

/**
 * What can be MEASURED about an existing logo, kept apart from the opinion scorecard. A check that was
 * not made says "not checked" and why; it is never reported as a pass.
 */
export function critiqueGates(logo: ExistingLogo, rendered: boolean): { id: string; status: "pass" | "fail" | "not-checked"; detail: string }[] {
  const out: { id: string; status: "pass" | "fail" | "not-checked"; detail: string }[] = [];
  if (logo.kind === "svg" && logo.svg) {
    const t = themeReport(logo.svg);
    const a = auditSvg(logo.svg);
    out.push({ id: "vector-file", status: "pass", detail: "The logo is a vector with no text or image inside." });
    out.push(
      t.base
        ? { id: "both-themes", status: t.fadesOn.length === 0 ? "pass" : "fail", detail: `Main colour ${t.base}: ${t.onLight}:1 on white, ${t.onDark}:1 on near-black (needs 3:1 on each)${t.fadesOn.length ? `; it fades on the ${t.fadesOn.join(" and ")} surface` : ""}.` }
        : { id: "both-themes", status: "not-checked", detail: "No main colour could be found to measure." }
    );
    out.push({ id: "colour-count", status: a.colors.length <= 3 ? "pass" : "fail", detail: `${a.colors.length} colour(s) in the file (three or fewer keeps it simple to reproduce).` });
  } else {
    out.push({ id: "vector-file", status: "fail", detail: "Only a picture (raster) file was given, so it cannot be scaled or recoloured cleanly; a vector master is needed." });
    out.push({ id: "both-themes", status: "not-checked", detail: "Colours cannot be measured from a picture file." });
  }
  out.push(rendered ? { id: "small-size", status: "pass", detail: "The logo was drawn and looked at, including at small sizes." } : { id: "small-size", status: "not-checked", detail: "No browser was available to draw it at small sizes." });
  out.push({ id: "competitor-confusion", status: "not-checked", detail: "Competitors were not read in critique mode." });
  out.push({ id: "font-licence", status: "not-checked", detail: "The typeface in the logo was not identified." });
  return out;
}

export function renderGates(gates: ReturnType<typeof critiqueGates>): string {
  return (
    `**Measured checks** (a gate is measured and can fail; the scorecard above is opinion)\n\n` +
    gates.map((g) => `- ${g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : "NOT CHECKED"} ${g.id}: ${g.detail}`).join("\n") +
    `\n\nA clean list means nothing measurable is broken, not that the logo is good.\n`
  );
}
