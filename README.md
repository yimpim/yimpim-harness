# OpenRouter Code Agent v0.2 — Production-Safe Foundation

This is a local, resumable, phase-based coding agent for Android and other Git repositories.

## Architecture

User -> Discovery -> <=4 clarification questions -> Planner -> one Editor phase -> Build/Test -> independent Verifier -> Git commit -> next phase.

The local orchestrator owns the filesystem, Git, recovery state, tool permissions and phase state. Models only request tools.

## Verification model

Verification is capability-graded. The verifier probes what the machine actually
has, runs every gate it can, and **degrades to static code review instead of
failing** when a tool is missing.

**Core rule: only positive evidence of a defect fails a run.** A missing
emulator, absent browser, headless server, uninstalled toolkit or offline model
lowers the reported *confidence* — it never produces a failure.

Three tiers, run in order:

| Tier | What it does | Blocking? |
|---|---|---|
| 1. Build | Compiles/typechecks (gradle, npm script, `python -m compileall`, discovered test commands) | Yes — only if it actually runs and fails |
| 2. Runtime + visual | Launches the app and screenshots it | Crash/uncaught error blocks; visual flaws are advisories |
| 3. Static QA | Reads the full change set and audits it against the requirements | Yes — only on a requirement proven unmet |

Supported visual surfaces, all auto-detected:

- **Android** — installs the APK to an attached emulator/device, launches via
  `monkey`, screenshots with `adb exec-out screencap`, and reads the crash
  buffer. A fatal trace counts only when attributed to *this* package.
- **Web** — spawns the dev script and learns the URL *from the server's own
  output* rather than guessing ports, then captures with Playwright and records
  uncaught page/console errors.
- **Python web** — Streamlit, Gradio, Flask, FastAPI, Django, Dash; same
  browser capture path.
- **Python desktop GUI** — PySide/PyQt/Tk/Kivy/wx; launches the app and takes a
  native screen capture (PowerShell GDI, `screencapture`, or scrot/import).
- **CLI / library** — no UI surface; build + static review only.

Every run reports a confidence level:

- `verified` — the app was launched and observed running.
- `partial` — it compiled, but was never observed running.
- `static-only` — nothing could be executed; the verdict rests on source review.

The verifier is a **QA specialist, not an engineer**. It never edits code, and
its prompts never solicit patches or design opinions. Its static reviewer is
explicitly instructed that "I could not confirm this" is `uncertain`, not a
failure — absence of proof is never treated as proof of absence.

## Project portability

Nothing is hardcoded to a single app. Per repository the harness derives:

- the Android application module (any name, not just `app`), its `applicationId`
  (falling back to `namespace`, then the manifest), the gradle assemble task,
  and the newest APK across all flavors/variants;
- the Node package manager, dev/build scripts and dev-server URL;
- the Python framework and its launch command;
- test commands (`npm test`, `pytest`, `cargo test`, `go test`).

`agent.config.yaml` is entirely optional — every section has defaults, so the
harness runs against a bare repository with no config file. A `verification:`
block exists to override detection when it guesses wrong.

## Safety properties

- Editor writes are confined to the target repo, with separator-aware
  containment, and blocked directories (`.git`, `node_modules`, build output,
  `.agent`) are enforced on every read and write.
- `patch_file` rejects ambiguous multi-match targets and applies replacements
  literally, so `$&`/`$1` in replacement text cannot corrupt a file.
- `search_code` builds argv arrays only; a model-supplied pattern is never
  interpolated into a shell string.
- The verifier has no shell-command tool. It runs only commands derived from
  project detection, via `execFile` with argv arrays.
- On phase failure only the **agent's own** changes are undone. Pre-existing
  uncommitted work is left untouched, and agent-created files are quarantined
  into `.agent/rejected/<timestamp>/` rather than deleted.
- Commits are scoped to files the agent actually touched; pre-existing dirty
  files are never swept into an agent commit.
- Sensitive files (keystores, certificates, `.env`, private keys) are blocked.

## Phased execution

The planner emits an ordered list of phases as structured JSON. Each phase is
implemented and verified independently, and committed only once it passes, so a
late failure never invalidates earlier work.

