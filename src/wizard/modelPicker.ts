/**
 * The model picker shared by first-run setup, /model, and the specialist-model question: a searchable list over the WHOLE catalog
 * a role can use. Nothing is cut to a fixed count. The list scrolls (12 rows at a time), the search line shows how many models
 * match, and matches are ordered by how well they match, then cheapest first.
 */

import type { CatalogModel, PersonaNeeds } from "../models.js";
import { p, answered, ESC_HINT, ESC_WHOLE } from "./prompts.js";

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

// ---- the row layout ----------------------------------------------------------
//
// clack draws each option as "│  ● label": a 3-column rail, then the radio dot and a space, then the label. A label that holds
// "\n" is split into lines and every line gets only the rail, so a continuation line starts 2 columns left of where the label
// began. Rows are laid out as a 3-column table sized to the terminal, and continuation lines are indented to make up for that.

/** "│  " in front of every line clack draws. */
export const RAIL_WIDTH = 3;
/** "● " in front of an option's first line only. */
export const RADIO_WIDTH = 2;
const GAP = 2;
const PRICE_WIDTH = 22;
const MIN_DETAILS_WIDTH = 16;
const MIN_ID_WIDTH = 16;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Visible width: ANSI escape codes take no columns. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, "").length;
}

/** Word-wraps to `width`, hard-breaking any single word longer than that. Never returns an empty list. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (visibleWidth(rest) > w) {
      if (line) { lines.push(line); line = ""; }
      lines.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (visibleWidth(line) + 1 + visibleWidth(rest) <= w) line += " " + rest;
    else { lines.push(line); line = rest; }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

export interface RowLayout {
  idWidth: number;
  priceWidth: number;
  detailsWidth: number;
  /** Screen column where the details column starts, counting clack's rail and radio. */
  detailsOffset: number;
}

/** Column widths for a terminal `columns` wide, given the longest id in the list. */
export function rowLayout(columns: number, longestId: number): RowLayout {
  const labelWidth = Math.max(40, columns) - RAIL_WIDTH - RADIO_WIDTH;
  const idWidth = Math.max(MIN_ID_WIDTH, Math.min(longestId, labelWidth - PRICE_WIDTH - MIN_DETAILS_WIDTH - 2 * GAP));
  const detailsWidth = Math.max(MIN_DETAILS_WIDTH, labelWidth - idWidth - PRICE_WIDTH - 2 * GAP);
  return { idWidth, priceWidth: PRICE_WIDTH, detailsWidth, detailsOffset: RAIL_WIDTH + RADIO_WIDTH + idWidth + GAP + PRICE_WIDTH + GAP };
}

/**
 * One option's label: id, price in/out per 1M, then details (context, current marker, model name). Each column wraps inside its
 * own width, so a long details column continues on lines that start exactly under it, never under the id.
 */
export function modelLabel(m: CatalogModel, layout: RowLayout, isCurrent = false): string {
  const details = [formatContext(m.contextLength), isCurrent ? "● current" : "", m.name && m.name !== m.id ? m.name : ""].filter(Boolean).join(" · ");
  const cells = [wrapText(m.id, layout.idWidth), wrapText(formatPrice(m), layout.priceWidth), wrapText(details, layout.detailsWidth)];
  const widths = [layout.idWidth, layout.priceWidth, layout.detailsWidth];
  const height = Math.max(...cells.map((c) => c.length));
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const row = cells
      .map((c, col) => {
        const text = c[i] ?? "";
        return col === cells.length - 1 ? text : text + " ".repeat(widths[col] - visibleWidth(text));
      })
      .join(" ".repeat(GAP))
      .replace(/\s+$/, "");
    // Lines after the first have no radio in front of them; indent by its width so the columns stay put.
    lines.push(i === 0 ? row : " ".repeat(RADIO_WIDTH) + row);
  }
  return lines.join("\n");
}

/** Between the models of a role's chain in /model's role list. */
export const CHAIN_SEPARATOR = "  →  ";

/** Width of the role column in /model's role list: the longest label plus a gap, so every chain starts in the same column. */
export function roleColumnWidth(labels: string[]): number {
  return Math.max(...labels.map(visibleWidth)) + GAP;
}

