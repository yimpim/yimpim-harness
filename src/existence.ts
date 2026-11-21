/**
 * Check what already exists before building anything. A request or a spec is split into requirements; for each one the
 * project is searched for the code that would implement it; a model judges from that code, and every claim of
 * "already built" must carry a quote that really appears, word for word, in a real source file. Only what is partial
 * or missing is then planned. If everything is already there, nothing is built.
 *
 * Models read and judge; code finds the candidate code, checks every quote against the file, and decides what a verdict
 * is worth. "Built" means the code is present, not that it works: QA is still the check for behaviour.
 */
import { collectFiles, type FileText } from "./securityAudit.js";
import type { BuiltUnit } from "./roadmap.js";

export type Msg = { role: "system" | "user"; content: string };
export type Call = (messages: Msg[]) => Promise<string>;

export type Verdict = "built" | "partial" | "missing" | "unclear" | "manual";

export interface Requirement {
  id: string;
  text: string;
  /** Identifiers, routes, UI strings or file names that would appear in the code if it exists. */
  terms: string[];
  /** The section of the document it comes from, as the document titles it (audits only). */
  group?: string;
  /** It is one of the document's own done / acceptance / "do not ship without" checklist items (audits only). */
  doneList?: boolean;
  /**
   * What would show it is done (audits only). "test": the requirement is that a test or check EXISTS or passes, so test files are
   * the evidence. "manual": a procedure a person must run or report (a manual test on a server, an owner decision): no code can show it.
   * Anything else is a requirement on the code itself.
   */
  kind?: "test" | "manual";
}

export interface Evidence {
  file: string;
  quote: string;
}

export interface Checked {
  req: Requirement;
  verdict: Verdict;
  evidence: Evidence[];
  /** For a partial one: what is still missing. */
  missing: string;
  note: string;
}

export interface ExistenceResult {
  /** False when the request is not about features existing (a bug fix, a refactor, a question). */
  applies: boolean;
  items: Checked[];
  /** Every requirement is built, with verified evidence: there is nothing to do. */
  allBuilt: boolean;
  note: string;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// "reference" folders hold the other app being ported from (an Android copy, a design export), which is the SOURCE of a
// requirement, never proof that this project has it. Matched by whole folder name: "preferences/" is not one.
// The same, for a requirement that is ABOUT a test: test files are then the evidence, everything else stays out.
const NOT_EVIDENCE_TESTS_OK = /(^|\/)(fixtures?|mocks?|examples?|samples?|docs?|node_modules|dist|build|references?|[\w-]+_reference|android-ui)\/|\.(stories|min)\.[a-z]+$/i;
const NOT_EVIDENCE = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|mocks?|examples?|samples?|docs?|node_modules|dist|build|references?|[\w-]+_reference|android-ui)\/|\.(test|spec|stories|min)\.[a-z]+$/i;

// ---------------------------------------------------------------------------
// 1. the requirements
// ---------------------------------------------------------------------------

export const EXTRACT_SYSTEM =
  "You decide whether a software request is about FEATURES or BEHAVIOUR that should exist in an app: a new feature, a screen, a flow, an integration, or a spec describing what the app should be. " +
  "It is NOT (answer applies=false) if it is a bug fix, a crash or error to repair, a refactor or rename, a dependency or config change, a test-only task, a question, or a visual tweak to one existing element. " +
  "If it applies, list up to 12 independent requirements, each specific and checkable against code (one behaviour each; split compound sentences; keep the user's own words where they matter). " +
  "For each, give up to 6 search terms: identifiers, route or screen names, UI strings, file names that would appear in the code IF it exists (the way a developer would name them). " +
  'Respond ONLY with JSON: {"applies": true|false, "requirements": [{"text": "", "terms": []}]}';

/**
 * Used when the person asked how much of a document is DONE ("did we finish everything in the brief?"). The extractor above treats a
 * question as "not a feature request" and stands down, which silently turned an audit into a build. Here the document IS the list of
 * what should exist, whatever the wording, and every requirement in it is listed.
 */
