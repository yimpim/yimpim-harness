/**
 * A request that lists numbered jobs ("1. ... 2. ... 3. ... 4. ...") must not quietly become only the first one. The Planner is
 * told to put every job it does not plan into followUpTasks, but it sometimes writes the narrowing off as an "assumption" and
 * moves on, and the other jobs simply vanish. This reads the numbered list out of the request, checks which jobs the plan
 * actually covers, and hands back the ones it does not, as follow-ups that carry their own context.
 */
import type { Plan } from "./planner.js";

export interface JobList {
  /** Everything before job 1: the shared context ("read X first", "Android is the source of truth"). */
  preamble: string;
  jobs: { n: number; text: string }[];
}

/** The numbered jobs in a request, when it has two or more numbered 1, 2, 3... in order. Otherwise no jobs. */
export function splitJobs(request: string): JobList {
  const marks: { n: number; at: number; end: number }[] = [];
  let expect = 1;
  for (const m of request.matchAll(/(?:^|[\s])(\d{1,2})[.)]\s+(?=\S)/g)) {
    if (Number(m[1]) !== expect) continue;
    const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    marks.push({ n: expect, at, end: (m.index ?? 0) + m[0].length });
    expect++;
  }
  if (marks.length < 2) return { preamble: request.trim(), jobs: [] };
  return {
    preamble: request.slice(0, marks[0].at).trim(),
    jobs: marks.map((mk, i) => ({ n: mk.n, text: request.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : undefined).trim() })),
  };
}

/** The words that name a job: its first sentence, long words only. */
function keyWords(text: string): string[] {
  const first = text.split(/\.\s|\n/)[0] ?? text;
  return [...new Set(first.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 6 && !STOP.has(w)))].slice(0, 8);
}
const STOP = new Set(["should", "please", "before", "after", "through", "because", "whether", "without", "within"]);

/** The plan's own work, not its assumptions: what it will actually do. */
function planText(plan: Plan): string {
  return [plan.goal, ...plan.phases.flatMap((p) => [p.name, p.goal, ...(p.files ?? []), ...(p.newFiles ?? []), ...(p.changes ?? [])])].join(" ").toLowerCase();
}

/**
 * Jobs from a numbered request that the plan does not cover, each written as a standalone follow-up with the request's shared
 * context. A job counts as covered when most of the words naming it appear in the plan's phases.
 */
export function unplannedJobs(request: string, plan: Plan): string[] {
  const { preamble, jobs } = splitJobs(request);
  if (jobs.length < 2) return [];
  const body = planText(plan);
  const have = new Set((plan.followUpTasks ?? []).map((f) => f.toLowerCase()));
  const out: string[] = [];
  for (const job of jobs) {
    const words = keyWords(job.text);
    if (words.length === 0) continue;
    const hits = words.filter((w) => body.includes(w)).length;
    if (hits / words.length >= 0.6) continue;
    const text = `${preamble.slice(0, 900)}\n\nDo only job ${job.n} of ${jobs.length} from that request:\n${job.n}. ${job.text}`.trim().slice(0, 2400);
    if ([...have].some((f) => words.every((w) => f.includes(w)))) continue; // the Planner already queued it
    out.push(text);
  }
  return out;
}
