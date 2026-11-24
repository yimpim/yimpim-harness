/**
 * The polish pass: `/design polish ui [all | 1,3,5] [--include-conflicts]`, after `/design critique ui`. The critique's ranked
 * changes become an ordinary task (planned, built and checked like any other, so uiLint and QA apply), and once that task has
 * passed, the same screens are captured again, re-scored, and set side by side with the ones the critique looked at:
 * design-system/critique/POLISH.md and before-after.png.
 *
 * Only ever run because a person asked for it. A change that conflicts with one of the project's own design documents is left out
 * unless the person includes it on purpose (by number, or with --include-conflicts): the document wins by default.
 */
import fs from "node:fs";
import path from "node:path";
import { parseLenient } from "./jsonRepair.js";
import { CRITIQUE_DIR, captureAppScreens, devServer, browserOpener, describeCapture, type CaptureReport, type CapturedScreen, type ScreenCandidate } from "./uiCapture.js";
import { UI_DIMENSIONS, type UiCritique, type UiDimension } from "./uiCritique.js";
import { imageData, clip, type Call } from "./referenceRead.js";
import type { Renderer } from "./svgRender.js";

// ----------------------------------------------------------------------------------------------- choosing what to change

export interface PolishArgs {
  /** Change numbers as listed in CRITIQUE.md (1-based); empty for all. */
  pick: number[];
  includeConflicts: boolean;
}

export function isUiPolishRequest(afterDesign: string): { rest: string } | null {
  const m = /^\s*polish\s+(?:my\s+|the\s+)?(?:ui|app|screens?|interface)\b(.*)$/is.exec(afterDesign);
  return m ? { rest: m[1].trim() } : null;
}

/** "all", "1,3,5", "1 3 5", "--include-conflicts", in any order. */
export function parsePolishArgs(rest: string): PolishArgs {
  const includeConflicts = /--include-conflicts\b/i.test(rest);
  const pick = [...new Set((rest.replace(/--include-conflicts\b/gi, "").match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))];
  return { pick, includeConflicts };
}

export interface LastCritique {
  critique: UiCritique;
  /** The screens it looked at, as captured (provided screenshots have no route and are not captured again). */
  capture: CaptureReport;
}

export function loadLastCritique(repoRoot: string): LastCritique | null {
  try {
    const critique = JSON.parse(fs.readFileSync(path.join(repoRoot, CRITIQUE_DIR, "critique.json"), "utf8")).critique as UiCritique;
    const capture = JSON.parse(fs.readFileSync(path.join(repoRoot, CRITIQUE_DIR, "before", "capture.json"), "utf8")) as CaptureReport;
    if (!critique || !Array.isArray(critique.changes) || !capture || !Array.isArray(capture.screens)) return null;
    return { critique, capture };
  } catch {
    return null;
  }
}

export interface Chosen {
  /** 1-based, as listed in CRITIQUE.md. */
  n: number;
  change: UiCritique["changes"][number];
}

/** The changes to make, and the ones left out with why. Picked by number, a conflict is included: the person chose it. */
export function chooseChanges(c: UiCritique, a: PolishArgs): { chosen: Chosen[]; left: { n: number; why: string }[] } {
  const all = c.changes.map((change, i) => ({ n: i + 1, change }));
  const chosen: Chosen[] = [];
  const left: { n: number; why: string }[] = [];
  for (const n of a.pick) if (n > all.length) left.push({ n, why: `there is no change ${n}` });
  for (const x of all) {
    if (a.pick.length > 0 && !a.pick.includes(x.n)) continue;
    if (x.change.conflicts && !a.includeConflicts && a.pick.length === 0) {
      left.push({ n: x.n, why: `it conflicts with ${x.change.conflicts} (pick it by number, or add --include-conflicts, to make it anyway)` });
      continue;
    }
    chosen.push(x);
  }
  return { chosen, left };
}

/** The task the normal pipeline runs: what to change and why, and what must not change. */
export function polishTask(c: UiCritique, chosen: Chosen[]): string {
  const lines = [
    "Polish the app's UI, following design-system/CRITIQUE.md. Make exactly these changes, and nothing beyond them:",
    ...chosen.map(
      (x) =>
        `${x.n}. ${x.change.change.replace(/[.…]+$/, "")}.${x.change.screens.length ? ` Screens: ${x.change.screens.join(", ")}.` : ""} Why: ${x.change.why}` +
        (x.change.conflicts ? ` This one conflicts with ${x.change.conflicts}: update that document to match, in the same change.` : "")
    ),
  ];
  if (c.tokens.length) {
    lines.push(
      "",
      "Token changes (change the token's value where the project defines it; never hard-code the new value in a component):",
      ...c.tokens.map((t) => `- ${t.token}: ${t.now} -> ${t.proposed}. ${t.why}`)
    );
  }
  lines.push(
    "",
    "Change how the app looks and is laid out only: keep its behaviour, its navigation, what its text means, and its tests passing. " +
      "Follow the project's own design documents and its theme. Every screen named above must still render."
  );
  return lines.join("\n");
}

