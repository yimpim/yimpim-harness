/**
 * What the commands and the run loop do with a roadmap, kept apart from
 * index.ts (which runs the whole CLI on import) so it can be tested.
 *
 * Everything that needs a model or a person is passed in, so none of this
 * knows how a question is asked or which model answers.
 */
import { splitJobs } from "./jobsList.js";
import fs from "fs";
import path from "path";
import {
  Roadmap,
  RoadmapUnit,
  addOpenItem,
  addUnits,
  archiveFinishedRoadmap,
  coverage,
  emptyRoadmap,
  loadRoadmap,
  markBlocked,
  markDone,
  markDropped,
  markStarted,
  nextUnits,
  progress,
  renderRoadmap,
  reopen,
  roadmapPath,
  notifyRoadmapChanged,
  saveRoadmap,
  setConventions,
  unitTaskPrompt,
  validateRoadmap,
  waitingUnits,
} from "./roadmap.js";
import { coverageFiles, scanReference } from "./referenceInventory.js";
import { checkRequirements, type Checked } from "./existence.js";
import { looksEssential, type QuestionMode } from "./planner.js";
import { ModelCall, Question, answersAsConventions, proposeChanges, synthesizeIdea, synthesizePort } from "./roadmapPlan.js";

export interface FlowDeps {
  repoRoot: string;
  complete: ModelCall;
  /** Asks the person one question. Absent when nobody can answer. */
  ask?: (q: Question) => Promise<string>;
  /** Which open points are asked (see QuestionMode). Defaults to "essential": only what is hard to undo. */
  questionMode?: QuestionMode;
}

/** After this many failed attempts a unit is parked as blocked instead of retried forever. */
export const MAX_UNIT_ATTEMPTS = 3;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

async function askAll(deps: FlowDeps, questions: Question[]): Promise<{ question: string; answer: string }[]> {
  const out: { question: string; answer: string }[] = [];
  if (!deps.ask) return out;
  for (const q of questions.slice(0, 5)) {
    try {
      out.push({ question: q.question, answer: (await deps.ask(q)).trim() });
    } catch {
      // an unanswered question is recorded as an assumption below
    }
  }
  return out;
}

/**
 * The roadmap's open points, handled by the same policy as a task's plan: the few worth a person's time are asked (when
 * someone is there), and every other one is decided, written down, and never waits.
 */
export async function settleQuestions(
  deps: FlowDeps,
  questions: Question[]
): Promise<{ answered: { question: string; answer: string }[]; decided: { question: string; answer: string; essential: boolean }[] }> {
  const mode = deps.questionMode ?? "essential";
  const toAsk: Question[] = [];
  const decided: { question: string; answer: string; essential: boolean }[] = [];
  for (const q of questions.slice(0, mode === "all" ? 5 : 40)) {
    const essential = looksEssential(q);
    if (mode === "all" || (mode === "essential" && essential && deps.ask)) toAsk.push(q);
    else decided.push({ question: q.question, answer: q.options[0] ?? "decide it from the request and the code, and say what was chosen", essential });
  }
  return { answered: await askAll(deps, toAsk), decided };
}

export interface CreateResult {
  ok: boolean;
  text: string;
  roadmap?: Roadmap;
}

