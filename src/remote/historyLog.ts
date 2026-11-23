/**
 * Durable, desktop-side record of every event RemoteSession.push() (client.ts)
 * has ever sent for a repo — independent of any particular broker session's
 * lifetime.
 *
 * The broker (broker.ts) only ever holds one session's events in memory, and
 * every desktop restart explicitly deletes that session (POST /v1/unregister)
 * before a fresh one starts — by design, not a bug, but it means a brand-new
 * pairing after a restart has genuinely nothing to sync. This file is what
 * makes the DESKTOP (not the ephemeral broker session) the durable source of
 * truth: appendHistoryEntry is called from inside push() itself — the single
 * choke point EVERY outbound event goes through, translated agent events AND
 * `status` pushes alike — rather than a narrower per-caller hook that would
 * silently miss `status`, which is what the Android app's own task-history
 * feature turns out to be entirely keyed on (see the protocol spec's "History
 * across sessions"). RemoteSession.replayHistory() then seeds a freshly-paired
 * session's outbox from this log — the phone needs no special handling for
 * it, replayed entries are indistinguishable from live ones on the wire.
 *
 * Persistence requires a RemoteSession to have registered at least once this
 * process (push()'s `this.connected` check) — a task run with /remote-control
 * never invoked at all still isn't captured. Accepted tradeoff: the Android
 * app's history can't materialize a task it never learned about via `status`
 * regardless of what the desktop does, so capturing granular detail with no
 * accompanying status for it would be dead weight.
 *
 * Plaintext on disk, same trust level as every other piece of per-repo state
 * under .agent/ (codebase-memory.json, ui-flows.json, ...) — the desktop
 * already generated this content in plaintext to begin with (it's the
 * encryption source for the wire protocol, not a downstream consumer of it),
 * so this adds no new exposure.
 *
 * ---- On-disk layout: one file per task, not one file for the whole repo ----
 *
 * Stored as `.agent/remote_history/<segment>.jsonl`, where a "segment" is
 * either:
 *   - a TASK, bounded by that task's own `task.start`/`task.end`:
 *       `<taskId>_<firstEventId>-<lastEventId>.jsonl`
 *   - a BETWEEN segment, everything between one task ending and the next
 *     one starting (idle-time `/ask` exchanges, the idle/awaiting-input
 *     status, a prompt's own `command.accepted` arriving before its
 *     `task.start`, model-picker browsing, ...), or before the very first
 *     task this repo has ever run:
 *       `between_<firstEventId>-<lastEventId>.jsonl`
 * While a segment is still open (no task.end / no next task.start yet), its
 * filename ends in `-open.jsonl` instead of a real `lastEventId` — renamed to
 * the real range the moment it closes. No manifest file: the range is the
 * only index, and it's enough to let a reader skip whole files it can't
 * possibly need (see readHistoryBacklogSinceEventId below).
 *
 * This replaces an earlier design (one growing `.agent/remote_history.jsonl`
 * file for the entire repo, trimmed once it crossed a size/entry cap) that
 * had exactly the failure mode a cap implies: a long-lived project running
 * hundreds of tasks permanently lost its early history mid-task, the moment
 * the cap was hit — losing an arbitrary chunk of a task's own middle, not
 * even a clean task-sized bite. Per-task files fix the SHAPE of that problem
 * (nothing is ever lost mid-task again) and MAX_RETAINED_TASKS below fixes
 * the actual disk-growth concern it was trying to solve, properly this
 * time: evicting whole tasks, oldest first, never a task's own middle. A
 * PHONE — which genuinely can't afford to mirror an entire project's
 * lifetime into local storage — keeps only a bounded recent window of its
 * own and pages back further on demand via `fetch_history`, exactly the
 * mechanism that already existed for gap recovery; it already has to
 * tolerate older history being gone, so desktop-side eviction costs it
 * nothing new. No new dependency either: this is plain fs, not an embedded
 * database — the access pattern here (append sequentially, occasionally
 * re-read a bounded range, occasionally delete whole old files) never
 * needed a query engine, and a plaintext per-task file is something a human
 * can still `cat`/`grep` directly, which an opaque DB file is not.
 *
 * No migration from the old single-file layout: this predates any real
 * release, so an old `.agent/remote_history.jsonl` (if one exists from
 * earlier testing) is simply ignored — it lives at a different path than
 * this directory and is never read by anything here.
 */

