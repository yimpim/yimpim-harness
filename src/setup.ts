/**
 * First-run wizard: Git, the OpenRouter key, and a model for each role, drawn with @clack/prompts (see wizard/prompts.ts).
 *
 * The key is typed masked, checked live against OpenRouter, saved to the OS credential store (secrets.ts, never the config file),
 * and only ever shown as sk-or-••••1234. Models are picked from the live catalog in a searchable list of every model the key can
 * reach. Advanced tuning (retries, timeouts) stays out of here: `yimpim config` covers it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogModel, PERSONAS, Persona, candidatesFor, fetchCatalog } from "./models.js";
import { describeBackend, loadStoredKey, storeApiKey, type SecretBackend } from "./secrets.js";
import { hasGlobalConfig, readGlobalConfig, writeGlobalConfig } from "./globalConfig.js";
import { which } from "./capabilities.js";
import { p, answered, canRunWizard, withExclusiveStdin, WizardCancelled, ESC_HINT } from "./wizard/prompts.js";
import { checkKey, describeKey, looksLikeOpenRouterKey, maskKey, sanitize, spendLimitWarning } from "./wizard/keyCheck.js";
import { pickChain, pickOne, vendorOf, NO_BACKUP } from "./wizard/modelPicker.js";

const execFileAsync = promisify(execFile);

export type ModelChains = Record<Persona, string[]>;

export function emptyChains(): ModelChains {
  return {
    discovery: [], planner: [], editor: [], repair: [], verifier: [],
    discoveryVision: [], editorVision: [], repairVision: [], verifierVision: [],
    designer: [], designerVision: [], security: [],
  };
}

/**
 * "Use one model for every role": the model (and its backup) runs Discovery, Planner, Editor and Verifier. Repair is left unset,
 * which means it reuses the Editor's chain. The screenshot checks get it too when it can see images; otherwise that role is left
 * unset and falls back to the Verifier. Specialist roles are not touched here.
 */
export function chainsForOneModel(primary: CatalogModel, backup?: CatalogModel): ModelChains {
  const out = emptyChains();
  const chain = backup ? [primary.id, backup.id] : [primary.id];
  for (const role of ["discovery", "planner", "editor", "verifier"] as const) out[role] = [...chain];
  if (primary.supportsVision) out.verifierVision = backup?.supportsVision ? [...chain] : [primary.id];
  return out;
}

/** The summary card: the masked key and every role that has a model. */
export function summaryLines(key: { masked: string; where: string }, models: Partial<ModelChains>): string[] {
  const rows = PERSONAS.filter((r) => (models[r.key]?.length ?? 0) > 0);
  const width = Math.max(4, ...rows.map((r) => r.label.length));
  return [
    `${"Key".padEnd(width)}  ${key.masked}  (${key.where})`,
    "",
    ...rows.map((r) => `${r.label.padEnd(width)}  ${models[r.key]!.join("  →  ")}`),
  ];
}

/** What to do where the wizard cannot run (no terminal). */
export const NON_INTERACTIVE_HELP = [
  "yimpim setup needs an interactive terminal.",
  "On a server or in CI, set OPENROUTER_API_KEY and choose models with:",
  "  yimpim config set models.planner <model-id>",
  "  yimpim config set models.editor <model-id>",
  "  (and models.discovery, models.verifier)",
];

export async function runSetup(force = false): Promise<number> {
  if (!canRunWizard()) {
    for (const l of NON_INTERACTIVE_HELP) console.error(l);
    return 1;
  }
  // One stdin hold for the whole wizard: raw mode stays on between its prompts (see withExclusiveStdin / holdRawMode).
  return withExclusiveStdin(() => runSetupSteps(force));
}

