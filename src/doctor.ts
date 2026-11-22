/**
 * `yimpim doctor` — pre-flight readiness report.
 *
 * Tells a user exactly what works, what is missing, and what each missing piece
 * costs them, BEFORE they spend money on a run. Missing optional tooling is
 * reported as reduced capability, never as an error, mirroring the verifier.
 */

import fsSync from "fs";
import path from "path";
import { Config } from "./config.js";
import { probeCapabilities, Capabilities } from "./capabilities.js";
import { detectProject, ProjectProfile } from "./projectProfile.js";
import { apiKeyStatus, describeBackend, detectStaleEnvKey } from "./secrets.js";
import { toolchainChecks } from "./envSetup/doctorChecks.js";

export interface DoctorReport {
  /** False only when something makes a run impossible. */
  canRun: boolean;
  lines: string[];
}

const OK = "✓";
const WARN = "~";
const BAD = "✗";

interface Check {
  label: string;
  ok: boolean;
  /** A failed required check blocks the run. */
  required: boolean;
  /** A problem that is not a blocker but is serious (an exposed login, a missing aapt2): drawn as a failure, never stops a run. */
  severity?: "fail";
  detail: string;
  /** What the user loses if this stays missing. */
  impact?: string;
  fix?: string;
}

function renderChecks(title: string, checks: Check[], lines: string[]): void {
  lines.push(`${title}`);
  for (const c of checks) {
    const icon = c.ok ? OK : c.required || c.severity === "fail" ? BAD : WARN;
    lines.push(`  ${icon} ${c.label}: ${c.detail}`);
    if (!c.ok && c.impact) lines.push(`      impact: ${c.impact}`);
    if (!c.ok && c.fix) lines.push(`      fix:    ${c.fix}`);
  }
  lines.push("");
}

function coreChecks(repoRoot: string, config: Config, configPath?: string, caps?: Capabilities): Check[] {
  // Same resolution the rest of the app uses (env var, then the OS credential
  // store) rather than checking the env var alone — this used to report
  // "not set" for a key that lived only in the credential store, and would
  // report "set" for a garbage env-var value with no way to tell the two apart.
  const keyStatus = apiKeyStatus();
  const isRepo = fsSync.existsSync(path.join(repoRoot, ".git"));

  return [
    {
      label: "target repository",
      ok: fsSync.existsSync(repoRoot),
      required: true,
      detail: fsSync.existsSync(repoRoot) ? repoRoot : `${repoRoot} does not exist`,
      fix: "pass an existing path with --repo <dir>",
    },
    {
      label: "git repository",
      ok: isRepo,
      required: true,
      detail: isRepo ? "target is a git repo" : "target is not a git repository",
      impact: "checkpoints, scoped revert and diff-based QA all require git",
      fix: `run: git init  (in ${repoRoot})`,
    },
    {
      label: "git binary",
      ok: caps?.git.available ?? false,
      required: true,
      detail: caps?.git.detail ?? "not probed",
      fix: "install git and ensure it is on PATH",
    },
    {
      label: "OpenRouter API key",
      ok: keyStatus.present,
      required: true,
      // Presence, not validity — an expired or revoked key still passes this
      // check and only surfaces as an HTTP 401 ("User not found") on the
      // first real call. Nothing short of a live call can tell the two apart.
      detail: keyStatus.present
        ? `found (${keyStatus.detail}) — not verified against OpenRouter`
        : "not set",
      impact: "no model calls are possible",
      fix: "run `yimpim setup` (first time) or `/api-key` in a session (to rotate)",
    },
    ...(function () {
      const stale = detectStaleEnvKey();
      if (!stale) return [];
      return [
        {
          label: "API key source conflict",
          ok: false,
          required: false,
          detail:
            `OPENROUTER_API_KEY env var (${stale.envPreview}) differs from the key saved via setup/` +
            `\`/api-key\` (${stale.storedPreview}, in ${describeBackend(stale.storedBackend)}) — the env var always wins.`,
          impact: "rotating your saved key has no effect; every call keeps using the env var's key",
          fix:
            'PowerShell: Remove-Item Env:OPENROUTER_API_KEY  (bash: unset OPENROUTER_API_KEY) — then open a ' +
            "fresh terminal if it reappears, since it may also be set at the User/Machine level",
        } as Check,
      ];
    })(),
    {
      label: "configuration",
      ok: true,
      required: false,
      detail: configPath ? `loaded ${configPath}` : "no config file — using built-in defaults",
      fix: "run: yimpim init   (writes a commented agent.config.yaml)",
    },
  ];
}

