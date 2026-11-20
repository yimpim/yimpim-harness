# Spec 04 — Bringing the result back: the test file only, through the per-test ratchet

Goal: a sandbox candidate reaches the real test file only if it makes strictly more tests pass and breaks none that passed; app
code in the real repo is never changed; a crash mid-merge can always be undone; what was fixed is recorded so the next cause, and
the report, know.

Code: `src/testHeal.ts` (`healOneInner`), using existing helpers only.

## 1. Option

`HealOptions.sandbox?: SandboxRun` (type from `src/healSandbox.ts`). Injected like `escalate`, so `testHeal.ts` stays free of
models and git worktrees and its tests can pass a fake.

## 2. Where it plugs in

In `healOneInner`, after `let outcome = await converse(opts.call, "first");`:

```ts
if (outcome === "parked-out" && opts.sandbox && parked.size > 0) {
  await sandboxParked();                          // §3 — may change last/current/ledger/parked
  if (parked.size === 0 || !focusOf()) { /* everything settled */ }
}
// then the EXISTING code: if (outcome === "parked-out" && opts.escalate && parked.size > 0) { … JSON strong pass … }
```

Decision: when `opts.sandbox` is given, the JSON strong pass (`opts.escalate`) is NOT also run (the sandbox replaces it). Wire
`index.ts`/`verifierTools.ts`/bench to pass `sandbox` and leave `escalate` undefined when the sandbox is enabled (spec 05).

After `sandboxParked()` the code continues to the EXISTING finalisation unchanged:
- every cause fixed → the normal healed result (verify the existing "healed" path is reached: if `current.ok`, return the healed
  result exactly as the loop does when a run passes — factor that into a helper if needed, do not duplicate its logic);
- causes still parked → existing code-bug partial / `giveUp` with progress kept.

## 3. `sandboxParked()`

```
for each cause in parked, by count descending (re-read causesOf(current.output) each time: earlier merges change the picture):
  skip if it no longer appears in current.output
  r = await opts.sandbox({ repoRoot, file, testText: last, failureOutput: current.output,
                           cause: { message, count, tests: <failing names of this cause>, reason, kind }, ledger: ledgerLines(),
                           firstModelNotes: <batches summary as built for the HANDOFF today> })
  log one line: `sandbox ${file}: [${count}×] ${message} → ${r.stop}, ${r.runs} test runs, $${r.cost.toFixed(2)}`
  record r in a per-file sandbox report (for HealResult note and the benchmark)
  if r.stop === "code-bug": mark the parked entry kind "code", reason = r.conclusion (+ appFilesTouched as evidence); continue
  if !r.candidate: keep parked with reason = r.conclusion; continue
  await mergeCandidate(r.candidate, cause)        // §4
```

The failing names of a cause: the tests in `failingNames(current.output)` whose failure block's digest signature matches the
cause key (use the same grouping `causesOf` uses; expose a helper from `src/failureDigest.ts` if needed).

## 4. `mergeCandidate(candidate, cause)` — the ratchet

All helpers exist: `beginTrial`/`endTrial` (`src/healCheckpoint.ts`), `regressions`, `madeWorse`, `testsPassing`,
`testsFailing` (`src/healAuthority.ts`), `run` (the heal's runner).

```
if candidate === last: return
integrity first (cheap, before running anything):
  - statsOf(last) vs statsOf(candidate) (src/benchScore.ts or the heal's own checks): test count must not drop, assertion
    count must not fall below 95% of before, no new .skip / .only / xit / xdescribe. Fail → reject with reason.
beginTrial(repoRoot, file, last, candidate)
write candidate to the real file
after = await run(repoRoot, [file])
broke = regressions(current.output, after.output, last, candidate)
worse = madeWorse(testsFailing(current.output), testsFailing(after.output))   // match the existing call shape in testHeal.ts
gain  = (testsPassing(after.output) ?? 0) - (testsPassing(current.output) ?? 0)
accept = broke.length === 0 && !worse.worse && gain > 0
if accept:
  ledger.push({ message: cause.message, fixed: <drop in this cause's count>, by: "sandbox: " + first line of r.conclusion })
  for every parked cause whose count dropped or vanished: remove from parked
  last = candidate; current = after
else:
  write last back
  parked cause reason = `the sandbox's change was not kept: ${broke.length ? `it broke ${broke.slice(0,3).join(" | ")}` : worse.worse ? "it made more tests fail" : "it did not make any more tests pass"}`
endTrial(repoRoot, file)
```

Never write product code in the real repo. `appFilesTouched` is only ever text in notes.

`recoverTrial` (already called at the start of every heal) covers a crash between `beginTrial` and `endTrial`.

## 5. What the result says

Extend the `HealResult.note` (existing field) for files that went through the sandbox with one line per cause:
`sandbox: [3×] Expected: > 0 → kept (+3 passing, $0.41, 9 test runs)` or `→ not kept: it broke …` or `→ stopped: stagnation …`
or `→ app bug: src/components/DashboardTimeline.tsx:3159 … (evidence: app files changed in the sandbox: …)`.
`renderHealReport` needs no structural change if the note carries this; VERIFY the note length limits (`slice(0, 2400)` in places)
and keep the sandbox lines within them.

## 6. Tests (`test/healSandbox.merge.test.ts`) — fake `SandboxRun`, the per-cause fixture style of `test/healPerCause.test.ts`

1. first model parks B; fake sandbox returns a candidate fixing B → kept; file has A and B fixed; result healed when C also fixed.
2. candidate fixes B but breaks A (which the first model fixed) → rejected, file restored to the first model's result, note says
   "it broke test-A1".
3. candidate that changes nothing passing (gain 0) → rejected ("did not make any more tests pass").
4. candidate that deletes a test / adds `.skip` → rejected before any run (spy on `run`: not called for the candidate).
5. `stop: "code-bug"` → cause stays parked as kind code; final status `code-bug`, partial, with the sandbox's file:line in the note.
6. two parked causes: the first merge also fixes the second (its count drops to 0) → the sandbox is called once, not twice.
7. crash simulation: throw inside `run` after `beginTrial` → next heal's `recoverTrial` restores `last`.
8. `opts.sandbox` given → `opts.escalate` is never called (spy).
9. no `opts.sandbox` → behaviour identical to today (the existing per-cause tests still pass unchanged).