import fsSync from "fs";
import path from "path";
import { REDACTED_EVENT_KINDS, TaskIndexEntry } from "./protocol.js";

export interface HistoryEntry {
  /** Absent only on entries written before this field existed — see
   *  allocateEventId's own comment. Every entry written from here on has one. */
  eventId?: number;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

function historyDir(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "remote_history");
}

/** Filesystem-unsafe characters replaced, never left out entirely — a
 *  stray slash or colon in a taskId must not escape the history directory
 *  or collide with the range suffix this scheme parses on. */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}

interface OpenSegment {
  /** Absolute path, always ending in "-open.jsonl" while this is current. */
  path: string;
  firstEventId: number;
  /** Present for a task segment, absent for a between segment. */
  taskId?: string;
}

/** The segment currently being appended to, per repo — undefined only for a
 *  repo that has never had anything appended to it yet this process. */
const openSegment = new Map<string, OpenSegment>();

/**
 * The next eventId to assign, per repo — strictly increasing, never reset,
 * survives a desktop restart. Seeded lazily, once per process per repo, from
 * whatever's already on disk (every closed segment's filename-embedded
 * `lastEventId`, plus a read of the one open segment's own contents, since
 * its filename alone doesn't encode a last id yet) — see ensureInitialized.
 */
const nextEventIds = new Map<string, number>();

/** Repos whose on-disk state has already been scanned this process — see ensureInitialized. */
const initializedRepos = new Set<string>();

interface ParsedSegmentFilename {
  filename: string;
  taskId?: string;
  firstEventId: number;
  /** undefined means this segment is still open. */
  lastEventId?: number;
}

// Matches both "<name>_<first>-<last>.jsonl" and "<name>_<first>-open.jsonl".
// `name` is greedy on purpose: a taskId never contains an underscore (see its
// own generator in index.ts), so the only "_" in a real filename is the one
// this regex anchors on, and greedy `.+` simply finds it without needing a
// non-greedy modifier.
const SEGMENT_FILENAME = /^(.+)_(\d+)-(open|\d+)\.jsonl$/;

function parseSegmentFilename(filename: string): ParsedSegmentFilename | undefined {
  const m = SEGMENT_FILENAME.exec(filename);
  if (!m) return undefined;
  const [, name, firstStr, lastRaw] = m;
  return {
    filename,
    taskId: name === "between" ? undefined : name,
    firstEventId: Number(firstStr),
    lastEventId: lastRaw === "open" ? undefined : Number(lastRaw),
  };
}

/** Parses one JSONL line into a HistoryEntry, or undefined for a blank or
 *  corrupt line (a partial write from a crash) — never throws. */
