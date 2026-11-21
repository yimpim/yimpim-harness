import fs from "fs/promises";
import { ReadLedger } from "./codeContext.js";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import type { ReviewRequest, ReviewOutcome, ActionReview } from "./commandReview.js";
import { cleanScratch, scratchTarget, SCRATCH_DIR } from "./scratch.js";
import { isFocusPath } from "./focusTests.js";
import type { EditorSweep, SweepOutcome } from "./editorSweep.js";
import { missingTool, missingToolMessage } from "./projectTools.js";
import { lookAlikeOf } from "./packageNames.js";
import { staleTestReferences, renderReferences, referencesKey, type Reference } from "./testReferences.js";
import {
  CommandApprovals,
  describeBinary,
  describeCommand,
  evaluateCommand,
  resolveExecutable,
  runResolvedCommand,
} from "./commandPolicy.js";
import { findInstalledVersions, snapshotDirs } from "./installVerify.js";
import { javaAwareEnv, probeJava, winSafeCommand } from "./capabilities.js";
import {
  ECOSYSTEMS,
  assessPackage,
  chooseVersionWithDates,
  lookupPackage,
  lookupVulnerabilities,
  type Ecosystem,
  type FetchFn,
} from "./dependencyFacts.js";
import { promisify } from "util";
import { AgentConfig } from "./config.js";
import { promptOnce } from "./terminalPrompt.js";
import { events } from "./events.js";
import { diffStore } from "./diffStore.js";
import { isJunkScreenName } from "./navGraph.js";
import { sanitizeQaSetup, saveQaSetup } from "./qaSetup.js";
import { isMustPass, lockedProblem, refusalFor } from "./directFix.js";
import { DEFAULT_MAX_ENTRIES, fingerprintOf, mergeComponentEntry } from "./repoMap.js";

const execFileAsync = promisify(execFile);

const READABLE_AGENT_METADATA = new Set([
  ".agent/repo_map.json",
  ".agent/nav_map.json",
  ".agent/qa-setup.json",
  ".agent/codebase-memory.json",
  ".agent/last-plan.json",
]);

/**
 * The standard, cross-ecosystem convention for an env-var TEMPLATE: holds
 * variable names only, never real values, and exists specifically to be
 * committed and read (by a human setting up the project, or an agent asked
 * to document required configuration) — the opposite of what the default
 * blockedFilePatterns' "*.env.*" glob is actually trying to stop. See
 * isSensitivePath's own comment for the real failure this was built from.
 */
const SAFE_ENV_TEMPLATE_RE = /^\.?env\.(example|sample|template|dist|defaults?)$/i;

export const TOOLS_SCHEMA = [
  {
    type: "function" as const,
    function: {
      name: "conclude_task",
      description:
        "Call this when: 1) You verified the requested change is ALREADY implemented correctly and no edits are needed, 2) You cannot locate the target code and need to escalate, or 3) You have finished patching.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["ALREADY_COMPLETED", "CANNOT_LOCATE", "FINISHED_PATCHING"],
            description: "Outcome of the editor pass.",
          },
          explanation: {
            type: "string",
            description:
              "Detailed explanation of why no changes were needed, what was missing, or what was modified. " +
              "Read by a human AND by a later repair pass fixing a real defect from it, so compress the " +
              "GRAMMAR, not the INFORMATION: one claim per line, wrap file/function/component names and " +
              "literal values in backticks (e.g. `RaceScreen.kt`, `TextOverflow.Ellipsis`), and never drop a " +
              "specific detail for brevity.",
          },
          howToVerify: {
            type: "string",
            description:
              "Only for FINISHED_PATCHING when you added or changed interactive UI behavior: step-by-step " +
              "instructions for confirming it works, written the way you'd write acceptance criteria for a " +
              "story — especially anything QA couldn't guess from a screenshot alone (a control with multiple " +
              "states reached by repeated taps, a gesture like a drag/swipe, an element hidden until scrolled " +
              "into view, a delay before an outcome appears). Omit if nothing you touched needs this. Same " +
              "writing style as explanation: short, one point per line, backticks around names/values.\n\n" +
              "WRITE IT AS A LITERAL NAVIGATION SCRIPT, not a description of the destination. Start from the " +
              "app's home/launch screen — QA does not already know the path to the screen you changed, and " +
              "cannot guess it. Name every intermediate screen you land on and the EXACT button/label text " +
              "tapped at each step, numbered in order. Never collapse several hops into one phrase.\n" +
              "  Bad:  'Enter the race from the betting office with a chicken fielded.'\n" +
              "  Good: '1. On the Home screen, tap `Coop`. 2. On the Coop screen, tap a chicken to select it, " +
              "then tap `Back`. 3. Tap `Betting Office`. 4. On the Betting screen, tap `LET'S RACE`. " +
              "5. On the Race screen, tap the leftmost floating button (fast-forward).'\n" +
              "If your own context includes a [KNOWN SCREEN NAVIGATION MAP], use it to fill in hops you didn't " +
              "personally trace — that's exactly what it's for. If a hop is missing from both what you read " +
              "AND that map, say so explicitly rather than guessing a path — a wrong path sends QA somewhere " +
              "that doesn't exist, which is worse than a shorter but honest one.\n\n" +
              "This is a HINT about mechanics for QA. It does not change what the acceptance criteria require.",
          },
          testsNotNeeded: {
            type: "string",
            description:
              "Only for FINISHED_PATCHING. If the files you changed have existing tests but this change genuinely " +
              "does not alter behavior any test should check (a pure refactor, renaming, styling, docs), give the " +
              "reason in one sentence. Otherwise update the existing test for each file whose behavior changed — QA " +
              "checks this and sends you back if a changed file's own test was left untouched.",
          },
          assertionDeltas: {
            type: "array",
            description:
              "Only for FINISHED_PATCHING, and only when your phase instructions list acceptance criteria with IDs " +
              "like [A1]. Report each criterion where what you built differs from it. Leave out any criterion you " +
              "satisfied as written. This never removes a check — QA still judges the original wording and shows " +
              "your note beside the result; a dropped criterion is reported to the user, never counted as passed.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "The criterion's ID exactly as listed, e.g. A2." },
                action: {
                  type: "string",
                  enum: ["modified", "dropped", "needs_device"],
                  description:
                    "modified: you built something different from what it says (give `replacement`). " +
                    "dropped: it is impossible or no longer applies. " +
                    "needs_device: it can only be confirmed on a real phone/device (native picker, camera, push, haptics).",
                },
                reason: { type: "string", description: "Why, in one or two concrete sentences. Required." },
                replacement: {
                  type: "string",
                  description:
                    "For `modified`: what is actually true now, as an observable outcome (not 'works correctly').",
                },
              },
              required: ["id", "action", "reason"],
            },
          },
        },
        required: ["status", "explanation"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_user",
      description:
        "CRITICAL: Pause execution immediately and ask the human user a blocking question. Use this ONLY for a real product decision that the specs, the task definition and the code do not settle (a dependency, a design choice, a trade-off, a credential). Look first: read the spec and search the code, because a question they answer is answered for you. A question about scope is answered by the task itself: stay inside it and note the rest as a follow-up. Always include your recommendation in the question.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The direct question to prompt the user with." },
          default: {
            type: "string",
            description:
              "The answer you will use if nobody answers in time (the user's answer deadline, 30 minutes by default). Always give one: the run carries on with it and it is written down for the user to review.",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "defer_question",
      description:
        "Log a non-blocking styling, copy, or preference decision to be resolved by the user at the end of the run. Always pick a temporary fallback and proceed.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Short label (e.g., 'Screen Background Tint')" },
          question: { type: "string", description: "The specific question for the user." },
          fallbackChosen: { type: "string", description: "The temporary fallback applied." },
          targetFile: { type: "string", description: "The relative path to the affected file." },
        },
        required: ["topic", "question", "fallbackChosen", "targetFile"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "flag_manual_step",
      description:
        "Record a step the USER must do outside this repo before the work is actually live — " +
        "applying a database migration to a real environment, setting a secret/API key in a cloud " +
        "provider's dashboard (Supabase, Cloudflare, Vercel, etc.), configuring DNS, rotating a key. " +
        "Anything requiring credentials or console access this agent does not have. Do not use this " +
        "for things you can and should just do yourself with the tools available (writing code, " +
        "editing config files IN this repo). Also do NOT use this for installing a dependency you just " +
        "declared in a manifest (package.json, requirements.txt, Cargo.toml, ...) — that install runs " +
        "automatically right after your turn, with no user action needed, even though you have no tool " +
        "to run the package manager yourself or confirm it directly. Not being able to run a command " +
        "yourself is not the same as the user needing to run it.",
      parameters: {
        type: "object",
        properties: {
          step: { type: "string", description: "The exact action the user needs to take, specific enough to act on directly." },
          reason: { type: "string", description: "Why this cannot be done by the agent (e.g., 'requires production DB credentials')." },
        },
        required: ["step", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "register_component",
      description:
        "Register or update a file entry in the architectural repo map (.agent/repo_map.json) for future reference.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Component or Screen name (e.g. SnailDetailScreen)" },
          path: { type: "string", description: "Relative file path." },
          summary: { type: "string", description: "Strict 10-15 word functional description." },
          exports: {
            type: "array",
            items: { type: "string" },
            description: "Top 2-3 functions, classes, or routes exported.",
          },
        },
        required: ["name", "path", "summary"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "register_screen_nav",
      description:
        "Record ONE screen's navigation facts in the persistent nav map (.agent/nav_map.json): what this " +
        "screen is called, which file defines it, how a user reaches it, and where each of its buttons/" +
        "controls leads. Only from what you actually saw in the navigation code (NavHost/composable route " +
        "definitions, navController.navigate calls, React Router routes, onClick handlers that switch " +
        "screens, storyboard segues, etc.) — never guess a destination you didn't see in code. Call this " +
        "whenever you're already reading a screen's file for another reason and its navigation is visible — " +
        "not a reason to go exploring extra files just to build this map. It's read later by the Editor " +
        "writing verification steps and by QA navigating toward a screen during automated testing, so a " +
        "missing entry just means less guidance (fine), but a WRONG one sends both somewhere that doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          screen: { type: "string", description: "Short, stable name for the screen, e.g. 'BettingScreen'." },
          file: { type: "string", description: "Relative path to the file that defines this screen." },
          reachedFrom: {
            type: "string",
            description:
              "How a user gets TO this screen, in words, e.g. 'HomeScreen, tap \"Coop\"', or 'app launch (start destination)'.",
          },
          isLaunchScreen: {
            type: "boolean",
            description:
              "true if the app/page can be sitting on this screen right after launch (the start destination, a splash, the landing page) with no navigation needed. QA's route-finding starts from these, so a map with none can't produce routes.",
          },
          reachedFromScreen: {
            type: "string",
            description:
              "The NAME of the one screen a user is on immediately before reaching this one (same naming as `screen`), if there is a single clear one. Omit for launch screens or when it varies.",
          },
          reachedViaLabel: {
            type: "string",
            description: "With reachedFromScreen: the exact visible label of the control tapped/clicked on that screen to get here.",
          },
          controls: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Exact visible text/label of the button or control." },
                leadsTo: {
                  type: "string",
                  description: "What tapping it does — the screen it navigates to, or the local behavior if it doesn't navigate.",
                },
                leadsToScreen: {
                  type: "string",
                  description:
                    "ONLY when this control navigates to another screen: that screen's name (same naming as `screen`). Omit for controls that just change something on this screen. This is what lets QA chain routes across screens.",
                },
              },
              required: ["label", "leadsTo"],
            },
            description: "Every button/control on this screen you found in the navigation code, and what it does.",
          },
        },
        required: ["screen", "file", "controls"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "register_qa_setup",
      description:
        "Tell QA how to put the running web app into a testable state BEFORE it looks at it. QA opens the app in " +
        "a fresh browser every time with no login, no pairing, no data, so any screen behind state can't be " +
        "reached unless you say how to fake that state. Use it when you know, from the code you just read or " +
        "wrote, how the app decides it is signed in / paired / onboarded (a localStorage key, a debug URL " +
        "parameter, a demo route), or when a feature needs the camera or a file picker. Values merge into " +
        ".agent/qa-setup.json and apply to every later QA run in this repo. Only set what the code actually " +
        "shows — never invent keys or values; a wrong one makes QA test a state that doesn't exist. Never put " +
        "real credentials, tokens or personal data in it: use a made-up demo value the app accepts, or " +
        "say via flag_manual_step that none exists.",
      parameters: {
        type: "object",
        properties: {
          launchPath: {
            type: "string",
            description:
              "Path (+ optional query/hash) QA opens instead of the site root, starting with '/', '?' or '#'. E.g. '/dashboard' or '/?demo=1'. Same origin only.",
          },
          localStorage: {
            type: "array",
            items: {
              type: "object",
              properties: { key: { type: "string" }, value: { type: "string" } },
              required: ["key", "value"],
            },
            description:
              "localStorage entries written before any app code runs (once per fresh browser tab). Values are strings; JSON-encode objects.",
          },
          cameraImage: {
            type: "string",
            description:
              "Repo-relative image shown to the app's camera (e.g. a QR code png the app should scan). Without it a camera screen sees a generic test pattern.",
          },
          uploadFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative files handed to any file chooser the app opens (max 5). Without it QA supplies a tiny sample png and txt.",
          },
          notes: { type: "string", description: "One line: what state this setup represents (e.g. 'paired session with demo desktop')." },
          deepLinks: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, url: { type: "string" } },
              required: ["name", "url"],
            },
            description:
              "Screens QA can open directly on a device: a URL with the app's own scheme or a universal link (myapp://pairing?demo=1), or a route starting with '/'. Android and iOS QA open them with open_link. At most 10.",
          },
          env: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" } },
              required: ["name", "value"],
            },
            description:
              "Variables the app is started with for QA. Only names starting EXPO_PUBLIC_, VITE_, NEXT_PUBLIC_, REACT_APP_, QA_ or MOCK_ are accepted (so nothing secret can be set); values are short strings.",
          },
          mockNotes: {
            type: "string",
            description:
              "What you mocked or toggled for QA and where it is switched on (e.g. 'a fake pairing service, on when EXPO_PUBLIC_QA_MOCK=1'). It is listed in the QA evidence so a person can see it. A mock must be off unless that flag is set.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read the full contents of one or more files. Prefer `paths` (an array, up to 12 files) over " +
        "repeated single-file calls whenever you need to survey several related files at once — e.g. " +
        "sibling screens or models to understand an existing pattern before deciding what to write. " +
        "Batching cuts down the number of round trips you need before you can act. For ONE file too " +
        "large to read whole (you'll see a 'truncated' note with the file's real size), use " +
        "startLine/endLine to walk it in sections instead of only ever seeing the first part — never " +
        "give up on a file just because one read came back truncated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to a single file. Omit if using `paths`." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Relative paths to multiple files to read in one call (max 12).",
          },
          startLine: {
            type: "number",
            description:
              "Only with `path` (not `paths`). 1-indexed, inclusive — read from this line onward (to " +
              "`endLine`, or to the end of the file if omitted). Use this to reach past a truncated " +
              "whole-file read, or to jump straight to a region you already know the line numbers for.",
          },
          endLine: {
            type: "number",
            description:
              "Only with `path` (not `paths`). 1-indexed, inclusive — read up to this line (from " +
              "`startLine`, or from the start of the file if omitted).",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "patch_file",
      description: "Apply a search-and-replace block to an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          search: { type: "string", description: "Exact string segment to match." },
          replace: { type: "string", description: "Replacement string." },
        },
        required: ["path", "search", "replace"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          content: { type: "string", description: "Full content of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_build_check",
      description:
        "Run this project's own build/typecheck command (the exact same check QA's build gate runs) " +
        "against the files you've written so far, and report pass/fail with the real compiler/build " +
        "output. Use this to confirm a patch actually compiles BEFORE concluding — submitting an " +
        "unverified guess wastes a full QA + repair cycle if it's wrong, and you otherwise have no way " +
        "to know. Takes no arguments. Build/typecheck only — it does not run tests, launch the app, or " +
        "check runtime/visual behavior; those still need QA. Returns a plain unavailability notice " +
        "(not a failure) when no build/typecheck command applies to this project.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_test_references",
      description:
        "After you remove or change something a person can see or call (a button or its label, a message, a route, an exported component or function), " +
        "list every test in the project that still names it. It reads YOUR edits so far, takes the texts, test ids, routes and exported names on the lines you " +
        "removed, drops anything the code still contains, and searches the whole test folder once. Returns file:line for each place. Call it before concluding " +
        "and update those lines to match your change, in this same phase. Takes no arguments. Finds literal text only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_dependency_install",
      description:
        "Run this project's own dependency install command (npm install, gradle, pod install, ... — " +
        "whichever applies) for the manifest file(s) you've changed so far, and report the REAL " +
        "pass/fail output. Use this for anything beyond a trivial one-line version bump — an SDK " +
        "upgrade, a version you are not fully certain is correct, a change touching more than one " +
        "dependency — so you find out what the package manager ACTUALLY resolves to instead of " +
        "guessing a version and hoping. A real install commonly surfaces a SECOND conflict only once " +
        "the first is fixed (bumping one package reveals another now needs bumping too, etc.) — if " +
        "that happens, fix the new conflict and call this again; do not stop at the first fix without " +
        "re-running it. Takes no arguments. May ask the user to approve running it, same as the " +
        "install that already happens automatically after this phase — this just lets you see the " +
        "result now instead of finding out from QA several minutes later. Returns a plain notice " +
        "(not a failure) when no dependency manifest has been changed yet.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "request_dependency",
      description:
        "Verify a NEW third-party dependency against its real registry BEFORE you add it to a manifest. " +
        "Returns whether the package actually exists, the version you should use, and any warnings " +
        "(deprecated, brand-new, almost no downloads, known security advisories). Your own memory of " +
        "package names and latest versions is not reliable; this is. Call it once per new package, then " +
        "use the version it returns. If it says the package does not exist, do not add it — pick a real " +
        "alternative. It is a read-only lookup: it installs nothing. Not needed for packages the project " +
        "already declares.",
      parameters: {
        type: "object",
        properties: {
          ecosystem: {
            type: "string",
            enum: ["npm", "pypi", "crates", "maven", "nuget", "go"],
            description:
              "Which registry: npm (JS/TS), pypi (Python), crates (Rust), maven (JVM/Android, as group:artifact), nuget (.NET/Unity), go (module path).",
          },
          name: {
            type: "string",
            description: "The package name, e.g. `react-native-svg`, `pandas`, `serde`, or `androidx.core:core-ktx`.",
          },
          reason: { type: "string", description: "One short sentence on why this dependency is needed." },
          version: {
            type: "string",
            description: "Only if the task states an exact version that must be used; otherwise omit it.",
          },
        },
        required: ["ecosystem", "name", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_project_command",
      description:
        "Run ONE command for this project (a build, a test run, an install, a code generator, a version " +
        "check) and get its real output. Use it when no dedicated tool covers what you need: " +
        "run_build_check and run_dependency_install already handle this project's standard build and " +
        "install, so prefer those. The command runs directly, NOT through a shell: do not chain with " +
        "&&, |, ;, > or $(...) — make separate calls. It must stay inside the project (the working " +
        "directory and any path argument). The user is asked to approve a command the first time; an " +
        "approved command is remembered for this project. Commands that fetch from the network, run " +
        "inline code, or download-and-execute a package are asked about every time. Not allowed at " +
        "all: sudo, shells, deleting files (use stage_file_for_deletion), system configuration, ssh. " +
        "If the program is not installed you get a plain notice instead of a failure — do not retry " +
        "it; report it as a manual step.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The single command line, e.g. `npm run build` or `cargo check --offline`.",
          },
          cwd: {
            type: "string",
            description: "Directory to run in, relative to the project root. Defaults to the root.",
          },
          purpose: {
            type: "string",
            description:
              "One short sentence on why this is needed, shown to the user in the approval prompt.",
          },
        },
        required: ["command", "purpose"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "stage_file_for_deletion",
      description:
        "Stage a file for deletion at the end of the run. This does NOT delete anything now — it only " +
        "records the intent, and the user is asked to confirm every staged file in a single prompt once " +
        "the run finishes. Use this instead of emptying a file to zero bytes when a file is genuinely " +
        "obsolete (dead code, a superseded module, a removed screen). Prefer this over leaving an empty " +
        "placeholder file behind.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file that should be deleted." },
          reason: {
            type: "string",
            description:
              "Short explanation of why this file is obsolete, shown to the user alongside the " +
              "deletion prompt (e.g. 'superseded by src/remote/auth.ts').",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_code",
      description:
        "Search for a regex or string pattern across files in the repository. Prefer `patterns` (an array, " +
        "up to 8) over repeated single-pattern calls whenever you're exploring several hypotheses at once — " +
        "a naming guess, a synonym, an abbreviation, a related concept. Each one still runs as its own " +
        "search with its own labeled results; batching only cuts down the number of round trips before you " +
        "can act, the same reason read_file's `paths` exists.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for. Omit if using `patterns`." },
          patterns: {
            type: "array",
            items: { type: "string" },
            description: "Multiple regex patterns to search for in one call (max 8).",
          },
          path: { type: "string", description: "Optional subdirectory to narrow the search." },
          caseSensitive: {
            type: "boolean",
            description: "Whether search should match exact case. Defaults to false.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description:
        "List files in a directory. Set `recursive: true` to list the entire subtree in one call instead " +
        "of listing each subdirectory separately — prefer this when orienting yourself in an unfamiliar " +
        "area of the codebase, such as before deciding whether a file already exists or needs to be created.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Defaults to root." },
          recursive: {
            type: "boolean",
            description: "List all nested files under this directory, not just its immediate children. Defaults to false.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_file_outline",
      description:
        "Inspect declarations, functions, and class signatures in one or more files without reading the " +
        "entire file. Pass `paths` (an array, up to 12 files) to batch multiple files in a single call.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to a single file. Omit if using `paths`." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Relative paths to multiple files to outline in one call (max 12).",
          },
        },
      },
    },
  },
];

