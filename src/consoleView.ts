/**
 * What the desktop terminal shows, as opposed to what a run says.
 *
 * Every line a run prints is also sent to a paired phone, which reads some of them (the verdict, the `[API]` tab, the files searched).
 * So nothing is changed at the source: this decides only what is drawn on the TERMINAL. A line that is routine bookkeeping (a model call
 * that succeeded, a file that was read, a gate that passed) is hidden; anything that went wrong, needs a decision, or says what was done
 * is shown. Warnings and errors are never hidden. `/verbose` (or YIMPIM_VERBOSE=1) shows every line, for finding out what happened.
 */

let verbose = /^(1|true|yes|on)$/i.test(process.env.YIMPIM_VERBOSE ?? "");

export function isVerbose(): boolean {
  return verbose;
}

export function setVerbose(on: boolean): void {
  verbose = on;
}

/** Whether the terminal has a live status line to say what is being waited on (then the 20-second "still waiting" lines are redundant). */
let statusAvailable: () => boolean = () => false;
export function setStatusAvailable(fn: () => boolean): void {
  statusAvailable = fn;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const OSC = /\u001b\]8;[^\u001b]*\u001b\\/g;
const stripCodes = (s: string): string => s.replace(OSC, "").replace(ANSI, "");

/** Routine bookkeeping: shown only in verbose mode. Each is a whole line, matched from its start. */
const ROUTINE: RegExp[] = [
  // A model call that came back fine on the first try. A retry, a failure and a slow call are different lines and stay.
  /^\[API\] \S+ \([A-Z_ -]+\) ✔ \(/,
  /^\[MEMORY\]/,
  // The files an agent opened and the searches it ran while looking: for an agent that EDITS, the same files are listed again as they are changed. Not for
  // the stages that only read (Discovery and the Planner): what they read is all they show, and without it a stage that takes minutes is silent. (The repair Planner's are still hidden: it is given its files.)
  /^\[(?!(?:DISCOVERY|PLANNER)\b)[A-Z_ ]+\] (🔎 )?(Bounded inspection|Reading discovery target|Read file:|Searched code with pattern)/,
  // The environment report printed ahead of every verification.
  /^\[QA\] Project profile:/,
  // The whole static review: the line before it has the summary, the counts and what is missing, and the rest is listed once as advisories.
  /^\[QA\] Static review \(full\):/,
  /^\[QA\] Running build gate:/,
  /^\[QA GATE\] ✓/,
  /^\[QA ADVISORY\] ✓/,
  // Counted from the start of verification, so it leaves out the editor's own calls: the phase and job totals are the real figures.
  /^\[COST\] ".*": .* so far\.$/,
];

/** The verdict's own list of every gate repeats what the gate lines said. The defects and advisories are what a person acts on. */
function withoutEvidenceList(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*(\*\*)?Evidence collected:(\*\*)?\s*$/.test(l));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\*\*/.test(lines[end])) end++;
  // Keep one blank line between the headline and what follows.
  const before = lines.slice(0, start);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  const after = lines.slice(end);
  return after.length ? [...before, "", ...after].join("\n") : before.join("\n");
}

// Decorative emoji next to a [TAG] add colour the tag cannot have (a leading emoji stops it matching) and noise nobody reads. The
// ones that carry a meaning stay.
const MEANINGFUL = new Set(["⚠", "❌", "✅", "⛔", "✔", "✖", "✗", "✓"]);
const EMOJI_RUN = "(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)+";
const keepMeaningful = (run: string): string => {
  // Each emoji keeps its own variation selector, so a kept ⚠️ still draws as the emoji it was.
  const kept = (run.match(/\p{Extended_Pictographic}️?/gu) ?? []).filter((c) => MEANINGFUL.has([...c][0]));
  return kept.length ? kept.join(" ") + " " : "";
};
/** `🧭 [PLANNER] x` -> `[PLANNER] x`, `[VERIFIER] 🛡️ x` -> `[VERIFIER] x`; `⚠️ [HARD VERIFICATION FAILURE]` keeps its warning sign. */
export function plainTagEmoji(text: string): string {
  return text
    .replace(new RegExp(`^(\\n*)(${EMOJI_RUN})(?=\\[)`, "u"), (_m, nl: string, run: string) => nl + keepMeaningful(run))
    .replace(new RegExp(`^(\\n*\\[[A-Z][A-Za-z0-9_ -]*\\]) (${EMOJI_RUN})`, "u"), (_m, tag: string, run: string) => `${tag} ${keepMeaningful(run)}`);
}