function verificationChecks(profile: ProjectProfile, caps: Capabilities): Check[] {
  const checks: Check[] = [];
  const degrade = "this gate degrades to static code review; the run still completes";

  if (profile.android) {
    checks.push({
      label: "Android build gate",
      ok: caps.gradleWrapper.available && caps.java.available,
      required: false,
      detail: caps.gradleWrapper.available
        ? caps.java.available
          ? "gradle wrapper + JDK present"
          : caps.java.detail
        : caps.gradleWrapper.detail,
      impact: degrade,
      fix: "install a JDK (or Android Studio) and ensure ./gradlew exists",
    });
    checks.push({
      label: "Android visual gate",
      ok: caps.androidDevice.available,
      required: false,
      detail: caps.androidDevice.available ? caps.androidDevice.detail : caps.androidDevice.detail,
      impact: degrade,
      fix: "start an emulator (or attach a device) and confirm with: adb devices",
    });
    if (!profile.android.applicationId) {
      checks.push({
        label: "Android applicationId",
        ok: false,
        required: false,
        detail: "could not be resolved from the gradle module",
        impact: "the app cannot be launched, so no screenshots are captured",
        fix: "declare it in the module's build.gradle (defaultConfig { applicationId \"com.example.app\" })",
      });
    }
  }

  if (profile.ios) {
    checks.push({
      label: "iOS build gate",
      ok: caps.xcodebuild.available,
      required: false,
      detail: caps.xcodebuild.detail,
      impact: degrade,
      fix:
        process.platform === "darwin"
          ? "install Xcode from the App Store"
          : "iOS builds require a Mac — this cannot be fixed on the current OS",
    });
    checks.push({
      label: "iOS visual gate",
      ok: caps.iosSimulator.available,
      required: false,
      detail: caps.iosSimulator.detail,
      impact: degrade,
      fix:
        process.platform === "darwin"
          ? "open Simulator.app (or: xcrun simctl boot <name>)"
          : "iOS builds require a Mac — this cannot be fixed on the current OS",
    });
    if (!profile.ios.bundleId) {
      checks.push({
        label: "iOS bundle identifier",
        ok: false,
        required: false,
        detail: "could not be resolved from Info.plist",
        impact: "the app cannot be launched on a simulator, so no screenshots are captured",
        fix: "ensure Info.plist sets CFBundleIdentifier to a literal value, not an unresolved build setting",
      });
    }
  }

  if (profile.reactNative) {
    checks.push({
      label: "React Native verification",
      ok: true,
      required: false,
      detail: "not yet automated — static review only",
      impact: "no build or on-device/simulator check runs for React Native yet",
    });
  }

  if (profile.flutter) {
    checks.push({
      label: "Flutter analyze gate",
      ok: caps.flutter.available,
      required: false,
      detail: caps.flutter.detail,
      impact: degrade,
      fix: "install the Flutter SDK and ensure it is on PATH",
    });
  }

  if (profile.dotnet) {
    checks.push({
      label: ".NET build gate",
      ok: caps.dotnet.available,
      required: false,
      detail: caps.dotnet.detail,
      impact: degrade,
      fix: "install the .NET SDK: https://dotnet.microsoft.com/download",
    });
  }

  if (profile.stacks.includes("go")) {
    checks.push({
      label: "Go build gate",
      ok: caps.go.available,
      required: false,
      detail: caps.go.detail,
      impact: degrade,
      fix: "install Go: https://go.dev/dl/",
    });
  }

  if (profile.stacks.includes("rust")) {
    checks.push({
      label: "Rust build gate",
      ok: caps.cargo.available,
      required: false,
      detail: caps.cargo.detail,
      impact: degrade,
      fix: "install Rust via rustup: https://rustup.rs",
    });
  }

  if (profile.web || profile.python?.kind === "web") {
    checks.push({
      label: "browser visual gate",
      ok: caps.browser.available,
      required: false,
      detail: caps.browser.detail,
      impact: degrade,
      fix: "npx playwright install chromium",
    });
  }

  if (profile.python) {
    checks.push({
      label: "python runtime",
      ok: caps.python.available,
      required: false,
      detail: caps.python.detail,
      impact: degrade,
      fix: "install python and ensure it runs (note: the Windows Store python3 alias is a stub, not an interpreter)",
    });
  }

  if (profile.python?.kind === "desktop") {
    checks.push({
      label: "desktop screen capture",
      ok: caps.screenCapture.available,
      required: false,
      detail: caps.screenCapture.detail,
      impact: degrade,
      fix:
        process.platform === "linux"
          ? "install one of: gnome-screenshot, spectacle, scrot, imagemagick"
          : "ensure a desktop session is available (not headless/SSH)",
    });
  }

  if (checks.length === 0) {
    checks.push({
      label: "visual gates",
      ok: true,
      required: false,
      detail: "no UI surface detected — build + static review only (expected for CLI/library projects)",
    });
  }

  return checks;
}

