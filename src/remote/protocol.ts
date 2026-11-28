/**
 * Remote control protocol: shared types, the verb allowlist, and end-to-end
 * encryption.
 *
 * Trust model
 * -----------
 * The agent machine NEVER opens a listening port. It registers with a broker
 * over outbound HTTPS, pushes encrypted events, and long-polls for commands.
 * The broker is a dumb relay: it routes ciphertext and never holds the key.
 *
 * The session key is generated on the desktop and travels to the phone only
 * inside the pairing QR code — desktop screen to phone camera, never over the
 * network. So even a fully compromised broker sees only ciphertext plus routing
 * metadata (session id, message sizes, timing).
 *
 * What the broker CAN do if compromised: deny service, and replay or drop
 * ciphertext. What it CANNOT do: read your code, read your task, forge a
 * command (commands are authenticated with the same AEAD key).
 */

import crypto from "node:crypto";
import { Persona, type RoleInfoWire } from "../models.js";
import type { UsageTotalsWire } from "../usageLedger.js";

export const PROTOCOL_VERSION = 1;

/**
 * The complete set of things a remote device may ask for. This is an allowlist,
 * not an RPC surface: anything not named here is impossible by construction.
 */
export type RemoteVerb =
  /** Tier 1 — always permitted, cannot cause harm. */
  | { verb: "abort"; reason?: string }
  | { verb: "ping" }
  /** Tier 2 — answering a question the AGENT asked. Bounded by the prompt. */
  | { verb: "answer"; questionId: string; answer: string }
  | { verb: "approve"; questionId: string }
  | { verb: "reject"; questionId: string; reason?: string }
  /**
   * Tier 2 — free text with no question to attach to. Only ever consumed as
   * the answer to whatever the agent asks NEXT (immediately, if something is
   * already pending; otherwise queued for the moment it next asks anything,
   * such as its idle "what should I do" prompt) — it can never inject text
   * mid-tool-call or otherwise interrupt work already in flight.
   */
  | { verb: "message"; text: string }
  /**
   * Tier 2 — handing over reference material. Inert data: it is written to a
   * staging folder and only ever read as model input, never executed and never
   * placed at a caller-chosen path. `name` is sanitised on arrival.
   */
  | {
      verb: "attach";
      uploadId: string;
      name: string;
      mime: string;
      seq: number;
      total: number;
      /** base64 chunk of the file body. */
      data: string;
    }
  /**
   * Tier 1 — asks for the full diff behind a `file.changed` event's "+N -M"
   * summary. Pure read of something already produced: it cannot alter the
   * run, so it carries the same "always safe" characterization as abort/ping
   * rather than the answer/attach consent gate.
   */
  | { verb: "fetch_diff"; changeId: string }
  /**
   * Tier 1 — asks the desktop to re-serve its own durable event log starting
   * strictly after a given point. Exists because the broker only keeps the
   * newest 500 events per session in memory (see broker.ts's MAX_QUEUE): a
   * long enough gap (the phone asleep overnight through a busy task) can
   * permanently drop events from the broker's buffer before the phone ever
   * polls for them. Pure read of something already produced, same "always
   * safe" characterization as fetch_diff/abort/ping.
   *
   * `afterEventId` (preferred) is the permanent integer eventId every
   * persisted event carries — a strict total order with no possible ties, so
   * paging by it can never drop or duplicate an event at a page boundary.
   * `after` (legacy) is an ISO-8601 timestamp (an event's own `at`) — kept
   * only for a phone build that predates `eventId`; two or more events
   * sharing the same millisecond make it an unsafe page boundary under real
   * load, which `afterEventId` doesn't have. Send `afterEventId` when you
   * have one; otherwise send `after`. Exactly one of the two must be present.
   *
   * `taskId`, when given, scopes this to ONE task's own events only (on-
   * demand fetch for opening a task from the History list), still paged at
   * 500 and still ordered/cursored by `afterEventId` within that one task —
   * `after` is not supported in this mode. Omitted, this behaves as before:
   * a merged, repo-wide cursor spanning every task and between-task file in
   * `eventId` order (gap recovery, and "catch me up to the current screen"
   * on a fresh pairing).
   */
  | { verb: "fetch_history"; after?: string; afterEventId?: number; taskId?: string }
  | { verb: "history_replay"; after?: string; afterEventId?: number; taskId?: string }
  /**
   * Tier 1 — the History list: a page of `tasks.index` entries, newest
   * first. Pure read of something already produced, same "always safe"
   * characterization as fetch_diff/fetch_history. `beforeTaskId` omitted
   * means "start from the newest"; given, it pages strictly older than that
   * task. `limit` defaults to 50,
   * capped at 100 server-side regardless of what's requested.
   */
  | { verb: "history.list"; limit?: number; beforeTaskId?: string }
  /**
   * Tier 1 — re-requests a screenshot's actual image data by the exact path
   * a gate.result's `artifacts` entry gave for it. Exists because
   * screenshot.chunk is deliberately excluded from the durable history log
   * (base64 image data would bloat it past usefulness) -- a gate.result
   * recovered via `fetch_history`, or replayed after any reconnect, always
   * names the file but never carries its pixels. Pure read of something
   * already produced, same "always safe" characterization as fetch_diff.
   * Unlike fetch_diff's in-memory, process-lifetime diffStore, this reads
   * the file straight off disk — the desktop's own screenshots persist
   * indefinitely in .agent/screenshots/, so this still works even after a
   * desktop restart.
   */
  | { verb: "fetch_screenshot"; path: string }
  /** Tier 1 — the current [primary, backup?] model chain for every configured role. Pure read. */
  | { verb: "get_model_config" }
  /** Tier 1 — the current roadmap, answered with a `roadmap.state` event. Pure read. */
  | { verb: "get_roadmap" }
  /**
   * Tier 1 — this desktop's lifetime usage totals (by worker and by model,
   * plus the last ended task). Pure read; answered with a `usage.totals` event. The same event is also pushed unprompted when
   * a phone pairs and after every task ends, so this is only needed to refresh.
   */
  | { verb: "get_usage" }
  /**
   * Tier 1 — the candidate models for one role, filtered to what that role
   * actually needs (tool-calling and/or vision) and sorted cheapest-first,
   * exactly like the desktop's own `/model` picker. `exclude` drops ids from
   * the result (used for the backup-picker step, set to the primary just
   * chosen) — the response can be slow (a live OpenRouter catalog fetch), so
   * a client should show a spinner while waiting.
   */
  | { verb: "list_models"; role: Persona; exclude?: string[] }
  /**
   * Tier 2 — persists a new [primary, backup?] chain for one role, exactly
   * where `/model` already persists it. `chain: []` clears an OPTIONAL
   * vision role back to unset; it is refused (`command.refused`) for one of
   * the four required roles (discovery/planner/editor/verifier), which can
   * never be left without a model. Also refused outright while a task is
   * actively RUNNING — changing models under an in-flight phase would leave
   * that phase's own agent calls using a chain that no longer matches what
   * either surface displays; safe while idle or while genuinely paused on a
   * pending question (RemoteStatus.state "awaiting-input").
   */
  | { verb: "set_model"; role: Persona; chain: string[] };

