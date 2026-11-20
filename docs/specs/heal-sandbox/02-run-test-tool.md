# Spec 02 — `run_test`: run one test, read the whole result, safely

Goal: the sandbox agent can run one test (or one file) in seconds and read the full output, exactly like `npx jest file -t "name"`
in Claude Code, without any way to run a command it made up, and without leaking secrets.

New module: `src/sandboxRunTest.ts`. Tool definition in `src/agentTools.ts`; dispatch in `src/agentLoop.ts`.

## 1. Why not reuse `runSuite` as is (a real hole)

`runSuite` (`src/testRun.ts`) runs `focusedTestCommand` (`src/focusTests.ts`) = `npm.cmd run test -- <files>` with
`shell: process.platform === "win32"`. With `shell: true`, Node joins the arguments with spaces and hands the string to `cmd.exe`
**without quoting**. A model-supplied `namePattern` such as `x & del /s /q C:\` would run. A pattern with a space would be split.
So `run_test` must start the test runner **directly with `node`, no shell, args as an array**.

## 2. Runner resolution (shell-free), `resolveDirectRunner(root)`

Return `{ bin: process.execPath, args: string[], kind: "jest" | "vitest" } | undefined`:

1. Jest: `require.resolve("jest/bin/jest.js", { paths: [root] })` (use `createRequire(path.join(root, "package.json"))`).
   Args: `[jestBin, "--ci", "--colors=false", ...configArgs, file, ...(namePattern ? ["-t", namePattern] : [])]`.
   `configArgs`: if `package.json` `scripts.test` contains `--config <x>` or `-c <x>`, pass the same; otherwise none (Jest finds
   `jest.config.*` / `package.json#jest` itself).
2. Vitest: `require.resolve("vitest/vitest.mjs", { paths: [root] })`. Args: `[vitestBin, "run", file, ...(namePattern ? ["-t", namePattern] : [])]`.
3. Neither found → `undefined`: `run_test` falls back to the heal's own `run(root, [file])` (whole file, no name filter) and says
   so in its output ("this project's runner could not be started directly; the whole file was run").
   VERIFY on the Expo repo: Jest resolves (`node_modules/jest/bin/jest.js` exists through the junction).

`execFile(bin, args, { cwd: root, shell: false, timeout: 600_000, maxBuffer: 64 MB, env: scrubbedEnv() })`.

## 3. `scrubbedEnv()` — no secrets reach test code

Start from `process.env`; delete every variable whose NAME matches
`/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i`, plus `OPENROUTER_*`, `YIMPIM_*`, `GITHUB_*`,
`NPM_TOKEN`, `AWS_*`, `GOOGLE_*`, `AZURE_*`. Then set `CI=true`, `FORCE_COLOR=0`, `NO_COLOR=1`. Keep `PATH`, `HOME`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `SystemRoot`, `ComSpec`, `NODE_OPTIONS` (if set by the user).
Tests: a variable `OPENROUTER_API_KEY=x` is absent in the child; `PATH` present.

## 4. The tool

Definition (added to `TOOLS_SCHEMA` in `src/agentTools.ts`, but only ever given to the sandbox agent — spec 03 §2):

```json
{ "type": "function", "function": {
  "name": "run_test",
  "description": "Run a test file in the sandbox, optionally only the tests whose name matches namePattern (a regular expression, as jest -t / vitest -t). Returns the runner's full output. Use it to check a hypothesis: add console.log anywhere (test or app code), change a wait, run, read. Nothing you change here reaches the real project except the test file, and only if it makes more tests pass without breaking any.",
  "parameters": { "type": "object",
    "properties": {
      "file": { "type": "string", "description": "Repo-relative test file, e.g. __tests__/dashboard.test.ts" },
      "namePattern": { "type": "string", "description": "Optional. Only tests whose full name matches. Example: \"derives Send/Stop\"" } },
    "required": ["file"] } } }
```

Handler `AgentTools.runTest(args)` → delegates to `sandboxRunTest(sandbox, args, gate)` (the sandbox is bound when the sandbox's
`AgentTools` instance is created; regular agents never get the tool, and calling it without a sandbox returns
`"run_test is only available in a heal sandbox"`).

