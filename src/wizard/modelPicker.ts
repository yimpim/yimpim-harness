/**
 * The model picker shared by first-run setup, /model, and the specialist-model question: a searchable list over the WHOLE catalog
 * a role can use. Nothing is cut to a fixed count. The list scrolls (12 rows at a time), the search line shows how many models
 * match, and matches are ordered by how well they match, then cheapest first.
 */

import type { CatalogModel, PersonaNeeds } from "../models.js";
import { p, answered } from "./prompts.js";

export const VISIBLE_ROWS = 12;

// ---- pure helpers (tested directly) ----------------------------------------

export function vendorOf(id: string): string {
  return id.split("/")[0]?.toLowerCase() ?? "";
}

/** 1M ctx, 200k ctx, 8k ctx. */
export function formatContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "? ctx";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

/** $0.30 / $2.50 per 1M, free, or variable price (router models). */
export function formatPrice(m: Pick<CatalogModel, "promptCost" | "completionCost">): string {
  if (m.promptCost === null || m.completionCost === null) return "variable price";
  if (m.promptCost === 0 && m.completionCost === 0) return "free";
  const d = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;
  return `${d(m.promptCost)} / ${d(m.completionCost)} per 1M`;
}

/** One row of the list: id, then price in/out and context, aligned. */
export function modelLabel(m: CatalogModel, idWidth: number, isCurrent = false): string {
  return `${m.id.padEnd(idWidth)}  ${formatPrice(m).padEnd(24)} ${formatContext(m.contextLength)}${isCurrent ? "  ● current" : ""}`;
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word typed must appear in the model's id or name. An empty search matches everything. */
export function matchesQuery(m: Pick<CatalogModel, "id" | "name">, query: string): boolean {
  const hay = `${m.id} ${m.name}`.toLowerCase();
  return tokens(query).every((t) => hay.includes(t));
}

function score(m: CatalogModel, ts: string[]): number {
  const id = m.id.toLowerCase();
  const vendor = vendorOf(id);
  const model = id.slice(vendor.length + 1);
  const nameWords = m.name.toLowerCase().split(/[\s:/()-]+/);
  let s = 0;
  for (const t of ts) {
    if (id === t || model === t) s += 0;
    else if (vendor === t || model.startsWith(t)) s += 1;
    else if (nameWords.some((w) => w.startsWith(t)) || model.includes(`-${t}`)) s += 2;
    else s += 3;
  }
  return s;
}

/**
 * The full list in display order for a search: matching models first, best match first (exact id, then provider or model-name
 * prefix, then word start, then anywhere), ties kept in catalog order (cheapest first); then the rest. Nothing is dropped:
 * the picker's filter hides non-matches, and keeping them here is what lets it show "N matches" against the whole list.
 */
export function rankModels(models: CatalogModel[], query: string): CatalogModel[] {
  const ts = tokens(query);
  if (ts.length === 0) return [...models];
  const indexed = models.map((m, i) => ({ m, i, hit: matchesQuery(m, query), s: 0 }));
  for (const x of indexed) if (x.hit) x.s = score(x.m, ts);
  return indexed
    .sort((a, b) => Number(b.hit) - Number(a.hit) || a.s - b.s || a.i - b.i)
    .map((x) => x.m);
}

/** The current model first, so the list opens on it; otherwise catalog order. */
export function currentFirst(models: CatalogModel[], current?: string): CatalogModel[] {
  if (!current) return models;
  const hit = models.find((m) => m.id === current);
  return hit ? [hit, ...models.filter((m) => m !== hit)] : models;
}

// ---- the picker -------------------------------------------------------------

/** A choice pinned above the models (Skip, No backup, Done). Shown only while the search is empty. */
export interface ExtraChoice {
  value: string;
  label: string;
  hint?: string;
}

export const SKIP = "\u0000skip";
export const NO_BACKUP = "\u0000none";
export const DONE = "\u0000done";

export async function pickOne(o: {
  message: string;
  models: CatalogModel[];
  current?: string;
  extra?: ExtraChoice[];
  placeholder?: string;
}): Promise<string> {
  const models = currentFirst(o.models, o.current);
  const byId = new Map(models.map((m) => [m.id, m]));
  const extra = o.extra ?? [];
  const extraValues = new Set(extra.map((e) => e.value));
  const idWidth = Math.min(44, Math.max(12, ...models.map((m) => m.id.length)));
  const toOption = (m: CatalogModel) => ({ value: m.id, label: modelLabel(m, idWidth, m.id === o.current), hint: m.name });

  let lastQuery: string | null = null;
  let lastList: { value: string; label: string; hint?: string }[] = [];
  const options = function (this: { userInput?: string } | undefined) {
    const q = String(this?.userInput ?? "");
    if (q !== lastQuery) {
      lastQuery = q;
      lastList = [...extra, ...rankModels(models, q).map(toOption)];
    }
    return lastList;
  };

  const value = await p.autocomplete<string>({
    message: `${o.message}  ${models.length} models`,
    options,
    filter: (search, opt) => (extraValues.has(opt.value) ? !search.trim() : matchesQuery(byId.get(opt.value)!, search)),
    maxItems: VISIBLE_ROWS,
    placeholder: o.placeholder ?? "type to search, e.g. claude, gemini, deepseek",
    initialValue: o.current && byId.has(o.current) ? o.current : extra[0]?.value,
  });
  return answered(value);
}

/**
 * A role's whole chain: a primary and an optional backup, or for a multi-model role (logo designer, logo judge) a set picked
 * one by one. Returns undefined when an optional role was skipped. Esc anywhere throws WizardCancelled.
 */
export async function pickChain(
  persona: PersonaNeeds,
  models: CatalogModel[],
  existing: string[] = [],
  opts: { allowSkip?: boolean } = {}
): Promise<string[] | undefined> {
  const allowSkip = opts.allowSkip ?? Boolean(persona.optional);
  const first = await pickOne({
    message: persona.label,
    models,
    current: existing[0],
    extra: allowSkip ? [{ value: SKIP, label: existing.length ? "Leave unset (clear it)" : "Skip, leave unset", hint: "uses its fallback" }] : [],
  });
  if (first === SKIP) return undefined;
  const chain = [first];

  if (persona.multi) {
    while (chain.length < persona.multi.max) {
      const next = await pickOne({
        message: `${persona.label}: model ${chain.length + 1} of up to ${persona.multi.max}`,
        models: models.filter((m) => !chain.includes(m.id)),
        current: existing[chain.length],
        extra: [{ value: DONE, label: `Done, use ${chain.length === 1 ? "this model" : `these ${chain.length}`}`, hint: "a different company gives more variety" }],
      });
      if (next === DONE) break;
      chain.push(next);
    }
    return chain;
  }

  const backup = await pickOne({
    message: `${persona.label}: backup, used only if ${first} is unavailable`,
    models: models.filter((m) => m.id !== first),
    current: existing[1],
    extra: [{ value: NO_BACKUP, label: "No backup" }],
  });
  if (backup !== NO_BACKUP) chain.push(backup);
  return chain;
}
