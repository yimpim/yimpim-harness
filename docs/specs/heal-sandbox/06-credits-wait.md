# Spec 06 — Out of credits: alert once, check every 4 minutes, resume, never give up

Independent of specs 01–05. Small. Can be done first or last.

## 1. The user's rule

Cost control is the user's job (limits on their OpenRouter key). When credits run out, YIMPIM must:
alert the user once, NOT hammer the API, re-check every **4 minutes**, and resume exactly where it was when money is back —
with no limit on how long it waits.

## 2. Today (`src/openrouter.ts`, `complete()`)

- `let creditsRetryCount = 0; const maxCreditsRetries = 60;` (~line 412) with the comment "~60 waits at up to 60s each is roughly
  an hour of patience".
- 402 branch (~606–645): `creditsRetryCount++; if (creditsRetryCount <= maxCreditsRetries) { const waitMs = Math.min(15_000 * creditsRetryCount, 60_000); … attempt--; }`
  so it waits 15 s, 30 s, 45 s, then 60 s, and gives up after ~60 waits (about an hour).
- `creditsWarningActive` makes the notification fire once and resets on the next successful call (keep that).

## 3. Change

1. Replace the schedule with: first wait **4 minutes**, every wait 4 minutes (`CREDITS_RECHECK_MS = 240_000`, exported for tests).
   No cap: remove `maxCreditsRetries` (and the branch that gives up when it is exceeded).
2. The wait must be interruptible by a user Stop: use the existing `this.delay` if it honours `runControl` (VERIFY), otherwise a
   delay that rejects with `AbortedError` when `runControl.signal` aborts. A Stop during the wait ends the call as Stop does today.
3. Each wait logs one line (not a ticker): `[CREDITS] Out of OpenRouter credits. Checking again in 4 min (waiting since HH:MM).`
   The first 402 also emits the existing notification (phone/terminal) — unchanged. Do not re-notify on every check.
4. The re-check IS the real request retried (no separate balance call): it is a single request every 4 minutes, which is the
   "do not hammer" requirement.
5. Still uncounted against `maxRetriesPerModel` and still does not mark the model unhealthy (keep today's behaviour).
6. Update the comment that justified the one-hour cap: the user decided waiting indefinitely is correct; their key's limits are
   the guardrail.

## 4. Tests (`test/creditsWait.test.ts`)

Stub `fetch` to return 402 twice then a valid stream; inject a fake delay (or `CREDITS_RECHECK_MS` override) that records waits.
1. waits are `[240000, 240000]`, then the call returns the content.
2. 100 consecutive 402s followed by success → still succeeds (no cap).
3. the notification is emitted once for a run of 402s, and again only after a success followed by a new 402.
4. a Stop during the wait → `AbortedError`, no further fetch.
