/**
 * Catches two easy-to-make mistakes before they ever reach task
 * classification: a slash command that doesn't quite match anything
 * ("/hrlp"), and a known command's bare name typed without its leading
 * slash ("remote-control"). Both used to fall straight through to
 * answerIfQuestion, get classified as a task on the "uncertain -> task"
 * bias, and kick off a full Discovery pass on what was actually a typo —
 * forcing a Ctrl-C to recover since nothing about "remote-control" as
 * literal task text ever looks like a real coding request.
 *
 * Pulled out of index.ts (which runs `main()` as an import side effect, so
 * it cannot be imported from a test) specifically so this has real,
 * isolated test coverage.
 */

/** Every recognized slash command's canonical/alias name, without the
 *  leading slash — kept in sync by hand with index.ts's dispatch chain (and
 *  roughly with printHelpMenu's listing). */
export const KNOWN_SLASH_COMMANDS = [
  "help", "status", "remote-control", "rc", "link", "model", "models", "model-sort",
  "api-key", "plan", "push-repo", "push-local", "branch", "branches",
  "merge", "memory", "exit", "ask", "usage", "approvals",
];

export function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** The closest known command to `word`, if it's close enough to plausibly be
 *  a typo rather than a coincidence — proportional to word length so a
 *  2-character garble doesn't confidently "match" an unrelated 10-letter
 *  command. */
export function closestSlashCommand(word: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cmd of KNOWN_SLASH_COMMANDS) {
    const d = levenshteinDistance(word, cmd);
    if (d < bestDist) {
      bestDist = d;
      best = cmd;
    }
  }
  return best && bestDist <= Math.max(1, Math.ceil(best.length / 3)) ? best : undefined;
}

export interface CommandTypoResult {
  /** The message to print explaining what was caught. */
  message: string;
}

/**
 * Checks whether `trimmed` looks like a failed attempt at a slash command.
 * Returns a result (with a message to print) when it should be treated as
 * a command typo instead of falling through to task classification;
 * undefined means "not a command typo, handle normally."
 *
 * Deliberately narrow: only fires on a single "word" with no spaces, so
 * ordinary task text that happens to start with a command-like word (e.g.
 * "help me understand this branch") is never misidentified.
 */
export function detectCommandTypo(trimmed: string): CommandTypoResult | undefined {
  if (/\s/.test(trimmed)) return undefined;

  if (trimmed.startsWith("/")) {
    const word = trimmed.slice(1).toLowerCase();
    if (KNOWN_SLASH_COMMANDS.includes(word)) return undefined; // a real command with no args — not this function's job
    const suggestion = closestSlashCommand(word);
    return {
      message: suggestion
        ? `Unknown command "${trimmed}" — did you mean /${suggestion}? (Type /help to see all commands.)`
        : `Unknown command "${trimmed}". Type /help to see all commands.`,
    };
  }

  if (KNOWN_SLASH_COMMANDS.includes(trimmed.toLowerCase())) {
    return { message: `Commands need a leading slash — did you mean /${trimmed.toLowerCase()}?` };
  }

  return undefined;
}