Validation, in order, each failing case returning a one-line refusal string (never throwing):
- `file`: normalise `\` → `/`, strip `./`; must pass `SAFE`, `isTestPath` (from `src/healEdits.ts` imports), must exist under
  `sandbox.root`, and `path.resolve(root, file)` must start with `root + path.sep`.
- `namePattern`: optional; string; length ≤ 200; no NUL, `\r`, `\n`. It goes to the runner as ONE argv element, so no other
  escaping is needed (no shell).

Output shaping (what the model reads):
- Strip ANSI. Prepend `--- run_test <file>${namePattern ? ` -t "${namePattern}"` : ""} (${seconds}s)`.
- If ≤ 24,000 chars → whole output. Else first 6,000 + `\n… (N lines cut) …\n` + last 16,000 (Jest puts the failures and the
  summary at the end; console.log output appears near each test).
- Always end with the `Tests:` summary line if present, and `PROBE`-style lines are not special: all console output is kept.

## 5. The safety gate (the "running executables" guardrail)

`run_test` executes code the agent may have just written (a test that calls `child_process`, deletes files, posts a token). That
is arbitrary code execution on the user's machine. Gate every run:

1. **What changed since the last approved run.** Keep, per sandbox, `approved: Map<relPath, sha256>`. Before a run, list changed
   files: `git -C root status --porcelain -z` (modified + untracked; ignore the junction dirs) and hash each; the set to review is
   every file whose hash is not in `approved`.
2. **Deterministic screen.** For each such file, `dangerIn(text)` (`src/commandReview.ts`) and `auditText(file, text)`
   (`src/securityLint.ts`). Additionally flag, in ADDED lines only (diff against the snapshot `base`):
   `child_process`, `execSync|spawn|fork|exec\(`, `process\.kill`, `fs\.(rm|rmdir|unlink)(Sync)?\(` with a path not under the
   project, `fetch\(|http\.request|https\.request|net\.connect|dgram|WebSocket\(` to a non-localhost host, `process\.env` reads,
   `eval\(|new Function\(`, dynamic `require\(` / `import\(` of a non-literal.
   - `dangerIn` hit (prompt injection, destructive command text) → **refuse** the run: return
     `"run_test refused: <why>. Remove that code; the sandbox does not run it."` Do NOT ask a human (sandbox rule).
3. **Model review when the screen flags something but `dangerIn` did not.** Build a `ReviewRequest` (`src/commandReview.ts`):
   `{ argv: [bin, ...args], label: "run_test <file>", purpose: "heal sandbox experiment", cwd: root, repoRoot: root, created: <changed files> }`
   and call the reviewer from `makeCommandReviewer(call)`. `call` is the SECURITY model chain (the same one `src/index.ts` uses at
   line ~4745; prefer a model different from the sandbox agent's). `allow` → run and add the files to `approved`; not allowed →
   refuse with `why`.
4. **Nothing flagged** → run, add hashes to `approved`.
5. Every refusal is counted by the stagnation logic as a no-progress round (spec 03 §4).

Budget: review calls are charged to the same per-cause budget (they go through `events`, so `usageDelta` sees them).

## 6. Dispatch in `src/agentLoop.ts`

Add next to the `run_project_command` branch (~line 860):

```ts
} else if (name === "run_test") {
  // Neither an inspection nor an edit for the ReadTracker: it is a measurement.
  console.log(`[${displayName}] 🧪 run_test ${String(args.file ?? "")}${args.namePattern ? ` -t "${String(args.namePattern).slice(0, 60)}"` : ""}`);
  toolOutput = await agentTools.runTest(args);
}
```

VERIFY how `ReadTracker` classifies unknown tool names (comment at agentLoop.ts ~89 and ~576): `run_test` must not count as a read
(it would trigger analysis-paralysis nudges) nor as a mutation.

## 7. Tests (`test/sandboxRunTest.test.ts`)

1. resolver: a temp dir with `node_modules/jest/bin/jest.js` (a stub script that prints its argv as JSON) → argv contains the file
   and `-t`, `<pattern>` as two separate elements; `shell` is false (assert via an injected `execFile`).
2. a pattern containing `& del /s /q C:\ "quoted" $HOME` reaches the stub as exactly one argv element, unchanged.
3. env scrub: stub prints `process.env`; no `*_KEY`/`*_TOKEN`; `CI=true`.
4. validation refusals: path outside the sandbox (`../x.test.ts`), non-test file (`src/app.ts`), missing file, pattern with `\n`.
5. output shaping: 100k-char output → head + "lines cut" + tail, summary line last.
6. gate: a changed file containing `require('child_process').execSync('rm -rf /')` → refused without calling the reviewer
   (spy); a changed file with `fetch('https://evil.example')` → reviewer called with that file in `created`; reviewer says no →
   refused; says yes → runs, and an unchanged second run does not call the reviewer again.
7. no-sandbox `AgentTools` → `run_test is only available in a heal sandbox`.