/** Plans a whole job into a roadmap, from a reference folder, an idea, or both, and saves it. */
export async function createRoadmap(
  deps: FlowDeps,
  args: { goal: string; referenceDir?: string; docs?: string; replace?: boolean; verifyExisting?: boolean }
): Promise<CreateResult> {
  // A roadmap that is all done is put away first, so the new job starts clean instead of being told to "add to" a finished one.
  archiveFinishedRoadmap(deps.repoRoot);
  const existing = loadRoadmap(deps.repoRoot);
  if (existing && !args.replace) {
    const p = progress(existing);
    return {
      ok: false,
      text:
        `A roadmap already exists ("${existing.goal.slice(0, 80)}": ${p.done}/${p.total} done). ` +
        `Add to it with "/roadmap add <what to add>", or start over with "/roadmap reset".`,
    };
  }

  let synth;
  let inventory;
  const answered: { question: string; answer: string }[] = [];
  const decided: { question: string; answer: string; essential: boolean }[] = [];
  if (args.referenceDir) {
    inventory = scanReference(deps.repoRoot, args.referenceDir);
    if (inventory.files.length === 0) return { ok: false, text: `There are no source files under "${args.referenceDir}" to plan from.` };
    synth = await synthesizePort({ goal: args.goal, inventory, complete: deps.complete, docs: args.docs });
    const settled = await settleQuestions(deps, synth.questions);
    answered.push(...settled.answered);
    decided.push(...settled.decided);
  } else {
    synth = await synthesizeIdea({ goal: args.goal, complete: deps.complete, docs: args.docs });
    if (synth.questions.length > 0) {
      const settled = await settleQuestions(deps, synth.questions);
      answered.push(...settled.answered);
      decided.push(...settled.decided);
      if (answered.length + decided.length > 0) {
        // The plan is redone knowing the answers, so it is built on what the user wants, not a guess.
        const again = await synthesizeIdea({
          goal: args.goal,
          complete: deps.complete,
          docs: args.docs,
          answers: [
            ...answered.map((a) => `${a.question} -> ${a.answer}`),
            ...decided.map((a) => `${a.question} -> ${a.answer} (decided for you: nobody was asked)`),
          ],
        });
        if (again.drafts.length > 0) synth = again;
      }
    }
  }
  if (synth.drafts.length === 0) {
    return { ok: false, text: `I could not turn that into a roadmap${synth.warnings.length ? `: ${synth.warnings.join("; ")}` : ""}.` };
  }

  // A request that lists numbered jobs IS the roadmap: one unit per job, in the order given, each depending on the one before.
  // Grouping a reference folder's files instead loses the jobs, their order and what each must report.
  const listed = splitJobs(args.goal);
  const byJobs = listed.jobs.length >= 2;
  if (byJobs) {
    const wantsReport = /\breport\b/i.test(listed.preamble);
    let prev: string | undefined;
    const drafts = listed.jobs.map((j) => {
      const title = shortTitle(`Job ${j.n}: ${j.text.split(/\.\s|\n/)[0]}`, 90);
      const draft = {
        title,
        area: "Requested jobs",
        summary: `Do only job ${j.n} of ${listed.jobs.length} from the request. ${j.text}`,
        deps: prev ? [prev] : [],
        acceptance: wantsReport ? ["Report what changed, the tests run with their counts, and anything that could not be verified."] : [],
      };
      prev = title;
      return draft;
    });
    synth = { ...synth, drafts, warnings: [...synth.warnings, `Planned as the ${listed.jobs.length} jobs listed in the request, in that order.`] };
  }

  // Before the roadmap is written: which of these units does the project already have? Those are not planned again.
  let checked: Checked[] = [];
  if (!args.referenceDir && !byJobs && args.verifyExisting !== false) {
    try {
      const drafts = synth.drafts.slice(0, 40);
      checked = await checkRequirements({
        call: deps.complete,
        repoRoot: deps.repoRoot,
        requirements: drafts.map((d, i) => ({ id: `R${i + 1}`, text: `${d.title}. ${d.summary ?? ""} ${(d.acceptance ?? []).join("; ")}`.replace(/\s+/g, " ").trim().slice(0, 240), terms: [] })),
      });
    } catch {
      checked = [];
    }
  }

  const rm = emptyRoadmap(args.goal, args.referenceDir ? (args.docs ? "mixed" : "port") : "idea");
  if (inventory && !byJobs) rm.reference = { dir: inventory.dir, fileCount: coverageFiles(inventory).length, scannedAt: new Date().toISOString() };
  const unasked = synth.questions.filter((q) => !answered.some((a) => a.question === q.question) && !decided.some((d) => d.question === q.question));
  setConventions(rm, [
    ...synth.conventions,
    ...answersAsConventions(answered),
    // Decided from the request and the code, and listed so they can be corrected in one go.
    ...decided.map((d) => `${d.essential ? "REVIEW: " : ""}Decided without asking: ${d.question} -> ${d.answer}`),
    // What nobody could be asked is written down as an assumption, not buried.
    ...synth.assumptions.map((a) => `Assumed, not confirmed: ${a}`),
    ...unasked.map((q) => `Open question, nobody was available to answer: ${q.question}`),
  ]);
  const added = addUnits(rm, synth.drafts, "plan");
  let already = 0;
  let partly = 0;
  checked.forEach((c, i) => {
    const d = synth.drafts[i];
    const unit = d && added.added.find((u) => u.title === d.title.replace(/\s+/g, " ").trim().slice(0, 100));
    if (!unit) return;
    if (c.verdict === "built") {
      markDone(rm, unit.id, { files: c.evidence.map((e) => e.file), summary: `Already built, verified in the code: ${c.evidence[0].file}` });
      already++;
    } else if (c.verdict === "partial") {
      unit.summary = `${unit.summary} Already in place: ${c.evidence[0].file}. Still missing: ${c.missing || "see the code"}.`.slice(0, 600);
      partly++;
    }
  });
  const issues = validateRoadmap(rm);
  saveRoadmap(deps.repoRoot, rm);

  const notes = [...synth.warnings, ...added.warnings, ...issues];
  let cover = "";
  if (inventory && !byJobs) {
    const c = coverage(rm, coverageFiles(inventory));
    cover = c.uncovered.length === 0 ? `\nEvery one of the ${rm.reference!.fileCount} reference files belongs to a unit.` : `\n${c.uncovered.length} reference file(s) belong to no unit.`;
  }
  return {
    ok: true,
    roadmap: rm,
    text: `${renderRoadmap(rm, { maxUnits: 40 })}${cover}${already || partly ? `\nChecked against the existing code: ${already} unit(s) are already built (marked done, with the file as evidence) and ${partly} are partly built (the roadmap says what is missing).` : ""}${notes.length ? `\n\nNotes:\n${notes.slice(0, 8).map((n) => `- ${n}`).join("\n")}` : ""}`,
  };
}

