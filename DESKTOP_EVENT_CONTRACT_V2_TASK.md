# Task: Event Contract v2 — make every event self-identifying

**For:** desktop dev · **From:** phone (Android + Expo) · **Priority order:** 1 → 6

## Why

The phone builds the dashboard and history from the desktop's event log (see `PHONE_HISTORY_SPEC.md`). Today several facts the desktop knows for certain are *guessed* by the phone:

| The phone currently guesses… | …from |
|---|---|
| whether two events are the same event (replay vs. live) | a hash of the event's JSON |
| event order | the `at` timestamp (ms collisions, missing `at`) |
| which worker a diff / QA check / log line belongs to | agent name, "newest open worker", `[TAG]` text prefixes |
| where a task starts and ends | status `state` transitions and event position |
| which task `manual.steps`, prompts and logs belong to | position in the stream |
| that a second PLANNER is a corrective pass | "planner restarted before any plan exists" |
| what the user typed | parsing `[REMOTE] 📱 message: "…"` log text |

Every guess is a place a bug can hide. This task replaces them with explicit fields.

## Ground rules

- **Additive only.** Every new field is optional for old phones; no existing field is removed or renamed. Old phones keep working.
- **Same bytes everywhere.** An event must be identical (same fields, same values) whether it is sent live, replayed into a new pairing, or returned by `fetch_history`. Build it once, persist it, and send the persisted object.
- **IDs are opaque strings** unless stated otherwise.

---

## 1. `eventId` — permanent sequence number on every event

Assign each event a strictly increasing integer **at the moment it is written to the durable log**, per repo (never reset, survives restarts — continue from the last value in the file).

```json
{ "kind": "worker.start", "eventId": 48211, "at": "2026-10-03T04:03:38.112Z", "taskId": "task-…", ... }
```

- Included on live emission, replay, and `fetch_history` responses — the same number each time.
- Events that are **not** persisted (screenshot/diff chunks, model config, pong, history.fetched, command.refused) have no `eventId`.

`fetch_history` takes a cursor by id:

```json
{ "verb": "fetch_history", "afterEventId": 48211 }
```

- Returns events with `eventId > afterEventId`, ascending, max 500, then
  `{ "kind": "history.fetched", "afterEventId": 48211, "lastEventId": 48711, "count": 500, "truncated": true }`.
- Keep accepting the old `{ "after": "<iso>" }` form for old phones.

**Why:** dedupe and order become exact (`eventId`), and paging can no longer drop events that share the millisecond at a page boundary (a real risk with `after: <timestamp>` today).

---

## 2. `workerId` — on every worker and everything it produces

```json
{ "kind": "worker.start", "workerId": "w-48211", "agent": "PLANNER", "taskId": "task-…", "phaseId": null }
{ "kind": "worker.end",   "workerId": "w-48211", "agent": "PLANNER", "outcome": "turn_limit" }
```

Carry `workerId` on: `worker.end`, `file.changed`, `gate.result`, `verdict`, and every `log` line printed while that worker runs (including its `[API]` lines).

**Retries/passes:** a worker that re-runs the same step says so:

```json
{ "kind": "worker.start", "workerId": "w-48264", "agent": "PLANNER", "retryOf": "w-48211", "attempt": 2, "reason": "Plan lacks surgical scope" }
```

Use `retryOf`/`attempt` for the corrective planner pass and for any other "same step again" (not for REPAIR, which is its own step).

---

## 3. Task identity everywhere + explicit lifecycle

**a) `taskId` on every event that belongs to a task**, adding the ones that lack it today: `log`, `command.accepted` (the prompt that *started* a task carries the new task's id), `manual.steps`, `attach.done`, `advisor.*` when an /ask runs inside a running task.

**b) Explicit start and end:**

```json
{ "kind": "task.start", "taskId": "task-…", "runId": "run-…", "prompt": "Do it all", "attachments": ["Screenshot_….png"], "at": "…" }
{ "kind": "task.end",   "taskId": "task-…", "state": "done", "tokensUsed": 2038107, "costUsd": 0.36, "at": "…" }
```

- `task.start` is emitted exactly when the taskId is minted (right after the prompt is captured, before Discovery).
- `task.end.state`: `done | failed | aborted | interrupted`. Emit `interrupted` for a task cut off by `/stop`, a crash, or process exit **on the next startup** if the last task in the log has no `task.end`.
- Statuses after `task.end` (the idle wait) keep that task's id but the phone ignores them for task data.

**c) Status reset at task start** must include `tokensUsed`, `costUsd`, `phaseTokensUsed`, `phaseCostUsd`, and `agentUsage` (not just goal/phases/currentPhase).

---

## 4. Advisor (/ask) exchanges as their own events

```json
{ "kind": "advisor.start",  "exchangeId": "ask-…", "question": "What is next", "at": "…" }
{ "kind": "advisor.answer", "exchangeId": "ask-…", "text": "…", "at": "…" }
```

- No `taskId` when no task is running; `taskId` of the running task when asked mid-task.
- Keep emitting the existing `worker.start/end` for the ADVISOR (old phones), with the same `exchangeId` added.

---

## 5. Prompts as data, not log text

`command.accepted` for `message` must always carry `text` (unless `redactLogs`) and, when it starts a task, the new `taskId`. The phone will stop parsing the `[REMOTE] 📱 message: "…"` log line once this is reliable — please treat it as display-only text that may change.

---

## 6. Small fixes

- `at` on **every** live event (today `plan.ready`, `advisor.answer`, `manual.steps` are sent live without one).
- Don't write `session.end` into the durable history log (it describes a broker session, not history; replaying it ends fresh pairings).
- `manual.steps` carries `taskId` (see 3a).

---

## Acceptance criteria

1. **Replay identity:** for any event, the JSON sent live, the JSON replayed into a new pairing, and the JSON returned by `fetch_history` are byte-for-byte equal after key sorting. Add a test that compares all three.
2. **Monotonic ids:** `eventId` strictly increases across the whole durable log, including across desktop restarts. Test: write, restart, write → no reuse, no gap reset.
3. **Paging:** `fetch_history{afterEventId}` over a log with ≥1,200 events, several sharing one millisecond across a page boundary, returns every event exactly once.
4. **Ownership:** every `file.changed`, `gate.result`, `verdict`, and worker-time `log` has a `workerId` that matches a preceding `worker.start`.
5. **Lifecycle:** every `task.start` is followed by exactly one `task.end` (including after a crash/restart → `interrupted`). A corrective planner pass carries `retryOf`.
6. **Isolation:** two tasks run back to back in one process → no event of task B carries task A's id, and the first status of B has zeroed usage fields.
7. **Back-compat:** an old phone build (no knowledge of the new fields) still works against the new desktop.

Please hand back a fresh `remote_history.jsonl` from a session that includes: a normal task, a corrective planner pass, an /ask after a finished task, a second task in the same process, and a `/stop` — the phone side is tested against it.

## What the phone does with it (for context)

Each field turns a heuristic into a lookup; the phone keeps today's fallback when a field is absent:

| Field | Phone change |
|---|---|
| `eventId` | dedupe + order by id; `fetch_history` by id |
| `workerId` / `retryOf` | attach diffs/checks/logs by id; merge passes by `retryOf` |
| `taskId` + `task.start/end` | segments = group by `taskId`; boundaries from lifecycle events |
| `advisor.*` + `exchangeId` | Advisor cards keyed by exchange |
| `command.accepted.text` | prompts from data, no log parsing |
