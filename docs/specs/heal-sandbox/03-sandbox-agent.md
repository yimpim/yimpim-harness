# Spec 03 — The sandbox agent: a native tool loop on one parked cause

Goal: one parked cause is worked by the stronger model in a native tool-calling loop (the format Gemini, Claude and GPT are
trained for), inside the sandbox, with a short opening prompt, free to experiment, stopped only by its own conclusion, the user's
per-cause budget, or a state-based stagnation rule.

Code: `src/healSandbox.ts` (agent half), small additions to `src/agentLoop.ts` (`stopWhen`) and `src/agentTools.ts`
(sandbox-bound instance, tool subset export).

## 1. API

```ts
export interface SandboxCause { message: string; count: number; tests: string[]; reason: string; kind: "unsure" | "code" }

export interface SandboxResult {
  candidate?: string;            // the sandbox's test file text, if it differs from startText
  appFilesTouched: string[];     // repo-relative non-test files changed in the sandbox (instrumentation / code-bug evidence)
  conclusion: string;            // the agent's conclude_task explanation, or why it stopped
  stop: "concluded" | "code-bug" | "budget" | "stagnation" | "error" | "preflight";
  rounds: number;
  cost: number;                  // dollars, from events.usageDelta
  runs: number;                  // run_test calls
}

export type SandboxRun = (args: {
  repoRoot: string; file: string; testText: string; failureOutput: string;
  cause: SandboxCause; ledger: string[]; firstModelNotes: string;
}) => Promise<SandboxResult>;

export function createSandboxRun(deps: {
  client: OpenRouterClient; config: AgentConfig; models: string[];       // the STRONGER chain (repair models after the first)
  budgetUsd: number; stagnation: number;                                  // from config (spec 05)
  run: RunTests; securityCall: ReviewCall; log?: (l: string) => void;
}): SandboxRun;
```

`createSandboxRun` returns a function that, per call: `createSandbox` (spec 01) → agent (this spec) → collect → `destroySandbox`
in a `finally`. It never throws; every failure becomes a `SandboxResult` with `stop` set and no `candidate`.

## 2. The tool loop: reuse `runToolAgent` (`src/agentLoop.ts`)

```ts
const tools = SANDBOX_TOOLS_SCHEMA;   // exported from agentTools.ts:
// TOOLS_SCHEMA.filter(t => ["read_file","search_code","get_file_outline","list_files","patch_file","write_file","conclude_task"].includes(t.function.name))
//   + RUN_TEST_TOOL (spec 02)
await runToolAgent({
  prompt,                                   // §3
  repo: createRepoTools(sandbox.root, config),
  repoRoot: sandbox.root,
  client, config, models,
  agentTools: new AgentTools(sandbox.root, config, async (_q, fallback) => fallback),   // NEVER prompts a human
  agentName: "HEAL_SANDBOX",
  tools,
  maxRoundsOverride: Number.MAX_SAFE_INTEGER,   // budget and stagnation govern, not a round count (user rule: no arbitrary caps)
  stopWhen,                                     // §4, new option
  onToolCall,                                   // feeds the stagnation tracker
  reason: `heal sandbox: ${cause.message.slice(0, 60)}`,
});
```

Deliberately NOT in the tool set: `run_project_command`, `run_dependency_install`, `request_dependency`, `ask_user`,
`defer_question`, `stage_file_for_deletion`, `register_*`, `flag_manual_step`, `run_build_check`. Nothing outside the sandbox is
reachable, nothing waits on a person, nothing installs.

The sandbox's `AgentTools` must have `runTest` bound to this sandbox (spec 02 §4). Simplest: a subclass
`SandboxAgentTools extends AgentTools` with the sandbox and gate injected.

VERIFY and handle in `runToolAgent` for `agentName === "HEAL_SANDBOX"`:
- `conclude_task` with `FINISHED_PATCHING` and no file written is refused by the loop (agentLoop.ts ~640). In the sandbox an agent
  may legitimately conclude after only measuring. Make that refusal not apply to `HEAL_SANDBOX`.
- `CANNOT_LOCATE` throws `ESCALATION_NEEDED: …` (~632). Catch it in `createSandboxRun` → `stop: "concluded"` with that text.
- `ALREADY_COMPLETED` returns `TASK_ALREADY_SATISFIED: …` → `stop: "concluded"`.
- grep `agentName ===` / `isPlanner` / `isEditor` in `runToolAgent`: no Editor- or Discovery-specific nudges may fire for the new name.
- Gemini tool turns need the assistant message echoed with its `thought_signature` / `reasoning_details`; `readStreamedCompletion`
  already passes unknown delta keys through (openrouter.ts `ASSEMBLED_DELTA_KEYS`). VERIFY with one fake-model test that a
  passthrough field survives into the next request.

## 3. The opening prompt (short: the agent reads what it needs)

Target under 8,000 characters. No file contents except the failure. Template:

