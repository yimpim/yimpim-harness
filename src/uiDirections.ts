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
