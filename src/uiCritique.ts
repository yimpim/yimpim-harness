/**
 * The UI critique: `/design critique ui [references…] [--screens <images…>]`. Looks at an existing app's screens, next to the
 * references the person likes, and writes design-system/CRITIQUE.md: a scorecard, what works, the slop it shows, findings per
 * screen, token changes and ranked component changes. Nothing in the app is changed; a later "polish" step acts on it.
 *
 * Only ever run because a person asked for it: it starts the app's dev server, a browser and vision-model calls. The modules it
 * uses (capture, references, the reference read) may be imported only from here, and this module only by the explicit command.
 *
 * Generic across stacks. Besides the screens it reads, from the project itself:
 *   - its theme: design-system/MASTER.md and token files, Tailwind config, CSS variables, theme/colour/typography modules
 *   - its constraints: design, style, brand, UI, parity and visual spec documents. These are binding: a change that would break
 *     one is marked with the document it conflicts with, so a project that must match another platform is critiqued within that.
 * Models judge; code bounds the reply and works out the totals.
 */
import fs from "node:fs";
import path from "node:path";
import { parseLenient } from "./jsonRepair.js";
import { SLOP_SIGNS, coreRulesBlock } from "./uiKnowledge.js";
import { captureAppScreens, devServer, browserOpener, describeCapture, CRITIQUE_DIR, type CaptureReport, type CapturedScreen } from "./uiCapture.js";
import { gatherReferences, referenceBrowser, describeReferences, type Reference } from "./uiReference.js";
import { readReferences, renderReads, writeReads, imageData, clip, type ReferenceRead, type Call } from "./referenceRead.js";
import { lazyIgnore, NATIVE_TREES } from "./projectPaths.js";

export const UI_DIMENSIONS = ["hierarchy", "spacing", "density", "surfaces", "typography", "colour", "consistency", "states", "accessibility", "originality"] as const;
export type UiDimension = (typeof UI_DIMENSIONS)[number];
export const IMPACTS = ["high", "medium", "low"] as const;
/** Screens sent to the judge at most (each a phone or desktop image). */
const MAX_JUDGE_IMAGES = 8;

// ----------------------------------------------------------------------------------------------- the command line

export interface CritiqueArgs {
  /** Inspiration: image paths, URLs, product names. */
  references: string[];
  /** The person's own screenshots of the app (after --screens). */
  screens: string[];
}

/** `/design critique ui <references…> --screens <images…>`: quoted names with spaces are one argument. */
export function parseCritiqueArgs(rest: string): CritiqueArgs {
  const args: string[] = [];
  for (const m of rest.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) args.push(m[1] ?? m[2] ?? m[3]);
  const out: CritiqueArgs = { references: [], screens: [] };
  let into: "references" | "screens" = "references";
  for (const a of args) {
    if (a === "--screens" || a === "--screen") into = "screens";
    else if (a === "--refs" || a === "--references" || a === "--like") into = "references";
    else out[into].push(a);
  }
  return out;
}

/** True for the explicit command only: `critique ui`, `critique app`, `critique screens` after /design. A logo critique is not this. */
export function isUiCritiqueRequest(afterDesign: string): { rest: string } | null {
  const m = /^\s*(?:critique|review|audit)\s+(?:my\s+|the\s+)?(?:ui|app|screens?|interface)\b(.*)$/is.exec(afterDesign);
  return m ? { rest: m[1].trim() } : null;
}

// ----------------------------------------------------------------------------------------------- what the project says about itself

const SKIP = lazyIgnore(NATIVE_TREES);
const THEME_FILE = /(^|\/)(tokens?|theme|themes|colou?rs?|palette|typography|spacing|design-tokens|variables|globals)\.(ts|tsx|js|mjs|cjs|json|css|scss)$|(^|\/)tailwind\.config\.(js|ts|cjs|mjs)$|(^|\/)design-system\/(MASTER\.md|design\.json|tokens\.(css|ts))$/i;
/** Words in a document's name that make it a design rule. Whole words only: "HISTORY_GUIDE.md" holds "ui" but is not about UI. */
const CONSTRAINT_WORDS = new Set(["parity", "design", "style", "styles", "styleguide", "brand", "branding", "ui", "ux", "visual", "visuals", "guidelines", "look", "theme", "typography"]);
/** A Markdown file whose name, split into words (separators and camelCase), contains one of those words. */
export function isConstraintDoc(name: string): boolean {
  if (!/\.md$/i.test(name)) return false;
  const words = name
    .replace(/\.md$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((w) => CONSTRAINT_WORDS.has(w));
}
const OWN_OUTPUT = /(^|\/)design-system\/(CRITIQUE\.md|critique\/)/i;

function walk(repoRoot: string, dir: string, maxDepth: number, test: (rel: string) => boolean, limit: number): string[] {
  const out: string[] = [];
  const go = (rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP.has(e.name)) go(r, depth + 1);
      } else if (e.isFile() && test(r) && !OWN_OUTPUT.test(r)) out.push(r);
    }
  };
  go(dir, 0);
  return out;
}

