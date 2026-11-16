# Task: what /design, /pentest and /roadmap look like on the phone

**For:** phone dev (Android + Expo) · **From:** desktop

**Order of work:** finish what is in `docs/REMOTE_SPEC.md` first (and `ANDROID_MODEL_PICKER_TASK.md`). Then do `docs/REMOTE_SPEC_ADDENDUM_QUESTIONS_AND_ROADMAP.md`:

- **Part A** there: questions now arrive longer (a plain-words block, and a gloss on each choice). Required; it is shipped on the desktop.
- **Part B** there: the roadmap card (`roadmap.state`, `get_roadmap`, `task.start.roadmapUnitId`). Layout decided (one card); built on the desktop.

This file is the background: what the three job commands do, so the screens make sense. No new protocol is described here.

## What the three job commands do (they use the channels the phone already has)

The phone sends them as ordinary text (a typed `/pentest`, or plain words such as "I need a logo", which the desktop recognises). Progress comes as `log` events; questions come inside `status.pendingQuestions`; pictures come as `screenshot.chunk`.

### /design (logo, favicon, app icons, brand kit)
- Several models propose concepts, draw them as SVG, a separate vision model judges them, and the best go through palette and accessibility checks. A few minutes and a number of model calls.
- **Q&A:** it can ask the user to choose between concepts (buttons) and shows the pictures first. Pictures arrive as `screenshot.chunk` with a label; the phone can re-request one with `fetch_screenshot`.
- Output (logo files, palette, `guidelines.pdf`) is written to the project on the desktop. The phone sees the pictures and the summary text, not the PDF.

### /pentest (stage 1: read-only security audit of the project)
- Reads the code, git history and dependency lists; looks up known vulnerabilities by package name and version only; reviews the riskiest files with the security model. It changes nothing and attacks nothing (live testing is not built).
- **Q&A:** none. It runs and reports. The phone sees progress lines and a short summary.
- The full report is a file on the desktop (`security/audits/`). The phone cannot open it today.

### /roadmap (a job too big for one task)
- The desktop splits a big request into **units** (one unit = one ordinary task with its own plan of up to 12 phases). It saves them and does them **one at a time, in order** (never several at once). Later units build on what earlier ones produced, which is why they are not run in parallel.
- A request goes to a roadmap **automatically** when it is clearly too big: 6 or more of the things it asks for are still missing in the code. Unattended runs always use a roadmap rather than cutting work off. Before planning, the desktop checks what the code already has and plans only what is missing.
- **Q&A:** after a roadmap is made, and after each unit finishes, one question: `Roadmap: 3/12 done. Next is U004 "…". Continue?` with choices `yes next`, `yes to all`, `no`. `yes to all` keeps going unit after unit without asking again. Mid-unit questions are the normal ones; a scope question an agent asks is answered from the unit's own definition, and the work it leaves out is added as a new "Follow-up" unit.
- Typed commands (all work as phone text): `/roadmap` (status), `/roadmap run`, `/roadmap add <text>`, `/roadmap drop <id>`, `/roadmap reopen <id>`, `/roadmap done <id>`, `/roadmap reset`.
- Until the phone builds Part B, it sees a roadmap only as `log` text, and each unit shows up as its own task.

## Gaps, for later, not part of either spec

- The pentest report and `guidelines.pdf` stay on the desktop. A "fetch a file" verb (like `fetch_diff`) would be needed to read them on the phone.
- `fetch_screenshot` serves pictures only.