function parseLine(line: string): HistoryEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed.kind === "string" &&
      typeof parsed.at === "string" &&
      parsed.payload &&
      typeof parsed.payload === "object"
    ) {
      return {
        ...(typeof parsed.eventId === "number" ? { eventId: parsed.eventId } : {}),
        kind: parsed.kind,
        payload: parsed.payload,
        at: parsed.at,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Reads one segment file's entries, oldest first, or [] if it's gone/unreadable. */
function readSegmentFile(filePath: string): HistoryEntry[] {
  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Scans this repo's history directory exactly once per process (cheap after
 * that — a Set lookup) to establish two things from whatever's already on
 * disk: the eventId counter's seed, and which segment (if any) is still
 * open. Every CLOSED segment's range is read straight from its filename —
 * no file open needed; only the one OPEN segment (naturally small, bounded
 * by however much of one task/between-segment it's seen so far) is actually read, to
 * find its own highest eventId since an open filename doesn't carry one yet.
 */
function ensureInitialized(repoRoot: string): void {
  if (initializedRepos.has(repoRoot)) return;
  initializedRepos.add(repoRoot);

  const dir = historyDir(repoRoot);
  let filenames: string[] = [];
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    filenames = fsSync.readdirSync(dir);
  } catch {
    // Unreadable/unwritable dir: proceed as if empty — appendHistoryEntry's
    // own best-effort posture takes it from here.
  }

  let maxEventId = 0;
  let openInfo: ParsedSegmentFilename | undefined;
  for (const filename of filenames) {
    const info = parseSegmentFilename(filename);
    if (!info) continue; // ignore anything unrecognized rather than failing the whole scan
    if (info.lastEventId === undefined) {
      // There should be at most one open segment. If more than one somehow
      // exists (e.g. a rename interrupted mid-write by a crash), keep the
      // one that started most recently — the other is an orphaned file
      // nothing reads from here on, same best-effort posture as elsewhere.
      if (!openInfo || info.firstEventId > openInfo.firstEventId) openInfo = info;
    } else if (info.lastEventId > maxEventId) {
      maxEventId = info.lastEventId;
    }
  }

  if (openInfo) {
    const entries = readSegmentFile(path.join(dir, openInfo.filename));
    for (const e of entries) {
      if (typeof e.eventId === "number" && e.eventId > maxEventId) maxEventId = e.eventId;
    }
    openSegment.set(repoRoot, {
      path: path.join(dir, openInfo.filename),
      firstEventId: openInfo.firstEventId,
      taskId: openInfo.taskId,
    });
  }

  nextEventIds.set(repoRoot, maxEventId + 1);
}

function allocateEventId(repoRoot: string): number {
  ensureInitialized(repoRoot);
  const next = nextEventIds.get(repoRoot)!;
  nextEventIds.set(repoRoot, next + 1);
  return next;
}

/** Renames an open segment to its real, final range — best-effort, matching
 *  this module's posture everywhere else (a failed rename just leaves the
 *  segment looking "open" forever, which reconcileInterruptedTask already
 *  knows how to find and isn't wrong about: nothing more was ever added to it). */
function finalizeSegment(segment: OpenSegment, lastEventId: number): void {
  const closedPath = segment.path.replace(/-open\.jsonl$/, `-${lastEventId}.jsonl`);
  try {
    fsSync.renameSync(segment.path, closedPath);
  } catch {
    // Best-effort.
  }
}

function writeLine(filePath: string, entry: { eventId: number; kind: string; payload: Record<string, unknown>; at: string }): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function taskIndexPath(repoRoot: string): string {
  return path.join(historyDir(repoRoot), "tasks.index");
}

/** One line per task, in the order they were last written (oldest-ish
 *  first, but not guaranteed strictly — see updateTaskIndex) — [] if the
 *  index doesn't exist yet. Never throws; a corrupt line is skipped. */
function readTaskIndex(repoRoot: string): TaskIndexEntry[] {
  let raw: string;
  try {
    raw = fsSync.readFileSync(taskIndexPath(repoRoot), "utf-8");
  } catch {
    return [];
  }
  const entries: TaskIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.taskId === "string") entries.push(parsed);
    } catch {
      // Skip a corrupt line, same posture as parseLine for the event files.
    }
  }
  return entries;
}

/** Rewrites the whole index — small by construction (at most
 *  MAX_RETAINED_TASKS lines), so a wholesale rewrite on every task.start/
 *  plan.ready/task.end is cheap, unlike doing this for the event files. */