// ----------------------------------------------------------------------------------------------- after the task: look again

export interface PolishScore {
  scores: Partial<Record<UiDimension, number>>;
  total: number;
  outOf: number;
  /** For each change made: done, partly or not, with what the after screens show. */
  verdicts: { n: number; verdict: "done" | "partly" | "not"; note: string }[];
}

export function parsePolishScore(text: string, chosen: Chosen[]): PolishScore | null {
  const j = parseLenient(text)?.value;
  if (!j || typeof j !== "object") return null;
  const scores: Partial<Record<UiDimension, number>> = {};
  for (const d of UI_DIMENSIONS) {
    const n = Number(j.scores?.[d]);
    if (Number.isFinite(n) && n > 0) scores[d] = Math.min(5, Math.max(1, Math.round(n)));
  }
  const counted = Object.keys(scores).length;
  if (counted < 5) return null;
  const known = new Set(chosen.map((c) => c.n));
  const verdicts = (Array.isArray(j.verdicts) ? j.verdicts : [])
    .map((v: any) => ({ n: Number(v?.n), verdict: (["done", "partly", "not"].includes(v?.verdict) ? v.verdict : "partly") as "done" | "partly" | "not", note: clip(v?.note, 300) }))
    .filter((v: { n: number }) => known.has(v.n));
  return { scores, total: Object.values(scores).reduce((a, b) => a + (b ?? 0), 0), outOf: counted * 5, verdicts };
}