- Each phase must leave the project compilable on its own.
- The editor is told explicitly which later phases *not* to implement.
- The verifier checks that phase's own acceptance criteria, not the whole feature.
- `PROGRESS.md` is rewritten after every phase with a live checklist.
- `--resume` skips completed phases and retries from the failure point.

If the planner returns prose instead of JSON, the run degrades to a single phase
containing the whole task rather than failing.

## Concurrency

One run per repository, enforced by `.agent/run.lock`. The lock is self-healing,
so a crash or Ctrl-C never locks you out:

- clean exit, Ctrl-C or SIGTERM releases it directly;
- a hard kill leaves a lock whose PID is dead, detected on the next run — on
  Windows via `tasklist`, because `process.kill(pid, 0)` reports
  recently-exited PIDs as still alive there;
- anything else ages out once its 15s heartbeat is 60s stale.

`--force-unlock` overrides a lock that is genuinely still held.

## Settings

Settings resolve lowest to highest: **built-in defaults → `agent.config.yaml` →
`YIMPIM_*` env vars → `--set key=value`**. A config file is entirely optional.

```bash
yimpim doctor                                  # readiness + cost exposure
yimpim init                                    # commented starter config
yimpim config list --common                    # the settings most people change
yimpim config set limits.maxRepairAttemptsPerPhase 3
yimpim --set models.editor=some/model "task"   # one-run override
```

All settings live in one registry in `src/settings.ts`; adding an entry there
surfaces it in `config list`, `init`, validation and help at once.

## Remote control (phone)

Remote control is part of YIMPIM Pro. Link this machine once with `/link` (or `yimpim link`), then type
`/remote-control` in any session:

```
yimpim > /remote-control

[REMOTE] Pro lease found — connecting to the YIMPIM cloud tunnel…
[REMOTE] Relay ready: https://… — hosted by YIMPIM Pro, nothing to install or keep running

📱 REMOTE CONTROL — scan to pair ONE device
   [QR code]
```

No URL to obtain, no config to set, no ports to open. An expired lease is renewed once on its own; a machine that is not
linked yet is offered the link flow on the spot.

### Why this does not expose your machine

- **No inbound ports, ever.** The agent registers with the broker over outbound
  HTTPS, pushes events, and long-polls for commands. There is no socket to scan
  and no firewall rule to add. Same shape Claude Code uses.
- **The broker never sees your data.** Events and commands are AES-256-GCM
  sealed. The session key is generated on the desktop and reaches the phone only
  inside the QR code, in the URL *fragment* — which browsers never send to a
  server. A fully compromised broker sees ciphertext and routing metadata only.
- **Commands are authenticated with the same key**, so the broker cannot forge
  one. Anything that fails to decrypt is discarded and logged.
- **AAD binds each message to its session id and sequence number**, so ciphertext
  cannot be replayed at a different position or moved between sessions.

### Pairing

- 256-bit single-use secret, ~2 minute TTL.
- **One wrong guess burns the code** — you re-pair from the desktop. Brute force
  gets exactly one attempt.
- Exactly one device may pair per session. A second attempt is refused.
- The session dies with the run. There is no daemon.

### What the phone may do

| Verb | Default | Notes |
|---|---|---|
| watch / status | on | Phases, verdicts, token usage |
| **stop** | on | Always permitted — stopping is never harmful |
| answer a question | on | Only questions the *agent* asked |
| start a run | **off** | `--remote-allow-start`; repo chosen by index from a local list, never a path |

Anything not in that list is impossible by construction, not by permission check.

### Stopping is cooperative

A remote stop sets a flag checked between tool rounds and between phases — it
never kills mid-write. Completed phases stay committed, the in-flight phase is
unwound by the normal scoped revert, and `yimpim --resume` picks up where it left
off. Exit code is 130.

### Log redaction

`remote.redactLogs` defaults to **true**. Log events mirror console output, and
compiler errors quote your source, so they are dropped before leaving the machine.
Phase, verdict and status events are metadata-only.

## Not yet wired