function writeTaskIndex(repoRoot: string, entries: TaskIndexEntry[]): void {
  try {
    fsSync.mkdirSync(historyDir(repoRoot), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    fsSync.writeFileSync(taskIndexPath(repoRoot), body.length > 0 ? `${body}\n` : "", "utf-8");
  } catch {
    // Best-effort — see this file's posture everywhere else.
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0];
}

/**
 * Creates or updates this task's own single line in tasks.index — a no-op
 * for any kind other than task.start (create), plan.ready (refresh title/
 * phaseCount once the plan is known), and task.end (finalize state/endedAt/
 * usage/lastEventId). One line per taskId, rewritten in place, never
 * duplicated — see this file's own TaskIndexEntry-adjacent comments.
 */
function updateTaskIndex(
  repoRoot: string,
  kind: string,
  payload: Record<string, unknown>,
  eventId: number,
  at: string,
  repoName: string | undefined
): void {
  if (kind !== "task.start" && kind !== "plan.ready" && kind !== "task.end") return;
  const taskId = (payload as any).taskId;
  if (typeof taskId !== "string") return;

  const entries = readTaskIndex(repoRoot);
  const idx = entries.findIndex((e) => e.taskId === taskId);

  if (kind === "task.start") {
    const prompt = typeof (payload as any).prompt === "string" ? (payload as any).prompt : "";
    const attachments = Array.isArray((payload as any).attachments) ? (payload as any).attachments : [];
    const entry: TaskIndexEntry = {
      taskId,
      repoName,
      title: firstLine(prompt),
      prompt: firstLine(prompt),
      state: "running",
      startedAt: at,
      endedAt: null,
      firstEventId: eventId,
      lastEventId: null,
      attachments,
    };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  } else if (idx >= 0) {
    if (kind === "plan.ready") {
      const goal = typeof (payload as any).goal === "string" ? (payload as any).goal : undefined;
      const phases = Array.isArray((payload as any).phases) ? (payload as any).phases : [];
      if (goal) entries[idx].title = firstLine(goal);
      entries[idx].phaseCount = phases.length;
    } else if (kind === "task.end") {
      const state = (payload as any).state;
      entries[idx].state = state === "failed" || state === "aborted" || state === "interrupted" ? state : "done";
      entries[idx].endedAt = at;
      if (typeof (payload as any).tokensUsed === "number") entries[idx].tokensUsed = (payload as any).tokensUsed;
      if (typeof (payload as any).costUsd === "number") entries[idx].costUsd = (payload as any).costUsd;
      entries[idx].lastEventId = eventId;
    }
  }
  // else: plan.ready/task.end for a taskId with no task.start entry at all —
  // shouldn't happen in practice (task.start always precedes them), so this
  // is a silent no-op rather than fabricating a partial entry.

  writeTaskIndex(repoRoot, entries);
}

/**
 * How many most-recently-started tasks this repo keeps on disk — see this
 * file's own top-of-file comment for why a count-based cap, evicting whole
 * tasks oldest-first, replaces the old byte/entry trim that could lose an
 * arbitrary chunk out of a task's own middle. New tasks are never blocked by
 * this (appendHistoryEntry always writes immediately); only a task.end ever
 * triggers eviction, and only of whatever's now the oldest.
 */
const MAX_RETAINED_TASKS = 1000;

/** Test-only override for MAX_RETAINED_TASKS — never called from production
 *  code, which always uses the real constant above. Lets a retention test
 *  exercise eviction with a handful of tasks instead of 1,000+ real ones. */
let maxRetainedTasksOverride: number | undefined;
export function _setMaxRetainedTasksForTesting(n: number | undefined): void {
  maxRetainedTasksOverride = n;
}

/**
 * Deletes whichever CLOSED segments are now older than the most recent
 * MAX_RETAINED_TASKS tasks — both the evicted tasks' own files and any
 * between-segment that chronologically precedes the oldest still-retained
 * task (it has no surviving task on either side to give it context once
 * that task is gone, so there's nothing left worth keeping it for). Never
 * touches the one currently-open segment. A no-op, cheaply (one directory
 * listing, no file content reads), once the task count is at or under the
 * cap — the common case for the entire lifetime of most projects.
 */
function enforceRetention(repoRoot: string): void {
  const cap = maxRetainedTasksOverride ?? MAX_RETAINED_TASKS;
  const dir = historyDir(repoRoot);
  let filenames: string[];
  try {
    filenames = fsSync.readdirSync(dir);
  } catch {
    return;
  }

  const closedTasks: { firstEventId: number; taskId: string }[] = [];
  for (const filename of filenames) {
    const info = parseSegmentFilename(filename);
    if (info && info.taskId !== undefined && info.lastEventId !== undefined) closedTasks.push({ firstEventId: info.firstEventId, taskId: info.taskId });
  }
  if (closedTasks.length <= cap) return;

  closedTasks.sort((a, b) => b.firstEventId - a.firstEventId); // newest first
  const oldestRetainedFirstEventId = closedTasks[cap - 1].firstEventId;
  const evictedTaskIds = new Set<string>();

  for (const filename of filenames) {
    const info = parseSegmentFilename(filename);
    if (!info || info.lastEventId === undefined) continue; // never touch the one open segment
    if (info.firstEventId < oldestRetainedFirstEventId) {
      if (info.taskId !== undefined) evictedTaskIds.add(info.taskId);
      try {
        fsSync.unlinkSync(path.join(dir, filename));
      } catch {
        // Best-effort — see this file's posture everywhere else.
      }
    }
  }

  if (evictedTaskIds.size > 0) {
    writeTaskIndex(repoRoot, readTaskIndex(repoRoot).filter((e) => !evictedTaskIds.has(e.taskId)));
  }
}

/**
 * Appends one translated event to this repo's durable history log. Best-
 * effort and never throws: losing one history entry is far cheaper than a
 * disk hiccup taking down the whole run.
 *
 * Silently skips the same kinds RemoteSession's live push already redacts
 * when redactLogs is on — durable storage must never be a more permissive
 * copy of data the user already opted out of streaming live.
 *
 * `task.start`/`task.end` are the segment boundaries: a `task.start` closes
 * whatever between segment was open (if any) and opens a fresh task segment;
 * a `task.end` is written into the current task segment, which is then
 * closed, leaving no segment open until the next event (task or otherwise)
 * lazily opens a new between segment.
 *
 * `repoName` is only ever consulted for `task.start` (tasks.index's own
 * entry) — every other kind ignores it, so every existing call site that
 * doesn't pass one keeps working unchanged.
 */
export function appendHistoryEntry(
  repoRoot: string,
  kind: string,
  payload: Record<string, unknown>,
  at: string,
  redactLogs: boolean,
  repoName?: string
): number | undefined {
  if (redactLogs && REDACTED_EVENT_KINDS.has(kind)) return undefined;
  try {
    const eventId = allocateEventId(repoRoot);
    const dir = historyDir(repoRoot);

    if (kind === "task.start") {
      const previous = openSegment.get(repoRoot);
      if (previous) finalizeSegment(previous, eventId - 1);
      const taskId = sanitizeForFilename(String((payload as any).taskId ?? "unknown"));
      const fresh: OpenSegment = { path: path.join(dir, `${taskId}_${eventId}-open.jsonl`), firstEventId: eventId, taskId };
      openSegment.set(repoRoot, fresh);
      writeLine(fresh.path, { eventId, kind, payload, at });
      updateTaskIndex(repoRoot, kind, payload, eventId, at, repoName);
      return eventId;
    }

    let current = openSegment.get(repoRoot);
    if (!current) {
      current = { path: path.join(dir, `between_${eventId}-open.jsonl`), firstEventId: eventId };
      openSegment.set(repoRoot, current);
    }
    writeLine(current.path, { eventId, kind, payload, at });

    if (kind === "plan.ready" || kind === "task.end") {
      updateTaskIndex(repoRoot, kind, payload, eventId, at, repoName);
    }

    if (kind === "task.end") {
      finalizeSegment(current, eventId);
      openSegment.delete(repoRoot);
      enforceRetention(repoRoot);
    }

    return eventId;
  } catch {
    // Best-effort — see doc comment above.
    return undefined;
  }
}

/** Every segment file for this repo (closed and open alike), oldest first —
 *  the only index this scheme has; sufficient to skip whole files a given
 *  read can't possibly need (see readHistoryBacklogSinceEventId). */
function listSegments(repoRoot: string): { path: string; firstEventId: number; lastEventId?: number; taskId?: string }[] {
  ensureInitialized(repoRoot);
  const dir = historyDir(repoRoot);
  let filenames: string[] = [];
  try {
    filenames = fsSync.readdirSync(dir);
  } catch {
    return [];
  }
  const segments: { path: string; firstEventId: number; lastEventId?: number; taskId?: string }[] = [];
  for (const filename of filenames) {
    const info = parseSegmentFilename(filename);
    if (!info) continue;
    segments.push({ path: path.join(dir, filename), firstEventId: info.firstEventId, lastEventId: info.lastEventId, taskId: info.taskId });
  }
  segments.sort((a, b) => a.firstEventId - b.firstEventId);
  return segments;
}

/**
 * Everything from the start of the NEWEST task segment onward (open or
 * closed), plus every between-segment after it — used to cap a brand-new
 * pairing's initial replay to the
 * current task/screen instead of a project's entire history. Anything
 * older is fetched on demand via `history.list` + `fetch_history{taskId}`.
 * Falls back to everything when no task has ever run yet (there's nothing
 * older to cap away from).
 */
function readFromNewestTask(repoRoot: string): HistoryEntry[] {
  const segments = listSegments(repoRoot);
  let startIndex = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].taskId !== undefined) {
      startIndex = i;
      break;
    }
  }
  const entries: HistoryEntry[] = [];
  for (let i = startIndex; i < segments.length; i++) entries.push(...readSegmentFile(segments[i].path));
  return entries;
}