/** "Add X" / "drop Y": the model proposes, the harness applies and saves. */
export async function changeRoadmap(deps: FlowDeps, request: string): Promise<string> {
  const rm = loadRoadmap(deps.repoRoot);
  if (!rm) return `There is no roadmap yet. Make one with "/roadmap new <what to build>" or "/roadmap port <folder> <goal>".`;
  const lines = rm.units.map((u) => `${u.id} [${u.status}] ${u.area}: ${u.title}`);
  const changes = await proposeChanges({ request, roadmapLines: lines, complete: deps.complete });
  if (!changes || (changes.add.length === 0 && changes.drop.length === 0)) return `I did not find anything to change on the roadmap for that${changes?.note ? `: ${changes.note}` : "."}`;

  const out: string[] = [];
  const res = addUnits(rm, changes.add, "user");
  if (res.added.length) out.push(`Added: ${res.added.map((u) => `${u.id} ${u.title}`).join("; ")}`);
  if (res.updated.length) out.push(`Updated: ${res.updated.map((u) => `${u.id} ${u.title}`).join("; ")}`);
  if (res.skipped.length) out.push(`Already done, left alone: ${res.skipped.join("; ")}`);
  for (const d of changes.drop) {
    const u = rm.units.find((x) => x.id.toLowerCase() === d.id.toLowerCase());
    if (!u) out.push(`No unit ${d.id}; ignored`);
    else if (u.status === "done") out.push(`${u.id} is already done; not dropped`);
    else {
      markDropped(rm, u.id, d.reason);
      out.push(`Dropped ${u.id} ${u.title}${d.reason ? ` (${d.reason})` : ""}`);
    }
  }
  const issues = validateRoadmap(rm);
  saveRoadmap(deps.repoRoot, rm);
  return [...out, ...res.warnings.map((w) => `Note: ${w}`), ...issues.map((i) => `Needs attention: ${i}`)].join("\n");
}

export interface Started {
  unit: RoadmapUnit;
  prompt: string;
}

