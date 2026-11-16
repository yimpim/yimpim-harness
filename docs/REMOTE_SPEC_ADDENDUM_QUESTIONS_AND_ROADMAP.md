# Remote spec addendum: longer questions, and the roadmap card

**Read `docs/REMOTE_SPEC.md` first and build against it. Come to this file after that work is done.** Everything here is additive: nothing in the main spec changes meaning, and a phone that ignores this file keeps working.

| Part | What | Desktop status |
|---|---|---|
| A | Questions carry a plain-words explanation and option glosses | **Shipped** (commits `b063764`, `8ffef38`) |
| B | Roadmap card: a `roadmap.state` event, a `get_roadmap` read and a unit id on `task.start` | **Built on the desktop** (not yet committed when this was written; layout decided: one card) |

## Part A. Questions got longer (shipped; the phone must handle it)

A question is still a `PendingQuestion` inside `status.pendingQuestions` (main spec §5), answered with the same `answer` verb. Only the text changed.

### What the desktop now sends

`prompt` has two parts: the original technical text, a blank line, then a bracketed explanation for someone who has never programmed:

```
Should the reducer keep workerRuns in state or derive them in a selector?

(In plain words: It is asking where the app should keep its list of runs.)
```

When the question has `choices`, each choice is the original text plus a short gloss in brackets:

```
Keep it in the reducer state (The app stores it itself)
Derive it in a selector (The app works it out each time)
```

Not changed: `id`, `kind`, `allowCustom`, `fallback`, `askedAt`, the order and number of `choices`. Questions that need no explanation (the idle "what should I do" prompt, ones already in plain words, or when the explanation model was slow) arrive exactly as before, so **both forms must work**.

### What the phone must do

1. Show the **whole** `prompt`, including the blank line and the bracketed block. Do not cut it at the first line.
2. Let long `choices` **wrap** onto several lines. Do not truncate or ellipsize a label.
3. Send back **exactly the text of the choice tapped**, untrimmed and unedited, in `answer`. The desktop turns it back into the original option. A shortened or edited label does not match: with `allowCustom` it is taken as the user's own words, otherwise the `fallback` is used.
4. Do not parse or split the bracketed text; it is display text only.

### Acceptance (A)

1. A question with a technical prompt and two choices shows both blocks, and the two buttons each show their gloss.
2. Tapping the second button makes the desktop continue with the original second option (check the desktop log line for the answer).
3. An idle prompt and a short question (no explanation block) still render and answer normally.
4. A long gloss wraps; nothing is cut off.

## Part B. The roadmap card (decided; built on the desktop)

### Background

A big request is split into **units**. Each unit is one ordinary task (its own plan of up to 12 phases). Units run **one at a time, in order**, never in parallel, because later units build on what earlier ones produced. Today the phone sees them only as separate tasks plus `log` text. This part gives the phone one card for the whole roadmap, with the running unit expanded and finished ones collapsed.

### Layout (decided)

Show **one roadmap card with the units listed inside it**: `3/12 done`, units grouped by area with a status each, the running unit expanded to its phases and workers, finished units collapsed to one line with their summary. Each unit's task stays in history underneath, so nothing is lost. If a different layout is chosen, only the phone UI changes; the wire format below serves any of them.

### New event: `roadmap.state`

Sent over the same event stream as every other kind (main spec §5). Always the **complete** current roadmap, never a partial update (same rule as `model.config`).

```json
{
  "kind": "roadmap.state",
  "roadmap": {
    "goal": "Rebuild the mobile app from the reference folder",
    "kind": "port",
    "done": 3,
    "total": 12,
    "activeUnitId": "U004",
    "updatedAt": "2026-11-15T10:22:31.000Z",
    "units": [
      { "id": "U001", "title": "Sign-in screen", "area": "Auth", "summary": "Email and password sign-in.", "status": "done",
        "order": 1, "deps": [], "attempts": 1, "addedBy": "plan",
        "result": { "summary": "Added the sign-in screen and its tests.", "fileCount": 6, "commit": "a1b2c3d" } },
      { "id": "U004", "title": "History list", "area": "History", "summary": "Show past tasks.", "status": "in_progress",
        "order": 4, "deps": ["U002"], "attempts": 1, "addedBy": "plan" },
      { "id": "U013", "title": "Make history.index carry entries", "area": "Follow-up", "summary": "…", "status": "todo",
        "order": 13, "deps": [], "attempts": 0, "addedBy": "overflow" }
    ]
  }
}
```

