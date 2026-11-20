# Spec 03 — From one sentence to a roadmap: intake, questionnaire, design, dependencies

Goal: "I want to build an app that tracks my fridge inventory" (with or without an attached brief) gets a thorough questionnaire written for a non-technical
person, with follow-ups, then a roadmap of small tickets; the look of the app is settled (UI questions → design system) before UI tickets build screens;
"change the font to Impact" on an existing app stays one ticket with no questionnaire; and every new third-party package is checked against its real registry
and reviewed by a security model (not the model that chose it) before anything installs it.

## 1. What exists today (this is mostly a deepening, not a new system)

- **Routing**: `src/routeIntent.ts` + `INTENT_SYSTEM` (`src/prompts.ts:929`). `program` = a whole product, app, site or system from an idea, a port, or a
  long list of features (`prompts.ts:996`); `task` = one feature, screen, bug or refactor ("When unsure between task and program, choose task"); `roadmap` =
  talking about an existing roadmap. The decision is the model's, from meaning, not phrases.
- **Program → roadmap**: `index.ts:~4910-4935`: the request's named files and attachments become `docs` (`renderUserDocuments(userNamedFiles(...),
  turnDocuments)`), then `createRoadmap(roadmapDeps(), { goal, referenceDir, docs })` (`src/roadmapFlow.ts:94`).
- **Questions**: `synthesizeIdea` (`src/roadmapPlan.ts:300`, prompt `ideaMessages` at :103) returns **at most 5** questions ("that only the USER can answer",
  2-4 options each). `settleQuestions` (`roadmapFlow.ts:72`): in `essential` mode (default, `config.planning.questions`) only questions matching
  `looksEssential` (`planner.ts:177`, a regex) are asked, the rest decided as `options[0]`; `askAll` asks at most 5. Then the plan is redone with the answers.
- **Design**: `ensureDesignSystem` (`index.ts:~6128`, when `config.uiDesign.enabled`) builds `design-system/` for a UI request before planning, from
  assumptions — it asks the user nothing. `runDesign` (`src/designer.ts:700`) is for logos/brand marks (the `design` route), `gatherBrief` "never asks".
- **Dependencies**: `src/dependencyFacts.ts` (`lookupPackage`: npm, PyPI, crates, Maven, NuGet, Go via registries and deps.dev; OSV vulnerabilities);
  `request_dependency` tool gives the Editor registry facts; `run_dependency_install` asks a PERSON to approve the install plan (`agentTools.ts`
  `runDependencyInstall` → `askFn(question, "no")`), with no security-model review in between.

## 2. Part A — the questionnaire, for a new product

### 2.1 When
`createRoadmap` for a `program` request with no reference folder (an idea, `kind: "idea"`), and the project is new or nearly empty (VERIFY a helper exists:
e.g. count of source files by `isSourceCodePath`; ≤ 10 source files = greenfield). An existing app getting a big feature list keeps today's 5 questions.
`planning.questions: "autonomous"` skips asking entirely (every question decided and recorded, as today).

### 2.2 What: a questionnaire, not five questions
New `src/intake.ts`:
- `questionnaireMessages(goal, docs)` → a model call that returns sections of questions for a person who is not technical. Sections (a section is skipped
  when the request or the brief already answers it, and then its answers are stated as assumptions to confirm):
  1. What it is for and who uses it (just you, family, a team, the public); 2. Where it runs (phone: iPhone/Android, web, desktop); 3. The core things it
  tracks (for a fridge: items, quantities, expiry dates, photos, barcodes) and the main things people do (add, use up, search, shopping list);
  4. Accounts and sharing (sign-in? shared between people?); 5. Data: where it lives (on the device, the cloud), offline use, import/export;
  6. Notifications (expiry reminders?); 7. Money (free, paid, subscriptions); 8. Look and feel (see §3); 9. Must-have now versus later;
  10. Things that must never happen (losing data, sharing private info) — the edge cases, phrased as situations ("what should happen if…").
- Each question: plain words, 2-5 options with one marked recommended, `allowCustom: true`, and a one-line "why this matters" a non-technical person
  understands. The existing plain-language explainer (`setQuestionExplainer`, `control.ts:247`) still applies.
- **Brief review**: when `docs` is present, the questionnaire model also returns "what the brief already settles" (shown back to the person as a summary
  to confirm in ONE question: "Here is what I understood from your brief: … Anything wrong?") and asks only about gaps and contradictions in it.
- **Follow-ups**: after the first round, one more model call with the answers returns follow-up questions only where an answer opened something
  (e.g. "shared with family" → "can everyone edit, or only you?"). At most two rounds; each round's questions are asked together.
- **Asking**: through `askChoice`/`askAnywhere` (so spec 01's deadline applies: an unanswered question takes the recommended option and is recorded as an
  assumption). Answers become roadmap conventions (`answersAsConventions`, `roadmapPlan.ts:354`) and go into `synthesizeIdea` as today.
- No cap on the number of questions beyond "only what changes the plan": the model is told to ask everything that does, and nothing that does not. Each
  section is one screen; the person can answer "decide for me" to any section (recorded as an assumption).

### 2.3 Small changes stay small
Nothing changes for `task`: a request like "change the font to Impact" is routed to `task` by the existing router and planned as one phase; the
Planner's own question policy applies (`essential`: nothing worth asking, so nothing is asked). Add a router test case (fake model reply) only to pin the
dispatch: `task` never calls the questionnaire. VERIFY that a one-file change yields a one-phase plan; if the Planner splits trivially small work, that is
a Planner prompt fix, not a new route.

## 3. Part B — the look of the app, before UI tickets

- **UI questions**: section 8 of the questionnaire asks the person for the feel (calm/playful/bold…, light/dark/both, any colours or apps they like, any
  logo or brand they have). Answers are written to `design-system/BRIEF.md` (new) for `ensureDesignSystem`.
- `ensureDesignSystem` (VERIFY its signature in `src/uiDesign.ts`) reads `design-system/BRIEF.md` when present and builds from it instead of assumptions.
- **Order**: the roadmap gets a first unit "Design system" (area "Design", acceptance: tokens and components exist, the brief is followed) and every unit that
  builds screens depends on it (`deps`). Non-UI units (data model, storage, API) do not depend on it, so they can be built while the design is made — this is
  "in parallel" within today's one-worker-at-a-time loop: the order lets non-UI work go first. True parallel workers are a later spec.
- **Designer tickets**: when the design system is made, the designer's own follow-ups (icon set, empty states, app icon via the `design` route) become units
  in area "Design" through `addUnits` — not free text.

## 4. Part C — every new package: registry facts, then a security model, then (only if flagged) a person

### 4.1 At planning time
When `synthesizeIdea` (or the Planner) names libraries in `conventions` (e.g. "use expo-sqlite", "zustand for state"), run `lookupPackage` for each named
package before the roadmap is saved. A package that does not exist, is deprecated, has no release in 2 years, or has a known critical vulnerability is
reported, and the planner is asked once for an alternative. The facts are written into the conventions ("expo-sqlite 15.x, MIT, maintained").

### 4.2 At install time: replace "ask a person" with "ask the security model, then a person only if it is flagged"
In `runDependencyInstall` (`agentTools.ts`), before `approve(planSummary)` asks a person:
1. For every package in the install plan, `lookupPackage` facts are already cleared through `request_dependency` (`markCleared`) — VERIFY; require them.
   A package with no facts, a lookup error, or a name that looks like a typosquat of a popular package (edit distance 1-2 from a top package in that
   ecosystem; ship a small list of the top ~200 npm/PyPI names) is flagged.
2. Send the plan, the facts and the flags to the **security model chain** (`securityModels(config.models)`, a different model from the Editor's), as a
   review like `makeCommandReviewer` does for commands: it answers allow / ask-a-person with a reason.
3. Allow → install without asking (logged: "install approved by the security reviewer: …").
   Ask-a-person → `approve()` as today, which (spec 01) is an `approval` question: DENY on timeout.
4. Never auto-allow a package the registry does not know, a typosquat flag, a critical vulnerability, or an install script from a package with < 1,000
   weekly downloads (npm facts: VERIFY the field) — those always go to a person.

## 5. Tickets are Jira-shaped and carry the QA contract

`ideaMessages`/`UNIT_RULES` (`roadmapPlan.ts`) — VERIFY `UNIT_RULES` — are extended so each unit has: a title, a summary written as a user story where it
fits, 2-6 acceptance criteria that a test or QA can check, the reference files (`refs`), and, for anything behind sign-in or a real service, an acceptance
line naming the QA way in (spec 02 §3). Unit size: one Editor pass — a unit that would change more than ~10 files or several screens is split (the rule is
stated to the model; `addUnits` already caps a roadmap at 500 units).

## 6. Tests

`test/intake.test.ts` (fake model, fake ask):
1. a `program` idea in an empty repo runs the questionnaire: sections are asked in order, "decide for me" is recorded as an assumption, answers reach
   `synthesizeIdea` (spy) as conventions.
2. with an attached brief: the summary-to-confirm question comes first; a section the brief settles is not asked; a contradiction in the brief is asked.
3. follow-ups: an answer that opens something produces a second round; at most two rounds.
4. `planning.questions: "autonomous"` → nothing asked, everything recorded.
5. a `task` request never calls the questionnaire (router reply faked as `task`).
6. an existing app (> 10 source files) getting a `program` keeps the 5-question path.
7. the look-and-feel answers are written to `design-system/BRIEF.md`; the roadmap's screen units depend on the "Design system" unit; non-UI units do not.
`test/dependencyGate.test.ts` (fake fetch, fake security reviewer):
8. a known package with facts → security reviewer allows → installed without a person (spy: `askFn` not called).
9. reviewer says ask → `askFn` called with `kind: approval` (and spec 01: DENY on timeout).
10. unknown package / typosquat (`expresss`) / critical vulnerability → a person is always asked, whatever the reviewer says.
11. planning-time check: a library named in conventions that the registry does not know is reported and replaced once.

## 7. Out of scope
Parallel workers; a UI for answering the questionnaire beyond the terminal and the phone's existing question cards.
