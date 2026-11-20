# Autonomy specs: fewer stops, fewer broken tests, one sentence to start

Status: SPEC, not built. Written 2026-11-20 against branch `heal-sandbox` at `957ce61`. Implement on a new branch `autonomy` (from `heal-sandbox`
once it is merged, or from `heal-sandbox` itself), one commit per spec, the full suite green after each (`node scripts/test.mjs`, `npx tsc --noEmit`).

Every file, function and line number below was read on 2026-11-20. Where a spec says **VERIFY**, check the code before relying on the sentence.
Build onto what exists: most of the machinery is already here, and each spec says what to reuse.

## The goal (the user's words, condensed)

A non-technical person types "I want to build an app that tracks my fridge inventory" (optionally with a brief or spec file) and YIMPIM runs on its own:
a thorough questionnaire in plain language, a roadmap of small Jira-like tickets, one worker at a time, the Editor keeping tests current, QA (and the visual
verifier) checking each ticket, security reviewing what is finished, until it is done. "Change the font to Impact" on an existing app is one ticket and no
questionnaire. The only guardrails: leaking secrets, running arbitrary executables, working outside the repo, mass deletion. A person is asked when it
matters, never waited on for more than 30 minutes. Cost control is the limit on the user's own OpenRouter key.

## What already exists (do not rebuild)

| Need | Already there |
|---|---|
| Route a request | `src/routeIntent.ts` + `INTENT_SYSTEM` (`src/prompts.ts:929`): 13 routes incl. `task`, `program` (whole product), `roadmap`, `design` |
| Roadmap of units | `src/roadmap.ts` (`RoadmapUnit`: deps, refs, acceptance), `src/roadmapFlow.ts` (`createRoadmap`, `settleQuestions`), `src/roadmapPlan.ts` |
| Questions with defaults | `PendingQuestion` (`src/remote/protocol.ts:164`) has `fallback` ("applied if nobody answers") and `kind`; `askAnywhere` (`src/remote/control.ts:255`) is the funnel |
| Unattended sign-offs | `interaction.autonomous` (default true): visual advisories and deferred decisions auto-accept and log to `QA_REVIEW.md` |
| Plan questions policy | `planning.questions`: `essential` (default) / `autonomous` / `all`; `looksEssential` (`src/planner.ts:177`) |
| Tests a change reaches | `selectTests` (`src/testGraph.ts:175`) + `staleSince`; run by the verifier at QA time (`src/verifierTools.ts:~2600`) |
| Tests naming removed things | `find_test_references` tool + `unseenTestReferences()` (`src/agentTools.ts:2011`), sent back at `FINISHED_PATCHING` (`src/agentLoop.ts:~690`) |
| QA access to gated screens (web) | `register_qa_setup` tool → `.agent/qa-setup.json` (`src/qaSetup.ts`): launch path, localStorage, fake camera, upload files |
| Test repair | the heal (`src/testHeal.ts`) with the sandbox (`src/healSandbox.ts`) and the deviation policy (`src/healDeviation.ts`) |
| Design system first | `ensureDesignSystem` (`src/index.ts:~6128`, `config.uiDesign.enabled`) |
| Dependency facts | `src/dependencyFacts.ts`: npm, PyPI, deps.dev, OSV; `request_dependency` tool; `run_dependency_install` |

## The three specs, in build order

1. `01-question-deadlines.md` — no question waits forever: a deadline (30 min default) on every question, the stated default taken and recorded as an
   assumption; security and destructive approvals default to DENY. Removes the overnight stall.
2. `02-editor-test-stewardship.md` — the Editor runs the tests its change reaches and fixes them in the same ticket, before QA; anything left goes to the
   sandbox heal; the ticket contract includes QA access hooks (mock data, dev toggles, deep links). Prevents the pile-up of broken tests.
3. `03-intake-and-greenfield.md` — a new product gets a deep questionnaire for a non-technical person (with follow-ups, and a review of any attached
   brief), then a roadmap; the UI questionnaire feeds the design system before UI tickets; small changes stay one ticket; every new third-party package is
   verified against its registry and reviewed by a security model before it is installed.

Specs 4 (automatic security gate before push) and 5 (QA BLOCKER vs PASS_WITH_LOW_CONFIDENCE policy, building on the deviation tickets) are written after
1-3 are built, so they rest on the code as it will be.

## Rules for the implementer

- Build onto the existing functions named above; do not add a second router, a second roadmap, a second question path.
- Never weaken a guardrail to remove a stop: a stop that protects the machine becomes a DENY on timeout, never an ALLOW.
- No arbitrary caps (rounds, time) except the user's own settings; the question deadline IS a user setting (`interaction.answerTimeoutMinutes`).
- Use the Edit/Write tools for code: shell heredocs and `node -e` in this environment mangle backslashes in regexes.
- Do not run benchmarks or real model calls; tests use fakes.