export const EXTRACT_AUDIT_SYSTEM =
  "The person wants to know how much of a body of work is DONE. The document they named (a brief, spec, roadmap or list of requirements) is the list of what should exist in the app; their wording is only a question about it. " +
  "Answer applies=true whenever the document describes things the app should do or show, and applies=false only if it has no such requirements (or no document was given). " +
  "List EVERY distinct requirement in the document, each specific and checkable against code (one behaviour each; split compound sentences; keep the document's own words where they matter). Leave out text that only says how to work (process, rules, notes to the developer). " +
  "For each, give up to 6 search terms: identifiers, route or screen names, UI strings, file names that would appear in the code IF it exists (the way a developer would name them). " +
  'Give each requirement a "kind": "test" when the requirement is that a test, check or replay EXISTS or PASSES (the evidence is a test file); "manual" when it is a procedure a person must run or report (a manual test on a server, an owner decision, a note to the developer about process) that no code can show; otherwise "code". ' +
  'Also give each requirement "group": the title of the section of the document it comes from, short and as the document words it. Set "doneList": true on a requirement that is one of the document\'s OWN explicit done / acceptance / ship checklist items (a list the document itself says must be satisfied), and false on everything else. ' +
  'Respond ONLY with JSON: {"applies": true|false, "requirements": [{"text": "", "terms": [], "group": "", "doneList": false, "kind": "code"}]}';

/** A section title for display: cut at a word, with an ellipsis, never mid-word. */
function groupTitle(v: unknown): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= 70) return t;
  const cut = t.slice(0, 70);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:(-]+$/, "") + "…";
}

export function parseRequirements(text: string, max = 12): { applies: boolean; requirements: Requirement[] } | null {
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
  if (!j || typeof j !== "object") return null;
  const requirements: Requirement[] = (Array.isArray(j.requirements) ? j.requirements : [])
    .map((r: any) => ({
      text: clip(r?.text, 240),
      terms: (Array.isArray(r?.terms) ? r.terms : []).map((t: unknown) => clip(t, 40)).filter((t: string) => t.length >= 3).slice(0, 6),
      group: groupTitle(r?.group),
      doneList: r?.doneList === true,
      kind: r?.kind === "test" || r?.kind === "manual" ? (r.kind as "test" | "manual") : undefined,
    }))
    .filter((r: { text: string }) => r.text)
    .slice(0, max)
    .map((r: { text: string; terms: string[]; group: string; doneList: boolean; kind?: "test" | "manual" }, i: number) => ({
      id: `R${i + 1}`,
      text: r.text,
      terms: r.terms,
      ...(r.group ? { group: r.group } : {}),
      ...(r.doneList ? { doneList: true } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
    }));
  return { applies: j.applies === true && requirements.length > 0, requirements };
}

// ---------------------------------------------------------------------------
// 2. finding the code that would implement a requirement
// ---------------------------------------------------------------------------

const STOP = new Set(["that", "this", "with", "from", "have", "when", "will", "should", "must", "able", "user", "users", "their", "there", "which", "each", "also", "into", "than", "then", "they", "been", "being", "about", "after", "before", "where", "while", "shows", "show", "page", "screen", "app", "feature", "ability", "allow", "allows", "support", "supports", "using", "used", "make", "makes", "need", "needs", "want", "wants", "like", "such", "some", "more", "most", "only", "other", "over", "under", "both"]);

export function wordsOf(text: string): string[] {
  const split = text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(split.filter((w) => w.length >= 4 && !STOP.has(w)))];
}

export interface Candidate {
  file: string;
  score: number;
  /** Numbered lines around the best matches, so a quote can be copied exactly. */
  snippet: string;
}

const count = (hay: string, needle: string, cap: number): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** The files most likely to implement a requirement, with the matching lines. Test, doc and generated files are not candidates. */
export function findCandidates(req: Requirement, files: FileText[], lower: Map<string, string>, boost: Set<string> = new Set(), maxFiles = 4, deep = false, strong: Set<string> = new Set()): Candidate[] {
  const notEvidence = req.kind === "test" ? NOT_EVIDENCE_TESTS_OK : NOT_EVIDENCE;
  const terms = req.terms.map((t) => t.toLowerCase());
  const words = wordsOf(req.text);
  const scored: { f: FileText; score: number }[] = [];
  for (const f of files) {
    if (notEvidence.test(f.rel) || /\.(json|lock)$/i.test(f.rel)) continue;
    const text = lower.get(f.rel)!;
    const path = f.rel.toLowerCase();
    let score = 0;
    for (const t of terms) {
      score += Math.min(5, count(text, t, 5)) * 3;
      if (path.includes(t.replace(/[^a-z0-9]/g, ""))) score += 5;
    }
    for (const w of words) {
      score += Math.min(3, count(text, w, 3));
      if (path.includes(w)) score += 2;
    }
    if (boost.has(f.rel)) score += 4;
    if (strong.has(f.rel)) score += 15;
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFiles).map(({ f, score }) => ({ file: f.rel, score, snippet: deep ? windows(f.text, [...terms, ...words], 16, 7000, 5) : windows(f.text, [...terms, ...words]) }));
}

