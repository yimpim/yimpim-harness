# Spec 02 — The Editor keeps its tests current, and makes its work testable

Goal: a ticket never reaches QA with tests its own change broke. The Editor runs the tests its change can reach, fixes what its change made stale (in the
test or in its code), and only then concludes. What it cannot fix goes to the sandbox heal (spec heal-sandbox) before QA. And every ticket that adds
something QA cannot reach on its own (a screen behind login, a feature behind a real API) also adds the way in: mock data, a dev toggle, a deep link.

Why: today's 28-test pile-up was tests rotting across tickets. The verifier does run the tests a change reaches, but only at QA time, after the Editor is
done; `find_test_references` only catches tests that NAME something removed, not a changed behaviour (a new debounce, a renamed label, a new event shape).

## 1. What exists today

- `selectTests(repoRoot, changed)` (`src/testGraph.ts:175`): the tests whose import graph reaches a changed file (all of them when project config
  changed; `uncertain` when imports could not be resolved). `staleSince(repoRoot, tests)` adds tests whose dependencies changed since they last ran.
- The verifier's test gate (`src/verifierTools.ts:~2600-2700`) runs exactly that selection with `runSuiteLogged`, then splits failures into "already failing
  before this phase" (`failsBefore`, healed by `healTests` with the sandbox) and "caused by this phase" (blocking, sent to REPAIR).
- The Editor's tools: `run_build_check` (build/typecheck), `find_test_references` + the automatic `unseenTestReferences()` bounce at
  `FINISHED_PATCHING` (`src/agentLoop.ts:~690`, EDITOR/REPAIR only, skipped for must-pass fixes).
- Focused tests: the Editor may write scaffolding tests under `_focus/`, finalised after the phase (`finalizeFocusTests`, `index.ts:~3380`).
- QA access (web only): `register_qa_setup` → `.agent/qa-setup.json` (`src/qaSetup.ts`): `launchPath`, `localStorage`, `cameraImage`, `uploadFiles`, `notes`.
  `src/visualProbes.ts` reads it. `flag_manual_step` records things only a person can do outside the repo.

## 2. Part A — the affected-test sweep, inside the Editor's ticket

### 2.1 When
At the Editor's `FINISHED_PATCHING` (the same place `unseenTestReferences()` is checked in `agentLoop.ts`), for `EDITOR` and `REPAIR`, once the change
has written at least one non-test source file. Not for verify-only phases, not when the project has no test runner (`focusedTestCommand` undefined).

### 2.2 What
1. `sel = selectTests(repoRoot, filesWrittenThisPhase())` plus `staleSince` (reuse the verifier's exact selection logic: factor it into one function in
   `testGraph.ts`, e.g. `selectForChange(repoRoot, changed)`, and have BOTH the verifier and this sweep call it, so the Editor checks exactly what QA will).