These modules exist but are **not** used by the pipeline: `state.ts` (atomic run
state + event journal), `recovery.ts` (dirty-tree policy), `worktree.ts`
(isolated worktree runs), `schemas.ts`, `safety.ts`. `--resume` reads
`.agent/last-plan.json` and ignores a run-ID argument. There is no token or cost
accounting — set spend limits on your OpenRouter key.

## Setup

```bash
npm install -g yimpim      # or: npm link, from a clone
yimpim setup              # asks once, applies to every project
```

`yimpim setup` asks for your OpenRouter key (hidden input, stored in your OS
credential store), then shows the models your key can actually reach — searchable,
with live prices — and lets you pick a primary and a backup for each role.
Your answers go to `~/.yimpim/config.yaml` and apply everywhere.

Then, in any repository:

```bash
cd my-project
yimpim
```

It works on the repo you are standing in. No paths, no flags.

Inside a session:

```
/remote-control   Pair your phone with a QR code (watch + stop runs)
/status           Models, settings and readiness
/plan             The current plan
/memory           What YIMPIM has learned about this repo
/exit             Quit
```

Everything else is optional:

```bash
yimpim doctor                 # what works here, and what a run will cost
yimpim config list --common   # settings most people change
yimpim config set <key> <val> # change one
```

Required: Node.js 22+, Git, an OpenRouter API key.
Optional tooling (a JDK, adb + emulator, Playwright, Python) each unlocks a
verification gate; its absence only lowers confidence rather than failing a run.

## Important Git behavior

The agent never stashes, discards, or commits work you already had in progress.

Before editing, it snapshots which paths were already dirty. On success it stages
**only** the files it changed itself. On failure it restores only those files and
moves any files it created into `.agent/rejected/<timestamp>/` — nothing is
deleted, and your pre-existing changes are left exactly as they were.

A phase is committed only after the verifier returns a pass. The commit message
records the QA confidence level so a `static-only` pass is visible in history.

## OpenRouter

`agent.config.yaml` accepts an ordered model array per role:

```yaml
models:
  discovery:
    - your-primary-model
    - your-fallback-model
  planner:
    - your-primary-model
    - your-fallback-model
  editor:
    - your-cheap-editor-model
    - your-editor-fallback
  verifier:
    - your-verifier-model
```

The implementation sends the first model as `model` and remaining models as OpenRouter's `models` fallback chain. Provider fallback remains enabled.

Use models that support tool calling for Discovery and Editor, and structured outputs for the structured stages. Confirm model capability before switching models.

## What I would still add before calling this an enterprise-grade service

- Android Studio plugin UI
- Human approval mode before commit
- Test suite/evals against representative repositories
- Cost/token telemetry
- Per-file patch backups
- Secret scanning of diffs
- Better Kotlin/Gradle symbol graph analysis
- Parallel read-only discovery
- Sandboxed Gradle execution
- Concurrency/run locking
- A small SQLite run database if you expect many simultaneous projects
- Optional remote observability

The core failure/recovery architecture is intentionally local and Git-backed.

## Security checks are tools, not a guarantee

Gage's security features (the threat model made before a risky task, the attacker-style review of a change, the pattern
scans, and the whole-application security audit) are automated and AI-assisted. They help a person look; they do not
replace one.

- They can miss vulnerabilities, including serious ones. "No findings" does not mean an application is secure.
- They can report problems that are not real, and a suggested fix can be wrong or incomplete. Check each before acting.
- They are not a penetration test, a security audit, a compliance assessment or professional advice, and they certify nothing.
- Everything is provided as is, without warranty of any kind. You are responsible for what you build and release, and for
  having a qualified person review anything that matters before you rely on it.
- Only test systems you own or have written permission to test.

The same notice is printed with every security result and saved at the top and bottom of every audit report (`src/disclaimer.ts`).

## Free and hosted

The harness in this repository is free and open source (Apache License 2.0, see `LICENSE` and `NOTICE`).

- **Free:** the command-line agent, planning, verification and security tooling. Nothing here needs an account.
- **YIMPIM Pro (paid):** phone remote control through the hosted relay, push notifications, and the Android and iOS apps.
  `/link` connects this machine to your subscription. The hosted service is a separate product with its own terms of
  service; its server code is not part of this repository.
