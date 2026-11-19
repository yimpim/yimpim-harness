/**
 * Which model calls are in flight right now, for the terminal's one live status line. Several run at once (a heal starts a worker per
 * failing test file), and a line per call every 20 seconds is a wall of near-identical text; one line that says what is being waited
 * on, for how long, and whether anything has come back yet, with moving dots, is enough. Display only: nothing here is sent to a
 * phone or to a model.
 */

interface Call {
  agent: string;
  model: string;
  since: number;
  /** Characters the model has produced so far: its answer, its thinking, and tool arguments. */
  chars: number;
}

const calls = new Map<number, Call>();
let seq = 0;

/** Ends the call. `progress` reports how much the model has produced so far (the stream calls it per chunk). */
export type CallTracker = (() => void) & { progress: (chars: number) => void };

/** Registers a call; the returned function ends it (safe to call more than once). */
export function trackCall(agent: string, model: string, now = Date.now()): CallTracker {
  const id = ++seq;
  const call: Call = { agent, model, since: now, chars: 0 };
  calls.set(id, call);
  const end = (() => {
    calls.delete(id);
  }) as CallTracker;
  end.progress = (chars: number) => {
    call.chars = chars;
  };
  return end;
}

export function liveCallCount(): number {
  return calls.size;
}

const shortModel = (m: string): string => m.split("/").pop() ?? m;

/** Roughly four characters to a token. Only an estimate: the real count arrives with the finished call, in its cost line. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);

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

/**
 * "REPAIR ×2 · deepseek-v4.1-flash-1017 · 2m 00s · ↓ ~1.4k tokens": who is being waited on, the longest wait, and how much has come back.
 * Nothing back yet reads "waiting", which tells a model that is thinking or writing from one that has gone silent.
 */
export function describeLiveCalls(now = Date.now()): string | undefined {
  if (calls.size === 0) return undefined;
  const byAgent = new Map<string, number>();
  const models = new Set<string>();
  let oldest = now;
  let chars = 0;
  for (const c of calls.values()) {
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + 1);
    models.add(c.model);
    oldest = Math.min(oldest, c.since);
    chars += c.chars;
  }
  const who = [...byAgent].map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(", ");
  const secs = Math.max(0, Math.floor((now - oldest) / 1000));
  const got = chars > 0 ? `↓ ~${formatTokens(estimateTokens(chars))} tokens` : "waiting";
  return `${models.size === 1 ? `${who} · ${shortModel([...models][0])}` : who} · ${formatElapsed(secs)} · ${got}`;
}

const FRAMES = ["   ", ".  ", ".. ", "..."];
/** Three characters wide at every step, so the line does not jitter as the dots come and go. */
export function dots(now = Date.now()): string {
  return FRAMES[Math.floor(now / 500) % FRAMES.length];
}

/**
 * The text for the pinned status line: what the run is on (a phase and persona), and what is being waited on right now.
 * With nothing in flight it is the plain "… running…" it always was.
 */
export function composeStatus(base: string | undefined, now = Date.now(), maxWidth = Infinity): string | undefined {
  const live = describeLiveCalls(now);
  if (!live) return base ? `${base} running…` : undefined;
  const tail = `calling ${live}${dots(now)}`;
  if (!base) return tail;
  const sep = " running · ";
  // The moving dots are the end of the line, so when the line is too wide it is the phase name that gives way, never the dots.
  const room = maxWidth - sep.length - tail.length;
  if (room >= base.length) return `${base}${sep}${tail}`;
  if (room >= 12) return `${base.slice(0, room - 1)}…${sep}${tail}`;
  return tail;
}
