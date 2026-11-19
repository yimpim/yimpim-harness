/**
 * Shared "markdown-lite" rendering for text that's dual-purpose — the exact
 * same string that gets displayed to a human (desktop terminal, phone) is
 * also fed to another model (REPAIR reading a QA failure, Editor reading
 * howToVerify). The underlying text is asked (see prompts.ts / staticQa.ts /
 * agentTools.ts) to use plain, ubiquitous Markdown conventions — backticks
 * around file/variable/component names, **bold** for emphasis — specifically
 * because those conventions cost another model nothing to parse (a
 * backtick-delimited identifier is arguably more unambiguous than a bare
 * word) while being trivial to turn into real visual formatting for a
 * human. This module is the one place that turns that convention into ANSI
 * escapes for the desktop terminal; remote/ui.ts has the parallel (but
 * separately maintained, since it runs in a browser, not Node) HTML version.
 */

const ANSI_BOLD = "\x1b[1m";
const ANSI_CODE = "\x1b[36m"; // cyan — distinct from the existing green/red diff-stat colors
const ANSI_RESET = "\x1b[0m";

/** Turns `` `code` `` and `**bold**` spans into ANSI escapes for a real
 *  terminal. Applied once, at the point text is about to hit a real TTY
 *  (see index.ts's console.log patch) — the phone gets the raw markdown-lite
 *  text unchanged so its own renderer can turn the same markers into HTML
 *  instead of losing them to this step. */
export function toAnsi(text: string): string {
  return text
    .replace(/`([^`]+)`/g, `${ANSI_CODE}$1${ANSI_RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET}`);
}

/** Strips ANSI escape sequences and carriage returns — the inverse of every
 *  raw terminal control code this module (and the ticker/diff-stat coloring
 *  elsewhere) can produce. Used both by the phone-mirror path (a browser
 *  activity feed isn't a terminal, so a stray "\x1b[K" would render as a
 *  literal typo-looking "[K") and by terminalInput.ts's own prompt-width
 *  math, which needs the VISIBLE length of a string, not its byte length. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

// One color per pipeline role, distinct from ANSI_CODE (cyan, used for
// inline `code` spans) so a colored [EDITOR] tag never reads like a code
// span at a glance. Deliberately NOT reusing green/red — those already carry
// pass/fail meaning elsewhere (diff +/- stats, QA verdicts) and coloring the
// tag itself the same way would suggest a status that isn't there.
// The first five are the original ones and keep their exact codes. The rest are 256-colour so that every persona that speaks has a hue
// of its own (VERIFIER and EXISTENCE had none). Red is left out on purpose: it already means failure. Infrastructure tags ([API],
// [CONTROL], [REMOTE], [MODELS] ...) are not here and stay plain.
const ROLE_TAG_COLORS: Record<string, string> = {
  DISCOVERY: "\x1b[34m", // blue
  PLANNER: "\x1b[35m", // magenta
  EDITOR: "\x1b[96m", // bright cyan
  REPAIR: "\x1b[33m", // yellow
  QA: "\x1b[32m", // green
  VERIFIER: "\x1b[38;5;42m", // spring green
  "VERIFIER-NAV": "\x1b[38;5;36m", // teal green
  "VERIFIER-VISUAL": "\x1b[38;5;79m", // aqua
  EXISTENCE: "\x1b[38;5;208m", // orange
  EXISTS: "\x1b[38;5;208m", // orange (the audit's own tag)
  REPAIR_PLANNER: "\x1b[38;5;179m", // gold
  TESTABILITY_PLANNER: "\x1b[38;5;141m", // lavender
  ROADMAP_PLANNER: "\x1b[38;5;171m", // orchid
  ROADMAP: "\x1b[38;5;147m", // periwinkle
  ADVISOR: "\x1b[38;5;111m", // sky blue
  SETUP: "\x1b[38;5;250m", // light grey
  DESIGNER: "\x1b[38;5;205m", // pink
  SECURITY: "\x1b[38;5;99m", // violet
  TESTS: "\x1b[38;5;37m", // teal
};
// Leading newlines (group 1) are common — most of these calls open with
// "\n[EDITOR] ..." for a blank-line separator before the tag — and must stay
// OUTSIDE the color codes so they still function as plain line breaks.
// Longest names first, so "REPAIR_PLANNER" is not read as "REPAIR".
const ROLE_TAG_RE = new RegExp(
  `^(\\n*)\\[(${Object.keys(ROLE_TAG_COLORS)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\]`,
);

/**
 * Colors a leading `[ROLE]` tag (DISCOVERY/PLANNER/EDITOR/REPAIR/QA) so
 * scanning scrollback for where a phase/role transitioned is a glance, not a
 * read — every existing `console.log("[EDITOR] ...")`-style call site stays
 * exactly as it is; only the terminal render step (see index.ts's
 * console.log patch) applies this. Only matches a tag that's the first
 * thing on the line (after any leading blank lines) — an infrastructure tag
 * ([CONTROL], [REMOTE], [API], ...) is deliberately left uncolored rather
 * than growing this into a color for every possible prefix, and a tag
 * appearing mid-message is left alone too.
 */
export function colorizeRoleTag(text: string): string {
  if (process.env.NO_COLOR) return text;
  const m = ROLE_TAG_RE.exec(text);
  if (!m) return text;
  const [whole, leadingNewlines, role] = m;
  const tag = `[${role}]`;
  const color = ROLE_TAG_COLORS[role];
  return `${leadingNewlines}${color}${tag}${ANSI_RESET}${text.slice(whole.length)}`;
}
