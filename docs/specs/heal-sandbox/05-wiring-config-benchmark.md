# Spec 05 — Wiring, configuration, report, benchmark, acceptance

## 1. Configuration (`src/config.ts` schema + `src/settings.ts` key list)

```yaml
heal:
  sandbox:
    enabled: true          # false = today's behaviour (JSON strong pass via escalate)
    budgetUsd: 0.75        # per parked cause; the USER's number. 0 = no dollar stop (stagnation rules only)
    stagnation: 3          # rules in spec 03 §4 (reading-only uses 2× this)
```

Add the three keys to the settings list in `src/settings.ts` (group "Cost and loop control"), with descriptions written for a
non-technical user, e.g. budgetUsd: "Most you will spend on the stronger model for one stubborn group of failing tests. When it is
reached, that group is reported for a person and the run goes on." Env overrides follow the existing `YIMPIM_*` mapping.

## 2. Call sites — the same construction in all three

The stronger chain is every repair model after the first: `models = config.models.repair ?? config.models.editor`, `models.slice(1)`.
If it is empty, the sandbox is not created (nothing stronger to hand to) and today's behaviour applies.

| Site | Today | Change |
|---|---|---|
| `src/index.ts` `/tests heal` (escalate built ~line 5150) | `escalate: healModels.length > 1 ? … : undefined` | if `config.heal.sandbox.enabled && healModels.length > 1`: `sandbox: createSandboxRun({ client, config, models: healModels.slice(1), budgetUsd, stagnation, run: runSuiteLogged, securityCall, log })` and `escalate: undefined`; else unchanged |
| `src/verifierTools.ts` phase gate (escalate built ~line 2683) | same | same rule |
| `scripts/bench-heal.mjs` | `escalate` with tracing | same rule; `--no-sandbox` restores escalate; `--no-escalate` disables both |

`securityCall`: reuse exactly what `src/index.ts` passes to `makeCommandReviewer` (~line 4745). In `verifierTools.ts` and the
bench, build it the same way from `config.models.security` (VERIFY the config key name used at that call site).

## 3. Benchmark additions (`scripts/bench-heal.mjs`)

Per run, record in the results JSON (`yimpim-bench/results/run-*.json`):
- `sandbox: [{ cause, stop, runs, rounds, cost, kept, gain, broke, appFilesTouched, conclusion }]` — wrap the `SandboxRun`
  passed to `healTests` to capture each result.
- `sandboxCost` total; `firstModelCost` = total cost − sandboxCost.
- `worktreesLeft`: after the run, `git -C <bench repo> worktree list --porcelain` entries under `yimpim-heal` (must be 0).
- `nodeModulesIntact`: the bench repo's `node_modules/jest/bin/jest.js` still exists (must be true).
Print one line per sandbox cause in the run summary, and totals in the multi-run summary.
`run --check` (wiring check) additionally calls `createSandbox` + preflight + `destroySandbox` on the fixture with a no-op agent,
and reports `sandbox preflight: ok` or the reason. Costs nothing.

## 4. The heal report

No format change beyond the note lines in spec 04 §5. The `/tests heal` console gets the per-cause log line from spec 04 §3.

## 5. Acceptance — the user runs this, from their own terminal

Before: `npm run build`, confirm `dist/` newer than `src/`, then `node scripts/bench-heal.mjs run --check` → sandbox preflight ok.

Then: `node scripts/bench-heal.mjs run --runs 1 --yes`. Read the result:

| Check | Pass |
|---|---|
| integrity | OK (no deleted/skipped tests, assertions ≥ 95%, product code untouched) |
| worktreesLeft / nodeModulesIntact | 0 / true |
| sandbox causes | each has a `stop` reason; cost per cause ≤ budgetUsd + one call |
| score | > 154 is progress; 164 is the goal |
| behaviour | the sandbox used `run_test` with a `namePattern` and edited between runs (it experimented) |

If the first run shows progress, run `--runs 3` and judge the median. If the sandbox spends its budget reading or stops on
stagnation every time, look at its transcript (the bench should save each sandbox's tool-call list to
`results/sandbox-<run>-<n>.json`: name, args summary, result size, fingerprint) before changing anything.

## 6. Rollback

`heal.sandbox.enabled: false` restores today's behaviour without a code change.

## 7. Tests (`test/healSandbox.wiring.test.ts`)

1. config defaults present and documented in settings.
2. source checks (as `test/healAuthority.test.ts` does for escalate): `src/index.ts`, `src/verifierTools.ts`,
   `scripts/bench-heal.mjs` construct `createSandboxRun` with `slice(1)` and leave `escalate` undefined when it is enabled.
3. `enabled: false` → `escalate` is built as today.
4. a single-model repair chain → neither sandbox nor escalate.