/**
 * For the Advisor pass (the user just wants information, not a change).
 * write_file/patch_file are absent from this list, not merely discouraged by
 * a prompt — a tool-calling model can only invoke a function that was
 * actually offered to it, so this is enforced at the protocol level, not by
 * asking nicely.
 */
const READ_ONLY_NAMES = new Set(["read_file", "search_code", "list_files", "get_file_outline"]);
export const READ_ONLY_TOOLS_SCHEMA = TOOLS_SCHEMA.filter((t) => READ_ONLY_NAMES.has(t.function.name));

/**
 * The Discovery pass's own instructions (index.ts's discoveryText) say
 * "If YES: Conclude immediately" once it has enough context — with the full
 * default TOOLS_SCHEMA (which this agent used to be given, same as
 * EDITOR/REPAIR), a model reads that as "call conclude_task", not as "answer
 * now with the required JSON". conclude_task's return value is the plain
 * string `TASK_CONCLUDED: <explanation>` (see agentLoop.ts) — not JSON — so
 * every downstream consumer of Discovery's output (extractTaskFindings,
 * extractDiscoveryTargetFiles in index.ts) silently fails to parse it,
 * discarding every file Discovery actually found and handing the Planner an
 * empty allowlist with no visible explanation. conclude_task, write_file,
 * patch_file, and stage_file_for_deletion are all meaningless for a role that
 * only ever reports findings as one final JSON answer, never edits anything
 * — omitting them here makes "conclude immediately" physically resolve to
 * "answer directly", the only response shape the caller can use.
 * register_component is added back on top of READ_ONLY_TOOLS_SCHEMA because
 * Discovery's own prompt explicitly instructs it to call that tool.
 */
const DISCOVERY_NAMES = new Set(["read_file", "search_code", "list_files", "get_file_outline", "register_component"]);
export const DISCOVERY_TOOLS_SCHEMA = TOOLS_SCHEMA.filter((t) => DISCOVERY_NAMES.has(t.function.name));

/**
 * How many DISTINCT files one planning pass may open. The Planner is not the
 * Editor — it never needs to survey a whole feature area, only to confirm the
 * contract of the handful of files Discovery already named. Five covers a
 * phase's own file plus a few adjacent callers/types (e.g. one shared
 * definition referenced from several call sites), and is still small enough
 * that a confused pass cannot turn planning into a second, unbounded
 * discovery sweep.
 */
export const PLANNER_MAX_INSPECTED_FILES = 5;

/** Hard ceiling however many targets Discovery lists (matches Discovery's own file budget). */
export const PLANNER_MAX_INSPECTED_FILES_CEILING = 30;

/** The least the Planner may read when it plans, whatever Discovery listed. */
export const PLANNER_MIN_INSPECTED_FILES = 8;

/**
 * The Planner is told never to guess what a file or spec could tell it, so it
 * may read every file Discovery named: the allowlist (only those files) is what
 * bounds the cost, and a budget below that count just stops it reading what it
 * was handed. At least 8, at most the ceiling.
 */
export function plannerReadBudget(discoveryTargetCount: number): number {
  return Math.min(PLANNER_MAX_INSPECTED_FILES_CEILING, Math.max(PLANNER_MIN_INSPECTED_FILES, discoveryTargetCount));
}

/**
 * The tool set the Planner is offered when it plans a phase.
 *
 * Deliberately two tools, NOT READ_ONLY_TOOLS_SCHEMA: `search_code`,
 * `list_files` and the batched `paths` form of `read_file` are absent from
 * this list, not merely discouraged by a prompt. A tool-calling model can
 * only invoke a function that was actually offered to it, so a Planner
 * physically cannot run a broad repository grep or walk a directory tree
 * here — it can only open a file Discovery already identified, or ask for one
 * symbol inside such a file.
 *
 * The path restriction and the file budget are enforced in AgentTools (see
 * assertPlannerFileAllowed), not by asking nicely, so a hallucinated path or
 * one read past the cap is refused rather than silently obeyed.
 */
/**
 * Run one test file in a heal sandbox. DELIBERATELY not part of TOOLS_SCHEMA: an agent that is not given an explicit tool list gets
 * TOOLS_SCHEMA, and none of them may be offered a way to run tests that only a sandbox makes safe.
 */
export const RUN_TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "run_test",
    description:
      "Run a test file in the sandbox, optionally only the tests whose name matches namePattern (a regular expression, as jest -t / vitest -t). " +
      "Returns the runner's full output. Use it to check a hypothesis: add console.log anywhere (test or app code), change a wait, run, read. " +
      "Nothing you change here reaches the real project except the test file, and only if it makes more tests pass without breaking any.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Repo-relative test file, e.g. __tests__/dashboard.test.ts" },
        namePattern: { type: "string", description: 'Optional. Only tests whose full name matches. Example: "derives Send/Stop"' },
      },
      required: ["file"],
    },
  },
};

/**
 * The tests the Editor's change can reach, run now (the same selection QA uses), with a digest of what fails. For EDITOR and REPAIR; the heal sandbox is not offered it.
 * Shell-free and gated like run_test: the code the agent changed is screened before anything runs.
 */
export const RUN_AFFECTED_TESTS_TOOL = {
  type: "function" as const,
  function: {
    name: "run_affected_tests",
    description:
      "Run the tests your change can reach (the same ones the final verification runs) and get the list of what fails and why. Use it before you conclude, and again after fixing what your change made out of date. " +
      "Tests that were already failing before this phase are reported separately: they are not yours to fix.",
    parameters: { type: "object", properties: {}, required: [] as string[] },
  },
};
TOOLS_SCHEMA.push(RUN_AFFECTED_TESTS_TOOL as any);

/**
 * run_test for REPAIR, which edits the real project: the same tool, described for where it runs. Offered only for a failing test, and only to REPAIR (see
 * repairRunTest.ts); everything else that is given the default tool list is still never offered a way to run tests.
 */
export const REPAIR_RUN_TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "run_test",
    description:
      "Run a test file in the project as it is right now, with your edits, optionally only the tests whose name matches namePattern (a regular expression, as jest -t / vitest -t). " +
      "Returns the runner's output. Use it after a change to see whether the failing test now passes BEFORE you finish: it is much cheaper than the full verification, " +
      "which still runs afterwards and decides. It runs tests only; it cannot run anything else.",
    parameters: RUN_TEST_TOOL.function.parameters,
  },
};

/**
 * Record a place where the spec says one thing and the working app does another, in a heal sandbox. Not in TOOLS_SCHEMA, for the same reason as RUN_TEST_TOOL.
 * What it records is checked against the project when it is called (the files and lines must exist), and again when the test change is merged.
 */
