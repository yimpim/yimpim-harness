# Heal sandbox: solve parked test causes the way Claude Code does

Status: SPEC, not built. Written 2026-11-20 from the benchmark evidence below. Implement on a feature branch `heal-sandbox`,
one commit per spec file 01–05 (06 is independent), the full suite green after each (`node scripts/test.mjs`, `npx tsc --noEmit`).

Read this file first, then the numbered specs in order. Every function, file and line named here was checked against the code on
2026-11-20 (commit `90f5bd4` + uncommitted probe/overlap work). Where a spec says **VERIFY**, check before relying on it.

---

## 1. The problem, in numbers

The benchmark (`scripts/bench-heal.mjs`, fixture in `C:\Users\brian\yimpim-bench`) heals one broken file: the Expo repo's
`__tests__/dashboard.test.ts`, 3,6xx lines, 164 tests, 34 failing at the start, with an answer key.

| Build | Score | Cost | What happened |
|---|---|---|---|
| before per-cause work | 130 | — | the worker only looked things up, never proposed an edit |
| `ca63d05` per-cause + escalation | 154, 153 | $0.33, $0.15 | cheap model (DeepSeek) fixes the easy causes; stronger model (Gemini Hydrogen) returned EMPTY replies |
| `7dc286d` | 136 | $0.25 | a code-bug claim parked every cause at once (fixed in `5bf2575`) |
| `5bf2575` | 153 | $0.19 | Hydrogen empty again: Google `MALFORMED_FUNCTION_CALL` |
| `90f5bd4` json_schema | 153 | **$2.27** | Hydrogen answered every call but made **14 calls, 13 lookups, 0 edits**, prompt grew 176k → 475k chars, parked |

The cheap first model reliably takes the file from 34 failing to 11 for about $0.19. **The last 11 never fall.** They are:

- 8 tests in `Dashboard poll-stream notices and recovery` (Send/Stop derived from desktop activity, stop reason, slash suggestions,
  archive polling, history.index retry, phase header count, expanded-card reset)
- 3 tests in `PendingQuestionCard` (Reject button, draft-gated send)

The same file was brought to **164/164** the day before by a model working in Claude Code. The facts that unlocked it were found by
**experiment**, not by reading:

- the timeline reducer is debounced by **60 ms** (`deliver()` had to wait for it),
- the fake event log **de-duplicates on `eventId`**, so id-less events collapsed into one (fixed by numbering them `800_000 + seq`),
- several expectations were written against an older spec (§17: Dismiss, lowercase yes/no, no reply field with choices).

## 2. Why the harness cannot do what Claude Code did (root causes)

These are properties of the protocol, not of prompts. More prompt or schema tuning will not remove them.

1. **An experiment and a fix are the same act.** In the JSON heal loop (`src/testHeal.ts`, `healOneInner` → `converse`) the only
   way to change anything is a verdict with edits to the REAL test file, judged by the ratchet. Claude Code's winning move was
   "change the wait in a throwaway copy, run it, compare". Here a model must dress a hypothesis up as a fix; a neutral one stays in
   the file, a failed one is undone with a refusal. A careful model therefore reads and parks.
2. **The probe is a keyhole.** `runProbe` (`src/healEdits.ts`) inserts ONE expression (no `;`, backtick or newline) as
   `console.log('PROBE', …)` into a copy of the TEST only, and returns only the `PROBE` lines. It cannot instrument app code, cannot
   time across `await`s, cannot change behaviour and show the outcome, and does not return the failure output.
3. **Coarse, slow feedback.** Every edit and every probe runs the whole 164-test file. There is no "run this one test".
4. **Append-only context.** The opening prompt is ~176k characters (whole test + sources). Every turn appends; nothing is ever
   summarised. Cost ≈ turns × context. (The overlap guard in `testHeal.ts` stops REPEATS; it does not stop growth.)
5. **A hand-maintained protocol.** Each capability needs a schema branch (`src/healSchema.ts`), prompt text, parser support and
   tests, and they drift: a schema written on 2026-11-20 silently made probing impossible.

What the JSON loop does WELL, and must keep doing: it is cheap, never loses progress (`giveUp` keeps it), has a per-test ratchet
(`regressions` in `src/healAuthority.ts`), an integrity check, and a ledger hand-off. **It stays as the fast path.**

## 3. What Claude Code (and similar agents) actually have, and how this spec gives the harness the same