/** Reads this repo's durable history, oldest first, across every segment —
 *  [] if none exist yet. Never throws; a corrupt line is skipped, not fatal. */
export function readHistoryBacklog(repoRoot: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const seg of listSegments(repoRoot)) entries.push(...readSegmentFile(seg.path));
  return entries;
}

/**
 * Like readHistoryBacklog, but only returns entries not already handed out
 * by a PREVIOUS call to this function for this repo, and advances the
 * watermark to cover them.
 *
 * This exists because RemoteSession.replayHistory() (client.ts) feeds its
 * result straight into a freshly (re-)paired session's outbox, indistinguishable
 * from a live event on the wire. Without this, EVERY re-pairing — leaving and
 * reopening the phone app, reconnecting after a dropped connection, anything
 * that spins up a new session — replayed the entire accumulated history
 * again from the start, including events already delivered and rendered on a
 * previous pairing (a duplicate "plan ready" card for every single re-pair,
 * compounding forever). For a personal, single-user tool where realistically
 * one phone is ever watching one desktop at a time, "only what's new since I
 * was last connected" is the correct semantics — not "everything, every
 * time." The very first pairing still gets full history, since the watermark
 * starts at 0.
 *
 * A plain entry COUNT, not an eventId — this used to also need adjusting
 * whenever a trim dropped entries out from under it; now that nothing is
 * ever trimmed (see this file's own doc comment), that concern is gone, and
 * a count stays exactly as simple as it looks.
 *
 * The very first call for a repo this process (watermark still 0 — i.e. a
 * brand-new pairing since startup, not a reconnect that already caught up
 * once) is capped to readFromNewestTask rather than the full project
 * history — everything older is
 * available on demand via `history.list` + `fetch_history{taskId}`. The
 * watermark still advances to the TRUE total either way, so nothing older
 * is ever replayed live later either; it was never meant to be.
 */