export interface ProjectFile {
  rel: string;
  text: string;
}

const read = (repoRoot: string, rel: string, max: number): string => {
  try {
    const t = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    return t.length > max ? t.slice(0, max) + "\n… (cut)" : t;
  } catch {
    return "";
  }
};

/** The project's own theme: token files, Tailwind config, CSS variables, theme modules. At most 6 files, each cut to 6 KB. */
export function discoverTheme(repoRoot: string): ProjectFile[] {
  const found = new Set<string>();
  for (const dir of ["design-system", "src", "app", "styles", "theme", "lib", ""]) {
    for (const rel of walk(repoRoot, dir, dir ? 4 : 0, (r) => THEME_FILE.test(r), 12)) found.add(rel);
  }
  // A plain stylesheet that defines CSS variables on :root is a theme too.
  if (found.size === 0) {
    for (const rel of walk(repoRoot, "", 3, (r) => /\.(css|scss)$/i.test(r), 20)) {
      if (/:root\s*\{[^}]*--[\w-]+\s*:/.test(read(repoRoot, rel, 20000))) found.add(rel);
    }
  }
  const order = (r: string) => (/design-system\/MASTER\.md$/i.test(r) ? 0 : /tokens?\./i.test(r) ? 1 : /tailwind/i.test(r) ? 2 : 3);
  return [...found]
    .sort((a, b) => order(a) - order(b) || a.length - b.length)
    .slice(0, 6)
    .map((rel) => ({ rel, text: read(repoRoot, rel, 6000) }))
    .filter((f) => f.text.trim());
}

/** The project's own design rules: design, style, brand, UI, parity and visual spec documents. At most 4, each cut to 2.5 KB. */
export function discoverConstraints(repoRoot: string): ProjectFile[] {
  const found = new Set<string>();
  for (const dir of ["", "docs", "doc", "reference", "references", "spec", "specs", "design", "design-system"]) {
    for (const rel of walk(repoRoot, dir, dir ? 3 : 0, (r) => isConstraintDoc(path.basename(r)), 12)) found.add(rel);
  }
  const order = (r: string) => (/parity|guideline|brand/i.test(r) ? 0 : /design-system\/MASTER/i.test(r) ? 1 : 2);
  return [...found]
    .sort((a, b) => order(a) - order(b) || a.length - b.length)
    .slice(0, 4)
    .map((rel) => ({ rel, text: read(repoRoot, rel, 2500) }))
    .filter((f) => f.text.trim());
}

// ----------------------------------------------------------------------------------------------- the judge

export interface UiCritique {
  firstImpression: string;
  works: string[];
  scores: Partial<Record<UiDimension, number>>;
  /** Which slop signs it shows, and where. */
  slop: { sign: string; where: string }[];
  screens: { screen: string; findings: string[] }[];
  tokens: { token: string; now: string; proposed: string; why: string }[];
  /** Ranked, most impact first. `conflicts` names the project document a change would break, when it would. */
  changes: { change: string; why: string; screens: string[]; impact: (typeof IMPACTS)[number]; conflicts: string | null }[];
  /** Where the app falls short of the references, when there were any. */
  referenceGaps: string[];
  /** Worked out here, never taken from the model. */
  total: number;
  outOf: number;
}

export const UI_CRITIQUE_METHOD =
  "Critique the design as a senior product designer would, from what the screenshots show. First impression in two seconds, said " +
  "honestly. Then score each dimension 1 to 5 (3 acceptable, 4 good, 5 rare): hierarchy (what is seen first, and is it the right " +
  "thing), spacing (a consistent scale and rhythm), density (right for the job), surfaces (backgrounds, cards, borders, depth), " +
  "typography (faces, sizes, weights, levels), colour (restraint, contrast, meaning), consistency (one system across screens), " +
  "states (empty, loading, error and pressed states that look designed), accessibility (contrast, target size, labels), originality " +
  "(free of the generic AI look). Name each slop sign you see and where. Findings per screen must be concrete and visible (an element, " +
  "a size, a spacing, a colour), never generic advice. Token changes adjust the project's own tokens (name the token, its value now, " +
  "the value proposed). Changes are ranked by impact on how the product looks and works, each small enough to do in one step.";