export const RECORD_DEVIATION_TOOL = {
  type: "function" as const,
  function: {
    name: "record_deviation",
    description:
      "Record ONE place where the written spec says one thing and the app works but does another (a label, its casing, wording, order, styling): call it for each, " +
      "after you changed the test to expect what the working app does. Both places must really exist. A deviation that is not recorded, or whose references do " +
      "not exist, makes your whole test change be thrown away. Never use it for an app that is WRONG (crashes, blocks a user, loses data, sends or shows wrong " +
      "functional data): that is a defect, and the test is not bent for it.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app code the test now follows, as path:line, e.g. src/components/DashboardTimeline.tsx:1247. Not a test file." },
        spec: { type: "string", description: "Where the spec says otherwise, as path:line, e.g. docs/PHONE_SPEC.md:461 (or the spec's own words, 20+ characters, if you cannot give a line)." },
        summary: { type: "string", description: "One sentence: what the spec requires and what the app does instead." },
      },
      required: ["app", "spec", "summary"],
    },
  },
};

export const PLANNER_TOOLS_SCHEMA = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read ONE file, to confirm a signature, type or constraint before writing contract " +
        "specifications. Start with the discovery target files; any other file in the project may also be opened " +
        `(sensitive files and anything outside the project are refused), and only a limited number of distinct files may be opened during one ` +
        "planning pass. Single `path` only; there is no batched `paths` form here. A truncated result " +
        "(the file is too large to read whole) still counts as opening that file — use startLine/endLine " +
        "to see a further section of the SAME file without spending another one of your file slots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to one discovery target file." },
          startLine: {
            type: "number",
            description:
              "1-indexed, inclusive — read from this line onward (to endLine, or to the end of the " +
              "file if omitted). Use this to reach past a truncated whole-file read.",
          },
          endLine: {
            type: "number",
            description: "1-indexed, inclusive — read up to this line (from startLine, or from the start of the file if omitted).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_symbol_definition",
      description:
        "Return the declaration of ONE named symbol (function, class, interface, type, method) inside a " +
        "project file, instead of reading the whole file. Same rules as read_file: any project file may be " +
        "opened (discovery targets are the place to start), and opening one counts against the same " +
        `file budget (a rejection tells you the exact limit).`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to one discovery target file." },
          symbol: { type: "string", description: "Exact symbol name to locate, e.g. 'patchFile'." },
        },
        required: ["path", "symbol"],
      },
    },
  },
];

export interface PendingQuestion {
  id: string;
  topic: string;
  question: string;
  fallbackChosen: string;
  targetFile: string;
  timestamp: string;
}

export interface ManualStep {
  step: string;
  reason: string;
  phase?: string;
}

/**
 * Line-change stat for a console hint (git-style "+N -M"). No external diff
 * dependency, no API/model cost — pure local string work.
 *
 * Trims the common prefix/suffix first (free, and exact), then runs a real
 * LCS diff on whatever's left in the middle, bounded so a huge whole-file
 * rewrite can't make this expensive. A prefix/suffix trim ALONE badly
 * overstates a file with two separate changes and unchanged lines between
 * them — e.g. one line edited plus one line inserted elsewhere reported as
 * "+4 -3" instead of the real "+2 -1", because everything between the two
 * edits got swept in as "changed" along with them. LCS on the trimmed
 * middle fixes that.
 */
/** A trailing newline splits into one extra empty element that isn't a real line. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineDiffStat(oldText: string, newText: string): { added: number; removed: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ta = a.slice(start, endA);
  const tb = b.slice(start, endB);

  if (ta.length === 0 || tb.length === 0 || ta.length * tb.length > 250_000) {
    // Pure insertion/deletion (LCS would be trivial anyway), or the
    // remaining middle is too large for an O(n*m) table — the trim above is
    // still exact on its own, just report it without diffing further.
    return { removed: ta.length, added: tb.length };
  }

  const dp: number[][] = Array.from({ length: ta.length + 1 }, () => new Array(tb.length + 1).fill(0));
  for (let i = 1; i <= ta.length; i++) {
    for (let j = 1; j <= tb.length; j++) {
      dp[i][j] = ta[i - 1] === tb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const common = dp[ta.length][tb.length];
  return { removed: ta.length - common, added: tb.length - common };
}

/**
 * A minimal diff rendering for human viewing only — never re-applied as a
 * patch, so it carries no file/hunk headers, just one line per row prefixed
 * ' ' (context), '-' (removed) or '+' (added). Reuses the exact same
 * common-prefix/suffix trim and LCS table as lineDiffStat (backtracked here
 * instead of just counted), so the full diff and the +N/-M stat can never
 * disagree about what actually changed.
 */
