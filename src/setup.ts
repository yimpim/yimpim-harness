/**
 * First-run wizard.
 *
 * Asks for an API key once, then lets the user pick a primary and a backup
 * model per persona from their own OpenRouter catalog. Nobody edits YAML.
 */

import { execFile } from "node:child_process";
import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { promisify } from "node:util";
import {
  CatalogModel, PERSONAS, Persona, candidatesFor, fetchCatalog, formatModel,
} from "./models.js";
import { apiKeyStatus, describeBackend, loadApiKey, storeApiKey } from "./secrets.js";
import { hasGlobalConfig, readGlobalConfig, writeGlobalConfig } from "./globalConfig.js";
import { which } from "./capabilities.js";
import { YES_NO_ENTER_NO } from "./promptStyle.js";

const execFileAsync = promisify(execFile);

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(60));

/**
 * Answers that mean "leave this picker alone" rather than "search for this
 * text". A single word with no spaces is deliberate: a real model search
 * term is almost never exactly one of these, while "back" typed alone in a
 * prompt that just advertised it must never be treated as a query.
 */
const CANCEL_WORDS = new Set(["q", "quit", "exit", "cancel", "back"]);

/**
 * Exported for tests: the picker's keyword half of cancellation, split out
 * from the ESC half because only this part is decidable without a real TTY.
 * Matches on the whole trimmed answer, case-insensitively — "claude", or a
 * multi-word search containing one of these words, is still a search.
 */
export function isCancelAnswer(answer: string): boolean {
  return CANCEL_WORDS.has(answer.trim().toLowerCase());
}

/** Raised when stdin closes mid-wizard (piped input ran out, Ctrl-D, etc). */
export class SetupCancelledError extends Error {
  constructor() {
    super("input ended before setup finished");
    this.name = "SetupCancelledError";
  }
}

/**
 * `rl.question()` after the underlying stream closes throws a raw
 * ERR_USE_AFTER_CLOSE with a stack trace — not something to show a user in the
 * middle of a wizard. This turns that into a clean, catchable cancellation.
 */
async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  if ((rl as any).closed) throw new SetupCancelledError();
  try {
    return await rl.question(prompt);
  } catch (err: any) {
    if (err?.code === "ERR_USE_AFTER_CLOSE") throw new SetupCancelledError();
    throw err;
  }
}

/**
 * `rl.question` on a TTY runs readline's own line editor, which never resolves
 * on a lone ESC — there is no newline to submit — so a picker telling the user
 * "press ESC to go back" would be lying: the keypress just sits there and the
 * picker waits for a line that is never coming. Watches the keypress stream
 * alongside the question and abandons it on ESC, resolving with undefined.
 * The abandoned question is harmless — readline keeps a single pending-question
 * callback, so the next question simply replaces this one.
 */
async function askOrEscape(rl: readline.Interface, prompt: string): Promise<string | undefined> {
  // Piped input (tests, CI, `echo ... | yimpim setup`) has no keypress stream
  // at all, so ESC can never arrive there — plain readline, unchanged.
  if (!process.stdin.isTTY) return ask(rl, prompt);

  emitKeypressEvents(process.stdin);
  let onKeypress: ((str: string, key?: { name?: string }) => void) | undefined;
  const escaped = new Promise<undefined>((resolve) => {
    onKeypress = (_str: string, key?: { name?: string }) => {
      if (key?.name !== "escape") return;
      // Resolved BEFORE the cleanup emit below so this always wins the race
      // below, regardless of how readline handles that emit.
      resolve(undefined);
      // Let the abandoned question settle with an empty line instead of
      // leaving it pending — readline holds exactly one question callback,
      // and the caller asks again on the very next loop iteration (another
      // persona, another picker), so it must not still be outstanding.
      try {
        (process.stdin as any).emit("keypress", "\r", { name: "return", sequence: "\r" });
      } catch {}
    };
    process.stdin.on("keypress", onKeypress);
  });

  try {
    // Rejections are captured as values rather than left to propagate: when
    // ESC wins this race the question is abandoned, and an abandoned
    // rejection would otherwise resurface later as an unhandled rejection
    // that kills the process. A real SetupCancelledError (stdin closed
    // mid-prompt) is re-thrown unchanged.
    const answered = ask(rl, prompt).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );
    const winner = await Promise.race([answered, escaped]);
    if (winner === undefined) return undefined;
    if (!winner.ok) throw winner.error;
    return winner.value;
  } finally {
    if (onKeypress) process.stdin.off("keypress", onKeypress);
  }
}