function system(hasReferences: boolean, hasConstraints: boolean): string {
  return (
    `${UI_CRITIQUE_METHOD}\n` +
    `Slop signs to check for: ${SLOP_SIGNS.join("; ")}.\n` +
    (hasReferences ? "The person's references are described below: say where the app falls short of what they like, as principles, never by copying a reference.\n" : "") +
    (hasConstraints
      ? "The project's own design documents are given below and are binding. A change that would break one stays in the list but names that document in \"conflicts\"; never recommend breaking one silently.\n"
      : "") +
    "Parts of a screen the setup notes call test scaffolding (fixture buttons, simulated connections) are not the product: ignore them.\n" +
    'Respond ONLY with JSON: {"firstImpression": "two sentences", "works": [up to 3], ' +
    `"scores": {${UI_DIMENSIONS.map((d) => `"${d}": 1-5`).join(", ")}}, ` +
    '"slop": [{"sign": string, "where": string}], "screens": [{"screen": name as given, "findings": [up to 4]}], ' +
    '"tokens": [{"token": string, "now": string, "proposed": string, "why": string}] (up to 8), ' +
    '"changes": [{"change": string, "why": string, "screens": [names], "impact": "high"|"medium"|"low", "conflicts": document path or null}] (up to 8, most important first), ' +
    '"referenceGaps": [up to 4]}'
  );
}

const strs = (v: unknown, max: number, len = 360): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, max);

export function parseUiCritique(text: string, knownScreens: string[], knownDocs: string[]): UiCritique | null {
  const j = parseLenient(text)?.value;
  if (!j || typeof j !== "object") return null;
  const scores: Partial<Record<UiDimension, number>> = {};
  for (const d of UI_DIMENSIONS) {
    const n = Number(j.scores?.[d]);
    if (Number.isFinite(n) && n > 0) scores[d] = Math.min(5, Math.max(1, Math.round(n)));
  }
  const counted = Object.keys(scores).length;
  if (counted < 5) return null; // not a real scorecard
  const known = (s: unknown) => {
    const name = clip(s, 80);
    return knownScreens.find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  };
  const doc = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || /^(null|none|no|n\/a)$/i.test(v.trim())) return null;
    const hit = knownDocs.find((d) => v.includes(d) || d.endsWith(v.trim()) || path.basename(d) === path.basename(v.trim()));
    return hit ?? clip(v, 120);
  };
  const rank = (i: unknown) => (IMPACTS.includes(i as any) ? (i as (typeof IMPACTS)[number]) : "medium");
  const changes = (Array.isArray(j.changes) ? j.changes : [])
    .map((c: any) => ({
      change: clip(c?.change, 420),
      why: clip(c?.why, 360),
      screens: (Array.isArray(c?.screens) ? c.screens : []).map(known).filter(Boolean).slice(0, 6),
      impact: rank(c?.impact),
      conflicts: doc(c?.conflicts),
    }))
    .filter((c: { change: string }) => c.change)
    .slice(0, 8);
  // Most impact first; the model's own order breaks ties.
  changes.sort((a: any, b: any) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact));
  return {
    firstImpression: clip(j.firstImpression, 400),
    works: strs(j.works, 3),
    scores,
    slop: (Array.isArray(j.slop) ? j.slop : []).map((s: any) => ({ sign: clip(s?.sign, 160), where: clip(s?.where, 300) })).filter((s: any) => s.sign).slice(0, 8),
    screens: (Array.isArray(j.screens) ? j.screens : [])
      .map((s: any) => ({ screen: known(s?.screen), findings: strs(s?.findings, 4) }))
      .filter((s: any) => s.screen && s.findings.length > 0)
      .slice(0, 12),
    tokens: (Array.isArray(j.tokens) ? j.tokens : [])
      .map((t: any) => ({ token: clip(t?.token, 80), now: clip(t?.now, 120), proposed: clip(t?.proposed, 160), why: clip(t?.why, 260) }))
      .filter((t: any) => t.token && t.proposed)
      .slice(0, 8),
    changes,
    referenceGaps: strs(j.referenceGaps, 4),
    total: Object.values(scores).reduce((a, b) => a + (b ?? 0), 0),
    outOf: counted * 5,
  };
}