export function buildDiffLines(oldText: string, newText: string, contextLines = 3): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: string[] = [];
  for (let i = Math.max(start - contextLines, 0); i < start; i++) out.push(`  ${a[i]}`);

  const ta = a.slice(start, endA);
  const tb = b.slice(start, endB);

  if (ta.length === 0 || tb.length === 0 || ta.length * tb.length > 250_000) {
    // Pure insertion/deletion, or too large to align cheaply — same threshold
    // as lineDiffStat, for the same reason: an O(n*m) table isn't worth it.
    for (const l of ta) out.push(`- ${l}`);
    for (const l of tb) out.push(`+ ${l}`);
  } else {
    const dp: number[][] = Array.from({ length: ta.length + 1 }, () => new Array(tb.length + 1).fill(0));
    for (let i = 1; i <= ta.length; i++) {
      for (let j = 1; j <= tb.length; j++) {
        dp[i][j] = ta[i - 1] === tb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const rows: string[] = [];
    let i = ta.length;
    let j = tb.length;
    while (i > 0 && j > 0) {
      if (ta[i - 1] === tb[j - 1]) {
        rows.push(`  ${ta[i - 1]}`);
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        rows.push(`- ${ta[i - 1]}`);
        i--;
      } else {
        rows.push(`+ ${tb[j - 1]}`);
        j--;
      }
    }
    while (i > 0) {
      rows.push(`- ${ta[i - 1]}`);
      i--;
    }
    while (j > 0) {
      rows.push(`+ ${tb[j - 1]}`);
      j--;
    }
    rows.reverse();
    out.push(...rows);
  }

  for (let i = endA; i < Math.min(endA + contextLines, a.length); i++) out.push(`  ${a[i]}`);
  return out.join("\n");
}

/** Green "+N" / red "-N" — ANSI codes only, matching the escape sequences already used for line-clearing elsewhere in this codebase. */
function formatDiffStat(stat: { added: number; removed: number }): string {
  return `\x1b[32m+${stat.added}\x1b[0m \x1b[31m-${stat.removed}\x1b[0m`;
}

/**
 * Search patterns are written for PCRE, but they are executed through `grep -E`
 * (POSIX ERE). `grep -E` rejects inline flag groups like `(?i)` outright with a
 * "repetition-operator error", so a perfectly reasonable pattern returned an
 * error string and zero results. Strip the leading flag group here and carry
 * its meaning into the `-i` flag instead; anything else PCRE-only is left for
 * the -F fixed-string retry in searchCode to handle.
 */
export function normalizeSearchPattern(
  pattern: string,
  caseSensitive: boolean
): { pattern: string; caseSensitive: boolean } {
  let cleaned = pattern;
  let effectiveCaseSensitive = caseSensitive;

  const flagGroup = /^\(\?([a-zA-Z-]+)\)/.exec(cleaned);
  if (flagGroup) {
    const flags = flagGroup[1];
    if (flags.includes("-")) {
      // (?-i) explicitly asks for case-sensitive matching.
      if (flags.includes("i")) effectiveCaseSensitive = true;
    } else if (flags.includes("i")) {
      effectiveCaseSensitive = false;
    }
    cleaned = cleaned.slice(flagGroup[0].length);
  }

  // A pattern that was nothing but flags would otherwise become an empty
  // argument, which grep treats as "match every line".
  if (cleaned.trim() === "") cleaned = pattern;
  return { pattern: cleaned, caseSensitive: effectiveCaseSensitive };
}

/** Escape a literal string for safe interpolation into a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class AgentTools {
  private repoRoot: string;
  private config: AgentConfig;
  private blockedPatterns: RegExp[];

  /** Distinct files written during the current phase. */
  private filesWritten = new Set<string>();
  /**
   * Everything read/searched/listed/outlined during the current phase, in the
   * order it was inspected. This is the evidence handed back to the planner
   * when the editor circuit-breaks without ever writing anything — real
   * findings ("these files exist, this one doesn't") instead of asking the
   * same underinformed model to guess again.
   */
  private filesInspected = new Set<string>();
  /** Files the plan expects this phase to touch; empty means "unknown". */
  private plannedFiles: string[] = [];
  /**
   * The Planner's bounded inspection window: the discovery target files it is
   * permitted to open, and which of them it has actually opened. Empty
   * allowedFiles means no window has been set, and every Planner inspection is
   * refused — an unconfigured Planner must not silently fall back to
   * unbounded reading.
   */
  private plannerAllowedFiles = new Set<string>();
  private plannerInspectedFiles = new Set<string>();
  /**
   * The exact (startLine, endLine) pairs readFileBounded was actually called
   * with this pass, per file, in call order — undefined start/end means a
   * whole-file (no-range) call. This is what lets a later corrective pass
   * replay the SAME chunked reads a large file needed the first time around
   * (see plannerInspectedRangesThisPass), instead of one single whole-file
   * read that truncates where the original chunked walk didn't. Not
   * populated by getSymbolDefinition — that tool never returns line-range
   * content, so there is nothing meaningful to replay for it.
   */
  private plannerInspectedRanges = new Map<string, Array<{ start?: number; end?: number }>>();
  private plannerMaxInspectedFiles = PLANNER_MAX_INSPECTED_FILES;
  private maxFilesPerPhase = 0; // 0 = no limit
  private currentPhaseName?: string;
  private activeAgent = "EDITOR";
  /** Accumulates across the WHOLE run — never reset by beginPhase. */
  private manualSteps: ManualStep[] = [];
  /**
   * Repo-relative paths staged for deletion. Like manualSteps this accumulates
   * across the WHOLE run and is never reset by beginPhase — a file the editor
   * marked obsolete in phase 2 is still obsolete in phase 5, and the single
   * confirmation prompt only makes sense once every phase has had its say.
   * Staging is purely a record of intent: nothing is unlinked here.
   */
  private filesPendingDeletion = new Set<string>();
  /** Why each staged path was proposed, keyed by the same normalized path. */
  private deletionReasons = new Map<string, string>();

  /**
   * Defaults to a plain local terminal prompt. index.ts overrides this with
   * askAnywhere so a question the agent asks mid-task also reaches a paired
   * phone, the same as every other question in this app — without this
   * class needing to know anything about remote control itself.
   */
  private askFn: (question: string, fallback: string, kind?: "approval") => Promise<string>;

  /**
   * Lets index.ts wire in a callback that runs this project's own build/
   * typecheck command (AutonomousVerifier.runBuildCheckOnly) — set once,
   * after both this class and the verifier exist, so the run_build_check
   * tool has something real to call into without AgentTools needing to know
   * anything about project profiles, capabilities, or build-command
   * resolution itself. index.ts always wires this before EDITOR or REPAIR
   * ever runs; runBuildCheck() below still fails with a clear message
   * rather than silently no-op'ing if it's ever somehow called first.
   */
  private buildCheckRunner?: (agentLabel: string) => Promise<string>;

  /**
   * Lets index.ts wire in a callback that runs this project's own
   * dependency install command (orchestrator.ts's runDependencyInstallCheck)
   * for whichever manifest file(s) this phase has written so far — set once,
   * same lifecycle as buildCheckRunner above. Backs the run_dependency_install
   * tool: EDITOR/REPAIR can see the REAL install result mid-turn (a version
   * conflict npm reports, a second conflict only exposed once the first is
   * fixed) instead of writing a guessed version and finding out only via QA,
   * several minutes later, whether the guess was even close.
   */
  private dependencyInstallRunner?: (
    writtenFiles: string[],
    approve: (planSummary: string) => Promise<boolean>,
    memo: Map<string, string>
  ) => Promise<string>;
  /** How registry lookups reach the network; replaceable so tests never do. */
  private factsFetch: FetchFn = (url, init) => fetch(url, init);
  /** request_dependency answers already given this phase, keyed by ecosystem:name. */
  private dependencyRequestMemo = new Map<string, string>();
  /** Per-user record of commands approved for run_project_command; lives outside the repo. */
  private commandApprovals = new CommandApprovals();
  /** Bumped on every write, so an unchanged tree can be recognised when a command is retried. */
  private writeEpoch = 0;
  /** Failed or declined run_project_command results this phase, keyed by command + tree state. */
  private commandMemo = new Map<string, string>();
  /** Packages request_dependency has cleared this session (lower-cased names). */
  private clearedPackages = new Set<string>();
  private clearedFacts = new Map<string, { ecosystem: Ecosystem; facts: import("./dependencyFacts.js").PackageFacts }>();
  /** Files and directories the agent itself created this session (repo-relative). */
  private agentCreatedFiles = new Set<string>();
  private agentCreatedDirs = new Set<string>();
  private commandReviewer?: (req: ReviewRequest) => Promise<ReviewOutcome>;
  private reviewerCoversElevated = false;
  /** Programs the project does not have that were already declined once (so asking for one again asks a person). */
  private missingToolRefused = new Set<string>();
  private actionReviewer?: (a: ActionReview) => Promise<ReviewOutcome>;

  /**
   * A security review that may clear a command before a person is asked (see commandReview.ts, commandPanel.ts). The single reviewer clears only
   * normal-risk commands; a panel of judges (coversElevated) is trusted with the ones that need extra care too, since it is shown why they do.
   */
  public setCommandReviewer(fn: ((req: ReviewRequest) => Promise<ReviewOutcome>) | undefined, opts: { coversElevated?: boolean } = {}): void {
    this.commandReviewer = fn;
    this.reviewerCoversElevated = Boolean(fn && opts.coversElevated);
  }

  /** The same review for a dependency install plan and for a package to add (see commandPanel.ts). */
  public setActionReviewer(fn: ((a: ActionReview) => Promise<ReviewOutcome>) | undefined): void {
    this.actionReviewer = fn;
  }

  /** Set only on the AgentTools of a heal sandbox: what `run_test` does. */
  private sandboxRunTest?: (args: Record<string, unknown>) => Promise<string>;
  public bindSandboxRunTest(fn: ((args: Record<string, unknown>) => Promise<string>) | undefined): void {
    this.sandboxRunTest = fn;
  }
  /** Set only on the AgentTools of a heal sandbox: what `record_deviation` does. */
  private sandboxDeviation?: (args: Record<string, unknown>) => Promise<string>;
  public bindSandboxDeviation(fn: ((args: Record<string, unknown>) => Promise<string>) | undefined): void {
    this.sandboxDeviation = fn;
  }
  /** `record_deviation`: only a heal sandbox binds it. */
  public async recordDeviation(args: Record<string, unknown>): Promise<string> {
    if (!this.sandboxDeviation) return "record_deviation is only available in a heal sandbox";
    return this.sandboxDeviation(args);
  }
  /** `run_test`: only a heal sandbox binds it; anywhere else it is refused, so no ordinary agent can run tests this way. */
  private affectedTests?: EditorSweep;
  /** The Editor's own test sweep (editorSweep.ts): what runs before an Editor or Repair is allowed to conclude, and what run_affected_tests answers with. */
  public setAffectedTests(s: EditorSweep | undefined): void {
    this.affectedTests = s;
  }
  public async affectedTestsCheck(): Promise<SweepOutcome | undefined> {
    if (!this.affectedTests) return undefined;
    try {
      return await this.affectedTests.check();
    } catch {
      return undefined; // a sweep that fails never stands in the way: QA runs the same tests
    }
  }
  public async runAffectedTests(): Promise<string> {
    if (!this.affectedTests) return "run_affected_tests is not available here";
    try {
      return await this.affectedTests.runNow();
    } catch (e: any) {
      return `The affected tests could not be run: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }

  public async runTest(args: Record<string, unknown>): Promise<string> {
    if (!this.sandboxRunTest) return "run_test is only available in a heal sandbox";
    return this.sandboxRunTest(args);
  }
  /** Results of run_dependency_install already produced this phase (reset by beginPhase). */
  private dependencyInstallMemo = new Map<string, string>();
  /** Install plans the user already approved this phase, so a retry after an edit does not re-ask. */
  private approvedInstallPlans = new Set<string>();

  /**
   * What each stage of this task (discovery, the planner) has been shown of the project's files, so an overlapping read sends only the lines it has not been shown, and a file that
   * changed on disk is forgotten. Reads are counted against the stage set by withReadStage; with none set (the editor, repair) a read is exactly what it was.
   */
  public readonly readLedger: ReadLedger;
  private readStage: string | undefined;

  /** Runs one stage's conversation with its reads recorded in the ledger under that stage's name. The stage starts with nothing shown unless the caller injected something first. */
  public async withReadStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const before = this.readStage;
    this.readStage = stage;
    try {
      return await fn();
    } finally {
      this.readStage = before;
    }
  }

  constructor(
    repoRoot: string,
    config: AgentConfig,
    askFn?: (question: string, fallback: string, kind?: "approval") => Promise<string>
  ) {
    this.repoRoot = path.resolve(repoRoot);
    this.readLedger = new ReadLedger(this.repoRoot);
    this.config = config;
    this.askFn =
      askFn ??
      (async () => (await promptOnce("Your answer: ")).trim());

    // Pull directly from the YAML config safety block
    const rawPatterns = config.safety?.blockedFilePatterns || [
      "*.keystore",
      "*.jks",
      "*.p12",
      "*.pem",
      "*.key",
      ".env",
      "*.env.*",
    ];

    // Convert glob patterns to case-insensitive RegExp
    this.blockedPatterns = rawPatterns.map((p) => {
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`, "i");
    });
  }

  private isSensitivePath(filePath: string): boolean {
    const fileName = path.basename(filePath);
    // The default blockedFilePatterns' "*.env.*" is meant to catch a REAL
    // per-environment secrets file (.env.local, .env.production) — but as a
    // bare glob it ALSO matches the standard, universally-safe TEMPLATE
    // convention (.env.example, .env.sample, ...), which holds variable
    // NAMES only, never real values, and exists specifically to be committed
    // and read. A real task hit this: "document the required env vars in
    // .env.example" was refused outright — ACCESS DENIED on the one file
    // whose entire purpose is safe to write — with no way to complete a
    // wholly legitimate, common request. Checked first and unconditionally
    // (not gated on the default vs. a customized blockedFilePatterns list):
    // these specific suffixes are unambiguous by convention, never real
    // secrets, on any stack — this isn't specific to one project's config.
    if (SAFE_ENV_TEMPLATE_RE.test(fileName)) return false;
    return this.blockedPatterns.some((pattern) => pattern.test(fileName));
  }

  /**
   * Reset the per-phase write budget. Call at the start of each phase.
   *
   * `plannedFiles` is advisory, not a hard allowlist: a legitimate change often
   * needs an adjacent file the planner did not predict (an import, a manifest
   * entry). Blocking those would cause spurious failures. What IS hard-capped
   * is the NUMBER of distinct files one phase may touch — that is what stops a
   * confused repair pass from rewriting half the repository.
   */
  public beginPhase(plannedFiles: string[] = [], maxFiles?: number, phaseName?: string): void {
    this.filesWritten.clear();
    this.referencesShown.clear();
    this.filesInspected.clear();
    this.dependencyInstallMemo.clear();
    this.approvedInstallPlans.clear();
    this.commandMemo.clear();
    this.dependencyRequestMemo.clear();
    this.plannedFiles = plannedFiles.map((p) => p.replace(/\\/g, "/"));
    this.maxFilesPerPhase = maxFiles ?? (this.config as any).limits?.maxFilesPerPhase ?? 0;
    this.currentPhaseName = phaseName;
    this.affectedTests?.reset(); // a new phase: nothing the Editor's test sweep remembered carries over
  }

  /**
   * Which agent's pass is currently running, purely so an edit is logged
   * under the agent that actually made it. The same AgentTools instance
   * serves the initial EDITOR pass and every later REPAIR pass, so a
   * hardcoded label meant a repair's own edits were reported as "[EDITOR]
   * patched …" directly beneath "[REPAIR] Patching file: …" — reading as two
   * different agents when it was only ever one.
   */
  public setActiveAgent(name: string): void {
    this.activeAgent = name;
  }

  public filesWrittenThisPhase(): string[] {
    return [...this.filesWritten];
  }

  /** Every read/search/list/outline target inspected so far this phase, in order. */
  public inspectedThisPhase(): string[] {
    return [...this.filesInspected];
  }

  /**
   * Open the Planner's bounded inspection window for one planning pass.
   *
   * `targetFiles` are the files upstream Discovery actually identified as
   * relevant to this task — the only paths the Planner may read. Clearing the
   * inspected set here means each planning pass gets its own fresh
   * PLANNER_MAX_INSPECTED_FILES budget rather than inheriting whatever an
   * earlier pass spent. Paths are normalized exactly the way registerWrite
   * normalizes them (forward slashes, no "./" prefix) so "src/foo.ts" and
   * "./src/foo.ts" are recognized as the same file and cannot be used to
   * spend the budget twice.
   */
  public beginPlannerInspection(targetFiles: string[] = [], maxFiles?: number): void {
    this.plannerAllowedFiles = new Set((targetFiles ?? []).map((f) => this.normalizeKey(f)));
    this.plannerInspectedFiles.clear();
    this.plannerInspectedRanges.clear();
    this.plannerMaxInspectedFiles = maxFiles ?? PLANNER_MAX_INSPECTED_FILES;
  }

  /** Repo-relative paths the Planner is permitted to open right now. */
  public plannerAllowedPaths(): string[] {
    return [...this.plannerAllowedFiles];
  }

  /** Files the Planner has actually opened so far, in the order it opened them. */
  public plannerInspectedThisPass(): string[] {
    return [...this.plannerInspectedFiles];
  }

  /**
   * The exact readFileBounded (startLine, endLine) calls made so far this
   * pass, per file, in call order — see plannerInspectedRanges' own comment.
   * A file present in plannerInspectedThisPass() but absent (or empty) here
   * was only ever touched via getSymbolDefinition, never readFileBounded.
   */
  public plannerInspectedRangesThisPass(): Map<string, Array<{ start?: number; end?: number }>> {
    return new Map([...this.plannerInspectedRanges].map(([k, v]) => [k, [...v]]));
  }

  /** How many more distinct files the Planner may still open in this pass. */
  public plannerInspectionBudgetLeft(): number {
    return Math.max(0, this.plannerMaxInspectedFiles - this.plannerInspectedFiles.size);
  }

  /** Forward-slash, no "./" prefix — the same normalization registerWrite uses. */
  private normalizeKey(relPath: string): string {
    return String(relPath ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  }

  /**
   * The whole bounded-inspection policy in one place: a Planner read is
   * allowed only if the path is one of the discovery target files AND the
   * pass has not already opened plannerMaxInspectedFiles distinct files.
   *
   * Throws rather than returning a soft error string, because the caller is
   * the Planner itself: a tool result saying "please don't" reads as an
   * invitation to retry the same path, while a thrown error surfaces in the
   * tool-result text as a refusal it has to route around.
   *
   * A file already opened this pass is free to open again — re-reading one
   * target file is not exploration, and charging for it would make the budget
   * depend on call ordering rather than on how much of the codebase the
   * Planner actually looked at.
   */
  private assertPlannerFileAllowed(filePath: string): string {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error(
        "[PLANNER SCOPE] This tool requires a non-empty 'path'. Only this task's discovery target " +
          "files may be inspected."
      );
    }

    const key = this.normalizeKey(filePath);

    // A file Discovery did not list is still a file the project has. Refusing it
    // made the Planner guess about code it knew was there ("its exact API could
    // not be inspected within the permitted discovery targets") and then ask the
    // user about it. The file budget below bounds how much it reads, and the
    // same safe-read check the Editor uses keeps out secrets, blocked folders
    // and anything outside the project, so the list is a starting point, not a
    // wall. There is still no search or directory tool: it can open a file it
    // can name, not sweep the repository.
    if (!this.plannerAllowedFiles.has(key)) {
      let resolved: string;
      try {
        resolved = this.resolveSafeReadPath(key);
      } catch (err: any) {
        throw new Error(`[PLANNER SCOPE] "${key}" cannot be opened: ${err.message}`);
      }
      let isFile = false;
      try {
        isFile = fsSync.statSync(resolved).isFile();
      } catch {
        // not there
      }
      if (!isFile) {
        throw new Error(
          `[PLANNER SCOPE] "${key}" is not a file in this project. Check the path; if the file you need does not ` +
            `exist, say so in the plan rather than guessing at its contents.`
        );
      }
    }

    if (!this.plannerInspectedFiles.has(key) && this.plannerInspectedFiles.size >= this.plannerMaxInspectedFiles) {
      throw new Error(
        `[PLANNER INSPECTION BUDGET] This planning pass has already inspected ${this.plannerInspectedFiles.size} ` +
          `file(s) (limit ${this.plannerMaxInspectedFiles}): ${[...this.plannerInspectedFiles].join(", ")}. ` +
          `No further file may be opened. Write the plan now from what you have already seen, and record any ` +
          `remaining gap as an uncertainty rather than reading more.`
      );
    }

    this.plannerInspectedFiles.add(key);
    return key;
  }

  /**
   * Planner-facing read_file: one file, from the discovery target list only,
   * inside the 3-file budget. Reuses the same path/sensitive-file guards as
   * the Editor's readFile, so the Planner inherits the containment checks
   * rather than a second, weaker copy of them.
   */
  public async readFileBounded(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    const key = this.assertPlannerFileAllowed(filePath);
    const ranges = this.plannerInspectedRanges.get(key) ?? [];
    ranges.push({ start: startLine, end: endLine });
    this.plannerInspectedRanges.set(key, ranges);
    return this.readFile(key, startLine, endLine);
  }

  /**
   * Planner-facing get_symbol_definition: the declaration of one named symbol
   * inside a discovery target file, so confirming an existing signature costs
   * a few hundred tokens instead of the whole file. Still counts against the
   * same file budget, since "which files did the Planner look at" is the
   * quantity being capped — not the number of calls.
   *
   * Best-effort by design: when no declaration for `symbol` is found this
   * returns the file's declaration outline (from getFileOutline) rather than
   * an error, so a slightly-off name still gives the Planner something real
   * to work from instead of a dead end.
   */
  public async getSymbolDefinition(filePath: string, symbol: string): Promise<string> {
    // Validated before assertPlannerFileAllowed deliberately: that call's
    // side effect is spending one file from the inspection budget, and a
    // call that was never going to succeed (no symbol name given) must not
    // burn budget on a file the Planner never actually got to inspect.
    if (typeof symbol !== "string" || symbol.trim() === "") {
      throw new Error(
        "[PLANNER SCOPE] get_symbol_definition requires a non-empty 'symbol' name, e.g. 'patchFile'."
      );
    }
    const key = this.assertPlannerFileAllowed(filePath);

    const name = symbol.trim();
    const content = await this.readFile(key);
    const lines = content.split("\n");

    // A declaration line mentions the symbol AND looks like a declaration —
    // requiring both is what keeps a mere call site (`await agentTools.patchFile(`)
    // from being returned as if it were the definition.
    const declarationRegex = /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fun|struct|impl|public|private|protected|static|final)\b/;
    const start = lines.findIndex(
      (line) => declarationRegex.test(line) && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)
    );

    if (start === -1) {
      const outline = await this.getFileOutline(key);
      return (
        `No declaration for "${name}" found in ${key}. The file's declarations are listed below — ` +
        `use one of those exact names, or read the file to confirm the real API:\n${outline}`
      );
    }

    // Brace-balanced slice: a declaration's body is included when the same
    // line opens a brace, so an interface/class comes back whole rather than
    // as a bare signature the Planner would then have to guess the members of.
    let end = start;
    const firstLine = lines[start];
    if (firstLine.includes("{")) {
      let depth = 0;
      for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        end = i;
        if (depth <= 0) break;
      }
    }

    const MAX_DEFINITION_LINES = 120;
    let body = lines.slice(start, end + 1);
    if (body.length > MAX_DEFINITION_LINES) {
      body = body.slice(0, MAX_DEFINITION_LINES).concat(
        `... [definition truncated at ${MAX_DEFINITION_LINES} lines — read ${key} for the rest]`
      );
    }

    return `${key}:L${start + 1} — ${name}\n${body.join("\n")}`;
  }

  /** Manual follow-ups flagged across the whole run so far, in the order raised. */
  public getManualSteps(): ManualStep[] {
    return [...this.manualSteps];
  }

  public async flagManualStep(args: { step: string; reason: string }): Promise<string> {
    this.manualSteps.push({ step: args.step, reason: args.reason, phase: this.currentPhaseName });
    console.log(`[MANUAL STEP] ${args.step}`);
    return `Recorded. This will be listed for the user at the end of the run; continue with what you CAN do here.`;
  }

  /**
   * Stage a file for deletion at the end of the run. Deliberately NON-
   * destructive: the agent never gets an unlink primitive, so a confused or
   * hallucinating pass cannot destroy a file that still mattered — it can only
   * propose, and the user makes the final call in one consolidated prompt.
   *
   * Path handling is normalized the same way registerWrite does it (forward
   * slashes, no "./" prefix) so the same file staged from two different phases
   * — or staged once as "./src/foo.ts" and once as "src/foo.ts" — collapses to
   * a single entry instead of appearing twice in the confirmation prompt.
   */
  public async stageFileForDeletion(relPath: string, reason?: string): Promise<string> {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new Error("stage_file_for_deletion requires a non-empty 'path'.");
    }
    this.assertNotDeletingMustPass(relPath);

    const key = relPath
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");

    // Reuse the same containment/sensitive-file guards as a read or write, so
    // staging cannot be used to smuggle .env or a path outside the repo into
    // the end-of-run deletion list.
    const fullPath = this.resolveSafePath(key);

    if (!fsSync.existsSync(fullPath)) {
      return (
        `Nothing to stage: "${key}" does not exist on disk. ` +
        `If it was already removed, no action is needed; if you meant a different path, ` +
        `use list_files or search_code to find the real one.`
      );
    }

    const alreadyStaged = this.filesPendingDeletion.has(key);
    this.filesPendingDeletion.add(key);

    // A repeat staging genuinely does not change anything — "the earlier
    // request still stands" — so the reason shown (and stored) here must be
    // the ORIGINAL one, never silently replaced by whatever this later call
    // happened to pass. The reason is only ever recorded on first staging.
    if (alreadyStaged) {
      const existingReason = this.deletionReasons.get(key);
      const note = existingReason ? ` Reason: ${existingReason}` : "";
      return (
        `"${key}" was already staged for deletion this run; the earlier request still stands.${note} ` +
        `Nothing has been deleted — the user confirms all staged deletions in one prompt at the end of the run.`
      );
    }

    if (reason && reason.trim()) this.deletionReasons.set(key, reason.trim());
    const note = reason && reason.trim() ? ` Reason: ${reason.trim()}` : "";
    console.log(`[${this.activeAgent}] ⏳ staged for deletion: ${key}${note}`);
    return (
      `Staged "${key}" for deletion.${note} ` +
      `The file is untouched on disk; the user is asked to confirm all staged deletions ` +
      `in a single prompt at the end of the run. Do not empty or overwrite it in the meantime.`
    );
  }

  /** Paths staged for deletion across the whole run, in insertion order. */
  public getStagedDeletions(): string[] {
    return [...this.filesPendingDeletion];
  }

  /** True when the agent itself created this file during the run (so it is the agent's own scratch, not the user's work). */
  public createdThisRun(relPath: string): boolean {
    return this.agentCreatedFiles.has(relPath.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  /** The panel's judgement of an action that would otherwise ask a person; undefined when no panel (or reviewer) is set. */
  public async reviewAction(a: ActionReview): Promise<ReviewOutcome | undefined> {
    if (!this.actionReviewer) return undefined;
    try {
      return await this.actionReviewer(a);
    } catch {
      return undefined; // a review that fails never allows
    }
  }

  /** The reason recorded for a staged path, if one was given. */
  public getDeletionReason(relPath: string): string | undefined {
    return this.deletionReasons.get(relPath.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  /**
   * Drop every staged deletion. Called after the end-of-run confirmation gate
   * has acted on the list (either deleting or declining), so a later run in the
   * same process cannot inherit stale intents.
   */
  public clearStagedDeletions(): void {
    this.filesPendingDeletion.clear();
    this.deletionReasons.clear();
  }

  /**
   * The budget half of registerWrite, usable BEFORE anything touches disk.
   * Split out because a patch must only be *recorded* as written after the
   * bytes actually land (see patchFile), but the cap must still be able to
   * REFUSE a write up front — checking it after the fact would let the
   * over-budget file be modified on disk and then merely complain.
   */
  private assertWriteBudget(relPath: string): void {
    const key = relPath.replace(/\\/g, "/");
    if (this.filesWritten.has(key)) return;

    if (this.maxFilesPerPhase > 0 && this.filesWritten.size >= this.maxFilesPerPhase) {
      throw new Error(
        `[WRITE BUDGET] This phase has already modified ${this.filesWritten.size} files ` +
          `(limit ${this.maxFilesPerPhase}) and "${relPath}" would be another. ` +
          `If the reported problem is environmental (missing emulator, absent toolchain) it cannot be fixed by editing source — ` +
          `call conclude_task(status='CANNOT_LOCATE') instead. Otherwise the change is too broad for one phase.`
      );
    }
  }

  /** Enforce the per-phase file budget and warn on out-of-plan writes. */
  private registerWrite(relPath: string): void {
    const key = relPath.replace(/\\/g, "/");
    this.writeEpoch++;
    if (this.filesWritten.has(key)) return;

    this.assertWriteBudget(relPath);

    this.filesWritten.add(key);

    if (this.plannedFiles.length > 0) {
      // The focused tests the harness has the Editor write for every change are never in a plan: they are not a stray edit, so they are not warned about.
      const expected = isFocusPath(key) || this.plannedFiles.some((p) => key === p || key.endsWith(`/${p}`) || p.endsWith(`/${key}`));
      if (!expected) {
        console.warn(
          `[SCOPE] ⚠️ "${relPath}" is outside this phase's planned files ` +
            (this.maxFilesPerPhase > 0 ? `(${this.filesWritten.size}/${this.maxFilesPerPhase} used).` : `(${this.filesWritten.size} file(s) written this phase).`)
        );
      }
    }
  }

  private resolveSafePath(filePath: string): string {
    const resolved = path.resolve(this.repoRoot, filePath);

    // Separator-aware containment: "/repo-evil" must not pass as inside "/repo".
    if (resolved !== this.repoRoot && !resolved.startsWith(this.repoRoot + path.sep)) {
      throw new Error(`[ACCESS DENIED] Path escapes repository root: ${filePath}`);
    }

    // Blocked directories (.git, node_modules, build output, .agent, ...).
    // Writing into .git/hooks would be arbitrary code execution on the next commit.
    const blocked = this.config.safety?.blockedDirectories ?? [];
    const segments = path.relative(this.repoRoot, resolved).split(path.sep).filter(Boolean);
    const hit = segments.find((s) => blocked.includes(s));
    if (hit) {
      throw new Error(`[ACCESS DENIED] "${hit}" is a blocked directory and may not be read or written.`);
    }

    if (this.isSensitivePath(resolved)) {
      throw new Error(`[ACCESS DENIED] Access to sensitive file "${path.basename(resolved)}" is strictly prohibited.`);
    }
    return resolved;
  }

  private resolveSafeReadPath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (READABLE_AGENT_METADATA.has(normalized)) {
      const resolved = path.resolve(this.repoRoot, normalized);
      if (!fsSync.existsSync(resolved)) throw new Error(`File not found: ${filePath}`);
      return resolved;
    }
    return this.resolveSafePath(filePath);
  }

  private questionResolver: ((question: string) => Promise<string | null>) | null = null;
  /** Settles a question from the specs, the task and the code before it reaches the user. */
  public setQuestionResolver(fn: ((question: string) => Promise<string | null>) | null): void {
    this.questionResolver = fn;
  }

  public async askUser(question: string, preferred?: string): Promise<string> {
    if (this.questionResolver) {
      try {
        const found = await this.questionResolver(question);
        if (found) {
          console.log(`\n🔍 [ASK] Answered from the project, so the user was not asked: ${question.split("\n")[0].slice(0, 120)}`);
          return found;
        }
      } catch {
        // an unanswered question is simply asked
      }
    }    console.log("\n==========================================");
    console.log(" [USER INTERACTION REQUIRED] ");
    console.log("==========================================");
    console.log(`Agent asks: ${question}\n`);

    // What is answered when nobody does (no terminal, or no answer within the deadline): the default the agent gave, else the most conventional option.
    const given = typeof preferred === "string" ? preferred.trim().slice(0, 300) : "";
    const fallback = given
      ? `Nobody answered, so use your own default: ${given}. State the assumption you made, and continue.`
      : "No human is available to answer (non-interactive session). " + "Choose the most conventional option for this codebase, state the assumption " + "you made, and continue.";

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(`[auto-answered: stdin is not interactive]`);
      return fallback;
    }

    const answer = await this.askFn(question, fallback);
    return answer.trim() || fallback;
  }

  public async deferQuestion(args: { topic: string; question: string; fallbackChosen: string; targetFile: string }): Promise<string> {
    const agentDir = path.join(this.repoRoot, ".agent");
    const qFile = path.join(agentDir, "pending_questions.json");

    await fs.mkdir(agentDir, { recursive: true });
    let existing: PendingQuestion[] = [];
    if (fsSync.existsSync(qFile)) {
      try {
        existing = JSON.parse(await fs.readFile(qFile, "utf-8"));
      } catch {}
    }

    const newEntry: PendingQuestion = {
      id: `dq-${Date.now()}`,
      ...args,
      timestamp: new Date().toISOString(),
    };

    existing.push(newEntry);
    await fs.writeFile(qFile, JSON.stringify(existing, null, 2), "utf-8");

    return `Question deferred successfully. Fallback '${args.fallbackChosen}' recorded for final resolution gate.`;
  }

  public async registerComponent(entry: { name: string; path: string; summary: string; exports?: string[] }): Promise<string> {
    const agentDir = path.join(this.repoRoot, ".agent");
    const mapFile = path.join(agentDir, "repo_map.json");

    await fs.mkdir(agentDir, { recursive: true });
    let map: Record<string, any> = {};
    if (fsSync.existsSync(mapFile)) {
      try {
        map = JSON.parse(await fs.readFile(mapFile, "utf-8"));
      } catch {}
    }

    // Hard clamp to 15 words to prevent token bloat
    const words = entry.summary.trim().split(/\s+/);
    const prunedSummary = words.length > 15 ? words.slice(0, 15).join(" ") + "..." : entry.summary;

    // Merged, not replaced: a re-registration must not wipe what an earlier task
    // confirmed about this file, and must not keep it either once the file has
    // changed (mergeComponentEntry decides by the file's fingerprint).
    map[entry.name] = mergeComponentEntry(
      map[entry.name],
      { path: entry.path, summary: prunedSummary, exports: (entry.exports || []).slice(0, 4) },
      fingerprintOf(this.repoRoot, entry.path.replace(/\\/g, "/"))
    );

    // Keep bounded LRU cache (capped at configured or default 50 entries)
    const keys = Object.keys(map);
    const maxEntries = (this.config as any).memory?.maxEntries || DEFAULT_MAX_ENTRIES;
    if (keys.length > maxEntries) {
      keys.sort((a, b) => (map[a].lastUpdated || 0) - (map[b].lastUpdated || 0));
      delete map[keys[0]];
    }

    await fs.writeFile(mapFile, JSON.stringify(map, null, 2), "utf-8");
    return `Component '${entry.name}' recorded in repo_map.json.`;
  }

  /** Merge a QA setup patch into .agent/qa-setup.json (see qaSetup.ts). */
  public async registerQaSetup(patch: unknown): Promise<string> {
    // Report what THIS call contributed, not the merged file: otherwise an
    // entirely invalid patch would claim success by echoing earlier values.
    const saved = sanitizeQaSetup(patch);
    const hasAnything = Boolean(saved.launchPath || saved.localStorage || saved.cameraImage || saved.uploadFiles || saved.notes || saved.deepLinks || saved.env || saved.mockNotes);
    if (hasAnything) saveQaSetup(this.repoRoot, saved);
    const parts: string[] = [];
    if (saved.launchPath) parts.push(`launchPath ${saved.launchPath}`);
    if (saved.localStorage) parts.push(`${Object.keys(saved.localStorage).length} storage value(s)`);
    if (saved.cameraImage) parts.push(`cameraImage ${saved.cameraImage}`);
    if (saved.uploadFiles) parts.push(`${saved.uploadFiles.length} upload file(s)`);
    if (saved.deepLinks) parts.push(`${saved.deepLinks.length} deep link(s)`);
    if (saved.env) parts.push(`${Object.keys(saved.env).length} variable(s) QA starts the app with`);
    if (saved.mockNotes) parts.push("what is mocked");
    return parts.length > 0
      ? `QA setup saved: ${parts.join(", ")}. Anything invalid (a path outside the repo, a non-relative launchPath, a secret-looking file) was dropped.`
      : "Nothing valid to record — launchPath must start with '/', '?' or '#', file paths must be repo-relative and non-secret.";
  }

  public async registerScreenNav(entry: {
    screen: string;
    file: string;
    reachedFrom?: string;
    isLaunchScreen?: boolean;
    reachedFromScreen?: string;
    reachedViaLabel?: string;
    controls: { label: string; leadsTo: string; leadsToScreen?: string }[];
  }): Promise<string> {
    // A call with a missing screen name used to be stored under the literal
    // key "undefined" and then sat in the map as a phantom screen forever.
    if (isJunkScreenName(entry.screen)) {
      return "Not recorded: `screen` must be the screen's real name.";
    }
    const agentDir = path.join(this.repoRoot, ".agent");
    const mapFile = path.join(agentDir, "nav_map.json");

    await fs.mkdir(agentDir, { recursive: true });
    let map: Record<string, any> = {};
    if (fsSync.existsSync(mapFile)) {
      try {
        map = JSON.parse(await fs.readFile(mapFile, "utf-8"));
      } catch {}
    }

    // Overwrites any prior entry for this screen wholesale, rather than
    // merging control lists — a stale control (a button that got removed or
    // rewired) is worse than a temporarily-incomplete one, and the caller
    // just re-read this screen's current navigation code, so what it reports
    // now is the freshest truth available.
    const prior = map[entry.screen];
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    map[entry.screen] = {
      file: entry.file,
      reachedFrom: entry.reachedFrom || prior?.reachedFrom || "unknown",
      ...(entry.isLaunchScreen === true || (entry.isLaunchScreen === undefined && prior?.isLaunchScreen === true)
        ? { isLaunchScreen: true }
        : {}),
      ...(clean(entry.reachedFromScreen) ?? clean(prior?.reachedFromScreen)
        ? { reachedFromScreen: clean(entry.reachedFromScreen) ?? clean(prior?.reachedFromScreen) }
        : {}),
      ...(clean(entry.reachedViaLabel) ?? clean(prior?.reachedViaLabel)
        ? { reachedViaLabel: clean(entry.reachedViaLabel) ?? clean(prior?.reachedViaLabel) }
        : {}),
      controls: (entry.controls || []).slice(0, 20).map((c) => {
        const to = clean(c.leadsToScreen);
        return to ? { label: c.label, leadsTo: c.leadsTo, leadsToScreen: to } : { label: c.label, leadsTo: c.leadsTo };
      }),
      // QA's record of edges it really walked. A relabeled/removed control just
      // stops matching any edge, so stale keys are inert without pruning.
      // Everything QA itself learned on a device outlives a re-read of the code.
      ...Object.fromEntries(
        ["verifiedInbound", "staleInbound", "observedEdges", "observedLaunch"]
          .filter((k) => prior?.[k] !== undefined)
          .map((k) => [k, prior[k]])
      ),
      lastUpdated: Date.now(),
    };

    // Same bounded LRU cache as repo_map.json above, but with its own, larger
    // default: a real app has far more screens than components worth caching,
    // and evicting one silently breaks every route through it.
    const keys = Object.keys(map);
    const maxEntries = (this.config as any).memory?.maxNavEntries || 200;
    if (keys.length > maxEntries) {
      keys.sort((a, b) => (map[a].lastUpdated || 0) - (map[b].lastUpdated || 0));
      delete map[keys[0]];
    }

    await fs.writeFile(mapFile, JSON.stringify(map, null, 2), "utf-8");
    return `Screen '${entry.screen}' navigation recorded in nav_map.json.`;
  }

  /**
   * `startLine`/`endLine` (1-indexed, inclusive) are the real fix for a file
   * too large to read whole: a byte cap alone always has SOME file it can't
   * fully cover, however high it's set, and a whole-file truncation just
   * hands back "first N bytes" with no way to reach what comes after — the
   * model has to fall back to get_file_outline/search_code and hope the
   * region it actually needs lands inside a symbol/match window. A line
   * range lets it walk a huge file end to end across a few calls instead.
   * The byte cap still applies to the REQUESTED SLICE as a backstop (a
   * single enormous minified line, or a range spanning tens of thousands of
   * lines, could still be too big on its own) — but now narrowing the range
   * further is the model's own next move, not a dead end.
   *
   * The returned slice is the file's own bytes, untouched — no inline line-
   * number prefixes — so a later patch_file search string copied straight
   * out of this response still matches the real file exactly. The range is
   * only ever reported in a bracketed header/footer note, the same
   * convention the existing truncation message already uses.
   */
  public async readFile(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    const fullPath = this.resolveSafeReadPath(filePath);
    this.filesInspected.add(filePath.replace(/\\/g, "/"));
    // Binary guard: a NUL byte in the first 4 KB means this is not text, and
    // loading e.g. a .dll or .png as UTF-8 would only inject noise.
    const stat = await fs.stat(fullPath);
    const probe = Buffer.alloc(Math.min(4096, stat.size));
    if (probe.length > 0) {
      const fh = await fs.open(fullPath, "r");
      try {
        await fh.read(probe, 0, probe.length, 0);
      } finally {
        await fh.close();
      }
      if (probe.includes(0)) {
        return `[BINARY FILE — ${filePath} (${stat.size} bytes) cannot be read as text. Do not retry; use a command or tool that understands the format.]`;
      }
    }
    const raw = await fs.readFile(fullPath, "utf-8");
    // Very long lines (minified bundles, inline SVG paths, base64 blobs) are
    // clamped: nobody can edit or reason over a 50,000-character line.
    const MAX_LINE = 2000;
    let clamped = 0;
    const content = raw.includes("\n") || raw.length <= MAX_LINE
      ? raw
          .split("\n")
          .map((l) => {
            if (l.length <= MAX_LINE) return l;
            clamped++;
            return `${l.slice(0, 200)}...[line truncated, ${l.length} chars]`;
          })
          .join("\n")
      : (clamped++, `${raw.slice(0, 200)}...[line truncated, ${raw.length} chars]`);
    const clampNote = clamped > 0 ? `\n\n[${clamped} very long line(s) were shortened; use search_code to locate what you need.]` : "";
    const cap = this.config.limits?.maxFileBytes ?? 60_000;

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const total = lines.length;
      // Clamped into range rather than erroring on a slightly-off guess
      // (e.g. endLine past the real end of a shorter-than-expected file) —
      // a clamped, still-useful result beats a hard failure here.
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(total, endLine ?? total);
      if (start > total) {
        return `[${filePath} has only ${total} line(s) total — the requested range starts past the end of the file.]`;
      }
      if (start > end) {
        return `[Invalid range for ${filePath}: startLine (${start}) is after endLine (${end}).]`;
      }
      // Lines this stage has already been shown are not sent again (only the part it has not seen is), unless the file changed since.
      const stage = this.readStage;
      const key = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
      if (stage) {
        const todo = this.readLedger.unseen(stage, key, start, end);
        if (todo.length === 0) {
          return `[${filePath}: lines ${start}-${end} were already shown to you earlier in this conversation and the file has not changed, so they are not sent again.]`;
        }
        if (!(todo.length === 1 && todo[0][0] === start && todo[0][1] === end)) {
          const body = todo.map(([a, b]) => `[lines ${a}-${b}]\n${lines.slice(a - 1, b).join("\n")}`).join("\n...\n");
          if (body.length <= cap) {
            for (const [a, b] of todo) this.readLedger.record(stage, key, a, b);
            return `[${filePath}: showing lines ${todo.map(([a, b]) => `${a}-${b}`).join(", ")} of ${total} total; the rest of ${start}-${end} was already shown above]\n${body}${clampNote}`;
          }
        }
      }
      const slice = lines.slice(start - 1, end).join("\n");
      if (slice.length > cap) {
        return (
          slice.slice(0, cap) +
          `\n\n... [truncated: lines ${start}-${end} of ${filePath} (${total} lines total) are ${slice.length} bytes, ` +
          `showing the first ${cap}. Request a narrower line range to see the rest.]`
        );
      }
      if (stage) this.readLedger.record(stage, key, start, end);
      return `[${filePath}: showing lines ${start}-${end} of ${total} total]\n${slice}${clampNote}`;
    }

    // Whole-file read: one this stage has already been shown, and that has not changed, is not sent again.
    const wholeStage = this.readStage;
    const wholeKey = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const wholeLines = content.split("\n").length;
    if (wholeStage && this.readLedger.unseen(wholeStage, wholeKey, 1, wholeLines).length === 0) {
      return `[${filePath}: all ${wholeLines} lines were already shown to you earlier in this conversation and the file has not changed, so it is not sent again.]`;
    }
    // Whole-file read, unchanged except the hint now also points at ranges.
    if (content.length > cap) {
      return (
        content.slice(0, cap) +
        `\n\n... [truncated: ${filePath} is ${content.length} bytes, showing first ${cap}. ` +
        `Use startLine/endLine to read a specific range of this file, or get_file_outline/search_code to locate one.]`
      );
    }
    // Recorded as shown only when every line really is in what is returned (not cut, no line shortened).
    if (wholeStage && clamped === 0) this.readLedger.record(wholeStage, wholeKey, 1, wholeLines);
    return content + clampNote;
  }

  /** Batched read_file: one round trip for several files instead of one call each. */
  public async readFiles(paths: string[]): Promise<string> {
    const MAX_BATCH = 12;
    const capped = paths.slice(0, MAX_BATCH);
    const overflow = paths.length - capped.length;

    const parts = await Promise.all(
      capped.map(async (p) => {
        try {
          return `=== ${p} ===\n${await this.readFile(p)}`;
        } catch (err: any) {
          return `=== ${p} ===\n[ERROR reading file: ${err.message}]`;
        }
      })
    );

    if (overflow > 0) {
      parts.push(
        `\n... ${overflow} more path(s) were not read — batch capped at ${MAX_BATCH} files per call. ` +
          `Issue a follow-up read_file call for the rest.`
      );
    }
    return parts.join("\n\n");
  }

  private readonly sessionStart = Date.now();

  /** Removes the scratch files this session left (see scratch.ts); returns what was removed. */
  public cleanScratchFiles(): string[] {
    return cleanScratch(this.repoRoot, this.agentCreatedFiles, this.sessionStart);
  }

  private relOf(filePath: string): string {
    return path.relative(this.repoRoot, path.resolve(this.repoRoot, filePath)).replace(/\\/g, "/");
  }

  /**
   * The tests a fix is FOR are its spec, so what the failing tests ASSERT may not change, but nothing else about their file is locked: a fix that changes a
   * hook's signature or needs a new mock must be free to update the setup (shared by every test in a big file), and to add new tests. Checked on the text the
   * file WOULD hold, before it is written, so the Editor is told at once what it may not do; QA checks again afterwards (a command could change the file).
   * An ordinary task has no must-pass files, so nothing here applies to it.
   */
  private assertMustPassIntact(filePath: string, newText: string): void {
    const rel = this.relOf(filePath);
    if (!isMustPass(rel)) return;
    const problem = lockedProblem(rel, newText);
    if (problem) throw new Error(refusalFor(rel, problem));
  }

  /** Deleting a must-pass test file removes the very tests the fix is for: refused, whatever else is allowed. */
  private assertNotDeletingMustPass(filePath: string): void {
    const rel = this.relOf(filePath);
    if (isMustPass(rel)) {
      throw new Error(refusalFor(rel, "it may not be deleted (it holds the failing tests this fix has to make pass)"));
    }
  }

  public async writeFile(filePath: string, content: string): Promise<string> {
    this.assertMustPassIntact(filePath, content);
    // A NEW one-off report, summary or helper script at the project root is not part of the project: it goes in the scratch folder, which is
    // never committed and is emptied when the task ends. A file that already exists, or one anywhere else, is written where it was asked.
    const redirect = scratchTarget(filePath);
    if (redirect && !fsSync.existsSync(path.resolve(this.repoRoot, filePath))) {
      const target = path.join(this.repoRoot, redirect);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
      this.agentCreatedFiles.add(redirect);
      console.log(`[${this.activeAgent}] + created ${redirect}  (scratch)`);
      return (
        `Successfully wrote ${content.length} characters to ${redirect}. "${filePath}" looked like a scratch file (a report, summary or one-off helper), ` +
        `so it was put in ${SCRATCH_DIR}/ instead of the project: that folder is never committed and is emptied when the task ends. ` +
        `Use "${redirect}" as its path from now on (for example: node ${redirect}).`
      );
    }
    const fullPath = this.resolveSafePath(filePath);
    // Checked before the write so "created" vs "overwrote" reflects what was
    // actually on disk a moment ago, not a guess made after the fact.
    const existedBefore = fsSync.existsSync(fullPath);
    const before = existedBefore ? await fs.readFile(fullPath, "utf-8").catch(() => "") : "";
    this.registerWrite(filePath);
    if (!existedBefore) {
      // Remember what the agent itself brought into the tree: an approved
      // command's fingerprint reacts to hook-like files appearing (see
      // commandFingerprint's tripwire).
      const toRel = (abs: string) => path.relative(this.repoRoot, abs).replace(/\\/g, "/");
      this.agentCreatedFiles.add(toRel(fullPath));
      for (let d = path.dirname(fullPath); d.length > this.repoRoot.length && !fsSync.existsSync(d); d = path.dirname(d)) {
        this.agentCreatedDirs.add(toRel(d));
      }
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    const stat = existedBefore ? lineDiffStat(before, content) : { added: splitLines(content).length, removed: 0 };
    console.log(`[${this.activeAgent}] ${existedBefore ? "✎ rewrote" : "+ created"} ${filePath}  ${formatDiffStat(stat)}`);
    const changeId = crypto.randomUUID();
    diffStore.record(changeId, filePath, buildDiffLines(before, content));
    events.emit({
      type: "file.write",
      agent: this.activeAgent,
      path: filePath,
      created: !existedBefore,
      added: stat.added,
      removed: stat.removed,
      changeId,
    });
    return `Successfully wrote ${content.length} characters to ${filePath}`;
  }

  public async patchFile(filePath: string, search: string, replace: string): Promise<string> {
    const fullPath = this.resolveSafePath(filePath);
    // Budget checked here (nothing on disk has changed yet), but the write is
    // only RECORDED after fs.writeFile below succeeds — see that call.
    this.assertWriteBudget(filePath);
    const raw = await fs.readFile(fullPath, "utf-8");

    // Normalise line endings so a CRLF file still matches an LF search block.
    const hadCrlf = raw.includes("\r\n");
    const content = raw.replace(/\r\n/g, "\n");
    const find = search.replace(/\r\n/g, "\n");
    const repl = replace.replace(/\r\n/g, "\n");

    if (!content.includes(find)) {
      throw new Error(`Search block not found in ${filePath}. Check indentation and whitespace.`);
    }

    const matches = content.split(find).length - 1;
    if (matches > 1) {
      throw new Error(
        `Ambiguous patch: "${filePath}" contains ${matches} occurrences of the search block. ` +
          `Include more surrounding context so exactly one location matches.`
      );
    }

    // Function form: prevents $&, $1, $' in the replacement from being expanded
    // as regex substitution patterns and silently corrupting the file.
    const patched = content.replace(find, () => repl);
    this.assertMustPassIntact(filePath, patched); // checked on what the file WOULD hold, before a byte is written
    await fs.writeFile(fullPath, hadCrlf ? patched.replace(/\n/g, "\r\n") : patched, "utf-8");
    // Registered only AFTER the bytes are on disk: registering up front meant a
    // patch that failed to find its search block (or hit the write budget) had
    // already been counted in filesWrittenThisPhase(), so the phase looked like
    // it had changed a file it never touched — and the "no file changes" guard
    // downstream was defeated by the very failure it exists to catch.
    this.registerWrite(filePath);
    const stat = lineDiffStat(find, repl);
    console.log(`[${this.activeAgent}] ✎ patched ${filePath}  ${formatDiffStat(stat)}`);
    const changeId = crypto.randomUUID();
    diffStore.record(changeId, filePath, buildDiffLines(find, repl));
    events.emit({
      type: "file.write",
      agent: this.activeAgent,
      path: filePath,
      created: false,
      added: stat.added,
      removed: stat.removed,
      changeId,
    });
    return `Successfully patched ${filePath}`;
  }

  /** Lists already handed to the agent this phase (by key), so the same list is never sent back twice. */
  private referencesShown = new Set<string>();

  /** Tests that still name something this phase's edits removed or changed (see testReferences.ts). */
  public currentTestReferences(): Reference[] {
    try {
      return staleTestReferences(this.repoRoot, this.filesWrittenThisPhase(), [...this.filesPendingDeletion]);
    } catch {
      return [];
    }
  }

  /** Backs the find_test_references tool. */
  public findTestReferences(): string {
    const refs = this.currentTestReferences();
    if (refs.length === 0) {
      return "No test names anything your edits removed or changed (searched the whole test suite for the texts, routes and names on the lines you removed). Tests that build a label from a variable are not found by this: the QA gate still runs them.";
    }
    this.referencesShown.add(referencesKey(refs));
    return (
      renderReferences(refs) +
      "\n\nUpdate only the lines that refer to what you changed, to match the change you made. Do not weaken or delete an assertion about behaviour that should stay the same. " +
      "If a test is the SPEC for a fix you were asked to make (it fails today and must pass), your change is what is wrong, not the test."
    );
  }

  /** At the point the agent says it is finished: the list, if there is one it has not yet been shown (shown once per distinct list). */
  public unseenTestReferences(): string | undefined {
    const refs = this.currentTestReferences();
    if (refs.length === 0) return undefined;
    const key = referencesKey(refs);
    if (this.referencesShown.has(key)) return undefined;
    this.referencesShown.add(key);
    return renderReferences(refs) + "\n\nUpdate the lines that refer to what you changed, then conclude again.";
  }

  public setBuildCheckRunner(fn: (agentLabel: string) => Promise<string>): void {
    this.buildCheckRunner = fn;
  }

  /** Backs the run_build_check tool — see buildCheckRunner's own comment.
   *  Passes activeAgent through so the check's own console output is
   *  attributed to whichever agent actually called it (EDITOR or REPAIR),
   *  not hardcoded to one of them regardless of who's really running. */
  public async runBuildCheck(): Promise<string> {
    if (!this.buildCheckRunner) {
      throw new Error("[BUILD CHECK] Not available in this context — no build check runner was configured.");
    }
    return this.buildCheckRunner(this.activeAgent);
  }

  public setDependencyInstallRunner(
    fn: (
      writtenFiles: string[],
      approve: (planSummary: string) => Promise<boolean>,
      memo: Map<string, string>
    ) => Promise<string>
  ): void {
    this.dependencyInstallRunner = fn;
  }

  /** Backs the run_dependency_install tool — see dependencyInstallRunner's
   *  own comment. Approval reuses the same askFn every other mid-task
   *  question in this class already goes through (free-text, same as
   *  ask_user) — a plain "yes"/"y" approves, anything else declines. */
  public async runDependencyInstall(): Promise<string> {
    if (!this.dependencyInstallRunner) {
      throw new Error("[DEPENDENCY INSTALL] Not available in this context — no dependency install runner was configured.");
    }
    const approve = async (planSummary: string): Promise<boolean> => {
      // Already said yes to this exact command this phase: do not ask again
      // just because the model edited the manifest and is re-running it.
      if (this.approvedInstallPlans.has(planSummary)) return true;
      // Before a person is asked: the security panel judges the plan (commandPanel.ts). All judges safe = it runs; otherwise the person sees what they said.
      let panelNote = "";
      if (this.actionReviewer) {
        try {
          const review = await this.actionReviewer({ kind: "dependency-plan", label: planSummary, purpose: `${this.activeAgent} needs dependencies installed`, details: planSummary, repoRoot: this.repoRoot });
          if (review.allow) {
            console.log(`[SECURITY] ✔ Allowed without asking: ${planSummary} — ${review.why}`);
            this.approvedInstallPlans.add(planSummary);
            return true;
          }
          panelNote = review.why;
          console.log(`[SECURITY] ✋ Needs a person: ${planSummary} — ${review.why}`);
        } catch {
          // a review that fails never allows
        }
      }
      const question = `${this.activeAgent} wants to run: ${planSummary}${panelNote ? `\nSecurity review: ${panelNote}` : ""}\nApprove? (yes/no)`;
      // Same banner askUser prints: askFn's own terminal prompt is just
      // "Your answer: ", so without this the question text only ever reached
      // a paired phone and the terminal showed a bare, unexplained prompt.
      console.log("\n==========================================");
      console.log(" [USER INTERACTION REQUIRED] ");
      console.log("==========================================");
      console.log(`${question}\n`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`[auto-declined: stdin is not interactive]`);
        return false;
      }
      const answer = await this.askFn(question, "no", "approval");
      const normalized = answer.trim().toLowerCase();
      const approved = normalized === "yes" || normalized === "y";
      if (approved) this.approvedInstallPlans.add(planSummary);
      return approved;
    };
    return this.dependencyInstallRunner(this.filesWrittenThisPhase(), approve, this.dependencyInstallMemo);
  }

  private markCleared(ecosystem: Ecosystem, name: string, facts: import("./dependencyFacts.js").PackageFacts): void {
    const lower = name.toLowerCase();
    const forms = new Set([lower]);
    if (ecosystem === "pypi") {
      forms.add(lower.replace(/[_.]+/g, "-"));
      forms.add(lower.replace(/[-.]+/g, "_"));
    }
    for (const f of forms) {
      this.clearedPackages.add(f);
      this.clearedFacts.set(f, { ecosystem, facts });
    }
  }

  /**
   * After an approved add command succeeded: which version actually landed,
   * and does it pass the same checks the name did? Read from the project's
   * own files (never the model's say-so).
   */
  private async verifyAddedPackages(
    names: string[],
    before: Map<string, string>,
    dirs: string[]
  ): Promise<string> {
    const lines: string[] = [];
    for (const name of names) {
      const info = this.clearedFacts.get(name.toLowerCase());
      if (!info) {
        lines.push(`[VERSION UNCHECKED] ${name}: no registry facts are held for it.`);
        continue;
      }
      const known = new Set(info.facts.versions.map((v) => v.version));
      const found = findInstalledVersions({ ecosystem: info.ecosystem, name, known, before, dirs });
      if (found.versions.length === 0) {
        lines.push(
          `[VERSION UNVERIFIED] ${name}: could not tell which version was installed from the project's files. ` +
            `Call flag_manual_step so the user confirms the version that landed in the manifest.`
        );
        continue;
      }
      for (const version of found.versions) {
        const vf = info.facts.versions.find((v) => v.version === version);
        const problems: string[] = [];
        if (vf?.yanked) problems.push("it has been yanked");
        if (vf?.deprecated) problems.push(`it is deprecated (${vf.deprecated.slice(0, 120)})`);
        if (vf?.publishedAt) {
          const ageDays = (Date.now() - Date.parse(vf.publishedAt)) / 86_400_000;
          if (ageDays < 7) problems.push(`it was published only ${Math.max(0, Math.floor(ageDays))} day(s) ago`);
        }
        const vulns = await lookupVulnerabilities(info.ecosystem, name, version, this.factsFetch);
        if (vulns.checked && vulns.ids.length > 0) problems.push(`known advisories: ${vulns.ids.slice(0, 5).join(", ")}`);
        if (problems.length > 0) {
          const text =
            `[VERSION ATTENTION] ${name}@${version} (read from ${found.source}): ${problems.join("; ")}. ` +
            `Do not build on it silently: call flag_manual_step so the user decides, or pick another version.`;
          console.log(`\n⚠️  ${text}\n`);
          lines.push(text);
        } else {
          lines.push(
            `[VERSION OK] ${name}@${version} (read from ${found.source}${vf?.publishedAt ? `; published ${vf.publishedAt.slice(0, 10)}` : ""}` +
              `${vulns.checked ? "; no known advisories" : "; advisory lookup unavailable"}).`
          );
        }
      }
    }
    return lines.join("\n");
  }

  public setFactsFetch(fn: FetchFn): void {
    this.factsFetch = fn;
  }

  /**
   * Backs request_dependency: registry facts for a package the model wants to
   * add, and the version the policy picks. Read-only. The model supplies the
   * name and the reason; everything it is told back comes from the registry.
   */
  public async requestDependency(args: {
    ecosystem?: unknown;
    name?: unknown;
    reason?: unknown;
    version?: unknown;
  }): Promise<string> {
    const ecosystem = String(args.ecosystem ?? "").toLowerCase() as Ecosystem;
    if (!ECOSYSTEMS.includes(ecosystem)) {
      return `Unknown ecosystem "${String(args.ecosystem ?? "")}". Use one of: ${ECOSYSTEMS.join(", ")}.`;
    }
    const name = String(args.name ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
    const requested = typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;

    const memoKey = `${ecosystem}:${name}@${requested ?? ""}`;
    const earlier = this.dependencyRequestMemo.get(memoKey);
    if (earlier !== undefined) return `${earlier}\n(Same answer as your earlier request this phase.)`;

    const facts = await lookupPackage(ecosystem, name, this.factsFetch);
    const choice = await chooseVersionWithDates(facts, this.factsFetch, { requested });

    const assessedVersion = choice.version;
    const chosen = facts.versions.find((v) => v.version === assessedVersion);
    const vulns =
      assessedVersion && facts.exists && !facts.lookupError
        ? await lookupVulnerabilities(ecosystem, name, assessedVersion, this.factsFetch)
        : undefined;
    let assessment = assessPackage(facts, chosen, vulns);
    if (ecosystem === "maven" && assessment.level !== "block" && !facts.lookupError) {
      // A Maven artifact goes into a Gradle build, i.e. native code. Even a
      // safe one can be the wrong architectural choice, so a person decides.
      assessment = {
        level: "confirm",
        warnings: [
          { level: "confirm", text: "adds a native Android (Gradle) dependency; a safe package can still be the wrong approach" },
          ...assessment.warnings,
        ],
      };
    }

    // A name one or two keystrokes from a very popular package is how a look-alike gets installed; the registry's facts cannot say so. And a package with a known advisory is never
  // waved through by a model. Either one is put to a PERSON, whatever the security judges would say.
  const lookAlike = facts.exists && assessment.level !== "block" ? lookAlikeOf(ecosystem, name) : undefined;
  const personOnly: string[] = [];
  if (lookAlike) {
    personOnly.push(`the name looks like "${lookAlike}", a very popular package: a look-alike name is how a malicious package gets installed`);
    assessment = { level: "confirm", warnings: [{ level: "confirm", text: personOnly[0] }, ...assessment.warnings] };
  }
  if (vulns?.checked && vulns.ids.length > 0) personOnly.push("it has a known security advisory");

  const head = `[${assessment.level === "block" ? "REFUSED" : facts.lookupError ? "UNVERIFIED" : "VERIFIED"}] ${ecosystem}:${name}`;
    const lines: string[] = [head];
    const warn = assessment.warnings.map((w) => `  - ${w.text}`);

    let outcome: string;
    if (assessment.level === "block") {
      outcome = [...lines, ...warn, `Do not add this dependency.`].join("\n");
    } else if (facts.lookupError) {
      outcome = [
        ...lines,
        ...warn,
        `Do not invent a version. If you must add it, reuse a version this project already uses for related ` +
          `packages, or flag_manual_step so the user can confirm it.`,
      ].join("\n");
    } else {
      const facts2 = [
        `${facts.versions.length} release(s)`,
        facts.firstPublishedAt ? `first published ${facts.firstPublishedAt.slice(0, 10)}` : undefined,
        facts.weeklyDownloads !== undefined ? `${facts.weeklyDownloads} downloads last week` : undefined,
        facts.totalDownloads !== undefined ? `${facts.totalDownloads} total downloads` : undefined,
        vulns?.checked ? `${vulns.ids.length} known advisor${vulns.ids.length === 1 ? "y" : "ies"}` : undefined,
      ].filter(Boolean);
      const body = [
        ...lines,
        ...(choice.version ? [`Use version ${choice.version} — ${choice.reason}.`] : [`No version chosen — ${choice.reason}.`]),
        `To add it, prefer the ecosystem's own add command through run_project_command (e.g. ` +
          `\`npm install <name> --ignore-scripts\`, \`npx expo install <name> -- --ignore-scripts\` (Expo needs the \`--\` ` +
          `before flags meant for the package manager), \`cargo add <name>\`, \`dotnet add package <name>\`, ` +
          `\`pip install --only-binary=:all: <name>\`, \`go get <module>\`): it picks a version compatible with ` +
          `this project, and the version that lands is checked afterwards. Write a version into a manifest by hand ` +
          `only when no add command exists (e.g. build.gradle); then use the version above.`,
        `Facts: ${facts2.join("; ")}.`,
        ...(warn.length ? ["Warnings:", ...warn] : []),
      ];

      let cleared = true;
      let panelCleared = false;
      let packagePanelNote = "";
      if (assessment.level === "confirm" && this.actionReviewer && personOnly.length === 0) {
        try {
          const review = await this.actionReviewer({
            kind: "package",
            label: `${ecosystem} package "${name}" ${choice.version}`,
            purpose: reason ?? "",
            details: [`Facts: ${facts2.join("; ")}.`, ...(warn.length ? ["Warnings:", ...warn] : [])].join("\n"),
            repoRoot: this.repoRoot,
          });
          if (review.allow) {
            panelCleared = true;
            console.log(`[SECURITY] ✔ Allowed without asking: ${name} ${choice.version} — ${review.why}`);
            body.push(`The security panel approved adding it despite the warnings: ${review.why}`);
          } else {
            packagePanelNote = review.why;
            console.log(`[SECURITY] ✋ Needs a person: ${name} ${choice.version} — ${review.why}`);
          }
        } catch {
          // a review that fails never allows
        }
      }
      if (assessment.level === "confirm" && !panelCleared) {
        const question =
          `${this.activeAgent} wants to add ${ecosystem} package "${name}" ${choice.version}` +
          `${reason ? ` (${reason})` : ""}.\nThings worth a look:\n${warn.join("\n")}${packagePanelNote ? `\nSecurity review: ${packagePanelNote}` : ""}\nAdd it anyway? (yes/no)`;
        console.log("\n==========================================");
        console.log(" [USER INTERACTION REQUIRED] ");
        console.log("==========================================");
        console.log(`${question}\n`);
        let allowed = false;
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const answer = (await this.askFn(question, "no", "approval")).trim().toLowerCase();
          allowed = answer === "yes" || answer === "y";
        } else {
          console.log(`[auto-declined: stdin is not interactive]`);
        }
        cleared = allowed;
        body.push(
          allowed
            ? `The user approved adding it despite the warnings.`
            : `The user did NOT approve it (or nobody was available). Do not add it; choose an alternative.`
        );
      }
      if (cleared) this.markCleared(ecosystem, name, facts);
      outcome = body.join("\n");
    }

    this.dependencyRequestMemo.set(memoKey, outcome);
    return outcome;
  }

  /**
   * Backs the run_project_command tool: a model-chosen command, run under the
   * generic policy in commandPolicy.ts. The model supplies the knowledge of
   * what to run; nothing here knows about any one ecosystem.
   *
   * Order matters: refuse what policy forbids, then check the program is even
   * installed (so a missing tool never costs the user an approval prompt),
   * then ask, then run.
   */
  public async runProjectCommand(args: { command?: unknown; cwd?: unknown; purpose?: unknown }): Promise<string> {
    const command = typeof args.command === "string" ? args.command : "";
    const cwdArg = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;
    const purpose = typeof args.purpose === "string" ? args.purpose.trim().slice(0, 200) : "";

    const decision = evaluateCommand(command, {
      repoRoot: this.repoRoot,
      cwd: cwdArg,
      approvals: this.commandApprovals,
      clearedPackages: this.clearedPackages,
      agentCreated: { files: [...this.agentCreatedFiles], dirs: [...this.agentCreatedDirs], trusted: this.plannedFiles },
    });
    if (decision.verdict === "deny") return `Not run — ${decision.reason}.`;

    const label = describeCommand(decision.argv, decision.cwdRel);
    const memoKey = `${JSON.stringify([decision.argv, decision.cwdRel])}#${this.writeEpoch}`;
    const earlier = this.commandMemo.get(memoKey);
    if (earlier !== undefined) {
      return (
        `Not re-run — this exact command already ran and nothing in the project changed since.\n` +
        `Its result was:\n${earlier}\nChange something (or the environment) before calling it again.`
      );
    }

    const env = javaAwareEnv(probeJava());
    const found = resolveExecutable(decision.argv[0], decision.cwd, env);
    if (!found) {
      return (
        `Not run — \`${decision.argv[0]}\` was not found (looked in ${decision.cwdRel || "the project root"} and on ` +
        `PATH). It is probably not installed. Do not retry it: report this as a manual step so the user can ` +
        `install it.`
      );
    }

    // A program the project does not have (npx for something that is not installed): there is nothing for a person to decide, because the answer is "use what the
    // project has". It is declined with what the project has, so the Editor corrects itself, BEFORE any judge is asked (three model calls for a program that is not
    // even installed would be wasted). Asked again for the same program, the judges and a person decide.
    if (decision.verdict === "ask") {
      const missing = missingTool(decision.argv, this.repoRoot);
      if (missing && !this.missingToolRefused.has(missing.toLowerCase())) {
        this.missingToolRefused.add(missing.toLowerCase());
        console.log(`[SECURITY] ✋ Not run, and no one needs to be asked: ${label} — "${missing}" is not installed in this project. The Editor is told what is.`);
        return missingToolMessage(missing, this.repoRoot);
      }
    }

    // Before a person is asked: a security model reads what is being run (a script in full) and clears what is plainly harmless. Destructive,
    // network, secret-reading, port-opening or steering text, and anything the review cannot settle, still goes to the person.
    let reviewNote = "";
    let clearedByReview = false;
    if (decision.verdict === "ask" && (decision.risk === "normal" || this.reviewerCoversElevated) && this.commandReviewer) {
      try {
        const review = await this.commandReviewer({
          argv: decision.argv,
          label,
          purpose,
          cwd: decision.cwd,
          repoRoot: this.repoRoot,
          created: [...this.agentCreatedFiles],
          notes: [
            ...(decision.risk === "elevated" && decision.elevatedBecause ? [`needs extra care: ${decision.elevatedBecause}`] : []),
            ...(decision.changedSinceApproval ? ["it was approved before, but files it runs have changed since"] : []),
            ...(decision.nativeProgram ? ["it is a compiled program, not a script"] : []),
          ],
        });
        if (review.allow) {
          clearedByReview = true;
          console.log(`[SECURITY] ✔ Allowed without asking: ${label} — ${review.why}`);
        } else {
          reviewNote = review.why;
          console.log(`[SECURITY] ✋ Needs a person: ${label} — ${review.why}`);
        }
      } catch {
        // a review that fails never allows
      }
    }

    if (decision.verdict === "ask" && !clearedByReview) {
      const lines = [
        `${this.activeAgent} wants to run a command:`,
        `  ${label}`,
        ...(purpose ? [`Why: ${purpose}`] : []),
        ...(reviewNote ? [`Security review: ${reviewNote}`] : []),
        ...(decision.changedSinceApproval
          ? [`Note: this was approved before, but files it runs (scripts, build files, config it loads) have changed since.`]
          : []),
        ...(decision.nativeProgram ? [await describeBinary(found)] : []),
        ...(decision.risk === "elevated"
          ? [`Needs extra care: ${decision.elevatedBecause}. You will be asked every time.`]
          : [`Approving remembers this exact command for this project.`]),
        `Approve? (yes/no)`,
      ];
      const question = lines.join("\n");
      console.log("\n==========================================");
      console.log(" [USER INTERACTION REQUIRED] ");
      console.log("==========================================");
      console.log(`${question}\n`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`[auto-declined: stdin is not interactive]`);
        return `Not run — nobody was available to approve: ${label}. Report it as a manual step.`;
      }
      const answer = (await this.askFn(question, "no", "approval")).trim().toLowerCase();
      if (answer !== "yes" && answer !== "y") {
        const declined =
          `Not run — the user declined: ${label}. Do not ask again; continue without it or report it as a ` +
          `manual step.`;
        this.commandMemo.set(memoKey, declined);
        return declined;
      }
      if (decision.risk === "normal") this.commandApprovals.remember(this.repoRoot, decision.argv, decision.cwdRel, decision.fingerprint);
    }

    const addsPackages = decision.addsPackages;
    const snapshotDirsList = [...new Set([decision.cwd, this.repoRoot])];
    const beforeSnapshot = addsPackages ? snapshotDirs(snapshotDirsList) : new Map<string, string>();

    console.log(`[${this.activeAgent}] ⚙️ Running: ${label}`);
    // Package adds also get script-skipping from the environment, so a wrapper
    // CLI (e.g. `expo install`) that drops or mis-forwards the flag cannot
    // turn the add into a run of the package's install scripts.
    const runEnv: NodeJS.ProcessEnv = addsPackages
      ? { ...env, npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false", PIP_ONLY_BINARY: ":all:" }
      : env;
    const result = await runResolvedCommand(found, decision.argv.slice(1), {
      cwd: decision.cwd,
      env: runEnv,
      wrap: winSafeCommand,
    });
    const headline = result.ok
      ? `[PASS] ${label}`
      : result.timedOut
        ? `[FAIL: timed out] ${label}`
        : `[FAIL: exit ${result.code}] ${label}`;
    const text = `${headline}\n${result.output}`;
    // A failure is remembered so an identical retry on an unchanged tree is
    // answered instantly instead of re-running (and re-asking about) it.
    if (!result.ok) this.commandMemo.set(memoKey, text);
    // Only a command that reached here through the approval store (just
    // approved, or approved earlier) is recorded, so read-only probes and
    // elevated one-offs stay out of the project's "ran successfully" list.
    if (result.ok && decision.risk === "normal") {
      this.commandApprovals.markSucceeded(this.repoRoot, decision.argv, decision.cwdRel, decision.fingerprint);
    }
    if (result.ok && addsPackages && addsPackages.length > 0) {
      const check = await this.verifyAddedPackages(addsPackages, beforeSnapshot, snapshotDirsList);
      return check ? `${text}\n\n${check}` : text;
    }
    return text;
  }

  /**
   * Search via argv arrays only — the pattern is never interpolated into a
   * shell string, so a model-supplied pattern cannot execute commands.
   * Prefers `git grep` (respects .gitignore), falls back to `grep`, and
   * finally to fixed-string (-F) matching.
   */
  public async searchCode(pattern: string, subPath?: string, caseSensitive = false): Promise<string> {
    const { pattern: cleaned, caseSensitive: effectiveCaseSensitive } = normalizeSearchPattern(
      pattern,
      caseSensitive
    );
    this.filesInspected.add(`search:"${cleaned}"${subPath ? ` in ${subPath}` : ""}`);
    const targetDir = subPath ? this.resolveSafePath(subPath) : this.repoRoot;
    const maxResults = this.config.limits?.maxSearchResults ?? 100;
    const ci = effectiveCaseSensitive ? [] : ["-i"];

    // -E first (POSIX ERE, what the model's patterns are written for), then the
    // same pattern as -F fixed strings: PCRE-only constructs like `(?i)`,
    // lookarounds or `\d` are not valid ERE and make grep exit 2 ("repetition-
    // operator error"), which previously surfaced as a dead-end error string
    // instead of any results. A literal search still answers "does this string
    // appear anywhere", which is what the caller actually wanted.
    const attempts: { bin: string; args: string[] }[] = [
      { bin: "git", args: ["grep", "-I", "-n", "-E", "--max-count=5", ...ci, "-e", cleaned, "--", "."] },
      { bin: "git", args: ["grep", "-I", "-n", "-F", "--max-count=5", ...ci, "-e", cleaned, "--", "."] },
      { bin: "grep", args: ["-r", "-I", "-n", "-E", ...ci, "-e", cleaned, "."] },
      { bin: "grep", args: ["-r", "-I", "-n", "-F", ...ci, "-e", cleaned, "."] },
    ];

    let lastError: any;
    for (const { bin, args } of attempts) {
      try {
        const { stdout } = await execFileAsync(bin, args, {
          cwd: targetDir,
          timeout: 20000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) return "No matches found.";
        const shown = lines.slice(0, maxResults);
        const suffix =
          lines.length > maxResults ? `\n... (${lines.length - maxResults} more matches, narrow the pattern)` : "";
        return shown.join("\n") + suffix;
      } catch (err: any) {
        // Exit code 1 is grep's "no matches" — a real answer, not an error.
        if (err?.code === 1) return "No matches found.";
        // Anything else (tool missing, invalid regex syntax): remember it and
        // try the next strategy — -E then -F, git then plain grep.
        lastError = err;
      }
    }
    return `Search could not be completed: ${String(lastError?.stderr || lastError?.message || lastError).slice(0, 300)}`;
  }

  /**
   * Several patterns in one round trip. Discovery routinely explores a
   * feature by trying half a dozen near-variant patterns in a row (a naming
   * guess, a synonym, an abbreviation) — each one used to cost a FULL tool
   * round, and every round resends the entire growing conversation so far,
   * so that shotgun exploration was the single biggest driver of Discovery's
   * token cost. Same search coverage, same number of grep invocations, just
   * one round instead of N.
   */
  public async searchCodeMulti(patterns: string[], subPath?: string, caseSensitive = false): Promise<string> {
    const MAX_BATCH = 8;
    const capped = patterns.slice(0, MAX_BATCH);
    const overflow = patterns.length - capped.length;

    const parts = await Promise.all(
      capped.map(async (p) => `=== "${p}" ===\n${await this.searchCode(p, subPath, caseSensitive)}`)
    );

    if (overflow > 0) {
      parts.push(`\n... ${overflow} more pattern(s) were not run — batch capped at ${MAX_BATCH} per call.`);
    }
    return parts.join("\n\n");
  }

  public async listFiles(dirPath?: string, recursive = false): Promise<string> {
    const targetDir = dirPath ? this.resolveSafePath(dirPath) : this.repoRoot;
    this.filesInspected.add(`${dirPath || "."}${recursive ? " (recursive)" : ""}`);

    if (!recursive) {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith(".git") && !this.isSensitivePath(e.name))
        .map((e) => `${e.isDirectory() ? "[DIR] " : " "}${e.name}`)
        .join("\n");
    }

    // Bounded walk: this exists to let the model survey a whole unfamiliar
    // subtree (e.g. "does this feature already have any files?") in one call
    // instead of one list_files per subdirectory, so caps here trade off
    // against exactly that goal — generous, but not unbounded.
    const blocked = new Set(this.config.safety?.blockedDirectories ?? []);
    const MAX_ENTRIES = 400;
    const MAX_DEPTH = 6;
    const baseRel = dirPath ? dirPath.replace(/\\/g, "/").replace(/\/$/, "") : "";
    const out: string[] = [];

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_ENTRIES) return;
        if (e.name.startsWith(".git") || blocked.has(e.name) || this.isSensitivePath(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(path.join(dir, e.name), relPath, depth + 1);
        } else {
          out.push(relPath);
        }
      }
    };

    await walk(targetDir, baseRel, 0);
    if (out.length === 0) return "No files found.";
    const suffix = out.length >= MAX_ENTRIES ? `\n... (truncated at ${MAX_ENTRIES} entries; narrow the path)` : "";
    return out.join("\n") + suffix;
  }

  public async getFileOutline(filePath: string): Promise<string> {
    const content = await this.readFile(filePath);
    const lines = content.split("\n");
    const matched: string[] = [];

    const outlineRegex = /(fun\s+\w+|class\s+\w+|interface\s+\w+|val\s+\w+|var\s+\w+|export\s+function|export\s+const|function\s+\w+)/;
    lines.forEach((line, idx) => {
      if (outlineRegex.test(line)) {
        matched.push(`L${idx + 1}: ${line.trim()}`);
      }
    });

    return matched.slice(0, 100).join("\n") || "No structural declarations identified.";
  }

  /** Batched get_file_outline: one round trip for several files instead of one call each. */
  public async getFileOutlines(paths: string[]): Promise<string> {
    const MAX_BATCH = 12;
    const capped = paths.slice(0, MAX_BATCH);
    const overflow = paths.length - capped.length;

    const parts = await Promise.all(
      capped.map(async (p) => {
        try {
          return `=== ${p} ===\n${await this.getFileOutline(p)}`;
        } catch (err: any) {
          return `=== ${p} ===\n[ERROR: ${err.message}]`;
        }
      })
    );

    if (overflow > 0) {
      parts.push(`\n... ${overflow} more path(s) were not outlined — batch capped at ${MAX_BATCH} files per call.`);
    }
    return parts.join("\n\n");
  }
}
