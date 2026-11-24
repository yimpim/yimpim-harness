/**
 * The look of a NEW app or site, decided with the person before the design system is written: one question about references they
 * like, then the design system is built from what those references look like.
 *
 * Only for a new user-facing build: the request calls for new UI, the project has no design system yet, and it is a new project.
 * A bug fix, a backend, a CLI, an incremental feature or a restyle of an existing app never gets here (uiDesign.ts checks that
 * before it loads this module), so routine runs never open a browser or spend a vision call for it. With nobody to ask (no
 * terminal or phone, or planning.questions is "autonomous"), nothing is asked and the recommended direction is used.
 */
import path from "node:path";
import fs from "node:fs";
import { gatherReferences, referenceBrowser, describeReferences, type Reference } from "./uiReference.js";
import { readReferences, writeReads, type ReferenceRead, type Call } from "./referenceRead.js";
import type { Renderer } from "./svgRender.js";
import { hexToOklch } from "./colorlib.js";
import { directionSystem, parseDirection, buildDesignSystem, type Direction, type DesignSystem, type UiStack } from "./uiDesign.js";
import type { Playbook } from "./uiKnowledge.js";
import type { ProductRow } from "./uiData.js";
import type { BrandFacts } from "./identity.js";

export interface VisualIntake {
  /** Asks the person (free text allowed). Absent when nobody can answer. */
  ask?: (prompt: string, choices: string[], fallback: string) => Promise<string>;
  /** Shows a picture: the path on the desktop, the image on a paired phone. */
  show?: (label: string, file: string) => void;
  /** Vision models (Designer Judge (Vision)) for reading references. */
  visionModels: string[];
  /** planning.questions is "autonomous": never wait on a person. */
  autonomous: boolean;
  /** The project is new (a fresh or starter project), not an existing app. */
  newProject: boolean;
  /** Opens a browser to draw the direction samples, only when they are drawn; null when there is none. */
  openRenderer?: () => Promise<Renderer | null>;
  /** Injected for tests; the real one captures pages in a guarded browser. */
  references?: (inputs: string[], outDir: string) => Promise<Reference[]>;
}

/** Only a new user-facing build, in a new project, with no design system yet. */
export function wantsVisualIntake(o: { ui: string; exists: boolean; newProject: boolean }): boolean {
  return o.ui === "new" && !o.exists && o.newProject;
}

export const SHOW_DIRECTIONS = "Show me 3 directions";
export const DECIDE_LOOK = "Decide for me";

export const REFERENCE_QUESTION =
  "Before I design the look: is there an app or a site whose look you like? Type image paths, web addresses or a product's " +
  `name, separated by spaces (a screenshot works best). Or choose "${SHOW_DIRECTIONS}" to pick from three looks, or "${DECIDE_LOOK}".`;

export type IntakeAnswer = { mode: "directions" } | { mode: "decide" } | { mode: "references"; inputs: string[] };

/** The person's answer: one of the two choices, or their references (quoted names with spaces stay whole). */
export function parseReferenceAnswer(answer: string | undefined): IntakeAnswer {
  const a = (answer ?? "").trim();
  if (!a || a.toLowerCase() === DECIDE_LOOK.toLowerCase() || /^(decide|you decide|no|none|skip|nothing)\b/i.test(a)) return { mode: "decide" };
  if (a.toLowerCase() === SHOW_DIRECTIONS.toLowerCase() || /^(show|directions|options|3|three)\b/i.test(a)) return { mode: "directions" };
  const inputs: string[] = [];
  for (const m of a.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) inputs.push(m[1] ?? m[2] ?? m[3]);
  // "like linear.app and stripe.com" -> the addresses and names, without the filler words.
  const kept = inputs.map((s) => s.replace(/[,;]+$/, "")).filter((s) => s && !/^(like|and|or|the|a|an|look|of|similar|to|something)$/i.test(s));
  return kept.length ? { mode: "references", inputs: kept } : { mode: "decide" };
}

