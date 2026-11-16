/**
 * Route-finding over .agent/nav_map.json.
 *
 * nav_map.json holds, per screen, how a user reaches it and where each control
 * leads (written by register_screen_nav from real navigation code). It used to
 * be handed to the QA vision model as raw text, leaving the model to do
 * multi-hop path-finding in its head, and nothing recorded whether a
 * documented path had ever actually worked on a device. This module turns the
 * same data into a graph, finds the shortest route from a launch screen to a
 * target screen, and records which edges QA has really walked.
 *
 * Nothing here knows about any particular app or framework. The graph is built
 * from STRUCTURED fields register_screen_nav records (isLaunchScreen,
 * reachedFromScreen + reachedViaLabel, controls[].leadsToScreen). The old
 * free-text fields are only a best-effort fallback for maps written before
 * those existed, since prose wording varies by model and project.
 *
 * Everything is a HINT, never proof of arrival: a route built from code can be
 * stale or wrong, so QA still confirms every screen visually. "Verified" only
 * changes how the hint is worded to the model.
 */

import fsSync from "fs";
import path from "path";

export interface NavEdge {
  from: string;
  label: string;
  to: string;
  /** The documented control was found missing on its own screen more recently
   *  than anything confirmed or re-read it. Stale edges are not routed through. */
  stale?: boolean;
}

export interface NavGraph {
  screens: string[];
  edges: NavEdge[];
  /** Screens the app can be on straight after launch. */
  starts: string[];
  /** "<to>\u0000<from>\u0000<label>" -> ISO time QA last actually walked it. */
  verified: Map<string, string>;
}

export interface RouteStep extends NavEdge {
  verifiedAt?: string;
}

const verifiedKey = (to: string, from: string, label: string) => `${to}\u0000${from}\u0000${label}`;
/** Key used inside a screen entry's `verifiedInbound` record. */
export const inboundKey = (from: string, label: string) => `${from}\u0000${label}`;

/** Loose label comparison: a recorded label like "🛒 Market" and the
 *  accessible label QA's hint list reports ("Market") should match. */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function labelsMatch(a: string, b: string): boolean {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function navMapPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "nav_map.json");
}