/**
 * Readiness lines for QA's model chains — specifically WHICH chain actually
 * carries a screenshot, since that is the chain whose first model has to
 * accept image input.
 *
 * QA routes every image-carrying call (screenshot navigation and the visual
 * audit) through models.verifierVision when it is set, and only falls back to
 * the normal verifier chain when it is not — see AutonomousVerifier's
 * getVisualVerifierModels. So reporting the base verifier alone would point a
 * user with no image support at the wrong model to fix, and a configured
 * verifierVision must NOT inherit the base verifier's vision requirement:
 * keeping the (cheaper) verifier chain text-only is the whole point of
 * setting it.
 *
 * Image support itself cannot be established offline — this report makes no
 * catalog call, same as it never validates a slug — so the requirement is
 * stated against the active chain rather than pretended to have been checked.
 */
function verifierVisionLines(config: Config): string[] {
  const lines: string[] = [];

  const vision = config.models.verifierVision;
  const configured = vision && vision.length > 0 ? vision : undefined;
  lines.push(
    configured
      ? `  verifierVision: ${configured.join(", ")}   (visual QA: screenshot navigation + visual audit)`
      : `  verifierVision: (unset — visual QA falls back to the verifier chain above)`
  );

  lines.push(`  ${WARN} model names are not validated offline. If a slug is wrong the run`);
  lines.push(`    fails on the first API call. Verify at https://openrouter.ai/models`);
  if (configured) {
    lines.push(`    Visual QA uses the verifierVision chain, so its FIRST model`);
    lines.push(`    (${configured[0]}) must accept image input. The verifier chain above is only`);
    lines.push(`    used for text-only checks (semantic diff review) and needs no image input.`);
  } else {
    lines.push(`    The FIRST verifier model must accept image input for visual QA.`);
    lines.push(`    Set models.verifierVision to keep the verifier chain text-only:`);
    lines.push(`      yimpim config set models.verifierVision <vision-model>,<backup-model>`);
  }
  lines.push("");

  return lines;
}

