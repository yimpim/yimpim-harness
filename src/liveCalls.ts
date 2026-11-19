/**
 * Which model calls are in flight right now, for the terminal's one live status line. Several run at once (a heal starts a worker per
 * failing test file), and a line per call every 20 seconds is a wall of near-identical text; one line that says what is being waited
 * on, with moving dots, is enough. Display only: nothing here is sent to a phone or to a model.
 */

interface Call {
  agent: string;
  model: string;
}

const calls = new Map<number, Call>();
let seq = 0;

/** Registers a call; the returned function ends it (safe to call more than once). */
export function trackCall(agent: string, model: string): () => void {
  const id = ++seq;
  calls.set(id, { agent, model });
  return () => {
    calls.delete(id);
  };
}

export function liveCallCount(): number {
  return calls.size;
}

const shortModel = (m: string): string => m.split("/").pop() ?? m;

/** "REPAIR ×2 · deepseek-v4.1-flash-1017", or just the personas when the calls use different models. Undefined when nothing is running. */
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
 * The text for the pinned status line: what the run is on (a phase and persona), and what is being waited on right now.
 * With nothing in flight it is the plain "… running…" it always was.
 */
export function composeStatus(base: string | undefined, now = Date.now(), maxWidth = Infinity): string | undefined {
  const live = describeLiveCalls();
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