/**
 * One row of /model's role list: the label padded to `labelWidth`, then the chain. A chain too long for the terminal breaks at a separator,
 * and each continuation line starts with "→" exactly under the chain's first model (a hanging indent), never at the left margin as a
 * terminal's own soft wrap would. `reserve` keeps room at the end for what clack adds after a label (the " (optional)" hint).
 */
export function roleRow(label: string, chain: string[] | undefined, unsetText: string, opts: { columns: number; labelWidth: number; reserve?: number }): string {
  const head = label + " ".repeat(Math.max(1, opts.labelWidth - visibleWidth(label)));
  if (!chain || chain.length === 0) return head + unsetText;
  // One column spare: a line filling the last column makes some consoles wrap the cursor, leaving a blank line under the row.
  const width = Math.max(12, opts.columns - RAIL_WIDTH - RADIO_WIDTH - opts.labelWidth - 1);
  const reserve = opts.reserve ?? 0;
  const arrow = CHAIN_SEPARATOR.trimStart(); // "→  " opens each continuation line
  const lines: string[] = [];
  let line = "";
  for (const id of chain) {
    if (!line) {
      line = id;
    } else if (visibleWidth(line) + visibleWidth(CHAIN_SEPARATOR) + visibleWidth(id) <= width) {
      line += CHAIN_SEPARATOR + id;
    } else {
      lines.push(line);
      line = arrow + id;
    }
    // One id wider than the whole column: hard-broken, never spilling past the edge.
    while (visibleWidth(line) > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  // The hint goes after the LAST line only: when it would not fit there, the last model moves to a line of its own.
  const cut = line.lastIndexOf(CHAIN_SEPARATOR);
  if (reserve > 0 && visibleWidth(line) + reserve > width && cut > 0) {
    lines.push(line.slice(0, cut));
    line = arrow + line.slice(cut + CHAIN_SEPARATOR.length);
  }
  lines.push(line);
  // Continuation lines have no radio in front; indent by it and by the role column so they start under the first model.
  const indent = " ".repeat(RADIO_WIDTH + opts.labelWidth);
  return lines.map((l, i) => (i === 0 ? head + l : indent + l)).join("\n");
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
  /** A later step of one change: the hint says Esc drops all of it, not just this step. */
  wholeChange?: boolean;
  /** Test seams; default to the process's own terminal. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream & { columns?: number };
}): Promise<string> {
  const models = currentFirst(o.models, o.current);
  const byId = new Map(models.map((m) => [m.id, m]));
  const extra = o.extra ?? [];
  const extraValues = new Set(extra.map((e) => e.value));
  const out = (o.output ?? process.stdout) as { columns?: number };
  const longestId = Math.max(12, ...models.map((m) => m.id.length));

  // Rebuilt when the search or the terminal width changes, so a resized window re-flows the columns.
  let lastKey: string | null = null;
  let lastList: { value: string; label: string; hint?: string }[] = [];
  const options = function (this: { userInput?: string } | undefined) {
    const q = String(this?.userInput ?? "");
    const columns = out.columns || 80;
    const key = `${columns}\u0000${q}`;
    if (key !== lastKey) {
      lastKey = key;
      const layout = rowLayout(columns, longestId);
      lastList = [...extra, ...rankModels(models, q).map((m) => ({ value: m.id, label: modelLabel(m, layout, m.id === o.current) }))];
    }
    return lastList;
  };

  const value = await p.autocomplete<string>({
    ...(o.input ? { input: o.input as any } : {}),
    ...(o.output ? { output: o.output as any } : {}),
    message: `${o.message}  ${models.length} models  ${o.wholeChange ? ESC_WHOLE : ESC_HINT}`,
    options,
    filter: (search, opt) => (extraValues.has(opt.value) ? !search.trim() : matchesQuery(byId.get(opt.value)!, search)),
    maxItems: VISIBLE_ROWS,
    placeholder: o.placeholder ?? "type to search, e.g. claude, gemini, deepseek",
    initialValue: o.current && byId.has(o.current) ? o.current : extra[0]?.value,
  });
  return answered(value);
}

/**
 * A role's whole chain: a primary and an optional backup, or for a multi-model role (Designer, Designer Judge (Vision)) a set picked
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
        wholeChange: true,
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
    wholeChange: true,
    models: models.filter((m) => m.id !== first),
    current: existing[1],
    extra: [{ value: NO_BACKUP, label: "No backup" }],
  });
  if (backup !== NO_BACKUP) chain.push(backup);
  return chain;
}
