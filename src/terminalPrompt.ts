import { claim, CancellablePrompt } from "./terminalInput.js";

export type { CancellablePrompt };

/**
 * A terminal prompt that treats a multi-line paste as ONE answer instead of
 * splitting it across every embedded newline (see terminalInput.ts's claim()
 * for the actual implementation and the full reasoning — this file now just
 * keeps the original name/shape so every existing call site stays
 * unchanged).
 */
export function startPrompt(query: string): CancellablePrompt {
  return claim(query);
}

/** Convenience wrapper for a one-shot prompt with no need to cancel it. */
export async function promptOnce(query: string): Promise<string> {
  return startPrompt(query).answer;
}