export type VerbName = RemoteVerb["verb"];

/** Verbs that can never be disabled: stopping (and viewing something already produced) is always safe. */
export const ALWAYS_ALLOWED: VerbName[] = ["abort", "ping", "fetch_diff", "fetch_history", "history_replay", "fetch_screenshot", "get_model_config", "get_roadmap", "get_usage", "list_models", "history.list"];

export interface RemoteCommand {
  id: string;
  issuedAt: string;
  deviceId: string;
  payload: RemoteVerb;
}

/** A question the agent is blocked on, surfaced to any connected device. */
export interface PendingQuestion {
  id: string;
  kind: "blocking" | "deferred" | "approval";
  prompt: string;
  /** Suggested choices; free text is allowed when empty. */
  choices?: string[];
  /**
   * When `choices` is also set: render them as buttons PLUS an explicit
   * "something else" option that opens free text, rather than locking the
   * answer to exactly one of `choices` (the existing behavior for a state-
   * machine decision like yes/no or install/skip/abort, where an arbitrary
   * answer has nowhere to go). Meaningless without `choices`, where free
   * text is already the only option. Absent/false on an old client: it just
   * renders `choices` as buttons with no "other" affordance, same as today.
   */
  allowCustom?: boolean;
  /** What the person has already answered in this same set of questions: not shown to them, given to whoever answers by default so a default never contradicts it. */
  context?: string;
  /** Applied if nobody answers. */
  fallback: string;
  askedAt: string;
  /**
   * True only for the loop's own idle "what should I do" prompt — never for a
   * real clarifying question the agent asks mid-task. Both currently arrive
   * as `kind: "blocking"` (the idle prompt genuinely does block the terminal
   * loop waiting for a task), so a client can't otherwise tell "the agent
   * needs an answer to keep working" apart from "nothing is running yet,
   * this is just the normal prompt for a new task" — the latter should never
   * be presented as an urgent/locking popup.
   */
  idle?: boolean;
}

