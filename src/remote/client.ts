/**
 * Agent-side remote control.
 *
 * This process NEVER listens. It only makes outbound HTTPS requests:
 *   register -> push events -> long-poll for commands
 *
 * That is the whole security story for the host machine: there is no socket to
 * scan, no port to forward, no firewall rule to add. An attacker cannot reach
 * this process; it can only reach out.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import {
  Envelope, ModelCatalogEntry, PendingQuestion, RemoteCommand, RemoteStatus, RemoteVerb, TaskIndexEntry,
  ALWAYS_ALLOWED, PROTOCOL_VERSION, REDACTED_EVENT_KINDS,
  encodePairing, generatePairingSecret, generateSessionKey, hashToken, open, seal,
} from "./protocol.js";
import { RemoteTelemetry } from "./telemetry.js";
import { logLocal } from "../localLog.js";
import { UploadCollector } from "./uploads.js";
import { Persona, type RoleInfoWire } from "../models.js";
import { appendHistoryEntry, HistoryEntry } from "./historyLog.js";
import type { UsageTotalsWire } from "../usageLedger.js";
import { roadmapStateWire, type RoadmapWire } from "../roadmap.js";

/** Why the relay ended a session. */
export type SessionEndReason = "unpaired" | "evicted" | "phone_replaced" | "account_deleted";

/** The relay would not open another terminal for this account: all of its allowance is in use by running desktops. */
export class SessionLimitError extends Error {
  constructor(public readonly limit?: number) {
    super(sessionLimitMessage(limit));
    this.name = "SessionLimitError";
  }
}

export function sessionLimitMessage(limit?: number): string {
  const n = typeof limit === "number" ? `${limit} terminal${limit === 1 ? "" : "s"}` : "the most terminals your account allows";
  return `You already have ${n} connected to your phone. Close one, or unpair it in the app, then run /remote-control again.`;
}

/** What to tell the person when the relay ends this session, and what to do next. */
export function endedMessage(reason: string, limit?: number): string {
  switch (reason) {
    case "unpaired":
      return "Your phone unpaired this terminal. Run /remote-control to show a fresh QR and pair again.";
    case "phone_replaced":
      return "Another phone took over your account, so the phone paired to this terminal was disconnected. Run /remote-control to pair a phone again.";
    case "evicted":
      return `This terminal was disconnected to make room for another (your account allows ${typeof limit === "number" ? limit : "a few"} at once). Run /remote-control to reconnect.`;
    case "account_deleted":
      return "This YIMPIM Pro account was deleted, so remote control has ended.";
    default:
      return "The relay ended this session. Run /remote-control to pair again.";
  }
}

/** One terminal's identity, sent sealed so a phone with several can tell them apart. */
export interface SessionHello {
  repoName: string;
  /** The folder this terminal was started in (path.basename of process.cwd()), so a phone can label the session. */
  projectName?: string;
  /** The working directory of this terminal. Sealed like the rest of the hello: the relay never sees it. */
  cwd?: string;
  branch?: string;
  hostname?: string;
  platform: string;
  cliVersion?: string;
  startedAt: string;
}

export interface RemoteOptions {
  brokerUrl: string;
  /** Verbs beyond the always-allowed set. */
  allowAnswer: boolean;
  /** Drop log events (which can quote source) before they leave the machine. */
  redactLogs: boolean;
  /** Where phone uploads are staged; enables the attach verb when set. */
  repoRoot?: string;
  /**
   * The Pro lease, sent to the broker at /v1/register so the session is bound
   * to its account. Set ONLY when the relay is the YIMPIM cloud broker: a
   * lease is a bearer credential and must never go to a self-hosted or
   * configured relay.
   */
  leaseToken?: string;
  /** Called once when the relay ends this session (the person has already been told why). */
  onEnded?: (reason: string) => void;
}

export interface RemoteHandlers {
  onAbort(reason?: string): void;
  onAnswer(questionId: string, answer: string): void;
  onAttach(filePath: string, name: string): void;
  /** Free text with no questionId — the phone composing without a specific
   *  question pending (e.g. starting the very first task). */
  onMessage(text: string): void;
  /** The phone tapped a patch row and wants the full diff behind its +N/-M summary. */
  onFetchDiff(changeId: string): void;
  /** The phone detected a gap (the broker dropped events past its 500-event
   *  cap, e.g. overnight through a busy task) and wants the desktop to
   *  re-serve its own durable log from this point — `afterEventId` when the
   *  phone sent the new (preferred) cursor, `after` for the legacy one.
   *  `taskId`, when present, scopes this to one task's own events only
   *  (opening a task from the History list), ignoring `after`/`afterEventId`
   *  as a repo-wide cursor entirely. */
  onFetchHistory(cursor: { after?: string; afterEventId?: number; taskId?: string }): void;
  /** The phone opened (or paged) the History list. */
  onHistoryList(limit: number, beforeTaskId: string | undefined): void;
  /** The phone has a gate.result's screenshot filename but no pixels for it
   *  (never received the live chunks, or they only ever lived in memory and
   *  are gone after a restart) and wants the desktop to re-serve that exact
   *  file from disk. */
  onFetchScreenshot(path: string): void;
  /** The phone opened the model-settings wizard, or just wants a refresh. */
  onGetModelConfig(): void;
  /** The phone wants the current roadmap. */
  onGetRoadmap?(): void;
  /** The phone wants a fresh copy of this desktop's lifetime usage totals. */
  onGetUsage(): void;
  /** The phone is browsing candidates for one role's primary/backup picker. */
  onListModels(role: Persona, exclude: string[] | undefined): void;
  /** The phone submitted a new chain for one role. */
  onSetModel(role: Persona, chain: string[]): void;
}