async function runSetupSteps(force: boolean): Promise<number> {
  let keySaved = false;
  try {
    p.intro("YIMPIM setup");

    if (hasGlobalConfig() && !force) {
      const go = answered(await p.confirm({ message: "You already have settings. Replace your model choices?", initialValue: false }));
      if (!go) {
        p.outro("Nothing changed.");
        return 0;
      }
    }

    // ---- Git ---------------------------------------------------------------
    // Every project YIMPIM touches needs git (checkpoints, scoped revert, diff-based QA), with no reduced mode, so it is settled
    // first: there is no point choosing models on a machine that cannot run a task.
    let gitBin = which("git");
    if (gitBin) {
      p.log.success(`Git found: ${gitBin}`);
    } else {
      p.log.warn("YIMPIM needs Git: checkpoints, revert and QA diffing are built on it, for every project.");
      const install = answered(await p.confirm({ message: "Install Git now?", initialValue: true }));
      if (!install) {
        p.cancel("Install Git when ready (https://git-scm.com/downloads), then run `yimpim setup` again. Nothing was saved.");
        return 1;
      }
      if (!(process.platform === "win32" && which("winget"))) {
        p.cancel("Automatic install isn't available here. Install Git from https://git-scm.com/downloads, then run `yimpim setup` again.");
        return 1;
      }
      const s = p.spinner();
      s.start("Installing Git with winget, this can take a minute");
      try {
        await execFileAsync(
          "winget",
          ["install", "--id", "Git.Git", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"],
          { timeout: 5 * 60 * 1000 }
        );
        s.stop("winget finished");
      } catch (err: any) {
        s.error(`winget reported an error: ${sanitize(err?.message ?? String(err))}`);
      }
      // winget updates PATH through a registry broadcast this running process never receives.
      gitBin = which("git");
      if (!gitBin) {
        p.cancel("Git may be installed, but this terminal hasn't picked it up yet. Open a new terminal and run `yimpim setup` again.");
        return 1;
      }
      p.log.success(`Git found: ${gitBin}`);
    }

    // ---- OpenRouter key ----------------------------------------------------
    const envKey = process.env.OPENROUTER_API_KEY?.trim();
    const saved = loadStoredKey();
    let key = "";
    let entered = false;
    let offerSaved = Boolean(saved.key);
    for (;;) {
      if (envKey) {
        key = envKey;
        p.log.info(`Using the key from OPENROUTER_API_KEY (${maskKey(envKey)}). It stays in your environment; nothing is saved.`);
      } else if (offerSaved && saved.key) {
        const keep = answered(await p.confirm({ message: `Keep your saved OpenRouter key (${maskKey(saved.key)})?`, initialValue: true }));
        offerSaved = false;
        if (keep) key = saved.key;
      }
      if (!key) {
        p.log.message("Get a key at openrouter.ai/keys. Give it a spend limit: YIMPIM does not cap what it spends.");
        key = answered(
          await p.password({
            message: `OpenRouter API key  ${ESC_HINT}`,
            mask: "•",
            validate: (v) => (v && v.trim() ? undefined : "Paste your key, or press Esc to cancel."),
          })
        ).trim();
        if (!looksLikeOpenRouterKey(key)) {
          const useIt = answered(await p.confirm({ message: "That doesn't look like an OpenRouter key (they start with sk-or-). Use it anyway?", initialValue: false }));
          if (!useIt) { key = ""; continue; }
        }
        entered = true;
      }

      const s = p.spinner();
      s.start("Checking your key with OpenRouter");
      const result = await checkKey(key);
      if (result.ok) {
        s.stop(`Key works: ${describeKey(result.info)}`);
        const warn = spendLimitWarning(result.info);
        if (warn) p.log.warn(warn);
        break;
      }
      s.error(result.reason);
      if (envKey) {
        p.cancel("Fix or unset OPENROUTER_API_KEY, then run `yimpim setup` again. Nothing was saved.");
        return 1;
      }
      key = "";
      entered = false;
    }

    // ---- The catalog -------------------------------------------------------
    const s = p.spinner();
    s.start("Loading the models your key can reach");
    let catalog: CatalogModel[];
    try {
      catalog = await fetchCatalog(key);
    } catch (err: any) {
      s.error(`Could not load the model list: ${sanitize(err?.message ?? String(err), key)}`);
      p.cancel("Nothing was saved. Run `yimpim setup` again in a moment.");
      return 1;
    }
    s.stop(`${catalog.length} models available`);

    let backend: SecretBackend | undefined = envKey ? "env" : saved.backend;
    if (entered) {
      backend = storeApiKey(key);
      keySaved = true;
      p.log.success(`Key saved to ${describeBackend(backend)}${backend === "file" ? " (no OS credential store was found)" : ""}.`);
    }

    // ---- Models ------------------------------------------------------------
    const current = readGlobalConfig();
    const existing = (role: Persona): string[] => (Array.isArray(current?.models?.[role]) ? current.models[role] : []);
    let models = emptyChains();

    const mode = answered(
      await p.select({
        message: `How do you want to choose models?  ${ESC_HINT}`,
        options: [
          { value: "one", label: "Use one model for every role", hint: "quickest; change any role later with /model" },
          { value: "each", label: "Choose a model for each role", hint: "Planner, Editor, Verifier, Repair and more" },
        ],
      })
    );

    if (mode === "one") {
      // Discovery and Editor drive the project through YIMPIM's tools, so the one model must be able to; candidatesFor says which.
      const editor = PERSONAS.find((r) => r.key === "editor")!;
      const options = candidatesFor(catalog, editor);
      const primaryId = await pickOne({ message: "Your model", models: options, current: existing("planner")[0] });
      const primary = options.find((m) => m.id === primaryId)!;
      const others = options.filter((m) => vendorOf(m.id) !== vendorOf(primaryId));
      const backupId = await pickOne({
        message: `Backup from another provider, used only if ${primaryId} is unavailable`,
        models: others,
        current: existing("planner")[1],
        extra: [{ value: NO_BACKUP, label: "No backup" }],
      });
      models = chainsForOneModel(primary, backupId === NO_BACKUP ? undefined : others.find((m) => m.id === backupId));
      if (!primary.supportsVision) p.log.info("This model can't see images, so screenshot checks will use your Verifier. You can set a vision model later with /model.");
    } else {
      for (const persona of PERSONAS) {
        if (persona.advanced) continue; // specialist roles: asked below
        const options = candidatesFor(catalog, persona);
        if (options.length === 0) continue;
        p.log.message(persona.blurb);
        const chain = await pickChain(persona, options, existing(persona.key));
        if (chain) models[persona.key] = chain;
      }
    }

    // ---- Specialist roles (optional) ---------------------------------------
    const wantsSpecialists = answered(
      await p.confirm({
        message: "Set up the specialist models now? (Security for /pentest, Designer and Designer Judge for /design)",
        initialValue: false,
      })
    );
    if (wantsSpecialists) {
      for (const persona of PERSONAS) {
        if (!persona.advanced) continue;
        const options = candidatesFor(catalog, persona);
        if (options.length === 0) continue;
        p.log.message(persona.blurb);
        const chain = await pickChain(persona, options, existing(persona.key), { allowSkip: true });
        if (chain) models[persona.key] = chain;
      }
    } else {
      p.log.info("Skipped. Each falls back to a role you just set, and you'll be asked the first time you run /pentest or /design.");
      // Re-running setup replaces the model choices, but a specialist role set earlier is not something this run touched.
      for (const persona of PERSONAS) if (persona.advanced && existing(persona.key).length) models[persona.key] = existing(persona.key);
    }

    // ---- Save --------------------------------------------------------------
    const chosen = Object.fromEntries(Object.entries(models).filter(([, v]) => v.length > 0));
    const file = writeGlobalConfig({ ...current, models: chosen });

    p.note(summaryLines({ masked: maskKey(key), where: describeBackend(backend) }, chosen).join("\n"), "Your setup");
    p.log.info("Phone remote control (YIMPIM Pro) needs nothing here: run /link once, then /remote-control in any session.");
    p.outro(`Saved to ${file}. Next: cd into a project and run yimpim`);
    return 0;
  } catch (err) {
    if (err instanceof WizardCancelled) {
      p.cancel(keySaved ? "Setup cancelled. Your key was saved; run `yimpim setup` again to choose models." : "Setup cancelled. Nothing was saved.");
      return 1;
    }
    throw err;
  }
}
