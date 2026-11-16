# YIMPIM Remote Control — Wire Protocol Spec

**Before you build against this: the transport is not WebSocket.** It's plain
HTTPS with long-polling. There is no persistent socket anywhere in this
system — grep confirms zero WebSocket usage in the codebase. If your Android
app opens a `WebSocket`, it will never connect to anything. This doc
describes what's actually implemented, verified against the current source
(`src/remote/protocol.ts`, `src/remote/broker.ts`, `src/remote/client.ts`) as
of this write-up.

Two other assumptions in the original ask don't match reality either, called
out up front so you don't design UI around them:

- **Full patch content IS available, on demand — it does not ride along with
  `file.changed`.** Every file write/patch fires a `file.changed` event (see
  §5) with the real `added`/`removed` line counts, whether the file was
  created or modified, and — when the change is still in the desktop's
  short-lived in-memory cache — a `changeId`. Tap that row, send `fetch_diff`
  with the `changeId` (see §6), and the desktop streams the actual diff text
  back as one or more `diff.chunk` events (or `diff.unavailable` if it already
  aged out of the cache). This is exactly the mechanism the desktop's own
  bundled web UI uses for its "view diff ›" flyup — see `src/remote/ui.ts`'s
  `openDiff`/`renderDiffBody` for a reference implementation to port.
- **No dedicated streaming "token cost" event.** Token cost only exists as
  `RemoteStatus.tokensUsed` — a single cumulative integer updated whenever
  status changes, not a stream of per-call cost events. Per-model/per-agent
  breakdowns (the "EDITOR: 47 calls, 2.6M tokens, $0.13" table) only exist as
  unstructured text inside `log` events, not as their own JSON shape.
- **No dedicated "[y/n] checkpoint" message type.** Every question the agent
  asks — a blocking clarification, an approval, a "press Enter to accept" —
  is the same `PendingQuestion` shape, carried inside a `status` event's
  `pendingQuestions` array. `kind` distinguishes them (`"blocking" |
  "deferred" | "approval"`), but there's no separate wire format for a
  yes/no prompt specifically. Model it as one generic question type in
  Kotlin, not several.
- **`idle: true` marks the loop's own "what should I do next" prompt** —
  never a real clarifying question the agent asks mid-task. Both arrive as
  `kind: "blocking"` (the idle prompt genuinely blocks the terminal loop
  waiting for a new task), so this is the only field that distinguishes
  "nothing is running, give me a task" from "the agent needs an answer to
  keep working right now." Present a locking/urgent popup only for the
  latter — the idle prompt should read as a normal, low-priority "what's
  next" state, not an interruption. Absent (or `false`) on every other
  question.

---

## 1. Trust model

- The desktop (the "agent") **never listens on a port**. It only makes
  outbound HTTPS calls to a broker.
- The broker is a dumb relay — plain `http.createServer`, no TLS itself
  (expected to sit behind Tailscale `serve` or a real TLS terminator). It
  routes opaque ciphertext and **never holds the session key**.
- The AES-256-GCM session key is generated on the desktop and travels to the
  phone **only inside the QR code** (screen → camera), never over the
  network, never through the broker.
- A compromised broker can deny service or replay/drop ciphertext. It cannot
  read a task, read code, or forge a command — every command is
  authenticated by the same AEAD key the broker never sees.
- Exactly **one device may be paired per session**. There is no multi-device
  fan-out.

## 2. Pairing flow

```
Desktop                          Broker                          Phone
   |--- POST /v1/register ---------->|
   |<---- {sessionId, agentToken} ---|
   |                                 |
   |  [renders QR: broker/p#1.<sessionId>.<pairing>.<key>]
   |                                 |                               |
   |                                 |<---- POST /v1/pair -----------|
   |                                 |----- {deviceToken, deviceId}->|
   |                                 |                               |
   |--- POST /v1/events (loop) ----->|                               |
   |<-- GET /v1/commands (long-poll)-|<---- GET /v1/stream (poll) ---|
   |                                 |<---- POST /v1/command --------|
```

### QR payload format

**Not JSON.** A dot-joined string of already-URL-safe fields, to keep the QR
code small (every byte is a rendered module):

```
v.sessionId.pairing.key
```

Example: `1.s_AbCdEfGhIjKlMn.pR3q...longbase64url....xY9z`

- `v` — protocol version, currently `1`.
- `sessionId` — the session ID from `/v1/register`.
- `pairing` — one-time pairing secret (32 random bytes, base64url). Single
  use; burned on first use or first wrong guess.
- `key` — the AES-256-GCM session key (32 bytes, base64url). **Never sent to
  the broker.**

Full pairing URL: `{brokerOrigin}/p#{fragment}` — note it's in the URL
**fragment** (`#`, not `?`), which browsers never send to the server, so even
loading the page never transmits the key over the network. `broker` itself is
NOT encoded in the fragment — a native app scans the full URL (not just the
fragment) and takes the origin from that.

### Pairing TTL

The pairing secret expires **2 minutes** after `/v1/register`. After that,
`/v1/pair` returns 410 and the desktop must re-register (a fresh
`/remote-control` in the desktop CLI).

## 3. Envelope format & encryption

Every event and command crosses the wire as this JSON shape — **this is the
outer, always-visible layer**; the broker can see this whole structure, it's
`data` alone that's opaque:

```json
{
  "v": 1,
  "sessionId": "s_AbCdEfGhIjKlMn",
  "seq": 42,
  "iv": "base64-encoded-12-byte-IV",
  "data": "base64-encoded-ciphertext",
  "tag": "base64-encoded-16-byte-GCM-tag"
}
```

- **Algorithm:** AES-256-GCM.
- **IV:** 12 random bytes per envelope, base64.
- **AAD (additional authenticated data):** the ASCII string
  `"{v}:{sessionId}:{seq}"` (e.g. `"1:s_AbCdEfGhIjKlMn:42"`). This binds the
  ciphertext to its own routing metadata — the broker cannot move an envelope
  between sessions or replay it at a different `seq` without the decrypt
  failing.
- **Tag:** GCM's 16-byte auth tag, base64, carried **separately** from
  `data`. This is the single most important interop detail for a JVM client:
  **Java's `Cipher` (`AES/GCM/NoPadding`) expects the tag concatenated onto
  the end of the ciphertext** for `doFinal()`, where Node's
  `crypto.createCipheriv`/`createDecipheriv` API keeps them as two separate
  values (`cipher.getAuthTag()` / `decipher.setAuthTag()`). To decrypt an
  envelope from Kotlin, base64-decode `data` and `tag` separately, then
  **concatenate `data + tag` into one byte array** before calling
  `cipher.doFinal()`. Get this wrong and every decrypt throws
  `AEADBadTagException` — see `YimpimModels.kt`'s `YimpimCrypto` object, which
  does this concatenation for you.
- **Plaintext**, once decrypted, is one JSON object: `{ "kind": string, "at":
  ISO-8601 string, ...kind-specific fields }`. `seal()`/`open()` in
  `protocol.ts` are the reference implementation.

## 4. HTTP endpoints