const shortModel = (m: string): string => m.split("/").pop() ?? m;

/**
 * The arguments to print on the terminal for a console call, or null to print nothing. Warnings and errors are never dropped, and
 * anything that is not a string goes through as it is.
 */
export function terminalView(level: "log" | "warn" | "error", args: unknown[]): unknown[] | null {
  if (verbose || typeof args[0] !== "string") return args;
  let first = args[0] as string;
  if (level === "log") {
    const head = (stripCodes(first).split("\n").find((l) => l.trim()) ?? "").trim();
    if (ROUTINE.some((re) => re.test(head))) return null;
    // A slow call: the live status line already says what is being waited on. Without one, once a minute shows it is still alive.
    const waiting = /^\[API\] Still waiting on (\S+) \(([A-Z_ -]+)\)[^—]*— (\d+)s elapsed/.exec(head);
    if (waiting) {
      if (statusAvailable() || Number(waiting[3]) % 60 !== 0) return null;
      first = `[${waiting[2]}] ${shortModel(waiting[1])} is still working — ${waiting[3]}s`;
    }
    // The tag says who is speaking, as every other line does; the phone keeps `[API]`, which is what its API tab filters on.
    first = first.replace(/^(\n*)\[API\] (\S+) \(([A-Z_ -]+)\)/, (_m, nl: string, model: string, agent: string) => `${nl}[${agent}] ${shortModel(model)}`);
    if (/Evidence collected:/.test(first)) first = withoutEvidenceList(first);
  }
  return [plainTagEmoji(first), ...args.slice(1)];
}

// ---------------------------------------------------------------------------------------------------------------- wrapping

const WIDE = /\p{Extended_Pictographic}/u;
/** Columns a string takes on screen: escape codes take none, an emoji takes two. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripCodes(s)) {
    if (ch === "️" || ch === "‍") continue;
    w += WIDE.test(ch) ? 2 : 1;
  }
  return w;
}

/**
 * Wraps one line at word boundaries, and continues it under the text, not under the bullet: "  - a long assumption ..." keeps its
 * second row aligned with "a". A line that is already short, that holds aligned columns, or that has no spaces (a path) is left alone.
 */
function wrapLine(line: string, cols: number): string {
  if (visibleWidth(line) <= cols - 1) return line;
  const plain = stripCodes(line);
  if (/\S {3,}\S/.test(plain) || /[│┃─═┌┐└┘├┤]/.test(plain)) return line;
  const prefix = /^\s*(?:\[[^\]]{1,24}\]\s+)?(?:(?:[-*•▸›·]|\d+[.)])\s+)?/.exec(plain)?.[0].length ?? 0;
  const hang = prefix > Math.floor(cols / 3) ? 2 : prefix;
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  let first = true;
  for (const word of line.split(" ")) {
    const w = visibleWidth(word);
    if (first) {
      cur = word;
      curW = w;
      first = false;
    } else if (curW + 1 + w <= cols - 1) {
      cur += " " + word;
      curW += 1 + w;
    } else {
      rows.push(cur.replace(/\s+$/, ""));
      cur = " ".repeat(hang) + word;
      curW = hang + w;
    }
  }
  rows.push(cur.replace(/\s+$/, ""));
  return rows.join("\n");
}

/** Wraps every line of `text` to `cols` columns. Call with 0 (or a width under 40) to leave the text as it is. */
export function wrapForTerminal(text: string, cols: number): string {
  if (!Number.isFinite(cols) || cols < 40) return text;
  return text
    .split("\n")
    .map((l) => wrapLine(l, cols))
    .join("\n");
}
