/**
 * The wordmark and the lockups: the brand NAME next to (or above) the symbol.
 *
 * A model chooses; the harness sets. The model picks which real font suits the brand, in what
 * case, how tight, and whether one round letter should become the mark. Code then sets the name
 * in that font exactly (see wordmark.ts), checks it, renders it on a light and a dark page, a
 * different model looks at the three options, and the person picks. Nothing is drawn freehand.
 */
import fs from "node:fs";
import path from "node:path";
import { auditSvg } from "./svgSafety.js";
import { lockupCardHtml, type Renderer } from "./svgRender.js";
import {
  buildLockupSvg,
  buildWordmarkSvg,
  clampTracking,
  findFont,
  INK,
  layoutWordmark,
  licenceFile,
  loadCatalog,
  type CaseMode,
  type FontEntry,
  type Weight,
  type Wordmark,
  type WordmarkSpec,
} from "./wordmark.js";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | any[];
}
export type Call = (models: string[], messages: ChatMsg[], label: string, json: boolean) => Promise<string>;

export interface TypeOption {
  id: string;
  spec: WordmarkSpec;
  why: string;
  /** The word on its own: used for the lockups. */
  plain: Wordmark;
  /** The word with one letter replaced by the mark, when that was asked for and works. */
  embedded?: Wordmark;
  /** 0-10 from a vision model; null when it could not be looked at. */
  score: number | null;
  defects: string[];
}

export interface KitFile {
  name: string;
  data: string | Buffer;
}

export interface TypographyKit {
  files: KitFile[];
  info: Record<string, unknown>;
  /** A README section. */
  readme: string;
  /** What was decided and anything that went wrong, one line each. */
  notes: string[];
  summary: string;
}

export interface TypographyContext {
  call: Call;
  director: string;
  models: string[];
  visionModels: string[];
  renderer: Renderer | null;
  briefText: string;
  name: string;
  /** The chosen concept in a sentence, so the type can answer to the symbol. */
  conceptNote: string;
  symbolLight: string;
  symbolDark: string;
  /** The design folder (it exists). */
  dir: string;
  show?: (label: string, file: string) => void;
  ask?: (prompt: string, choices: string[], fallback: string) => Promise<string>;
  log: (line: string) => void;
}

const CASES: CaseMode[] = ["as-is", "lower", "upper", "title"];
const letter = (i: number) => String.fromCharCode(65 + i);

// ---------------------------------------------------------------------------
// what the model is told
// ---------------------------------------------------------------------------

export const TYPE_NOTES =
  "You are choosing the type for the wordmark. The harness sets the name in the real font you choose, exactly as you specify, converted to shapes; you never draw letters. " +
  "Choose by the voice of the brand and answer to the symbol: a round, soft symbol wants round, soft type; an angular one wants angular type; match the weight of the symbol's strokes. " +
  "Case carries tone: lowercase reads approachable and contemporary, capitals stable and institutional, title case conventional; a capitals-only face is set in capitals. " +
  "Long names shrink badly: prefer a narrower face or tighter tracking. Open tracking (0.05 to 0.2 em) suits capitals; tight tracking suits heavy faces. " +
  "A default geometric sans with nothing ownable is forgettable, so give each option one deliberate move: a distinctive face, an unexpected case, a weight, a tracking, or replacing a ROUND letter (o, O, e, a, Q, 0) with the mark, " +
  "but only when the symbol is simple enough to read as a letter-sized shape and that letter exists in the name. " +
  "Offer three genuinely different options, each in a DIFFERENT font. Keep to at most two families for the whole brand: the wordmark face, and a body face chosen only from those marked body. " +
  "Do not choose a face that lacks a character in the name (the harness will reject it).";

export function catalogPrompt(catalog: FontEntry[]): string {
  return catalog
    .map((f) => {
      const weights = [f.files.regular ? "regular" : null, f.files.bold ? "bold" : null].filter(Boolean).join(", ");
      return `- ${f.id}: ${f.family}; ${f.voice}; ${f.feel}; weights: ${weights}${f.body ? "; body" : ""}${f.caps ? "; capitals only" : ""}${f.mono ? "; monospace" : ""}`;
    })
    .join("\n");
}

/** "0:P 1:e 2:n ..." so a letter can be named by number without ambiguity. */
export function letterList(name: string): string {
  return [...name]
    .filter((c) => !/\s/.test(c))
    .map((c, i) => `${i}:${c}`)
    .join(" ");
}