export interface IntakeResult {
  mode: "directions" | "decide" | "references";
  reads: ReferenceRead[];
}

const realReferences = (repoRoot: string) => async (inputs: string[], outDir: string) => {
  const browser = inputs.some((i) => !fs.existsSync(path.resolve(repoRoot, i))) ? await referenceBrowser() : null;
  try {
    return await gatherReferences(inputs, { repoRoot, outDir, browser });
  } finally {
    await browser?.close();
  }
};

/**
 * The one question, and what the answer leads to. References are gathered and read (design-system/references/); when none of
 * them could be used, the three directions are offered instead, so the person still gets a say.
 */
export async function askForLook(intake: VisualIntake, o: { repoRoot: string; call: Call; log: (line: string) => void }): Promise<IntakeResult> {
  if (intake.autonomous || !intake.ask) {
    o.log("[DESIGN] Nobody to ask about the look (or questions are off), so the recommended direction is used.");
    return { mode: "decide", reads: [] };
  }
  const answer = parseReferenceAnswer(await intake.ask(REFERENCE_QUESTION, [SHOW_DIRECTIONS, DECIDE_LOOK], DECIDE_LOOK));
  if (answer.mode !== "references") return { mode: answer.mode, reads: [] };
  const outDir = path.join(o.repoRoot, "design-system", "references");
  const refs = await (intake.references ?? realReferences(o.repoRoot))(answer.inputs, outDir);
  for (const l of describeReferences(refs)) o.log(l);
  const reads = await readReferences(refs, { repoRoot: o.repoRoot, call: o.call, models: intake.visionModels, log: o.log });
  if (reads.length === 0) {
    o.log(`[DESIGN] None of those references could be used, so here are three directions to choose from instead.`);
    return { mode: "directions", reads: [] };
  }
  writeReads(outDir, reads);
  o.log(`[DESIGN] Read ${reads.length} reference(s): the design system is built from what they look like (design-system/references/READ.md).`);
  return { mode: "references", reads };
}

// ----------------------------------------------------------------------------------------------- three directions to pick from

export const DIRECTIONS_INSTRUCTION =
  "\n\nInstead of one direction, propose THREE that are clearly different from each other: different styles, different type " +
  "pairings and different signature colours, each a credible answer to the brief (not a safe one, a loud one and a strange one). " +
  'Respond ONLY with JSON: {"directions": [three objects, each with every key above plus "pitch": "one sentence a person would ' +
  'choose it for"], "recommended": 1|2|3}';

export interface DirectionOption {
  n: number;
  direction: Direction;
  system: DesignSystem;
  pitch: string;
}

/** The three proposals as raw objects, and which one is recommended (0-based; the first when unsaid). */
export function parseDirections(text: string): { raws: any[]; recommended: number } {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    try {
      j = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
    } catch {
      j = null;
    }
  }
  const raws = Array.isArray(j?.directions) ? j.directions.filter((d: any) => d && typeof d === "object").slice(0, 3) : [];
  const rec = Number(j?.recommended);
  return { raws, recommended: Number.isInteger(rec) && rec >= 1 && rec <= raws.length ? rec - 1 : 0 };
}