export function readHistoryBacklogForReplay(repoRoot: string): HistoryEntry[] {
  const watermark = readReplayWatermark(repoRoot);
  const all = readHistoryBacklog(repoRoot);
  const fresh = watermark === 0 ? readFromNewestTask(repoRoot) : all.slice(Math.min(watermark, all.length));
  writeReplayWatermark(repoRoot, all.length);
  return fresh;
}

/**
 * Deliberately IN-MEMORY, not persisted to disk: this must reset to 0 on
 * every fresh process start, not just every fresh pairing. `--resume` (or
 * any restart) is a brand-new process, and it has no way to know what a
 * reconnecting phone's own local state actually still holds — a disk-backed
 * watermark that survived the restart would (and did) wrongly withhold the
 * task's original goal/prompt event on the resumed process's first-ever
 * pairing, since it looked "already replayed" from the PREVIOUS process's
 * point of view. Scoped per repoRoot so unrelated repos (and, incidentally,
 * separate test fixtures within one test run) never share a counter.
 */
const replayWatermarks = new Map<string, number>();

function readReplayWatermark(repoRoot: string): number {
  return replayWatermarks.get(repoRoot) ?? 0;
}

function writeReplayWatermark(repoRoot: string, count: number): void {
  replayWatermarks.set(repoRoot, count);
}