All bodies are `application/json`. All responses are `application/json`
unless noted. Max request body: **1 MB**. There is no HTTPS termination in
the broker process itself — it's expected to sit behind Tailscale `serve` or
a reverse proxy; treat the base URL as `https://` in production.

### `POST /v1/register` — desktop only, unauthenticated

Request:
```json
{ "pairingHash": "sha256-hex-of-the-pairing-secret" }
```
Response `200`:
```json
{ "sessionId": "s_AbCdEfGhIjKlMn", "agentToken": "at_...x_...", "pairingTtlMs": 120000 }
```
`agentToken` is the bearer token for every subsequent desktop→broker call.
Response `400` if `pairingHash` isn't a 64-char hex string.

### `POST /v1/pair` — phone only, unauthenticated (uses the one-time secret)

Request:
```json
{ "sessionId": "s_AbCdEfGhIjKlMn", "pairing": "the-pairing-secret-from-the-QR", "label": "Pixel 8" }
```
Response `200`:
```json
{ "deviceToken": "dt_...y_...", "deviceId": "dev_AbCdEf", "sessionId": "s_AbCdEfGhIjKlMn" }
```
`deviceToken` is the bearer token for every subsequent phone→broker call.

Errors: `404` session not found · `409` already paired (re-pair from
desktop) · `410` pairing code expired · `403` wrong code (also **burns** the
code — one wrong guess and the desktop must issue a fresh QR).

### `POST /v1/unregister` — desktop only, `Authorization: Bearer {agentToken}`

Request: `{ "sessionId": "..." }`. Response `200`: `{ "ok": true }`.
Immediately deletes the session server-side (used when the desktop re-pairs
in the same process). Not relevant to an Android client except to know that
a session can vanish abruptly, not just via the 12h idle timeout.

### `POST /v1/events` — desktop only, `Authorization: Bearer {agentToken}`

Request:
```json
{ "sessionId": "s_AbCdEfGhIjKlMn", "events": [ /* array of Envelope */ ] }
```
Response `200`: `{ "ok": true, "paired": true }` — `paired` tells the desktop
whether a device has ever paired yet.

### `GET /v1/commands?sessionId=...` — desktop only, long-poll, `Authorization: Bearer {agentToken}`

Holds the connection open **up to 25 seconds** if no commands are queued, then
returns whatever arrived (possibly empty). Response `200`:
```json
{ "commands": [ /* array of Envelope */ ], "paired": true }
```

### `GET /v1/stream?sessionId=...&after={seq}` — phone only, `Authorization: Bearer {deviceToken}`

Returns immediately (not long-polling) with every event whose `seq > after`.
Response `200`:
```json
{ "events": [ /* array of Envelope, seq > after */ ] }
```
The reference phone client polls this **every 1.2 seconds**, with a 35s
client-side timeout per request and exponential backoff on repeated
failures. Response `401` means the session is genuinely gone (swept after
12h idle, or the desktop process restarted) — this is NOT recoverable by
retrying with the same token; the client must show "scan a fresh QR" and
discard its cached credentials.

### `POST /v1/command` — phone only, `Authorization: Bearer {deviceToken}`

Request:
```json
{ "sessionId": "s_AbCdEfGhIjKlMn", "envelope": { /* one Envelope */ } }
```
Response `200`: `{ "ok": true }`. This immediately wakes any desktop
long-polling on `/v1/commands`.

### `GET /healthz` — unauthenticated

```json
{ "ok": true, "sessions": 1 }
```

### `GET /p` or `GET /` — serves the reference HTML/JS phone client

Not relevant to a native app — this is the existing browser-based fallback
client. Content-Security-Policy locks it to fully inline, self-contained
assets; nothing to reuse here.

## 5. Inbound: event payloads (desktop → device)

Every event, once its `Envelope` is decrypted, is a flat JSON object:
`{"kind": "...", "at": "2026-...Z", ...fields}`. There is no other
discriminator — an Android client must branch on `kind` after decoding to a
generic map/JsonElement first (see `YimpimModels.kt`'s
`JsonContentPolymorphicSerializer`).

### `status`

The single most important event — a full snapshot of run state, re-sent on
every state change (not a diff). A late-joining device gets caught up by the
most recent `status` alone.

```json
{
  "kind": "status",
  "at": "2026-09-16T18:02:11.483Z",
  "status": {
    "runId": "run_1789...",
    "taskId": "task-1790729755716-abc123",
    "repoName": "MutantChickenRacers",
    "state": "awaiting-input",
    "goal": "Swap the fast forward and throw button positions...",
    "phases": [
      { "id": "phase-1", "name": "Swap button order in RaceScreen controls row", "status": "passed" }
    ],
    "currentPhase": "Swap button order in RaceScreen controls row",
    "pendingQuestions": [
      {
        "id": "task_run_1789_172...",
        "kind": "blocking",
        "prompt": "What would you like me to do in MutantChickenRacers?",
        "fallback": "",
        "askedAt": "2026-09-16T18:02:11.400Z",
        "idle": true
      }
    ],
    "tokensUsed": 348922,
    "startedAt": "2026-09-16T17:58:00.000Z",
    "updatedAt": "2026-09-16T18:02:11.483Z"
  }
}
```

`state` is one of: `idle | planning | running | awaiting-input | done |
failed | aborted`. `phases[].status` is a free-form string in practice
(`pending | running | passed | failed` are the values actually produced, but
treat it as an open string, not an enum, in Kotlin).

`pendingQuestions` is usually 0 or 1 entries — `choices` is optional
(present only when the agent suggested specific answers; free text is always
still allowed).

**`runId` vs `taskId` — this distinction matters and is easy to get wrong.**
`runId` identifies the desktop PROCESS and is fixed for its entire lifetime.
`taskId` identifies one TASK within that process, and a single interactive
session can run many unrelated tasks back to back without restarting —
each getting the SAME `runId` but a different `taskId`. **Reconcile on
`taskId`, never on `runId`** — an earlier version of this spec said to key
on `runId`, which is wrong whenever more than one task runs in one process:
it merges every task in that process into a single card (phase lists from
two different tasks interleaved, a stale "0 workers" card, a plan's phase
count not matching what's actually running). If you already built against
`runId` per this spec's earlier guidance, switch the key to `taskId` — the
field is new, but the bug it fixes predates it.

**Reconciliation: replace, never append.** Every `status` is a full snapshot
of the ENTIRE task, not a diff and not a timeline entry — a client that
renders it as one more item in a history feed (alongside `worker.start`,
`log`, etc.) will show stale, conflicting phase counts as soon as it has
rendered more than one `status`, especially after a reconnect replays a
batch of several at once (an old one and the current one arriving together).
The correct handling: keep exactly ONE live `status` per `taskId`, and every
new `status` for that `taskId` overwrites it outright — `phases[]`,
`currentPhase`, `state`, all of it, wholesale, keyed by whichever `status`
has the latest `updatedAt` (or, within one replayed batch, simply the last
one in delivery order, since replay is already chronological). Never merge
field-by-field across two `status` snapshots, and never treat an older
`status` in a replayed batch as more current just because it rendered more
recently than an even-older cached one — `updatedAt` is the only authority.

**Exactly when a new `taskId` appears, and what comes with it.** A fresh
`taskId` is minted at the moment a task actually BEGINS — right as the
user's prompt is captured, immediately before Discovery starts — never
earlier. In particular:
- The previous task's own final `status` (`state: "done"` or `"failed"`,
  from its own `finish()`) and the idle `"awaiting-input"` status while the
  desktop sits waiting for the next prompt both still carry the PREVIOUS
  task's `taskId` — there is no task to mint a new id for yet during that
  gap. Don't treat an "awaiting-input" status as evidence a new task has
  started; nothing has, until a `plan.ready` (or a `status` with a new
  `taskId`) actually shows up.
