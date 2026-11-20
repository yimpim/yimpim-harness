# Spec 01 — No question waits forever

Goal: every question YIMPIM asks a person has a deadline (default 30 minutes, a user setting). When nobody answers in time, the question's stated default is
taken, the run carries on, and the choice is recorded as an assumption a person can review. Approvals that protect the machine (a command, an install, a
deletion, a push) take DENY on timeout, never allow.

## 1. What exists today (read before changing)

- **The funnel.** Almost every question goes through `askAnywhere(question, promptText)` (`src/remote/control.ts:255`) → `askRaw` (same file, ~line 300),
  which races the terminal prompt (`startPrompt`) against the phone (`runControl.ask(question)`). There is **no deadline**: with a terminal, both wait
  forever; without a terminal (non-TTY), it waits on the phone forever ("the caller's timeout/fallback applies" — no caller passes one).
- `askChoice` (`control.ts:394`) wraps `askAnywhere`. `AgentTools` gets its `askFn` from `index.ts:4731`, wired to `askAnywhere`; its four call sites
  (`agentTools.ts` ~1605 `ask_user`, ~2069, ~2240, ~2353: command/install approvals) pass fallback `"no"`.
- **The question object** `PendingQuestion` (`src/remote/protocol.ts:164`): `id`, `kind: "blocking" | "deferred" | "approval"`, `prompt`, `choices?`,
  `allowCustom?`, `fallback` ("Applied if nobody answers"), `askedAt`, `idle?` (the loop's own "what should I do next" prompt).
- `runControl.settleAllWithFallback()` (`control.ts:224`) already resolves every waiter with its fallback (used at shutdown).
- **Two prompts bypass the funnel**, both with `promptOnce` directly:
  - `resolveDeferredQuestions` (`src/agentLoop.ts:~1177`): one prompt per deferred decision ("Press Enter to accept fallback");
  - the visual-advisory accept prompt (`src/index.ts:~3331`).
  Both are skipped when `config.interaction.autonomous` is true (the default), which auto-accepts and logs to `QA_REVIEW.md`. With it false they block forever.
- `promptOrDefault` (`src/cli.ts:253`) auto-answers only for `--yes` or a non-TTY.
- The git-push question (`index.ts:~4640`) already refuses to ask when nobody can answer (`isInteractive() || remote?.connected`).

## 2. The rule

| Question | On deadline |
|---|---|
| `idle: true` (the loop's own "what next" prompt) | never times out (nothing is running) |
| `kind: "approval"` (command, install, deletion, push, anything the security reviewer could not clear) | answer **DENY** (see §3.3), whatever `fallback` says |
| anything else (`blocking`, `deferred`, `ask_user`, plan/roadmap questions, choices) | answer `fallback` |

A deadline of `0` means "never time out" (the old behaviour) — a user setting, not a default.

## 3. Changes

### 3.1 Setting
`src/config.ts` `interaction`: `answerTimeoutMinutes: z.number().min(0).default(30)`. `src/settings.ts`: a documented key in group "Interaction",
`common: true`, plain words: "How long YIMPIM waits for your answer before it takes the safe default and carries on (the choice is written down for you to
review). Approvals of commands, installs and deletions are refused, never allowed, when nobody answers. 0 = wait forever."

### 3.2 The deadline, in one place: `askRaw`
Add `deadlineMs` to `askAnywhere`'s options (a third optional parameter `{ deadlineMs?: number }`; when absent, read the configured value through a
module-level setter, e.g. `setAnswerDeadline(ms)` called once from `index.ts` after config is loaded, like `setQuestionExplainer`).
In `askRaw`, when `!question.idle && deadlineMs > 0`, race a timer too. On timeout:
1. `const answer = timeoutAnswer(question)` (§3.3).
2. `runControl.answer(question.id, answer)` so the phone's card disappears; `prompt.cancel()` for the terminal.
3. Return `{ answer, by: "timeout" }` (extend the union) and let `askAnywhere` log it (§3.4) instead of the "Answered ... here" line.
4. Clear the timer whenever a real answer wins (no leaked timers: tests check with a fake clock).

