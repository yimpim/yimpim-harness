/**
 * A roadmap: the whole of a big piece of work, kept above any one task.
 *
 * A task is bounded (about 30 files read, 12 phases), so a request like "port
 * this app" or "build a marketplace for X" cannot fit in one, and what does not
 * fit used to be dropped or left as a line of text that the next task planned
 * from scratch. The roadmap is the missing piece: a list of UNITS, each sized
 * to one task, with what depends on what, what each one covers, and whether it
 * is done. It is how a large job is remembered, resumed, and added to.
 *
 * One file (`.agent/roadmap.json`), updated in place, never appended to. This
 * module is pure logic (no model, no git): creating from a plan, adding,
 * choosing what is next, recording what is done, and checking nothing was missed.
 */
import fs from "fs";
import path from "path";

export type UnitStatus = "todo" | "in_progress" | "done" | "blocked" | "dropped";

export interface UnitDone {
  at: string;
  commit?: string;
  /** What this unit actually produced, so later units build on it instead of redoing it. */
  files: string[];
  summary?: string;
  /** Things this unit could not finish or verify (a server-side half, a check it could not run). The unit still counts as done. */
  openItems?: string[];
}

export interface RoadmapUnit {
  id: string;
  title: string;
  /** Grouping (an epic, a feature area, a layer). */
  area: string;
  summary: string;
  deps: string[];
  /** Reference files this unit covers (a port); empty for a new build. */
  refs: string[];
  acceptance: string[];
  status: UnitStatus;
  order: number;
  attempts: number;
  blockedReason?: string;
  done?: UnitDone;
  addedBy: "plan" | "user" | "overflow";
  /** The task that last ran this unit, so a phone can nest that task's phases under the unit. */
  taskId?: string;
}