- The `status` pushed the instant a new `taskId` IS minted is a complete,
  explicit reset, not a bare id patch: `goal`/`currentPhase` are cleared,
  `phases` is emptied, `state` becomes `"planning"`, and the usage fields
  (`tokensUsed`, `phaseTokensUsed`, …) zero out. This status is pushed
  BEFORE Discovery/Planner run, specifically so a client reconciling on
  `taskId` (per the rule above) never has a window where the new id is
  attached to the previous task's leftover content.
- Discovery and Planner's own `worker.start` events carry the new `taskId`
  but `phaseId`/`phaseName`/`acceptanceCriteria` all omitted (`undefined`)
  — neither agent runs inside a phase. If you see a `phaseId` on a
  Discovery/Planner `worker.start`, something upstream didn't reset it;
  don't display it as if it were real phase context.

### `plan.ready`

The Planner's finished plan — fires exactly once per task, right after
Discovery/Planning completes and before phase 1 starts.

```json
{
  "kind": "plan.ready",
  "at": "2026-09-16T18:01:50.000Z",
  "taskId": "task-1790729755716-abc123",
  "runId": "run_1789...",
  "goal": "Swap the fast forward and throw button positions...",
  "degraded": false,
  "phases": [
    { "id": "phase-1", "name": "Swap button order in RaceScreen controls row", "goal": "...", "executor": "EDITOR" },
    { "id": "phase-2", "name": "Restore locked dependencies", "goal": "...", "executor": "SETUP" },
    { "id": "phase-3", "name": "Run the Jest suite", "goal": "...", "executor": "QA" }
  ]
}
```

`executor` says which kind of worker runs the phase, assigned by the Planner:
`"EDITOR"` (changes files), `"QA"` (verification only — the Editor pass is
skipped), or `"SETUP"` (runs the install, analyses its output, and calls a
model only when the output needs diagnosing). The same field is on
`phase.start`. It is **optional**: absent (older desktops, resumed older
plans) means `"EDITOR"`, and an unrecognised value should be treated the
same way. A SETUP phase may complete with no model call at all, so don't
expect a `worker.start` for it.

`degraded` is true for the one-phase, no-op fallback plan produced when
Planner couldn't decompose the task normally — a client may want to show
this differently (e.g. a warning tone) rather than as a confident multi-phase
plan.

**Reconciliation: one card per `taskId`, same rule as `status`.** This event
can still arrive more than once for the SAME task — replayed into a freshly
(re-)paired session after a desktop restart or reconnect (see "History
across sessions" below) is not a new plan, it's the same one again. `runId`
is also present but is NOT the key — see `status`'s own `runId` vs `taskId`
note above; two different tasks in the same process share a `runId` and
MUST NOT be merged just because of that. Key the rendered "plan ready" card
on `taskId`, and a redelivery updates that existing card in place rather
than appending a second one.

### `log`

Every console line the desktop prints, mirrored verbatim (ANSI stripped).
This is the bulk of traffic and it is **unstructured prose**, including
markdown-lite (backtick code spans, `**bold**`) that the reference phone
client renders as HTML — there is no structured sub-type for "this log line
is actually a diff stat" or "this one is a QA verdict"; the existing HTML
client pattern-matches the raw text with regexes. A native client wanting the
same rich rendering has to reimplement those same text patterns, not parse a
richer JSON shape that doesn't exist.

```json
{ "kind": "log", "at": "2026-09-16T18:01:03.112Z", "level": "info", "message": "[EDITOR] ✂️ Editing RaceScreen.kt…" }
```
`level` is `"info" | "warn" | "error"`.

### `screenshot.chunk`

A screenshot is always chunked (48 KB raw per chunk before base64) — never
sent as one event, since a full PNG routinely exceeds the 1 MB body cap.
Reassemble by `id`, ordering by `seq`, until `chunks received == total`.

```json
{
  "kind": "screenshot.chunk",
  "at": "2026-09-16T18:01:40.001Z",
  "id": "shot_1789592501234_ab12cd",
  "label": "Race screen after fast-forward tap",
  "mime": "image/png",
  "seq": 0,
  "total": 3,
  "data": "base64-chunk-of-the-png..."
}
```
Concatenating every chunk's `data` string (plain string concat, not
byte-array concat — chunks are cut on 48KB *raw* boundaries so only the
final chunk may carry base64 padding) reproduces the exact base64 of the
whole PNG.

**This is never durably logged, and a client shouldn't be either** — don't
try to persist raw chunk buffers across your own process lifetime; keep
them in memory only, for exactly as long as reassembly takes. If you need a
screenshot again later (after a restart, or recovering a `gate.result` via
`fetch_history`), ask for it again with `fetch_screenshot` (§6) rather than
trying to make this durable yourself — the desktop's own file on disk is
the only thing that needs to survive, not a copy of the wire chunks.

### `command.refused`

Sent back when a device sends a verb it isn't permitted to use.
```json
{ "kind": "command.refused", "at": "...", "verb": "attach", "reason": "\"attach\" is not enabled for this run" }
```

### `command.accepted`

