/**
 * What the terminal's one live status line says about model calls: for the step that is running (a heal, a repair, a phase's editor), the
 * total time and total tokens so far, which only go up, and, when nothing has come back for a while, how long it has been quiet.
 *
 * A step is many calls (look something up, write the edit, run the test, try again) across however many files at once. A timer per call
 * resets every call and jumps when the oldest of several ends; the person watching wants "how long has this been going and how much has
 * it done", so that is what is counted. The one per-call signal kept is silence: a total that is still climbing is working, a total that
 * has stopped, with time still passing, is a model that has gone quiet. Display only: nothing here is sent to a phone or to a model.
 */

interface Call {
  agent: string;
  model: string;
  /** Characters the model has produced so far: its answer, its thinking, and tool arguments. */
  chars: number;
}

const calls = new Map<number, Call>();
let seq = 0;

/** The step the status line is totalling. */
const step: { since: number | undefined; doneTokens: number; lastActivity: number } = { since: undefined, doneTokens: 0, lastActivity: 0 };

/**
 * Ends the call, counting what it produced as an estimate. `done(tokens)` ends it with the exact count the provider reported;
 * `progress(chars)` is told how much the model has produced so far (the stream calls it per chunk).
 */
export type CallTracker = (() => void) & { progress: (chars: number, now?: number) => void; done: (completionTokens?: number) => void };

/** Roughly four characters to a token. Only an estimate while a call runs: the real count arrives when it finishes. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);

/** Registers a call; the returned function ends it (safe to call more than once). */
export function trackCall(agent: string, model: string, now = Date.now()): CallTracker {
  const id = ++seq;
  const call: Call = { agent, model, chars: 0 };
  calls.set(id, call);
  if (step.since === undefined) {
    step.since = now;
    step.doneTokens = 0;
  }
  step.lastActivity = now;
  let ended = false;
  const finish = (tokens: number) => {
    if (ended) return;
    ended = true;
    step.doneTokens += tokens;
    calls.delete(id);
  };
  const end = (() => finish(estimateTokens(call.chars))) as CallTracker;
  end.done = (completionTokens?: number) => finish(typeof completionTokens === "number" && completionTokens >= 0 ? completionTokens : estimateTokens(call.chars));
  end.progress = (chars: number, at = Date.now()) => {
    if (chars > call.chars) step.lastActivity = at;
    call.chars = chars;
  };
  return end;
}

export function liveCallCount(): number {
  return calls.size;
}

/** True while a step is being totalled, including the gaps between its calls (a test file running, a decision being made). */
export function stepActive(): boolean {
  return step.since !== undefined;
}

/** Starts a fresh total: the step that was running is over. Calls still in flight are counted from now. */
export function resetStep(now = Date.now()): void {
  step.since = calls.size > 0 ? now : undefined;
  step.doneTokens = 0;
  step.lastActivity = now;
}

const shortModel = (m: string): string => m.split("/").pop() ?? m;

/** 850 -> "850", 7000 -> "7.0k": one decimal from a thousand up, so the width barely changes as it counts. */
export function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(Math.round(n / 100) / 10).toFixed(1)}k`;
}

/** 45 -> "45s", 90 -> "1m 30s", 120 -> "2m 00s", 3725 -> "1h 02m 05s": seconds to 59, then minutes. */
export function formatElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  const two = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m ${two(s % 60)}s`;
}

/** A silence shorter than this is a model thinking, not a problem, and is not mentioned. */
export const QUIET_AFTER_SECS = 15;

/** "2m 10s · ↓ ~3.2k tokens", plus " · quiet 45s" when calls are in flight and nothing has come back for a while. */
export function describeTotals(now = Date.now()): string | undefined {
  if (step.since === undefined) return undefined;
  let live = 0;
  for (const c of calls.values()) live += c.chars;
  const tokens = step.doneTokens + estimateTokens(live);
  const quiet = calls.size > 0 ? Math.floor((now - step.lastActivity) / 1000) : 0;
  return [
    formatElapsed((now - step.since) / 1000),
    tokens > 0 ? `↓ ~${formatTokens(tokens)} tokens` : "waiting",
    ...(quiet >= QUIET_AFTER_SECS ? [`quiet ${formatElapsed(quiet)}`] : []),
  ].join(" · ");
}

/** "REPAIR ×2 · deepseek-v4.1-flash-1017": who is being waited on right now (the model only when they all use the same one). */
export function describeLiveCalls(): string | undefined {
  if (calls.size === 0) return undefined;
  const byAgent = new Map<string, number>();
  const models = new Set<string>();
  for (const c of calls.values()) {
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + 1);
    models.add(c.model);
  }
  const who = [...byAgent].map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(", ");
  return models.size === 1 ? `${who} · ${shortModel([...models][0])}` : who;
}

const FRAMES = ["   ", ".  ", ".. ", "..."];
/** Three characters wide at every step, so the line does not jitter as the dots come and go. */
export function dots(now = Date.now()): string {
  return FRAMES[Math.floor(now / 500) % FRAMES.length];
}

/**
 * The text for the pinned status line: what the run is on (a phase and persona), the totals for the step, and what is being waited on.
 * With nothing running and no step under way it is the plain "… running…" it always was.
 */
export function composeStatus(base: string | undefined, now = Date.now(), maxWidth = Infinity): string | undefined {
  const who = describeLiveCalls();
  const totals = describeTotals(now);
  if (!who && !totals) return base ? `${base} running…` : undefined;
  // Between calls (a test file running, a decision being made) the totals keep counting and nothing is being waited on.
  const tail = who ? `calling ${who} · ${totals}${dots(now)}` : `${totals}…`;
  if (!base) return tail;
  const sep = " running · ";
  // The tail is what moves, so when the line is too wide it is the phase name that gives way, never the tail.
  const room = maxWidth - sep.length - tail.length;
  if (room >= base.length) return `${base}${sep}${tail}`;
  if (room >= 12) return `${base.slice(0, room - 1)}…${sep}${tail}`;
  return tail;
}