const hueOf = (hex: string) => hexToOklch(hex).h;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Too alike to be a real choice: the same style and type pairing, or the same style and nearly the same signature colour. */
export function tooAlike(a: Direction, b: Direction): boolean {
  if (a.style === b.style && a.pairing === b.pairing) return true;
  return a.style === b.style && hueGap(hueOf(a.signature), hueOf(b.signature)) < 25;
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Each direction as a small sample screen in its own tokens (colours, type, radius, density), side by side. */
export function directionsSheetHtml(options: DirectionOption[]): string {
  const families = [...new Set(options.flatMap((o) => [o.system.pairing.heading, o.system.pairing.body]))];
  const gf = families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600;700`).join("&");
  const cols = options
    .map((o) => {
      const r = o.system.palette.light;
      const s = o.system;
      const pad = o.direction.density === "airy" ? 24 : o.direction.density === "dense" ? 10 : 16;
      const rad = s.radius.md ?? 8;
      const radL = s.radius.lg ?? rad;
      const btnRad = o.direction.radius === "round" ? 999 : rad;
      const head = `'${esc(s.pairing.heading)}', system-ui, sans-serif`;
      const body = `'${esc(s.pairing.body)}', system-ui, sans-serif`;
      return (
        `<div class="col"><div class="label"><b>${o.n}. ${esc(o.direction.name)}</b> ${esc(o.pitch)}</div>` +
        `<div class="screen" style="background:${r.background};color:${r.text};font-family:${body};padding:${pad}px;border-radius:${radL}px">` +
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${pad}px"><span style="font-family:${head};font-weight:700">${esc(o.direction.name)}</span><span style="width:28px;height:28px;border-radius:999px;background:${r.surfaceAlt};display:inline-block"></span></div>` +
        `<div style="font-family:${head};font-weight:700;font-size:28px;line-height:1.15;letter-spacing:-0.01em">Your week at a glance</div>` +
        `<p style="color:${r.textMuted};margin:8px 0 ${pad}px">Three things need you today. Everything else can wait.</p>` +
        `<div style="display:flex;gap:8px;margin-bottom:${pad}px"><span style="background:${r.primary};color:${r.onPrimary};padding:10px 16px;border-radius:${btnRad}px;font-weight:600">Get started</span>` +
        `<span style="border:1px solid ${r.border};padding:10px 16px;border-radius:${btnRad}px">Later</span></div>` +
        [
          ["Review the draft", "Due today"],
          ["Send the invoice", "Tomorrow"],
        ]
          .map(
            ([t, m]) =>
              `<div style="background:${r.surface};border:1px solid ${r.border};border-radius:${rad}px;padding:${Math.max(8, pad - 4)}px;margin-bottom:8px;display:flex;justify-content:space-between"><span>${t}</span><span style="color:${r.accent || r.primary};font-size:13px">${m}</span></div>`
          )
          .join("") +
        `<div style="margin-top:${pad}px;font-size:13px;color:${r.textMuted}">Email</div><div style="border:1px solid ${r.border};background:${r.surface};border-radius:${rad}px;padding:10px;margin-top:4px;color:${r.textMuted}">you@example.com</div>` +
        `</div><div class="facts">${esc(s.style.name)} · ${esc(s.pairing.heading)} / ${esc(s.pairing.body)} · <span class="sw" style="background:${o.direction.signature}"></span> ${o.direction.signature} · ${o.direction.density}</div></div>`
      );
    })
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    (gf ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${gf}&display=swap">` : "") +
    `<style>body{margin:0;padding:24px;background:#eceef2;font:14px system-ui,sans-serif;color:#16181d}.row{display:flex;gap:20px;align-items:flex-start}` +
    `.col{width:360px}.label{margin-bottom:10px;line-height:1.4}.screen{box-shadow:0 1px 3px rgb(0 0 0/.12)}.facts{margin-top:8px;color:#5d6370;font-size:12px}` +
    `.sw{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle}</style></head><body><div class="row">${cols}</div></body></html>`
  );
}

/** "2", "2 — Calm…", or the label itself picks that one; anything else, or "Decide for me", picks the recommended one. */
export function parseDirectionChoice(answer: string | undefined, labels: string[], recommended: number): number {
  const a = (answer ?? "").trim();
  const n = /^\s*(\d)\b/.exec(a);
  if (n && Number(n[1]) >= 1 && Number(n[1]) <= labels.length) return Number(n[1]) - 1;
  const i = labels.findIndex((l) => l.toLowerCase() === a.toLowerCase());
  return i >= 0 ? i : recommended;
}

