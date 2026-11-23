# YIMPIM

A coding agent for your terminal. Describe a change, and YIMPIM plans it in phases, writes the code, builds and runs it, has a separate reviewer check it, and commits each phase that passes.

It works in any Git project, on your machine, with the AI models you choose through [OpenRouter](https://openrouter.ai). Guide and reference: **[yimpim.com](https://yimpim.com)**.

```
yimpim › Add a dark mode toggle to settings

Plan  3 phases
Phase 1/3  build passed · tests passed · app ran
           ✓ verified · committed
Phase 2/3  editing 2 files…
```

> **Run it in a sandbox if you can.** YIMPIM only works inside the project you start it in, but it edits files and runs commands there. A virtual machine or other sandbox is the safest place to use it.

## What you need

- Node.js 22 or newer, and Git
- An OpenRouter account with credit, and a key from [openrouter.ai/keys](https://openrouter.ai/keys) **with a spend limit**. YIMPIM does not cap spending itself, and OpenRouter bills you directly.
- Optional: a JDK with `adb` and an emulator, Playwright, Python. Each lets YIMPIM check more of its own work. Without them it still runs and reports lower confidence.

## Install

YIMPIM is not on the npm registry. Install it from a clone:

```bash
git clone https://github.com/yimpim/yimpim-harness.git
cd yimpim-harness
npm install      # also builds it
npm link         # gives you the `yimpim` and `yp` commands
yimpim setup
```

`yimpim setup` is a short wizard. It asks for your OpenRouter key (typed masked, checked straight away, and saved in your system's credential store, never in a project), shows the models your key can reach with live prices, and lets you pick one model for every role or a model per role. Esc cancels at any point. Your choices go to `~/.yimpim/config.yaml` and apply to every project.

Then, in any project:

```bash
cd my-project
yimpim
```

Type what you want, the way you would ask a colleague. Small and specific works best: *"Add a loading spinner while the feed loads."* Type `/stop` at any time to stop safely.

`yimpim doctor` shows what works on this machine, which checks will run, and what a run is likely to cost.

## Models

YIMPIM talks to models through OpenRouter only. Each role can use a different model, with an optional backup that takes over if the first is unavailable.

| Role | Used for |
|---|---|
| Planner | Turns your request into phases. Worth your strongest model: it runs once per task. |
| Editor | Writes the code. By far the most tokens, so it drives the bill. |
| Repair | Fixes what the checks found. Optional; uses the Editor's model when unset. |
| Verifier | Reviews each change against what you asked for. |
| Verifier (Vision) | Looks at screenshots of your app. |
| Discovery | Reads the project to learn how it is built. |
| Security | `/pentest` and the review of risky changes. Optional; falls back to the Verifier, then the Planner. |
| Designer | `/design`: proposes and draws logo concepts. A set of models to rotate through. Optional; falls back to the Planner. |
| Designer Judge (Vision) | `/design`: looks at the rendered concepts and judges them. Needs a vision-capable model. Optional. |

Discovery, Editor and Repair also have vision versions, used only on a task where you attach an image. Change any role later with `/model`. The first time you run `/pentest` or `/design` without its role set, YIMPIM tells you which model it will use and offers to let you pick one.

## Commands

Inside a session, type `/` to see suggestions, or `/help` for the list.

| Command | What it does |
|---|---|
| `/ask` | Ask a question about the code. Nothing changes. |
| `/plan`, `/stop`, `/continue` | Show the plan; stop at the next safe point; pick up where a stop left off |
| `/roadmap` | Plan and track a big job as units (`/roadmap new`, `run`, `add`, `drop`, `reopen`, `done`, `sync`, `reset`) |
| `/tests` | Fix a failing test suite: update outdated tests, report real bugs (`/tests heal`, `/tests log`) |
| `/design` | Make a logo, favicon and app icons |
| `/pentest` | Read-only security audit of the project |
| `/model`, `/model-sort`, `/api-key`, `/usage` | Change a role's model; how OpenRouter picks a provider; replace your key; tokens and cost so far |
| `/branch`, `/branches`, `/merge`, `/push-repo`, `/push-local` | Git helpers |
| `/status`, `/memory`, `/approvals`, `/verbose` | Settings and readiness; what YIMPIM has learned about the project; commands you approved; routine detail on or off |
| `/link`, `/remote-control` | YIMPIM Pro: link this machine, pair a phone |

From your shell: `yimpim setup`, `yimpim doctor`, `yimpim init` (write a starter config), `yimpim setup-env` (install the toolchains a new machine needs; `--dry-run` first), `yimpim config list | get | set`, `yimpim link`, and `yimpim "task"` to run one task without opening a session.

Flags: `--repo <dir>`, `--resume`, `--attach <file>` (repeatable), `--set key=value` (one run), `--json` (NDJSON output), `--yes` (accept defaults, never prompt), `--force-unlock`.

## How work is checked

Each phase goes through up to three checks, in order, and YIMPIM runs every check your machine supports.

| Check | Fails the phase when |
|---|---|
| Build and tests | The build or a test fails |
| Run the app (Android, web, Python web and desktop apps, with a screenshot) | It crashes. Visual issues are notes, not failures. |
| Review by a separate reviewer that never edits code | A requirement is clearly not met |

A missing tool never fails a run: only positive evidence of a defect does. Each phase reports how much was actually checked, and writes it into its commit message: `verified` (the app was launched and seen running), `partial` (it built, but was never seen running), or `static-only` (nothing could be run; the result rests on reading the code).

A failed phase is repaired and checked again, up to 10 times by default. Each phase is committed on its own, so a late problem never undoes earlier work, and `PROGRESS.md` in your project shows a live checklist.

## Your code stays safe

- Changes you already had in progress are never stashed, discarded or committed.
- Commits contain only the files YIMPIM changed for that phase.
- A failed phase is undone; files it created are moved to `.agent/rejected/`, never deleted.
- It cannot read or write `.env` files, keystores, certificates or private keys, or anything in `.git` and `node_modules`, and everything it touches must be inside the project.
- Before text goes to a model, keys and tokens in well-known formats are removed. This is a safety net, not a guarantee.
- The first time it wants to run a command it has not used in this project, it asks. See what you approved with `/approvals`.
- One run per project at a time, enforced by a lock that frees itself after a crash.

## Questions while you are away

YIMPIM asks only what it cannot work out. If nobody answers within 30 minutes, a model picks a sensible answer and notes it in `.agent/assumptions.md`. Requests to run a command, install or delete are refused instead. See `planning.questions` and the `interaction.*` settings.

## Settings

Settings resolve from lowest to highest: built-in defaults, `agent.config.yaml` (optional, per project), `YIMPIM_*` environment variables, then `--set key=value`.

```bash
yimpim config list --common
yimpim config set limits.maxRepairAttemptsPerPhase 3
yimpim --set models.editor=some/model "your task"   # this run only
```

Every setting lives in one registry, `src/settings.ts`, which feeds `config list`, `init`, validation and help.

## Phone control (YIMPIM Pro)

Part of the paid YIMPIM Pro service. Link this machine once with `/link` (or `yimpim link`), then type `/remote-control` in any session and scan the QR code with the YIMPIM app. Watch runs, answer questions, send messages and attachments, change models and stop work from your phone.

- **No inbound ports.** The desktop only makes outbound HTTPS requests to the hosted relay at `broker.yimpim.com`: it pushes events and long-polls for commands.
- **The relay cannot read your data.** Events and commands are sealed with AES-256-GCM. The key is generated on your computer and reaches the phone only inside the QR code, in the URL fragment, which browsers never send to a server. Each message is bound to its session and sequence number, so it cannot be replayed elsewhere.
- **Pairing:** a 256-bit single-use secret that expires in about two minutes. One device pairs per session, and attempts are rate-limited. A session ends when the run does, after 12 hours of inactivity, or 24 hours after it began.
- **Several terminals:** one account can have up to 3 terminals (a project each) paired at once. A 4th is refused while the others are running, and a terminal that has been silent for 3 minutes makes room. Only one phone is active per account: pairing on a new phone disconnects the old one. Each terminal tells the phone its project name, branch and (unless `remote.shareHostname` is off) computer name, sealed so the relay cannot read it. If the relay ends a terminal, it tells you why and what to run next.
- **`remote.redactLogs`** (off by default) drops free text from log events and from the echo of messages and answers you send.

## Security checks are tools, not a guarantee

Gage's security features (the threat model made before a risky task, the attacker-style review of a change, the pattern scans, and the whole-application security audit) are automated and AI-assisted. They help a person look; they do not replace one.

- They can miss vulnerabilities, including serious ones. "No findings" does not mean an application is secure.
- They can report problems that are not real, and a suggested fix can be wrong or incomplete. Check each before acting.
- They are not a penetration test, a security audit, a compliance assessment or professional advice, and they certify nothing.
- Everything is provided as is, without warranty of any kind. You are responsible for what you build and release, and for having a qualified person review anything that matters before you rely on it.
- Only test systems you own or have written permission to test.

The same notice is printed with every security result and saved at the top and bottom of every audit report (`src/disclaimer.ts`).

## Free and hosted

The harness in this repository is free and open source under the Apache License 2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)).

- **Free:** the command-line agent, planning, verification and security tooling. Nothing here needs an account.
- **YIMPIM Pro (paid):** phone remote control through the hosted relay, push notifications, and the mobile apps. `/link` connects this machine to your subscription. The hosted service is separate, with its own [terms](https://yimpim.com/terms/) and [privacy policy](https://yimpim.com/privacy/); its server code is not part of this repository.

What the harness itself sends, and where, is on the [privacy page](https://yimpim.com/privacy/). To delete a Pro account, see [yimpim.com/delete-account](https://yimpim.com/delete-account/).

## Contributing and security

Bug reports and pull requests are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md). To report a vulnerability, see [`SECURITY.md`](SECURITY.md) and please do not open a public issue.