/**
 * Entries strictly after a given ISO timestamp, oldest first, capped at
 * `limit`. The desktop side of phone-initiated gap recovery (the
 * `fetch_history` remote command, client.ts): the broker only keeps the
 * newest 500 events per session in memory (`MAX_QUEUE` in broker.ts), so a
 * long enough gap — the phone asleep overnight through a busy task — can
 * permanently drop events from the broker's own buffer before the phone ever
 * polls for them. This is what lets the phone ask the DESKTOP, the only
 * place with the full durable record, to re-serve what the broker lost.
 *
 * Keyed on `at`, not a seq number: the durable log has no concept of the
 * broker's per-session seq (meaningless across sessions — see
 * readHistoryBacklogForReplay's own comment), but it does carry each entry's
 * original timestamp, which is stable across every session that ever existed
 * for this repo.
 *
 * Oldest-first and capped (not newest-first): recovering a gap in
 * chronological order is what lets a client page forward through a large gap
 * strictly — request 1 returns entries [after, after+limit), and a client
 * that got `truncated: true` back simply asks again with THIS batch's last
 * entry's `at` as the next `after`, continuing until `truncated: false`.
 *
 * Legacy path, kept for a phone build that only knows `fetch_history`'s old
 * `{ after: "<iso>" }` form — see readHistoryBacklogSinceEventId below for
 * why a NEW client should always prefer `afterEventId` instead: a timestamp
 * is not a safe page boundary when two or more events share the same
 * millisecond (routine under real load), since `e.at > afterIso` can't tell
 * them apart — some land before the cut, some after, with no guarantee every
 * one of them ends up on exactly one side. Unlike readHistoryBacklogSinceEventId,
 * this can't skip whole segment files by range (a segment's filename carries
 * no timestamp), so it always reads the full backlog — acceptable for a
 * fallback path that's explicitly not the one new clients should use.
 */
export function readHistoryBacklogSince(
  repoRoot: string,
  afterIso: string,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  const filtered = readHistoryBacklog(repoRoot).filter((e) => e.at > afterIso);
  if (filtered.length <= limit) return { entries: filtered, truncated: false };
  return { entries: filtered.slice(0, limit), truncated: true };
}

/**
 * Entries with `eventId > afterEventId`, oldest first, capped at `limit` —
 * the preferred `fetch_history` cursor (see readHistoryBacklogSince's own
 * comment for why `at` alone isn't a safe page boundary). `eventId` is a
 * strict integer order with no possible ties, so this can never drop or
 * duplicate an event at a page boundary the way timestamp-based paging can.
 * An entry with no eventId at all (written before that field existed) is
 * never returned here — a client paging by id has no way to place it anyway;
 * it's still reachable via the legacy readHistoryBacklogSince.
 *
 * A CLOSED segment entirely at or before `afterEventId` is skipped without
 * ever being opened — the whole point of embedding each segment's range in
 * its filename. Only segments that might actually contain a matching event
 * (plus the one open segment, whose upper bound is unknown) are read.
 */