/** Snapshot pushed alongside events so a device that connects late has context. */
export interface RemoteStatus {
  runId: string;
  /** Identifies which TASK within this run/process this snapshot belongs to
   *  — distinct from `runId`, which stays fixed for the whole desktop
   *  process. A single interactive session can run many unrelated tasks
   *  back to back without restarting, each with the same runId but a
   *  different taskId. Reconcile on taskId, not runId — see "Reconciliation"
   *  under `status` below. */
  taskId: string;
  repoName: string;
  /** The folder name this terminal runs in (path.basename of process.cwd()), so a phone with several terminals can label each one. Sealed. */
  projectName?: string;
  /** The working directory of this terminal. Sealed: the relay never sees a path. */
  cwd?: string;
  state: "idle" | "planning" | "running" | "awaiting-input" | "done" | "failed" | "aborted";
  /** Explicit task-level run flag carried on every status heartbeat so transient dropped packets reconcile on the next poll. */
  taskRunning?: boolean;
  /** Explicit task-level terminal/active status carried on every status heartbeat for reliable reconciliation. */
  taskStatus?: "idle" | "running" | "completed" | "failed";
  /** Authoritative active task id (`null` when idle between tasks). */
  activeTaskId?: string | null;
  /** Most recently completed task id in this session (`null` if none yet). */
  lastCompletedTaskId?: string | null;
  goal?: string;
  phases: { id: string; name: string; status: string }[];
  currentPhase?: string;
  pendingQuestions: PendingQuestion[];
  /** Cumulative across the WHOLE task — every phase, every agent. */
  tokensUsed: number;
  /** Real USD cost across the whole task so far, when the provider prices are known. Omitted otherwise. */
  costUsd?: number;
  /** Cumulative for the CURRENT phase only — every agent that has worked on it (Editor, Repair, QA, ...), reset at each phase's start. */
  phaseTokensUsed?: number;
  /** Real USD cost for the current phase only, when known. Omitted otherwise. */
  phaseCostUsd?: number;
  /** Per-agent-role totals for the WHOLE task so far (e.g. "DISCOVERY", "EDITOR", "VERIFIER") — costUsd per entry omitted when that role's provider never reported a price. */
  agentUsage?: Record<string, { tokens: number; costUsd?: number }>;
  /** Per-agent-role totals for the CURRENT phase only (same keys and shape as `agentUsage`): what the Editor cost in this phase. */
  phaseAgentUsage?: Record<string, { tokens: number; costUsd?: number }>;
  /** Every phase of this task so far, finished ones included, keyed by phase id: total, per agent role and per model id. */
  phaseUsage?: Record<string, import("../usageWire.js").PhaseUsageWire>;
  startedAt: string;
  updatedAt: string;
}

/**
 * One row of the desktop's `tasks.index`, the History list's own unit, built from a task's `task.start`
 * (title/prompt/attachments, pending a goal), refreshed at `plan.ready`
 * (title upgraded to the goal, phaseCount filled in), and finalized at
 * `task.end` (state/endedAt/tokensUsed/costUsd/lastEventId). One line per
 * task on disk, rewritten in place as these three events arrive — never
 * multiple historical lines for the same taskId.
 */
