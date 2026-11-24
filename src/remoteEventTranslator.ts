/**
 * Maps the internal structured event stream (src/events.ts) onto the typed
 * remote wire events (src/remote/protocol.ts's `RemoteEvent`), for whichever
 * subset a paired phone/native client actually benefits from seeing
 * structurally instead of regex-scraping the free-text `log` mirror.
 *
 * Pulled out of src/index.ts as a standalone, side-effect-free function so it
 * can be unit tested directly — index.ts runs its whole CLI on import.
 */

import { YimpimEvent } from "./events.js";

/** The minimal phase shape the translator needs, to avoid importing planner.ts's full PlannedPhase just for three fields. */
export interface PhaseContext {
  id: string;
  name: string;
  verification: string[];
}

export interface TranslatedRemoteEvent {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Returns the wire event to push for a given internal event, or undefined
 * for internal events with no remote-facing counterpart (most of them —
 * `run.start`, `model.call`, `tool.call`, etc. stay purely internal/NDJSON).
 *
 * `taskId` is injected here, at the single translation choke point, the same
 * way `currentPhase` already is — rather than threading it through every
 * individual `events.emit()` call site across index.ts/agentLoop.ts/
 * verifierTools.ts. It identifies which TASK within the current desktop
 * process an event belongs to: `runId` (still present on `status`/
 * `plan.ready`) only identifies the PROCESS, and a single interactive
 * session can run many separate tasks back to back without restarting —
 * each with the same runId, but a genuinely different taskId. A client that
 * reconciled on `runId` alone (the only identifier available before this)
 * merged every task in one process into a single card, which is exactly the
 * "Phase 5/3" symptom (one task's phase list bleeding into the next task's
 * plan) this fixes. The reconciliation key
 * changes from `runId` to `taskId`.
 *
 * `workerId` is injected the same way: minted by the caller when it sees
 * `agent.start` (the only point a fresh id is needed), held steady across
 * every event belonging to that worker's run, and cleared by the caller once
 * `agent.end` fires — so `file.write`/`gate.result`/`verdict` emitted while a
 * worker is actively running inherit the same id without this translator
 * needing to track worker lifetime itself.
 *
 * `taskRunning` is a SEPARATE flag from `taskId` itself: `taskId` is always
 * passed as a plain string (even while idle, in which case it's the
 * just-finished task's stale id) for every kind that predates it, to avoid
 * breaking an old phone's assumption that e.g. `worker.start.taskId` is
 * always present. It is used ONLY by the brand-new `advisor.start`/
 * `advisor.answer` kinds, which have never shipped before and so carry no
 * such back-compat obligation — per the task contract, THESE must omit
 * taskId entirely when no task is running, not fall back to the stale id.
 */
export function translateForRemote(
  event: YimpimEvent,
  currentPhase?: PhaseContext,
  taskId?: string,
  workerId?: string,
  taskRunning?: boolean
): TranslatedRemoteEvent | undefined {
  switch (event.type) {
    case "plan.ready":
      // Same cap reasoning as advisor.answer/manual.steps: bounded per-field
      // length and a generous but finite phase count.
      return {
        kind: "plan.ready",
        payload: {
          taskId,
          runId: event.runId,
          goal: event.goal.slice(0, 2_000),
          degraded: event.degraded,
          phases: event.phases.slice(0, 100).map((p) => ({
            id: p.id,
            name: p.name.slice(0, 500),
            goal: p.goal.slice(0, 2_000),
            ...(p.executor ? { executor: p.executor } : {}),
          })),
        },
      };
    case "phase.start":
      return {
        kind: "phase.start",
        payload: {
          taskId,
          phaseId: event.phaseId,
          name: event.name,
          goal: event.goal,
          index: event.index,
          total: event.total,
          ...(event.executor ? { executor: event.executor } : {}),
        },
      };
    case "phase.end":
      return {
        kind: "phase.end",
        payload: {
          taskId,
          phaseId: event.phaseId,
          name: event.name,
          passed: event.passed,
          confidence: event.confidence,
          attempts: event.attempts,
        },
      };
    case "agent.start": {
      // A background check with no visible result is not a worker card (see events.ts's background).
      if (event.background) return undefined;
      // ADVISOR is the one agent that can run OUTSIDE a task (an /ask asked
      // while idle) — every other agent only ever runs between this task's
      // own taskId mint and its task.end, so `taskId` is never stale for
      // them and keeping it unconditional there preserves the existing
      // back-compat guarantee that worker.start.taskId is always a plain
      // string. ADVISOR gets the same taskRunning gating advisor.start/
      // advisor.answer already use, instead of the just-finished task's
      // stale id — the new fields (exchangeId) carry no such back-compat
      // obligation, so there's nothing to preserve here.
      const workerTaskId = event.agent === "ADVISOR" ? (taskRunning ? taskId : undefined) : taskId;
      return {
        kind: "worker.start",
        payload: {
          taskId: workerTaskId,
          workerId,
          agent: event.agent,
          phaseId: currentPhase?.id,
          phaseName: currentPhase?.name,
          // A security check (a command's review, the post-phase review) belongs to the phase it runs in, or the one just finished
          // when it runs between phases: a phone nests it inside that phase's card instead of opening a card of its own.
          ...(event.agent === "SECURITY" && currentPhase?.id ? { parentPhaseId: currentPhase.id } : {}),
          acceptanceCriteria: currentPhase?.verification,
          retryOf: event.retryOf,
          attempt: event.attempt,
          reason: event.reason,
          exchangeId: event.exchangeId,
        },
      };
    }
    case "agent.end": {
      if (event.background) return undefined;
      const workerTaskId = event.agent === "ADVISOR" ? (taskRunning ? taskId : undefined) : taskId;
      return {
        kind: "worker.end",
        payload: {
          taskId: workerTaskId,
          workerId,
          agent: event.agent,
          outcome: event.outcome,
          exchangeId: event.exchangeId,
          // This worker's own usage (see events.ts's agent.end doc comment)
          // — exact per-card cost with no agent-label-to-worker guessing on
          // the phone's part, unlike status.agentUsage below, which is keyed
          // by call label and can diverge from the worker that actually ran
          // (QA's internal calls are individually labeled VERIFIER/
          // verifier-nav/verifier-visual, not QA).
          tokensUsed: event.tokensUsed,
          costUsd: event.costUsd,
          // How long the worker ran (additive: an older phone build ignores it).
          elapsedMs: event.elapsedMs,
        },
      };
    }
    case "file.write":
      return {
        kind: "file.changed",
        payload: {
          taskId,
          workerId,
          agent: event.agent,
          path: event.path,
          action: event.created ? "created" : "modified",
          added: event.added,
          removed: event.removed,
          changeId: event.changeId,
          phaseId: currentPhase?.id,
        },
      };
    case "gate.result":
      return {
        kind: "gate.result",
        payload: {
          taskId,
          workerId,
          tier: event.tier,
          gate: event.gate,
          status: event.status,
          blocking: event.blocking,
          detail: event.detail,
          artifacts: event.artifacts,
          phaseId: currentPhase?.id,
        },
      };
    case "verdict":
      return {
        kind: "verdict",
        payload: {
          taskId,
          workerId,
          passed: event.passed,
          confidence: event.confidence,
          blockingFailures: event.blockingFailures,
          advisories: event.advisories,
          phaseId: currentPhase?.id,
        },
      };
    case "advisor.start":
      return {
        kind: "advisor.start",
        payload: { exchangeId: event.exchangeId, question: event.question.slice(0, 2_000), taskId: taskRunning ? taskId : undefined },
      };
    case "advisor.answer":
      // Capped so one runaway answer can't flood the encrypted outbox —
      // see client.ts's own MAX_BATCH_BYTES/outbox-cap handling for the
      // limits this stays well under even at the cap.
      return {
        kind: "advisor.answer",
        payload: {
          text: event.answer.slice(0, 32_000),
          question: event.question.slice(0, 2_000),
          exchangeId: event.exchangeId,
          taskId: taskRunning ? taskId : undefined,
        },
      };
    // Maps onto the pre-existing "log" wire kind (level: "error") rather than
    // a new one — the wire contract already has a dedicated slot for exactly
    // this ("an error worth a client's attention, not just scrollback"), it
    // just had no producer wired to it before. The clearest real-world case
    // this exists for: OpenRouter reporting insufficient credits (see
    // openrouter.ts's complete()) — previously this only ever scrolled past
    // in the desktop terminal, with nothing distinguishing it from any other
    // per-call failure on a paired phone.
    case "error":
      return {
        kind: "log",
        payload: { level: "error", message: event.message, taskId, workerId },
      };
    case "manual.steps":
      // Same cap reasoning as advisor.answer: bounded per-field length, and
      // a generous but finite count, rather than trusting a pathological
      // model output to stay small on its own.
      return {
        kind: "manual.steps",
        payload: {
          taskId,
          steps: event.steps.slice(0, 100).map((s) => ({
            step: s.step.slice(0, 2_000),
            reason: s.reason.slice(0, 2_000),
            phase: s.phase?.slice(0, 500),
          })),
        },
      };
    case "question.timedOut": {
      // Nobody answered in time. Said on the phone in plain words, as a log line (no new message kind, so an older phone shows it too): what was taken, and that it was by default.
      const taken = event.answer === "" ? "the default" : `"${event.answer.replace(/\s+/g, " ").slice(0, 200)}"`;
      return {
        kind: "log",
        payload: {
          level: "info",
          message:
            event.kind === "approval"
              ? `Nobody answered in time, so it was refused (taken by default): ${taken}`
              : event.byModel
                ? `Nobody answered in time, so a model read the question and chose ${taken}`
                : `Nobody answered in time, so ${taken} was taken by default`,
          taskId,
          workerId,
        },
      };
    }
    default:
      return undefined;
  }
}