/** Event kinds push() never durably persists — see its own doc comment for why each one. */
const NOT_PERSISTED_KINDS = new Set([
  "screenshot.chunk",
  "diff.chunk",
  "model.config",
  // Current state, replaced whole on every change: an old copy replayed into a new session would be stale.
  "roadmap.state",
  // A snapshot of a moving total: replaying an old one into a new session
  // would show stale numbers. The ledger file is the durable copy.
  "usage.totals",
  "pong",
  "history.fetched",
  "history.index",
  "command.refused",
  "session.end",
  // Identity of THIS session, sent again at every pairing: an old copy replayed into a new session would name the wrong terminal.
  "session.hello",
]);

const POLL_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000];
/** ~1 minute of backoff: well past any restart, so a warning means it is real. */
const UNAUTHORIZED_POLLS_BEFORE_WARNING = 6;
/** Stop polling after repeated unknown 401s so a dead session doesn't spam the relay forever. */
const UNAUTHORIZED_POLLS_BEFORE_STOP = 10;
// Same raw chunk size the phone itself uses for uploads,
// so both directions behave the same way under the broker's body-size limit.
const SCREENSHOT_CHUNK_BYTES = 48 * 1024;
// Leaves headroom under the broker's 1MB per-request body cap for JSON
// framing, the base64 ~33% blow-up, and the other events riding along in the
// same flush — a batch built purely by event COUNT (the old behavior) could
// bundle 100 screenshot-chunk events into a multi-megabyte body that the
// broker rejects outright, and since the failed batch just gets put back and
// retried unchanged, that was a silent, permanent stall, not a transient one.
const MAX_BATCH_BYTES = 700_000;

/** The actual content of a phone command, for the terminal audit line. */
function describePhoneCommand(p: RemoteVerb): string {
  switch (p.verb) {
    case "answer":
      return `answered: "${p.answer}"`;
    case "approve":
      return `approved (${p.questionId})`;
    case "reject":
      return `rejected${p.reason ? `: "${p.reason}"` : ""}`;
    case "message":
      return `message: "${p.text}"`;
    case "abort":
      return `STOP${p.reason ? ` — "${p.reason}"` : ""}`;
    case "attach":
      return `sending ${p.name} (chunk ${p.seq + 1}/${p.total})`;
    case "ping":
      return "ping";
    case "fetch_diff":
      return `requested the diff for change ${p.changeId}`;
    case "fetch_history":
      return p.taskId !== undefined
        ? `requested task ${p.taskId}'s history after eventId ${p.afterEventId ?? 0}`
        : `requested history after ${p.afterEventId !== undefined ? `eventId ${p.afterEventId}` : p.after} (gap recovery)`;
    case "history.list":
      return `browsing the History list${p.beforeTaskId ? ` (older than ${p.beforeTaskId})` : ""}`;
    case "fetch_screenshot":
      return `requested screenshot data for ${p.path}`;
    case "get_model_config":
      return "requested current model config";
    case "get_roadmap":
      return "requested the roadmap";
    case "get_usage":
      return "requested lifetime usage totals";
    case "list_models":
      return `browsing models for "${p.role}"`;
    case "set_model":
      return `set "${p.role}" to [${p.chain.join(", ") || "unset"}]`;
    default:
      return (p as RemoteVerb).verb;
  }
}

/**
 * The `command.accepted` payload actually durably persisted/echoed back —
 * see protocol.ts's `command.accepted` doc comment for why this exists at
 * all (previously just `{verb}`, so a phone's own typed text was never
 * captured anywhere durable). `redactLogs` strips the free-text field only,
 * same policy as `log`, never the `questionId` correlation id (never
 * content, always safe).
 */
/**
 * `currentTaskId` is only attached for answer/reject/approve — see
 * protocol.ts's `command.accepted` doc comment for why `message` never gets
 * one here (the task it might start doesn't exist yet at this point).
 */