export function readNavMap(repoRoot: string): Record<string, any> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(navMapPath(repoRoot), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A screen name that can never be real (a register call whose `screen`
 *  argument was missing used to be stored under the literal key "undefined"). */
export function isJunkScreenName(name: unknown): boolean {
  if (typeof name !== "string") return true;
  const n = name.trim().toLowerCase();
  return n === "" || n === "undefined" || n === "null";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fallback for maps without `leadsToScreen`: the one known screen a free-text
 *  `leadsTo` names, if it names exactly one. */
function resolveLegacyDestination(leadsTo: string, screens: string[]): string | undefined {
  const exact = screens.find((s) => s === leadsTo.trim());
  if (exact) return exact;
  const hits = screens.filter((s) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(s)}($|[^A-Za-z0-9_])`).test(leadsTo));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Fallback for maps without `reachedFromScreen`/`reachedViaLabel`: split a
 *  free-text reachedFrom of the form `<Screen>, tap "<Label>"`. */
function parseLegacyReachedFrom(reached: string, screens: string[]): { from: string; label: string } | undefined {
  const label = reached.match(/tap\s+(?:the\s+)?["'`“](.+?)["'`”]/i)?.[1];
  if (!label) return undefined;
  const from = [...screens].sort((a, b) => b.length - a.length).find((s) => reached.trim().startsWith(s));
  return from ? { from, label } : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function buildNavGraph(rawMap: Record<string, any>): NavGraph {
  const map: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawMap)) if (!isJunkScreenName(k)) map[k] = v;

  const registered = Object.keys(map);
  const implicit = new Set<string>();

  // Pass 1: every screen name referenced as a source, so unregistered-but-real
  // screens still become nodes and can be matched in pass 2.
  for (const entry of Object.values<any>(map)) {
    const src = str(entry?.reachedFromScreen);
    if (src && !registered.includes(src)) implicit.add(src);
  }
  const screens = [...registered, ...implicit];

  const edges: NavEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, label: string, to: string) => {
    if (!label || !from || !to || from === to) return;
    const k = `${from}\u0000${label}\u0000${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, label, to });
  };

  const starts: string[] = [];
  const verified = new Map<string, string>();

  for (const [screen, entry] of Object.entries<any>(map)) {
    for (const c of Array.isArray(entry?.controls) ? entry.controls : []) {
      const label = str(c?.label);
      if (!label) continue;
      const structured = str(c?.leadsToScreen);
      const dest = structured ?? (typeof c?.leadsTo === "string" ? resolveLegacyDestination(c.leadsTo, screens) : undefined);
      if (dest && screens.includes(dest)) add(screen, label, dest);
    }

    const sFrom = str(entry?.reachedFromScreen);
    const sLabel = str(entry?.reachedViaLabel);
    if (sFrom && sLabel) {
      add(sFrom, sLabel, screen);
    } else if (typeof entry?.reachedFrom === "string") {
      const legacy = parseLegacyReachedFrom(entry.reachedFrom, screens);
      if (legacy) add(legacy.from, legacy.label, screen);
    }

    if (entry?.isLaunchScreen === true) starts.push(screen);

    // What QA itself saw happen on a device. Real evidence by construction, so
    // it also counts as "walked".
    if (entry?.observedLaunch === true && !starts.includes(screen)) starts.push(screen);
    for (const o of Array.isArray(entry?.observedEdges) ? entry.observedEdges : []) {
      const label = str(o?.label);
      const to = str(o?.to);
      if (!label || !to || !screens.includes(to)) continue;
      add(screen, label, to);
      if (str(o?.at)) verified.set(verifiedKey(to, screen, label), o.at);
    }

    const v = entry?.verifiedInbound;
    if (v && typeof v === "object") {
      for (const [k, at] of Object.entries<any>(v)) {
        const [from, label] = k.split("\u0000");
        if (typeof at === "string" && from && label) verified.set(verifiedKey(screen, from, label), at);
      }
    }
  }

  // An edge flagged stale stays stale until something newer than the flag
  // confirms it: QA walking it again, or the code being re-read and
  // re-registered (register_screen_nav stamps lastUpdated).
  for (const e of edges) {
    const staleAt = Date.parse(map[e.to]?.staleInbound?.[inboundKey(e.from, e.label)] ?? "");
    if (Number.isNaN(staleAt)) continue;
    const walkedAt = Date.parse(verified.get(verifiedKey(e.to, e.from, e.label)) ?? "") || 0;
    const fresh = Math.max(walkedAt, Number(map[e.from]?.lastUpdated) || 0, Number(map[e.to]?.lastUpdated) || 0);
    if (staleAt > fresh) e.stale = true;
  }

  return { screens, edges, starts, verified };
}

/** Shortest route from any launch screen to `target` (BFS). `[]` means the
 *  target is itself a launch screen; `undefined` means no known route (either
 *  the target is unmapped or no launch screen has been recorded yet). */
export function findRoute(graph: NavGraph, target: string): RouteStep[] | undefined {
  if (!graph.screens.includes(target)) return undefined;
  if (graph.starts.includes(target)) return [];

  const out = new Map<string, NavEdge[]>();
  for (const e of graph.edges) {
    if (e.stale) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }

  const prev = new Map<string, NavEdge>();
  const visited = new Set<string>(graph.starts);
  const queue = [...graph.starts];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      prev.set(e.to, e);
      if (e.to === target) {
        const route: RouteStep[] = [];
        let node = target;
        while (prev.has(node)) {
          const edge = prev.get(node)!;
          route.unshift({ ...edge, verifiedAt: graph.verified.get(verifiedKey(edge.to, edge.from, edge.label)) });
          node = edge.from;
        }
        return route;
      }
      queue.push(e.to);
    }
  }
  return undefined;
}

export function formatRoute(target: string, route: RouteStep[]): string {
  if (route.length === 0) return `${target} is a launch screen — no navigation needed.`;
  const lines = route.map(
    (s, i) =>
      `${i + 1}. On ${s.from}, tap "${s.label}" -> ${s.to}` +
      (s.verifiedAt ? ` (walked successfully by QA before, ${s.verifiedAt.slice(0, 10)})` : " (from code only, never walked on a device)")
  );
  return `Suggested route to ${target}:\n${lines.join("\n")}`;
}

const MAX_VERIFIED_PER_SCREEN = 30;

/** Records that QA really tapped these route steps on a device and ended up
 *  where the requirement was. Only steps whose label QA actually tapped are
 *  passed in — an untried step is never promoted just because the end was
 *  reached some other way. Best-effort: failing to record only loses the
 *  "walked before" wording, never navigation itself. */
export function markEdgesVerified(repoRoot: string, steps: NavEdge[]): void {
  if (steps.length === 0) return;
  try {
    const map = readNavMap(repoRoot);
    const now = new Date().toISOString();
    let changed = false;
    for (const s of steps) {
      const entry = map[s.to];
      if (!entry) continue;
      const v: Record<string, string> = entry.verifiedInbound && typeof entry.verifiedInbound === "object" ? entry.verifiedInbound : {};
      v[inboundKey(s.from, s.label)] = now;
      const keys = Object.keys(v);
      if (keys.length > MAX_VERIFIED_PER_SCREEN) {
        keys.sort((a, b) => v[a].localeCompare(v[b]));
        for (const k of keys.slice(0, keys.length - MAX_VERIFIED_PER_SCREEN)) delete v[k];
      }
      entry.verifiedInbound = v;
      changed = true;
    }
    if (changed) fsSync.writeFileSync(navMapPath(repoRoot), JSON.stringify(map, null, 2), "utf-8");
  } catch {}
}

/** Which route steps' labels appear among the labels QA actually tapped. */
export function stepsActuallyTapped(route: RouteStep[], tappedLabels: string[]): RouteStep[] {
  return route.filter((s) => tappedLabels.some((t) => labelsMatch(t, s.label)));
}

/** Read-modify-write of nav_map.json. Best-effort: losing an observation just
 *  means the map is no better informed than before, never a failed run. */
function mutateNavMap(repoRoot: string, fn: (map: Record<string, any>) => boolean): void {
  try {
    const map = readNavMap(repoRoot);
    if (!fn(map)) return;
    fsSync.mkdirSync(path.dirname(navMapPath(repoRoot)), { recursive: true });
    fsSync.writeFileSync(navMapPath(repoRoot), JSON.stringify(map, null, 2), "utf-8");
  } catch {}
}

/** A screen QA saw but no code analysis registered. It has no file, so it is
 *  tagged `source: "observed"` (agentLoop's stale-file cleanup must skip it). */
function ensureObservedEntry(map: Record<string, any>, screen: string, reachedFrom: string): any {
  if (!map[screen]) {
    map[screen] = { file: "(observed at runtime)", reachedFrom, source: "observed", controls: [], lastUpdated: Date.now() };
  }
  return map[screen];
}

const MAX_OBSERVED_EDGES_PER_SCREEN = 30;

/** QA tapped `label` on `from` and the next screen it saw was `to`. */
export function recordObservedEdge(repoRoot: string, from: string, label: string, to: string): void {
  if (isJunkScreenName(from) || isJunkScreenName(to) || !label.trim() || from === to) return;
  mutateNavMap(repoRoot, (map) => {
    ensureObservedEntry(map, to, `observed: ${from}, tap "${label}"`);
    const entry = ensureObservedEntry(map, from, "observed");
    const list: any[] = Array.isArray(entry.observedEdges) ? entry.observedEdges : [];
    const now = new Date().toISOString();
    const hit = list.find((o) => o?.label === label && o?.to === to);
    if (hit) hit.at = now;
    else list.push({ label, to, at: now });
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    entry.observedEdges = list.slice(-MAX_OBSERVED_EDGES_PER_SCREEN);
    return true;
  });
}

/** The first screen QA saw right after launching the app fresh. */
export function recordObservedLaunch(repoRoot: string, screen: string): void {
  if (isJunkScreenName(screen)) return;
  mutateNavMap(repoRoot, (map) => {
    const entry = ensureObservedEntry(map, screen, "app launch (observed)");
    if (entry.observedLaunch === true) return false;
    entry.observedLaunch = true;
    return true;
  });
}

/** A documented control was not on its own screen when QA stood there. */
export function markEdgeStale(repoRoot: string, edge: NavEdge): void {
  mutateNavMap(repoRoot, (map) => {
    const entry = map[edge.to];
    if (!entry) return false;
    const stale: Record<string, string> = entry.staleInbound && typeof entry.staleInbound === "object" ? entry.staleInbound : {};
    stale[inboundKey(edge.from, edge.label)] = new Date().toISOString();
    entry.staleInbound = stale;
    return true;
  });
}

/** Match a model-reported screen name to a known one, ignoring case and
 *  punctuation; otherwise keep the model's own short name. */
export function canonicalScreenName(reported: unknown, known: string[]): string | undefined {
  if (typeof reported !== "string" || isJunkScreenName(reported)) return undefined;
  const name = reported.trim().slice(0, 60);
  const n = normalizeLabel(name);
  return known.find((k) => normalizeLabel(k) === n) ?? name;
}