export interface Roadmap {
  version: 1;
  goal: string;
  /** The full request the roadmap was planned from, when it was longer than the one-line goal. */
  brief?: string;
  kind: "idea" | "port" | "mixed" | "overflow";
  reference?: { dir: string; fileCount: number; scannedAt: string };
  /** Decisions every unit follows, so the pieces fit (naming, structure, libraries). */
  conventions: string[];
  units: RoadmapUnit[];
  /** Set once the person has confirmed that a roadmap spends money on its own (asked once per roadmap). */
  costNoticeAckedAt?: string;
  /** Set when the last unit is done. */
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the Planner (or the user) proposes; ids are assigned here. */
export interface UnitDraft {
  title: string;
  area?: string;
  summary?: string;
  /** Unit ids, or titles of other units (existing or in the same batch). */
  deps?: string[];
  refs?: string[];
  acceptance?: string[];
  order?: number;
}

export const MAX_UNITS = 500;
const MAX_CONVENTIONS = 12;
const MAX_BRIEF = 20000;
const MAX_OPEN_ITEMS = 8;

/** Files that are by-products of working (logs, review notes, tool caches), not something a unit built. */
const NOISE_PATH = /(^|\/)(\.expo|\.agent|\.git|node_modules|\.gradle|build|dist|coverage)\/|(^|\/)(QA_REVIEW\.md|verify-tmp\.txt)$|\.log$/i;
export function isEvidenceNoise(p: string): boolean {
  return NOISE_PATH.test(p.replace(/\\/g, "/"));
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const key = (title: string, area: string) => `${area}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, "");
const nowIso = () => new Date().toISOString();
const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function roadmapPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "roadmap.json");
}

export function emptyRoadmap(goal: string, kind: Roadmap["kind"]): Roadmap {
  const t = nowIso();
  const full = String(goal ?? "").trim();
  return {
    version: 1,
    goal: clip(goal, 500),
    ...(full.length > 500 ? { brief: full.slice(0, MAX_BRIEF) } : {}),
    kind,
    conventions: [],
    units: [],
    createdAt: t,
    updatedAt: t,
  };
}

export function loadRoadmap(repoRoot: string): Roadmap | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(roadmapPath(repoRoot), "utf-8"));
    if (raw?.version === 1 && Array.isArray(raw.units)) return raw as Roadmap;
  } catch {
    // none, or unreadable
  }
  return undefined;
}

const changeListeners = new Set<(repoRoot: string) => void>();
/** Called whenever a roadmap is saved or thrown away (the phone's roadmap card follows it). Returns the way to stop listening. */
export function onRoadmapChanged(fn: (repoRoot: string) => void): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}
export function notifyRoadmapChanged(repoRoot: string): void {
  for (const fn of [...changeListeners]) {
    try {
      fn(repoRoot);
    } catch {
      // a listener must never break a save
    }
  }
}

/** What a phone is sent: the whole roadmap, summaries clipped, without acceptance lists or reference file lists. */
export interface RoadmapWire {
  /** Stable for the life of this roadmap (its creation time). */
  roadmapId: string;
  goal: string;
  kind: Roadmap["kind"];
  done: number;
  total: number;
  activeUnitId: string | null;
  updatedAt: string;
  units: {
    id: string;
    title: string;
    area: string;
    summary: string;
    status: UnitStatus;
    order: number;
    deps: string[];
    attempts: number;
    addedBy: RoadmapUnit["addedBy"];
    taskId?: string;
    blockedReason?: string;
    result?: { summary: string; fileCount: number; commit?: string; openItems?: string[] };
  }[];
}

/** The roadmap as the phone gets it; null when there is none. */
export function roadmapWire(rm: Roadmap | undefined): RoadmapWire | null {
  if (!rm) return null;
  const units = [...rm.units].sort((a, b) => a.order - b.order);
  return {
    roadmapId: rm.createdAt,
    goal: rm.goal,
    kind: rm.kind,
    done: units.filter((u) => u.status === "done").length,
    total: units.filter((u) => u.status !== "dropped").length,
    activeUnitId: units.find((u) => u.status === "in_progress")?.id ?? null,
    updatedAt: rm.updatedAt,
    units: units.map((u) => ({
      id: u.id,
      title: u.title,
      area: u.area,
      summary: clip(u.summary, 200),
      status: u.status,
      order: u.order,
      deps: u.deps,
      attempts: u.attempts,
      addedBy: u.addedBy,
      ...(u.taskId ? { taskId: u.taskId } : {}),
      ...(u.blockedReason ? { blockedReason: clip(u.blockedReason, 200) } : {}),
      ...(u.status === "done" && u.done ? { result: { summary: clip(u.done.summary ?? "", 200), fileCount: u.done.files.length, ...(u.done.commit ? { commit: u.done.commit } : {}), ...(u.done.openItems?.length ? { openItems: u.done.openItems.map((x) => clip(x, 200)) } : {}) } } : {}),
    })),
  };
}

/** Written whole, atomically, so a crash never leaves half a roadmap. */
export function saveRoadmap(repoRoot: string, rm: Roadmap): void {
  rm.updatedAt = nowIso();
  stampCompleted(rm);
  const file = roadmapPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rm, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  notifyRoadmapChanged(repoRoot);
}

/**
 * A finished roadmap is copied to .agent/roadmaps/ (named by when it began) and the active file is removed, so the next big
 * request starts clean instead of being offered "add to a roadmap that is 12/12 done". Returns the archive path, or undefined
 * when the roadmap is not finished.
 */
export function archiveFinishedRoadmap(repoRoot: string): string | undefined {
  const rm = loadRoadmap(repoRoot);
  if (!rm || !isFinished(rm)) return undefined;
  rm.completedAt ??= nowIso();
  const dir = path.join(repoRoot, ".agent", "roadmaps");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rm.createdAt.replace(/[^0-9A-Za-z]+/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(rm, null, 2), "utf-8");
  fs.rmSync(roadmapPath(repoRoot), { force: true });
  notifyRoadmapChanged(repoRoot);
  return file;
}

export function setConventions(rm: Roadmap, conventions: string[]): void {
  rm.conventions = [...new Set(conventions.map((c) => clip(c, 200)).filter(Boolean))].slice(0, MAX_CONVENTIONS);
}

export interface AddResult {
  added: RoadmapUnit[];
  updated: RoadmapUnit[];
  /** Already done: left alone. */
  skipped: string[];
  warnings: string[];
}

/**
 * Adds proposed units. A unit that matches an existing one (same title and
 * area) updates it instead of appearing twice, unless it is already done, in
 * which case it is left alone. Dependencies given as titles are resolved; ones
 * that resolve to nothing, or that would make a cycle, are dropped with a warning.
 */
export function addUnits(rm: Roadmap, drafts: UnitDraft[], addedBy: RoadmapUnit["addedBy"] = "plan"): AddResult {
  const res: AddResult = { added: [], updated: [], skipped: [], warnings: [] };
  let nextNum = rm.units.reduce((m, u) => Math.max(m, Number(u.id.slice(1)) || 0), 0) + 1;
  let nextOrder = rm.units.reduce((m, u) => Math.max(m, u.order), 0) + 1;

  // Pass 1: decide each draft's unit (new or existing) so deps can point at any of them.
  const resolved: { draft: UnitDraft; unit: RoadmapUnit; isNew: boolean }[] = [];
  for (const d of drafts) {
    const title = clip(d.title, 100);
    if (!title) {
      res.warnings.push("a proposed unit had no title and was ignored");
      continue;
    }
    const area = clip(d.area || "General", 60);
    const existing = rm.units.find((u) => key(u.title, u.area) === key(title, area));
    if (existing) {
      if (existing.status === "done") {
        res.skipped.push(`${existing.id} ${existing.title} (already done)`);
        continue;
      }
      resolved.push({ draft: d, unit: existing, isNew: false });
      continue;
    }
    if (rm.units.length + resolved.filter((r) => r.isNew).length >= MAX_UNITS) {
      res.warnings.push(`the roadmap is full (${MAX_UNITS} units); "${title}" was not added`);
      continue;
    }
    const unit: RoadmapUnit = {
      id: `U${String(nextNum++).padStart(3, "0")}`,
      title,
      area,
      summary: "",
      deps: [],
      refs: [],
      acceptance: [],
      status: "todo",
      order: d.order ?? nextOrder++,
      attempts: 0,
      addedBy,
    };
    resolved.push({ draft: d, unit, isNew: true });
  }

  const all = [...rm.units, ...resolved.filter((r) => r.isNew).map((r) => r.unit)];
  const byId = new Map(all.map((u) => [u.id.toLowerCase(), u]));
  const byTitle = new Map(all.map((u) => [key(u.title, "").replace(/^\|/, ""), u]));
  const find = (ref: string): RoadmapUnit | undefined => byId.get(ref.trim().toLowerCase()) ?? byTitle.get(key(ref, "").replace(/^\|/, ""));

  // Pass 2: fill the fields and resolve dependencies.
  for (const { draft, unit, isNew } of resolved) {
    if (draft.summary !== undefined || isNew) unit.summary = clip(draft.summary ?? unit.summary, 600);
    if (draft.refs) unit.refs = [...new Set(draft.refs.map(norm).filter(Boolean))].slice(0, 200);
    if (draft.acceptance) unit.acceptance = draft.acceptance.map((a) => clip(a, 160)).filter(Boolean).slice(0, 6);
    if (draft.deps) {
      const deps: string[] = [];
      for (const ref of draft.deps) {
        const target = find(ref);
        if (!target) res.warnings.push(`"${unit.title}" depends on "${ref}", which is not on the roadmap; dependency dropped`);
        else if (target.id === unit.id) res.warnings.push(`"${unit.title}" cannot depend on itself`);
        else if (!deps.includes(target.id)) deps.push(target.id);
      }
      unit.deps = deps;
    }
    if (isNew) {
      rm.units.push(unit);
      res.added.push(unit);
    } else {
      res.updated.push(unit);
    }
  }

  // A cycle makes work impossible to order: break it at the unit just added.
  for (const u of [...res.added, ...res.updated]) {
    for (const cycle of findCycles(rm)) {
      if (!cycle.includes(u.id)) continue;
      const before = u.deps.length;
      u.deps = u.deps.filter((d) => !cycle.includes(d));
      if (u.deps.length < before) res.warnings.push(`"${u.title}" had a circular dependency; the circular part was dropped`);
    }
  }
  return res;
}

/** Groups of units that depend on each other in a loop. */
export function findCycles(rm: Roadmap): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let i = 0;
  const byId = new Map(rm.units.map((u) => [u.id, u]));
  const visit = (id: string) => {
    index.set(id, i);
    low.set(id, i);
    i++;
    stack.push(id);
    onStack.add(id);
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue;
      if (!index.has(d)) {
        visit(d);
        low.set(id, Math.min(low.get(id)!, low.get(d)!));
      } else if (onStack.has(d)) {
        low.set(id, Math.min(low.get(id)!, index.get(d)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== id);
      if (comp.length > 1) out.push(comp);
    }
  };
  for (const u of rm.units) if (!index.has(u.id)) visit(u.id);
  return out;
}

export function validateRoadmap(rm: Roadmap): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const u of rm.units) {
    if (ids.has(u.id)) issues.push(`duplicate id ${u.id}`);
    ids.add(u.id);
    if (!u.title) issues.push(`${u.id} has no title`);
  }
  for (const u of rm.units) for (const d of u.deps) if (!ids.has(d)) issues.push(`${u.id} depends on unknown ${d}`);
  for (const c of findCycles(rm)) issues.push(`circular dependency among ${c.join(", ")}`);
  if (rm.units.length > MAX_UNITS) issues.push(`more than ${MAX_UNITS} units`);
  return issues;
}

const settled = (u: RoadmapUnit | undefined) => !u || u.status === "done" || u.status === "dropped";

/** Units that can be worked on now: not finished, with every dependency done. In-progress ones first. */
export function nextUnits(rm: Roadmap, n = 1): RoadmapUnit[] {
  const byId = new Map(rm.units.map((u) => [u.id, u]));
  return rm.units
    .filter((u) => (u.status === "todo" || u.status === "in_progress") && u.deps.every((d) => settled(byId.get(d))))
    .sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress") || a.order - b.order || a.id.localeCompare(b.id))
    .slice(0, n);
}

/** Units that cannot start yet, and what they are waiting for. */
export function waitingUnits(rm: Roadmap): { unit: RoadmapUnit; waitingFor: RoadmapUnit[] }[] {
  const byId = new Map(rm.units.map((u) => [u.id, u]));
  return rm.units
    .filter((u) => u.status === "todo" || u.status === "in_progress")
    .map((unit) => ({ unit, waitingFor: unit.deps.map((d) => byId.get(d)).filter((d): d is RoadmapUnit => !!d && !settled(d)) }))
    .filter((w) => w.waitingFor.length > 0);
}

const unitOf = (rm: Roadmap, id: string) => rm.units.find((u) => u.id.toLowerCase() === id.toLowerCase());

export function markStarted(rm: Roadmap, id: string): RoadmapUnit | undefined {
  const u = unitOf(rm, id);
  if (!u || u.status === "done" || u.status === "dropped") return u;
  u.status = "in_progress";
  u.attempts++;
  delete u.blockedReason;
  return u;
}

/** True once every unit that is not dropped is done. */
export function isFinished(rm: Roadmap): boolean {
  const live = rm.units.filter((u) => u.status !== "dropped");
  return live.length > 0 && live.every((u) => u.status === "done");
}

function stampCompleted(rm: Roadmap): void {
  if (isFinished(rm)) rm.completedAt ??= nowIso();
  else delete rm.completedAt;
}

/** Everything that was left open across the roadmap, for the person to see after a run. */
export function openItems(rm: Roadmap): { id: string; title: string; item: string }[] {
  return rm.units.flatMap((u) => (u.done?.openItems ?? []).map((item) => ({ id: u.id, title: u.title, item })));
}

/** A unit the roadmap recorded as built: what it was, where it landed, and what it left open. */
export interface BuiltUnit {
  id: string;
  title: string;
  summary: string;
  files: string[];
  commit?: string;
  openItems: string[];
}

/**
 * Everything any roadmap of this project recorded as done: the active one and every archived one. This is the cheapest
 * record of what was built, so a check "is the brief done?" starts from it and then confirms in the code.
 */
export function builtByUnits(repoRoot: string): BuiltUnit[] {
  const sets: Roadmap[] = [];
  const active = loadRoadmap(repoRoot);
  if (active) sets.push(active);
  try {
    const dir = path.join(repoRoot, ".agent", "roadmaps");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const rm = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (rm?.version === 1 && Array.isArray(rm.units)) sets.push(rm as Roadmap);
      } catch {
        // an unreadable archive is skipped
      }
    }
  } catch {
    // no archive folder
  }
  return sets.flatMap((rm) =>
    rm.units
      .filter((u) => u.status === "done" && u.done)
      .map((u) => ({ id: u.id, title: u.title, summary: u.summary, files: u.done!.files, commit: u.done!.commit, openItems: u.done!.openItems ?? [] }))
  );
}

/** Adds a note to a unit that is done, without reopening it. */
export function addOpenItem(rm: Roadmap, id: string, text: string): boolean {
  const u = unitOf(rm, id);
  if (!u?.done) return false;
  u.done.openItems = [...(u.done.openItems ?? []), clip(text, 240)].slice(0, MAX_OPEN_ITEMS);
  return true;
}

export function markDone(rm: Roadmap, id: string, evidence: { commit?: string; files?: string[]; summary?: string; openItems?: string[] }): RoadmapUnit | undefined {
  const u = unitOf(rm, id);
  if (!u) return undefined;
  u.status = "done";
  delete u.blockedReason;
  u.done = {
    at: nowIso(),
    ...(evidence.commit ? { commit: evidence.commit.slice(0, 40) } : {}),
    files: [...new Set((evidence.files ?? []).map(norm).filter((f) => f && !isEvidenceNoise(f)))].slice(0, 40),
    ...(evidence.summary ? { summary: clip(evidence.summary, 300) } : {}),
    ...(evidence.openItems?.length ? { openItems: evidence.openItems.map((x) => clip(x, 240)).filter(Boolean).slice(0, MAX_OPEN_ITEMS) } : {}),
  };
  stampCompleted(rm);
  return u;
}

export function markBlocked(rm: Roadmap, id: string, reason: string): RoadmapUnit | undefined {
  const u = unitOf(rm, id);
  if (!u || u.status === "done" || u.status === "dropped") return u;
  u.status = "blocked";
  u.blockedReason = clip(reason, 300);
  return u;
}

export function markDropped(rm: Roadmap, id: string, reason?: string): RoadmapUnit | undefined {
  const u = unitOf(rm, id);
  if (!u) return undefined;
  u.status = "dropped";
  if (reason) u.blockedReason = clip(reason, 300);
  return u;
}

/** Back to todo (a failed or doubtful unit), keeping what it said it produced. */
export function reopen(rm: Roadmap, id: string): RoadmapUnit | undefined {
  const u = unitOf(rm, id);
  if (!u) return undefined;
  u.status = "todo";
  delete u.blockedReason;
  return u;
}

export interface Progress {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  todo: number;
  dropped: number;
  percent: number;
}

export function progress(rm: Roadmap): Progress {
  const count = (s: UnitStatus) => rm.units.filter((u) => u.status === s).length;
  const dropped = count("dropped");
  const total = rm.units.length - dropped;
  const done = count("done");
  return { total, done, inProgress: count("in_progress"), blocked: count("blocked"), todo: count("todo"), dropped, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Reference files no unit covers, and covered paths that are not in the scan (gone, or never there). */
export function coverage(rm: Roadmap, referenceFiles: string[]): { uncovered: string[]; unknown: string[] } {
  const have = new Set(referenceFiles.map(norm));
  const covered = new Set<string>();
  for (const u of rm.units) if (u.status !== "dropped") for (const r of u.refs) covered.add(norm(r));
  return {
    uncovered: [...have].filter((f) => !covered.has(f)).sort(),
    unknown: [...covered].filter((f) => !have.has(f)).sort(),
  };
}

/** The roadmap for a person: progress, what is next, what is stuck, by area. */
export function renderRoadmap(rm: Roadmap, opts: { maxUnits?: number } = {}): string {
  const p = progress(rm);
  const bar = "█".repeat(Math.round(p.percent / 5)) + "░".repeat(20 - Math.round(p.percent / 5));
  const lines: string[] = [
    `Roadmap: ${rm.goal}`,
    `${bar} ${p.done}/${p.total} done (${p.percent}%)${p.inProgress ? `, ${p.inProgress} in progress` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}${p.dropped ? `, ${p.dropped} dropped` : ""}`,
  ];
  const next = nextUnits(rm, 3);
  if (next.length > 0) lines.push("", "Next up:", ...next.map((u) => `  ${u.id}  ${u.title}${u.status === "in_progress" ? "  (in progress)" : ""}`));
  const blocked = rm.units.filter((u) => u.status === "blocked");
  if (blocked.length > 0) lines.push("", "Blocked:", ...blocked.slice(0, 6).map((u) => `  ${u.id}  ${u.title}: ${u.blockedReason ?? "no reason recorded"}`));
  const left = openItems(rm);
  if (left.length > 0) lines.push("", "Done, with open items:", ...left.slice(0, 8).map((o) => `  ${o.id}  ${o.item}`));
  if (rm.completedAt) lines.push("", `Finished ${rm.completedAt.slice(0, 10)}.`);
  const cycles = findCycles(rm);
  if (cycles.length > 0) lines.push("", `Needs attention: circular dependency among ${cycles[0].join(", ")}`);

  const max = opts.maxUnits ?? 60;
  const areas = new Map<string, RoadmapUnit[]>();
  for (const u of [...rm.units].sort((a, b) => a.order - b.order)) areas.set(u.area, [...(areas.get(u.area) ?? []), u]);
  lines.push("");
  let shown = 0;
  for (const [area, units] of areas) {
    if (shown >= max) break;
    const d = units.filter((u) => u.status === "done").length;
    lines.push(`${area} (${d}/${units.length})`);
    for (const u of units) {
      if (shown >= max) break;
      const mark = { done: "[x]", in_progress: "[~]", blocked: "[!]", dropped: "[-]", todo: "[ ]" }[u.status];
      lines.push(`  ${mark} ${u.id} ${u.title}`);
      shown++;
    }
  }
  if (shown < rm.units.length) lines.push(`... ${rm.units.length - shown} more unit(s) not shown`);
  return lines.join("\n");
}

/**
 * The task text for one unit: what to build, what it must use that already
 * exists, what it must NOT build because a later unit owns it, and the
 * conventions that make the pieces fit. This is what makes a unit a task that
 * knows the whole picture without having to read it.
 */
export function unitTaskPrompt(rm: Roadmap, unit: RoadmapUnit): string {
  const p = progress(rm);
  const position = rm.units.filter((u) => u.status !== "dropped").sort((a, b) => a.order - b.order).findIndex((u) => u.id === unit.id) + 1;
  const byId = new Map(rm.units.map((u) => [u.id, u]));
  const lines: string[] = [
    `ROADMAP UNIT ${unit.id}: ${unit.title}  (area: ${unit.area}; unit ${position} of ${p.total}; ${p.done} already done)`,
    `Overall goal: ${rm.goal}`,
    ...(rm.brief ? [``, `The full request this roadmap came from:`, rm.brief.slice(0, 6000)] : []),
    ``,
    `Build this unit:`,
    unit.summary || unit.title,
  ];
  if (unit.acceptance.length > 0) lines.push(``, `It is done when:`, ...unit.acceptance.map((a) => `- ${a}`));
  if (unit.refs.length > 0) {
    lines.push(``, `Reference files this unit covers (read them: they define the behavior to reproduce):`, ...unit.refs.slice(0, 40).map((r) => `- ${r}`));
    if (unit.refs.length > 40) lines.push(`- ... and ${unit.refs.length - 40} more under the same folders`);
  }

  const built = rm.units.filter((u) => u.status === "done" && u.done);
  const direct = unit.deps.map((d) => byId.get(d)).filter((u): u is RoadmapUnit => !!u && !!u.done);
  const others = built.filter((u) => !direct.includes(u)).slice(-6);
  if (direct.length + others.length > 0) {
    lines.push(``, `Already built by earlier units (use these; do not rebuild them):`);
    for (const u of [...direct, ...others]) {
      const files = u.done!.files.slice(0, 6).join(", ");
      lines.push(`- ${u.id} ${u.title}${direct.includes(u) ? " (this unit depends on it)" : ""}${files ? `: ${files}` : ""}`);
      for (const item of (u.done!.openItems ?? []).slice(0, 3)) lines.push(`    left open: ${item}`);
    }
  }
  if (rm.conventions.length > 0) lines.push(``, `Conventions every unit follows, so the pieces fit:`, ...rm.conventions.map((c) => `- ${c}`));

  const later = rm.units.filter((u) => (u.status === "todo" || u.status === "in_progress") && u.id !== unit.id).sort((a, b) => a.order - b.order).slice(0, 8);
  if (later.length > 0) lines.push(``, `Do NOT build these here; other units own them: ${later.map((u) => u.title).join("; ")}.`);
  lines.push(
    ``,
    `Stay inside this unit. If something it needs should already exist from an earlier unit and does not, say so plainly in your plan instead of building it here.`
  );
  return lines.join("\n");
}

/** Record which task is running a unit. Saved so a phone that joins late still knows where the unit's phases are. */
export function attachTaskToUnit(repoRoot: string, unitId: string, taskId: string): void {
  const rm = loadRoadmap(repoRoot);
  const u = rm && rm.units.find((x) => x.id === unitId);
  if (!rm || !u || u.taskId === taskId) return;
  u.taskId = taskId;
  saveRoadmap(repoRoot, rm);
}

/**
 * The flat snapshot the phone builds its roadmap card from. Sent next to the original `roadmap` object, which is unchanged.
 * `state` is "reset" when the roadmap is gone; `unit.status` is todo | running | done | blocked | dropped.
 */
export interface RoadmapStateWire {
  roadmapId: string;
  title: string;
  done: number;
  total: number;
  state: "active" | "finished" | "reset";
  units: { id: string; title: string; area: string | null; status: "todo" | "running" | "done" | "blocked" | "dropped"; summary: string | null; taskId: string | null }[];
}

export function roadmapStateWire(wire: RoadmapWire | null, lastRoadmapId?: string): RoadmapStateWire | null {
  if (!wire) return lastRoadmapId ? { roadmapId: lastRoadmapId, title: "", done: 0, total: 0, state: "reset", units: [] } : null;
  return {
    roadmapId: wire.roadmapId,
    title: clip(wire.goal, 120),
    done: wire.done,
    total: wire.total,
    state: wire.total > 0 && wire.done >= wire.total ? "finished" : "active",
    units: wire.units.map((u) => ({
      id: u.id,
      title: u.title,
      area: u.area || null,
      status: u.status === "in_progress" ? "running" : u.status,
      // The one-line RESULT once the unit is done; null before that (the plan summary stays in the original `roadmap` object).
      summary: u.status === "done" ? u.result?.summary || u.summary || null : null,
      taskId: u.taskId ?? null,
    })),
  };
}