export function phoneCommandEcho(
  p: RemoteVerb,
  redactLogs: boolean,
  currentTaskId?: string
): { verb: string; questionId?: string; text?: string; taskId?: string } {
  const taskId = currentTaskId || undefined;
  switch (p.verb) {
    case "message":
      return redactLogs ? { verb: p.verb } : { verb: p.verb, text: p.text };
    case "answer":
      return redactLogs
        ? { verb: p.verb, questionId: p.questionId, taskId }
        : { verb: p.verb, questionId: p.questionId, text: p.answer, taskId };
    case "reject":
      return redactLogs
        ? { verb: p.verb, questionId: p.questionId, taskId }
        : { verb: p.verb, questionId: p.questionId, text: p.reason, taskId };
    case "approve":
      return { verb: p.verb, questionId: p.questionId, taskId };
    default:
      return { verb: p.verb };
  }
}

export class RemoteSession {
  private key = generateSessionKey();
  private sessionId = "";
  private agentToken = "";
  private seq = 0;
  private outbox: Envelope[] = [];
  private stopped = false;
  private failures = 0;
  /** Consecutive 401s on the command poll - the relay no longer knows this session. */
  private unauthorizedPolls = 0;
  /** Whether the relay last said a phone is paired, to notice the moment one pairs. */
  private wasPaired = false;
  private ending = false;
  /** How many terminals the account may have, as the relay last said. */
  private limit?: number;
  private hello?: SessionHello;
  private pollTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private pollAbort?: AbortController;
  private flushFailures = 0;
  private handlers?: RemoteHandlers;
  private seenCommands = new Set<string>();