export interface TaskIndexEntry {
  taskId: string;
  /** The repo name shown in RemoteStatus, same string — only known at
   *  task.start time (RemoteSession.start()'s own param), absent if that
   *  somehow wasn't available. */
  repoName?: string;
  /** The plan's goal once known (`plan.ready`), else the prompt's own first line. */
  title: string;
  /** The prompt's first line only — the full text lives in the task file's own `task.start` event. */
  prompt: string;
  state: "running" | "done" | "failed" | "aborted" | "interrupted";
  startedAt: string;
  /** null while the task is still running. */
  endedAt: string | null;
  /** Filled in once `plan.ready` arrives; absent before that (a degraded/no-plan task may never get one). */
  phaseCount?: number;
  tokensUsed?: number;
  costUsd?: number;
  /** This task's own task.start eventId — where its file's range begins. */
  firstEventId: number;
  /** This task's own task.end eventId — where its file's range ends. null while still running. */
  lastEventId: number | null;
  attachments: string[];
}

export interface TaskSnapshotWorker {
  workerId?: string;
  agent: string;
  phaseId?: string;
  phaseName?: string;
  outcome?: string;
  tokensUsed?: number;
  costUsd?: number;
  elapsedMs?: number;
  summary?: string;
  safeCount?: number;
  totalJudges?: number;
  startedAt?: string;
  endedAt?: string;
}

export interface TaskSnapshotPhase {
  id: string;
  name: string;
  goal?: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "ABORTED";
  index?: number;
  executor?: string;
  runs: TaskSnapshotWorker[];
}

/**
 * Authoritative pre-reduced snapshot of a single task stored in SQLite
 * (`tasks.snapshot_json`) and pushed on `fetch_history({ taskId })` so the
 * phone renders phases and worker cards immediately without re-reducing raw
 * events.
 */
export interface TaskSnapshotWire {
  taskId: string;
  repoName?: string;
  goal: string;
  prompt: string;
  state: "running" | "done" | "failed" | "aborted" | "interrupted";
  tokensUsed: number;
  costUsd?: number;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  phases: TaskSnapshotPhase[];
}

/**
 * The complete set of things the desktop pushes to a paired device, once
 * decrypted. Formalized here (matching `RemoteVerb`'s pattern) so new event
 * kinds get compile-time-checked payload shapes at their call site — `push()`
 * itself (remote/client.ts) still accepts an arbitrary `kind: string` for
 * backward compatibility with its existing untyped call sites, but any NEW
 * caller should shape its payload against this union.
 */