Echo/ack for any command other than `attach` (attach gets its own
`attach.done`/`attach.rejected` instead, to avoid one ack per 48KB chunk).
```json
{ "kind": "command.accepted", "at": "...", "verb": "answer", "questionId": "task_run_1789_172...", "text": "yes, use the red variant" }
```
`questionId` is present for `answer`/`approve`/`reject` (an opaque id, never
content — always included). `text` echoes back the actual free text that was
sent (`message`'s text, `answer`'s answer, `reject`'s reason) — this is what
makes the user's own typed content durable: without it, only the DESKTOP's
side of a conversation survived a replay/recovery, never what the user
actually typed to get there. Omitted for verbs with no free text at all
(`ping`, `abort`, `approve`), and omitted even when one exists if the agent
has `redactLogs` on — same policy `log` content already gets, since a
typed answer can quote project content exactly as easily as a log line can.

### `answer.rejected`

Sent when an `answer`/`approve`/`reject` arrived for a question that was
already resolved by another surface (the desktop terminal, or a fallback) —
lets the phone recover its typed text instead of it silently vanishing.
```json
{ "kind": "answer.rejected", "at": "...", "questionId": "task_run_1789_172...", "reason": "that question was already resolved" }
```

### `attach.done` / `attach.rejected`

```json
{ "kind": "attach.done", "at": "...", "name": "screenshot.jpg", "bytes": 267421 }
```
```json
{ "kind": "attach.rejected", "at": "...", "reason": "file exceeds 10 MB" }
```

### `pong`

Reply to a `ping` command. `{ "kind": "pong", "at": "..." }` — no other fields.

### `session.end`

```json
{ "kind": "session.end", "at": "...", "reason": "re-pairing" }
```
On receiving this, a client must both stop polling **and discard its cached
session credentials** (the device token and session key) — an ended session's
token is never valid again, and a client that only stops polling but keeps
the token will fail with a 401 on its next reconnect attempt instead of
cleanly re-pairing.

This is deliberately scoped to credentials only. `session.end` says nothing
about whatever history a client has already rendered from this session's
events — discarding the token does not imply discarding the task/event
history a user has been looking at. See "History across sessions" below for
why: a fresh pairing's event stream may itself begin with replayed history
from before this session even existed, so a client that wipes its own
render on every `session.end` throws away exactly the continuity the desktop
is now providing on the next re-pair.

### Worker/QA structured events

The five kinds below are translated live from the desktop's own internal
event bus (`worker.start`/`worker.end` from the same boundary that prints
`[EDITOR]`/`[REPAIR]`/`[QA]` console labels; `file.changed` from the same
diff-stat computation behind the `+N -M` console hint; `gate.result`/`verdict`
from QA's evidence ledger). They're additive — the free-text `log` mirror
keeps sending the exact same lines it always did, in the same order; these
just let a client avoid re-deriving structured data from that text.

**Ordering, for building a UI like "phase card → worker card → file-change
rows":** for one phase, expect `worker.start` (one per EDITOR/REPAIR/QA pass —
QA can appear more than once per phase, in a repair-and-recheck loop),
0+ `file.changed` and `gate.result` events interleaved while that worker is
active, then a `worker.end` closing it. `verdict` fires once, right before
QA's own `worker.end`. A client buffers events between a `worker.start` and
its matching `worker.end` (matched by `agent` name and by which one comes
first: this stream has no id linking a start to its end, same as
`tool.call`/`tool.result` internally).

**Every `worker.start` gets exactly one matching `worker.end`, no matter how
that pass actually ends** — including a model-call exception, an aborted
run, or an early conclusion (the agent deciding the work was already done,
or escalating because it couldn't locate what it needed). This wasn't
always true: several of those exit paths used to skip the end event
entirely, relying on a client closing the card itself when the phase ended
instead. A client no longer NEEDS that fallback, but keeping it costs
nothing and is still the right behavior for the one case this can't cover —
a hard desktop-process crash, where nothing gets a chance to emit anything
at all.

**Gate results are not test-runner output.** YIMPIM's QA is its own
evidence-ledger PASS/DEFECT/INCONCLUSIVE-per-requirement system — there is no
JUnit-style named-test data anywhere in the pipeline. `gate.result`'s `gate`
field is a human-readable check name (`"compile/build"`, `"requirement
coverage"`, `"RaceScreen visual QA"`, or a real command like `"gradle
assemble"`), not a test identifier — don't design a UI element that assumes
one row equals one named unit test.

#### `worker.start`

```json
{
  "kind": "worker.start",
  "at": "2026-09-17T18:02:11.483Z",
  "taskId": "task-1790729755716-abc123",
  "agent": "EDITOR",
  "phaseId": "phase-2",
  "phaseName": "Implementation & Review",
  "acceptanceCriteria": ["Favorites persist across restart", "Toggle reflects the persisted value"]
}
```
`agent` is one of whatever the console already labels (`EDITOR`, `REPAIR`,
`QA`, or `EDITOR - VISION` / `REPAIR - VISION` when that phase used a vision
model). `phaseId`/`phaseName`/`acceptanceCriteria` are omitted when the
desktop has no current phase in scope at the moment the worker started
(shouldn't normally happen mid-run, but don't assume they're always present).
`acceptanceCriteria` is the Planner's own `verification` list for that phase
— the same wording a human would use for a story's acceptance criteria, not
YIMPIM inventing a separate format for it. `taskId` scopes this (and every
other task-scoped kind on this page) to one task — see `status`'s own
`runId` vs `taskId` note; group/filter worker cards by `taskId`, not `runId`.

#### `worker.end`

```json
{ "kind": "worker.end", "at": "...", "taskId": "task-1790729755716-abc123", "agent": "EDITOR", "outcome": "completed" }
```
`outcome` is a free-form string — treat it as open, not an enum. Values
actually produced today: `"completed"` (normal finish, including the agent
concluding the work was already done), `"escalated"` (couldn't locate what
it needed to proceed), `"circuit_breaker"` (gave up after too many
unproductive inspection rounds without an edit), `"turn_limit"` /
`"turn_limit_recovered"` (ran out of tool-call rounds; `_recovered` means it
still produced a usable final answer when forced to), `"aborted"` (the user
stopped the run), `"interrupted"` (an unanticipated failure — a model-call
exception, a network error — none of the above).

#### `file.changed`

```json
{
  "kind": "file.changed",
  "at": "...",
  "taskId": "task-1790729755716-abc123",
  "agent": "EDITOR",
  "path": "FavoritesRepository.kt",
  "action": "created",
  "added": 42,
  "removed": 0,
  "changeId": "3f9a1c2e-...-b6d4"
}
```
One event per successful `write_file`/`patch_file` tool call. `action` is
`"created"` only for a brand-new file written via `write_file`; a `patch_file`
call is always `"modified"` (patching a nonexistent file fails before this
event would ever fire). For a patch, `added`/`removed` reflect only the
changed search/replace region, not a full old-file-vs-new-file comparison —
same scope as the desktop's own `+N -M` console hint.

`changeId` keys the full diff text in the desktop's in-memory cache (up to
300 entries or 20 MB total, oldest evicted first — so it can legitimately be
gone by the time you ask, e.g. after a very long run or a desktop restart).
Send it back as `fetch_diff` (§6) to get the actual patch content as
`diff.chunk`/`diff.unavailable` events.

#### `diff.chunk`

```json
{ "kind": "diff.chunk", "changeId": "3f9a1c2e-...-b6d4", "path": "FavoritesRepository.kt", "seq": 0, "total": 1, "data": "base64-utf8-chunk..." }
```
Sent in response to `fetch_diff`, chunked exactly like `screenshot.chunk`
(48 KB raw per chunk, base64-encoded) since a full-file rewrite's diff can
just as easily exceed one envelope as a screenshot can. Reassemble by
`changeId` once `total` chunks with that id have all arrived, then
base64-decode and UTF-8-decode the concatenated bytes to get the diff text.

The diff text is plain lines, **not** unified-diff format (no `@@` hunk
headers, no line numbers) — each line is prefixed with `"+ "` (added),
`"- "` (removed), or two spaces (unchanged context). Style by the first
character only: `+` → addition, `-` → removal, anything else → context. See
`src/remote/ui.ts`'s `renderDiffBody` for the reference parse.

#### `diff.unavailable`

```json
{ "kind": "diff.unavailable", "changeId": "3f9a1c2e-...-b6d4", "reason": "That change is no longer available (older than this session's diff cache, or the process restarted)." }
```
Sent instead of `diff.chunk` when the requested `changeId` already aged out
of the cache. Show `reason` (or your own equivalent copy) in place of the
diff body rather than leaving the flyup stuck on "Loading…".

#### `history.fetched`

```json
{ "kind": "history.fetched", "requestedAfter": "2026-09-16T18:02:11.483Z", "count": 213, "truncated": true }
```

Answers a `fetch_history` command (§6). Pushed **after** the recovered
events themselves — each one already arrived as its own ordinary event
(`worker.start`, `log`, `file.changed`, ...), through the exact same
reconciliation rules as any other delivery of that kind. This event is just
the completion marker, telling the client the batch is done rather than it
having to guess from the stream going quiet.

- `count: 0, truncated: false` — nothing existed after `requestedAfter`.
  This is the normal "fully caught up" response, not an error.
- `truncated: true` — more exists beyond the 500-event cap. Send another
  `fetch_history` with the `at` of the last event you just received as the
  new `after`, and keep paging until `truncated: false`.

#### `model.config`

```json
{
  "kind": "model.config",
  "roles": [
    { "role": "discovery", "chain": ["anthropic/claude-3.5-sonnet"] },
    { "role": "discoveryVision", "chain": [] },
    { "role": "planner", "chain": ["anthropic/claude-3.5-sonnet"] },
    { "role": "editor", "chain": ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"] },
    { "role": "editorVision", "chain": [] },
    { "role": "verifier", "chain": ["google/gemini-3.8-flash"] },
    { "role": "verifierVision", "chain": [] },
    { "role": "designer", "chain": ["openai/gpt-5", "google/gemini-3", "anthropic/claude-opus-5"] },
    { "role": "designerVision", "chain": [] },
    { "role": "security", "chain": [] }
  ],
  "scope": "project",
  "roleInfo": [
    { "role": "editor", "label": "Editor", "blurb": "Writes the actual code. Needs tool calling. HIGHEST token volume.",
      "optional": false, "multi": null, "needsTools": true, "needsVision": false, "volume": "high" },
    { "role": "designer", "label": "Logo designer", "blurb": "The models that propose and draw logo and brand concepts, rotated ...",
      "optional": true, "multi": { "min": 1, "max": 6 }, "needsTools": false, "needsVision": false, "volume": "low" }
  ]
}
```
Sent in response to `get_model_config` (§6), and again after any `set_model`
that was actually accepted — always the complete set of roles, never a
partial update, so a client never has to merge. **`roleInfo` describes every role in `roles`, in
display order** (it is abbreviated above): build the picker from it, not from a hard-coded list, so a role the
desktop adds later appears without an app change. It is absent from a desktop older than this field; fall back to
the nine original roles then (`discovery`, `discoveryVision`, `planner`, `editor`, `editorVision`, `repair`,
`repairVision`, `verifier`, `verifierVision`). The roles are currently those nine plus `designer`,
`designerVision` and `security`. If `roleInfo` is absent, ignore any `role` you do not recognise.
`multi` is `null` for a normal role (`chain[0]` is the primary model, `chain[1]` the fallback) and
`{ min, max }` for a role that takes a SET of models to rotate through (`chain` is then that whole set, in order;
the order does not matter). `optional: true` roles may be cleared with `chain: []`. `chain: []` means "not
configured." `scope` is
`"project"` when this repo has its own `agent.config.yaml`/`.agent/config.yaml`
in effect, `"global"` when falling through to `~/.yimpim/config.yaml` —
informational only, a client never picks a scope on write.

#### `usage.totals`

```json
{
  "kind": "usage.totals",
  "at": "2026-10-11T17:42:10.000Z",
  "desktopId": "3f0c8a52-6a1e-4c1f-9d5e-0b7a2e41c9aa",
  "lifetime": {
    "tokens": 417625050,
    "cost": 44.96,
    "costIsFloor": false,
    "calls": 3120,
    "tasks": 214,
    "since": "2026-03-02T09:11:00.000Z",
    "byWorker": [
      { "worker": "EDITOR", "tokens": 301000000, "cost": 31.2 },
      { "worker": "QA", "tokens": 52000000, "cost": 6.1, "costIsFloor": true }
    ],
    "byModel": [
      { "model": "anthropic/claude-sonnet-5-5", "tokens": 350000000, "cost": 38.0 }
    ]
  },
  "last": {
    "taskId": "task-1790729755716-abc123",
    "title": "Fix login redirect",
    "status": "completed",
    "tokens": 1830000,
    "cost": 0.4212,
    "costIsFloor": true
  }
}
```

**This desktop's** lifetime usage. The desktop is the source of truth, so a
freshly installed or re-paired phone shows the same totals as any other, with
no account needed. It is a per-desktop number: a user with two desktops gets
two `desktopId`s, and the phone should keep them apart (key on `desktopId`)
rather than overwrite one with the other. If the desktop is offline, fall
back to whatever the phone last received or counted locally.

- **Sent** on pairing (right after the history replay), after every
  `task.end`, and in response to `get_usage`. Always the complete current
  snapshot: replace, never add.
- **Not part of replayed history.** It is never persisted into the desktop's
  event log, so a redelivered or replayed copy can only be a live one.
- The discriminator is `kind`, like every other event, and `at` is the
  envelope's usual timestamp.
- `lifetime.tokens` / `calls` / `tasks` / `byWorker` / `byModel` are never
  evicted. `tasks` counts every task ever started on this desktop (a task
  with no model call, e.g. a clean install, still counts). Both breakdown
  arrays are sorted by `tokens`, descending, and capped (12 workers, 10
  models), so the rows may sum to less than `lifetime.tokens`.
- `worker` is the name a phone already sees on `worker.start` (`EDITOR`, `QA`,
  `DISCOVERY`, `PLANNER`, `REPAIR`, `SETUP`, `ADVISOR`, ...). QA's internal
  sub-roles are folded into `QA`. `model` is the provider's model id.
- **`cost` is USD**, rounded to 4 places (a single task is often under a
  cent). `costIsFloor: true` means some calls reported no price, so `cost` is
  a lower bound: show `$1.23+`. `cost` is **absent** when no call in that
  bucket reported a price: show no cost rather than `$0`. A genuinely free
  call is `cost: 0` with `costIsFloor: false`. On `byWorker`/`byModel` rows
  `costIsFloor` is present only when it is `true`.
- `last` is the most recent task that has **ended**; it is omitted until one
  has. A task still running is never `last`.
  - `status` is one of `completed`, `failed`, `aborted`, `interrupted`
    (the desktop process died mid-task), or `running`.
  - `title` is the first line of the user's prompt, clipped to 80
    characters; omitted if unavailable.
  - Per-phase and per-task breakdowns are kept on the desktop (`/usage`),
    not sent over the wire.
- Counts, model ids and a short title only: no prompt body, code or file
  paths. Like every other event it is end-to-end encrypted; the relay only
  sees ciphertext.

#### `model.catalog`

```json
{
  "kind": "model.catalog",
  "role": "editorVision",
  "models": [
    {
      "id": "openai/gpt-4o-mini",
      "pricing": { "promptPerM": 0.15, "completionPerM": 0.60 },
      "isFree": false,
      "isVariablePrice": false,
      "contextLength": 128000,
      "supportsVision": true,
      "supportsTools": true
    }
  ]
}
```
Sent in response to `list_models` (§6). **Cheapest-first, server-guaranteed**
— render as-received. `pricing` is `null` exactly when `isVariablePrice` is
`true` (a router-style model whose cost can't be known up front). The full
filtered list is sent in one event, never chunked — even a few hundred
candidates lands comfortably under the broker's 1MB per-request cap as plain
JSON. "Type to narrow" search is expected to be client-side substring
filtering against `id`, the same way the desktop's own `/model` picker works
— there is no per-keystroke round trip.

#### `model.catalog_unavailable`

```json
{ "kind": "model.catalog_unavailable", "role": "editorVision", "reason": "Could not reach OpenRouter: ..." }
```
Sent instead of `model.catalog` when `list_models` couldn't complete — no
API key configured on the desktop, or the live OpenRouter fetch itself
failed. Show `reason` in place of the candidate list.

#### `gate.result`

```json
{
  "kind": "gate.result",
  "at": "...",
  "taskId": "task-1790729755716-abc123",
  "tier": "semantic",
  "gate": "requirement coverage",
  "status": "fail",
  "blocking": true,
  "detail": "UNMET: Favorites persist across restart — no persistence call found",
  "artifacts": ["C:\\Users\\brian\\project\\.agent\\screenshots\\expo-web-1790730945670.png"]
}
```
`tier` is one of `build | runtime | visual | static | semantic`. `status` is
one of `pass | fail | skipped | inconclusive | error` — only `blocking: true`
combined with `status: "fail"` can fail the phase; `error` (the check itself
broke, not the code under test) and `inconclusive` never do. `artifacts`,
when present, are screenshot file paths — correlate by the exact path string,
there's no shared id with the `screenshot.chunk` events sent live for the
same capture.

**This path is the only thing that survives a gap.** `screenshot.chunk` is
deliberately excluded from the durable history log (base64 image data would
bloat it past usefulness — see `appendHistoryEntry`'s exclusion list), so a
`gate.result` recovered via `fetch_history`, or simply replayed after any
reconnect, always names the file but never carries pixels for it. If you
don't already have the image data for one of these `artifacts` paths, send
`fetch_screenshot` (§6) with that exact path — it re-reads the file straight
off disk, so it works even across a desktop restart (unlike `fetch_diff`'s
in-memory cache).

#### `verdict`

```json
{
  "kind": "verdict",
  "at": "...",
  "taskId": "task-1790729755716-abc123",
  "passed": false,
  "confidence": "verified",
  "blockingFailures": ["requirement coverage: UNMET: Favorites persist across restart — no persistence call found"],
  "advisories": []
}
```
QA's final roll-up for the phase, fired once, right before QA's `worker.end`.
`confidence` is one of `verified | partial | static-only` (how much of this
was actually observed running vs. only read/compiled). `blockingFailures`/
`advisories` are pre-formatted `"gate: detail"` strings, not structured
entries — if you want the individual `tier`/`gate`/`status` fields for each
one, use the `gate.result` events that already fired for them instead of
re-parsing these strings.

## 6. Outbound: command payloads (device → desktop)

Sent as `{ "id": "...", "issuedAt": "ISO-8601", "deviceId": "...", "payload": { ...one of below } }`,
then the whole thing is encrypted into an `Envelope` and POSTed to
`/v1/command`. `id` should be a fresh random string per command — the
desktop de-duplicates by `id` (a replay guard), so reusing an id makes a
second identical command a silent no-op.

Two permission tiers. **Tier 1 — `abort`/`ping`/`fetch_diff`/
`get_model_config`/`get_usage`/`list_models` — is always allowed**, cannot be disabled.
**Tier 2 — everything else, `set_model` included — requires the run to have
been started with answering enabled** (`allowAnswer`, which is always `true`
in the current desktop CLI, but a client should handle a `command.refused`
for any Tier 2 verb gracefully regardless).

### `abort`
```json
{ "verb": "abort", "reason": "stopped from phone" }
```
`reason` is optional. Stops at the next safe boundary (between tool rounds /
phases), never mid-write.

### `ping`
```json
{ "verb": "ping" }
```
No fields. Answered with a `pong` event.

### `answer`
```json
{ "verb": "answer", "questionId": "task_run_1789_172...", "answer": "Swap fast-forward and throw." }
```
Answers a specific `PendingQuestion` by id.

### `approve`
```json
{ "verb": "approve", "questionId": "..." }
```
Shorthand equivalent to answering with empty string — used for a pure
yes/proceed prompt.

### `reject`
```json
{ "verb": "reject", "questionId": "...", "reason": "wrong screen, use RaceScreen not BettingScreen" }
```
`reason` is optional; if omitted the desktop uses the literal string
`"rejected"` as the answer text.

### `message`
```json
{ "verb": "message", "text": "Add a Rescue tab to the market screen." }
```
Free text with **no `questionId`** — the phone-initiated "start a task" path.
If a question is currently pending, the desktop applies this as that
question's answer immediately. If nothing is pending (the desktop is mid-run),
it's queued and applied the instant the desktop next asks anything at all,
including its own recurring idle "what should I do" prompt. It can never
interrupt a tool call or a phase already in flight.

### `attach`
```json
{
  "verb": "attach",
  "uploadId": "up_9f8e7d",
  "name": "screenshot.jpg",
  "mime": "image/jpeg",
  "seq": 0,
  "total": 6,
  "data": "base64-chunk..."
}
```
Same chunking convention as `screenshot.chunk`, reversed direction: 48 KB raw
per chunk. Limits: **10 MB per file**, **40 MB per session total**. `name` is
sanitized server-side on arrival — don't rely on the exact string round-
tripping unchanged. A completed upload (all chunks received) is staged to
disk as reference material for the *next* plan; it never affects a run
already in progress, and it is never executed.

### `fetch_diff`
```json
{ "verb": "fetch_diff", "changeId": "3f9a1c2e-...-b6d4" }
```
Requests the full diff text behind a `file.changed` event's `changeId`
(§5). **Tier 1 — always allowed**, same as `abort`/`ping`: it only reads
something already produced, so it can never alter or interrupt a run.
Answered with one or more `diff.chunk` events, or `diff.unavailable` if the
change already aged out of the desktop's cache.

### `fetch_history`
```json
{ "verb": "fetch_history", "after": "2026-09-16T18:02:11.483Z" }
```
Asks the desktop to re-serve its own durable event log, strictly after the
given timestamp. **Tier 1 — always allowed**, same as `fetch_diff`/`abort`/
`ping`: it only reads something already produced.

**Why this exists**: the broker keeps only the newest **500 events per
session** in memory (`MAX_QUEUE` in `broker.ts`) — a long enough gap (the
phone asleep overnight through a busy task) can push the total past 500 and
permanently drop the oldest ones from the broker's buffer before the phone
ever polls for them. `/v1/stream` gives no signal that this happened; a
client has to detect it itself (see "Detecting a gap" below). Once detected,
`fetch_history` is the only way to recover those events — the broker has
already discarded them, but the desktop's own on-disk log (independent of
any broker session, see "History across sessions") still has everything.

`after` is an event's own `at` (ISO-8601) — **not a broker `seq`**. A
`seq` has no stable meaning across sessions (it resets on every re-pair) and
the durable log isn't keyed on it; `at` is what actually survives. Use the
last event you successfully rendered before the gap.

Answered with the recovered events themselves (each sent as its own ordinary
event — `worker.start`, `log`, `file.changed`, whatever it originally was,
indistinguishable from a live one), followed by exactly one `history.fetched`
marking the batch complete. Capped at 500 per request; if `history.fetched`
comes back with `truncated: true`, send another `fetch_history` using the
`at` of the last event you just received, and repeat until `truncated` is
false — this pages forward through an arbitrarily large gap.

**One thing this does NOT recover: screenshot pixels.** `screenshot.chunk` is
deliberately excluded from the durable log (bulky image data), so a
recovered `gate.result` will always name its screenshot file but never
include its chunks. Use `fetch_screenshot` (below) for those, per-file, on
demand.

### `fetch_screenshot`
```json
{ "verb": "fetch_screenshot", "path": "C:\\Users\\brian\\project\\.agent\\screenshots\\expo-web-1790730945670.png" }
```
Asks the desktop to re-send a screenshot's actual image data, by the exact
path a `gate.result`'s `artifacts` entry gave for it. **Tier 1 — always
allowed**, same as `fetch_diff`: it only reads something already produced.

**Why this exists**: `screenshot.chunk` is deliberately excluded from the
durable history log — a `gate.result` recovered via `fetch_history`, or
simply replayed after any reconnect, always has the filename but never the
pixels, which otherwise only ever lived in memory on the way to a live
stream and are gone the moment that's lost (a restart, or a client that
doesn't persist chunk buffers across its own process lifetime).

Unlike `fetch_diff`'s in-memory, process-lifetime `diffStore`, this reads the
file straight off disk — the desktop's screenshots persist indefinitely in
`.agent/screenshots/`, so this still works even after the desktop process
itself has restarted. The `path` you send is reduced to its own filename and
re-resolved under the repo's own screenshot directory server-side, never
used as-is — sending a path outside it, or a nonsense one, simply resolves
to nothing found there.

Answered with `screenshot.chunk` events (the same shape and reassembly as
any other screenshot), or `screenshot.unavailable` if the file is genuinely
gone (deleted, or never a real path this repo produced):
```json
{ "kind": "screenshot.unavailable", "path": "...", "reason": "That screenshot no longer exists on disk." }
```

### `get_model_config`
```json
{ "verb": "get_model_config" }
```
No fields. **Tier 1 — always allowed.** Answered with a `model.config` event
(§5) covering all 7 roles.

### `get_usage`
```json
{ "verb": "get_usage" }
```
No fields. **Tier 1 — always allowed**, pure read. Answered with a
`usage.totals` event (§5). You normally don't need it — the desktop pushes
that event on pairing and after every task — but it is the refresh action for
a usage screen.

### `list_models`
```json
{ "verb": "list_models", "role": "editorVision", "exclude": ["openai/gpt-4o"] }
```
**Tier 1 — always allowed.** `role` is one of the role strings in `model.config`'s
`roles` (§5). The candidates are already filtered to what that role needs (`needsVision` roles list only
vision-capable models). For a `multi` role send no `exclude`: the set is chosen from one list. `exclude` is optional — an array of model ids to drop from
the results, used for the backup-picker step (set to `[primaryJustChosen]`),
same two-step flow (primary, then backup) the desktop's own `/model` uses.
Can be slow (a live OpenRouter catalog fetch) — show a spinner while
waiting. Answered with `model.catalog` or `model.catalog_unavailable` (§5).

### `set_model`
```json
{ "verb": "set_model", "role": "editorVision", "chain": ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"] }
```
Persists a new chain for one role, exactly where `/model` already persists
it (project config if this repo has one, else the user's global config).
`chain: [primaryOnly]` is valid (no backup). A normal role takes at most a primary and one backup (a longer chain is
refused: "... takes a primary and at most one backup."). A `multi` role takes 1 to `multi.max` models (a longer set
is refused: "Logo designer takes at most 6 models."). The same model twice, or an empty id, is refused. `chain: []`
clears any role whose `roleInfo.optional` is true back to unset — sending it for one of the four required roles
(`discovery`/`planner`/`editor`/`verifier`) is refused via `command.refused`, since those can never be left without
a model.

**Also refused via `command.refused`** whenever a task is actively
**RUNNING** (reason names this explicitly) — changing model config out from
under an in-flight phase would leave what's displayed no longer matching
what that phase's own calls are actually using. It's allowed while **idle**
and while genuinely paused **awaiting a pending question**
(`RemoteStatus.state: "awaiting-input"`) — that's the human's turn, not the
model's, so changing config in that window is safe.

On success (not refused), the desktop re-pushes a fresh `model.config` (§5)
reflecting the new state for all roles — never trust an optimistic local
update; wait for this to actually update the UI.

## 7. Session lifecycle notes

- **12-hour idle TTL**, swept every 60s server-side. A session with no
  desktop activity for 12h simply stops existing — no `session.end` fires
  for this case, since the desktop process itself is what generates that
  event and it may no longer be running.
- **`seq` is a strictly increasing per-session counter**, shared across every
  event kind (not per-kind). `/v1/stream?after=N` returning nothing doesn't
  mean the session is dead — it means nothing new happened since `seq N`.
  Track the highest `seq` seen and always pass it back as `after`.
- **Events and commands are two separate `seq` spaces — never share a counter
  between them.** `s.events` (desktop → phone) and `s.commands` (phone →
  desktop) are independent arrays on the broker (`broker.ts`'s `Session`),
  each numbered by whoever generates that direction's envelopes. A command's
  `seq` exists only for that envelope's own AES-GCM AAD binding (§3) — it is
  never compared against anything in event-space, anywhere: `GET
  /v1/commands` (§4) has no `after` filter at all, it's a plain drain. The
  ONLY thing that should ever advance a client's `/v1/stream?after=` cursor
  is the highest `seq` actually seen in an `events` array FROM that endpoint.
  A client that reuses one counter for both its outbound command numbering
  and its stream cursor will skip real events every time it sends a command.
- A device reconnecting after being backgrounded should resume from its last
  known `seq`, not `-1` — replaying the full event history is only harmless
  if the client actually implements the reconciliation rules below (`status`
  and `plan.ready` replace-by-`runId`, not append); a client that blindly
  appends every event it receives WILL produce duplicate plan/phase cards on
  a full replay. Resuming from the last known `seq` is still the right
  default regardless — it's wasteful even when harmless, and old
  `screenshot.chunk` events for an already-fully-rendered screenshot will
  just be ignored by a client that doesn't keep chunk buffers around
  indefinitely anyway.
- **A broker restart is not an unpairing.** The relay is redeployed from
  time to time, and paired sessions survive it (they are mirrored to disk and
  reloaded at boot), so the outage is a few seconds of connection errors,
  `502`/`530`, or `5xx`. Treat every one of those as **transient**: keep the
  pairing, retry with backoff (1s, 2s, 5s, 10s, capped at 20s), and resume
  `/v1/stream?after=` from the last seq you saw. Only a `401` that persists
  across many retries (a minute or more) means the relay genuinely lost the
  session; at that point, and only then, ask the user to pair again. Never
  clear the stored session or device token on a single failed request.

### Detecting a gap

The broker caps every session at the newest **500 events** (`MAX_QUEUE`,
`broker.ts`) — a long enough stretch without polling (the phone asleep
overnight through a busy task) can push the total past 500 and the broker
silently drops the oldest ones. `/v1/stream` gives no explicit signal that
this happened — no error, no count of what's missing — but a client that
already tracks its own last-seen `seq` (it must, for `after=`) can detect it
with pure arithmetic, no new endpoint needed:

> After polling `/v1/stream?after=X`, if the first event in the response has
> `seq > X + 1`, events `X+1` through `firstReturnedSeq - 1` were dropped by
> the broker before you ever saw them.

When that happens:
1. Note the `at` of the last event you successfully rendered BEFORE the gap
   (not the missing `seq` numbers — the recovery command is keyed on
   timestamp, see `fetch_history` in §6).
2. Send `fetch_history` with that `at` as `after`.
3. Apply the recovered events through the normal reconciliation rules
   (`status`/`plan.ready` replace-by-`runId`; everything else appends to the
   feed in the gap, now filled in rather than missing).
4. If the response's `history.fetched` says `truncated: true`, repeat with
   the last recovered event's `at`, until `truncated: false`.

This is the only way to recover events the broker already dropped — they
exist nowhere else but the desktop's own durable log (see "History across
sessions" below). A client that doesn't implement this will show a task
whose middle is silently missing after a big enough gap: phases that never
show as completed, chat bubbles and worker activity vanished from the
timeline, even though the desktop's own record is complete.

### History across sessions

The broker itself is NOT a durable history store — it only ever holds one
session's events in memory, and a re-pair explicitly deletes the old session
outright (`POST /v1/unregister`) rather than waiting out the 12h TTL. A brand
new session's event stream starts genuinely empty on the broker.

The desktop compensates for this on its own side: it keeps a durable,
on-disk log of every event it has ever translated for this repo (independent
of any session's lifetime), and replays that backlog into a freshly-paired
session — through the exact same `push()` call a live event uses — before
any live events for the new session arrive. From a client's perspective this
requires **no special handling whatsoever**: the replayed entries just show
up as the first events on `/v1/stream`, in chronological order, ahead of
whatever happens next. A client that renders events in `seq` order (as it
already must) gets continuity across a desktop restart or a fresh re-pair for
free.

The practical implication for a client implementation: do **not** clear a
locally-rendered task/event history on `session.end` or on a fresh pairing —
only the credentials need to go (see `session.end` above). If anything, treat
local storage as a cache and let a freshly-seeded session's replayed events
reconcile it, rather than the other way around — "reconcile" meaning the
per-`runId` replace rule under `status` and `plan.ready` above, not a plain
append. A client that gets this right is also naturally correct for the
desktop's own replay-reduction behavior: it only sends what's new since the
last pairing when it can (never resending something already delivered), but
it cannot always know that for certain (the desktop process itself may have
restarted, in which case it conservatively replays in full rather than risk
a client missing something) — so a correct client treats EVERY `status`/
`plan.ready` delivery as idempotent-by-`runId` regardless of whether this
particular redelivery was strictly necessary.

#### Cost per phase, per agent and per model (additive, `status`)

Unchanged: `tokensUsed`/`costUsd` (whole task), `phaseTokensUsed`/`phaseCostUsd` (current phase), `agentUsage` (whole task, by
agent role). Nothing was renamed or removed, so an app that ignores the fields below behaves exactly as before.

New, all optional (absent from a desktop older than this change):

- `phaseAgentUsage`: `{ [agent]: { tokens, costUsd? } }` for the **current phase only**, same keys as `agentUsage`
  (`EDITOR`, `QA`, `REPAIR`, ...). "What did the Editor cost in this phase."
- `phaseUsage`: `{ [phaseId]: { tokens, costUsd?, byAgent, byModel } }` for **every phase of this task so far**, finished
  ones included. `byAgent` has the same shape as `agentUsage`; `byModel` is keyed by provider model id. The current phase is
  live; a finished phase stays at its final value. Replace the whole map on each status, never add.

`costUsd` is omitted whenever no call in that bucket reported a price: show no cost, not `$0`.

**Roadmaps.** Each roadmap unit runs as its own task (`task.start.roadmapUnitId`). So "phase 5 of 11 of roadmap unit 4 of 5" is
`phaseUsage[<phase 5's id>]` on the status stream of the task whose `roadmapUnitId` is unit 4. `roadmap.state` carries no cost,
and the desktop does not yet total a roadmap across its units: a client that wants the roadmap's total sums the final
`costUsd` of each unit's task.

#### Roadmap card: `roadmap.state` (flat fields) and `task.start`

`roadmap.state` keeps its original `roadmap` object unchanged and now also carries a flat snapshot beside it. The newest
snapshot per `roadmapId` replaces earlier ones. It is sent when a roadmap is created or changed, when a unit starts, ends,
is added, dropped or reopened, on `/roadmap reset`, after a reconnect and for `get_roadmap`.

```json
{ "kind": "roadmap.state", "at": "...", "roadmapId": "2026-11-15T10:00:00.000Z",
  "title": "Rebuild the reducer", "done": 3, "total": 12, "state": "active",
  "units": [{ "id": "U001", "title": "...", "area": "Timeline", "status": "done", "summary": "Fields kept.", "taskId": "task-41" }],
  "roadmap": { "...": "the original payload, unchanged" } }
```

- `status`: `todo | running | done | blocked | dropped`. `state`: `active | finished | reset` (`reset` removes the card; its
  `units` is empty). `area`, `summary` (the result, only once `done`) and `taskId` (once the unit has started) are `null` until set.
- `total` does not count dropped units (dropping a unit lowers it). `roadmapId` is stable for the life of a roadmap.
- `task.start` carries optional `roadmapId` and `roadmapUnitId` only for a roadmap unit. An ordinary task has neither.
- No cost fields on roadmap events by design. When a roadmap is first started, the desktop asks a `question`
  (choices exactly `I understand, start` / `Cancel`) with the spending notice, once per roadmap. Unattended, it only logs it.
- `/design` and `/pentest` now send `task.start`/`task.end` (with `tokensUsed`/`costUsd`) and a `worker.start`/`worker.end`
  per model call (`DESIGNER`, `SECURITY`), and are counted in `usage.totals`.