/** Up to two windows of numbered lines around the lines that match the most terms. */
export function windows(text: string, terms: string[], radius = 12, maxChars = 2400, count = 2): string {
  const lines = text.split(/\r?\n/);
  const low = lines.map((l) => l.toLowerCase());
  // A comment that mentions the feature is a weaker lead than the code that does it.
  const hits = low.map((l, i) => ({ i, n: terms.reduce((s, t) => s + (l.includes(t) ? 1 : 0), 0) * (COMMENT_LINE.test(lines[i]) ? 0.3 : 1) })).filter((h) => h.n > 0).sort((a, b) => b.n - a.n);
  const picked: number[] = [];
  for (const h of hits) {
    if (picked.every((p) => Math.abs(p - h.i) > radius * 2)) picked.push(h.i);
    if (picked.length === count) break;
  }
  if (picked.length === 0) picked.push(0);
  picked.sort((a, b) => a - b);
  const out = picked.map((p) => {
    const from = Math.max(0, p - radius);
    return lines.slice(from, Math.min(lines.length, p + radius + 1)).map((l, k) => `${from + k + 1}: ${l.slice(0, 200)}`).join("\n");
  });
  return out.join("\n...\n").slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// 3. the verdicts, and what a verdict is worth
// ---------------------------------------------------------------------------

export const JUDGE_SYSTEM =
  "You judge whether requirements are ALREADY implemented in an existing app, using ONLY the code excerpts given for each (numbered lines from real files). " +
  "built: the code clearly implements the whole requirement (not just something related or similar). " +
  "partial: some of it exists AND a specific piece is clearly absent from the code you can see; say exactly what that piece is. missing: no relevant code in the excerpts. " +
  "unclear: the requirement is too vague to judge, OR the excerpts are too short to see all of it. An excerpt being short is never a reason for partial: if you simply cannot see whether a part exists, answer unclear and say which part to look for. Never write that 'the excerpt does not show' something in the missing field. " +
  "Be strict: related code is not an implementation. For built and partial you MUST give evidence: one to three quotes, each copied EXACTLY (one or two lines, no line numbers) from an excerpt, with its file. A quote must be executable code (a function, a route, a config key, a handler), never a comment, docstring or documentation: a comment describing a feature is not the feature. A quote that is not in the excerpts, or is only a comment, will be rejected and the verdict downgraded. " +
  'Respond ONLY with JSON: {"results": [{"id": "R1", "verdict": "built"|"partial"|"missing"|"unclear", "evidence": [{"file": "", "quote": ""}], "missing": "what is not there yet (partial)", "note": "one sentence"}]}';

/**
 * The last look, for what excerpts could not settle: the judge is given COMPLETE files, one at a time, with every requirement that points at
 * that file. Short excerpts of a 2,000-line file were leaving more than half of a long brief as "could not tell"; that is the check's
 * nearsightedness, not a fact about the app.
 */
export const JUDGE_WHOLE_SYSTEM =
  "You are shown ONE complete source file (every line, numbered) and several requirements. A requirement is usually implemented across SEVERAL files, and you only see this one: report what THIS file contributes. " +
  "built: this file ALONE implements the whole requirement. " +
  "partial: this file clearly implements part of it; quote that part, and say which part it does not cover (another file may). Do NOT use partial just because something is absent here. " +
  "missing: nothing in this file relates to the requirement. " +
  "unclear: it depends on code outside this file; say which. " +
  "Be strict: related code is not an implementation. For built and partial you MUST give one to three quotes copied EXACTLY (one or two lines, no line numbers) from this file; a quote must be executable code, never a comment. " +
  'Respond ONLY with JSON: {"results": [{"id": "R1", "verdict": "built"|"partial"|"missing"|"unclear", "evidence": [{"file": "", "quote": ""}], "missing": "the part this file does not cover (partial)", "note": "one sentence"}]}';

/**
 * Then the findings from the several files are put together. A file lacking a piece says nothing about the project: the piece may sit in another file
 * that was read. No code is sent here, only what each file was found to contribute, and every quote must still exist in the project.
 */
export const JUDGE_COMBINE_SYSTEM =
  "Several COMPLETE source files were each judged against ONE requirement; each finding says what that file contributes. A file that lacks a piece says nothing about the project: the piece may be in another of these files. Decide from all the findings together. " +
  "built: together the findings show the whole requirement is implemented. " +
  "partial: some of it is implemented AND a specific piece is not found in ANY of these files; say exactly which piece. " +
  "unclear: the findings cannot show it. " +
  "For built and partial give one to three quotes, each copied EXACTLY from the quotes in the findings, with its file. " +
  'Respond ONLY with JSON: {"results": [{"id": "R1", "verdict": "built"|"partial"|"unclear", "evidence": [{"file": "", "quote": ""}], "missing": "the piece not found in any file (partial)", "note": "one sentence"}]}';

const VERDICTS: Verdict[] = ["built", "partial", "missing", "unclear"];

export interface Raw {
  id: string;
  verdict: Verdict;
  evidence: Evidence[];
  missing: string;
  note: string;
}

export function parseVerdicts(text: string): Raw[] {
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
  return (Array.isArray(j?.results) ? j.results : [])
    .map((r: any) => ({
      id: String(r?.id ?? ""),
      verdict: VERDICTS.includes(r?.verdict) ? r.verdict : "unclear",
      evidence: (Array.isArray(r?.evidence) ? r.evidence : []).map((e: any) => ({ file: String(e?.file ?? "").replace(/\\/g, "/").replace(/^\.?\//, ""), quote: String(e?.quote ?? "") })).slice(0, 3),
      missing: clip(r?.missing, 240),
      note: clip(r?.note, 200),
    }))
    .filter((r: Raw) => r.id);
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?![a-z]+\s*[{:])|<!--|--\s|;|"""|''')/;

/** Does the quote contain any line of actual code, not only comments or docstrings? */
export const hasCode = (quote: string): boolean => quote.split(/\r?\n/).some((l) => l.trim() && !COMMENT_LINE.test(l));

/** A quote counts only if it is real: in a source file the project has, word for word, long enough to mean something, and code. */
export function validQuotes(evidence: Evidence[], byRel: Map<string, string>, testsOk = false): Evidence[] {
  const notEvidence = testsOk ? NOT_EVIDENCE_TESTS_OK : NOT_EVIDENCE;
  return evidence.filter((e) => {
    const q = norm(e.quote);
    if (q.length < 12 || q.length > 400 || notEvidence.test(e.file) || !hasCode(e.quote)) return false;
    const content = byRel.get(e.file);
    return content !== undefined && norm(content).includes(q);
  });
}

/** What a verdict is worth after the quotes are checked: built and partial both need at least one real quote. */
/** "Partial" whose only reason is that the excerpt was short: not evidence that anything is absent. */
export const SHORT_EXCERPT = /\b(excerpts?|snippets?|shown|visible|supplied|provided)\b[^.]{0,60}\b(not|n't|no|never|without)\b[^.]{0,40}\b(show|establish|include|contain|confirm|demonstrate|reveal)|\b(does|do) not (show|establish|confirm|include)\b/i;

export function settle(raw: Raw, req: Requirement, byRel: Map<string, string>): Checked {
  const evidence = validQuotes(raw.evidence, byRel, req.kind === "test");
  if (raw.verdict === "partial" && SHORT_EXCERPT.test(raw.missing)) {
    return { req, verdict: "unclear", evidence, missing: "", note: `Not seen in the code that was checked (not shown to be absent): ${raw.missing}`.slice(0, 240) };
  }
  if ((raw.verdict === "built" || raw.verdict === "partial") && evidence.length === 0) {
    return { req, verdict: "unclear", evidence: [], missing: "", note: `Claimed ${raw.verdict} but gave no quote that exists in a source file, so it is not counted as built. ${raw.note}`.trim().slice(0, 240) };
  }
  return { req, verdict: raw.verdict, evidence, missing: raw.verdict === "partial" ? raw.missing : "", note: raw.note };
}

/** The done units whose title or summary overlaps a requirement most: what the roadmap says built it. */
export function unitsFor(req: Requirement, built: BuiltUnit[], max = 2): BuiltUnit[] {
  const want = new Set([...wordsOf(req.text), ...req.terms.flatMap((t) => wordsOf(t))]);
  return built
    .map((u) => ({ u, n: wordsOf(`${u.title} ${u.summary}`).filter((w) => want.has(w)).length }))
    .filter((x) => x.n >= 3)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((x) => x.u);
}

const roadmapNote = (units: BuiltUnit[]) =>
  units.length === 0
    ? ""
    : `\nThe roadmap recorded this as built by: ${units.map((u) => `${u.id} "${u.title}"${u.commit ? ` (commit ${u.commit.slice(0, 8)})` : ""}, files: ${u.files.slice(0, 6).join(", ") || "none listed"}${u.openItems.length ? `; left open: ${u.openItems.join(" | ")}` : ""}`).join("; ")}. This is a lead, not proof: confirm it from the code, and quote the code.`;

export interface CheckOptions {
  call: Call;
  /**
   * A cheaper model for the FIRST look at each requirement (short excerpts; its "built" answers need a quote that really is in a source file, which is checked in code, so
   * it cannot invent evidence). Anything it does not settle, and a sample of what it does, goes to `call`. Unset: `call` does everything, as before.
   */
  cheapCall?: Call;
  /** What earlier roadmaps recorded as done: searched first, and told to the judge as a lead. */
  built?: BuiltUnit[];
  /** Folders (relative) that hold material being ported from, never evidence: the roadmap's reference folder. */
  exclude?: string[];
  repoRoot: string;
  requirements: Requirement[];
  /** Files the project's own map ranks for this request: they are searched first. */
  shortlist?: string[];
  files?: FileText[];
}

/** Checks each requirement against the code. Never throws: a requirement the model could not judge is "unclear". */
export async function checkRequirements(o: CheckOptions): Promise<Checked[]> {
  // Big central files (an index or a main) are where wiring lives, so they are searched too.
  const skip = (o.exclude ?? []).map((d) => d.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  const files = (o.files ?? collectFiles(o.repoRoot, 4000, 1_500_000)).filter((f) => {
    const rel = f.rel.toLowerCase();
    return !skip.some((d) => rel === d || rel.startsWith(d + "/"));
  });
  const byRel = new Map(files.map((f) => [f.rel, f.text]));
  const lower = new Map(files.map((f) => [f.rel, f.text.toLowerCase()]));
  const boost = new Set((o.shortlist ?? []).map((p) => p.replace(/\\/g, "/")));
  const leads = new Map(o.requirements.map((r) => [r.id, unitsFor(r, o.built ?? [])]));
  const strongFor = (r: Requirement) => new Set(leads.get(r.id)!.flatMap((u) => u.files.map((f) => f.replace(/\\/g, "/"))));
  const out = new Map<string, Checked>();
  // A manual step (a test to run on a server, a decision for the owner) is not something the code can show: it is neither built nor missing.
  for (const r of o.requirements.filter((x) => x.kind === "manual")) {
    out.set(r.id, { req: r, verdict: "manual", evidence: [], missing: "", note: "A person has to do and report this; the code cannot show it." });
  }
  // A requirement that names a file inside the reference folder is about the source being ported FROM, never about this project's code: it cannot be found here.
  const inReference = (r: Requirement) => skip.some((d) => r.text.toLowerCase().replace(/\\/g, "/").includes(d + "/"));
  for (const r of o.requirements.filter((x) => x.kind !== "manual" && inReference(x))) {
    out.set(r.id, { req: r, verdict: "manual", evidence: [], missing: "", note: "It names a file in the reference folder, which is the source being ported from, not code this project has; it cannot be checked against the code." });
  }
  const withCode = o.requirements.filter((r) => r.kind !== "manual" && !out.has(r.id)).map((req) => ({ req, cands: findCandidates(req, files, lower, boost, 4, false, strongFor(req)) }));
  // A requirement that matches no code at all is missing: no model needs to be asked, and an empty project costs nothing.
  const asked = withCode.filter(({ req, cands }) => {
    if (cands.length > 0) return true;
    out.set(req.id, { req, verdict: "missing", evidence: [], missing: "", note: "No code in the project matched it." });
    return false;
  });
  // Every batch is independent of the others, so they are all asked at once: a long brief is as quick to check as its slowest batch.
  const firstBatches: (typeof asked)[] = [];
  for (let i = 0; i < asked.length; i += 4) firstBatches.push(asked.slice(i, i + 4));
  await Promise.all(firstBatches.map(async (chunk) => {
    const user = chunk
      .map(({ req, cands }) => `### ${req.id}: ${req.text}${roadmapNote(leads.get(req.id)!)}\n${cands.map((c) => `--- ${c.file}\n${c.snippet}`).join("\n")}`)
      .join("\n\n");
    let raws: Raw[] = [];
    try {
      raws = parseVerdicts(await (o.cheapCall ?? o.call)([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }]));
    } catch {
      raws = [];
    }
    for (const { req, cands } of chunk) {
      const raw = raws.find((r) => r.id === req.id);
      if (!raw) {
        out.set(req.id, { req, verdict: "unclear", evidence: [], missing: "", note: "The check could not be completed for this one." });
        continue;
      }
      let c = settle(raw, req, byRel);
      // "missing" while the project has code that matched strongly is worth a second look, not a rebuild.
      if (c.verdict === "missing" && cands.length > 0 && cands[0].score >= 25) c = { ...c, note: `${c.note} (code that matched closely was found in ${cands[0].file}, so check before rebuilding)`.trim() };
      out.set(req.id, c);
    }
  }));

  // The cheaper model's "built" answers are checked in code (the quote must be in the file), but whether the quote really satisfies the requirement is judgement. A sample is
  // asked again of the stronger model: every fifth one, and any whose only evidence is a very short quote. Where it disagrees, its answer replaces the first one.
  if (o.cheapCall) {
    const builtNow = asked.filter(({ req }) => out.get(req.id)?.verdict === "built");
    const spot = builtNow.filter(({ req }, i) => i % 5 === 0 || Math.min(...out.get(req.id)!.evidence.map((x) => x.quote.length)) < 40);
    const spotBatches: (typeof spot)[] = [];
    for (let i = 0; i < spot.length; i += 4) spotBatches.push(spot.slice(i, i + 4));
    await Promise.all(spotBatches.map(async (chunk) => {
      const user = chunk
        .map(({ req, cands }) => `### ${req.id}: ${req.text}${roadmapNote(leads.get(req.id)!)}\n${cands.map((c) => `--- ${c.file}\n${c.snippet}`).join("\n")}`)
        .join("\n\n");
      let raws: Raw[] = [];
      try {
        raws = parseVerdicts(await o.call([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }]));
      } catch {
        raws = [];
      }
      for (const { req } of chunk) {
        const raw = raws.find((r) => r.id === req.id);
        if (!raw) continue; // no answer from the stronger model: the first one stands
        const c = settle(raw, req, byRel);
        if (c.verdict !== "built") out.set(req.id, { ...c, note: `${c.note} (a second model did not confirm the first model's "built")`.trim() });
      }
    }));
  }

  // Anything not clearly built gets a second look at much more of the code (more files, longer excerpts) before it is called
  // work: a first look that saw four short excerpts is not enough to say a requirement is only partly there.
  const rank: Record<Verdict, number> = { built: 3, partial: 2, unclear: 1, missing: 0, manual: 0 };
  const again = o.requirements.filter((r) => {
    const c = out.get(r.id);
    return c && (c.verdict === "partial" || c.verdict === "unclear") && c.note !== "No code in the project matched it.";
  });
  const deepFor = new Map(again.map((req) => [req.id, findCandidates(req, files, lower, boost, 8, true, strongFor(req))]));
  const secondBatches: (typeof again)[] = [];
  for (let i = 0; i < again.length; i += 2) secondBatches.push(again.slice(i, i + 2));
  await Promise.all(secondBatches.map(async (chunk) => {
    const user = chunk
      .map((req) => `### ${req.id}: ${req.text}\n(Earlier, short excerpts were not enough to decide. These are longer.)${roadmapNote(leads.get(req.id)!)}\n${deepFor.get(req.id)!.map((c) => `--- ${c.file}\n${c.snippet}`).join("\n")}`)
      .join("\n\n");
    let raws: Raw[] = [];
    try {
      raws = parseVerdicts(await o.call([{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }]));
    } catch {
      raws = [];
    }
    for (const req of chunk) {
      const raw = raws.find((r) => r.id === req.id);
      if (!raw) continue;
      const c = settle(raw, req, byRel);
      if (rank[c.verdict] > rank[out.get(req.id)!.verdict]) out.set(req.id, c);
      else if (c.verdict === out.get(req.id)!.verdict && c.verdict === "partial") out.set(req.id, c);
    }
  }));

  // Whatever is still partly built or undecided is read against the whole of its closest files. A file is sent once, with every
  // requirement that points at it, so a big file costs one read however many requirements are about it.
  const undecided = o.requirements.filter((r) => {
    const c = out.get(r.id);
    return c && (c.verdict === "partial" || c.verdict === "unclear") && c.note !== "No code in the project matched it.";
  });
  const filesOf = new Map(undecided.map((req) => [req.id, findCandidates(req, files, lower, boost, 3, false, strongFor(req)).map((c) => c.file)]));
  const askedAbout = new Map<string, Requirement[]>();
  for (const req of undecided) for (const file of filesOf.get(req.id)!) askedAbout.set(file, [...(askedAbout.get(file) ?? []), req]);
  const seen = new Map<string, { file: string; c: Checked }[]>();
  await Promise.all(
    [...askedAbout].map(async ([file, reqs]) => {
      const numbered = byRel.get(file)!.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`).join("\n");
      const user = `The file ${file} (complete):\n${numbered}\n\nThe requirements to judge against it:\n${reqs.map((r) => `### ${r.id}: ${r.text}`).join("\n")}`;
      let raws: Raw[] = [];
      try {
        raws = parseVerdicts(await o.call([{ role: "system", content: JUDGE_WHOLE_SYSTEM }, { role: "user", content: user }]));
      } catch {
        raws = [];
      }
      for (const req of reqs) {
        const raw = raws.find((r) => r.id === req.id);
        if (raw) seen.set(req.id, [...(seen.get(req.id) ?? []), { file, c: settle(raw, req, byRel) }]);
      }
    })
  );
  await Promise.all(
    undecided.map(async (req) => {
      const got = seen.get(req.id) ?? [];
      const built = got.find((g) => g.c.verdict === "built");
      if (built) {
        out.set(req.id, built.c);
        return;
      }
      if (got.length === 0) return;
      const asked = filesOf.get(req.id)!;
      if (got.length === asked.length && got.every((g) => g.c.verdict === "missing")) {
        out.set(req.id, { req, verdict: "missing", evidence: [], missing: "", note: `Not in the ${got.length} closest file${got.length === 1 ? "" : "s"}, which were read in full.` });
        return;
      }
      const contributing = got.filter((g) => g.c.verdict === "partial");
      if (contributing.length === 0) return; // nothing positive was found in any of them: stays as it was
      if (got.length === 1 || contributing.length === 1 && asked.length === 1) {
        if (rank.partial >= rank[out.get(req.id)!.verdict]) out.set(req.id, contributing[0].c);
        return;
      }
      // Several files each hold part of it (or lack it): decide from the findings together, never from one file's absence.
      const findings = got
        .map(({ file, c }) => `- ${file}: ${c.verdict}.${c.missing ? ` Not covered here: ${c.missing}` : ""}${c.note ? ` ${c.note}` : ""}${c.evidence.length ? `\n    quotes:\n${c.evidence.map((e) => `      ${e.file}: ${e.quote}`).join("\n")}` : ""}`)
        .join("\n");
      let raws: Raw[] = [];
      try {
        raws = parseVerdicts(await o.call([{ role: "system", content: JUDGE_COMBINE_SYSTEM }, { role: "user", content: `### ${req.id}: ${req.text}\n${findings}` }]));
      } catch {
        raws = [];
      }
      const raw = raws.find((r) => r.id === req.id);
      const combined = raw ? settle(raw, req, byRel) : undefined;
      if (combined && (combined.verdict === "built" || combined.verdict === "partial") && rank[combined.verdict] >= rank[out.get(req.id)!.verdict]) {
        out.set(req.id, combined);
      } else if (rank.partial >= rank[out.get(req.id)!.verdict]) {
        out.set(req.id, contributing[0].c);
      }
    })
  );
  return o.requirements.map((r) => out.get(r.id)!);
}

// ---------------------------------------------------------------------------
// the check, and what is said about it
// ---------------------------------------------------------------------------

export interface ExistenceArgs {
  call: Call;
  /** See CheckOptions.cheapCall. */
  cheapCall?: Call;
  repoRoot: string;
  request: string;
  /** The text of a spec or brief the request names. */
  docs?: string;
  shortlist?: string[];
  maxRequirements?: number;
  built?: BuiltUnit[];
  exclude?: string[];
  /** The person asked how much of the document is done: it is read whole, every requirement in it is checked, and a question's wording does not stand the check down. */
  audit?: boolean;
  /** Told how many requirements were found, before any of them is checked, so a big document is not a surprise. */
  onRequirements?: (count: number) => void;
}

export async function checkExistence(a: ExistenceArgs): Promise<ExistenceResult> {
  const none: ExistenceResult = { applies: false, items: [], allBuilt: false, note: "" };
  let parsed: ReturnType<typeof parseRequirements> = null;
  try {
    parsed = parseRequirements(
      await a.call([
        { role: "system", content: a.audit ? EXTRACT_AUDIT_SYSTEM : EXTRACT_SYSTEM },
        {
          role: "user",
          content: a.audit
            ? `The question:\n${a.request.slice(0, 3000)}\n\nThe document (the list of what should exist):\n${a.docs ?? "(no document was given)"}`
            : `The request:\n${a.request.slice(0, 3000)}${a.docs ? `\n\nA document the request names (the spec):\n${a.docs.slice(0, 14000)}` : ""}`,
        },
      ]),
      a.audit ? Infinity : (a.maxRequirements ?? 12)
    );
  } catch {
    return { ...none, note: "The requirements could not be extracted, so nothing was checked against the code." };
  }
  if (!parsed || !parsed.applies) return none;
  a.onRequirements?.(parsed.requirements.length);
  const items = await checkRequirements({ call: a.call, cheapCall: a.cheapCall, repoRoot: a.repoRoot, requirements: parsed.requirements, shortlist: a.shortlist, built: a.built, exclude: a.exclude });
  const checkable = items.filter((i) => i.verdict !== "manual");
  return { applies: true, items, allBuilt: checkable.length > 0 && checkable.every((i) => i.verdict === "built"), note: "" };
}

const place = (e: Evidence) => `${e.file}: \`${e.quote.replace(/`/g, "'").slice(0, 110)}\``;

const MARK: Record<Verdict, string> = { built: "✓", partial: "◐", missing: "✗", unclear: "?", manual: "☐" };
const tally = (list: Checked[]): string =>
  (["built", "partial", "missing", "unclear", "manual"] as Verdict[])
    .map((v) => [v, list.filter((i) => i.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v === "missing" ? "not built" : v === "unclear" ? "could not tell" : v === "partial" ? "partly built" : v === "manual" ? "for a person to do" : "built"}`)
    .join(", ") || "none";

/** One line per requirement for the grouped report: what it is, the verdict, and only as much evidence as the verdict needs. */
function groupedLine(c: Checked): string {
  const head = `  ${MARK[c.verdict]} ${c.req.text}`;
  if (c.verdict === "built") return `${head}  [${c.evidence[0]?.file ?? ""}]`;
  if (c.verdict === "partial") return `${head}\n      exists: ${place(c.evidence[0])}\n      still missing: ${c.missing || "see the code"}`;
  return c.note ? `${head}  (${c.note})` : head;
}

/** A document with sections (or its own done-list): by the document's own structure, its done-list first, a tally for each part. */
function renderGrouped(r: ExistenceResult): string {
  const lines: string[] = [`Checked ${r.items.length} requirements: ${tally(r.items)}.`];
  const done = r.items.filter((i) => i.req.doneList);
  if (done.length) lines.push("", `The document's own done-list (${tally(done)}):`, ...done.map(groupedLine));
  const groups = new Map<string, Checked[]>();
  for (const c of r.items.filter((i) => !i.req.doneList)) {
    const g = c.req.group || "Other";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  for (const [g, list] of groups) lines.push("", `${g} (${tally(list)}):`, ...list.map(groupedLine));
  return lines.join("\n");
}

/** The report: what exists, with its evidence, what is partial, what is missing. */
export function renderExistence(r: ExistenceResult): string {
  if (r.items.some((i) => i.req.group || i.req.doneList)) return renderGrouped(r);
  const by = (v: Verdict) => r.items.filter((i) => i.verdict === v);
  const lines: string[] = [];
  const section = (title: string, list: Checked[], detail: (c: Checked) => string) => {
    if (list.length) lines.push(`${title} (${list.length}):`, ...list.map((c) => `  - ${c.req.text}${detail(c)}`));
  };
  section("Already built", by("built"), (c) => `\n      ${place(c.evidence[0])}`);
  section("Partly built", by("partial"), (c) => `\n      exists: ${place(c.evidence[0])}\n      still missing: ${c.missing || "see the code"}`);
  section("Not built", by("missing"), (c) => (c.note ? `  (${c.note})` : ""));
  section("Could not tell", by("unclear"), (c) => (c.note ? `  (${c.note})` : ""));
  section("For a person to do (the code cannot show these)", by("manual"), () => "");
  return lines.join("\n");
}

/** What the Planner is told: reuse what exists, plan only the rest. Empty when nothing was found built or partial. */
export function existencePlannerSection(r: ExistenceResult): string {
  const built = r.items.filter((i) => i.verdict === "built");
  const partial = r.items.filter((i) => i.verdict === "partial");
  if (built.length === 0 && partial.length === 0) return "";
  return (
    "\n\nWhat already exists in this project (verified against the code: each quote was checked against the file). Do NOT rebuild or rewrite it: reuse it, and plan only what is partial or missing.\n" +
    (built.length ? `Already built:\n${built.map((c) => `- ${c.req.text} -> ${place(c.evidence[0])}`).join("\n")}\n` : "") +
    (partial.length ? `Partly built (extend the existing code in place):\n${partial.map((c) => `- ${c.req.text} -> exists in ${place(c.evidence[0])}; still missing: ${c.missing || "see the code"}`).join("\n")}\n` : "") +
    (r.items.some((i) => i.verdict === "missing")
      ? `Not built (these are the work):\n${r.items.filter((i) => i.verdict === "missing").map((c) => `- ${c.req.text}`).join("\n")}\n`
      : "") +
    (r.items.some((i) => i.verdict === "unclear")
      ? `Not determined (the check could not see whether these exist: read the code to decide, and plan work only for what you find is absent; do not rebuild them blindly):\n${r.items.filter((i) => i.verdict === "unclear").map((c) => `- ${c.req.text}${c.note ? ` (${c.note})` : ""}`).join("\n")}\n`
      : "")
  );
}