export type RemoteEvent =
  | { kind: "status"; status: RemoteStatus }
  /** `taskId`/`workerId` are omitted when no task/worker is currently running (e.g. an idle-prompt-time log). */
  | { kind: "log"; level: "info" | "warn" | "error"; message: string; taskId?: string; workerId?: string }
  | { kind: "screenshot.chunk"; id: string; label: string; mime: string; seq: number; total: number; data: string }
  | { kind: "command.refused"; verb: string; reason: string }
  /**
   * `questionId` is included for answer/approve/reject (always safe — an
   * opaque id, never content). `text` echoes back the actual free text sent
   * (message's text, answer's answer, reject's reason) so a client rebuilding
   * its history from a replay/recovery still has what the user typed, not
   * just the fact that *something* of this verb was accepted — omitted
   * entirely when the agent has redactLogs on, or when this verb carries no
   * free text to begin with (ping, abort, approve).
   */
  /**
   * `taskId` is included for `answer`/`reject`/`approve` whenever a task is
   * currently running (these verbs only ever resolve a question that exists
   * BECAUSE a task is running, so the session's own current taskId is always
   * correct for them). It is deliberately NEVER included for `message`:
   * when a message arrives there is no reliable way yet to know whether it
   * will become a NEW task's prompt (taskId not minted until the idle
   * prompt's own await resolves, in a completely different stack frame) or
   * just answer something already pending — tagging it with the session's
   * CURRENT taskId in that window would often be the PREVIOUS, already-
   * finished task's id, which is exactly the kind of mislabeling this whole
   * contract exists to eliminate. A client that needs to know which task a
   * message started should match it against the `task.start` event that
   * follows it (task.start carries the same prompt text).
   */
  | { kind: "command.accepted"; verb: string; questionId?: string; text?: string; taskId?: string }
  | { kind: "answer.rejected"; questionId: string; reason: string }
  | { kind: "attach.done"; name: string; bytes: number; taskId?: string }
  | { kind: "attach.rejected"; reason: string }
  | { kind: "pong" }
  | { kind: "session.end"; reason: string }
  /**
   * Who this terminal is, for a phone that has several: sent sealed at the start of a session and again when the phone pairs, so
   * the relay never sees a project or host name. `hostname` is left out when `remote.shareHostname` is off.
   */
  | { kind: "session.hello"; repoName: string; projectName?: string; cwd?: string; branch?: string; hostname?: string; platform: string; cliVersion?: string; startedAt: string }
  /** Emitted exactly once, the moment `taskId` is minted (right after the
   *  prompt is captured, before Discovery) — the explicit task-boundary
   *  counterpart to `status.state` transitions, which a client previously had
   *  to infer task boundaries from. `prompt` is the exact text that started
   *  it; `attachments` are the attachment labels (same text already shown in
   *  console `[ATTACH]` lines), empty when none. */
  | { kind: "task.start"; taskId: string; runId: string; prompt: string; attachments: string[]; /** Only when this task is a roadmap unit. */ roadmapUnitId?: string; roadmapId?: string }
  /** Emitted exactly once per `task.start`, when the task concludes.
   *  `interrupted` is emitted retroactively on the NEXT startup for a task
   *  whose process ended (crash, kill, `/stop` racing process exit) before
   *  this could fire normally — detected from an orphaned `task.start` with
   *  no matching `task.end` in the durable log; `tokensUsed`/`costUsd` are
   *  omitted for that retroactive case since the crashed process's own usage
   *  tracker is gone. Statuses pushed after this (the idle wait) keep this
   *  task's id but a client should ignore them for task data — see
   *  RemoteStatus.taskId's own doc comment. */
  | { kind: "task.end"; taskId: string; state: "done" | "failed" | "aborted" | "interrupted"; tokensUsed?: number; costUsd?: number }
  /** A phase began — the explicit boundary a client groups everything else under, rather than inferring one from worker.start's phaseId changing.
   *  `taskId` scopes this (and every other task-scoped kind below) to one task within the current run — see RemoteStatus.taskId's own doc comment. */
  | { kind: "phase.start"; taskId: string; phaseId: string; name: string; goal: string; index: number; total: number; executor?: string }
  /** A phase finished, pass or fail. */
  | { kind: "phase.end"; taskId: string; phaseId: string; name: string; passed: boolean; confidence?: string; attempts: number }
  /** A worker (EDITOR/REPAIR/QA/...) started its pass on the current phase.
   *  `workerId` is a fresh id minted for THIS run, carried on `worker.end` and
   *  everything the worker produces (`file.changed`/`gate.result`/`verdict`/
   *  worker-time `log`) so a client can attribute evidence to the exact run
   *  that produced it instead of guessing from "newest open worker". A worker
   *  that re-runs the same step (not REPAIR, which is its own step) sets
   *  `retryOf` to the earlier worker's id, plus a 1-based `attempt` and a
   *  short `reason` — e.g. the corrective Planner pass after a plan fails
   *  validation, or a re-plan after clarifying-question answers. */
  | { kind: "worker.start"; taskId: string; workerId: string; agent: string; phaseId?: string; phaseName?: string;
      /** For a SECURITY worker: the phase it belongs to (the one it runs in, or the one just finished when it runs between phases), so a
       *  client nests it inside that phase's card. A background check with no visible result sends no worker.start/worker.end at all. */
      parentPhaseId?: string;
      /** "planning" for a pass that runs before the Planner (the threat triage): its parentPhaseId is then the Discover & Plan card. */
      stage?: "planning";
      acceptanceCriteria?: string[]; retryOf?: string; attempt?: number; reason?: string; exchangeId?: string }
  /** A worker finished its pass — `outcome` is a free-form label (e.g.
   *  "completed", "passed", "failed"). `tokensUsed`/`costUsd` are this
   *  worker's OWN usage (every model call between its worker.start and this,
   *  regardless of what internal label those calls used — see events.ts's
   *  agent.end doc comment) — the exact, no-guessing-required per-card cost;
   *  prefer this over matching `agent` against `status.agentUsage`'s keys,
   *  which can diverge from the worker that actually ran (e.g. QA's own
   *  internal calls are labeled VERIFIER/verifier-nav/verifier-visual, not
   *  QA). Omitted (not zero) when genuinely unknown, same as task.end's. */
  | { kind: "worker.end"; taskId: string; workerId: string; agent: string; outcome: string; exchangeId?: string; tokensUsed?: number; costUsd?: number; elapsedMs?: number }
  /** One file write/patch, with the same line diff stat already shown in the console hint. `changeId` keys the full diff for `fetch_diff`. */
  | { kind: "file.changed"; taskId: string; workerId?: string; agent: string; path: string; action: "created" | "modified"; added: number; removed: number; changeId?: string; phaseId?: string }
  /** One QA evidence-ledger entry — YIMPIM's own per-requirement/per-check result, not a parsed test-runner report (YIMPIM has no JUnit-style named-test data). */
  | { kind: "gate.result"; taskId: string; workerId?: string; tier: string; gate: string; status: string; blocking: boolean; detail: string; artifacts?: string[]; phaseId?: string }
  /** QA's final roll-up for the phase. */
  | { kind: "verdict"; taskId: string; workerId?: string; passed: boolean; confidence: string; blockingFailures: string[]; advisories: string[]; phaseId?: string }
  /** One chunk of a diff requested via `fetch_diff`, reassembled the same way `screenshot.chunk` is. */
  | { kind: "diff.chunk"; changeId: string; path: string; seq: number; total: number; data: string }
  /** The requested changeId is no longer in the diff cache (evicted, or the process restarted). */
  | { kind: "diff.unavailable"; changeId: string; reason: string }
  /** Sent instead of screenshot.chunk when a `fetch_screenshot` path no longer exists on disk (deleted, or not a path this repo ever produced). */
  | { kind: "screenshot.unavailable"; path: string; reason: string }
  /**
   * Answers a `fetch_history` request — pushed AFTER the recovered events
   * themselves (each re-sent as its own ordinary event via replayHistory, not
   * wrapped in this one), so a client knows the batch is complete rather than
   * guessing from the stream going quiet. `count` is how many were actually
   * found and sent; `truncated` means more exist beyond `limit` and the
   * client should ask again to continue paging forward. `count: 0, truncated:
   * false` means there was genuinely nothing past the requested point — not
   * a gap, just already fully caught up.
   *
   * `requestedAfter` (legacy, always present) echoes whatever the request
   * actually sent — the `after` timestamp if that's what was given, or the
   * `afterEventId` stringified if that's what was given instead (so an old
   * phone reading only this field still gets a sensible echo either way).
   * `lastEventId` (new, present whenever the request used `afterEventId` and
   * at least one event was returned) is the highest `eventId` in this batch —
   * pass it straight back as next request's `afterEventId` to keep paging;
   * this is the field a client should actually use, not requestedAfter.
   *
   * `taskId` echoes a task-scoped request (`fetch_history{taskId}`) back —
   * absent for the merged, repo-wide cursor. `missing: true` replaces the
   * usual empty-but-caught-up answer when the requested taskId names a task
   * that was never recorded, or has since been evicted by retention — a
   * client that gets this should drop its cached reference to that task
   * rather than keep retrying the same fetch forever.
   */
  | { kind: "history.fetched"; requestedAfter: string; lastEventId?: number; count: number; truncated: boolean; taskId?: string; missing?: boolean }
  /**
   * Authoritative pre-reduced task snapshot pushed ahead of raw events on
   * `fetch_history({ taskId })`. Not persisted into the raw event stream.
   */
  | { kind: "task.snapshot"; snapshot: TaskSnapshotWire }
  /**
   * Answers `history.list` — one page of the History list, newest first.
   * Not persisted (like history.fetched): it's an on-demand index read, not
   * part of a task's own record. `hasMore: true` means page again with
   * `beforeTaskId` set to this page's last (oldest) entry's taskId.
   */
  | { kind: "history.index"; entries: TaskIndexEntry[]; hasMore: boolean }
  /** An /ask exchange began — lets a client open an "Advisor" card right
   *  away instead of only learning about it once the answer lands.
   *  `taskId` is present only when a task is currently running (omitted for
   *  an /ask asked while idle — see RemoteStatus.taskId's own doc comment
   *  for why the idle-time status's taskId is NOT a safe substitute). */
  | { kind: "advisor.start"; exchangeId: string; question: string; taskId?: string }
  /** The read-only advisor's final answer to an /ask, so a phone can show it as a readable block. `exchangeId` links it back to the matching advisor.start; `taskId` follows the same rule as advisor.start's. */
  | { kind: "advisor.answer"; text: string; question?: string; exchangeId?: string; taskId?: string }
  /**
   * The agent asked a question (not the idle "what should I do next" prompt, whose answer arrives as task.start's prompt). Sent once,
   * when it is asked, so a client can open the Q of a Q&A pair; it also stays in status.pendingQuestions until answered.
   * `question` is never empty; `options` are the suggested answers (empty when free text is the only way to answer).
   * `phaseId`/`worker`/`workerId` say who asked, when a phase or worker was running.
   */
  | { kind: "question.ask"; questionId: string; question: string; options: string[]; questionKind: "blocking" | "deferred" | "approval"; allowCustom?: boolean; taskId?: string; phaseId?: string; worker?: string; workerId?: string; askedAt: string }
  /**
   * A question was answered: sent the moment it is answered, with the answer that was taken, so a client fills the A of the pair.
   * `by` is where it came from: "terminal", "phone", "timeout" (nobody answered, the default was taken) or "model" (nobody answered,
   * a model decided from the project). Not sent when a stop settles questions with their defaults.
   */
  | { kind: "question.answered"; questionId: string; question: string; answer: string; by: "terminal" | "phone" | "timeout" | "model"; taskId?: string; phaseId?: string; worker?: string; workerId?: string }
  /** "Before this is actually live, you need to..." — manual steps flagged this task, only sent when non-empty. */
  | { kind: "manual.steps"; taskId: string; steps: { step: string; reason: string; phase?: string }[] }
  /** The Planner's finished plan — goal plus every phase's own goal, so a phone can show the full plan, not just phase names as they start.
   *  `taskId` matches `status.taskId`: exactly one plan.ready per task, so a client that sees the same taskId twice (a replayed redelivery,
   *  not a new plan) should update its existing plan card rather than add another one. `runId` is also included but is NOT the reconciliation
   *  key — it's fixed for the whole desktop process, and one process can run several unrelated tasks (each its own taskId) back to back. */
  | { kind: "plan.ready"; taskId: string; runId: string; goal: string; degraded: boolean; phases: { id: string; name: string; goal: string; executor?: string }[] }
  /** The whole current roadmap (never a partial update), or null when there is none. Sent on every change, when a phone connects, and for `get_roadmap`. Current state, not history: never persisted. */
  | { kind: "roadmap.state"; roadmap: import("../roadmap.js").RoadmapWire | null }
  /** The current [primary, backup?] chain for every configured role, in response to `get_model_config` or right after a `set_model` that was accepted — always the complete set, never a partial update. */
  | { kind: "model.config"; roles: { role: Persona; chain: string[] }[]; scope: "project" | "global";
      /** What each role is (label, optional, multi-select, needs), so a client can build its picker from this instead of a hard-coded list. Absent from an older desktop. */
      roleInfo?: RoleInfoWire[] }
  /**
   * This desktop's lifetime usage — the desktop is the source of truth, so a
   * freshly installed phone shows the same numbers as any other. Sent on
   * pairing, after every task.end, and in response to `get_usage`; always the
   * complete current snapshot, never a delta, and never persisted into the
   * replay history (a stale copy replayed later would be wrong).
   * `lifetime` is never evicted; `last` is the most recent ENDED task.
   * `cost` is USD; `costIsFloor: true` means some calls reported no price, so
   * show it as a floor ("$1.23+"), and `cost` is absent when none did.
   * UsageTotalsWire (usageLedger.ts) is the full shape.
   */
  | ({ kind: "usage.totals" } & UsageTotalsWire)
  /** One role's candidate models, in response to `list_models` — cheapest-first, matching the desktop's own `/model` ordering. */
  | { kind: "model.catalog"; role: Persona; models: ModelCatalogEntry[] }
  /** `list_models` couldn't complete (no API key configured, or the catalog fetch itself failed) — sent instead of `model.catalog`. */
  | { kind: "model.catalog_unavailable"; role: Persona; reason: string };