| Capability that solved the file | Claude Code | Harness today | After this spec |
|---|---|---|---|
| Read only what you need, when you need it | `Read` with ranges | 176k pre-dumped prompt | `read_file` tool, short opening prompt (spec 03) |
| Search the code | `Grep`/`Glob` | `search` lookup | `search_code` tool (exists) |
| Edit freely, including throwaway edits | `Edit`/`Write` | edits = final verdict on the real file | `patch_file`/`write_file` inside a **disposable worktree** (spec 01) |
| Temporary logging in APP code | yes | impossible | yes, in the worktree; discarded on merge (spec 04) |
| Run ONE test, read the FULL output | `npx jest -t …` | whole file, PROBE lines only | `run_test(file, namePattern)` (spec 02) |
| Iterate edit → run → read → refine | native loop | one verdict at a time | native tool loop: `runToolAgent` (spec 03) |
| Stop when stuck | user / judgement | dry-round parking | budget + three state-based stagnation rules (spec 03) |
| Never break what already passes | user review | per-test ratchet | the SAME ratchet guards the merge (spec 04) |
| Guardrails | permission prompts | command review | `run_test` safety gate + secrets stripped from env (spec 02) |

Honest limit: this removes the structural handicap. It does not make the stronger model as capable as the model that solved the
file. The benchmark decides (spec 05 §5).

## 4. Architecture

```
healOneInner (src/testHeal.ts)
  first model, JSON loop (unchanged) ────────────────► "parked-out"
        │  opts.sandbox provided?           no ─► existing opts.escalate path (unchanged)
        ▼ yes
  for each parked cause, biggest first:
     src/healSandbox.ts
        createSandbox(repoRoot, file, testText)        spec 01
           git stash create → git worktree add --detach → copy untracked → node_modules junction → preflight
        runSandboxAgent(...)                           spec 03
           runToolAgent(tools: read_file, search_code, get_file_outline, list_files,
                               patch_file, write_file, run_test, conclude_task)
           stopWhen: conclude | $ budget | stagnation (3 rules)
           run_test → safety gate → runner without a shell (spec 02)
        collect candidate = the worktree's copy of the test file only
        destroySandbox()  (junction removed FIRST, then git worktree remove)   spec 01
     mergeCandidate(...)                               spec 04
        beginTrial → write → run whole file in the REAL repo → regressions/madeWorse/testsPassing → keep or restore → endTrial
        update last/current/ledger; un-park causes whose count dropped
        ▼
  existing finalisation (code-bug partial / giveUp), unchanged
```

## 5. Principles every spec obeys (the user's rules)

- **Do not handicap the model.** Inside the sandbox it may read anything in the repo, edit anything, add logging to app code, write
  scratch test files, run tests as often as it likes. No round cap.
- **The only guardrails:** leaking secrets, running arbitrary executables / dangerous code, working outside the repo, deleting
  many files. These are enforced by the worktree boundary, the tool set, the `run_test` safety gate and the env scrub (spec 02).
- **No arbitrary caps.** Stopping is by state (no new information) or by a dollar budget the USER sets in config. Never a time or
  round count chosen by us.
- **Never lose progress, never go backwards.** Only the test file comes back, and only through the per-test ratchet.
- **Never wait on a human inside the sandbox.** Anything that would need a person is refused to the agent instead (it can park).
- **Product code in the real repo is never changed by the heal.** App edits made in the sandbox are evidence, reported, discarded.

## 6. Files

New: `src/healSandbox.ts`, `src/sandboxRunTest.ts`, tests `test/healSandbox*.test.ts`.
Changed: `src/testHeal.ts`, `src/agentLoop.ts`, `src/agentTools.ts`, `src/testRun.ts` (or a sibling), `src/config.ts`,
`src/settings.ts`, `src/index.ts`, `src/verifierTools.ts`, `scripts/bench-heal.mjs`.
Do NOT change: `src/healSchema.ts`, the JSON prompt rules, `src/healAuthority.ts` ratchet semantics (only call them).

## 7. Commit order

1. spec 01 — sandbox lifecycle (worktree, untracked copy, junction, preflight, cleanup, stale prune) + tests
2. spec 02 — `run_test`: shell-free runner, name filter, safety gate, env scrub + tests
3. spec 03 — sandbox agent: `stopWhen`, tool subset, prompt, stagnation, budget + tests (fake model)
4. spec 04 — merge through the ratchet, wiring into `healOneInner` + tests
5. spec 05 — config, CLI/phase-gate/benchmark wiring, report lines + tests; then ONE benchmark run by the user
6. spec 06 — (independent, any time) credits wait: every 4 minutes, indefinitely

## 8. Definition of done

- All new tests pass; full suite green; `tsc` clean.
- No benchmark run is started by the implementer. The user runs it from their own terminal (background runs here get killed for
  memory). Acceptance criteria are in spec 05 §5.