/**
 * Read a line without echoing it, for secrets. Exported for reuse by /api-key.
 *
 * ESC cancels: raw mode is already what this reads keys from, so a lone ESC
 * (`\x1b`) is a single byte in the data stream with no newline needed —
 * resolving with "" is the same cancellation signal an empty Enter already
 * produces, and callers already treat that as "nothing entered, change
 * nothing". Raw mode is restored by the same cleanup path as every other exit.
 */
export async function askHidden(rl: readline.Interface, prompt: string): Promise<string> {
  const input = process.stdin as any;
  const output = process.stdout as any;

  if (!input.isTTY) return (await ask(rl, prompt)).trim();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();

    // On Windows, raw mode is a CONSOLE-WIDE flag (ENABLE_PROCESSED_INPUT),
    // not scoped to this process — it also controls whether Ctrl+C generates
    // a signal at all. The two explicit restores below (Enter, Ctrl+C) only
    // cover their own paths; anything else that throws while this listener
    // is live (a broken pipe from output.write, for instance) would
    // otherwise leave the terminal itself stuck in raw mode with no way back
    // short of closing the window. This is the actual safety net.
    const cleanup = (err?: unknown) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("error", onErr);
      input.setRawMode?.(wasRaw ?? false);
      if (err !== undefined) reject(err);
    };
    const onErr = (err: unknown) => cleanup(err);
    input.on("error", onErr);

    // Redraws the ENTIRE line from scratch on every keystroke, rather than
    // appending one bullet incrementally. A paste on some Windows terminals
    // (Windows Terminal, conhost) can echo part of the pasted block to the
    // screen before Node's raw-mode listener finishes processing it -- a
    // terminal-timing quirk, not something this function's own output ever
    // does (it only ever writes a bullet or a backspace-erase). Appending
    // could not fix that: any stray text is already on screen by the time
    // this listener runs. A full clear-and-redraw closes the window to "as
    // soon as this listener fires" rather than "whenever the next keystroke
    // happens to overwrite it" -- the tightest bound Node can guarantee here.
    const MASK = "•";
    const render = () => output.write(`\r\x1b[K${prompt}${MASK.repeat(value.length)}`);
    render();

    const onData = (buf: Buffer) => {
      try {
      const ch = buf.toString("utf8");
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          cleanup();
          render();
          output.write("\n");
          return resolve(value.trim());
        }
        if (c === "\x1b") {
          // ESC — cancel. An arrow/function key also starts with ESC, but its
          // remaining bytes arrive in this same buffer, so a multi-byte
          // sequence is left alone (having no control meaning in a hidden
          // secret field, it is otherwise ignored) instead of being mistaken
          // for a cancellation.
          if (buf.length === 1) {
            cleanup();
            render();
            output.write("\n");
            return resolve("");
          }
          continue;
        }
        if (c === "") {
          cleanup();
          render();
          output.write("\n");
          process.exit(130);
        }
        if (c === "" || c === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += c;
      }
      render();
      } catch (err) {
        // Whatever went wrong, raw mode must not be left engaged — that's a
        // console-wide flag on Windows, not just a broken promise here.
        cleanup(err);
      }
    };
    input.on("data", onData);
  });
}