/** Before and after, paired by screen and size: only screens captured both times. */
export function pairScreens(before: CapturedScreen[], after: CapturedScreen[]): { name: string; viewport: string; before: string; after: string }[] {
  const out: { name: string; viewport: string; before: string; after: string }[] = [];
  for (const b of before) {
    if (b.viewport === "provided") continue;
    const a = after.find((x) => x.name === b.name && x.viewport === b.viewport);
    if (a) out.push({ name: b.name, viewport: b.viewport, before: b.file, after: a.file });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One page: each screen's before and after side by side, for a person to look at (rendered to before-after.png). */
export function beforeAfterHtml(pairs: { name: string; viewport: string; before: string; after: string }[], src: (file: string) => string | null): string {
  const rows = pairs
    .map((p) => {
      const b = src(p.before);
      const a = src(p.after);
      if (!b || !a) return "";
      return `<tr><th colspan="2">${esc(p.name)} <span>${esc(p.viewport)}</span></th></tr><tr><td><img src="${b}"><div>before</div></td><td><img src="${a}"><div>after</div></td></tr>`;
    })
    .join("");
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f3f7;font:14px system-ui,sans-serif;color:#16181d">` +
    `<style>table{border-spacing:16px 8px}th{text-align:left;font-size:16px;padding-top:16px}th span{color:#5d6370;font-weight:400}` +
    `td{vertical-align:top;background:#fff;border:1px solid #e3e5ec;border-radius:10px;padding:10px}img{display:block;width:380px;height:auto}` +
    `td div{color:#5d6370;margin-top:6px}</style><table>${rows}</table></body></html>`
  );
}

export function renderPolish(o: {
  critique: UiCritique;
  chosen: Chosen[];
  left: { n: number; why: string }[];
  after: PolishScore | null;
  pairs: number;
  capture: CaptureReport;
  sheet: string | null;
}): string {
  const b = o.critique;
  const rows = UI_DIMENSIONS.filter((d) => b.scores[d] !== undefined || o.after?.scores[d] !== undefined).map((d) => {
    const x = b.scores[d];
    const y = o.after?.scores[d];
    const delta = x !== undefined && y !== undefined ? (y > x ? ` (+${y - x})` : y < x ? ` (${y - x})` : "") : "";
    return `| ${d} | ${x ?? "?"} | ${y ?? "?"}${delta} |`;
  });
  const verdictOf = (n: number) => o.after?.verdicts.find((v) => v.n === n);
  const blocks = [
    "# UI polish",
    o.sheet ? `Before and after, side by side: [before-after.png](${o.sheet})` : "No side-by-side picture could be made (no browser, or no screen captured both times).",
    `## Score\n\n| Dimension | Before | After |\n|---|---|---|\n${rows.join("\n")}\n| **total** | **${b.total} of ${b.outOf}** | **${o.after ? `${o.after.total} of ${o.after.outOf}` : "not re-scored"}** |`,
    `## Changes made\n${o.chosen
      .map((c) => {
        const v = verdictOf(c.n);
        return `${c.n}. ${c.change.change}${v ? `  \n   ${v.verdict === "done" ? "✅ done" : v.verdict === "partly" ? "◐ partly" : "✗ not visible"}${v.note ? `: ${v.note}` : ""}` : ""}`;
      })
      .join("\n")}`,
    o.left.length ? `## Left out\n${o.left.map((l) => `- ${l.n}: ${l.why}`).join("\n")}` : "",
    o.capture.skipped.length ? `Not captured after: ${o.capture.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.` : "",
  ];
  return blocks.filter(Boolean).join("\n\n") + "\n";
}

export interface PolishAfterDeps {
  repoRoot: string;
  call: Call;
  visionModels: string[];
  log: (line: string) => void;
  /** Injected for tests; the real ones start the dev server and a browser. */
  capture?: (routes: ScreenCandidate[]) => Promise<CaptureReport>;
  renderer?: Renderer | null;
}

/** The screens a critique captured, as routes to capture again. */
export function routesOf(capture: CaptureReport): ScreenCandidate[] {
  const seen = new Set<string>();
  const out: ScreenCandidate[] = [];
  for (const s of capture.screens) {
    if (s.viewport === "provided" || !s.route || seen.has(s.route)) continue;
    seen.add(s.route);
    out.push({ route: s.route, name: s.name, from: s.from });
  }
  return out;
}

const SCORE_SYSTEM =
  "You are re-scoring an app's UI after a polish pass. Score each dimension 1 to 5 exactly as a design critique would (3 acceptable, " +
  "4 good, 5 rare), from the AFTER screenshots only. Then, for each change that was asked for, say whether the after screens show it " +
  'done, partly, or not, and what you see. Respond ONLY with JSON: {"scores": {' +
  UI_DIMENSIONS.map((d) => `"${d}": 1-5`).join(", ") +
  '}, "verdicts": [{"n": change number, "verdict": "done"|"partly"|"not", "note": string}]}';

export async function polishAfter(last: LastCritique, chosen: Chosen[], left: { n: number; why: string }[], deps: PolishAfterDeps): Promise<{ ok: boolean; text: string }> {
  const { repoRoot, log } = deps;
  log("🎨 [POLISH] The polish task passed. Capturing the same screens again to compare.");
  const routes = routesOf(last.capture);
  const capture = deps.capture
    ? await deps.capture(routes)
    : await (async () => {
        const browser = await browserOpener(repoRoot);
        try {
          return await captureAppScreens({ repoRoot, server: devServer, open: browser?.open ?? null, stage: "after", routes });
        } finally {
          await browser?.close();
        }
      })();
  for (const l of describeCapture(capture)) log(l.replace("[CRITIQUE]", "[POLISH]"));

  // Re-score from the after screens.
  let after: PolishScore | null = null;
  const images = capture.screens.map((s) => ({ s, url: imageData(repoRoot, s.file) })).filter((x): x is { s: CapturedScreen; url: string } => !!x.url).slice(0, 8);
  if (images.length > 0) {
    try {
      const text = await deps.call(
        deps.visionModels,
        [
          { role: "system", content: SCORE_SYSTEM },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `After screens, in order: ${images.map((x, i) => `${i + 1}. ${x.s.name} (${x.s.viewport})`).join("; ")}.\n` +
                  `Changes asked for:\n${chosen.map((c) => `${c.n}. ${c.change.change}`).join("\n")}` +
                  (capture.setupNotes ? `\nSetup notes (test scaffolding, not product):\n${capture.setupNotes}` : ""),
              },
              ...images.map((x) => ({ type: "image_url", image_url: { url: x.url } })),
            ],
          },
        ],
        "UI polish re-score",
        true
      );
      after = parsePolishScore(text, chosen);
      if (!after) log("[POLISH] The re-score reply was not usable; the comparison is written without it.");
    } catch (err: any) {
      log(`[POLISH] The re-score could not be made (${String(err?.message ?? err).split("\n")[0]}); the comparison is written without it.`);
    }
  }

  // The side-by-side picture.
  const dir = path.join(repoRoot, CRITIQUE_DIR);
  const pairs = pairScreens(last.capture.screens, capture.screens);
  let sheet: string | null = null;
  if (pairs.length > 0 && deps.renderer) {
    try {
      const png = await deps.renderer.page(beforeAfterHtml(pairs, (f) => imageData(repoRoot, f)), 860, 600);
      fs.writeFileSync(path.join(dir, "before-after.png"), png);
      sheet = "before-after.png";
    } catch {
      // the report still says what changed
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "POLISH.md"), renderPolish({ critique: last.critique, chosen, left, after, pairs: pairs.length, capture, sheet }));
  const delta = after ? after.total - Math.round((last.critique.total * after.outOf) / Math.max(1, last.critique.outOf)) : null;
  return {
    ok: true,
    text:
      `Polish compared in design-system/critique/POLISH.md` +
      (after ? `: ${last.critique.total} of ${last.critique.outOf} before, ${after.total} of ${after.outOf} after${delta !== null && delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}` : "") +
      (sheet ? `; side by side in design-system/critique/before-after.png` : "") +
      ".",
  };
}