### 3.3 What a timeout answers: `timeoutAnswer(q)`
- `kind === "approval"`: a deny. If `q.fallback` already denies (case-insensitive `no`, `n`, `deny`, `skip`, `abort`, `cancel`, `local`, empty string), use
  it; otherwise use `"no"` and log that the fallback was not a denial (a caller bug worth seeing).
- otherwise `q.fallback`.
Export it; it is the policy and gets its own tests.

### 3.4 Recording it: `.agent/assumptions.md` and an event
- `recordAssumption(repoRoot, { questionId, prompt, answer, kind, askedAt, decidedAt, reason: "no answer within N min" })` appends one line block to
  `.agent/assumptions.md` (create with a header explaining what the file is). Plain text a person can read and edit. The repo root comes from a
  setter like the deadline (control.ts has no repo root today) — VERIFY where `index.ts` initialises remote/control and set both there.
- Console: `   ↳ ⏱ No answer in 30 min: took "<answer>" (written to .agent/assumptions.md): <first line of the prompt>`.
- `events.emit({ type: "question.timedOut", id, answer, kind })` — VERIFY the event union in `src/events.ts`/`src/remote/protocol.ts` and add the type
  (and map it in `src/remoteEventTranslator.ts` so the phone shows "taken by default").

### 3.5 The two bypasses go through the funnel
- `resolveDeferredQuestions` (`agentLoop.ts`): replace the `promptOnce` loop with `askAnywhere({ kind: "deferred", fallback: "", ... })` per item (empty
  answer = accept the fallback, as today). It then gets the deadline and the phone for free. Keep the `autonomous` short-circuit unchanged.
- The visual-advisory prompt (`index.ts:~3331`): same, `kind: "blocking"`, `fallback: ""` (accept the visual state).

### 3.6 Questions must carry a real default
- `ask_user` tool (`agentTools.ts`): VERIFY its parameters. If it has no `fallback`/`default` argument, add an optional one and say in the description: "Give
  the default you will use if nobody answers in time; it is taken automatically after the user's answer deadline." Pass it as the `PendingQuestion.fallback`.
  An empty default is allowed (free-text questions) and is recorded as "no answer".
- Roadmap questions (`roadmapFlow.ts` `askAll`): the `Question` has `options`; the fallback is `options[0]` (what `settleQuestions` already decides for
  unasked ones). VERIFY that `roadmapDeps().ask` builds a `PendingQuestion` with that fallback; if not, set it.
- Planner clarifying questions (`index.ts:~6567`, `askChoice(pending)`): VERIFY the fallback is the planner's own recommended choice.

## 4. Tests (`test/questionDeadline.test.ts`) — fake timers, no TTY

Use an injectable clock (pass `setTimer`/`clearTimer` into `askRaw` via the setter, or `node:test`'s `mock.timers`).
1. a `blocking` question with fallback `"b"` and nobody answering resolves to `"b"` at exactly the deadline, not before; `by: "timeout"`.
2. an answer at 29 minutes wins and no timer is left pending.
3. an `approval` question with fallback `"yes"` resolves to `"no"` on timeout (and logs the caller bug); with fallback `"skip"` resolves to `"skip"`.
4. `idle: true` never times out (advance 24 h: still pending).
5. deadline 0: never times out.
6. a timeout writes one block to `.agent/assumptions.md` with the prompt, the answer and the reason, and emits `question.timedOut`; the phone waiter is
   resolved (the card disappears).
7. `timeoutAnswer` table test for every deny spelling.
8. `resolveDeferredQuestions` with `autonomous: false` and nobody answering finishes after the deadline with every fallback accepted (no `promptOnce`
   left in `agentLoop.ts`: source check).
9. `askChoice` inherits the deadline.
10. settings: the key exists, is documented, parses from text.

## 5. Out of scope
Asking again later about an assumption, and a `/assumptions` command to review and revise them: worth doing, after this.
