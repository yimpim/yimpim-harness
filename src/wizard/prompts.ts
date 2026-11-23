/**
 * The interactive wizard screens (first-run setup, /model, /api-key, /model-sort) are drawn with @clack/prompts. The coding session
 * itself stays a plain console stream; only these short menus take over the terminal.
 *
 * Three rules every screen follows:
 *   1. It runs only on a real terminal. Piped stdin, --json, --yes and phone commands never reach a prompt (canRunWizard).
 *   2. It has stdin to itself. The session's persistent input line is paused first and restored in `finally`, so no keystroke is
 *      handled twice and Esc / Ctrl+C never leave the terminal in raw mode (withExclusiveStdin).
 *   3. It writes straight to the terminal, not through console.log, so nothing a wizard shows (a masked key included) is mirrored
 *      to a paired phone.
 */

import * as p from "@clack/prompts";
import { inputActive, pauseInput, resumeInput } from "../terminalInput.js";

export { p };

/** Raised when the person presses Esc or Ctrl+C in a wizard screen. Callers turn it into "nothing changed". */
export class WizardCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "WizardCancelled";
  }
}

/** A wizard can only run where someone can answer it: an interactive terminal on both ends. */
export function canRunWizard(stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** A prompt's answer, or WizardCancelled when it was cancelled. */
export function answered<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new WizardCancelled();
  return value as Exclude<T, symbol>;
}

/**
 * Runs `fn` with exclusive use of stdin. Pauses the session's input line only if it is live (so nested calls, or a caller that
 * already paused it, do not resume it early), and always puts raw mode back the way it was.
 */
export async function withExclusiveStdin<T>(fn: () => Promise<T>): Promise<T> {
  const owned = inputActive();
  if (owned) pauseInput();
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = Boolean(stdin.isRaw);
  try {
    return await fn();
  } finally {
    try { stdin.setRawMode?.(wasRaw); } catch { /* not a TTY */ }
    if (owned) resumeInput();
  }
}
