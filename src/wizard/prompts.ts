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
import { styleText } from "node:util";
import { inputActive, inputInstalled, pauseInput, resumeInput } from "../terminalInput.js";

export { p };

/**
 * The reminder shown on every screen: clack's own footer lists Enter and typing but not Esc, which cancels the whole screen.
 * Dim, so it reads as a hint. ESC_WHOLE is for the later steps of a multi-step pick (backup, next model), where Esc drops the
 * entire change, not just that step.
 */
export const ESC_HINT = styleText("dim", "Esc: cancel");
export const ESC_WHOLE = styleText("dim", "Esc: cancel the whole change");

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
 * Keeps stdin in raw mode until the returned release is called. While held, every setRawMode(false) becomes setRawMode(true).
 * Holds nest; only the outermost release gives the real setRawMode back.
 *
 * Why: on Windows, leaving raw mode while stdin is still reading switches libuv to a line-mode console read. Every readline
 * close and every clack prompt end calls setRawMode(false), so once the session had its own readline on stdin, the SECOND
 * wizard prompt never received a key again: no arrows, no letters, no Esc. Reproduced in a real console (one readline opened
 * and closed, then two clack prompts: the second is dead); with raw mode held, every key arrives.
 */
let rawHolds = 0;
let restoreSetRawMode: (() => void) | undefined;
export function holdRawMode(stdin: any = process.stdin): () => void {
  if (!stdin?.isTTY || typeof stdin.setRawMode !== "function") return () => {};
  if (rawHolds++ === 0) {
    const hadOwn = Object.prototype.hasOwnProperty.call(stdin, "setRawMode");
    const own = stdin.setRawMode;
    const real = own.bind(stdin);
    stdin.setRawMode = (_mode: boolean) => real(true);
    real(true);
    restoreSetRawMode = () => {
      if (hadOwn) stdin.setRawMode = own;
      else delete stdin.setRawMode;
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--rawHolds === 0) {
      restoreSetRawMode?.();
      restoreSetRawMode = undefined;
    }
  };
}

/** How many raw-mode holds are open (tests). */
export function rawHoldCount(): number {
  return rawHolds;
}

/**
 * Runs `fn` with exclusive use of stdin. Pauses the session's input line only if it is live (so nested calls, or a caller that
 * already paused it, do not resume it early), and holds raw mode the whole time (see holdRawMode).
 *
 * Afterwards raw mode goes back the way it was, except while the session's input line is installed but paused by a caller:
 * that caller's resumeInput() turns raw on again anyway, and dropping it in between would recreate the Windows problem.
 */
export async function withExclusiveStdin<T>(fn: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = Boolean(stdin.isRaw);
  const release = holdRawMode(stdin);
  const owned = inputActive();
  if (owned) pauseInput();
  try {
    return await fn();
  } finally {
    release();
    if (owned) resumeInput();
    else if (!inputInstalled() && rawHolds === 0) {
      try { stdin.setRawMode?.(wasRaw); } catch { /* not a TTY */ }
    }
  }
}