export async function runDoctor(
  repoRoot: string,
  config: Config,
  configPath?: string
): Promise<DoctorReport> {
  const lines: string[] = [];
  lines.push("");
  lines.push("YIMPIM readiness report");
  lines.push("=".repeat(64));
  lines.push("");

  // Detected before probing so probeCapabilities knows what's actually
  // relevant to check — an Android/gradle/emulator probe is real, non-free
  // work (shelling out, waiting on responses) that a CLI or plain-web
  // project has no use for, and reporting it regardless just reads as
  // yimpim having gone looking through the machine for something unrelated
  // to what's being built.
  let profile: ProjectProfile | undefined;
  let detectionError: string | undefined;
  try {
    profile = await detectProject(repoRoot);
  } catch (err: any) {
    detectionError = err.message;
  }

  const caps = await probeCapabilities(repoRoot, profile);
  const core = coreChecks(repoRoot, config, configPath, caps);
  renderChecks("Required", core, lines);

  if (profile) {
    lines.push("Detected project");
    lines.push(`  stacks: ${profile.stacks.join(", ")}`);
    for (const note of profile.notes) lines.push(`  ${note}`);
    if (profile.testCommands.length > 0) {
      lines.push(`  test commands: ${profile.testCommands.map((c) => c.join(" ")).join(" | ")}`);
    }
    lines.push("");
    renderChecks("Verification gates", verificationChecks(profile, caps), lines);
  } else {
    lines.push(`  ${WARN} project detection failed: ${detectionError}`);
    lines.push("");
  }

  // The machine itself: which toolchains are installed, and whether the host is safe to leave running. Read-only; each problem says what to run.
  try {
    renderChecks(
      "Developer toolchains and host security (yimpim setup-env installs the toolchains)",
      toolchainChecks().map((c) => ({ label: c.label, ok: c.status === "pass", required: false, ...(c.status === "fail" ? { severity: "fail" as const } : {}), detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) })),
      lines
    );
  } catch (err: any) {
    lines.push(`  ${WARN} the machine checks could not run: ${String(err?.message ?? err).slice(0, 120)}`, "");
  }

  lines.push("Models");
  lines.push(`  discovery: ${config.models.discovery.join(", ")}`);
  lines.push(`  planner:   ${config.models.planner.join(", ")}`);
  lines.push(`  editor:    ${config.models.editor.join(", ")}`);
  if (config.models.repair && config.models.repair.length > 0) {
    lines.push(`  repair:    ${config.models.repair.join(", ")}`);
  }
  lines.push(`  verifier:  ${config.models.verifier.join(", ")}`);
  lines.push(...verifierVisionLines(config));

  lines.push("Cost exposure");
  lines.push(`  up to ${config.limits.maxToolRounds} tool rounds per agent pass`);
  lines.push(`  up to ${config.limits.maxRepairAttemptsPerPhase} repair attempts, each a full editor pass`);
  // This budget applies PER PHASE, so a multi-phase plan multiplies it.
  const worst = config.limits.maxToolRounds * (config.limits.maxRepairAttemptsPerPhase + 1);
  lines.push(`  worst case ≈ ${worst} model calls PER PHASE`);
  lines.push(`    a 4-phase plan is therefore ≈ ${worst * 4} calls`);
  lines.push("");
  lines.push(`  ${WARN} Set a spend limit on your OpenRouter key before running.`);
  lines.push(`    YIMPIM does not cap spend itself. https://openrouter.ai/settings/keys`);
  // 10 is the default (split between the primary and backup editor model), so only a value above it is worth a warning.
  if (config.limits.maxRepairAttemptsPerPhase > 10) {
    lines.push(`  ${WARN} maxRepairAttemptsPerPhase=${config.limits.maxRepairAttemptsPerPhase} is above the default of 10; each attempt is a full editor pass`);
    lines.push(`    lower it: yimpim config set limits.maxRepairAttemptsPerPhase 10`);
  }
  lines.push("");

  const blockers = core.filter((c) => c.required && !c.ok);
  const canRun = blockers.length === 0;

  lines.push("=".repeat(64));
  if (canRun) {
    const degraded = profile ? verificationChecks(profile, caps).filter((c) => !c.ok).length : 0;
    lines.push(
      degraded === 0
        ? `${OK} Ready. All detected verification gates are available.`
        : `${OK} Ready, with ${degraded} gate(s) degraded to static review. Runs will complete and report reduced confidence.`
    );
  } else {
    lines.push(`${BAD} Cannot run. Fix ${blockers.length} required item(s) above:`);
    for (const b of blockers) lines.push(`    - ${b.label}`);
  }
  lines.push("");

  return { canRun, lines };
}