- `roadmap: null` means there is no roadmap (it was reset or never existed): hide the card.
- `status` is one of `todo`, `in_progress`, `done`, `blocked`, `dropped`. A `blocked` unit also has `blockedReason`. Treat an unknown status as `todo`.
- `addedBy`: `plan` (made with the roadmap), `user` (added by hand), `overflow` (left out of a task as a follow-up, or the overflow of a plan too big for one task). Show `overflow` units under their `area` ("Follow-up") like any other.
- `result` appears only on a `done` unit. `summary` is clipped to 200 characters; `summary` on every unit too. Acceptance lists and the reference file lists are **not** sent (the desktop keeps them).
- `kind`: `idea`, `port`, `mixed`, `overflow`. Informational.
- A roadmap can hold up to 500 units. The desktop sends the whole list; a phone should render the list lazily and group by `area`.
- `activeUnitId` is the unit currently running, or `null` when none is.

### When it is sent

- Every time the roadmap changes (created, a unit started, finished, blocked, added, dropped, reopened, reset).
- Once when a phone connects, if a roadmap exists (so a late joiner has it).
- On request: new verb `get_roadmap` (no fields), always allowed (add it to the always-allowed list with `get_model_config`). The reply is a fresh `roadmap.state`.

### Tying units to tasks: `task.start.roadmapUnitId`

`task.start` (main spec §5) gets one optional field:

```json
{ "kind": "task.start", "taskId": "...", "runId": "...", "prompt": "...", "attachments": [], "roadmapUnitId": "U004" }
```

Present only for a task that is a roadmap unit. Use it to attach the task's phases, workers and verdict under that unit in the card. A task without it is a normal task. An old desktop never sends it: then show tasks as separate, as today.

### Commands (no new verbs needed)

The user acts on the roadmap by sending text, exactly as on the desktop:

| Text | Effect |
|---|---|
| `/roadmap` | status (also triggers a fresh `roadmap.state`) |
| `/roadmap run` | start the next unit |
| `/roadmap add <text>` / `/roadmap drop <id> [reason]` | change it |
| `/roadmap reopen <id>` / `/roadmap done <id>` | put a blocked unit back / mark by hand |
| `/roadmap reset` | throw it away (`roadmap: null`) |

The "continue?" question after each unit is an ordinary question (Part A): choices `yes next`, `yes to all`, `no`. Offer the card's unit actions (Run next, Drop, Reopen) as buttons that send these exact texts; there is no separate verb to implement.

### Compatibility rules

- Unknown fields on any unit or on the roadmap: ignore (lenient parsing).
- No `roadmap.state` ever received: no card; the phone behaves as today.
- `roadmap.state` is **not** stored in the durable history log (it is current state, not history); a reconnect gets a fresh one.

### Acceptance (B)

1. Start a roadmap on the desktop: the phone shows one card, `0/N done`, units grouped by area.
2. A unit starts: it shows `in_progress`, expands, and its phases appear under it (from `task.start.roadmapUnitId`).
3. It finishes: it collapses to a line with its summary; the count goes up.
4. Add a follow-up from an agent's scope question: a new "Follow-up" unit appears in the list without reopening the app.
5. `/roadmap reset` on the desktop: the card disappears.
6. Connect the phone mid-roadmap: the card is there at once.
7. Older desktop (no event): no card, nothing breaks.

## What /design, /pentest and /roadmap do, in short

See `ANDROID_QUESTIONS_AND_JOBS_TASK.md`, section 2. None of the three needs a new message type apart from Part B above.