```
You are fixing ONE cause of failing tests in a JavaScript/TypeScript project, in a disposable SANDBOX copy of the project.

THE CAUSE
  [<count>×] <cause.message>
  Failing tests:
    - <test 1>
    - … (all of cause.tests)
  The first model's notes (may be wrong): <cause.reason>

WHAT ALREADY PASSES AND MUST KEEP PASSING
  <ledger lines, or "(the tests not listed above)">

THE TEST FILE: <file> (<N> lines). Read it with read_file (use line ranges). Search with search_code.

THE FAILURE NOW (this file run on its own)
<failureText(failureOutput, repoRoot, file) — the digest the heal already builds, cut to 4,000 chars>

HOW TO WORK
- Reading code cannot show timing (debounces, effects that run later), what an event carries, or what a mock returns.
  MEASURE: add console.log anywhere (the test or the app code), change a wait, then run_test with a namePattern for one test,
  and read the output. Repeat. This is a sandbox: experiments cost nothing and are thrown away.
- Only the TEST FILE comes back to the real project, and only if it makes more tests pass without breaking any that pass now.
  Changes to app code are thrown away (they are fine for logging). Remove your console.logs from the test file before you finish.
- Fix the TEST when it is out of date (the app's code, its doc comments, the spec in docs/ or *.md, and recent commits are the
  authority, in that order of strength). If the APP is wrong, do not bend the test: conclude and say exactly where (file:line) and
  what shows it.
- Never delete tests or assertions, never skip tests, never loosen an assertion into one that cannot fail.
- When the cause's tests pass (run them), or when you are sure the app is at fault, call conclude_task:
  FINISHED_PATCHING with what you changed and why; or CANNOT_LOCATE with what you found and what is still unknown
  (prefix with "APP BUG:" when the app is wrong).
```

## 4. `stopWhen` and stagnation (state-based, no round cap)

New option on `AgentRunOptions` (`src/agentLoop.ts`):

```ts
/** Checked at the top of every round. A string ends the run: the loop returns `STOPPED: <reason>` (no throw). */
stopWhen?: () => string | undefined;
```

Insert at the top of `while (rounds < maxRounds) {` (~line 495): `const why = options.stopWhen?.(); if (why) { emitAgentEnd(rounds, "stopped"); return `STOPPED: ${why}`; }`
VERIFY the exact `emitAgentEnd` status vocabulary and use an existing value if "stopped" is not one.

The tracker, fed by `onToolCall(name, args)` and by the results `run_test` returns (have `SandboxAgentTools.runTest` report each
result to the tracker):

1. **Budget.** `events.usageDelta(startSnapshot).totals.cost >= budgetUsd` → `"budget: $X of $Y spent on this cause"`.
   If `costKnown` is false for every bucket, fall back to tokens: stop at `budgetUsd / 1e-6` total tokens is NOT acceptable
   (made-up price). Instead: log once that the cost is unknown and rely on the stagnation rules only.
2. **Identical results.** Fingerprint each `run_test` result as `sha1(sorted failingNames(output) + "\n" + output with timings
   and paths normalised)`. `stagnation` (default 3) consecutive `run_test` calls with the same fingerprint AND no `patch_file`/
   `write_file` between them → `"stagnation: N identical test runs with no change in between"`.
3. **Editing blind.** `stagnation` consecutive rounds containing an edit and no `run_test` → `"stagnation: N rounds of edits without running a test"`.
4. **Reading only.** `2 × stagnation` consecutive rounds with only read/search/outline/list calls, no edit and no run →
   `"stagnation: N rounds of reading without an experiment"`. (Reading is allowed; reading forever is not.)
5. A refused `run_test` (spec 02 §5) counts as a round with no run and no successful edit.

Any round with a run whose fingerprint is NEW resets rules 2–4. There is no total round or time limit.

## 5. Collecting the result (before destroy)

- `candidate`: read `<root>/<file>`; if it equals `sandbox.startText` → undefined.
  Strip lines the agent added that are only `console.log(...)` / `console.debug(...)` statements (added lines only, compared with
  `startText`) — the prompt asks the agent to remove them; this is the safety net.
- `appFilesTouched`: `git -C root status --porcelain` → changed paths minus the test file minus junction dirs.
- `stop`: `"concluded"` (FINISHED_PATCHING / ALREADY_COMPLETED / CANNOT_LOCATE without "APP BUG:"), `"code-bug"` (CANNOT_LOCATE
  with "APP BUG:" prefix), `"budget"`, `"stagnation"`, `"error"` (exception), `"preflight"` (createSandbox failed).
- `conclusion`: the explanation text, or the `stopWhen` reason, or the error message (first 1,500 chars).

## 6. Tests (`test/healSandbox.agent.test.ts`) — fake model, fake runner, real temp git repo

Use a scripted fake `OpenRouterClient` (as `test/openrouterStream.test.ts` stubs fetch, or inject a client with `complete()`
returning queued tool calls).

1. happy path: model calls `read_file`, `run_test` (fails), `patch_file` on the test, `run_test` (passes), `conclude_task`
   → `candidate` contains the patch, `stop: "concluded"`, worktree removed, real test file untouched.
2. budget: usage events recorded with cost 0.30 per call, budget 0.75 → stops before the 4th call, `stop: "budget"`.
3. identical runs: three `run_test` with the same output and no edit → `stop: "stagnation"`; a run with a new output in between
   resets the count.
4. blind edits: three rounds of `patch_file` without `run_test` → stagnation.
5. reading only: six read rounds → stagnation; five reads then a run → continues.
6. honest exploration is never cut: 15 rounds alternating edit/run with a new fingerprint each time, then conclude → concluded.
7. app instrumentation: `patch_file` on `src/x.ts` → listed in `appFilesTouched`, never in the real repo.
8. console.log lines added to the test are stripped from `candidate`.
9. `CANNOT_LOCATE` with "APP BUG: src/x.ts:12 …" → `stop: "code-bug"`, conclusion preserved.
10. tools offered to the model are exactly the sandbox set (assert the `tools` array sent to `complete`).
11. `ask_user` is not offered; the `AgentTools` ask function returns the fallback without reading stdin.