  private status: RemoteStatus = {
    runId: "",
    taskId: "",
    repoName: "",
    state: "idle",
    phases: [],
    pendingQuestions: [],
    tokensUsed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  private uploads?: UploadCollector;

  constructor(private opts: RemoteOptions) {
    if (opts.repoRoot) this.uploads = new UploadCollector(opts.repoRoot);
  }

  get connected(): boolean {
    return Boolean(this.sessionId) && !this.stopped;
  }

  /** The current run state, for a handler (set_model's gating, notably) that
   *  needs to know whether a task is actively running without keeping its
   *  own separate copy of state this class already tracks. */
  get runState(): RemoteStatus["state"] {
    return this.status.state;
  }

  /**
   * Register with the broker and return the pairing URL to render as a QR.
   * The session key is embedded in the URL fragment and never sent anywhere.
   */
  async start(runId: string, repoName: string, handlers: RemoteHandlers, hello?: Partial<SessionHello>): Promise<string> {
    this.handlers = handlers;
    this.status.runId = runId;
    this.status.repoName = repoName;
    // Carried in every status heartbeat (sealed), so the phone can label this terminal by project without a separate lookup.
    if (hello?.projectName) this.status.projectName = hello.projectName;
    if (hello?.cwd) this.status.cwd = hello.cwd;

    const pairingSecret = generatePairingSecret();

    const res = await fetch(`${this.base()}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingHash: hashToken(pairingSecret),
        ...(this.opts.leaseToken ? { proToken: this.opts.leaseToken } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      let refusal: any;
      try {
        refusal = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (res.status === 409 && refusal?.code === "session_limit") {
        throw new SessionLimitError(typeof refusal.limit === "number" ? refusal.limit : undefined);
      }
      throw new Error(`broker register failed: HTTP ${res.status} ${text}`);
    }

    const body: any = await res.json();
    this.sessionId = body.sessionId;
    this.agentToken = body.agentToken;
    if (typeof body.limit === "number") this.limit = body.limit;
    this.hello = { repoName, platform: process.platform, startedAt: this.status.startedAt, ...(hello ?? {}) };

    // Without this, a phone pairing while yimpim is sitting idle at the prompt
    // (no phase running yet to trigger the next natural updateStatus() call)
    // never received ANY status event at all — it sat on the page's static
    // "Connecting…" placeholder indefinitely, even though the connection
    // itself was healthy (a Stop command still round-tripped fine, since
    // that path doesn't depend on a status event ever having arrived).
    this.updateStatus({});
    this.pushHello();

    this.beginPolling();
    this.beginFlushing();

    return encodePairing({
      v: PROTOCOL_VERSION,
      broker: this.opts.brokerUrl,
      sessionId: this.sessionId,
      pairing: pairingSecret,
      key: this.key.toString("base64url"),
    });
  }

  /** Sealed like everything else: the relay learns no project or host name. Sent at the start and again when a phone pairs. */
  private pushHello(): void {
    if (this.hello) this.push("session.hello", { ...this.hello });
  }

  /** The relay ended this session: say why, stop for good, and let the owner know. A repeat does nothing. */
  private async handleEnded(reason: string): Promise<void> {
    if (this.ending || this.stopped) return;
    this.ending = true;
    console.warn(`[REMOTE] ${endedMessage(reason, this.limit)}`);
    await this.stop(`ended: ${reason}`);
    this.opts.onEnded?.(reason);
  }

  /** The reason in a relay answer that says this session has ended, if it does. */
  private async endedReasonOf(res: Response): Promise<string | undefined> {
    if (!res.ok && res.status !== 401) return undefined;
    const body: any = await res.json().catch(() => undefined);
    if (body?.code === "session_ended") return String(body.ended ?? "");
    return res.ok && body?.ended ? String(body.ended) : undefined;
  }

  private base(): string {
    return this.opts.brokerUrl.replace(/\/+$/, "");
  }

  // ------------------------------------------------------------- outbound

  /**
   * Counters-only usage metrics (see telemetry.ts). Fed from push() and from
   * accepted commands, drained into a plaintext `metrics` block on each
   * /v1/events post — the only telemetry the broker can see, since the events
   * themselves are sealed.
   */
  private readonly telemetry = new RemoteTelemetry();

  /** Queue an event. Encrypted here; the broker only ever holds ciphertext. */
  push(kind: string, payload: Record<string, unknown>): void {
    if (!this.connected) return;
    // Before the redactLogs filter below on purpose: counters are not log
    // content, so redacting the phone-visible log must not blind usage counts.
    this.telemetry.observeEvent(kind, payload);
    if (this.opts.redactLogs && REDACTED_EVENT_KINDS.has(kind)) return;

    const at = new Date().toISOString();

    // This is the single choke point every outbound event goes through —
    // translated agent events (worker.start, file.changed, ...), status
    // pushes, model-config pushes, all of it. Durable persistence lives HERE,
    // not in a narrower per-caller hook, specifically because `status` (built
    // by updateStatus() below) is what the Android app's own history
    // mechanism is entirely keyed on — a hook that only saw translateForRemote
    // events would silently never capture the one event kind that actually
    // matters most for replay to be useful.
    //
    // NOT_PERSISTED_KINDS: screenshot/diff chunks are large, on-demand,
    // reconstructable-on-request payloads, not part of what a task summary
    // needs. model.config/pong/history.fetched/command.refused are protocol-
    // level acks with no task content, cheaply re-askable, not history.
    // session.end describes an EPHEMERAL BROKER SESSION's teardown, not
    // anything about the actual task — critically, replaying it into a
    // freshly (re-)paired session would tell that brand-new, very-much-alive
    // session to discard its own credentials and stop polling (see
    // the session.end contract: "stop polling and discard
    // cached session credentials"), which is actively harmful, not just
    // noise, if it's ever replayed rather than only ever delivered live.
    let eventId: number | undefined;
    if (this.opts.repoRoot && !NOT_PERSISTED_KINDS.has(kind)) {
      eventId = appendHistoryEntry(this.opts.repoRoot, kind, payload, at, this.opts.redactLogs, this.status.repoName);
    }

    this.outbox.push(
      seal(this.key, this.sessionId, this.seq++, {
        kind,
        at,
        ...(eventId !== undefined ? { eventId } : {}),
        ...payload,
      })
    );
    if (this.outbox.length > 400) {
      const dropped = this.outbox.length - 400;
      this.outbox.splice(0, dropped);
      // Told explicitly rather than left as a silent gap — a phone
      // reconnecting after a long disconnect otherwise just sees history
      // resume mid-stream with no sign anything came before it. Appended as
      // a normal next-seq event, not spliced back into the trimmed range, so
      // this never disturbs the strictly increasing seq order downstream
      // relies on.
      if (kind !== "log" || !this.opts.redactLogs) {
        this.outbox.push(
          seal(this.key, this.sessionId, this.seq++, {
            kind: "log",
            at: new Date().toISOString(),
            line: `[REMOTE] ⚠️ ${dropped} queued event(s) were dropped (outbox cap reached during a disconnect).`,
          })
        );
      }
    }
  }

  /**
   * Seeds a freshly-paired session's outbox with the durable backlog
   * (historyLog.ts) — every entry that was ever pushed through push() above,
   * for every task this repo has ever run, not just the current process.
   *
   * Deliberately NOT routed through push(): these entries are already sitting
   * in the durable log (that's where they came from), so re-appending them
   * here would duplicate the log a little more on every single re-pair. Also
   * preserves each entry's ORIGINAL `at` timestamp AND `eventId` rather than
   * stamping "now"/a fresh id on history that may be days old — push()
   * always mints both fresh, which is correct for a live event but wrong for
   * a replay: the whole point of a permanent eventId is that it's the SAME
   * number live, replayed, and via fetch_history (see historyLog.ts).
   */
  replayHistory(entries: HistoryEntry[]): void {
    if (!this.connected) return;
    for (const { eventId, kind, payload, at } of entries) {
      if (this.opts.redactLogs && REDACTED_EVENT_KINDS.has(kind)) continue;
      this.outbox.push(
        seal(this.key, this.sessionId, this.seq++, {
          kind,
          at,
          ...(eventId !== undefined ? { eventId } : {}),
          ...payload,
        })
      );
    }
  }

  /**
   * Streams one screenshot to the paired phone as base64 chunks — the same
   * shape as the phone's own upload direction, just reversed. A full-size PNG
   * routinely exceeds the broker's per-request body cap, so it can never go
   * as a single event; the phone reassembles it once every chunk with a
   * matching `id` has arrived.
   *
   * Returns whether it actually sent anything. The original (live-capture)
   * caller doesn't check this — a screenshot that vanished (a probe cleaning
   * up after itself) before this could read it is not worth failing a QA run
   * over — but `fetch_screenshot`'s on-demand caller needs to know, to push
   * `screenshot.unavailable` instead of leaving the phone waiting forever for
   * chunks that are never coming.
   */
  pushScreenshot(id: string, label: string, filePath: string): boolean {
    if (!this.connected) return false;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch {
      return false;
    }
    const total = Math.max(1, Math.ceil(bytes.length / SCREENSHOT_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
      const slice = bytes.subarray(seq * SCREENSHOT_CHUNK_BYTES, (seq + 1) * SCREENSHOT_CHUNK_BYTES);
      this.push("screenshot.chunk", { id, label, mime: "image/png", seq, total, data: slice.toString("base64") });
    }
    return true;
  }

  pushScreenshotUnavailable(path: string, reason: string): void {
    if (!this.connected) return;
    this.push("screenshot.unavailable", { path, reason });
  }

  /**
   * Streams a diff to the phone in response to `fetch_diff`, chunked exactly
   * like pushScreenshot — a full-file rewrite's diff can just as easily
   * exceed the broker's per-request body cap as a screenshot can.
   */
  pushDiff(changeId: string, path: string, diffText: string): void {
    if (!this.connected) return;
    const bytes = Buffer.from(diffText, "utf-8");
    const total = Math.max(1, Math.ceil(bytes.length / SCREENSHOT_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
      const slice = bytes.subarray(seq * SCREENSHOT_CHUNK_BYTES, (seq + 1) * SCREENSHOT_CHUNK_BYTES);
      this.push("diff.chunk", { changeId, path, seq, total, data: slice.toString("base64") });
    }
  }

  pushDiffUnavailable(changeId: string, reason: string): void {
    if (!this.connected) return;
    this.push("diff.unavailable", { changeId, reason });
  }

  /**
   * Answers a `fetch_history` request. The caller re-serves the recovered
   * entries themselves via replayHistory() BEFORE calling this — each one
   * goes out as its own ordinary event, exactly like the connect-time replay
   * backlog, so a client needs no special handling for them beyond this
   * completion marker telling it the batch is done and whether to page for
   * more. `lastEventId` is omitted when the request used the legacy `after`
   * form, or when nothing was found to return. `taskId`/`missing` are only
   * ever set for a task-scoped request (`fetch_history{taskId}`).
   */
  pushHistoryFetched(
    requestedAfter: string,
    lastEventId: number | undefined,
    count: number,
    truncated: boolean,
    taskId?: string,
    missing?: boolean
  ): void {
    if (!this.connected) return;
    this.push("history.fetched", {
      requestedAfter,
      ...(lastEventId !== undefined ? { lastEventId } : {}),
      count,
      truncated,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(missing ? { missing: true } : {}),
    });
  }

  /** Answers a `history.list` request — one page of the History list, newest first. */
  pushHistoryIndex(entries: TaskIndexEntry[], hasMore: boolean): void {
    if (!this.connected) return;
    this.push("history.index", { entries, hasMore });
  }

  /** The full current model config — sent in response to `get_model_config`,
   *  and again after any `set_model` that was actually accepted, so the
   *  phone never has to trust its own optimistic guess about what changed. */
  pushModelConfig(roles: { role: Persona; chain: string[] }[], scope: "project" | "global", roleInfo?: RoleInfoWire[]): void {
    if (!this.connected) return;
    this.push("model.config", roleInfo ? { roles, scope, roleInfo } : { roles, scope });
  }

  /** The whole current roadmap, or null when there is none. */
  private lastRoadmapId?: string;
  pushRoadmapState(roadmap: RoadmapWire | null): void {
    if (!this.connected) return;
    const flat = roadmapStateWire(roadmap, this.lastRoadmapId);
    if (roadmap) this.lastRoadmapId = roadmap.roadmapId;
    else this.lastRoadmapId = undefined;
    // `roadmap` is the original payload and is unchanged; the flat fields beside it are what the phone's roadmap card reads.
    this.push("roadmap.state", { roadmap, ...(flat ?? {}), at: new Date().toISOString() } as unknown as Record<string, unknown>);
  }

  /** This desktop's lifetime usage — the complete current snapshot (see the
   *  `usage.totals` event's own doc comment in protocol.ts). */
  pushUsageTotals(totals: UsageTotalsWire): void {
    if (!this.connected) return;
    this.push("usage.totals", totals as unknown as Record<string, unknown>);
  }

  /** One role's candidate list, in response to `list_models`. Never chunked:
   *  even the OpenRouter catalog's full filtered set for one role (a few
   *  hundred entries at most) lands well under the broker's 1MB per-request
   *  cap as plain JSON — nowhere near what actually needs pushDiff/
   *  pushScreenshot's chunking. */
  pushModelCatalog(role: Persona, models: ModelCatalogEntry[]): void {
    if (!this.connected) return;
    this.push("model.catalog", { role, models });
  }

  pushModelCatalogUnavailable(role: Persona, reason: string): void {
    if (!this.connected) return;
    this.push("model.catalog_unavailable", { role, reason });
  }

  updateStatus(patch: Partial<RemoteStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
    this.push("status", { status: this.status });
  }

  askQuestion(q: PendingQuestion): void {
    this.status.pendingQuestions = [...this.status.pendingQuestions.filter((p) => p.id !== q.id), q];
    this.updateStatus({ state: "awaiting-input" });
  }

  resolveQuestion(id: string): void {
    this.status.pendingQuestions = this.status.pendingQuestions.filter((p) => p.id !== id);
    this.updateStatus({ state: this.status.pendingQuestions.length ? "awaiting-input" : "running" });
  }

  /**
   * Fire-and-forget: ask the broker to push a "question"/"done" FCM
   * notification to the paired phone, for whenever it isn't actively
   * watching the live event stream. Never awaited by the caller — a push
   * failing or timing out must never block or fail the run itself.
   */
  notify(kind: "question" | "done"): void {
    if (!this.connected || !this.agentToken) return;
    void fetch(`${this.base()}/v1/push/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
      body: JSON.stringify({ sessionId: this.sessionId, kind }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  private drainOutboxBatch(): Envelope[] {
    const batch: Envelope[] = [];
    let bytes = 0;
    while (this.outbox.length > 0 && batch.length < 100) {
      const nextSize = this.outbox[0].data.length;
      // Always take at least one event even if it alone busts the budget
      // (shouldn't happen at this chunk size, but must never stall).
      if (batch.length > 0 && bytes + nextSize > MAX_BATCH_BYTES) break;
      batch.push(this.outbox.shift()!);
      bytes += nextSize;
    }
    return batch;
  }

  private beginFlushing(): void {
    const tick = async () => {
      if (this.stopped) return;
      if (this.outbox.length > 0 || this.telemetry.pending) {
        const batch = this.drainOutboxBatch();
        const metrics = this.telemetry.drain();
        try {
          const res = await fetch(`${this.base()}/v1/events`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
            body: JSON.stringify({ sessionId: this.sessionId, events: batch, ...(metrics ? { metrics } : {}) }),
            signal: AbortSignal.timeout(15_000),
          });
          const endedBy = await this.endedReasonOf(res);
          if (endedBy !== undefined) {
            await this.handleEnded(endedBy);
            return;
          }
          if (!res.ok) {
            // Non-2xx (500/502/503/429/413): re-queue so events and metrics are not silently dropped.
            // Exception: a single event rejected with 413 Payload Too Large would wedge the queue forever.
            if (res.status === 413 && batch.length <= 1) {
              console.warn(`[REMOTE] ⚠️ Dropping oversized event rejected with HTTP 413 (${batch[0]?.data.length ?? 0} bytes).`);
              this.telemetry.restore(metrics);
            } else {
              this.outbox.unshift(...batch);
              this.telemetry.restore(metrics);
            }
            this.flushFailures++;
          } else {
            this.flushFailures = 0;
          }
        } catch {
          // Put them back; a dropped network must not lose events.
          this.outbox.unshift(...batch);
          this.telemetry.restore(metrics);
          this.flushFailures++;
        }
      }
      const nextDelay =
        this.flushFailures === 0
          ? 900
          : Math.min(15_000, 900 * Math.pow(2, Math.min(this.flushFailures, 5)));
      this.flushTimer = setTimeout(tick, nextDelay);
      this.flushTimer.unref?.();
    };
    void tick();
  }

  // -------------------------------------------------------------- inbound

  private beginPolling(): void {
    const tick = async () => {
      if (this.stopped) return;
      const pollAbort = new AbortController();
      this.pollAbort = pollAbort;
      try {
        const signal =
          typeof AbortSignal.any === "function"
            ? AbortSignal.any([pollAbort.signal, AbortSignal.timeout(40_000)])
            : pollAbort.signal;
        const res = await fetch(
          `${this.base()}/v1/commands?sessionId=${encodeURIComponent(this.sessionId)}`,
          {
            headers: { authorization: `Bearer ${this.agentToken}` },
            signal,
          }
        );
        if (this.stopped) return;
        if (res.ok) {
          const body: any = await res.json();
          if (body.ended) {
            await this.handleEnded(String(body.ended));
            return;
          }
          for (const env of body.commands ?? []) this.handleEnvelope(env);
          // A phone just paired: send this terminal's identity again, in case the first copy aged out of the relay's queue.
          const paired = Boolean(body.paired);
          if (paired && !this.wasPaired) this.pushHello();
          this.wasPaired = paired;
          this.failures = 0;
          this.unauthorizedPolls = 0;
        } else {
          this.failures++;
          // The broker answers 401 for both a bad token and a session it
          // does not have. A restart is covered by its persisted state, so a
          // long unbroken run of them means the relay lost this session
          // (wiped disk, rebuilt VM): say so instead of retrying silently.
          if (res.status === 401) {
            const endedBy = await this.endedReasonOf(res);
            if (endedBy !== undefined) {
              await this.handleEnded(endedBy);
              return;
            }
            this.unauthorizedPolls++;
            if (this.unauthorizedPolls === UNAUTHORIZED_POLLS_BEFORE_WARNING) {
              console.warn(
                `[REMOTE] ⚠️ The relay no longer recognises this session. Run /remote-control to pair your phone again.`
              );
            }
            if (this.unauthorizedPolls >= UNAUTHORIZED_POLLS_BEFORE_STOP) {
              this.stopped = true;
              if (this.flushTimer) clearTimeout(this.flushTimer);
              return;
            }
          } else {
            this.unauthorizedPolls = 0;
          }
        }
      } catch {
        if (this.stopped) return;
        this.failures++;
      } finally {
        if (this.pollAbort === pollAbort) this.pollAbort = undefined;
      }

      if (this.stopped) return;
      const delay = this.failures === 0 ? 0 : POLL_BACKOFF_MS[Math.min(this.failures - 1, POLL_BACKOFF_MS.length - 1)];
      this.pollTimer = setTimeout(tick, delay);
      this.pollTimer.unref?.();
    };
    void tick();
  }

  /**
   * Decrypt and dispatch one command. Anything that fails to decrypt is
   * discarded silently: only a holder of the session key can issue commands,
   * so a compromised broker cannot forge one.
   */
  private handleEnvelope(env: Envelope): void {
    let cmd: RemoteCommand;
    try {
      cmd = open<RemoteCommand>(this.key, env);
    } catch {
      console.warn(`[REMOTE] ⚠️ Discarded a command that failed authentication.`);
      return;
    }

    if (!cmd?.id || this.seenCommands.has(cmd.id)) return; // replay guard
    this.seenCommands.add(cmd.id);
    // Evict the OLDEST entries once over the cap (a Set preserves insertion
    // order in JS) rather than clearing everything at once — a full clear
    // left every command from before the reset replayable again the instant
    // the cap was hit, defeating the guard for the next 1000 commands.
    while (this.seenCommands.size > 1000) {
      const oldest = this.seenCommands.values().next().value;
      if (oldest === undefined) break;
      this.seenCommands.delete(oldest);
    }

    const verb = cmd.payload?.verb as RemoteVerb["verb"];
    if (!this.isPermitted(verb)) {
      const reason = `"${verb}" is not enabled for this run`;
      console.warn(`[REMOTE] ⚠️ Refused verb "${verb}" (not enabled for this run).`);
      // Structured, not just the console line above — a phone that sent this
      // needs to detect its OWN message was rejected specifically (to
      // restore the composer text and explain why), not just see one more
      // line in a scrolling log it might not be looking at.
      this.push("command.refused", { verb, reason });
      return;
    }

    const p = cmd.payload;

    // Liveness probe, answered before the audit/echo below on purpose: a ping
    // must leave no trace — no console audit line, and no durable
    // command.accepted (which would get an eventId, show up in fetch_history,
    // and read as activity). The pong itself is already unpersisted
    // (NOT_PERSISTED_KINDS). It stays in seq order with the rest of the outbox:
    // seqs are fixed at push time, and a pong that jumped the queue would make
    // the phone see a gap and then skip the queued events below its cursor.
    if (p.verb === "ping") {
      this.push("pong", {});
      return;
    }

    // Every remote action is echoed locally, so the terminal is always an
    // audit log — with the actual content, not just the verb name, since
    // "received: answer" tells you nothing about what was answered.
    // Attachment chunks are the one exception: a completed upload already
    // gets its own one-line summary in the "attach" case below, so logging
    // this generic line per chunk too would mean 50+ near-duplicate lines
    // for one file instead of one.
    // Same reasoning as the console.log above: a completed attach already
    // gets its own one-line summary ("attach.done"/"attach.rejected") once
    // the whole file lands, so pushing "command.accepted" per chunk too
    // means 50+ near-duplicate lines in the phone's activity feed for one
    // image instead of one.
    // The echo is for the terminal only: the phone knows what it just did (and gets command.accepted). Mirrored, it put the phone's
    // own prompt back into whatever worker was running, and filled worker consoles with passive views (browsing History, a diff).
    if (p.verb !== "attach") {
      logLocal(`[REMOTE] 📱 ${describePhoneCommand(p)}`);
      this.push("command.accepted", phoneCommandEcho(p, this.opts.redactLogs, this.status.taskId));
    }

    this.telemetry.observeCommand(p.verb);

    switch (p.verb) {
      case "abort":
        this.handlers?.onAbort(p.reason);
        break;
      case "answer":
        this.handlers?.onAnswer(p.questionId, p.answer);
        break;
      case "approve":
        this.handlers?.onAnswer(p.questionId, "");
        break;
      case "reject":
        this.handlers?.onAnswer(p.questionId, p.reason ?? "rejected");
        break;
      case "message":
        this.handlers?.onMessage(p.text);
        break;
      case "attach":
        try {
          const done = this.uploads?.accept(p);
          if (done) {
            console.log(`[REMOTE] 📎 Received ${done.name} (${(done.bytes / 1024).toFixed(0)} KB)`);
            this.handlers?.onAttach(done.filePath, done.name);
            this.push("attach.done", { name: done.name, bytes: done.bytes, taskId: this.status.taskId || undefined });
          }
        } catch (err: any) {
          console.log(`[REMOTE] 📎 Upload rejected: ${err.message}`);
          this.push("attach.rejected", { reason: err.message });
        }
        break;
      case "fetch_diff":
        this.handlers?.onFetchDiff(p.changeId);
        break;
      case "fetch_history":
        this.handlers?.onFetchHistory({ after: p.after, afterEventId: p.afterEventId, taskId: p.taskId });
        break;
      case "history.list":
        this.handlers?.onHistoryList(Math.min(p.limit ?? 50, 100), p.beforeTaskId);
        break;
      case "fetch_screenshot":
        this.handlers?.onFetchScreenshot(p.path);
        break;
      case "get_model_config":
        this.handlers?.onGetModelConfig();
        break;
      case "get_roadmap":
        this.handlers?.onGetRoadmap?.();
        break;
      case "get_usage":
        this.handlers?.onGetUsage();
        break;
      case "list_models":
        this.handlers?.onListModels(p.role, p.exclude);
        break;
      case "set_model":
        this.handlers?.onSetModel(p.role, p.chain);
        break;
    }
  }

  private isPermitted(verb: string): boolean {
    if (ALWAYS_ALLOWED.includes(verb as any)) return true;
    if (["answer", "approve", "reject", "message"].includes(verb)) return this.opts.allowAnswer;
    // Reference material is inert data, gated with the same consent as answering.
    if (verb === "attach") return this.opts.allowAnswer;
    // Actually changing a model chain is a real write, same consent tier as
    // answering a question — get_model_config/list_models (pure reads) are
    // in ALWAYS_ALLOWED above and never reach this check.
    if (verb === "set_model") return this.opts.allowAnswer;
    return false;
  }

  // --------------------------------------------------------------- teardown

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    // Never durably persisted (session.end is in NOT_PERSISTED_KINDS, push's
    // own single choke point for that) -- it describes THIS ephemeral broker
    // session's teardown, not anything about the actual task, and replaying
    // it into a future, still-very-much-alive session would wrongly tell
    // that brand-new session to discard its own credentials and stop
    // polling. Still delivered live here, in case a phone is watching this
    // exact session right now and can use the signal.
    this.push("session.end", { reason });

    // Cancel timers and any in-flight 40s command long-poll immediately so teardown never hangs.
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.pollAbort?.abort();

    // Best-effort final flush respecting MAX_BATCH_BYTES and the 100-event cap, within a bounded deadline.
    const flushDeadline = Date.now() + 4_000;
    while ((this.outbox.length > 0 || this.telemetry.pending) && Date.now() < flushDeadline) {
      const batch = this.drainOutboxBatch();
      const metrics = this.telemetry.drain();
      const remainingMs = Math.max(500, flushDeadline - Date.now());
      try {
        const res = await fetch(`${this.base()}/v1/events`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
          body: JSON.stringify({
            sessionId: this.sessionId,
            events: batch,
            ...(metrics ? { metrics } : {}),
          }),
          signal: AbortSignal.timeout(remainingMs),
        });
        if (!res.ok) break;
      } catch {
        break;
      }
    }

    // Delete the session on the broker right now rather than leaving it for
    // the 12h TTL sweep — otherwise a re-pairing agent's OLD session keeps
    // showing up in /healthz, and a phone still holding its old token can
    // keep polling it, indefinitely.
    try {
      await fetch(`${this.base()}/v1/unregister`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
        body: JSON.stringify({ sessionId: this.sessionId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}
