# Task: Per-task history files, task index, and on-demand history fetch

**For:** desktop dev · **From:** phone (Android + Expo) · **Builds on:** `DESKTOP_EVENT_CONTRACT_V2_TASK.md` (eventId, workerId, taskId, task.start/end, advisor.*)

## Goal

The phone stops downloading whole history. It shows the History **list** from a small index, and fetches **one task's events** only when that task is opened (behind its loading overlay). Closed tasks never change, so the phone caches them and never fetches them twice.

---

## 1. Storage layout (desktop)

| File | Contains |
|---|---|
| `task-<taskId>_<firstEventId>-<lastEventId>.jsonl` | Every event of one **closed** task, in `eventId` order |
| `task-<taskId>_<firstEventId>-open.jsonl` | The **running** task. Renamed once, at `task.end`, to its final range. Never rename per write. |
| `between_<firstEventId>-<lastEventId>.jsonl` (+ `-open` while active) | Events outside any task: idle `status`/`awaiting-input`, `advisor.start`/`advisor.answer` and the ADVISOR worker/log events of an idle /ask, prompt `command.accepted` + `[REMOTE] message` log lines and `attach.done` that arrive **before** `task.start`. Close it when the next task starts. |
| `tasks.index` | One JSON line per task (§2) |

Rules:
1. **`eventId` stays one counter per repo**, continuous across all files (task and between). Filenames record a range; they never restart numbering.
2. **Crash recovery:** on startup, an `-open` task file without `task.end` gets `{"kind":"task.end","state":"interrupted",…}` appended (same `eventId` sequence), then is renamed.
3. **Byte identity (unchanged):** an event's JSON is identical whether sent live, replayed, or returned by any fetch below.
4. **Retention:** count-based FIFO, keep the newest 1000 tasks; evicting a task deletes its task file, its index line, and any between-file that ends before the oldest kept task. Never blocks writes.
5. `session.end` is not written to any history file (unchanged).

---

## 2. `tasks.index`

One line per task, newest appended last; the line is rewritten at `task.end` (and may be refreshed on `plan.ready`).

```json
{
  "taskId": "task-1791036000500-uglf1s",
  "repoName": "YimPim Remote Expo",
  "title": "Add a dark mode toggle to Settings",
  "prompt": "Add a dark mode toggle to Settings",
  "state": "done",
  "startedAt": "2026-10-03T14:00:00.500Z",
  "endedAt": "2026-10-03T14:01:04.100Z",
  "phaseCount": 1,
  "tokensUsed": 48211,
  "costUsd": 0.1832,
  "firstEventId": 2,
  "lastEventId": 37,
  "attachments": []
}
```

- `title` = plan goal when known, else the prompt's first line.
- `state`: `running | done | failed | aborted | interrupted`. `endedAt`, `lastEventId` are null while running.
- `prompt`: first line only (full prompt is in the task file's `task.start`).

---

## 3. New / extended commands

All Tier 1 (always allowed), answered with events like the existing `fetch_history`.

### 3a. `history.list` — the History list

```json
{ "verb": "history.list", "limit": 50, "beforeTaskId": "task-…" }
```
- Newest first. `beforeTaskId` omitted = start from the newest. `limit` default 50, max 100.
- Answer (one event, not persisted):
```json
{ "kind": "history.index", "at": "…", "entries": [ { …§2 line… }, … ], "hasMore": true }
```

### 3b. `fetch_history { taskId }` — one task, on demand

```json
{ "verb": "fetch_history", "taskId": "task-…", "afterEventId": 0 }
```
- Returns that task's events in `eventId` order, max 500 per page, then
  `{ "kind": "history.fetched", "taskId": "task-…", "lastEventId": 412, "count": 412, "truncated": false }`.
- Next page: same verb with `afterEventId = lastEventId`.
- Unknown or evicted task → `{ "kind": "history.fetched", "taskId": "…", "count": 0, "truncated": false, "missing": true }`.

### 3c. `fetch_history { afterEventId }` — unchanged, but merges files

The existing id-cursor fetch (gap recovery, and "current screen" on app start) must return events from **task and between files merged in `eventId` order**, 500 per page, with `lastEventId` / `truncated` as today. If `afterEventId` predates the oldest kept file, start from the oldest available (don't fail).

### 3d. Pairing replay — capped

On a new pairing, do **not** replay the whole history. Replay only: the newest task file (open or closed) **plus** every between-task event after it. (The phone fetches anything else via 3a/3b on demand.)

---

## 4. What the phone does with it (for context)

- **History screen:** `history.list` pages → list rows. Cached locally so History works offline.
- **Open a task:** if not cached, `fetch_history{taskId}` behind the loading overlay → render → cache by `taskId`+`lastEventId` (closed tasks are immutable; never refetched).
- **App start / re-pair:** `history.list` (first page) + `fetch_history{afterEventId: <newest task's firstEventId − 1>}` for the current screen; then live events as today.
- **Gap after sleep:** `fetch_history{afterEventId: <phone's last eventId>}` as today.

---

## Acceptance criteria

1. **Continuous ids:** across ≥3 tasks with idle /ask exchanges between them, the union of all files is exactly `eventId` 1..N with no gaps or duplicates.
2. **Rename once:** a running task is only ever `-open`; after `task.end` exactly one file `task-<id>_<first>-<last>.jsonl` exists with `last` = its `task.end` eventId.
3. **Crash:** kill the process mid-task, restart → that task's file ends with `task.end{state:"interrupted"}` and is renamed; its index line says `interrupted`.
4. **Index:** `history.list` returns tasks newest-first, paged with `beforeTaskId`/`hasMore`, values matching each task's `task.start`/`plan.ready`/`task.end`.
5. **Task fetch:** `fetch_history{taskId}` returns exactly that file's events (byte-identical to live), paged at 500; a >500-event task pages correctly; evicted → `missing: true`.
6. **Merged fetch:** `fetch_history{afterEventId}` spanning a task file and a between file returns both interleaved in `eventId` order.
7. **Between events:** an idle /ask produces `advisor.start`/`advisor.answer` (+ ADVISOR worker/log events) in a between file, never in the previous task's file.
8. **Pairing replay:** a fresh pairing receives only the newest task + later between-task events.
9. **Retention:** with the limit set to 3 in a test, creating a 4th task evicts the oldest task's file, its index line, and between-files older than the oldest kept task.

Please return: a regenerated v2 fixture laid out as these files (task files + between files + `tasks.index`), so the phone tests run against the real layout.