/** The next unit that can run, marked in progress and turned into the task text. */
export function startNext(repoRoot: string): { started?: Started; reason?: string } {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return { reason: "There is no roadmap yet." };
  const [unit] = nextUnits(rm, 1);
  if (!unit) {
    const p = progress(rm);
    if (p.total > 0 && p.done === p.total) return { reason: "Every unit on the roadmap is done." };
    const blocked = rm.units.filter((u) => u.status === "blocked");
    if (blocked.length > 0) return { reason: `Nothing can start: ${blocked.length} unit(s) are blocked (${blocked.slice(0, 3).map((u) => u.id).join(", ")}). Reopen one with "/roadmap reopen <id>" once it is sorted out.` };
    const w = waitingUnits(rm)[0];
    return { reason: w ? `Nothing can start: ${w.unit.id} waits for ${w.waitingFor.map((u) => u.id).join(", ")}.` : "Nothing left to run." };
  }
  markStarted(rm, unit.id);
  saveRoadmap(repoRoot, rm);
  return { started: { unit, prompt: unitTaskPrompt(rm, unit) } };
}

/** What a finished unit leaves behind, so the units after it build on it. */
export function finishUnit(repoRoot: string, id: string, evidence: { commit?: string; files?: string[]; summary?: string; openItems?: string[] }): void {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return;
  markDone(rm, id, evidence);
  saveRoadmap(repoRoot, rm);
}

/** A failed attempt leaves the unit resumable; after enough of them it is parked, with the reason. */
export function failUnit(repoRoot: string, id: string, reason: string): { parked: boolean } {
  const rm = loadRoadmap(repoRoot);
  const u = rm?.units.find((x) => x.id === id);
  if (!rm || !u || u.status === "done") return { parked: false };
  const parked = u.attempts >= MAX_UNIT_ATTEMPTS;
  if (parked) markBlocked(rm, id, `Failed ${u.attempts} times. Last: ${reason}`);
  else u.blockedReason = `Last attempt failed: ${reason.slice(0, 200)}`;
  saveRoadmap(repoRoot, rm);
  return { parked };
}

/**
 * A plan too big for one task used to leave its overflow as lines in a queue
 * that "no" deleted. They become units instead: the current plan is the unit in
 * progress (or the one already running), and the rest follow it in order.
 * Returns the id of the unit the current task is.
 */