// ----------------------------------------------------------------------------------------------- the report

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderUiCritique(
  c: UiCritique,
  o: { screens: CapturedScreen[]; reads: ReferenceRead[]; constraints: string[]; theme: string[]; capture: CaptureReport }
): string {
  const rel = (f: string) => path.posix.relative("design-system", f.replace(/\\/g, "/"));
  // Blocks, joined by a blank line; an optional block that is empty is left out without collapsing the spacing around it.
  const context = [
    `Screens looked at: ${o.screens.map((s) => `[${s.name}${s.viewport === "provided" ? "" : ` (${s.viewport})`}](${rel(s.file)})`).join(", ") || "none"}.`,
    o.capture.skipped.length ? `Not looked at: ${o.capture.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.` : "",
    o.reads.length ? `Compared with: ${o.reads.map((r) => `${r.label}${r.source === "recalled" ? " (recalled, not seen)" : ""}`).join(", ")}.` : "",
    o.constraints.length ? `Held to the project's own documents: ${o.constraints.map((d) => `\`${d}\``).join(", ")}.` : "",
    o.theme.length ? `Theme read from: ${o.theme.map((d) => `\`${d}\``).join(", ")}.` : "No theme or token files were found.",
  ]
    .filter(Boolean)
    .join("  \n");
  const blocks = [
    "# UI critique",
    `**First impression.** ${c.firstImpression || "(none given)"}`,
    context,
    c.works.length ? `## What works\n${c.works.map((w) => `- ${w}`).join("\n")}\n` : "",
    `## Scorecard (${c.total} of ${c.outOf})\n\n1 to 5, where 3 is acceptable. A rough guide, not a grade.\n\n| Dimension | Score |\n|---|---|\n` +
      UI_DIMENSIONS.filter((d) => c.scores[d] !== undefined).map((d) => `| ${d} | ${c.scores[d]} |`).join("\n") +
      "\n",
    c.slop.length ? `## AI-slop signs\n${c.slop.map((s) => `- **${s.sign}**: ${s.where}`).join("\n")}\n` : "## AI-slop signs\nNone seen.\n",
    c.changes.length
      ? `## Changes, most impact first\n${c.changes
          .map((x, i) => `${i + 1}. **${x.change}** (${x.impact}${x.screens.length ? `; ${x.screens.join(", ")}` : ""})  \n   ${x.why}${x.conflicts ? `  \n   ⚠️ Conflicts with \`${x.conflicts}\`: do it only if that document changes too.` : ""}`)
          .join("\n")}\n`
      : "",
    c.tokens.length ? `## Token changes\n\n| Token | Now | Proposed | Why |\n|---|---|---|---|\n${c.tokens.map((t) => `| \`${cell(t.token)}\` | ${cell(t.now)} | ${cell(t.proposed)} | ${cell(t.why)} |`).join("\n")}\n` : "",
    c.screens.length ? `## Per screen\n${c.screens.map((s) => `### ${s.screen}\n${s.findings.map((f) => `- ${f}`).join("\n")}`).join("\n\n")}\n` : "",
    c.referenceGaps.length ? `## Against your references\n${c.referenceGaps.map((g) => `- ${g}`).join("\n")}\n` : "",
    "Nothing in the app was changed.",
  ];
  return blocks.map((b) => b.trim()).filter(Boolean).join("\n\n") + "\n";
}

// ----------------------------------------------------------------------------------------------- the whole step

export interface CritiqueDeps {
  repoRoot: string;
  call: Call;
  /** Vision models (Designer Judge (Vision)). */
  visionModels: string[];
  log: (line: string) => void;
  /** Injected for tests; the real ones start the dev server, a browser and fetch pages. */
  capture?: (provided: string[]) => Promise<CaptureReport>;
  references?: (inputs: string[], outDir: string) => Promise<Reference[]>;
}

export interface CritiqueResult {
  ok: boolean;
  text: string;
  file?: string;
}

const realCapture = (repoRoot: string) => async (provided: string[]) => {
  const browser = await browserOpener(repoRoot);
  try {
    return await captureAppScreens({ repoRoot, provided, server: devServer, open: browser?.open ?? null });
  } finally {
    await browser?.close();
  }
};

const realReferences = (repoRoot: string) => async (inputs: string[], outDir: string) => {
  if (inputs.length === 0) return [];
  const browser = inputs.some((i) => !fs.existsSync(path.resolve(repoRoot, i))) ? await referenceBrowser() : null;
  try {
    return await gatherReferences(inputs, { repoRoot, outDir, browser });
  } finally {
    await browser?.close();
  }
};