2. Exclude tests already failing before this phase: `failsBefore` (the verifier's helper) — those are not this ticket's to fix, and the heal handles them.
   Cache the baseline per phase so it runs once.
3. Run the rest with `runSuiteLogged`. If green: conclude as today, and record in the conclusion "N affected tests pass" (the QA ledger can show it).
4. If red: do NOT accept the conclusion. Send the Editor back with a tool message, once per distinct failure set (like `unseenTestReferences`, never in a
   loop):
   `NOT YET: your change breaks N test(s) that passed before it: <file › title, up to 10>. <failureText digest, cut to 3,000 chars>. Fix what your change
   made out of date: if the test checks the old behaviour on purpose and the change is what the ticket asks for, update the test (change the expected value or
   selector; never delete or weaken an assertion); if the test is right, fix your code. Run run_affected_tests to check, then conclude again.`
5. A new tool `run_affected_tests` (EDITOR/REPAIR tool set; NOT in the sandbox set): runs the same selection now and returns the digest. Shell-free and
   gated exactly like `run_test` (reuse `src/sandboxRunTest.ts`'s runner resolution and env scrub; there is no sandbox here, so the gate's reviewer is the
   project's command reviewer — VERIFY `AgentTools.setCommandReviewer` is set in `index.ts` before phases run).

### 2.3 What is left goes to the heal, before QA
If the Editor concludes a second time with the same failing set (it tried and could not), the ticket does not go to QA red: run
`healTests({ files: <those test files>, call, sandbox, ... })` exactly as the verifier's gate does for pre-existing failures (same construction via
`sandboxFor`). The deviation policy and ratchet apply unchanged (a test bent to follow the app needs evidence; a defect is reported, never bent).
Whatever the heal could not settle goes to QA as it does today (QA's own gate blocks on it and REPAIR runs) — never silently passed.

### 2.4 Integrity
The Editor may update tests; it may not remove or skip them. Before accepting a conclusion after a sweep, run `candidateProblem` (`src/testHeal.ts`) on every
test file the Editor changed (before vs after the phase): fewer tests, thinner assertions, new `.skip`/`.only` → bounce with the reason. This is the same
rule the heal uses for the sandbox's candidates.

## 3. Part B — QA access hooks in the ticket contract

### 3.1 The contract
In the Editor's system prompt (`EDITOR_SYSTEM`, `src/prompts.ts` — VERIFY name) and in each roadmap unit's acceptance (spec 03 §5): when the change adds or
changes something QA cannot reach from a fresh start — a screen behind sign-in or pairing, data that only a real backend returns, a native-only path, a
feature behind a flag — the same ticket adds the way in, using the cheapest honest one:
- **web state**: `register_qa_setup` (exists): `launchPath`, `localStorage` (a signed-in session, onboarding done);
- **mock data / mock endpoint**: a dev-only fixture or mock (an MSW handler, a fake service selected by an env flag or `__DEV__`), never shipped enabled
  in production; say where it is switched on;
- **dev toggle**: a flag read from env/config/localStorage that enables the feature for QA;
- **deep link**: a route (`myapp://…`, `/route?state=…`) that opens the screen directly; record it for the visual verifier.
The Editor states which it used (or that none was needed) in the conclusion; QA reads it.

### 3.2 Extend QA setup for native and APIs
`src/qaSetup.ts` `QaSetup` gains (all optional, sanitised like the existing fields):
- `deepLinks: { name: string; url: string }[]` — opened by the Android/iOS probes (`adb shell am start -W -a android.intent.action.VIEW -d <url>`;
  VERIFY how `visualProbes.ts` launches the emulator and add the deep-link step there);
- `env: Record<string, string>` — variables the app is started with for QA (only names matching `/^(EXPO_PUBLIC_|VITE_|NEXT_PUBLIC_|REACT_APP_|QA_|MOCK_)/`,
  so nothing secret-shaped is set);
- `mockNotes: string` — what is mocked and where it is switched on.
`register_qa_setup`'s schema and description gain the same fields. Values are validated: deep links must be a URL with a scheme or start with `/`; env values
are strings ≤ 200 chars.

### 3.3 Never in production
A mock or toggle must be off unless the dev flag or QA env is set. Spec 04 (the security gate) will check for mocks enabled in production builds; for now the
Editor prompt says it, and the QA ledger lists every mock/toggle the ticket added (from the conclusion) so it is visible.

## 4. Tests

`test/editorTestSweep.test.ts` (fake model through `runToolAgent`, a temp repo with a stub runner like `test/healSandbox.agent.test.ts`):
1. an Editor change to `src/a.ts` that breaks `__tests__/a.test.ts` (which reaches it): `FINISHED_PATCHING` is bounced with the failing title and digest; the
   Editor updates the test; the second conclusion is accepted.
2. a test that was already failing before the phase is NOT bounced (it is not this ticket's).
3. a test that does not reach the changed file is not run (assert via the runner's recorded file list).
4. the same failing set twice → no third bounce; the heal is called with those files (spy `sandbox`), and QA receives whatever is left.
5. an Editor that "fixes" by deleting a test or adding `.skip` is bounced with the integrity reason.
6. `run_affected_tests` returns the digest; it is shell-free (argv array) and its env has no secrets (reuse the sandboxRunTest assertions).
7. no test runner in the project → no sweep, conclusion accepted as today.
8. `selectForChange` is called by both the verifier gate and the sweep (source check), so they cannot drift.
`test/qaSetup.test.ts` additions: `deepLinks` and `env` are sanitised (a secret-looking env name is dropped; a deep link without a scheme or `/` is dropped).

## 5. Out of scope
Writing new tests for new features (the focused-test flow exists); changing QA's own gate.