/** A title cut at a word, with an ellipsis, instead of in the middle of one. The full text stays in the unit's summary. */
export function shortTitle(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

export function absorbOverflow(
  repoRoot: string,
  args: { goal: string; planGoal: string; followUps: string[]; currentUnitId?: string }
): { currentUnitId: string; added: number } {
  archiveFinishedRoadmap(repoRoot);
  const rm = loadRoadmap(repoRoot) ?? emptyRoadmap(args.goal, "overflow");
  let current = args.currentUnitId ? rm.units.find((u) => u.id === args.currentUnitId) : undefined;
  if (!current) {
    const res = addUnits(rm, [{ title: args.planGoal || args.goal, area: "Current task", summary: args.goal }], "plan");
    current = res.added[0] ?? res.updated[0];
    if (current) markStarted(rm, current.id);
  }
  let prev = current?.title;
  let added = 0;
  for (const f of args.followUps) {
    const title = shortTitle(f);
    if (!title) continue;
    const r = addUnits(rm, [{ title, area: "Follow-up", summary: f.trim().slice(0, 600), deps: prev ? [prev] : [] }], "overflow");
    if (r.added.length > 0) added++;
    prev = title;
  }
  saveRoadmap(repoRoot, rm);
  return { currentUnitId: current?.id ?? "", added };
}

/**
 * Work an agent was told to leave out of the task it is on (a scope question, answered by the task's own definition):
 * it goes on the roadmap as a unit, so it is remembered and done later instead of widening this task or being lost.
 * The same follow-up twice is one unit. Returns the unit's id, or undefined when there was nothing to record.
 */
export function recordFollowUp(repoRoot: string, followUp: string, goal: string): string | undefined {
  const title = shortTitle(followUp);
  if (!title) return undefined;
  archiveFinishedRoadmap(repoRoot);
  const rm = loadRoadmap(repoRoot) ?? emptyRoadmap(goal, "overflow");
  const r = addUnits(rm, [{ title, area: "Follow-up", summary: followUp.trim().slice(0, 600) }], "overflow");
  saveRoadmap(repoRoot, rm);
  return (r.added[0] ?? r.updated[0])?.id;
}

export interface Drift {
  /** Reference files added since the roadmap was made that no unit covers. */
  uncovered: string[];
  /** Files a unit covers that are no longer in the reference. */
  gone: string[];
  /** Finished units whose files are no longer in the project. */
  doneMissing: { id: string; title: string; missing: string[] }[];
}

/** Has the world moved under the roadmap? Read-only. */
export function checkDrift(repoRoot: string): Drift | undefined {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return undefined;
  const drift: Drift = { uncovered: [], gone: [], doneMissing: [] };
  if (rm.reference) {
    const inv = scanReference(repoRoot, rm.reference.dir);
    const c = coverage(rm, coverageFiles(inv));
    drift.uncovered = c.uncovered;
    drift.gone = c.unknown;
  }
  for (const u of rm.units) {
    if (u.status !== "done" || !u.done) continue;
    const missing = u.done.files.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
    if (missing.length > 0) drift.doneMissing.push({ id: u.id, title: u.title, missing: missing.slice(0, 6) });
  }
  return drift;
}

/** New reference files become units, so they cannot be forgotten; returns how many units were added. */
export function absorbUncovered(repoRoot: string, uncovered: string[], perUnit = 30): number {
  const rm = loadRoadmap(repoRoot);
  if (!rm || uncovered.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < uncovered.length; i += perUnit) {
    const refs = uncovered.slice(i, i + perUnit);
    const r = addUnits(rm, [{ title: `New reference files (${Math.floor(i / perUnit) + 1})`, area: "Added to the reference", summary: `These reference files appeared after the roadmap was made: ${refs.slice(0, 5).join(", ")}${refs.length > 5 ? "..." : ""}`, refs }], "user");
    n += r.added.length;
  }
  saveRoadmap(repoRoot, rm);
  return n;
}

export function describeDrift(d: Drift): string[] {
  const out: string[] = [];
  if (d.uncovered.length > 0) out.push(`${d.uncovered.length} reference file(s) were added since the roadmap was made and no unit covers them (run "/roadmap sync" to add them).`);
  if (d.gone.length > 0) out.push(`${d.gone.length} file(s) a unit covers are no longer in the reference.`);
  for (const m of d.doneMissing.slice(0, 4)) out.push(`${m.id} ${m.title} is marked done, but ${m.missing.length} of its files are gone: ${m.missing.slice(0, 3).join(", ")}.`);
  return out;
}

// -------------------------------------------------------------- commands

export type RoadmapCommand =
  | { kind: "show" }
  | { kind: "new"; goal: string }
  | { kind: "port"; dir: string; goal: string }
  | { kind: "run" }
  | { kind: "add"; request: string }
  | { kind: "drop"; id: string; reason: string }
  | { kind: "reopen"; id: string }
  | { kind: "done"; id: string }
  | { kind: "open"; id: string; note: string }
  | { kind: "sync" }
  | { kind: "reset" }
  | { kind: "help" };

/** "/roadmap ..." arguments, parsed. Anything unclear is help, never a guess. */
export function parseRoadmapCommand(args: string): RoadmapCommand {
  const a = args.trim();
  if (!a) return { kind: "show" };
  const [word, ...rest] = a.split(/\s+/);
  const tail = rest.join(" ").trim();
  switch (word.toLowerCase()) {
    case "show":
    case "status":
      return { kind: "show" };
    case "new":
    case "create":
    case "plan":
      return tail ? { kind: "new", goal: tail } : { kind: "help" };
    case "port": {
      const [dir, ...g] = rest;
      return dir && g.length > 0 ? { kind: "port", dir: norm(dir), goal: g.join(" ") } : { kind: "help" };
    }
    case "run":
    case "next":
    case "continue":
    case "resume":
      return { kind: "run" };
    case "add":
      return tail ? { kind: "add", request: tail } : { kind: "help" };
    case "drop":
    case "remove": {
      const [id, ...why] = rest;
      return id && /^U\d+$/i.test(id) ? { kind: "drop", id: id.toUpperCase(), reason: why.join(" ") } : { kind: "help" };
    }
    case "reopen":
      return rest[0] && /^U\d+$/i.test(rest[0]) ? { kind: "reopen", id: rest[0].toUpperCase() } : { kind: "help" };
    case "done":
      return rest[0] && /^U\d+$/i.test(rest[0]) ? { kind: "done", id: rest[0].toUpperCase() } : { kind: "help" };
    case "open":
    case "note": {
      const [id, ...note] = rest;
      return id && /^U\d+$/i.test(id) && note.length > 0 ? { kind: "open", id: id.toUpperCase(), note: note.join(" ") } : { kind: "help" };
    }
    case "sync":
      return { kind: "sync" };
    case "reset":
      return { kind: "reset" };
    default:
      return { kind: "help" };
  }
}

export const ROADMAP_HELP = [
  "Roadmap commands:",
  "  /roadmap                      where things stand",
  "  /roadmap new <what to build>  plan a whole job from an idea",
  "  /roadmap port <folder> <goal> plan a rebuild from a reference folder",
  "  /roadmap run                  start the next unit",
  "  /roadmap add <what to add>    add to it (or say what to drop)",
  "  /roadmap drop <id> [reason]   leave a unit out",
  "  /roadmap reopen <id>          put a blocked or failed unit back",
  "  /roadmap done <id>            mark a unit done by hand",
  "  /roadmap open <id> <note>     record something a done unit left open",
  "  /roadmap sync                 add reference files that appeared since",
  "  /roadmap reset                throw the roadmap away",
].join("\n");

/** Marks done or reopens by hand; the rest need a model or the run loop. */
export function manualUpdate(repoRoot: string, cmd: RoadmapCommand): string {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return "There is no roadmap yet.";
  if (cmd.kind === "drop") {
    const u = rm.units.find((x) => x.id === cmd.id);
    if (!u) return `No unit ${cmd.id}.`;
    if (u.status === "done") return `${u.id} is already done.`;
    markDropped(rm, u.id, cmd.reason);
  } else if (cmd.kind === "reopen") {
    if (!reopen(rm, cmd.id)) return `No unit ${cmd.id}.`;
  } else if (cmd.kind === "done") {
    if (!markDone(rm, cmd.id, { summary: "Marked done by hand." })) return `No unit ${cmd.id}.`;
  } else if (cmd.kind === "open") {
    if (!addOpenItem(rm, cmd.id, cmd.note)) return `${cmd.id} is not a finished unit.`;
  } else return "";
  saveRoadmap(repoRoot, rm);
  if (cmd.kind === "open") return `Noted on ${cmd.id}.`;
  return `${cmd.kind === "drop" ? "Dropped" : cmd.kind === "reopen" ? "Reopened" : "Marked done"} ${cmd.id}.`;
}

export function resetRoadmap(repoRoot: string): boolean {
  try {
    // A roadmap that got anywhere is kept as a record before it is cleared: what its done units built is still what the audit
    // starts from. One with nothing done has nothing to keep.
    const rm = loadRoadmap(repoRoot);
    if (rm && rm.units.some((u) => u.status === "done")) {
      const dir = path.join(repoRoot, ".agent", "roadmaps");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${rm.createdAt.replace(/[^0-9A-Za-z]+/g, "-")}-reset.json`), JSON.stringify(rm, null, 2), "utf-8");
    }
    fs.rmSync(roadmapPath(repoRoot), { force: true });
    notifyRoadmapChanged(repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the classifier decided about the roadmap, as a command. The wording of the
 * request was understood by a model, so there is nothing to match here. If it did
 * not say what it wanted, showing where things stand is harmless and useful.
 */
export function commandFromIntent(action: unknown, request: unknown): RoadmapCommand {
  const text = typeof request === "string" ? request.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (action === "run") return { kind: "run" };
  if (action === "add" && text) return { kind: "add", request: text };
  if (action === "drop" && text) return { kind: "add", request: `drop: ${text}` };
  return { kind: "show" };
}