export async function runUiCritique(args: CritiqueArgs, deps: CritiqueDeps): Promise<CritiqueResult> {
  const { repoRoot, log } = deps;
  const dir = path.join(repoRoot, CRITIQUE_DIR);
  log("🎨 [CRITIQUE] Looking at the app's screens. This starts its dev server and a browser, and uses a few vision-model calls.");

  // 1. The screens.
  const capture = await (deps.capture ?? realCapture(repoRoot))(args.screens);
  for (const l of describeCapture(capture)) log(l);
  const screens = capture.screens;
  if (screens.length === 0) {
    return { ok: false, text: "No screen could be looked at, so there is nothing to critique. Send screenshots: /design critique ui --screens <image paths>." };
  }

  // 2. The references, and what they look like.
  let reads: ReferenceRead[] = [];
  if (args.references.length > 0) {
    const refDir = path.join(dir, "references");
    const refs = await (deps.references ?? realReferences(repoRoot))(args.references, refDir);
    for (const l of describeReferences(refs)) log(l);
    reads = await readReferences(refs, { repoRoot, call: deps.call, models: deps.visionModels, log });
    if (reads.length > 0) writeReads(refDir, reads);
  }

  // 3. What the project says about itself.
  const theme = discoverTheme(repoRoot);
  const constraints = discoverConstraints(repoRoot);

  // 4. The judge: images first (desktop before phone, captured before provided), then everything it is held to.
  const order = (s: CapturedScreen) => (s.viewport === "desktop" ? 0 : s.viewport === "phone" ? 1 : 2);
  const sent = [...screens].sort((a, b) => order(a) - order(b)).slice(0, MAX_JUDGE_IMAGES);
  const images = sent.map((s) => ({ s, url: imageData(repoRoot, s.file) })).filter((x): x is { s: CapturedScreen; url: string } => !!x.url);
  if (images.length === 0) return { ok: false, text: "The screenshots could not be read, so there is nothing to critique." };
  const intro = [
    `Screens, in the order of the images: ${images.map((x, i) => `${i + 1}. ${x.s.name} (${x.s.viewport})`).join("; ")}.`,
    capture.setupNotes ? `Setup notes (what is test scaffolding, not product):\n${capture.setupNotes}` : "",
    reads.length ? `The person's references:\n${renderReads(reads)}` : "",
    constraints.length ? `The project's own design documents (binding):\n${constraints.map((f) => `--- ${f.rel}\n${f.text}`).join("\n")}` : "",
    theme.length ? `The project's theme and tokens:\n${theme.map((f) => `--- ${f.rel}\n${f.text}`).join("\n")}` : "No theme or token files were found.",
    coreRulesBlock(),
  ]
    .filter(Boolean)
    .join("\n\n");
  let text: string;
  try {
    text = await deps.call(
      deps.visionModels,
      [
        { role: "system", content: system(reads.length > 0, constraints.length > 0) },
        { role: "user", content: [{ type: "text", text: intro }, ...images.map((x) => ({ type: "image_url", image_url: { url: x.url } }))] },
      ],
      "UI critique",
      true
    );
  } catch (err: any) {
    return { ok: false, text: `The critique could not be made: ${String(err?.message ?? err).split("\n")[0]}` };
  }
  const critique = parseUiCritique(text, [...new Set(screens.map((s) => s.name))], constraints.map((c) => c.rel));
  if (!critique) return { ok: false, text: "The model's reply was not a usable critique. Try again, or set a stronger vision model for Designer Judge (Vision) in /model." };

  // 5. The report.
  fs.mkdirSync(path.join(repoRoot, "design-system"), { recursive: true });
  const file = path.join(repoRoot, "design-system", "CRITIQUE.md");
  fs.writeFileSync(file, renderUiCritique(critique, { screens: images.map((x) => x.s), reads, constraints: constraints.map((c) => c.rel), theme: theme.map((t) => t.rel), capture }));
  fs.writeFileSync(path.join(dir, "critique.json"), JSON.stringify({ critique, at: new Date().toISOString() }, null, 2));
  const top = critique.changes[0];
  return {
    ok: true,
    file,
    text:
      `Critique written to design-system/CRITIQUE.md: ${critique.total} of ${critique.outOf}, ${critique.slop.length} slop sign(s), ${critique.changes.length} change(s)` +
      (top ? `; the first: ${top.change.replace(/[.…]+$/, "")}` : "") +
      ". Nothing in the app was changed.",
  };
}
