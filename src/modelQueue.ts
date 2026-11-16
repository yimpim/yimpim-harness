/**
 * Changing a model while a task is running.
 *
 * Every call reads `config.models[role]` at the moment it starts, so a change made mid-task must not reach a role that is
 * working: it is held and takes effect the next time that role is read while idle (an Editor that is mid-phase finishes on
 * its current model; the next phase's Editor uses the new one). A role that is not working takes the change at once.
 *
 * The queue replaces each role on `config.models` with an accessor, so no call site changes and `config.models.editor` just
 * answers with whatever is current. A direct assignment (the idle `/model` menu, `set_model` from the phone) still works and
 * discards any queued change for that role.
 */

/** A role and its vision twin share one worker: Editor and EditorVision are both "editor". */
const family = (role: string): string => role.replace(/Vision$/, "");

/** Which config role an agent label runs on. Labels not listed here are treated as idle (a change then applies at once). */
const AGENT_FAMILY: Record<string, string> = {
  DISCOVERY: "discovery",
  PLANNER: "planner",
  REPLAN: "planner",
  EDITOR: "editor",
  REPAIR: "repair",
  VERIFIER: "verifier",
  QA: "verifier",
  "verifier-nav": "verifier",
  "verifier-visual": "verifier",
  DESIGNER: "designer",
  SECURITY: "security",
};

export type QueueResult = "applied" | "queued";
export interface ModelChange {
  role: string;
  /** What the role now uses (applied) or will use (queued); undefined clears an optional role. */
  chain: string[] | undefined;
  when: "applied" | "queued";
}

export class ModelQueue {
  private readonly values = new Map<string, string[] | undefined>();
  /** role -> chain, with `null` meaning "clear". */
  private readonly waiting = new Map<string, string[] | null>();
  private readonly busy = new Map<string, number>();
  private readonly listeners = new Set<(c: ModelChange) => void>();

  constructor(models: Record<string, any>, roles: string[]) {
    for (const role of roles) {
      this.values.set(role, models[role]);
      Object.defineProperty(models, role, {
        enumerable: true,
        configurable: true,
        get: () => {
          this.commitIfIdle(role);
          return this.values.get(role);
        },
        set: (v: string[] | undefined) => {
          // A direct write is an explicit "now": it replaces whatever was waiting for this role.
          this.waiting.delete(role);
          this.values.set(role, v);
          this.emit({ role, chain: v, when: "applied" });
        },
      });
    }
  }

  private isBusy(role: string): boolean {
    return (this.busy.get(family(role)) ?? 0) > 0;
  }

  private commitIfIdle(role: string): void {
    if (!this.waiting.has(role) || this.isBusy(role)) return;
    const next = this.waiting.get(role);
    this.waiting.delete(role);
    this.values.set(role, next ?? undefined);
    this.emit({ role, chain: next ?? undefined, when: "applied" });
  }

  /** Ask for a change. Applied now when the role is idle, otherwise held until it is. */
  queue(role: string, chain: string[] | undefined): QueueResult {
    if (!this.isBusy(role)) {
      this.waiting.delete(role);
      this.values.set(role, chain);
      this.emit({ role, chain, when: "applied" });
      return "applied";
    }
    this.waiting.set(role, chain ?? null);
    this.emit({ role, chain, when: "queued" });
    return "queued";
  }

  /** What is in use right now, without triggering a commit. */
  current(role: string): string[] | undefined {
    return this.values.get(role);
  }

  /** The change waiting for this role, if any (`null` = a clear is waiting). */
  pendingFor(role: string): string[] | null | undefined {
    return this.waiting.get(role);
  }

  hasPending(): boolean {
    return this.waiting.size > 0;
  }

  agentStarted(label: string): void {
    const f = AGENT_FAMILY[label];
    if (f) this.busy.set(f, (this.busy.get(f) ?? 0) + 1);
  }

  agentEnded(label: string): void {
    const f = AGENT_FAMILY[label];
    if (!f) return;
    const n = (this.busy.get(f) ?? 0) - 1;
    if (n > 0) this.busy.set(f, n);
    else {
      this.busy.delete(f);
      // Apply as soon as the role goes idle, not only on its next read, so the strip and log do not lag a whole phase.
      for (const role of [...this.waiting.keys()]) if (family(role) === f) this.commitIfIdle(role);
    }
  }

  onChange(cb: (c: ModelChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(c: ModelChange): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(c);
      } catch {
        // a listener must never break a model read
      }
    }
  }
}

/** The one-line strip shown under the stream: `Models  planner A · editor B→C* …` (`*` = change waiting). */
export function renderModelStrip(queue: ModelQueue, roles: { key: string; label: string }[], show: string[]): string {
  const short = (id: string | undefined): string => (id ? id.split("/").pop()! : "unset");
  const parts: string[] = [];
  for (const r of roles) {
    if (!show.includes(r.key)) continue;
    const now = queue.current(r.key)?.[0];
    const pending = queue.pendingFor(r.key);
    parts.push(
      pending === undefined ? `${r.key} ${short(now)}` : `${r.key} ${short(now)}→${pending === null ? "unset" : short(pending[0])}*`,
    );
  }
  return `Models  ${parts.join(" · ")}${queue.hasPending() ? "   (* applies when that role next starts)" : ""}`;
}