export function readHistoryBacklogSinceEventId(
  repoRoot: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean } {
  const result: HistoryEntry[] = [];
  let truncated = false;
  for (const seg of listSegments(repoRoot)) {
    if (seg.lastEventId !== undefined && seg.lastEventId <= afterEventId) continue;
    const matching = readSegmentFile(seg.path).filter((e) => typeof e.eventId === "number" && e.eventId > afterEventId);
    for (const e of matching) {
      if (result.length >= limit) {
        truncated = true;
        break;
      }
      result.push(e);
    }
    if (truncated) break;
  }
  return { entries: result, truncated };
}

/**
 * One page of the History list, newest first — the desktop side of
 * `history.list`. `beforeTaskId` pages strictly older than that task;
 * omitted, starts from the newest. `hasMore` tells the client whether to
 * page again with this page's last (oldest) entry's taskId.
 */
export function listTasks(repoRoot: string, limit: number, beforeTaskId?: string): { entries: TaskIndexEntry[]; hasMore: boolean } {
  const newestFirst = readTaskIndex(repoRoot).slice().reverse();
  let start = 0;
  if (beforeTaskId !== undefined) {
    const idx = newestFirst.findIndex((e) => e.taskId === beforeTaskId);
    start = idx >= 0 ? idx + 1 : newestFirst.length;
  }
  const page = newestFirst.slice(start, start + limit);
  const hasMore = start + page.length < newestFirst.length;
  return { entries: page, hasMore };
}

/**
 * One task's own events only, in `eventId` order, strictly after
 * `afterEventId` — the desktop side of `fetch_history{taskId}` (opening a
 * task from the History list). `missing: true` when no file for this
 * taskId exists at all (unknown taskId, or evicted by retention) — distinct
 * from a genuine "nothing past this point" answer for a real task.
 */
export function readTaskEvents(
  repoRoot: string,
  taskId: string,
  afterEventId: number,
  limit: number
): { entries: HistoryEntry[]; truncated: boolean; missing: boolean } {
  const sanitized = sanitizeForFilename(taskId);
  const match = listSegments(repoRoot).find((seg) => seg.taskId === sanitized);
  if (!match) return { entries: [], truncated: false, missing: true };

  const matching = readSegmentFile(match.path).filter((e) => typeof e.eventId === "number" && e.eventId > afterEventId);
  if (matching.length <= limit) return { entries: matching, truncated: false, missing: false };
  return { entries: matching.slice(0, limit), truncated: true, missing: false };
}

/**
 * Closes an orphaned task segment left open by a process that ended (crash,
 * kill, `/stop` racing process exit) before its own `task.end` could be
 * written — called once at startup, unconditionally, so a client paging
 * through `fetch_history`/replay never sees a task that looks like it's
 * still running forever. A no-op when the currently open segment is a
 * BETWEEN segment (nothing to reconcile — it has no completion invariant to
 * enforce) or when there's no open segment at all (a brand-new repo).
 *
 * tokensUsed/costUsd are deliberately omitted: the crashed process's own
 * usage tracker (events.ts's in-memory EventBus) died with it, so there is
 * nothing honest to report, and both fields are optional for exactly this
 * reason.
 */
export function reconcileInterruptedTask(repoRoot: string): void {
  ensureInitialized(repoRoot);
  const current = openSegment.get(repoRoot);
  if (current && current.taskId) {
    // appendHistoryEntry's own task.end handling already calls
    // enforceRetention, so the call below is redundant in this branch —
    // left as an explicit, unconditional call regardless of branch so a
    // lowered MAX_RETAINED_TASKS between versions still gets cleaned up on
    // the very next startup, not just whenever a task next happens to end.
    appendHistoryEntry(repoRoot, "task.end", { taskId: current.taskId, state: "interrupted" }, new Date().toISOString(), false);
  }
  enforceRetention(repoRoot);
}