export interface DirectionContext {
  call: Call;
  models: string[];
  repoRoot: string;
  log: (line: string) => void;
  playbook: Playbook;
  stack: UiStack;
  platform: "web" | "native" | "both";
  product?: ProductRow;
  brand?: BrandFacts | null;
  /** The request, with anything the person said about the look. */
  userText: string;
}

/**
 * Proposes three directions, builds each into a real design system, draws them side by side (design-system/directions.png) and
 * asks which one. Null when fewer than two usable, different directions came back: the caller then makes the single recommended one.
 */
export async function chooseFromDirections(intake: VisualIntake, c: DirectionContext): Promise<{ direction: Direction; note: string } | null> {
  const name = path.basename(c.repoRoot);
  let text = "";
  try {
    text = await c.call(
      c.models,
      [
        { role: "system", content: directionSystem(c.playbook, c.stack, c.platform, c.product, c.brand) + DIRECTIONS_INSTRUCTION },
        { role: "user", content: `${c.userText.slice(0, 3600)}\n\nThe folder name is "${name}". Propose the three directions.` },
      ],
      "three design directions",
      true
    );
  } catch {
    return null;
  }
  const { raws, recommended } = parseDirections(text);
  const options: DirectionOption[] = [];
  let rec = 0;
  raws.forEach((raw: any, i: number) => {
    const d = parseDirection(JSON.stringify(raw), c.playbook, c.stack, name, c.product);
    if (!d || options.some((o) => tooAlike(o.direction, d))) return;
    if (i === recommended) rec = options.length;
    options.push({
      n: options.length + 1,
      direction: d,
      system: buildDesignSystem(d, c.platform, c.stack, c.brand),
      pitch: String(raw.pitch ?? d.memorableMove ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  });
  if (options.length < 2) {
    c.log("[DESIGN] The three directions did not come back distinct enough to choose between, so the recommended one is used.");
    return null;
  }
  fs.mkdirSync(path.join(c.repoRoot, "design-system"), { recursive: true });
  fs.writeFileSync(
    path.join(c.repoRoot, "design-system", "directions.json"),
    JSON.stringify({ directions: options.map((o) => ({ n: o.n, pitch: o.pitch, direction: o.direction })), recommended: rec + 1 }, null, 2)
  );
  const renderer = intake.openRenderer ? await intake.openRenderer().catch(() => null) : null;
  try {
    if (renderer) {
      const file = path.join(c.repoRoot, "design-system", "directions.png");
      fs.writeFileSync(file, await renderer.page(directionsSheetHtml(options), 48 + options.length * 360 + (options.length - 1) * 20, 760));
      intake.show?.("Three directions for the look", file);
    }
  } catch {
    // the choice can still be made from the descriptions
  } finally {
    await renderer?.close();
  }
  for (const o of options) c.log(`   ${o.n}. ${o.direction.name}: ${o.pitch} (${o.system.style.name}; ${o.system.pairing.heading} / ${o.system.pairing.body}; ${o.direction.signature})`);
  const labels = options.map((o) => `${o.n} — ${o.pitch || o.system.style.name}`.slice(0, 90));
  let pick = rec;
  if (intake.ask && !intake.autonomous) {
    const answer = await intake.ask(`Which look should the app have? (recommended: ${rec + 1})`, [...labels, DECIDE_LOOK], labels[rec]);
    pick = parseDirectionChoice(answer, labels, rec);
  }
  const chosen = options[pick];
  const others = options.filter((o) => o !== chosen).map((o) => `${o.n}. ${o.pitch || o.system.style.name}`);
  c.log(`[DESIGN] Using direction ${chosen.n}: ${chosen.pitch || chosen.system.style.name}`);
  return {
    direction: chosen.direction,
    note: `Chosen from three directions (design-system/directions.png): ${chosen.n}. ${chosen.pitch}${others.length ? ` Not chosen: ${others.join("; ")}.` : ""}`,
  };
}