/** Exported so /model in an interactive session can reuse the same search UI. */
export async function pickModel(
  rl: readline.Interface,
  label: string,
  blurb: string,
  options: CatalogModel[],
  current: string | undefined,
  allowNone: boolean
): Promise<string | undefined> {
  line();
  line(`  ${label}`);
  line(`  ${blurb}`);
  line();

  // With hundreds of eligible models, a flat "cheapest first" list is useless —
  // the top of it is always obscure free models. Show a small sample and make
  // search the primary way to navigate.
  let shown = sample(options);
  let filter = "";

  const render = () => {
    shown.forEach((m, i) => {
      const mark = m.id === current ? "  (current)" : "";
      line(`   ${String(i + 1).padStart(2)}. ${formatModel(m)}${mark}`);
    });
    line();
    line(filter
      ? `   ${options.length} match "${filter}". Type another word to refine, or "*" to reset.`
      : `   ${options.length} models available for this role. Type part of a name to search,`);
    if (!filter) line(`   e.g. "claude", "gemini", "gpt", "deepseek".`);
  };

  render();
  line();
  line("   Press ESC (or type \"cancel\") to go back without changing anything.");

  const hint = allowNone ? "number, search, or blank for none" : "number or search";
  for (;;) {
    const raw = await askOrEscape(rl, `  Choose (${hint}): `);
    // ESC, or the readline interface closing mid-question: a cancellation,
    // never a model id — resolve undefined the same way an optional role's
    // blank answer does, so callers already treat it as "nothing changed".
    if (raw === undefined) {
      line("   Cancelled — nothing changed.");
      return undefined;
    }
    const answer = raw.trim();

    // A typed word like "cancel" would otherwise be handed to the search
    // below and either report "nothing matches" or silently narrow the list
    // to whatever happens to contain that substring — a loop with no way
    // out, which is exactly what these words exist to provide.
    if (isCancelAnswer(answer)) {
      line("   Cancelled — nothing changed.");
      return undefined;
    }

    if (!answer) {
      if (allowNone) return undefined;
      if (current) return current;
      line("  Please choose one.");
      continue;
    }

    if (answer === "*") {
      filter = "";
      shown = sample(options);
      line();
      render();
      continue;
    }

    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1].id;

    // Exact id always wins, so power users can paste one.
    const exact = options.find((m) => m.id === answer);
    if (exact) return exact.id;

    // Otherwise treat the input as a search over the eligible set.
    const matches = options.filter((m) => m.id.toLowerCase().includes(answer.toLowerCase()));
    if (matches.length === 0) {
      line(`  Nothing matches "${answer}" for this role. Try another word, or "*" to reset.`);
      continue;
    }
    filter = answer;
    shown = matches.slice(0, 12);
    line();
    render();
  }
}

/** A spread of price points rather than just the cheapest tail. */
function sample(options: CatalogModel[]): CatalogModel[] {
  const free = options.filter((m) => m.promptCost === 0 && m.completionCost === 0).slice(0, 2);
  const paid = options.filter((m) => (m.promptCost ?? 0) > 0);
  if (paid.length === 0) return options.slice(0, 10);

  // Even steps through the paid range so cheap, mid and premium are all visible.
  const picks: CatalogModel[] = [];
  const step = Math.max(1, Math.floor(paid.length / 8));
  for (let i = 0; i < paid.length && picks.length < 8; i += step) picks.push(paid[i]);

  return [...free, ...picks];
}