/** One candidate model as shown to a device picking a primary/backup for a role — the wire shape of what `/model`'s own picker already computes from the OpenRouter catalog (see models.ts's `CatalogModel`/`formatModel`). */
export interface ModelCatalogEntry {
  id: string;
  pricing: { promptPerM: number; completionPerM: number } | null;
  isFree: boolean;
  isVariablePrice: boolean;
  contextLength: number;
  supportsVision: boolean;
  supportsTools: boolean;
}

export type RemoteEventKind = RemoteEvent["kind"];

/**
 * Event kinds suppressed when redactLogs is on — all quote project content
 * the same way a plain log line can. Lives here (not client.ts, which uses
 * it) and not historyLog.ts (which also uses it) specifically to avoid a
 * circular import between those two — protocol.ts sits below both.
 */
export const REDACTED_EVENT_KINDS = new Set(["log", "advisor.start", "advisor.answer", "manual.steps", "plan.ready"]);

// --------------------------------------------------------------- Envelopes

/** What actually crosses the wire. `data` is AES-256-GCM ciphertext. */
export interface Envelope {
  v: number;
  sessionId: string;
  seq: number;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 ciphertext */
  data: string;
  /** base64 GCM auth tag (16 bytes) */
  tag: string;
}

const ALGO = "aes-256-gcm";