export function proposeSystem(director: string, catalog: FontEntry[]): string {
  return (
    `${director}\n\n${TYPE_NOTES}\n\n` +
    "Reflex test: models pick the same typeface for everything (a geometric sans for any tech or education brand, a soft serif for anything 'warm'). Ask whether you would choose this font for another brand in this sector; if so, justify it from the brief or choose another. The three options must use three different fonts. Do not claim a typeface 'builds trust'.\n\n" +
    `The fonts available (id; family; voice; feel; weights):\n${catalogPrompt(catalog)}\n\n` +
    'Respond ONLY with JSON: {"options": [{"fontId": id, "weight": "regular"|"bold", "case": "as-is"|"lower"|"upper"|"title", "tracking": number in em (-0.04 to 0.2), ' +
    '"replaceLetter": letter number or null, "why": "one sentence"}, ...three of them], "pairing": {"display": id, "body": id marked body, "why": "one sentence"}}'
  );
}

// ---------------------------------------------------------------------------
// reading what came back, and refusing what cannot be set
// ---------------------------------------------------------------------------

function parseJson(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // maybe wrapped in prose
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

export interface Pairing {
  display: FontEntry;
  body: FontEntry;
  why: string;
}

/** Sets one option, plain and (if asked) with a letter replaced. Null with a reason when it cannot be set. */
function setOption(spec: WordmarkSpec): { option: Omit<TypeOption, "id" | "why" | "score" | "defects">; note?: string } | { error: string } {
  const plain = layoutWordmark({ ...spec, replaceLetter: null });
  if ("error" in plain) return { error: plain.error };
  let embedded: Wordmark | undefined;
  let note: string | undefined;
  if (spec.replaceLetter !== null && spec.replaceLetter !== undefined) {
    const r = layoutWordmark(spec);
    if ("error" in r) note = `${r.error} The option is kept without replacing a letter.`;
    else embedded = r.wordmark;
  }
  return { option: { spec: { ...spec, replaceLetter: embedded ? spec.replaceLetter : null }, plain: plain.wordmark, embedded }, note };
}

export function parseTypeOptions(
  text: string,
  name: string,
  catalog: FontEntry[]
): { options: Omit<TypeOption, "id" | "score" | "defects">[]; pairing?: Pairing; notes: string[] } {
  const j = parseJson(text);
  const notes: string[] = [];
  const options: Omit<TypeOption, "id" | "score" | "defects">[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(j?.options) ? j.options : []) {
    if (options.length >= 3) break;
    const entry = findFont(raw?.fontId, catalog);
    if (!entry) {
      notes.push(`An option named a font that is not available ("${String(raw?.fontId).slice(0, 40)}") and was dropped.`);
      continue;
    }
    if (seen.has(entry.id)) continue; // three DIFFERENT fonts
    const spec: WordmarkSpec = {
      fontId: entry.id,
      weight: (raw?.weight === "bold" ? "bold" : "regular") as Weight,
      text: name,
      caseMode: CASES.includes(raw?.case) ? raw.case : "as-is",
      tracking: clampTracking(raw?.tracking),
      replaceLetter: Number.isInteger(raw?.replaceLetter) && raw.replaceLetter >= 0 ? raw.replaceLetter : null,
    };
    const set = setOption(spec);
    if ("error" in set) {
      notes.push(`${entry.family} was dropped: ${set.error}`);
      continue;
    }
    if (set.note) notes.push(`${entry.family}: ${set.note}`);
    seen.add(entry.id);
    options.push({ ...set.option, why: String(raw?.why ?? "").slice(0, 200) });
  }

  let pairing: Pairing | undefined;
  if (options.length > 0) {
    const display = findFont(j?.pairing?.display, catalog) ?? findFont(options[0].spec.fontId, catalog)!;
    const asked = findFont(j?.pairing?.body, catalog);
    const body = asked?.body ? asked : catalog.find((f) => f.body && f.id !== display.id) ?? catalog.find((f) => f.body) ?? display;
    pairing = { display, body, why: String(j?.pairing?.why ?? "").slice(0, 200) };
  }
  return { options, pairing, notes };
}

/** Safe options for when the model's did not come back usable: three real, different, readable faces. */
export function defaultTypeOptions(name: string, catalog: FontEntry[]): Omit<TypeOption, "id" | "score" | "defects">[] {
  const wanted: [string, Weight, CaseMode, number, string][] = [
    ["poppins", "bold", "as-is", 0.02, "A clean geometric sans that suits most products."],
    ["barlow", "bold", "as-is", 0.02, "A calm, neutral grotesque."],
    ["crimsontext", "bold", "as-is", 0.01, "A classic old-style serif for a more editorial voice."],
    ["bevietnampro", "bold", "as-is", 0.02, "A warm, contemporary sans."],
    ["archivoblack", "regular", "as-is", 0.02, "A heavy, confident grotesque."],
  ];
  const out: Omit<TypeOption, "id" | "score" | "defects">[] = [];
  for (const [id, weight, caseMode, tracking, why] of wanted) {
    if (out.length >= 3) break;
    if (!findFont(id, catalog)) continue;
    const set = setOption({ fontId: id, weight, text: name, caseMode, tracking, replaceLetter: null });
    if (!("error" in set)) out.push({ ...set.option, why });
  }
  return out;
}

// ---------------------------------------------------------------------------
// looking at the options
// ---------------------------------------------------------------------------

export const TYPE_JUDGE =
  "You judge wordmark options for one logo from the images. Each image is one option shown on a light page and a dark page, at a comfortable size and at a small one. " +
  "Judge ONLY what you see. Score 0-10: the name reads clearly at the small size; spacing and kerning look even (no gaps like 'A V' or collisions); " +
  "the type matches the symbol's character and weight (it looks like it belongs to the same brand); it suits the brand's personality; it is distinct rather than default; " +
  "if a letter was replaced by the mark, it still reads as that letter. Be strict: 7 is good, 9 is rare. " +
  'List defects as specific, fixable notes. Respond ONLY with JSON: {"scores": [{"id": "A", "score": number, "defects": [string, up to 3]}, ...], "pick": "A"}';

export function parseTypeJudgement(text: string, ids: string[]): { scores: Map<string, { score: number; defects: string[] }>; pick: string | null } {
  const j = parseJson(text);
  const scores = new Map<string, { score: number; defects: string[] }>();
  for (const s of Array.isArray(j?.scores) ? j.scores : []) {
    const id = String(s?.id ?? "").toUpperCase();
    const n = Number(s?.score);
    if (!ids.includes(id) || !Number.isFinite(n)) continue;
    scores.set(id, {
      score: Math.max(0, Math.min(10, n)),
      defects: (Array.isArray(s?.defects) ? s.defects : []).map((d: unknown) => String(d).slice(0, 200)).slice(0, 3),
    });
  }
  const pick = String(j?.pick ?? "").toUpperCase();
  return { scores, pick: ids.includes(pick) ? pick : null };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function describeOption(o: TypeOption, catalog: FontEntry[] = loadCatalog()): string {
  const f = findFont(o.spec.fontId, catalog);
  const bits = [
    `${f?.family ?? o.spec.fontId}${o.plain.font.weight === "bold" ? " Bold" : ""}`,
    o.spec.caseMode === "as-is" ? null : o.spec.caseMode === "title" ? "title case" : o.spec.caseMode === "lower" ? "lowercase" : "capitals",
    o.spec.tracking !== 0 ? `tracking ${o.spec.tracking > 0 ? "+" : ""}${o.spec.tracking.toFixed(2)} em` : null,
    o.embedded ? "the mark replaces a letter" : null,
  ].filter(Boolean);
  return bits.join(", ");
}

// ---------------------------------------------------------------------------
// the whole step
// ---------------------------------------------------------------------------

export async function designTypography(ctx: TypographyContext): Promise<TypographyKit | null> {
  const catalog = loadCatalog();
  if (catalog.length === 0) {
    ctx.log("[DESIGN] No fonts are installed with this build, so no wordmark was made.");
    return null;
  }
  const notes: string[] = [];

  // 1. the model chooses
  let options: Omit<TypeOption, "id" | "score" | "defects">[] = [];
  let pairing: Pairing | undefined;
  try {
    const text = await ctx.call(
      ctx.models,
      [
        { role: "system", content: proposeSystem(ctx.director, catalog) },
        {
          role: "user",
          content:
            `The brief:\n${ctx.briefText}\n\nThe name to set: ${ctx.name}\nLetters by number: ${letterList(ctx.name)}\n\n` +
            `The symbol that was chosen: ${ctx.conceptNote}\nIts source:\n${ctx.symbolLight.slice(0, 1800)}`,
        },
      ],
      "typography",
      true
    );
    const parsed = parseTypeOptions(text, ctx.name, catalog);
    options = parsed.options;
    pairing = parsed.pairing;
    notes.push(...parsed.notes);
  } catch (err: any) {
    notes.push(`The type proposal failed (${String(err?.message ?? err).slice(0, 80)}).`);
  }
  if (options.length === 0) {
    options = defaultTypeOptions(ctx.name, catalog);
    notes.push("No usable type options came back, so three safe defaults were used.");
  }
  if (options.length === 0) {
    ctx.log(`[DESIGN] ${notes.join(" ")} The name could not be set in any bundled font, so there is no wordmark.`);
    return null;
  }
  const opts: TypeOption[] = options.map((o, i) => ({ ...o, id: letter(i), score: null, defects: [] }));

  // 2. each one, as it will be met
  const typoDir = path.join(ctx.dir, "typography");
  fs.mkdirSync(typoDir, { recursive: true });
  const lightOf = (o: TypeOption) => buildLockupSvg(ctx.symbolLight, o.plain, "horizontal", INK.light);
  const darkOf = (o: TypeOption) => buildLockupSvg(ctx.symbolDark, o.plain, "horizontal", INK.dark);
  const cards = new Map<string, string>();
  if (ctx.renderer) {
    for (const o of opts) {
      try {
        const file = path.join(typoDir, `option-${o.id.toLowerCase()}.png`);
        fs.writeFileSync(file, await ctx.renderer.page(lockupCardHtml({ label: `${o.id} — ${describeOption(o, catalog)}`, light: lightOf(o), dark: darkOf(o), lightAlt: o.embedded ? buildWordmarkSvg(o.embedded, INK.light, ctx.symbolLight) : undefined, darkAlt: o.embedded ? buildWordmarkSvg(o.embedded, INK.dark, ctx.symbolDark) : undefined }), 700, 200));
        cards.set(o.id, file);
      } catch {
        // an option without a picture is still an option
      }
    }
  }
  for (const o of opts) fs.writeFileSync(path.join(typoDir, `option-${o.id.toLowerCase()}.svg`), lightOf(o));

  // 3. a model other than the proposer looks
  let pick: string | null = null;
  if (ctx.renderer && cards.size === opts.length) {
    try {
      const others = ctx.visionModels.filter((m) => m !== ctx.models[0]);
      const text = await ctx.call(
        others.length > 0 ? others : ctx.visionModels,
        [
          { role: "system", content: `${ctx.director}\n\n${TYPE_JUDGE}` },
          {
            role: "user",
            content: [
              { type: "text", text: `The brief:\n${ctx.briefText}\n\nThe options are ${opts.map((o) => o.id).join(", ")}, in order. Judge them.` },
              ...opts.map((o) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(cards.get(o.id)!).toString("base64")}` } })),
            ],
          },
        ],
        "typography look",
        true
      );
      const j = parseTypeJudgement(text, opts.map((o) => o.id));
      for (const o of opts) {
        const s = j.scores.get(o.id);
        if (s) {
          o.score = s.score;
          o.defects = s.defects;
        }
      }
      pick = j.pick;
    } catch {
      notes.push("The options could not be looked at.");
    }
  }
  const best = [...opts].sort((a, b) => (b.score ?? 5) - (a.score ?? 5))[0];
  const recommended = opts.find((o) => o.id === pick) ?? best;

  // 4. the person chooses, seeing what they are choosing between
  for (const o of opts) {
    const f = cards.get(o.id);
    if (f) ctx.show?.(`Wordmark ${o.id} — ${describeOption(o, catalog)}${o === recommended ? " (recommended)" : ""}`, f);
  }
  ctx.log(`[DESIGN] Wordmark options: ${path.join(typoDir)}`);
  for (const o of opts) ctx.log(`   ${o.id}. ${describeOption(o, catalog)}${o.score !== null ? ` (${o.score.toFixed(1)}/10)` : ""}${o.why ? ` — ${o.why}` : ""}`);
  let chosen = recommended;
  if (ctx.ask && opts.length > 1) {
    const labels = opts.map((o) => `${o.id} — ${describeOption(o, catalog)}${o === recommended ? " (recommended)" : ""}`);
    try {
      const answer = await ctx.ask(
        `Which wordmark should go with the symbol?\n${opts.map((o) => `${o.id} — ${describeOption(o, catalog)}${o.why ? `: ${o.why}` : ""}`).join("\n")}\n${
          cards.size > 0 ? "The pictures are above." : `No pictures could be made; the SVG files are in ${typoDir}.`
        }`,
        labels,
        labels[opts.indexOf(recommended)]
      );
      const l = /^\s*([A-C])\b/i.exec(answer)?.[1]?.toUpperCase();
      chosen = opts.find((o) => o.id === l) ?? recommended;
    } catch {
      chosen = recommended;
    }
  }
  ctx.log(`[DESIGN] Wordmark: ${chosen.id} — ${describeOption(chosen, catalog)}.`);

  return buildKit(ctx, chosen, pairing, notes, catalog);
}

// ---------------------------------------------------------------------------
// the files
// ---------------------------------------------------------------------------

async function buildKit(ctx: TypographyContext, chosen: TypeOption, pairing: Pairing | undefined, notes: string[], catalog: FontEntry[]): Promise<TypographyKit> {
  const files: KitFile[] = [];
  const word = chosen.plain;
  const svgs: Record<string, string> = {
    "wordmark.svg": buildWordmarkSvg(word, INK.light),
    "wordmark-on-dark.svg": buildWordmarkSvg(word, INK.dark),
    "lockup-horizontal.svg": buildLockupSvg(ctx.symbolLight, word, "horizontal", INK.light),
    "lockup-horizontal-on-dark.svg": buildLockupSvg(ctx.symbolDark, word, "horizontal", INK.dark),
    "lockup-stacked.svg": buildLockupSvg(ctx.symbolLight, word, "stacked", INK.light),
    "lockup-stacked-on-dark.svg": buildLockupSvg(ctx.symbolDark, word, "stacked", INK.dark),
  };
  if (chosen.embedded) {
    svgs["wordmark-with-mark.svg"] = buildWordmarkSvg(chosen.embedded, INK.light, ctx.symbolLight);
    svgs["wordmark-with-mark-on-dark.svg"] = buildWordmarkSvg(chosen.embedded, INK.dark, ctx.symbolDark);
  }
  for (const [name, data] of Object.entries(svgs)) files.push({ name, data });

  if (ctx.renderer) {
    for (const name of ["lockup-horizontal.svg", "lockup-horizontal-on-dark.svg", "lockup-stacked.svg", "lockup-stacked-on-dark.svg"]) {
      try {
        const vb = auditSvg(svgs[name]).viewBox;
        const width = 1200;
        files.push({ name: name.replace(/\.svg$/, ".png"), data: await ctx.renderer.png(svgs[name], { size: width, height: Math.max(1, Math.round((width * vb.h) / vb.w)) }) });
      } catch {
        // the SVGs stand on their own
      }
    }
  }

  const used = new Map<string, FontEntry>();
  const wordFont = findFont(chosen.spec.fontId, catalog)!;
  used.set(wordFont.id, wordFont);
  if (pairing) {
    used.set(pairing.display.id, pairing.display);
    used.set(pairing.body.id, pairing.body);
  }
  for (const f of used.values()) {
    const lic = licenceFile(f);
    if (lic) files.push({ name: `fonts/OFL-${f.id}.txt`, data: fs.readFileSync(lic) });
  }

  const gf = (f: FontEntry) => `https://fonts.google.com/specimen/${encodeURIComponent(f.family).replace(/%20/g, "+")}`;
  const described = describeOption(chosen, catalog);
  const readme =
    `## Typography\n` +
    `- Wordmark: **${described}**. It is outlined shapes, so it needs no font where it is shown.\n` +
    (pairing ? `- Brand typefaces: display **${pairing.display.family}**, body **${pairing.body.family}**${pairing.why ? `: ${pairing.why}` : ""}. Two families at most.\n` : "") +
    `- Every font used is open-licence (SIL Open Font License 1.1), free for products and print. Licence texts are in \`fonts/\`. Get the families from Google Fonts: ${[...used.values()].map((f) => `[${f.family}](${gf(f)})`).join(", ")}.\n` +
    `- Files: \`wordmark.svg\`, \`lockup-horizontal.svg\`, \`lockup-stacked.svg\`${chosen.embedded ? ", `wordmark-with-mark.svg` (a letter replaced by the mark)" : ""}, each with an \`-on-dark\` version${ctx.renderer ? " and PNGs" : ""}.\n` +
    `- Check pairs such as AV and To by eye before print: spacing is the font's own kerning plus the tracking above.\n\n`;

  return {
    files,
    readme,
    notes,
    summary: `Wordmark: ${described}.`,
    info: {
      wordmark: {
        fontId: chosen.spec.fontId,
        family: wordFont.family,
        weight: chosen.plain.font.weight,
        case: chosen.spec.caseMode,
        tracking: chosen.spec.tracking,
        replacedLetter: chosen.embedded ? chosen.spec.replaceLetter : null,
        text: word.text,
        score: chosen.score,
      },
      pairing: pairing ? { display: pairing.display.family, body: pairing.body.family, why: pairing.why } : null,
      licence: "SIL Open Font License 1.1",
    },
  };
}
