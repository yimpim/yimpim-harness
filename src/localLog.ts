/**
 * A line for the person at the terminal only. Every console line is otherwise mirrored to a paired phone as a `log` event (see the
 * console hook in index.ts); some lines would only repeat back to the phone what it already knows or already has as a typed event:
 * the echo of what the phone itself just did, a passive view (browsing History, fetching a diff), or the answer to a question,
 * which the phone gets as `question.answered`. Those are printed with logLocal and never mirrored.
 */
let depth = 0;

export function logLocal(...args: unknown[]): void {
  depth++;
  try {
    console.log(...args);
  } finally {
    depth--;
  }
}

/** True while a logLocal line is being printed: the console mirror skips it. */
export function isLocalOnly(): boolean {
  return depth > 0;
}