export async function runSetup(force = false): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    rule();
    line("  YIMPIM setup");
    rule();

    if (hasGlobalConfig() && !force) {
      line("  You already have settings. Re-running will replace your model choices.");
      const go = (await ask(rl, `  Continue? ${YES_NO_ENTER_NO}: `)).trim().toLowerCase();
      if (go !== "y" && go !== "yes") {
        line("  Cancelled. Nothing changed.");
        return 0;
      }
    }

    // ---- 1. Git ------------------------------------------------------------
    // Checked here, once, while the user is actually sitting at the keyboard —
    // the best (and for an unattended run, only) chance to fix this. Every
    // project YIMPIM ever touches needs git: checkpoints, scoped revert, and
    // diff-based QA are all built directly on it (see repoTools.ts), so
    // there's no reduced-capability mode to fall back to the way there is for
    // an optional build tool. Missing git isn't a "this project" problem, so
    // it's resolved here rather than per-project.
    line();
    line("  1. Git");
    let gitBin = which("git");
    if (gitBin) {
      line(`     Found: ${gitBin}`);
    } else {
      line("     YIMPIM requires git locally — checkpoints, revert, and QA diffing are");
      line("     all built on it, for every project you point YIMPIM at, not just this one.");
      line();
      const install = (await ask(rl, `     Install it now? ${YES_NO_ENTER_NO}: `)).trim().toLowerCase();

      if (install === "y" || install === "yes") {
        if (process.platform === "win32" && which("winget")) {
          line("     Installing via winget — this can take a minute…");
          try {
            await execFileAsync(
              "winget",
              [
                "install", "--id", "Git.Git", "-e",
                "--source", "winget",
                "--accept-package-agreements", "--accept-source-agreements",
              ],
              { timeout: 5 * 60 * 1000 }
            );
          } catch (err: any) {
            line(`     winget reported an error: ${err.message}`);
          }

          // winget updates PATH via a registry broadcast this already-running
          // process never receives, so re-checking PATH in-process can still
          // report "missing" even on a successful install.
          gitBin = which("git");
          if (gitBin) {
            line(`     ✓ git found at ${gitBin}`);
          } else {
            line();
            line("     Git may be installed, but this terminal's PATH hasn't picked it up yet.");
            line("     Close this terminal, open a new one, and run `yimpim setup` again.");
            return 1;
          }
        } else {
          line("     Automatic install isn't available here (winget not found, or not on Windows).");
          line("     Install git yourself: https://git-scm.com/downloads");
          line("     Then run `yimpim setup` again.");
          return 1;
        }
      } else {
        line();
        line("     Without git, YIMPIM cannot create checkpoints, revert failed phases, or");
        line("     diff changes for QA on ANY project — so it can't run at all.");
        line("     Install git yourself when ready: https://git-scm.com/downloads");
        line("     Setup cancelled — nothing was saved.");
        return 1;
      }
    }

    // ---- 2. API key ------------------------------------------------------
    line();
    line("  2. OpenRouter API key");
    const existing = apiKeyStatus();
    if (existing.present) {
      line(`     Found one already: ${existing.detail}`);
    }

    let apiKey = loadApiKey().key;
    if (!existing.present || force) {
      line("     Get one at https://openrouter.ai/keys");
      line("     Tip: set a spend limit on the key — YIMPIM does not cap spend itself.");
      line();
      const entered = await askHidden(rl, "     Paste your key (hidden): ");
      if (!entered) {
        line("     No key entered. Setup cannot continue.");
        return 1;
      }
      apiKey = entered;
    }

    if (!apiKey) {
      line("     No API key available.");
      return 1;
    }

    // ---- 3. Catalog ------------------------------------------------------
    line();
    line("  3. Checking which models your key can reach…");
    let catalog: CatalogModel[];
    try {
      catalog = await fetchCatalog(apiKey);
    } catch (err: any) {
      line(`     Could not reach OpenRouter: ${err.message}`);
      line("     Your key may be wrong, or you may be offline. Nothing was saved.");
      return 1;
    }
    line(`     ${catalog.length} models available.`);

    // The key works, so it is safe to persist now.
    const backend = storeApiKey(apiKey);
    line(`     Key saved to ${describeBackend(backend)}.`);
    if (backend === "file") {
      line("     (No OS credential store found, so an owner-only file was used.)");
    }

    // ---- 4. Models per persona ------------------------------------------
    line();
    line("  4. Choose a model for each role");
    line("     Listed cheapest first. The backup is used if the primary fails.");
    line("     The Editor has by far the highest token volume — but a weak editor");
    line("     fails verification more often, and each retry costs a full pass.");

    const current = readGlobalConfig();
    const models: Record<Persona, string[]> = {
      discovery: [], planner: [], editor: [], repair: [], verifier: [],
      discoveryVision: [], editorVision: [], repairVision: [], verifierVision: [],
      designer: [], designerVision: [], security: [],
    };

    for (const persona of PERSONAS) {
      // The specialist roles (logo designer, logo judge, security) are not asked on first run: /model and the phone set them.
      if (persona.advanced) continue;
      const options = candidatesFor(catalog, persona);
      if (options.length === 0) {
        if (persona.optional) continue; // no vision-capable model reachable — fine, this role is opt-in anyway
        line();
        line(`  ${persona.label}: no model your key can reach meets this role's needs.`);
        line(`  Skipping; you can set it later with: yimpim config set models.${persona.key} <id>`);
        continue;
      }

      const existingChain: string[] = current?.models?.[persona.key] ?? [];
      const primary = await pickModel(
        rl,
        `${persona.label} — primary`,
        persona.blurb +
          (persona.volume === "high" ? "  ⚠ high volume: this choice drives your bill." : "") +
          (persona.optional ? "  (optional — press Enter to skip this role entirely)" : ""),
        options,
        existingChain[0],
        Boolean(persona.optional)
      );
      if (!primary) continue; // skipped an optional role — leave models[persona.key] empty

      const backup = await pickModel(
        rl,
        `${persona.label} — backup`,
        "Used only if the primary is unavailable.",
        options.filter((m) => m.id !== primary),
        existingChain[1],
        true
      );

      models[persona.key] = backup ? [primary, backup] : [primary];
    }

    // ---- 5. Specialist roles (optional) ----------------------------------
    // Security, logo designer and logo judge each fall back to a role set above, so this is skippable. Asked once here so people know they exist.
    line();
    line("  5. Specialist models (optional)");
    line("     Three more roles are used only by /pentest and /design. Each falls back to a role");
    line("     you just set, and you can set them any time with /model.");
    const wantsSpecialists = (await ask(rl, `     Set them up now? ${YES_NO_ENTER_NO}: `)).trim().toLowerCase();
    if (wantsSpecialists === "y" || wantsSpecialists === "yes") {
      for (const persona of PERSONAS) {
        if (!persona.advanced) continue;
        const options = candidatesFor(catalog, persona);
        if (options.length === 0) continue;
        const existingChain: string[] = current?.models?.[persona.key] ?? [];
        const first = await pickModel(rl, `${persona.label}`, persona.blurb + "  (press Enter to skip this role)", options, existingChain[0], true);
        if (!first) continue;
        const chain = [first];
        const maxModels = persona.multi?.max ?? 2;
        while (chain.length < maxModels) {
          const more = await pickModel(
            rl,
            `${persona.label} — ${persona.multi ? `model ${chain.length + 1} of up to ${maxModels}` : "backup"}`,
            persona.multi ? "Add another (a different company gives more variety), or press Enter to finish." : "Used only if the first is unavailable.",
            options.filter((m) => !chain.includes(m.id)),
            existingChain[chain.length],
            true
          );
          if (!more) break;
          chain.push(more);
        }
        models[persona.key] = chain;
      }
    } else {
      line("     Skipped. You will be asked the first time you run /pentest or /design.");
      // Re-running setup replaces the model choices, but a specialist role set earlier is not something this run touched.
      for (const persona of PERSONAS) {
        if (persona.advanced && Array.isArray(current?.models?.[persona.key])) models[persona.key] = current!.models![persona.key];
      }
    }

    // Phone remote control needs no setup here: it runs through YIMPIM Pro (/link once, then /remote-control).
    line();
    line("  6. Phone remote control (YIMPIM Pro)");
    line("     Nothing to set up now — run /link once to link this machine, then");
    line("     /remote-control in any session shows a QR code for the YIMPIM app.");

    // ---- 6. Save ---------------------------------------------------------
    const data: Record<string, any> = {
      models: Object.fromEntries(
        Object.entries(models).filter(([, v]) => v.length > 0)
      ),
    };

    const file = writeGlobalConfig(data);

    line();
    rule();
    line("  Setup complete.");
    rule();
    for (const persona of PERSONAS) {
      const chain = models[persona.key];
      if (chain.length) line(`  ${persona.label.padEnd(10)} ${chain.join("  →  ")}`);
    }
    line();
    line(`  Saved to ${file}`);
    line();
    line("  Next: cd into a project and just run");
    line("      yimpim");
    line();
    return 0;
  } catch (err) {
    if (err instanceof SetupCancelledError) {
      line();
      line("  Setup was interrupted before finishing. Nothing was saved beyond your");
      line("  API key. Run `yimpim setup` again to pick up where you left off.");
      return 1;
    }
    throw err;
  } finally {
    rl.close();
  }
}
