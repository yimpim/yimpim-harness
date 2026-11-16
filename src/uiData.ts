/**
 * The reference tables behind the design step, loaded from assets/ui/*.json (condensed from the MIT-licensed
 * ui-ux-pro-max-skill data; see assets/ui/NOTICE.md). Nothing here runs a search: a model chooses an id from a
 * menu, and code looks up the row. A missing or damaged file means that table is empty, never a crash.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAIRINGS, type Pairing } from "./uiKnowledge.js";

const UI_DIR = fileURLToPath(new URL("../assets/ui/", import.meta.url));

const cache = new Map<string, unknown>();
function load<T>(name: string, dir: string = UI_DIR): T[] {
  const key = dir + name;
  if (cache.has(key)) return cache.get(key) as T[];
  let data: T[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
    if (Array.isArray(raw)) data = raw;
  } catch {
    data = [];
  }
  cache.set(key, data);
  return data;
}

export interface ProductRow {
  id: string;
  name: string;
  pattern: string;
  style: string;
  colour: string;
  type: string;
  fx: string;
  anti: string;
  must: string[];
  /** condition (words) -> actions (words) */
  when: Record<string, string[]>;
  palette: { primary: string; secondary: string; accent: string; background: string; foreground: string; note: string };
}
export interface LandingRow { id: string; name: string; keywords: string; sections: string; cta: string; colour: string; fx: string; convert: string }
export interface ChartRow { data: string; best: string; alt: string; use: string; not: string; volume: string; colour: string; a11y: string; fallback: string; lib: string }
export interface NativeRule { cat: string; issue: string; platform: string; do: string; not: string; good: string; bad: string; sev: string }
export interface StyleDetail { id: string; name: string; keywords: string; colours: string; fx: string; best: string; avoid: string; a11y: string; css: string; checklist: string[]; vars: string }
export interface TypeRow { id: string; name: string; cat: string; heading: string; body: string; mood: string; best: string; wh: string; wb: string }
export interface StackNote { cat: string; rule: string; do: string; not: string; sev: string }

export const products = (): ProductRow[] => load<ProductRow>("products.json");
export const landingPatterns = (): LandingRow[] => load<LandingRow>("landing.json");
export const chartRows = (): ChartRow[] => load<ChartRow>("charts.json");
export const nativeRules = (): NativeRule[] => load<NativeRule>("native-rules.json");
export const styleDetails = (): StyleDetail[] => load<StyleDetail>("styles.json");

export const findProduct = (id: unknown) => products().find((p) => p.id === id);
export const findLanding = (id: unknown) => landingPatterns().find((p) => p.id === id);
export const styleDetail = (id: string | undefined) => (id ? styleDetails().find((s) => s.id === id) : undefined);

/** "id: Name" lines for a menu a model picks from. */
export const productMenu = () => products().map((p) => `${p.id}: ${p.name}`).join("\n");
export const landingMenu = () => landingPatterns().map((p) => `${p.id}: ${p.name} — ${p.sections.slice(0, 110)}`).join("\n");

// ---------------------------------------------------------------------------
// type pairings: ours first, then the reference ones that add something (other scripts, other moods)
// ---------------------------------------------------------------------------

let pairingCache: Pairing[] | null = null;

/** Ours plus the extra reference pairings, without duplicates (same two fonts). */
export function allPairings(): Pairing[] {
  if (pairingCache) return pairingCache;
  const seen = new Set(PAIRINGS.map((p) => `${p.heading}|${p.body}`.toLowerCase()));
  const out: Pairing[] = [...PAIRINGS];
  for (const t of load<TypeRow>("typography.json")) {
    const key = `${t.heading}|${t.body}`.toLowerCase();
    if (seen.has(key) || out.some((p) => p.id === t.id)) continue;
    seen.add(key);
    out.push({ id: t.id, heading: t.heading, body: t.body, mood: `${t.mood.split(",").slice(0, 4).join(",").trim()}${t.best ? `; for ${t.best.split(",").slice(0, 3).join(",").trim()}` : ""}`, weights: { heading: t.wh, body: t.wb } });
  }
  pairingCache = out;
  return out;
}
export const findAnyPairing = (id: unknown) => allPairings().find((p) => p.id === id);

// ---------------------------------------------------------------------------
// stack notes
// ---------------------------------------------------------------------------

const STACK_FILE = "stacks.json";
let stackCache: Record<string, StackNote[]> | null = null;

export function stackNotes(key: string): StackNote[] {
  if (!stackCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(UI_DIR, STACK_FILE), "utf-8"));
      stackCache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      stackCache = {};
    }
  }
  return stackCache![key] ?? [];
}

/** Which of the reference stacks fit a project's frameworks and styling. */
export function stackKeys(frameworks: string[], styling: string[], platform: string, hasFlutter = false): string[] {
  const f = new Set(frameworks);
  const keys: string[] = [];
  if (f.has("react-native") || f.has("expo")) keys.push("react-native");
  if (f.has("next")) keys.push("nextjs");
  if (f.has("nuxt")) keys.push("nuxtjs");
  if (f.has("vue")) keys.push("vue");
  if (f.has("svelte") || f.has("@sveltejs/kit")) keys.push("svelte");
  if (f.has("astro")) keys.push("astro");
  if (f.has("@angular/core")) keys.push("angular");
  if (hasFlutter) keys.push("flutter");
  if (f.has("react") && !f.has("react-native") && !f.has("next")) keys.push("react");
  if (styling.includes("tailwindcss") && platform !== "native") keys.push("html-tailwind");
  if (styling.includes("shadcn") || styling.includes("@radix-ui/react-slot")) keys.push("shadcn");
  return [...new Set(keys)];
}
