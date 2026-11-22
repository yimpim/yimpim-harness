/**
 * Structured event stream (NDJSON).
 *
 * With `--json`, one JSON object per line goes to stdout and all human-readable
 * logging is redirected to stderr, so stdout stays machine-parseable. This is
 * the integration surface: an IDE plugin, CI job or dashboard consumes these
 * events instead of re-implementing orchestration.
 *
 * Contract for consumers:
 *  - Every event has `v`, `seq`, `ts`, `type`.
 *  - `seq` increases by 1, so a consumer can detect dropped lines.
 *  - Unknown event types must be ignored, not treated as errors — new types
 *    will be added without a version bump.
 */

import process from "node:process";

export const EVENT_SCHEMA_VERSION = 1;

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** Actual billed USD for this one call, from OpenRouter itself (real
   *  per-provider pricing, not a hardcoded table) — undefined when a
   *  provider/route didn't report it, distinct from a genuinely free $0 call. */
  cost?: number;
  /** Of the prompt tokens, how many the provider served from its prompt cache (OpenRouter's prompt_tokens_details.cached_tokens). Undefined when the route did not report it. */
  cached?: number;
}

export type YimpimEvent =
  | { type: "question.timedOut"; id: string; answer: string; kind: string }
  | { type: "run.start"; runId: string; repoRoot: string; command: string; task?: string }
  | { type: "run.end"; ok: boolean; phasesCompleted: number; phasesTotal: number; durationMs: number; usage: UsageReport }
  | { type: "plan.ready"; runId: string; goal: string; degraded: boolean; phases: { id: string; name: string; goal: string; executor?: string }[] }
  | { type: "phase.start"; phaseId: string; name: string; goal: string; index: number; total: number; executor?: string }
  | { type: "phase.end"; phaseId: string; name: string; passed: boolean; confidence?: string; attempts: number }
  | {
      type: "agent.start";
      agent: string;
      models: string[];
      /** Set when this run is a corrective/retry pass of an earlier worker,
       *  not REPAIR (which is its own distinct step) — e.g. the Planner
       *  being asked to fix a plan that failed validation, or to re-plan
       *  after the user answered clarifying questions. `retryOf` names the
       *  earlier worker's `workerId` (minted at translation time, so it is
       *  threaded in from the caller rather than known here). */
      retryOf?: string;
      attempt?: number;
      reason?: string;
      /** Set only for agent === "ADVISOR" — links this worker.start/end pair
       *  to the same /ask exchange's advisor.start/advisor.answer events, so
       *  an old phone build (which only ever knew worker.start/end for
       *  ADVISOR) still gets a correlation id without needing the new kinds. */
      exchangeId?: string;
    }
  | {
      type: "agent.end";
      agent: string;
      rounds: number;
      outcome: string;
      exchangeId?: string;
      /**
       * This worker's OWN usage — every model.call recorded between the
       * matching agent.start and this agent.end, regardless of what "agent"
       * label individual calls inside it used. Computed and injected by
       * EventBus.emit() itself (see its own comment), never set by the
       * caller — a caller that emits "agent.end" with these fields already
       * present would have them overwritten. This is what fixes QA's cost
       * reading as $0 on a paired phone: QA's own worker.start/worker.end
       * both say agent "QA", but its three internal calls are individually
       * labeled "VERIFIER"/"verifier-nav"/"verifier-visual" (for usage-
       * tiering and test-routing purposes — see askJson/decideNextNavStep/
       * auditScreenshots in verifierTools.ts) and a phone matching cost to
       * worker cards by agent-label string never found any of them. Summing
       * by WORKER LIFETIME instead of by label match needs no such match at
       * all, and covers every future case the same way, not just this one.
       */
      tokensUsed?: number;
      costUsd?: number;
      /** How long this worker ran, from its agent.start to this agent.end. Set by EventBus.emit(), like the usage above. */
      elapsedMs?: number;
    }
  | { type: "model.call"; agent: string; model: string; ok: boolean; elapsedMs: number; usage?: TokenUsage; error?: string }
  | { type: "tool.call"; agent: string; tool: string; target?: string }
  | { type: "tool.result"; agent: string; tool: string; ok: boolean; bytes: number }
  | { type: "gate.result"; tier: string; gate: string; status: string; blocking: boolean; detail: string; artifacts?: string[] }
  | { type: "verdict"; passed: boolean; confidence: string; blockingFailures: string[]; advisories: string[] }
  | { type: "question"; kind: "blocking" | "deferred"; question: string; answered: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "error"; message: string; fatal: boolean }
  | {
      type: "file.write";
      agent: string;
      path: string;
      created: boolean;
      added: number;
      removed: number;
      /** Keys the full diff text in diffStore.ts, so a paired phone can fetch
       *  it on demand later without every write shipping its diff eagerly. */
      changeId: string;
    }
  /** An /ask exchange began — emitted right before the ADVISOR agent runs,
   *  so a client can open an "Advisor" card immediately instead of only
   *  learning about the exchange once the answer is already in hand.
   *  `exchangeId` links this to the matching advisor.answer and to the
   *  ADVISOR worker.start/end pair (see agent.start's own `exchangeId`). */
  | { type: "advisor.start"; exchangeId: string; question: string }
  /** The read-only advisor's final answer to an /ask — its own event so a
   *  paired phone gets the exact text instead of guessing which untagged
   *  `log` line (among the advisor's tool-call activity) was actually it. */
  | { type: "advisor.answer"; question: string; answer: string; exchangeId?: string }
  /** Manual steps flagged this task (agentTools.ts's ManualStep, inlined here
   *  rather than imported so events.ts stays dependency-light) — the "before
   *  this is actually live, you need to..." list, as its own event for the
   *  same reason advisor.answer is: it was only ever an untagged `log` block,
   *  indistinguishable from everything else printed around it. Only emitted
   *  when non-empty. */
  | { type: "manual.steps"; steps: { step: string; reason: string; phase?: string }[] };