export function generateSessionKey(): Buffer {
  return crypto.randomBytes(32);
}

/** 256 bits of entropy; brute force is off the table, so no rate limit needed. */
export function generatePairingSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function seal(key: Buffer, sessionId: string, seq: number, payload: unknown): Envelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  // Bind the ciphertext to its routing metadata so the broker cannot move a
  // message between sessions or replay it at a different sequence number.
  cipher.setAAD(Buffer.from(`${PROTOCOL_VERSION}:${sessionId}:${seq}`, "utf8"));

  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    v: PROTOCOL_VERSION,
    sessionId,
    seq,
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open<T = unknown>(key: Buffer, env: Envelope): T {
  if (env.v !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version ${env.v} (expected ${PROTOCOL_VERSION})`);
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(env.iv, "base64"));
  decipher.setAAD(Buffer.from(`${PROTOCOL_VERSION}:${env.sessionId}:${env.seq}`, "utf8"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(env.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** Constant-time compare for tokens, to avoid leaking via timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ------------------------------------------------------------- Pairing URL

export interface PairingPayload {
  v: number;
  /** Broker base URL, e.g. https://relay.example.com */
  broker: string;
  sessionId: string;
  /** One-time secret redeemed for a device token. */
  pairing: string;
  /** base64url session key — never sent to the broker. */
  key: string;
}

/**
 * The fragment is scanned off a screen, so its size is the QR code's size —
 * every byte here is rendered as visible modules. `sessionId`, `pairing` and
 * `key` are already base64url, so wrapping them in JSON and base64-encoding
 * the whole thing a second time was pure overhead: braces, quotes, field
 * names, and ~33% base64 bloat on data that needed none of it. `broker` is
 * dropped entirely — the page that scans this loads FROM the broker, so it
 * is `location.origin` there, never something to carry as payload.
 *
 * Wire format: `v.sessionId.pairing.key`, dot-joined. None of the three
 * fields can contain a literal ".", so no escaping is needed.
 */
export function encodePairing(p: PairingPayload): string {
  const fragment = [PROTOCOL_VERSION, p.sessionId, p.pairing, p.key].join(".");
  // The fragment is never sent to the server in an HTTP request, so even the
  // page load does not hand the key to the broker.
  return `${p.broker.replace(/\/+$/, "")}/p#${fragment}`;
}

/**
 * Decodes only what the fragment carries: `broker` is not part of it (see
 * encodePairing) and is set to "" — callers with a full pairing URL already
 * have the broker as its origin and should use that instead.
 */
export function decodePairing(fragment: string): PairingPayload {
  const parts = fragment.split(".");
  if (parts.length !== 4) throw new Error("pairing payload is malformed");
  const [v, sessionId, pairing, key] = parts;
  if (Number(v) !== PROTOCOL_VERSION) throw new Error("pairing payload version mismatch");
  return { v: PROTOCOL_VERSION, broker: "", sessionId, pairing, key };
}