export interface UsageBucket {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  /** Sum of every call's cost that actually reported one. */
  cost: number;
  /** True once at least one call in this bucket reported a cost — lets a
   *  summary tell "$0.0000 known" apart from "cost never reported here". */
  costKnown: boolean;
}

export interface UsageReport {
  /** Totals per agent role, which is what reveals whether model tiering pays off. */
  byAgent: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  totals: UsageBucket;
}

class EventBus {
  private seq = 0;
  private enabled = false;
  private startedAt = Date.now();
  private subscribers = new Set<(event: YimpimEvent) => void>();

  private usage: UsageReport = {
    byAgent: {},
    byModel: {},
    totals: { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, costKnown: false },
  };

  // Snapshot taken the moment the currently-active worker's agent.start
  // fires, consumed (and cleared) the moment its agent.end fires — see
  // emit()'s own handling of both. Workers run strictly sequentially system-
  // wide (never two agent.start without an intervening agent.end), so a
  // single scalar is enough; there is nothing to stack.
  private currentWorkerUsageStart: UsageReport | undefined;
  private currentWorkerStartedAt: number | undefined;

  /**
   * Notified on every emit() regardless of `enabled` — unlike the gated
   * NDJSON stdout write below, this is the hook a same-process consumer
   * (the remote phone bridge) uses to observe events during a normal
   * interactive session, where `enabled` is never turned on (that's reserved
   * for `--json` batch mode, which rebinds console.log itself and would
   * conflict with the phone's own console.log mirroring). Returns an
   * unsubscribe function.
   */
  onEmit(cb: (event: YimpimEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Turn on NDJSON output. Human logs move to stderr so stdout carries only
   * events — console.log is rebound rather than audited call-by-call.
   */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.startedAt = Date.now();

    const toStderr =
      (level: "info" | "warn" | "error") =>
      (...args: unknown[]) => {
        const message = args
          .map((a) => (typeof a === "string" ? a : safeStringify(a)))
          .join(" ");
        process.stderr.write(message + "\n");
        // Mirror into the stream so a consumer sees progress text too.
        this.emit({ type: "log", level, message });
      };

    console.log = toStderr("info");
    console.info = toStderr("info");
    console.warn = toStderr("warn");
    console.error = toStderr("error");
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  emit(event: YimpimEvent): void {
    // Scopes usage to this worker's own lifetime, regardless of what "agent"
    // label its individual model.call()s used internally (see agent.end's
    // own doc comment on tokensUsed/costUsd for why that matters) — computed
    // here, once, rather than leaving every subscriber to reconstruct it.
    if (event.type === "agent.start") {
      this.currentWorkerUsageStart = this.usageReport();
      this.currentWorkerStartedAt = Date.now();
    } else if (event.type === "agent.end" && this.currentWorkerStartedAt !== undefined) {
      event.elapsedMs = Math.max(0, Date.now() - this.currentWorkerStartedAt);
      this.currentWorkerStartedAt = undefined;
    }
    if (event.type === "agent.end" && this.currentWorkerUsageStart) {
      const delta = this.usageDelta(this.currentWorkerUsageStart).totals;
      event.tokensUsed = delta.total;
      if (delta.costKnown) event.costUsd = delta.cost;
      this.currentWorkerUsageStart = undefined;
    }

    for (const cb of this.subscribers) cb(event);
    if (!this.enabled) return;
    const line = safeStringify({
      v: EVENT_SCHEMA_VERSION,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      ...event,
    });
    process.stdout.write(line + "\n");
  }

  /** Record token usage even when the stream is off, so totals are always available. */
  recordUsage(agent: string, model: string, usage?: TokenUsage): void {
    if (!usage) return;
    const bump = (bucket: Record<string, UsageBucket>, key: string) => {
      const e = (bucket[key] ??= { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, costKnown: false });
      e.calls++;
      e.prompt += usage.prompt;
      e.completion += usage.completion;
      e.total += usage.total;
      if (usage.cost !== undefined) {
        e.cost += usage.cost;
        e.costKnown = true;
      }
    };
    bump(this.usage.byAgent, agent || "unknown");
    bump(this.usage.byModel, model);
    this.usage.totals.calls++;
    this.usage.totals.prompt += usage.prompt;
    this.usage.totals.completion += usage.completion;
    this.usage.totals.total += usage.total;
    if (usage.cost !== undefined) {
      this.usage.totals.cost += usage.cost;
      this.usage.totals.costKnown = true;
    }
    for (const cb of this.usageSubscribers) {
      try {
        cb(agent || "unknown", model, usage);
      } catch {
        // A subscriber (the lifetime ledger) must never break a model call.
      }
    }
  }

  private usageSubscribers = new Set<(agent: string, model: string, usage: TokenUsage) => void>();

  /**
   * Notified once per recorded model call, whether or not the NDJSON stream is
   * on. The lifetime usage ledger hangs off this: recordUsage is the single
   * choke point every call goes through, so nothing (including /ask and
   * Discovery, which run outside any phase) can be missed. Returns an
   * unsubscribe function.
   */
  onUsage(cb: (agent: string, model: string, usage: TokenUsage) => void): () => void {
    this.usageSubscribers.add(cb);
    return () => this.usageSubscribers.delete(cb);
  }

  usageReport(): UsageReport {
    return JSON.parse(JSON.stringify(this.usage));
  }

  /**
   * Usage recorded since an earlier snapshot (from usageReport()). A session
   * that loops back to the prompt after a successful run can run several
   * unrelated tasks in one process, all sharing this same cumulative
   * tracker — without this, a task's own "done" summary would silently
   * include every earlier task's spend too.
   */
  usageDelta(since: UsageReport): UsageReport {
    type Bucket = Record<string, UsageBucket>;
    const emptyEntry: UsageBucket = { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0, costKnown: false };
    const diffEntry = (cur: UsageBucket, prev: UsageBucket): UsageBucket => ({
      calls: cur.calls - prev.calls,
      prompt: cur.prompt - prev.prompt,
      completion: cur.completion - prev.completion,
      total: cur.total - prev.total,
      cost: cur.cost - prev.cost,
      // Known if EITHER side ever saw a cost — a bucket that only existed
      // before the snapshot (prev.costKnown) still means cost is/was known
      // for this key, and one that only appeared after still counts too.
      costKnown: cur.costKnown || prev.costKnown,
    });
    const diffBucket = (current: Bucket, before: Bucket): Bucket => {
      const out: Bucket = {};
      for (const [key, cur] of Object.entries(current)) {
        const d = diffEntry(cur, before[key] ?? emptyEntry);
        if (d.calls > 0) out[key] = d;
      }
      return out;
    };

    return {
      byAgent: diffBucket(this.usage.byAgent, since.byAgent),
      byModel: diffBucket(this.usage.byModel, since.byModel),
      totals: diffEntry(this.usage.totals, since.totals),
    };
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Human-readable usage summary for the normal (non-JSON) terminal output.
   * Defaults to this whole process's cumulative usage (right for an abort,
   * which cuts across whatever tasks ran); pass a delta from usageDelta()
   * plus a matching label to scope it to just one task instead.
   */
  renderUsage(report?: UsageReport, label = "Token usage this session"): string {
    const { byAgent, totals } = report ?? this.usage;
    if (totals.calls === 0) return "";

    // Cost is opt-in per request (see openrouter.ts) and not every provider
    // reports it — only append the column when this report actually has it,
    // rather than printing a misleading "$0.0000" next to real spend on rows
    // where it's simply unknown.
    const costSuffix = (u: UsageBucket) => (u.costKnown ? `  ${formatCost(u.cost)}` : "");

    const rows = Object.entries(byAgent)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([agent, u]) => `  ${agent.toUpperCase().padEnd(10)} ${String(u.calls).padStart(4)} calls  ${formatTokens(u.total).padStart(10)} tokens${costSuffix(u)}`);

    return [
      "",
      `${label} (use this to check whether model tiering is paying off):`,
      ...rows,
      `  ${"TOTAL".padEnd(10)} ${String(totals.calls).padStart(4)} calls  ${formatTokens(totals.total).padStart(10)} tokens${costSuffix(totals)}`,
      "",
    ].join("\n");
  }
}

/** Shared by the end-of-run summary and any live, per-phase cost readout. */
export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 4 decimal places below a dime, since most individual calls cost fractions
 *  of a cent and 2 decimals would just print "$0.00" for nearly all of them. */
export function formatCost(n: number): string {
  return n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Never let a circular or exotic value break the stream. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      });
    } catch {
      return JSON.stringify(String(value));
    }
  }
}

export const events = new EventBus();
